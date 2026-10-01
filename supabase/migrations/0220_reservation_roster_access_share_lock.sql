-- 0220_reservation_roster_access_share_lock.sql
-- Phase 45E4 — closes the proven P2 from the Phase 45E4 concurrency audit:
-- public._authorize_reservation_roster_access(uuid, uuid, boolean) read the
-- target reservation with a plain, UNLOCKED SELECT. A concurrent
-- admin/staff host reassignment (update_member_reservation, which holds
-- reservations ... FOR UPDATE for the duration of its transaction) could
-- commit a NEW roster_member_id while this unlocked read still returned
-- the OLD (stale) one. The sole exploitable consumer of that staleness is
-- add_reservation_participant's host-exemption branch
-- (`if p_roster_member_id <> v_reservation.roster_member_id then
-- [acquire the LFP scope/search-row locks and run the capacity check]
-- end if;`) — a stale match against the OLD host lets a caller add that
-- former host as a plain participant with the entire capacity-check/lock
-- sequence silently skipped.
--
-- LIVE VERIFICATION (performed fresh this checkpoint): pulled
-- pg_get_functiondef + owner/prosecdef/search_path/proacl for
-- _authorize_reservation_roster_access — unchanged from the Phase 45E4
-- audit's own captured text. owner postgres, SECURITY DEFINER,
-- search_path = public, pg_temp, proacl {postgres=X, service_role=X} — no
-- PUBLIC, no anon, no authenticated, matching the established internal-
-- helper convention exactly (it is never intended as a client-facing RPC,
-- despite being called by many client-facing RPCs).
--
-- EXHAUSTIVE SUPPLEMENTAL LOCK-ORDER VERIFICATION (performed fresh this
-- checkpoint, database-wide, not sampled): queried every live function in
-- the public schema for (a) any FOR UPDATE/FOR SHARE/FOR NO KEY UPDATE/
-- FOR KEY SHARE lock on reservations, and (b) any call to
-- _lock_reservation_player_search_scope/_lock_reservation_player_search_row
-- or direct FOR UPDATE/FOR SHARE on reservation_player_searches, plus the
-- complete live trigger set on reservations/reservation_player_searches/
-- reservation_participants/reservation_guests.
--
-- Result: public.update_member_reservation is the ONLY live function that
-- ever acquires `reservations ... FOR UPDATE` anywhere in the schema.
-- Every OTHER function that locks reservations (lesson/event/program/
-- cancellation functions — accept_lesson_proposal, cancel_lesson,
-- cancel_event, propose_lesson_time, and a dozen others) never touches
-- reservation_player_searches, reservation_participants, or the scope/
-- search-row lock helpers at all — they operate on reservations with a
-- different `reason` (pro_lesson/event/maintenance), which the LFP domain
-- triggers (enforce_reservation_participant_domain,
-- enforce_reservation_player_search_domain, both requiring
-- reason = 'member_booking' via _lock_and_validate_reservation_roster_
-- mutable) structurally cannot apply to.
--
-- The COMPLETE set of functions that acquire BOTH a reservations lock AND
-- an LFP-domain lock (scope advisory lock, search-row FOR UPDATE, or a
-- domain trigger that locks reservations) is exactly: add_reservation_
-- participant, add_reservation_guest (via enforce_reservation_guest_
-- domain), set_reservation_player_search, clear_reservation_player_search,
-- remove_reservation_participant, remove_reservation_guest, join_
-- reservation_player_search, and leave_reservation_participation. In
-- EVERY one of these, the reservation lock is ALWAYS FOR SHARE — never
-- FOR UPDATE. join_reservation_player_search/leave_reservation_
-- participation already acquire it FOR SHARE directly, up front, today;
-- the other six acquire it only via their respective domain trigger
-- (FOR SHARE), AFTER their own scope/search-row/child-row lock — which
-- this migration's change now ALSO acquires up front (also FOR SHARE, via
-- _authorize_reservation_roster_access), unifying every path onto the
-- same order (reservation FOR SHARE -> scope/search-row lock) that
-- join_reservation_player_search already used.
--
-- DEADLOCK CONCLUSION: a cycle requires two transactions each holding a
-- resource the other needs, with at least one request being exclusive/
-- non-shareable. Since update_member_reservation (the only FOR UPDATE
-- holder anywhere) never requests the scope advisory lock or the search-
-- row lock, and since every LFP-domain-touching function only ever
-- requests the reservation lock in FOR SHARE mode (compatible with any
-- number of simultaneous FOR SHARE holders), no reachable path can form
-- "reservations FOR UPDATE -> LFP lock" bookended against an opposite
-- "LFP lock -> reservations FOR UPDATE/SHARE" path — the only two-sided
-- relationship possible is update_member_reservation's FOR UPDATE request
-- blocking (one-directionally) against any FOR-SHARE holder, which
-- resolves the instant that holder commits. No deadlock is possible
-- before or after this change; the change in fact removes a pre-existing
-- lock-order INCONSISTENCY (six functions previously acquired their
-- reservation FOR SHARE lock only via a late-firing trigger, after already
-- holding scope/search-row locks, while join_reservation_player_search/
-- leave_reservation_participation already acquired it up front) by making
-- every path acquire it up front uniformly.
--
-- THE FIX: append `for share` to _authorize_reservation_roster_access's
-- one SELECT. No other statement changes. Authorization predicates,
-- exception vocabulary, return shape, SECURITY DEFINER, and search_path
-- are all preserved exactly. No caller is redefined — the fix is entirely
-- contained in this single choke-point function, automatically protecting
-- all 11 live callers (add_reservation_participant, remove_reservation_
-- participant, add_reservation_guest, remove_reservation_guest, set_
-- reservation_player_search, clear_reservation_player_search, mint_
-- reservation_guest_waiver_invitation, get_reservation_guest_waiver_
-- compliance, get_reservation_player_search, get_reservation_roster,
-- get_reservation_eligible_roster_members) without touching any of them.
--
-- No table/schema/RLS/policy change. No ACL/GRANT/REVOKE change (CREATE OR
-- REPLACE preserves the existing owner/security/ACL automatically since
-- the signature and return type are unchanged). No change to
-- _lock_and_validate_reservation_roster_mutable, any LFP lock helper, any
-- domain trigger, court constraints, payment/pricing logic, or 0217/0218/
-- 0219.
--
-- Created by this checkpoint. Do NOT apply until reviewed.

