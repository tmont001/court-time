-- 0190_memberships_enable_disable_foundation.sql
-- Phase 42C-1 — Memberships Enable/Disable DB Foundation.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 42A (0188) and 42B (0189), both applied/immutable, gave Court Time
-- a durable membership-status axis and Member/Non-Member court pricing.
-- This migration adds the one missing piece: a per-club feature switch so
-- a club that does not run a membership program can turn Member/Non-Member
-- pricing off entirely, while every underlying axis (membership_types,
-- roster_members.membership_status/.membership_type_id, configured rates)
-- stays fully intact and un-erased for a future re-enable.
--
-- Approved architecture (locked by the 42C audit, Approach B):
--   - reservations.membership_pricing_class is STILL computed and
--     snapshotted exactly as 0189 does today, unconditionally — it always
--     answers "was this booking identity an active Member at booking
--     time," independent of whether that fact was used for pricing.
--   - Only the RATE RESOLUTION formula gains one additional predicate:
--     the Non-Member rate chain is only consulted when
--     club_settings.memberships_enabled = true. When false, EVERY booking
--     resolves through the existing Member/base chain, regardless of the
--     (still-accurately-stored) pricing class.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- TARGETED AUDIT (performed before writing this file)
-- ═══════════════════════════════════════════════════════════════════════════
-- get_members() / get_roster_members() return-shape mechanics: confirmed
-- via 0132's own header comment (a real, documented Production incident —
-- "cannot change return type of existing function") and via 0117's own
-- get_roster_members() correction (which DROPped the zero-arg overload
-- before introducing the one-arg version specifically because "adding a
-- parameter... is a NEW, DISTINCT overload... CREATE OR REPLACE on a
-- different argument list does not replace the original") that PostgreSQL
-- categorically refuses `CREATE OR REPLACE FUNCTION` when the RETURNS
-- TABLE column list changes — even by pure addition. Both functions below
-- are therefore DROPped (exact current signature) and recreated, never
-- CREATE OR REPLACE alone.
--
-- Dependency check (grep across every migration, both function names):
-- every match is a COMMENT referencing these functions by name for style
-- precedent — zero other SQL function, view, or trigger calls either one
-- internally. Both are leaf RPCs invoked only via PostgREST from the
-- frontend. Safe to DROP with no CASCADE and no dependent object to
-- restore.
--
-- Frontend consumer check (grep across src/app, src/lib, excluding test
-- files and comments):
--   • get_roster_members(boolean) — called ONLY from
--     src/app/(app)/admin/members/page.tsx
--     (`supabase.rpc("get_roster_members", { p_include_inactive: true })`).
--     EventRosterSheet.tsx/ProgramRosterSheet.tsx reference it only in
--     comments describing historical lineage — they call their own
--     dedicated RPCs, not this one.
--   • get_members() — called ONLY from
--     src/app/(app)/admin/members/page.tsx and
--     src/app/(app)/admin/members/actions.ts.
-- Both are exactly, and only, the Admin Members LIST surface's data
-- sources — confirming the 42C audit's own "likely candidates" hypothesis
-- with actual grep evidence, not assumption.
--
-- get_admin_member_detail(uuid) — audited, NOT widened here. It is a real,
-- currently-shipped consumer (src/app/(app)/admin/members/[id]/page.tsx),
-- and a genuine future candidate once the Member Detail editing UI (Phase
-- 42C-4, not yet scoped or approved) needs membership fields on that
-- surface. Widening it now, with no 42C-1 deliverable consuming it, would
-- be exactly the "widen an RPC merely because it exists" this checkpoint
-- was explicitly told to avoid. Deferred to whichever future migration
-- actually ships 42C-4's detail-page editing controls.
--
-- The two frontend Server Actions that already call update_club_pricing
-- and set_court_hourly_rate with their pre-0189 2-argument shape are
-- UNCHANGED here — 0189's third parameters are `DEFAULT NULL`, so those
-- existing 2-arg calls remain fully valid today. They are deliberately
-- left alone; widening them is Phase 42C-2's job, when the Non-Member
-- pricing UI is actually added.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- SCOPE
-- ═══════════════════════════════════════════════════════════════════════════
--   1. club_settings.memberships_enabled boolean not null default true —
--      every existing club preserves current (42A/42B) behavior unchanged.
--   2. update_club_memberships_enabled(p_enabled boolean) — new, narrowly
--      scoped Admin-only toggle RPC. Deliberately NOT folded into
--      update_club_pricing (same separation-of-concerns precedent as
--      update_club_payment_mode living apart from it).
--   3. create_reservation / admin_create_member_reservation /
--      update_member_reservation: verbatim 0189 bodies, each with exactly
--      ONE added predicate in the existing rate-resolution branch
--      condition. membership_pricing_class's own computation is
--      byte-identical to 0189 — untouched.
--   4. get_members() / get_roster_members(boolean): DROP + CREATE (see
--      audit above), each gaining membership_status, membership_type_id,
--      and a same-club membership_type_name (nullable, via LEFT JOIN) —
--      every pre-existing returned column, ordering, and filtering
--      behavior preserved exactly. Effective authorization (admin-only,
--      same-club) is preserved for both; get_roster_members' underlying
--      MECHANISM is corrected from a direct profiles%rowtype read to the
--      canonical current_user_club_id()/current_user_role() pattern, with
--      an explicit revoke/grant added (see Section F below for the full
--      rationale) — get_members' mechanism and grants were already
--      canonical and are unchanged.
--
-- Explicitly NOT touched: 0188, 0189 (both immutable), Stripe/payment
-- ledger architecture, Checkout fail-closed logic, reassignment/inactive-
-- court guards, historical reservation rows (no backfill, no bulk
-- update — this migration NEVER issues an UPDATE against the reservations
-- table), roster lifecycle RPCs, membership_types CRUD RPCs,
-- is_active_club_member, any frontend file, AddMemberSheet/roster-creation
-- behavior, get_admin_member_detail.
--
-- Not applied by this checkpoint. Do not create 0191.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- A. club_settings.memberships_enabled
-- ═══════════════════════════════════════════════════════════════════════════
alter table public.club_settings
  add column memberships_enabled boolean not null default true;

comment on column public.club_settings.memberships_enabled is
  'Phase 42C-1: per-club feature switch for Member/Non-Member court
   pricing differentiation. Defaults true so every existing club preserves
   current (42A/42B) behavior unchanged. Turning this off never erases
   membership_types, roster_members.membership_status/.membership_type_id,
   or configured Member/Non-Member rates — it only changes which rate
   chain new reservations resolve through. reservations.
   membership_pricing_class continues to be computed and snapshotted
   unconditionally regardless of this flag (0189, untouched) — this column
   affects PRICING RESOLUTION only, never the stored classification.';

-- ═══════════════════════════════════════════════════════════════════════════
-- B. update_club_memberships_enabled — new Admin-only toggle RPC.
--    Deliberately separate from update_club_pricing, matching the
--    established precedent of update_club_payment_mode living apart from
--    it for the same reason: "manage rate values" and "manage a feature
--    switch" are different concerns.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.update_club_memberships_enabled(
  p_enabled boolean
)
returns club_settings
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_id uuid;
  v_role    text;
  v_result  club_settings%rowtype;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  select
    public.current_user_club_id(),
    public.current_user_role()
  into
    v_club_id,
    v_role;

  if v_role is distinct from 'admin' then
    raise exception 'insufficient_role';
  end if;

  if p_enabled is null then
    raise exception 'enabled_required';
  end if;

  update club_settings
     set memberships_enabled = p_enabled,
         updated_at          = now()
   where club_id = v_club_id
  returning * into v_result;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'update_club_memberships_enabled', 'club_settings', v_club_id,
    jsonb_build_object('memberships_enabled', p_enabled)
  );

  return v_result;
