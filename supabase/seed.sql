-- seed.sql
-- Run after applying both migrations.
-- Do NOT create users here — use the Supabase Auth dashboard instead.

-- ---------------------------------------------------------------------------
-- Club
-- ---------------------------------------------------------------------------
insert into clubs (id, name, slug, timezone)
values (
  'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  'Riverside Tennis Club',
  'riverside',
  'America/New_York'
)
on conflict (slug) do nothing;

-- ---------------------------------------------------------------------------
-- Club settings
-- ---------------------------------------------------------------------------
insert into club_settings (club_id, booking_window_days, cancellation_window_hours)
values (
  'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  14,
  24
)
on conflict (club_id) do nothing;

-- ---------------------------------------------------------------------------
-- Courts (5 courts, display_order 1–5, all active)
-- ---------------------------------------------------------------------------
insert into courts (club_id, name, display_order, is_active) values
  ('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'Court 1', 1, true),
  ('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'Court 2', 2, true),
  ('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'Court 3', 3, true),
  ('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'Court 4', 4, true),
  ('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'Court 5', 5, true);

-- ---------------------------------------------------------------------------
-- Operating hours (Sun–Sat, 08:00–19:00, all open)
-- day_of_week: 0 = Sunday … 6 = Saturday
-- ---------------------------------------------------------------------------
insert into operating_hours (club_id, day_of_week, opens_at, closes_at, is_closed) values
  ('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 0, '08:00', '19:00', false),
  ('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 1, '08:00', '19:00', false),
  ('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 2, '08:00', '19:00', false),
  ('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 3, '08:00', '19:00', false),
  ('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 4, '08:00', '19:00', false),
  ('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 5, '08:00', '19:00', false),
  ('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 6, '08:00', '19:00', false);

-- ---------------------------------------------------------------------------
-- Event types
-- All configurable defaults live ONLY here, not in application code.
-- ---------------------------------------------------------------------------
insert into event_types
  (club_id, key, label, color, default_capacity, default_duration_minutes, default_court_count, shows_participant_names)
values
  ('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'lesson',     'Private Lesson', '#3B7DD8',  1,  60, 1, false),
  ('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'clinic',     'Group Clinic',   '#2E9B5E',  8,  90, 1, false),
  ('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'social',     'Open Social',    '#E68433', 12, 120, 2, true),
  ('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'league',     'League Match',   '#7B4FB5',  4,  90, 1, true),
  ('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'tournament', 'Tournament',     '#C44545', 32, 240, 4, true)
on conflict (club_id, key) do nothing;
