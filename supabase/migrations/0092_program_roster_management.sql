-- 0092_program_roster_management.sql
-- Phase 27D3A: Admin/Pro Program Roster Backend.
--
-- Adds three SECURITY DEFINER RPCs so admins and authorized pros can view
-- and manage the roster of a whole-program (enrollment_model='program')
-- offering: get_program_roster, add_program_member, remove_program_member.
-- No new table. No parallel roster/participant/waitlist/attendance/session
-- system — program_enrollments remains the authoritative program-level
-- roster and event_participants remains the authoritative generated-
-- session roster, exactly as locked in 0091. This migration does not edit
-- 0087-0091 and is independently reviewable/rollback-able from them.
--
-- All three functions reuse the five private helpers 0091 already shipped
-- (_expire_stale_program_offers, _advance_program_waitlist_offer,
-- _materialize_program_member_into_future_events,
-- _cancel_program_member_future_participation, _program_is_enrollable) —
-- no new private helper was needed. add_program_member and
-- remove_program_member acquire the identical
-- `select ... from programs where id = p_program_id for update` lock, at
-- the identical point (their first program lookup), that join_program /
-- leave_program / accept_program_waitlist_offer /
-- decline_program_waitlist_offer / generate_program_sessions already use
-- — so every one of those six write paths against a given program fully
-- serializes against every other, exactly as 0091 already established for
-- the first four plus generation. No advisory lock is introduced; the
-- existing row-lock strategy is sufficient (see "Concurrency" below).
--
-- ─────────────────────────────────────────────────────────────────────────
-- Authorization model (all three functions):
--   • not_authenticated   — current_user_club_id() is null (no valid active
--                           membership — this single check already
--                           subsumes "not signed in" and "inactive/
--                           suspended active membership", per the existing
--                           membership-native convention).
--   • insufficient_role   — current_user_role() = 'member', OR
--                           current_user_role() = 'pro' and the program was
--                           created by someone else. Admins may manage any
--                           same-club program; pros only their own.
--   • program_not_found   — no programs row with that id in the caller's
--                           own active club (cross-club isolation — a
--                           program in a different club is indistinguishable
--                           from a nonexistent one, exactly like every other
--                           Phase 27 RPC).
-- Role is checked before the program lookup (matching
-- generate_program_sessions' own ordering) — a member calling with any
-- program id, valid or not, gets insufficient_role; an admin/pro calling
-- with a cross-club or nonexistent id gets program_not_found.
--
-- Target-membership authorization (add_program_member only — see that
-- function's own header for why remove_program_member does not repeat
-- this check): the target profile's club_memberships row is the sole
-- source of truth (status='active' and removed_at is null), never
-- profiles.club_id/role/status/is_lesson_provider — matching
-- _current_user_active_membership()'s own established predicate (0082),
-- applied here to a third-party target instead of the caller.
--
-- ─────────────────────────────────────────────────────────────────────────
-- Concurrency guarantees (see migration header of 0091 for the underlying
-- mechanism — this section only restates how the specific scenarios asked
-- for here are covered):
--   • staff add vs a concurrent member join_program: both take the same
--     programs-row lock as their first statement, so one fully commits
--     (capacity count, queue-bypass check, and any insert) before the
--     other's capacity count ever runs — neither can overfill the program
--     or bypass a waitlisted member the other just placed.
--   • staff removal vs concurrent generate_program_sessions: same lock:
--     removal cancelling a member's future participation and generation
--     materializing enrolled members into a brand-new event fully
--     serialize, so a departed member is never left materialized into a
--     session generated moments later, and a session generated moments
--     before a removal always has that removal's cancellation applied to
--     it (identical reasoning to 0091's own generate_program_sessions
--     header, "Race safety").
--   • two simultaneous staff additions: the second call's capacity count
--     and queue-bypass check only run after the first has committed (or
--     rolled back), so they can never both simultaneously believe a spot
--     is free.
--   • two simultaneous staff removals (or a removal racing a member's own
--     leave_program): only one can be holding the lock at a time, so
--     _advance_program_waitlist_offer's own idempotency guard (0091 — at
--     most one live offer at a time) is never evaluated by two callers
--     against the same pre-promotion state, so a double-promotion is
--     structurally impossible.
--   • different programs never block each other — the lock is per programs
--     row, not table-wide.
--
-- ─────────────────────────────────────────────────────────────────────────
-- Deliberate divergence from the Phase 19B admin event-participant RPCs
-- (0051 — admin_add_member/admin_remove_participant): those two use the
-- pre-membership-native pattern (profiles.role/profiles.club_id directly)
-- and admin_add_member raises already_joined as an error for an already-
-- active target rather than returning it idempotently. This checkpoint's
-- own instructions explicitly specify membership-native authorization only
-- and explicitly specify idempotent (non-error) behavior for an already-
-- enrolled/waitlisted/offered target — both are deliberate, spelled-out
-- requirements for this checkpoint, not an oversight or an accidental
-- inconsistency with 0051's older pattern.
--
-- Email exposure in get_program_roster: the only existing precedent in
-- this codebase for exposing a member's email to staff is get_members()
-- (0086), which joins auth.users for email and is gated admin-only (pro
-- never sees it there, even for members of a program the pro created).
-- No roster-shaped RPC (get_event_roster) exposes email at all. Given the
-- checkpoint's own hedge — "member email if the existing profile/contact
-- authorization contract permits it" — the only established contract found
-- is admin-only, so get_program_roster follows it exactly: email is
-- populated for admin callers and returned null for pro callers, even
-- though a pro may otherwise fully manage the same roster. This is not a
-- new restriction invented for this checkpoint; it is the existing
-- contract applied faithfully to a new caller (pro) that contract never
-- previously covered.
--
-- ─────────────────────────────────────────────────────────────────────────
-- RLS / grants note: no RLS policy and no table-level GRANT is changed by
-- this migration. program_enrollments' existing SELECT policy (0087) and
-- table-level grant (authenticated SELECT only, 0087) are untouched — all
-- three functions below are SECURITY DEFINER and read/write
-- program_enrollments and event_participants as their owner, bypassing RLS
-- for their own internal operations, exactly like every RPC in 0091. No
-- authenticated/anon INSERT, UPDATE, or DELETE grant is added to
-- program_enrollments or event_participants — writes to both remain
-- exclusively RPC-owned.
--
-- See supabase/scripts/verify_phase27d3a.sql for the full read-only
-- verification pass, and supabase/scripts/QA_phase27d3a.md for manual QA
-- steps.
--
-- Apply in Supabase SQL Editor (cloud only). Not applied by this checkpoint.

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. get_program_roster
-- ═══════════════════════════════════════════════════════════════════════════
-- Returns every program_enrollments row for the program (including
-- cancelled — this is a roster/history view, unlike get_event_roster which
-- excludes cancelled rows entirely), joined to profiles for first/last
-- name and conditionally to auth.users for email (admin only — see
-- migration header). No enrollability/lifecycle gate: viewing the roster
-- of an ended, cancelled, completed, or archived program is a legitimate
-- staff operation and must not be blocked the way join_program blocks new
-- enrollment into one.
--
-- Ordering: enrolled(1) / offered(2) / waitlisted(3, by waitlisted_at asc
-- — the same FIFO order _advance_program_waitlist_offer promotes in) /
-- cancelled(4). Within the enrolled/offered/cancelled groups, created_at
-- asc; id asc is the final deterministic tiebreaker for any exact tie.
--
-- Error codes: not_authenticated, insufficient_role, program_not_found,
-- program_not_whole_enrollment.

