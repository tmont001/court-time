-- 0073_fix_phase23_proposal_validation_and_role_sync.sql
--
-- Fix 1: propose_lesson_time — add preflight conflict validation so invalid
--   proposals are rejected before being stored. The existing acceptance-time
--   checks remain authoritative for final concurrency protection.
--
-- Fix 2: set_member_role — sync is_lesson_provider when a role changes:
--   role → pro   ⟹  is_lesson_provider = true
--   role → member ⟹  is_lesson_provider = false
--   role → admin  ⟹  is_lesson_provider unchanged
--   Also adds set search_path = public, pg_temp and REVOKE/GRANT that were
--   missing from 0036.
--
-- Fix 3: data repair — set is_lesson_provider = true for any existing active
--   pro profiles that were promoted before this migration was applied.


-- ── 1. propose_lesson_time with preflight validation ──────────────────────────

create or replace function public.propose_lesson_time(
  p_request_id   uuid,
  p_starts_at    timestamptz,
  p_ends_at      timestamptz,
  p_court_id     uuid default null
)
returns public.lesson_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile public.profiles%rowtype;
  v_request public.lesson_requests%rowtype;
  v_result  public.lesson_requests%rowtype;
  v_tz      text;
begin
  select * into v_profile from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.club_id is null then raise exception 'no_club'; end if;
  if v_profile.role not in ('pro', 'admin') then raise exception 'insufficient_role'; end if;

  select * into v_request
    from public.lesson_requests
   where id      = p_request_id
     and club_id = v_profile.club_id
   for update;
  if not found then raise exception 'request_not_found'; end if;

  if v_profile.role = 'pro' and v_request.pro_id <> auth.uid() then
    raise exception 'not_assigned_pro';
  end if;

  if v_request.status not in ('pending', 'proposed') then
    raise exception 'invalid_status_for_propose';
  end if;

  if p_starts_at <= now() then raise exception 'cannot_propose_past_time'; end if;
  if p_ends_at   <= p_starts_at then raise exception 'invalid_duration'; end if;

  if round(extract(epoch from (p_ends_at - p_starts_at)) / 60)::int <> v_request.duration_minutes then
    raise exception 'duration_mismatch';
  end if;

  -- ── Preflight conflict validation ─────────────────────────────────────────

  if p_court_id is not null then
    -- Court must be active and belong to this club
    if not exists (
      select 1 from public.courts
       where id        = p_court_id
         and club_id   = v_profile.club_id
         and is_active = true
    ) then
      raise exception 'court_not_found';
    end if;

    -- Court conflict: reject if any pending/confirmed reservation overlaps
    if exists (
      select 1 from public.reservations r
       where r.court_id = p_court_id
         and r.status   in ('pending', 'confirmed')
         and tstzrange(r.starts_at, r.ends_at, '[)') && tstzrange(p_starts_at, p_ends_at, '[)')
    ) then
      raise exception 'court_conflict';
    end if;
  end if;

  -- Operating hours
  select timezone into v_tz from public.clubs where id = v_profile.club_id;
  perform public._lesson_check_operating_hours(
    v_profile.club_id,
    p_starts_at,
    p_ends_at,
    v_tz
  );

  -- Pro conflicts (reservation owned by the pro is only created at acceptance,
  -- not at proposal time, so p_exclude_request_id is always null here)
  perform public._lesson_check_pro_availability(
    v_request.pro_id,
    p_starts_at,
    p_ends_at,
    null
  );

  -- Member conflicts
  perform public._lesson_check_member_availability(
    v_request.member_id,
    p_starts_at,
    p_ends_at
  );

  -- ── Commit ────────────────────────────────────────────────────────────────

  update public.lesson_requests
     set status             = 'proposed',
         proposed_starts_at = p_starts_at,
         proposed_ends_at   = p_ends_at,
         proposed_court_id  = p_court_id,
         last_actor_id      = auth.uid(),
         last_actor_role    = v_profile.role,
         updated_at         = now()
   where id = p_request_id
  returning * into v_result;

  insert into public.notifications (club_id, user_id, kind, body, metadata)
  values (
    v_profile.club_id,
    v_request.member_id,
    'lesson_request_proposed',
    trim(coalesce(v_profile.first_name, '') || ' ' || coalesce(v_profile.last_name, '')) ||
      ' proposed a time for your lesson. Please review and respond.',
    jsonb_build_object('request_id', p_request_id, 'target_path', '/lessons')
  );

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id, auth.uid(), 'propose_lesson_time', 'lesson_request', p_request_id,
    jsonb_build_object(
      'proposed_starts_at', p_starts_at,
      'proposed_ends_at',   p_ends_at,
      'court_id',           p_court_id
    )
  );

  return v_result;
end;
$$;

revoke execute on function public.propose_lesson_time(uuid, timestamptz, timestamptz, uuid) from public, anon;
grant  execute on function public.propose_lesson_time(uuid, timestamptz, timestamptz, uuid) to authenticated;


-- ── 2. set_member_role with is_lesson_provider synchronization ────────────────

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
  v_actor       public.profiles%rowtype;
  v_target      public.profiles%rowtype;
  v_admin_count int;
begin
  select * into v_actor from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_actor.role <> 'admin' then raise exception 'insufficient_role'; end if;

  if p_new_role not in ('member', 'pro', 'admin') then
    raise exception 'invalid_role';
  end if;

  select * into v_target
    from public.profiles
   where id      = p_target_user_id
     and club_id = v_actor.club_id;
  if not found then raise exception 'user_not_found'; end if;

  if v_actor.id = p_target_user_id then
    raise exception 'cannot_change_own_role';
  end if;

  if v_target.role = 'admin' and p_new_role <> 'admin' then
    perform p.id
      from  public.profiles p
     where  p.club_id = v_actor.club_id
       and  p.role    = 'admin'
       and  p.status  = 'active'
    for update;

    select count(*) into v_admin_count
      from public.profiles
     where club_id = v_actor.club_id
       and role    = 'admin'
       and status  = 'active'
       and id     <> p_target_user_id;

    if v_admin_count = 0 then
      raise exception 'last_admin';
    end if;
  end if;

  -- Sync is_lesson_provider with the new role:
  --   pro    → true   (immediately bookable as a lesson provider)
  --   member → false  (members are never lesson providers)
  --   admin  → unchanged (admin may or may not be a lesson provider)
  update public.profiles
     set role               = p_new_role,
         is_lesson_provider = case
           when p_new_role = 'pro'    then true
           when p_new_role = 'member' then false
           else is_lesson_provider
         end,
         updated_at         = now()
   where id = p_target_user_id;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_actor.club_id,
    auth.uid(),
    'set_member_role',
    'profile',
    p_target_user_id,
    jsonb_build_object('old_role', v_target.role, 'new_role', p_new_role)
  );
end;
$$;

revoke execute on function public.set_member_role(uuid, text) from public, anon;
grant  execute on function public.set_member_role(uuid, text) to authenticated;


-- ── 3. Data repair: backfill is_lesson_provider for existing active pros ──────
-- Corrects any active pro profiles promoted before this migration was applied.

update public.profiles
   set is_lesson_provider = true
 where role               = 'pro'
   and status             = 'active'
   and is_lesson_provider = false;
