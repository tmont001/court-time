-- 0036_set_member_role.sql
-- Phase 14B: admin RPC to change a club member's role.
-- Guards: admin-only, own-club scoping, self-demotion blocked, last-admin protected.
-- Apply in Supabase SQL Editor (cloud only).

create or replace function set_member_role(
  p_target_user_id uuid,
  p_new_role       text
)
returns void
language plpgsql security definer as $$
declare
  v_actor       profiles%rowtype;
  v_target      profiles%rowtype;
  v_admin_count int;
begin
  -- 1. Load actor profile.
  select * into v_actor from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  -- 2. Actor must be admin.
  if v_actor.role <> 'admin' then raise exception 'insufficient_role'; end if;

  -- 3. Validate new role value.
  if p_new_role not in ('member', 'pro', 'admin') then
    raise exception 'invalid_role';
  end if;

  -- 4. Load target profile, scoped to actor's club (prevents cross-club changes).
  select * into v_target
  from profiles
  where id      = p_target_user_id
    and club_id = v_actor.club_id;
  if not found then raise exception 'user_not_found'; end if;

  -- 5. Admin cannot change their own role.
  if v_actor.id = p_target_user_id then
    raise exception 'cannot_change_own_role';
  end if;

  -- 6. Last-admin guard: only fires when demoting a current admin.
  if v_target.role = 'admin' and p_new_role <> 'admin' then

    -- Lock all active admin rows in the club to block concurrent racing demotions.
    -- A concurrent transaction that also tries to demote an admin will block here
    -- until this transaction commits, then re-check the count against updated state.
    perform p.id
    from    profiles p
    where   p.club_id = v_actor.club_id
      and   p.role    = 'admin'
      and   p.status  = 'active'
    for update;

    -- Count remaining active admins excluding the target being demoted.
    select count(*) into v_admin_count
    from   profiles
    where  club_id = v_actor.club_id
      and  role    = 'admin'
      and  status  = 'active'
      and  id     <> p_target_user_id;

    if v_admin_count = 0 then
      raise exception 'last_admin';
    end if;

  end if;

  -- 7. Update the target's role.
  update profiles
  set    role       = p_new_role,
         updated_at = now()
  where  id = p_target_user_id;

  -- 8. Write audit log.
  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
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
