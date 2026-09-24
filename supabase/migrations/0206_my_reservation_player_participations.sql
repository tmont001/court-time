-- 0206_my_reservation_player_participations.sql
-- Phase 39C-2A — My Reservation Participation Read Foundation.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
-- 39C-2 (Open Games discovery + instant join/leave + My Schedule) needs one
-- capability none of the existing Phase 39B-2 (0204/0205) RPCs provide:
-- "which reservations is the current user an active player on, that they
-- did not book themselves." reservation_participants has zero client-
-- facing RLS policies and zero direct table grants (0178) — a Server
-- Component cannot read it directly no matter how the query is written, so
-- this is a genuine new read need, not a wiring gap. This migration adds
-- exactly one new RPC for exactly that purpose. It does not touch
-- discovery, join, leave, or any owner-control RPC, and does not modify
-- 0001-0205.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- CRITICAL IDENTITY / LEAVE INVARIANT (locked correction to the 39C-2
-- audit)
-- ═══════════════════════════════════════════════════════════════════════════
-- This read uses claim continuity (current_user_roster_member_id()) but
-- does NOT require CURRENT participation eligibility. Discovery and Join
-- require an active, eligible roster identity — Existing participation and
-- Leave deliberately do not. leave_reservation_participation (0204) has no
-- member_self_service capability gate and no roster_members.status/
-- removed_at check at all — this read preserves that exact same escape-path
-- model, so a player who joined while eligible never loses their durable
-- My Schedule Leave surface merely because the club later disables
-- member_self_service or their own roster membership later becomes
-- inactive/removed. Concretely, this function:
--   - DOES call current_user_roster_member_id() (claim continuity: which
--     roster identity is this caller).
--   - Does NOT call current_club_has_capability('member_self_service').
--   - Does NOT read or filter on roster_members.status/removed_at for the
--     CALLER's own identity at all.
-- If no claimed roster identity exists at all, raises roster_identity_
-- required — there is no roster_member_id to look up participations
-- against, which is a structural precondition, not an eligibility check.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- SEARCH-STATE INDEPENDENCE (locked)
-- ═══════════════════════════════════════════════════════════════════════════
-- This function never reads or joins reservation_player_searches and never
-- depends on is_open/effective_is_open/player_capacity/remaining_spots.
-- Participation, once it exists as an active reservation_participants row,
-- is entirely independent of whether Looking-for-Players remains open —
-- an owner turning LFP off, a stale-host reassignment, or a legacy-
-- guest_names conflict must never make an existing participant vanish
-- from My Schedule or lose their ability to Leave. The only source of
-- truth for "am I still a player on this reservation" is reservation_
-- participants.status = 'active' itself.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- CURRENT-HOST EXCLUSION
-- ═══════════════════════════════════════════════════════════════════════════
-- A reservation reassignment (admin_reassign / update_member_reservation's
-- own roster_member_id change) can leave a stale reservation_participants
-- row naming a roster identity that is now the reservation's OWN host. That
-- must never render as "You joined" or expose a Leave action the backend
-- would correctly reject (leave_reservation_participation's own
-- reservation_player_search_host_cannot_leave-equivalent host check) — so
-- every returned row is explicitly filtered against the reservation's
-- CURRENT roster_member_id, not any historical value.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- PRE-IMPLEMENTATION VERIFY — CURRENT LIVE DEFINITIONS (re-read directly):
-- ═══════════════════════════════════════════════════════════════════════════
--   - current_user_club_id() / current_user_role() — single definitions,
--     0082 (APPLIED), never redefined since.
--   - current_user_roster_member_id() — single definition, 0110 (APPLIED),
--     never redefined since. `select id from roster_members where club_id
--     = current_user_club_id() and claimed_by = auth.uid()` — inherently
--     a CLAIMED-account requirement; does NOT itself filter status/
--     removed_at, which is exactly why it is safe to use here without any
--     additional eligibility check layered on top (unlike
--     get_open_reservation_player_searches/join_reservation_player_search
--     in 0204, which deliberately DO add that check for their own,
--     different, eligibility-gated purpose).
--   - reservation_participants (0178, APPLIED): id/reservation_id/
--     roster_member_id/status ('active'|'removed')/removed_at/removed_by/
--     added_by/created_at/updated_at. RLS enabled, zero client policies,
--     zero grants — confirmed unchanged through 0204/0205. This migration
--     adds no policy/grant to it directly; the only access surface remains
--     the SECURITY DEFINER RPC layer.
--   - reservations (0003, altered through 0200): id/club_id/court_id/
--     owner_user_id/roster_member_id/starts_at/ends_at/status/reason/
--     format. roster_member_id nullable at the column level; 0108's own
--     trigger enforces it non-null for reason='member_booking' via the
--     normal write paths, but this function does not assume that and
--     instead uses a LEFT JOIN to roster_members with the same 'Unknown'
--     display-name fallback used elsewhere, so a genuinely anomalous null
--     host never causes a row to silently vanish from the result set.
--   - courts (0001): id/club_id/name.
--   - roster_members (0056, altered 0107/0117/0131): id/club_id/
--     first_name/last_name/status/removed_at/claimed_by.
--   - Display-name fallback convention (0117/0118/0179, get_reservation_
--     roster/get_open_reservation_player_searches): `coalesce(nullif(trim(
--     concat_ws(' ', first_name, last_name)), ''), 'Unknown')::text` —
--     reused verbatim.
--   - Transaction convention: begin;/commit; wrapping the whole file
--     (0126, 0150, 0176-0179, 0203-0204). Followed below.
--
-- Not applied by this checkpoint. Not committed. Does not modify 0001-0205.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- get_my_reservation_player_participations — the current authenticated
-- player's existing joined reservation participations, for My Schedule.
-- Read-only, mutates nothing. Returns one row per reservation where the
-- caller has an ACTIVE reservation_participants row, the reservation is
-- same-club, member_booking, confirmed, and future, and the caller is NOT
-- the reservation's current host. Ordered by starts_at ascending, matching
-- My Schedule's own existing reservation-list ordering convention.
create or replace function public.get_my_reservation_player_participations(
  p_expected_club_id uuid
)
returns table (
  reservation_id     uuid,
  court_id           uuid,
  court_name         text,
  starts_at          timestamptz,
  ends_at            timestamptz,
  format             text,
  host_display_name  text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id          uuid;
  v_caller_roster_id uuid;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;

  v_club_id := public.current_user_club_id();
  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;

  -- Claim continuity only — deliberately NOT an eligibility check. See the
  -- CRITICAL IDENTITY / LEAVE INVARIANT header above: no capability call,
  -- no roster_members.status/removed_at check on the caller's own
  -- identity. A missing claimed identity is a structural precondition
  -- (there is no roster_member_id to look up participations against), not
  -- an eligibility rejection.
  v_caller_roster_id := public.current_user_roster_member_id();
  if v_caller_roster_id is null then raise exception 'roster_identity_required'; end if;

  return query
    select
      r.id,
      c.id,
      c.name,
      r.starts_at,
      r.ends_at,
      r.format,
      coalesce(nullif(trim(concat_ws(' ', hrm.first_name, hrm.last_name)), ''), 'Unknown')::text
    from public.reservation_participants rp
    join public.reservations       r   on r.id      = rp.reservation_id
    join public.courts             c   on c.id      = r.court_id
    left join public.roster_members hrm on hrm.id    = r.roster_member_id
   where rp.roster_member_id = v_caller_roster_id
     and rp.status            = 'active'
     and r.club_id            = v_club_id
     and r.reason             = 'member_booking'
     and r.status              = 'confirmed'
     and r.starts_at           > now()
     -- Current-host exclusion — see header. Compares against the
     -- reservation's CURRENT roster_member_id, never a historical/search
     -- snapshot (this function never reads reservation_player_searches at
     -- all). IS DISTINCT FROM, not <> — plain <> against a NULL
     -- roster_member_id evaluates to NULL in Postgres, which the WHERE
     -- clause treats as false and silently drops the row. A genuinely
     -- anomalous NULL current host is not the caller by definition, so it
     -- must be INCLUDED (with host_display_name falling back to
     -- 'Unknown' via the LEFT JOIN above) — IS DISTINCT FROM evaluates
     -- NULL IS DISTINCT FROM <v_caller_roster_id, non-null> as true,
     -- giving exactly that inclusion, while still correctly excluding the
     -- true positive (current host = caller, both non-null → not
     -- distinct → excluded).
     and r.roster_member_id is distinct from v_caller_roster_id
   order by r.starts_at asc;
end;
$$;

revoke execute on function public.get_my_reservation_player_participations(uuid) from public, anon;
grant  execute on function public.get_my_reservation_player_participations(uuid) to authenticated;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration created in
-- this checkpoint). Purely additive — nothing else depends on it yet.
-- ═══════════════════════════════════════════════════════════════════════════
--   drop function if exists public.get_my_reservation_player_participations(uuid);
