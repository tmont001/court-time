-- 0008_maintenance_blocks.sql
-- Phase 4E: create_maintenance_block RPC.
-- Admin only. Inserts a reservation with reason='maintenance'.
-- Relies on the existing EXCLUDE constraint for overlap prevention.
-- Writes to audit_log (created in 0005_audit_log.sql).
-- Apply in Supabase SQL Editor (cloud only).

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

  -- Admin only — pro is excluded.
  if v_profile.role <> 'admin' then
    raise exception 'insufficient_role';
  end if;

  if p_ends_at <= p_starts_at then
    raise exception 'invalid_duration';
  end if;

  select * into v_court
    from courts
    where id      = p_court_id
      and club_id = v_profile.club_id
      and is_active = true;
  if not found then raise exception 'court_not_found'; end if;

  -- The EXCLUDE constraint on reservations rejects overlapping
  -- pending/confirmed rows automatically (raises 23P01).
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
