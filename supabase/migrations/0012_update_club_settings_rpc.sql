-- 0012_update_club_settings_rpc.sql
-- Phase 6C: admin RPC to update club booking and cancellation windows.
-- Validates inputs, updates club_settings, and writes to audit_log.
-- Apply in Supabase SQL Editor (cloud only).

-- ---------------------------------------------------------------------------
-- club_settings UPDATE policy for admins (defense-in-depth; writes go via RPC)
-- ---------------------------------------------------------------------------
create policy "club_settings_update_admin"
  on club_settings for update
  using (
    club_id = current_user_club_id()
    and current_user_role() = 'admin'
  )
  with check (
    club_id = current_user_club_id()
    and current_user_role() = 'admin'
  );

-- ---------------------------------------------------------------------------
-- update_club_settings
-- ---------------------------------------------------------------------------
create or replace function update_club_settings(
  p_booking_window_days       int,
  p_cancellation_window_hours int
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

  update club_settings set
    booking_window_days       = p_booking_window_days,
    cancellation_window_hours = p_cancellation_window_hours,
    updated_at                = now()
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
      'booking_window_days',       p_booking_window_days,
      'cancellation_window_hours', p_cancellation_window_hours
    )
  );

  return v_result;
end;
$$;
