-- 0023_update_club_name_rpc.sql
-- Phase 10B: allow admins to update the club display name from Admin Settings.
-- Adds a clubs UPDATE policy (defense-in-depth) and an update_club_name RPC.
-- Apply in Supabase SQL Editor (cloud only).

-- ---------------------------------------------------------------------------
-- clubs — UPDATE policy for admins (defense-in-depth; writes go via RPC)
-- ---------------------------------------------------------------------------
create policy "clubs_update_admin"
  on clubs for update
  using (
    id = current_user_club_id()
    and current_user_role() = 'admin'
  )
  with check (
    id = current_user_club_id()
    and current_user_role() = 'admin'
  );

-- ---------------------------------------------------------------------------
-- update_club_name
-- ---------------------------------------------------------------------------
create or replace function update_club_name(p_name text)
returns void
language plpgsql security definer as $$
declare
  v_profile profiles%rowtype;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.role <> 'admin' then raise exception 'insufficient_role'; end if;

  if trim(p_name) = '' then raise exception 'invalid_club_name'; end if;

  update clubs
  set name = trim(p_name), updated_at = now()
  where id = v_profile.club_id;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'update_club_name',
    'club',
    v_profile.club_id,
    jsonb_build_object('name', trim(p_name))
  );
end;
$$;
