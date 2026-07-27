-- 0081_club_membership_compatibility_foundation.sql
-- Phase 26B1: Club Membership Compatibility Foundation
--
-- This migration is purely additive. It creates the multi-club membership
-- schema and a full bidirectional compatibility layer, but does NOT change
-- any existing authorization behavior:
--
--   • current_user_club_id() / current_user_role() are NOT touched.
--   • No existing RLS policy is touched.
--   • No existing RPC body is touched (accept_club_invite, set_member_role,
--     set_member_status, set_lesson_provider_status are all unmodified).
--   • No application code depends on anything introduced here.
--
-- Every existing legacy writer keeps working exactly as it does today. The
-- new club_memberships table and profiles.active_club_id column are kept in
-- sync with those legacy writers via triggers, so that by the time Phase 26B2
-- redefines current_user_club_id()/current_user_role() to read from
-- club_memberships, the new structures are already fully populated and
-- proven correct.
--
-- Structure of this file:
--   1. club_memberships table, indexes, RLS (locked down, zero policies)
--   2. profiles.active_club_id column (defense-in-depth revokes)
--   3. Backfill (plain bulk statements, run BEFORE any new triggers exist)
--   4. Trigger A  — legacy profile writer -> club_memberships projection
--   5. Trigger B  — club_memberships -> active profile projection + fallback
--   6. Trigger C  — active_club_id validation + legacy projection
--
-- Triggers are installed AFTER the backfill runs (see the comment at the top
-- of section 3) so the one-time backfill is a small number of deterministic,
-- reviewable bulk statements — not hundreds of per-row trigger cascades.
--
-- ATOMICITY: the entire file — table/column creation, all grants/revokes,
-- both backfill steps, and installation of all four compatibility triggers
-- — runs inside a single transaction (BEGIN ... COMMIT below). This closes
-- the window between "backfill has run" and "triggers are installed": the
-- ALTER TABLE public.profiles ADD COLUMN statement in section 2 takes an
-- ACCESS EXCLUSIVE lock on profiles that is held for the entire remainder
-- of this transaction. Any concurrent statement touching profiles (e.g. a
-- live accept_club_invite/set_member_role/set_member_status call) will
-- simply block, queued behind that lock, until this transaction commits —
-- at which point the compatibility triggers already exist, so that queued
-- write is correctly synced the moment it proceeds. No concurrent write can
-- land in a gap where the backfill has already run but the triggers are not
-- yet watching, because no other transaction can see any intermediate state
-- of this one at all: Postgres transaction isolation means the whole
-- migration is invisible to other sessions until COMMIT, and visible
-- complete (with triggers active) immediately after. If anything in this
-- file fails, the entire transaction rolls back — nothing here installs an
-- exception handler that would swallow a failure and let a partial result
-- commit.
--
-- Safe to sit on indefinitely: nothing added here is read by any existing
-- policy, RPC, or application code. See supabase/scripts/verify_phase26b1.sql
-- for the full read-only verification pass, and
-- supabase/scripts/QA_phase26b1.md for manual regression steps.
--
-- Apply in Supabase SQL Editor (cloud only). Not applied by this checkpoint.

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. club_memberships
-- ═══════════════════════════════════════════════════════════════════════════
-- Per-(user, club) membership. user_id/invited_by/removed_by reference
-- public.profiles(id) rather than auth.users(id) directly, matching the
-- explicit contract for this checkpoint. source_invite_id references
-- club_invites, which are only ever soft-revoked (never hard-deleted), but
-- carries an explicit on delete set null for safety if that ever changes.

