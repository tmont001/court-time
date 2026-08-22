-- 0144_payment_obligation_wiring.sql
-- Phase 34C — Payment Obligation Wiring.
--
-- Redefines exactly 17 existing functions so that a confirmed, positively-
-- priced commitment calls into the 0143 obligation helpers
-- (_create_payment_obligation / _adjust_payment_obligation /
-- _check_member_reassignment_allowed). Every body below is reproduced
-- verbatim from an authoritative Production pg_get_functiondef() export
-- (/Users/thomasmontanaro/Downloads/phase34c-production-functiondefs.txt,
-- 2447 lines, 17/17 functions confirmed present) — NOT reconstructed from
-- migration history. Every delta from that Production text is a small,
-- explicitly-commented addition; nothing else about any of these 17
-- functions — signatures, return contracts, scheduling rules, capacity
-- rules, identity rules, notifications, audit logging, role checks, or
-- SECURITY DEFINER / search_path — is changed.
--
-- Cancellation/remove/leave RPCs are NOT touched by this migration.
-- Financial resolution (refund/void/waive) remains an explicit, separate
-- Admin action in every case — nothing here automates it.
--
-- Apply in Supabase SQL Editor (cloud only).

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. create_reservation
-- ═══════════════════════════════════════════════════════════════════════════
-- Delta: after the reservation insert, ensure a normal obligation using the
-- price/roster identity already resolved and snapshotted by Production onto
-- the new row. Always a fresh row (self-service booking creates, never
-- reactivates) — NORMAL/idempotent-ensure semantics (p_new_cycle omitted).
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
-- 2. admin_create_member_reservation
-- ═══════════════════════════════════════════════════════════════════════════
-- Delta: identical obligation-ensure call as create_reservation, using the
-- roster identity and price this function already resolves/snapshots.
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
-- 3. update_member_reservation
-- ═══════════════════════════════════════════════════════════════════════════
-- Delta: two additions.
--  (a) When the Member is being reassigned, _check_member_reassignment_
--      allowed is called BEFORE the mutating UPDATE — raises
--      payment_resolution_required_before_member_reassignment if the
--      current obligation cycle retains unresolved money. Placed
--      immediately after v_new_owner_id is resolved, before the
--      scheduling-conflict checks — a pure addition, no existing check's
--      order or error precedence is disturbed.
--  (b) After the mutating UPDATE: if the Member changed, an EXPLICIT NEW
--      CYCLE obligation is ensured for the NEW Member at the resulting
--      price — reassignment is independently material even when the price
--      itself didn't change. Otherwise, if the price changed, the existing
--      obligation (if any) is adjusted to the new total (0 is a valid
--      total; NULL is deliberately left unadjusted — see comment below),
--      and a normal obligation is ensured in case none existed yet. If
--      neither the Member nor the price changed, no payment call is made
--      at all — enabling Manual mode does not retroactively create
--      obligations for untouched bookings.
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

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. admin_create_member_lesson
-- ═══════════════════════════════════════════════════════════════════════════
-- Delta: ensure a normal obligation after the lesson_requests insert, using
-- the roster identity and price this function already resolves/snapshots.
-- Always an immediately-confirmed fresh row.
CREATE OR REPLACE FUNCTION public.admin_create_member_lesson(p_expected_club_id uuid, p_roster_member_id uuid, p_pro_id uuid, p_court_id uuid, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone, p_lesson_type_id uuid DEFAULT NULL::uuid, p_member_note text DEFAULT NULL::text)
 RETURNS lesson_requests
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_club_id           uuid;
  v_role              text;
  v_roster            public.roster_members%rowtype;
  v_member_id         uuid;
  v_pro                public.profiles%rowtype;
  v_duration_minutes  int;
  v_tz                text;
  v_res_id            uuid;
  v_result            public.lesson_requests%rowtype;
  v_member_name       text;
  -- FINAL LESSON PRICING REFINEMENT: flat-or-hourly price snapshot,
  -- resolved once at creation from the selected lesson_types row.
  v_pricing_basis            text;
  v_unit_price_amount_cents  integer;
  v_price_amount_cents       integer;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
  if v_role is null or v_role not in ('admin', 'pro', 'staff') then raise exception 'insufficient_role'; end if;

  -- A Pro may only book themselves as the lesson provider — assigning a
  -- different Pro remains an admin/staff-only action. Unchanged: this
  -- check is keyed to role='pro' specifically, so it never applies to a
  -- Staff caller (see this section's header above).
  if v_role = 'pro' and p_pro_id <> auth.uid() then
    raise exception 'insufficient_role';
  end if;

  select * into v_roster
    from public.roster_members
   where id      = p_roster_member_id
     and club_id = v_club_id;
  if not found then raise exception 'roster_member_not_found'; end if;

  v_member_id   := v_roster.claimed_by;
  v_member_name := trim(coalesce(v_roster.first_name, '') || ' ' || coalesce(v_roster.last_name, ''));

  -- Validate pro: active, same club, role pro/admin/staff, is_lesson_provider = true
  select * into v_pro
    from public.profiles
   where id                 = p_pro_id
     and club_id            = v_club_id
     and status              = 'active'
     and role                in ('pro', 'admin', 'staff')
     and is_lesson_provider  = true;
  if not found then raise exception 'pro_not_found'; end if;

  if v_member_id is not null and v_member_id = p_pro_id then
    raise exception 'cannot_request_yourself';
  end if;

  if p_starts_at < now() then raise exception 'cannot_propose_past_time'; end if;
  if p_ends_at  <= p_starts_at then raise exception 'invalid_duration'; end if;

  v_duration_minutes := round(extract(epoch from (p_ends_at - p_starts_at)) / 60)::int;
  if v_duration_minutes < 30 or v_duration_minutes % 15 <> 0 then
    raise exception 'invalid_duration';
  end if;

  if not exists (
    select 1 from public.courts
     where id        = p_court_id
       and club_id   = v_club_id
       and is_active = true
  ) then
    raise exception 'court_not_found';
  end if;

  if p_lesson_type_id is not null then
    if not exists (
      select 1 from public.lesson_types lt
       where lt.id        = p_lesson_type_id
         and lt.club_id   = v_club_id
         and lt.is_active = true
    ) then
      raise exception 'lesson_type_not_found';
    end if;

    if exists (
      select 1 from public.lesson_types lt
       where lt.id               = p_lesson_type_id
         and lt.allowed_durations is not null
         and array_length(lt.allowed_durations, 1) > 0
         and not (v_duration_minutes = any(lt.allowed_durations))
    ) then
      raise exception 'duration_not_allowed_for_type';
    end if;

    -- FINAL LESSON PRICING REFINEMENT: resolved once here at creation.
    -- flat: total = the configured unit amount. hourly: total = the
    -- configured hourly unit rate multiplied by this Lesson's own
    -- duration, rounded to the nearest cent (same integer-safe pattern as
    -- court pricing). A NULL unit price always yields a NULL total,
    -- whichever basis. No per-pro override; no per-participant math.
    select pricing_basis, unit_price_amount_cents
      into v_pricing_basis, v_unit_price_amount_cents
      from public.lesson_types where id = p_lesson_type_id;

    if v_pricing_basis = 'hourly' then
      if v_unit_price_amount_cents is not null then
        v_price_amount_cents := round(v_unit_price_amount_cents * v_duration_minutes / 60.0)::integer;
      else
        v_price_amount_cents := null;
      end if;
    else
      v_price_amount_cents := v_unit_price_amount_cents;
    end if;
  end if;

  if length(p_member_note) > 500 then raise exception 'note_too_long'; end if;

  if exists (
    select 1 from public.reservations r
     where r.court_id = p_court_id
       and r.status   in ('pending', 'confirmed')
       and tstzrange(r.starts_at, r.ends_at, '[)') && tstzrange(p_starts_at, p_ends_at, '[)')
  ) then
    raise exception 'court_conflict';
  end if;

  select timezone into v_tz from public.clubs where id = v_club_id;
  perform public._lesson_check_operating_hours(v_club_id, p_starts_at, p_ends_at, v_tz);

  perform public._lesson_check_pro_availability(p_pro_id, p_starts_at, p_ends_at, null);

  perform public._lesson_check_member_availability(v_member_id, p_roster_member_id, p_starts_at, p_ends_at, null);

  insert into public.reservations (
    club_id, court_id, owner_user_id, roster_member_id,
    starts_at, ends_at, status, reason,
    notes, show_notes_to_members, created_by
  ) values (
    v_club_id, p_court_id, p_pro_id, p_roster_member_id,
    p_starts_at, p_ends_at, 'confirmed', 'pro_lesson',
    'Pro lesson with ' || v_member_name,
    false,
    auth.uid()
  ) returning id into v_res_id;

  insert into public.lesson_requests (
    club_id, member_id, pro_id, roster_member_id,
    duration_minutes, member_note, lesson_type_id,
    proposed_starts_at, proposed_ends_at, proposed_court_id,
    status, linked_reservation_id, confirmed_at,
    last_actor_id, last_actor_role,
    pricing_basis, unit_price_amount_cents, price_amount_cents
  ) values (
    v_club_id, v_member_id, p_pro_id, p_roster_member_id,
    v_duration_minutes, btrim(coalesce(p_member_note, '')), p_lesson_type_id,
    p_starts_at, p_ends_at, p_court_id,
    'confirmed', v_res_id, now(),
    auth.uid(), v_role,
    v_pricing_basis, v_unit_price_amount_cents, v_price_amount_cents
  ) returning * into v_result;

  -- Phase 34C: ensure a normal payment obligation for this fresh, confirmed lesson.
  perform public._create_payment_obligation(
    v_club_id, 'lesson_request', v_result.id, p_roster_member_id,
    v_price_amount_cents, auth.uid()
  );

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'admin_create_member_lesson', 'lesson_request', v_result.id,
    jsonb_build_object(
      'roster_member_id', p_roster_member_id,
      'member_id',        v_member_id,
      'member_claimed',   v_member_id is not null,
      'pro_id',           p_pro_id,
      'reservation_id',   v_res_id,
      'duration_minutes', v_duration_minutes,
      'actor_role',       v_role
    )
  );

  if p_pro_id <> auth.uid() then
    insert into public.notifications (club_id, user_id, kind, body, metadata)
    values (
      v_club_id, p_pro_id, 'lesson_request_confirmed',
      'Lesson with ' || v_member_name || ' confirmed for ' ||
        to_char(p_starts_at at time zone v_tz, 'Mon DD "at" HH12:MI AM') || '.',
      jsonb_build_object('request_id', v_result.id, 'reservation_id', v_res_id)
    );
  end if;

  if v_member_id is not null then
    insert into public.notifications (club_id, user_id, kind, body, metadata)
    values (
      v_club_id, v_member_id, 'lesson_request_confirmed',
      'Your lesson with ' ||
        trim(coalesce(v_pro.first_name, '') || ' ' || coalesce(v_pro.last_name, '')) ||
        ' is confirmed for ' || to_char(p_starts_at at time zone v_tz, 'Mon DD "at" HH12:MI AM') || '.',
      jsonb_build_object('request_id', v_result.id, 'reservation_id', v_res_id)
    );
  end if;

  return v_result;
