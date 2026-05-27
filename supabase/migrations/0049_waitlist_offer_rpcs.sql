-- 0049_waitlist_offer_rpcs.sql
-- Phase 18A: RPC changes for the waitlist offer/confirmation flow.
-- Requires 0048_waitlist_offer_schema.sql to be applied first.
--
-- Functions created/replaced (in dependency order):
--   A. advance_waitlist_offer          — internal helper
--   B. expire_stale_offers_for_event   — internal helper (calls A)
--   C. leave_event                     — replaces 0021; offer instead of auto-promote
--   D. join_event                      — replaces 0043; includes offered in guards/count
--   E. accept_waitlist_offer           — new
--   F. decline_waitlist_offer          — new
--   G. cancel_event                    — replaces 0015; covers offered participants
--   H. get_event_roster                — replaces 0016; returns offered + offer_expires_at
--   I. update_club_settings            — replaces 0025; adds offer window setting
--
-- Apply in Supabase SQL Editor (cloud only).

-- ===========================================================================
-- A. advance_waitlist_offer
-- Internal helper — not exposed as a direct client RPC.
-- Finds the oldest waitlisted participant and transitions them to 'offered'.
-- Guards:
--   • Capacity check: (confirmed + offered) < capacity required before offering.
--   • Idempotency: if a non-expired offered row already exists, returns null.
-- Returns the offered profile_id, or null if no advance was made.
-- ===========================================================================
create or replace function advance_waitlist_offer(
  p_event_id    uuid,
  p_club_id     uuid,
  p_event_title text
)
returns uuid
language plpgsql security definer as $$
declare
  v_next_profile       uuid;
  v_offer_window_hours int;
  v_offer_expires_at   timestamptz;
  v_tz                 text;
  v_expires_label      text;
  v_slot_count         int;
  v_capacity           int;
begin
  -- Idempotency guard: if a non-expired offered row already exists, do nothing.
  if exists (
    select 1 from event_participants
    where event_id        = p_event_id
      and status          = 'offered'
      and offer_expires_at > now()
  ) then
    return null;
  end if;

  -- Capacity guard: only offer if there is actually a free slot.
  -- Offered rows count the same as confirmed against capacity.
  select count(*) into v_slot_count
    from event_participants
    where event_id = p_event_id
      and status   in ('confirmed', 'offered')
      and role     = 'participant';

  select capacity into v_capacity from events where id = p_event_id;

  if v_slot_count >= coalesce(v_capacity, 0) then
    return null;
  end if;

  -- Find the oldest waitlisted participant (FIFO order by created_at).
  select profile_id into v_next_profile
    from event_participants
    where event_id = p_event_id
      and status   = 'waitlisted'
    order by created_at asc
    limit 1;

  if not found then
    return null;
  end if;

  -- Fetch offer window and club timezone.
  select waitlist_offer_window_hours into v_offer_window_hours
    from club_settings
    where club_id = p_club_id;

  -- Defensive fallback: default 2 hours if settings row is missing.
  if not found then
    v_offer_window_hours := 2;
  end if;

  v_offer_expires_at := now() + (v_offer_window_hours || ' hours')::interval;

  select timezone into v_tz from clubs where id = p_club_id;

  v_expires_label := to_char(
    v_offer_expires_at at time zone coalesce(v_tz, 'UTC'),
    'Mon DD "at" HH12:MI AM'
  );

  -- Transition participant to offered.
  update event_participants
    set status           = 'offered',
        offer_expires_at = v_offer_expires_at,
        updated_at       = now()
    where event_id   = p_event_id
      and profile_id = v_next_profile;

  -- Insert waitlist_offer notification (mandatory — no preference gate).
  insert into notifications (club_id, user_id, kind, body, metadata)
  values (
    p_club_id,
    v_next_profile,
    'waitlist_offer',
    'A spot opened in "' || p_event_title || '"! Accept by ' || v_expires_label || '.',
    jsonb_build_object(
      'event_id',        p_event_id,
      'offer_expires_at', v_offer_expires_at
    )
  );

  return v_next_profile;
end;
$$;

