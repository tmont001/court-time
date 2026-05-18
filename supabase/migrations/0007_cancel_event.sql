-- 0007_cancel_event.sql
-- Phase 4D: cancel_event RPC.
-- Admin (any event) or the event's confirmed host (own event only).
-- Cancels the event, all linked court reservations, and writes to audit_log.
-- Apply in Supabase SQL Editor (cloud only).

create or replace function cancel_event(p_event_id uuid)
returns events
language plpgsql security definer as $$
declare
  v_profile profiles%rowtype;
  v_event   events%rowtype;
  v_result  events%rowtype;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  select * into v_event
    from events
    where id      = p_event_id
      and club_id = v_profile.club_id
      and status  = 'scheduled';
  if not found then raise exception 'event_not_found'; end if;

  -- Admin can cancel any event.
  -- Otherwise the caller must be the event's confirmed host.
  if v_profile.role <> 'admin' then
    if not exists (
      select 1 from event_participants
      where event_id   = p_event_id
        and profile_id = auth.uid()
        and role       = 'host'
        and status     = 'confirmed'
    ) then
      raise exception 'insufficient_role';
    end if;
  end if;

  update events
    set status = 'cancelled', updated_at = now()
    where id = p_event_id
    returning * into v_result;

  update reservations set
    status            = 'cancelled',
    cancelled_at      = now(),
    cancelled_by      = auth.uid(),
    cancellation_kind = 'admin',
    updated_at        = now()
  where event_id = p_event_id
    and status in ('pending', 'confirmed');

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'cancel_event',
    'event',
    p_event_id,
    jsonb_build_object('title', v_event.title, 'starts_at', v_event.starts_at)
  );

  return v_result;
end;
$$;
