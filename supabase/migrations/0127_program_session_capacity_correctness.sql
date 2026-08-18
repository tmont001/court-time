-- 0127_program_session_capacity_correctness.sql
-- Phase 33G1D: authoritative Program/generated-session capacity guards.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
-- 33G1D's audit found that generated-session capacity was computed but
-- never authoritatively enforced in several write paths — most severely,
-- _materialize_program_member_into_future_events and generate_program_
-- sessions' bulk materialization confirm whole-Program Members into
-- generated Events with zero capacity awareness at all, and admin_add_guest
-- computes occupancy but never blocks on it. The audit also found that
-- Program-level enrollment capacity is ALREADY race-safe today (every
-- program_enrollments writer locks the programs row FOR UPDATE before any
-- capacity-relevant read), and that Program capacity/rule definitions are
-- already structurally immutable once anything is generated (update_program
-- refuses to edit a program with any generated event) — so this migration
-- deliberately does NOT add new machinery at the Program-definition layer,
-- only at the generated-session (Event) layer, where the real gap is.
--
-- Same architecture as 0126 (Phase 33G1C): the rule lives at the CONFIRMED
-- DATA TRANSITION itself, as table guards, not scattered across RPCs. Three
-- new guards — event_participants (confirmed/offered), event_guests
-- (active), events (capacity reductions) — all delegating to one shared
-- occupancy primitive and one shared assertion, mirroring 0126's shared-
-- assertion-plus-triggers shape exactly.
--
-- LOCKED CAPACITY MODEL: an Event/session's capacity is consumed by
-- event_participants.status IN ('confirmed','offered') (role='participant')
-- and event_guests.status='active' — unchanged from every existing
-- capacity-counting query in this schema. For an enrollment_model='program'
-- generated Event specifically, it is ALSO consumed by any outstanding
-- program_enrollments.status='offered' row for that program which has not
-- yet been materialized into a confirmed event_participants row for this
-- session — an active whole-Program offer reserves its seat before it is
-- physically occupied. Waitlisted/cancelled/withdrawn/declined rows never
-- consume anything, in either domain. This is purely additive to existing
-- semantics — no prior "counts toward capacity" rule changes; only
-- "computed but unenforced" becomes "computed and enforced," and the one
-- previously-missing reservation term is added.
--
-- WHOLE-PROGRAM GUARANTEE, WITHOUT OVER-RESERVING: a confirmed whole-
-- Program enrollment (program_enrollments.status='enrolled') is already
-- physically represented as a confirmed event_participants row in every
-- session that existed at enrollment time (materialization is synchronous,
-- same transaction) — there is nothing further to reserve for it, and
-- nothing here double-counts it as both an enrollment AND a participant.
-- Only an outstanding OFFER (not yet enrolled, not yet materialized) needs
-- an explicit reservation term, and only until it is accepted, declined, or
-- expires. Capacity nobody has enrolled in at all is never reserved — staff
-- may freely use genuinely unsold capacity for session-specific Members or
-- Guests.
--
-- NEW WHOLE-PROGRAM ENROLLMENT FITS EVERY FUTURE SESSION, OR WAITLISTS:
-- join_program, add_program_roster_member, and _advance_program_waitlist_
-- offer now additionally check every already-generated FUTURE (scheduled,
-- non-archived, starts_at >= now()) session for room before enrolling/
-- offering a candidate — using the existing Program waitlist state
-- (program_enrollments.status='waitlisted') as the fallback, exactly as
-- before. No new state, no new waitlist system.
--
-- CAPACITY_OVERRIDE: create_program/update_program (0089/0090, unmodified
-- here) already reject any capacity_override at all for enrollment_model=
-- 'program' outright (capacity_override_not_allowed_for_program_
-- enrollment) — so a real program-model program's generated session
-- capacity is already always exactly programs.default_capacity today, by
-- construction, for every program created through the validated path.
-- generate_program_sessions gains one defensive, fail-closed check
-- (capacity_override_below_program_capacity) as a backstop against any
-- historical/edge-case inconsistency this migration does not assume away
-- — no existing rule/session definition is rewritten.
--
-- FORCE-CONFIRM PRESERVED: admin_force_confirm, admin_force_confirm_
-- roster_participant, and force_confirm_program_roster_member may still
-- intentionally exceed capacity — their one capacity-consuming write is
-- now wrapped in a transaction-local bypass (courttime.skip_capacity_guard,
-- set_config(..., true) => is_local, auto-reverts at COMMIT/ROLLBACK, set
-- immediately before and explicitly cleared immediately after the one
-- mutation) that affects ONLY the new capacity guards — 0126's Member
-- schedule-conflict guard is a completely separate mechanism or these
-- functions' own transactions and is never touched or disabled by this
-- flag. No other function sets this flag, so no normal Admin operation can
-- ever inherit a bypass it did not explicitly request.
--
-- RACE-SAFE WAITLIST FALLBACK: join_event, admin_add_roster_participant,
-- and advance_waitlist_offer each decide confirmed-vs-waitlisted (or
-- offer-vs-no-offer) from their own occupancy read, then perform the
-- write that the new table guard re-validates. Reviewed before finalizing
-- this migration and found insufficient: without also locking the Event
-- row at the point of THAT DECISION (not only later, incidentally, via
-- the guard), two concurrent callers racing for the last spot could both
-- read the same pre-write snapshot, both decide 'confirmed', and the
-- loser would hit the guard's hard event_capacity_exceeded rejection
-- instead of its own intended graceful waitlist fallback — capacity would
-- still never be exceeded, but the loser gets an unexpected error instead
-- of the existing, correct waitlist/no-offer outcome. Fixed by having all
-- three lock the Event row (FOR UPDATE) as part of their existing early
-- Event lookup — no new helper needed, this reuses each function's own
-- pre-existing SELECT. admin_add_guest is deliberately NOT changed this
-- way: it has no Guest waitlist by design, so a hard capacity error for
-- the losing concurrent Guest add is the correct outcome, not a bug.
--
-- NOT-A-NET-INCREASE TRANSITIONS: the event_participants and event_guests
-- capacity guards now skip the capacity check entirely when the row was
-- already 'confirmed'/'offered' (participants) or 'active' (guests) at
-- the SAME event_id immediately before the write, and remains so — a
-- same-event roster_member_id reassignment or status re-affirmation never
-- changes total occupancy at that Event, so it must never be rejected
-- merely because the Event is already at or over capacity from an earlier
-- intentional force-confirm. A row moving to a DIFFERENT event_id is
-- never treated as a no-op, even from an already-consuming status — that
-- is a genuine new consumption of the TARGET event's capacity and is
-- always fully checked. This narrows enforcement only to cases where a
-- check is actually meaningful; it never allows an overflow that would
-- not already have existed.
--
-- LOCK ORDER (verified against 0126's live trigger set, and against the
-- latest effective body of every writer named below, before writing this
-- migration — not assumed). Two distinct mechanisms establish "Event row
-- before Member advisory lock," and this comment states precisely which
-- one applies to which writer — it does not claim trigger-name ordering
-- alone is universally sufficient, since it is not: PostgreSQL fires
-- same-table same-event BEFORE ROW triggers in ALPHABETICAL ORDER BY
-- TRIGGER NAME, which only helps for a lock FIRST ACQUIRED BY A TRIGGER.
-- On an UPDATE, PostgreSQL has already selected/locked the target row
-- before any BEFORE ROW trigger on THAT table runs at all — trigger-name
-- ordering only ever governs the relative order between two triggers on
-- the SAME row being written, never between that row and a DIFFERENT
-- table's row (the Event) that the writing function did not itself lock
-- first.
--
-- Mechanism A — the writer locks the Event itself, explicitly, before its
-- own participant/guest mutation: join_event, admin_add_roster_participant,
-- advance_waitlist_offer, _leave_event_impl (shared by leave_event and
-- leave_event_v2), accept_waitlist_offer, decline_waitlist_offer,
-- admin_remove_roster_participant, admin_remove_guest,
-- admin_remove_participant, and update_event (already did this before
-- 33G1D, unmodified here) all acquire FOR UPDATE on the Event row as an
-- explicit early statement, before touching event_participants/
-- event_guests at all. For these, the Event lock is established directly
-- by the writer; event_participants_capacity_guard's later FOR UPDATE
-- request on that same row (fired by the writer's own subsequent INSERT/
-- UPDATE) is then a trivial self-compatible re-grant, and 0126's schedule
-- guard's still-later FOR SHARE request is likewise trivial — the order
-- Event row lock -> Member advisory lock holds because the writer put the
-- Event lock first, not because of trigger-name ordering.
--
-- Mechanism B — trigger-name ordering is what establishes the order: for
-- any writer that does NOT lock the Event itself first (admin_add_guest,
-- generate_program_sessions' bulk materialization,
-- _materialize_program_member_into_future_events, and the three force-
-- confirm functions), the FIRST lock this transaction takes on the Event
-- row is whichever trigger fires first on the write itself.
-- event_participants_capacity_guard/event_guests_capacity_guard are named
-- to sort alphabetically before event_participants_member_schedule_guard
-- (0126) — 'c' < 'm' — so the capacity guard's FOR UPDATE is acquired
-- before the schedule guard's later FOR SHARE request on the same row,
-- for these writers too. The events-table capacity-reduction guard needs
-- no lock of its own in either mechanism: a BEFORE UPDATE trigger's row
-- is already implicitly locked by the UPDATE statement itself before any
-- trigger for that statement runs, which is what already serializes it
-- against any concurrent capacity-consuming writer holding the explicit
-- FOR UPDATE from either mechanism above.
--
-- _program_candidate_fits_future_sessions locks every applicable future
-- Event row FOR UPDATE in one deterministic order (starts_at, id) before
-- checking any of them — always after the caller's own pre-existing
-- programs-row FOR UPDATE lock (join_program/add_program_roster_member/
-- _advance_program_waitlist_offer all already acquire it first, confirmed
-- against their live bodies), giving: Program row lock -> Event row
-- lock(s), deterministic order -> Member advisory lock (only reached
-- later, inside materialization, which re-acquires already-held locks as
-- a no-op). An Event belongs to at most one Program (events.program_id is
-- a single FK), so two different Programs' future-session sets are always
-- disjoint — no two concurrent whole-Program operations for different
-- Programs can ever contend for the same Event row through this helper
-- regardless of ordering, and same-Program concurrent calls are already
-- fully serialized by the shared programs-row lock before this helper is
-- ever reached.
--
-- SCOPE BOUNDARY: does not touch 0001-0126, Lesson UX, Phase 34 pricing/
-- payments, staff roles, or commercial entitlements. Not applied by this
-- checkpoint. Not committed.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. _event_effective_occupancy — pure read, no locking of its own (the
-- caller is responsible for locking the Event row before relying on this
-- for a capacity decision). Three self-exclusion parameters, used
-- independently depending on caller: p_exclude_event_participant_id and
-- p_exclude_event_guest_id let an UPDATE (a row transitioning INTO
-- confirmed/offered/active from something that already counted, e.g.
-- offered -> confirmed) exclude its own prior contribution before adding
-- itself back in; p_exclude_roster_member_id lets a check exclude a
-- specific roster Member's own outstanding Program-level offer reservation
-- (needed when checking whether THAT SAME Member's own transition fits).
-- The Program-offer term only ever contributes for an
-- enrollment_model='program' Event. A standalone (non-generated) Event has
-- events.program_id null, so the join can never match there — but a
-- per_session/admin_managed GENERATED Event still carries a real
-- program_id (generate_program_sessions sets it for every model, not only
-- 'program'). The term is still always exactly 0 for those, because
-- program_enrollments rows can only ever be created for an
-- enrollment_model='program' Program in the first place — join_program/
-- add_program_roster_member/force_confirm_program_roster_member all raise
-- program_not_whole_enrollment for any other model, so a per_session/
-- admin_managed Program can never have a matching program_enrollments row
-- to join against, regardless of program_id being set. No special-casing
-- required either way.
--
-- Phase 33G1D correction: declared VOLATILE, not STABLE. This function is
-- called from row-trigger enforcement during commands that can affect
-- multiple rows in one SQL statement (generate_program_sessions' bulk
-- materialization, _program_candidate_fits_future_sessions' multi-session
-- loop) — STABLE tells the planner "same result for the same arguments
-- for the whole statement," the wrong contract for a value that must
-- reflect writes made earlier in the SAME statement/transaction. VOLATILE
-- (the correct, conservative choice — also the default for a SQL function
-- when unspecified, written out explicitly here) guarantees a fresh
-- evaluation on every call, always seeing this transaction's own prior
-- writes.
--
-- Also corrected here: the Program-offer reservation term now (a) treats
-- an existing event_participants row as "already materialized" whenever
-- its status is 'confirmed' OR 'offered' — both already consume physical
-- capacity per the locked model, so either one must suppress the
-- Program-level reservation for that same roster Member at this Event,
-- not confirmed alone; and (b) only counts a Program offer as reserving
-- capacity while it is genuinely ACTIVE — status = 'offered' AND
-- offer_expires_at > now(), the exact predicate
-- _advance_program_waitlist_offer's own idempotency guard already uses as
-- this domain's definition of "active offer" (reused verbatim, not
-- reinvented) — an expired-but-not-yet-swept offer no longer reserves a
-- seat; and (c) only reserves a seat in an event that is itself scheduled,
-- non-archived, and starts_at >= now() — the exact same "applicable
-- future session" boundary _materialize_program_member_into_future_events
-- uses to decide which sessions to materialize into. A past, cancelled,
-- or archived session is never materialized into and must never be
-- treated as holding a reservation either.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public._event_effective_occupancy(
  p_event_id                     uuid,
  p_exclude_event_participant_id uuid default null,
  p_exclude_event_guest_id       uuid default null,
  p_exclude_roster_member_id     uuid default null
)
returns int
language sql
security definer
volatile
set search_path = public, pg_temp
as $$
  select
    (select count(*)
       from public.event_participants ep
      where ep.event_id = p_event_id
        and ep.status   in ('confirmed', 'offered')
        and ep.role     = 'participant'
        and (p_exclude_event_participant_id is null or ep.id is distinct from p_exclude_event_participant_id))
    +
    (select count(*)
       from public.event_guests eg
      where eg.event_id = p_event_id
        and eg.status   = 'active'
        and (p_exclude_event_guest_id is null or eg.id is distinct from p_exclude_event_guest_id))
    +
    (select count(*)
       from public.program_enrollments pe
       join public.events e on e.id = p_event_id
      where e.program_id        = pe.program_id
        -- Phase 33G1D correction: an active whole-Program offer reserves a
        -- seat only in an APPLICABLE FUTURE generated session — the exact
        -- same boundary _materialize_program_member_into_future_events
        -- itself uses. Without this, the reservation term could apply to
        -- a past, cancelled/non-scheduled, or archived session, which is
        -- never materialized into and should never be treated as holding
        -- a reservation.
        and e.status             = 'scheduled'
        and e.archived_at       is null
        and e.starts_at         >= now()
        and pe.status            = 'offered'
        and pe.offer_expires_at > now()
        and (p_exclude_roster_member_id is null or pe.roster_member_id is distinct from p_exclude_roster_member_id)
        and not exists (
          select 1 from public.event_participants ep2
           where ep2.event_id         = p_event_id
             and ep2.roster_member_id = pe.roster_member_id
             and ep2.status           in ('confirmed', 'offered')
        ));
