-- 0188_membership_domain_foundation.sql
-- Phase 42A — Membership Domain Foundation.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
-- Court Time has always had exactly one lifecycle axis on a roster identity:
-- roster_members.status ('active'|'inactive', added 0117) — "is this roster
-- identity active in Court Time." That axis is synchronized with
-- club_memberships for claimed identities and driven directly by
-- remove_roster_member/restore_roster_member for unclaimed ones. It has
-- never represented, and does not become, "does this person currently hold
-- club membership" — that is a separate, club-business decision an Admin
-- makes explicitly. This migration adds that second axis without touching
-- the first one's meaning, storage, or synchronization at all.
--
-- Scope, precisely:
--   1. roster_members.membership_status (new column) — the club-business
--      membership axis: active / inactive / suspended / non_member.
--   2. membership_types (new table) — club-configurable, soft-lifecycle,
--      optionally attached to a roster_members row via a new nullable
--      membership_type_id, same-club enforced at the DB level.
--   3. is_active_club_member() — the one canonical, role-agnostic
--      active-Member predicate, private (not exposed to authenticated
--      clients), for future callers (pricing, policy) to share instead of
--      re-deriving.
--   4. Five new Admin-only, same-club RPCs: create_membership_type,
--      update_membership_type, set_membership_type_active,
--      set_roster_member_membership_type, set_roster_member_membership_status.
--
-- Explicitly NOT in this migration: pricing (Phase 42B), any UI, any
-- automated expiration/renewal/billing, any change to application
-- authorization (current_user_role()/current_user_club_id() are untouched),
-- any change to reservations/lessons/events/programs/payments/guests, and
-- no modification whatsoever to set_member_status, remove_club_member,
-- restore_club_member, remove_roster_member, or restore_roster_member —
-- see the "ROSTER LIFECYCLE INTERACTION AUDIT" section below for why that
-- is safe to leave alone.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- ROSTER LIFECYCLE INTERACTION AUDIT (performed before writing this file)
-- ═══════════════════════════════════════════════════════════════════════════
-- Confirmed via `grep` across every migration 0001-0187 that the LATEST
-- (and only post-33 era) definitions of the five functions below are all in
-- 0117_durable_member_guest_lifecycle_and_attendance.sql — nothing after
-- 0117 redefines any of them:
--   • set_member_status(p_target_user_id, p_new_status)       — 0117
--   • remove_club_member(p_target_user_id)                    — 0117
--   • restore_club_member(p_target_user_id)                   — 0117
--   • remove_roster_member(p_roster_member_id)                — 0117 (new in 0117)
--   • restore_roster_member(p_roster_member_id)                — 0117 (new in 0117)
--
-- Each one writes roster_members.status ONLY (active/inactive), via a
-- fail-closed GET DIAGNOSTICS row_count = 1 guard. None of them reads or
-- writes any column that does not already exist before this migration —
-- read in full, none contains a code path that could accidentally start
-- writing membership_status once that column exists, because none of them
-- does anything but `set status = ..., removed_at = ..., removed_by = ...`
-- (claimed path) or `set status = ..., removed_at = ..., removed_by = ...`
-- (unclaimed path). No SELECT *-then-blind-UPDATE-all-columns pattern
-- exists anywhere in this family that could accidentally clobber a sibling
-- column.
--
-- FINDING: no coupling exists and none is introduced. The preferred rule —
-- "roster lifecycle operations continue to manage roster_members.status
-- only; membership_status remains an explicit club-business decision" — is
-- satisfied by construction, with the single, explicit, one-time exception
-- of this migration's own backfill (Section 1 below). No STOP condition was
-- found; none of these five functions is touched by this migration.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. roster_members.membership_status — the new, independent business-
--    membership axis. Added nullable first so the backfill can set it
--    per-row from the EXISTING status column before the NOT NULL/CHECK are
--    applied — this is the one-time, explicitly-authorized compatibility
--    exception described above, and it reads (never writes) the untouched
--    status column.
-- ═══════════════════════════════════════════════════════════════════════════
alter table public.roster_members
  add column membership_status text;

