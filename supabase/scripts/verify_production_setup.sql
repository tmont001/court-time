-- verify_production_setup.sql
-- Phase 20A: Production readiness verification.
-- Run in the Supabase SQL Editor against the production project.
-- Safe to run multiple times — no data is mutated.
--
-- How to use:
--   1. Open your Supabase project → SQL Editor.
--   2. Paste this entire file and run it.
--   3. Review each result set. Any MISSING or FALSE entries need action.
--   4. Fix identified gaps, then re-run until all checks pass.
-- ─────────────────────────────────────────────────────────────────────────────


-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. REQUIRED TABLES
-- Expected: 16 rows, one per table.
-- Missing tables will appear in the MISSING TABLES check below instead.
-- ═══════════════════════════════════════════════════════════════════════════════
select table_name, 'EXISTS' as status
from information_schema.tables
where table_schema = 'public'
  and table_name in (
    'clubs',
    'profiles',
    'courts',
    'reservations',
    'events',
    'event_participants',
    'event_guests',
    'notifications',
    'notification_deliveries',
    'notification_preferences',
    'audit_log',
    'club_invites',
    'club_settings',
    'operating_hours',
    'operating_hours_override',
    'event_types'
  )
order by table_name;


-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. MISSING TABLES
-- Expected: 0 rows.
-- Any row here is a table that does not exist — a blocking gap.
-- ═══════════════════════════════════════════════════════════════════════════════
select expected.table_name as missing_table
from (values
  ('clubs'),
  ('profiles'),
  ('courts'),
  ('reservations'),
  ('events'),
  ('event_participants'),
  ('event_guests'),
  ('notifications'),
  ('notification_deliveries'),
  ('notification_preferences'),
  ('audit_log'),
  ('club_invites'),
  ('club_settings'),
  ('operating_hours'),
  ('operating_hours_override'),
  ('event_types')
) as expected(table_name)
left join information_schema.tables ist
  on ist.table_schema = 'public'
  and ist.table_name  = expected.table_name
where ist.table_name is null;


-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. REQUIRED COLUMNS
-- Expected: 6 rows — one per column listed.
-- Any missing row means a migration was not applied.
-- ═══════════════════════════════════════════════════════════════════════════════
select table_name, column_name, data_type
from information_schema.columns
where (table_schema, table_name, column_name) in (
  ('public', 'event_participants', 'offer_expires_at'),            -- migration 0048
  ('public', 'club_settings',      'waitlist_offer_window_hours'), -- migration 0048
  ('public', 'profiles',           'sms_opt_in'),                  -- migration 0018
  ('public', 'profiles',           'phone'),                       -- migration 0001
  ('public', 'events',             'archived_at'),                 -- migration 0060
  ('public', 'events',             'member_joinable')              -- migration 0062
)
order by table_name, column_name;


-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. ROW-LEVEL SECURITY ENABLED
-- Expected: relrowsecurity = true for all 16 application tables.
-- Any false entry means RLS is not enabled on that table — a security gap.
-- ═══════════════════════════════════════════════════════════════════════════════
select relname as table_name,
       relrowsecurity as rls_enabled
from pg_class
where relkind = 'r'  -- ordinary tables only
  and relname in (
    'clubs',
    'profiles',
    'courts',
    'reservations',
    'events',
    'event_participants',
    'event_guests',
    'notifications',
    'notification_deliveries',
    'notification_preferences',
    'audit_log',
    'club_invites',
    'club_settings',
    'operating_hours',
    'operating_hours_override',
    'event_types'
  )
order by relname;


-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. RLS POLICY COUNTS PER TABLE
-- Expected: each table has at least 1 policy.
-- Tables with 0 policies have RLS enabled but no access rules — effectively
-- locked out for all users, which blocks all queries.
-- ═══════════════════════════════════════════════════════════════════════════════
select
  t.table_name,
  coalesce(p.policy_count, 0) as policy_count,
  case when coalesce(p.policy_count, 0) = 0 then 'NO POLICIES — BLOCKED' else 'OK' end as status
from (values
  ('clubs'),
  ('profiles'),
  ('courts'),
  ('reservations'),
  ('events'),
  ('event_participants'),
  ('event_guests'),
  ('notifications'),
  ('notification_deliveries'),
  ('notification_preferences'),
  ('audit_log'),
  ('club_invites'),
  ('club_settings'),
  ('operating_hours'),
  ('operating_hours_override'),
  ('event_types')
) as t(table_name)
left join (
  select tablename, count(*) as policy_count
  from pg_policies
  where schemaname = 'public'
  group by tablename
) p on p.tablename = t.table_name
order by t.table_name;


-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. REALTIME PUBLICATION — NOTIFICATIONS TABLE
-- Expected: 1 row with tablename = 'notifications'.
-- If 0 rows, in-app notification bell will not update in real time.
-- Fix: ALTER PUBLICATION supabase_realtime ADD TABLE notifications;
-- ═══════════════════════════════════════════════════════════════════════════════
select
  pubname,
  schemaname,
  tablename,
  'OK — notification bell realtime is active' as status
from pg_publication_tables
where pubname    = 'supabase_realtime'
  and tablename  = 'notifications';
-- If this returns 0 rows, run:
--   ALTER PUBLICATION supabase_realtime ADD TABLE notifications;


