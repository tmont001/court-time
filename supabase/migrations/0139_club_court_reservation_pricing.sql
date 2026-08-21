-- 0139_club_court_reservation_pricing.sql
-- Phase 34B — Admin-Controlled Pricing Foundation, part 1 of 4.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
-- Introduces club-wide currency and OPTIONAL court-reservation pricing.
-- Court pricing is opt-in: a club that never configures a rate experiences
-- zero behavioral change — booking still works, every price column stays
-- NULL, and no UI surfaces a price. This is a locked product requirement,
-- not a default assumption.
--
-- Production preflight (2026, this checkpoint) confirmed: 4 clubs, 4
-- club_settings rows (no missing rows), 16 courts, 416 existing
-- reservations. None of these existing rows are backfilled with a price —
-- they remain NULL, meaning "no price was recorded for this historical
-- booking," which is honest and correct since none was ever charged.
--
-- Every RPC body below is copied verbatim from the Production
-- pg_get_functiondef output supplied directly by the operator (2026,
-- this checkpoint) — not reconstructed from migration history. The ONLY
-- change to each existing function is the price-resolution/snapshot logic
-- described in its own inline comment; every validation, locking,
-- concurrency, operating-hours, and notification behavior is reproduced
-- byte-for-byte.
--
-- Money representation: integer minor units (cents) everywhere, never
-- floating point. NULL = no price configured / no historical price
-- recorded. 0 = explicitly free. >0 = a configured amount. Currency is
-- club-wide (club_settings.currency) — no column anywhere gets its own
-- per-row currency; one club, one currency.
--
-- Does not touch club_subscriptions or club_entitlements (Court Time's own
-- SaaS billing — architecturally unrelated to what a club charges its
-- members) and does not depend on Staff-Managed vs Connected tier in any
-- way — pricing configuration is available regardless of tier.
--
-- Does not modify 0131-0138. Not applied by this checkpoint. Apply in
-- Supabase SQL Editor (cloud only).
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ─────────────────────────────────────────────────────────────────────────
-- Schema
-- ─────────────────────────────────────────────────────────────────────────

alter table public.club_settings
  add column currency text not null default 'USD',
  add column default_court_hourly_rate_cents integer null;

alter table public.club_settings
  add constraint club_settings_currency_format
    check (currency ~ '^[A-Z]{3}$');

alter table public.club_settings
  add constraint club_settings_default_court_hourly_rate_cents_nonneg
    check (default_court_hourly_rate_cents is null or default_court_hourly_rate_cents >= 0);

alter table public.courts
  add column hourly_rate_cents integer null;

alter table public.courts
  add constraint courts_hourly_rate_cents_nonneg
    check (hourly_rate_cents is null or hourly_rate_cents >= 0);

-- Shared table for every reservation reason (member_booking, maintenance,
-- admin_block, event, pro_lesson) — these two columns are only ever
-- populated for reason='member_booking'. Every other reason leaves them
-- NULL by construction (no code path below ever writes them for a
-- non-member_booking row).
alter table public.reservations
  add column hourly_rate_cents  integer null,
  add column price_amount_cents integer null;

alter table public.reservations
  add constraint reservations_hourly_rate_cents_nonneg
    check (hourly_rate_cents is null or hourly_rate_cents >= 0);

alter table public.reservations
  add constraint reservations_price_amount_cents_nonneg
    check (price_amount_cents is null or price_amount_cents >= 0);