end;
$function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. accept_lesson_proposal
-- ═══════════════════════════════════════════════════════════════════════════
-- Delta: Production already computes v_is_reschedule (line "v_is_reschedule
-- := v_request.linked_reservation_id is not null"). An obligation is
-- ensured ONLY when this is NOT a reschedule — a reschedule acceptance is
-- the SAME Lesson commitment continuing under a replacement court
-- reservation, never a second financial cycle. Placed right after the
-- lesson_requests UPDATE, before notifications.
CREATE OR REPLACE FUNCTION public.accept_lesson_proposal(p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_profile         public.profiles%rowtype;
  v_request         public.lesson_requests%rowtype;
  v_pro             public.profiles%rowtype;
  v_member          public.profiles%rowtype;
  v_old_reservation public.reservations%rowtype;
  v_is_reschedule   boolean;
  v_tz              text;
  v_res_id          uuid;
  v_time_label      text;
  -- Phase 33D1 correction: the caller's own current roster identity in
  -- this club, server-resolved only — never a client-supplied roster id.
  v_caller_roster_id uuid;
begin
  select * into v_profile from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.club_id is null then raise exception 'no_club'; end if;

  -- Fetch and row-lock
  select * into v_request
    from public.lesson_requests
   where id      = p_request_id
     and club_id = v_profile.club_id
   for update;
  if not found then raise exception 'request_not_found'; end if;

  select id into v_caller_roster_id
    from public.roster_members
   where club_id    = v_profile.club_id
     and claimed_by = auth.uid();

  -- Phase 33D1 correction: authorized if the caller matches EITHER the
  -- historical member_id snapshot OR the lesson's durable roster_
  -- member_id via the caller's own current roster identity — the second
  -- branch is what makes this valid after a previously-unclaimed roster
  -- identity is later claimed (member_id stays null forever on that row;
  -- only the roster route can ever authorize it). Written as explicit
  -- `is not null and =` comparisons throughout rather than `<>`, so there
  -- is no three-valued-NULL-logic trap to reason about — a null on either
  -- side simply fails to match, never silently admits.
  if not (
    (v_request.member_id is not null and v_request.member_id = auth.uid())
    or (v_caller_roster_id is not null and v_request.roster_member_id = v_caller_roster_id)
  ) then
    raise exception 'not_your_request';
  end if;

  -- Must be in 'proposed' status
  if v_request.status <> 'proposed' then raise exception 'invalid_status_for_accept'; end if;

  -- proposed_starts_at / proposed_ends_at must be populated (enforced by constraint but guard anyway)
  if v_request.proposed_starts_at is null or v_request.proposed_ends_at is null then
    raise exception 'proposed_time_missing';
  end if;

  -- Proposed time must still be in the future
  if v_request.proposed_starts_at <= now() then raise exception 'proposed_time_in_past'; end if;

  -- Court required
  if v_request.proposed_court_id is null then raise exception 'proposed_court_missing'; end if;

  -- Revalidate the proposed court is still active and belongs to this club
  -- — it may have been deactivated at any point between proposal and
  -- acceptance. Uses the same court_not_found vocabulary as
  -- propose_lesson_time's own court check. Applies to every acceptance,
  -- not only a reschedule — accept_lesson_proposal previously trusted
  -- proposed_court_id unconditionally.
  if not exists (
    select 1 from public.courts
     where id        = v_request.proposed_court_id
       and club_id   = v_profile.club_id
       and is_active = true
  ) then
    raise exception 'court_not_found';
  end if;

  v_is_reschedule := v_request.linked_reservation_id is not null;

  -- Reschedule: lock and soft-cancel the old confirmed reservation before
  -- inserting its replacement, in this same transaction. Any failure below
  -- (including a genuine court conflict on the new slot, raised as Postgres
  -- 23P01 by the GiST exclusion constraint) rolls back this entire
  -- function, so the old reservation is left exactly as it was —
  -- 'confirmed' — never left cancelled with no replacement.
  if v_is_reschedule then
    select * into v_old_reservation
      from public.reservations
     where id      = v_request.linked_reservation_id
       and club_id = v_profile.club_id
       and reason  = 'pro_lesson'
       and status  = 'confirmed'
     for update;
    if not found then raise exception 'linked_reservation_not_found'; end if;

    -- The original lesson may have started (or already ended) in the time
    -- between proposal and acceptance. Checked before any mutation —
    -- including the old reservation's own cancellation below — so a stale
    -- acceptance can never cancel a lesson that has already happened.
    if v_old_reservation.starts_at <= now() then
      raise exception 'cannot_reschedule_started_lesson';
    end if;

    update public.reservations
       set status            = 'cancelled',
           cancelled_at      = now(),
           cancelled_by      = auth.uid(),
           cancellation_kind = 'system',
           updated_at        = now()
     where id = v_old_reservation.id;
  end if;

  -- Operating hours check
  select timezone into v_tz from public.clubs where id = v_profile.club_id;
  perform public._lesson_check_operating_hours(
    v_profile.club_id,
    v_request.proposed_starts_at,
    v_request.proposed_ends_at,
    v_tz
  );

  -- Pro availability check — excludes this request's own (already
  -- soft-cancelled above, if a reschedule) linked reservation.
  perform public._lesson_check_pro_availability(
    v_request.pro_id,
    v_request.proposed_starts_at,
    v_request.proposed_ends_at,
    v_request.id
  );

  -- Member availability check (caller is the member accepting). Phase
  -- 33D1: widened args — auth.uid() is the caller's own current account
  -- (always correct here regardless of claim timing, since the caller
  -- just proved ownership above), plus the durable roster_member_id for
  -- the widened conflict categories (Section M).
  perform public._lesson_check_member_availability(
    auth.uid(),
    v_request.roster_member_id,
    v_request.proposed_starts_at,
    v_request.proposed_ends_at,
    v_request.id
  );

  -- Fetch names for notifications
  select * into v_pro    from public.profiles where id = v_request.pro_id;
  select * into v_member from public.profiles where id = auth.uid();

  -- Create the replacement reservation (GiST EXCLUDE handles court conflicts
  -- atomically). Phase 33D1: roster_member_id added — v_request.roster_
  -- member_id was already resolved and stored at submission time
  -- (submit_lesson_request), so it is reused directly here rather than
  -- re-resolved; it is the same durable identity throughout this lesson's
  -- lifecycle.
  insert into public.reservations (
    club_id, court_id, owner_user_id, roster_member_id,
    starts_at, ends_at, status, reason,
    notes, show_notes_to_members, created_by
  ) values (
    v_profile.club_id,
    v_request.proposed_court_id,
    v_request.pro_id,
    v_request.roster_member_id,
    v_request.proposed_starts_at,
    v_request.proposed_ends_at,
    'confirmed',
    'pro_lesson',
    'Pro lesson with ' || trim(coalesce(v_member.first_name, '') || ' ' || coalesce(v_member.last_name, '')),
    false,
    auth.uid()
  ) returning id into v_res_id;

  -- Update the request
  update public.lesson_requests
     set status               = 'confirmed',
         linked_reservation_id = v_res_id,
         confirmed_at         = now(),
         last_actor_id        = auth.uid(),
         last_actor_role      = 'member',
         updated_at           = now()
   where id = p_request_id;

  -- Phase 34C: ensure a normal payment obligation ONLY on first
  -- confirmation. A reschedule acceptance (v_is_reschedule = true) is the
  -- same Lesson commitment continuing under a replacement reservation —
  -- never a second obligation cycle.
  if not v_is_reschedule then
    perform public._create_payment_obligation(
      v_profile.club_id, 'lesson_request', p_request_id, v_request.roster_member_id,
      v_request.price_amount_cents, auth.uid()
    );
  end if;

  v_time_label := to_char(v_request.proposed_starts_at at time zone v_tz, 'Mon DD "at" HH12:MI AM');

  -- Notify member
  insert into public.notifications (club_id, user_id, kind, body, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'lesson_request_confirmed',
    'Your lesson with ' ||
      trim(coalesce(v_pro.first_name, '') || ' ' || coalesce(v_pro.last_name, '')) ||
      ' is confirmed for ' || v_time_label || '.',
    jsonb_build_object('request_id', p_request_id, 'reservation_id', v_res_id)
  );

  -- Notify pro
  insert into public.notifications (club_id, user_id, kind, body, metadata)
  values (
    v_profile.club_id,
    v_request.pro_id,
    'lesson_request_confirmed',
    'Lesson with ' ||
      trim(coalesce(v_member.first_name, '') || ' ' || coalesce(v_member.last_name, '')) ||
      ' confirmed for ' || v_time_label || '.',
    jsonb_build_object('request_id', p_request_id, 'reservation_id', v_res_id)
  );

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id, auth.uid(), 'accept_lesson_proposal', 'lesson_request', p_request_id,
    jsonb_build_object(
      'reservation_id',     v_res_id,
      'new_reservation_id', v_res_id,
      'old_reservation_id', case when v_is_reschedule then v_old_reservation.id else null end,
      'is_reschedule',      v_is_reschedule,
      'roster_member_id',   v_request.roster_member_id
    )
  );

  return jsonb_build_object('request_id', p_request_id, 'reservation_id', v_res_id);