$$;

revoke execute on function public._event_effective_occupancy(uuid, uuid, uuid, uuid)
  from public, anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. _assert_event_capacity_available — the shared authority the new table
-- guards call. Locks the Event FOR UPDATE first (true mutual exclusion,
-- stronger than 0126's FOR SHARE, which only needs to conflict with a
-- plain UPDATE, not with another FOR SHARE) — see this migration's header
-- for the complete lock-order argument. Checks the transaction-local
-- capacity bypass AFTER acquiring the lock (so lock ordering is identical
-- regardless of whether this specific call ends up enforcing anything) but
-- BEFORE computing occupancy (so a bypassed call pays no extra cost).
-- Fails closed on invalid input.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public._assert_event_capacity_available(
  p_event_id                     uuid,
  p_additional                   int default 1,
  p_exclude_event_participant_id uuid default null,
  p_exclude_event_guest_id       uuid default null,
  p_exclude_roster_member_id     uuid default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event     public.events%rowtype;
  v_occupancy int;
begin
  if p_event_id is null or p_additional is null or p_additional < 0 then
    raise exception 'invalid_capacity_check_target';
  end if;

  select * into v_event from public.events where id = p_event_id for update;
  if not found then
    raise exception 'event_not_found';
  end if;

  -- Explicit Admin override in effect for this one mutation — see this
  -- migration's header for the exact set/clear/scope discipline. Never
  -- affects 0126's Member schedule-conflict guard, which does not consult
  -- this setting at all.
  if coalesce(current_setting('courttime.skip_capacity_guard', true), 'false') = 'true' then
    return;
  end if;

  v_occupancy := public._event_effective_occupancy(
    p_event_id, p_exclude_event_participant_id, p_exclude_event_guest_id, p_exclude_roster_member_id
  );

  if v_occupancy + p_additional > v_event.capacity then
    raise exception 'event_capacity_exceeded';
  end if;
end;
$$;

revoke execute on function public._assert_event_capacity_available(uuid, int, uuid, uuid, uuid)
  from public, anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. _program_candidate_fits_future_sessions — used by join_program,
-- add_program_roster_member, and _advance_program_waitlist_offer to decide
-- whether a candidate can be safely enrolled/offered, or must fall back to
-- the existing Program waitlist. Returns a boolean rather than raising, so
-- callers can preserve their existing waitlist-fallback UX cleanly. Locks
-- every applicable already-generated FUTURE (scheduled, non-archived,
-- starts_at >= now()) session for this Program, in one deterministic order
-- (starts_at, id), before checking any of them — see this migration's
-- header for why this ordering closes the one theoretical deadlock class
-- and why it is provably unreachable in practice given the Program row
-- lock every caller already holds first. p_roster_member_id is passed as
-- the occupancy exclusion so a candidate who already holds their own
-- outstanding offer for one of these sessions is not double-counted
-- against themselves.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public._program_candidate_fits_future_sessions(
  p_program_id       uuid,
  p_roster_member_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session   record;
  v_occupancy int;
begin
  for v_session in
    select e.id, e.capacity
      from public.events e
     where e.program_id  = p_program_id
       and e.status       = 'scheduled'
       and e.archived_at is null
       and e.starts_at   >= now()
     order by e.starts_at, e.id
     for update
  loop
    v_occupancy := public._event_effective_occupancy(v_session.id, null, null, p_roster_member_id);
    if v_occupancy + 1 > v_session.capacity then
      return false;
    end if;
  end loop;

  return true;
end;
$$;

revoke execute on function public._program_candidate_fits_future_sessions(uuid, uuid)
  from public, anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. event_participants capacity guard. Named to sort alphabetically
-- BEFORE event_participants_member_schedule_guard (0126) — see this
-- migration's header for the full lock-order proof this depends on. Fires
-- on transition INTO 'confirmed' OR 'offered' (both consume capacity per
-- the locked model); a transition AWAY from either (leave/decline/cancel)
-- never matches this WHEN clause and is never blocked. Self-excludes its
-- own row (covers offered -> confirmed, which must never be treated as a
-- second, additional consumption of an already-reserved seat) and its own
-- roster Member's outstanding Program-offer reservation (same reason, for
-- the whole-Program accept/force-confirm path).
--
-- Phase 33G1D correction: a transition that does NOT increase this Event's
-- occupancy — the row was already 'confirmed' or 'offered' at this SAME
-- event_id, for this SAME roster_member_id, immediately before this write
-- (a pure status re-affirmation with nothing identity-relevant changed) —
-- skips the capacity check entirely rather than re-validating it. Without
-- this, a session already at or over capacity from a deliberate
-- admin_force_confirm could never again accept a harmless, non-occupancy-
-- increasing UPDATE against one of its own already-consuming rows.
--
-- Phase 33G1D correction: roster_member_id must ALSO be unchanged for this
-- to be a genuine no-op — same-event physical row count staying at 1 does
-- NOT mean effective occupancy is unchanged, because the Program-offer
-- reservation term is identity-sensitive. Example: this row currently
-- represents Member A, who also holds an active whole-Program offer for
-- this same session — that offer is currently suppressed (not counted as
-- a reservation) precisely because A is already physically represented
-- here. Reassigning this row from A to B removes that suppression: A's
-- offer becomes unmaterialized again and now reserves a seat, while B's
-- own offer (if any) becomes newly suppressed by this row instead — net
-- effective occupancy can genuinely change even though the physical row
-- count at this Event does not. So the fast path now requires
-- old.roster_member_id = new.roster_member_id in addition to the same
-- event_id and an already-consuming status. Any roster_member_id change
-- always falls through to the full check below — which already computes
-- the correct projection with no further logic needed: excluding this
-- row's own id from the physical count (so it is not double-counted with
-- itself) and excluding NEW.roster_member_id from the reservation count
-- (so the row's new occupant's own offer, if any, is not double-counted
-- against the same physical seat it is about to occupy) — while OLD's
-- roster_member_id is deliberately NOT excluded, so if OLD still holds an
-- active offer, it correctly reappears as a reservation once this row no
-- longer represents them. A row moving to a DIFFERENT event_id (even from
-- a consuming status) is likewise never treated as a no-op — that is a
-- genuine new consumption of the TARGET event's capacity.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.enforce_event_participant_capacity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_was_consuming boolean;
begin
  v_was_consuming := (
    tg_op = 'UPDATE'
    and old.event_id         = new.event_id
    and old.roster_member_id = new.roster_member_id
    and old.status           in ('confirmed', 'offered')
  );

  if v_was_consuming then
    return new;
  end if;

  perform public._assert_event_capacity_available(
    p_event_id                     => new.event_id,
    p_additional                   => 1,
    p_exclude_event_participant_id => new.id,
    p_exclude_roster_member_id     => new.roster_member_id
  );
  return new;
