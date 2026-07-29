-- 0091_whole_program_enrollment.sql
-- Phase 27D1: Whole-Program Enrollment Backend.
--
-- Adds the complete backend state machine for enrollment_model='program'
-- (whole-program) enrollment: four new public RPCs (join_program,
-- leave_program, accept_program_waitlist_offer,
-- decline_program_waitlist_offer), five new private helpers, one new
-- program_enrollments column, a direct-write correction on
-- event_participants, and a CREATE OR REPLACE of generate_program_sessions
-- (0089, already applied and immutable) that adds participant
-- materialization without changing its public signature, return shape, or
-- any other 0089 behavior. 0091 has not been applied yet, so every change
-- below lives in this one file — there is no separate "correction"
-- migration.
--
-- Locked architecture (Phase 27, not repeated here beyond this pointer):
-- generated occurrences are events rows; enrollment_model='program' has no
-- parallel session/roster/attendance table — it uses event_participants
-- exclusively, exactly like every other event signup in this schema. This
-- migration creates no new participant, session, waitlist, roster,
-- attendance, reservation, or notification table.
--
-- No member enrollment/admin roster UI is added — this is backend only, as
-- scoped. No notification is inserted by any function in this file
-- (deferred, matching every other explicit non-goal in this checkpoint).
--
-- ─────────────────────────────────────────────────────────────────────────
-- Program lifecycle matrix — join/leave/accept/decline by program state.
-- "Enrollable" = status='active' and archived_at is null and
-- ends_on >= today in the program's club timezone (see
-- _program_is_enrollable). draft is never enrollable regardless of dates —
-- a draft program has never been generated, by definition (0089:
-- generate_program_sessions is the only path from draft to active).
--
--   program state                 join_program           leave_program   accept_offer            decline_offer
--   ────────────────────────────  ─────────────────────  ──────────────  ──────────────────────  ──────────────
--   draft                         program_not_enrollable  cleanup only*   program_not_enrollable   cleanup only*
--   active, within window         normal join flow        normal          normal                   normal
--   active, ends_on has passed    program_not_enrollable  cleanup only    program_not_enrollable   cleanup only
--   cancelled / completed         program_not_enrollable  cleanup only    program_not_enrollable   cleanup only
--   archived_at is not null       program_not_enrollable  cleanup only    program_not_enrollable   cleanup only
--
--   * draft programs can never actually have an enrollment row to clean up
--     in practice (join_program has always rejected draft, in this version
--     and the prior one), but leave_program/decline_program_waitlist_offer
--     place no lifecycle gate on top of their normal row-state checks, so
--     the behavior is stated here for completeness rather than special-
--     cased in the function bodies.
--
-- leave_program and decline_program_waitlist_offer never gate on program
-- enrollability — a member must always be able to back out, matching
-- leave_event/decline_waitlist_offer, neither of which has an analogous
-- "is the event still joinable" check either. join_program and
-- accept_program_waitlist_offer both gate on it: join because a non-
-- enrollable program should never accept a first-time join, and accept
-- because the program could have stopped being enrollable in the window
-- between an offer being made and the member accepting it (no automatic
-- status transition happens at ends_on, so this is a real, reachable
-- window, not a hypothetical). Both use the single stable error code
-- program_not_enrollable — see the "smallest safe change" note below on
-- error-code proliferation.
--
-- ─────────────────────────────────────────────────────────────────────────
-- Design mirrors the existing event waitlist/offer machinery (0048/0049)
-- as closely as the schema allows, function-for-function:
--
--   event system                          program system (this file)
--   ───────────────────────────────────    ───────────────────────────────
--   event_participants.status              program_enrollments.status
--     confirmed/waitlisted/offered/          enrolled/waitlisted/offered/
--     cancelled                              cancelled (0087's existing
--                                             CHECK constraint vocabulary —
--                                             unchanged by this migration)
--   advance_waitlist_offer                 _advance_program_waitlist_offer
--   expire_stale_offers_for_event          _expire_stale_program_offers
--   join_event                             join_program
--   leave_event                            leave_program
--   accept_waitlist_offer                  accept_program_waitlist_offer
--   decline_waitlist_offer                 decline_program_waitlist_offer
--   events.capacity                        programs.default_capacity
--   club_settings.waitlist_offer_window_   same column, same 2-hour
--     hours (source of offer duration)       fallback-if-missing default
--
-- Deliberate departures from the event system, each justified below:
--
--   1. Concurrency: FOR UPDATE row lock on the target `programs` row.
--      event_participants' capacity safety relies on nothing explicit
--      beyond short transactions — there is no DB-level capacity
--      constraint for events either, so this is not a gap introduced here,
--      it is a pre-existing property of the event system this migration
--      does not attempt to fix. This checkpoint's own instructions
--      explicitly require "two simultaneous joins must never overfill the
--      program" and "two simultaneous promotions must never offer the
--      same released spot twice" — program_enrollments has no exclusion
--      constraint analogous to reservations' GiST exclude to lean on for
--      this, so an explicit lock is the correct mechanism. Every one of
--      the four public RPCs below acquires
--      `select ... from programs where id = p_program_id for update`
--      as its very first program lookup (combining the existence/club-
--      scope check with lock acquisition in one statement), and holds it
--      for the rest of the call. generate_program_sessions now acquires
--      the identical lock at the identical point (its own first program
--      lookup) — this was missing from the first draft of this migration:
--      generation could previously commit concurrently with a join/leave/
--      accept/decline call against the same program, which could leave a
--      just-generated event missing a materialized row for a member who
--      joined mid-generation, or materialize a member into a new event
--      after they had already left. With both sides taking the same lock
--      as their first statement, the two calls now fully serialize against
--      each other: whichever commits first is fully visible to the other,
--      so generation always sees the final enrolled/not-enrolled state of
--      any join/leave that raced it, and a join/leave always sees every
--      event that a generation call has already committed. The five
--      private helpers (_expire_stale_program_offers,
--      _advance_program_waitlist_offer,
--      _materialize_program_member_into_future_events,
--      _cancel_program_member_future_participation,
--      _program_is_enrollable) all assume this lock is already held by
--      their caller — they never acquire it themselves — so every
--      mutation to program_enrollments or program-derived
--      event_participants rows for a given program is fully serialized
--      against every other concurrent call touching that same program.
--      Different programs are never blocked against each other, since the
--      lock is per programs row, not table-wide.
--
--   2. No per-session capacity gate on materialized rows: a whole-program
--      enrollee's seat is a standing program-level reservation, not a
--      per-event join competing against that event's own capacity — this
--      was locked in the Phase 27 architecture discussion before any
--      RPC in this feature was written. _materialize_program_member_into_
--      future_events and generate_program_sessions' own new
--      materialization step both insert directly at status='confirmed',
--      bypassing events.capacity entirely, exactly as designed.
--
--   3. No notification insert anywhere in this file — explicitly out of
--      scope for this checkpoint (see header non-goals). advance_waitlist_
--      offer's event equivalent inserts a 'waitlist_offer' notification;
--      _advance_program_waitlist_offer deliberately does not.
--
--   4. FIFO position is tracked on a dedicated program_enrollments.
--      waitlisted_at column, not on created_at (the event system's own
--      advance_waitlist_offer orders by event_participants.created_at,
--      which works there only because event_participants rows are never
--      reused across a cancel/rejoin cycle in a way that matters — a
--      member who leaves and rejoins an event gets a fresh created_at only
--      if a new row is inserted, and re-ordering that member fairly behind
--      the existing queue was never a stated requirement for events). For
--      programs it is a stated requirement here: a cancelled member who
--      rejoins the waitlist must go to the back of the current queue, and
--      program_enrollments' upsert-by-unique-(program_id, profile_id)
--      shape means the SAME row is reused across every join/leave/rejoin
--      cycle — its created_at is fixed at first-ever-join and never
--      reflects a later rejoin. Reusing created_at as the rejoin's queue
--      position would silently and incorrectly preserve the member's
--      original queue position from years earlier. waitlisted_at is set to
--      now() every time a row (re-)enters 'waitlisted' — on a brand new
--      join, and on every rejoin from 'cancelled' — and cleared back to
--      null on every transition away from 'waitlisted', mirroring exactly
--      how offer_expires_at is only ever non-null while status='offered'
--      (same CHECK-constraint pattern, applied to the new column).
--      _advance_program_waitlist_offer's FIFO promotion query now orders
--      by waitlisted_at asc (with id asc as a deterministic tiebreaker),
--      not created_at.
--
--   5. join_program additionally refuses to enroll a brand-new caller
--      directly whenever ANY member is currently waitlisted for the
--      program, even if the raw enrolled+offered count is under
--      default_capacity. This is necessary because
--      _advance_program_waitlist_offer's idempotency guard (see that
--      function's own header comment) only ever offers one open spot at a
--      time — if a live offer
--      is already outstanding for the front of the queue and the program's
--      capacity is greater than 1, a second spot can be genuinely free by
--      raw count while a waitlisted member is still waiting on their own
--      offer to resolve. Without this check, a brand-new caller could take
--      that second spot directly, bypassing the waitlisted member entirely.
--      The check is a single `exists` against program_enrollments; it does
--      not change the one-live-offer-at-a-time policy itself.
--
-- Error-code note: the requested vocabulary in this checkpoint's brief
-- includes not_waitlisted and capacity_unavailable. Neither is reachable
-- by the final design and neither was forced in artificially:
-- join_program never rejects for capacity — mirroring join_event exactly,
-- it always succeeds as either 'enrolled' or 'waitlisted', so
-- capacity_unavailable has no call site. accept_program_waitlist_offer/
-- decline_program_waitlist_offer both look up the caller's row filtered to
-- status='offered' directly (mirroring accept_waitlist_offer/
-- decline_waitlist_offer exactly) and raise offer_not_found/offer_expired
-- for every other case, including a merely-waitlisted caller — inventing a
-- separate not_waitlisted code for that one sub-case would only fragment
-- an already-precise error without a corresponding distinct code on the
-- event side to mirror. Both omissions are deliberate, not oversights.
--
-- program_not_enrollable now also covers the lifecycle contract (see the
-- matrix above): draft, cancelled, completed, archived, and past-ends_on
-- programs all raise this same single code from both join_program and
-- accept_program_waitlist_offer, rather than a distinct code per reason —
-- the caller-facing distinction ("why can't I join") is a UI-layer concern
-- for a later phase, not a backend contract this checkpoint needs to
-- expose, and a single code keeps the error surface the smallest it can be
-- while still being fully accurate.
--
-- See supabase/scripts/verify_phase27d1.sql for the full read-only
-- verification pass, and supabase/scripts/QA_phase27d1.md for manual QA
-- steps.
--
-- Apply in Supabase SQL Editor (cloud only). Not applied by this checkpoint.

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- RLS / grants note
-- ═══════════════════════════════════════════════════════════════════════════
-- program_enrollments' existing SELECT policy (0087,
-- "program_enrollments_select") already correctly scopes visibility to:
-- the caller's own row, any admin in the program's club, or a pro who
-- created the program — and already uses current_user_club_id()/
-- current_user_role() exclusively. It requires no change for the RPCs in
-- this file: every one of them is SECURITY DEFINER and reads/writes
-- program_enrollments and event_participants as its owner, which bypasses
-- RLS entirely for its own internal operations, exactly like every
-- existing Phase 19B admin participant RPC and every Phase 27B/C RPC
-- already does. No table-level GRANT change is made to program_enrollments
-- — it remains exactly as hardened in 0087 (authenticated SELECT only,
-- writes RPC-only). The new waitlisted_at column added below (see SCHEMA
-- CHANGES) is covered by that same existing table-level grant; no
-- additional grant statement is needed for it.
--
-- event_participants DOES get a table-level grant correction in this
-- migration (see SCHEMA CHANGES below) — this was not made in the first
-- draft and is being added now. 0004 created two RLS policies,
-- "event_participants_insert_own" and "event_participants_cancel_own",
-- that predate the RPC-owned join/leave/waitlist flow introduced in 0049;
-- no table-level REVOKE was ever applied for event_participants the way
-- 0087 applied one for program_enrollments, so those two policies are
-- currently the only thing standing between an authenticated client and a
-- direct write — Supabase's default authenticated grants are still present
-- underneath them. Before revoking, every event_participants write path in
-- this codebase was inspected directly: src/app/(app)/events,
-- src/app/(app)/calendar, src/app/(app)/admin/events, and every existing
-- RPC (join_event, leave_event, accept_waitlist_offer,
-- decline_waitlist_offer, cancel_event, admin_add_member,
-- admin_remove_participant, mark_attendance, and the whole-program RPCs in
-- this file) already write exclusively through RPCs. No
-- `.from("event_participants")` call anywhere in src/ performs `.insert(`,
-- `.update(`, or `.delete(` — every non-RPC call site found is a read
-- (`.select(...)`). It is therefore safe to revoke the underlying grants
-- and drop the two now-dead policies; SELECT remains available via the
-- existing "event_participants_select_same_club" policy (0004, untouched).