end;
$function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. admin_update_member_lesson
-- ═══════════════════════════════════════════════════════════════════════════
-- Delta: mirrors update_member_reservation exactly. (a)
-- _check_member_reassignment_allowed before the mutation, added right
-- after v_pro_changed is computed (after all price-snapshot computation,
-- before the scheduling-mutation block). (b) after the lesson_requests
-- UPDATE, the same member-reassignment/price-adjustment payment wiring,
-- keyed off the function's own already-computed v_price_amount_cents vs
-- v_before.price_amount_cents.
CREATE OR REPLACE FUNCTION public.admin_update_member_lesson(p_request_id uuid, p_expected_club_id uuid, p_expected_updated_at timestamp with time zone, p_roster_member_id uuid, p_pro_id uuid, p_court_id uuid, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone, p_lesson_type_id uuid DEFAULT NULL::uuid, p_member_note text DEFAULT NULL::text)
 RETURNS lesson_requests
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_club_id           uuid;
  v_role              text;
  v_before            public.lesson_requests%rowtype;
  v_old_reservation   public.reservations%rowtype;
  v_roster            public.roster_members%rowtype;
  v_member_id         uuid;
  v_pro               public.profiles%rowtype;
  v_duration_minutes  int;
  v_tz                text;
  v_scheduling_changed boolean;
  v_member_changed     boolean;
  v_pro_changed        boolean;
  v_res_id             uuid;
  v_member_name        text;
  v_result             public.lesson_requests%rowtype;
  -- FINAL LESSON PRICING REFINEMENT: lesson-type-change re-snapshot, plus
  -- duration-only recompute for an hourly-priced Lesson whose type is
  -- unchanged.
  v_lesson_type_changed boolean;
  v_duration_changed     boolean;
  v_pricing_basis            text;
  v_unit_price_amount_cents  integer;
  v_price_amount_cents       integer;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
  if v_role is null or v_role not in ('admin', 'staff') then raise exception 'insufficient_role'; end if;

  select * into v_before
    from public.lesson_requests
   where id      = p_request_id
     and club_id = v_club_id
   for update;
  if not found then raise exception 'request_not_found'; end if;

  if v_before.status <> 'confirmed' then raise exception 'invalid_status_for_edit'; end if;
  if v_before.updated_at is distinct from p_expected_updated_at then raise exception 'stale_edit_conflict'; end if;
  if v_before.linked_reservation_id is null then raise exception 'linked_reservation_not_found'; end if;

  select * into v_old_reservation
    from public.reservations
   where id      = v_before.linked_reservation_id
     and club_id = v_club_id
     and reason  = 'pro_lesson'
     and status  = 'confirmed'
   for update;
  if not found then raise exception 'linked_reservation_not_found'; end if;

  if v_old_reservation.starts_at <= now() then
    raise exception 'cannot_reschedule_started_lesson';
  end if;

  -- Resolve and validate the (possibly reassigned) target roster Member.
  select * into v_roster
    from public.roster_members
   where id      = p_roster_member_id
     and club_id = v_club_id;
  if not found then raise exception 'roster_member_not_found'; end if;

  v_member_id   := v_roster.claimed_by;
  v_member_name := trim(coalesce(v_roster.first_name, '') || ' ' || coalesce(v_roster.last_name, ''));

  -- Validate (possibly reassigned) pro.
  select * into v_pro
    from public.profiles
   where id                 = p_pro_id
     and club_id            = v_club_id
     and status              = 'active'
     and role                in ('pro', 'admin', 'staff')
     and is_lesson_provider  = true;
  if not found then raise exception 'pro_not_found'; end if;

  if v_member_id is not null and v_member_id = p_pro_id then
    raise exception 'cannot_request_yourself';
  end if;

  if p_starts_at < now() then raise exception 'cannot_propose_past_time'; end if;
  if p_ends_at  <= p_starts_at then raise exception 'invalid_duration'; end if;

  v_duration_minutes := round(extract(epoch from (p_ends_at - p_starts_at)) / 60)::int;
  if v_duration_minutes < 30 or v_duration_minutes % 15 <> 0 then
    raise exception 'invalid_duration';
  end if;

  if not exists (
    select 1 from public.courts
     where id        = p_court_id
       and club_id   = v_club_id
       and is_active = true
  ) then
    raise exception 'court_not_found';
  end if;

  if p_lesson_type_id is not null then
    if not exists (
      select 1 from public.lesson_types lt
       where lt.id        = p_lesson_type_id
         and lt.club_id   = v_club_id
         and lt.is_active = true
    ) then
      raise exception 'lesson_type_not_found';
    end if;

    if exists (
      select 1 from public.lesson_types lt
       where lt.id               = p_lesson_type_id
         and lt.allowed_durations is not null
         and array_length(lt.allowed_durations, 1) > 0
         and not (v_duration_minutes = any(lt.allowed_durations))
    ) then
      raise exception 'duration_not_allowed_for_type';
    end if;
  end if;

  -- FINAL LESSON PRICING REFINEMENT — full A/B/C-style edit invariants:
  --
  --  * lesson_type_id UNCHANGED, duration UNCHANGED (time/court/provider/
  --    member-only edits): preserve pricing_basis, unit price, and total
  --    exactly.
  --  * lesson_type_id UNCHANGED, duration CHANGED: preserve the existing
  --    pricing_basis + unit price snapshot. flat -> total stays exactly
  --    what it was (a flat Lesson price does not scale with duration).
  --    hourly -> recompute total from the PRESERVED unit rate times the
  --    NEW duration. A NULL preserved unit price always keeps the total
  --    NULL — never silently adopt today's Lesson Type rate merely because
  --    an existing Lesson's duration changed.
  --  * lesson_type_id CHANGES: snapshot the NEW type's CURRENT
  --    pricing_basis + unit price, and calculate a fresh total from the
  --    Lesson's current (possibly also-changed) duration — changing what
  --    is priced re-resolves from its current configuration, exactly like
  --    the reservation court-change rule. Changing to no Lesson Type at
  --    all (NULL) clears all three snapshot fields to NULL.
  v_lesson_type_changed := p_lesson_type_id is distinct from v_before.lesson_type_id;
  v_duration_changed    := v_duration_minutes is distinct from v_before.duration_minutes;

  if v_lesson_type_changed then
    if p_lesson_type_id is not null then
      select pricing_basis, unit_price_amount_cents
        into v_pricing_basis, v_unit_price_amount_cents
        from public.lesson_types where id = p_lesson_type_id;

      if v_pricing_basis = 'hourly' then
        if v_unit_price_amount_cents is not null then
          v_price_amount_cents := round(v_unit_price_amount_cents * v_duration_minutes / 60.0)::integer;
        else
          v_price_amount_cents := null;
        end if;
      else
        v_price_amount_cents := v_unit_price_amount_cents;
      end if;
    else
      v_pricing_basis           := null;
      v_unit_price_amount_cents := null;
      v_price_amount_cents      := null;
    end if;
  else
    v_pricing_basis           := v_before.pricing_basis;
    v_unit_price_amount_cents := v_before.unit_price_amount_cents;

    if v_duration_changed and v_pricing_basis = 'hourly' and v_unit_price_amount_cents is not null then
      v_price_amount_cents := round(v_unit_price_amount_cents * v_duration_minutes / 60.0)::integer;
    else
      v_price_amount_cents := v_before.price_amount_cents;
    end if;
  end if;

  if length(p_member_note) > 500 then raise exception 'note_too_long'; end if;

  v_scheduling_changed := (p_court_id, p_starts_at, p_ends_at)
    is distinct from (v_old_reservation.court_id, v_old_reservation.starts_at, v_old_reservation.ends_at);
  v_member_changed := p_roster_member_id is distinct from v_before.roster_member_id;
  v_pro_changed     := p_pro_id is distinct from v_before.pro_id;

  -- Phase 34C: a reassignment must not silently abandon or transfer an
  -- unresolved obligation. Checked before any mutation below.
  if v_member_changed then
    perform public._check_member_reassignment_allowed(v_club_id, 'lesson_request', p_request_id);
  end if;

  select timezone into v_tz from public.clubs where id = v_club_id;

  if v_scheduling_changed or v_pro_changed then

    -- Phase 33E3 fix: court-conflict pre-check, excluding this lesson's
    -- own currently-linked reservation — mirrors propose_lesson_time's
    -- already-live pattern. Without this, a genuine court double-book was
    -- only ever caught by the raw GiST EXCLUDE constraint on reservations,
    -- whose untranslated error text mapLessonError() cannot match, so the
    -- UI showed a generic "Something went wrong" instead of the friendly,
    -- already-mapped court_conflict message.
    if exists (
      select 1 from public.reservations r
       where r.court_id = p_court_id
         and r.status   in ('pending', 'confirmed')
         and tstzrange(r.starts_at, r.ends_at, '[)') && tstzrange(p_starts_at, p_ends_at, '[)')
         and r.id is distinct from v_old_reservation.id
    ) then
      raise exception 'court_conflict';
    end if;

    -- Time and/or pro changed — re-validate operating hours / pro /
    -- member conflicts, excluding this lesson's own still-active
    -- reservation, exactly like a self-service reschedule. Member check
    -- is unconditional (correction pass — see admin_create_member_
    -- lesson's header note above); p_roster_member_id always supplied.
    perform public._lesson_check_operating_hours(v_club_id, p_starts_at, p_ends_at, v_tz);
    perform public._lesson_check_pro_availability(p_pro_id, p_starts_at, p_ends_at, p_request_id);
    perform public._lesson_check_member_availability(v_member_id, p_roster_member_id, p_starts_at, p_ends_at, p_request_id);
  end if;

  if v_scheduling_changed then
    -- Soft-cancel the old reservation and insert a new one — mirrors
    -- accept_lesson_proposal's own reschedule pattern exactly. The new
    -- row's created_by is this admin: it is a genuinely new row, not a
    -- rewrite of the old one's created_by (which stays untouched on the
    -- now-cancelled row).
    update public.reservations
       set status            = 'cancelled',
           cancelled_at      = now(),
           cancelled_by      = auth.uid(),
           cancellation_kind = 'system',
           updated_at        = now()
     where id = v_old_reservation.id;

    insert into public.reservations (
      club_id, court_id, owner_user_id, roster_member_id,
      starts_at, ends_at, status, reason,
      notes, show_notes_to_members, created_by
    ) values (
      v_club_id, p_court_id, p_pro_id, p_roster_member_id,
      p_starts_at, p_ends_at, 'confirmed', 'pro_lesson',
      'Pro lesson with ' || v_member_name,
      false,
      auth.uid()
    ) returning id into v_res_id;
  elsif v_member_changed or v_pro_changed then
    -- Nothing time-related changed — update the existing reservation row
    -- directly in place (no history-losing replace) rather than the
    -- soft-cancel-and-reinsert pattern above, which is reserved for an
    -- actual scheduling change.
    update public.reservations
       set owner_user_id    = p_pro_id,
           roster_member_id = p_roster_member_id,
           notes            = 'Pro lesson with ' || v_member_name,
           updated_at       = now()
     where id = v_old_reservation.id;
    v_res_id := v_old_reservation.id;
  else
    v_res_id := v_old_reservation.id;
  end if;

  update public.lesson_requests
     set roster_member_id    = p_roster_member_id,
         member_id           = v_member_id,
         pro_id              = p_pro_id,
         duration_minutes    = v_duration_minutes,
         member_note         = btrim(coalesce(p_member_note, '')),
         lesson_type_id      = p_lesson_type_id,
         proposed_starts_at  = p_starts_at,
         proposed_ends_at    = p_ends_at,
         proposed_court_id   = p_court_id,
         linked_reservation_id = v_res_id,
         last_actor_id       = auth.uid(),
         last_actor_role     = v_role,
         pricing_basis           = v_pricing_basis,
         unit_price_amount_cents = v_unit_price_amount_cents,
         price_amount_cents      = v_price_amount_cents,
         updated_at          = now()
   where id = p_request_id
  returning * into v_result;

  -- Phase 34C: payment wiring, after the mutation, mirroring
  -- update_member_reservation's rule exactly, including the Phase 34C
  -- lifecycle correction: p_roster_member_id is passed as the CURRENT
  -- identity into _adjust_payment_obligation, which no-ops if the latest
  -- cycle belongs to a prior Member (reassigned while unpriced) rather
  -- than silently adjusting their historical payment. Member reassignment
  -- always gets an explicit new cycle for the new Member; otherwise a
  -- price change adjusts the current cycle (if any, and if the new total
  -- is not NULL) and ensures one exists.
  if v_member_changed then
    perform public._create_payment_obligation(
      v_club_id, 'lesson_request', p_request_id, p_roster_member_id,
      v_price_amount_cents, auth.uid(), true
    );
  elsif v_price_amount_cents is distinct from v_before.price_amount_cents then
    if v_price_amount_cents is not null then
      perform public._adjust_payment_obligation(v_club_id, 'lesson_request', p_request_id, p_roster_member_id, v_price_amount_cents, auth.uid());
    end if;
    perform public._create_payment_obligation(
      v_club_id, 'lesson_request', p_request_id, p_roster_member_id,
      v_price_amount_cents, auth.uid()
    );
  end if;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'admin_update_member_lesson', 'lesson_request', p_request_id,
    jsonb_build_object(
      'before', jsonb_build_object(
        'roster_member_id', v_before.roster_member_id,
        'member_id',        v_before.member_id,
        'pro_id',           v_before.pro_id,
        'court_id',         v_old_reservation.court_id,
        'starts_at',        v_old_reservation.starts_at,
        'ends_at',          v_old_reservation.ends_at,
        'lesson_type_id',   v_before.lesson_type_id,
        'pricing_basis',    v_before.pricing_basis,
        'unit_price_amount_cents', v_before.unit_price_amount_cents,
        'price_amount_cents', v_before.price_amount_cents
      ),
      'after', jsonb_build_object(
        'roster_member_id', p_roster_member_id,
        'member_id',        v_member_id,
        'pro_id',           p_pro_id,
        'court_id',         p_court_id,
        'starts_at',        p_starts_at,
        'ends_at',          p_ends_at,
        'lesson_type_id',   p_lesson_type_id,
        'pricing_basis',    v_pricing_basis,
        'unit_price_amount_cents', v_unit_price_amount_cents,
        'price_amount_cents', v_price_amount_cents
      ),
      'scheduling_changed', v_scheduling_changed,
      'member_changed',     v_member_changed,
      'pro_changed',        v_pro_changed,
      'lesson_type_changed', v_lesson_type_changed,
      'duration_changed',    v_duration_changed,
      'reservation_id',     v_res_id,
      'old_reservation_id', case when v_scheduling_changed then v_old_reservation.id else null end
    )
  );

  -- Notify pro — always, when the pro or the schedule changed (always has
  -- an account). Notify member only if claimed and something material
  -- changed. Reuses the existing lesson_request_confirmed kind — no new
  -- notification kind is introduced.
  if v_scheduling_changed or v_pro_changed then
    insert into public.notifications (club_id, user_id, kind, body, metadata)
    values (
      v_club_id, p_pro_id, 'lesson_request_confirmed',
      'Lesson with ' || v_member_name || ' updated — now ' ||
        to_char(p_starts_at at time zone v_tz, 'Mon DD "at" HH12:MI AM') || '.',
      jsonb_build_object('request_id', p_request_id, 'reservation_id', v_res_id)
    );
  end if;

  if v_member_id is not null and (v_scheduling_changed or v_pro_changed or v_member_changed) then
    insert into public.notifications (club_id, user_id, kind, body, metadata)
    values (
      v_club_id, v_member_id, 'lesson_request_confirmed',
      'Your lesson with ' ||
        trim(coalesce(v_pro.first_name, '') || ' ' || coalesce(v_pro.last_name, '')) ||
        ' is confirmed for ' || to_char(p_starts_at at time zone v_tz, 'Mon DD "at" HH12:MI AM') || '.',
      jsonb_build_object('request_id', p_request_id, 'reservation_id', v_res_id)
    );
  end if;

  return v_result;
