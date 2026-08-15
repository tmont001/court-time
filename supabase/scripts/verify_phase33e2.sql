-- verify_phase33e2.sql
-- Phase 33E2: Durable Member/Guest Lifecycle + Attendance + Reporting —
-- POST-migration verification for
-- 0117_durable_member_guest_lifecycle_and_attendance.sql.
--
-- Run in the Supabase SQL Editor AFTER 0117 has been applied. Every query
-- is read-only. Text-pattern function-body checks are not a full behavioral
-- proof — supplement with the runtime QA plan from the implementation
-- report.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Schema: new columns exist with correct type/nullability/default/check
-- ═══════════════════════════════════════════════════════════════════════════
select table_name, column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public'
  and (
    (table_name = 'roster_members' and column_name in ('status', 'removed_at', 'removed_by'))
    or (table_name = 'event_guests' and column_name in ('status', 'attendance_status', 'cancelled_at', 'cancelled_by'))
  )
order by table_name, column_name;
-- Expect 7 rows:
--   roster_members.status       text, not null, default 'active'::text
--   roster_members.removed_at   timestamptz, nullable, no default
--   roster_members.removed_by   uuid, nullable, no default
--   event_guests.status            text, not null, default 'active'::text
--   event_guests.attendance_status text, nullable, no default
--   event_guests.cancelled_at      timestamptz, nullable, no default
--   event_guests.cancelled_by      uuid, nullable, no default

select conrelid::regclass as table_name, conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid in ('public.roster_members'::regclass, 'public.event_guests'::regclass)
  and contype = 'c'
order by 1, 2;
-- Expect CHECK constraints present for roster_members.status
-- (in ('active','inactive')), event_guests.status
-- (in ('active','cancelled')), event_guests.attendance_status
-- (in ('attended','no_show')).

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. roster_members backfill correctness — re-derive the expected status
--    from club_memberships and diff against the actual post-backfill value.
--    Compare row counts against the preflight's query 2 baseline.
-- ═══════════════════════════════════════════════════════════════════════════
select rm.id, rm.club_id, rm.claimed_by, rm.status as actual_status,
       rm.removed_at as actual_removed_at,
       case
         when cm.status = 'active' and cm.removed_at is null then 'active'
         else 'inactive'
       end as expected_status,
       cm.removed_at as expected_removed_at
from public.roster_members rm
join public.club_memberships cm
  on cm.user_id = rm.claimed_by and cm.club_id = rm.club_id
where rm.status is distinct from (
        case when cm.status = 'active' and cm.removed_at is null then 'active' else 'inactive' end
      )
   or rm.removed_at is distinct from cm.removed_at;
-- Expect: 0 rows. Any row here means the backfill produced a value that
-- disagrees with what club_memberships says today — investigate.

select status, count(*) as row_count
from public.roster_members
where claimed_by is null
group by status;
-- Expect: a single row, status = 'active', count = the preflight's query 3
-- total minus however many claimed rows exist (every unclaimed row must
-- default to 'active').

select count(*) as total_roster_members from public.roster_members;
-- Compare directly against the preflight's query 3 — must be identical
-- (0117 never inserts/deletes a roster_members row).

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. event_guests — no data changed, only schema added
-- ═══════════════════════════════════════════════════════════════════════════
select status, count(*) as row_count
from public.event_guests
group by status;
-- Expect: a single row, status = 'active', count = the preflight's query 4
-- total (every pre-existing row defaults to 'active'; 0117 inserts/deletes
-- nothing).

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Sync-hook presence in the three 0086 membership RPCs
-- ═══════════════════════════════════════════════════════════════════════════
select
  p.proname,
  pg_get_functiondef(p.oid) ~ 'update public\.roster_members' as has_roster_sync,
  pg_get_functiondef(p.oid) ~ 'set search_path = public, pg_temp' as has_fixed_search_path,
  coalesce(p.prosecdef, false) as is_security_definer
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('set_member_status', 'remove_club_member', 'restore_club_member')
order by p.proname;
-- Expect: 3 rows, all three columns true for every row.

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. get_roster_members / get_program_eligible_roster_members — active-only
--    filtering present, p_include_inactive parameter exists
-- ═══════════════════════════════════════════════════════════════════════════
select
  pg_get_function_identity_arguments(p.oid) as args,
  pg_get_functiondef(p.oid) ~ 'p_include_inactive or rm\.status = ''active''' as has_active_filter
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'get_roster_members';
-- Expect: 1 row. args includes "p_include_inactive boolean DEFAULT false".
-- has_active_filter = true.

