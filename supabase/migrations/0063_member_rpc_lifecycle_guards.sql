-- 0063_member_rpc_lifecycle_guards.sql
-- Phase 21Q-D: Add event_archived guard to all member-facing event RPCs.
--
-- Problem: Admin RPCs gained event_archived guards in 0061. Member-facing RPCs
-- were not updated in that migration, leaving a defense-in-depth gap. In practice
-- members cannot encounter archived events through normal UI flows (archived events
-- are filtered from all member views), but a direct API call could bypass UI guards.
--
-- Functions updated (5 total):
--   A. join_event              — from 0062; add event_archived after event_not_found
--   B. leave_event             — from 0049; add event_archived before participant lookup
--   C. accept_waitlist_offer   — from 0049; add event_archived after event_not_found
--   D. decline_waitlist_offer  — from 0049; add event_archived before participant update
--   E. cancel_event            — from 0049; add event_archived after event_not_found
--
-- Guard pattern (matches 0061):
--   if v_event.archived_at is not null then raise exception 'event_archived'; end if;
--
-- All other behavior, signatures, grants, security-definer, and search paths
-- preserved exactly. Apply in Supabase SQL Editor (cloud only).

-- ═══════════════════════════════════════════════════════════════════════════
-- A. join_event  (from 0062_member_joinable.sql)
-- Added: event_archived guard between event_not_found and event_not_joinable.
-- All other behavior preserved exactly from 0062.
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

  -- Phase 21Q-D: reject join on archived events (defense-in-depth).
  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

  -- Phase 21P-B: reject self-join/waitlist for admin-managed events.
  if not v_event.member_joinable then
    raise exception 'event_not_joinable';
  end if;

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

-- ═══════════════════════════════════════════════════════════════════════════
-- B. leave_event  (from 0049_waitlist_offer_rpcs.sql)
-- Added: event_archived guard via upfront event query, before participant lookup.
-- The upfront query uses club_id for cross-club safety; the status-filtered
-- queries in the confirmed/offered paths are preserved unchanged.
-- All other behavior preserved exactly from 0049.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function leave_event(p_event_id uuid)
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

  -- Phase 21Q-D: reject leave on archived events (defense-in-depth).
  select * into v_event
    from events
    where id      = p_event_id
      and club_id = v_profile.club_id;
  if found and v_event.archived_at is not null then
    raise exception 'event_archived';
  end if;

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

-- ═══════════════════════════════════════════════════════════════════════════
-- C. accept_waitlist_offer  (from 0049_waitlist_offer_rpcs.sql)
-- Added: event_archived guard between event_not_found and offered-row check.
-- All other behavior preserved exactly from 0049.
-- ═══════════════════════════════════════════════════════════════════════════
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

  -- Phase 21Q-D: reject accept on archived events (defense-in-depth).
  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

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

-- ═══════════════════════════════════════════════════════════════════════════
-- D. decline_waitlist_offer  (from 0049_waitlist_offer_rpcs.sql)
-- Added: event_archived guard after event fetch, before any participant update.
-- Execution order:
--   1. Load profile.
--   2. Load and validate the caller's offered participant row.
--   3. Load event (moved before the participant update).
--   4. Reject archived events with event_archived.
--   5. Cancel the participant row, write audit, and advance the queue.
-- All other behavior preserved exactly from 0049.
-- ═══════════════════════════════════════════════════════════════════════════
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

  -- Fetch event for archived check, audit log, and expire/advance calls.
  -- Moved before the participant update so the archived guard fires cleanly.
  select * into v_event
    from events
    where id      = p_event_id
      and club_id = v_profile.club_id;

  -- Phase 21Q-D: reject decline on archived events (defense-in-depth).
  if found and v_event.archived_at is not null then
    raise exception 'event_archived';
  end if;

  -- Cancel the caller's offered row.
  update event_participants
    set status           = 'cancelled',
        offer_expires_at = null,
        updated_at       = now()
    where event_id   = p_event_id
      and profile_id = auth.uid();

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

-- ═══════════════════════════════════════════════════════════════════════════
-- E. cancel_event  (from 0049_waitlist_offer_rpcs.sql)
-- Added: event_archived guard between event_not_found and role/host check.
-- All other behavior preserved exactly from 0049.
-- ═══════════════════════════════════════════════════════════════════════════
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

  -- Phase 21Q-D: reject cancellation of archived events (defense-in-depth).
  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

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
