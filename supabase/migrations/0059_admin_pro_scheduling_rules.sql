-- 0059_admin_pro_scheduling_rules.sql
-- Phase 21N-B: Admin/Pro Scheduling Rule Migration.
--
-- Three targeted changes:
--
--   1. create_reservation — booking-window guard is now member-only.
--      Admins and pros may book courts beyond booking_window_days.
--      Past-date guard ('cannot_book_past') is preserved for all roles.
--      All other checks from 0053 are preserved unchanged, including:
--        - authentication and active-member enforcement
--        - court/club validity
--        - positive-duration guard
--        - Phase 20D-B: permitted-duration check (30/60/90/120 min)
--        - Phase 17A: operating-hours override check
--        - weekly operating-hours fallback
--        - overlap protection (GiST constraint on insert)
--        - Phase 16F: preference-gated reservation_confirmed notification
--
--   2. create_event — past-date guard ('cannot_create_past') removed.
--      Admins and pros may now create events in the past for record-keeping.
--      All other checks from 0058 are preserved unchanged, including:
--        - authentication and account_inactive enforcement
--        - role check ('pro' or 'admin' required)
--        - invalid_duration guard
--        - event_type_not_found guard
--        - court reservation inserts (conflict detection via GiST)
--        - Phase 21I-D: no auto-host participant row inserted
--
--   3. join_event — server-side past-date guard added.
--      Returns 'event_already_started' when a caller attempts to
--      join or waitlist for an event whose starts_at is in the past.
--      Previously this was UI-only. All behavior from 0050 is preserved
--      unchanged, including:
--        - authentication and account_inactive enforcement
--        - Phase 18A: stale-offer expiry and queue advancement
--        - Phase 18A: 'offered' in the already_joined guard
--        - Phase 18A: offered rows count against capacity
--        - Phase 19A: event_guests count against capacity
--        - Phase 16F: preference-gated event_joined notification
--
-- Does not change: create_maintenance_block, create_maintenance_blocks,
-- leave_event, cancel_event, or any admin participant RPCs.
-- Apply in Supabase SQL Editor (cloud only).

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. create_reservation — booking-window guard scoped to role = 'member'
--    Full reproduction of 0053 with one targeted change only.
-- ═══════════════════════════════════════════════════════════════════════════
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
  v_date     date;                             -- Phase 17A: local booking date
  v_override operating_hours_override%rowtype; -- Phase 17A: date-specific override
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

  -- Past-date guard: applies to all roles. Admins and pros may not book in the past.
  if p_starts_at < now() then
    raise exception 'cannot_book_past';
  end if;

  -- Booking-window guard: members only. Admins and pros may book beyond the window.
  if v_profile.role = 'member'
     and p_starts_at > now() + (v_settings.booking_window_days || ' days')::interval then
    raise exception 'outside_booking_window';
  end if;

  if p_ends_at <= p_starts_at then
    raise exception 'invalid_duration';
  end if;

  -- Phase 20D-B: member court reservations must use one of the supported durations.
  if extract(epoch from (p_ends_at - p_starts_at)) / 60 not in (30, 60, 90, 120) then
    raise exception 'invalid_duration';
  end if;

  -- ---------------------------------------------------------------------------
  -- Phase 17A: check for a date-specific override before falling back to the
  -- weekly operating_hours. The override lookup uses the club-local calendar
  -- date (v_date) derived from the booking's starts_at timestamp.
  -- ---------------------------------------------------------------------------
  v_date := (p_starts_at at time zone v_tz)::date;
  v_dow  := extract(dow from p_starts_at at time zone v_tz)::int;

  select * into v_override
    from operating_hours_override
    where club_id       = v_profile.club_id
      and override_date = v_date;

  if found then
    -- An override exists for this date — it takes priority over weekly hours.
    if v_override.is_closed then
      raise exception 'club_closed_this_day';
    end if;
    -- When special hours are set, reject bookings that fall outside them.
    if v_override.opens_at is not null and v_override.closes_at is not null then
      if (p_starts_at at time zone v_tz)::time < v_override.opens_at
         or (p_ends_at at time zone v_tz)::time > v_override.closes_at then
        raise exception 'outside_operating_hours';
      end if;
    end if;
    -- Override exists and booking is within bounds; skip the weekly check below.
  else
    -- No override for this date — apply normal weekly operating_hours.
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
  end if;
  -- ---------------------------------------------------------------------------

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

  -- Phase 16F: only insert the in-app notification if the member has this kind enabled.
  if user_pref_enabled(auth.uid(), 'reservation_confirmed') then
    insert into notifications (club_id, user_id, kind, body, metadata)
    values (
      v_profile.club_id,
      auth.uid(),
      'reservation_confirmed',
      v_court.name || ' booked for '
        || to_char(p_starts_at at time zone v_tz, 'Mon DD "at" HH12:MI AM'),
      jsonb_build_object('reservation_id', v_result.id, 'court_id', p_court_id)
    );
  end if;

  return v_result;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. create_event — remove past-date guard