-- ─────────────────────────────────────────────────────────────────────────
-- update_club_pricing — new, Admin-only. Mirrors update_club_settings'
-- exact auth/audit style (profiles-direct, same-club, audited). Kept
-- entirely separate from update_club_settings itself per instruction —
-- small dedicated pricing RPC, no argument added to the existing one.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.update_club_pricing(
  p_currency text,
  p_default_court_hourly_rate_cents integer
)
returns club_settings
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_profile  profiles%rowtype;
  v_currency text;
  v_result   club_settings%rowtype;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.role <> 'admin' then raise exception 'insufficient_role'; end if;

  if p_currency is null or btrim(p_currency) = '' then raise exception 'currency_required'; end if;
  v_currency := upper(btrim(p_currency));
  if v_currency !~ '^[A-Z]{3}$' then raise exception 'invalid_currency'; end if;

  if p_default_court_hourly_rate_cents is not null and p_default_court_hourly_rate_cents < 0 then
    raise exception 'invalid_rate';
  end if;

  update club_settings set
    currency                        = v_currency,
    default_court_hourly_rate_cents = p_default_court_hourly_rate_cents,
    updated_at                      = now()
  where club_id = v_profile.club_id
  returning * into v_result;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'update_club_pricing',
    'club_settings',
    v_result.club_id,
    jsonb_build_object(
      'currency', v_currency,
      'default_court_hourly_rate_cents', p_default_court_hourly_rate_cents
    )
  );

  return v_result;
end;
$$;

revoke execute on function public.update_club_pricing(text, integer) from public, anon;
grant  execute on function public.update_club_pricing(text, integer) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- set_court_hourly_rate — new, Admin-only. Mirrors set_court_active's
-- exact auth/audit style. A court override may exist even when the club
-- default is NULL — resolution order is court override, else club
-- default, else unpriced.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.set_court_hourly_rate(
  p_court_id uuid,
  p_hourly_rate_cents integer
)
returns courts
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_profile profiles%rowtype;
  v_result  courts%rowtype;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.role <> 'admin' then raise exception 'insufficient_role'; end if;

  if not exists (
    select 1 from courts where id = p_court_id and club_id = v_profile.club_id
  ) then
    raise exception 'invalid_court';
  end if;

  if p_hourly_rate_cents is not null and p_hourly_rate_cents < 0 then
    raise exception 'invalid_rate';
  end if;

  update courts set hourly_rate_cents = p_hourly_rate_cents
  where id = p_court_id
  returning * into v_result;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id, auth.uid(), 'set_court_hourly_rate', 'court', p_court_id,
    jsonb_build_object('hourly_rate_cents', p_hourly_rate_cents)
  );

  return v_result;
end;
$$;

revoke execute on function public.set_court_hourly_rate(uuid, integer) from public, anon;
grant  execute on function public.set_court_hourly_rate(uuid, integer) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- create_reservation — verbatim Production body + price snapshot. v_court
-- and v_settings were already selected by the existing body; no new
-- lookups added, just a new resolve-and-snapshot block before the insert.
-- ─────────────────────────────────────────────────────────────────────────
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

  -- Phase 34B: resolve and snapshot court-booking price. hourly_rate_cents
  -- = court override, else club default, else NULL (unpriced club/court —
  -- court pricing is optional). price_amount_cents = hourly_rate_cents ×
  -- duration; NULL when unpriced. Snapshotted once, here, at booking time
  -- — a later admin rate change never repriced this reservation.
  v_hourly_rate_cents := coalesce(v_court.hourly_rate_cents, v_settings.default_court_hourly_rate_cents);
  if v_hourly_rate_cents is not null then
    v_price_amount_cents := round(v_hourly_rate_cents * extract(epoch from (p_ends_at - p_starts_at)) / 3600.0)::integer;
  else
    v_price_amount_cents := null;
  end if;

  insert into reservations (
    club_id, court_id, owner_user_id, roster_member_id,
    starts_at, ends_at, status, reason,
    format, player_count, guest_names, notes, created_by,
    hourly_rate_cents, price_amount_cents
  ) values (
    v_profile.club_id, p_court_id, auth.uid(), v_roster_member_id,
    p_starts_at, p_ends_at, 'confirmed', 'member_booking',
    p_format, p_player_count, p_guest_names, p_notes, auth.uid(),
    v_hourly_rate_cents, v_price_amount_cents
  )
  returning * into v_result;

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

