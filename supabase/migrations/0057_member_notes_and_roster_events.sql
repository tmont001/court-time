-- 0057_member_notes_and_roster_events.sql
-- Phase 21I-C-A: admin notes on profiles + roster members in events.
-- Additive only — no existing columns, constraints, or RLS altered.
-- Apply in Supabase SQL Editor (cloud only).

-- ═══════════════════════════════════════════════════════════════════════════
-- Part 1 — Admin notes on signed-in members
-- ═══════════════════════════════════════════════════════════════════════════

-- 1a. Add column (idempotent)
alter table profiles add column if not exists admin_notes text;

-- 1b. set_member_notes — admin-only RPC following set_member_role pattern
create or replace function set_member_notes(
  p_target_user_id uuid,
  p_notes          text
)
returns void
language plpgsql security definer as $$
declare
  v_actor  profiles%rowtype;
  v_target profiles%rowtype;
  v_notes  text;
begin
  -- 1. Load actor.
  select * into v_actor from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  -- 2. Admin only.
  if v_actor.role <> 'admin' then raise exception 'insufficient_role'; end if;

  -- 3. Load target, scoped to actor's club.
  select * into v_target
    from profiles
   where id      = p_target_user_id
     and club_id = v_actor.club_id;
  if not found then raise exception 'user_not_found'; end if;

  -- 4. Normalise.
  v_notes := nullif(btrim(coalesce(p_notes, '')), '');

  -- 5. Update.
  update profiles
     set admin_notes = v_notes,
         updated_at  = now()
   where id = p_target_user_id;

  -- 6. Audit.
  insert into audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_actor.club_id,
    auth.uid(),
    'set_member_notes',
    'profile',
    p_target_user_id,
    jsonb_build_object('notes', v_notes)
  );
end;
$$;

-- 1c. Update get_members to return admin_notes
-- DROP required because adding a return column changes the OUT parameter row type.
-- Preserves all existing columns and sort order from 0011.
drop function if exists get_members();
create or replace function get_members()
returns table (
  id          uuid,
  first_name  text,
  last_name   text,
  phone       text,
  role        text,
  status      text,
  created_at  timestamptz,
  email       text,
  admin_notes text
)
language plpgsql security definer as $$
declare
  v_profile profiles%rowtype;
begin
  select pr.* into v_profile from profiles pr where pr.id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.role <> 'admin' then raise exception 'insufficient_role'; end if;

  return query
    select
      p.id          as id,
      p.first_name  as first_name,
      p.last_name   as last_name,
      p.phone       as phone,
      p.role        as role,
      p.status      as status,
      p.created_at  as created_at,
      u.email::text as email,
      p.admin_notes as admin_notes
    from profiles p
    left join auth.users u on u.id = p.id
    where p.club_id = v_profile.club_id
    order by p.last_name asc nulls last, p.first_name asc nulls last;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Part 2 — Roster members in events (via event_guests)
-- ═══════════════════════════════════════════════════════════════════════════

-- 2a. Add column + index (idempotent)
alter table event_guests
  add column if not exists roster_member_id uuid references roster_members(id) on delete set null;

create unique index if not exists event_guests_roster_member_uniq
  on event_guests (event_id, roster_member_id)
  where roster_member_id is not null;

-- 2b. admin_add_roster_member_to_event
-- Follows admin_add_guest pattern from 0051. Inserts an event_guests row
-- linked to a roster_member. Always occupies a capacity slot.
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

-- 2c. Update get_event_roster to return roster_member_id
-- DROP required because adding a return column changes the OUT parameter row type.
-- Preserves all existing columns, sort order, and auth logic from 0050.
-- Adds roster_member_id as the 8th return column.
drop function if exists get_event_roster(uuid);
create or replace function get_event_roster(p_event_id uuid)
returns table (
  profile_id        uuid,
  display_name      text,
  role              text,
  status            text,
  attendance_status text,
  offer_expires_at  timestamptz,
  waitlist_position int,
  roster_member_id  uuid
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
        null::uuid                                                    as roster_member_id,
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
    guest_rows as (
      select
        eg.id             as profile_id,
        eg.display_name::text,
        'guest'::text     as role,
        'confirmed'::text as status,
        null::text        as attendance_status,
        null::timestamptz as offer_expires_at,
        null::int         as waitlist_position,
        eg.roster_member_id,
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
      c.waitlist_position,
      c.roster_member_id
    from (
      select * from member_rows
      union all
      select * from guest_rows
    ) c
    order by c.sort_group, c.created_at asc;
end;
$$;