end;
$function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. join_event
-- ═══════════════════════════════════════════════════════════════════════════
-- Delta: the waitlisted branch is untouched (no obligation — waitlisting
-- never charges). In the confirmed branch, v_existing_found is exactly the
-- "reactivating a previously-cancelled row" signal here — the earlier
-- guard already raises already_joined for confirmed/waitlisted/offered, so
-- an existing row reaching this branch can only have been 'cancelled'.
-- v_event.price_amount_cents is what both the update and insert already
-- snapshot onto price_amount_cents (current Event price either way), so
-- passing it directly to the obligation call satisfies "reactivation
-- re-snapshots current Event price" without any separate re-snapshot
-- logic being added.
CREATE OR REPLACE FUNCTION public.join_event(p_event_id uuid)
 RETURNS event_participants
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_profile  profiles%rowtype;
  v_event    events%rowtype;
  v_existing event_participants%rowtype;
  v_existing_found boolean;
  v_count    int;
  v_result   event_participants%rowtype;
  v_roster_member_id uuid;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_profile.status <> 'active' then raise exception 'account_inactive'; end if;

  -- Phase 34A3: restated as an explicit admin/pro allowlist rather than a
  -- member-exclusion — see this section's header above.
  if v_profile.role not in ('admin', 'pro') and not current_club_has_capability('member_self_service') then
    raise exception 'capability_not_available';
  end if;

  select * into v_event
    from events
    where id      = p_event_id
      and club_id = v_profile.club_id
      and status  = 'scheduled'
    for update;
  if not found then raise exception 'event_not_found'; end if;

  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

  if not v_event.member_joinable then
    raise exception 'event_not_joinable';
  end if;

  if v_event.starts_at < now() then
    raise exception 'event_already_started';
  end if;

  select id into v_roster_member_id
    from roster_members
   where club_id    = v_profile.club_id
     and claimed_by = auth.uid();
  if not found then
    raise exception 'phase33d2_unresolved_member_identity';
  end if;

  perform expire_stale_offers_for_event(p_event_id, v_profile.club_id, v_event.title);
  perform advance_waitlist_offer(p_event_id, v_profile.club_id, v_event.title);

  select * into v_existing
    from event_participants
   where event_id = p_event_id
     and (profile_id = auth.uid() or roster_member_id = v_roster_member_id)
   for update;
  v_existing_found := found;

  if v_existing_found and v_existing.status in ('confirmed', 'waitlisted', 'offered') then
    raise exception 'already_joined';
  end if;

  v_count := public._event_effective_occupancy(
    p_event_id,
    case when v_existing_found then v_existing.id else null end
  );

  if v_count >= v_event.capacity then
    if v_existing_found then
      update event_participants
         set status = 'waitlisted', profile_id = auth.uid(), roster_member_id = v_roster_member_id,
             price_amount_cents = v_event.price_amount_cents, updated_at = now()
       where id = v_existing.id
      returning * into v_result;
    else
      insert into event_participants (event_id, profile_id, roster_member_id, role, status, price_amount_cents)
      values (p_event_id, auth.uid(), v_roster_member_id, 'participant', 'waitlisted', v_event.price_amount_cents)
      returning * into v_result;
    end if;

    if v_result.id is null then
      raise exception 'event_participant_write_failed';
    end if;
  else
    if v_existing_found then
      update event_participants
         set status = 'confirmed', profile_id = auth.uid(), roster_member_id = v_roster_member_id,
             price_amount_cents = v_event.price_amount_cents, updated_at = now()
       where id = v_existing.id
      returning * into v_result;
    else
      insert into event_participants (event_id, profile_id, roster_member_id, role, status, price_amount_cents)
      values (p_event_id, auth.uid(), v_roster_member_id, 'participant', 'confirmed', v_event.price_amount_cents)
      returning * into v_result;
    end if;

    if v_result.id is null then
      raise exception 'event_participant_write_failed';
    end if;

    -- Phase 34C: confirmed (not waitlisted) — ensure a payment obligation.
    -- v_existing_found means this is a reactivation of a previously-
    -- cancelled row (an existing confirmed/waitlisted/offered row would
    -- have raised already_joined above), so it gets an explicit new cycle;
    -- a brand-new row gets a normal (first-cycle) obligation.
    perform public._create_payment_obligation(
      v_profile.club_id, 'event_participant', v_result.id, v_roster_member_id,
      v_event.price_amount_cents, auth.uid(), v_existing_found
    );

    if user_pref_enabled(auth.uid(), 'event_joined') then
      insert into notifications (club_id, user_id, kind, body, metadata)
      values (
        v_profile.club_id,
        auth.uid(),
        'event_joined',
        'You''ve joined "' || v_event.title || '".',
        jsonb_build_object('event_id', p_event_id)
      );
    end if;
  end if;

  return v_result;
