-- 0043_preference_aware_notification_rpcs.sql
-- Phase 16F: add user_pref_enabled() guard to the four user-configurable
-- notification-inserting RPCs. Each function is reproduced in full from its
-- prior migration (latest versions: 0037, 0040, 0041) with only the
-- notification INSERT wrapped in a preference check.
--
-- Mandatory kinds (reservation_cancelled_by_admin, event_cancelled,
-- waitlist_promoted) are NOT touched here.
-- Requires 0042_notification_preferences.sql to be applied first.
-- Apply in Supabase SQL Editor (cloud only).

-- ---------------------------------------------------------------------------
-- create_reservation — add reservation_confirmed preference guard
-- Latest prior version: 0037_set_member_status.sql
-- One change only: notification INSERT wrapped with user_pref_enabled check.
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

  -- Only insert the in-app notification if the member has this kind enabled.
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

-- ---------------------------------------------------------------------------
-- join_event — add event_joined preference guard
-- Latest prior version: 0037_set_member_status.sql
-- One change only: notification INSERT in the confirmed branch wrapped with
-- user_pref_enabled check.
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

    -- Only insert the in-app notification if the member has this kind enabled.
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

-- ---------------------------------------------------------------------------
-- notify_reservation_cancelled_by_member — add preference guard
-- Latest prior version: 0040_notify_reservation_cancelled_by_member_rpc.sql
-- One change only: notification INSERT wrapped with user_pref_enabled check.
-- ---------------------------------------------------------------------------
create or replace function notify_reservation_cancelled_by_member(
  p_reservation_id uuid
)
returns void
language plpgsql security definer as $$
declare
  v_profile profiles%rowtype;
  v_res     reservations%rowtype;
  v_tz      text;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  -- Verify the reservation belongs to the caller, is in their club, and is
  -- already cancelled. Checking status = 'cancelled' ensures the server action's
  -- update succeeded before we record the notification.
  select * into v_res
    from reservations
    where id            = p_reservation_id
      and owner_user_id = auth.uid()
      and club_id       = v_profile.club_id
      and status        = 'cancelled';
  if not found then raise exception 'reservation_not_found'; end if;

  select timezone into v_tz from clubs where id = v_profile.club_id;

  -- Only insert the in-app notification if the member has this kind enabled.
  if user_pref_enabled(auth.uid(), 'reservation_cancelled_by_member') then
    insert into notifications (club_id, user_id, kind, body, metadata)
    values (
      v_profile.club_id,
      auth.uid(),
      'reservation_cancelled_by_member',
      'Your reservation on '
        || to_char(v_res.starts_at at time zone v_tz, 'Mon DD "at" HH12:MI AM')
        || ' was cancelled.',
      jsonb_build_object('reservation_id', p_reservation_id)
    );
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- send_announcement — add announcement preference filter to bulk insert
-- Latest prior version: 0041_send_announcement_rpc.sql
-- Changes:
--   1. Recipient pre-count query removed.
--   2. INSERT SELECT WHERE clause filters by each recipient's preference
--      (coalesce to true when no row exists — default on).
--   3. GET DIAGNOSTICS counts actual insertions for the return value and
--      audit_log, so the count reflects who actually received the notification.
-- ---------------------------------------------------------------------------
create or replace function send_announcement(
  p_title text,
  p_body  text
)
returns integer
language plpgsql security definer as $$
declare
  v_profile        profiles%rowtype;
  v_recipient_count integer;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_profile.role <> 'admin' then
    raise exception 'insufficient_role';
  end if;

  -- Validate: both fields required; title ≤ 100 chars; body ≤ 500 chars.
  if trim(p_title) = '' or trim(p_body) = '' then
    raise exception 'invalid_announcement';
  end if;
  if length(trim(p_title)) > 100 or length(trim(p_body)) > 500 then
    raise exception 'invalid_announcement';
  end if;

  -- Bulk-insert announcement notifications for all active members in the club,
  -- excluding the sender, filtered by each recipient's announcement preference
  -- (coalesce to true when no row exists — default on).
  insert into notifications (club_id, user_id, kind, body, metadata)
  select
    v_profile.club_id,
    p.id,
    'announcement',
    trim(p_body),
    jsonb_build_object(
      'title',     trim(p_title),
      'sender_id', auth.uid()
    )
  from profiles p
  where p.club_id = v_profile.club_id
    and p.status  = 'active'
    and p.id      <> auth.uid()
    and coalesce(
      (select enabled
         from notification_preferences
        where user_id = p.id
          and kind    = 'announcement'),
      true
    ) = true;

  -- Count actual rows inserted (reflects preference filtering).
  get diagnostics v_recipient_count = row_count;

  -- Audit log.
  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'send_announcement',
    'club',
    v_profile.club_id,
    jsonb_build_object(
      'title',           trim(p_title),
      'recipient_count', v_recipient_count
    )
  );

  return v_recipient_count;
end;
$$;