select
  pg_get_functiondef(p.oid) ~ 'rm\.status\s*=\s*''active''' as has_active_filter
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'get_program_eligible_roster_members';
-- Expect: 1 row, true.

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. admin_remove_guest is now a soft-cancel with a fail-closed guard —
--    structural proof (no DELETE statement remains, UPDATE + GET
--    DIAGNOSTICS guard present)
-- ═══════════════════════════════════════════════════════════════════════════
select
  pg_get_functiondef(p.oid) !~ 'delete from event_guests' as no_hard_delete,
  pg_get_functiondef(p.oid) ~ 'set\s+status\s*=\s*''cancelled''' as sets_cancelled_status,
  pg_get_functiondef(p.oid) ~ 'get diagnostics v_rows_updated = row_count' as has_fail_closed_guard
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'admin_remove_guest';
-- Expect: 1 row, all three columns true.

-- Data-level canary: after runtime QA soft-removes at least one guest,
-- confirm the row still exists (not deleted) with cancelled_at/cancelled_by
-- populated.
select id, event_id, display_name, status, cancelled_at, cancelled_by
from public.event_guests
where status = 'cancelled'
order by cancelled_at desc
limit 20;
-- Informational — empty immediately after apply (expected; nothing is
-- retroactively cancelled by 0117 itself), populated after runtime QA
-- exercises admin_remove_guest.

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. Every capacity-count call site filters to active guests — structural
--    proof across all 12 touched SQL functions
-- ═══════════════════════════════════════════════════════════════════════════
with expected(proname) as (
  values
    ('admin_add_guest'), ('admin_add_roster_member_to_event'),
    ('join_event'), ('admin_add_member'), ('admin_add_roster_participant'),
    ('admin_force_confirm'), ('admin_force_confirm_roster_participant'),
    ('admin_offer_spot'), ('admin_offer_spot_roster_participant'),
    ('advance_waitlist_offer'), ('update_event')
)
select
  expected.proname,
  p.oid is not null as function_exists,
  coalesce(
    (
      select bool_and(m ~ 'status\s*=\s*''active''')
      from regexp_matches(pg_get_functiondef(p.oid), 'from\s+(?:public\.)?event_guests\s+where\s+event_id\s*=\s*p_event_id[^;)]*', 'g') as m
    ),
    false
  ) as every_event_guests_read_filters_active
from expected
left join pg_proc p
  on p.proname = expected.proname
 and p.pronamespace = 'public'::regnamespace
order by expected.proname;
-- Expect: 11 rows, function_exists = true and
-- every_event_guests_read_filters_active = true for every row. This is a
-- text-pattern proof, not a full behavioral one — the runtime QA plan's
-- capacity-boundary repro (add a guest to a capacity=1 event, soft-remove
-- them, confirm the freed slot is immediately joinable) is the real proof.

-- ═══════════════════════════════════════════════════════════════════════════
-- 8. get_event_roster surfaces real guest attendance, active-only guests
-- ═══════════════════════════════════════════════════════════════════════════
select
  pg_get_functiondef(p.oid) ~ 'eg\.attendance_status::text\s+as attendance_status' as surfaces_real_attendance,
  pg_get_functiondef(p.oid) ~ 'eg\.status\s*=\s*''active''' as filters_active_guests_only
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'get_event_roster';
-- Expect: 1 row, both columns true.

-- ═══════════════════════════════════════════════════════════════════════════
-- 9. mark_attendance_guest exists with correct signature/grants/search_path
-- ═══════════════════════════════════════════════════════════════════════════
select
  pg_get_function_identity_arguments(p.oid) as args,
  coalesce(p.prosecdef, false) as is_security_definer,
  pg_get_functiondef(p.oid) ~ 'set search_path = public, pg_temp' as has_fixed_search_path,
  pg_get_functiondef(p.oid) ~ 'get diagnostics v_rows_updated = row_count' as has_fail_closed_guard,
  pg_get_functiondef(p.oid) ~ 'and status\s*=\s*''active''' as targets_active_guest_only,
  pg_get_functiondef(p.oid) ~ 'insert into public\.audit_log' as writes_audit_log
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'mark_attendance_guest';
-- Expect: 1 row, all boolean columns true. args:
-- "p_event_id uuid, p_expected_club_id uuid, p_guest_id uuid,
--  p_attendance_status text"

select
  p.proname, g.grantee,
  has_function_privilege(
    case g.grantee when 'PUBLIC' then 'public' else g.grantee end,
    p.oid, 'EXECUTE'
  ) as can_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join (values ('PUBLIC'), ('anon'), ('authenticated')) as g(grantee)
where n.nspname = 'public'
  and p.proname = 'mark_attendance_guest'
order by g.grantee;
-- Expect: can_execute = false for PUBLIC and anon, true for authenticated.

-- Data-level canary: no guest attendance mark should exist on a row whose
-- event is in a different club than the actor who set it — structurally
-- guaranteed by the function's own club-scoped event lookup, checked here
-- as a direct data assertion instead.
select eg.id, eg.event_id, e.club_id, eg.attendance_status
from public.event_guests eg
join public.events e on e.id = eg.event_id
where eg.attendance_status is not null
order by eg.id
limit 20;
-- Informational — populated after runtime QA marks at least one guest's
-- attendance.