end;
$function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 8. admin_add_roster_participant
-- ═══════════════════════════════════════════════════════════════════════════
-- Delta: identical pattern to join_event. v_existing_found (already
-- computed by Production) again means "reactivating from cancelled" here,
-- since the already_joined guard above it excludes confirmed/waitlisted/
-- offered. Only when the resulting status is 'confirmed' is an obligation
-- ensured — waitlisted never charges.
CREATE OR REPLACE FUNCTION public.admin_add_roster_participant(p_event_id uuid, p_expected_club_id uuid, p_roster_member_id uuid)
 RETURNS event_participants
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_club_id    uuid;
  v_role       text;
  v_event      public.events%rowtype;
  v_roster     public.roster_members%rowtype;
  v_member_id  uuid;
  v_existing   public.event_participants%rowtype;
  v_existing_found boolean;
  v_occupied   int;
  v_new_status text;
  v_result     public.event_participants%rowtype;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
  if v_role is null or v_role not in ('admin', 'pro', 'staff') then raise exception 'admin_required'; end if;

  select * into v_event
    from public.events
   where id      = p_event_id
     and club_id = v_club_id
   for update;
  if not found then raise exception 'event_not_found'; end if;
  if v_event.status <> 'scheduled' then raise exception 'event_cancelled'; end if;
  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

  select * into v_roster
    from public.roster_members
   where id      = p_roster_member_id
     and club_id = v_club_id;
  if not found then raise exception 'roster_member_not_found'; end if;

  v_member_id := v_roster.claimed_by;

  select * into v_existing
    from public.event_participants
   where event_id = p_event_id
     and (
       roster_member_id = p_roster_member_id
       or (v_member_id is not null and profile_id = v_member_id)
     )
   for update;
  v_existing_found := found;

  if v_existing_found and v_existing.status in ('confirmed', 'waitlisted', 'offered') then
    raise exception 'already_joined';
  end if;

  v_occupied := public._event_effective_occupancy(
    p_event_id,
    case when v_existing_found then v_existing.id else null end
  );

  v_new_status := case when v_occupied >= v_event.capacity then 'waitlisted' else 'confirmed' end;

  if v_existing_found then
    update public.event_participants
       set status           = v_new_status,
           profile_id       = v_member_id,
           roster_member_id = p_roster_member_id,
           offer_expires_at = null,
           price_amount_cents = v_event.price_amount_cents,
           updated_at       = now()
     where id = v_existing.id
    returning * into v_result;
  else
    insert into public.event_participants (event_id, profile_id, roster_member_id, role, status, price_amount_cents)
    values (p_event_id, v_member_id, p_roster_member_id, 'participant', v_new_status, v_event.price_amount_cents)
    returning * into v_result;
  end if;

  if v_result.id is null then
    raise exception 'event_participant_write_failed';
  end if;

  -- Phase 34C: only a confirmed resulting status gets an obligation.
  -- v_existing_found signals a cancelled-row reactivation here (identical
  -- reasoning to join_event above) -> explicit new cycle; otherwise a
  -- normal first-cycle obligation.
  if v_new_status = 'confirmed' then
    perform public._create_payment_obligation(
      v_club_id, 'event_participant', v_result.id, p_roster_member_id,
      v_event.price_amount_cents, auth.uid(), v_existing_found
    );
  end if;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'admin_add_roster_participant', 'event', p_event_id,
    jsonb_build_object(
      'roster_member_id', p_roster_member_id,
      'member_id',        v_member_id,
      'member_claimed',   v_member_id is not null,
      'final_status',     v_new_status
    )
  );

  return v_result;
end;
$function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 9. admin_add_guest
-- ═══════════════════════════════════════════════════════════════════════════
-- Delta: after the guest insert, ensure a normal obligation. Guests are
-- always a fresh insert (no reactivation concept exists for event_guests),
-- and roster_member_id is NULL by design — an unresolved payer, never
-- invented.
CREATE OR REPLACE FUNCTION public.admin_add_guest(p_event_id uuid, p_display_name text)
 RETURNS event_guests
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor        profiles%rowtype;
  v_event        events%rowtype;
  v_name         text;
  v_occupied     int;
  v_was_over_cap boolean;
  v_result       event_guests%rowtype;
begin
  select * into v_actor from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_actor.role not in ('admin', 'pro', 'staff') then
    raise exception 'admin_required';
  end if;

  select * into v_event
    from events
    where id      = p_event_id
      and club_id = v_actor.club_id;
  if not found then raise exception 'event_not_found'; end if;
  if v_event.status <> 'scheduled' then raise exception 'event_cancelled'; end if;
  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

  v_name := trim(p_display_name);
  if char_length(v_name) < 1 then raise exception 'invalid_guest_name'; end if;

  select
    (select count(*)
       from event_participants
       where event_id = p_event_id
         and status   in ('confirmed', 'offered')
         and role     = 'participant')
    +
    (select count(*)
       from event_guests
       where event_id = p_event_id
         and status   = 'active')
    into v_occupied;

  v_was_over_cap := v_occupied >= v_event.capacity;

  -- Phase 34B: guest price snapshot preserves what the guest seat cost
  -- when added. This does not create guest payment mechanics — who
  -- ultimately pays for the guest remains deferred to 34C+.
  insert into event_guests (event_id, display_name, added_by, price_amount_cents)
  values (p_event_id, v_name, auth.uid(), v_event.price_amount_cents)
  returning * into v_result;

  -- Phase 34C: ensure a normal payment obligation for this active Guest.
  -- roster_member_id is NULL by design — a guest is not a roster Member.
  perform public._create_payment_obligation(
    v_actor.club_id, 'event_guest', v_result.id, null,
    v_event.price_amount_cents, auth.uid()
  );

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_actor.club_id,
    auth.uid(),
    'admin_add_guest',
    'event',
    p_event_id,
    jsonb_build_object(
      'event_title',       v_event.title,
      'guest_id',          v_result.id,
      'guest_name',        v_name,
      'was_over_capacity', v_was_over_cap
    )
  );

  return v_result;
end;
$function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 10. accept_waitlist_offer
-- ═══════════════════════════════════════════════════════════════════════════
-- Delta: offered -> confirmed never touches price_amount_cents (preserving
-- the existing snapshot as required — "no repricing"). The row itself is
-- never cancelled by this transition, but the SAME row can be a
-- reactivation of an earlier cancelled-then-rejoined-to-waitlist episode
-- (join_event creates no obligation for a waitlisted result, so a prior
-- cycle from before that cancellation can already exist even though this
-- particular waitlist episode was never billed). Existence of ANY prior
-- payment for this exact domain_id — not the row's current/previous
-- status — is the financial-history signal: none -> normal first-cycle
-- ensure; some -> explicit new cycle.
CREATE OR REPLACE FUNCTION public.accept_waitlist_offer(p_event_id uuid)
 RETURNS event_participants
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_profile  profiles%rowtype;
  v_event    events%rowtype;
  v_my_row   event_participants%rowtype;
  v_result   event_participants%rowtype;
  v_roster_member_id uuid;
  v_has_prior_payment boolean;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  select * into v_event
    from events
    where id      = p_event_id
      and club_id = v_profile.club_id
      and status  = 'scheduled'
    for update;
  if not found then raise exception 'event_not_found'; end if;

  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

  select id into v_roster_member_id
    from roster_members
   where club_id    = v_profile.club_id
     and claimed_by = auth.uid();

  select * into v_my_row
    from event_participants
    where event_id = p_event_id
      and status    = 'offered'
      and (
        profile_id = auth.uid()
        or (v_roster_member_id is not null and roster_member_id = v_roster_member_id)
      );

  if not found then
    raise exception 'offer_not_found';
  end if;

  if v_my_row.offer_expires_at <= now() then
    raise exception 'offer_expired';
  end if;

  update event_participants
    set status           = 'confirmed',
        offer_expires_at = null,
        updated_at       = now()
    where id = v_my_row.id
  returning * into v_result;

  -- Phase 34C (lifecycle correction): determine reactivation from prior
  -- payment existence, not from status — see header note above.
  select exists (
    select 1 from public.payments
     where club_id = v_profile.club_id
       and domain_type = 'event_participant'
       and domain_id = v_result.id
  ) into v_has_prior_payment;

  -- Ensure a payment obligation using the row's own already-snapshotted
  -- price and roster identity — no repricing here.
  perform public._create_payment_obligation(
    v_profile.club_id, 'event_participant', v_result.id, v_result.roster_member_id,
    v_result.price_amount_cents, auth.uid(), v_has_prior_payment
  );

  perform expire_stale_offers_for_event(p_event_id, v_profile.club_id, v_event.title);

  insert into notifications (club_id, user_id, kind, body, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'waitlist_promoted',
    'You''ve accepted and are confirmed for "' || v_event.title || '".',
    jsonb_build_object('event_id', p_event_id)
  );

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'accept_waitlist_offer',
    'event',
    p_event_id,
    jsonb_build_object('event_title', v_event.title)
  );

  return v_result;
