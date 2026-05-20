-- 0021_leave_event_returns_promoted.sql
-- Phase 8F: change leave_event return type from void to uuid.
-- Returns the promoted participant's profile_id when waitlist auto-promotion
-- occurs, or null when no promotion happens.
-- Existing callers that ignore the return value are unaffected.
-- All leave/cancel/promotion logic is identical to 0015_waitlist_rpcs.sql.
-- Apply in Supabase SQL Editor (cloud only).

drop function if exists leave_event(uuid);

create function leave_event(p_event_id uuid)
returns uuid   -- promoted profile_id, or null if no promotion occurred
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

        return v_next_profile;
      end if;
    end if;
  end if;

  return null;
end;
$$;