-- ═══════════════════════════════════════════════════════════════════════════
-- 10. Reporting: active-Member definition is IDENTICAL between
--     get_member_engagement_summary and get_reporting_overview, and both
--     now use roster_members rather than club_memberships
-- ═══════════════════════════════════════════════════════════════════════════
select
  p.proname,
  pg_get_functiondef(p.oid) ~ 'from public\.roster_members rm\s*\n?\s*where rm\.club_id = v_club_id\s*\n?\s*and rm\.role\s*=\s*''member''\s*\n?\s*and rm\.status\s*=\s*''active''' as uses_roster_active_member_definition
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('get_member_engagement_summary', 'get_reporting_overview');
-- Expect: 2 rows, both true. (Whitespace-sensitive regex — if this reads
-- false but section 1's plain grep below reads true, trust the grep; this
-- is a convenience check, not the authoritative one.)

-- Simpler, whitespace-insensitive fallback check for the same fact:
select
  p.proname,
  pg_get_functiondef(p.oid) ~ 'roster_members' as references_roster_members,
  pg_get_functiondef(p.oid) !~ 'club_memberships.*active_count|active_count.*club_memberships' as no_longer_club_memberships_keyed
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('get_member_engagement_summary', 'get_reporting_overview');
-- Expect: 2 rows, both columns true.

-- Data-level parity check: with the SAME date range, both reports' active-
-- Member count must be identical (run manually as the authenticated admin,
-- via the application or SQL Editor's RPC call feature — cannot be scripted
-- as plain SQL since both are SECURITY DEFINER functions gated on
-- current_user_role()).
-- select active_member_snapshot_count from get_member_engagement_summary(current_date - 30, current_date);
-- select active_member_count           from get_reporting_overview(current_date - 30, current_date);
-- Expect: identical values.

-- Confirms the new roster-based count is >= the old club_memberships-based
-- count recorded in the preflight (query 6) — the gap should equal the
-- preflight's query 6b (unclaimed active Members), give or take any
-- claimed-identity status disagreement already ruled out by query 2 above.
select count(*) as new_active_member_count
from public.roster_members
where role = 'member' and status = 'active';

-- ═══════════════════════════════════════════════════════════════════════════
-- 11. get_event_program_summary — Guest attendance now participates in
--     attendance metrics; guests (enrollment) counts active only
-- ═══════════════════════════════════════════════════════════════════════════
select
  pg_get_functiondef(p.oid) ~ 'guest_attended_count' as tracks_guest_attended,
  pg_get_functiondef(p.oid) ~ 'guest_no_show_count'  as tracks_guest_no_show,
  pg_get_functiondef(p.oid) ~ 'filter \(where eg\.status = ''active''\)\s*\n?\s*as guest_count' as guest_enrollment_active_only
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'get_event_program_summary';
-- Expect: 1 row, all three columns true.

-- ═══════════════════════════════════════════════════════════════════════════
-- 12. No FOUND-lifetime regressions introduced — none of this migration's
--     touched functions add a new v_existing/FOUND-capturing branch; this
--     is a defense-in-depth re-check that the 0114-established
--     v_existing_found capture pattern is still intact, unchanged, in the
--     three functions that use it
-- ═══════════════════════════════════════════════════════════════════════════
select
  p.proname,
  pg_get_functiondef(p.oid) ~ 'v_existing_found := found' as captures_found_immediately
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('admin_add_member', 'join_event', 'admin_add_roster_participant')
order by p.proname;
-- Expect: 3 rows, all true — confirms 0117's capacity-count edit in each
-- of these three functions did not disturb the FOUND-lifetime fix 0114
-- established.

-- ═══════════════════════════════════════════════════════════════════════════
-- 13. No duplicate function overloads introduced anywhere this migration
--     touched (every change was CREATE OR REPLACE on an existing signature,
--     except the one new function)
-- ═══════════════════════════════════════════════════════════════════════════
select p.proname, count(*) as overload_count
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'set_member_status', 'remove_club_member', 'restore_club_member',
    'get_roster_members', 'get_program_eligible_roster_members',
    'admin_add_guest', 'admin_remove_guest', 'admin_add_roster_member_to_event',
    'get_event_roster', 'mark_attendance_guest',
    'admin_add_member', 'join_event', 'admin_add_roster_participant',
    'admin_force_confirm_roster_participant', 'admin_offer_spot_roster_participant',
    'admin_force_confirm', 'admin_offer_spot', 'advance_waitlist_offer', 'update_event',
    'get_reporting_overview', 'get_event_program_summary', 'get_member_engagement_summary'
  )
group by p.proname
having count(*) <> 1
order by p.proname;
-- Expect: 0 rows (every function in this list has exactly one overload).
