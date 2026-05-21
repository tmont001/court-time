-- 0027_court_management_rpcs.sql
-- Phase 11B: court management RPCs (add, rename, reorder, activate/deactivate).
-- No hard-delete. Deactivation is blocked when future reservations exist.
-- Apply in Supabase SQL Editor (cloud only).

-- ---------------------------------------------------------------------------
-- add_court
-- ---------------------------------------------------------------------------
create or replace function add_court(p_name text)
returns void
language plpgsql security definer as $$
declare
  v_profile    profiles%rowtype;
  v_trimmed    text;
  v_next_order int;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.role <> 'admin' then raise exception 'insufficient_role'; end if;

  v_trimmed := trim(p_name);
  if v_trimmed = '' or v_trimmed is null then raise exception 'name_required'; end if;
  if char_length(v_trimmed) > 60 then raise exception 'name_too_long'; end if;

  if exists (
    select 1 from courts
    where club_id = v_profile.club_id
      and lower(name) = lower(v_trimmed)
  ) then
    raise exception 'name_already_exists';
  end if;

  select coalesce(max(display_order), -1) + 1
    into v_next_order
    from courts
    where club_id = v_profile.club_id;

  insert into courts (club_id, name, display_order, is_active)
  values (v_profile.club_id, v_trimmed, v_next_order, true);

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id, auth.uid(), 'add_court', 'court', v_profile.club_id,
    jsonb_build_object('name', v_trimmed)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- rename_court
-- ---------------------------------------------------------------------------
create or replace function rename_court(p_court_id uuid, p_name text)
returns void
language plpgsql security definer as $$
declare
  v_profile profiles%rowtype;
  v_trimmed text;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.role <> 'admin' then raise exception 'insufficient_role'; end if;

  if not exists (
    select 1 from courts
    where id = p_court_id and club_id = v_profile.club_id
  ) then
    raise exception 'invalid_court';
  end if;

  v_trimmed := trim(p_name);
  if v_trimmed = '' or v_trimmed is null then raise exception 'name_required'; end if;
  if char_length(v_trimmed) > 60 then raise exception 'name_too_long'; end if;

  if exists (
    select 1 from courts
    where club_id = v_profile.club_id
      and lower(name) = lower(v_trimmed)
      and id <> p_court_id
  ) then
    raise exception 'name_already_exists';
  end if;

  update courts set name = v_trimmed where id = p_court_id;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id, auth.uid(), 'rename_court', 'court', p_court_id,
    jsonb_build_object('new_name', v_trimmed)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- reorder_courts
-- ---------------------------------------------------------------------------
create or replace function reorder_courts(p_court_order uuid[])
returns void
language plpgsql security definer as $$
declare
  v_profile  profiles%rowtype;
  v_count    int;
  v_idx      int := 0;
  v_court_id uuid;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.role <> 'admin' then raise exception 'insufficient_role'; end if;

  -- Array must contain exactly all courts for this club (active + inactive).
  select count(*) into v_count from courts where club_id = v_profile.club_id;
  if array_length(p_court_order, 1) is null or array_length(p_court_order, 1) <> v_count then
    raise exception 'invalid_court_order';
  end if;

  if exists (
    select 1 from unnest(p_court_order) as t(id)
    where not exists (
      select 1 from courts
      where courts.id = t.id and courts.club_id = v_profile.club_id
    )
  ) then
    raise exception 'invalid_court_order';
  end if;

  foreach v_court_id in array p_court_order loop
    update courts set display_order = v_idx where id = v_court_id;
    v_idx := v_idx + 1;
  end loop;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id, auth.uid(), 'reorder_courts', 'court', v_profile.club_id,
    jsonb_build_object('order', p_court_order)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- set_court_active
-- ---------------------------------------------------------------------------
create or replace function set_court_active(p_court_id uuid, p_is_active boolean)
returns void
language plpgsql security definer as $$
declare
  v_profile      profiles%rowtype;
  v_future_count int;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.role <> 'admin' then raise exception 'insufficient_role'; end if;

  if not exists (
    select 1 from courts
    where id = p_court_id and club_id = v_profile.club_id
  ) then
    raise exception 'invalid_court';
  end if;

  -- Block deactivation if future non-cancelled reservations exist.
  if not p_is_active then
    select count(*) into v_future_count
    from reservations
    where court_id  = p_court_id
      and starts_at > now()
      and status   <> 'cancelled';

    if v_future_count > 0 then
      raise exception 'court_has_future_reservations: %', v_future_count;
    end if;
  end if;

  update courts set is_active = p_is_active where id = p_court_id;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id, auth.uid(), 'set_court_active', 'court', p_court_id,
    jsonb_build_object('is_active', p_is_active)
  );
end;
$$;