-- ═══════════════════════════════════════════════════════════════════════════
-- SCHEMA CHANGES
-- ═══════════════════════════════════════════════════════════════════════════

-- program_enrollments.waitlisted_at — dedicated FIFO queue-position
-- timestamp (see migration header, "Deliberate departures" item 4). Only
-- ever non-null while status='waitlisted'; set to now() on every (re-)entry
-- into that status and cleared on every transition away from it, mirroring
-- the existing offer_expires_at/status='offered' CHECK pattern from 0087.
alter table public.program_enrollments
  add column waitlisted_at timestamptz;

alter table public.program_enrollments
  add constraint program_enrollments_waitlisted_at_check
  check (
    (status = 'waitlisted' and waitlisted_at is not null)
    or (status <> 'waitlisted' and waitlisted_at is null)
  );

-- event_participants direct-write correction (see migration header,
-- RLS / grants note, for the call-site audit that justifies this).
revoke all on public.event_participants from public, anon, authenticated;
grant select on public.event_participants to authenticated;

drop policy if exists "event_participants_insert_own" on public.event_participants;
drop policy if exists "event_participants_cancel_own" on public.event_participants;
-- event_participants_select_same_club (0004) is untouched — SELECT remains
-- available; all writes are now RPC-only, matching program_enrollments.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. _expire_stale_program_offers — private helper
-- ═══════════════════════════════════════════════════════════════════════════
-- Mirrors expire_stale_offers_for_event (0049) exactly, at the program
-- level. Precondition: caller already holds the FOR UPDATE lock on the
-- target programs row (see migration header, concurrency note). Not
-- callable directly by any client role.