end;
$$;

drop trigger if exists event_participants_capacity_guard on public.event_participants;
create trigger event_participants_capacity_guard
  before insert or update of event_id, roster_member_id, status
  on public.event_participants
  for each row
  when (new.status in ('confirmed', 'offered'))
  execute function public.enforce_event_participant_capacity();


-- ═══════════════════════════════════════════════════════════════════════════
-- 5. event_guests capacity guard. admin_add_guest is deliberately NOT a
-- force-capacity operation (locked rule) — this guard is unconditional
-- (never bypassed) for any INSERT/UPDATE transitioning a Guest row to
-- 'active'. A transition away from 'active' (cancel) never matches the
-- WHEN clause.
--
-- Phase 33G1D correction: same "not a net increase" skip as the
-- event_participants guard above, for the same reason — a Guest row
-- already 'active' at the SAME event_id, remaining active, must never be
-- re-rejected merely because the Event is already at/over capacity from
-- an unrelated force-confirm.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.enforce_event_guest_capacity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_was_consuming boolean;
begin
  v_was_consuming := (
    tg_op = 'UPDATE'
    and old.event_id = new.event_id
    and old.status   = 'active'
  );

  if v_was_consuming then
    return new;
  end if;

  perform public._assert_event_capacity_available(
    p_event_id               => new.event_id,
    p_additional             => 1,
    p_exclude_event_guest_id => new.id
  );
  return new;