begin;

create or replace function public._authorize_reservation_roster_access(p_reservation_id uuid, p_expected_club_id uuid, p_require_not_cancelled boolean)
 RETURNS reservations
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_club_id          uuid;
  v_role             text;
  v_roster_member_id uuid;
  v_reservation      public.reservations%rowtype;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;

  -- Null-safe, explicit allowlist — an unrecognized/null role must never
  -- silently fall through into the ownership-only branch below.
  if v_role is null or v_role not in ('admin', 'staff', 'member', 'pro') then
    raise exception 'insufficient_role';
  end if;

  -- Locked matrix: Member requires member_self_service; Pro does not.
  -- Admin/Staff are never gated by this capability.
  if v_role = 'member' and not public.current_club_has_capability('member_self_service') then
    raise exception 'capability_not_available';
  end if;

  v_roster_member_id := public.current_user_roster_member_id();

  -- Phase 45E4: FOR SHARE — closes the stale-host race where a concurrent
  -- admin/staff host reassignment (update_member_reservation, which holds
  -- reservations FOR UPDATE for its whole transaction) could otherwise
  -- leave this read returning the pre-reassignment roster_member_id.
  -- Blocks only against a genuine exclusive writer; any number of FOR
  -- SHARE readers/writers (including this function's own other callers)
  -- proceed together exactly as before. See this migration's own header
  -- for the full lock-order/deadlock analysis.
  select * into v_reservation
    from public.reservations
   where id      = p_reservation_id
     and club_id = v_club_id
     and (
       v_role in ('admin', 'staff')
       or owner_user_id = auth.uid()
       or (v_roster_member_id is not null and roster_member_id = v_roster_member_id)
     )
   for share;
  if not found then raise exception 'reservation_not_found'; end if;

  if v_reservation.reason <> 'member_booking' then
    raise exception 'reservation_not_participant_eligible';
  end if;

  if p_require_not_cancelled and v_reservation.status = 'cancelled' then
    raise exception 'reservation_roster_locked';
  end if;

  return v_reservation;
end;
$function$;

commit;
