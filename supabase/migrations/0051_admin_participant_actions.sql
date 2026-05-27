-- 0051_admin_participant_actions.sql
-- Phase 19B: Admin participant action RPCs.
-- Requires 0050_event_guests.sql to be applied first.
--
-- Functions created (in dependency order):
--   A. admin_add_member         — add a club member to an event roster
--   B. admin_remove_participant — cancel a member from an event roster
--   C. admin_force_confirm      — promote any non-confirmed member (capacity override)
--   D. admin_offer_spot         — offer a specific waitlisted member a spot (FIFO bypass)
--   E. admin_expire_offer       — immediately cancel an active offer (no auto-advance)
--   F. admin_add_guest          — add a named non-member guest to an event
--   G. admin_remove_guest       — remove a guest from an event
--
-- All functions are SECURITY DEFINER and require admin or pro role.
-- Capacity formula: (confirmed + offered participants) + event_guests count.
-- apply in Supabase SQL Editor (cloud only).

-- ===========================================================================
-- Shared guard pattern used by all functions in this file:
--
--   1. Auth:    auth.uid() maps to an active profiles row
--   2. Role:    caller role in ('admin', 'pro')
--   3. Event:   event belongs to caller's club; check cancelled separately
--   4. Target:  profile/participant/guest exists and satisfies preconditions
--
-- Error codes (raised as exceptions, caught by server actions):
--   not_authenticated     — no auth session
--   admin_required        — caller role is 'member'
--   event_not_found       — no event with p_event_id in caller's club
--   event_cancelled       — event exists but status = 'cancelled'
--   member_not_found      — p_profile_id not in caller's club
--   member_inactive       — profile.status <> 'active'
--   participant_not_found — no matching active/cancelled row in event_participants
--   already_joined        — member already has confirmed/waitlisted/offered status
--   offer_already_active  — a non-expired offered row exists (admin_offer_spot only)
--   no_capacity_for_offer — occupied >= capacity, cannot create a valid offer
--   guest_not_found       — no event_guests row matching p_guest_id + p_event_id
--   invalid_guest_name    — trimmed display_name is empty
-- ===========================================================================

-- ===========================================================================
-- A. admin_add_member
-- Adds a club member to an event as a participant.
-- Outcome: confirmed if a slot is available, waitlisted if the event is full.
-- Reactivates a prior cancelled row via ON CONFLICT rather than inserting a
-- duplicate; the UNIQUE(event_id, profile_id) constraint is preserved.
-- Does NOT trigger advance_waitlist_offer — the caller explicitly chose who
-- to add, so no implicit queue advancement is needed.
-- ===========================================================================
create or replace function admin_add_member(
  p_event_id   uuid,
  p_profile_id uuid
)
returns event_participants
language plpgsql security definer as $$
declare
  v_actor      profiles%rowtype;
  v_event      events%rowtype;
  v_occupied   int;
  v_new_status text;
  v_result     event_participants%rowtype;
begin
  select * into v_actor from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_actor.role not in ('admin', 'pro') then
    raise exception 'admin_required';
  end if;

  select * into v_event
    from events
    where id      = p_event_id
      and club_id = v_actor.club_id;
  if not found then raise exception 'event_not_found'; end if;
  if v_event.status <> 'scheduled' then raise exception 'event_cancelled'; end if;

  -- Target must belong to the same club and be active.
  if not exists (
    select 1 from profiles
    where id      = p_profile_id
      and club_id = v_actor.club_id
      and status  = 'active'
  ) then
    if not exists (select 1 from profiles where id = p_profile_id and club_id = v_actor.club_id) then
      raise exception 'member_not_found';
    end if;
    raise exception 'member_inactive';
  end if;

  -- Guard: already an active participant (any role).
  if exists (
    select 1 from event_participants
    where event_id   = p_event_id
      and profile_id = p_profile_id
      and status     in ('confirmed', 'waitlisted', 'offered')
  ) then raise exception 'already_joined'; end if;

  -- Capacity: confirmed/offered participants + guests.
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
    into v_occupied;

  v_new_status := case when v_occupied >= v_event.capacity then 'waitlisted' else 'confirmed' end;

  -- Upsert: insert new row or reactivate a prior cancelled row.
  -- ON CONFLICT preserves the existing role (host rows stay host).
  insert into event_participants (event_id, profile_id, role, status, offer_expires_at)
  values (p_event_id, p_profile_id, 'participant', v_new_status, null)
  on conflict (event_id, profile_id)
    do update set
      status           = v_new_status,
      offer_expires_at = null,
      updated_at       = now()
  returning * into v_result;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_actor.club_id,
    auth.uid(),
    'admin_add_member',
    'event',
    p_event_id,
    jsonb_build_object(
      'event_title',      v_event.title,
      'added_profile_id', p_profile_id,
      'final_status',     v_new_status
    )
  );

  return v_result;
