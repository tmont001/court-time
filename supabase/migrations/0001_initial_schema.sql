-- 0001_initial_schema.sql
-- Phase 1 tables: clubs, club_settings, profiles, courts,
-- operating_hours, operating_hours_override, event_types

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------
create extension if not exists "uuid-ossp";

-- ---------------------------------------------------------------------------
-- updated_at trigger helper
-- ---------------------------------------------------------------------------
create or replace function trigger_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- clubs
-- ---------------------------------------------------------------------------
create table clubs (
  id          uuid primary key default uuid_generate_v4(),
  name        text not null,
  slug        text not null unique,
  timezone    text not null default 'America/New_York',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger clubs_updated_at
  before update on clubs
  for each row execute function trigger_set_updated_at();

-- ---------------------------------------------------------------------------
-- club_settings
-- ---------------------------------------------------------------------------
create table club_settings (
  id                        uuid primary key default uuid_generate_v4(),
  club_id                   uuid not null references clubs(id) on delete cascade,
  booking_window_days       int  not null default 14,
  cancellation_window_hours int  not null default 24,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  unique (club_id)
);

create trigger club_settings_updated_at
  before update on club_settings
  for each row execute function trigger_set_updated_at();

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
create table profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  club_id     uuid not null references clubs(id),
  first_name  text,
  last_name   text,
  phone       text,
  role        text not null default 'member'
                check (role in ('member', 'pro', 'admin')),
  status      text not null default 'active'
                check (status in ('active', 'inactive', 'suspended')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger profiles_updated_at
  before update on profiles
  for each row execute function trigger_set_updated_at();

-- ---------------------------------------------------------------------------
-- on_auth_user_created — auto-create profile row
-- ---------------------------------------------------------------------------
-- The club_id is hardcoded to the single seeded club for Phase 1.
-- A future migration will replace this with multi-club lookup logic.
create or replace function handle_new_user()
returns trigger language plpgsql security definer as $$
declare
  v_club_id uuid;
begin
  select id into v_club_id from clubs where slug = 'riverside' limit 1;

  insert into profiles (id, club_id, role, status)
  values (new.id, v_club_id, 'member', 'active');

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ---------------------------------------------------------------------------
-- courts
-- ---------------------------------------------------------------------------
create table courts (
  id            uuid primary key default uuid_generate_v4(),
  club_id       uuid not null references clubs(id) on delete cascade,
  name          text not null,
  display_order int  not null default 0,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create trigger courts_updated_at
  before update on courts
  for each row execute function trigger_set_updated_at();

-- ---------------------------------------------------------------------------
-- operating_hours
-- ---------------------------------------------------------------------------
create table operating_hours (
  id          uuid primary key default uuid_generate_v4(),
  club_id     uuid not null references clubs(id) on delete cascade,
  day_of_week int  not null check (day_of_week between 0 and 6), -- 0 = Sunday
  opens_at    time not null,
  closes_at   time not null,
  is_closed   boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  unique (club_id, day_of_week)
);

create trigger operating_hours_updated_at
  before update on operating_hours
  for each row execute function trigger_set_updated_at();

-- ---------------------------------------------------------------------------
-- operating_hours_override
-- ---------------------------------------------------------------------------
create table operating_hours_override (
  id          uuid primary key default uuid_generate_v4(),
  club_id     uuid not null references clubs(id) on delete cascade,
  override_date date not null,
  opens_at    time,
  closes_at   time,
  is_closed   boolean not null default false,
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  unique (club_id, override_date)
);

create trigger operating_hours_override_updated_at
  before update on operating_hours_override
  for each row execute function trigger_set_updated_at();

-- ---------------------------------------------------------------------------
-- event_types
-- ---------------------------------------------------------------------------
create table event_types (
  id                       uuid primary key default uuid_generate_v4(),
  club_id                  uuid not null references clubs(id) on delete cascade,
  key                      text not null
                             check (key in ('lesson','clinic','social','league','tournament')),
  label                    text not null,
  color                    text not null,
  default_capacity         int  not null,
  default_duration_minutes int  not null,
  default_court_count      int  not null,
  shows_participant_names  boolean not null default false,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  unique (club_id, key)
);

create trigger event_types_updated_at
  before update on event_types
  for each row execute function trigger_set_updated_at();