--    Full reproduction of 0058 with one targeted change only.
--    Admins and pros may now create events with starts_at in the past.
-- ═══════════════════════════════════════════════════════════════════════════
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
  -- Phase 21N-B: past-date guard removed. Admins and pros may create events
  -- in the past for record-keeping purposes.

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

  -- Phase 21I-D: host participant row not inserted.
  -- The creator is recorded in events.created_by for ownership/audit;
  -- they join the roster only if explicitly added via the roster UI.

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

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. join_event — add server-side past-date guard
--    Full reproduction of 0050 with one targeted addition only.
-- ═══════════════════════════════════════════════════════════════════════════
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

  -- Phase 21N-B: reject join/waitlist attempts for events that have already started.
  if v_event.starts_at < now() then
    raise exception 'event_already_started';
  end if;

  -- Phase 18A: expire stale offered rows so they do not falsely consume capacity.
  perform expire_stale_offers_for_event(p_event_id, v_profile.club_id, v_event.title);

  -- Phase 18A: advance the queue if a stale offer was just cleared (FIFO fairness).
  -- Idempotent: if expire already advanced, this call returns null and is a no-op.
  perform advance_waitlist_offer(p_event_id, v_profile.club_id, v_event.title);

  -- Guard: already an active participant.
  -- Phase 18A: 'offered' added — an offered member cannot join again.
  if exists (
    select 1 from event_participants
    where event_id   = p_event_id
      and profile_id = auth.uid()
      and status     in ('confirmed', 'waitlisted', 'offered')
  ) then raise exception 'already_joined'; end if;

  -- Phase 18A: 'offered' rows count against capacity (the slot is reserved).
  -- Phase 19A: event_guests also count against capacity.
  select
    (select count(*)
       from event_participants
       where event_id = p_event_id
         and status   in ('confirmed', 'offered')
         and role     = 'participant')
    +
    (select count(*)
       from event_guests
       where event_id = p_event_id)
    into v_count;

  if v_count >= v_event.capacity then
    -- Event is full → place caller on waitlist.
    insert into event_participants (event_id, profile_id, role, status)
    values (p_event_id, auth.uid(), 'participant', 'waitlisted')
    on conflict (event_id, profile_id)
      do update set status = 'waitlisted', updated_at = now()
    returning * into v_result;
    -- No notification for waitlist joins; UI reflects status immediately.
  else
    -- Event has capacity → confirmed signup.
    insert into event_participants (event_id, profile_id, role, status)
    values (p_event_id, auth.uid(), 'participant', 'confirmed')
    on conflict (event_id, profile_id)
      do update set status = 'confirmed', updated_at = now()
    returning * into v_result;

    -- Preference-gated event_joined notification (preserved from 0043).
    if user_pref_enabled(auth.uid(), 'event_joined') then
      insert into notifications (club_id, user_id, kind, body, metadata)
      values (
        v_profile.club_id,
        auth.uid(),
        'event_joined',
        'You''ve joined "' || v_event.title || '".',
        jsonb_build_object('event_id', p_event_id)
      );
    end if;
  end if;

  return v_result;
end;
$$;
