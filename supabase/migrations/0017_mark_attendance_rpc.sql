-- 0017_mark_attendance_rpc.sql
-- Phase 7G: mark_attendance RPC for admin/pro to record event attendance.
-- Requires 0016_get_event_roster_rpc.sql first (attendance_status column).
-- Apply in Supabase SQL Editor (cloud only).

-- ---------------------------------------------------------------------------
-- mark_attendance
-- Admin or pro only. Sets attendance_status on a confirmed participant row.
-- Pass p_attendance_status = null to clear a previously recorded mark.
-- Raises participant_not_found if no confirmed row exists for the given
-- event + profile combination within the caller's club.
-- Writes an audit_log entry for every change (including clears).
-- ---------------------------------------------------------------------------
create or replace function mark_attendance(
  p_event_id          uuid,
  p_profile_id        uuid,
  p_attendance_status text   -- 'attended' | 'no_show' | null (clears the mark)
)
returns void
language plpgsql security definer as $$
declare
  v_profile      profiles%rowtype;
  v_rows_updated int;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_profile.role not in ('admin', 'pro') then
    raise exception 'insufficient_role';
  end if;

  if p_attendance_status is not null
     and p_attendance_status not in ('attended', 'no_show') then
    raise exception 'invalid_attendance_status';
  end if;

  -- Verify the event belongs to the caller's club
  if not exists (
    select 1 from events
    where id      = p_event_id
      and club_id = v_profile.club_id
  ) then raise exception 'event_not_found'; end if;

  -- Only confirmed participants are markable; waitlisted/cancelled are not
  update event_participants
    set attendance_status = p_attendance_status,
        updated_at        = now()
    where event_id   = p_event_id
      and profile_id = p_profile_id
      and status     = 'confirmed';

  get diagnostics v_rows_updated = row_count;
  if v_rows_updated = 0 then raise exception 'participant_not_found'; end if;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'mark_attendance',
    'event_participant',
    p_profile_id,
    jsonb_build_object(
      'event_id',          p_event_id,
      'attendance_status', p_attendance_status
    )
  );
end;
$$;