-- Backfill: preserves current product behavior exactly. Only 'active' and
-- 'inactive' are ever written here — 'suspended' and 'non_member' are new
-- Phase 42 states with no existing signal to infer them from, so no row is
-- ever backfilled into either (no fabricated membership state).
update public.roster_members
   set membership_status = case when status = 'active' then 'active' else 'inactive' end;

alter table public.roster_members
  alter column membership_status set default 'active',
  alter column membership_status set not null;

alter table public.roster_members
  add constraint roster_members_membership_status_check
    check (membership_status in ('active', 'inactive', 'suspended', 'non_member'));

comment on column public.roster_members.membership_status is
  'Phase 42A: independent club-business membership axis — is this person
   currently a club Member (active), lapsed (inactive), temporarily
   suspended (suspended), or a known non-Member (non_member). Distinct from
   roster_members.status, which answers "is this roster identity active in
   Court Time" and is never written by anything in this migration except
   the one-time backfill above. Managed exclusively via
   set_roster_member_membership_status(); roster lifecycle RPCs
   (remove/restore_roster_member, remove/restore_club_member,
   set_member_status) do not read or write this column.';

-- Partial index for the shape the canonical predicate below queries most:
-- "is this roster identity, in this club, a currently active Member."
create index roster_members_club_active_membership_idx
  on public.roster_members (club_id)
  where status = 'active' and membership_status = 'active';

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. membership_types — club-configurable, soft-lifecycle. No hard-coded
--    categories. Case-insensitive, trimmed uniqueness per club via a
--    normalized expression index (mirrors roster_members_club_email_uniq's
--    own lower()-based approach, 0056).
-- ═══════════════════════════════════════════════════════════════════════════
create table public.membership_types (
  id         uuid        primary key default gen_random_uuid(),
  club_id    uuid        not null references public.clubs(id) on delete cascade,
  name       text        not null,
  is_active  boolean     not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint membership_types_name_nonempty check (char_length(btrim(name)) > 0),
  constraint membership_types_name_length   check (char_length(name) <= 100),

  -- Composite uniqueness target for roster_members.membership_type_id's
  -- same-club FK below (Section 3) — the established pattern in this repo
  -- for enforcing "the referenced row belongs to the same club" at the
  -- database level, not just in RPC logic (see payments' own
  -- `unique (id, club_id)` in 0143, reused the same way by 0150/0153/0156/
  -- 0181's `foreign key (payment_id, club_id) references payments(id, club_id)`).
  constraint membership_types_id_club_uniq unique (id, club_id)
);

comment on table public.membership_types is
  'Phase 42A: club-configurable membership type labels (e.g. Adult, Junior,
   Family — never hard-coded by this schema). Optional, soft-lifecycle via
   is_active; deactivation never erases existing roster_members
   assignments. Managed exclusively via create_membership_type/
   update_membership_type/set_membership_type_active.';

create unique index membership_types_club_name_uniq
  on public.membership_types (club_id, lower(btrim(name)));

create index membership_types_club_active_idx
  on public.membership_types (club_id)
  where is_active;

create trigger membership_types_updated_at
  before update on public.membership_types
  for each row execute function public.trigger_set_updated_at();

-- RLS — admin-only, same-club, matching roster_members' own policy style
-- (0056): current_user_club_id()/current_user_role() (the club_memberships-
-- backed helpers used by every RLS policy in this repo). The five RPC
-- bodies below (Section 5) use the SAME two helpers for their own
-- authorization/scoping — see that section's header for why the earlier
-- profiles%rowtype-direct draft was corrected before this migration's
-- first apply. No delete policy: Phase 42A exposes soft deactivate only,
-- never a delete RPC.
alter table public.membership_types enable row level security;

create policy "membership_types_select_admin"
  on public.membership_types for select
  using (
    club_id = current_user_club_id()
    and current_user_role() = 'admin'
  );

create policy "membership_types_insert_admin"
  on public.membership_types for insert
  with check (
    club_id = current_user_club_id()
    and current_user_role() = 'admin'
  );

