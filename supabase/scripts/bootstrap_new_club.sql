-- =============================================================================
-- bootstrap_new_club.sql
-- Phase 13A: Operator script to provision a new club via Supabase SQL Editor.
--
-- HOW TO USE
-- ----------
-- 1. Edit the values in the "EDIT THESE VALUES" section below.
-- 2. Paste the entire script into the Supabase SQL Editor.
-- 3. Run it. The result row contains club_id, slug, invite_code, invite_url.
-- 4. Copy invite_url and send it to the first admin.
--    (Also create their Auth account first — see README_bootstrap_new_club.md)
--
-- BEFORE YOU START
-- ----------------
-- You need your operator UUID (a valid row in auth.users).
-- Find it with:
--   select id, email from auth.users order by created_at;
-- =============================================================================


-- =============================================================================
-- EDIT THESE VALUES
-- =============================================================================
with cfg as (
  select

    -- Club display name (2–80 characters).
    'New Club Name'                     as p_name,

    -- URL-safe slug: lowercase letters, digits, hyphens only.
    -- Must start and end with a letter or digit.
    -- Must be unique across all clubs.
    -- Cannot be changed after creation.
    -- Reserved and rejected: admin, api, auth, join, sign-in, setup,
    --   operator, app, www, mail, help, support, booking, dashboard
    'new-club-slug'                     as p_slug,

    -- IANA timezone name. Common values:
    --   America/New_York    America/Chicago    America/Denver
    --   America/Los_Angeles America/Phoenix    America/Anchorage
    --   America/Honolulu    Europe/London      Europe/Paris
    'America/New_York'                  as p_timezone,

    -- Number of courts to create (1–20).
    -- Courts will be named "Court 1", "Court 2", etc. unless you provide
    -- custom names in p_court_names below.
    2                                   as p_court_count,

    -- Your operator UUID from auth.users.
    -- Replace with the output of:
    --   select id from auth.users where email = 'your@email.com';
    'REPLACE-WITH-YOUR-UUID'::uuid      as p_operator_user_id,

    -- Optional custom court names.
    -- Must be an array with exactly p_court_count elements, e.g.:
    --   array['Clay 1', 'Clay 2']
    -- Set to null to use default names ("Court 1", "Court 2", ...).
    null::text[]                        as p_court_names,

    -- Daily operating hours applied to all 7 days.
    -- Admins can adjust individual days later.
    '08:00'::time                       as p_opens_at,
    '20:00'::time                       as p_closes_at,

    -- How far in advance members can book (1–365 days).
    14                                  as p_booking_window_days,

    -- How many hours before a session members must cancel (0–168).
    24                                  as p_cancellation_window_hours,

    -- Grace period: minutes after booking during which a member can cancel
    -- even if inside the cancellation window (0–60).
    5                                   as p_cancellation_grace_minutes,

    -- Base URL for building the first-admin invite link.
    -- Production: your Vercel deployment URL (no trailing slash).
    -- Local dev:  http://localhost:3000
    'https://court-time.vercel.app'       as app_url

),
-- =============================================================================
-- DO NOT EDIT BELOW THIS LINE
-- =============================================================================
bootstrap as (
  select bootstrap_new_club(
    cfg.p_name,
    cfg.p_slug,
    cfg.p_timezone,
    cfg.p_court_count,
    cfg.p_operator_user_id,
    cfg.p_court_names,
    cfg.p_opens_at,
    cfg.p_closes_at,
    cfg.p_booking_window_days,
    cfg.p_cancellation_window_hours,
    cfg.p_cancellation_grace_minutes
  ) as result,
  cfg.app_url
  from cfg
)
select
  result->>'club_id'                                              as club_id,
  result->>'slug'                                                 as slug,
  result->>'invite_code'                                          as invite_code,
  app_url || '/join/' || (result->>'invite_code')                 as invite_url
from bootstrap;