-- ===========================================================================
-- B. expire_stale_offers_for_event
-- Internal helper — not exposed as a direct client RPC.
-- Finds all offered rows for the event whose offer_expires_at has passed,
-- cancels each one, writes an audit_log entry, then — if any rows were
-- expired — calls advance_waitlist_offer once to keep the queue moving.
-- ===========================================================================
create or replace function expire_stale_offers_for_event(
  p_event_id    uuid,
  p_club_id     uuid,
  p_event_title text
)
returns void
language plpgsql security definer as $$
declare
  v_row           record;
  v_expired_count int := 0;
begin
  for v_row in
    select profile_id
      from event_participants
      where event_id        = p_event_id
        and status          = 'offered'
        and offer_expires_at < now()
  loop
    -- Cancel the expired offered row.
    update event_participants
      set status           = 'cancelled',
          offer_expires_at = null,
          updated_at       = now()
      where event_id   = p_event_id
        and profile_id = v_row.profile_id;

    -- Audit each expiry. auth.uid() is the authenticated caller of the parent RPC.
    insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
    values (
      p_club_id,
      auth.uid(),
      'waitlist_offer_expired',
      'event',
      p_event_id,
      jsonb_build_object(
        'profile_id',  v_row.profile_id,
        'event_title', p_event_title
      )
    );

    v_expired_count := v_expired_count + 1;
  end loop;

  -- Only advance the queue if we actually freed a slot via expiry.
  if v_expired_count > 0 then
    perform advance_waitlist_offer(p_event_id, p_club_id, p_event_title);
  end if;
end;
$$;

-- ===========================================================================
-- C. leave_event
-- Replaces 0021_leave_event_returns_promoted.sql.
-- Prior behavior preserved: cancels caller's participation; returns offered
-- profile_id (was: promoted profile_id) or null.
-- Phase 18A changes:
--   • Caller eligibility extended to include 'offered' status.
--   • offer_expires_at cleared on cancellation.
--   • Confirmed path: expire stale offers, then advance to next waitlisted
--     (offer mode, not auto-promote); waitlist_promoted notification removed.
--   • Offered path: treated as implicit decline; audit 'leave_offered_spot';
--     same expire + advance chain as confirmed path.
--   • Waitlisted path: unchanged (cancel, return null).
--   • Return value: offered profile_id queried from DB after all operations,
--     so the value is correct regardless of whether expire or advance made
--     the offer.
-- ===========================================================================
drop function if exists leave_event(uuid);

create function leave_event(p_event_id uuid)
returns uuid   -- offered profile_id, or null if no offer was made
language plpgsql security definer as $$
declare
  v_profile    profiles%rowtype;
  v_event      events%rowtype;
  v_old_status text;
  v_offered_id uuid;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  -- Capture the caller's current active status.
  -- Phase 18A: 'offered' is now a valid status to leave from.
  select status into v_old_status
    from event_participants
    where event_id   = p_event_id
      and profile_id = auth.uid()
      and status     in ('confirmed', 'waitlisted', 'offered');
  if not found then raise exception 'not_joined'; end if;

  -- Cancel the caller's participation and clear any offer state.
  update event_participants
    set status           = 'cancelled',
        offer_expires_at = null,
        updated_at       = now()
    where event_id   = p_event_id
      and profile_id = auth.uid()
      and status     in ('confirmed', 'waitlisted', 'offered');

  if v_old_status = 'confirmed' then
    -- A confirmed spot was freed. Expire other stale offers, then advance.
    select * into v_event
      from events
      where id      = p_event_id
        and club_id = v_profile.club_id
        and status  = 'scheduled';

    if found then
      perform expire_stale_offers_for_event(p_event_id, v_profile.club_id, v_event.title);
      perform advance_waitlist_offer(p_event_id, v_profile.club_id, v_event.title);
    end if;

  elsif v_old_status = 'offered' then
    -- Caller is implicitly declining their offer by leaving the event entirely.
    select * into v_event
      from events
      where id      = p_event_id
        and club_id = v_profile.club_id
        and status  = 'scheduled';

    if found then
      insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
      values (
        v_profile.club_id,
        auth.uid(),
        'leave_offered_spot',
        'event',
        p_event_id,
        jsonb_build_object('event_title', v_event.title)
      );

      perform expire_stale_offers_for_event(p_event_id, v_profile.club_id, v_event.title);
      perform advance_waitlist_offer(p_event_id, v_profile.club_id, v_event.title);
    end if;

  else
    -- Caller was waitlisted: no confirmed slot was freed, no advance needed.
    return null;
  end if;

  -- Query whoever is currently offered for this event (may be null).
  -- Using a direct query rather than relying on advance_waitlist_offer's
  -- return value ensures correctness when expire_stale_offers_for_event
  -- made the offer internally.
  select profile_id into v_offered_id
    from event_participants
    where event_id        = p_event_id
      and status          = 'offered'
      and offer_expires_at > now()
    order by updated_at desc
    limit 1;

  return v_offered_id;
