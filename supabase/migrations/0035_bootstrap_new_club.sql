-- 0035_bootstrap_new_club.sql
-- Phase 13A: operator-only club bootstrap RPC.
--
-- Creates all rows required for a new club to function:
--   clubs              — 1 row
--   club_settings      — 1 row
--   courts             — p_court_count rows
--   operating_hours    — 7 rows (all days open; create_reservation requires
--                        a row for every day-of-week or raises club_closed_this_day)
--   event_types        — 5 rows (standard keys)
--   club_invites       — 1 first-admin invite (14-day expiry)
--
-- This function is SECURITY DEFINER and restricted to service_role / superuser.
-- Authenticated and anonymous users cannot call it.
-- Intended for operator/manual SQL use only — do not expose to the application.
--
-- Apply in Supabase SQL Editor (cloud only).

-- ---------------------------------------------------------------------------
-- bootstrap_new_club
-- ---------------------------------------------------------------------------
create or replace function bootstrap_new_club(
  p_name                       text,
  p_slug                       text,
  p_timezone                   text,
  p_court_count                int,
  p_operator_user_id           uuid,
  p_court_names                text[]  default null,
  p_opens_at                   time    default '08:00',
  p_closes_at                  time    default '20:00',
  p_booking_window_days        int     default 14,
  p_cancellation_window_hours  int     default 24,
  p_cancellation_grace_minutes int     default 5
)
returns jsonb
language plpgsql security definer as $$
declare
  -- Slugs that collide with existing app routes or reserved paths.
  v_reserved    text[] := array[
    'admin', 'api', 'auth', 'join', 'sign-in', 'setup', 'operator',
    'app', 'www', 'mail', 'help', 'support', 'booking', 'dashboard'
  ];
  v_club        clubs%rowtype;
  v_code        text;
  v_dow         int;
  v_i           int;
  v_court_name  text;
