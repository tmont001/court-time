-- 0060_archive_event.sql
-- Phase 21O-A: Admin event archive and unarchive.
--
-- Safe, reversible alternative to hard delete for cleaning up old or
-- cancelled events. Archive preserves all linked rows (event_participants,
-- event_guests, reservations, notifications, audit_log) and does not send
-- any member notifications.
--
-- Changes:
--   1. events table — add archived_at (timestamptz) and archived_by (uuid FK)
--   2. Partial index for the default non-archived event query pattern
--   3. Partial index for fast archived-event lookups
--   4. archive_event(p_event_id) — SECURITY DEFINER RPC
--   5. unarchive_event(p_event_id) — SECURITY DEFINER RPC
--
-- Apply in Supabase SQL Editor (cloud only).

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Archive columns
-- ═══════════════════════════════════════════════════════════════════════════

alter table events
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by uuid references profiles(id) on delete set null;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Partial index — non-archived events (default query pattern)
-- ═══════════════════════════════════════════════════════════════════════════

create index if not exists events_club_starts_at_not_archived_idx
  on events (club_id, starts_at desc)
  where archived_at is null;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Partial index — archived events lookup
-- ═══════════════════════════════════════════════════════════════════════════

create index if not exists events_club_archived_at_idx
  on events (club_id, archived_at, starts_at desc)
  where archived_at is not null;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. archive_event
--
-- Marks an event as archived. Does not notify members, does not touch linked
-- rows (event_participants, event_guests, reservations, notifications).
-- Writes an audit_log entry for traceability.
--
-- Permission model:
--   admin — can archive any event in the club
--   pro   — can archive only events where events.created_by = auth.uid()
--   member — raises insufficient_role
--
-- Guards:
--   already_archived   — event.archived_at is not null
--   event_not_past     — status = 'scheduled' and starts_at > now()
--                        (cancelled events and past scheduled events are allowed)
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function archive_event(p_event_id uuid)
returns events
language plpgsql security definer as $$
declare
  v_profile profiles%rowtype;
  v_event   events%rowtype;
  v_result  events%rowtype;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_profile.status <> 'active' then raise exception 'account_inactive'; end if;

  if v_profile.role not in ('admin', 'pro') then
    raise exception 'insufficient_role';
  end if;

  select * into v_event
    from events
    where id      = p_event_id
      and club_id = v_profile.club_id;
  if not found then raise exception 'event_not_found'; end if;

  -- Admins can archive any event in the club.
  -- Pros can archive only events they created.
  if v_profile.role = 'pro' and v_event.created_by <> auth.uid() then
    raise exception 'insufficient_role';
  end if;

  if v_event.archived_at is not null then
    raise exception 'already_archived';
  end if;

  -- Block archiving future scheduled events; cancelled events are always allowed.
  if v_event.status = 'scheduled' and v_event.starts_at > now() then
    raise exception 'event_not_past';
  end if;

  update events
    set archived_at = now(),
        archived_by = auth.uid(),
        updated_at  = now()
    where id = p_event_id
    returning * into v_result;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'archive_event',
    'event',
    p_event_id,
    jsonb_build_object(
      'title',     v_event.title,
      'starts_at', v_event.starts_at,
      'status',    v_event.status
    )
  );

  return v_result;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. unarchive_event
--
-- Removes the archive mark from an event. Fully reverses archive_event.
-- Does not notify members, does not touch linked rows.
-- Writes an audit_log entry for traceability.
--
-- Permission model mirrors archive_event:
--   admin — can unarchive any archived event in the club
--   pro   — can unarchive only events where events.created_by = auth.uid()
--   member — raises insufficient_role
--
-- Guards:
--   not_archived — event.archived_at is null
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function unarchive_event(p_event_id uuid)
returns events
language plpgsql security definer as $$
declare
  v_profile profiles%rowtype;
  v_event   events%rowtype;
  v_result  events%rowtype;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_profile.status <> 'active' then raise exception 'account_inactive'; end if;

  if v_profile.role not in ('admin', 'pro') then
    raise exception 'insufficient_role';
  end if;

  select * into v_event
    from events
    where id      = p_event_id
      and club_id = v_profile.club_id;
  if not found then raise exception 'event_not_found'; end if;

  -- Admins can unarchive any event in the club.
  -- Pros can unarchive only events they created.
  if v_profile.role = 'pro' and v_event.created_by <> auth.uid() then
    raise exception 'insufficient_role';
  end if;

  if v_event.archived_at is null then
    raise exception 'not_archived';
  end if;

  update events
    set archived_at = null,
        archived_by = null,
        updated_at  = now()
    where id = p_event_id
    returning * into v_result;

  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'unarchive_event',
    'event',
    p_event_id,
    jsonb_build_object(
      'title',     v_event.title,
      'starts_at', v_event.starts_at,
      'status',    v_event.status
    )
  );

  return v_result;
end;
$$;