end;
$$;

-- ===========================================================================
-- D. join_event
-- Replaces 0043_preference_aware_notification_rpcs.sql (which superseded 0037).
-- Prior behavior preserved exactly: account_inactive guard; waitlist fallback;
-- user_pref_enabled gate on event_joined notification.
-- Phase 18A changes (three lines only):
--   1. expire_stale_offers_for_event called after fetching event (clears stale
--      offered rows so they don't falsely consume capacity).
--   2. advance_waitlist_offer called after expire (maintains FIFO fairness when
--      a stale offer was just cleared; idempotent if expire already advanced).
--   3. already_joined guard extended to include 'offered' status.
--   4. Capacity count extended to include 'offered' rows (an offered slot
--      is reserved and must not be taken by a new joiner).
-- ===========================================================================
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
  -- Prior behavior counted only 'confirmed' participant rows.
  select count(*) into v_count
    from event_participants
    where event_id = p_event_id
      and status   in ('confirmed', 'offered')
      and role     = 'participant';

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

-- ===========================================================================
-- E. accept_waitlist_offer
-- New RPC. Authenticated member only.
-- Caller must have status = 'offered' and offer must not be expired.
-- Transitions caller to 'confirmed'; sends waitlist_promoted notification
-- (mandatory — preserves the existing "you are now confirmed" kind).
-- Returns the updated event_participants row.
-- ===========================================================================
create or replace function accept_waitlist_offer(p_event_id uuid)
returns event_participants
language plpgsql security definer as $$
declare
  v_profile  profiles%rowtype;
  v_event    events%rowtype;
  v_my_row   event_participants%rowtype;
  v_result   event_participants%rowtype;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  -- Verify the event exists within the caller's club.
  select * into v_event
    from events
    where id      = p_event_id
      and club_id = v_profile.club_id
      and status  = 'scheduled';
  if not found then raise exception 'event_not_found'; end if;

  -- Check the caller's offered row before running expire, so we can
  -- distinguish offer_not_found from offer_expired with a precise error.
  select * into v_my_row
    from event_participants
    where event_id   = p_event_id
      and profile_id = auth.uid()
      and status     = 'offered';

  if not found then
    raise exception 'offer_not_found';
  end if;

  if v_my_row.offer_expires_at <= now() then
    raise exception 'offer_expired';
  end if;

  -- Accept: transition to confirmed, clear offer_expires_at.
  update event_participants
    set status           = 'confirmed',
        offer_expires_at = null,
        updated_at       = now()
    where event_id   = p_event_id
      and profile_id = auth.uid()
  returning * into v_result;

  -- Clean up any other stale offers for this event (defensive; normally none).
  -- The capacity check inside advance_waitlist_offer prevents a spurious
  -- advance here since the confirmed+offered count is unchanged after accept.
  perform expire_stale_offers_for_event(p_event_id, v_profile.club_id, v_event.title);

  -- Mandatory waitlist_promoted notification: caller is now confirmed.
  -- Preserves the existing 'waitlist_promoted' kind for the "confirmed" outcome.
  insert into notifications (club_id, user_id, kind, body, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'waitlist_promoted',
    'You''ve accepted and are confirmed for "' || v_event.title || '".',
    jsonb_build_object('event_id', p_event_id)
  );

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'accept_waitlist_offer',
    'event',
    p_event_id,
    jsonb_build_object('event_title', v_event.title)
  );

  return v_result;
