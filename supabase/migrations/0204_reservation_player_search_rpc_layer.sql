-- 0204_reservation_player_search_rpc_layer.sql
-- Phase 39B-2 — Reservation Looking-for-Players RPC / Authorization /
-- Capacity Layer.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
-- 0203 (APPLIED, immutable — not modified by this migration) laid the
-- schema-only foundation: reservation_player_searches, RLS locked to zero
-- client access, and a domain guard enforcing player_capacity against
-- occupied seats ONLY for direct writes to that table. 0203's own header
-- explicitly documented that this alone does not complete the runtime
-- capacity invariant, because add_reservation_participant/
-- add_reservation_guest (0179) remained completely capacity-unaware. This
-- migration closes that gap and adds the full RPC surface: owner/operator
-- search-state management, a privacy-narrow discovery read, instant
-- self-join, and self-leave — all built on the existing
-- reservation_participants/reservation_guests model, zero new tables, zero
-- new participant system.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- PRE-APPLY REVIEW CORRECTIONS (this revision, before any apply)
-- ═══════════════════════════════════════════════════════════════════════════
-- Three corrections made to the first draft of this migration, all before
-- it was ever applied:
--   1. CONCURRENCY GAP — SELECT ... FOR UPDATE against a not-yet-existing
--      reservation_player_searches row is a no-op (nothing to lock), so
--      the original design had no serialization point between a
--      first-time set_reservation_player_search INSERT and a concurrent
--      add_reservation_participant/add_reservation_guest/join racing on
--      the SAME reservation before any search row exists. Fixed with a
--      reservation-scoped transaction advisory lock (Section 1e),
--      acquired by every path that can either CREATE an effective search
--      or INCREASE occupied seats, BEFORE the search-row FOR UPDATE
--      lock — see the CANONICAL LOCK ORDER note below.
--   2. HOST ELIGIBILITY — the original design validated the JOINING/
--      browsing roster identity's eligibility but never the HOST's. A
--      host later deactivated/removed from the roster could leave a
--      stored is_open=true search that discovery/join would still treat
--      as live. Fixed by folding host eligibility (roster_members.
--      status='active' AND removed_at IS NULL — the exact existing
--      semantics from get_reservation_eligible_roster_members, 0179) into
--      the SAME shared effective-open predicate, and by rejecting an
--      inactive/removed host explicitly at open/reopen time. Adds exactly
--      one new block-reason value: 'host_inactive'.
--   3. NOTIFICATION RECIPIENT + PREFERENCE SEMANTICS — the original
--      design used reservations.owner_user_id (which does not track a
--      reassigned/reclaimed roster identity — 0108's own locked model)
--      and incorrectly gated the in-app row behind user_pref_enabled.
--      Corrected: the recipient is always resolved fresh from
--      roster_members.claimed_by for the reservation's CURRENT
--      roster_member_id (never owner_user_id), and the in-app
--      notification is now created UNCONDITIONALLY for a claimed host on
--      a genuine join/leave — user_pref_enabled governs downstream EMAIL
--      delivery preference only (confirmed directly: 0043's own comments
--      on create_reservation/join_event/notify_reservation_cancelled_by_
--      member gate the in-app INSERT itself, which is this schema's own
--      convention for kinds that DO have an email path; 39B-2 adds none,
--      so this migration does not touch notification_preferences_kind_
--      check or update_notification_preference at all). If Phase 44 later
--      adds email/SMS for this kind, preference support can be added
--      then, as its own migration.
-- Everything else from the first draft is unchanged: the guest_names
-- fail-closed decision, the canonical occupied-seat formula, instant join,
-- self-leave, payment non-regression, the discovery privacy aperture,
-- same-club checks, and 0203's own immutability.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- PRE-IMPLEMENTATION FINDING — reservations.guest_names (resolved, not a
-- blocker; see LOCKED RESOLUTION below)
-- ═══════════════════════════════════════════════════════════════════════════
-- Direct re-inspection (not from memory) confirmed reservations.guest_names
-- is NOT legacy: as of the current live definitions of create_reservation/
-- admin_create_member_reservation/update_member_reservation (all last
-- redefined in 0200_court_rate_periods.sql — re-verified directly, not
-- assumed from an earlier 0139/0189 read), all three still accept and
-- persist p_guest_names text[] with zero synchronization to
-- reservation_guests, exactly as 0178's own header already documented. The
-- frontend confirms this is live and reachable today, not dead code:
-- CalendarShell.tsx's operator booking sheet (~line 2484) renders an
-- editable "Guest names (optional, comma-separated)" input wired to
-- admin_create_member_reservation's p_guest_names, and
-- EditReservationSheet.tsx (~line 176) loads/edits the same field via
-- update_member_reservation. This means a member_booking reservation can
-- have real, currently-occupying guests recorded ONLY in guest_names —
-- structurally invisible to the reservation_participants/
-- reservation_guests-based occupied-seat formula this entire feature is
-- built on.
--
-- LOCKED RESOLUTION (product decision, not a schema/sync fix): a
-- reservation with a non-empty guest_names array can never be treated as
-- capacity-safe for Looking-for-Players. This is folded into the SAME
-- effective-open predicate already needed for the stale-host/host-
-- inactive cases (see Section 1) as an additional precondition — never
-- counted toward occupied seats, never synchronized, never silently
-- ignored:
--   - set_reservation_player_search (open/reopen) REJECTS with
--     reservation_has_legacy_guest_names when reservations.guest_names is
--     non-empty.
--   - _reservation_player_search_is_effective_open treats a non-empty
--     guest_names as making the search NOT effectively open, even when
--     the stored row still says is_open = true — exactly like the
--     stale-host/host-inactive cases, this never mutates, deletes, or
--     auto-closes the row. If an operator later clears guest_names back
--     to empty (via the existing, untouched update_member_reservation), a
--     previously-opened search becomes eligible again automatically, the
--     next time its effective state is evaluated, with no action needed
--     on this table.
--   - get_open_reservation_player_searches and join_reservation_player_
--     search both consume the same shared predicate, so both independently
--     fail closed on a legacy-guest_names reservation — never a special
--     case duplicated in either RPC.
--   - get_reservation_player_search surfaces this as
--     effective_open_block_reason = 'legacy_guest_names' for the future
--     39C owner UI. The actual legacy guest names are never returned by
--     this or any other RPC in this migration.
-- update_member_reservation/create_reservation/admin_create_member_
-- reservation and the guest_names free-text field itself are NOT modified
-- by this migration — no normalization, no deprecation, no UI change.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- CANONICAL LOCK ORDER (revised)
-- ═══════════════════════════════════════════════════════════════════════════
--   1. reservation authorization/lock — _authorize_reservation_roster_
--      access or _lock_and_validate_reservation_roster_mutable (0178/
--      0179, both FOR SHARE on reservations, unchanged).
--   2. reservation-scoped advisory transaction lock —
--      _lock_reservation_player_search_scope(p_reservation_id) (Section
--      1e, NEW). Closes the no-search-row race: acquired by every path
--      that can either CREATE an effective search (set_reservation_
--      player_search) or INCREASE occupied seats (add_reservation_
--      participant for a non-host activation, add_reservation_guest,
--      join_reservation_player_search) — BEFORE that path even checks
--      whether a search row exists. Whichever transaction acquires this
--      lock first for a given reservation_id fully completes (commit or
--      rollback) before the other proceeds, so:
--        CASE A — a participant/guest addition wins the lock first: it
--        commits the added seat; a concurrent first-time LFP open then
--        waits, and once it proceeds it sees the now-committed occupancy,
--        which 0203's own domain guard correctly rejects if the requested
--        capacity is now too small.
--        CASE B — a first-time LFP open wins the lock first: it creates
--        the search row; a concurrent participant/guest addition then
--        waits, and once it proceeds it sees the now-existing effective
--        search and enforces capacity against it.
--      Host-participant addition is seat-neutral under the locked formula
--      (the host is already counted as 1, unconditionally) and does NOT
--      acquire this lock — there is no capacity decision to serialize.
--   3. reservation_player_searches row FOR UPDATE (if one exists) —
--      _lock_reservation_player_search_row (Section 1d, unchanged from
--      the first draft). A no-op, no contention, when no row exists yet —
--      safe now that step 2 has already closed the race for that case.
--   4. reservation_participants/reservation_guests row FOR UPDATE.
--   5. occupancy decision (capacity check) / write.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- PRE-IMPLEMENTATION VERIFY — CURRENT LIVE DEFINITIONS (re-read directly,
-- not copied from an earlier/superseded migration):
-- ═══════════════════════════════════════════════════════════════════════════
--   - _lock_and_validate_reservation_roster_mutable(uuid) — single
--     definition, 0178 (APPLIED), never redefined since. FOR SHARE lock,
--     raises reservation_not_found / reservation_not_participant_eligible
--     (reason <> 'member_booking') / reservation_roster_locked (status =
--     'cancelled'). Reused verbatim throughout this migration — never
--     reimplemented.
--   - _authorize_reservation_roster_access(uuid, uuid, boolean) — single
--     definition, 0179 (APPLIED), never redefined since. Owner
--     (claim-continuity: owner_user_id OR current_user_roster_member_id())
--     or Admin/Staff (bypass ownership), same-club, member_self_service
--     required for role='member' only (never Pro, never Admin/Staff),
--     reason='member_booking', optionally not-cancelled. Reused verbatim
--     for set/clear/get_reservation_player_search's ownership/role gate.
--   - get_reservation_roster / get_reservation_eligible_roster_members /
--     add_reservation_participant / remove_reservation_participant /
--     add_reservation_guest / remove_reservation_guest — single
--     definitions, all 0179 (APPLIED), never redefined since.
--     get_reservation_eligible_roster_members's own eligibility predicate
--     ("currently active" requires BOTH rm.status = 'active' AND
--     rm.removed_at IS NULL) is the exact semantics reused for host
--     eligibility below — not a new invention. Two RPCs (add_reservation_
--     participant, add_reservation_guest) are CREATE OR REPLACE'd below
--     with the CURRENT 0179 body preserved byte-for-byte except for the
--     new capacity-guard/scope-lock insertions documented at each site.
--     remove_reservation_participant/remove_reservation_guest are NOT
--     touched — removal only ever decreases occupancy, never needs a
--     capacity ceiling.
--   - current_user_roster_member_id() — single definition, 0110
--     (APPLIED), never redefined since. `select id from roster_members
--     where club_id = current_user_club_id() and claimed_by = auth.uid()`
--     — inherently a CLAIMED-account requirement. Does NOT itself filter
--     status/removed_at — every call site in this migration that uses it
--     separately re-checks status='active' AND removed_at IS NULL.
--   - current_club_has_capability(text) / club_has_capability(uuid, text)
--     — single definitions, 0122 (APPLIED), never redefined since.
--     current_club_has_capability is fail-closed (null club -> false,
--     never an error) and the only client-reachable entry point; reused
--     verbatim.
--   - pg_advisory_xact_lock(bigint) / hashtextextended(text, bigint) —
--     both built-in Postgres functions (hashtextextended available since
--     PG 11), already the established transaction-scoped serialization
--     idiom in this exact schema — confirmed by direct re-read of 0126
--     (`pg_advisory_xact_lock(hashtextextended(p_roster_member_id::text,
--     0))`, bare key), 0143/0149/0164 (`pg_advisory_xact_lock(hashtext
--     extended(p_domain_type || ':' || p_domain_id::text, 0))` /
--     `'club_commercial_tier:' || p_club_id::text`, NAMESPACED key). This
--     migration follows the namespaced form — 'reservation_player_
--     search:' || p_reservation_id::text — to avoid ever colliding with a
--     bare-uuid advisory lock keyed on the same reservation_id for an
--     unrelated purpose. Transaction-scoped: released automatically at
--     COMMIT/ROLLBACK, never unlocked early — held through the entire
--     mutation that follows, not just through the acquiring statement,
--     matching 0126's own documented behavior exactly.
--   - notifications_kind_check — latest real ALTER is 0197 (APPLIED,
--     confirmed no later migration through 0202 touches it). 21 kinds
--     currently allowed, reproduced verbatim below with
--     'reservation_player_activity' appended as the 22nd — none removed,
--     none reordered. notification_preferences_kind_check and
--     update_notification_preference are NOT touched by this migration at
--     all (see PRE-APPLY REVIEW CORRECTIONS, item 3) — 39B-2 adds no
--     email/SMS delivery path for this kind.
--   - roster_members (0056, altered 0107/0117/0131): status text check
--     ('active','inactive'), default 'active' (0117); removed_at/
--     removed_by added 0117; claimed_by uuid unique references
--     auth.users(id) on delete set null (0056) — the FK this migration
--     resolves the notification recipient through.
--   - audit_log convention — every reservation-domain RPC in this schema
--     uses `insert into audit_log (club_id, actor_id, action, target_type,
--     target_id, metadata) values (...)` with target_type = 'reservation'.
--     Reused verbatim for every new audit row below.
--   - courts (0001): id/club_id/name — used only for the discovery read's
--     court_name column.
--   - Transaction convention: begin;/commit; wrapping the whole file
--     (0126, 0150, 0176-0179, 0203). Followed below.
--
-- Not applied by this checkpoint. Not committed. Does not modify 0001-0203.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 1 — Shared effective-open / capacity / locking helpers
-- ═══════════════════════════════════════════════════════════════════════════
-- Five private helpers, EXECUTE revoked from public/anon/authenticated,
-- called only from the public RPCs below (and from each other) — the
-- single canonical implementation every capacity-increasing path and every
-- read RPC in this migration shares, so there is exactly ONE place the
-- occupied-seat formula, the effective-open predicate, and the
-- serialization primitive are ever written.
--
-- "Effective open" is deliberately narrower than the stored is_open
-- column. A stored is_open=true row imposes the player_capacity ceiling
-- ONLY when it is also:
--   - host-current:   search.host_roster_member_id = reservation.
--                      roster_member_id (0203's own locked correction — a
--                      reservation reassignment can leave an old row
--                      is_open=true with a stale host).
--   - host-eligible:   the CURRENT host's roster_members row is
--                      status='active' AND removed_at IS NULL — the exact
--                      existing eligibility semantics from get_
--                      reservation_eligible_roster_members (0179), not a
--                      new membership/rating/status system.
--   - reservation-eligible: reason='member_booking', status='confirmed',
--                      starts_at > now().
--   - capability-available: club_has_capability(club_id,
--                      'member_self_service') — club-wide, not
--                      caller-specific.
--   - guest_names-clean: reservations.guest_names is null/empty (see the
--                      PRE-IMPLEMENTATION FINDING above).
-- Any row failing one of these is simply inert: undiscoverable, unjoinable,
-- imposes no capacity ceiling on ordinary roster operations — but is NEVER
-- mutated, deleted, or auto-closed by these helpers. Only an explicit
-- clear_reservation_player_search or set_reservation_player_search call
-- ever changes the stored row.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1a. _reservation_player_search_is_effective_open — pure predicate, no
-- locking. Takes already-fetched rows so it is equally usable inside a
-- locked mutation flow and inside a plain read/discovery query without
-- re-querying the reservation/search rows. p_search with a null id is
-- treated as "no search" — always not effectively open. Host eligibility
-- is resolved via its own internal EXISTS subquery (not a third
-- parameter) so every existing call site inherits it automatically with
-- no signature change.
create or replace function public._reservation_player_search_is_effective_open(
  p_reservation public.reservations,
  p_search      public.reservation_player_searches
)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select
    p_search.id is not null
    and p_search.is_open
    and p_search.host_roster_member_id = p_reservation.roster_member_id
    and p_reservation.reason     = 'member_booking'
    and p_reservation.status     = 'confirmed'
    and p_reservation.starts_at  > now()
    and (p_reservation.guest_names is null or array_length(p_reservation.guest_names, 1) is null)
    and public.club_has_capability(p_reservation.club_id, 'member_self_service')
    and exists (
      select 1
        from public.roster_members rm
       where rm.id         = p_reservation.roster_member_id
         and rm.status      = 'active'
         and rm.removed_at is null
    );