end;
$$;

-- ===========================================================================
-- B. admin_remove_participant
-- Cancels a member's active participation (confirmed, offered, or waitlisted).
-- If the removed row held a capacity slot (confirmed or offered), triggers the
-- standard expire + advance chain so the next waitlisted member is offered.
-- ===========================================================================
create or replace function admin_remove_participant(
  p_event_id   uuid,
  p_profile_id uuid
)
returns void
language plpgsql security definer as $$
declare
  v_actor      profiles%rowtype;
  v_event      events%rowtype;
  v_old_status text;
begin
  select * into v_actor from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_actor.role not in ('admin', 'pro') then
    raise exception 'admin_required';
  end if;

  select * into v_event
    from events
    where id      = p_event_id
      and club_id = v_actor.club_id;
  if not found then raise exception 'event_not_found'; end if;
  if v_event.status <> 'scheduled' then raise exception 'event_cancelled'; end if;

  -- Target row must be active (non-cancelled).
  select status into v_old_status
    from event_participants
    where event_id   = p_event_id
      and profile_id = p_profile_id
      and status     in ('confirmed', 'offered', 'waitlisted');
  if not found then raise exception 'participant_not_found'; end if;

  -- Cancel and clear any offer state.
  update event_participants
    set status           = 'cancelled',
        offer_expires_at = null,
        updated_at       = now()
    where event_id   = p_event_id
      and profile_id = p_profile_id;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_actor.club_id,
    auth.uid(),
    'admin_remove_participant',
    'event',
    p_event_id,
    jsonb_build_object(
      'event_title',        v_event.title,
      'removed_profile_id', p_profile_id,
      'previous_status',    v_old_status
    )
  );

  -- A capacity slot was freed: expire other stale offers, then advance the queue.
  -- Waitlisted removal frees no slot, so no advance is needed for that case.
  if v_old_status in ('confirmed', 'offered') then
    perform expire_stale_offers_for_event(p_event_id, v_actor.club_id, v_event.title);
    perform advance_waitlist_offer(p_event_id, v_actor.club_id, v_event.title);
  end if;
end;
$$;

-- ===========================================================================
-- C. admin_force_confirm
-- Moves a waitlisted, offered, or cancelled participant directly to confirmed.
-- Does NOT enforce capacity — this is an explicit admin override.
-- Sends a mandatory waitlist_promoted notification to the target member.
-- Records whether capacity was already at or above the limit at action time.
-- ===========================================================================
create or replace function admin_force_confirm(
  p_event_id   uuid,
  p_profile_id uuid
)
returns event_participants
language plpgsql security definer as $$
declare
  v_actor        profiles%rowtype;
  v_event        events%rowtype;
  v_old_status   text;
  v_occupied     int;
  v_was_over_cap boolean;
  v_result       event_participants%rowtype;
begin
  select * into v_actor from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_actor.role not in ('admin', 'pro') then
    raise exception 'admin_required';
  end if;

  select * into v_event
    from events
    where id      = p_event_id
      and club_id = v_actor.club_id;
  if not found then raise exception 'event_not_found'; end if;
  if v_event.status <> 'scheduled' then raise exception 'event_cancelled'; end if;

  -- Target profile must belong to the same club and be active.
  if not exists (
    select 1 from profiles
    where id      = p_profile_id
      and club_id = v_actor.club_id
      and status  = 'active'
  ) then
    if not exists (select 1 from profiles where id = p_profile_id and club_id = v_actor.club_id) then
      raise exception 'member_not_found';
    end if;
    raise exception 'member_inactive';
  end if;

  -- Target row must exist (any status) and must not already be confirmed.
  select status into v_old_status
    from event_participants
    where event_id   = p_event_id
      and profile_id = p_profile_id;
  if not found then raise exception 'participant_not_found'; end if;
  if v_old_status = 'confirmed' then raise exception 'already_joined'; end if;

  -- Compute occupied capacity before the action (for audit trail).
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
    into v_occupied;

  v_was_over_cap := v_occupied >= v_event.capacity;

  -- Force confirm — no capacity gate.
  update event_participants
    set status           = 'confirmed',
        offer_expires_at = null,
        updated_at       = now()
    where event_id   = p_event_id
      and profile_id = p_profile_id
  returning * into v_result;

  -- Mandatory notification: target member is now confirmed.
  insert into notifications (club_id, user_id, kind, body, metadata)
  values (
    v_actor.club_id,
    p_profile_id,
    'waitlist_promoted',
    'An admin confirmed your spot in "' || v_event.title || '".',
    jsonb_build_object('event_id', p_event_id)
  );

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_actor.club_id,
    auth.uid(),
    'admin_force_confirm',
    'event',
    p_event_id,
    jsonb_build_object(
      'event_title',       v_event.title,
      'profile_id',        p_profile_id,
      'previous_status',   v_old_status,
      'was_over_capacity', v_was_over_cap
    )
  );

  return v_result;
