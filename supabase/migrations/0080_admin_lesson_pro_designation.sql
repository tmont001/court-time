-- 0080_admin_lesson_pro_designation.sql
-- Phase 25C: Admin Membership Controls and Lesson Pro Designation
--
-- Changes in this migration:
--
--   1. get_members — add is_lesson_provider to the return contract.
--      Drops the 0075 definition then recreates with the new column.
--
--   2. get_admin_member_detail — add is_lesson_provider to the return contract.
--      Drops the 0077 definition then recreates with the new column.
--
--   3. set_lesson_provider_status(p_target_user_id uuid, p_enabled boolean)
--      New SECURITY DEFINER RPC. Allows an active same-club admin to set
--      is_lesson_provider on another admin (or themselves). Rejects Member and
--      Pro targets. Caller must have status = 'active'. Skips mutation and
--      audit when the value would not change (idempotent no-op path).
--
--   4. get_admin_club_pros()
--      Admin-only variant of get_club_pros(). Same contract, but includes the
--      calling admin when they are an eligible provider. Used by admin lesson
--      management pages so an admin with is_lesson_provider = true can select
--      themselves as a provider. Member-facing pages continue to use
--      get_club_pros(), which preserves the existing self-exclusion.
--
-- NOT changed:
--   • set_member_role synchronization (pro→true, member→false, admin→unchanged)
--     remains in force from migration 0073.
--   • get_club_pros() is unchanged — member-facing self-exclusion preserved.
--
-- Apply in Supabase SQL Editor (cloud only).

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. get_members — add is_lesson_provider
-- ═══════════════════════════════════════════════════════════════════════════
-- DROP is required: PostgreSQL cannot change RETURNS TABLE via CREATE OR REPLACE.

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
  v_profile public.profiles%rowtype;
begin
  select pr.* into v_profile from public.profiles pr where pr.id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.role <> 'admin' then raise exception 'insufficient_role'; end if;

  return query
    select
      p.id                 as id,
      p.first_name         as first_name,
      p.last_name          as last_name,
      p.phone              as phone,
      p.role               as role,
      p.status             as status,
      p.created_at         as created_at,
      u.email::text        as email,
      p.is_lesson_provider as is_lesson_provider
    from public.profiles p
    left join auth.users u on u.id = p.id
   where p.club_id = v_profile.club_id
   order by p.last_name asc nulls last, p.first_name asc nulls last;
end;
$$;

revoke execute on function public.get_members() from public, anon;
grant  execute on function public.get_members() to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. get_admin_member_detail — add is_lesson_provider
-- ═══════════════════════════════════════════════════════════════════════════
-- DROP is required: PostgreSQL cannot change RETURNS TABLE via CREATE OR REPLACE.

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
  v_actor public.profiles%rowtype;
begin
  select pr.* into v_actor from public.profiles pr where pr.id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_actor.club_id is null then raise exception 'no_club'; end if;
  if v_actor.role <> 'admin' then raise exception 'insufficient_role'; end if;

  if not exists (
    select 1 from public.profiles tgt
     where tgt.id      = p_member_id
       and tgt.club_id = v_actor.club_id
  ) then
    raise exception 'member_not_found';
  end if;

  return query
    select
      p.id                                                  as id,
      p.first_name                                          as first_name,
      p.last_name                                           as last_name,
      p.phone                                               as phone,
      p.role                                                as role,
      p.status                                              as status,
      p.created_at                                          as created_at,
      u.email::text                                         as email,
      p.is_lesson_provider                                  as is_lesson_provider,
      (
        select count(*) from public.event_participants ep
          join public.events ev on ev.id = ep.event_id
         where ep.profile_id        = p_member_id
           and ep.attendance_status = 'attended'
           and ev.club_id           = v_actor.club_id
      )                                                     as attended_event_count,
      (
        select count(*) from public.event_participants ep
          join public.events ev on ev.id = ep.event_id
         where ep.profile_id        = p_member_id
           and ep.attendance_status = 'no_show'
           and ev.club_id           = v_actor.club_id
      )                                                     as event_no_show_count,
      (
        select count(*) from public.lesson_requests lr
         where lr.member_id      = p_member_id
           and lr.club_id        = v_actor.club_id
           and lr.lesson_outcome = 'completed'
      )                                                     as completed_lesson_count,
      (
        select count(*) from public.lesson_requests lr
         where lr.member_id      = p_member_id
           and lr.club_id        = v_actor.club_id
           and lr.lesson_outcome = 'member_no_show'
      )                                                     as member_lesson_no_show_count
    from public.profiles p
    left join auth.users u on u.id = p.id
   where p.id = p_member_id;
