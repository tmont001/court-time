-- 0219_pro_lesson_schedule_advisory_lock.sql
-- Phase 45E3B — closes the proven P1 from the Phase 45E3A concurrency
-- audit: two DIFFERENT lesson_requests for the SAME Pro, on DIFFERENT
-- courts, at overlapping times could both durably commit as confirmed
-- lesson reservations. The court GiST exclusion constraint on
-- public.reservations never catches this, because its equality branch is
-- keyed on court_id — two different courts never conflict there regardless
-- of time overlap. No lock anywhere was ever scoped to the Pro's identity.
--
-- LIVE VERIFICATION (performed fresh this checkpoint): pulled
-- pg_get_functiondef + owner/prosecdef/search_path/proacl for all four
-- target writers and re-hashed their bodies against the Phase 45E3A
-- audit's own captured text — byte-identical, no drift. Also inspected
-- five directly-comparable existing internal lock/validation helpers
-- (_assert_event_capacity_available, _lock_and_validate_reservation_
-- roster_mutable, _lock_reservation_player_search_row,
-- _lock_reservation_player_search_scope,
-- _lesson_check_pro_availability_for_club) — every one of them has the
-- IDENTICAL live ACL shape: {postgres=X, service_role=X} only, no PUBLIC,
-- no anon, no authenticated. This is the established, unanimous
-- convention for a pure internal lock/check helper never intended as a
-- client-facing RPC, and the new helper below follows it exactly.
--
-- PROVEN RACE (accept-vs-accept; identical shape for the other three
-- writers): T1 accepts lesson request A for Pro P on Court 1, 10-11am; T2
-- concurrently accepts lesson request B for the SAME Pro P on Court 2,
-- 10-11am. Each locks only its OWN lesson_requests row (different rows,
-- no contention) and calls _lesson_check_pro_availability, a plain
-- unlocked SELECT COUNT against public.reservations/event_participants/
-- events — under READ COMMITTED, neither transaction's uncommitted insert
-- is visible to the other, so both see zero conflicts and both commit.
-- Pro P ends up double-booked.
--
-- THE FIX: a new transaction-scoped advisory lock, keyed on the Pro's own
-- identity, acquired by every function that durably writes a Pro-owned
-- lesson reservation — immediately before that function's own existing
-- (unmodified) Pro availability check, so the SECOND concurrent writer
-- blocks until the first commits, then re-runs its own availability check
-- against the now-visible, just-committed conflict and correctly raises
-- 'pro_has_conflict' instead of silently succeeding.
--
-- SCOPE (deliberately narrow — do not read this as closing every possible
-- Pro schedule race):
--   MUST PARTICIPATE (this migration): accept_lesson_proposal,
--   admin_create_member_lesson, admin_update_member_lesson (only its
--   scheduling_changed/pro_changed branch), admin_reassign_confirmed_
--   lesson_pro. These are the complete set of live functions that insert
--   or update a public.reservations row tied to a Pro's lesson occupancy
--   — confirmed by a live text search of every function body in the
--   public schema for calls to _lesson_check_pro_availability(/_for_club,
--   which surfaced these four plus propose_lesson_time (excluded below).
--
--   INTENTIONALLY EXCLUDED: public.propose_lesson_time never writes to
--   public.reservations at all — its only mutation is
--   UPDATE lesson_requests SET status='proposed', proposed_starts_at=...,
--   confirmed by reading its complete live body. Overlapping PROPOSALS
--   for the same Pro are already tolerated today and remain so — a
--   proposal consumes no durable capacity, so a lock there would only
--   serialize the check between two proposals, never prevent a durable
--   double-booking (which can only happen at accept time, which this
--   migration protects). Adding a lock to propose_lesson_time would be
--   exactly the "lock that gives false confidence" the audit warned
--   against, so it is not touched.
--
--   DOCUMENTED RESIDUAL HARDENING (explicitly NOT in scope for this
--   migration, tracked for a future checkpoint if ever prioritized):
--     - Lesson vs. a Pro's own personal member_booking court reservation
--       (create_reservation/update_member_reservation) — these do not
--       participate in this lock protocol, so a Pro self-booking a
--       personal slot at the exact moment someone else confirms a lesson
--       with them remains a theoretical, narrower race.
--     - Lesson vs. Event participation/Event-creator occupancy
--       (join_event, admin event-participant RPCs, create_event) — the
--       event module has its own, separately-audited (Phase 45E)
--       concurrency protections for ITS OWN invariants; extending the Pro
--       lock into it is out of scope here.
--
-- LOCK ORDER INVARIANT: in every function that acquires both locks, the
-- new Pro advisory lock is acquired strictly BEFORE the existing Member
-- roster advisory lock (inside _lesson_check_member_availability ->
-- _assert_roster_member_schedule_available, entirely unmodified). No
-- function anywhere acquires the Member lock and then, in the same
-- transaction, reaches for a Pro lock — the Pro lock exists only inside
-- these four writers, none of which call one another — so no reversed-
-- order path exists and no deadlock cycle is introduced.
--
-- The namespace prefix 'pro_schedule:' keeps this lock's keyspace
-- separate from the existing Member schedule lock's bare (unprefixed)
-- roster_member_id hash — matching the same prefixed-key convention
-- already used by _lock_reservation_player_search_scope. A hash
-- collision between two different prefixed/unprefixed inputs is not
-- mathematically impossible, but would only ever cause unnecessary
-- serialization (two unrelated identities briefly contending for the same
-- lock slot) — never a schedule-integrity failure, since the actual
-- conflict detection still runs, correctly, against real committed rows
-- after the lock is released.
--
-- No table/schema/RLS/policy/index change. No pricing/payment semantic
-- change. No change to propose_lesson_time, _lesson_check_pro_availability,
-- _lesson_check_pro_availability_for_club, _lesson_check_member_
-- availability, _assert_roster_member_schedule_available, court
-- constraints, event functions, or reservation/member-booking functions.
-- Every other statement in the four redefined writers is byte-identical
-- to their current live bodies — only the one new helper call is added to
-- each, in the approved location.
--
-- Created by this checkpoint. Do NOT apply until reviewed.

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- A. NEW INTERNAL HELPER — public._lock_pro_schedule(uuid)
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public._lock_pro_schedule(p_pro_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if p_pro_id is null then
    raise exception 'invalid_pro_schedule_lock_target';
  end if;

  -- Transaction-scoped (released automatically at COMMIT/ROLLBACK, never
  -- unlocked early) — held through the availability check AND the
  -- reservation insert/update that follows it in every caller, exactly
  -- like the existing Member schedule lock's own pattern.
  perform pg_advisory_xact_lock(
    hashtextextended('pro_schedule:' || p_pro_id::text, 0)
  );
end;
$function$;

alter function public._lock_pro_schedule(uuid) owner to postgres;
revoke execute on function public._lock_pro_schedule(uuid) from public;
revoke execute on function public._lock_pro_schedule(uuid) from anon;
revoke execute on function public._lock_pro_schedule(uuid) from authenticated;
grant  execute on function public._lock_pro_schedule(uuid) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- B. accept_lesson_proposal — Pro lock immediately before the existing
--    Pro availability check.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.accept_lesson_proposal(p_request_id uuid)
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

  -- Phase 45E3B: Pro schedule advisory lock, acquired immediately before
  -- the Pro availability check it protects — blocks a concurrent
  -- accept/admin-create/admin-update/admin-reassign for the SAME Pro
  -- until this transaction commits or rolls back, so the second writer's
  -- own check re-runs against fresh, committed state instead of a stale
  -- pre-commit snapshot.
  perform public._lock_pro_schedule(v_request.pro_id);

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
-- C. admin_create_member_lesson — Pro lock immediately before the
--    existing Pro availability check.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.admin_create_member_lesson(p_expected_club_id uuid, p_roster_member_id uuid, p_pro_id uuid, p_court_id uuid, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone, p_lesson_type_id uuid DEFAULT NULL::uuid, p_member_note text DEFAULT NULL::text)
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

  -- Phase 45E3B: Pro schedule advisory lock, acquired immediately before
  -- the Pro availability check it protects — see accept_lesson_proposal's
  -- own comment above for the full rationale.
  perform public._lock_pro_schedule(p_pro_id);

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
-- D. admin_update_member_lesson — Pro lock inside the existing
--    scheduling_changed/pro_changed branch, immediately before the
--    existing Pro availability check. Locks the TARGET (p_pro_id), never
--    the old pro. No lock acquired when neither scheduling nor pro changes.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.admin_update_member_lesson(p_request_id uuid, p_expected_club_id uuid, p_expected_updated_at timestamp with time zone, p_roster_member_id uuid, p_pro_id uuid, p_court_id uuid, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone, p_lesson_type_id uuid DEFAULT NULL::uuid, p_member_note text DEFAULT NULL::text)
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
  -- Phase 34E-A: pre-mutation Stripe Checkout invalidation.
  v_payment_id_for_checkout_guard uuid;
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

    -- Phase 45E3B: Pro schedule advisory lock, acquired immediately
    -- before the Pro availability check it protects, and only in this
    -- branch (a pure member-reassignment-with-no-scheduling/pro-change
    -- edit never touches the reservation's Pro-owned occupancy, so it
    -- never needs this lock). Locks the TARGET p_pro_id, never the old
    -- (possibly-being-replaced) pro — see accept_lesson_proposal's own
    -- comment above for the full rationale.
    perform public._lock_pro_schedule(p_pro_id);

    perform public._lesson_check_pro_availability(p_pro_id, p_starts_at, p_ends_at, p_request_id);
    perform public._lesson_check_member_availability(v_member_id, p_roster_member_id, p_starts_at, p_ends_at, p_request_id);
  end if;

  -- Phase 34E-A (correction pass): pre-mutation Stripe Checkout
  -- invalidation. Moved here, AFTER every validation above (including the
  -- scheduling-conflict/operating-hours/pro/member-availability checks
  -- just above, which the original 34E-A placement ran BEFORE — an
  -- invalid edit that would go on to fail court_conflict or an
  -- availability check must never expire a legitimate Stripe Checkout
  -- Session first), but still strictly BEFORE any local mutation
  -- (reservation soft-cancel/insert/update, lesson_requests UPDATE)
  -- below.
  --
  -- Phase 34F-A (external review correction, BLOCKER 2 + final delta):
  -- v_scheduling_changed and v_pro_changed both added to this condition —
  -- a pure court/time-only edit or a pure Pro-only reassignment previously
  -- skipped this guard entirely, even though instructor, date/time, and
  -- court are all material confirmed-lesson terms a Member's payment
  -- obligation depends on being settled, exactly like the priced amount
  -- already guarded here. This is NOT a pricing change — the existing
  -- pricing invariants above (time/court/provider-only edits never
  -- reprice) are untouched; this guard only ever invalidates/flags a
  -- Checkout ATTEMPT, never adjusts amount_due_cents/amount_paid_cents.
  -- These four conditions (scheduling, member, pro, price) are the ONLY
  -- changes to this function versus its 0151 body.
  if v_scheduling_changed
     or v_member_changed
     or v_pro_changed
     or v_price_amount_cents is distinct from v_before.price_amount_cents
  then
    select id into v_payment_id_for_checkout_guard
      from public.payments
     where club_id = v_club_id and domain_type = 'lesson_request' and domain_id = p_request_id
     order by obligation_cycle desc
     limit 1
     for update;
    if v_payment_id_for_checkout_guard is not null then
      perform public._invalidate_or_flag_open_checkout_attempt(v_payment_id_for_checkout_guard);
    end if;
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
-- E. admin_reassign_confirmed_lesson_pro — Pro lock (new target pro only)
--    immediately before the existing club-aware Pro availability check.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.admin_reassign_confirmed_lesson_pro(p_request_id uuid, p_expected_updated_at timestamp with time zone, p_new_pro_id uuid)
 RETURNS lesson_requests
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_club_id     uuid;
  v_role        text;
  v_request     public.lesson_requests%rowtype;
  v_reservation public.reservations%rowtype;
  v_new_pro_membership public.club_memberships%rowtype;
  v_new_pro     public.profiles%rowtype;
  v_member      public.profiles%rowtype;
  v_member_name text;
  v_old_pro_id  uuid;
  v_tz          text;
  v_result      public.lesson_requests%rowtype;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if v_role is null or v_role not in ('admin', 'staff') then raise exception 'insufficient_role'; end if;

  select * into v_request
    from public.lesson_requests
   where id      = p_request_id
     and club_id = v_club_id
   for update;
  if not found then raise exception 'request_not_found'; end if;

  if v_request.status <> 'confirmed' then raise exception 'invalid_status_for_pro_reassign'; end if;
  if v_request.updated_at is distinct from p_expected_updated_at then raise exception 'stale_edit_conflict'; end if;
  if v_request.linked_reservation_id is null then raise exception 'linked_reservation_not_found'; end if;

  select * into v_reservation
    from public.reservations
   where id      = v_request.linked_reservation_id
     and club_id = v_club_id
     and reason  = 'pro_lesson'
     and status  = 'confirmed'
   for update;
  if not found then raise exception 'linked_reservation_not_found'; end if;

  -- Already-started lesson: mirrors admin_update_member_lesson's/
  -- propose_lesson_time's identical guard exactly (0138/0159) — reassigning
  -- who taught a lesson that already happened corrects nothing.
  if v_reservation.starts_at <= now() then
    raise exception 'cannot_reschedule_started_lesson';
  end if;

  if v_request.pro_id = p_new_pro_id then
    raise exception 'same_pro';
  end if;

  -- Phase 38A correction (multi-club eligibility): reassign_lesson_provider
  -- (0132) / admin_update_member_lesson (0138) validate the target Pro
  -- against public.profiles.club_id/role/status/is_lesson_provider — a
  -- legacy compatibility PROJECTION of that user's CURRENTLY ACTIVE club
  -- membership only (0081), kept in sync only while a club_memberships row
  -- remains that user's current active membership — not a reliable
  -- per-club fact for a user who belongs to more than one club. A Pro
  -- active in Club A but currently viewing/active in Club B would
  -- incorrectly fail this check when Admin/Staff at Club A tries to
  -- reassign a Club A lesson to them, even though they hold a perfectly
  -- valid, active, lesson-providing membership in Club A. Since this
  -- function is new (not yet applied), it validates directly against
  -- public.club_memberships — the canonical per-(user, club) source since
  -- Phase 26B2 (0081's own header: "Source of truth starting Phase
  -- 26B2") — scoped to v_club_id (THIS lesson's own, caller-verified
  -- club), never the target's currently active club. Same fix shape
  -- already applied to send_announcement_v2 for the identical class of
  -- bug (0177) — reassign_lesson_provider/admin_update_member_lesson/
  -- get_admin_club_pros are pre-existing, already-applied migrations that
  -- share this same limitation and are intentionally left unmodified here.
  select * into v_new_pro_membership
    from public.club_memberships
   where user_id            = p_new_pro_id
     and club_id            = v_club_id
     and status              = 'active'
     and removed_at is null
     and role                in ('pro', 'admin', 'staff')
     and is_lesson_provider  = true;
  if not found then raise exception 'pro_not_found'; end if;

  -- Global identity (name) always comes from profiles regardless of which
  -- club is currently active — the same convention getAuthProfile/
  -- get_current_account_context already document (0081/0082): identity
  -- fields (id/first_name/last_name) are user-global, not club-scoped.
  select * into v_new_pro from public.profiles where id = p_new_pro_id;

  if v_request.member_id = p_new_pro_id then
    raise exception 'cannot_assign_to_self';
  end if;

  -- Phase 45E3B: Pro schedule advisory lock for the NEW target Pro,
  -- acquired immediately before the club-aware availability check it
  -- protects — see accept_lesson_proposal's own comment above for the
  -- full rationale. The OLD pro is never locked here: they are losing
  -- this lesson, not gaining a new schedule commitment.
  perform public._lock_pro_schedule(p_new_pro_id);

  -- Club-aware availability/blackout check (multi-club correction — see
  -- header). v_club_id is THIS lesson's own, caller-verified club, never
  -- the target Pro's profiles.club_id. Already excludes this lesson's own
  -- linked reservation via p_exclude_request_id.
  perform public._lesson_check_pro_availability_for_club(
    p_new_pro_id, v_club_id, v_reservation.starts_at, v_reservation.ends_at, p_request_id
  );

  v_old_pro_id := v_request.pro_id;

  select * into v_member from public.profiles where id = v_request.member_id;
  v_member_name := trim(coalesce(v_member.first_name, '') || ' ' || coalesce(v_member.last_name, ''));
  if v_member_name = '' then
    select trim(coalesce(first_name, '') || ' ' || coalesce(last_name, ''))
      into v_member_name
      from public.roster_members
     where id = v_request.roster_member_id;
  end if;

  select timezone into v_tz from public.clubs where id = v_club_id;

  -- Scheduling never changes here — update the existing reservation row IN
  -- PLACE (never soft-cancel-and-reinsert), preserving its id, court, and
  -- time exactly. Only the assigned Pro (owner_user_id) and the descriptive
  -- note change.
  update public.reservations
     set owner_user_id = p_new_pro_id,
         notes         = 'Pro lesson with ' || v_member_name,
         updated_at    = now()
   where id = v_reservation.id;

  update public.lesson_requests
     set pro_id          = p_new_pro_id,
         last_actor_id   = auth.uid(),
         last_actor_role = v_role,
         updated_at      = now()
   where id = p_request_id
  returning * into v_result;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'admin_reassign_confirmed_lesson_pro', 'lesson_request', p_request_id,
    jsonb_build_object(
      'old_pro_id',      v_old_pro_id,
      'new_pro_id',      p_new_pro_id,
      'reservation_id',  v_reservation.id
    )
  );

  insert into public.notifications (club_id, user_id, kind, body, metadata)
  values (
    v_club_id, p_new_pro_id, 'lesson_provider_reassigned',
    'You have been assigned a confirmed lesson with ' || v_member_name || ' on ' ||
      to_char(v_reservation.starts_at at time zone v_tz, 'Mon DD "at" HH12:MI AM') || '.',
    jsonb_build_object('request_id', p_request_id, 'reservation_id', v_reservation.id)
  );

  insert into public.notifications (club_id, user_id, kind, body, metadata)
  values (
    v_club_id, v_old_pro_id, 'lesson_provider_reassigned',
    'Your lesson with ' || v_member_name || ' on ' ||
      to_char(v_reservation.starts_at at time zone v_tz, 'Mon DD "at" HH12:MI AM') ||
      ' has been reassigned to another pro.',
    jsonb_build_object('request_id', p_request_id, 'reservation_id', v_reservation.id)
  );

  -- A no-account Member (member_id null) has no user_id to notify in-app —
  -- the calling Server Action sends the operational email directly to
  -- roster_members.email instead (v_result.roster_member_id is already
  -- part of `returning *` above), mirroring cancelLesson's own no-account
  -- branch exactly. No new communications mechanism is introduced here.
  if v_request.member_id is not null then
    insert into public.notifications (club_id, user_id, kind, body, metadata)
    values (
      v_club_id, v_request.member_id, 'lesson_provider_reassigned',
      'Your lesson on ' || to_char(v_reservation.starts_at at time zone v_tz, 'Mon DD "at" HH12:MI AM') ||
        ' has been reassigned to ' ||
        trim(coalesce(v_new_pro.first_name, '') || ' ' || coalesce(v_new_pro.last_name, '')) || '.',
      jsonb_build_object('request_id', p_request_id, 'new_pro_id', p_new_pro_id)
    );
  end if;

  return v_result;
end;
$function$;

commit;
