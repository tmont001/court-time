-- 0026_show_notes_to_members.sql
-- Phase 10F (polish): let admins control whether a maintenance block's reason
-- is visible to members on the calendar.
-- Default false → existing and new blocks are hidden from members unless
-- the admin explicitly enables visibility.
-- Apply in Supabase SQL Editor (cloud only).

alter table reservations
  add column show_notes_to_members boolean not null default false;

-- ---------------------------------------------------------------------------
-- create_maintenance_blocks (plural) — add p_show_notes_to_members
-- ---------------------------------------------------------------------------
create or replace function create_maintenance_blocks(
  p_court_ids              uuid[],
  p_starts_at              timestamptz,
  p_ends_at                timestamptz,
  p_notes                  text    default null,
  p_show_notes_to_members  boolean default false
)
returns void
language plpgsql security definer as $$
declare
  v_profile  profiles%rowtype;
  v_court_id uuid;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_profile.role <> 'admin' then
    raise exception 'insufficient_role';
  end if;

  if p_court_ids is null or array_length(p_court_ids, 1) is null then
    raise exception 'select_at_least_one_court';
  end if;

  if p_ends_at <= p_starts_at then
    raise exception 'invalid_duration';
  end if;

  if p_starts_at < now() then
    raise exception 'cannot_create_past';
  end if;

  if exists (
    select 1 from unnest(p_court_ids) as t(id)
    where not exists (
      select 1 from courts
      where courts.id      = t.id
        and courts.club_id = v_profile.club_id
        and courts.is_active = true
    )
  ) then
    raise exception 'invalid_court';
  end if;

  foreach v_court_id in array p_court_ids loop
    insert into reservations (
      club_id, court_id, owner_user_id,
      starts_at, ends_at, status, reason,
      created_by, notes, show_notes_to_members
    ) values (
      v_profile.club_id, v_court_id, auth.uid(),
      p_starts_at, p_ends_at, 'confirmed', 'maintenance',
      auth.uid(), p_notes, p_show_notes_to_members
    );
  end loop;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'create_maintenance_blocks',
    'maintenance_block',
    v_profile.club_id,
    jsonb_build_object(
      'court_ids',              p_court_ids,
      'starts_at',              p_starts_at,
      'ends_at',                p_ends_at,
      'show_notes_to_members',  p_show_notes_to_members
    )
  );
end;
$$;
