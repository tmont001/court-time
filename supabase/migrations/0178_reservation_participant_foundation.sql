-- 0178_reservation_participant_foundation.sql
-- Phase 37B — Reservation Participant Schema / Guard / RLS Foundation.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 37A's audit found that a reservation today tells us who booked it
-- (owner_user_id/roster_member_id/created_by) but not who is actually
-- playing. This migration lays the durable, additive foundation for naming
-- players on a reservation — two new tables only. It does NOT add any RPC
-- (get/add/remove — those are Phase 37C), does NOT change any existing
-- Reservation CRUD RPC, does NOT change UI, and does NOT touch pricing,
-- payments, checkout, refunds, disputes, or reporting.
--
-- LOCKED ARCHITECTURE (Phase 37A, corrected):
--   - reservation_participants — durable club roster identities
--     (roster_members.id), for reservations with reason = 'member_booking'
--     only.
--   - reservation_guests — true non-Members, reservation-scoped
--     display_name only. No roster_member_id column on this table at all
--     (Events' own now-deprecated nullable-roster-linked-guest ambiguity is
--     deliberately not repeated here).
--   - Reservation ownership (reservations.owner_user_id/roster_member_id)
--     and reservation participation are separate concepts. A person counts
--     as a named player ONLY through an active row in one of these two
--     tables — the reservation holder never implicitly counts. No
--     is_booker column: "reservation holder" is a derived comparison
--     (reservation_participants.roster_member_id = reservations
--     .roster_member_id) computed by a future read, never persisted.
--   - Exactly one durable relationship row per (reservation_id,
--     roster_member_id) pair for the life of the reservation — a plain
--     UNIQUE constraint, not a partial one. Remove/re-add toggles that
--     row's lifecycle fields; it is never replaced by a second row.
--   - Both tables are RLS-enabled with ZERO client-facing policies of any
--     kind, and ALL table privileges are revoked from public/anon/
--     authenticated. This is intentionally narrower than
--     event_participants' own posture (which still grants authenticated a
--     same-club SELECT, per 0091) — Phase 36 established that reservation
--     DETAIL authorization is deliberately narrower than calendar-grid
--     visibility, and Phase 37A Correction 4 applies that same narrowness
--     here: ordinary reads go exclusively through Phase 37C's
--     get_reservation_roster/get_reservation_eligible_roster_members
--     SECURITY DEFINER RPCs, never a direct client SELECT.
--   - reservations.player_count/format/guest_names are completely
--     untouched by this migration — no backfill, no synchronization, no
--     new constraint referencing them.
--
-- PRE-IMPLEMENTATION VERIFY (done directly against this repo's current
-- migrations before writing this file, not from paraphrase):
--   - roster_members (0056, altered 0107/0117/0131): id uuid PK default
--     gen_random_uuid(); club_id uuid not null references clubs(id) on
--     delete cascade; status text not null default 'active' check
--     (status in ('active','inactive')) (added 0117); claimed_by uuid
--     references auth.users(id) on delete set null, unique per
--     (club_id, claimed_by) since 0107 (not global). role widened to
--     ('member','pro','staff','admin') by 0131 — irrelevant here, this
--     migration never filters or checks roster_members.role.
--   - reservations (0003, altered 0004/0026/0069/0108/0139): id uuid PK;
--     club_id uuid not null; reason text not null default 'member_booking'
--     check (reason in ('member_booking','maintenance','admin_block',
--     'event','pro_lesson')) — final list per 0069, confirmed unchanged by
--     any later migration; status text not null default 'confirmed' check
--     (status in ('pending','confirmed','cancelled')) — unchanged since
--     0003.
--   - profiles (0001): id uuid primary key references auth.users(id) on
--     delete cascade. This is the FK target for added_by/removed_by below.
--   - trigger_set_updated_at() (0001): `returns trigger language plpgsql
--     as $$ begin new.updated_at = now(); return new; end; $$;` — reused
--     verbatim below, unqualified, exactly as every existing call site
--     invokes it (e.g. 0056's roster_members_updated_at).
--   - UUID default convention: this schema mixes uuid_generate_v4()
--     (older) and gen_random_uuid() (roster_members, and every migration
--     from 0173 onward). This migration uses gen_random_uuid() — the
--     currently-prevailing convention, and an exact match for
--     roster_members.id's own default, which these tables reference.
--   - Transaction convention: recent migrations (0126, 0150, 0176, 0177)
--     wrap their body in begin;/commit;. Followed below.
--   - No naming/schema contradiction found against the Phase 37A/37B
--     paraphrase — proceeding as designed.
--
-- CONCURRENCY: see _lock_and_validate_reservation_roster_mutable below for
-- the full FOR SHARE argument — the identical mechanism and reasoning as
-- 0126's enforce_event_participant_member_schedule FOR SHARE lock on
-- events, applied here to reservations against a concurrent cancellation.
--
-- Not applied by this checkpoint. Not committed. Does not modify 0001-0177.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. reservation_participants
-- ═══════════════════════════════════════════════════════════════════════════
create table public.reservation_participants (
  id                uuid        primary key default gen_random_uuid(),
  reservation_id    uuid        not null references public.reservations(id) on delete cascade,
  roster_member_id  uuid        not null references public.roster_members(id),
  status            text        not null default 'active',
  removed_at        timestamptz,
  removed_by        uuid        references public.profiles(id),
  added_by          uuid        not null references public.profiles(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint reservation_participants_status_check
    check (status in ('active', 'removed')),

  -- Removal provenance is always fully present or fully absent together —
  -- pure column-internal consistency, no session/auth dependency, safe as
  -- an ordinary CHECK.
  constraint reservation_participants_removed_consistency_check
    check (
      (status = 'active'  and removed_at is null     and removed_by is null)
      or
      (status = 'removed' and removed_at is not null and removed_by is not null)
    ),

  -- The single durable relationship row (Phase 37A Correction 2). Not
  -- partial — applies regardless of status, which is exactly what
  -- prevents a second lifecycle row ever existing for the same pair. A
  -- remove/re-add reuses this same row (see Phase 37C design).
  constraint reservation_participants_reservation_roster_uniq
    unique (reservation_id, roster_member_id)

  -- roster_member_id intentionally carries no ON DELETE clause (defaults
  -- to NO ACTION/RESTRICT) — the same durable-identity deletion posture
  -- reservations.roster_member_id itself already uses (0108): roster
  -- identities are deactivated via roster_members.status, never hard-
  -- deleted, so this FK is never expected to block a real operation.
);

comment on table public.reservation_participants is
  'Durable club roster identities (roster_members.id) named as players on '
  'a reason=''member_booking'' reservation. Reservation ownership '
  '(reservations.owner_user_id/roster_member_id) is a separate concept — '
  'an active row here is the only thing that makes someone count as a '
  'named participant. No is_booker column: compare roster_member_id '
  'against reservations.roster_member_id at read time to identify the '
  'reservation holder, if they are also named. Phase 37B: schema only, no '
  'RPC yet.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. reservation_guests
-- ═══════════════════════════════════════════════════════════════════════════
-- No roster_member_id column on this table by design (Phase 37A Correction
-- 8 / the Events-precedent lesson): a guest here is definitionally a
-- non-Member. No email/phone/brought_by — minimum viable identity only,
-- per the locked Phase 37 guest foundation. reservation_id is immutable
-- after insert (enforced below); there is deliberately no uniqueness
-- constraint on (reservation_id, display_name) — two real guests may share
-- a name, and guests have no durable identity to deduplicate against.
create table public.reservation_guests (
  id              uuid        primary key default gen_random_uuid(),
  reservation_id  uuid        not null references public.reservations(id) on delete cascade,
  display_name    text        not null,
  status          text        not null default 'active',
  removed_at      timestamptz,
  removed_by      uuid        references public.profiles(id),
  added_by        uuid        not null references public.profiles(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint reservation_guests_status_check
    check (status in ('active', 'removed')),

  constraint reservation_guests_removed_consistency_check
    check (
      (status = 'active'  and removed_at is null     and removed_by is null)
      or
      (status = 'removed' and removed_at is not null and removed_by is not null)
    ),

  -- Canonical storage, not merely trim-aware validation: display_name is
  -- the guest's only Phase 37 identity, so the STORED value must already
  -- be trimmed (never merely valid-after-trimming) and 1-100 characters
  -- long. No normalization trigger is introduced here — Phase 37C's
  -- add_reservation_guest RPC is responsible for calling btrim() before
  -- INSERT; this constraint exists to reject anything that RPC (or any
  -- future writer) fails to normalize, not to normalize it itself.
  constraint reservation_guests_display_name_canonical_check
    check (
      display_name = btrim(display_name)
      and char_length(display_name) between 1 and 100
    )
);

comment on table public.reservation_guests is
  'True non-Member guests named on a reason=''member_booking'' '
  'reservation. display_name only — no roster_member_id, no email/phone, '
  'no durable cross-reservation identity, reservation-scoped only. Phase '
  '37B: schema only, no RPC yet.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Indexes
-- ═══════════════════════════════════════════════════════════════════════════
-- reservation_participants: the UNIQUE (reservation_id, roster_member_id)
-- constraint above already provides a reservation_id-leading btree — a
-- separate reservation_id-only index would be redundant and is
-- deliberately NOT added.
--
-- reservation_guests has no such composite index, and Phase 37C's
-- get_reservation_roster is designed to return ACTIVE rows only in the
-- normal case (removed rows are durable history, not part of the normal
-- roster read — Phase 37A Correction 6/37B locked decision) — so a
-- partial index on exactly that predicate is the one index this table
-- actually needs.
create index reservation_guests_active_idx
  on public.reservation_guests (reservation_id)
  where status = 'active';

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. updated_at — reuse the existing shared trigger function verbatim,
-- exactly as every other table in this schema does (e.g. 0056's
-- roster_members_updated_at). No second generic implementation introduced.
-- ═══════════════════════════════════════════════════════════════════════════
create trigger reservation_participants_updated_at
  before update on public.reservation_participants
  for each row execute function trigger_set_updated_at();

create trigger reservation_guests_updated_at
  before update on public.reservation_guests
  for each row execute function trigger_set_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. RLS — enabled on both tables, ZERO client-facing policies of any kind
-- (no SELECT, INSERT, UPDATE, or DELETE), and every table privilege
-- revoked from public/anon/authenticated. This is a hard deny, not merely
-- an RLS gap: even a future RLS misconfiguration could not open direct
-- access, because the underlying GRANT itself is absent. FORCE ROW LEVEL
-- SECURITY is deliberately NOT set — the table owner (which will also own
-- Phase 37C's SECURITY DEFINER RPCs) must remain able to operate on these
-- tables without RLS applying to it, exactly as every other RPC-only table
-- in this schema (event_participants since 0091, programs/program_
-- enrollments since 0087, payment_checkout_attempts since 0150, etc.)
-- already relies on.
-- ═══════════════════════════════════════════════════════════════════════════
alter table public.reservation_participants enable row level security;
alter table public.reservation_guests        enable row level security;

revoke all on public.reservation_participants from public, anon, authenticated;
revoke all on public.reservation_guests        from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. Shared internal guard authority. Private — revoked from public/anon/
-- authenticated entirely; callable only from the two trigger functions
-- below (which run SECURITY DEFINER, so their execution context is the
-- owning role regardless of the original caller's own grants — the same
-- mechanism 0108's enforce_member_booking_roster_identity and 0126's
-- _assert_roster_member_schedule_available already rely on). Trigger
-- firing is unaffected by this revoke: Postgres invokes a trigger function
-- via the table's own trigger machinery, which does not check EXECUTE
-- privilege the way a direct RPC call does — 0126's identical revoke on
-- _assert_roster_member_schedule_available already proves this in
-- production.
--
-- CONCURRENCY (Phase 37A/37B locked requirement): FOR SHARE, not FOR
-- UPDATE — the exact same mechanism and argument as 0126's
-- enforce_event_participant_member_schedule FOR SHARE lock on events.
-- Multiple concurrent roster mutations against the SAME reservation do not
-- block each other (FOR SHARE is compatible with FOR SHARE), but any
-- ordinary UPDATE on this reservations row — in particular
-- cancel_member_reservation's and admin_cancel_reservation_v2's plain
-- `update reservations set status = 'cancelled' ...` — takes an implicit
-- row lock that conflicts with FOR SHARE. This produces exactly one of two
-- safe orderings for any roster mutation racing a cancellation of the same
-- reservation:
--   1. This SELECT acquires its FOR SHARE lock first: the concurrent
--      cancellation's UPDATE blocks until this trigger's transaction
--      commits or rolls back, so the roster mutation always completes (or
--      fails for its own reasons) against a reservation that was NOT
--      cancelled at the moment it read the row.
--   2. The cancellation's UPDATE acquires its row lock first: this
--      SELECT ... FOR SHARE blocks until that transaction commits, then
--      reads the now-committed status = 'cancelled' row, and the check
--      below rejects the roster mutation.
-- Either way, a roster mutation can never commit having reasoned from a
-- pre-cancellation snapshot that a concurrent cancellation has already
-- superseded.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public._lock_and_validate_reservation_roster_mutable(
  p_reservation_id uuid
)
returns public.reservations
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reservation public.reservations%rowtype;
begin
  select * into v_reservation
    from public.reservations
    where id = p_reservation_id
    for share;

  if not found then
    raise exception 'reservation_not_found';
  end if;

  if v_reservation.reason <> 'member_booking' then
    raise exception 'reservation_not_participant_eligible';
  end if;

  if v_reservation.status = 'cancelled' then
    raise exception 'reservation_roster_locked';
  end if;

  return v_reservation;
end;
$$;

revoke execute on function public._lock_and_validate_reservation_roster_mutable(uuid)
  from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. reservation_participants domain guard. Structural invariants only —
-- no auth.uid()/role check belongs here (that is exclusively Phase 37C's
-- concern). Enforces, in order:
--   1. reservation_id/roster_member_id are immutable after INSERT (Phase
--      37A Correction: a durable relationship row may never be repointed
--      at a different reservation or a different roster identity — only
--      its lifecycle/provenance columns may change).
--   2. The parent reservation exists, is reason = 'member_booking', and
--      is not cancelled (via the shared helper above).
--   3. The referenced roster_members row belongs to the SAME club as the
--      reservation — mirrors reservations' own
--      enforce_member_booking_roster_identity (0108) same-club check
--      exactly, including its error code.
-- Deliberately does NOT check roster_members.status = 'active' — that is
-- Phase 37C business/eligibility policy (may evolve without a schema
-- migration), not a structural fact enforced here.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.enforce_reservation_participant_domain()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reservation public.reservations%rowtype;
  v_roster      public.roster_members%rowtype;
begin
  if tg_op = 'UPDATE' then
    if new.reservation_id is distinct from old.reservation_id then
      raise exception 'reservation_participant_reservation_immutable';
    end if;
    if new.roster_member_id is distinct from old.roster_member_id then
      raise exception 'reservation_participant_identity_immutable';
    end if;
  end if;

  v_reservation := public._lock_and_validate_reservation_roster_mutable(new.reservation_id);

  select * into v_roster
    from public.roster_members
    where id = new.roster_member_id;

  if not found then
    raise exception 'roster_member_not_found';
  end if;

  if v_roster.club_id <> v_reservation.club_id then
    raise exception 'roster_member_wrong_club';
  end if;

  return new;
end;
$$;

revoke execute on function public.enforce_reservation_participant_domain()
  from public, anon, authenticated;

drop trigger if exists reservation_participants_domain_guard on public.reservation_participants;
create trigger reservation_participants_domain_guard
  before insert or update
  on public.reservation_participants
  for each row
  execute function public.enforce_reservation_participant_domain();

-- ═══════════════════════════════════════════════════════════════════════════
-- 8. reservation_guests domain guard. Same structural shape as above minus
-- the roster/club check (guests carry no roster reference): reservation_id
-- is immutable after INSERT, and the parent reservation must exist, be
-- reason = 'member_booking', and not be cancelled.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.enforce_reservation_guest_domain()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' and new.reservation_id is distinct from old.reservation_id then
    raise exception 'reservation_guest_reservation_immutable';
  end if;

  perform public._lock_and_validate_reservation_roster_mutable(new.reservation_id);

  return new;
end;
$$;

revoke execute on function public.enforce_reservation_guest_domain()
  from public, anon, authenticated;

drop trigger if exists reservation_guests_domain_guard on public.reservation_guests;
create trigger reservation_guests_domain_guard
  before insert or update
  on public.reservation_guests
  for each row
  execute function public.enforce_reservation_guest_domain();

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration created in
-- this checkpoint). Safe to roll back at any point before Phase 37C's RPCs
-- are built on top of these tables: both tables are brand-new with no
-- other object depending on them yet.
-- ═══════════════════════════════════════════════════════════════════════════
--   drop trigger if exists reservation_participants_domain_guard on public.reservation_participants;
--   drop trigger if exists reservation_guests_domain_guard        on public.reservation_guests;
--   drop trigger if exists reservation_participants_updated_at    on public.reservation_participants;
--   drop trigger if exists reservation_guests_updated_at          on public.reservation_guests;
--   drop function if exists public.enforce_reservation_participant_domain();
--   drop function if exists public.enforce_reservation_guest_domain();
--   drop function if exists public._lock_and_validate_reservation_roster_mutable(uuid);
--   drop table if exists public.reservation_guests;
--   drop table if exists public.reservation_participants;
