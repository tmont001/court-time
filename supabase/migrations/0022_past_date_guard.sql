-- 0022_past_date_guard.sql
-- Phase 10A: block creating events and maintenance blocks in the past.
-- create_reservation already guards this; create_event and
-- create_maintenance_block did not. Mirrors the same 'cannot_create_past'
-- exception so the frontend can show a consistent message.
-- Apply in Supabase SQL Editor (cloud only).

-- ---------------------------------------------------------------------------
-- create_event — add past-date guard
-- ---------------------------------------------------------------------------
create or replace function create_event(
  p_event_type_id uuid,
  p_title          text,
  p_starts_at      timestamptz,
  p_ends_at        timestamptz,
  p_court_ids      uuid[],
  p_description    text  default null,
  p_capacity       int   default null,
  p_notes          text  default null
)
returns events
language plpgsql security definer as $$
declare
  v_profile  profiles%rowtype;
  v_et       event_types%rowtype;
  v_event    events%rowtype;
  v_court_id uuid;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.role not in ('pro', 'admin') then
    raise exception 'insufficient_role';
  end if;

  if p_ends_at <= p_starts_at then raise exception 'invalid_duration'; end if;
  if p_starts_at < now() then raise exception 'cannot_create_past'; end if;

  select * into v_et
    from event_types
    where id = p_event_type_id and club_id = v_profile.club_id;
  if not found then raise exception 'event_type_not_found'; end if;

  insert into events (
    club_id, event_type_id, title, description,
    starts_at, ends_at, capacity, court_count, status, created_by
  ) values (
    v_profile.club_id, v_et.id, p_title, p_description,
    p_starts_at, p_ends_at,
    coalesce(p_capacity, v_et.default_capacity),
    array_length(p_court_ids, 1),
    'scheduled', auth.uid()
  )
  returning * into v_event;

  insert into event_participants (event_id, profile_id, role, status)
  values (v_event.id, auth.uid(), 'host', 'confirmed');

  foreach v_court_id in array p_court_ids loop
    insert into reservations (
      club_id, court_id, owner_user_id,
      starts_at, ends_at, status, reason, event_id, created_by, notes
    ) values (
      v_profile.club_id, v_court_id, auth.uid(),
      p_starts_at, p_ends_at, 'confirmed', 'event', v_event.id, auth.uid(), p_notes
    );
  end loop;

  return v_event;
end;
$$;

-- ---------------------------------------------------------------------------
-- create_maintenance_block — add past-date guard
-- ---------------------------------------------------------------------------
create or replace function create_maintenance_block(
  p_court_id  uuid,
  p_starts_at timestamptz,
  p_ends_at   timestamptz,
  p_notes     text default null
)
returns reservations
language plpgsql security definer as $$
declare
  v_profile profiles%rowtype;
  v_court   courts%rowtype;
  v_result  reservations%rowtype;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_profile.role <> 'admin' then
    raise exception 'insufficient_role';
  end if;

  if p_ends_at <= p_starts_at then
    raise exception 'invalid_duration';
  end if;

  if p_starts_at < now() then
    raise exception 'cannot_create_past';
  end if;

  select * into v_court
    from courts
    where id      = p_court_id
      and club_id = v_profile.club_id
      and is_active = true;
  if not found then raise exception 'court_not_found'; end if;

  insert into reservations (
    club_id, court_id, owner_user_id,
    starts_at, ends_at, status, reason,
    created_by, notes
  ) values (
    v_profile.club_id, p_court_id, auth.uid(),
    p_starts_at, p_ends_at, 'confirmed', 'maintenance',
    auth.uid(), p_notes
  )
  returning * into v_result;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'create_maintenance_block',
    'maintenance_block',
    v_result.id,
    jsonb_build_object(
      'court_id',   p_court_id,
      'starts_at',  p_starts_at,
      'ends_at',    p_ends_at
    )
  );

  return v_result;
end;
$$;
