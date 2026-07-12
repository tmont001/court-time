-- 0061_archive_roster_guard.sql
-- Phase 21O-D: Add event_archived guard to all roster mutation RPCs.
-- Prevents mutations on archived event rosters.
-- Guard is inserted after event_cancelled check in each function.
-- Requires 0060_archive_event.sql (archived_at column) to be applied first.
-- Apply in Supabase SQL Editor (cloud only). Do NOT apply until 0060 is live.
--
-- Functions updated (9 total):
--   From 0051: admin_add_member, admin_remove_participant, admin_force_confirm,
--              admin_offer_spot, admin_expire_offer, admin_add_guest, admin_remove_guest
--   From 0057: admin_add_roster_member_to_event
--   From 0017: mark_attendance (upgraded from not-exists check to select-into)

-- ═══════════════════════════════════════════════════════════════════════════
-- A. admin_add_member
-- ═══════════════════════════════════════════════════════════════════════════
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
  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

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

-- ═══════════════════════════════════════════════════════════════════════════
-- B. admin_remove_participant
-- ═══════════════════════════════════════════════════════════════════════════
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
  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

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

-- ═══════════════════════════════════════════════════════════════════════════
-- C. admin_force_confirm
-- ═══════════════════════════════════════════════════════════════════════════
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
  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

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

-- ═══════════════════════════════════════════════════════════════════════════
-- D. admin_offer_spot
-- ═══════════════════════════════════════════════════════════════════════════
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
  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

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

-- ═══════════════════════════════════════════════════════════════════════════
-- E. admin_expire_offer
-- ═══════════════════════════════════════════════════════════════════════════
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
  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

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

-- ═══════════════════════════════════════════════════════════════════════════
-- F. admin_add_guest
-- ═══════════════════════════════════════════════════════════════════════════
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
  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

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

-- ═══════════════════════════════════════════════════════════════════════════
-- G. admin_remove_guest
-- ═══════════════════════════════════════════════════════════════════════════
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
  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

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

-- ═══════════════════════════════════════════════════════════════════════════
-- H. admin_add_roster_member_to_event  (from 0057)
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function admin_add_roster_member_to_event(
  p_event_id        uuid,
  p_roster_member_id uuid
)
returns event_guests
language plpgsql security definer as $$
declare
  v_actor        profiles%rowtype;
  v_event        events%rowtype;
  v_roster       roster_members%rowtype;
  v_name         text;
  v_occupied     int;
  v_was_over_cap boolean;
  v_result       event_guests%rowtype;
begin
  -- 1. Auth / admin-or-pro gate.
  select * into v_actor from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_actor.role not in ('admin', 'pro') then
    raise exception 'admin_required';
  end if;

  -- 2. Load event, scoped to actor's club.
  select * into v_event
    from events
   where id      = p_event_id
     and club_id = v_actor.club_id;
  if not found then raise exception 'event_not_found'; end if;
  if v_event.status <> 'scheduled' then raise exception 'event_cancelled'; end if;
  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

  -- 3. Load roster member, scoped to same club.
  select * into v_roster
    from roster_members
   where id      = p_roster_member_id
     and club_id = v_actor.club_id;
  if not found then raise exception 'roster_member_not_found'; end if;

  -- 3b. Must be unclaimed — claimed members should be added via admin_add_member.
  if v_roster.claimed_by is not null then
    raise exception 'roster_member_already_claimed';
  end if;

  -- 4. Build display name.
  v_name := trim(concat_ws(' ', v_roster.first_name, v_roster.last_name));

  -- 5. Capacity for audit.
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

  -- 6. Insert (unique index prevents duplicates).
  insert into event_guests (event_id, display_name, added_by, roster_member_id)
  values (p_event_id, v_name, auth.uid(), p_roster_member_id)
  returning * into v_result;

  -- 7. Audit.
  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_actor.club_id,
    auth.uid(),
    'admin_add_roster_member_to_event',
    'event',
    p_event_id,
    jsonb_build_object(
      'event_title',       v_event.title,
      'roster_member_id',  p_roster_member_id,
      'roster_member_name', v_name,
      'guest_id',          v_result.id,
      'was_over_capacity', v_was_over_cap
    )
  );

  return v_result;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- I. mark_attendance  (from 0017)
-- Upgraded from not-exists event check to select-into to support archived_at guard.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function mark_attendance(
  p_event_id          uuid,
  p_profile_id        uuid,
  p_attendance_status text   -- 'attended' | 'no_show' | null (clears the mark)
)
returns void
language plpgsql security definer as $$
declare
  v_profile      profiles%rowtype;
  v_event        events%rowtype;
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

  -- Load event to verify club scope and check archive status.
  select * into v_event
    from events
    where id      = p_event_id
      and club_id = v_profile.club_id;
  if not found then raise exception 'event_not_found'; end if;
  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

  -- Only confirmed participants are markable; waitlisted/cancelled are not.
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