end;
$$;

-- ===========================================================================
-- F. decline_waitlist_offer
-- New RPC. Authenticated member only.
-- Caller must have status = 'offered' (expired or not — declining an expired
-- offer is valid as a cleanup path).
-- Transitions caller to 'cancelled', advances queue to next waitlisted member.
-- Returns the offered profile_id of the next person, or null.
-- ===========================================================================
create or replace function decline_waitlist_offer(p_event_id uuid)
returns uuid   -- next offered profile_id, or null
language plpgsql security definer as $$
declare
  v_profile    profiles%rowtype;
  v_event      events%rowtype;
  v_my_row     event_participants%rowtype;
  v_offered_id uuid;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  select * into v_my_row
    from event_participants
    where event_id   = p_event_id
      and profile_id = auth.uid()
      and status     = 'offered';

  if not found then
    raise exception 'offer_not_found';
  end if;

  -- Cancel the caller's offered row.
  update event_participants
    set status           = 'cancelled',
        offer_expires_at = null,
        updated_at       = now()
    where event_id   = p_event_id
      and profile_id = auth.uid();

  -- Fetch event for audit log and expire/advance calls.
  select * into v_event
    from events
    where id      = p_event_id
      and club_id = v_profile.club_id;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'decline_waitlist_offer',
    'event',
    p_event_id,
    jsonb_build_object('event_title', coalesce(v_event.title, ''))
  );

  if found and v_event.status = 'scheduled' then
    -- Expire other stale offers, then advance queue for the freed slot.
    perform expire_stale_offers_for_event(p_event_id, v_profile.club_id, v_event.title);
    perform advance_waitlist_offer(p_event_id, v_profile.club_id, v_event.title);
  end if;

  -- Query whoever is now offered (may be null if nobody is waitlisted).
  select profile_id into v_offered_id
    from event_participants
    where event_id        = p_event_id
      and status          = 'offered'
      and offer_expires_at > now()
    order by updated_at desc
    limit 1;

  return v_offered_id;
end;
$$;

-- ===========================================================================
-- G. cancel_event
-- Replaces 0015_waitlist_rpcs.sql.
-- Prior behavior preserved exactly: admin/host guard; event + reservation
-- cancellation; audit log; event_cancelled notifications.
-- Phase 18A changes (two additions only):
--   1. Update offered participant rows to cancelled (clears offer_expires_at).
--   2. Include 'offered' in the event_cancelled notification recipients.
-- ===========================================================================
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

  -- Phase 18A: cancel offered rows and clear offer_expires_at.
  -- Prevents offered members from attempting to accept after event cancellation.
  update event_participants
    set status           = 'cancelled',
        offer_expires_at = null,
        updated_at       = now()
    where event_id = p_event_id
      and status   = 'offered';

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'cancel_event',
    'event',
    p_event_id,
    jsonb_build_object('title', v_event.title, 'starts_at', v_event.starts_at)
  );

  -- Notify confirmed, waitlisted, and offered participants — all lose their spot.
  -- Phase 18A: 'offered' added to the status filter.
  insert into notifications (club_id, user_id, kind, body, metadata)
  select
    v_event.club_id,
    ep.profile_id,
    'event_cancelled',
    '"' || v_event.title || '" has been cancelled.',
    jsonb_build_object('event_id', p_event_id)
  from event_participants ep
  where ep.event_id = p_event_id
    and ep.status   in ('confirmed', 'waitlisted', 'offered');

  return v_result;
end;
$$;

-- ===========================================================================
-- H. get_event_roster
-- Replaces 0016_get_event_roster_rpc.sql.
-- Prior behavior preserved exactly: admin/pro only; confirmed + waitlisted rows;
-- display_name; waitlist_position (1-based, waitlisted only).
-- Phase 18A changes:
--   1. 'offered' added to status filter.
--   2. offer_expires_at added to return shape.
--   3. 'offered' ordered between 'confirmed' (1) and 'waitlisted' (3).
--   4. waitlist_position remains null for offered rows (same as confirmed).
-- Must DROP first: PostgreSQL rejects create or replace when a RETURNS TABLE
-- definition gains columns (return type change is not permitted in-place).
-- ===========================================================================
drop function if exists get_event_roster(uuid);

