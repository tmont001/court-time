-- 0037_set_member_status.sql
-- Phase 14C: admin RPC to deactivate/reactivate members, plus account_inactive
-- enforcement in create_reservation, join_event, and create_event.
-- leave_event is intentionally unchanged — cancelling participation is safe for inactive users.
-- Apply in Supabase SQL Editor (cloud only).

-- ---------------------------------------------------------------------------
-- set_member_status
-- ---------------------------------------------------------------------------
create or replace function set_member_status(
  p_target_user_id uuid,
  p_new_status     text
)
returns void
language plpgsql security definer as $$
declare
  v_actor       profiles%rowtype;
  v_target      profiles%rowtype;
  v_admin_count int;
begin
  -- 1. Load actor profile.
  select * into v_actor from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  -- 2. Actor must be admin.
  if v_actor.role <> 'admin' then raise exception 'insufficient_role'; end if;

  -- 3. Validate status value. 'suspended' is a valid schema value but not accepted here.
  if p_new_status not in ('active', 'inactive') then
    raise exception 'invalid_status';
  end if;

  -- 4. Load target profile, scoped to actor's club (prevents cross-club changes).
  select * into v_target
  from profiles
  where id      = p_target_user_id
    and club_id = v_actor.club_id;
  if not found then raise exception 'user_not_found'; end if;

  -- 5. Admin cannot change their own status.
  if v_actor.id = p_target_user_id then
    raise exception 'cannot_change_own_status';
  end if;

  -- 6. Last-admin guard: only fires when deactivating an active admin.
  if v_target.role = 'admin' and p_new_status = 'inactive' then

    -- Lock all active admin rows in the club to block concurrent racing deactivations.
    -- A concurrent transaction that also tries to deactivate an admin will block here
    -- until this transaction commits, then re-check the count against updated state.
    perform p.id
    from    profiles p
    where   p.club_id = v_actor.club_id
      and   p.role    = 'admin'
      and   p.status  = 'active'
    for update;

    -- Count remaining active admins excluding the target being deactivated.
    select count(*) into v_admin_count
    from   profiles
    where  club_id = v_actor.club_id
      and  role    = 'admin'
      and  status  = 'active'
      and  id     <> p_target_user_id;

    if v_admin_count = 0 then
      raise exception 'last_admin';
    end if;

  end if;

  -- 7. Update the target's status.
  update profiles
  set    status     = p_new_status,
         updated_at = now()
  where  id = p_target_user_id;

  -- 8. Write audit log.
  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_actor.club_id,
    auth.uid(),
    'set_member_status',
    'profile',
    p_target_user_id,
    jsonb_build_object('old_status', v_target.status, 'new_status', p_new_status)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- create_reservation — add account_inactive guard
-- Latest prior version: 0010_notification_rpc_updates.sql
-- One change only: account_inactive guard inserted after not_authenticated check.
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

  if v_profile.status <> 'active' then raise exception 'account_inactive'; end if;

  select * into v_court
    from courts
    where id        = p_court_id
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
    where club_id     = v_profile.club_id
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
-- join_event — add account_inactive guard
-- Latest prior version: 0015_waitlist_rpcs.sql (waitlist-aware)
-- One change only: account_inactive guard inserted after not_authenticated check.
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

  if v_profile.status <> 'active' then raise exception 'account_inactive'; end if;

  select * into v_event
    from events
    where id      = p_event_id
      and club_id = v_profile.club_id
      and status  = 'scheduled';
  if not found then raise exception 'event_not_found'; end if;

  -- Guard: already an active participant (confirmed or waitlisted)
  if exists (
    select 1 from event_participants
    where event_id   = p_event_id
      and profile_id = auth.uid()
      and status     in ('confirmed', 'waitlisted')
  ) then raise exception 'already_joined'; end if;

  -- Only confirmed participants (role = 'participant') consume capacity;
  -- hosts and waitlisted rows do not count against the event's capacity.
  select count(*) into v_count
    from event_participants
    where event_id = p_event_id
      and status   = 'confirmed'
      and role     = 'participant';

  if v_count >= v_event.capacity then
    -- Event is full → place caller on waitlist
    insert into event_participants (event_id, profile_id, role, status)
    values (p_event_id, auth.uid(), 'participant', 'waitlisted')
    on conflict (event_id, profile_id)
      do update set status = 'waitlisted', updated_at = now()
    returning * into v_result;
    -- No notification for waitlist joins; UI reflects status immediately.
  else
    -- Event has capacity → confirmed signup
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
  end if;

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- create_event — add account_inactive guard
-- Latest prior version: 0022_past_date_guard.sql
-- One change only: account_inactive guard inserted after not_authenticated check.
-- ---------------------------------------------------------------------------
create or replace function create_event(
  p_event_type_id uuid,
  p_title         text,
  p_starts_at     timestamptz,
  p_ends_at       timestamptz,
  p_court_ids     uuid[],
  p_description   text  default null,
  p_capacity      int   default null,
  p_notes         text  default null
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

  if v_profile.status <> 'active' then raise exception 'account_inactive'; end if;

  if v_profile.role not in ('pro', 'admin') then
    raise exception 'insufficient_role';
  end if;

  if p_ends_at <= p_starts_at then raise exception 'invalid_duration'; end if;
  if p_starts_at < now() then raise exception 'cannot_create_past'; end if;

  select * into v_et
    from event_types
    where id      = p_event_type_id
      and club_id = v_profile.club_id;
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
