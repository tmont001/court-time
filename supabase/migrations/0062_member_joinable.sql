-- 0062_member_joinable.sql
-- Phase 21P-B: Admin-managed / non-joinable events.
-- Adds member_joinable boolean to events and guards join_event against
-- events where self-registration is disabled.
-- Requires 0060_archive_event.sql (archived_at column) to be applied first.
-- Apply in Supabase SQL Editor (cloud only).
--
-- Changes:
--   1. events.member_joinable boolean not null default true
--   2. create_event  — add p_member_joinable parameter (default true)
--   3. join_event    — add event_not_joinable guard
--
-- Index decision:
--   No new index is added. The existing events_club_starts_at_idx (club_id, starts_at)
--   covers all current queries. The member /events filter for member_joinable = true
--   is a 21P-C UI change; adding a partial index before that query exists would be
--   premature. A partial index can be added in 21P-C alongside the query change.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Add member_joinable column
-- ═══════════════════════════════════════════════════════════════════════════
alter table events
  add column if not exists member_joinable boolean not null default true;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. create_event  (from 0059_admin_pro_scheduling_rules.sql)
-- Added: p_member_joinable boolean default true parameter (last, backward-compat).
-- Added: member_joinable in INSERT column list and coalesce(p_member_joinable, true) in values.
-- All other behavior preserved exactly from 0059 — notably no cannot_create_past guard
-- (Phase 21N-B intentionally allows admins/pros to create past events).
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function create_event(
  p_event_type_id   uuid,
  p_title           text,
  p_starts_at       timestamptz,
  p_ends_at         timestamptz,
  p_court_ids       uuid[],
  p_description     text    default null,
  p_capacity        int     default null,
  p_notes           text    default null,
  p_member_joinable boolean default true
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
    starts_at, ends_at, capacity, court_count, status, created_by, member_joinable
  ) values (
    v_profile.club_id, v_et.id, p_title, p_description,
    p_starts_at, p_ends_at,
    coalesce(p_capacity, v_et.default_capacity),
    array_length(p_court_ids, 1),
    'scheduled', auth.uid(),
    coalesce(p_member_joinable, true)
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

-- Remove the old 8-argument overload so Supabase RPC calls are not ambiguous.
drop function if exists public.create_event(
  uuid,
  text,
  timestamptz,
  timestamptz,
  uuid[],
  text,
  integer,
  text
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. join_event  (from 0059_admin_pro_scheduling_rules.sql)
-- Added: event_not_joinable guard immediately after event_not_found check.
-- All other behavior preserved exactly from 0059.
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
