-- 0086_per_club_membership_administration.sql
-- Phase 26D2: Per-Club Membership Administration
--
-- Extends the existing Admin membership-management RPCs (set_member_status,
-- get_members, get_admin_member_detail, all last touched in 0083) with the
-- repository's full status vocabulary (active/inactive/suspended) and
-- explicit removal/restoration via club_memberships.removed_at/removed_by.
-- Adds two new RPCs: remove_club_member and restore_club_member.
--
-- FOCUSED AUDIT FINDINGS (membership-administration surface only; the
-- broader Phase 26 architecture audit is not repeated here):
--   • set_member_status(uuid, text) (0083) only accepted
--     ('active', 'inactive') — no 'suspended' support, and no path to
--     removed_at/removed_by at all.
--   • The last-admin guard in set_member_status and set_member_role (0083)
--     fires on `v_target.role = 'admin' AND <status-changing condition>`
--     without also requiring the target's CURRENT status to already be
--     'active'. This is harmless for the existing active/inactive pair in
--     isolation, but extending the same unguarded pattern to 'suspended'
--     and to removal would incorrectly block operations on a target who
--     isn't currently counted as an active admin at all (e.g. suspending an
--     already-inactive admin). Corrected here for set_member_status and the
--     two new RPCs by additionally requiring v_target.status = 'active'
--     before the last-admin count applies. set_member_role's own,
--     independent instance of this same shape is left untouched — role
--     changes are out of this checkpoint's scope, and this is a pre-
--     existing, unrelated code path.
--   • get_members()/get_admin_member_detail(uuid) (0083) both exclude
--     removed memberships from their target/listing scope entirely
--     (cm.removed_at is null), with no application-reachable way to find or
--     restore a removed member — extended below so a restore capability has
--     something to act on.
--   • Migration 0081's Trigger B (club_memberships -> profiles projection
--     and active_club_id fallback) already fires on updates to removed_at/
--     removed_by, not just role/status/is_lesson_provider — confirmed by
--     inspecting its trigger definition (`after insert or update of role,
--     status, is_lesson_provider, removed_at, removed_by or delete`). No
--     change to any 0081 trigger is required: removal and restoration both
--     correctly resolve or clear the target's active_club_id, or restore it
--     only when exactly one valid alternative exists, using the exact same
--     logic already built and tested for status changes.
--
-- No RLS policy, no 0081/0082 helper or trigger, and no other RPC is
-- touched. Invitation acceptance (0084) and club switching (0082/0085) are
-- untouched.
--
-- ATOMICITY: the entire file runs inside one transaction. No exception
-- handler here catches and swallows a migration failure.
--
-- Apply in Supabase SQL Editor (cloud only). Not applied by this checkpoint.

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. set_member_status(uuid, text) — extended
-- ═══════════════════════════════════════════════════════════════════════════
-- Adds 'suspended' to the accepted status vocabulary. Parameter names,
-- return type, and every existing stable error code are preserved.
-- Last-admin guard corrected (see header note above): now requires the
-- target to currently be an active, non-removed admin before the guard
-- applies — previously fired on role alone, regardless of current status.
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

  select public.current_user_club_id(), public.current_user_role()
    into v_actor_club_id, v_actor_role;

  if v_actor_role is distinct from 'admin' then
    raise exception 'insufficient_role';
  end if;

  if p_new_status not in ('active', 'inactive', 'suspended') then
    raise exception 'invalid_status';
  end if;

  -- Lock order: target's profiles row first (see set_member_role's header
  -- comment in 0083 for the full deadlock-avoidance rationale).
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

  -- Last-admin guard: only applies when the target is CURRENTLY an active
  -- admin and this change would take them out of that state. A target who
  -- is already inactive/suspended isn't counted as an active admin today,
  -- so changing them further (e.g. inactive -> suspended) cannot reduce the
  -- active-admin count and must not be blocked.
  if v_target.role = 'admin' and v_target.status = 'active' and p_new_status <> 'active' then
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

  -- Writes club_memberships directly. Migration 0081's Trigger B resolves
  -- or clears active_club_id safely for any status transition away from
  -- 'active' (reassigns to another active membership if exactly one
  -- remains, else clears it — never guesses), and restores it on
  -- transition back to 'active' under the same rule. No direct profiles
  -- write here.
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
-- 2. remove_club_member(uuid) — new
-- ═══════════════════════════════════════════════════════════════════════════
-- Explicit removal via removed_at/removed_by. Never touches role or status
-- — a removed membership retains whatever role/status it had, so a
-- subsequent restore (below) brings it back exactly as it was, not
-- silently reset to some default. Same actor/target/lock/last-admin
-- pattern as set_member_status; blanket self-restriction matches
-- set_member_role/set_member_status's existing convention (an admin cannot
-- self-service major membership changes through the tool used to manage
-- others), independent of whether they happen to be the last admin.
create or replace function public.remove_club_member(
  p_target_user_id uuid
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

  select public.current_user_club_id(), public.current_user_role()
    into v_actor_club_id, v_actor_role;

  if v_actor_role is distinct from 'admin' then
    raise exception 'insufficient_role';
  end if;

  perform 1 from public.profiles where id = p_target_user_id for update;

  select cm.* into v_target
    from public.club_memberships cm
   where cm.user_id = p_target_user_id
     and cm.club_id = v_actor_club_id
     and cm.removed_at is null;

  if not found then raise exception 'user_not_found'; end if;

  if auth.uid() = p_target_user_id then
    raise exception 'cannot_remove_self';
  end if;

  if v_target.role = 'admin' and v_target.status = 'active' then
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

  -- Writes club_memberships directly. Fires migration 0081's Trigger B
  -- (removed_at/removed_by are in its trigger column list already), which
  -- resolves or clears active_club_id exactly as it does for a status
  -- change away from 'active'. No direct profiles write here. Never
  -- touches any other club's membership row for this user.
  update public.club_memberships
     set removed_at = now(),
         removed_by = auth.uid()
   where user_id = p_target_user_id
     and club_id = v_actor_club_id;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_actor_club_id, auth.uid(), 'remove_club_member', 'profile', p_target_user_id,
    jsonb_build_object('old_role', v_target.role, 'old_status', v_target.status)
  );