end;
$$;

revoke execute on function public.update_club_memberships_enabled(boolean) from public, anon;
grant  execute on function public.update_club_memberships_enabled(boolean) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- C. create_reservation — verbatim 0189 body. The ONLY change is the
--    added `v_settings.memberships_enabled and` predicate in the existing
--    rate-resolution branch condition. v_settings is already loaded
--    earlier in this function (unconditionally, before this block), so no
--    new lookup is introduced. v_membership_pricing_class's own
--    computation is byte-identical to 0189 — the classification always
--    happens, regardless of this flag.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.create_reservation(p_court_id uuid, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone, p_format text DEFAULT NULL::text, p_player_count integer DEFAULT NULL::integer, p_guest_names text[] DEFAULT NULL::text[], p_notes text DEFAULT NULL::text)
 RETURNS reservations
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_profile           profiles%rowtype;
  v_settings          club_settings%rowtype;
  v_court              courts%rowtype;
  v_tz                  text;
  v_date                date;                             -- Phase 17A: local booking date
  v_override            operating_hours_override%rowtype;  -- Phase 17A: date-specific override
  v_dow                 int;
  v_hours               operating_hours%rowtype;
  v_result              reservations%rowtype;
  -- Phase 33C1: the caller's own durable Member identity for this club.
  v_roster_member_id    uuid;
  -- Phase 34B: resolved/snapshotted court-booking price.
  v_hourly_rate_cents    integer;
  v_price_amount_cents   integer;
  -- Phase 42B: resolved/snapshotted membership pricing class.
  v_membership_pricing_class text;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_profile.status <> 'active' then raise exception 'account_inactive'; end if;

  -- Phase 33F3B: Staff-Managed Members may not book a NEW court reservation.
  -- Never gates Admin/Pro self-booking. Phase 34A3: restated as an
  -- explicit admin/pro allowlist rather than a member-exclusion, so a
  -- Staff person's own self-service booking is gated the same as a
  -- Member's — see this section's header above for the full rationale.
  if v_profile.role not in ('admin', 'pro') and not current_club_has_capability('member_self_service') then
    raise exception 'capability_not_available';
  end if;

  -- Phase 33C1: resolve the caller's own roster identity in this club.
  -- Never client-supplied — auth.uid() and v_profile.club_id are both
  -- server-derived, exactly like every other identity resolution in this
  -- function. A member can never specify another person's identity here;
  -- this only ever resolves the CALLER's own roster row. Fails closed:
  -- every active club member is expected to have one (Phase 33B1's own
  -- backfill plus accept_club_invite's fail-closed roster resolution both
  -- guarantee this for anyone who could reach this point), so this should
  -- never legitimately raise — it is verified, not assumed.
  select id into v_roster_member_id
    from roster_members
   where club_id    = v_profile.club_id
     and claimed_by = auth.uid();
  if not found then raise exception 'no_roster_identity'; end if;

  select * into v_court
    from courts
    where id        = p_court_id
      and club_id   = v_profile.club_id
      and is_active = true;
  if not found then raise exception 'court_not_found'; end if;

  select * into v_settings from club_settings where club_id = v_profile.club_id;

  select timezone into v_tz from clubs where id = v_profile.club_id;

  -- Past-date guard: applies to all roles. Admins and pros may not book in the past.
  if p_starts_at < now() then
    raise exception 'cannot_book_past';
  end if;

  -- Phase 34A3: booking-window guard restated as an explicit admin/pro
  -- allowlist rather than a member-exclusion — see the section header
  -- above. Behavior for member/admin/pro is byte-identical to before;
  -- Staff is newly, deliberately included in the restricted side.
  if v_profile.role not in ('admin', 'pro')
     and p_starts_at > now() + (v_settings.booking_window_days || ' days')::interval then
    raise exception 'outside_booking_window';
  end if;

  if p_ends_at <= p_starts_at then
    raise exception 'invalid_duration';
  end if;

  -- Phase 20D-B: member court reservations must use one of the supported durations.
  if extract(epoch from (p_ends_at - p_starts_at)) / 60 not in (30, 60, 90, 120) then
    raise exception 'invalid_duration';
  end if;

  -- ---------------------------------------------------------------------------
  -- Phase 17A: check for a date-specific override before falling back to the
  -- weekly operating_hours. The override lookup uses the club-local calendar
  -- date (v_date) derived from the booking's starts_at timestamp.
  -- ---------------------------------------------------------------------------
  v_date := (p_starts_at at time zone v_tz)::date;
  v_dow  := extract(dow from p_starts_at at time zone v_tz)::int;

  select * into v_override
    from operating_hours_override
    where club_id       = v_profile.club_id
      and override_date = v_date;

  if found then
    -- An override exists for this date — it takes priority over weekly hours.
    if v_override.is_closed then
      raise exception 'club_closed_this_day';
    end if;
    -- When special hours are set, reject bookings that fall outside them.
    if v_override.opens_at is not null and v_override.closes_at is not null then
      if (p_starts_at at time zone v_tz)::time < v_override.opens_at
         or (p_ends_at at time zone v_tz)::time > v_override.closes_at then
        raise exception 'outside_operating_hours';
      end if;
    end if;
    -- Override exists and booking is within bounds; skip the weekly check below.
  else
    -- No override for this date — apply normal weekly operating_hours.
    select * into v_hours
      from operating_hours
      where club_id     = v_profile.club_id
        and day_of_week = v_dow;

    if not found or v_hours.is_closed then
      raise exception 'club_closed_this_day';
    end if;

    if (p_starts_at at time zone v_tz)::time < v_hours.opens_at
       or (p_ends_at at time zone v_tz)::time > v_hours.closes_at then
      raise exception 'outside_operating_hours';
    end if;
  end if;
  -- ---------------------------------------------------------------------------

  -- Phase 42B: resolve the booking identity's membership pricing class via
  -- the canonical, role-agnostic predicate (0188) — Admin/Pro/Staff get
  -- Member pricing exactly like a plain Member if their own roster
  -- identity has active business membership, and vice versa. Named
  -- reservation participants/guests (Phase 37) are never consulted — only
  -- the booking identity itself determines the base court rate. Computed
  -- unconditionally — Phase 42C's memberships_enabled flag (below) affects
  -- only which RATE this classification resolves to, never whether the
  -- classification itself happens.
  v_membership_pricing_class := case
    when public.is_active_club_member(v_roster_member_id, v_profile.club_id) then 'member'
    else 'non_member'
  end;

  -- Phase 34B/42B/42C: resolve and snapshot court-booking price.
  -- Member: court override, else club default, else NULL (unpriced —
  -- court pricing remains optional). Non-Member (only when
  -- memberships_enabled): court non-member override, else club non-member
  -- default, else the SAME Member/default chain (required fallback — a
  -- club that never configures Non-Member pricing has ZERO behavior
  -- change), else NULL. When memberships_enabled is false, every booking
  -- resolves through the Member/base chain regardless of the computed
  -- class above — the class is still stored accurately; only the rate
  -- differs. price_amount_cents = hourly_rate_cents × duration; NULL when
  -- unpriced. Snapshotted once, here, at booking time — a later admin
  -- rate change, membership_status change, or memberships_enabled toggle
  -- never reprices this reservation.
  if v_settings.memberships_enabled and v_membership_pricing_class = 'non_member' then
    v_hourly_rate_cents := coalesce(
      v_court.hourly_rate_non_member_cents,
      v_settings.default_court_hourly_rate_non_member_cents,
      v_court.hourly_rate_cents,
      v_settings.default_court_hourly_rate_cents
    );
  else
    v_hourly_rate_cents := coalesce(v_court.hourly_rate_cents, v_settings.default_court_hourly_rate_cents);
  end if;
  if v_hourly_rate_cents is not null then
    v_price_amount_cents := round(v_hourly_rate_cents * extract(epoch from (p_ends_at - p_starts_at)) / 3600.0)::integer;
  else
    v_price_amount_cents := null;
  end if;

  insert into reservations (
    club_id, court_id, owner_user_id, roster_member_id,
    starts_at, ends_at, status, reason,
    format, player_count, guest_names, notes, created_by,
    hourly_rate_cents, price_amount_cents, membership_pricing_class
  ) values (
    v_profile.club_id, p_court_id, auth.uid(), v_roster_member_id,
    p_starts_at, p_ends_at, 'confirmed', 'member_booking',
    p_format, p_player_count, p_guest_names, p_notes, auth.uid(),
    v_hourly_rate_cents, v_price_amount_cents, v_membership_pricing_class
  )
  returning * into v_result;

  -- Phase 34C: ensure a normal payment obligation for this fresh,
  -- confirmed, member_booking reservation. No-op when unpriced or when
  -- the club's payment_mode is not 'manual'.
  perform public._create_payment_obligation(
    v_profile.club_id, 'reservation', v_result.id, v_roster_member_id,
    v_price_amount_cents, auth.uid()
  );

  -- Phase 16F: only insert the in-app notification if the member has this kind enabled.
  if user_pref_enabled(auth.uid(), 'reservation_confirmed') then
    insert into notifications (club_id, user_id, kind, body, metadata)
    values (
      v_profile.club_id,
      auth.uid(),
      'reservation_confirmed',
      v_court.name || ' booked for '
        || to_char(p_starts_at at time zone v_tz, 'Mon DD "at" HH12:MI AM'),
      jsonb_build_object('reservation_id', v_result.id, 'court_id', p_court_id)
    );
  end if;

  return v_result;
