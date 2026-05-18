-- 0010_notification_rpc_updates.sql
-- Phase 5B: add notification inserts to four existing RPCs.
-- Re-declares create_reservation, admin_cancel_reservation,
-- cancel_event, and join_event in full.
-- All existing guard logic, error raises, overlap checks, and
-- audit_log inserts are preserved unchanged.
-- Requires 0009_notifications.sql to be applied first.
-- Apply in Supabase SQL Editor (cloud only).

-- ---------------------------------------------------------------------------
-- create_reservation
-- Added: insert into notifications after successful reservation insert.
-- v_tz was already declared and fetched in the original function.
-- ---------------------------------------------------------------------------
create or replace function create_reservation(
  p_court_id     uuid,
  p_starts_at    timestamptz,
  p_ends_at      timestamptz,
  p_format       text    default null,
  p_player_count int     default null,
  p_guest_names  text[]  default null,
  p_notes        text    default null
)
returns reservations
language plpgsql security definer as $$
declare
  v_profile  profiles%rowtype;
  v_settings club_settings%rowtype;
  v_court    courts%rowtype;
  v_tz       text;
  v_dow      int;
  v_hours    operating_hours%rowtype;
  v_result   reservations%rowtype;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  select * into v_court
    from courts
    where id = p_court_id
      and club_id   = v_profile.club_id
      and is_active = true;
  if not found then raise exception 'court_not_found'; end if;

  select * into v_settings from club_settings where club_id = v_profile.club_id;

  select timezone into v_tz from clubs where id = v_profile.club_id;

  if p_starts_at < now() then
    raise exception 'cannot_book_past';
  end if;

  if p_starts_at > now() + (v_settings.booking_window_days || ' days')::interval then
    raise exception 'outside_booking_window';
  end if;

  if p_ends_at <= p_starts_at then
    raise exception 'invalid_duration';
  end if;

  v_dow := extract(dow from p_starts_at at time zone v_tz)::int;

  select * into v_hours
    from operating_hours
    where club_id    = v_profile.club_id
      and day_of_week = v_dow;

  if not found or v_hours.is_closed then
    raise exception 'club_closed_this_day';
  end if;

  if (p_starts_at at time zone v_tz)::time < v_hours.opens_at
     or (p_ends_at at time zone v_tz)::time > v_hours.closes_at then
    raise exception 'outside_operating_hours';
  end if;

  insert into reservations (
    club_id, court_id, owner_user_id,
    starts_at, ends_at, status, reason,
    format, player_count, guest_names, notes, created_by
  ) values (
    v_profile.club_id, p_court_id, auth.uid(),
    p_starts_at, p_ends_at, 'confirmed', 'member_booking',
    p_format, p_player_count, p_guest_names, p_notes, auth.uid()
  )
  returning * into v_result;

  insert into notifications (club_id, user_id, kind, body, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'reservation_confirmed',
    v_court.name || ' booked for '
      || to_char(p_starts_at at time zone v_tz, 'Mon DD "at" HH12:MI AM'),
    jsonb_build_object('reservation_id', v_result.id, 'court_id', p_court_id)
  );

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_cancel_reservation
-- Added: v_tz declare + fetch; insert into notifications for reservation owner.
-- Admin never receives a notification for their own cancellation action.
-- ---------------------------------------------------------------------------
create or replace function admin_cancel_reservation(p_reservation_id uuid)
returns reservations
language plpgsql security definer as $$
declare
  v_profile profiles%rowtype;
  v_res     reservations%rowtype;
  v_result  reservations%rowtype;
  v_tz      text;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_profile.role <> 'admin' then
    raise exception 'insufficient_role';
  end if;

  select * into v_res
    from reservations
    where id      = p_reservation_id
      and club_id = v_profile.club_id
      and status in ('pending', 'confirmed');
  if not found then raise exception 'reservation_not_found'; end if;

  update reservations set
    status            = 'cancelled',
    cancelled_at      = now(),
    cancelled_by      = auth.uid(),
    cancellation_kind = 'admin',
    updated_at        = now()
  where id = p_reservation_id
  returning * into v_result;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'admin_cancel_reservation',
    'reservation',
    p_reservation_id,
    jsonb_build_object(
      'court_id',      v_res.court_id,
      'owner_user_id', v_res.owner_user_id,
      'starts_at',     v_res.starts_at,
      'reason',        v_res.reason
    )
  );

  select timezone into v_tz from clubs where id = v_profile.club_id;

  insert into notifications (club_id, user_id, kind, body, metadata)
  values (
    v_profile.club_id,
    v_res.owner_user_id,
    'reservation_cancelled_by_admin',
    'Your reservation on '
      || to_char(v_res.starts_at at time zone v_tz, 'Mon DD "at" HH12:MI AM')
      || ' was cancelled by the club.',
    jsonb_build_object('reservation_id', p_reservation_id)
  );

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- cancel_event
-- Added: bulk insert into notifications for all confirmed participants.
-- No timezone needed — body uses only the event title.
-- ---------------------------------------------------------------------------
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

  insert into notifications (club_id, user_id, kind, body, metadata)
  select
    v_event.club_id,
    ep.profile_id,
    'event_cancelled',
    '"' || v_event.title || '" has been cancelled.',
    jsonb_build_object('event_id', p_event_id)
  from event_participants ep
  where ep.event_id = p_event_id
    and ep.status   = 'confirmed';

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- join_event
-- Added: insert into notifications for the joiner.
-- No timezone needed — body uses only the event title.
-- ---------------------------------------------------------------------------
create or replace function join_event(p_event_id uuid)
returns event_participants
language plpgsql security definer as $$
declare
  v_profile profiles%rowtype;
  v_event   events%rowtype;
  v_count   int;
  v_result  event_participants%rowtype;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  select * into v_event
    from events
    where id      = p_event_id
      and club_id = v_profile.club_id
      and status  = 'scheduled';
  if not found then raise exception 'event_not_found'; end if;

  select count(*) into v_count
    from event_participants
    where event_id = p_event_id and status = 'confirmed';
  if v_count >= v_event.capacity then raise exception 'event_full'; end if;

  if exists (
    select 1 from event_participants
    where event_id   = p_event_id
      and profile_id = auth.uid()
      and status     = 'confirmed'
  ) then raise exception 'already_joined'; end if;

  insert into event_participants (event_id, profile_id, role, status)
  values (p_event_id, auth.uid(), 'participant', 'confirmed')
  on conflict (event_id, profile_id)
    do update set status = 'confirmed', updated_at = now()
  returning * into v_result;

  insert into notifications (club_id, user_id, kind, body, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'event_joined',
    'You''ve joined "' || v_event.title || '".',
    jsonb_build_object('event_id', p_event_id)
  );

  return v_result;
end;
$$;
