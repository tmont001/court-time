-- 0053_create_reservation_duration_check.sql
-- Phase 20D-B: restrict member court reservations to supported durations.
--
-- This migration resolves Issue #5 from Phase 20B QA. Member court reservations
-- must be exactly 30, 60, 90, or 120 minutes. Any other duration — including
-- arbitrary values such as 45 minutes or anything exceeding 120 minutes — is
-- rejected with the existing 'invalid_duration' exception code.
--
-- This is a full reproduction of the function body from
-- 0047_create_reservation_override_check.sql (the latest version) with one
-- addition only: a permitted-duration check inserted after the existing
-- positive-duration guard and before the operating-hours checks.
--
-- Admin/pro event creation (create_event RPC and CreateEventSheet) is
-- unaffected — events such as clinics, lessons, and tournament blocks may
-- use durations beyond 120 minutes.
--
-- All existing logic is preserved unchanged:
--   - authentication and active-member enforcement
--   - court/club validity
--   - booking-window check
--   - operating-hours override check (Phase 17A)
--   - weekly operating-hours fallback
--   - overlap protection (GiST constraint on insert)
--   - reservation creation
--   - preference-gated reservation_confirmed notification (Phase 16F)
--
-- Reuses existing error codes only. No new tables, columns, or policies.
-- Apply in Supabase SQL Editor (cloud only) before testing the UI changes.

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
  v_date     date;                             -- Phase 17A: local booking date
  v_override operating_hours_override%rowtype; -- Phase 17A: date-specific override
  v_dow      int;
  v_hours    operating_hours%rowtype;
  v_result   reservations%rowtype;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_profile.status <> 'active' then raise exception 'account_inactive'; end if;

  select * into v_court
    from courts
    where id        = p_court_id
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

  -- Phase 20D-B: member court reservations must use one of the supported durations.
  if extract(epoch from (p_ends_at - p_starts_at)) / 60 not in (30, 60, 90, 120) then
    raise exception 'invalid_duration';
  end if;

  -- ---------------------------------------------------------------------------
  -- Phase 17A: check for a date-specific override before falling back to the
  -- weekly operating_hours. The override lookup uses the club-local calendar
  -- date (v_date) derived from the booking's starts_at timestamp.
  -- ---------------------------------------------------------------------------
  v_date := (p_starts_at at time zone v_tz)::date;
  v_dow  := extract(dow from p_starts_at at time zone v_tz)::int;

  select * into v_override
    from operating_hours_override
    where club_id       = v_profile.club_id
      and override_date = v_date;

  if found then
    -- An override exists for this date — it takes priority over weekly hours.
    if v_override.is_closed then
      raise exception 'club_closed_this_day';
    end if;
    -- When special hours are set, reject bookings that fall outside them.
    if v_override.opens_at is not null and v_override.closes_at is not null then
      if (p_starts_at at time zone v_tz)::time < v_override.opens_at
         or (p_ends_at at time zone v_tz)::time > v_override.closes_at then
        raise exception 'outside_operating_hours';
      end if;
    end if;
    -- Override exists and booking is within bounds; skip the weekly check below.
  else
    -- No override for this date — apply normal weekly operating_hours.
    select * into v_hours
      from operating_hours
      where club_id     = v_profile.club_id
        and day_of_week = v_dow;

    if not found or v_hours.is_closed then
      raise exception 'club_closed_this_day';
    end if;

    if (p_starts_at at time zone v_tz)::time < v_hours.opens_at
       or (p_ends_at at time zone v_tz)::time > v_hours.closes_at then
      raise exception 'outside_operating_hours';
    end if;
  end if;
  -- ---------------------------------------------------------------------------

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

  -- Phase 16F: only insert the in-app notification if the member has this kind enabled.
  if user_pref_enabled(auth.uid(), 'reservation_confirmed') then
    insert into notifications (club_id, user_id, kind, body, metadata)
    values (
      v_profile.club_id,
      auth.uid(),
      'reservation_confirmed',
      v_court.name || ' booked for '
        || to_char(p_starts_at at time zone v_tz, 'Mon DD "at" HH12:MI AM'),
      jsonb_build_object('reservation_id', v_result.id, 'court_id', p_court_id)
    );
  end if;

  return v_result;
end;
$$;