end;
$function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- D. admin_create_member_reservation — verbatim 0189 body, identical
--    one-predicate addition as create_reservation above.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.admin_create_member_reservation(p_court_id uuid, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone, p_roster_member_id uuid, p_expected_club_id uuid, p_format text DEFAULT NULL::text, p_player_count integer DEFAULT NULL::integer, p_guest_names text[] DEFAULT NULL::text[], p_notes text DEFAULT NULL::text)
 RETURNS reservations
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_club_id  uuid;
  v_role     text;
  v_court    public.courts%rowtype;
  v_roster   public.roster_members%rowtype;
  v_owner_id uuid;
  v_tz       text;
  v_date     date;
  v_dow      int;
  v_override public.operating_hours_override%rowtype;
  v_hours    public.operating_hours%rowtype;
  v_result   public.reservations%rowtype;
  -- Phase 34B: resolved/snapshotted court-booking price.
  v_settings public.club_settings%rowtype;
  v_hourly_rate_cents  integer;
  v_price_amount_cents integer;
  -- Phase 42B: resolved/snapshotted membership pricing class.
  v_membership_pricing_class text;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
  if v_role not in ('admin', 'staff') then raise exception 'insufficient_role'; end if;

  if p_roster_member_id is null then raise exception 'roster_identity_required'; end if;

  select * into v_roster
    from public.roster_members
   where id      = p_roster_member_id
     and club_id = v_club_id;
  if not found then raise exception 'roster_member_not_found'; end if;

  v_owner_id := v_roster.claimed_by;

  select * into v_court
    from public.courts
   where id        = p_court_id
     and club_id   = v_club_id
     and is_active = true;
  if not found then raise exception 'court_not_found'; end if;

  select * into v_settings from public.club_settings where club_id = v_club_id;

  select timezone into v_tz from public.clubs where id = v_club_id;

  if p_starts_at < now() then
    raise exception 'cannot_book_past';
  end if;

  if p_ends_at <= p_starts_at then
    raise exception 'invalid_duration';
  end if;

  if extract(epoch from (p_ends_at - p_starts_at)) / 60 not in (30, 60, 90, 120) then
    raise exception 'invalid_duration';
  end if;

  v_date := (p_starts_at at time zone v_tz)::date;
  v_dow  := extract(dow from p_starts_at at time zone v_tz)::int;

  select * into v_override
    from public.operating_hours_override
   where club_id       = v_club_id
     and override_date = v_date;

  if found then
    if v_override.is_closed then
      raise exception 'club_closed_this_day';
    end if;
    if v_override.opens_at is not null and v_override.closes_at is not null then
      if (p_starts_at at time zone v_tz)::time < v_override.opens_at
         or (p_ends_at at time zone v_tz)::time > v_override.closes_at then
        raise exception 'outside_operating_hours';
      end if;
    end if;
  else
    select * into v_hours
      from public.operating_hours
     where club_id     = v_club_id
       and day_of_week = v_dow;

    if not found or v_hours.is_closed then
      raise exception 'club_closed_this_day';
    end if;

    if (p_starts_at at time zone v_tz)::time < v_hours.opens_at
       or (p_ends_at at time zone v_tz)::time > v_hours.closes_at then
      raise exception 'outside_operating_hours';
    end if;
  end if;

  -- Phase 42B: identical role-agnostic pricing-class resolution as
  -- create_reservation, for the explicit target roster member. Computed
  -- unconditionally, exactly as above.
  v_membership_pricing_class := case
    when public.is_active_club_member(p_roster_member_id, v_club_id) then 'member'
    else 'non_member'
  end;

  -- Phase 34B/42B/42C: identical resolve/snapshot formula as create_reservation.
  if v_settings.memberships_enabled and v_membership_pricing_class = 'non_member' then
    v_hourly_rate_cents := coalesce(
      v_court.hourly_rate_non_member_cents,
      v_settings.default_court_hourly_rate_non_member_cents,
      v_court.hourly_rate_cents,
      v_settings.default_court_hourly_rate_cents
    );
  else
    v_hourly_rate_cents := coalesce(v_court.hourly_rate_cents, v_settings.default_court_hourly_rate_cents);
  end if;
  if v_hourly_rate_cents is not null then
    v_price_amount_cents := round(v_hourly_rate_cents * extract(epoch from (p_ends_at - p_starts_at)) / 3600.0)::integer;
  else
    v_price_amount_cents := null;
  end if;

  insert into public.reservations (
    club_id, court_id, owner_user_id, roster_member_id,
    starts_at, ends_at, status, reason,
    format, player_count, guest_names, notes, created_by,
    hourly_rate_cents, price_amount_cents, membership_pricing_class
  ) values (
    v_club_id, p_court_id, v_owner_id, p_roster_member_id,
    p_starts_at, p_ends_at, 'confirmed', 'member_booking',
    p_format, p_player_count, p_guest_names, p_notes, auth.uid(),
    v_hourly_rate_cents, v_price_amount_cents, v_membership_pricing_class
  )
  returning * into v_result;

  -- Phase 34C: ensure a normal payment obligation for this fresh,
  -- confirmed, member_booking reservation.
  perform public._create_payment_obligation(
    v_club_id, 'reservation', v_result.id, p_roster_member_id,
    v_price_amount_cents, auth.uid()
  );

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id,
    auth.uid(),
    'admin_create_member_reservation',
    'reservation',
    v_result.id,
    jsonb_build_object(
      'roster_member_id', p_roster_member_id,
      'owner_user_id',    v_owner_id,
      'court_id',         p_court_id,
      'starts_at',        p_starts_at,
      'ends_at',          p_ends_at
    )
  );

  return v_result;