end;
$$;

-- ===========================================================================
-- D. admin_offer_spot
-- Manually offers a capacity slot to a specific waitlisted member, bypassing
-- FIFO order. Blocked when another non-expired offer already exists or when
-- there is no free slot to back the offer.
-- Records skipped_profile_ids: waitlisted members who had an earlier position
-- than the offered member, providing an audit trail for the FIFO bypass.
-- ===========================================================================
create or replace function admin_offer_spot(
  p_event_id   uuid,
  p_profile_id uuid
)
returns event_participants
language plpgsql security definer as $$
declare
  v_actor              profiles%rowtype;
  v_event              events%rowtype;
  v_target_row         event_participants%rowtype;
  v_slot_count         int;
  v_offer_window_hours int;
  v_offer_expires_at   timestamptz;
  v_tz                 text;
  v_expires_label      text;
  v_skipped_ids        uuid[];
  v_result             event_participants%rowtype;
begin
  select * into v_actor from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_actor.role not in ('admin', 'pro') then
    raise exception 'admin_required';
  end if;

  select * into v_event
    from events
    where id      = p_event_id
      and club_id = v_actor.club_id;
  if not found then raise exception 'event_not_found'; end if;
  if v_event.status <> 'scheduled' then raise exception 'event_cancelled'; end if;

  -- Target row must be waitlisted.
  select * into v_target_row
    from event_participants
    where event_id   = p_event_id
      and profile_id = p_profile_id
      and status     = 'waitlisted';
  if not found then raise exception 'participant_not_found'; end if;

  -- Block if a non-expired offered row already exists for this event.
  -- Admin must call admin_expire_offer first to clear it.
  if exists (
    select 1 from event_participants
    where event_id        = p_event_id
      and status          = 'offered'
      and offer_expires_at > now()
  ) then raise exception 'offer_already_active'; end if;

  -- Capacity guard: an offer is only meaningful if there is a free slot.
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
    into v_slot_count;

  if v_slot_count >= v_event.capacity then
    raise exception 'no_capacity_for_offer';
  end if;

  -- Compute skipped_profile_ids: waitlisted members with an earlier queue
  -- position (created_at) than the target. Empty array when target is first.
  select coalesce(array_agg(profile_id order by created_at asc), '{}') into v_skipped_ids
    from event_participants
    where event_id   = p_event_id
      and status     = 'waitlisted'
      and profile_id <> p_profile_id
      and created_at < v_target_row.created_at;

  -- Fetch offer window and club timezone.
  select waitlist_offer_window_hours into v_offer_window_hours
    from club_settings
    where club_id = v_actor.club_id;

  if not found then
    v_offer_window_hours := 2;
  end if;

  v_offer_expires_at := now() + (v_offer_window_hours || ' hours')::interval;

  select timezone into v_tz from clubs where id = v_actor.club_id;

  v_expires_label := to_char(
    v_offer_expires_at at time zone coalesce(v_tz, 'UTC'),
    'Mon DD "at" HH12:MI AM'
  );

  -- Transition to offered.
  update event_participants
    set status           = 'offered',
        offer_expires_at = v_offer_expires_at,
        updated_at       = now()
    where event_id   = p_event_id
      and profile_id = p_profile_id
  returning * into v_result;

  -- Mandatory waitlist_offer notification (same kind as advance_waitlist_offer).
  insert into notifications (club_id, user_id, kind, body, metadata)
  values (
    v_actor.club_id,
    p_profile_id,
    'waitlist_offer',
    'A spot opened in "' || v_event.title || '"! Accept by ' || v_expires_label || '.',
    jsonb_build_object(
      'event_id',         p_event_id,
      'offer_expires_at', v_offer_expires_at
    )
  );

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_actor.club_id,
    auth.uid(),
    'admin_offer_spot',
    'event',
    p_event_id,
    jsonb_build_object(
      'event_title',         v_event.title,
      'profile_id',          p_profile_id,
      'offer_expires_at',    v_offer_expires_at,
      'skipped_profile_ids', v_skipped_ids
    )
  );

  return v_result;
end;
$$;

-- ===========================================================================
-- E. admin_expire_offer
-- Immediately cancels an active offered row without auto-advancing the queue.
-- The admin explicitly controls what happens next (e.g., call admin_offer_spot
-- to a specific member, or leave the queue to advance naturally on next action).
-- Accepts both non-expired and already-expired offered rows: both are 'offered'
-- status and the admin may want to clean up either.
-- ===========================================================================
create or replace function admin_expire_offer(
  p_event_id   uuid,
  p_profile_id uuid
)
returns void
language plpgsql security definer as $$
declare
  v_actor  profiles%rowtype;
  v_event  events%rowtype;