create or replace function public._expire_stale_program_offers(
  p_program_id    uuid,
  p_club_id       uuid,
  p_program_title text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row           record;
  v_expired_count int := 0;
begin
  for v_row in
    select profile_id
      from public.program_enrollments
      where program_id        = p_program_id
        and status            = 'offered'
        and offer_expires_at  < now()
  loop
    update public.program_enrollments
      set status           = 'cancelled',
          offer_expires_at = null,
          updated_at       = now()
      where program_id = p_program_id
        and profile_id = v_row.profile_id;

    insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
    values (
      p_club_id,
      auth.uid(),
      'program_waitlist_offer_expired',
      'program',
      p_program_id,
      jsonb_build_object('profile_id', v_row.profile_id, 'program_title', p_program_title)
    );

    v_expired_count := v_expired_count + 1;
  end loop;

  if v_expired_count > 0 then
    perform public._advance_program_waitlist_offer(p_program_id, p_club_id, p_program_title);
  end if;
end;
$$;

revoke execute on function public._expire_stale_program_offers(uuid, uuid, text) from public, anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. _advance_program_waitlist_offer — private helper
-- ═══════════════════════════════════════════════════════════════════════════
-- Mirrors advance_waitlist_offer (0049) at the program level: same
-- idempotency guard (a non-expired existing offer means no-op — this one-
-- live-offer-at-a-time policy is confirmed as the genuine existing event
-- contract by direct inspection of 0049 and is preserved here unchanged),
-- same capacity check (enrolled + offered against programs.
-- default_capacity), same offer-window source (club_settings.
-- waitlist_offer_window_hours, same 2-hour fallback if the settings row is
-- missing). Deliberately does not insert a notification (see migration
-- header). Precondition: caller already holds the FOR UPDATE lock on the
-- target programs row.
--
-- FIFO ordering deliberately diverges from advance_waitlist_offer's own
-- `order by created_at asc`: this orders by waitlisted_at asc (with id asc
-- as a deterministic tiebreaker) instead, and the promoted row's
-- waitlisted_at is cleared back to null as part of the same UPDATE that
-- sets status='offered' — see migration header, "Deliberate departures"
-- item 4, for why created_at cannot be reused for this.

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
  v_next_profile        uuid;
  v_offer_window_hours   int;
  v_offer_expires_at     timestamptz;
  v_slot_count           int;
  v_capacity             int;
begin
  -- Idempotency guard: if a non-expired offered row already exists, do nothing.
  if exists (
    select 1 from public.program_enrollments
    where program_id       = p_program_id
      and status           = 'offered'
      and offer_expires_at > now()
  ) then
    return null;
  end if;

  -- Capacity guard: only offer if there is actually a free slot. Offered
  -- rows count the same as enrolled against capacity.
  select count(*) into v_slot_count
    from public.program_enrollments
    where program_id = p_program_id
      and status     in ('enrolled', 'offered');

  select default_capacity into v_capacity from public.programs where id = p_program_id;

  if v_slot_count >= coalesce(v_capacity, 0) then
    return null;
  end if;

  -- Find the oldest waitlisted enrollment (FIFO order by waitlisted_at,
  -- the queue-position timestamp — not created_at; see migration header).
  select profile_id into v_next_profile
    from public.program_enrollments
    where program_id = p_program_id
      and status     = 'waitlisted'
    order by waitlisted_at asc, id asc
    limit 1;

  if not found then
    return null;
  end if;

  select waitlist_offer_window_hours into v_offer_window_hours
    from public.club_settings
    where club_id = p_club_id;

  -- Defensive fallback: default 2 hours if settings row is missing.
  if not found then
    v_offer_window_hours := 2;
  end if;

  v_offer_expires_at := now() + (v_offer_window_hours || ' hours')::interval;

  update public.program_enrollments
    set status           = 'offered',
        offer_expires_at = v_offer_expires_at,
        waitlisted_at    = null,
        updated_at       = now()
    where program_id = p_program_id
      and profile_id = v_next_profile;

  -- No notification — deferred (see migration header).

  return v_next_profile;
end;
$$;

revoke execute on function public._advance_program_waitlist_offer(uuid, uuid, text) from public, anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. _materialize_program_member_into_future_events — private helper
-- ═══════════════════════════════════════════════════════════════════════════
-- Inserts (or re-confirms) an event_participants row, role='participant'
-- status='confirmed' — the identical shape a normal confirmed event signup
-- uses — for one profile into every applicable future generated event
-- under this program: status='scheduled', not archived, starts_at >= now()
-- (matching join_event's own past-event boundary exactly — see 0059).
-- Bypasses each event's own capacity gate by design (see migration
-- header). The ON CONFLICT branch only touches rows not already
-- 'confirmed' — re-materializing an already-confirmed row is a no-op, and
-- attendance_status is never touched by either branch, so historical
-- attendance data already recorded on a row can never be clobbered here.

create or replace function public._materialize_program_member_into_future_events(
  p_program_id uuid,
  p_profile_id uuid,
  p_club_id    uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.event_participants (event_id, profile_id, role, status)
  select e.id, p_profile_id, 'participant', 'confirmed'
  from public.events e
  where e.program_id  = p_program_id
    and e.club_id      = p_club_id
    and e.status        = 'scheduled'
    and e.archived_at  is null
    and e.starts_at    >= now()
  on conflict (event_id, profile_id)
    do update set status = 'confirmed', updated_at = now()
    where event_participants.status <> 'confirmed';
end;
$$;

revoke execute on function public._materialize_program_member_into_future_events(uuid, uuid, uuid) from public, anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. _cancel_program_member_future_participation — private helper
-- ═══════════════════════════════════════════════════════════════════════════
-- The inverse of the helper above: cancels a departing member's
-- event_participants rows for future, non-archived, scheduled events under
-- this program only. Never touches a past event (starts_at < now()) or an
-- already-cancelled row, so historical attendance/no-show data is always
-- preserved. Only ever targets status='confirmed' rows — the only status a
-- program-materialized row can hold, since member_joinable=false on every
-- generated event under a whole-program program blocks the ordinary
-- join_event self-service path entirely (0062).

create or replace function public._cancel_program_member_future_participation(
  p_program_id uuid,
  p_profile_id uuid,
  p_club_id    uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.event_participants ep
    set status           = 'cancelled',
        offer_expires_at = null,
        updated_at       = now()
  from public.events e
  where ep.event_id   = e.id
    and e.program_id   = p_program_id
    and e.club_id       = p_club_id
    and e.status         = 'scheduled'
    and e.archived_at   is null
    and e.starts_at     >= now()
    and ep.profile_id   = p_profile_id
    and ep.status        = 'confirmed';
end;
$$;

revoke execute on function public._cancel_program_member_future_participation(uuid, uuid, uuid) from public, anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 5. _program_is_enrollable — private helper
-- ═══════════════════════════════════════════════════════════════════════════
-- Implements the program lifecycle contract from the migration header's
-- lifecycle matrix: a program is enrollable only while status='active',
-- not archived, and its window hasn't ended (ends_on has not passed in the
-- program's own club's local calendar date — the same club-timezone
-- convention generate_program_sessions already uses for computing
-- occurrence timestamps, applied here at day granularity). draft,
-- cancelled, completed, and archived programs are never enrollable
-- regardless of dates. Takes the already-fetched programs row (every
-- caller has already done `select ... for update` on it) rather than
-- re-querying — one extra query (club timezone) is the only DB round trip
-- this adds. Precondition: caller already holds the FOR UPDATE lock on the
-- target programs row (harmless even though this function itself only
-- reads — it never writes, so it needs no lock of its own).

create or replace function public._program_is_enrollable(p_program public.programs)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tz text;
begin
  if p_program.archived_at is not null then
    return false;
  end if;

  if p_program.status <> 'active' then
    return false;
  end if;

  select timezone into v_tz from public.clubs where id = p_program.club_id;

  return p_program.ends_on >= (now() at time zone coalesce(v_tz, 'UTC'))::date;
end;
$$;

revoke execute on function public._program_is_enrollable(public.programs) from public, anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 6. join_program
-- ═══════════════════════════════════════════════════════════════════════════
-- Mirrors join_event (0049/0059) at the program level. Any authenticated
-- member of the program's active club may call this — no admin/pro role
-- gate, matching "a member enrolling in a whole program" framing.
--
-- Lifecycle gate: rejects draft, cancelled, completed, archived, and past-
-- ends_on programs via _program_is_enrollable (see migration header,
-- lifecycle matrix).
--
-- Queue-bypass guard: a brand-new caller is never enrolled directly while
-- anyone is currently waitlisted, even if the raw capacity count looks
-- open (see migration header, "Deliberate departures" item 5).
--
-- Error codes: not_authenticated, program_not_found,
-- program_not_whole_enrollment, program_not_enrollable, already_enrolled.

create or replace function public.join_program(p_program_id uuid)
returns public.program_enrollments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id  uuid;
  v_role     text;
  v_program  public.programs%rowtype;
  v_existing public.program_enrollments%rowtype;
  v_count    int;
  v_result   public.program_enrollments%rowtype;
begin
  -- Membership-native auth capture — one statement, one snapshot.
  -- current_user_club_id() is NULL for any caller without a valid active
  -- club membership, which is exactly "the caller has an active
  -- membership in that club" — no separate check is needed.
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;
  if v_club_id is null then raise exception 'not_authenticated'; end if;

  -- Lock acquisition combined with the existence/club-scope check — every
  -- subsequent read/write in this call happens while holding this lock,
  -- serializing all concurrent join/leave/accept/decline calls against
  -- this specific program (see migration header, concurrency note).
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

  -- Idempotent fast path for an already-enrolled member — no state
  -- change, no audit entry, matches join_event's own re-materialization-
  -- is-a-no-op spirit for a caller who is already exactly where they
  -- asked to be.
  select * into v_existing
    from public.program_enrollments
    where program_id = p_program_id and profile_id = auth.uid();
  if found and v_existing.status = 'enrolled' then
    return v_existing;
  end if;

  perform public._expire_stale_program_offers(p_program_id, v_club_id, v_program.title);
  perform public._advance_program_waitlist_offer(p_program_id, v_club_id, v_program.title);

  -- Re-read after expiry/promotion may have changed this caller's own row
  -- (e.g. their own stale offer was just expired-and-cancelled above).
  select * into v_existing
    from public.program_enrollments
    where program_id = p_program_id and profile_id = auth.uid();

  -- Waitlisted or (still) offered: re-joining while already in the queue
  -- is rejected, exactly like join_event's already_joined guard.
  if found and v_existing.status in ('waitlisted', 'offered') then
    raise exception 'already_enrolled';
  end if;

  select count(*) into v_count
    from public.program_enrollments
    where program_id = p_program_id
      and status     in ('enrolled', 'offered');

  -- Queue-bypass guard: even if raw capacity looks open, a brand-new
  -- caller must never enroll ahead of anyone already waitlisted (see
  -- migration header, "Deliberate departures" item 5).
  if v_count >= v_program.default_capacity or exists (
    select 1 from public.program_enrollments
    where program_id = p_program_id and status = 'waitlisted'
  ) then
    insert into public.program_enrollments (program_id, profile_id, status, waitlisted_at)
    values (p_program_id, auth.uid(), 'waitlisted', now())
    on conflict (program_id, profile_id)
      do update set status = 'waitlisted', offer_expires_at = null, waitlisted_at = now(), updated_at = now()
    returning * into v_result;
  else
    insert into public.program_enrollments (program_id, profile_id, status)
    values (p_program_id, auth.uid(), 'enrolled')
    on conflict (program_id, profile_id)
      do update set status = 'enrolled', offer_expires_at = null, waitlisted_at = null, updated_at = now()
    returning * into v_result;

    perform public._materialize_program_member_into_future_events(p_program_id, auth.uid(), v_club_id);
  end if;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'join_program', 'program', p_program_id,
    jsonb_build_object('status', v_result.status, 'actor_role', v_role)
  );

  return v_result;
end;
$$;

revoke execute on function public.join_program(uuid) from public, anon;
grant  execute on function public.join_program(uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 7. leave_program
-- ═══════════════════════════════════════════════════════════════════════════
-- Mirrors leave_event (0049) at the program level: enrolled/waitlisted/
-- offered all become cancelled; leaving a confirmed-equivalent (enrolled)
-- or offered spot frees capacity and triggers expire+advance, matching
-- leave_event's own confirmed/offered branches exactly. A departing
-- enrolled member's FUTURE materialized event_participants rows are
-- cancelled; past attendance is never touched (see
-- _cancel_program_member_future_participation).
--
-- No lifecycle gate: leave_program is always available as a cleanup
-- operation regardless of program state (see migration header, lifecycle
-- matrix) — a member must always be able to back out, matching
-- leave_event, which has no analogous "still joinable" check either.
--
-- Error codes: not_authenticated, program_not_found,
-- program_not_whole_enrollment, enrollment_not_found.

create or replace function public.leave_program(p_program_id uuid)
returns public.program_enrollments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
  v_role    text;
  v_program public.programs%rowtype;
  v_old     public.program_enrollments%rowtype;
  v_result  public.program_enrollments%rowtype;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;
  if v_club_id is null then raise exception 'not_authenticated'; end if;

  select * into v_program
    from public.programs
    where id = p_program_id and club_id = v_club_id
    for update;
  if not found then raise exception 'program_not_found'; end if;

  if v_program.enrollment_model <> 'program' then
    raise exception 'program_not_whole_enrollment';
  end if;

  select * into v_old
    from public.program_enrollments
    where program_id = p_program_id
      and profile_id = auth.uid()
      and status     in ('enrolled', 'waitlisted', 'offered');
  if not found then raise exception 'enrollment_not_found'; end if;

  update public.program_enrollments
    set status           = 'cancelled',
        offer_expires_at = null,
        waitlisted_at    = null,
        updated_at       = now()
    where program_id = p_program_id and profile_id = auth.uid()
  returning * into v_result;

  if v_old.status in ('enrolled', 'offered') then
    -- A held-or-reserved spot was freed. Cancel this member's own future
    -- materialized rows first (an 'enrolled' departure only — an
    -- 'offered' member was never materialized, so this is a no-op for
    -- that branch, matching decline's own "do not materialize" rule).
    if v_old.status = 'enrolled' then
      perform public._cancel_program_member_future_participation(p_program_id, auth.uid(), v_club_id);
    else
      insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
      values (
        v_club_id, auth.uid(), 'leave_program_offered_spot', 'program', p_program_id,
        jsonb_build_object('program_title', v_program.title)
      );
    end if;

    perform public._expire_stale_program_offers(p_program_id, v_club_id, v_program.title);
    perform public._advance_program_waitlist_offer(p_program_id, v_club_id, v_program.title);
  end if;
  -- v_old.status = 'waitlisted': no capacity was freed, no promotion needed.

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'leave_program', 'program', p_program_id,
    jsonb_build_object('previous_status', v_old.status, 'actor_role', v_role)
  );

  return v_result;
end;
$$;

revoke execute on function public.leave_program(uuid) from public, anon;
grant  execute on function public.leave_program(uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 8. accept_program_waitlist_offer
-- ═══════════════════════════════════════════════════════════════════════════
-- Mirrors accept_waitlist_offer (0049). Materializes the accepting
-- member into every applicable future generated event.
--
-- Lifecycle re-check: a program can stop being enrollable in the window
-- between an offer being made and the member accepting it (no automatic
-- status transition happens at ends_on), so this re-checks
-- _program_is_enrollable before honoring the accept — see migration
-- header, lifecycle matrix.
--
-- Error codes: not_authenticated, program_not_found,
-- program_not_whole_enrollment, program_not_enrollable, offer_not_found,
-- offer_expired.

create or replace function public.accept_program_waitlist_offer(p_program_id uuid)
returns public.program_enrollments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
  v_role    text;
  v_program public.programs%rowtype;
  v_my_row  public.program_enrollments%rowtype;
  v_result  public.program_enrollments%rowtype;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;
  if v_club_id is null then raise exception 'not_authenticated'; end if;

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

  -- Check the caller's offered row before running expiry, so we can
  -- distinguish offer_not_found from offer_expired with a precise error —
  -- identical structure to accept_waitlist_offer (0049).
  select * into v_my_row
    from public.program_enrollments
    where program_id = p_program_id
      and profile_id = auth.uid()
      and status     = 'offered';
  if not found then raise exception 'offer_not_found'; end if;

  if v_my_row.offer_expires_at <= now() then raise exception 'offer_expired'; end if;

  update public.program_enrollments
    set status           = 'enrolled',
        offer_expires_at = null,
        updated_at       = now()
    where program_id = p_program_id and profile_id = auth.uid()
  returning * into v_result;

  perform public._materialize_program_member_into_future_events(p_program_id, auth.uid(), v_club_id);

  -- Defensive cleanup, mirroring accept_waitlist_offer: the capacity check
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
$$;

revoke execute on function public.accept_program_waitlist_offer(uuid) from public, anon;
grant  execute on function public.accept_program_waitlist_offer(uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 9. decline_program_waitlist_offer
-- ═══════════════════════════════════════════════════════════════════════════
-- Mirrors decline_waitlist_offer (0049) exactly. The declining member was
-- never materialized (only 'enrolled' members are), so there is nothing to
-- un-materialize here.
--
-- No lifecycle gate: like leave_program, decline is always available as a
-- cleanup operation regardless of program state (see migration header,
-- lifecycle matrix).
--
-- Error codes: not_authenticated, program_not_found,
-- program_not_whole_enrollment, offer_not_found.

create or replace function public.decline_program_waitlist_offer(p_program_id uuid)
returns public.program_enrollments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
  v_role    text;
  v_program public.programs%rowtype;
  v_my_row  public.program_enrollments%rowtype;
  v_result  public.program_enrollments%rowtype;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;
  if v_club_id is null then raise exception 'not_authenticated'; end if;

  select * into v_program
    from public.programs
    where id = p_program_id and club_id = v_club_id
    for update;
  if not found then raise exception 'program_not_found'; end if;

  if v_program.enrollment_model <> 'program' then
    raise exception 'program_not_whole_enrollment';
  end if;

  -- Declining an already-expired offer is valid cleanup, matching
  -- decline_waitlist_offer — the status filter alone (not offer_expires_at)
  -- gates eligibility here.
  select * into v_my_row
    from public.program_enrollments
    where program_id = p_program_id
      and profile_id = auth.uid()
      and status     = 'offered';
  if not found then raise exception 'offer_not_found'; end if;

  update public.program_enrollments
    set status           = 'cancelled',
        offer_expires_at = null,
        waitlisted_at    = null,
        updated_at       = now()
    where program_id = p_program_id and profile_id = auth.uid()
  returning * into v_result;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'decline_program_waitlist_offer', 'program', p_program_id,
    jsonb_build_object('program_title', v_program.title, 'actor_role', v_role)
  );

  perform public._expire_stale_program_offers(p_program_id, v_club_id, v_program.title);
  perform public._advance_program_waitlist_offer(p_program_id, v_club_id, v_program.title);

  return v_result;
end;
$$;

revoke execute on function public.decline_program_waitlist_offer(uuid) from public, anon;
grant  execute on function public.decline_program_waitlist_offer(uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 10. generate_program_sessions — CREATE OR REPLACE, materialization added
-- ═══════════════════════════════════════════════════════════════════════════
-- Byte-for-byte identical to 0089's body except for one addition, clearly
-- marked below: immediately after each new event's reservations are
-- inserted, every currently-'enrolled' program_enrollments member for this
-- program is materialized into that event via a single set-based INSERT —
-- offered and waitlisted members are never materialized. This keeps
-- generation and materialization inside the exact same per-event
-- transaction scope as the rest of this function, so the whole call
-- remains atomic exactly as before: any later failure still rolls back
-- every events/reservations/event_participants row this call has inserted
-- so far. member_joinable's existing formula
-- (`v_program.enrollment_model = 'per_session'`) already evaluates to
-- false for 'program' — identical to 'admin_managed' — so no change was
-- needed there; it already satisfied "generated events must have
-- member_joinable = false" for whole-program enrollment before this
-- migration existed.
--
-- Every other piece of 0089 behavior is unchanged: ownership stamping
-- (events.created_by/reservations.owner_user_id/created_by =
-- v_program.created_by, audit_log.actor_id = auth.uid()), the pro
-- ownership check (v_role = 'pro' and v_program.created_by <> auth.uid()
-- -> insufficient_role), _validate_program_definition call, batch self-
-- conflict check, pre-existing-reservation conflict check, the
-- pg27b2_candidates temp table (including its defensive DROP IF EXISTS and
-- ON COMMIT DROP), idempotent skip of already-generated slots, the
-- 200-occurrence ceiling, inserted/skipped-count arithmetic, the
-- draft->active status transition, audit metadata shape, and both grant
-- statements.
--
-- Locking correction: the program's initial lookup now takes
-- `for update`, exactly like the four enrollment RPCs' own first program
-- lookup (see migration header, concurrency note, "Deliberate departures"
-- item 1). This was missing from the first draft of this migration. The
-- lock is held for the entire function body, including every insert in the
-- generation loop and the new per-event materialization step below — so a
-- concurrent join_program/leave_program/accept_program_waitlist_offer/
-- decline_program_waitlist_offer call against the same program either
-- completes entirely before generation starts, or waits until generation
-- (and its commit) has entirely finished. Either ordering is correct: see
-- the per-branch reasoning in the materialization step comment below.
-- Different programs are never blocked against each other, since the lock
-- is per programs row.
--
-- Error codes: unchanged from 0089 — not_authenticated, insufficient_role,
-- program_not_found, event_type_not_found, rule_requires_court,
-- court_not_found, program_archived, program_not_generatable,
-- invalid_date_range, range_too_long, too_many_occurrences, court_conflict.

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

  -- Locking correction: `for update` serializes this call against
  -- join_program/leave_program/accept_program_waitlist_offer/
  -- decline_program_waitlist_offer for the same program (see migration
  -- header, locking correction note, and concurrency note).
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

  -- Revalidate the program's definition on every call — see
  -- _validate_program_definition and the 0089 migration header for why.
  perform public._validate_program_definition(p_program_id, v_club_id, v_program.event_type_id);

  v_from    := greatest(coalesce(p_from_date, v_program.starts_on), v_program.starts_on);
  v_through := least(coalesce(p_through_date, v_program.ends_on), v_program.ends_on);

  if v_through < v_from then raise exception 'invalid_date_range'; end if;
  if (v_through - v_from) > 182 then raise exception 'range_too_long'; end if;

  select timezone into v_tz from public.clubs where id = v_club_id;

  -- Total possible (rule, date) slots in range, regardless of already
  -- generated — used only for the skipped_count arithmetic below.
  select count(*) into v_total_count
  from public.program_schedule_rules psr
  cross join generate_series(v_from::timestamp, v_through::timestamp, interval '1 day') as d
  where psr.program_id = p_program_id
    and extract(dow from d)::int = psr.day_of_week;

  -- Materialize the NEW (not yet generated) candidate set once. Session-
  -- local, dropped automatically when this call's transaction ends. The
  -- defensive DROP IF EXISTS guards the (not expected under normal
  -- PostgREST one-request-one-transaction usage) case of this function
  -- being invoked a second time within an already-open outer transaction.
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

  -- Batch self-conflict: two different NEW candidates in this same call
  -- that would land on the same court + occurrence_date with overlapping
  -- time windows. Possible for a program whose rules predate 0089's
  -- create_program overlap guard. Fails the whole call before any INSERT.
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

  -- Pre-flight conflict check against existing pending/confirmed
  -- reservations — same overlap semantics as the reservations table's own
  -- GiST exclude constraint (0003). Fails the whole call before any INSERT
  -- if anything conflicts.
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

  -- All clear — one events row per new (rule, date), one reservations row
  -- per assigned court. Same insert shape as create_event (0062): same
  -- events columns, same reservations columns/reason/event linkage, no
  -- operating-hours check (create_event has none), no host participant row
  -- (removed from create_event in 0058).
  --
  -- Ownership: events.created_by, reservations.owner_user_id, and
  -- reservations.created_by are all v_program.created_by (the program
  -- owner), not auth.uid() — generation is the owner's own act regardless
  -- of who actually invoked it. auth.uid() is recorded only in
  -- audit_log.actor_id / metadata.generated_by_id below.
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

    -- member_joinable: true only for per_session; false for program
    -- (whole-series enrollment, no per-session self-join) and admin_managed
    -- (roster is admin-only).
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

    -- ── New in 0091: materialize every currently-'enrolled' whole-program
    -- member into this brand-new event. A no-op (zero rows) for
    -- per_session/admin_managed programs, since program_enrollments only
    -- ever has rows for enrollment_model='program' programs — every write
    -- path into program_enrollments (join_program et al.) rejects any
    -- other model with program_not_whole_enrollment. Offered and
    -- waitlisted members are never selected here. ON CONFLICT DO NOTHING
    -- is defensive only — this event was just inserted above and cannot
    -- already have any event_participants rows.
    --
    -- Race safety (see migration header, locking correction note): because
    -- this whole function holds the programs row lock acquired above,
    -- exactly one of two orderings is possible relative to any concurrent
    -- join_program/leave_program call for this program, never an
    -- interleaving of the two:
    --   (a) a concurrent join_program committed first — this SELECT then
    --       sees that member as 'enrolled' and correctly materializes them
    --       into this brand-new event;
    --   (b) this generation call commits first — the concurrent
    --       join_program (now unblocked) runs its own
    --       _materialize_program_member_into_future_events afterward,
    --       which finds this event already existing and materializes into
    --       it there instead. Symmetrically for leave_program: either it
    --       cancelled the member's row before this SELECT runs (excluded
    --       here), or it runs after this commits and its own
    --       _cancel_program_member_future_participation cancels the row
    --       this insert just created (this event is already 'scheduled',
    --       non-archived, and starts_at >= now(), so it is in scope for
    --       that cancellation).
    -- Either way, no enrolled member is ever left missing from a newly
    -- generated event, and no departed member is ever left materialized
    -- into one.
    if v_program.enrollment_model = 'program' then
      insert into public.event_participants (event_id, profile_id, role, status)
      select v_new_event.id, pe.profile_id, 'participant', 'confirmed'
      from public.program_enrollments pe
      where pe.program_id = v_program.id
        and pe.status     = 'enrolled'
      on conflict (event_id, profile_id) do nothing;
    end if;

    v_inserted_ids   := v_inserted_ids || v_new_event.id;
    v_inserted_count := v_inserted_count + 1;
  end loop;

  -- A successful generation transitions a draft program to active. Already-
  -- active programs are left alone; there is no other status this function
  -- can reach at this point (program_archived/program_not_generatable
  -- already rejected everything else above).
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


-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ═══════════════════════════════════════════════════════════════════════════
-- join_program, leave_program, accept_program_waitlist_offer,
-- decline_program_waitlist_offer, and the five private helpers are all new
-- in this migration — dropping them is a clean rollback with no other
-- object depending on them:
--
--   drop function if exists public.decline_program_waitlist_offer(uuid);
--   drop function if exists public.accept_program_waitlist_offer(uuid);
--   drop function if exists public.leave_program(uuid);
--   drop function if exists public.join_program(uuid);
--   drop function if exists public._program_is_enrollable(public.programs);
--   drop function if exists public._cancel_program_member_future_participation(uuid, uuid, uuid);
--   drop function if exists public._materialize_program_member_into_future_events(uuid, uuid, uuid);
--   drop function if exists public._advance_program_waitlist_offer(uuid, uuid, text);
--   drop function if exists public._expire_stale_program_offers(uuid, uuid, text);
--
-- program_enrollments.waitlisted_at and its CHECK constraint are also new
-- in this migration:
--
--   alter table public.program_enrollments drop constraint if exists program_enrollments_waitlisted_at_check;
--   alter table public.program_enrollments drop column if exists waitlisted_at;
--
-- event_participants' direct-write correction must be reversed alongside
-- the above if this migration is ever rolled back — otherwise the table
-- would be left with revoked write grants but none of the RPCs that were
-- supposed to replace them:
--
--   grant insert, update, delete on public.event_participants to authenticated;
--   create policy "event_participants_insert_own" on public.event_participants for insert
--     with check (
--       profile_id = auth.uid()
--       and exists (
--         select 1 from public.events
--         where events.id = event_participants.event_id
--           and events.club_id = public.current_user_club_id()
--           and events.status = 'scheduled'
--       )
--     );
--   create policy "event_participants_cancel_own" on public.event_participants for update
--     using (profile_id = auth.uid())
--     with check (status = 'cancelled' and profile_id = auth.uid());
--   -- (both policy bodies copied verbatim from 0004_events.sql)
--
-- generate_program_sessions is different: 0089 (already applied,
-- immutable) shipped a working version of this same function (without the
-- FOR UPDATE lock or the materialization step added in this migration).
-- Dropping it is NOT an acceptable rollback — the only acceptable rollback
-- for it is to CREATE OR REPLACE it back to 0089's exact body (copy that
-- file's function definition verbatim; do not edit 0089 in place):
--
--   -- re-run the "9. generate_program_sessions — hardened" CREATE OR
--   -- REPLACE block from 0089_program_generation_hardening.sql verbatim.
--
-- None of the above touches any program_enrollments/event_participants/
-- events/reservations/audit_log row already created under either version
-- of these functions while they existed — those are ordinary data rows,
-- not schema, and are unaffected by which function body is currently
-- active.

commit;
