-- 0004_events.sql
-- Phase 3A tables: events, event_participants; RPCs: create_event, join_event, leave_event
-- Idempotent — safe to rerun after a partial failure.
-- Apply in Supabase SQL Editor (cloud only).

-- ---------------------------------------------------------------------------
-- Extend reservations.reason to include 'event'
-- ---------------------------------------------------------------------------
alter table reservations drop constraint if exists reservations_reason_check;
alter table reservations add constraint reservations_reason_check
  check (reason in ('member_booking','maintenance','admin_block','event'));

-- ---------------------------------------------------------------------------
-- events
-- ---------------------------------------------------------------------------
create table if not exists events (
  id            uuid        primary key default uuid_generate_v4(),
  club_id       uuid        not null references clubs(id) on delete cascade,
  event_type_id uuid        not null references event_types(id),
  title         text        not null,
  description   text,
  starts_at     timestamptz not null,
  ends_at       timestamptz not null,
  capacity      int         not null,
  court_count   int         not null,
  status        text        not null default 'scheduled'
                              check (status in ('scheduled', 'cancelled')),
  created_by    uuid        not null references profiles(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint events_ends_after_starts check (ends_at > starts_at)
);

-- Allow the test seed SQL (direct insert) to omit court_count; RPC always sets it.
alter table events alter column court_count set default 1;

create or replace trigger events_updated_at
  before update on events
  for each row execute function trigger_set_updated_at();

create index if not exists events_club_starts_at_idx on events (club_id, starts_at);

-- ---------------------------------------------------------------------------
-- event_participants
-- ---------------------------------------------------------------------------
create table if not exists event_participants (
  id         uuid        primary key default uuid_generate_v4(),
  event_id   uuid        not null references events(id) on delete cascade,
  profile_id uuid        not null references profiles(id),
  role       text        not null default 'participant'
                           check (role in ('host', 'participant')),
  status     text        not null default 'confirmed'
                           check (status in ('confirmed', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (event_id, profile_id)
);

create or replace trigger event_participants_updated_at
  before update on event_participants
  for each row execute function trigger_set_updated_at();

-- ---------------------------------------------------------------------------
-- Wire reservations.event_id → events
-- (The column already exists as nullable with no FK from Phase 2.)
-- ---------------------------------------------------------------------------
do $$ begin
  alter table reservations
    add constraint reservations_event_id_fkey
      foreign key (event_id) references events(id) on delete set null;
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- RLS — events
-- ---------------------------------------------------------------------------
alter table events enable row level security;

drop policy if exists "events_select_same_club" on events;
create policy "events_select_same_club"
  on events for select
  using (club_id = current_user_club_id());

drop policy if exists "events_insert_pro_admin" on events;
create policy "events_insert_pro_admin"
  on events for insert
  with check (
    club_id = current_user_club_id()
    and current_user_role() in ('pro', 'admin')
  );

-- ---------------------------------------------------------------------------
-- RLS — event_participants
-- ---------------------------------------------------------------------------
alter table event_participants enable row level security;

drop policy if exists "event_participants_select_same_club" on event_participants;
create policy "event_participants_select_same_club"
  on event_participants for select
  using (
    exists (
      select 1 from events
      where events.id        = event_participants.event_id
        and events.club_id   = current_user_club_id()
    )
  );

drop policy if exists "event_participants_insert_own" on event_participants;
create policy "event_participants_insert_own"
  on event_participants for insert
  with check (
    profile_id = auth.uid()
    and exists (
      select 1 from events
      where events.id      = event_participants.event_id
        and events.club_id = current_user_club_id()
        and events.status  = 'scheduled'
    )
  );

drop policy if exists "event_participants_cancel_own" on event_participants;
create policy "event_participants_cancel_own"
  on event_participants for update
  using  (profile_id = auth.uid())
  with check (
    status     = 'cancelled'
    and profile_id = auth.uid()
  );

-- ---------------------------------------------------------------------------
-- create_event RPC
-- Required params first; optional/defaulted params last.
-- Pro/admin only. Creates the event, host participant, and court reservations.
-- ---------------------------------------------------------------------------
create or replace function create_event(
  p_event_type_id uuid,
  p_title          text,
  p_starts_at      timestamptz,
  p_ends_at        timestamptz,
  p_court_ids      uuid[],
  p_description    text  default null,
  p_capacity       int   default null,
  p_notes          text  default null
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
  if v_profile.role not in ('pro', 'admin') then
    raise exception 'insufficient_role';
  end if;

  if p_ends_at <= p_starts_at then raise exception 'invalid_duration'; end if;

  select * into v_et
    from event_types
    where id = p_event_type_id and club_id = v_profile.club_id;
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

  insert into event_participants (event_id, profile_id, role, status)
  values (v_event.id, auth.uid(), 'host', 'confirmed');

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

-- ---------------------------------------------------------------------------
-- join_event RPC
-- Any member. Adds the caller as a confirmed participant.
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

  select count(*) into v_count
    from event_participants
    where event_id = p_event_id and status = 'confirmed';
  if v_count >= v_event.capacity then raise exception 'event_full'; end if;

  if exists (
    select 1 from event_participants
    where event_id   = p_event_id
      and profile_id = auth.uid()
      and status     = 'confirmed'
  ) then raise exception 'already_joined'; end if;

  insert into event_participants (event_id, profile_id, role, status)
  values (p_event_id, auth.uid(), 'participant', 'confirmed')
  on conflict (event_id, profile_id)
    do update set status = 'confirmed', updated_at = now()
  returning * into v_result;

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- leave_event RPC
-- Cancels the caller's participation. Does not affect court reservations.
-- ---------------------------------------------------------------------------
create or replace function leave_event(p_event_id uuid)
returns void
language plpgsql security definer as $$
declare
  v_profile profiles%rowtype;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  update event_participants
    set status = 'cancelled', updated_at = now()
    where event_id   = p_event_id
      and profile_id = auth.uid()
      and status     = 'confirmed';
end;
$$;
