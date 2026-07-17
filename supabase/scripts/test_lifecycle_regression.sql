-- test_lifecycle_regression.sql
-- Pilot Readiness — static schema verification + manual regression guide.
-- Run in the Supabase SQL Editor (against production or staging).
-- Safe to re-run: no data is committed.
--
-- ── What this file IS ────────────────────────────────────────────────────────
-- Sections A–G are STATIC VERIFICATION CHECKS executed automatically.
-- They inspect schema structure (columns, functions, constraints, grants) without
-- needing authenticated users or real event/member data.
--
-- Section H is a MANUAL REGRESSION GUIDE. Those statements require an
-- authenticated session with real UUIDs. They are wrapped in begin/rollback so
-- no data is permanently changed. A human must run them after replacing the UUID
-- placeholders.
--
-- ── What this file is NOT ────────────────────────────────────────────────────
-- This is not an automated behavioral regression suite. It does not simulate two
-- clubs, does not prove cross-club isolation (only confirms RLS is enabled), and
-- does not run RPC calls automatically. Those require authenticated Supabase
-- sessions with real test data.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Coverage:
--   A. RLS enabled on all tables
--   B. RLS helper function names (correct names: current_user_club_id, current_user_role)
--   C. SECURITY DEFINER on member and admin RPCs
--   D. event_archived guard presence in all 5 member RPCs (migration 0063)
--   E. Waitlist schema columns and helper RPCs
--   F. Booking-window and event-lifecycle columns
--   G. Function grants to authenticated role
--   H. Manual behavioral tests (begin/rollback; requires real UUIDs)
-- ─────────────────────────────────────────────────────────────────────────────


-- ═══════════════════════════════════════════════════════════════════════════════
-- A. RLS ENABLED ON ALL APPLICATION TABLES
-- Expected: rls_enabled = true for all 16 rows.
-- Note: confirms RLS is ON, not that policies are correct.
-- Cross-club isolation requires testing with two authenticated sessions.
-- ═══════════════════════════════════════════════════════════════════════════════

select
  t.table_name,
  case when c.relrowsecurity then 'OK — RLS enabled'
       else 'FAIL — RLS DISABLED' end as rls_status
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
join pg_class c on c.relname = t.table_name and c.relkind = 'r'
order by t.table_name;
-- Expected: 16 rows, all OK.


-- ═══════════════════════════════════════════════════════════════════════════════
-- B. RLS HELPER FUNCTIONS
-- The authoritative names from migration 0002_rls_policies.sql are:
--   current_user_club_id()   (NOT auth_club_id)
--   current_user_role()      (NOT auth_role)
-- ═══════════════════════════════════════════════════════════════════════════════

select
  fn_name,
  case when count(r.routine_name) > 0 then 'OK — exists'
       else 'FAIL — missing (RLS policies may be broken)' end as status
from (values
  ('current_user_club_id'),
  ('current_user_role')
) as t(fn_name)
left join information_schema.routines r
  on r.routine_schema = 'public' and r.routine_name = t.fn_name
group by fn_name
order by fn_name;
-- Expected: 2 rows, both OK.


-- ═══════════════════════════════════════════════════════════════════════════════
-- C. SECURITY DEFINER — MEMBER AND ADMIN RPCs
-- All application RPCs use SECURITY DEFINER so they bypass RLS and perform
-- their own auth + role checks internally.
-- ═══════════════════════════════════════════════════════════════════════════════

select
  p.proname as function_name,
  case when p.prosecdef then 'OK — SECURITY DEFINER'
       else 'FAIL — caller-rights function (role check bypassed)' end as status
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    -- Member-facing
    'join_event',
    'leave_event',
    'accept_waitlist_offer',
    'decline_waitlist_offer',
    'create_reservation',
    -- Admin event lifecycle
    'cancel_event',
    'archive_event',
    'unarchive_event',
    'create_event',
    'mark_attendance',
    -- Admin participant management (Phase 19)
    'admin_add_member',
    'admin_remove_participant',
    'admin_force_confirm',
    'admin_offer_spot',
    'admin_expire_offer',
    'admin_add_guest',
    'admin_remove_guest'
  )
order by p.proname;
-- Expected: one row per function, all SECURITY DEFINER.


