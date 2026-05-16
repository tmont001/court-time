-- 0003_reservations.sql
-- Phase 2 tables: reservations
-- Apply in Supabase SQL Editor (cloud only).

-- ---------------------------------------------------------------------------
-- btree_gist — required for the EXCLUDE constraint combining uuid equality
-- and tstzrange overlap in a single GiST index
-- ---------------------------------------------------------------------------
create extension if not exists btree_gist;

-- ---------------------------------------------------------------------------
-- reservations
-- ---------------------------------------------------------------------------
create table reservations (
  id                uuid        primary key default uuid_generate_v4(),
  club_id           uuid        not null references clubs(id) on delete cascade,
  court_id          uuid        not null references courts(id) on delete cascade,
  owner_user_id     uuid        not null references profiles(id),
  starts_at         timestamptz not null,
  ends_at           timestamptz not null,
  status            text        not null default 'confirmed'
                                  check (status in ('pending','confirmed','cancelled')),
  reason            text        not null default 'member_booking'
                                  check (reason in ('member_booking','maintenance','admin_block')),
  player_count      int,
  format            text        check (format in ('singles','doubles')),
  guest_names       text[],
  notes             text,
  event_id          uuid,                          -- nullable, no FK; to be constrained in future event migration
  created_by        uuid        not null references profiles(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  cancelled_at      timestamptz,
  cancelled_by      uuid        references profiles(id),
  cancellation_kind text        check (cancellation_kind in ('member','admin','system')),

  constraint reservations_ends_after_starts
    check (ends_at > starts_at),

  -- Prevent overlapping pending/confirmed reservations on the same court.
  -- tstzrange '[)' = inclusive start, exclusive end: back-to-back slots do not conflict.
  -- Cancelled rows are excluded from the constraint via the WHERE clause.
  exclude using gist (
    court_id with =,
    tstzrange(starts_at, ends_at, '[)') with &&
  ) where (status in ('pending','confirmed'))
);

create trigger reservations_updated_at
  before update on reservations
  for each row execute function trigger_set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table reservations enable row level security;

-- Members see all reservations at their club (needed to render the calendar).
create policy "reservations_select_same_club"
  on reservations for select
  using (club_id = current_user_club_id());

-- Members may insert their own member_booking rows.
-- create_reservation RPC enforces operating hours and booking window on top.
create policy "reservations_insert_own"
  on reservations for insert
  with check (
    owner_user_id = auth.uid()
    and created_by   = auth.uid()
    and reason       = 'member_booking'
    and club_id      = current_user_club_id()
  );

-- Members may cancel only their own reservations.
create policy "reservations_cancel_own"
  on reservations for update
  using  (owner_user_id = auth.uid())
  with check (
    status            = 'cancelled'
    and cancelled_by  = auth.uid()
    and cancellation_kind = 'member'
    and owner_user_id = auth.uid()
  );

-- ---------------------------------------------------------------------------
-- create_reservation RPC
-- Validates operating hours and booking window, then inserts.
-- security definer so it can read club_settings and operating_hours freely.
-- ---------------------------------------------------------------------------
create or replace function create_reservation(
  p_court_id     uuid,
  p_starts_at    timestamptz,
  p_ends_at      timestamptz,
  p_format       text    default null,
  p_player_count int     default null,
  p_guest_names  text[]  default null,
  p_notes        text    default null
)
returns reservations
language plpgsql security definer as $$
declare
  v_profile  profiles%rowtype;
  v_settings club_settings%rowtype;
  v_court    courts%rowtype;
  v_tz       text;
  v_dow      int;
  v_hours    operating_hours%rowtype;
  v_result   reservations%rowtype;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  select * into v_court
    from courts
    where id = p_court_id
      and club_id   = v_profile.club_id
      and is_active = true;
  if not found then raise exception 'court_not_found'; end if;

  select * into v_settings from club_settings where club_id = v_profile.club_id;

  select timezone into v_tz from clubs where id = v_profile.club_id;

  if p_starts_at < now() then
    raise exception 'cannot_book_past';
  end if;

  if p_starts_at > now() + (v_settings.booking_window_days || ' days')::interval then
    raise exception 'outside_booking_window';
  end if;

  if p_ends_at <= p_starts_at then
    raise exception 'invalid_duration';
  end if;

  v_dow := extract(dow from p_starts_at at time zone v_tz)::int;

  select * into v_hours
    from operating_hours
    where club_id    = v_profile.club_id
      and day_of_week = v_dow;

  if not found or v_hours.is_closed then
    raise exception 'club_closed_this_day';
  end if;

  if (p_starts_at at time zone v_tz)::time < v_hours.opens_at
     or (p_ends_at at time zone v_tz)::time > v_hours.closes_at then
    raise exception 'outside_operating_hours';
  end if;

  insert into reservations (
    club_id, court_id, owner_user_id,
    starts_at, ends_at, status, reason,
    format, player_count, guest_names, notes, created_by
  ) values (
    v_profile.club_id, p_court_id, auth.uid(),
    p_starts_at, p_ends_at, 'confirmed', 'member_booking',
    p_format, p_player_count, p_guest_names, p_notes, auth.uid()
  )
  returning * into v_result;

  return v_result;
end;
$$;