end;
$$;

drop trigger if exists event_guests_capacity_guard on public.event_guests;
create trigger event_guests_capacity_guard
  before insert or update of event_id, status
  on public.event_guests
  for each row
  when (new.status = 'active')
  execute function public.enforce_event_guest_capacity();


-- ═══════════════════════════════════════════════════════════════════════════
-- 6. events capacity-reduction guard. Fires only when `capacity` is part
-- of the UPDATE's SET list and the value actually changes. Needs no lock
-- of its own — the row being updated is already implicitly locked by this
-- same UPDATE statement before any of its triggers run, which is exactly
-- what already serializes it against a concurrent event_participants/
-- event_guests writer holding the explicit FOR UPDATE from Sections 4/5.
-- Never bypassed — lowering capacity below occupancy is blocked
-- unconditionally, matching the locked rule (Admin capacity edits are not
-- a capacity override in the way force-confirm is). Only ever blocks a
-- REDUCTION below current effective occupancy; an increase can never
-- fail this check.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.enforce_event_capacity_reduction()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_occupancy int;
begin
  v_occupancy := public._event_effective_occupancy(new.id);
  if new.capacity < v_occupancy then
    raise exception 'event_capacity_exceeded';
  end if;
  return new;
end;
$$;

drop trigger if exists events_capacity_reduction_guard on public.events;
create trigger events_capacity_reduction_guard
  before update of capacity
  on public.events
  for each row
  when (new.capacity is distinct from old.capacity)
  execute function public.enforce_event_capacity_reduction();


-- ═══════════════════════════════════════════════════════════════════════════
-- 7. admin_add_roster_participant — latest effective body:
-- 0117_durable_member_guest_lifecycle_and_attendance.sql:1886-1995,
-- reproduced verbatim below with exactly one change: the inline capacity
-- COUNT is replaced with a call to the shared _event_effective_occupancy,
-- so this function's own enrolled-vs-waitlisted decision can never
-- disagree with the new authoritative guard (in particular, so it
-- continues to gracefully waitlist rather than hard-error via the new
-- guard when an outstanding whole-Program offer reserves the session's
-- last seat — a real, reachable case for this function, unlike join_event,
-- which structurally can never target an enrollment_model='program' Event
-- at all via member_joinable=false — join_event needs the SAME early-lock
-- correction below, Section 7B, for a different reason: ordinary Events,
-- not just Program ones).
--
-- Phase 33G1D correction: the events lookup now locks the row (FOR
-- UPDATE) at the point this function first reads it — BEFORE computing
-- occupancy and deciding confirmed vs waitlisted, not only later when the
-- eventual INSERT/UPDATE re-triggers the capacity guard. Without this, two
-- concurrent callers for the last open spot could each read the same
-- pre-write occupancy snapshot, each decide 'confirmed', and only the
-- first to actually write would succeed — the second would hit the
-- table guard's hard event_capacity_exceeded rejection instead of this
-- function's own intended graceful waitlist fallback. Locking here first
-- means the second caller's occupancy read (and therefore its own
-- confirmed-vs-waitlisted decision) happens only after the first caller's
-- write has committed and released the lock, so it correctly waitlists
-- instead of erroring — the table guard's later re-check then always
-- passes trivially, since it re-acquires a lock this transaction already
-- holds and re-validates a decision already made under full serialization.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.admin_add_roster_participant(
  p_event_id          uuid,
  p_expected_club_id  uuid,
  p_roster_member_id  uuid
)
returns public.event_participants
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
  if v_role is null or v_role not in ('admin', 'pro') then raise exception 'admin_required'; end if;

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
           updated_at       = now()
     where id = v_existing.id
    returning * into v_result;
  else
    insert into public.event_participants (event_id, profile_id, roster_member_id, role, status)
    values (p_event_id, v_member_id, p_roster_member_id, 'participant', v_new_status)
    returning * into v_result;
  end if;

  if v_result.id is null then
    raise exception 'event_participant_write_failed';
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
$$;

