-- 0189_member_non_member_court_pricing.sql
-- Phase 42B — Member vs Non-Member Court Reservation Pricing.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 42A (0188, applied/immutable) gave Court Time a canonical,
-- role-agnostic active-Member predicate — public.is_active_club_member
-- (roster_member_id, club_id) — but wired it into nothing. This migration
-- is the first consumer: court reservation pricing, and ONLY court
-- reservation pricing. Lessons/events/programs/guest fees are explicitly
-- out of scope and untouched.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- TARGETED AUDIT (performed before writing this file — narrow, not repo-wide)
-- ═══════════════════════════════════════════════════════════════════════════
-- Confirmed via `grep` (case-insensitive, since several of these functions
-- use the uppercase `CREATE OR REPLACE FUNCTION` / `$function$` quoting
-- style from their own "verbatim Production export" migrations) the LATEST
-- live definition of every function this migration touches:
--
--   • create_reservation               — last redefined 0144 (payment
--     obligation wiring). Self-service booking: always resolves the
--     CALLER's own roster identity (v_roster_member_id), never a
--     client-supplied one. Price resolves as court override, else club
--     default, else NULL — computed once, snapshotted onto the new row.
--   • admin_create_member_reservation  — last redefined 0144. Same price
--     formula, byte-identical, for an explicit p_roster_member_id.
--   • update_member_reservation        — last redefined 0151 (stale
--     checkout invalidation). THIS IS THE ONLY RESERVATION REASSIGNMENT
--     RPC — confirmed by grep across every reservation-touching migration;
--     0109 (which introduced reassignment) extended this same function,
--     never created a parallel one. Its EXISTING (pre-42B) repricing rule:
--     rate/price are re-resolved ONLY when the COURT changes (from the
--     destination court's current rate) or, if only duration changes, the
--     EXISTING rate is preserved and just re-multiplied by the new
--     duration. Reassigning the Member ALONE (roster_member_id changes,
--     court/duration untouched) does NOT today trigger any repricing —
--     price is silently carried over from the previous occupant.
--   • update_club_pricing              — last redefined 0142 (program
--     pricing), which added a currency-lock guard (refuses a currency
--     change once ANY positive price exists anywhere in the club — a
--     dedicated `union all` scan across club_settings/courts/lesson_types/
--     event_types/events/programs/reservations/lesson_requests/
--     event_participants/event_guests/program_enrollments). Signature is
--     (p_currency text, p_default_court_hourly_rate_cents integer),
--     unchanged since 0139.
--   • set_court_hourly_rate            — only ever defined once, 0139.
--     Signature (p_court_id uuid, p_hourly_rate_cents integer), untouched
--     since.
--
-- FINDING on reassignment (Locked Rule §4 / edge case K): the task requires
-- that reassigning a reservation to a different roster member resolve
-- pricing class/rate for the NEW identity. The existing RPC topology makes
-- this SAFE, not ambiguous: _check_member_reassignment_allowed (0144)
-- already runs before any reassignment mutation and blocks it outright if
-- the current obligation cycle has unresolved money; and the existing
-- post-mutation payment-wiring block already treats ANY member
-- reassignment as creating an explicit NEW payment obligation cycle for
-- the new Member (`_create_payment_obligation(..., true)` — a forced new
-- cycle — regardless of whether the price itself changed), independent of
-- this migration. Tying a fresh price/class resolution to that same
-- already-new-cycle moment is a direct, non-ambiguous extension of an
-- invariant this codebase already enforces for reassignment — not a new,
-- independently-risky behavior. This migration therefore ADDS member
-- reassignment as a second repricing trigger in update_member_reservation,
-- alongside the existing court-change trigger — see Section 3 below for the
-- exact rule and the NULL-classified-legacy-row safety argument.
--
-- No STOP condition was found. No other reservation-mutating RPC needed
-- auditing — get_reservation_roster/get_reservation_eligible_roster_members
-- (0178/0179) and reservation_participants/reservation_guests (Phase 37)
-- are read/participant-only and never touch pricing; confirmed by grep and
-- left untouched.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- SCOPE
-- ═══════════════════════════════════════════════════════════════════════════
--   1. club_settings.default_court_hourly_rate_non_member_cents (new,
--      nullable) + courts.hourly_rate_non_member_cents (new, nullable).
--   2. reservations.membership_pricing_class (new, nullable, NO backfill —
--      every pre-42B row stays NULL forever unless a future edit
--      legitimately creates a fresh snapshot per Section 4 below).
--   3. create_reservation / admin_create_member_reservation: resolve and
--      snapshot membership_pricing_class + a class-aware rate, using
--      is_active_club_member — role-agnostic, guest-participant-agnostic.
--   4. update_member_reservation: preserve the existing court-change and
--      duration-only repricing rules exactly; ADD member-reassignment as a
--      new repricing trigger (pricing class resolved fresh for the NEW
--      roster member; rate re-resolved against the (possibly unchanged)
--      court for that new class); everything else about this reservation
--      (including its class) is untouched by an edit that changes neither
--      court nor Member.
--   5. update_club_pricing / set_court_hourly_rate: widened (DROP + CREATE,
--      not a same-signature CREATE OR REPLACE — Postgres treats an added
--      argument as a distinct function identity) to accept a non-member
--      rate alongside the existing Member/default rate, with identical
--      admin/same-club/audit/validation posture. Currency-lock guard
--      extended to also cover the two new non-member rate columns.
--
-- Explicitly NOT touched: Stripe, payment ledger architecture (payments/
-- payment_events), _create_payment_obligation/_adjust_payment_obligation/
-- _check_member_reassignment_allowed/_invalidate_or_flag_open_checkout_
-- attempt (0143/0144/0150/0151, all untouched — they already consume
-- whatever price_amount_cents/roster_member_id this migration resolves,
-- generically), lessons/events/programs pricing, guest fees, Phase 37
-- reservation_participants/reservation_guests, roster_members.status or
-- .membership_status (0188, untouched), and any UI (Phase 42C, deferred).
--
-- Not applied by this checkpoint. STOP before applying. Do not create 0190.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Non-member rate columns — same validation philosophy as the existing
--    Member/default rate columns (0139): nullable, non-negative, integer
--    cents. Opt-in: NULL everywhere means zero pricing behavior change.
-- ═══════════════════════════════════════════════════════════════════════════
alter table public.club_settings
  add column default_court_hourly_rate_non_member_cents integer null;

alter table public.club_settings
  add constraint club_settings_default_court_hourly_rate_non_member_cents_nonneg
    check (default_court_hourly_rate_non_member_cents is null or default_court_hourly_rate_non_member_cents >= 0);

alter table public.courts
  add column hourly_rate_non_member_cents integer null;

alter table public.courts
  add constraint courts_hourly_rate_non_member_cents_nonneg
    check (hourly_rate_non_member_cents is null or hourly_rate_non_member_cents >= 0);

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. reservations.membership_pricing_class — historical snapshot. NO
--    backfill: every reservation created before this migration stays NULL
--    forever — fabricating a historical classification from CURRENT
--    membership state would misrepresent what was actually true (or
--    unknowable) at booking time. Populated going forward exclusively by
--    create_reservation / admin_create_member_reservation (every new row)
--    and update_member_reservation (only when a reassignment legitimately
--    creates a fresh snapshot for the new Member — Section 4).
-- ═══════════════════════════════════════════════════════════════════════════
alter table public.reservations
  add column membership_pricing_class text
    check (membership_pricing_class in ('member', 'non_member'));

comment on column public.reservations.membership_pricing_class is
  'Phase 42B: snapshotted at booking/reassignment time from
   is_active_club_member() — NEVER re-derived dynamically for display, and
   NEVER mutated by a later membership_status/roster change. Every
   reservation created or reassigned from this migration forward always
   snapshots ''member'' or ''non_member'', regardless of whether the club
   has configured a differentiated Non-Member rate — classification is
   about the booking identity, not about whether it happens to change the
   resolved price. NULL is exclusively historical/legacy state: every
   reservation created before this migration (no fabricated history),
   preserved until an explicit qualifying operation (e.g. Member
   reassignment) legitimately creates a fresh snapshot for that row.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. create_reservation — verbatim 0144 body + class-aware price
--    resolution. Only the Phase 34B pricing block and the INSERT's column/
--    value lists change; every other line, check, and side effect is
--    byte-identical to the currently-applied 0144 text.
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
  -- the booking identity itself determines the base court rate.
  v_membership_pricing_class := case
    when public.is_active_club_member(v_roster_member_id, v_profile.club_id) then 'member'
    else 'non_member'
  end;

  -- Phase 34B/42B: resolve and snapshot court-booking price.
  -- Member: court override, else club default, else NULL (unpriced —
  -- court pricing remains optional). Non-Member: court non-member
  -- override, else club non-member default, else the SAME Member/default
  -- chain (required fallback — a club that never configures Non-Member
  -- pricing has ZERO behavior change), else NULL. price_amount_cents =
  -- hourly_rate_cents × duration; NULL when unpriced. Snapshotted once,
  -- here, at booking time — a later admin rate change, or a later
  -- membership_status change, never reprices this reservation.
  if v_membership_pricing_class = 'non_member' then
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
-- 4. admin_create_member_reservation — verbatim 0144 body + identical
--    class-aware price resolution as create_reservation, for an explicit
--    p_roster_member_id.
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
  -- create_reservation, for the explicit target roster member.
  v_membership_pricing_class := case
    when public.is_active_club_member(p_roster_member_id, v_club_id) then 'member'
    else 'non_member'
  end;

  -- Phase 34B/42B: identical resolve/snapshot formula as create_reservation.
  if v_membership_pricing_class = 'non_member' then
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
-- 5. update_member_reservation — verbatim 0151 body + member-reassignment
--    repricing. See this migration's header "FINDING on reassignment" for
--    why this is safe to add. Exact rule:
--      A. Court changes (regardless of Member/duration) -> resolve the
--         DESTINATION court's CURRENT rate, using the (possibly freshly
--         resolved) pricing class — unchanged mechanism from 0139, now
--         class-aware.
--      B. Member reassigned, court UNCHANGED -> resolve pricing class
--         fresh for the NEW roster member (a new customer identity), and
--         re-resolve the rate against the UNCHANGED court for that new
--         class. v_court is loaded here specifically for this case (the
--         existing v_scheduling_changed block never runs when only the
--         Member changes, so it never populates v_court on its own) —
--         same-club scoped but deliberately NOT requiring is_active = true
--         (correction, below): this reads the reservation's already-booked
--         court to reprice it, not a decision to create or move a booking,
--         so a court later deactivated for new bookings must not block
--         reassigning an existing, unmoved reservation to a different
--         Member.
--      C. Neither A nor B, duration only changes -> preserve the EXISTING
--         hourly_rate_cents AND the EXISTING membership_pricing_class
--         exactly; only price_amount_cents is re-multiplied by the new
--         duration. Matches the pre-42B behavior byte-for-byte.
--      D. Nothing scheduling/Member-relevant changes -> preserve both the
--         rate and the pricing class exactly as they were.
--    NULL-safety for legacy rows: the branch that resolves a NON-MEMBER
--    rate is keyed on `v_new_pricing_class = 'non_member'`, never
--    `= 'member'` — so a pre-42B reservation whose membership_pricing_class
--    is NULL (case C/D above, preserved unchanged) can never silently fall
--    into the Non-Member chain merely because NULL fails a `= 'member'`
--    check; NULL and 'member' both resolve through the existing Member/
--    default chain, exactly preserving current behavior for every
--    unclassified historical row.
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
  -- them. Contrast with v_scheduling_changed's own lookup (line ~662),
  -- which DOES require is_active = true because it governs moving a
  -- booking onto a (possibly different) court, a genuine new-booking
  -- decision.
  if v_member_changed and not v_scheduling_changed then
    select * into v_court
      from courts
      where id = p_court_id and club_id = v_club_id;
    if not found then raise exception 'invalid_court'; end if;
  end if;

  if v_court_changed or v_member_changed then
    select * into v_settings from public.club_settings where club_id = v_club_id;
    if v_new_pricing_class = 'non_member' then
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
-- 6. update_club_pricing — widened. Postgres treats a changed argument list
--    as a distinct function identity, so the live 2-arg overload is
--    explicitly DROPped before the 3-arg CREATE — a same-signature CREATE
--    OR REPLACE would leave BOTH callable, exactly the stale-overload
--    trap 0117's own get_roster_members correction already established the
--    discipline for. Body is the verbatim 0142 text (currency-lock guard
--    included) + the new param's validation/SET/audit + the two new
--    non-member rate columns added to the currency-lock scan (same
--    "rate configured = pricing exists, currency may not change" reasoning
--    the existing Member/default rate columns are already subject to).
--
--    CORRECTION PASS (post-review, before first apply): this function is
--    newly republished by this migration (a DROP + CREATE, not a
--    same-signature CREATE OR REPLACE preserving an untouched body) — the
--    same category of "new/republished privileged RPC" Phase 42A's own
--    correction pass (0188) already established must use the canonical
--    active-club pattern, not a direct `profiles%rowtype` read (which can
--    go stale relative to club_memberships). Rewritten accordingly: no
--    `v_profile` anywhere, every same-club lookup/write/audit scoped to
--    v_club_id resolved from current_user_club_id()/current_user_role().
--    Pricing behavior, validation, currency-lock semantics, audit action
--    name, and grants are otherwise unchanged.
-- ═══════════════════════════════════════════════════════════════════════════
drop function if exists public.update_club_pricing(text, integer);