-- ═══════════════════════════════════════════════════════════════════════════════
-- D. event_archived GUARD IN MEMBER RPCs (migration 0063)
-- Checks function body text for the guard pattern. Does not prove execution order
-- is correct — see the manual test in Section H for that.
-- ═══════════════════════════════════════════════════════════════════════════════

-- D1. Guard text present in all 5 member RPCs
select
  p.proname as function_name,
  case
    when pg_get_functiondef(p.oid) like '%event_archived%'
      then 'OK — event_archived guard present'
    else 'FAIL — guard missing (apply migration 0063)'
  end as archived_guard,
  case
    when pg_get_functiondef(p.oid) like '%not_authenticated%'
      then 'OK — auth check present'
    else 'WARN — not_authenticated check not found'
  end as auth_check
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'join_event',
    'leave_event',
    'accept_waitlist_offer',
    'decline_waitlist_offer',
    'cancel_event'
  )
order by p.proname;
-- Expected: all 5 rows show OK for archived_guard.

-- D2. Guard fires BEFORE participant UPDATE in decline_waitlist_offer
-- The archived check must appear at a lower character offset than the participant UPDATE.
select
  case
    when (
      select
        position('event_archived' in pg_get_functiondef(p.oid))
        < position('update event_participants' in lower(pg_get_functiondef(p.oid)))
        and position('event_archived' in pg_get_functiondef(p.oid)) > 0
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'decline_waitlist_offer'
    )
    then 'OK — archived guard fires before participant UPDATE'
    else 'FAIL — guard order incorrect or guard missing'
  end as decline_guard_order;
-- Expected: OK.


-- ═══════════════════════════════════════════════════════════════════════════════
-- E. WAITLIST SCHEMA AND HELPER RPCS
-- ═══════════════════════════════════════════════════════════════════════════════

-- E1. Required columns
select
  t.col as column_name,
  t.tbl as table_name,
  case when c.column_name is not null then 'OK' else 'MISSING' end as status
from (values
  ('event_participants', 'offer_expires_at'),
  ('club_settings',      'waitlist_offer_window_hours')
) as t(tbl, col)
left join information_schema.columns c
  on c.table_schema = 'public' and c.table_name = t.tbl and c.column_name = t.col
order by t.tbl, t.col;
-- Expected: 2 rows, both OK.

-- E2. Waitlist helper RPCs exist
select
  fn_name,
  case when count(r.routine_name) > 0 then 'OK' else 'MISSING' end as status
from (values
  ('advance_waitlist_offer'),
  ('expire_stale_offers_for_event'),
  ('accept_waitlist_offer'),
  ('decline_waitlist_offer')
) as t(fn_name)
left join information_schema.routines r
  on r.routine_schema = 'public' and r.routine_name = t.fn_name
group by fn_name
order by fn_name;
-- Expected: 4 rows, all OK.

-- E3. event_participants status check constraint includes all required values
select conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'event_participants'::regclass
  and contype  = 'c'
  and conname like '%status%';
-- Expected: constraint includes 'confirmed','waitlisted','offered','cancelled'.


-- ═══════════════════════════════════════════════════════════════════════════════
-- F. BOOKING-WINDOW AND EVENT-LIFECYCLE COLUMNS
-- ═══════════════════════════════════════════════════════════════════════════════

-- F1. Present columns
select table_name, column_name, 'OK' as status
from information_schema.columns
where (table_schema, table_name, column_name) in (
  ('public', 'club_settings', 'booking_window_days'),
  ('public', 'club_settings', 'cancellation_window_hours'),
  ('public', 'club_settings', 'cancellation_grace_minutes'),
  ('public', 'club_settings', 'waitlist_offer_window_hours'),
  ('public', 'events',        'archived_at'),           -- migration 0060
  ('public', 'events',        'member_joinable'),        -- migration 0062
  ('public', 'profiles',      'sms_opt_in'),             -- migration 0018
  ('public', 'profiles',      'phone')                   -- migration 0001
)
order by table_name, column_name;
-- Expected: 8 rows.