create policy "membership_types_update_admin"
  on public.membership_types for update
  using (
    club_id = current_user_club_id()
    and current_user_role() = 'admin'
  )
  with check (
    club_id = current_user_club_id()
  );

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. roster_members.membership_type_id — optional. Never required for an
--    active Member. Composite FK enforces same-club at the database level,
--    independent of any RPC-layer check.
--
--    ON DELETE: deliberately NOT `set null`. A composite FK's SET NULL
--    action nulls every referencing column together — that would attempt
--    to null roster_members.club_id too, which is NOT NULL and would
--    error. Phase 42A exposes soft deactivate only (no delete RPC/UI for
--    membership_types), so the default NO ACTION (block a delete while
--    referenced) is the correct, data-preserving behavior for the one path
--    that isn't supposed to exist yet — matches the identical, unmodified
--    choice already made for payment_id-referencing composite FKs (0150,
--    0153, 0156, 0181). If physical deletion of membership_types is ever
--    exposed in a later phase, it must reassign or null out affected
--    roster_members rows explicitly first, not rely on cascade.
-- ═══════════════════════════════════════════════════════════════════════════
alter table public.roster_members
  add column membership_type_id uuid;

alter table public.roster_members
  add constraint roster_members_membership_type_club_fkey
    foreign key (membership_type_id, club_id)
    references public.membership_types (id, club_id);

comment on column public.roster_members.membership_type_id is
  'Phase 42A: optional club-configurable membership_types.id. Same-club
   enforced by a composite FK against membership_types(id, club_id) — a
   cross-club assignment is rejected by the database itself, not only by
   RPC logic. NULL is a valid, unfabricated state for any roster identity,
   including an active Member.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. is_active_club_member — the ONE canonical, role-agnostic active-Member
--    predicate. Named to be unmistakably distinct from Phase 41's
--    v_is_member_by_history/v_is_member_by_roster (those are per-request
--    IDENTITY-MATCH variables — "is the caller the same person as this
--    booking's Member" — unrelated to membership status). Private: revoked
--    from public/anon/authenticated. Every SECURITY DEFINER RPC in this
--    schema is owned by the same role that owns this function, so internal
--    callers need no explicit grant (Postgres owners always have implicit
--    EXECUTE on their own objects) — this is intentionally not a
--    client-callable RPC in 42A, closing off any cross-club membership
--    oracle.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.is_active_club_member(
  p_roster_member_id uuid,
  p_club_id          uuid
)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.roster_members rm
     where rm.id                = p_roster_member_id
       and rm.club_id           = p_club_id
       and rm.status            = 'active'
       and rm.membership_status = 'active'
  );
$$;

comment on function public.is_active_club_member(uuid, uuid) is
  'Phase 42A canonical active-Member predicate: true iff the given
   roster_members row belongs to p_club_id, has status = ''active'' AND
   membership_status = ''active''. Role-agnostic by design — a roster
   identity''s role (member/pro/staff/admin, display/intent only per 0056)
   is never consulted. A NULL p_roster_member_id (e.g. a reservation/event
   guest, which carries no roster identity at all) safely evaluates to
   false. Private helper — not granted to authenticated; callers are other
   SECURITY DEFINER functions owned by the same role. Not wired into any
   authorization/pricing decision in this migration.';