create or replace function get_event_roster(p_event_id uuid)
returns table (
  profile_id        uuid,
  display_name      text,
  role              text,
  status            text,
  attendance_status text,
  offer_expires_at  timestamptz,   -- Phase 18A: null for confirmed/waitlisted
  waitlist_position int
)
language plpgsql security definer as $$
declare
  v_profile profiles%rowtype;
  v_event   events%rowtype;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_profile.role not in ('admin', 'pro') then
    raise exception 'insufficient_role';
  end if;

  select * into v_event
    from events
    where id      = p_event_id
      and club_id = v_profile.club_id;
  if not found then raise exception 'event_not_found'; end if;

  return query
    with ranked as (
      select
        ep.profile_id,
        ep.role,
        ep.status,
        ep.attendance_status,
        ep.offer_expires_at,       -- Phase 18A
        ep.created_at,
        row_number() over (
          partition by ep.status
          order by ep.created_at asc
        ) as pos
      from event_participants ep
      where ep.event_id = p_event_id
        and ep.status   in ('confirmed', 'waitlisted', 'offered')  -- Phase 18A: offered added
    )
    select
      r.profile_id,
      coalesce(
        nullif(trim(concat_ws(' ', p.first_name, p.last_name)), ''),
        'Unknown'
      )::text                                                     as display_name,
      r.role::text,
      r.status::text,
      r.attendance_status::text,
      r.offer_expires_at,                                         -- Phase 18A
      case when r.status = 'waitlisted' then r.pos::int else null end
                                                                  as waitlist_position
    from   ranked r
    left join profiles p on p.id = r.profile_id
    order by
      case r.status
        when 'confirmed'  then 1
        when 'offered'    then 2  -- Phase 18A: between confirmed and waitlisted
        when 'waitlisted' then 3  -- Phase 18A: shifted from 2 → 3
        else 4
      end,
      r.created_at asc;
end;
$$;

-- ===========================================================================
-- I. update_club_settings
-- Replaces 0025_cancellation_grace.sql.
-- Prior behavior preserved exactly: admin only; booking window, cancellation
-- window, and grace period validation and persistence; audit log.
-- Phase 18A changes:
--   1. p_waitlist_offer_window_hours int default 2 parameter added.
--   2. Validation: 1–72 hours.
--   3. waitlist_offer_window_hours persisted to club_settings.
--   4. Included in audit log metadata.
-- Must DROP the old 3-arg overload first: adding a 4th parameter creates a
-- distinct overload in PostgreSQL rather than replacing the existing function.
-- Dropping the 3-arg version ensures callers resolve to the new 4-arg version
-- (which accepts 3 args via the p_waitlist_offer_window_hours default).
-- ===========================================================================
drop function if exists update_club_settings(int, int, int);

create or replace function update_club_settings(
  p_booking_window_days          int,
  p_cancellation_window_hours    int,
  p_cancellation_grace_minutes   int default 5,
  p_waitlist_offer_window_hours  int default 2  -- Phase 18A
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
  -- Phase 18A: validate offer window.
  if p_waitlist_offer_window_hours < 1 or p_waitlist_offer_window_hours > 72 then
    raise exception 'invalid_offer_window';
  end if;

  update club_settings set
    booking_window_days           = p_booking_window_days,
    cancellation_window_hours     = p_cancellation_window_hours,
    cancellation_grace_minutes    = p_cancellation_grace_minutes,
    waitlist_offer_window_hours   = p_waitlist_offer_window_hours,  -- Phase 18A
    updated_at                    = now()
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
      'booking_window_days',          p_booking_window_days,
      'cancellation_window_hours',    p_cancellation_window_hours,
      'cancellation_grace_minutes',   p_cancellation_grace_minutes,
      'waitlist_offer_window_hours',  p_waitlist_offer_window_hours  -- Phase 18A
    )
  );

  return v_result;
end;
$$;
