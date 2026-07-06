-- 0058_create_event_no_auto_host.sql
-- Phase 21I-D: stop auto-adding the event creator to the roster as Host.
--
-- Before this change, create_event inserted the creator as a confirmed
-- 'host' participant. This inflated the roster attendance count and confused
-- admins/pros who create events they do not plan to attend as players.
--
-- Changes:
--   1. create_event — remove the INSERT into event_participants.
--      The creator remains in events.created_by for audit / ownership purposes.
--   2. cancel_event — replace the host-row ownership check for pros with an
--      events.created_by = auth.uid() check, which works regardless of whether
--      a host participant row exists.
--
-- Apply in Supabase SQL Editor (cloud only).

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. create_event — identical to 0037 except host participant insert removed
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

  -- Phase 21I-D: host participant row removed.
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
-- 2. cancel_event — replace host-row check with events.created_by
--    Preserves all Phase 18A additions from 0049 exactly.
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

  -- Admins can cancel any event.
  -- Pros can cancel only events they created (events.created_by).
  -- Phase 21I-D: replaced host-row ownership check with created_by so that
  -- cancellation works correctly when no host participant row exists.
  if v_profile.role <> 'admin' then
    if v_event.created_by <> auth.uid() then
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

  -- Notify confirmed, waitlisted, and offered participants (Phase 18A: +offered).
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
