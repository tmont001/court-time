-- 0025_cancellation_grace.sql
-- Phase 10F: add cancellation_grace_minutes to club_settings.
-- A member can cancel a reservation created within this many minutes, even if
-- the reservation starts inside the normal cancellation_window_hours window.
-- Effective policy: cancel is allowed when EITHER
--   starts_at - now() >= cancellation_window_hours  (outside window)
--   OR now() - created_at <= cancellation_grace_minutes  (inside grace period)
-- Admin cancellation is unaffected (exempt from both checks).
-- Minimum 0 (disables grace entirely). Maximum 60.
-- Apply in Supabase SQL Editor (cloud only).

alter table club_settings
  add column cancellation_grace_minutes int not null default 5;

-- ---------------------------------------------------------------------------
-- update_club_settings — extended with p_cancellation_grace_minutes
-- ---------------------------------------------------------------------------
create or replace function update_club_settings(
  p_booking_window_days        int,
  p_cancellation_window_hours  int,
  p_cancellation_grace_minutes int default 5
)
returns club_settings
language plpgsql security definer as $$
declare
  v_profile profiles%rowtype;
  v_result  club_settings%rowtype;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.role <> 'admin' then raise exception 'insufficient_role'; end if;

  if p_booking_window_days < 1 or p_booking_window_days > 365 then
    raise exception 'invalid_booking_window';
  end if;
  if p_cancellation_window_hours < 0 or p_cancellation_window_hours > 168 then
    raise exception 'invalid_cancellation_window';
  end if;
  if p_cancellation_grace_minutes < 0 or p_cancellation_grace_minutes > 60 then
    raise exception 'invalid_grace_period';
  end if;

  update club_settings set
    booking_window_days        = p_booking_window_days,
    cancellation_window_hours  = p_cancellation_window_hours,
    cancellation_grace_minutes = p_cancellation_grace_minutes,
    updated_at                 = now()
  where club_id = v_profile.club_id
  returning * into v_result;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'update_club_settings',
    'club_settings',
    v_result.club_id,
    jsonb_build_object(
      'booking_window_days',        p_booking_window_days,
      'cancellation_window_hours',  p_cancellation_window_hours,
      'cancellation_grace_minutes', p_cancellation_grace_minutes
    )
  );

  return v_result;
end;
$$;
