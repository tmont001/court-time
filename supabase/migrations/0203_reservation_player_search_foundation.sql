-- 0203_reservation_player_search_foundation.sql
-- Phase 39B-1 — Reservation Looking-for-Players Schema Foundation.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
-- The pre-39B implementation audit (Phase 39B/C planning) established that
-- "Looking for Players" must extend the existing reservation_participants/
-- reservation_guests model (0178/
-- 0179) rather than create a second, disconnected roster system, and that
-- instant-join is the locked V1 join model — no request/approval workflow.
-- This migration lays the schema-only foundation: one new table, one
-- domain guard, RLS locked to zero client access. It does NOT add any RPC
-- (create/close/join/leave — those are Phase 39B-2), does NOT change any
-- existing reservation/roster table or RPC, does NOT change UI, and does
-- NOT touch pricing, payments, checkout, refunds, disputes, or reporting.
--
-- LOCKED ARCHITECTURE (Phase 39B, corrected from the pre-39B implementation
-- audit):
--   - public.reservation_player_searches — one row per reservation opting
--     into Looking-for-Players, for reservations with reason =
--     'member_booking' only. Table name is deliberately NOT
--     reservation_open_play: "Open Play" already means a club-operated
--     drop-in program in this product and would be ambiguous here.
--   - No skill_preference, message, or any free-text collaboration field.
--     The repo has no canonical skill/rating model (verified: no such
--     column exists anywhere on profiles or roster_members) and Phase
--     39B/C planning explicitly locked V1 to NOT invent one. Deferred, not
--     omitted by oversight.
--   - player_capacity is the TOTAL desired players for the reservation,
--     INCLUDING the reservation host. This is a correction from the
--     pre-39B implementation audit: the reservation host is NOT normally
--     represented by their own reservation_participants row (0178's own locked
--     decision — "the reservation holder never implicitly counts"), so
--     occupied-seat accounting below always adds exactly 1 for the host on
--     top of the active participant/guest rows, and explicitly excludes
--     any participant row whose roster_member_id happens to equal the
--     host's own roster_member_id (an anomalous/legacy state) from being
--     double-counted.
--   - host_roster_member_id is an intentional SNAPSHOT of
--     reservations.roster_member_id, but the write-time rule is
--     state-dependent, not a blanket "always match current" — a closed
--     search must remain closable even after the reservation has been
--     reassigned to a different Member (reservation_member_reassignment,
--     0109), without pretending the new Member was the one who opened it:
--       * INSERT — host_roster_member_id MUST equal the reservation's
--         CURRENT roster_member_id, regardless of the row's own is_open
--         value at insert time. A search can never be created snapshotting
--         anyone other than the actual current host.
--       * UPDATE where NEW.is_open = true — NEW.host_roster_member_id
--         MUST equal the reservation's CURRENT roster_member_id. This is
--         what lets a future authorized reopen operation atomically adopt
--         the reservation's current host (which may differ from the row's
--         own prior host_roster_member_id) at the same moment it flips
--         is_open back to true — reopening always re-adopts the current
--         host, never revives a stale one.
--       * UPDATE where NEW.is_open = false — the reservation's CURRENT
--         roster_member_id is NOT consulted at all, so a historical/stale
--         host_roster_member_id (from before a reassignment) never blocks
--         closing. What IS enforced instead: host_roster_member_id must be
--         unchanged from OLD.host_roster_member_id — a closed-state update
--         may never rewrite who actually created the search.
--     Net effect: an OPEN search always belongs to the current reservation
--     host; a CLOSED search may retain its historical host snapshot
--     untouched; closing a stale search is always possible; only an
--     explicit reopen may change host_roster_member_id, and only to the
--     reservation's current roster_member_id. This migration deliberately
--     does NOT modify update_member_reservation — reassignment itself
--     never touches this table; only a subsequent write to THIS table
--     re-derives host_roster_member_id against the reservation's now-
--     current owner. Phase 39B-2's discovery/join RPCs must independently
--     re-check that an OPEN row's snapshot still matches
--     reservations.roster_member_id at read/join time, since a reassigned-
--     but-not-yet-reopened row can still be sitting at is_open = true with
--     a now-stale host until this guard is triggered again.
--   - capacity is NEVER a stored "remaining spots" counter. Occupied seats
--     are always computed at validation time as:
--       1 (the host)
--       + count(active reservation_participants
--               where roster_member_id <> host_roster_member_id)
--       + count(active reservation_guests)
--     An OPEN (is_open = true) search may never be written with
--     player_capacity below this computed occupied-seat count — rejected
--     as reservation_player_capacity_too_small, never silently clamped. A
--     CLOSED (is_open = false) search is explicitly exempt from this
--     check: it may retain a stale player_capacity from before the roster
--     grew past it; reopening will be revalidated by this same guard on
--     that later UPDATE, not by this migration doing any retroactive
--     sweep.
--   - The null-roster check (reservation.roster_member_id IS NOT NULL)
--     applies unconditionally on every INSERT/UPDATE. The host-match check
--     does NOT — see the state-dependent rule above: it is unconditional
--     on INSERT and on an UPDATE that keeps/sets is_open = true, but is
--     replaced by a host-IMMUTABILITY check (against OLD, not against the
--     reservation) on an UPDATE that keeps/sets is_open = false. The
--     capacity-vs-occupied-seats check remains conditional on is_open =
--     true, unchanged. A closed row's STALE CAPACITY and STALE HOST are
--     both tolerated by design; what is never tolerated is a closed-state
--     update silently rewriting the host to someone who wasn't actually
--     the one who created the search.
--   - RLS enabled, ZERO client-facing policies of any kind, and ALL table
--     privileges revoked from public/anon/authenticated — the identical
--     posture 0178 established for reservation_participants/
--     reservation_guests. Ordinary reads/writes go exclusively through
--     Phase 39B-2's future SECURITY DEFINER RPCs, never a direct client
--     query. FORCE ROW LEVEL SECURITY is deliberately NOT set, for the
--     same reason 0178 did not set it: the table owner (which will also
--     own Phase 39B-2's RPCs) must remain able to operate on this table
--     without RLS applying to it.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- ⚠ THIS MIGRATION ALONE DOES NOT COMPLETE THE RUNTIME CAPACITY INVARIANT ⚠
-- ═══════════════════════════════════════════════════════════════════════════
-- The domain guard below only validates player_capacity at the moment a
-- reservation_player_searches row is itself written. It has NO visibility
-- into, and does NOT modify, add_reservation_participant or
-- add_reservation_guest (0179) — those RPCs remain exactly as they are
-- today: capacity-unaware, inserting/reactivating unconditionally once
-- authorized. That is deliberate and correct scope for 39B-1 (schema
-- only), but it means an OPEN Looking-for-Players search can currently be
-- pushed over its own player_capacity by a completely ordinary roster
-- mutation that this migration cannot see:
--   - an Admin/Staff or the reservation owner adding another participant
--     via add_reservation_participant,
--   - anyone adding a guest via add_reservation_guest,
--   - either one REACTIVATING a previously-removed participant/guest row
--     (0179's own reactivate-or-insert branch).
-- BEFORE Phase 39B-2 exposes any join_open_reservation RPC or any client
-- UI for this feature, the shared occupied-seats-vs-player_capacity guard
-- introduced here must be extended to run — atomically, under the same
-- locking discipline — across ALL FOUR of: join_open_reservation itself,
-- add_reservation_participant, add_reservation_guest, and both
-- reactivation paths. Until that lands, an OPEN search's player_capacity
-- is advisory only with respect to those four existing/future mutation
-- paths, even though this migration's own guard is fully enforced for
-- direct writes to reservation_player_searches. This is not a claim that
-- the feature-level invariant is complete — it is explicitly not, until
-- 39B-2 closes this gap.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- PAYMENT INVARIANT (documentation only — no payment object is touched by
-- this migration)
-- ═══════════════════════════════════════════════════════════════════════════
-- Looking-for-Players participation will NEVER create a payment obligation
-- for a joining player, transfer reservation payment responsibility, split
-- a reservation charge, or waive/refund/void anything. The booking owner's
-- existing payment responsibility (hourly_rate_cents/price_amount_cents,
-- payments, payment_checkout_attempts, Stripe checkout/refund state — all
-- untouched here) remains entirely unchanged by this feature, in this
-- migration and in every future 39B-2/39C checkpoint.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- PRE-IMPLEMENTATION VERIFY (done directly against this repo's current
-- migrations before writing this file, not from paraphrase):
-- ═══════════════════════════════════════════════════════════════════════════
--   - reservations (0003, altered through 0202): id uuid PK; club_id uuid
--     not null; reason text not null default 'member_booking' check
--     (reason in (...)); status text not null default 'confirmed' check
--     (status in ('pending','confirmed','cancelled')); roster_member_id
--     uuid references roster_members(id) (added 0108), nullable — a
--     staff-created no-account-Member booking always sets it (0108's own
--     enforce_member_booking_roster_identity trigger), but this migration
--     does not assume that trigger is the only path and explicitly
--     rejects a null roster_member_id itself rather than trusting it.
--   - roster_members (0056, altered 0107/0117/0131): id uuid PK default
--     gen_random_uuid(); club_id uuid not null; status text not null
--     default 'active' check (status in ('active','inactive')) (0117);
--     removed_at/removed_by added 0117. This migration's own guard does
--     NOT check roster_members.status/removed_at — Phase 39B-1 validates
--     only that host_roster_member_id matches the reservation's CURRENT
--     roster_member_id, mirroring 0178's own enforce_reservation_
--     participant_domain, which likewise defers "is this roster identity
--     currently eligible" to the RPC/business layer, not the schema guard.
--   - reservation_participants/reservation_guests (0178, APPLIED,
--     verified): both id uuid PK default gen_random_uuid(); status text
--     not null default 'active' check (status in ('active','removed'));
--     reservation_participants.roster_member_id uuid not null (no ON
--     DELETE clause); reservation_guests carries no roster_member_id at
--     all. Both RLS-enabled, zero client policies, zero grants — this
--     migration's own RLS/grant posture matches exactly.
--   - _lock_and_validate_reservation_roster_mutable(uuid) (0178, APPLIED):
--     `security definer set search_path = public, pg_temp`; `select *
--     into v_reservation from public.reservations where id =
--     p_reservation_id for share;`, raises reservation_not_found,
--     reservation_not_participant_eligible (reason <> 'member_booking'),
--     or reservation_roster_locked (status = 'cancelled'); EXECUTE revoked
--     from public/anon/authenticated. 0178's own domain-guard trigger
--     functions (enforce_reservation_participant_domain/
--     enforce_reservation_guest_domain) already call this exact function
--     from inside their own SECURITY DEFINER bodies despite that revoke —
--     proven safe in production, since the revoke only removes direct
--     top-level EXECUTE for those three roles, not the ability of another
--     SECURITY DEFINER function (running as this schema's owning role) to
--     invoke it internally. Reused verbatim here for the identical
--     reason/cancelled/missing-parent checks — no second implementation of
--     that locking discipline is introduced.
--   - trigger_set_updated_at() (0001): `returns trigger language plpgsql
--     as $$ begin new.updated_at = now(); return new; end; $$;` — reused
--     verbatim, exactly as every existing table in this schema does. No
--     second generic timestamp helper is introduced.
--   - profiles (0001): id uuid primary key references auth.users(id) on
--     delete cascade. FK target for created_by below, matching added_by's
--     own target in 0178.
--   - UUID/transaction conventions: gen_random_uuid() (the prevailing
--     convention since 0173) and a wrapping begin;/commit; block (0126,
--     0150, 0176, 0177, 0178, 0179) — both followed below.
--   - No naming/schema contradiction found against the Phase 39B/C
--     locked corrections. Proceeding as designed.
--
-- Not applied by this checkpoint. Not committed. Does not modify 0001-0202.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. reservation_player_searches
-- ═══════════════════════════════════════════════════════════════════════════
create table public.reservation_player_searches (
  id                     uuid        primary key default gen_random_uuid(),
  reservation_id         uuid        not null unique references public.reservations(id) on delete cascade,
  host_roster_member_id  uuid        not null references public.roster_members(id),
  player_capacity        integer     not null,
  is_open                boolean     not null default true,
  created_by             uuid        not null references public.profiles(id),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  -- Structural bound only — the DB does not infer capacity from
  -- reservations.format (singles/doubles). A future UI may default
  -- intelligently from format, but capacity is always an explicit,
  -- owner-supplied value at this layer.
  constraint reservation_player_searches_capacity_check
    check (player_capacity between 2 and 8)

  -- host_roster_member_id intentionally carries no ON DELETE clause
  -- (defaults to NO ACTION/RESTRICT) — the same durable-identity deletion
  -- posture reservation_participants.roster_member_id already uses (0178):
  -- roster identities are deactivated via roster_members.status, never
  -- hard-deleted.
);

comment on table public.reservation_player_searches is
  'One row per reason=''member_booking'' reservation opting into '
  'Looking-for-Players. player_capacity is the TOTAL desired players '
  'INCLUDING the host — occupied seats = 1 (host) + active '
  'reservation_participants (excluding a row whose roster_member_id '
  'equals host_roster_member_id) + active reservation_guests, computed at '
  'validation time, never stored. host_roster_member_id is a snapshot of '
  'reservations.roster_member_id: INSERT and any UPDATE that keeps/sets '
  'is_open=true must match the reservation''s CURRENT roster_member_id '
  '(so a reopen always re-adopts the current host); an UPDATE that '
  'keeps/sets is_open=false instead requires host_roster_member_id to '
  'stay equal to its own prior value, regardless of the reservation''s '
  'current roster_member_id — a closed search may retain a historical, '
  'stale host so it always remains closable after a reassignment. Phase '
  '39B-2''s discovery/join RPCs must independently re-check an OPEN row''s '
  'snapshot still matches the reservation''s CURRENT roster_member_id '
  'before allowing discovery or join. Phase 39B-1: schema only, no RPC '
  'yet. See this migration''s header for the still-open 39B-2 '
  'capacity-enforcement gap across add_reservation_participant/'
  'add_reservation_guest/reactivation paths.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. updated_at — reuse the existing shared trigger function verbatim.
-- ═══════════════════════════════════════════════════════════════════════════
create trigger reservation_player_searches_updated_at
  before update on public.reservation_player_searches
  for each row execute function trigger_set_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. RLS — enabled, ZERO client-facing policies, ALL table privileges
-- revoked from public/anon/authenticated. Identical posture to 0178's
-- reservation_participants/reservation_guests: a hard deny via GRANT
-- absence, not merely an RLS gap. FORCE ROW LEVEL SECURITY deliberately
-- NOT set, for the same reason as 0178 (the owning role must remain able
-- to operate on this table from Phase 39B-2's future SECURITY DEFINER
-- RPCs without RLS applying to it).
-- ═══════════════════════════════════════════════════════════════════════════
alter table public.reservation_player_searches enable row level security;

revoke all on public.reservation_player_searches from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Domain guard. Structural invariants only — no auth.uid()/role check
-- belongs here (that is exclusively Phase 39B-2's concern, matching 0178's
-- own enforce_reservation_participant_domain precedent). Enforces, in
-- order:
--   1. reservation_id is immutable after INSERT.
--   2. The parent reservation exists, is reason = 'member_booking', and is
--      not cancelled — via _lock_and_validate_reservation_roster_mutable
--      (0178), reused verbatim, not reimplemented.
--   3. reservation.roster_member_id is not null (Looking-for-Players
--      cannot exist without a durable Member identity to snapshot).
--   4. Host check — state-dependent, the host-reassignment-safety rule:
--      - INSERT: NEW.host_roster_member_id must equal the reservation's
--        CURRENT roster_member_id, unconditionally.
--      - UPDATE with NEW.is_open = true: NEW.host_roster_member_id must
--        equal the reservation's CURRENT roster_member_id — this is what
--        lets an authorized reopen atomically adopt a since-changed host.
--      - UPDATE with NEW.is_open = false: the reservation's current owner
--        is NOT consulted; instead NEW.host_roster_member_id must equal
--        OLD.host_roster_member_id — a closed-state update may retain a
--        stale host snapshot (so closing a search never blocks on a
--        reassignment that happened after it was opened) but may never
--        silently rewrite who actually created it.
--   5. Only when NEW.is_open = true: player_capacity must be >= the
--      occupied-seat count computed as 1 (host) + active
--      reservation_participants excluding the host's own
--      roster_member_id + active reservation_guests. A closed row is
--      exempt from this check and may retain a stale player_capacity;
--      reopening re-runs this same guard on that later UPDATE.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.enforce_reservation_player_search_domain()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reservation        public.reservations%rowtype;
  v_participant_count  int;
  v_guest_count        int;
  v_occupied_seats     int;
begin
  if tg_op = 'UPDATE' and new.reservation_id is distinct from old.reservation_id then
    raise exception 'reservation_player_search_reservation_immutable';
  end if;

  v_reservation := public._lock_and_validate_reservation_roster_mutable(new.reservation_id);

  if v_reservation.roster_member_id is null then
    raise exception 'roster_identity_required';
  end if;

  -- Host check — state-dependent (Phase 39B correction): an OPEN row
  -- (on INSERT, or an UPDATE that keeps/sets is_open = true) must always
  -- snapshot the reservation's CURRENT host, so a reopen atomically
  -- re-adopts whoever owns the reservation now. A CLOSED row (an UPDATE
  -- that keeps/sets is_open = false) is exempt from matching the
  -- reservation at all — a search must always remain closable even after
  -- the reservation has been reassigned to a different Member — but its
  -- host_roster_member_id must stay exactly equal to its own prior value,
  -- so closing can never silently rewrite who actually created it.
  if tg_op = 'INSERT' or new.is_open then
    if new.host_roster_member_id <> v_reservation.roster_member_id then
      raise exception 'reservation_player_search_host_mismatch';
    end if;
  elsif new.host_roster_member_id is distinct from old.host_roster_member_id then
    raise exception 'reservation_player_search_host_immutable_while_closed';
  end if;

  if new.is_open then
    select count(*) into v_participant_count
      from public.reservation_participants
     where reservation_id   = new.reservation_id
       and status            = 'active'
       and roster_member_id <> new.host_roster_member_id;

    select count(*) into v_guest_count
      from public.reservation_guests
     where reservation_id = new.reservation_id
       and status          = 'active';

    v_occupied_seats := 1 + v_participant_count + v_guest_count;

    if new.player_capacity < v_occupied_seats then
      raise exception 'reservation_player_capacity_too_small';
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function public.enforce_reservation_player_search_domain()
  from public, anon, authenticated;

drop trigger if exists reservation_player_searches_domain_guard on public.reservation_player_searches;
create trigger reservation_player_searches_domain_guard
  before insert or update
  on public.reservation_player_searches
  for each row
  execute function public.enforce_reservation_player_search_domain();

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration created in
-- this checkpoint). Safe to roll back at any point before Phase 39B-2's
-- RPCs are built on top of this table: brand-new, with no other object
-- depending on it yet.
-- ═══════════════════════════════════════════════════════════════════════════
--   drop trigger if exists reservation_player_searches_domain_guard on public.reservation_player_searches;
--   drop trigger if exists reservation_player_searches_updated_at   on public.reservation_player_searches;
--   drop function if exists public.enforce_reservation_player_search_domain();
--   drop table if exists public.reservation_player_searches;
