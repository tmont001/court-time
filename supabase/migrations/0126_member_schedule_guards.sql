-- 0126_member_schedule_guards.sql
-- Phase 33G1C: authoritative cross-domain Member schedule guards.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
-- 33G1A/33G1B audited cross-domain scheduling correctness and found no
-- authority anywhere preventing a roster Member from holding two
-- overlapping CONFIRMED commitments across court Reservations, Events, and
-- Lessons. An earlier draft plan would have patched every individual
-- Reservation/Event/Program RPC — rejected as exactly the kind of drifting,
-- duplicated invariant this checkpoint exists to eliminate.
--
-- Architecture instead: the rule lives at the CONFIRMED DATA TRANSITION
-- itself, as FOUR narrow BEFORE-row triggers (reservations,
-- event_participants, events, lesson_requests), all delegating to one
-- shared internal assertion. This makes the guard authoritative for every
-- current AND future writer automatically — create_reservation,
-- admin_create_member_reservation, both update_member_reservation
-- overloads (10-arg legacy and 11-arg current), a direct authenticated
-- INSERT under reservations_insert_own, join_event,
-- admin_add_roster_participant, accept_waitlist_offer, admin_force_confirm,
-- admin_force_confirm_roster_participant, join_program,
-- _materialize_program_member_into_future_events,
-- force_confirm_program_roster_member, add_program_roster_member,
-- generate_program_sessions, update_event, and any future Event-time
-- writer all become protected without any of their own function bodies
-- being touched. Existing RPC-level prechecks
-- (_lesson_check_member_availability, _lesson_check_pro_availability) may
-- remain for early, friendly UX errors, but the triggers are final
-- authority and cannot be bypassed by any writer that reaches a table.
--
-- The events guard (Section 3B) closes a hole found in review before this
-- migration was applied: the event_participants guard alone only fires
-- when a participant row itself changes. update_event (or any future
-- Event-time writer) can change events.starts_at/ends_at while every
-- existing confirmed event_participants row is left completely untouched
-- — e.g. a Member confirmed into a 12:00-13:00 Event, holding an unrelated
-- 10:00-11:00 Reservation, would become silently double-booked if the
-- Event were edited to 10:00-11:00, because no event_participants row
-- ever changes in that edit. Section 3B closes this by guarding
-- events.starts_at/ends_at/status/archived_at directly.
--
-- LOCKED INVARIANT: a roster Member (roster_members.id — never
-- profile/email/display name) must not hold overlapping CONFIRMED
-- commitments across Member court Reservations, Events, and Lessons.
-- Waitlisted/offered positions never block. Overlap is [start,end) —
-- 10:00-11:00 and 11:00-12:00 do not conflict; 10:00-11:00 and 10:30-11:30
-- do.
--
-- DOMAIN FILTERS (avoids the double-count identified in 33G1B — a
-- confirmed Lesson's linked reason='pro_lesson' reservation is the Lesson's
-- own business commitment, never counted a second time as a Reservation):
--   Reservation: reason = 'member_booking', status = 'confirmed'
--   Lesson:      lesson_requests.status = 'confirmed'
--   Event:       event_participants.status = 'confirmed', joined directly
--                to events.starts_at/ends_at, only for events.status =
--                'scheduled' and archived_at is null (cancelled/archived
--                history never blocks)
--
-- CONCURRENCY: each check acquires pg_advisory_xact_lock(hashtextextended
-- (roster_member_id::text, 0)) before reading — a transaction-scoped lock,
-- released only at COMMIT/ROLLBACK, so it is held through the entire
-- mutation, not just the check. A hash collision between two different
-- roster_member_ids only causes harmless extra serialization; the same
-- roster_member_id always hashes identically, so same-identity
-- serialization is never missed. Two writers can affect MULTIPLE Members
-- in a single transaction: generate_program_sessions (all currently-
-- enrolled whole-program Members, into each newly generated session) and,
-- as of Section 3B, an events.starts_at/ends_at/status/archived_at edit
-- (every confirmed participant of that Event). Both now iterate/order
-- their affected Members by roster_member_id before checking each one —
-- generate_program_sessions via an explicit ORDER BY on its bulk INSERT,
-- the events guard via an explicit ORDER BY on the FOR loop that walks
-- its confirmed event_participants — so the per-row locks either acquires
-- are always requested in the same fixed order, preventing a circular-
-- wait deadlock between them or against any other multi-lock transaction.
-- No other current writer acquires more than one Member's lock per
-- transaction, so ordering
-- is not a concern for them.
--
-- Section 3B's Event-time edit and Section 3's participant confirmation
-- also serialize against EACH OTHER for the same Event, independent of
-- the advisory-lock scheme above: the participant guard FOR SHARE-locks
-- the Event row before doing anything else, and an ordinary UPDATE to
-- that row (Section 3B's own trigger context) takes a conflicting lock —
-- so a confirmation and an Event-time edit for the same Event can never
-- each commit having reasoned from a state the other had not yet written.
-- The Event row lock is always acquired before the Member advisory lock
-- (Event row lock -> Member advisory lock), a fixed order that avoids
-- introducing any new deadlock risk against the ordering already
-- described above.
--
-- SCOPE BOUNDARY: this migration does NOT change Program per-session
-- capacity semantics (deferred to 33G1D — a genuine, undecided product
-- question, not a mechanical fix), does not touch Lesson UX/navigation,
-- Phase 34 pricing/payments, staff roles, or commercial entitlements. Not
-- applied by this checkpoint. Not committed. Does not modify 0001-0125.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Shared internal authority. Private — revoked from public/anon/
-- authenticated entirely; callable only from the trigger functions below
-- (which run SECURITY DEFINER, so their execution context is the owning
-- role, not the original caller's role — the same mechanism every other
-- internal helper in this schema already relies on, e.g.
-- enforce_member_booking_roster_identity reading roster_members despite
-- ordinary sessions having no direct SELECT grant there).
--
-- Fails closed on invalid input (null identity, null/inverted range)
-- rather than silently passing. Raises a single consistent code,
-- member_schedule_conflict, for any of the three domains — callers wanting
-- a more specific message (see _lesson_check_member_availability below)
-- may catch and remap it, but the trigger-level guard itself never needs
-- three-way disambiguation to be correct.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public._assert_roster_member_schedule_available(
  p_roster_member_id             uuid,
  p_starts_at                    timestamptz,
  p_ends_at                      timestamptz,
  p_exclude_reservation_id       uuid default null,
  p_exclude_lesson_request_id    uuid default null,
  p_exclude_event_participant_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_conflict int;
begin
  if p_roster_member_id is null then
    raise exception 'invalid_schedule_check_target';
  end if;

  if p_starts_at is null or p_ends_at is null or p_ends_at <= p_starts_at then
    raise exception 'invalid_schedule_check_range';
  end if;

  -- Serializes every confirmed-commitment check-then-write for this exact
  -- roster identity for the remainder of this transaction. Transaction-
  -- scoped (not session-scoped): released automatically at COMMIT/
  -- ROLLBACK, never unlocked early, so it is held through the mutation
  -- that follows this call, not just through this SELECT.
  perform pg_advisory_xact_lock(hashtextextended(p_roster_member_id::text, 0));

  -- Member court Reservation. reason = 'member_booking' only — a
  -- reason = 'pro_lesson' reservation is the Lesson's own linked booking,
  -- checked below via lesson_requests instead, never here (avoids the
  -- double-count identified in 33G1B).
  select count(*) into v_conflict
    from public.reservations r
   where r.reason           = 'member_booking'
     and r.status            = 'confirmed'
     and r.roster_member_id  = p_roster_member_id
     and tstzrange(r.starts_at, r.ends_at, '[)') && tstzrange(p_starts_at, p_ends_at, '[)')
     and (p_exclude_reservation_id is null or r.id is distinct from p_exclude_reservation_id);
  if v_conflict > 0 then
    raise exception 'member_schedule_conflict';
  end if;

  -- Lesson.
  select count(*) into v_conflict
    from public.lesson_requests lr
   where lr.status           = 'confirmed'
     and lr.roster_member_id = p_roster_member_id
     and tstzrange(lr.proposed_starts_at, lr.proposed_ends_at, '[)') && tstzrange(p_starts_at, p_ends_at, '[)')
     and (p_exclude_lesson_request_id is null or lr.id is distinct from p_exclude_lesson_request_id);
  if v_conflict > 0 then
    raise exception 'member_schedule_conflict';
  end if;

  -- Event. Joined directly to events.starts_at/ends_at, not indirectly via
  -- a possibly-absent linked reservation. Only a scheduled, non-archived
  -- event counts — cancelled/archived history never blocks.
  select count(*) into v_conflict
    from public.event_participants ep
    join public.events e on e.id = ep.event_id
   where ep.status           = 'confirmed'
     and ep.roster_member_id = p_roster_member_id
     and e.status             = 'scheduled'
     and e.archived_at       is null
     and tstzrange(e.starts_at, e.ends_at, '[)') && tstzrange(p_starts_at, p_ends_at, '[)')
     and (p_exclude_event_participant_id is null or ep.id is distinct from p_exclude_event_participant_id);
  if v_conflict > 0 then
    raise exception 'member_schedule_conflict';
  end if;
end;
$$;

revoke execute on function public._assert_roster_member_schedule_available(uuid, timestamptz, timestamptz, uuid, uuid, uuid)
  from public, anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- Supporting partial indexes — the trigger functions below run this
-- assertion's three SELECTs on every relevant confirmed-commitment write
-- across the whole schema; each index matches one check's WHERE clause
-- exactly, keyed on roster_member_id first (the column every check filters
-- on) so the planner can use it directly instead of scanning.
-- ═══════════════════════════════════════════════════════════════════════════
create index if not exists reservations_member_booking_confirmed_roster_idx
  on public.reservations (roster_member_id, starts_at, ends_at)
  where reason = 'member_booking' and status = 'confirmed';

create index if not exists lesson_requests_confirmed_roster_idx
  on public.lesson_requests (roster_member_id, proposed_starts_at, proposed_ends_at)
  where status = 'confirmed';

create index if not exists event_participants_confirmed_roster_idx
  on public.event_participants (roster_member_id, event_id)
  where status = 'confirmed';


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Reservation guard. Fires only for a reservation that IS (post-write) a
-- confirmed Member booking, and on UPDATE only when a commitment-relevant
-- column is actually part of the UPDATE's SET list (Postgres's own
-- `UPDATE OF column_list` trigger feature — an ordinary notes/format/
-- player_count/guest_names-only edit never touches any of these five
-- columns, so the trigger does not fire and does not pay the lock/check
-- cost). Named to sort alphabetically AFTER reservations_member_booking_
-- identity_guard (0108) and BEFORE reservations_updated_at (0003) among
-- same-table same-event triggers, which Postgres fires in name order —
-- so roster identity is already validated by the time this guard runs.
-- Self-exclusion via new.id covers UPDATE (a plain edit never conflicts
-- with its own prior row) and is a harmless no-op on INSERT.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.enforce_reservation_member_schedule()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._assert_roster_member_schedule_available(
    p_roster_member_id       => new.roster_member_id,
    p_starts_at              => new.starts_at,
    p_ends_at                => new.ends_at,
    p_exclude_reservation_id => new.id
  );
  return new;
end;
$$;

drop trigger if exists reservations_member_schedule_guard on public.reservations;
create trigger reservations_member_schedule_guard
  before insert or update of roster_member_id, starts_at, ends_at, status, reason
  on public.reservations
  for each row
  when (new.reason = 'member_booking' and new.status = 'confirmed')
  execute function public.enforce_reservation_member_schedule();


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Event-participant guard. Fires only when the row IS confirmed
-- (post-write), and on UPDATE only when event_id/roster_member_id/status
-- is part of the UPDATE's SET list — an offer_expires_at-only touch, for
-- example, never fires this. Covers every writer automatically: join_event,
-- admin_add_roster_participant, accept_waitlist_offer, admin_force_confirm,
-- admin_force_confirm_roster_participant, program materialization into
-- generated Events (both directions — see Section 8), and any future
-- confirmed-participant writer, without any of those function bodies being
-- touched. There is no pre-existing trigger on event_participants to order
-- against. Serializes against a concurrent Section 3B Event-time edit for
-- the same Event via a FOR SHARE lock on the Event row, acquired before
-- any Member schedule check — see the trigger function body for the full
-- ordering argument.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.enforce_event_participant_member_schedule()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event public.events%rowtype;
begin
  -- Phase 33G1C concurrency fix: FOR SHARE row-locks the Event BEFORE any
  -- Member schedule check or advisory lock. Without this, a confirmation
  -- here and a concurrent Event-time edit (Section 3B's guard, which
  -- fires as part of an ordinary UPDATE on this same row) could each read
  -- a committed state that the other has not yet accounted for. A plain
  -- UPDATE's own row lock conflicts with FOR SHARE, so acquiring it here
  -- forces the two to serialize against each other through this one row
  -- — deliberately BEFORE _assert_roster_member_schedule_available's
  -- advisory lock (Event row lock -> Member advisory lock), so a
  -- participant confirmation and an Event-time edit for that same Event
  -- always resolve in one consistent order rather than each reasoning
  -- from a different, only-locally-consistent snapshot.
  select * into v_event from public.events where id = new.event_id for share;
  if not found then
    raise exception 'event_not_found';
  end if;

  -- A cancelled/archived Event is not a confirmed schedule commitment —
  -- skip the assertion rather than checking against a time that no
  -- longer represents a live obligation. If later restored to
  -- scheduled/non-archived, events_member_schedule_guard (Section 3B)
  -- re-checks every confirmed participant at that exact transition, so
  -- this is not a coverage gap.
  if v_event.status <> 'scheduled' or v_event.archived_at is not null then
    return new;
  end if;

  perform public._assert_roster_member_schedule_available(
    p_roster_member_id             => new.roster_member_id,
    p_starts_at                    => v_event.starts_at,
    p_ends_at                      => v_event.ends_at,
    p_exclude_event_participant_id => new.id
  );
  return new;
end;
$$;

drop trigger if exists event_participants_member_schedule_guard on public.event_participants;
create trigger event_participants_member_schedule_guard
  before insert or update of event_id, roster_member_id, status
  on public.event_participants
  for each row
  when (new.status = 'confirmed')
  execute function public.enforce_event_participant_member_schedule();


-- ═══════════════════════════════════════════════════════════════════════════
-- 3B. Event guard — closes the bypass found in review: editing an Event's
-- own time/status/archived state can silently double-book every one of
-- its confirmed participants, because none of THEIR event_participants
-- rows change when only the Event row changes (Section 3's guard never
-- fires in that case). BEFORE UPDATE only — a brand-new Event cannot yet
-- have any confirmed event_participants row, so there is nothing to check
-- on INSERT. Fires only when starts_at/ends_at/status/archived_at is part
-- of the UPDATE's SET list AND the resulting NEW row is itself an active
-- commitment context (status = 'scheduled', archived_at IS NULL) — an
-- edit that cancels or archives an Event is never itself a scheduling
-- conflict.
--
-- Walks every currently-confirmed event_participants row for this Event,
-- in ascending roster_member_id order (the same deadlock-avoidance
-- ordering generate_program_sessions uses — an Event edit can affect
-- multiple confirmed Members in one transaction), and asserts each one
-- against the Event's NEW starts_at/ends_at, excluding that participant's
-- own row via p_exclude_event_participant_id. That exclusion is required
-- because _assert_roster_member_schedule_available's own Event check
-- joins event_participants to events to read the OTHER event's time — for
-- this SAME participant's own row, that join still resolves to the OLD,
-- not-yet-written events row (a BEFORE trigger runs before the physical
-- update), so without excluding it by id the participant's own still-
-- confirmed commitment could be miscounted as a distinct conflicting
-- Event. This does not change Event capacity semantics in any way — 33G1D
-- remains the only place that behavior is addressed.
--
-- Covers update_event automatically, and any future writer that changes
-- an Event's time/status/archived_at, without that function's own body
-- being touched.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.enforce_event_member_schedule()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_participant record;
begin
  for v_participant in
    select ep.id, ep.roster_member_id
      from public.event_participants ep
     where ep.event_id = new.id
       and ep.status    = 'confirmed'
     order by ep.roster_member_id
  loop
    perform public._assert_roster_member_schedule_available(
      p_roster_member_id             => v_participant.roster_member_id,
      p_starts_at                    => new.starts_at,
      p_ends_at                      => new.ends_at,
      p_exclude_event_participant_id => v_participant.id
    );
  end loop;

  return new;
end;
$$;

drop trigger if exists events_member_schedule_guard on public.events;
create trigger events_member_schedule_guard
  before update of starts_at, ends_at, status, archived_at
  on public.events
  for each row
  when (new.status = 'scheduled' and new.archived_at is null)
  execute function public.enforce_event_member_schedule();


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Lesson guard. Fires only when the row IS confirmed with a concrete
-- proposed time (post-write), and on UPDATE only when roster_member_id/
-- proposed_starts_at/proposed_ends_at/status is part of the UPDATE's SET
-- list. Covers submit-then-confirm, proposal acceptance, reschedule, and
-- Member reassignment uniformly — final Member-side authority for Lessons,
-- independent of and complementary to _lesson_check_pro_availability
-- (Section 6), which remains the separate Pro-side concern.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.enforce_lesson_request_member_schedule()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._assert_roster_member_schedule_available(
    p_roster_member_id          => new.roster_member_id,
    p_starts_at                 => new.proposed_starts_at,
    p_ends_at                   => new.proposed_ends_at,
    p_exclude_lesson_request_id => new.id
  );
  return new;
end;
$$;

drop trigger if exists lesson_requests_member_schedule_guard on public.lesson_requests;
create trigger lesson_requests_member_schedule_guard
  before insert or update of roster_member_id, proposed_starts_at, proposed_ends_at, status
  on public.lesson_requests
  for each row
  when (
    new.status = 'confirmed'
    and new.proposed_starts_at is not null
    and new.proposed_ends_at   is not null
  )
  execute function public.enforce_lesson_request_member_schedule();


-- ═══════════════════════════════════════════════════════════════════════════
-- 5. _lesson_check_pro_availability — narrow correction only. Latest
-- effective body: 0070_lesson_competitive_foundation.sql:987-1065,
-- reproduced verbatim below with exactly one change: the event-conflict
-- sub-check's status filter narrows from ('confirmed','offered') to
-- 'confirmed' only. No provider-specific business rule requiring an
-- outstanding, not-yet-accepted offer to block a Pro's schedule was found
-- anywhere in this codebase — the prior inclusion of 'offered' here
-- appears to be inherited from the capacity-counting convention used
-- elsewhere (where 'offered' correctly reserves inventory), applied
-- without a clear reason to this different, personal-conflict concern.
-- Pro identity, the reservation-conflict check, the event-creator check,
-- and the blackout-date check are all completely unchanged. Not merged
-- with the new roster-based Member primitive — Pros are staff who always
-- hold an account in practice, and owner_user_id on a pro_lesson
-- reservation is the Pro's own profiles.id, not a roster identity concern.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public._lesson_check_pro_availability(
  p_pro_id    uuid,
  p_starts_at timestamptz,
  p_ends_at   timestamptz,
  p_exclude_request_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_conflict   int;
  v_range      tstzrange;
  v_club_id    uuid;
  v_tz         text;
  v_local_date date;
begin
  v_range := tstzrange(p_starts_at, p_ends_at, '[)');

  -- Check overlapping court reservations owned by the pro
  select count(*) into v_conflict
    from public.reservations r
   where r.owner_user_id = p_pro_id
     and r.status        in ('pending', 'confirmed')
     and tstzrange(r.starts_at, r.ends_at, '[)') && v_range
     and (p_exclude_request_id is null
          or r.id not in (
            select linked_reservation_id from public.lesson_requests
             where id = p_exclude_request_id
               and linked_reservation_id is not null
          ));

  if v_conflict > 0 then raise exception 'pro_has_conflict'; end if;

  -- Check overlapping event participation (host or confirmed participant).
  -- Phase 33G1C: narrowed to status = 'confirmed' only — an outstanding,
  -- not-yet-accepted offer is not a personal commitment for the Pro either.
  select count(*) into v_conflict
    from public.event_participants ep
    join public.reservations       er on er.event_id  = ep.event_id
                                     and er.status     in ('pending', 'confirmed')
                                     and tstzrange(er.starts_at, er.ends_at, '[)') && v_range
   where ep.profile_id = p_pro_id
     and ep.status     = 'confirmed';

  if v_conflict > 0 then raise exception 'pro_has_event_conflict'; end if;

  -- Also catch event creators who may not have an event_participants row
  select count(*) into v_conflict
    from public.events e
    join public.reservations er on er.event_id  = e.id
                               and er.status     in ('pending', 'confirmed')
                               and tstzrange(er.starts_at, er.ends_at, '[)') && v_range
   where e.created_by = p_pro_id
     and e.status     = 'scheduled'
     and not exists (
       select 1 from public.event_participants ep2
        where ep2.event_id   = e.id
          and ep2.profile_id = p_pro_id
     );

  if v_conflict > 0 then raise exception 'pro_has_event_conflict'; end if;

  -- Check pro blackout dates
  select p.club_id into v_club_id
    from public.profiles p where p.id = p_pro_id;

  select timezone into v_tz from public.clubs where id = v_club_id;

  v_local_date := (p_starts_at at time zone v_tz)::date;

  if exists (
    select 1 from public.pro_blackout_dates b
     where b.pro_id       = p_pro_id
       and b.blackout_date = v_local_date
  ) then
    raise exception 'pro_on_blackout';
  end if;
end;
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 6. _lesson_check_member_availability — reduced to a compatibility
-- preflight wrapper over the new shared assertion, per 33G1B, rather than
-- maintaining a second independent implementation of Reservation/Event/
-- Lesson conflict SQL. Signature is fully preserved (p_member_id is
-- accepted but no longer used — roster_member_id is now the sole
-- authoritative identity; every current call site already supplies it
-- unconditionally) so propose_lesson_time, accept_lesson_proposal,
-- admin_create_member_lesson, and admin_update_member_lesson need no
-- changes at all. This wrapper now exists purely to surface a clean,
-- early, friendly member_schedule_conflict error before those RPCs attempt
-- their write — the lesson_requests trigger (Section 4) remains final
-- authority regardless, and raises the identical error code, so there is
-- no risk of the two ever disagreeing on what counts as a conflict.
-- p_exclude_request_id maps directly to the assertion's lesson-exclusion
-- parameter (a reschedule of an already-confirmed lesson must not
-- self-conflict against its own still-active row); the assertion's
-- reservation check no longer needs a parallel linked-reservation
-- exclusion, because reason='member_booking' scoping means a pro_lesson
-- reservation was never examined by that branch in the first place.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public._lesson_check_member_availability(
  p_member_id           uuid,
  p_roster_member_id    uuid,
  p_starts_at           timestamptz,
  p_ends_at             timestamptz,
  p_exclude_request_id  uuid default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_roster_member_id is null then
    return;
  end if;

  perform public._assert_roster_member_schedule_available(
    p_roster_member_id           => p_roster_member_id,
    p_starts_at                  => p_starts_at,
    p_ends_at                    => p_ends_at,
    p_exclude_lesson_request_id  => p_exclude_request_id
  );
end;
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 7. generate_program_sessions — deterministic lock-ordering fix only.
-- Latest effective body: 0115_program_enrollment_identity.sql:1464-1711,
-- reproduced verbatim below with exactly one addition: an explicit
-- `order by pe.roster_member_id` on the per-session bulk confirmed-
-- participant materialization SELECT. This is the only current writer
-- that can confirm MULTIPLE roster Members in a single transaction (every
-- currently-'enrolled' whole-program Member, into each newly generated
-- session) — the event_participants trigger (Section 3) fires once per
-- inserted row and therefore acquires one advisory lock per Member as
-- each row is processed; without a defined order, two concurrent multi-
-- Member transactions (e.g. two overlapping generate_program_sessions
-- calls, or one racing a direct join_event) could acquire overlapping
-- locks in opposite order and deadlock. Sorting this SELECT's output
-- guarantees the same fixed order every time this statement runs, in
-- every transaction, closing that risk. No other current writer acquires
-- more than one Member's lock per transaction, so no other change is
-- needed. Does NOT add any capacity check or change any capacity
-- behavior — that remains explicitly deferred to 33G1D.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.generate_program_sessions(
  p_program_id    uuid,
  p_from_date     date default null,
  p_through_date  date default null
)
returns table (
  inserted_count int,
  skipped_count  int,
  event_ids      uuid[]
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id            uuid;
  v_role               text;
  v_program            public.programs%rowtype;
  v_tz                 text;
  v_from               date;
  v_through            date;
  v_total_count        int;
  v_new_count          int;
  v_conflict_res_id    uuid;
  v_conflict_court_id  uuid;
  v_conflict_date      date;
  v_conflict_rule_a    uuid;
  v_conflict_rule_b    uuid;
  v_rec                record;
  v_starts_at          timestamptz;
  v_ends_at            timestamptz;
  v_capacity           int;
  v_court_count        int;
  v_member_joinable    boolean;
  v_new_event          public.events%rowtype;
  v_court_rec          record;
  v_inserted_ids       uuid[] := '{}';
  v_inserted_count     int    := 0;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if v_role not in ('admin', 'pro') then raise exception 'insufficient_role'; end if;

  select * into v_program
    from public.programs
    where id = p_program_id and club_id = v_club_id
    for update;
  if not found then raise exception 'program_not_found'; end if;

  if v_role = 'pro' and v_program.created_by <> auth.uid() then
    raise exception 'insufficient_role';
  end if;

  if v_program.archived_at is not null then raise exception 'program_archived'; end if;
  if v_program.status not in ('draft', 'active') then raise exception 'program_not_generatable'; end if;

  perform public._validate_program_definition(p_program_id, v_club_id, v_program.event_type_id);

  v_from    := greatest(coalesce(p_from_date, v_program.starts_on), v_program.starts_on);
  v_through := least(coalesce(p_through_date, v_program.ends_on), v_program.ends_on);

  if v_through < v_from then raise exception 'invalid_date_range'; end if;
  if (v_through - v_from) > 182 then raise exception 'range_too_long'; end if;

  select timezone into v_tz from public.clubs where id = v_club_id;

  select count(*) into v_total_count
  from public.program_schedule_rules psr
  cross join generate_series(v_from::timestamp, v_through::timestamp, interval '1 day') as d
  where psr.program_id = p_program_id
    and extract(dow from d)::int = psr.day_of_week;

  drop table if exists pg27b2_candidates;

  create temporary table pg27b2_candidates (
    rule_id            uuid,
    occurrence_date    date,
    start_time         time,
    duration_minutes   int,
    capacity_override  int,
    court_id           uuid
  ) on commit drop;

  insert into pg27b2_candidates (rule_id, occurrence_date, start_time, duration_minutes, capacity_override, court_id)
  select psr.id, d::date, psr.start_time, psr.duration_minutes, psr.capacity_override, prc.court_id
  from public.program_schedule_rules psr
  cross join generate_series(v_from::timestamp, v_through::timestamp, interval '1 day') as d
  join public.program_rule_courts prc on prc.program_schedule_rule_id = psr.id
  where psr.program_id = p_program_id
    and extract(dow from d)::int = psr.day_of_week
    and not exists (
      select 1 from public.events e
      where e.program_schedule_rule_id = psr.id
        and e.program_occurrence_date  = d::date
    );

  select count(distinct (rule_id, occurrence_date)) into v_new_count from pg27b2_candidates;

  if v_new_count = 0 then
    insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
    values (
      v_club_id, auth.uid(), 'generate_program_sessions', 'program', p_program_id,
      jsonb_build_object(
        'inserted_count',   0,
        'skipped_count',    v_total_count,
        'from',             v_from,
        'through',          v_through,
        'program_owner_id', v_program.created_by,
        'generated_by_id',  auth.uid()
      )
    );
    return query select 0, v_total_count, '{}'::uuid[];
    return;
  end if;

  if v_new_count > 200 then
    raise exception 'too_many_occurrences';
  end if;

  select a.court_id, a.occurrence_date, a.rule_id, b.rule_id
    into v_conflict_court_id, v_conflict_date, v_conflict_rule_a, v_conflict_rule_b
  from pg27b2_candidates a
  join pg27b2_candidates b
    on a.court_id = b.court_id
   and a.occurrence_date = b.occurrence_date
   and a.rule_id < b.rule_id
   and a.start_time < (b.start_time + (b.duration_minutes || ' minutes')::interval)::time
   and b.start_time < (a.start_time + (a.duration_minutes || ' minutes')::interval)::time
  limit 1;

  if v_conflict_court_id is not null then
    raise exception 'court_conflict'
      using detail = format(
        'batch_self_conflict court_id=%s occurrence_date=%s rule_a=%s rule_b=%s',
        v_conflict_court_id, v_conflict_date, v_conflict_rule_a, v_conflict_rule_b
      );
  end if;

  select r.id, c.court_id, c.occurrence_date
    into v_conflict_res_id, v_conflict_court_id, v_conflict_date
  from pg27b2_candidates c
  join public.reservations r
    on r.court_id = c.court_id
   and r.status in ('pending', 'confirmed')
   and tstzrange(r.starts_at, r.ends_at, '[)')
       && tstzrange(
            (c.occurrence_date + c.start_time) at time zone v_tz,
            ((c.occurrence_date + c.start_time) at time zone v_tz) + (c.duration_minutes || ' minutes')::interval,
            '[)'
          )
  limit 1;

  if v_conflict_res_id is not null then
    raise exception 'court_conflict'
      using detail = format(
        'existing_reservation court_id=%s occurrence_date=%s reservation_id=%s',
        v_conflict_court_id, v_conflict_date, v_conflict_res_id
      );
  end if;

  for v_rec in
    select distinct rule_id, occurrence_date, start_time, duration_minutes, capacity_override
    from pg27b2_candidates
    order by occurrence_date, start_time
  loop
    v_starts_at := (v_rec.occurrence_date + v_rec.start_time) at time zone v_tz;
    v_ends_at   := v_starts_at + (v_rec.duration_minutes || ' minutes')::interval;
    v_capacity  := coalesce(v_rec.capacity_override, v_program.default_capacity);

    select count(*) into v_court_count
      from public.program_rule_courts
      where program_schedule_rule_id = v_rec.rule_id;

    v_member_joinable := (v_program.enrollment_model = 'per_session');

    insert into public.events (
      club_id, event_type_id, title, description,
      starts_at, ends_at, capacity, court_count, status, created_by,
      member_joinable, program_id, program_schedule_rule_id,
      program_occurrence_date, is_program_exception
    ) values (
      v_club_id, v_program.event_type_id, v_program.title, v_program.description,
      v_starts_at, v_ends_at, v_capacity, v_court_count, 'scheduled', v_program.created_by,
      v_member_joinable, v_program.id, v_rec.rule_id,
      v_rec.occurrence_date, false
    )
    returning * into v_new_event;

    for v_court_rec in
      select court_id from public.program_rule_courts where program_schedule_rule_id = v_rec.rule_id
    loop
      insert into public.reservations (
        club_id, court_id, owner_user_id,
        starts_at, ends_at, status, reason, event_id, created_by
      ) values (
        v_club_id, v_court_rec.court_id, v_program.created_by,
        v_starts_at, v_ends_at, 'confirmed', 'event', v_new_event.id, v_program.created_by
      );
    end loop;

    -- Phase 33D2b: sources roster_member_id (NOT NULL — structurally
    -- guaranteed present for every 'enrolled' row) as the authoritative
    -- identity, resolving claimed_by fresh via join for the profile_id
    -- column. Safe exemption from the FOR-UPDATE-then-branch pattern is
    -- unchanged from the 0113 reasoning: this insert only ever targets an
    -- events row this same function just created in the same transaction,
    -- which cannot already have any event_participants row.
    --
    -- Phase 33G1C: ORDER BY pe.roster_member_id added — the only change
    -- in this function. Guarantees the event_participants BEFORE-row
    -- trigger fires, and therefore acquires its advisory lock, for these
    -- Members in the same fixed order on every run (see this migration's
    -- Section 7 header for the full deadlock-avoidance argument).
    if v_program.enrollment_model = 'program' then
      insert into public.event_participants (event_id, profile_id, roster_member_id, role, status)
      select v_new_event.id, rm.claimed_by, pe.roster_member_id, 'participant', 'confirmed'
      from public.program_enrollments pe
      join public.roster_members rm
        on rm.id = pe.roster_member_id
      where pe.program_id = v_program.id
        and pe.status     = 'enrolled'
      order by pe.roster_member_id
      on conflict (event_id, profile_id) do nothing;
    end if;

    v_inserted_ids   := v_inserted_ids || v_new_event.id;
    v_inserted_count := v_inserted_count + 1;
  end loop;

  if v_program.status = 'draft' then
    update public.programs set status = 'active', updated_at = now() where id = v_program.id;
  end if;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'generate_program_sessions', 'program', p_program_id,
    jsonb_build_object(
      'inserted_count',   v_inserted_count,
      'skipped_count',    v_total_count - v_new_count,
      'from',             v_from,
      'through',          v_through,
      'event_ids',        to_jsonb(v_inserted_ids),
      'program_owner_id', v_program.created_by,
      'generated_by_id',  auth.uid()
    )
  );

  return query select v_inserted_count, (v_total_count - v_new_count), v_inserted_ids;
end;
$$;

revoke execute on function public.generate_program_sessions(uuid, date, date) from public, anon;
grant  execute on function public.generate_program_sessions(uuid, date, date) to authenticated;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration created in
-- this checkpoint)
-- ═══════════════════════════════════════════════════════════════════════════
-- New objects — safe to drop in this order:
--   `drop trigger if exists reservations_member_schedule_guard on public.reservations;`
--   `drop trigger if exists event_participants_member_schedule_guard on public.event_participants;`
--   `drop trigger if exists events_member_schedule_guard on public.events;`
--   `drop trigger if exists lesson_requests_member_schedule_guard on public.lesson_requests;`
--   `drop function if exists public.enforce_reservation_member_schedule();`
--   `drop function if exists public.enforce_event_participant_member_schedule();`
--   `drop function if exists public.enforce_event_member_schedule();`
--   `drop function if exists public.enforce_lesson_request_member_schedule();`
--   `drop index if exists public.reservations_member_booking_confirmed_roster_idx;`
--   `drop index if exists public.lesson_requests_confirmed_roster_idx;`
--   `drop index if exists public.event_participants_confirmed_roster_idx;`
--   `drop function if exists public._assert_roster_member_schedule_available(uuid, timestamptz, timestamptz, uuid, uuid, uuid);`
-- Functions restored to their pre-0126 body from the cited source migration:
--   `_lesson_check_pro_availability`      -> supabase/migrations/0070_lesson_competitive_foundation.sql
--   `_lesson_check_member_availability`   -> supabase/migrations/0120_fix_lesson_edit_self_conflict.sql
--   `generate_program_sessions`           -> supabase/migrations/0115_program_enrollment_identity.sql