end;
$$;

revoke execute on function public.remove_club_member(uuid) from public, anon;
grant  execute on function public.remove_club_member(uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. restore_club_member(uuid) — new
-- ═══════════════════════════════════════════════════════════════════════════
-- Clears removed_at/removed_by only — deliberately does not also force
-- status back to 'active'. A membership removed while suspended is
-- restored still suspended; the admin makes a separate, explicit
-- set_member_status call if they also want to reactivate it. No last-admin
-- guard: restoring only ever adds a membership back, never removes an
-- admin, so it cannot reduce the active-admin count. No self-restriction
-- needed either — a removed membership cannot belong to the authenticated
-- caller for this club, since current_user_role() (and therefore the
-- insufficient_role check above) only ever resolves through an active,
-- non-removed membership.
create or replace function public.restore_club_member(
  p_target_user_id uuid
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
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;

  select public.current_user_club_id(), public.current_user_role()
    into v_actor_club_id, v_actor_role;

  if v_actor_role is distinct from 'admin' then
    raise exception 'insufficient_role';
  end if;

  perform 1 from public.profiles where id = p_target_user_id for update;

  select cm.* into v_target
    from public.club_memberships cm
   where cm.user_id = p_target_user_id
     and cm.club_id = v_actor_club_id
     and cm.removed_at is not null;

  if not found then raise exception 'user_not_found'; end if;

  -- Fires migration 0081's Trigger B: if this restores the user's ONLY
  -- active, non-removed membership (i.e. status is 'active' after this
  -- clear), it becomes their active_club_id again — but only when exactly
  -- one valid alternative exists, never guessed. If the restored
  -- membership's status is inactive/suspended, active_club_id is
  -- correctly left untouched, exactly matching the same rule set_member_
  -- status already relies on.
  update public.club_memberships
     set removed_at = null,
         removed_by = null
   where user_id = p_target_user_id
     and club_id = v_actor_club_id;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_actor_club_id, auth.uid(), 'restore_club_member', 'profile', p_target_user_id,
    jsonb_build_object('role', v_target.role, 'status', v_target.status)
  );
end;
$$;

revoke execute on function public.restore_club_member(uuid) from public, anon;
grant  execute on function public.restore_club_member(uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. get_members() — extended
-- ═══════════════════════════════════════════════════════════════════════════
-- Adds removed_at to the return contract and removes the removed_at
-- exclusion — the directory now returns every membership in the active
-- club, removed or not, so the application can group them (a "Removed"
-- section becomes reachable) rather than removed members being permanently
-- undiscoverable. removed_at is null for every currently-non-removed row,
-- so a club with no removed members ever (every club prior to this
-- checkpoint) sees byte-identical output aside from the added column.
-- Sort order: non-removed first (existing name ordering preserved exactly
-- within that group), removed members after.
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
  is_lesson_provider boolean,
  removed_at         timestamptz
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
      cm.is_lesson_provider,
      cm.removed_at
    from public.club_memberships cm
    join public.profiles p on p.id = cm.user_id
    left join auth.users u on u.id = p.id
   where cm.club_id = v_actor_club_id
   order by (cm.removed_at is not null) asc,
            p.last_name asc nulls last, p.first_name asc nulls last;
end;
$$;

revoke execute on function public.get_members() from public, anon;
grant  execute on function public.get_members() to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 5. get_admin_member_detail(uuid) — extended
-- ═══════════════════════════════════════════════════════════════════════════
-- Adds removed_at to the return contract and removes the removed_at
-- exclusion from the target lookup, so a removed member's detail page
-- (reached from get_members()'s new "removed" rows) is reachable and can
-- show a Restore action. Still scoped exclusively to the caller's active
-- club (cm.club_id = v_actor_club_id) — this cannot surface any
-- information about a membership in a different club.
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
  removed_at                  timestamptz,
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

  select public.current_user_club_id(), public.current_user_role()
    into v_actor_club_id, v_actor_role;

  if v_actor_role is distinct from 'admin' then
    raise exception 'insufficient_role';
  end if;

  select cm.* into v_membership
    from public.club_memberships cm
   where cm.user_id = p_member_id
     and cm.club_id = v_actor_club_id;

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
      v_membership.removed_at,
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

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration is created
-- in this checkpoint)
-- ═══════════════════════════════════════════════════════════════════════════
-- Rolling back 0086 must NOT roll back 0081-0085. To revert in place:
--   1. CREATE OR REPLACE public.set_member_status back to its 0083 body
--      (active/inactive only, unguarded last-admin condition) — full text
--      in 0083_auth_context_and_membership_controls.sql.
--   2. DROP FUNCTION public.remove_club_member(uuid);
--   3. DROP FUNCTION public.restore_club_member(uuid);
--   4. DROP FUNCTION public.get_members(); then CREATE OR REPLACE it back to
--      its 0083 body (no removed_at column, removed_at is null filter) —
--      requires DROP first, exactly as 0083's own comment notes.
--   5. DROP FUNCTION public.get_admin_member_detail(uuid); then CREATE OR
--      REPLACE it back to its 0083 body (no removed_at column, removed_at
--      is null filter).
-- Only after the application changes in this same checkpoint (Remove/
-- Suspend/Restore UI in MembersClient.tsx) are also reverted or made
-- inert, since they call remove_club_member/restore_club_member directly
-- and read the new removed_at column. club_memberships, profiles.
-- active_club_id, all 0081 compatibility triggers, and all 0082/0085
-- switching objects remain untouched by this rollback.