create or replace function public.update_club_pricing(
  p_currency text,
  p_default_court_hourly_rate_cents integer,
  p_default_court_hourly_rate_non_member_cents integer default null
)
returns club_settings
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_id  uuid;
  v_role     text;
  v_settings club_settings%rowtype;
  v_currency text;
  v_positive_pricing_exists boolean;
  v_result   club_settings%rowtype;
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

  select * into v_settings from club_settings where club_id = v_club_id;

  if p_currency is null or btrim(p_currency) = '' then raise exception 'currency_required'; end if;
  v_currency := upper(btrim(p_currency));
  if v_currency !~ '^[A-Z]{3}$' then raise exception 'invalid_currency'; end if;

  if p_default_court_hourly_rate_cents is not null and p_default_court_hourly_rate_cents < 0 then
    raise exception 'invalid_rate';
  end if;

  -- Phase 42B.
  if p_default_court_hourly_rate_non_member_cents is not null and p_default_court_hourly_rate_non_member_cents < 0 then
    raise exception 'invalid_rate';
  end if;

  if v_currency is distinct from v_settings.currency then
    select exists (
      select 1 from club_settings where club_id = v_club_id and default_court_hourly_rate_cents > 0
      union all
      select 1 from club_settings where club_id = v_club_id and default_court_hourly_rate_non_member_cents > 0
      union all
      select 1 from courts where club_id = v_club_id and hourly_rate_cents > 0
      union all
      select 1 from courts where club_id = v_club_id and hourly_rate_non_member_cents > 0
      union all
      select 1 from lesson_types where club_id = v_club_id and unit_price_amount_cents > 0
      union all
      select 1 from event_types where club_id = v_club_id and default_price_amount_cents > 0
      union all
      select 1 from events where club_id = v_club_id and price_amount_cents > 0
      union all
      select 1 from programs where club_id = v_club_id and price_amount_cents > 0
      union all
      select 1 from reservations
        where club_id = v_club_id
          and (hourly_rate_cents > 0 or price_amount_cents > 0)
      union all
      select 1 from lesson_requests
        where club_id = v_club_id
          and (unit_price_amount_cents > 0 or price_amount_cents > 0)
      union all
      select 1 from event_participants ep
        join events e on e.id = ep.event_id
        where e.club_id = v_club_id and ep.price_amount_cents > 0
      union all
      select 1 from event_guests eg
        join events e on e.id = eg.event_id
        where e.club_id = v_club_id and eg.price_amount_cents > 0
      union all
      select 1 from program_enrollments pe
        join programs p on p.id = pe.program_id
        where p.club_id = v_club_id and pe.price_amount_cents > 0
    ) into v_positive_pricing_exists;

    if v_positive_pricing_exists then
      raise exception 'currency_locked_by_pricing';
    end if;
  end if;

  update club_settings set
    currency                                    = v_currency,
    default_court_hourly_rate_cents             = p_default_court_hourly_rate_cents,
    default_court_hourly_rate_non_member_cents  = p_default_court_hourly_rate_non_member_cents,
    updated_at                                  = now()
  where club_id = v_club_id
  returning * into v_result;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id,
    auth.uid(),
    'update_club_pricing',
    'club_settings',
    v_result.club_id,
    jsonb_build_object(
      'currency', v_currency,
      'default_court_hourly_rate_cents', p_default_court_hourly_rate_cents,
      'default_court_hourly_rate_non_member_cents', p_default_court_hourly_rate_non_member_cents
    )
  );

  return v_result;