revoke execute on function public.is_active_club_member(uuid, uuid) from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. Admin RPCs — membership_types CRUD (create / rename / activate-
--    deactivate) and roster_members membership assignment (type / status).
--
--    CORRECTION PASS (post-review, before first apply): all five originally
--    authorized via a direct `profiles%rowtype` read (matching
--    add_roster_member/remove_roster_member's legacy style). That is wrong
--    for a NEW privileged RPC — profiles.role/profiles.club_id are a legacy
--    projection that can go stale relative to club_memberships (e.g. after
--    a membership is removed/deactivated but before every projection
--    trigger's effect is what the caller expects). Every function below now
--    uses the canonical, null-safe active-club pattern instead:
--
--      if auth.uid() is null then raise exception 'not_authenticated'; end if;
--      select public.current_user_club_id(), public.current_user_role()
--        into v_club_id, v_role;
--      if v_role is distinct from 'admin' then raise exception 'insufficient_role'; end if;
--
--    All data access and every audit_log write is scoped to v_club_id, not
--    v_profile.club_id. No function below references profiles.role or
--    profiles.club_id for authorization or scoping. (The no_club check from
--    the pre-correction draft is dropped as redundant: current_user_role()
--    and current_user_club_id() are derived from the same active-membership
--    row — v_role can only be 'admin' when v_club_id is also non-null.)
--
--    SECURITY DEFINER with search_path hardened throughout, as before.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── create_membership_type ─────────────────────────────────────────────
create or replace function public.create_membership_type(
  p_name text
)
returns public.membership_types
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id   uuid;
  v_role      text;
  v_name      text;
  v_dup_count int;
  v_result    public.membership_types%rowtype;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  select
    public.current_user_club_id(),
    public.current_user_role()
  into
    v_club_id,
    v_role;

  if v_role is distinct from 'admin' then
    raise exception 'insufficient_role';
  end if;

  v_name := nullif(btrim(p_name), '');
  if v_name is null then raise exception 'name_required'; end if;
  if char_length(v_name) > 100 then raise exception 'name_too_long'; end if;

  select count(*) into v_dup_count
    from public.membership_types
   where club_id = v_club_id
     and lower(name) = lower(v_name);
  if v_dup_count > 0 then raise exception 'membership_type_name_taken'; end if;

  insert into public.membership_types (club_id, name)
  values (v_club_id, v_name)
  returning * into v_result;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'create_membership_type', 'membership_type', v_result.id,
    jsonb_build_object('name', v_name)
  );

  return v_result;
end;
$$;

revoke execute on function public.create_membership_type(text) from public, anon;
grant  execute on function public.create_membership_type(text) to authenticated;

-- ─── update_membership_type (rename) ────────────────────────────────────
create or replace function public.update_membership_type(
  p_id   uuid,
  p_name text
)
returns public.membership_types
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id   uuid;
  v_role      text;
  v_type      public.membership_types%rowtype;
  v_name      text;
  v_dup_count int;
  v_result    public.membership_types%rowtype;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  select
    public.current_user_club_id(),
    public.current_user_role()
  into
    v_club_id,
    v_role;

  if v_role is distinct from 'admin' then
    raise exception 'insufficient_role';
  end if;

  select * into v_type
    from public.membership_types
   where id = p_id and club_id = v_club_id;
  if not found then raise exception 'membership_type_not_found'; end if;

  v_name := nullif(btrim(p_name), '');
  if v_name is null then raise exception 'name_required'; end if;
  if char_length(v_name) > 100 then raise exception 'name_too_long'; end if;

  select count(*) into v_dup_count
    from public.membership_types
   where club_id = v_club_id
     and lower(name) = lower(v_name)
     and id <> p_id;
  if v_dup_count > 0 then raise exception 'membership_type_name_taken'; end if;

  update public.membership_types
     set name = v_name, updated_at = now()
   where id = p_id
  returning * into v_result;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'update_membership_type', 'membership_type', p_id,
    jsonb_build_object('old_name', v_type.name, 'new_name', v_name)
  );

  return v_result;
end;
$$;

revoke execute on function public.update_membership_type(uuid, text) from public, anon;
grant  execute on function public.update_membership_type(uuid, text) to authenticated;

-- ─── set_membership_type_active (activate / deactivate) ────────────────
create or replace function public.set_membership_type_active(
  p_id        uuid,
  p_is_active boolean
)
returns public.membership_types
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
  v_role    text;
  v_type    public.membership_types%rowtype;
  v_result  public.membership_types%rowtype;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  select
    public.current_user_club_id(),
    public.current_user_role()
  into
    v_club_id,
    v_role;

  if v_role is distinct from 'admin' then
    raise exception 'insufficient_role';
  end if;

  if p_is_active is null then raise exception 'is_active_required'; end if;

  select * into v_type
    from public.membership_types
   where id = p_id and club_id = v_club_id;
  if not found then raise exception 'membership_type_not_found'; end if;

  -- Deactivation never touches roster_members — existing assignments
  -- (historical or current) are preserved exactly as-is; only new
  -- assignment of an inactive type is blocked, and only by
  -- set_roster_member_membership_type below. This UPDATE requests a
  -- row-lock strength that conflicts with, and therefore waits behind, any
  -- FOR SHARE lock set_roster_member_membership_type is holding on this
  -- same row while it validates an in-flight assignment — see that
  -- function's own lock comment for the full race this closes.
  update public.membership_types
     set is_active = p_is_active, updated_at = now()
   where id = p_id
  returning * into v_result;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'set_membership_type_active', 'membership_type', p_id,
    jsonb_build_object('old_is_active', v_type.is_active, 'new_is_active', p_is_active)
  );

  return v_result;