-- F2. Missing columns (should return 0 rows)
select t.tbl as table_name, t.col as column_name, 'MISSING' as status
from (values
  ('club_settings', 'booking_window_days'),
  ('club_settings', 'cancellation_window_hours'),
  ('club_settings', 'cancellation_grace_minutes'),
  ('club_settings', 'waitlist_offer_window_hours'),
  ('events',        'archived_at'),
  ('events',        'member_joinable'),
  ('profiles',      'sms_opt_in'),
  ('profiles',      'phone')
) as t(tbl, col)
left join information_schema.columns c
  on c.table_schema = 'public' and c.table_name = t.tbl and c.column_name = t.col
where c.column_name is null;
-- Expected: 0 rows.


-- ═══════════════════════════════════════════════════════════════════════════════
-- G. FUNCTION GRANTS — authenticated role
-- All application RPCs must be EXECUTABle by the 'authenticated' role.
-- ═══════════════════════════════════════════════════════════════════════════════

select
  p.proname as function_name,
  case
    when has_function_privilege('authenticated', p.oid, 'execute')
      then 'OK — authenticated can execute'
    else 'FAIL — grant missing'
  end as grant_status
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'join_event',
    'leave_event',
    'accept_waitlist_offer',
    'decline_waitlist_offer',
    'cancel_event',
    'archive_event',
    'unarchive_event',
    'create_event',
    'mark_attendance',
    'create_reservation',
    'admin_add_member',
    'admin_remove_participant',
    'admin_force_confirm',
    'admin_offer_spot',
    'admin_expire_offer',
    'admin_add_guest',
    'admin_remove_guest'
  )
order by p.proname;
-- Expected: all rows OK.


-- ═══════════════════════════════════════════════════════════════════════════════
-- H. MANUAL BEHAVIORAL REGRESSION TESTS
--
-- These require an authenticated Supabase session (not the postgres role).
-- Run them in the SQL Editor while signed in as a test member who is:
--   - a member of the test club
--   - already joined the archived-event as a participant (for leave/decline tests)
--
-- Replace the UUID placeholders before running.
-- All statements are wrapped in begin/rollback — no data is permanently changed.
--
-- ── Honest coverage note ─────────────────────────────────────────────────────
-- These tests cover the happy/error path for individual RPCs.
-- They do NOT cover:
--   • cross-club isolation (requires two separate authenticated sessions)
--   • booking-window enforcement (requires a future date + controlled clock)
--   • reservation overlap constraint (requires two overlapping reservations)
--   • full waitlist promotion chain (advance_waitlist_offer side effects)
-- Those scenarios require a dedicated integration test environment.
-- ═══════════════════════════════════════════════════════════════════════════════

/*

-- ── REPLACE THESE ───────────────────────────────────────────────────────────
-- <archived-event-uuid>      — an event with archived_at IS NOT NULL
-- <active-future-event-uuid> — a scheduled event starting in the future

-- ── 1. join_event on archived event → 'event_archived' ───────────────────
begin;
  select join_event('<archived-event-uuid>');
rollback;
-- Expected: ERROR: event_archived

-- ── 2. join_event on active event → confirmed or waitlisted ──────────────
begin;
  select (join_event('<active-future-event-uuid>')).status;
rollback;
-- Expected: 'confirmed' or 'waitlisted'

-- ── 3. leave_event on archived event → 'event_archived' ─────────────────
begin;
  select leave_event('<archived-event-uuid>');
rollback;
-- Expected: ERROR: event_archived

-- ── 4. accept_waitlist_offer on archived event → 'event_archived' ────────
begin;
  select accept_waitlist_offer('<archived-event-uuid>');
rollback;
-- Expected: ERROR: event_archived

-- ── 5. decline_waitlist_offer on archived event → 'event_archived' ───────
--    Confirms guard fires BEFORE any participant row is mutated.
begin;
  select decline_waitlist_offer('<archived-event-uuid>');
rollback;
-- Expected: ERROR: event_archived

-- ── 6. cancel_event on archived event (admin session) → 'event_archived' ─
begin;
  select cancel_event('<archived-event-uuid>');
rollback;
-- Expected: ERROR: event_archived

-- ── 7. cancel_event on active event (admin session) → success ────────────
begin;
  select cancel_event('<active-future-event-uuid>');
rollback;
-- Expected: no error; events.status would be 'cancelled' inside txn

-- ── 8. join_event as member on member_joinable = false event ─────────────
--    Requires an event with member_joinable = false.
begin;
  select join_event('<admin-managed-event-uuid>');
rollback;
-- Expected: ERROR: event_not_joinable

*/