end;
$function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 11. admin_force_confirm
-- ═══════════════════════════════════════════════════════════════════════════
-- Delta (narrow, per the locked correction): the participant lookup is
-- changed from a bare SELECT to `SELECT * ... FOR UPDATE` (Production's
-- version did not lock this row before its later UPDATE — a genuine
-- concurrency gap for a function that can promote from multiple prior
-- statuses). The events row lookup gains FOR UPDATE for the same reason.
-- A new v_participant variable holds the locked row so v_old_status can
-- still be derived exactly as before. The UPDATE re-snapshots
-- price_amount_cents from the CURRENT Event price only when promoting
-- from 'cancelled' (a genuine reactivation); waitlisted/offered promotion
-- leaves price_amount_cents untouched, preserving the existing snapshot,
-- via a single CASE expression rather than two duplicated UPDATE
-- statements. Capacity-bypass semantics (skip_capacity_guard) are
-- untouched. Explicit-new-cycle is required not only when promoting from
-- 'cancelled' but also when promoting from waitlisted/offered onto a row
-- that itself carries a prior payment cycle from before an earlier
-- cancellation (join_event/admin_add_roster_participant never bill a
-- waitlisted result, so that prior cycle can already exist even though
-- this waitlist episode itself was never billed) — see the lifecycle
-- correction note below.
CREATE OR REPLACE FUNCTION public.admin_force_confirm(p_event_id uuid, p_profile_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor            public.profiles%rowtype;
  v_event            public.events%rowtype;
  v_participant       public.event_participants%rowtype;
  v_old_status       text;
  v_occupied         int;
  v_was_over_cap     boolean;
  v_result           public.event_participants%rowtype;
  v_notification_id  uuid;
  v_has_prior_payment boolean;
begin
  select * into v_actor from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_actor.role not in ('admin', 'pro', 'staff') then
    raise exception 'admin_required';
  end if;

  select * into v_event
    from public.events
    where id      = p_event_id
      and club_id = v_actor.club_id
    for update;
  if not found then raise exception 'event_not_found'; end if;
  if v_event.status <> 'scheduled' then raise exception 'event_cancelled'; end if;
  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

  if not exists (
    select 1 from public.profiles
    where id      = p_profile_id
      and club_id = v_actor.club_id
      and status  = 'active'
  ) then
    if not exists (select 1 from public.profiles where id = p_profile_id and club_id = v_actor.club_id) then
      raise exception 'member_not_found';
    end if;
    raise exception 'member_inactive';
  end if;

  select * into v_participant
    from public.event_participants
    where event_id   = p_event_id
      and profile_id = p_profile_id
    for update;
  if not found then raise exception 'participant_not_found'; end if;
  v_old_status := v_participant.status;
  if v_old_status = 'confirmed' then raise exception 'already_joined'; end if;

  select
    (select count(*)
       from public.event_participants
       where event_id = p_event_id
         and status   in ('confirmed', 'offered')
         and role     = 'participant')
    +
    (select count(*)
       from public.event_guests
       where event_id = p_event_id
         and status   = 'active')
    into v_occupied;

  v_was_over_cap := v_occupied >= v_event.capacity;

  perform set_config('courttime.skip_capacity_guard', 'true', true);

  update public.event_participants
    set status             = 'confirmed',
        offer_expires_at   = null,
        price_amount_cents = case when v_old_status = 'cancelled' then v_event.price_amount_cents else price_amount_cents end,
        updated_at         = now()
    where event_id   = p_event_id
      and profile_id = p_profile_id
    returning * into v_result;

  perform set_config('courttime.skip_capacity_guard', 'false', true);

  -- Phase 34C (lifecycle correction): promoting from 'cancelled' is
  -- always a genuine reactivation -> explicit new cycle, re-snapshotted
  -- to the current Event price above. Promoting from waitlisted/offered
  -- preserves the existing price snapshot, but may STILL need a new
  -- cycle if this exact row already carries a prior payment cycle from
  -- before an earlier cancellation (see header note) — existence of any
  -- prior payment, not the previous status, is what decides that.
  select exists (
    select 1 from public.payments
     where club_id = v_actor.club_id
       and domain_type = 'event_participant'
       and domain_id = v_result.id
  ) into v_has_prior_payment;

  perform public._create_payment_obligation(
    v_actor.club_id, 'event_participant', v_result.id, v_result.roster_member_id,
    v_result.price_amount_cents, auth.uid(), (v_old_status = 'cancelled' or v_has_prior_payment)
  );

  insert into public.notifications (club_id, user_id, kind, body, metadata)
  values (
    v_actor.club_id,
    p_profile_id,
    'waitlist_promoted',
    'An admin confirmed your spot in "' || v_event.title || '".',
    jsonb_build_object('event_id', p_event_id, 'triggered_by', auth.uid())
  )
  returning id into v_notification_id;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_actor.club_id,
    auth.uid(),
    'admin_force_confirm',
    'event',
    p_event_id,
    jsonb_build_object(
      'event_title',       v_event.title,
      'profile_id',        p_profile_id,
      'previous_status',   v_old_status,
      'was_over_capacity', v_was_over_cap
    )
  );

  return jsonb_build_object(
    'participant',      to_jsonb(v_result),
    'notification_id',  v_notification_id
  );
end;
$function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 12. admin_force_confirm_roster_participant
-- ═══════════════════════════════════════════════════════════════════════════
-- Delta: identical narrow correction to admin_force_confirm above — the
-- participant lookup gains FOR UPDATE (Production selected only id/status,
-- unlocked) via a new v_participant row variable, and the events lookup
-- gains FOR UPDATE. Same CASE-based price re-snapshot-only-on-cancelled-
-- reactivation, same prior-payment-existence lifecycle correction for the
-- explicit-new-cycle decision.
CREATE OR REPLACE FUNCTION public.admin_force_confirm_roster_participant(p_event_id uuid, p_expected_club_id uuid, p_roster_member_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_club_id          uuid;
  v_role             text;
  v_event            public.events%rowtype;
  v_roster           public.roster_members%rowtype;
  v_current_member_id uuid;
  v_participant      public.event_participants%rowtype;
  v_participant_id   uuid;
  v_old_status       text;
  v_occupied         int;
  v_was_over_cap     boolean;
  v_result           public.event_participants%rowtype;
  v_notification_id  uuid;
  v_has_prior_payment boolean;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
  if v_role is null or v_role not in ('admin', 'pro', 'staff') then raise exception 'admin_required'; end if;

  select * into v_event
    from public.events
   where id      = p_event_id
     and club_id = v_club_id
   for update;
  if not found then raise exception 'event_not_found'; end if;
  if v_event.status <> 'scheduled' then raise exception 'event_cancelled'; end if;
  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

  select * into v_roster
    from public.roster_members
   where id      = p_roster_member_id
     and club_id = v_club_id;
  if not found then raise exception 'roster_member_not_found'; end if;
  v_current_member_id := v_roster.claimed_by;

  select * into v_participant
    from public.event_participants
   where event_id         = p_event_id
     and roster_member_id = p_roster_member_id
   for update;
  if not found then raise exception 'participant_not_found'; end if;
  v_participant_id := v_participant.id;
  v_old_status      := v_participant.status;
  if v_old_status = 'confirmed' then raise exception 'already_joined'; end if;

  select
    (select count(*)
       from public.event_participants
       where event_id = p_event_id
         and status   in ('confirmed', 'offered')
         and role     = 'participant')
    +
    (select count(*)
       from public.event_guests
       where event_id = p_event_id
         and status   = 'active')
    into v_occupied;
  v_was_over_cap := v_occupied >= v_event.capacity;

  perform set_config('courttime.skip_capacity_guard', 'true', true);

  update public.event_participants
     set status             = 'confirmed',
         offer_expires_at   = null,
         price_amount_cents = case when v_old_status = 'cancelled' then v_event.price_amount_cents else price_amount_cents end,
         updated_at         = now()
   where id = v_participant_id
  returning * into v_result;

  perform set_config('courttime.skip_capacity_guard', 'false', true);

  -- Phase 34C (lifecycle correction): same rule as admin_force_confirm above.
  select exists (
    select 1 from public.payments
     where club_id = v_club_id
       and domain_type = 'event_participant'
       and domain_id = v_result.id
  ) into v_has_prior_payment;

  perform public._create_payment_obligation(
    v_club_id, 'event_participant', v_result.id, v_result.roster_member_id,
    v_result.price_amount_cents, auth.uid(), (v_old_status = 'cancelled' or v_has_prior_payment)
  );

  if v_current_member_id is not null then
    insert into public.notifications (club_id, user_id, kind, body, metadata)
    values (
      v_club_id, v_current_member_id, 'waitlist_promoted',
      'An admin confirmed your spot in "' || v_event.title || '".',
      jsonb_build_object('event_id', p_event_id, 'triggered_by', auth.uid())
    )
    returning id into v_notification_id;
  end if;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'admin_force_confirm', 'event', p_event_id,
    jsonb_build_object(
      'event_title',       v_event.title,
      'roster_member_id',  p_roster_member_id,
      'previous_status',   v_old_status,
      'was_over_capacity', v_was_over_cap
    )
  );

  return jsonb_build_object('participant', to_jsonb(v_result), 'notification_id', v_notification_id);
