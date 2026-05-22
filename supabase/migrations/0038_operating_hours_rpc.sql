-- 0038_operating_hours_rpc.sql
-- Phase 14E: admin RPC to update club operating hours with dry-run conflict check.
-- Never cancels or modifies existing reservations; conflict count is informational only.
-- Apply in Supabase SQL Editor (cloud only).

create or replace function update_operating_hours(
  p_hours   jsonb,
  p_dry_run boolean default true
)
returns jsonb
language plpgsql security definer as $$
declare
  v_actor     profiles%rowtype;
  v_tz        text;
  v_element   jsonb;
  v_dow       int;
  v_opens_at  time;
  v_closes_at time;
  v_is_closed boolean;
  v_count     int;
  v_affected  jsonb := '[]'::jsonb;
begin
  -- 1. Load actor profile.
  select * into v_actor from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  -- 2. Actor must be admin.
  if v_actor.role <> 'admin' then raise exception 'insufficient_role'; end if;

  -- 3. Load club timezone.
  select timezone into v_tz from clubs where id = v_actor.club_id;

  -- 4a. Validate: must be a JSON array with exactly 7 elements.
  if jsonb_typeof(p_hours) <> 'array' or jsonb_array_length(p_hours) <> 7 then
    raise exception 'invalid_hours_payload';
  end if;

  -- 4b. Validate: all 7 day_of_week values must be in range 0–6 and distinct.
  select count(*) into v_count
  from   jsonb_array_elements(p_hours) as elem
  where  (elem->>'day_of_week')::int between 0 and 6;
  if v_count <> 7 then raise exception 'invalid_hours_payload'; end if;

  select count(distinct (elem->>'day_of_week')::int) into v_count
  from   jsonb_array_elements(p_hours) as elem;
  if v_count <> 7 then raise exception 'invalid_hours_payload'; end if;

  -- 4c. Validate: for non-closed days, opens_at must be before closes_at.
  if exists (
    select 1
    from   jsonb_array_elements(p_hours) as elem
    where  (elem->>'is_closed')::boolean = false
      and  (elem->>'opens_at')::time >= (elem->>'closes_at')::time
  ) then
    raise exception 'invalid_time_range';
  end if;

  -- 5–6. Count future reservation conflicts per day; accumulate affected list.
  for v_element in select * from jsonb_array_elements(p_hours) loop
    v_dow       := (v_element->>'day_of_week')::int;
    v_is_closed := (v_element->>'is_closed')::boolean;
    v_opens_at  := (v_element->>'opens_at')::time;
    v_closes_at := (v_element->>'closes_at')::time;

    -- Reservation conflicts when the day is closed, or when the reservation
    -- starts before the new opens_at, or ends after the new closes_at.
    -- Both starts_at and ends_at are converted to club local time before comparison,
    -- matching the same pattern used in create_reservation.
    select count(*) into v_count
    from   reservations r
    where  r.club_id   = v_actor.club_id
      and  r.status    in ('pending', 'confirmed')
      and  r.starts_at > now()
      and  extract(dow from r.starts_at at time zone v_tz)::int = v_dow
      and  (
        v_is_closed
        or (r.starts_at at time zone v_tz)::time < v_opens_at
        or (r.ends_at   at time zone v_tz)::time > v_closes_at
      );

    if v_count > 0 then
      v_affected := v_affected
        || jsonb_build_array(
             jsonb_build_object('day_of_week', v_dow, 'reservation_count', v_count)
           );
    end if;
  end loop;

  -- 7. Dry run: return conflict data without writing anything.
  if p_dry_run then
    return jsonb_build_object('dry_run', true, 'affected', v_affected);
  end if;

  -- 8a. Upsert all 7 operating_hours rows for this club.
  insert into operating_hours (club_id, day_of_week, opens_at, closes_at, is_closed, updated_at)
  select
    v_actor.club_id,
    (elem->>'day_of_week')::int,
    (elem->>'opens_at')::time,
    (elem->>'closes_at')::time,
    (elem->>'is_closed')::boolean,
    now()
  from jsonb_array_elements(p_hours) as elem
  on conflict (club_id, day_of_week) do update set
    opens_at   = excluded.opens_at,
    closes_at  = excluded.closes_at,
    is_closed  = excluded.is_closed,
    updated_at = excluded.updated_at;

  -- 8b. Write audit log.
  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_actor.club_id,
    auth.uid(),
    'update_operating_hours',
    'club_settings',
    v_actor.club_id,
    jsonb_build_object('affected', v_affected, 'hours', p_hours)
  );

  return jsonb_build_object('dry_run', false, 'affected', v_affected);
end;
$$;