end;
$function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- E. update_member_reservation — verbatim 0189 body. The ONLY change is
--    the same added `v_settings.memberships_enabled and` predicate,
--    inside the `if v_court_changed or v_member_changed then` branch
--    (the only branch that resolves a rate from scratch). v_settings is
--    already loaded unconditionally at the top of that branch. The
--    duration-only and no-change branches are untouched — they never
--    consult club_settings at all, exactly as in 0189.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.update_member_reservation(p_reservation_id uuid, p_expected_club_id uuid, p_expected_updated_at timestamp with time zone, p_court_id uuid, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone, p_roster_member_id uuid, p_format text DEFAULT NULL::text, p_player_count integer DEFAULT NULL::integer, p_guest_names text[] DEFAULT NULL::text[], p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_club_id             uuid;
  v_role                text;
  v_before               reservations%rowtype;
  v_after                reservations%rowtype;
  v_court                courts%rowtype;
  v_tz                   text;
  v_date                 date;
  v_dow                  int;
  v_override             operating_hours_override%rowtype;
  v_hours                operating_hours%rowtype;
  v_scheduling_changed   boolean;
  v_changed_fields       text[] := '{}';
  v_notification_id      uuid;
  v_roster               public.roster_members%rowtype;
  v_member_changed       boolean;
  v_new_owner_id         uuid;
  -- Phase 34B: reservation-edit pricing invariants.
  v_settings             public.club_settings%rowtype;
  v_court_changed        boolean;
  v_duration_changed     boolean;
  v_new_hourly_rate_cents  integer;
  v_new_price_amount_cents integer;
  -- Phase 34E-A: pre-mutation Stripe Checkout invalidation.
  v_payment_id_for_checkout_guard uuid;
  -- Phase 42B: reassignment-aware membership pricing class.
  v_new_pricing_class    text;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
  if v_role not in ('admin', 'staff') then raise exception 'insufficient_role'; end if;

  if p_court_id is null then raise exception 'invalid_court'; end if;
  if p_starts_at is null or p_ends_at is null then raise exception 'invalid_duration'; end if;

  select * into v_before
    from reservations
    where id = p_reservation_id and club_id = v_club_id
    for update;
  if not found then raise exception 'reservation_not_found'; end if;

  if v_before.reason <> 'member_booking' then raise exception 'reservation_not_editable'; end if;
  if v_before.status <> 'confirmed' then raise exception 'reservation_not_editable'; end if;

  if v_before.starts_at <= now() then raise exception 'cannot_edit_started_reservation'; end if;

  if v_before.updated_at is distinct from p_expected_updated_at then
    raise exception 'stale_edit_conflict';
  end if;

  if p_starts_at <= now() then raise exception 'cannot_book_past'; end if;
  if p_ends_at <= p_starts_at then raise exception 'invalid_duration'; end if;

  if p_roster_member_id is null then
    raise exception 'roster_identity_required';
  end if;

  v_member_changed := p_roster_member_id is distinct from v_before.roster_member_id;

  if v_member_changed then
    select * into v_roster
      from public.roster_members
     where id      = p_roster_member_id
       and club_id = v_club_id;
    if not found then raise exception 'roster_member_not_found'; end if;
    v_new_owner_id := v_roster.claimed_by;
  else
    v_new_owner_id := v_before.owner_user_id;
  end if;

  -- Phase 34C: a reassignment must not silently abandon or transfer an
  -- unresolved obligation. Checked before any mutation below.
  if v_member_changed then
    perform public._check_member_reassignment_allowed(v_club_id, 'reservation', p_reservation_id);
  end if;

  v_scheduling_changed :=
    p_court_id  is distinct from v_before.court_id
    or p_starts_at is distinct from v_before.starts_at
    or p_ends_at   is distinct from v_before.ends_at;

  if v_scheduling_changed then
    select * into v_court
      from courts
      where id = p_court_id and club_id = v_club_id and is_active = true;
    if not found then raise exception 'invalid_court'; end if;

    if extract(epoch from (p_ends_at - p_starts_at)) / 60 not in (30, 60, 90, 120) then
      raise exception 'invalid_duration';
    end if;

    select timezone into v_tz from clubs where id = v_club_id;

    v_date := (p_starts_at at time zone v_tz)::date;
    v_dow  := extract(dow from p_starts_at at time zone v_tz)::int;

    select * into v_override
      from operating_hours_override
      where club_id = v_club_id and override_date = v_date;

    if found then
      if v_override.is_closed then
        raise exception 'club_closed_this_day';
      end if;
      if v_override.opens_at is not null and v_override.closes_at is not null then
        if (p_starts_at at time zone v_tz)::time < v_override.opens_at
           or (p_ends_at at time zone v_tz)::time > v_override.closes_at then
          raise exception 'outside_operating_hours';
        end if;
      end if;
    else
      select * into v_hours
        from operating_hours
        where club_id = v_club_id and day_of_week = v_dow;

      if not found or v_hours.is_closed then
        raise exception 'club_closed_this_day';
      end if;

      if (p_starts_at at time zone v_tz)::time < v_hours.opens_at
         or (p_ends_at at time zone v_tz)::time > v_hours.closes_at then
        raise exception 'outside_operating_hours';
      end if;
    end if;
  end if;

  -- Phase 34B: reservation-edit pricing invariants — see this function's
  -- own header comment above for the full A/B/C/D rule statement.
  v_court_changed    := p_court_id is distinct from v_before.court_id;
  v_duration_changed := (p_ends_at - p_starts_at) is distinct from (v_before.ends_at - v_before.starts_at);

  -- Phase 42B: membership pricing class — resolved fresh ONLY when the
  -- Member is being reassigned (a new customer identity, per this
  -- migration's locked rule); otherwise preserved exactly from the
  -- reservation's existing snapshot, regardless of any court/duration
  -- change on this same edit. Role-agnostic, matching create_reservation.
  -- Computed unconditionally — unaffected by memberships_enabled.
  if v_member_changed then
    v_new_pricing_class := case
      when public.is_active_club_member(p_roster_member_id, v_club_id) then 'member'
      else 'non_member'
    end;
  else
    v_new_pricing_class := v_before.membership_pricing_class;
  end if;

  -- Phase 42B (correction): when the Member is reassigned WITHOUT any
  -- scheduling change, v_court was never loaded by the v_scheduling_changed
  -- block above — load it now, same-club scoped, to read its pricing
  -- fields for repricing the new customer identity. Deliberately does NOT
  -- require is_active = true, unlike the court-change path above: this is
  -- a read of the reservation's ALREADY-BOOKED court, not authorization to
  -- create or move a booking onto it. A court legitimately deactivated for
  -- NEW bookings after this reservation was made must not block Admin from
  -- reassigning that existing, unmoved booking to a different roster
  -- Member — the court/time are not changing, only who is being billed for
  -- them. Contrast with v_scheduling_changed's own lookup, which DOES
  -- require is_active = true because it governs moving a booking onto a
  -- (possibly different) court, a genuine new-booking decision.
  if v_member_changed and not v_scheduling_changed then
    select * into v_court
      from courts
      where id = p_court_id and club_id = v_club_id;
    if not found then raise exception 'invalid_court'; end if;
  end if;

  if v_court_changed or v_member_changed then
    select * into v_settings from public.club_settings where club_id = v_club_id;
    if v_settings.memberships_enabled and v_new_pricing_class = 'non_member' then
      v_new_hourly_rate_cents := coalesce(
        v_court.hourly_rate_non_member_cents,
        v_settings.default_court_hourly_rate_non_member_cents,
        v_court.hourly_rate_cents,
        v_settings.default_court_hourly_rate_cents
      );
    else
      v_new_hourly_rate_cents := coalesce(v_court.hourly_rate_cents, v_settings.default_court_hourly_rate_cents);
    end if;
    if v_new_hourly_rate_cents is not null then
      v_new_price_amount_cents := round(v_new_hourly_rate_cents * extract(epoch from (p_ends_at - p_starts_at)) / 3600.0)::integer;
    else
      v_new_price_amount_cents := null;
    end if;
  elsif v_duration_changed then
    v_new_hourly_rate_cents := v_before.hourly_rate_cents;
    if v_new_hourly_rate_cents is not null then
      v_new_price_amount_cents := round(v_new_hourly_rate_cents * extract(epoch from (p_ends_at - p_starts_at)) / 3600.0)::integer;
    else
      v_new_price_amount_cents := null;
    end if;
  else
    v_new_hourly_rate_cents  := v_before.hourly_rate_cents;
    v_new_price_amount_cents := v_before.price_amount_cents;
  end if;

  -- Phase 34E-A: pre-mutation Stripe Checkout invalidation. Runs BEFORE
  -- the reservation UPDATE below whenever this edit is about to change
  -- the priced amount or reassign the Member — see this migration's own
  -- header comment for why reassignment needs no independent guard
  -- beyond this (it is included here purely as defense in depth).
  if v_member_changed or v_new_price_amount_cents is distinct from v_before.price_amount_cents then
    select id into v_payment_id_for_checkout_guard
      from public.payments
     where club_id = v_club_id and domain_type = 'reservation' and domain_id = p_reservation_id
     order by obligation_cycle desc
     limit 1
     for update;
    if v_payment_id_for_checkout_guard is not null then
      perform public._invalidate_or_flag_open_checkout_attempt(v_payment_id_for_checkout_guard);
    end if;
  end if;

  if p_court_id is distinct from v_before.court_id then
    v_changed_fields := array_append(v_changed_fields, 'court_id');
  end if;
  if p_starts_at is distinct from v_before.starts_at then
    v_changed_fields := array_append(v_changed_fields, 'starts_at');
  end if;
  if p_ends_at is distinct from v_before.ends_at then
    v_changed_fields := array_append(v_changed_fields, 'ends_at');
  end if;
  if v_member_changed then
    v_changed_fields := array_append(v_changed_fields, 'roster_member_id');
  end if;
  if p_format is distinct from v_before.format then
    v_changed_fields := array_append(v_changed_fields, 'format');
  end if;
  if p_player_count is distinct from v_before.player_count then
    v_changed_fields := array_append(v_changed_fields, 'player_count');
  end if;
  if p_guest_names is distinct from v_before.guest_names then
    v_changed_fields := array_append(v_changed_fields, 'guest_names');
  end if;
  if p_notes is distinct from v_before.notes then
    v_changed_fields := array_append(v_changed_fields, 'notes');
  end if;
  if v_new_hourly_rate_cents is distinct from v_before.hourly_rate_cents then
    v_changed_fields := array_append(v_changed_fields, 'hourly_rate_cents');
  end if;
  if v_new_price_amount_cents is distinct from v_before.price_amount_cents then
    v_changed_fields := array_append(v_changed_fields, 'price_amount_cents');
  end if;
  if v_new_pricing_class is distinct from v_before.membership_pricing_class then
    v_changed_fields := array_append(v_changed_fields, 'membership_pricing_class');
  end if;

  if array_length(v_changed_fields, 1) is null then
    return jsonb_build_object(
      'reservation',     to_jsonb(v_before),
      'changed_fields',  to_jsonb(v_changed_fields),
      'notification_id', null
    );
  end if;

  update reservations set
    court_id          = p_court_id,
    starts_at         = p_starts_at,
    ends_at           = p_ends_at,
    roster_member_id  = p_roster_member_id,
    owner_user_id     = v_new_owner_id,
    format            = p_format,
    player_count      = p_player_count,
    guest_names       = p_guest_names,
    notes             = p_notes,
    hourly_rate_cents  = v_new_hourly_rate_cents,
    price_amount_cents = v_new_price_amount_cents,
    membership_pricing_class = v_new_pricing_class,
    updated_at        = now()
  where id = p_reservation_id
  returning * into v_after;

  -- Phase 34C: payment wiring, after the mutation, using the final v_after
  -- state. Member reassignment always gets an explicit new cycle for the
  -- new Member (liable party changed is independently material); otherwise
  -- a price change adjusts the current cycle (if any) and ensures one
  -- exists. NULL is deliberately left unadjusted — a price becoming fully
  -- unpriced does not automatically touch an existing obligation; that
  -- remains an explicit Admin financial-resolution action.
  --
  -- Phase 34C (lifecycle correction): p_roster_member_id is now passed
  -- into _adjust_payment_obligation as the CURRENT identity — the latest
  -- payment cycle can belong to a PRIOR Member if this row was safely
  -- reassigned while unpriced (no positive obligation was created at that
  -- reassignment), and a later price edit must never silently adjust that
  -- prior Member's historical cycle. The helper no-ops on a mismatch;
  -- the following _create_payment_obligation call (NORMAL mode) then
  -- correctly allocates a fresh cycle for the current Member instead of
  -- reusing the mismatched one.
  if v_member_changed then
    perform public._create_payment_obligation(
      v_club_id, 'reservation', p_reservation_id, p_roster_member_id,
      v_new_price_amount_cents, auth.uid(), true
    );
  elsif v_new_price_amount_cents is distinct from v_before.price_amount_cents then
    if v_new_price_amount_cents is not null then
      perform public._adjust_payment_obligation(v_club_id, 'reservation', p_reservation_id, p_roster_member_id, v_new_price_amount_cents, auth.uid());
    end if;
    perform public._create_payment_obligation(
      v_club_id, 'reservation', p_reservation_id, p_roster_member_id,
      v_new_price_amount_cents, auth.uid()
    );
  end if;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id,
    auth.uid(),
    'update_member_reservation',
    'reservation',
    p_reservation_id,
    jsonb_build_object(
      'owner_user_id',     v_before.owner_user_id,
      'changed_fields',    v_changed_fields,
      'member_reassigned', v_member_changed,
      'before', jsonb_build_object(
        'court_id',         v_before.court_id,
        'starts_at',        v_before.starts_at,
        'ends_at',          v_before.ends_at,
        'format',           v_before.format,
        'player_count',     v_before.player_count,
        'guest_names',      v_before.guest_names,
        'notes',            v_before.notes,
        'roster_member_id', v_before.roster_member_id,
        'owner_user_id',    v_before.owner_user_id,
        'hourly_rate_cents', v_before.hourly_rate_cents,
        'price_amount_cents', v_before.price_amount_cents,
        'membership_pricing_class', v_before.membership_pricing_class
      ),
      'after', jsonb_build_object(
        'court_id',         v_after.court_id,
        'starts_at',        v_after.starts_at,
        'ends_at',          v_after.ends_at,
        'format',           v_after.format,
        'player_count',     v_after.player_count,
        'guest_names',      v_after.guest_names,
        'notes',            v_after.notes,
        'roster_member_id', v_after.roster_member_id,
        'owner_user_id',    v_after.owner_user_id,
        'hourly_rate_cents', v_after.hourly_rate_cents,
        'price_amount_cents', v_after.price_amount_cents,
        'membership_pricing_class', v_after.membership_pricing_class
      )
    )
  );

  v_notification_id := null;

  if v_scheduling_changed and v_after.owner_user_id is not null then
    if v_tz is null then
      select timezone into v_tz from clubs where id = v_club_id;
    end if;

    insert into notifications (club_id, user_id, kind, body, metadata)
    values (
      v_club_id,
      v_after.owner_user_id,
      'reservation_rescheduled',
      'Your booking was moved to ' || v_court.name || ' on '
        || to_char(v_after.starts_at at time zone v_tz, 'Mon DD "at" HH12:MI AM')
        || ' – ' || to_char(v_after.ends_at at time zone v_tz, 'HH12:MI AM') || '.',
      jsonb_build_object('reservation_id', v_after.id, 'court_id', v_after.court_id)
    )
    returning id into v_notification_id;
  end if;

  return jsonb_build_object(
    'reservation',     to_jsonb(v_after),
    'changed_fields',  to_jsonb(v_changed_fields),
    'notification_id', v_notification_id
  );
end;
$function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- F. get_roster_members — DROP + CREATE (see audit above: adding return
--    columns requires it). Signature (p_include_inactive boolean default
--    false) is UNCHANGED — only the RETURNS TABLE column list grows.
--    Every existing filter, unclaimed-only scoping, and ordering is
--    byte-identical to the live 0117 body.
--
--    CORRECTION (post-review, before first apply): this function is being
--    fully recreated by this migration (a DROP + CREATE, not a
--    same-signature CREATE OR REPLACE preserving an untouched body) — the
--    same category of "new/republished privileged RPC" the 0188 and 0189
--    correction passes already established must use the canonical
--    active-club pattern, not a direct `profiles%rowtype` read (which can
--    go stale relative to club_memberships). Rewritten accordingly: no
--    `v_profile` anywhere, club scoping resolved via
--    current_user_club_id()/current_user_role(). This also brings its
--    execution-privilege posture in line with the rest of this migration's
--    functions — explicit revoke from public/anon, grant to authenticated
--    only — rather than perpetuating the prior implicit-PUBLIC-EXECUTE
--    posture (gated only by the internal role check) that 0117 had left
--    in place for this specific function.
-- ═══════════════════════════════════════════════════════════════════════════
drop function if exists public.get_roster_members(boolean);

create or replace function get_roster_members(p_include_inactive boolean default false)
returns table (
  id uuid, first_name text, last_name text, email text, phone text,
  role text, notes text, created_by uuid, created_at timestamptz,
  status text, removed_at timestamptz,
  membership_status text, membership_type_id uuid, membership_type_name text
)
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
  v_role    text;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  select
    public.current_user_club_id(),
    public.current_user_role()
  into
    v_club_id,
    v_role;

  if v_role is distinct from 'admin' then
    raise exception 'insufficient_role';
  end if;

  return query
    select rm.id, rm.first_name, rm.last_name, rm.email, rm.phone,
           rm.role, rm.notes, rm.created_by, rm.created_at,
           rm.status, rm.removed_at,
           rm.membership_status, rm.membership_type_id, mt.name
    from roster_members rm
    left join membership_types mt on mt.id = rm.membership_type_id
    where rm.club_id    = v_club_id
      and rm.claimed_by is null
      and (p_include_inactive or rm.status = 'active')
    order by (rm.status <> 'active') asc,
             rm.last_name asc nulls last, rm.first_name asc nulls last;
end;
$$;

revoke execute on function public.get_roster_members(boolean) from public, anon;
grant  execute on function public.get_roster_members(boolean) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- G. get_members — DROP + CREATE (same reason as F). Zero-arg signature
--    unchanged. Every existing column, join, filter, ordering, and
--    authorization check is byte-identical to the live 0132 body. The
--    new membership fields join through roster_members on
--    (club_id, claimed_by) — the exact per-club-unique pairing 0107
--    established (roster_members_club_claimed_by_uniq), so this LEFT JOIN
--    can never fan out rows: at most one roster_members row exists per
--    (club_id, claimed_by), preserving get_members()'s existing
--    one-row-per-membership cardinality exactly. Grant posture restored
--    exactly as it was (explicit revoke/grant already existed on this
--    function before this migration).
-- ═══════════════════════════════════════════════════════════════════════════
drop function if exists public.get_members();

create or replace function public.get_members()
returns table(id uuid, first_name text, last_name text, phone text, role text, status text, created_at timestamp with time zone, email text, is_lesson_provider boolean, removed_at timestamp with time zone, membership_status text, membership_type_id uuid, membership_type_name text)
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_actor_club_id uuid;
  v_actor_role    text;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;

  select public.current_user_club_id(), public.current_user_role()
    into v_actor_club_id, v_actor_role;

  if v_actor_role is distinct from 'admin' and v_actor_role is distinct from 'staff' then
    raise exception 'insufficient_role';
  end if;

  return query
    select
      p.id,
      p.first_name,
      p.last_name,
      p.phone,
      cm.role,
      cm.status,
      p.created_at,
      u.email::text as email,
      cm.is_lesson_provider,
      cm.removed_at,
      rm.membership_status,
      rm.membership_type_id,
      mt.name as membership_type_name
    from public.club_memberships cm
    join public.profiles p on p.id = cm.user_id
    left join auth.users u on u.id = p.id
    left join public.roster_members rm on rm.club_id = cm.club_id and rm.claimed_by = cm.user_id
    left join public.membership_types mt on mt.id = rm.membership_type_id
   where cm.club_id = v_actor_club_id
   order by (cm.removed_at is not null) asc,
            p.last_name asc nulls last, p.first_name asc nulls last;
end;
$function$;

revoke execute on function public.get_members() from public, anon;
grant  execute on function public.get_members() to authenticated;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration created in
-- this checkpoint)
-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Restore create_reservation, admin_create_member_reservation, and
--    update_member_reservation to their exact 0189 bodies (this migration
--    changed exactly one predicate in each — reverting is a pure text
--    restore, no signature change).
-- 2. Drop update_club_memberships_enabled(boolean) outright (new, safe).
-- 3. `drop function if exists public.get_roster_members(boolean);` then
--    restore the 0117 body (11-column RETURNS TABLE) via CREATE OR REPLACE.
-- 4. `drop function if exists public.get_members();` then restore the
--    0132 body (10-column RETURNS TABLE) via CREATE OR REPLACE, followed
--    by its existing revoke/grant (unchanged either way).
-- 5. `alter table public.club_settings drop column memberships_enabled;`
-- No other table, policy, or function is touched by this migration. 0188
-- and 0189 are read-only consumed here, never modified. No reservations
-- row is ever UPDATEd by this migration — no backfill, no bulk rewrite.