end;
$function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 13. join_program
-- ═══════════════════════════════════════════════════════════════════════════
-- Delta: waitlisted result gets no obligation. By the time the
-- update/insert branch below is reached, v_existing_found being true can
-- only mean the existing row's status was 'cancelled' (the enrolled fast
-- path already returned early above; the waitlisted/offered case already
-- raised already_enrolled) — so it is exactly the reactivation signal.
-- price_amount_cents = v_program.price_amount_cents is already
-- unconditionally set in both the update and insert branches (existing
-- Production 34B behavior, untouched), which already satisfies
-- "re-snapshots current Program price" for the reactivation case.
CREATE OR REPLACE FUNCTION public.join_program(p_program_id uuid)
 RETURNS program_enrollments
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_club_id  uuid;
  v_role     text;
  v_roster_member_id uuid;
  v_program  public.programs%rowtype;
  v_existing public.program_enrollments%rowtype;
  v_existing_found boolean;
  v_count    int;
  v_new_status text;
  v_result   public.program_enrollments%rowtype;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;
  if v_club_id is null then raise exception 'not_authenticated'; end if;

  -- Phase 34A3: restated as an explicit admin/pro allowlist rather than a
  -- member-exclusion — see this section's header above.
  if v_role not in ('admin', 'pro') and not public.current_club_has_capability('member_self_service') then
    raise exception 'capability_not_available';
  end if;

  v_roster_member_id := public.current_user_roster_member_id();
  if v_roster_member_id is null then raise exception 'phase33d2_unresolved_member_identity'; end if;

  select * into v_program from public.programs
    where id = p_program_id and club_id = v_club_id for update;
  if not found then raise exception 'program_not_found'; end if;
  if v_program.enrollment_model <> 'program' then raise exception 'program_not_whole_enrollment'; end if;
  if not public._program_is_enrollable(v_program) then raise exception 'program_not_enrollable'; end if;

  select * into v_existing from public.program_enrollments
    where program_id = p_program_id and (profile_id = auth.uid() or roster_member_id = v_roster_member_id);
  if found and v_existing.status = 'enrolled' then return v_existing; end if;

  perform public._expire_stale_program_offers(p_program_id, v_club_id, v_program.title);
  perform public._advance_program_waitlist_offer(p_program_id, v_club_id, v_program.title);

  select * into v_existing from public.program_enrollments
    where program_id = p_program_id and (profile_id = auth.uid() or roster_member_id = v_roster_member_id)
    for update;
  v_existing_found := found;

  if v_existing_found and v_existing.status in ('waitlisted', 'offered') then
    raise exception 'already_enrolled';
  end if;

  select count(*) into v_count from public.program_enrollments
    where program_id = p_program_id and status in ('enrolled', 'offered');

  if v_count >= v_program.default_capacity or exists (
    select 1 from public.program_enrollments where program_id = p_program_id and status = 'waitlisted'
  ) then
    v_new_status := 'waitlisted';
  elsif not public._program_candidate_fits_future_sessions(p_program_id, v_roster_member_id) then
    v_new_status := 'waitlisted';
  else
    v_new_status := 'enrolled';
  end if;

  if v_existing_found then
    update public.program_enrollments
       set status = v_new_status, profile_id = auth.uid(), roster_member_id = v_roster_member_id,
           offer_expires_at = null,
           waitlisted_at = case when v_new_status = 'waitlisted' then now() else null end,
           -- Phase 34B: reactivating a previously-cancelled enrollment is a
           -- fresh commitment — re-snapshot the program's current price.
           price_amount_cents = v_program.price_amount_cents,
           updated_at = now()
     where id = v_existing.id
    returning * into v_result;
  else
    insert into public.program_enrollments (program_id, profile_id, roster_member_id, status, waitlisted_at, price_amount_cents)
    values (p_program_id, auth.uid(), v_roster_member_id, v_new_status,
      case when v_new_status = 'waitlisted' then now() else null end,
      v_program.price_amount_cents)
    returning * into v_result;
  end if;

  if v_result.id is null then raise exception 'program_enrollment_write_failed'; end if;

  if v_new_status = 'enrolled' then
    -- Phase 34C: ensure a payment obligation. v_existing_found signals a
    -- cancelled-row reactivation here -> explicit new cycle; otherwise a
    -- normal first-cycle obligation.
    perform public._create_payment_obligation(
      v_club_id, 'program_enrollment', v_result.id, v_roster_member_id,
      v_result.price_amount_cents, auth.uid(), v_existing_found
    );
    perform public._materialize_program_member_into_future_events(p_program_id, v_roster_member_id, v_club_id);
  end if;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (v_club_id, auth.uid(), 'join_program', 'program', p_program_id,
    jsonb_build_object('status', v_result.status, 'actor_role', v_role));

  return v_result;
end;
$function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 14. add_program_member
-- ═══════════════════════════════════════════════════════════════════════════
-- Delta: the two idempotent short-circuit branches (already enrolled;
-- already waitlisted/offered, v_no_op := true both times) get no payment
-- call — nothing changed. The else branch mirrors join_program: by the
-- time it runs, v_existing_found=true can only mean 'cancelled' (the two
-- earlier branches already handled enrolled/waitlisted/offered), so it is
-- the reactivation signal; price_amount_cents is already unconditionally
-- re-snapshotted from v_program.price_amount_cents in both its update and
-- insert paths (untouched Production 34B behavior).
CREATE OR REPLACE FUNCTION public.add_program_member(p_program_id uuid, p_profile_id uuid)
 RETURNS program_enrollments
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_club_id       uuid;
  v_role          text;
  v_program       public.programs%rowtype;
  v_target_status text;
  v_roster_member_id uuid;
  v_existing      public.program_enrollments%rowtype;
  v_existing_found boolean;
  v_count         int;
  v_new_status    text;
  v_result        public.program_enrollments%rowtype;
  v_no_op         boolean := false;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;
  if v_club_id is null then raise exception 'not_authenticated'; end if;

  if v_role not in ('admin', 'pro', 'staff') then
    raise exception 'insufficient_role';
  end if;

  select * into v_program
    from public.programs
    where id = p_program_id and club_id = v_club_id
    for update;
  if not found then raise exception 'program_not_found'; end if;

  if v_role = 'pro' and v_program.created_by <> auth.uid() then
    raise exception 'insufficient_role';
  end if;

  if v_program.enrollment_model <> 'program' then
    raise exception 'program_not_whole_enrollment';
  end if;

  if not public._program_is_enrollable(v_program) then
    raise exception 'program_not_enrollable';
  end if;

  -- Target membership: club_memberships is the sole source of truth here
  -- (unchanged from the pre-0115 body).
  select status into v_target_status
    from public.club_memberships
    where user_id    = p_profile_id
      and club_id    = v_club_id
      and removed_at is null;
  if not found then raise exception 'target_member_not_found'; end if;
  if v_target_status <> 'active' then raise exception 'target_member_inactive'; end if;

  -- Phase 33D2b: resolve the target's durable roster identity, fail
  -- closed — every account holder resolves one by construction (33B1
  -- backfill guarantee), matching admin_add_member's identical guard.
  select id into v_roster_member_id
    from public.roster_members
   where club_id    = v_club_id
     and claimed_by = p_profile_id;
  if not found then
    raise exception 'phase33d2_unresolved_member_identity';
  end if;

  -- Read the target's existing row FIRST, before any other side effect —
  -- required ordering, unchanged from the pre-0115 body. Phase 33D2b
  -- hotfix-in-advance: FOR UPDATE + immediate FOUND capture. Matched via
  -- profile_id OR roster_member_id, so a prior no-account enrollment for
  -- this same target (now claimed) is correctly recognized as the same
  -- durable enrollment.
  select * into v_existing
    from public.program_enrollments
    where program_id = p_program_id
      and (profile_id = p_profile_id or roster_member_id = v_roster_member_id)
    for update;
  v_existing_found := found;

  if v_existing_found and v_existing.status = 'enrolled' then
    -- Idempotent fast path — no expire/advance run, matching join_program's
    -- own identical fast path exactly.
    v_result := v_existing;
    v_no_op  := true;
  elsif v_existing_found and v_existing.status in ('waitlisted', 'offered') then
    -- Returned exactly unchanged — no expire/advance call is made in this
    -- branch (unchanged from the pre-0115 body's own documented rule).
    v_result := v_existing;
    v_no_op  := true;
  else
    perform public._expire_stale_program_offers(p_program_id, v_club_id, v_program.title);
    perform public._advance_program_waitlist_offer(p_program_id, v_club_id, v_program.title);

    select count(*) into v_count
      from public.program_enrollments
      where program_id = p_program_id
        and status     in ('enrolled', 'offered');

    if v_count >= v_program.default_capacity or exists (
      select 1 from public.program_enrollments
      where program_id = p_program_id and status = 'waitlisted'
    ) then
      v_new_status := 'waitlisted';
    else
      v_new_status := 'enrolled';
    end if;

    if v_existing_found then
      update public.program_enrollments
         set status           = v_new_status,
             profile_id       = p_profile_id,
             roster_member_id = v_roster_member_id,
             offer_expires_at = null,
             waitlisted_at    = case when v_new_status = 'waitlisted' then now() else null end,
             -- Phase 34B: reactivating a previously-cancelled enrollment is
             -- a fresh commitment — re-snapshot the program's current price.
             price_amount_cents = v_program.price_amount_cents,
             updated_at       = now()
       where id = v_existing.id
      returning * into v_result;
    else
      insert into public.program_enrollments (program_id, profile_id, roster_member_id, status, waitlisted_at, price_amount_cents)
      values (
        p_program_id, p_profile_id, v_roster_member_id, v_new_status,
        case when v_new_status = 'waitlisted' then now() else null end,
        v_program.price_amount_cents
      )
      returning * into v_result;
    end if;

    if v_result.id is null then
      raise exception 'program_enrollment_write_failed';
    end if;
  end if;

  if v_result.status = 'enrolled' then
    -- Phase 34C: ensure a payment obligation, skipped entirely for the two
    -- no-op fast paths above (v_no_op = true, nothing changed). Reached
    -- only via the else branch, where v_existing_found (if true) can only
    -- mean 'cancelled' -> explicit new cycle; otherwise normal.
    if not v_no_op then
      perform public._create_payment_obligation(
        v_club_id, 'program_enrollment', v_result.id, v_roster_member_id,
        v_result.price_amount_cents, auth.uid(), v_existing_found
      );
    end if;
    perform public._materialize_program_member_into_future_events(p_program_id, v_roster_member_id, v_club_id);
  end if;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'add_program_member', 'program', p_program_id,
    jsonb_build_object(
      'target_profile_id', p_profile_id,
      'roster_member_id',  v_roster_member_id,
      'final_status',      v_result.status,
      'no_op',             v_no_op,
      'actor_role',        v_role
    )
  );

  return v_result;