revoke execute on function public.admin_add_roster_participant(uuid, uuid, uuid) from public, anon;
grant  execute on function public.admin_add_roster_participant(uuid, uuid, uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 7B. join_event — latest effective body: 0123_staff_managed_connected_
-- enforcement.sql:457-580 (content-identical to 0117's original, wrapped
-- with the 33F3B capability gate) — NOT modified by the original 0127
-- pass, added here to close the same race condition Section 7 closes for
-- admin_add_roster_participant. join_event can never target an
-- enrollment_model='program' Event (member_joinable=false blocks it
-- structurally), but the exact same "two concurrent callers for the last
-- ordinary spot" race applies to any Event it CAN reach — Locked Rule 2's
-- required outcome (capacity 8, occupancy 7, two concurrent joins =>
-- exactly one confirmed, the other waitlists, no error) needs the same
-- early Event row lock. Two changes from the live body: (1) the events
-- lookup gains FOR UPDATE, acquired before the occupancy decision, for the
-- identical reason given in Section 7's header; (2) the inline capacity
-- COUNT is replaced with a call to the shared _event_effective_occupancy
-- for consistency with every other capacity decision in this migration —
-- behaviorally a no-op here (the Program-offer reservation term is always
-- 0 for a join_event-reachable Event), but avoids a second, independent
-- copy of the same formula. No revoke/grant statements: join_event's live
-- definition has never had an explicit one in this schema's history
-- (confirmed via grep across every migration) — reproduced exactly as-is,
-- not changed here.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function join_event(p_event_id uuid)
returns event_participants
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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

  if v_profile.role = 'member' and not current_club_has_capability('member_self_service') then
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
         set status = 'waitlisted', profile_id = auth.uid(), roster_member_id = v_roster_member_id, updated_at = now()
       where id = v_existing.id
      returning * into v_result;
    else
      insert into event_participants (event_id, profile_id, roster_member_id, role, status)
      values (p_event_id, auth.uid(), v_roster_member_id, 'participant', 'waitlisted')
      returning * into v_result;
    end if;

    if v_result.id is null then
      raise exception 'event_participant_write_failed';
    end if;
  else
    if v_existing_found then
      update event_participants
         set status = 'confirmed', profile_id = auth.uid(), roster_member_id = v_roster_member_id, updated_at = now()
       where id = v_existing.id
      returning * into v_result;
    else
      insert into event_participants (event_id, profile_id, roster_member_id, role, status)
      values (p_event_id, auth.uid(), v_roster_member_id, 'participant', 'confirmed')
      returning * into v_result;
    end if;

    if v_result.id is null then
      raise exception 'event_participant_write_failed';
    end if;

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
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 8. advance_waitlist_offer (Events) — latest effective body:
-- 0117_durable_member_guest_lifecycle_and_attendance.sql:2482-2600,
-- reproduced below with two changes. First: the inline capacity COUNT is
-- replaced with a call to the shared _event_effective_occupancy, for the
-- same reason as Section 7 — a waitlisted Event participant on an
-- enrollment_model='program' session must not be offered a seat that an
-- outstanding whole-Program offer has already reserved. Second (Phase
-- 33G1D correction, same race as Section 7): the Event row is now locked
-- FOR UPDATE as the very FIRST statement — before the idempotency check,
-- not merely before the capacity count. A prior draft of this fix locked
-- only immediately before the capacity count, leaving the idempotency
-- check ("is there already a non-expired offered participant?") unlocked
-- and first — two concurrent callers could each read "no active offer"
-- before either committed, the first would promote a candidate and
-- commit, and the second — having already read its own (now stale)
-- "no active offer" answer and never re-checking it after finally
-- acquiring the lock — could promote a SECOND candidate, violating this
-- function's own documented invariant (at most one non-expired offered
-- participant at a time). Locking first means the ENTIRE decision
-- sequence — idempotency check, capacity check, candidate selection — is
-- evaluated only after the lock is held, so a second concurrent call
-- always blocks until the first's promotion (or no-op return) has fully
-- committed, then correctly re-reads the resulting state before making
-- its own decision.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.advance_waitlist_offer(
  p_event_id    uuid,
  p_club_id     uuid,
  p_event_title text,
  p_actor_id    uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_next_id               uuid;
  v_next_roster_member_id uuid;
  v_current_member_id     uuid;
  v_offer_window_hours    int;
  v_offer_expires_at      timestamptz;
  v_tz                    text;
  v_expires_label         text;
  v_slot_count            int;
  v_capacity              int;
  v_notification_id       uuid;
  v_no_result             jsonb := jsonb_build_object('offered_profile_id', null, 'notification_id', null);
begin
  -- Phase 33G1D: lock BEFORE any state read that determines whether a
  -- promotion is allowed — see this section's header for why the
  -- idempotency check must not run unlocked.
  select capacity into v_capacity from public.events where id = p_event_id for update;

  if exists (
    select 1 from public.event_participants
    where event_id        = p_event_id
      and status          = 'offered'
      and offer_expires_at > now()
  ) then
    return v_no_result;
  end if;

  v_slot_count := public._event_effective_occupancy(p_event_id);

  if v_slot_count >= coalesce(v_capacity, 0) then
    return v_no_result;
  end if;

  select id, roster_member_id into v_next_id, v_next_roster_member_id
    from public.event_participants
    where event_id = p_event_id
      and status   = 'waitlisted'
    order by created_at asc
    limit 1;

  if not found then
    return v_no_result;
  end if;

  select waitlist_offer_window_hours into v_offer_window_hours
    from public.club_settings
    where club_id = p_club_id;

  if not found then
    v_offer_window_hours := 2;
  end if;

  v_offer_expires_at := now() + (v_offer_window_hours || ' hours')::interval;

  select timezone into v_tz from public.clubs where id = p_club_id;

  v_expires_label := to_char(
    v_offer_expires_at at time zone coalesce(v_tz, 'UTC'),
    'Mon DD "at" HH12:MI AM'
  );

  update public.event_participants
    set status           = 'offered',
        offer_expires_at = v_offer_expires_at,
        updated_at       = now()
    where id = v_next_id;

  select claimed_by into v_current_member_id
    from public.roster_members
   where id = v_next_roster_member_id;

  if v_current_member_id is not null then
    insert into public.notifications (club_id, user_id, kind, body, metadata)
    values (
      p_club_id,
      v_current_member_id,
      'waitlist_offer',
      'A spot opened in "' || p_event_title || '"! Accept by ' || v_expires_label || '.',
      case when p_actor_id is null then
        jsonb_build_object(
          'event_id',         p_event_id,
          'offer_expires_at', v_offer_expires_at
        )
      else
        jsonb_build_object(
          'event_id',         p_event_id,
          'offer_expires_at', v_offer_expires_at,
          'triggered_by',     p_actor_id
        )
      end
    )
    returning id into v_notification_id;
  end if;

  return jsonb_build_object(
    'offered_profile_id', v_current_member_id,
    'notification_id',    v_notification_id
  );
end;
$$;

revoke execute on function public.advance_waitlist_offer(uuid, uuid, text, uuid) from public, anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 8B-8G. Exhaustive caller fix. A full-repo caller scan for advance_
-- waitlist_offer and expire_stale_offers_for_event (every `perform`/
-- `select` call site across all 127 prior migrations, traced forward to
-- each caller's own latest effective definition) found six functions that
-- mutate an event_participants or event_guests row THEMSELVES before
-- calling one of these two helpers, each with an early events lookup that
-- was never locked — the same "participant row mutated before the Event
-- is locked" inversion Section 8's fix alone does not close, since that
-- inversion happens inside THESE callers, not inside advance_waitlist_
-- offer itself. Every one of the six gets the identical minimal fix: FOR
-- UPDATE added to the existing early events lookup already present in
-- each function, so the Event lock is acquired before that function's own
-- participant/guest mutation — nothing else in any of the six changes.
-- None of these six ever had an explicit REVOKE/GRANT statement in this
-- schema's history (confirmed via grep across every migration, matching
-- join_event's identical situation) — reproduced with no grant statements
-- added, exactly matching their current live privilege state.
--
-- expire_stale_offers_for_event and _advance_program_waitlist_offer/etc.
-- themselves need no separate fix here: once every caller that mutates a
-- participant/guest row first locks the Event, that lock is already held
-- by the time expire_stale_offers_for_event's own internal loop (which
-- cancels OTHER stale-offered rows) or advance_waitlist_offer's own
-- promotion runs — both already operate under a lock their caller
-- established first.
-- ═══════════════════════════════════════════════════════════════════════════

-- 8B. _leave_event_impl — the single internal leave implementation shared
-- by leave_event and leave_event_v2 (thin wrappers, unmodified, not
-- redeclared here — fixing this implementation fixes both automatically).
-- Latest effective body: 0113_staff_managed_events_identity.sql:812-916.
-- FOR UPDATE added to the function's first events lookup (used for the
-- archived_at check), which already precedes the event_participants
-- cancel UPDATE in the existing code — only the lock itself is new.
create or replace function public._leave_event_impl(p_event_id uuid)
returns jsonb   -- { offered_profile_id: uuid | null, notification_id: uuid | null }
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile        public.profiles%rowtype;
  v_event          public.events%rowtype;
  v_old_status     text;
  v_participant_id uuid;
  v_roster_member_id uuid;
  v_expire_result  jsonb;
  v_advance_result jsonb;
  v_final_result   jsonb := jsonb_build_object('offered_profile_id', null, 'notification_id', null);
begin
  select * into v_profile from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  select * into v_event
    from public.events
    where id      = p_event_id
      and club_id = v_profile.club_id
    for update;
  if found and v_event.archived_at is not null then
    raise exception 'event_archived';
  end if;

  select id into v_roster_member_id
    from public.roster_members
   where club_id    = v_profile.club_id
     and claimed_by = auth.uid();

  select id, status into v_participant_id, v_old_status
    from public.event_participants
    where event_id = p_event_id
      and status    in ('confirmed', 'waitlisted', 'offered')
      and (
        profile_id = auth.uid()
        or (v_roster_member_id is not null and roster_member_id = v_roster_member_id)
      );
  if not found then raise exception 'not_joined'; end if;

  update public.event_participants
    set status           = 'cancelled',
        offer_expires_at = null,
        updated_at       = now()
    where id = v_participant_id;

  if v_old_status = 'confirmed' then
    select * into v_event
      from public.events
      where id      = p_event_id
        and club_id = v_profile.club_id
        and status  = 'scheduled';

    if found then
      select public.expire_stale_offers_for_event(p_event_id, v_profile.club_id, v_event.title, auth.uid())
        into v_expire_result;
      select public.advance_waitlist_offer(p_event_id, v_profile.club_id, v_event.title, auth.uid())
        into v_advance_result;

      v_final_result := case
        when (v_expire_result->>'offered_profile_id') is not null then v_expire_result
        else v_advance_result
      end;
    end if;

  elsif v_old_status = 'offered' then
    select * into v_event
      from public.events
      where id      = p_event_id
        and club_id = v_profile.club_id
        and status  = 'scheduled';

    if found then
      insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
      values (
        v_profile.club_id,
        auth.uid(),
        'leave_offered_spot',
        'event',
        p_event_id,
        jsonb_build_object('event_title', v_event.title)
      );

      select public.expire_stale_offers_for_event(p_event_id, v_profile.club_id, v_event.title, auth.uid())
        into v_expire_result;
      select public.advance_waitlist_offer(p_event_id, v_profile.club_id, v_event.title, auth.uid())
        into v_advance_result;

      v_final_result := case
        when (v_expire_result->>'offered_profile_id') is not null then v_expire_result
        else v_advance_result
      end;
    end if;

  else
    return v_final_result;
  end if;

  return v_final_result;