end;
$$;

revoke execute on function public.update_club_pricing(text, integer, integer) from public, anon;
grant  execute on function public.update_club_pricing(text, integer, integer) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. set_court_hourly_rate — widened. Same DROP + CREATE discipline as
--    update_club_pricing above; the 2-arg overload is explicitly dropped
--    so it can never remain callable alongside the new 3-arg version.
--
--    CORRECTION PASS (post-review, before first apply): same correction as
--    update_club_pricing above — this is a newly republished privileged
--    RPC, so it now uses current_user_club_id()/current_user_role()
--    exclusively; no `v_profile` anywhere. A second, later correction also
--    scoped the final UPDATE itself to `id = p_court_id and club_id =
--    v_club_id` — the pre-write existence check alone is not a substitute
--    for the write itself failing closed on both identity and club.
-- ═══════════════════════════════════════════════════════════════════════════
drop function if exists public.set_court_hourly_rate(uuid, integer);

create or replace function public.set_court_hourly_rate(
  p_court_id uuid,
  p_hourly_rate_cents integer,
  p_hourly_rate_non_member_cents integer default null
)
returns courts
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_id uuid;
  v_role    text;
  v_result  courts%rowtype;
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

  if not exists (
    select 1 from courts where id = p_court_id and club_id = v_club_id
  ) then
    raise exception 'invalid_court';
  end if;

  if p_hourly_rate_cents is not null and p_hourly_rate_cents < 0 then
    raise exception 'invalid_rate';
  end if;

  -- Phase 42B.
  if p_hourly_rate_non_member_cents is not null and p_hourly_rate_non_member_cents < 0 then
    raise exception 'invalid_rate';
  end if;

  -- Correction: the write itself must fail closed on both identity AND
  -- club, not rely solely on the pre-write existence check above.
  update courts set
    hourly_rate_cents            = p_hourly_rate_cents,
    hourly_rate_non_member_cents = p_hourly_rate_non_member_cents
  where id = p_court_id
    and club_id = v_club_id
  returning * into v_result;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'set_court_hourly_rate', 'court', p_court_id,
    jsonb_build_object(
      'hourly_rate_cents', p_hourly_rate_cents,
      'hourly_rate_non_member_cents', p_hourly_rate_non_member_cents
    )
  );

  return v_result;
end;
$$;

revoke execute on function public.set_court_hourly_rate(uuid, integer, integer) from public, anon;
grant  execute on function public.set_court_hourly_rate(uuid, integer, integer) to authenticated;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration created in
-- this checkpoint)
-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Restore create_reservation, admin_create_member_reservation, and
--    update_member_reservation to their exact 0144/0151 bodies (this
--    file's own header quotes which migration is authoritative for each).
-- 2. `drop function if exists public.update_club_pricing(text, integer, integer);`
--    then restore the 0142 body (2-arg signature) via CREATE OR REPLACE.
-- 3. `drop function if exists public.set_court_hourly_rate(uuid, integer, integer);`
--    then restore the 0139 body (2-arg signature) via CREATE OR REPLACE.
-- 4. Drop the new columns/constraints: club_settings.
--    default_court_hourly_rate_non_member_cents, courts.
--    hourly_rate_non_member_cents, reservations.membership_pricing_class
--    (and its CHECK constraint).
-- No other table, policy, or function is touched by this migration. 0188's
-- roster_members.membership_status/.membership_type_id/is_active_club_member
-- are read-only consumed here, never modified.