end;
$function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 15. add_program_roster_member
-- ═══════════════════════════════════════════════════════════════════════════
-- Delta: identical pattern to add_program_member — no-op fast paths (both
-- v_no_op := true) skip the payment call; the else branch's
-- v_existing_found (if true) can only mean 'cancelled' by the time it is
-- reached -> explicit new cycle; price_amount_cents is already
-- unconditionally re-snapshotted in both its update and insert paths.
CREATE OR REPLACE FUNCTION public.add_program_roster_member(p_program_id uuid, p_expected_club_id uuid, p_roster_member_id uuid)
 RETURNS program_enrollments
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_club_id    uuid;
  v_role       text;
  v_program    public.programs%rowtype;
  v_roster     public.roster_members%rowtype;
  v_existing   public.program_enrollments%rowtype;
  v_existing_found boolean;
  v_count      int;
  v_new_status text;
  v_result     public.program_enrollments%rowtype;
  v_no_op      boolean := false;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;
  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
  if v_role not in ('admin', 'pro', 'staff') then raise exception 'insufficient_role'; end if;

  select * into v_program
    from public.programs
    where id = p_program_id and club_id = v_club_id
    for update;
  if not found then raise exception 'program_not_found'; end if;

  if v_role = 'pro' and v_program.created_by <> auth.uid() then
    raise exception 'insufficient_role';
  end if;

  if v_program.enrollment_model <> 'program' then
    raise exception 'program_not_whole_enrollment';
  end if;

  if not public._program_is_enrollable(v_program) then
    raise exception 'program_not_enrollable';
  end if;

  select * into v_roster
    from public.roster_members
   where id      = p_roster_member_id
     and club_id = v_club_id;
  if not found then raise exception 'roster_member_not_found'; end if;

  select * into v_existing
    from public.program_enrollments
    where program_id = p_program_id
      and (
        roster_member_id = p_roster_member_id
        or (v_roster.claimed_by is not null and profile_id = v_roster.claimed_by)
      )
    for update;
  v_existing_found := found;

  if v_existing_found and v_existing.status = 'enrolled' then
    v_result := v_existing;
    v_no_op  := true;
  elsif v_existing_found and v_existing.status in ('waitlisted', 'offered') then
    v_result := v_existing;
    v_no_op  := true;
  else
    perform public._expire_stale_program_offers(p_program_id, v_club_id, v_program.title);
    perform public._advance_program_waitlist_offer(p_program_id, v_club_id, v_program.title);

    select count(*) into v_count
      from public.program_enrollments
      where program_id = p_program_id
        and status     in ('enrolled', 'offered');

    if v_count >= v_program.default_capacity or exists (
      select 1 from public.program_enrollments
      where program_id = p_program_id and status = 'waitlisted'
    ) then
      v_new_status := 'waitlisted';
    elsif not public._program_candidate_fits_future_sessions(p_program_id, p_roster_member_id) then
      v_new_status := 'waitlisted';
    else
      v_new_status := 'enrolled';
    end if;

    if v_existing_found then
      update public.program_enrollments
         set status           = v_new_status,
             profile_id       = v_roster.claimed_by,
             roster_member_id = p_roster_member_id,
             offer_expires_at = null,
             waitlisted_at    = case when v_new_status = 'waitlisted' then now() else null end,
             -- Phase 34B: reactivating a previously-cancelled enrollment is
             -- a fresh commitment — re-snapshot the program's current price.
             price_amount_cents = v_program.price_amount_cents,
             updated_at       = now()
       where id = v_existing.id
      returning * into v_result;
    else
      insert into public.program_enrollments (program_id, profile_id, roster_member_id, status, waitlisted_at, price_amount_cents)
      values (
        p_program_id, v_roster.claimed_by, p_roster_member_id, v_new_status,
        case when v_new_status = 'waitlisted' then now() else null end,
        v_program.price_amount_cents
      )
      returning * into v_result;
    end if;

    if v_result.id is null then
      raise exception 'program_enrollment_write_failed';
    end if;
  end if;

  if v_result.status = 'enrolled' then
    -- Phase 34C: same rule as add_program_member above.
    if not v_no_op then
      perform public._create_payment_obligation(
        v_club_id, 'program_enrollment', v_result.id, p_roster_member_id,
        v_result.price_amount_cents, auth.uid(), v_existing_found
      );
    end if;
    perform public._materialize_program_member_into_future_events(p_program_id, p_roster_member_id, v_club_id);
  end if;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'add_program_roster_member', 'program', p_program_id,
    jsonb_build_object(
      'roster_member_id', p_roster_member_id,
      'member_id',        v_roster.claimed_by,
      'member_claimed',   v_roster.claimed_by is not null,
      'final_status',     v_result.status,
      'no_op',             v_no_op,
      'actor_role',        v_role
    )
  );

  return v_result;
end;
$function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 16. accept_program_waitlist_offer
-- ═══════════════════════════════════════════════════════════════════════════
-- Delta: offered -> enrolled never touches price_amount_cents, preserving
-- the existing snapshot. The row is never cancelled by this transition,
-- but the SAME row can be a reactivation of an earlier
-- cancelled-then-rejoined-to-waitlist episode (join_program creates no
-- obligation for a waitlisted result). Existence of any prior payment for
-- this exact domain_id is the financial-history signal — not status.
CREATE OR REPLACE FUNCTION public.accept_program_waitlist_offer(p_program_id uuid)
 RETURNS program_enrollments
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_club_id uuid;
  v_role    text;
  v_roster_member_id uuid;
  v_program public.programs%rowtype;
  v_my_row  public.program_enrollments%rowtype;
  v_result  public.program_enrollments%rowtype;
  v_has_prior_payment boolean;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;
  if v_club_id is null then raise exception 'not_authenticated'; end if;

  v_roster_member_id := public.current_user_roster_member_id();
  if v_roster_member_id is null then
    raise exception 'phase33d2_unresolved_member_identity';
  end if;

  select * into v_program
    from public.programs
    where id = p_program_id and club_id = v_club_id
    for update;
  if not found then raise exception 'program_not_found'; end if;

  if v_program.enrollment_model <> 'program' then
    raise exception 'program_not_whole_enrollment';
  end if;

  if not public._program_is_enrollable(v_program) then
    raise exception 'program_not_enrollable';
  end if;

  -- Phase 33D2b: matched via profile_id OR the caller's own current
  -- roster identity.
  select * into v_my_row
    from public.program_enrollments
    where program_id = p_program_id
      and (profile_id = auth.uid() or roster_member_id = v_roster_member_id)
      and status     = 'offered';
  if not found then raise exception 'offer_not_found'; end if;

  if v_my_row.offer_expires_at <= now() then raise exception 'offer_expired'; end if;

  update public.program_enrollments
    set status           = 'enrolled',
        offer_expires_at = null,
        updated_at       = now()
    where id = v_my_row.id
  returning * into v_result;

  -- Phase 34C (lifecycle correction): see header note above.
  select exists (
    select 1 from public.payments
     where club_id = v_club_id
       and domain_type = 'program_enrollment'
       and domain_id = v_result.id
  ) into v_has_prior_payment;

  -- Ensure a payment obligation using the row's own already-snapshotted
  -- price and roster identity — no repricing here.
  perform public._create_payment_obligation(
    v_club_id, 'program_enrollment', v_result.id, v_roster_member_id,
    v_result.price_amount_cents, auth.uid(), v_has_prior_payment
  );

  perform public._materialize_program_member_into_future_events(p_program_id, v_roster_member_id, v_club_id);

  -- Defensive cleanup, mirroring the pre-0115 body: the capacity check
  -- inside _advance_program_waitlist_offer prevents a spurious promotion
  -- here since enrolled+offered count is unchanged by an accept.
  perform public._expire_stale_program_offers(p_program_id, v_club_id, v_program.title);

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'accept_program_waitlist_offer', 'program', p_program_id,
    jsonb_build_object('program_title', v_program.title, 'actor_role', v_role)
  );

  return v_result;
end;
$function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 17. force_confirm_program_roster_member
-- ═══════════════════════════════════════════════════════════════════════════
-- Delta: this function's own lookup is structurally scoped to
-- status IN ('waitlisted','offered') only — it can never reach a
-- 'cancelled' row (that lookup would simply not find one, raising
-- enrollment_not_found), so there is no cancelled-reactivation branch to
-- add here at all, matching the locked instruction not to invent one.
-- price_amount_cents is never touched by this function's UPDATE, so the
-- existing snapshot is already preserved. The same row can still carry a
-- prior payment cycle from before an earlier cancellation-then-rejoin-to-
-- waitlist episode though (join_program/add_program_member/
-- add_program_roster_member create no obligation for a waitlisted
-- result), so — per the same lifecycle correction as the other
-- confirmation paths — existence of any prior payment for this exact
-- domain_id, not status, decides normal vs. explicit new cycle.
CREATE OR REPLACE FUNCTION public.force_confirm_program_roster_member(p_program_id uuid, p_expected_club_id uuid, p_roster_member_id uuid)
 RETURNS program_enrollments
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_club_id      uuid;
  v_role         text;
  v_program      public.programs%rowtype;
  v_old          public.program_enrollments%rowtype;
  v_result       public.program_enrollments%rowtype;
  v_occupied     int;
  v_was_over_cap boolean;
  v_has_prior_payment boolean;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;
  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
  if v_role not in ('admin', 'pro', 'staff') then raise exception 'insufficient_role'; end if;

  select * into v_program from public.programs where id = p_program_id and club_id = v_club_id for update;
  if not found then raise exception 'program_not_found'; end if;
  if v_role = 'pro' and v_program.created_by <> auth.uid() then raise exception 'insufficient_role'; end if;
  if v_program.enrollment_model <> 'program' then raise exception 'program_not_whole_enrollment'; end if;

  select * into v_old from public.program_enrollments
    where program_id = p_program_id and roster_member_id = p_roster_member_id
      and status in ('waitlisted', 'offered');
  if not found then raise exception 'enrollment_not_found'; end if;

  select count(*) into v_occupied from public.program_enrollments
    where program_id = p_program_id and status in ('enrolled', 'offered');
  v_was_over_cap := v_occupied >= v_program.default_capacity;

  perform set_config('courttime.skip_capacity_guard', 'true', true);

  update public.program_enrollments
     set status = 'enrolled', offer_expires_at = null, waitlisted_at = null, updated_at = now()
   where id = v_old.id
  returning * into v_result;
  if v_result.id is null then raise exception 'program_enrollment_write_failed'; end if;

  -- Phase 34C (lifecycle correction): see header note above.
  select exists (
    select 1 from public.payments
     where club_id = v_club_id
       and domain_type = 'program_enrollment'
       and domain_id = v_result.id
  ) into v_has_prior_payment;

  -- Ensure a payment obligation using the row's own already-snapshotted
  -- price and roster identity.
  perform public._create_payment_obligation(
    v_club_id, 'program_enrollment', v_result.id, p_roster_member_id,
    v_result.price_amount_cents, auth.uid(), v_has_prior_payment
  );

  perform public._materialize_program_member_into_future_events(p_program_id, p_roster_member_id, v_club_id);

  perform set_config('courttime.skip_capacity_guard', 'false', true);

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (v_club_id, auth.uid(), 'force_confirm_program_roster_member', 'program', p_program_id,
    jsonb_build_object('roster_member_id', p_roster_member_id, 'previous_status', v_old.status,
      'was_over_capacity', v_was_over_cap));

  return v_result;
end;
$function$;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback (manual, cloud SQL Editor)
-- ═══════════════════════════════════════════════════════════════════════════
-- Not a schema migration — restores each of the 17 functions to the exact
-- Production body captured in this file's own header comment, by
-- redefining each from the same authoritative export used to write this
-- migration (re-run the CREATE OR REPLACE statements above with every
-- Phase 34C delta block removed). There is nothing to DROP: no signature
-- or return type changed for any of the 17.