end;
$$;

revoke execute on function public._leave_event_impl(uuid) from public, anon, authenticated;


-- 8C. accept_waitlist_offer — latest effective body:
-- 0113_staff_managed_events_identity.sql:442-519. FOR UPDATE added to the
-- function's early events lookup, which already precedes the
-- event_participants confirm UPDATE.
create or replace function accept_waitlist_offer(p_event_id uuid)
returns event_participants
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile  profiles%rowtype;
  v_event    events%rowtype;
  v_my_row   event_participants%rowtype;
  v_result   event_participants%rowtype;
  v_roster_member_id uuid;
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
$$;


-- 8D. decline_waitlist_offer — latest effective body:
-- 0113_staff_managed_events_identity.sql:522-596. FOR UPDATE added to the
-- function's events lookup, which already precedes the event_participants
-- cancel UPDATE (the participant "find my row" lookup just above it is a
-- plain SELECT, not a mutation, so it does not need to move).
create or replace function decline_waitlist_offer(p_event_id uuid)
returns uuid   -- next offered profile_id, or null
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile    profiles%rowtype;
  v_event      events%rowtype;
  v_my_row     event_participants%rowtype;
  v_offered_id uuid;
  v_roster_member_id uuid;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

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

  select * into v_event
    from events
    where id      = p_event_id
      and club_id = v_profile.club_id
    for update;

  if found and v_event.archived_at is not null then
    raise exception 'event_archived';
  end if;

  update event_participants
    set status           = 'cancelled',
        offer_expires_at = null,
        updated_at       = now()
    where id = v_my_row.id;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'decline_waitlist_offer',
    'event',
    p_event_id,
    jsonb_build_object('event_title', coalesce(v_event.title, ''))
  );

  if found and v_event.status = 'scheduled' then
    perform expire_stale_offers_for_event(p_event_id, v_profile.club_id, v_event.title);
    perform advance_waitlist_offer(p_event_id, v_profile.club_id, v_event.title);
  end if;

  select profile_id into v_offered_id
    from event_participants
    where event_id        = p_event_id
      and status          = 'offered'
      and offer_expires_at > now()
    order by updated_at desc
    limit 1;

  return v_offered_id;
end;
$$;


-- 8E. admin_remove_roster_participant — latest effective body:
-- 0113_staff_managed_events_identity.sql:1043-1112. FOR UPDATE added to
-- the function's early events lookup, which already precedes the
-- event_participants cancel UPDATE.
create or replace function public.admin_remove_roster_participant(
  p_event_id          uuid,
  p_expected_club_id  uuid,
  p_roster_member_id  uuid
)
returns public.event_participants
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id      uuid;
  v_role         text;
  v_event        public.events%rowtype;
  v_participant_id uuid;
  v_old_status   text;
  v_result       public.event_participants%rowtype;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
  if v_role is null or v_role not in ('admin', 'pro') then raise exception 'admin_required'; end if;

  select * into v_event
    from public.events
   where id      = p_event_id
     and club_id = v_club_id
   for update;
  if not found then raise exception 'event_not_found'; end if;
  if v_event.status <> 'scheduled' then raise exception 'event_cancelled'; end if;
  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

  select id, status into v_participant_id, v_old_status
    from public.event_participants
   where event_id         = p_event_id
     and roster_member_id = p_roster_member_id
     and status            in ('confirmed', 'waitlisted', 'offered');
  if not found then raise exception 'participant_not_found'; end if;

  update public.event_participants
     set status           = 'cancelled',
         offer_expires_at = null,
         updated_at       = now()
   where id = v_participant_id
  returning * into v_result;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'admin_remove_roster_participant', 'event', p_event_id,
    jsonb_build_object(
      'roster_member_id', p_roster_member_id,
      'previous_status',  v_old_status
    )
  );

  if v_old_status in ('confirmed', 'offered') then
    perform public.expire_stale_offers_for_event(p_event_id, v_club_id, v_event.title, auth.uid());
    perform public.advance_waitlist_offer(p_event_id, v_club_id, v_event.title, auth.uid());
  end if;

  return v_result;
end;
$$;

revoke execute on function public.admin_remove_roster_participant(uuid, uuid, uuid) from public, anon;
grant  execute on function public.admin_remove_roster_participant(uuid, uuid, uuid) to authenticated;


-- 8F. admin_remove_guest — latest effective body:
-- 0117_durable_member_guest_lifecycle_and_attendance.sql:1275-1359. FOR
-- UPDATE added to the function's early events lookup, which already
-- precedes the event_guests cancel UPDATE.
create or replace function admin_remove_guest(
  p_event_id uuid,
  p_guest_id  uuid
)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_actor        profiles%rowtype;
  v_event        events%rowtype;
  v_guest        event_guests%rowtype;
  v_occupied     int;
  v_rows_updated int;
begin
  select * into v_actor from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_actor.role not in ('admin', 'pro') then
    raise exception 'admin_required';
  end if;

  select * into v_event
    from events
    where id      = p_event_id
      and club_id = v_actor.club_id
    for update;
  if not found then raise exception 'event_not_found'; end if;
  if v_event.status <> 'scheduled' then raise exception 'event_cancelled'; end if;
  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

  select * into v_guest
    from event_guests
    where id       = p_guest_id
      and event_id = p_event_id
      and status   = 'active';
  if not found then raise exception 'guest_not_found'; end if;

  update event_guests
     set status       = 'cancelled',
         cancelled_at = now(),
         cancelled_by = auth.uid()
   where id       = p_guest_id
     and status   = 'active';

  get diagnostics v_rows_updated = row_count;
  if v_rows_updated = 0 then raise exception 'guest_not_found'; end if;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_actor.club_id,
    auth.uid(),
    'admin_remove_guest',
    'event',
    p_event_id,
    jsonb_build_object(
      'event_title', v_event.title,
      'guest_id',    p_guest_id,
      'guest_name',  v_guest.display_name
    )
  );

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

  if v_occupied < v_event.capacity then
    perform expire_stale_offers_for_event(p_event_id, v_actor.club_id, v_event.title);
    perform advance_waitlist_offer(p_event_id, v_actor.club_id, v_event.title);
  end if;
end;
$$;


-- 8G. admin_remove_participant — legacy profile_id-keyed equivalent of
-- admin_remove_roster_participant, kept live for deployed compatibility.
-- Latest effective body: 0061_archive_roster_guard.sql:113-176. FOR
-- UPDATE added to the function's early events lookup, which already
-- precedes the event_participants cancel UPDATE.
create or replace function admin_remove_participant(
  p_event_id   uuid,
  p_profile_id uuid
)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_actor      profiles%rowtype;
  v_event      events%rowtype;
  v_old_status text;
begin
  select * into v_actor from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_actor.role not in ('admin', 'pro') then
    raise exception 'admin_required';
  end if;

  select * into v_event
    from events
    where id      = p_event_id
      and club_id = v_actor.club_id
    for update;
  if not found then raise exception 'event_not_found'; end if;
  if v_event.status <> 'scheduled' then raise exception 'event_cancelled'; end if;
  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

  select status into v_old_status
    from event_participants
    where event_id   = p_event_id
      and profile_id = p_profile_id
      and status     in ('confirmed', 'offered', 'waitlisted');
  if not found then raise exception 'participant_not_found'; end if;

  update event_participants
    set status           = 'cancelled',
        offer_expires_at = null,
        updated_at       = now()
    where event_id   = p_event_id
      and profile_id = p_profile_id;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_actor.club_id,
    auth.uid(),
    'admin_remove_participant',
    'event',
    p_event_id,
    jsonb_build_object(
      'event_title',        v_event.title,
      'removed_profile_id', p_profile_id,
      'previous_status',    v_old_status
    )
  );

  if v_old_status in ('confirmed', 'offered') then
    perform expire_stale_offers_for_event(p_event_id, v_actor.club_id, v_event.title);
    perform advance_waitlist_offer(p_event_id, v_actor.club_id, v_event.title);
  end if;