begin
  select * into v_actor from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_actor.role not in ('admin', 'pro') then
    raise exception 'admin_required';
  end if;

  select * into v_event
    from events
    where id      = p_event_id
      and club_id = v_actor.club_id;
  if not found then raise exception 'event_not_found'; end if;
  if v_event.status <> 'scheduled' then raise exception 'event_cancelled'; end if;

  -- Target must be in offered state.
  if not exists (
    select 1 from event_participants
    where event_id   = p_event_id
      and profile_id = p_profile_id
      and status     = 'offered'
  ) then raise exception 'participant_not_found'; end if;

  -- Cancel the offered row. No auto-advance — admin controls next step.
  update event_participants
    set status           = 'cancelled',
        offer_expires_at = null,
        updated_at       = now()
    where event_id   = p_event_id
      and profile_id = p_profile_id
      and status     = 'offered';

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_actor.club_id,
    auth.uid(),
    'admin_expire_offer',
    'event',
    p_event_id,
    jsonb_build_object(
      'event_title', v_event.title,
      'profile_id',  p_profile_id
    )
  );
end;
$$;

-- ===========================================================================
-- F. admin_add_guest
-- Adds a named non-member guest to an event. Guests always occupy a capacity
-- slot (counted in the same formula as confirmed members). Admin override:
-- the insert proceeds even if the event is at or over capacity, but the audit
-- log records was_over_capacity so the action is traceable.
-- Returns the inserted event_guests row.
-- ===========================================================================
create or replace function admin_add_guest(
  p_event_id     uuid,
  p_display_name text
)
returns event_guests
language plpgsql security definer as $$
declare
  v_actor        profiles%rowtype;
  v_event        events%rowtype;
  v_name         text;
  v_occupied     int;
  v_was_over_cap boolean;
  v_result       event_guests%rowtype;
begin
  select * into v_actor from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_actor.role not in ('admin', 'pro') then
    raise exception 'admin_required';
  end if;

  select * into v_event
    from events
    where id      = p_event_id
      and club_id = v_actor.club_id;
  if not found then raise exception 'event_not_found'; end if;
  if v_event.status <> 'scheduled' then raise exception 'event_cancelled'; end if;

  v_name := trim(p_display_name);
  if char_length(v_name) < 1 then raise exception 'invalid_guest_name'; end if;

  -- Compute occupied before insert (for was_over_capacity audit field).
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
    into v_occupied;

  v_was_over_cap := v_occupied >= v_event.capacity;

  insert into event_guests (event_id, display_name, added_by)
  values (p_event_id, v_name, auth.uid())
  returning * into v_result;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_actor.club_id,
    auth.uid(),
    'admin_add_guest',
    'event',
    p_event_id,
    jsonb_build_object(
      'event_title',       v_event.title,
      'guest_id',          v_result.id,
      'guest_name',        v_name,
      'was_over_capacity', v_was_over_cap
    )
  );

  return v_result;
end;
$$;

-- ===========================================================================
-- G. admin_remove_guest
-- Removes a guest from an event. Frees one capacity slot; if the event now
-- has a vacancy and someone is on the waitlist, triggers the standard
-- expire + advance chain so the next waitlisted member is offered.
-- ===========================================================================
create or replace function admin_remove_guest(
  p_event_id uuid,
  p_guest_id  uuid
)
returns void
language plpgsql security definer as $$
declare
  v_actor    profiles%rowtype;
  v_event    events%rowtype;
  v_guest    event_guests%rowtype;
  v_occupied int;
begin
  select * into v_actor from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_actor.role not in ('admin', 'pro') then
    raise exception 'admin_required';
  end if;

  select * into v_event
    from events
    where id      = p_event_id
      and club_id = v_actor.club_id;
  if not found then raise exception 'event_not_found'; end if;
  if v_event.status <> 'scheduled' then raise exception 'event_cancelled'; end if;

  -- Guest row must exist for this event.
  select * into v_guest
    from event_guests
    where id       = p_guest_id
      and event_id = p_event_id;
  if not found then raise exception 'guest_not_found'; end if;

  delete from event_guests where id = p_guest_id;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_actor.club_id,
    auth.uid(),
    'admin_remove_guest',
    'event',
    p_event_id,
    jsonb_build_object(
      'event_title', v_event.title,
      'guest_id',    p_guest_id,
      'guest_name',  v_guest.display_name
    )
  );

  -- Check whether the removal freed a slot below capacity.
  -- Count AFTER delete (guest row is already gone).
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
    into v_occupied;

  if v_occupied < v_event.capacity then
    perform expire_stale_offers_for_event(p_event_id, v_actor.club_id, v_event.title);
    perform advance_waitlist_offer(p_event_id, v_actor.club_id, v_event.title);
  end if;
end;
$$;