-- ─────────────────────────────────────────────────────────────────────────
-- admin_create_member_reservation — verbatim Production body + price
-- snapshot. Adds a v_settings lookup (not previously present) alongside
-- the existing v_court lookup, using the identical resolve formula as
-- create_reservation.
-- ─────────────────────────────────────────────────────────────────────────
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

  -- Phase 34B: identical resolve/snapshot formula as create_reservation.
  v_hourly_rate_cents := coalesce(v_court.hourly_rate_cents, v_settings.default_court_hourly_rate_cents);
  if v_hourly_rate_cents is not null then
    v_price_amount_cents := round(v_hourly_rate_cents * extract(epoch from (p_ends_at - p_starts_at)) / 3600.0)::integer;
  else
    v_price_amount_cents := null;
  end if;

  insert into public.reservations (
    club_id, court_id, owner_user_id, roster_member_id,
    starts_at, ends_at, status, reason,
    format, player_count, guest_names, notes, created_by,
    hourly_rate_cents, price_amount_cents
  ) values (
    v_club_id, p_court_id, v_owner_id, p_roster_member_id,
    p_starts_at, p_ends_at, 'confirmed', 'member_booking',
    p_format, p_player_count, p_guest_names, p_notes, auth.uid(),
    v_hourly_rate_cents, v_price_amount_cents
  )
  returning * into v_result;

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

-- ─────────────────────────────────────────────────────────────────────────
-- update_member_reservation — verbatim Production body + reservation-edit
-- pricing invariants:
--   A. court unchanged + duration unchanged (includes time-shift-only and
--      Member reassignment) -> preserve both snapshots exactly.
--   B. court unchanged + duration changed -> preserve the EXISTING
--      hourly_rate_cents snapshot; recompute price_amount_cents from that
--      preserved rate × the new duration. A NULL rate snapshot stays NULL
--      (never silently adopts today's rate for a legacy reservation).
--   C. court changed (regardless of duration) -> resolve the DESTINATION
--      court's CURRENT rate; replace both snapshots. This also applies to
--      a legacy NULL-priced reservation — changing courts is a new
--      pricing dimension.
-- v_court is already populated by the existing v_scheduling_changed block
-- whenever the court changes (that block always re-selects v_court by
-- p_court_id). A club_settings lookup is added for the club-default
-- fallback in case C.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.update_member_reservation(p_reservation_id uuid, p_expected_club_id uuid, p_expected_updated_at timestamp with time zone, p_court_id uuid, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone, p_roster_member_id uuid, p_format text DEFAULT NULL::text, p_player_count integer DEFAULT NULL::integer, p_guest_names text[] DEFAULT NULL::text[], p_notes text DEFAULT NULL::text)
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
  -- own header comment above for the full A/B/C rule statement.
  v_court_changed    := p_court_id is distinct from v_before.court_id;
  v_duration_changed := (p_ends_at - p_starts_at) is distinct from (v_before.ends_at - v_before.starts_at);

  if v_court_changed then
    select * into v_settings from public.club_settings where club_id = v_club_id;
    v_new_hourly_rate_cents := coalesce(v_court.hourly_rate_cents, v_settings.default_court_hourly_rate_cents);
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
    updated_at        = now()
  where id = p_reservation_id
  returning * into v_after;

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
        'price_amount_cents', v_before.price_amount_cents
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
        'price_amount_cents', v_after.price_amount_cents
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

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration created in
-- this checkpoint)
-- ═══════════════════════════════════════════════════════════════════════════
-- Drop update_club_pricing(text, integer) and set_court_hourly_rate(uuid,
-- integer) (both new, safe to drop outright). Restore create_reservation,
-- admin_create_member_reservation, and update_member_reservation by
-- re-querying their live Production definitions (pg_get_functiondef)
-- immediately before rolling back. Drop the new columns/constraints on
-- club_settings, courts, and reservations. No other table or policy is
-- touched by this migration.