$$;

revoke execute on function public._reservation_player_search_is_effective_open(public.reservations, public.reservation_player_searches)
  from public, anon, authenticated;

-- 1b. _reservation_player_search_block_reason — deliberately narrow
-- taxonomy: only 'stale_host', 'host_inactive', and 'legacy_guest_names'
-- are ever returned. Every other reason a row is not effectively open
-- (closed, no search, reservation cancelled/past/non-member_booking,
-- capability disabled) collapses to null — not a generic state engine,
-- only the conditions an owner can actually act on. host_inactive is
-- checked only once staleness is ruled out (a stale host's own eligibility
-- is irrelevant — it isn't the current host).
create or replace function public._reservation_player_search_block_reason(
  p_reservation public.reservations,
  p_search      public.reservation_player_searches
)
returns text
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select case
    when p_search.id is null or not p_search.is_open then null
    when p_search.host_roster_member_id is distinct from p_reservation.roster_member_id then 'stale_host'
    when not exists (
      select 1
        from public.roster_members rm
       where rm.id         = p_reservation.roster_member_id
         and rm.status      = 'active'
         and rm.removed_at is null
    ) then 'host_inactive'
    when p_reservation.guest_names is not null and array_length(p_reservation.guest_names, 1) is not null then 'legacy_guest_names'
    else null
  end;
$$;

revoke execute on function public._reservation_player_search_block_reason(public.reservations, public.reservation_player_searches)
  from public, anon, authenticated;

-- 1c. _reservation_player_search_occupied_seats — the canonical formula,
-- identical in substance to 0203's own (already-applied, immutable)
-- domain-guard calculation: 1 (host) + active reservation_participants
-- EXCLUDING the host's own roster_member_id + active reservation_guests.
create or replace function public._reservation_player_search_occupied_seats(
  p_reservation_id        uuid,
  p_host_roster_member_id uuid
)
returns int
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select
    1
    + (select count(*)
         from public.reservation_participants
        where reservation_id   = p_reservation_id
          and status            = 'active'
          and roster_member_id <> p_host_roster_member_id)
    + (select count(*)
         from public.reservation_guests
        where reservation_id = p_reservation_id
          and status          = 'active');
$$;

revoke execute on function public._reservation_player_search_occupied_seats(uuid, uuid)
  from public, anon, authenticated;

-- 1d. _lock_reservation_player_search_row — locks the search row FOR
-- UPDATE if one exists (a no-op, no contention, if none does). Must only
-- ever be called AFTER _lock_reservation_player_search_scope (Section 1e)
-- has already been acquired by a capacity-increasing path — see the
-- CANONICAL LOCK ORDER note above. Pure locking only — no decision, no
-- exception.
create or replace function public._lock_reservation_player_search_row(
  p_reservation_id uuid
)
returns public.reservation_player_searches
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_search public.reservation_player_searches%rowtype;
begin
  select * into v_search
    from public.reservation_player_searches
   where reservation_id = p_reservation_id
   for update;

  return v_search;
end;
$$;

revoke execute on function public._lock_reservation_player_search_row(uuid)
  from public, anon, authenticated;

-- 1e. _lock_reservation_player_search_scope — NEW (pre-apply correction
-- 1). Closes the race a plain SELECT ... FOR UPDATE cannot: a
-- reservation_player_searches row that does not exist YET has nothing to
-- lock, so two transactions that can each either create the effective
-- search (set_reservation_player_search) or add a seat-consuming row
-- (add_reservation_participant for a non-host, add_reservation_guest,
-- join_reservation_player_search) could otherwise both observe "no search
-- row" and proceed without ever serializing against each other. A
-- transaction-scoped Postgres advisory lock, keyed deterministically from
-- reservation_id, exists independently of any row — acquiring it is the
-- first serialization point, before either side even checks for row
-- existence. Namespaced key (not a bare uuid) — see PRE-IMPLEMENTATION
-- VERIFY above for why. pg_advisory_xact_lock releases automatically at
-- COMMIT/ROLLBACK; never unlocked early, so it is held through the entire
-- mutation that follows this call, not merely through this statement.
create or replace function public._lock_reservation_player_search_scope(
  p_reservation_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('reservation_player_search:' || p_reservation_id::text, 0));
end;
$$;

revoke execute on function public._lock_reservation_player_search_scope(uuid)
  from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 2 — Harden the existing roster-add mutation paths (0179)
-- ═══════════════════════════════════════════════════════════════════════════
-- CREATE OR REPLACE only. Every existing authorization check, error, audit
-- row, and behavior for a non-effective-open reservation is preserved
-- byte-for-byte — the capacity guard below is purely additive and is a
-- complete no-op whenever no effective open search exists.
-- ═══════════════════════════════════════════════════════════════════════════

-- 2a. add_reservation_participant — a host being added never consumes a
-- seat under the locked formula, so the scope lock, search-row lock, and
-- capacity check are all skipped entirely when p_roster_member_id = the
-- reservation's own host — identical to 0179's existing behavior for that
-- case. For any OTHER roster identity, the scope lock (Section 1e) is
-- acquired FIRST — closing the no-search-row race — then the search-row
-- lock, then the capacity gate applies only to a GENUINE activation (a
-- fresh insert, or a reactivation of a previously removed row); the
-- existing idempotent "already active" branch exits before either lock or
-- the capacity check is ever reached.
create or replace function public.add_reservation_participant(
  p_reservation_id   uuid,
  p_expected_club_id uuid,
  p_roster_member_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reservation    public.reservations%rowtype;
  v_roster         public.roster_members%rowtype;
  v_search         public.reservation_player_searches%rowtype;
  v_existing       public.reservation_participants%rowtype;
  v_existing_found boolean;
  v_result         public.reservation_participants%rowtype;
  v_reactivated    boolean := false;
  v_occupied       int;
begin
  v_reservation := public._authorize_reservation_roster_access(p_reservation_id, p_expected_club_id, true);

  if p_roster_member_id is null then raise exception 'roster_identity_required'; end if;

  select * into v_roster
    from public.roster_members
   where id      = p_roster_member_id
     and club_id = v_reservation.club_id;
  if not found then raise exception 'roster_member_not_found'; end if;

  if v_roster.status is distinct from 'active' or v_roster.removed_at is not null then
    raise exception 'roster_member_inactive';
  end if;

  -- Canonical lock order: scope lock, THEN search-row lock — skipped
  -- entirely for the host, who never consumes a seat.
  if p_roster_member_id <> v_reservation.roster_member_id then
    perform public._lock_reservation_player_search_scope(p_reservation_id);
    v_search := public._lock_reservation_player_search_row(p_reservation_id);
  end if;

  loop
    select * into v_existing
      from public.reservation_participants
     where reservation_id   = p_reservation_id
       and roster_member_id = p_roster_member_id
     for update;
    v_existing_found := found;

    if v_existing_found then
      if v_existing.status = 'active' then
        v_result := v_existing;
        exit;
      end if;

      -- Genuine reactivation of a non-host participant.
      if p_roster_member_id <> v_reservation.roster_member_id
         and public._reservation_player_search_is_effective_open(v_reservation, v_search)
      then
        v_occupied := public._reservation_player_search_occupied_seats(p_reservation_id, v_search.host_roster_member_id);
        if v_occupied + 1 > v_search.player_capacity then
          raise exception 'reservation_player_search_full';
        end if;
      end if;

      update public.reservation_participants
         set status     = 'active',
             removed_at = null,
             removed_by = null,
             added_by   = auth.uid(),
             updated_at = now()
       where id = v_existing.id
      returning * into v_result;

      v_reactivated := true;
      exit;
    else
      -- Genuine first-time activation of a non-host participant.
      if p_roster_member_id <> v_reservation.roster_member_id
         and public._reservation_player_search_is_effective_open(v_reservation, v_search)
      then
        v_occupied := public._reservation_player_search_occupied_seats(p_reservation_id, v_search.host_roster_member_id);
        if v_occupied + 1 > v_search.player_capacity then
          raise exception 'reservation_player_search_full';
        end if;
      end if;

      begin
        insert into public.reservation_participants (reservation_id, roster_member_id, added_by)
        values (p_reservation_id, p_roster_member_id, auth.uid())
        returning * into v_result;
        exit;
      exception when unique_violation then
        continue;
      end;
    end if;
  end loop;

  if v_result.id is null then
    raise exception 'reservation_participant_write_failed';
  end if;

  if v_reactivated or not v_existing_found then
    insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
    values (
      v_reservation.club_id,
      auth.uid(),
      case when v_reactivated then 'reactivate_reservation_participant' else 'add_reservation_participant' end,
      'reservation',
      p_reservation_id,
      jsonb_build_object(
        'participant_id',   v_result.id,
        'roster_member_id', p_roster_member_id
      )
    );
  end if;

  return v_result.id;
end;
$$;

revoke execute on function public.add_reservation_participant(uuid, uuid, uuid) from public, anon;
grant  execute on function public.add_reservation_participant(uuid, uuid, uuid) to authenticated;

-- 2b. add_reservation_guest — every valid call always creates a brand-new
-- row (confirmed by direct inspection of the current 0179 body: there is
-- no SELECT-existing/reactivation branch for guests at all), so the scope
-- lock and capacity gate apply unconditionally to every call, with no host
-- exemption (a guest can never be the host).
create or replace function public.add_reservation_guest(
  p_reservation_id   uuid,
  p_expected_club_id uuid,
  p_display_name     text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reservation  public.reservations%rowtype;
  v_search       public.reservation_player_searches%rowtype;
  v_display_name text;
  v_occupied     int;
  v_result       public.reservation_guests%rowtype;
begin
  v_reservation := public._authorize_reservation_roster_access(p_reservation_id, p_expected_club_id, true);

  v_display_name := btrim(p_display_name);

  if v_display_name is null or char_length(v_display_name) < 1 then
    raise exception 'guest_display_name_required';
  end if;

  if char_length(v_display_name) > 100 then
    raise exception 'guest_display_name_too_long';
  end if;

  -- Canonical lock order: scope lock, THEN search-row lock.
  perform public._lock_reservation_player_search_scope(p_reservation_id);
  v_search := public._lock_reservation_player_search_row(p_reservation_id);

  if public._reservation_player_search_is_effective_open(v_reservation, v_search) then
    v_occupied := public._reservation_player_search_occupied_seats(p_reservation_id, v_search.host_roster_member_id);
    if v_occupied + 1 > v_search.player_capacity then
      raise exception 'reservation_player_search_full';
    end if;
  end if;

  insert into public.reservation_guests (reservation_id, display_name, added_by)
  values (p_reservation_id, v_display_name, auth.uid())
  returning * into v_result;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_reservation.club_id,
    auth.uid(),
    'add_reservation_guest',
    'reservation',
    p_reservation_id,
    jsonb_build_object('guest_id', v_result.id)
  );

  return v_result.id;
end;
$$;

revoke execute on function public.add_reservation_guest(uuid, uuid, text) from public, anon;
grant  execute on function public.add_reservation_guest(uuid, uuid, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 3 — Owner/operator search-state RPCs
-- ═══════════════════════════════════════════════════════════════════════════

-- 3a. set_reservation_player_search — open OR update/reopen. The caller
-- never supplies host_roster_member_id; it is always derived server-side
-- from the reservation's CURRENT roster_member_id. Pre-apply correction 2:
-- explicitly rejects an inactive/removed current host (roster_member_
-- inactive — the existing, established error code) before ever writing a
-- row — an owner cannot open Looking-for-Players snapshotting a host
-- identity that is not currently eligible. Pre-apply correction 1: the
-- scope lock (Section 1e) is acquired immediately before the search-row
-- select, closing the no-search-row race against a concurrent add_
-- reservation_participant/add_reservation_guest/join on the same
-- reservation. Capacity-vs-current-occupancy is still enforced by 0203's
-- own domain guard on the INSERT/UPDATE below — not recomputed here.
create or replace function public.set_reservation_player_search(
  p_reservation_id   uuid,
  p_expected_club_id uuid,
  p_player_capacity  int
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reservation    public.reservations%rowtype;
  v_host_roster    public.roster_members%rowtype;
  v_existing       public.reservation_player_searches%rowtype;
  v_existing_found boolean;
  v_result         public.reservation_player_searches%rowtype;
begin
  -- Owner (claim-continuity) or Admin/Staff, same-club, not-cancelled,
  -- member_booking only — the exact gate 0179 already established for the
  -- roster surface this feature extends.
  v_reservation := public._authorize_reservation_roster_access(p_reservation_id, p_expected_club_id, true);

  -- Locked Phase 39B-2 rule: opening/reopening requires member_self_service
  -- club-wide, INCLUDING when invoked by an operator.
  if not public.current_club_has_capability('member_self_service') then
    raise exception 'capability_not_available';
  end if;

  if v_reservation.status <> 'confirmed' then
    raise exception 'reservation_not_confirmed';
  end if;

  if v_reservation.starts_at <= now() then
    raise exception 'reservation_already_started';
  end if;

  if v_reservation.roster_member_id is null then
    raise exception 'roster_identity_required';
  end if;

  -- Pre-apply correction 2: the CURRENT host roster identity must itself
  -- be eligible — the exact same status/removed_at semantics
  -- get_reservation_eligible_roster_members already establishes (0179),
  -- not a new membership/rating/status system.
  select * into v_host_roster
    from public.roster_members
   where id = v_reservation.roster_member_id;

  if v_host_roster.status is distinct from 'active' or v_host_roster.removed_at is not null then
    raise exception 'roster_member_inactive';
  end if;

  -- Pre-implementation finding: a reservation using the legacy free-text
  -- guest_names field can never open/reopen Looking-for-Players.
  if v_reservation.guest_names is not null and array_length(v_reservation.guest_names, 1) is not null then
    raise exception 'reservation_has_legacy_guest_names';
  end if;

  if p_player_capacity is null or p_player_capacity < 2 or p_player_capacity > 8 then
    raise exception 'reservation_player_capacity_out_of_range';
  end if;

  -- Pre-apply correction 1: acquire the reservation-scoped advisory lock
  -- BEFORE checking whether a search row exists — this is what makes a
  -- concurrent first-time open and a concurrent add_reservation_
  -- participant/add_reservation_guest/join on the same reservation
  -- serialize correctly instead of both racing against a nonexistent row.
  perform public._lock_reservation_player_search_scope(p_reservation_id);

  select * into v_existing
    from public.reservation_player_searches
   where reservation_id = p_reservation_id
   for update;
  v_existing_found := found;

  if v_existing_found then
    update public.reservation_player_searches
       set host_roster_member_id = v_reservation.roster_member_id,
           player_capacity       = p_player_capacity,
           is_open               = true
     where id = v_existing.id
    returning * into v_result;
  else
    insert into public.reservation_player_searches (
      reservation_id, host_roster_member_id, player_capacity, is_open, created_by
    ) values (
      p_reservation_id, v_reservation.roster_member_id, p_player_capacity, true, auth.uid()
    )
    returning * into v_result;
  end if;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_reservation.club_id,
    auth.uid(),
    'set_reservation_player_search',
    'reservation',
    p_reservation_id,
    jsonb_build_object(
      'player_search_id', v_result.id,
      'player_capacity',  p_player_capacity,
      'was_existing',     v_existing_found
    )
  );

  return v_result.id;
end;
$$;

revoke execute on function public.set_reservation_player_search(uuid, uuid, int) from public, anon;
grant  execute on function public.set_reservation_player_search(uuid, uuid, int) to authenticated;

-- 3b. clear_reservation_player_search — is_open=false only. Never deletes,
-- never touches participants/guests, never rewrites host_roster_member_id.
-- Deliberately does NOT require member_self_service or host eligibility:
-- an Admin/Staff must be able to clear a stale OR host-inactive search, or
-- after the club's capability has since been disabled, and cleanup must
-- never be trapped by any of those.
create or replace function public.clear_reservation_player_search(
  p_reservation_id   uuid,
  p_expected_club_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reservation public.reservations%rowtype;
  v_existing    public.reservation_player_searches%rowtype;
begin
  v_reservation := public._authorize_reservation_roster_access(p_reservation_id, p_expected_club_id, false);

  select * into v_existing
    from public.reservation_player_searches
   where reservation_id = p_reservation_id
   for update;
  if not found then
    raise exception 'reservation_player_search_not_found';
  end if;

  if not v_existing.is_open then
    return v_existing.id;
  end if;

  update public.reservation_player_searches
     set is_open = false
   where id = v_existing.id;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_reservation.club_id,
    auth.uid(),
    'clear_reservation_player_search',
    'reservation',
    p_reservation_id,
    jsonb_build_object('player_search_id', v_existing.id)
  );

  return v_existing.id;
end;
$$;

revoke execute on function public.clear_reservation_player_search(uuid, uuid) from public, anon;
grant  execute on function public.clear_reservation_player_search(uuid, uuid) to authenticated;

-- 3c. get_reservation_player_search — read-only, mutates nothing. Owner or
-- Admin/Staff only. Returns zero rows when no search exists at all.
-- Exposes only the aggregate collaboration state the UI needs — no host
-- id, no payment/waiver/email/phone/notes.
create or replace function public.get_reservation_player_search(
  p_reservation_id   uuid,
  p_expected_club_id uuid
)
returns table (
  reservation_id              uuid,
  player_capacity             int,
  is_open                     boolean,
  effective_is_open           boolean,
  effective_open_block_reason text,
  occupied_seats              int,
  remaining_spots             int
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reservation public.reservations%rowtype;
  v_search      public.reservation_player_searches%rowtype;
  v_occupied    int;
begin
  v_reservation := public._authorize_reservation_roster_access(p_reservation_id, p_expected_club_id, false);

  select * into v_search
    from public.reservation_player_searches
   where reservation_id = p_reservation_id;

  if not found then
    return;
  end if;

  v_occupied := public._reservation_player_search_occupied_seats(p_reservation_id, v_search.host_roster_member_id);

  return query
    select
      p_reservation_id,
      v_search.player_capacity,
      v_search.is_open,
      public._reservation_player_search_is_effective_open(v_reservation, v_search),
      public._reservation_player_search_block_reason(v_reservation, v_search),
      v_occupied,
      v_search.player_capacity - v_occupied;
end;
$$;

revoke execute on function public.get_reservation_player_search(uuid, uuid) from public, anon;
grant  execute on function public.get_reservation_player_search(uuid, uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 4 — Discovery read
-- ═══════════════════════════════════════════════════════════════════════════
-- get_open_reservation_player_searches — the intentional opt-in privacy
-- aperture. Caller eligibility is IDENTITY-based, not role-based. Returns
-- ONLY effective-open (now including host-eligibility), non-full searches,
-- excluding the caller's own hosted reservations and any reservation where
-- the caller already has an active participant row. Returns the minimum
-- fields needed for a future browse list. Does not change ordinary
-- Calendar reservation visibility in any way.
create or replace function public.get_open_reservation_player_searches(
  p_expected_club_id uuid
)
returns table (
  reservation_id     uuid,
  court_id           uuid,
  court_name         text,
  starts_at          timestamptz,
  ends_at            timestamptz,
  format             text,
  host_display_name  text,
  player_capacity    int,
  occupied_seats     int,
  remaining_spots    int
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id          uuid;
  v_caller_roster_id uuid;
  v_caller_roster    public.roster_members%rowtype;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;

  v_club_id := public.current_user_club_id();
  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;

  if not public.current_club_has_capability('member_self_service') then
    raise exception 'capability_not_available';
  end if;

  v_caller_roster_id := public.current_user_roster_member_id();
  if v_caller_roster_id is null then raise exception 'roster_identity_required'; end if;

  select * into v_caller_roster from public.roster_members where id = v_caller_roster_id;
  if v_caller_roster.status is distinct from 'active' or v_caller_roster.removed_at is not null then
    raise exception 'roster_member_inactive';
  end if;

  return query
    select
      r.id,
      c.id,
      c.name,
      r.starts_at,
      r.ends_at,
      r.format,
      coalesce(nullif(trim(concat_ws(' ', hrm.first_name, hrm.last_name)), ''), 'Unknown')::text,
      s.player_capacity,
      public._reservation_player_search_occupied_seats(r.id, s.host_roster_member_id),
      s.player_capacity - public._reservation_player_search_occupied_seats(r.id, s.host_roster_member_id)
    from public.reservation_player_searches s
    join public.reservations   r   on r.id   = s.reservation_id
    join public.courts         c   on c.id   = r.court_id
    join public.roster_members hrm on hrm.id = s.host_roster_member_id
   where r.club_id = v_club_id
     and public._reservation_player_search_is_effective_open(r, s)
     and r.roster_member_id <> v_caller_roster_id
     and (s.player_capacity - public._reservation_player_search_occupied_seats(r.id, s.host_roster_member_id)) > 0
     and not exists (
       select 1 from public.reservation_participants rp
        where rp.reservation_id   = r.id
          and rp.roster_member_id = v_caller_roster_id
          and rp.status           = 'active'
     )
   order by r.starts_at asc;
end;
$$;

revoke execute on function public.get_open_reservation_player_searches(uuid) from public, anon;
grant  execute on function public.get_open_reservation_player_searches(uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 5 — Instant join
-- ═══════════════════════════════════════════════════════════════════════════
-- join_reservation_player_search — self only. Pre-apply correction 1: the
-- scope lock is acquired immediately before the search-row lock, per the
-- revised CANONICAL LOCK ORDER. Pre-apply correction 3: the owner
-- notification recipient is resolved fresh from roster_members.claimed_by
-- for the reservation's CURRENT roster_member_id (never owner_user_id),
-- and is created unconditionally for a claimed host — no user_pref_
-- enabled gate (39B-2 adds no email/SMS path; that helper governs email
-- delivery preference only, confirmed directly from 0043).
create or replace function public.join_reservation_player_search(
  p_reservation_id   uuid,
  p_expected_club_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id          uuid;
  v_roster_member_id uuid;
  v_roster           public.roster_members%rowtype;
  v_reservation      public.reservations%rowtype;
  v_search           public.reservation_player_searches%rowtype;
  v_occupied         int;
  v_existing         public.reservation_participants%rowtype;
  v_existing_found   boolean;
  v_result           public.reservation_participants%rowtype;
  v_reactivated      boolean := false;
  v_host_claimed_by  uuid;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;

  v_club_id := public.current_user_club_id();
  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;

  if not public.current_club_has_capability('member_self_service') then
    raise exception 'capability_not_available';
  end if;

  v_roster_member_id := public.current_user_roster_member_id();
  if v_roster_member_id is null then raise exception 'roster_identity_required'; end if;

  select * into v_roster from public.roster_members where id = v_roster_member_id;
  if v_roster.status is distinct from 'active' or v_roster.removed_at is not null then
    raise exception 'roster_member_inactive';
  end if;

  v_reservation := public._lock_and_validate_reservation_roster_mutable(p_reservation_id);

  if v_reservation.club_id <> v_club_id then
    raise exception 'reservation_not_found';
  end if;

  if v_reservation.status <> 'confirmed' then
    raise exception 'reservation_not_confirmed';
  end if;

  if v_reservation.starts_at <= now() then
    raise exception 'reservation_already_started';
  end if;

  if v_reservation.roster_member_id = v_roster_member_id then
    raise exception 'reservation_player_search_host_cannot_join';
  end if;

  -- Canonical lock order: scope lock, THEN search-row lock.
  perform public._lock_reservation_player_search_scope(p_reservation_id);
  v_search := public._lock_reservation_player_search_row(p_reservation_id);

  if not public._reservation_player_search_is_effective_open(v_reservation, v_search) then
    raise exception 'reservation_player_search_not_open';
  end if;

  loop
    select * into v_existing
      from public.reservation_participants
     where reservation_id   = p_reservation_id
       and roster_member_id = v_roster_member_id
     for update;
    v_existing_found := found;

    if v_existing_found and v_existing.status = 'active' then
      v_result := v_existing;
      exit;
    end if;

    -- Genuine activation — enforce capacity now, under the search row's
    -- own lock already held above.
    v_occupied := public._reservation_player_search_occupied_seats(p_reservation_id, v_search.host_roster_member_id);
    if v_occupied + 1 > v_search.player_capacity then
      raise exception 'reservation_player_search_full';
    end if;

    if v_existing_found then
      update public.reservation_participants
         set status     = 'active',
             removed_at = null,
             removed_by = null,
             added_by   = auth.uid(),
             updated_at = now()
       where id = v_existing.id
      returning * into v_result;
      v_reactivated := true;
      exit;
    else
      begin
        insert into public.reservation_participants (reservation_id, roster_member_id, added_by)
        values (p_reservation_id, v_roster_member_id, auth.uid())
        returning * into v_result;
        exit;
      exception when unique_violation then
        continue;
      end;
    end if;
  end loop;

  if v_result.id is null then
    raise exception 'reservation_participant_write_failed';
  end if;

  -- Audit + owner notification only for a genuine new join — never for the
  -- idempotent already-active branch above, which already exited.
  if v_reactivated or not v_existing_found then
    insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
    values (
      v_reservation.club_id,
      auth.uid(),
      'join_reservation_player_search',
      'reservation',
      p_reservation_id,
      jsonb_build_object('participant_id', v_result.id, 'roster_member_id', v_roster_member_id)
    );

    -- Pre-apply correction 3: the canonical host identity is reservations.
    -- roster_member_id, never owner_user_id — resolve the CURRENT claimed
    -- account for that exact roster row. No account claimed -> no
    -- notification row (notifications.user_id references profiles(id), so
    -- there is nothing valid to insert). Unconditional otherwise — no
    -- preference gate; user_pref_enabled governs email delivery only, and
    -- this feature adds no email path.
    select claimed_by into v_host_claimed_by
      from public.roster_members
     where id = v_reservation.roster_member_id;

    if v_host_claimed_by is not null then
      insert into public.notifications (club_id, user_id, kind, body, metadata)
      values (
        v_reservation.club_id,
        v_host_claimed_by,
        'reservation_player_activity',
        coalesce(nullif(trim(concat_ws(' ', v_roster.first_name, v_roster.last_name)), ''), 'A club member')
          || ' joined your reservation.',
        jsonb_build_object('reservation_id', p_reservation_id)
      );
    end if;
  end if;

  return v_result.id;
end;
$$;

revoke execute on function public.join_reservation_player_search(uuid, uuid) from public, anon;
grant  execute on function public.join_reservation_player_search(uuid, uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 6 — Self leave
-- ═══════════════════════════════════════════════════════════════════════════
-- leave_reservation_participation — deliberately IDENTITY-based, not
-- ownership- or capability-gated. Removing yourself only ever DECREASES
-- occupancy, so it never acquires the Section 1e scope lock either — there
-- is no capacity decision to serialize. Pre-apply correction 3: the same
-- roster_members.claimed_by resolution and unconditional-for-a-claimed-
-- host notification behavior as join, above.
create or replace function public.leave_reservation_participation(
  p_reservation_id   uuid,
  p_expected_club_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id          uuid;
  v_roster_member_id uuid;
  v_leaving_roster   public.roster_members%rowtype;
  v_reservation      public.reservations%rowtype;
  v_existing         public.reservation_participants%rowtype;
  v_host_claimed_by  uuid;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;

  v_club_id := public.current_user_club_id();
  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;

  v_roster_member_id := public.current_user_roster_member_id();
  if v_roster_member_id is null then raise exception 'roster_identity_required'; end if;

  v_reservation := public._lock_and_validate_reservation_roster_mutable(p_reservation_id);

  if v_reservation.club_id <> v_club_id then
    raise exception 'reservation_not_found';
  end if;

  if v_reservation.roster_member_id = v_roster_member_id then
    raise exception 'reservation_player_search_host_cannot_leave';
  end if;

  select * into v_existing
    from public.reservation_participants
   where reservation_id   = p_reservation_id
     and roster_member_id = v_roster_member_id
   for update;
  if not found then
    raise exception 'reservation_participant_not_found';
  end if;

  if v_existing.status = 'removed' then
    return v_existing.id;
  end if;

  update public.reservation_participants
     set status     = 'removed',
         removed_at = now(),
         removed_by = auth.uid(),
         updated_at = now()
   where id = v_existing.id;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_reservation.club_id,
    auth.uid(),
    'leave_reservation_participation',
    'reservation',
    p_reservation_id,
    jsonb_build_object('participant_id', v_existing.id, 'roster_member_id', v_roster_member_id)
  );

  select claimed_by into v_host_claimed_by
    from public.roster_members
   where id = v_reservation.roster_member_id;

  if v_host_claimed_by is not null then
    select * into v_leaving_roster from public.roster_members where id = v_roster_member_id;

    insert into public.notifications (club_id, user_id, kind, body, metadata)
    values (
      v_reservation.club_id,
      v_host_claimed_by,
      'reservation_player_activity',
      coalesce(nullif(trim(concat_ws(' ', v_leaving_roster.first_name, v_leaving_roster.last_name)), ''), 'A club member')
        || ' left your reservation.',
      jsonb_build_object('reservation_id', p_reservation_id)
    );
  end if;

  return v_existing.id;
end;
$$;

revoke execute on function public.leave_reservation_participation(uuid, uuid) from public, anon;
grant  execute on function public.leave_reservation_participation(uuid, uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 7 — Notification: exactly one new kind, wired into the CURRENT
-- latest notifications_kind_check (re-read directly above, not from
-- memory) with every existing kind preserved verbatim, in order.
-- Pre-apply correction 3: notification_preferences_kind_check and
-- update_notification_preference are DELIBERATELY NOT touched by this
-- migration — 39B-2 adds no email/SMS delivery path for this kind, and
-- the in-app row is created unconditionally (see Sections 5/6). If a
-- future phase adds email/SMS for reservation_player_activity, preference
-- support is added then, as its own migration.
-- ═══════════════════════════════════════════════════════════════════════════

-- 7a. notifications_kind_check — the 21 kinds currently allowed (latest
-- real ALTER: 0197), plus 'reservation_player_activity' as the 22nd.
alter table public.notifications
  drop constraint if exists notifications_kind_check;

alter table public.notifications
  add constraint notifications_kind_check
  check (kind in (
    'reservation_confirmed',
    'reservation_cancelled_by_admin',
    'reservation_cancelled_by_member',
    'reservation_rescheduled',
    'event_cancelled',
    'event_joined',
    'event_updated',
    'waitlist_promoted',
    'waitlist_offer',
    'announcement',
    'lesson_request_received',
    'lesson_request_proposed',
    'lesson_request_confirmed',
    'lesson_request_declined',
    'lesson_cancelled',
    'lesson_provider_reassigned',
    'lesson_admin_requested',
    'refund_request_rejected',
    'refund_request_completed',
    'refund_request_submitted',
    'member_waiver_requires_acceptance',
    'reservation_player_activity'  -- Phase 39B-2
  ));

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration created in
-- this checkpoint).
-- ═══════════════════════════════════════════════════════════════════════════
--   -- notifications_kind_check: restore to its exact pre-0204 (0197) list.
--   drop function if exists public.leave_reservation_participation(uuid, uuid);
--   drop function if exists public.join_reservation_player_search(uuid, uuid);
--   drop function if exists public.get_open_reservation_player_searches(uuid);
--   drop function if exists public.get_reservation_player_search(uuid, uuid);
--   drop function if exists public.clear_reservation_player_search(uuid, uuid);
--   drop function if exists public.set_reservation_player_search(uuid, uuid, int);
--   -- Restore add_reservation_participant/add_reservation_guest to their
--   -- exact pre-0204 (0179) bodies — reproduced verbatim in 0179 itself.
--   drop function if exists public._lock_reservation_player_search_scope(uuid);
--   drop function if exists public._lock_reservation_player_search_row(uuid);
--   drop function if exists public._reservation_player_search_occupied_seats(uuid, uuid);
--   drop function if exists public._reservation_player_search_block_reason(public.reservations, public.reservation_player_searches);
--   drop function if exists public._reservation_player_search_is_effective_open(public.reservations, public.reservation_player_searches);