begin
  -- -------------------------------------------------------------------------
  -- Validate p_name
  -- -------------------------------------------------------------------------
  if trim(p_name) is null or char_length(trim(p_name)) < 2 then
    raise exception 'invalid_name: club name must be at least 2 characters';
  end if;

  if char_length(trim(p_name)) > 80 then
    raise exception 'invalid_name: club name must be 80 characters or fewer';
  end if;

  -- -------------------------------------------------------------------------
  -- Validate p_slug format
  -- Allows: a single alphanumeric character, or a string of 2+ characters
  -- that starts and ends with alphanumeric and contains only lowercase
  -- letters, digits, and hyphens in the middle.
  -- -------------------------------------------------------------------------
  if p_slug is null or p_slug = '' then
    raise exception 'invalid_slug: slug is required';
  end if;

  if p_slug !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$' then
    raise exception
      'invalid_slug: slug must contain only lowercase letters, digits, and '
      'hyphens, and must start and end with a letter or digit';
  end if;

  if p_slug = any(v_reserved) then
    raise exception 'invalid_slug: "%" is a reserved slug', p_slug;
  end if;

  -- -------------------------------------------------------------------------
  -- Validate slug uniqueness
  -- -------------------------------------------------------------------------
  if exists (select 1 from clubs where slug = p_slug) then
    raise exception
      'slug_already_exists: a club with slug "%" already exists', p_slug;
  end if;

  -- -------------------------------------------------------------------------
  -- Validate p_court_count
  -- -------------------------------------------------------------------------
  if p_court_count is null or p_court_count < 1 or p_court_count > 20 then
    raise exception 'invalid_court_count: court count must be between 1 and 20';
  end if;

  -- -------------------------------------------------------------------------
  -- Validate p_court_names length when provided
  -- -------------------------------------------------------------------------
  if p_court_names is not null then
    if array_length(p_court_names, 1) is null or
       array_length(p_court_names, 1) <> p_court_count then
      raise exception
        'invalid_court_names: p_court_names must contain exactly % '
        'elements to match p_court_count', p_court_count;
    end if;
  end if;

  -- -------------------------------------------------------------------------
  -- Validate operating hours
  -- -------------------------------------------------------------------------
  if p_closes_at <= p_opens_at then
    raise exception 'invalid_hours: closes_at must be after opens_at';
  end if;

  -- -------------------------------------------------------------------------
  -- Validate booking / cancellation settings
  -- -------------------------------------------------------------------------
  if p_booking_window_days < 1 or p_booking_window_days > 365 then
    raise exception
      'invalid_booking_window: booking_window_days must be between 1 and 365';
  end if;

  if p_cancellation_window_hours < 0 or p_cancellation_window_hours > 168 then
    raise exception
      'invalid_cancellation_window: cancellation_window_hours must be between 0 and 168';
  end if;

  if p_cancellation_grace_minutes < 0 or p_cancellation_grace_minutes > 60 then
    raise exception
      'invalid_grace_period: cancellation_grace_minutes must be between 0 and 60';
  end if;

  -- -------------------------------------------------------------------------
  -- Validate p_operator_user_id
  -- -------------------------------------------------------------------------
  if p_operator_user_id is null then
    raise exception 'invalid_operator_user: p_operator_user_id is required';
  end if;

  if not exists (select 1 from auth.users where id = p_operator_user_id) then
    raise exception
      'invalid_operator_user: user % does not exist in auth.users',
      p_operator_user_id;
  end if;

  -- =========================================================================
  -- All validations passed.
  -- The inserts below run in the caller's transaction — all or nothing.
  -- =========================================================================

  -- -------------------------------------------------------------------------
  -- Insert clubs
  -- -------------------------------------------------------------------------
  insert into clubs (name, slug, timezone, theme_key)
  values (trim(p_name), p_slug, p_timezone, 'classic-gray')
  returning * into v_club;

  -- -------------------------------------------------------------------------
  -- Insert club_settings
  -- -------------------------------------------------------------------------
  insert into club_settings (
    club_id,
    booking_window_days,
    cancellation_window_hours,
    cancellation_grace_minutes
  ) values (
    v_club.id,
    p_booking_window_days,
    p_cancellation_window_hours,
    p_cancellation_grace_minutes
  );

  -- -------------------------------------------------------------------------
  -- Insert courts
  -- display_order is 0-based, matching the convention in add_court().
  -- -------------------------------------------------------------------------
  for v_i in 1..p_court_count loop
    if p_court_names is not null then
      v_court_name := p_court_names[v_i];
    else
      v_court_name := 'Court ' || v_i::text;
    end if;

    insert into courts (club_id, name, display_order, is_active)
    values (v_club.id, v_court_name, v_i - 1, true);
  end loop;

  -- -------------------------------------------------------------------------
  -- Insert operating_hours — all 7 days open.
  -- create_reservation raises club_closed_this_day for any day-of-week row
  -- that is missing, not only for rows where is_closed = true.
  -- All days open by default; a future operating hours editor can close days.
  -- -------------------------------------------------------------------------
  for v_dow in 0..6 loop
    insert into operating_hours (club_id, day_of_week, opens_at, closes_at, is_closed)
    values (v_club.id, v_dow, p_opens_at, p_closes_at, false);
  end loop;

  -- -------------------------------------------------------------------------
  -- Insert event_types — 5 standard keys.
  --
  -- Column mapping from the plan spec:
  --   member_can_join → shows_participant_names
  --   (display_order is not a column on event_types; the app queries by key)
  --
  -- default_court_count values match the pilot club seed:
  --   lesson=1, clinic=1, social=2, league=1, tournament=4
  -- -------------------------------------------------------------------------
  insert into event_types (
    club_id, key, label, color,
    default_capacity, default_duration_minutes, default_court_count,
    shows_participant_names
  ) values
    (v_club.id, 'lesson',     'Private Lesson', '#3B7DD8',  1,  60, 1, false),
    (v_club.id, 'clinic',     'Group Clinic',   '#2E9B5E',  8,  90, 1, false),
    (v_club.id, 'social',     'Open Social',    '#E68433', 12, 120, 2, true),
    (v_club.id, 'league',     'League Match',   '#7B4FB5',  4,  90, 1, true),
    (v_club.id, 'tournament', 'Tournament',     '#C44545', 32, 240, 4, true);

  -- -------------------------------------------------------------------------
  -- Insert first admin invite.
  -- email = null means any email address may accept.
  -- expires_at = 14 days (double the default) to allow for delivery delays.
  -- created_by = p_operator_user_id satisfies the FK to auth.users without
  -- making the column nullable or introducing a fake UUID.
  -- -------------------------------------------------------------------------
  insert into club_invites (club_id, role, email, created_by, expires_at)
  values (v_club.id, 'admin', null, p_operator_user_id, now() + interval '14 days')
  returning code into v_code;

  -- -------------------------------------------------------------------------
  -- Return result
  -- -------------------------------------------------------------------------
  return jsonb_build_object(
    'club_id',     v_club.id,
    'slug',        v_club.slug,
    'invite_code', v_code
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Restrict to service_role / superuser only.
--
-- PostgreSQL grants EXECUTE to PUBLIC by default on all new functions.
-- Revoking from PUBLIC removes that default grant for anon and authenticated
-- PostgREST callers. The postgres superuser retains access unconditionally
-- (superusers bypass privilege checks) — SQL Editor testing is unaffected.
-- service_role is granted explicitly for Phase 13B's server-side operator page.
-- ---------------------------------------------------------------------------
revoke execute
  on function bootstrap_new_club(text, text, text, int, uuid, text[], time, time, int, int, int)
  from public;

grant execute
  on function bootstrap_new_club(text, text, text, int, uuid, text[], time, time, int, int, int)
  to service_role;
