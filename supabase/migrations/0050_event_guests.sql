-- 0050_event_guests.sql
-- Phase 19A: Guest data model + capacity update.
-- Requires 0049_waitlist_offer_rpcs.sql to be applied first.
--
-- Changes in this migration (in dependency order):
--   1. event_guests table   — stores admin-added non-member guests
--   2. RLS on event_guests  — SELECT for club members; writes via RPCs only
--   3. get_event_roster     — UNION ALL guests (role='guest', sort group 4)
--   4. join_event           — capacity check includes event_guests count
--   5. advance_waitlist_offer — capacity check includes event_guests count
--
-- Apply in Supabase SQL Editor (cloud only).

-- ===========================================================================
-- 1. event_guests table
-- Stores non-member guests added by an admin to an event. Guests always
-- occupy a capacity slot (treated as confirmed) and have no waitlist or offer
-- state. Contact info is deferred to a later phase; v1 is name-only.
-- ===========================================================================
create table event_guests (
  id           uuid        primary key default uuid_generate_v4(),
  event_id     uuid        not null references events(id) on delete cascade,
  display_name text        not null check (char_length(trim(display_name)) >= 1),
  added_by     uuid        not null references profiles(id),
  created_at   timestamptz not null default now()
);

-- ===========================================================================
-- 2. RLS on event_guests
-- SELECT: any authenticated user whose profile belongs to the same club as
--   the event. Needed so member-facing pages can include guests in capacity
--   display without an extra admin-only query.
-- INSERT / UPDATE / DELETE: withheld from RLS. All writes are handled
--   exclusively by security-definer RPCs added in Phase 19B.
-- ===========================================================================
alter table event_guests enable row level security;

create policy "event_guests_select_club_members"
  on event_guests
  for select
  to authenticated
  using (
    exists (
      select 1
        from profiles p
        join events   e on e.id = event_guests.event_id
       where p.id      = auth.uid()
         and p.club_id = e.club_id
    )
  );

-- ===========================================================================
-- 3. get_event_roster
-- Replaces the Phase 18A version from 0049_waitlist_offer_rpcs.sql.
-- Return shape is unchanged (same seven columns); only the query body
-- changes to UNION ALL guests into the result after member rows.
--
-- Guest rows:
--   profile_id = event_guests.id  (the guest's own UUID, not a profiles FK)
--   role       = 'guest'          (callers must guard before joining profiles)
--   status     = 'confirmed'      (guests always hold a slot)
--   attendance_status, offer_expires_at, waitlist_position = null
--
-- Sort order: confirmed (1) → offered (2) → waitlisted (3) → guest (4).
-- Within each group, rows are ordered by created_at asc (FIFO).
--
-- No DROP needed: RETURNS TABLE definition is unchanged from Phase 18A.
-- ===========================================================================
create or replace function get_event_roster(p_event_id uuid)
returns table (
  profile_id        uuid,
  display_name      text,
  role              text,
  status            text,
  attendance_status text,
  offer_expires_at  timestamptz,
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
      -- Phase 18A: window function assigns 1-based position within each status
      -- group for FIFO ordering; used below for waitlist_position.
      select
        ep.profile_id,
        ep.role,
        ep.status,
        ep.attendance_status,
        ep.offer_expires_at,
        ep.created_at,
        row_number() over (
          partition by ep.status
          order by ep.created_at asc
        ) as pos
      from event_participants ep
      where ep.event_id = p_event_id
        and ep.status   in ('confirmed', 'waitlisted', 'offered')
    ),
    member_rows as (
      select
        r.profile_id,
        coalesce(
          nullif(trim(concat_ws(' ', p.first_name, p.last_name)), ''),
          'Unknown'
        )::text                                                       as display_name,
        r.role::text,
        r.status::text,
        r.attendance_status::text,
        r.offer_expires_at,
        case when r.status = 'waitlisted' then r.pos::int else null end
                                                                      as waitlist_position,
        -- Sort group drives the section order in the UI.
        case r.status
          when 'confirmed'  then 1
          when 'offered'    then 2
          when 'waitlisted' then 3
          else 4
        end                                                           as sort_group,
        r.created_at
      from ranked r
      left join profiles p on p.id = r.profile_id
    ),
    -- Phase 19A: guests are unioned after members with sort group 4.
    guest_rows as (
      select
        eg.id             as profile_id,
        eg.display_name::text,
        'guest'::text     as role,
        'confirmed'::text as status,
        null::text        as attendance_status,
        null::timestamptz as offer_expires_at,
        null::int         as waitlist_position,
        4                 as sort_group,
        eg.created_at
      from event_guests eg
      where eg.event_id = p_event_id
    )
    select
      c.profile_id,
      c.display_name,
      c.role,
      c.status,
      c.attendance_status,
      c.offer_expires_at,
      c.waitlist_position
    from (
      select * from member_rows
      union all
      select * from guest_rows
    ) c
    order by c.sort_group, c.created_at asc;
end;
$$;

-- ===========================================================================
-- 4. join_event
-- Replaces the Phase 18A version from 0049_waitlist_offer_rpcs.sql.
-- All prior behavior is preserved exactly.
-- Single change: the capacity count now adds the event_guests row count so
-- guests occupy capacity slots and affect member join/waitlist routing.
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

-- ===========================================================================
-- 5. advance_waitlist_offer
-- Replaces the Phase 18A version from 0049_waitlist_offer_rpcs.sql.
-- All prior behavior is preserved exactly.
-- Single change: the capacity guard now adds the event_guests row count so
-- an event filled by guests (or a mix of members and guests) correctly
-- declines to advance the waitlist when there is no real vacancy.
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
  -- Phase 18A: offered rows count the same as confirmed against capacity.
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
    into v_slot_count;

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
      'event_id',         p_event_id,
      'offer_expires_at', v_offer_expires_at
    )
  );

  return v_next_profile;
end;
$$;