end;
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 9. join_program — latest effective body: 0123_staff_managed_connected_
-- enforcement.sql:584-718 (content-identical to 0115's original, wrapped
-- with the 33F3B capability gate). Reproduced verbatim below with exactly
-- one change: the enrolled-vs-waitlisted decision gains an additional
-- elsif branch calling _program_candidate_fits_future_sessions — if the
-- candidate fits the abstract Program-level count but NOT one or more
-- already-generated future sessions, they fall back to the existing
-- Program waitlist exactly as if Program-level capacity itself were full.
-- No new state.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.join_program(p_program_id uuid)
returns public.program_enrollments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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

  if v_role = 'member' and not public.current_club_has_capability('member_self_service') then
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
           updated_at = now()
     where id = v_existing.id
    returning * into v_result;
  else
    insert into public.program_enrollments (program_id, profile_id, roster_member_id, status, waitlisted_at)
    values (p_program_id, auth.uid(), v_roster_member_id, v_new_status,
      case when v_new_status = 'waitlisted' then now() else null end)
    returning * into v_result;
  end if;

  if v_result.id is null then raise exception 'program_enrollment_write_failed'; end if;

  if v_new_status = 'enrolled' then
    perform public._materialize_program_member_into_future_events(p_program_id, v_roster_member_id, v_club_id);
  end if;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (v_club_id, auth.uid(), 'join_program', 'program', p_program_id,
    jsonb_build_object('status', v_result.status, 'actor_role', v_role));

  return v_result;
end;
$$;