create table public.club_memberships (
  id                 uuid        primary key default gen_random_uuid(),
  user_id            uuid        not null references public.profiles(id) on delete cascade,
  club_id            uuid        not null references public.clubs(id) on delete cascade,
  role               text        not null default 'member'
                        check (role in ('member', 'pro', 'admin')),
  status             text        not null default 'active'
                        check (status in ('active', 'inactive', 'suspended')),
  is_lesson_provider boolean     not null default false,
  joined_at          timestamptz not null default now(),
  invited_by         uuid        references public.profiles(id) on delete set null,
  source_invite_id   uuid        references public.club_invites(id) on delete set null,
  removed_at         timestamptz,
  removed_by         uuid        references public.profiles(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  unique (user_id, club_id)
);

comment on table public.club_memberships is
  'Per-club membership (role/status/lesson-pro eligibility). Source of truth '
  'starting Phase 26B2; kept in sync with legacy profiles columns during the '
  '26B-26F transition via the triggers defined later in this migration.';

-- Standard repo updated_at trigger (see trigger_set_updated_at in 0001).
-- Schema-qualified here for clarity; the function itself is unqualified in
-- its own 0001 definition, which resolves to public.trigger_set_updated_at
-- exactly as every other caller in the repo already relies on.
create trigger club_memberships_updated_at
  before update on public.club_memberships
  for each row execute function public.trigger_set_updated_at();

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
-- All three predicates require status = 'active' and removed_at is null —
-- the exact "counts as a real, active membership" definition used throughout
-- the trigger logic below and by the fail-closed helpers planned for 26B2.

-- Active memberships by user (multi-club resolver: "does this user have any
-- active membership, and how many").
create index club_memberships_user_active_idx
  on public.club_memberships (user_id)
  where status = 'active' and removed_at is null;

-- Active memberships by club (per-club active roster / member directory).
create index club_memberships_club_active_idx
  on public.club_memberships (club_id)
  where status = 'active' and removed_at is null;

-- Active administrators by club (last-admin-protection count/lock queries).
create index club_memberships_club_admin_active_idx
  on public.club_memberships (club_id)
  where role = 'admin' and status = 'active' and removed_at is null;

-- ---------------------------------------------------------------------------
-- RLS — locked down, zero policies
-- ---------------------------------------------------------------------------
-- No browser code needs direct access during 26B1. RLS is enabled with no
-- policies at all (not even narrow ones), and all table privileges are
-- revoked from anon/authenticated — the default-deny posture is exactly what
-- is wanted here. Client-facing policies are introduced only when a real
-- reader/writer needs them (Phase 26B2+).

alter table public.club_memberships enable row level security;

revoke all on public.club_memberships from public, anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. profiles.active_club_id
-- ═══════════════════════════════════════════════════════════════════════════
-- Nullable pointer to the user's active club. profiles.club_id has always
-- been a simple `references clubs(id)` with no ON DELETE action (clubs are
-- never hard-deleted by any existing RPC) — active_club_id follows the same,
-- already-established convention. A composite FK to
-- club_memberships(user_id, club_id) was evaluated in Phase 26A.1 and
-- rejected: it cannot express "status = 'active' and removed_at is null"
-- (Postgres FKs may only reference an unconditional unique constraint, not a
-- partial one), and its DELETE-action semantics interact badly with
-- profiles.id being the primary key. Full active-membership validation is
-- enforced by Trigger C (section 6 below), not by a foreign key.
--
-- This ALTER TABLE is also what makes the whole migration concurrency-safe
-- (see the header comment): it takes an ACCESS EXCLUSIVE lock on profiles
-- that is held until COMMIT, so no other session can write to profiles
-- between now and the moment the compatibility triggers (section 4-6) are
-- installed below.

alter table public.profiles
  add column active_club_id uuid references public.clubs(id);

comment on column public.profiles.active_club_id is
  'Pointer to the user''s active club. Not yet read by any policy, RPC, or '
  'application code as of Phase 26B1 — see Trigger C below for the '
  'validation that keeps it honest, and Phase 26B2 for the authorization '
  'helpers that will consume it.';

-- Defense in depth: active_club_id was never included in the authenticated
-- column-level UPDATE grant (see migration 0079, which lists only
-- first_name/last_name/phone), so this REVOKE is a documented no-op rather
-- than a behavior change — it makes the "not client-writable" intent
-- explicit and auditable rather than implicit.
revoke update (active_club_id) on public.profiles from anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Backfill — plain bulk statements, run before any new trigger exists
-- ═══════════════════════════════════════════════════════════════════════════
-- Deliberately sequenced before section 4-6 install any trigger on profiles
-- or club_memberships. Running the backfill first means these are simple,
-- reviewable, single-pass bulk statements — not hundreds of per-row trigger
-- cascades interacting with a bulk INSERT. Historical timing is preserved
-- throughout: joined_at, created_at, AND updated_at on every backfilled
-- membership row are copied from the source profile, never defaulted to the
-- migration's own now().

-- Step 1+2: one membership row for every profile that already has a club.
-- ON CONFLICT DO NOTHING is a no-op safety net (unique(user_id, club_id) can
-- only be hit here if this section were ever re-run against a database that
-- already has rows from a prior partial run).
insert into public.club_memberships (
  user_id, club_id, role, status, is_lesson_provider,
  joined_at, created_at, updated_at
)
select
  p.id,
  p.club_id,
  p.role,
  p.status,
  p.is_lesson_provider,
  p.created_at,
  p.created_at,
  p.updated_at
from public.profiles p
where p.club_id is not null
on conflict (user_id, club_id) do nothing;

-- Step 3: only after every membership row exists, backfill active_club_id.
--   • profile.status = 'active'                  -> active_club_id = club_id
--   • profile.status in ('inactive','suspended')  -> active_club_id = NULL
--   • profile.club_id is already NULL             -> untouched (stays NULL,
--     the column's own default — excluded by the WHERE clause below)
-- Legacy columns (club_id, role, status, is_lesson_provider) are never
-- touched by this step.
--
-- profiles.updated_at preservation: this UPDATE would otherwise cause the
-- existing profiles_updated_at trigger (0001_initial_schema.sql:72-74,
-- `before update on profiles for each row execute function
-- trigger_set_updated_at()`) to stamp every affected row with the migration
-- timestamp, making every existing profile look newly updated. That trigger
-- — and ONLY that trigger, never `disable trigger all`/`user` — is disabled
-- immediately before this statement and re-enabled immediately after.
-- Because this whole migration runs inside one transaction, DISABLE TRIGGER
-- is itself transactional: if any statement below fails before the matching
-- ENABLE TRIGGER runs, the entire transaction rolls back and the DISABLE
-- rolls back with it — there is no path that can COMMIT with
-- profiles_updated_at left disabled. The UPDATE itself is also scoped with
-- an IS DISTINCT FROM guard so only rows whose active_club_id actually
-- changes are touched at all.
alter table public.profiles disable trigger profiles_updated_at;

update public.profiles
   set active_club_id = case when status = 'active' then club_id else null end
 where club_id is not null
   and active_club_id is distinct from
       case when status = 'active' then club_id else null end;

alter table public.profiles enable trigger profiles_updated_at;


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Trigger A — legacy profile writer -> club_memberships
-- ═══════════════════════════════════════════════════════════════════════════
-- Covers every existing legacy writer unmodified: accept_club_invite,
-- set_member_role, set_member_status, set_lesson_provider_status. All of
-- them issue a plain `update profiles set ...` — this section makes those
-- writes correctly create/update/restore the corresponding club_memberships
-- row, with zero changes to any of those four function bodies.

-- ---------------------------------------------------------------------------
-- 4a. BEFORE INSERT OR UPDATE OF club_id — keeps active_club_id glued to a
--     *valid* (active-status) club_id. Mutates NEW only; never issues a
--     nested UPDATE, so it cannot recurse.
-- ---------------------------------------------------------------------------
create or replace function public.trg_sync_active_club_before()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.club_id is null then
    -- Leaving/never having a club: no active club either.
    new.active_club_id := null;
  elsif new.status = 'active' then
    -- The common legacy path: one club, active status.
    new.active_club_id := new.club_id;
  else
    -- club_id is set but status is inactive/suspended in this same
    -- statement (no current legacy RPC does this, but it must never be
    -- allowed to happen even defensively): active_club_id must not point
    -- at a membership that isn't active. Only clear it if it would have
    -- pointed here; otherwise leave whatever it currently is untouched.
    if new.active_club_id is not distinct from new.club_id then
      new.active_club_id := null;
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function public.trg_sync_active_club_before() from public, anon, authenticated;

create trigger profiles_sync_active_club
  before insert or update of club_id on public.profiles
  for each row
  execute function public.trg_sync_active_club_before();

-- ---------------------------------------------------------------------------
-- 4b. AFTER INSERT OR UPDATE OF club_id, role, status, is_lesson_provider —
--     projects the legacy write into club_memberships. Writes a different
--     table (club_memberships), so this is safe as an AFTER trigger.
-- ---------------------------------------------------------------------------
create or replace function public.trg_project_profile_to_membership()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.club_id is null then
    return new;
  end if;

  insert into public.club_memberships (user_id, club_id, role, status, is_lesson_provider)
  values (new.id, new.club_id, new.role, new.status, new.is_lesson_provider)
  on conflict (user_id, club_id) do update
    set role               = excluded.role,
        status             = excluded.status,
        is_lesson_provider = excluded.is_lesson_provider,
        removed_at         = null,
        removed_by         = null,
        updated_at         = now()
  where public.club_memberships.role               is distinct from excluded.role
     or public.club_memberships.status             is distinct from excluded.status
     or public.club_memberships.is_lesson_provider is distinct from excluded.is_lesson_provider
     or public.club_memberships.removed_at         is not null
     or public.club_memberships.removed_by         is not null;
  -- joined_at/created_at are intentionally absent from both the INSERT
  -- column list (defaults to now() for a genuinely new membership created
  -- through a live invitation) and the DO UPDATE SET list (preserved
  -- untouched on conflict/reactivation); updated_at IS in the DO UPDATE SET
  -- list so a real later change is still timestamped at the moment it
  -- happens, which is correct and distinct from the one-time backfill in
  -- section 3 above.

  return new;
end;
$$;

revoke execute on function public.trg_project_profile_to_membership() from public, anon, authenticated;

create trigger profiles_project_to_membership
  after insert or update of club_id, role, status, is_lesson_provider on public.profiles
  for each row
  when (new.club_id is not null)
  execute function public.trg_project_profile_to_membership();


-- ═══════════════════════════════════════════════════════════════════════════
-- 5. Trigger B — club_memberships -> active profile projection + fallback
-- ═══════════════════════════════════════════════════════════════════════════
-- Fires on INSERT, on UPDATE of the columns that can change a membership's
-- validity, and on DELETE. Handles three cases:
--   1. The changed row is the active membership and remains valid -> project
--      its values onto profiles (only when they actually differ).
--   2. The changed row was the active membership and just became invalid
--      (or was deleted) -> resolve active_club_id: exactly one remaining
--      active membership switches to it; zero or more than one clears it
--      to NULL (never guesses).
--   3. The changed row is not the active membership, but the user currently
--      has none selected, and this row just became a valid, active
--      membership, and it is now the user's ONLY active membership ->
--      auto-select it. More than one active membership leaves NULL for a
--      later explicit picker (Phase 26B2+); never guesses.

create or replace function public.trg_project_membership_to_profile()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id        uuid;
  v_club_id        uuid;
  v_is_valid_now   boolean;
  v_active_club_id uuid;
  v_total_active   int;
  v_solo_club_id   uuid;
  v_remaining      int;
  v_remaining_club uuid;
begin
  if tg_op = 'DELETE' then
    v_user_id      := old.user_id;
    v_club_id      := old.club_id;
    v_is_valid_now := false;
  else
    v_user_id      := new.user_id;
    v_club_id      := new.club_id;
    v_is_valid_now := (new.status = 'active' and new.removed_at is null);
  end if;

  select active_club_id into v_active_club_id
    from public.profiles where id = v_user_id;

  -- ── Case: this row is not the user's current active membership. ────────
  if v_active_club_id is distinct from v_club_id then

    -- Reactivation-while-unselected: only relevant when this row just
    -- became valid (never true for DELETE) and no club is currently active.
    if v_active_club_id is null and v_is_valid_now then
      select count(*) into v_total_active
        from public.club_memberships
       where user_id = v_user_id and status = 'active' and removed_at is null;

      if v_total_active = 1 then
        select club_id into v_solo_club_id
          from public.club_memberships
         where user_id = v_user_id and status = 'active' and removed_at is null;

        update public.profiles
           set active_club_id = v_solo_club_id
         where id = v_user_id
           and active_club_id is distinct from v_solo_club_id;
      end if;
      -- more than one active membership: leave NULL, defer to an explicit
      -- picker introduced in a later phase — never guess.
    end if;

    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;

  -- ── Case: this row IS the current active membership. ────────────────────
  if v_is_valid_now then
    update public.profiles
       set club_id            = new.club_id,
           role               = new.role,
           status             = new.status,
           is_lesson_provider = new.is_lesson_provider
     where id = v_user_id
       and (club_id is distinct from new.club_id
         or role is distinct from new.role
         or status is distinct from new.status
         or is_lesson_provider is distinct from new.is_lesson_provider);
    -- active_club_id is never touched in this branch.

    return new;
  end if;

  -- ── Case: the active membership just became invalid, or was deleted. ───
  select count(*) into v_remaining
    from public.club_memberships
   where user_id = v_user_id and status = 'active' and removed_at is null
     and club_id <> v_club_id;

  if v_remaining = 1 then
    select club_id into v_remaining_club
      from public.club_memberships
     where user_id = v_user_id and status = 'active' and removed_at is null
       and club_id <> v_club_id;

    update public.profiles
       set active_club_id = v_remaining_club
     where id = v_user_id and active_club_id is distinct from v_remaining_club;
  else
    -- Zero, or more than one: never guess. Clear it. Legacy columns
    -- (club_id/role/status/is_lesson_provider) are deliberately left
    -- untouched here — see the Phase 26B1 transitional-semantics note in
    -- the header comment and section 6 below; existing admin RPCs still
    -- locate and reactivate inactive users through profiles.club_id.
    update public.profiles
       set active_club_id = null
     where id = v_user_id and active_club_id is distinct from null;
  end if;

  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;

revoke execute on function public.trg_project_membership_to_profile() from public, anon, authenticated;

create trigger club_memberships_project_to_profile
  after insert or update of role, status, is_lesson_provider, removed_at, removed_by
       or delete on public.club_memberships
  for each row
  execute function public.trg_project_membership_to_profile();


-- ═══════════════════════════════════════════════════════════════════════════
-- 6. Trigger C — active_club_id validation + legacy projection
-- ═══════════════════════════════════════════════════════════════════════════
-- The database-integrity backstop: no write to profiles.active_club_id
-- (whichever code path produced it — Trigger B's fallback logic today, or
-- set_active_club() starting Phase 26B2) may result in it pointing at
-- anything other than a live, active, non-removed membership belonging to
-- that same user. BEFORE trigger, mutates NEW only — issues no nested
-- UPDATE, so it cannot recurse.

create or replace function public.trg_validate_active_club_switch()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_membership public.club_memberships%rowtype;
begin
  if new.active_club_id is null then
    -- Phase 26B1: legacy fields are intentionally left untouched when
    -- active_club_id becomes NULL — they remain available so existing
    -- admin RPCs (which still key off profiles.club_id) can continue to
    -- locate and reactivate this user. See section 5's header comment.
    return new;
  end if;

  select * into v_membership
    from public.club_memberships
   where user_id = new.id
     and club_id = new.active_club_id
     and status  = 'active'
     and removed_at is null;

  if not found then
    raise exception 'invalid_active_club';
  end if;

  new.club_id            := v_membership.club_id;
  new.role               := v_membership.role;
  new.status             := v_membership.status;
  new.is_lesson_provider := v_membership.is_lesson_provider;

  return new;
end;
$$;

revoke execute on function public.trg_validate_active_club_switch() from public, anon, authenticated;

create trigger profiles_validate_active_club_switch
  before update of active_club_id on public.profiles
  for each row
  when (new.active_club_id is distinct from old.active_club_id)
  execute function public.trg_validate_active_club_switch();

-- Ordering note: this trigger and profiles_sync_active_club (section 4a) are
-- both BEFORE triggers on profiles but bound to disjoint "UPDATE OF" column
-- lists (active_club_id vs. club_id). Postgres fires a column-list trigger
-- only when that column is a literal target of the statement's own SET
-- clause — not merely because some other BEFORE trigger mutated it via NEW
-- — so the two never co-fire on the same statement in any write path
-- introduced by this migration, and there is no ordering ambiguity to
-- resolve between them. See the migration report for the full recursion-
-- termination proof built on this same fact.

commit;