end;
$$;

revoke execute on function public.set_membership_type_active(uuid, boolean) from public, anon;
grant  execute on function public.set_membership_type_active(uuid, boolean) to authenticated;

-- ─── set_roster_member_membership_type ──────────────────────────────────
-- p_membership_type_id = NULL clears the assignment and is always allowed.
-- The roster_members row is still locked FOR UPDATE to preserve one stable
-- pre-mutation snapshot; no membership_types row lock is taken when
-- clearing because no target type's active state is being relied upon.
--
-- Cross-club assignment is rejected twice over: the SELECT below is
-- club-scoped (raises membership_type_not_found for a cross-club id, never
-- leaking whether it exists elsewhere), and the composite FK (Section 3)
-- would independently reject the write even if this RPC had a bug.
--
-- CONCURRENCY (post-review correction): the roster row is now locked FOR
-- UPDATE immediately after resolving it — matching this repo's established
-- convention of locking the row a function is about to modify at SELECT
-- time (e.g. create_club_invite's own `for update` on roster_members,
-- 0107) rather than reading it unlocked and only protecting the write at
-- UPDATE time. This also serializes two concurrent assignment attempts
-- against the SAME roster member, so they can't both compute their
-- inactive/no-op decision from the same stale v_roster snapshot. When
-- p_membership_type_id is non-null, the membership_types row is then
-- locked FOR SHARE before its is_active flag is relied on — closing a
-- second, independent race where (1) this function reads the type as
-- active, (2) a concurrent set_membership_type_active deactivates it, (3)
-- this function's UPDATE proceeds and assigns an already-inactive type.
-- FOR SHARE, not FOR UPDATE, for the type row: multiple concurrent
-- assignments/readers of the SAME still-active type (against DIFFERENT
-- roster members) must be able to proceed together (FOR SHARE locks are
-- mutually compatible with each other), while set_membership_type_active's
-- UPDATE (which needs a stronger lock to change the row) blocks until
-- every FOR SHARE holder's transaction commits — so the type's active
-- state observed here cannot flip out from under this function for the
-- rest of its transaction. Both locks are held only until this function's
-- own transaction ends (standard row-lock lifetime).
--
-- LOCK ORDER: roster_members (FOR UPDATE) is acquired strictly before
-- membership_types (FOR SHARE) within this function — the only function in
-- this migration that ever touches both tables. set_membership_type_active
-- only ever locks membership_types; set_roster_member_membership_status
-- only ever locks roster_members; create_membership_type/
-- update_membership_type only ever touch membership_types. No function
-- anywhere in this migration — or, since membership_types did not exist
-- before 0188, anywhere in the schema — acquires membership_types before
-- roster_members. With a single function establishing the only order used
-- for this pair, and no reverse-order path anywhere else, no deadlock
-- cycle between these two tables is possible.
create or replace function public.set_roster_member_membership_type(
  p_roster_member_id   uuid,
  p_membership_type_id uuid default null
)
returns public.roster_members
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id      uuid;
  v_role         text;
  v_roster       public.roster_members%rowtype;
  v_type         public.membership_types%rowtype;
  v_result       public.roster_members%rowtype;
  v_rows_updated int;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  select
    public.current_user_club_id(),
    public.current_user_role()
  into
    v_club_id,
    v_role;

  if v_role is distinct from 'admin' then
    raise exception 'insufficient_role';
  end if;

  -- Lock the roster row FOR UPDATE immediately — see this function's own
  -- header comment above for why (this repo's established convention, plus
  -- closing a same-row concurrent-assignment race) and for the full
  -- lock-order argument.
  select * into v_roster
    from public.roster_members
   where id = p_roster_member_id and club_id = v_club_id
   for update;
  if not found then raise exception 'roster_member_not_found'; end if;

  if p_membership_type_id is not null then
    -- Lock this club-scoped membership_types row FOR SHARE before relying
    -- on is_active — acquired strictly after the roster_members lock above.
    select * into v_type
      from public.membership_types
     where id = p_membership_type_id and club_id = v_club_id
     for share;
    if not found then raise exception 'membership_type_not_found'; end if;

    -- An inactive type may remain attached wherever it already is
    -- (no forced clearing), but is not ASSIGNABLE as a new selection — the
    -- only exempt case is re-saving the exact type this roster member
    -- already holds (a true no-op, not a new assignment).
    if not v_type.is_active and p_membership_type_id is distinct from v_roster.membership_type_id then
      raise exception 'membership_type_inactive';
    end if;
  end if;

  update public.roster_members
     set membership_type_id = p_membership_type_id,
         updated_at         = now()
   where id      = p_roster_member_id
     and club_id = v_club_id
  returning * into v_result;

  get diagnostics v_rows_updated = row_count;
  if v_rows_updated <> 1 then raise exception 'roster_member_update_failed'; end if;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'set_roster_member_membership_type', 'roster_member', p_roster_member_id,
    jsonb_build_object(
      'old_membership_type_id', v_roster.membership_type_id,
      'new_membership_type_id', p_membership_type_id
    )
  );

  return v_result;