-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. REQUIRED FUNCTIONS / RPCs
-- Expected: 20 rows (one per function name).
-- NOTE: update_club_settings may return 2 rows if the obsolete 3-argument
-- overload was not dropped when migration 0049 was applied manually. See
-- Section 8b below to detect and fix that condition.
-- Any function name absent from results means that migration was not applied.
-- ═══════════════════════════════════════════════════════════════════════════════
select routine_name, 'EXISTS' as status
from information_schema.routines
where routine_schema = 'public'
  and routine_name in (
    -- Bootstrap
    'bootstrap_new_club',
    -- Core booking
    'create_reservation',
    -- Events / waitlist (member-facing)
    'create_event',
    'join_event',
    'leave_event',
    'accept_waitlist_offer',
    'decline_waitlist_offer',
    -- Event lifecycle (admin)
    'cancel_event',
    'archive_event',
    'unarchive_event',
    'mark_attendance',
    -- Roster
    'get_event_roster',
    -- Settings
    'update_club_settings',
    -- Phase 19 admin participant actions
    'admin_add_member',
    'admin_remove_participant',
    'admin_force_confirm',
    'admin_offer_spot',
    'admin_expire_offer',
    'admin_add_guest',
    'admin_remove_guest'
  )
order by routine_name;


-- ═══════════════════════════════════════════════════════════════════════════════
-- 8. MISSING FUNCTIONS
-- Expected: 0 rows.
-- Any row here is an RPC that does not exist — a blocking gap.
-- ═══════════════════════════════════════════════════════════════════════════════
select expected.fn_name as missing_function
from (values
  ('bootstrap_new_club'),
  ('create_reservation'),
  ('create_event'),
  ('join_event'),
  ('leave_event'),
  ('accept_waitlist_offer'),
  ('decline_waitlist_offer'),
  ('cancel_event'),
  ('archive_event'),
  ('unarchive_event'),
  ('mark_attendance'),
  ('get_event_roster'),
  ('update_club_settings'),
  ('admin_add_member'),
  ('admin_remove_participant'),
  ('admin_force_confirm'),
  ('admin_offer_spot'),
  ('admin_expire_offer'),
  ('admin_add_guest'),
  ('admin_remove_guest')
) as expected(fn_name)
left join information_schema.routines r
  on r.routine_schema = 'public'
  and r.routine_name  = expected.fn_name
where r.routine_name is null;


-- ═══════════════════════════════════════════════════════════════════════════════
-- 8b. OBSOLETE update_club_settings OVERLOADS
-- Expected: 0 rows.
-- The current (and only valid) signature is the 4-argument version introduced
-- in migration 0049 (p_booking_window_days, p_cancellation_window_hours,
-- p_cancellation_grace_minutes default 5, p_waitlist_offer_window_hours default 2).
--
-- Two obsolete overloads can exist depending on how migrations were applied:
--   • 2-argument (int, int) — created by 0012; never dropped by any migration
--     prior to 0052. Root cause: 0025 used CREATE OR REPLACE with a different
--     argument count, which PostgreSQL treats as a new overload rather than a
--     replacement, leaving the 2-arg version permanently alive.
--   • 3-argument (int, int, int) — created by 0025; dropped by 0049, but only
--     if that DROP statement executed (it may have been skipped in manual SQL
--     Editor workflows).
--
-- Both are unreachable from the app (named-argument calls resolve to the 4-arg
-- version) but are dead weight in the schema.
--
-- Migration 0052 removes both overloads and should prevent this check from
-- ever failing on a clean deployment. If this check fails here, it means
-- migration 0052 has not yet been applied to this environment.
--
-- Fix — apply migration 0052, or drop each obsolete overload manually:
--   DROP FUNCTION IF EXISTS public.update_club_settings(integer, integer);
--   DROP FUNCTION IF EXISTS public.update_club_settings(integer, integer, integer);
-- ═══════════════════════════════════════════════════════════════════════════════
select
  p.proname                                   as function_name,
  pg_get_function_identity_arguments(p.oid)   as arguments,
  p.pronargs                                  as arg_count,
  'OBSOLETE — apply migration 0052 or drop manually (see comment above)' as status
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname  = 'public'
  and p.proname  = 'update_club_settings'
  and p.pronargs <> 4;
-- Re-run this script after applying 0052 to confirm 0 rows.


-- ═══════════════════════════════════════════════════════════════════════════════
-- 9. STORAGE BUCKET — club-logos
-- Expected: 1 row with name = 'club-logos'.
-- If 0 rows, logo upload will fail.
-- Fix: create the bucket in Supabase dashboard → Storage → New bucket.
--   Name: club-logos | Public: true | File size limit: 2 MB
--   Allowed MIME types: image/jpeg, image/png, image/webp
-- ═══════════════════════════════════════════════════════════════════════════════
select
  name,
  public,
  file_size_limit,
  allowed_mime_types,
  'OK — bucket exists' as status
from storage.buckets
where name = 'club-logos';
-- If this returns 0 rows, create the bucket manually in the Supabase dashboard.


-- ═══════════════════════════════════════════════════════════════════════════════
-- 10. MIGRATION TRACKING (informational only)
-- supabase_migrations.schema_migrations may not exist when migrations have been
-- applied manually via the SQL Editor rather than through the Supabase CLI.
-- The object checks above (tables, columns, functions, RLS) are authoritative
-- regardless of whether migration tracking is present.
-- ═══════════════════════════════════════════════════════════════════════════════
select
  case
    when to_regclass('supabase_migrations.schema_migrations') is null
      then 'NOT PRESENT — migrations may have been applied manually; rely on object checks above.'
    else 'PRESENT — migration tracking exists; object checks above remain authoritative.'
  end as migration_tracking_status;