end;
$$;

revoke execute on function public.get_admin_member_detail(uuid) from public, anon;
grant  execute on function public.get_admin_member_detail(uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. set_lesson_provider_status
-- ═══════════════════════════════════════════════════════════════════════════
-- Allows an active same-club admin to set is_lesson_provider on an admin
-- profile (including their own). Member and Pro targets are rejected with a
-- stable 'target_not_admin_role' error. Inactive callers are rejected with
-- 'inactive_actor'. Idempotent: when p_enabled equals the stored value no
-- mutation or audit entry is written.

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
  v_actor   public.profiles%rowtype;
  v_target  public.profiles%rowtype;
  v_old_val boolean;
begin
  -- Require authenticated, active admin.
  select * into v_actor from public.profiles where id = auth.uid();
  if not found            then raise exception 'not_authenticated'; end if;
  if v_actor.role <> 'admin' then raise exception 'insufficient_role'; end if;
  if v_actor.status <> 'active' then raise exception 'inactive_actor'; end if;
  if v_actor.club_id is null  then raise exception 'no_club'; end if;

  -- Target must exist in the caller's club.
  select * into v_target
    from public.profiles
   where id      = p_target_user_id
     and club_id = v_actor.club_id;
  if not found then raise exception 'user_not_found'; end if;

  -- Only admin-role profiles may have their designation changed.
  -- set_member_role already syncs Pro→true and Member→false.
  if v_target.role <> 'admin' then
    raise exception 'target_not_admin_role';
  end if;

  v_old_val := v_target.is_lesson_provider;

  -- No-op: value already matches; skip mutation and audit.
  if v_old_val = p_enabled then
    return;
  end if;

  -- Update only is_lesson_provider; never touch role, status, club_id, or PII.
  update public.profiles
     set is_lesson_provider = p_enabled,
         updated_at         = now()
   where id = p_target_user_id;

  -- Audit the change so admin provider-status transitions are traceable.
  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_actor.club_id,
    auth.uid(),
    'set_lesson_provider_status',
    'profile',
    p_target_user_id,
    jsonb_build_object('old_value', v_old_val, 'new_value', p_enabled)
  );
end;
$$;

revoke execute on function public.set_lesson_provider_status(uuid, boolean) from public, anon;
grant  execute on function public.set_lesson_provider_status(uuid, boolean) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. get_admin_club_pros
-- ═══════════════════════════════════════════════════════════════════════════
-- Admin-only variant of get_club_pros(). Identical eligibility rules
-- (active + is_lesson_provider = true + role in pro/admin) but does NOT
-- exclude the calling admin. Used by admin lesson management pages so that
-- an admin with is_lesson_provider = true can select themselves as a provider.
--
-- Member-facing pages must continue using get_club_pros() so the existing
-- self-exclusion is preserved for member-initiated requests.

create or replace function public.get_admin_club_pros()
returns table (
  id                 uuid,
  first_name         text,
  last_name          text,
  role               text,
  is_lesson_provider boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile public.profiles%rowtype;
begin
  select * into v_profile from public.profiles p where p.id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.club_id is null then raise exception 'no_club'; end if;
  if v_profile.role <> 'admin' then raise exception 'insufficient_role'; end if;

  return query
    select p.id, p.first_name, p.last_name, p.role, p.is_lesson_provider
      from public.profiles p
     where p.club_id            = v_profile.club_id
       and p.status             = 'active'
       and p.role               in ('pro', 'admin')
       and p.is_lesson_provider = true
     order by p.last_name nulls last, p.first_name nulls last;
end;
$$;

revoke execute on function public.get_admin_club_pros() from public, anon;
grant  execute on function public.get_admin_club_pros() to authenticated;