end;
$$;

revoke execute on function public.set_roster_member_membership_type(uuid, uuid) from public, anon;
grant  execute on function public.set_roster_member_membership_type(uuid, uuid) to authenticated;

-- ─── set_roster_member_membership_status ────────────────────────────────
-- Writes ONLY roster_members.membership_status — never status. This is the
-- sole mutator of membership_status outside this migration's own one-time
-- backfill.
create or replace function public.set_roster_member_membership_status(
  p_roster_member_id  uuid,
  p_membership_status text
)
returns public.roster_members
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id      uuid;
  v_role         text;
  v_roster       public.roster_members%rowtype;
  v_result       public.roster_members%rowtype;
  v_rows_updated int;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  select
    public.current_user_club_id(),
    public.current_user_role()
  into
    v_club_id,
    v_role;

  if v_role is distinct from 'admin' then
    raise exception 'insufficient_role';
  end if;

  -- NULL-safe: `x not in (...)` evaluates to NULL (neither true nor false)
  -- when x is NULL, which would silently fall through an `if ... then
  -- raise` guard instead of rejecting it. The explicit `is null or` makes
  -- NULL fail closed exactly like any other disallowed value.
  if p_membership_status is null
     or p_membership_status not in ('active', 'inactive', 'suspended', 'non_member') then
    raise exception 'invalid_membership_status';
  end if;

  select * into v_roster
    from public.roster_members
   where id = p_roster_member_id and club_id = v_club_id;
  if not found then raise exception 'roster_member_not_found'; end if;

  update public.roster_members
     set membership_status = p_membership_status,
         updated_at        = now()
   where id      = p_roster_member_id
     and club_id = v_club_id
  returning * into v_result;

  get diagnostics v_rows_updated = row_count;
  if v_rows_updated <> 1 then raise exception 'roster_member_update_failed'; end if;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'set_roster_member_membership_status', 'roster_member', p_roster_member_id,
    jsonb_build_object(
      'old_membership_status', v_roster.membership_status,
      'new_membership_status', p_membership_status
    )
  );

  return v_result;
end;
$$;

revoke execute on function public.set_roster_member_membership_status(uuid, text) from public, anon;
grant  execute on function public.set_roster_member_membership_status(uuid, text) to authenticated;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration created in
-- this checkpoint)
-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Drop the five new RPCs outright (all new, safe to drop):
--    create_membership_type(text), update_membership_type(uuid, text),
--    set_membership_type_active(uuid, boolean),
--    set_roster_member_membership_type(uuid, uuid),
--    set_roster_member_membership_status(uuid, text).
-- 2. Drop is_active_club_member(uuid, uuid).
-- 3. `alter table public.roster_members drop constraint
--    roster_members_membership_type_club_fkey;`
--    `alter table public.roster_members drop column membership_type_id;`
-- 4. `drop table public.membership_types;` (cascades its own indexes/
--    policies/trigger).
-- 5. `drop index public.roster_members_club_active_membership_idx;`
--    `alter table public.roster_members drop constraint
--    roster_members_membership_status_check;`
--    `alter table public.roster_members drop column membership_status;`
-- No other table, policy, or function is touched by this migration, and
-- set_member_status/remove_club_member/restore_club_member/
-- remove_roster_member/restore_roster_member are never redefined here, so
-- none of them needs any rollback action.