create or replace function public.get_program_roster(p_program_id uuid)
returns table (
  enrollment_id     uuid,
  program_id        uuid,
  profile_id        uuid,
  first_name        text,
  last_name         text,
  email             text,
  status            text,
  waitlisted_at     timestamptz,
  offer_expires_at  timestamptz,
  created_at        timestamptz,
  updated_at        timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
  v_role    text;
  v_program public.programs%rowtype;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;
  if v_club_id is null then raise exception 'not_authenticated'; end if;

  if v_role not in ('admin', 'pro') then
    raise exception 'insufficient_role';
  end if;

  select * into v_program
    from public.programs
    where id = p_program_id and club_id = v_club_id;
  if not found then raise exception 'program_not_found'; end if;

  if v_role = 'pro' and v_program.created_by <> auth.uid() then
    raise exception 'insufficient_role';
  end if;

  if v_program.enrollment_model <> 'program' then
    raise exception 'program_not_whole_enrollment';
  end if;

  return query
    select
      pe.id,
      pe.program_id,
      pe.profile_id,
      p.first_name,
      p.last_name,
      case when v_role = 'admin' then u.email::text else null end,
      pe.status,
      pe.waitlisted_at,
      pe.offer_expires_at,
      pe.created_at,
      pe.updated_at
    from public.program_enrollments pe
    join public.profiles p on p.id = pe.profile_id
    left join auth.users u on u.id = pe.profile_id
    where pe.program_id = p_program_id
    order by
      case pe.status
        when 'enrolled'   then 1
        when 'offered'    then 2
        when 'waitlisted' then 3
        when 'cancelled'  then 4
      end,
      case when pe.status = 'waitlisted' then pe.waitlisted_at else pe.created_at end asc,
      pe.id asc;
end;
$$;

revoke execute on function public.get_program_roster(uuid) from public, anon;
grant  execute on function public.get_program_roster(uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. add_program_member
-- ═══════════════════════════════════════════════════════════════════════════
-- Staff-initiated equivalent of join_program, targeting a specific
-- same-club member instead of the caller. Diverges from join_program's own
-- control flow in three deliberate, spelled-out-by-this-checkpoint ways:
--   1. An admin/pro authorization gate up front (join_program has none —
--      any member may call it for themselves).
--   2. A target-membership check (club_memberships-based, never
--      profiles.club_id/role/status/is_lesson_provider) in place of
--      join_program's own auth.uid()-is-the-target assumption.
--   3. Waitlisted/offered targets are returned EXACTLY unchanged (no
--      already_enrolled error, but also no expiry/advance run on their
--      behalf) — the target's existing row is read first, before any
--      other side effect, specifically so that an already-waitlisted or
--      already-offered target's status, waitlisted_at, offer_expires_at,
--      and updated_at are never touched by this call. Stale-offer expiry
--      and queue advancement only run in the remaining branch (the target
--      has no row, or a cancelled row) — neither helper can affect a row
--      that doesn't exist or is already cancelled, so it is safe to run
--      them there without a target-specific side effect either. This
--      correction replaces an earlier draft that ran expire+advance
--      unconditionally before checking the target's status, which could
--      promote, expire, or otherwise alter an already-waitlisted/offered
--      target (or the surrounding queue) as an unintended side effect of
--      a staff Add action that should have been a pure no-op for them.
--
-- Preserves the existing one-live-offer-at-a-time policy from
-- _advance_program_waitlist_offer unchanged (no correction was needed).
--
-- An audit_log entry is written on every call, including the two
-- idempotent no-op paths (already-enrolled, already-waitlisted/offered) —
-- a staff member's decision to add someone is itself worth recording even
-- when it produces no state change, unlike a member's own repeat
-- self-join (which join_program treats as a true no-op with no audit
-- entry, since a member re-clicking Join is not a meaningful staff
-- action). metadata.no_op distinguishes the two cases.
--
-- Error codes: not_authenticated, insufficient_role, program_not_found,
-- program_not_whole_enrollment, program_not_enrollable,
-- target_member_not_found, target_member_inactive.

create or replace function public.add_program_member(
  p_program_id uuid,
  p_profile_id uuid
)
returns public.program_enrollments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id       uuid;
  v_role          text;
  v_program       public.programs%rowtype;
  v_target_status text;
  v_existing      public.program_enrollments%rowtype;
  v_count         int;
  v_result        public.program_enrollments%rowtype;
  v_no_op         boolean := false;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;
  if v_club_id is null then raise exception 'not_authenticated'; end if;

  if v_role not in ('admin', 'pro') then
    raise exception 'insufficient_role';
  end if;

  -- Lock acquisition combined with the existence/club-scope check — see
  -- migration header, Concurrency, for what this serializes against.
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

  -- Target membership: club_memberships is the sole source of truth here.
  select status into v_target_status
    from public.club_memberships
    where user_id    = p_profile_id
      and club_id    = v_club_id
      and removed_at is null;
  if not found then raise exception 'target_member_not_found'; end if;
  if v_target_status <> 'active' then raise exception 'target_member_inactive'; end if;

  -- Read the target's existing row FIRST, before any other side effect.
  -- This ordering is required, not incidental: an already-waitlisted or
  -- already-offered target must be returned exactly as their row already
  -- stands — no expiry/advance call runs on their behalf, so their status,
  -- waitlisted_at, offer_expires_at, and updated_at are all guaranteed
  -- untouched by this call.
  select * into v_existing
    from public.program_enrollments
    where program_id = p_program_id and profile_id = p_profile_id;

  if found and v_existing.status = 'enrolled' then
    -- Idempotent fast path — no expire/advance run, matching join_program's
    -- own identical fast path exactly.
    v_result := v_existing;
    v_no_op  := true;
  elsif found and v_existing.status in ('waitlisted', 'offered') then
    -- Returned exactly unchanged — see this function's header for why no
    -- expire/advance call is made in this branch.
    v_result := v_existing;
    v_no_op  := true;
  else
    -- No row, or a cancelled row: neither _expire_stale_program_offers nor
    -- _advance_program_waitlist_offer can touch a row that doesn't exist or
    -- is already cancelled, so it is safe to run routine queue maintenance
    -- here before deciding this target's own outcome.
    perform public._expire_stale_program_offers(p_program_id, v_club_id, v_program.title);
    perform public._advance_program_waitlist_offer(p_program_id, v_club_id, v_program.title);

    select count(*) into v_count
      from public.program_enrollments
      where program_id = p_program_id
        and status     in ('enrolled', 'offered');

    -- Queue-bypass guard: identical to join_program's own — never enroll
    -- directly while anyone is waitlisted, even if raw capacity is free.
    if v_count >= v_program.default_capacity or exists (
      select 1 from public.program_enrollments
      where program_id = p_program_id and status = 'waitlisted'
    ) then
      insert into public.program_enrollments (program_id, profile_id, status, waitlisted_at)
      values (p_program_id, p_profile_id, 'waitlisted', now())
      on conflict (program_id, profile_id)
        do update set status = 'waitlisted', offer_expires_at = null, waitlisted_at = now(), updated_at = now()
      returning * into v_result;
    else
      insert into public.program_enrollments (program_id, profile_id, status)
      values (p_program_id, p_profile_id, 'enrolled')
      on conflict (program_id, profile_id)
        do update set status = 'enrolled', offer_expires_at = null, waitlisted_at = null, updated_at = now()
      returning * into v_result;
    end if;
  end if;

  if v_result.status = 'enrolled' then
    perform public._materialize_program_member_into_future_events(p_program_id, p_profile_id, v_club_id);
  end if;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'add_program_member', 'program', p_program_id,
    jsonb_build_object(
      'target_profile_id', p_profile_id,
      'final_status',      v_result.status,
      'no_op',             v_no_op,
      'actor_role',        v_role
    )
  );

  return v_result;
end;
$$;

revoke execute on function public.add_program_member(uuid, uuid) from public, anon;
grant  execute on function public.add_program_member(uuid, uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. remove_program_member
-- ═══════════════════════════════════════════════════════════════════════════
-- Staff-initiated equivalent of leave_program, targeting a specific
-- same-club member. Structurally identical to leave_program (enrolled/
-- waitlisted/offered -> cancelled; enrolled departure cancels only future
-- materialized event_participants rows, past attendance untouched;
-- enrolled/offered departure frees a held spot and runs expire+advance;
-- waitlisted departure triggers no promotion), with an admin/pro
-- authorization gate prepended and p_profile_id in place of auth.uid().
--
-- Deliberately does NOT repeat add_program_member's target-membership
-- (club_memberships active/removed) check: "same authorization rules as
-- add_program_member" is read here as the caller-side rules (role gate,
-- program lookup, pro-ownership, club scoping) — not the target-
-- eligibility precondition for adding. A member whose own membership has
-- since gone inactive or been removed must still be removable from a
-- program roster they are still materialized into; gating removal on the
-- target's current membership state would make such a stale roster entry
-- permanently unremovable through this RPC. This mirrors leave_program's
-- own precedent of placing no lifecycle/eligibility gate on a cleanup-only
-- operation (see 0091's lifecycle matrix).
--
-- No idempotent-cancelled-return path: a target with no active (enrolled/
-- waitlisted/offered) row raises enrollment_not_found, matching the
-- existing admin participant-management convention
-- (admin_remove_participant, 0051, raises participant_not_found for the
-- same case rather than returning idempotently).
--
-- Error codes: not_authenticated, insufficient_role, program_not_found,
-- program_not_whole_enrollment, enrollment_not_found.

create or replace function public.remove_program_member(
  p_program_id uuid,
  p_profile_id uuid
)
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

  if v_role not in ('admin', 'pro') then
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

  select * into v_old
    from public.program_enrollments
    where program_id = p_program_id
      and profile_id = p_profile_id
      and status     in ('enrolled', 'waitlisted', 'offered');
  if not found then raise exception 'enrollment_not_found'; end if;

  update public.program_enrollments
    set status           = 'cancelled',
        offer_expires_at = null,
        waitlisted_at    = null,
        updated_at       = now()
    where program_id = p_program_id and profile_id = p_profile_id
  returning * into v_result;

  if v_old.status = 'enrolled' then
    -- Future-only cancellation — past attendance/historical rows are never
    -- touched (see _cancel_program_member_future_participation, 0091).
    perform public._cancel_program_member_future_participation(p_program_id, p_profile_id, v_club_id);
  end if;

  if v_old.status in ('enrolled', 'offered') then
    -- A held-or-reserved spot was freed: expire other stale offers, then
    -- advance the queue for the next eligible waitlisted member.
    perform public._expire_stale_program_offers(p_program_id, v_club_id, v_program.title);
    perform public._advance_program_waitlist_offer(p_program_id, v_club_id, v_program.title);
  end if;
  -- v_old.status = 'waitlisted': no capacity was freed, no promotion needed.

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'remove_program_member', 'program', p_program_id,
    jsonb_build_object(
      'target_profile_id', p_profile_id,
      'previous_status',   v_old.status,
      'actor_role',        v_role
    )
  );

  return v_result;
end;
$$;

revoke execute on function public.remove_program_member(uuid, uuid) from public, anon;
grant  execute on function public.remove_program_member(uuid, uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ═══════════════════════════════════════════════════════════════════════════
-- All three functions are new in this migration and depend on nothing
-- this migration itself created (only on 0091's already-applied private
-- helpers and 0087's already-applied tables) — dropping them is a clean,
-- complete rollback with no other object depending on them:
--
--   drop function if exists public.remove_program_member(uuid, uuid);
--   drop function if exists public.add_program_member(uuid, uuid);
--   drop function if exists public.get_program_roster(uuid);
--
-- No schema (table/column/constraint), grant, or RLS policy change was
-- made anywhere in this migration, so there is nothing else to reverse.
-- No program_enrollments/event_participants/audit_log row created while
-- these functions existed is affected by dropping them — those are
-- ordinary data rows, unrelated to which functions are currently defined.

commit;