revoke execute on function public.join_program(uuid) from public, anon;
grant  execute on function public.join_program(uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 10. add_program_roster_member — latest effective body:
-- 0115_program_enrollment_identity.sql:1063-1195. Reproduced verbatim
-- below with the identical single addition as join_program (Section 9):
-- an elsif branch calling _program_candidate_fits_future_sessions before
-- deciding 'enrolled'.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.add_program_roster_member(
  p_program_id       uuid,
  p_expected_club_id uuid,
  p_roster_member_id uuid
)
returns public.program_enrollments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
  if v_role not in ('admin', 'pro') then raise exception 'insufficient_role'; end if;

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
             updated_at       = now()
       where id = v_existing.id
      returning * into v_result;
    else
      insert into public.program_enrollments (program_id, profile_id, roster_member_id, status, waitlisted_at)
      values (
        p_program_id, v_roster.claimed_by, p_roster_member_id, v_new_status,
        case when v_new_status = 'waitlisted' then now() else null end
      )
      returning * into v_result;
    end if;

    if v_result.id is null then
      raise exception 'program_enrollment_write_failed';
    end if;
  end if;

  if v_result.status = 'enrolled' then
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
$$;

revoke execute on function public.add_program_roster_member(uuid, uuid, uuid) from public, anon;
grant  execute on function public.add_program_roster_member(uuid, uuid, uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 11. _advance_program_waitlist_offer — latest effective body:
-- 0116_program_waitlist_lifecycle_correctness.sql:100-220. Reproduced
-- verbatim below with one addition: after identifying the next waitlisted
-- candidate (FIFO), a future-session fit check runs before promoting them
-- to 'offered' — if any applicable future session has no room, promotion
-- is skipped (return null, the exact same "nothing to offer right now"
-- outcome this function already returns for every other not-yet-ready
-- case), leaving the candidate 'waitlisted'. No new state. Locking every
-- caller of this function already acquires (programs FOR UPDATE, per this
-- function's own pre-existing header comment) makes this addition safe
-- without any further change here.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public._advance_program_waitlist_offer(
  p_program_id    uuid,
  p_club_id       uuid,
  p_program_title text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_next_id               uuid;
  v_next_roster_member_id uuid;
  v_current_member_id     uuid;
  v_offer_window_hours    int;
  v_offer_expires_at      timestamptz;
  v_slot_count            int;
  v_capacity              int;
  v_rows_updated          int;
  v_tz                    text;
  v_expires_label         text;
  v_notification_id       uuid;
begin
  if exists (
    select 1 from public.program_enrollments
    where program_id = p_program_id and status = 'offered' and offer_expires_at > now()
  ) then
    return null;
  end if;

  select count(*) into v_slot_count
    from public.program_enrollments
    where program_id = p_program_id and status in ('enrolled', 'offered');

  select default_capacity into v_capacity from public.programs where id = p_program_id;

  if v_slot_count >= coalesce(v_capacity, 0) then
    return null;
  end if;

  select id, roster_member_id into v_next_id, v_next_roster_member_id
    from public.program_enrollments
    where program_id = p_program_id and status = 'waitlisted'
    order by waitlisted_at asc, id asc
    limit 1;

  if not found then
    return null;
  end if;

  -- Phase 33G1D: the candidate fits the abstract Program-level count above
  -- but must also fit every applicable already-generated future session
  -- before an offer is created for them — an offer reserves a real seat
  -- (locked rule 4), so it must never be created for a seat that does not
  -- exist. Leaves the candidate 'waitlisted' (return null, same as every
  -- other not-yet-ready outcome above) rather than raising.
  if not public._program_candidate_fits_future_sessions(p_program_id, v_next_roster_member_id) then
    return null;
  end if;

  select waitlist_offer_window_hours into v_offer_window_hours
    from public.club_settings
    where club_id = p_club_id;

  if not found then
    v_offer_window_hours := 2;
  end if;

  v_offer_expires_at := now() + (v_offer_window_hours || ' hours')::interval;

  update public.program_enrollments
    set status           = 'offered',
        offer_expires_at = v_offer_expires_at,
        waitlisted_at    = null,
        updated_at       = now()
    where id = v_next_id;

  get diagnostics v_rows_updated = row_count;
  if v_rows_updated = 0 then
    raise exception 'program_enrollment_write_failed';
  end if;

  select claimed_by into v_current_member_id
    from public.roster_members
   where id = v_next_roster_member_id;

  if v_current_member_id is not null then
    select timezone into v_tz from public.clubs where id = p_club_id;
    v_expires_label := to_char(
      v_offer_expires_at at time zone coalesce(v_tz, 'UTC'),
      'Mon DD "at" HH12:MI AM'
    );

    insert into public.notifications (club_id, user_id, kind, body, metadata)
    values (
      p_club_id,
      v_current_member_id,
      'waitlist_offer',
      'A spot opened in "' || p_program_title || '"! Accept by ' || v_expires_label || '.',
      jsonb_build_object(
        'program_id',        p_program_id,
        'offer_expires_at',  v_offer_expires_at,
        'triggered_by',      auth.uid()
      )
    )
    returning id into v_notification_id;
  end if;

  return v_current_member_id;
end;
$$;

revoke execute on function public._advance_program_waitlist_offer(uuid, uuid, text) from public, anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 12. admin_force_confirm — latest effective body:
-- 0117_durable_member_guest_lifecycle_and_attendance.sql:2231-2339.
-- Reproduced verbatim below with exactly one addition: the transaction-
-- local capacity bypass is set immediately before, and explicitly cleared
-- immediately after, the one event_participants UPDATE that this function
-- may intentionally push over capacity. 0126's Member schedule-conflict
-- guard is never touched by this flag and remains fully enforced on this
-- same write.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.admin_force_confirm(
  p_event_id   uuid,
  p_profile_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor            public.profiles%rowtype;
  v_event            public.events%rowtype;
  v_old_status       text;
  v_occupied         int;
  v_was_over_cap     boolean;
  v_result           public.event_participants%rowtype;
  v_notification_id  uuid;
begin
  select * into v_actor from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_actor.role not in ('admin', 'pro') then
    raise exception 'admin_required';
  end if;

  select * into v_event
    from public.events
    where id      = p_event_id
      and club_id = v_actor.club_id;
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

  select status into v_old_status
    from public.event_participants
    where event_id   = p_event_id
      and profile_id = p_profile_id;
  if not found then raise exception 'participant_not_found'; end if;
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
    set status           = 'confirmed',
        offer_expires_at = null,
        updated_at       = now()
    where event_id   = p_event_id
      and profile_id = p_profile_id
    returning * into v_result;

  perform set_config('courttime.skip_capacity_guard', 'false', true);

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
$$;

revoke execute on function public.admin_force_confirm(uuid, uuid) from public, anon;
grant  execute on function public.admin_force_confirm(uuid, uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 13. admin_force_confirm_roster_participant — latest effective body:
-- 0117_durable_member_guest_lifecycle_and_attendance.sql:1998-2097. Same
-- single addition as Section 12.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.admin_force_confirm_roster_participant(
  p_event_id          uuid,
  p_expected_club_id  uuid,
  p_roster_member_id  uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id          uuid;
  v_role             text;
  v_event            public.events%rowtype;
  v_roster           public.roster_members%rowtype;
  v_current_member_id uuid;
  v_participant_id   uuid;
  v_old_status       text;
  v_occupied         int;
  v_was_over_cap     boolean;
  v_result           public.event_participants%rowtype;
  v_notification_id  uuid;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
  if v_role is null or v_role not in ('admin', 'pro') then raise exception 'admin_required'; end if;

  select * into v_event
    from public.events
   where id      = p_event_id
     and club_id = v_club_id;
  if not found then raise exception 'event_not_found'; end if;
  if v_event.status <> 'scheduled' then raise exception 'event_cancelled'; end if;
  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

  select * into v_roster
    from public.roster_members
   where id      = p_roster_member_id
     and club_id = v_club_id;
  if not found then raise exception 'roster_member_not_found'; end if;
  v_current_member_id := v_roster.claimed_by;

  select id, status into v_participant_id, v_old_status
    from public.event_participants
   where event_id         = p_event_id
     and roster_member_id = p_roster_member_id;
  if not found then raise exception 'participant_not_found'; end if;
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
     set status           = 'confirmed',
         offer_expires_at = null,
         updated_at       = now()
   where id = v_participant_id
  returning * into v_result;

  perform set_config('courttime.skip_capacity_guard', 'false', true);

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
$$;

revoke execute on function public.admin_force_confirm_roster_participant(uuid, uuid, uuid) from public, anon;
grant  execute on function public.admin_force_confirm_roster_participant(uuid, uuid, uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 14. force_confirm_program_roster_member — latest effective body:
-- 0115_program_enrollment_identity.sql:1298-1379. The bypass here wraps
-- both the enrollment UPDATE and the materializer call that follows it —
-- the enrollment UPDATE itself touches an unguarded table
-- (program_enrollments), but the materializer's own event_participants
-- writes are exactly what needs the bypass, so the flag is set before
-- entering this whole sequence and cleared right after, matching "set
-- immediately around the forced capacity mutation."
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.force_confirm_program_roster_member(
  p_program_id       uuid,
  p_expected_club_id uuid,
  p_roster_member_id uuid
)
returns public.program_enrollments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id      uuid;
  v_role         text;
  v_program      public.programs%rowtype;
  v_old          public.program_enrollments%rowtype;
  v_result       public.program_enrollments%rowtype;
  v_occupied     int;
  v_was_over_cap boolean;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;
  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
  if v_role not in ('admin', 'pro') then raise exception 'insufficient_role'; end if;

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

  perform public._materialize_program_member_into_future_events(p_program_id, p_roster_member_id, v_club_id);

  perform set_config('courttime.skip_capacity_guard', 'false', true);

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (v_club_id, auth.uid(), 'force_confirm_program_roster_member', 'program', p_program_id,
    jsonb_build_object('roster_member_id', p_roster_member_id, 'previous_status', v_old.status,
      'was_over_capacity', v_was_over_cap));

  return v_result;
end;
$$;

revoke execute on function public.force_confirm_program_roster_member(uuid, uuid, uuid) from public, anon;
grant  execute on function public.force_confirm_program_roster_member(uuid, uuid, uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 15. generate_program_sessions — latest effective body: 0126 Section 7
-- (itself a verbatim reproduction of 0115's body plus 0126's own
-- roster_member_id ORDER BY addition). Reproduced below with exactly one
-- further addition: a fail-closed check that a generated session's
-- effective capacity is never lower than the Program's own default_
-- capacity for enrollment_model='program'. create_program/update_program
-- already reject any capacity_override for this enrollment_model outright
-- (capacity_override_not_allowed_for_program_enrollment) — this is a
-- defensive backstop against any historical/edge-case inconsistency this
-- migration does not otherwise assume away, not a fix for an otherwise-
-- reachable path through the validated creation/update RPCs.
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

    if v_program.enrollment_model = 'program' and v_capacity < v_program.default_capacity then
      raise exception 'capacity_override_below_program_capacity';
    end if;

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
--   `drop trigger if exists event_participants_capacity_guard on public.event_participants;`
--   `drop trigger if exists event_guests_capacity_guard on public.event_guests;`
--   `drop trigger if exists events_capacity_reduction_guard on public.events;`
--   `drop function if exists public.enforce_event_participant_capacity();`
--   `drop function if exists public.enforce_event_guest_capacity();`
--   `drop function if exists public.enforce_event_capacity_reduction();`
--   `drop function if exists public._program_candidate_fits_future_sessions(uuid, uuid);`
--   `drop function if exists public._assert_event_capacity_available(uuid, int, uuid, uuid, uuid);`
--   `drop function if exists public._event_effective_occupancy(uuid, uuid, uuid, uuid);`
-- Functions restored to their pre-0127 body from the cited source migration:
--   `admin_add_roster_participant`             -> supabase/migrations/0117_durable_member_guest_lifecycle_and_attendance.sql
--   `join_event`                                -> supabase/migrations/0123_staff_managed_connected_enforcement.sql
--   `advance_waitlist_offer`                    -> supabase/migrations/0117_durable_member_guest_lifecycle_and_attendance.sql
--   `_leave_event_impl`                          -> supabase/migrations/0113_staff_managed_events_identity.sql
--   `accept_waitlist_offer`                      -> supabase/migrations/0113_staff_managed_events_identity.sql
--   `decline_waitlist_offer`                     -> supabase/migrations/0113_staff_managed_events_identity.sql
--   `admin_remove_roster_participant`            -> supabase/migrations/0113_staff_managed_events_identity.sql
--   `admin_remove_guest`                         -> supabase/migrations/0117_durable_member_guest_lifecycle_and_attendance.sql
--   `admin_remove_participant`                   -> supabase/migrations/0061_archive_roster_guard.sql
--   `join_program`                              -> supabase/migrations/0123_staff_managed_connected_enforcement.sql
--   `add_program_roster_member`                 -> supabase/migrations/0115_program_enrollment_identity.sql
--   `_advance_program_waitlist_offer`            -> supabase/migrations/0116_program_waitlist_lifecycle_correctness.sql
--   `admin_force_confirm`                        -> supabase/migrations/0117_durable_member_guest_lifecycle_and_attendance.sql
--   `admin_force_confirm_roster_participant`     -> supabase/migrations/0117_durable_member_guest_lifecycle_and_attendance.sql
--   `force_confirm_program_roster_member`        -> supabase/migrations/0115_program_enrollment_identity.sql
--   `generate_program_sessions`                  -> supabase/migrations/0126_member_schedule_guards.sql
