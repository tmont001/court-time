-- 0187_member_cancellation_policy_preview.sql
-- Phase 41B completion — authoritative Member cancellation-policy preview.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- SCOPE (locked)
-- ═══════════════════════════════════════════════════════════════════════════
-- Read-only preview of the SAME classification _evaluate_cancellation_
-- policy (0185) already authoritatively computes inside cancel_member_
-- reservation/cancel_lesson, plus two thin "confirmed" wrapper RPCs that
-- close the preview-to-confirm race window. No refund/payment/Stripe
-- semantics change. No event/program RPC touched. No new club_settings
-- column. Admin/Staff/assigned-Pro cancellation paths are completely
-- untouched — this migration adds nothing they call.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY A PREVIEW RPC IS NEEDED (targeted check, already performed — not
-- re-audited here)
-- ═══════════════════════════════════════════════════════════════════════════
-- _evaluate_cancellation_policy is called ONLY from inside cancel_member_
-- reservation and cancel_lesson (confirmed by grep across every applied
-- migration) — no read-only caller exists. Reproducing its arithmetic
-- client-side, or in a second independent server-side helper, was
-- explicitly out of scope. Both new preview functions below are thin,
-- read-only wrappers with the SAME auth/ownership/effective-start-time
-- resolution their corresponding mutating RPC already uses, delegating
-- the actual classification to the one existing private helper.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHAT THIS MIGRATION DOES
-- ═══════════════════════════════════════════════════════════════════════════
-- 1. preview_member_reservation_cancellation_policy(p_reservation_id,
--    p_expected_club_id) — same club/role/roster-aware-ownership
--    resolution and same club_settings window/grace defaulting as
--    cancel_member_reservation; no row lock (nothing is mutated); returns
--    state/cutoff_at/within_grace only, never a refund amount.
-- 2. preview_member_lesson_cancellation_policy(p_request_id) — same
--    durable Member-identity resolution (history OR roster) and same
--    effective-start-time resolution (linked_reservation_id's own
--    starts_at when a reschedule is in flight, else proposed_starts_at)
--    as cancel_lesson's own Member branch; grace hard-disabled (0
--    minutes, no anchor), matching cancel_lesson exactly.
-- 3. cancel_member_reservation_confirmed(p_reservation_id,
--    p_expected_club_id, p_expected_policy_state) — thin wrapper.
--    Authenticates/authorizes via an initial, unlocked call to the
--    preview RPC (fails fast, no lock taken, for an invalid/unauthorized
--    request); THEN locks the reservation row (FOR UPDATE, id+club-scoped
--    only — no ownership/policy predicate duplicated); THEN locks that
--    club's club_settings row (FOR SHARE — see "LOCK ORDER" below for
--    why); THEN re-runs the preview a SECOND time while BOTH locks are
--    held, and compares ONLY this final result against what the Member
--    explicitly confirmed. A mismatch raises 'cancellation_policy_changed'
--    (nothing mutates, both locks released on rollback). A match
--    delegates to the existing, unmodified cancel_member_reservation,
--    still inside the same transaction — its own FOR UPDATE/plain SELECT
--    re-read the SAME already-locked/held rows (a no-op re-lock, not a
--    second race window). See "LOCK ORDER" below for the full
--    correctness argument.
-- 4. cancel_member_lesson_confirmed(p_request_id, p_reason,
--    p_expected_policy_state) — same shape, over cancel_lesson. Locks
--    lesson_requests FIRST, then (when linked_reservation_id is set) the
--    linked pro_lesson reservation SECOND — the SAME order cancel_lesson/
--    propose_lesson_time/admin_update_member_lesson all already use
--    (verified by direct re-read of all three before writing the prior
--    correction) — then that lesson's club_settings row THIRD (FOR
--    SHARE). A non-Member caller is rejected by the initial preview call
--    itself (not_authorised_to_cancel) before any lock is ever taken.
--
-- Neither wrapper copies the body of cancel_member_reservation/
-- cancel_lesson, and neither duplicates _evaluate_cancellation_policy's
-- own arithmetic or either mutating RPC's ownership/status predicates —
-- each wrapper's own row locks are scoped by id (+club, for the
-- reservation and club_settings locks) ONLY; the full authorization/
-- policy re-evaluation is left entirely to the (twice-called) preview RPC
-- and the delegated mutating RPC. p_expected_policy_state is never
-- trusted as truth; it is compared against a fresh, LOCK-STABLE
-- server-side evaluation, never used to skip or alter that evaluation.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- LOCK ORDER — why the confirmed wrappers are safe against a preview/row-
-- change race (two correction passes — see both bugs below)
-- ═══════════════════════════════════════════════════════════════════════════
-- FIRST-DRAFT BUG (fixed in the first correction pass): the original
-- wrapper bodies called the (unlocked, read-only) preview RPC once,
-- compared its result, then delegated — arguing that PostgreSQL's
-- transaction-stable now() made this safe. That argument only freezes
-- TIME. It does NOT freeze starts_at, linked_reservation_id, or any other
-- row content across statements under READ COMMITTED. The reachable race
-- it missed: preview says in_policy -> comparison passes -> a CONCURRENT
-- Admin reschedule commits, changing starts_at -> the delegated RPC's own
-- FOR UPDATE blocks, then reads the NEW row -> its fresh evaluator
-- returns late -> cancellation still succeeds, silently, as late, with NO
-- policy refund request created.
--
-- SECOND-DRAFT BUG (fixed here): the first correction locked the
-- reservation/lesson_requests (+linked reservation) rows but left
-- club_settings.cancellation_window_hours/cancellation_grace_minutes
-- unlocked — both preview RPCs read them, and they are just as
-- policy-driving as starts_at. The identical race remained reachable
-- through club_settings instead of starts_at: preview reads the CURRENT
-- window/grace and returns in_policy -> comparison passes -> a
-- CONCURRENT Admin update_club_settings call commits new window/grace
-- values -> the delegated RPC's own plain SELECT of club_settings (it has
-- no lock of its own on that table) reads the NEW values -> late -> same
-- silent financial-outcome change, now via a different row.
--
-- The corrected invariant, implemented below:
--   * TIME is stable because now() is transaction-stable (necessary, not
--     sufficient on its own).
--   * EVERY policy-driving DOMAIN AND SETTINGS row is stable because the
--     confirmed wrapper itself acquires all of their locks BEFORE the
--     final comparison: reservations (FOR UPDATE) + that club's
--     club_settings row (FOR SHARE) for the reservation wrapper;
--     lesson_requests (FOR UPDATE) then the linked pro_lesson reservation
--     (FOR UPDATE, conditionally) then that lesson's club_settings row
--     (FOR SHARE) for the lesson wrapper.
--   * club_settings is locked FOR SHARE, not FOR UPDATE — this project's
--     own established pattern for "freeze this row against a concurrent
--     UPDATE without blocking other concurrent readers" (identical use:
--     0126_member_schedule_guards.sql's events lock, 0178_reservation_
--     participant_foundation.sql's reservations lock). Multiple Members
--     previewing/confirming cancellations for the SAME club concurrently
--     never block each other (FOR SHARE does not conflict with FOR
--     SHARE); an Admin's update_club_settings blocks until they all
--     finish, since a plain UPDATE's implicit row lock conflicts with FOR
--     SHARE. This is the least-exclusive lock that still prevents the
--     race.
--   * The delegated cancellation RPC (cancel_member_reservation/
--     cancel_lesson) re-locks/re-reads those SAME rows, in the SAME
--     transaction, before it computes its own v_policy_state — since this
--     wrapper already holds every lock, that re-acquisition (or, for
--     club_settings, plain re-read) is a no-op, never a second race
--     window, and it reads the exact content the wrapper's own final
--     comparison just validated.
--   * Therefore the Member-confirmed policy outcome cannot silently
--     change between confirmation and mutation — any concurrent change to
--     ANY policy-driving row (domain or settings) now blocks behind this
--     wrapper's own locks until this transaction commits or rolls back,
--     and only ever takes effect on a LATER, separate cancellation
--     attempt (which will correctly preview the new state first).
--
-- LOCK ORDER CHECK — club_settings mutators (verified, not assumed): every
-- function that writes to club_settings was found by grepping every
-- `insert into club_settings`/`update club_settings set` across the full
-- migrations directory and reading each one: update_club_settings (0049,
-- window/grace itself), update_club_pricing (0142), update_club_payment_
-- mode (0143), update_club_rules_and_policies (0184), and the "bootstrap
-- new club" INSERT (0035/0074/0129/0164, superseding redefinitions of one
-- function). None of them takes a FOR UPDATE/FOR SHARE lock on
-- reservations or lesson_requests at all. update_club_pricing does READ
-- reservations/lesson_requests (an existence check gating a currency-lock
-- rule), but via a plain, non-locking SELECT — under MVCC a plain SELECT
-- neither blocks nor is blocked by another transaction's row lock, so it
-- cannot participate in a lock cycle. The bootstrap insert only ever runs
-- for a brand-new club with zero existing reservations/lesson_requests.
-- No club_settings-mutating function locks club_settings and then a
-- domain row — this migration's own domain-row-then-club_settings order
-- therefore introduces no deadlock risk against any existing path.
--
-- MISSING club_settings ROW (verified, not assumed): update_club_settings
-- — the only function that ever changes cancellation_window_hours/
-- cancellation_grace_minutes — is a plain `UPDATE ... WHERE club_id = ...`
-- with no INSERT/upsert fallback, and no other function inserts a
-- club_settings row for an ALREADY-EXISTING club (every INSERT found
-- above is part of new-club bootstrap only, which runs once, before that
-- club can have any reservations/lessons at all). A club's club_settings
-- row therefore either exists from bootstrap onward (and only its
-- contents ever change, never its existence) or was never created (in
-- which case the existing 24h/5min fallback — preserved verbatim, not
-- touched by this migration — applies permanently and consistently, since
-- nothing can ever insert one later). There is no reachable "row comes
-- into existence mid-transaction" race for either wrapper's FOR SHARE
-- lock (a lock over zero matching rows is a harmless no-op, exactly like
-- this migration's own reservation/lesson_requests locks already handle
-- a not-found id) — this migration therefore adds no schema constraint
-- or bootstrap change, and none is needed.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- SECURITY
-- ═══════════════════════════════════════════════════════════════════════════
-- All four new functions: revoke execute from public, anon; grant to
-- authenticated only. Same-club scoping and ownership/identity checks are
-- inherited verbatim from the mutating RPCs they mirror — no new
-- cross-club or cross-Member read surface is introduced.
-- _evaluate_cancellation_policy itself is untouched and remains revoked
-- from every role (0185) — nothing here grants it new reachability.
--
-- Not applied by this checkpoint. Not committed.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. preview_member_reservation_cancellation_policy
-- ═══════════════════════════════════════════════════════════════════════════
-- Reuses cancel_member_reservation's (0186) own auth/ownership/window-
-- resolution logic verbatim, minus the row lock (read-only) and minus
-- everything past the policy evaluation itself (no mutation, no refund
-- logic, no audit/notification).
create or replace function public.preview_member_reservation_cancellation_policy(
  p_reservation_id   uuid,
  p_expected_club_id uuid
)
returns table (
  state        text,
  cutoff_at    timestamptz,
  within_grace boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id                     uuid;
  v_role                        text;
  v_roster_member_id            uuid;
  v_res                         reservations%rowtype;
  v_cancellation_window_hours   integer;
  v_cancellation_grace_minutes  integer;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
  if v_role is null or v_role not in ('member', 'pro') then
    raise exception 'insufficient_role';
  end if;

  v_roster_member_id := public.current_user_roster_member_id();

  select * into v_res
    from reservations
    where id = p_reservation_id
      and club_id = v_club_id
      and (
        owner_user_id = auth.uid()
        or (v_roster_member_id is not null and roster_member_id = v_roster_member_id)
      );
  if not found then raise exception 'reservation_not_found'; end if;

  if v_res.reason <> 'member_booking' then raise exception 'reservation_not_editable'; end if;
  if v_res.status <> 'confirmed' then raise exception 'reservation_not_editable'; end if;

  select cancellation_window_hours, cancellation_grace_minutes
    into v_cancellation_window_hours, v_cancellation_grace_minutes
    from club_settings
    where club_id = v_club_id;

  if not found then
    v_cancellation_window_hours  := 24;
    v_cancellation_grace_minutes := 5;
  else
    v_cancellation_window_hours  := coalesce(v_cancellation_window_hours, 24);
    v_cancellation_grace_minutes := coalesce(v_cancellation_grace_minutes, 5);
  end if;

  return query
    select p.state, p.cutoff_at, p.within_grace
      from public._evaluate_cancellation_policy(
        v_res.starts_at,
        v_cancellation_window_hours,
        v_cancellation_grace_minutes,
        v_res.created_at,
        now()
      ) p;
end;
$$;

revoke execute on function public.preview_member_reservation_cancellation_policy(uuid, uuid) from public, anon;
grant  execute on function public.preview_member_reservation_cancellation_policy(uuid, uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. preview_member_lesson_cancellation_policy
-- ═══════════════════════════════════════════════════════════════════════════
-- Reuses cancel_lesson's (0186) own Member-identity resolution and
-- effective-start-time resolution verbatim, minus the row lock and
-- everything past the policy evaluation itself. Grace hard-disabled,
-- matching cancel_lesson's Member branch exactly.
create or replace function public.preview_member_lesson_cancellation_policy(
  p_request_id uuid
)
returns table (
  state        text,
  cutoff_at    timestamptz,
  within_grace boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile              public.profiles%rowtype;
  v_request              public.lesson_requests%rowtype;
  v_caller_roster_id     uuid;
  v_is_member_by_history boolean;
  v_is_member_by_roster  boolean;
  v_old_reservation      public.reservations%rowtype;
  v_effective_starts_at  timestamptz;
  v_window_hours         int;
begin
  select * into v_profile from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.club_id is null then raise exception 'no_club'; end if;

  select * into v_request
    from public.lesson_requests
   where id      = p_request_id
     and club_id = v_profile.club_id;
  if not found then raise exception 'request_not_found'; end if;

  select id into v_caller_roster_id
    from public.roster_members
   where club_id    = v_profile.club_id
     and claimed_by = auth.uid();

  v_is_member_by_history := v_request.member_id is not null and v_request.member_id = auth.uid();
  v_is_member_by_roster  := v_caller_roster_id is not null and v_request.roster_member_id = v_caller_roster_id;

  if not (v_is_member_by_history or v_is_member_by_roster) then
    raise exception 'not_authorised_to_cancel';
  end if;

  if not (
    v_request.status = 'confirmed'
    or (v_request.status = 'proposed' and v_request.linked_reservation_id is not null)
  ) then
    raise exception 'invalid_status_for_cancel';
  end if;

  if v_request.linked_reservation_id is not null then
    select * into v_old_reservation
      from public.reservations
     where id      = v_request.linked_reservation_id
       and club_id = v_profile.club_id
       and reason  = 'pro_lesson'
       and status  = 'confirmed';
    if not found then raise exception 'linked_reservation_not_found'; end if;
    v_effective_starts_at := v_old_reservation.starts_at;
  else
    v_effective_starts_at := v_request.proposed_starts_at;
  end if;

  select coalesce(cs.cancellation_window_hours, 24) into v_window_hours
    from public.club_settings cs
   where cs.club_id = v_profile.club_id;

  return query
    select p.state, p.cutoff_at, p.within_grace
      from public._evaluate_cancellation_policy(
        v_effective_starts_at,
        v_window_hours,
        0,
        null,
        now()
      ) p;
end;
$$;

revoke execute on function public.preview_member_lesson_cancellation_policy(uuid) from public, anon;
grant  execute on function public.preview_member_lesson_cancellation_policy(uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. cancel_member_reservation_confirmed — expected-state guard wrapper
--    (correction pass — see this migration's own "LOCK ORDER" header
--    comment for the race this closes)
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.cancel_member_reservation_confirmed(
  p_reservation_id        uuid,
  p_expected_club_id      uuid,
  p_expected_policy_state text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_final_state text;
begin
  if p_expected_policy_state is null or p_expected_policy_state not in ('in_policy', 'grace', 'late') then
    raise exception 'invalid_arguments';
  end if;

  -- Step 1 — authenticate/authorize via the existing preview RPC, UNLOCKED.
  -- Fails fast (not_authenticated/stale_club_context/insufficient_role/
  -- reservation_not_found/reservation_not_editable) for an invalid or
  -- unauthorized request before ever taking a row lock. Its result is not
  -- used for the policy comparison — only step 4's result is.
  perform public.preview_member_reservation_cancellation_policy(p_reservation_id, p_expected_club_id);

  -- Step 2 — lock the reservation row itself. Deliberately id+club scoped
  -- ONLY, no ownership/reason/status predicate duplicated from cancel_
  -- member_reservation — step 1 already authorized this exact id, and
  -- step 4's re-run preview re-validates everything (including ownership)
  -- against whatever this lock now holds stable. Freezes starts_at,
  -- created_at, status, roster_member_id, etc. for the rest of this
  -- transaction — a concurrent Admin edit/reschedule now blocks here
  -- until this transaction commits or rolls back.
  perform 1 from public.reservations
   where id = p_reservation_id and club_id = p_expected_club_id
   for update;

  -- Step 3 — lock that club's club_settings row FOR SHARE (see this
  -- migration's own "LOCK ORDER" header comment for why FOR SHARE, and
  -- for the verified finding that no club_settings-mutating function
  -- locks a domain row first, so this order cannot deadlock). Freezes
  -- cancellation_window_hours/cancellation_grace_minutes — a concurrent
  -- Admin update_club_settings now blocks until this transaction commits
  -- or rolls back. A club with no club_settings row locks nothing here
  -- (harmless no-op) — see "MISSING club_settings ROW" above.
  perform 1 from public.club_settings
   where club_id = p_expected_club_id
   for share;

  -- Step 4 — re-run the FULL authoritative preview, now reading the
  -- locked, frozen reservation row AND the locked, frozen club_settings
  -- row. This is the comparison that actually matters.
  select state into v_final_state
    from public.preview_member_reservation_cancellation_policy(p_reservation_id, p_expected_club_id);

  if v_final_state is distinct from p_expected_policy_state then
    raise exception 'cancellation_policy_changed';
  end if;

  -- Step 5 — delegate to the existing, unmodified cancel_member_
  -- reservation. Its own FOR UPDATE and plain club_settings SELECT
  -- re-read the SAME rows this wrapper already holds locked (same
  -- transaction — a no-op re-lock/stable re-read, not a new race window)
  -- — the exact content step 4 just validated.
  return public.cancel_member_reservation(p_reservation_id, p_expected_club_id);
end;
$$;

revoke execute on function public.cancel_member_reservation_confirmed(uuid, uuid, text) from public, anon;
grant  execute on function public.cancel_member_reservation_confirmed(uuid, uuid, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. cancel_member_lesson_confirmed — expected-state guard wrapper
--    (correction pass — see this migration's own "LOCK ORDER" header
--    comment for the race this closes)
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.cancel_member_lesson_confirmed(
  p_request_id            uuid,
  p_reason                text,
  p_expected_policy_state text
)
returns public.lesson_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id               uuid;
  v_linked_reservation_id uuid;
  v_final_state            text;
begin
  -- Lessons never have grace (cancel_lesson's own Member branch always
  -- passes p_grace_minutes = 0) — 'grace' is not a reachable preview
  -- result here, so it is not accepted as an expected state either.
  if p_expected_policy_state is null or p_expected_policy_state not in ('in_policy', 'late') then
    raise exception 'invalid_arguments';
  end if;

  -- Step 1 — authenticate/authorize via the existing preview RPC,
  -- UNLOCKED. A non-Member caller is rejected here (not_authorised_to_
  -- cancel) before any lock is ever taken. Its result is not used for the
  -- policy comparison — only step 5's result is.
  perform public.preview_member_lesson_cancellation_policy(p_request_id);

  -- Step 2 — lock lesson_requests FIRST, matching cancel_lesson's own
  -- established lock order exactly (verified by direct re-read of
  -- cancel_lesson, propose_lesson_time, and admin_update_member_lesson
  -- before writing the prior correction — all three lock lesson_requests
  -- before any linked reservation, so this cannot deadlock against any of
  -- them). id-scoped only, club/ownership already authorized in step 1
  -- and re-validated fresh in step 5.
  select club_id, linked_reservation_id into v_club_id, v_linked_reservation_id
    from public.lesson_requests
   where id = p_request_id
   for update;

  -- Step 3 — lock the linked pro_lesson reservation SECOND, only when one
  -- exists — same conditional and same identity predicate (id/club_id/
  -- reason) cancel_lesson's own body uses, minus its status = 'confirmed'
  -- filter (deliberately: locking the row regardless of its current
  -- status freezes it either way; step 5's full preview re-validates
  -- status and raises linked_reservation_not_found if it no longer
  -- qualifies). This freezes the exact row that determines
  -- v_effective_starts_at.
  if v_linked_reservation_id is not null then
    perform 1 from public.reservations
     where id = v_linked_reservation_id
       and club_id = v_club_id
       and reason = 'pro_lesson'
     for update;
  end if;

  -- Step 4 — lock this lesson's club_settings row THIRD, FOR SHARE (see
  -- this migration's own "LOCK ORDER" header comment for why FOR SHARE,
  -- and for the verified finding that no club_settings-mutating function
  -- locks a domain row first, so this order cannot deadlock). Freezes
  -- cancellation_window_hours (grace is always disabled for lessons
  -- regardless) — a concurrent Admin update_club_settings now blocks
  -- until this transaction commits or rolls back. Uses v_club_id already
  -- resolved from the locked lesson_requests row in step 2, never a
  -- client-supplied club id. A club with no club_settings row locks
  -- nothing here (harmless no-op) — see "MISSING club_settings ROW"
  -- above.
  perform 1 from public.club_settings
   where club_id = v_club_id
   for share;

  -- Step 5 — re-run the FULL authoritative preview, now reading the
  -- locked, frozen lesson_requests row, linked reservation (when
  -- applicable), and club_settings row. This is the comparison that
  -- actually matters.
  select state into v_final_state
    from public.preview_member_lesson_cancellation_policy(p_request_id);

  if v_final_state is distinct from p_expected_policy_state then
    raise exception 'cancellation_policy_changed';
  end if;

  -- Step 6 — delegate to the existing, unmodified cancel_lesson. Its own
  -- FOR UPDATE calls and plain club_settings SELECT re-read the SAME rows
  -- this wrapper already holds locked (same transaction, same order — a
  -- no-op re-lock/stable re-read, not a new race window) — the exact
  -- content step 5 just validated.
  return public.cancel_lesson(p_request_id, p_reason);
end;
$$;

revoke execute on function public.cancel_member_lesson_confirmed(uuid, text, text) from public, anon;
grant  execute on function public.cancel_member_lesson_confirmed(uuid, text, text) to authenticated;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration is
-- created in this checkpoint)
-- ═══════════════════════════════════════════════════════════════════════════
-- All four objects are new and drop-safe independently, in any order,
-- once nothing calls them:
--   drop function if exists public.cancel_member_lesson_confirmed(uuid, text, text);
--   drop function if exists public.cancel_member_reservation_confirmed(uuid, uuid, text);
--   drop function if exists public.preview_member_lesson_cancellation_policy(uuid);
--   drop function if exists public.preview_member_reservation_cancellation_policy(uuid, uuid);
--
-- Data impact: none. Every function here is read-only or a pure
-- delegating wrapper — no table is written to directly by anything in
-- this migration. cancel_member_reservation/cancel_lesson themselves are
-- completely untouched (not redefined) by this migration.
