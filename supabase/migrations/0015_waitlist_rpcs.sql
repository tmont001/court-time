-- 0015_waitlist_rpcs.sql
-- Phase 7B: replace join_event, leave_event, and cancel_event with
-- waitlist-aware versions. Requires 0014_waitlist_schema.sql first.
-- Apply in Supabase SQL Editor (cloud only).

-- ---------------------------------------------------------------------------
-- join_event
-- If the event has capacity: confirmed signup + event_joined notification.
-- If the event is full: waitlisted signup, no notification.
-- Raises already_joined if caller is already confirmed or waitlisted.
-- event_full is no longer raised; full events silently waitlist the caller.
-- Returns the event_participants row so the caller can inspect .status.
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
-- leave_event
-- Cancels caller's confirmed or waitlisted participation.
-- Raises not_joined if the caller has no active (confirmed/waitlisted) row.
-- If caller was confirmed, promotes the earliest waitlisted participant to
-- confirmed and sends them a waitlist_promoted notification.
-- If the event is already cancelled, no promotion occurs.
-- ---------------------------------------------------------------------------
create or replace function leave_event(p_event_id uuid)
returns void
language plpgsql security definer as $$
declare
  v_profile      profiles%rowtype;
  v_event        events%rowtype;
  v_old_status   text;
  v_next_profile uuid;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  -- Capture caller's current active status before cancelling
  select status into v_old_status
    from event_participants
    where event_id   = p_event_id
      and profile_id = auth.uid()
      and status     in ('confirmed', 'waitlisted');
  if not found then raise exception 'not_joined'; end if;

  -- Cancel caller's participation
  update event_participants
    set status = 'cancelled', updated_at = now()
    where event_id   = p_event_id
      and profile_id = auth.uid()
      and status     in ('confirmed', 'waitlisted');

  -- Only promote from waitlist when a confirmed spot was freed
  if v_old_status = 'confirmed' then
    -- Fetch event to verify it is still active and to get title for notification
    select * into v_event
      from events
      where id      = p_event_id
        and club_id = v_profile.club_id
        and status  = 'scheduled';

    if found then
      select profile_id into v_next_profile
        from event_participants
        where event_id = p_event_id
          and status   = 'waitlisted'
        order by created_at asc
        limit 1;

      if found then
        update event_participants
          set status = 'confirmed', updated_at = now()
          where event_id   = p_event_id
            and profile_id = v_next_profile;

        insert into notifications (club_id, user_id, kind, body, metadata)
        values (
          v_profile.club_id,
          v_next_profile,
          'waitlist_promoted',
          'A spot opened up! You''ve been confirmed for "' || v_event.title || '".',
          jsonb_build_object('event_id', p_event_id)
        );
      end if;
    end if;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- cancel_event
-- All existing guard logic, cancellation behavior, and audit_log writes are
-- preserved exactly. One change: event_cancelled notifications now cover
-- waitlisted participants in addition to confirmed ones.
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

  -- Notify both confirmed and waitlisted participants — both lose their spot
  insert into notifications (club_id, user_id, kind, body, metadata)
  select
    v_event.club_id,
    ep.profile_id,
    'event_cancelled',
    '"' || v_event.title || '" has been cancelled.',
    jsonb_build_object('event_id', p_event_id)
  from event_participants ep
  where ep.event_id = p_event_id
    and ep.status   in ('confirmed', 'waitlisted');

  return v_result;
end;
$$;
