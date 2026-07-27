-- 0083_auth_context_and_membership_controls.sql
-- Phase 26C1: Auth Context and Admin Membership Controls
--
-- Converts the application's authenticated-account lookup and the five
-- Admin membership-management RPCs from profiles.club_id/role/status/
-- is_lesson_provider to club_memberships as the authoritative source,
-- built entirely on the Phase 26B2 fail-closed helpers
-- (current_user_club_id(), current_user_role()). Also carries the one
-- remaining narrow RLS correction flagged in Phase 26B2's audit.
--
-- FOCUSED AUDIT FINDINGS (see the Phase 26C1 report for full detail):
--   • get_members(), get_admin_member_detail(uuid), set_member_role(uuid,
--     text), set_member_status(uuid, text), and set_lesson_provider_status
--     (uuid, boolean) all authorized the actor via a raw
--     `select * into v_profile/v_actor from profiles where id = auth.uid()`
--     and scoped/wrote target rows via profiles.club_id/role/status/
--     is_lesson_provider directly — none of them used
--     current_user_club_id()/current_user_role() at all.
--   • lesson_requests_select_admin (0069) already used
--     current_user_club_id() for club scope but bypassed
--     current_user_role() for its admin check via an inline
--     `(select role from public.profiles where id = auth.uid())` — exactly
--     the partial bypass flagged (not corrected) in migration 0082's audit.
--   • src/lib/supabase/user.ts's getAuthProfile() and every layout/route
--     guard/profile page read profiles.club_id/role/status/
--     is_lesson_provider directly via a plain `.from("profiles").select()`
--     — none of them called any Phase 26B helper.
--
-- No other RLS policy is touched. No unconverted RPC (Calendar,
-- reservations, Events, Bookings, Lessons, notifications, settings,
-- audit-log) is touched — those still read profiles.club_id/role/status/
-- is_lesson_provider directly and remain correct only because migration
-- 0081's compatibility triggers keep those legacy columns synchronized with
-- the active membership. That is expected and intentional for Phase 26C1;
-- converting them is Phase 26C2-26C4's job.
--
-- ATOMICITY: the entire file runs inside one transaction. No exception
-- handler here catches and swallows a migration failure.
--
-- Independently safe to deploy and leave in production before Phase 26C2
-- begins: every converted function preserves its existing application-
-- facing parameter names, return contract, and stable error vocabulary: no
-- application code change is REQUIRED for the database half of this
-- migration to be safe to sit on (the application changes in this same
-- checkpoint are a product improvement — multi-club-correct authorization —
-- not a compatibility requirement for 0083 itself).
--
-- Apply in Supabase SQL Editor (cloud only). Not applied by this checkpoint.

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. get_current_account_context() — new
-- ═══════════════════════════════════════════════════════════════════════════
-- Naming checked against existing convention: every read-only RPC in this
-- schema is `get_<noun>` (get_members, get_admin_member_detail,
-- get_club_invites, get_roster_members, get_audit_log, get_club_pros, ...).
-- get_current_account_context() fits that pattern.
--
-- Returns exactly one row for any authenticated caller with a profiles row
-- (which is every real user, via handle_new_user). Global identity fields
-- always populate. Active-membership and active-club fields populate only
-- when a valid active membership exists (public._current_user_active_
-- membership(), the same Phase 26B2 primitive current_user_club_id()/
-- current_user_role() are built on) — NULL for a no-club user AND for an
-- inactive/suspended/removed membership alike, by design: this checkpoint
-- does not attempt to surface a non-active membership's stale role/status
-- for display (that is a Phase 26E memberships-list concern). Never reads
-- profiles.club_id/role/status/is_lesson_provider for the returned
-- membership fields — those come exclusively from club_memberships via the
-- private helper.
create or replace function public.get_current_account_context()
returns table (
  id                 uuid,
  first_name         text,
  last_name          text,
  phone              text,
  created_at         timestamptz,
  updated_at         timestamptz,
  active_club_id     uuid,
  role               text,
  status             text,
  is_lesson_provider boolean,
  club_name          text,
  club_slug          text,
  theme_key          text
)
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_profile             public.profiles%rowtype;
  -- _current_user_active_membership() returns only these four columns
  -- (club_id, role, status, is_lesson_provider) — NOT a full
  -- club_memberships row (which also has id, user_id, joined_at,
  -- invited_by, source_invite_id, removed_at, removed_by, created_at,
  -- updated_at). Assigning its result into a public.club_memberships%rowtype
  -- variable via `select m.* into v_membership` is a positional/column-count
  -- mismatch that fails at runtime — corrected here with four scalar
  -- variables matching the helper's actual return shape exactly.
  v_active_club_id      uuid;
  v_role                text;
  v_status              text;
  v_is_lesson_provider  boolean;
  v_club_name           text;
  v_club_slug           text;
  v_theme_key           text;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  select p.* into v_profile from public.profiles p where p.id = auth.uid();
  if not found then
    raise exception 'not_authenticated';
  end if;

  select m.club_id, m.role, m.status, m.is_lesson_provider
    into v_active_club_id, v_role, v_status, v_is_lesson_provider
    from public._current_user_active_membership() m;

  if v_active_club_id is not null then
    select c.name, c.slug, c.theme_key
      into v_club_name, v_club_slug, v_theme_key
      from public.clubs c
     where c.id = v_active_club_id;
  end if;

  return query
    select
      v_profile.id,
      v_profile.first_name,
      v_profile.last_name,
      v_profile.phone,
      v_profile.created_at,
      v_profile.updated_at,
      v_active_club_id,
      v_role,
      v_status,
      v_is_lesson_provider,
      v_club_name,
      v_club_slug,
      v_theme_key;
end;
$$;

revoke execute on function public.get_current_account_context() from public, anon;
grant  execute on function public.get_current_account_context() to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. get_members() — converted
-- ═══════════════════════════════════════════════════════════════════════════
-- Application-facing return contract is byte-identical to the 0080
-- definition — same columns, same order, same types. Only the
-- authorization and data source change.
--
-- Removed-membership decision: EXCLUDED (cm.removed_at is null). No
-- removed-history view exists anywhere in this product today (no such RPC
-- or UI was ever built); the current directory has never shown a removed
-- user, so this preserves current product behavior — "removed" is a
-- Phase 26 concept with no legacy equivalent to preserve either way.
-- Inactive and suspended members remain included (no status filter),
-- exactly matching the current directory's existing inclusive behavior.
drop function if exists public.get_members();

create or replace function public.get_members()
returns table (
  id                 uuid,
  first_name         text,
  last_name          text,
  phone              text,
  role               text,
  status             text,
  created_at         timestamptz,
  email              text,
  is_lesson_provider boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_club_id uuid;
  v_actor_role    text;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;

  -- Capture the actor's active club and role together, in one statement,
  -- from one snapshot. Resolving current_user_club_id() and
  -- current_user_role() as two separate calls would let a concurrent
  -- account-global active-club switch (set_active_club, another session)
  -- land between them, potentially pairing an Admin role from one club
  -- with a different now-active club. Neither helper is called again below
  -- — every subsequent lookup uses only v_actor_club_id.
  select public.current_user_club_id(), public.current_user_role()
    into v_actor_club_id, v_actor_role;

  if v_actor_role is distinct from 'admin' then
    raise exception 'insufficient_role';
  end if;

  return query
    select
      p.id,
      p.first_name,
      p.last_name,
      p.phone,
      cm.role,
      cm.status,
      p.created_at,
      u.email::text as email,
      cm.is_lesson_provider
    from public.club_memberships cm
    join public.profiles p on p.id = cm.user_id
    left join auth.users u on u.id = p.id
   where cm.club_id = v_actor_club_id
     and cm.removed_at is null
   order by p.last_name asc nulls last, p.first_name asc nulls last;
end;
$$;

revoke execute on function public.get_members() from public, anon;
grant  execute on function public.get_members() to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. get_admin_member_detail(uuid) — converted
-- ═══════════════════════════════════════════════════════════════════════════
-- Return contract byte-identical to 0080. The distinct pre-0083
-- `no_club` error (raised when the actor had no club) is subsumed by
-- `insufficient_role` — verified against src/app/(app)/admin/members/[id]/
-- page.tsx during the focused audit: that page only branches on
-- `member_not_found`, never on `no_club`, so this is a harmless
-- consolidation, not an application-visible change. Target lookup allows
-- active/inactive/suspended (no status filter), excludes removed
-- (cm.removed_at is null) — same decision as get_members, same reasoning.
drop function if exists public.get_admin_member_detail(uuid);

create or replace function public.get_admin_member_detail(
  p_member_id uuid
)
returns table (
  id                          uuid,
  first_name                  text,
  last_name                   text,
  phone                       text,
  role                        text,
  status                      text,
  created_at                  timestamptz,
  email                       text,
  is_lesson_provider          boolean,
  attended_event_count        bigint,
  event_no_show_count         bigint,
  completed_lesson_count      bigint,
  member_lesson_no_show_count bigint
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_club_id uuid;
  v_actor_role    text;
  v_membership    public.club_memberships%rowtype;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;

  -- Capture actor club and role together, one statement, one snapshot —
  -- see get_members() above for the full rationale. No further call to
  -- either helper below; only v_actor_club_id is used.
  select public.current_user_club_id(), public.current_user_role()
    into v_actor_club_id, v_actor_role;

  if v_actor_role is distinct from 'admin' then
    raise exception 'insufficient_role';
  end if;

  select cm.* into v_membership
    from public.club_memberships cm
   where cm.user_id = p_member_id
     and cm.club_id = v_actor_club_id
     and cm.removed_at is null;

  if not found then
    raise exception 'member_not_found';
  end if;

  return query
    select
      p.id,
      p.first_name,
      p.last_name,
      p.phone,
      v_membership.role,
      v_membership.status,
      p.created_at,
      u.email::text as email,
      v_membership.is_lesson_provider,
      (
        select count(*) from public.event_participants ep
          join public.events ev on ev.id = ep.event_id
         where ep.profile_id        = p_member_id
           and ep.attendance_status = 'attended'
           and ev.club_id           = v_actor_club_id
      ) as attended_event_count,
      (
        select count(*) from public.event_participants ep
          join public.events ev on ev.id = ep.event_id
         where ep.profile_id        = p_member_id
           and ep.attendance_status = 'no_show'
           and ev.club_id           = v_actor_club_id
      ) as event_no_show_count,
      (
        select count(*) from public.lesson_requests lr
         where lr.member_id      = p_member_id
           and lr.club_id        = v_actor_club_id
           and lr.lesson_outcome = 'completed'
      ) as completed_lesson_count,
      (
        select count(*) from public.lesson_requests lr
         where lr.member_id      = p_member_id
           and lr.club_id        = v_actor_club_id
           and lr.lesson_outcome = 'member_no_show'
      ) as member_lesson_no_show_count
    from public.profiles p
    left join auth.users u on u.id = p.id
   where p.id = p_member_id;
end;
$$;

revoke execute on function public.get_admin_member_detail(uuid) from public, anon;
grant  execute on function public.get_admin_member_detail(uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. set_member_role(uuid, text) — converted
-- ═══════════════════════════════════════════════════════════════════════════
-- Parameter names, return type (void), and every existing stable error code
-- (not_authenticated, insufficient_role, invalid_role, user_not_found,
-- cannot_change_own_role, last_admin) are preserved exactly — verified
-- against src/app/(app)/admin/members/actions.ts's ERROR_MESSAGES map during
-- the focused audit.
--
-- LOCK ORDER (see also set_member_status and set_lesson_provider_status
-- below, and set_active_club in 0082): this function locks the TARGET's
-- profiles row FIRST — before touching any club_memberships row — even
-- though it never reads or writes that row directly. This exists solely to
-- preserve a consistent cross-function lock order with set_active_club,
-- which locks the caller's own profiles row first and a club_memberships
-- row second. Without this, this function's actual lock order would be
-- club_memberships-first (via the last-admin FOR UPDATE below) and
-- profiles-second (via migration 0081's Trigger B, which fires as a side
-- effect of the UPDATE further down and issues a plain UPDATE — itself an
-- implicit row lock — on the target's profiles row when that target's
-- active_club_id equals this club). That would be the exact opposite order
-- from set_active_club, and is reachable: if the target of a role-driven
-- demotion is concurrently calling set_active_club to switch INTO this same
-- club, the two transactions would each hold one of the two locks the other
-- needs, satisfying the classic cycle condition for a real deadlock.
-- Locking the target's profiles row first here closes that cycle: whichever
-- transaction acquires the target's profiles-row lock first now proceeds to
-- completion before the other can start its own chain, so the two
-- transactions serialize instead of deadlocking. Postgres's own deadlock
-- detector remains a backstop even if this reasoning is incomplete for some
-- case not enumerated here — a caught deadlock aborts one side cleanly with
-- 'deadlock_detected' rather than hanging.
create or replace function public.set_member_role(
  p_target_user_id uuid,
  p_new_role       text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_club_id uuid;
  v_actor_role    text;
  v_target        public.club_memberships%rowtype;
  v_admin_count   int;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;

  -- Capture actor club and role together, one statement, one snapshot —
  -- see get_members() above for the full rationale (prevents a concurrent
  -- set_active_club in another session from pairing an Admin role from one
  -- club with a different now-active club). No further call to either
  -- helper below; only v_actor_club_id is used.
  select public.current_user_club_id(), public.current_user_role()
    into v_actor_club_id, v_actor_role;

  if v_actor_role is distinct from 'admin' then
    raise exception 'insufficient_role';
  end if;

  if p_new_role not in ('member', 'pro', 'admin') then
    raise exception 'invalid_role';
  end if;

  -- Lock order: target's profiles row first (see header comment above).
  perform 1 from public.profiles where id = p_target_user_id for update;

  select cm.* into v_target
    from public.club_memberships cm
   where cm.user_id = p_target_user_id
     and cm.club_id = v_actor_club_id
     and cm.removed_at is null;

  if not found then raise exception 'user_not_found'; end if;

  if auth.uid() = p_target_user_id then
    raise exception 'cannot_change_own_role';
  end if;

  if v_target.role = 'admin' and p_new_role <> 'admin' then
    -- Lock all active, non-removed admin memberships in the active club to
    -- serialize concurrent demotions (mirrors the pre-0083 last-admin guard,
    -- now against club_memberships instead of profiles).
    perform cm.id
      from public.club_memberships cm
     where cm.club_id    = v_actor_club_id
       and cm.role       = 'admin'
       and cm.status     = 'active'
       and cm.removed_at is null
     for update;

    select count(*) into v_admin_count
      from public.club_memberships cm
     where cm.club_id    = v_actor_club_id
       and cm.role       = 'admin'
       and cm.status     = 'active'
       and cm.removed_at is null
       and cm.user_id   <> p_target_user_id;

    if v_admin_count = 0 then
      raise exception 'last_admin';
    end if;
  end if;

  -- Preserve role/provider synchronization exactly as before (0073):
  --   pro -> is_lesson_provider true; member -> false; admin -> unchanged.
  -- Writes club_memberships directly; migration 0081's Trigger B projects
  -- this onto the target's legacy profiles fields when this club is that
  -- target's active club. No direct profiles write here.
  update public.club_memberships cm
     set role               = p_new_role,
         is_lesson_provider = case
           when p_new_role = 'pro'    then true
           when p_new_role = 'member' then false
           else cm.is_lesson_provider
         end
   where cm.user_id = p_target_user_id
     and cm.club_id = v_actor_club_id;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_actor_club_id, auth.uid(), 'set_member_role', 'profile', p_target_user_id,
    jsonb_build_object('old_role', v_target.role, 'new_role', p_new_role)
  );
end;
$$;

revoke execute on function public.set_member_role(uuid, text) from public, anon;
grant  execute on function public.set_member_role(uuid, text) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 5. set_member_status(uuid, text) — converted
-- ═══════════════════════════════════════════════════════════════════════════
-- Parameter names, return type, and every stable error code
-- (not_authenticated, insufficient_role, invalid_status, user_not_found,
-- cannot_change_own_status, last_admin) preserved exactly. Same lock-order
-- rationale as set_member_role above: target's profiles row is locked
-- first.
create or replace function public.set_member_status(
  p_target_user_id uuid,
  p_new_status     text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_club_id uuid;
  v_actor_role    text;
  v_target        public.club_memberships%rowtype;
  v_admin_count   int;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;

  -- Capture actor club and role together, one statement, one snapshot —
  -- see get_members() above for the full rationale. No further call to
  -- either helper below; only v_actor_club_id is used.
  select public.current_user_club_id(), public.current_user_role()
    into v_actor_club_id, v_actor_role;

  if v_actor_role is distinct from 'admin' then
    raise exception 'insufficient_role';
  end if;

  if p_new_status not in ('active', 'inactive') then
    raise exception 'invalid_status';
  end if;

  -- Lock order: target's profiles row first (see set_member_role's header
  -- comment above for the full deadlock-avoidance rationale — identical
  -- risk here, since this function's UPDATE also drives migration 0081's
  -- Trigger B, which may issue a plain UPDATE on the target's profiles row).
  perform 1 from public.profiles where id = p_target_user_id for update;

  select cm.* into v_target
    from public.club_memberships cm
   where cm.user_id = p_target_user_id
     and cm.club_id = v_actor_club_id
     and cm.removed_at is null;

  if not found then raise exception 'user_not_found'; end if;

  if auth.uid() = p_target_user_id then
    raise exception 'cannot_change_own_status';
  end if;

  if v_target.role = 'admin' and p_new_status = 'inactive' then
    perform cm.id
      from public.club_memberships cm
     where cm.club_id    = v_actor_club_id
       and cm.role       = 'admin'
       and cm.status     = 'active'
       and cm.removed_at is null
     for update;

    select count(*) into v_admin_count
      from public.club_memberships cm
     where cm.club_id    = v_actor_club_id
       and cm.role       = 'admin'
       and cm.status     = 'active'
       and cm.removed_at is null
       and cm.user_id   <> p_target_user_id;

    if v_admin_count = 0 then
      raise exception 'last_admin';
    end if;
  end if;

  -- Writes club_memberships directly. Deactivation: migration 0081's
  -- Trigger B resolves or clears active_club_id safely (reassigns to
  -- another active membership if exactly one remains, else clears it —
  -- never guesses). Reactivation: Trigger B restores the sole remaining
  -- active membership as active_club_id when this was the only one. No
  -- direct profiles write here.
  update public.club_memberships
     set status = p_new_status
   where user_id = p_target_user_id
     and club_id = v_actor_club_id;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_actor_club_id, auth.uid(), 'set_member_status', 'profile', p_target_user_id,
    jsonb_build_object('old_status', v_target.status, 'new_status', p_new_status)
  );
end;
$$;

revoke execute on function public.set_member_status(uuid, text) from public, anon;
grant  execute on function public.set_member_status(uuid, text) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 6. set_lesson_provider_status(uuid, boolean) — converted
-- ═══════════════════════════════════════════════════════════════════════════
-- Parameter names, return type, and stable errors (not_authenticated,
-- insufficient_role, user_not_found, target_not_admin_role) preserved.
-- Self-designation remains supported (no self-check existed in the 0080
-- version; none is added here). Idempotent no-op path preserved exactly.
--
-- The pre-0083 `inactive_actor`/`no_club` checks are removed as now
-- structurally unreachable: current_user_role() only ever returns 'admin'
-- when the caller has a status='active', non-removed membership with a
-- non-null club — exactly the two conditions those checks used to test
-- separately against profiles.status/club_id. This was flagged as an
-- anticipated simplification in migration 0082's own audit commentary.
-- Their entries in src/app/(app)/admin/members/[id]/actions.ts's error map
-- are harmless to leave in place (unreferenced, not incorrect) and are not
-- touched by this migration.
create or replace function public.set_lesson_provider_status(
  p_target_user_id uuid,
  p_enabled        boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_club_id uuid;
  v_actor_role    text;
  v_target        public.club_memberships%rowtype;
  v_old_val       boolean;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;

  -- Capture actor club and role together, one statement, one snapshot —
  -- see get_members() above for the full rationale. No further call to
  -- either helper below; only v_actor_club_id is used.
  select public.current_user_club_id(), public.current_user_role()
    into v_actor_club_id, v_actor_role;

  if v_actor_role is distinct from 'admin' then
    raise exception 'insufficient_role';
  end if;

  -- Lock order: target's profiles row first — same rationale as
  -- set_member_role/set_member_status above; this function's UPDATE also
  -- drives Trigger B, which may touch the target's profiles row.
  perform 1 from public.profiles where id = p_target_user_id for update;

  select cm.* into v_target
    from public.club_memberships cm
   where cm.user_id = p_target_user_id
     and cm.club_id = v_actor_club_id
     and cm.removed_at is null;

  if not found then raise exception 'user_not_found'; end if;

  if v_target.role <> 'admin' then
    raise exception 'target_not_admin_role';
  end if;

  v_old_val := v_target.is_lesson_provider;
  if v_old_val = p_enabled then
    return;
  end if;

  update public.club_memberships
     set is_lesson_provider = p_enabled
   where user_id = p_target_user_id
     and club_id = v_actor_club_id;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_actor_club_id, auth.uid(), 'set_lesson_provider_status', 'profile', p_target_user_id,
    jsonb_build_object('old_value', v_old_val, 'new_value', p_enabled)
  );
end;
$$;

revoke execute on function public.set_lesson_provider_status(uuid, boolean) from public, anon;
grant  execute on function public.set_lesson_provider_status(uuid, boolean) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 7. lesson_requests_select_admin — narrow RLS correction
-- ═══════════════════════════════════════════════════════════════════════════
-- Before: club_id = current_user_club_id() AND (select role from
-- public.profiles where id = auth.uid()) = 'admin' — the club check already
-- used the helper; the admin check bypassed it via an inline profiles.role
-- lookup, flagged (not corrected) in migration 0082.
-- After: both halves use the Phase 26B2 helpers. current_user_role() is
-- NULL-safe as an RLS predicate (a NULL comparison excludes the row rather
-- than including it), so no IS DISTINCT FROM is needed here — this exactly
-- matches every other "_admin" policy already in the schema
-- (club_invites_select_admin, roster_members_select_admin, etc.).
-- Member and Pro lesson-request policies are untouched.
alter policy "lesson_requests_select_admin" on public.lesson_requests
  using (
    club_id = public.current_user_club_id()
    and public.current_user_role() = 'admin'
  );

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration is created
-- in this checkpoint)
-- ═══════════════════════════════════════════════════════════════════════════
-- Rolling back 0083 must NOT roll back 0081 or 0082. To revert in place:
--   1. CREATE OR REPLACE the five pre-0083 RPC bodies (get_members,
--      get_admin_member_detail, set_member_role, set_member_status,
--      set_lesson_provider_status) — full pre-0083 text is in migrations
--      0080 (get_members, get_admin_member_detail, set_lesson_provider_
--      status), 0073 (set_member_role), and 0037 (set_member_status).
--      get_members and get_admin_member_detail require DROP FUNCTION first
--      (RETURNS TABLE cannot change via CREATE OR REPLACE), exactly as
--      those original migrations themselves noted.
--   2. ALTER POLICY "lesson_requests_select_admin" ON public.lesson_requests
--        USING (
--          club_id = current_user_club_id()
--          and (select role from public.profiles where id = auth.uid()) = 'admin'
--        );
--   3. DROP FUNCTION public.get_current_account_context();
--      (only after reverting src/lib/supabase/user.ts's getAuthProfile()
--      back to its pre-26C1 direct-profiles-select form — see the
--      application-layer changes in this same checkpoint).
-- club_memberships, profiles.active_club_id, all 0081 compatibility
-- triggers, and all 0082 authorization helpers remain untouched by this
-- rollback.
