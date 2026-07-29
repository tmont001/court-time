-- verify_phase28a.sql
-- Phase 28A: Reporting Foundation — read-only verification.
--
-- Run in the Supabase SQL Editor AFTER 0095_reporting_foundation.sql has
-- been applied. Every query is read-only (no INSERT/UPDATE/DELETE) — safe
-- to run against a live database. An empty result set from a "should be
-- empty" query means PASS.

-- ── A. Functions exist with correct owner/security/volatility/search_path ─
select
  p.proname                                  as function_name,
  pg_get_function_identity_arguments(p.oid)  as args,
  p.prosecdef                                as is_security_definer,
  p.provolatile                              as volatility,   -- expect 's' (stable) on all
  p.proconfig                                as config        -- expect search_path=public, pg_temp
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'club_local_bounds',
    '_reporting_daily_open_hours',
    '_reporting_reserved_hours',
    'get_reporting_overview',
    'get_court_utilization'
  )
order by p.proname;
-- Expect: 5 rows, is_security_definer = true on all, volatility = 's' on
-- all, config contains 'search_path=public, pg_temp' on all.

-- ── B. Grants — exposed RPCs: authenticated only, never PUBLIC or anon ─────
select
  p.proname as function_name,
  g.grantee,
  has_function_privilege(
    case g.grantee when 'PUBLIC' then 'public' else g.grantee end,
    p.oid, 'EXECUTE'
  ) as can_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join (values ('PUBLIC'), ('anon'), ('authenticated')) as g(grantee)
where n.nspname = 'public'
  and p.proname in ('get_reporting_overview', 'get_court_utilization')
order by p.proname, g.grantee;
-- Expect: can_execute = true ONLY for grantee = 'authenticated'; false for
-- both 'PUBLIC' and 'anon', on every row.

-- ── C. Grants — internal helpers: nobody (not even authenticated) ──────────
select
  p.proname as function_name,
  g.grantee,
  has_function_privilege(
    case g.grantee when 'PUBLIC' then 'public' else g.grantee end,
    p.oid, 'EXECUTE'
  ) as can_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join (values ('PUBLIC'), ('anon'), ('authenticated')) as g(grantee)
where n.nspname = 'public'
  and p.proname in ('club_local_bounds', '_reporting_daily_open_hours', '_reporting_reserved_hours')
order by p.proname, g.grantee;
-- Expect: can_execute = false for every row (PUBLIC, anon, AND
-- authenticated all lack EXECUTE) — these are callable only internally, by
-- the SECURITY DEFINER exposed RPCs running as the owning role.

-- ── D. Non-SELECT table grants (informational — snapshot & diff, not empty) ─
-- NOT a pass/fail check on its own, and an empty result is NOT the expected
-- baseline: several of these tables (e.g. reservations, which members can
-- INSERT/UPDATE directly per its own RLS-gated policies) may already carry
-- legitimate historical INSERT/UPDATE/DELETE grants to `authenticated` from
-- earlier migrations or Supabase's own schema bootstrap — row-level access
-- for those is enforced by RLS policies, not by the absence of a grant.
-- 0095 itself adds no table-level grant anywhere. Run this block once
-- BEFORE applying 0095 (see QA_phase28a.md "Pre-apply baseline") and once
-- after; the two result sets must be byte-identical. Any row that appears
-- post-apply and was absent pre-apply is the actual failure signal — not
-- the presence of rows in general.
select table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in (
    'reservations', 'events', 'event_participants', 'event_guests',
    'club_memberships', 'program_enrollments', 'programs', 'courts',
    'operating_hours', 'operating_hours_override', 'clubs'
  )
  and grantee in ('anon', 'authenticated')
  and privilege_type <> 'SELECT'
order by table_name, grantee, privilege_type;

-- ── E. RLS still enabled on every table this checkpoint reads ──────────────
select relname as table_name, relrowsecurity as rls_enabled
from pg_class
where relnamespace = 'public'::regnamespace
  and relname in (
    'reservations', 'events', 'event_participants', 'event_guests',
    'club_memberships', 'program_enrollments', 'programs', 'courts',
    'operating_hours', 'operating_hours_override', 'clubs'
  )
order by relname;
-- Expect: rls_enabled = true for every row. This migration adds no table,
-- alters no RLS policy, and does not disable RLS anywhere.

-- ── F. Source-text proof: membership-native only, never legacy columns ─────
select
  p.proname as function_name,
  pg_get_functiondef(p.oid) ilike '%current_user_club_id%'
    and pg_get_functiondef(p.oid) ilike '%current_user_role%'          as uses_membership_native,
  pg_get_functiondef(p.oid) ilike '%profiles.club_id%'
    or pg_get_functiondef(p.oid) ilike '%profiles.role%'
    or pg_get_functiondef(p.oid) ilike '%profiles.status%'
    or pg_get_functiondef(p.oid) ilike '%is_lesson_provider%'          as touches_legacy_columns
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('get_reporting_overview', 'get_court_utilization')
order by p.proname;
-- Expect: uses_membership_native = true and touches_legacy_columns = false
-- for both.

-- ── G. Source-text proof: neither exposed RPC accepts a client club id ─────
select
  p.proname as function_name,
  pg_get_function_arguments(p.oid) as args
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('get_reporting_overview', 'get_court_utilization')
order by p.proname;
-- Expect: args contain only p_start_date/p_end_date — no p_club_id or
-- similar parameter on either function.

-- ── H. Index exists: reservations (club_id, starts_at) ─────────────────────
select indexname, indexdef
from pg_indexes
where schemaname = 'public'
  and tablename  = 'reservations'
  and indexname  = 'reservations_club_starts_at_idx';
-- Expect: exactly 1 row, indexdef shows btree (club_id, starts_at).

-- ── I. Source-text proof: club_local_bounds rejects invalid input ──────────
select
  pg_get_functiondef(oid) ilike '%invalid_date_range%'    as rejects_null_or_reversed,
  pg_get_functiondef(oid) ilike '%date_range_too_large%'  as rejects_oversized_range
from pg_proc
where proname = 'club_local_bounds' and pronamespace = 'public'::regnamespace;
-- Expect: both true.

-- ── J. Cross-club isolation smoke check (manual — requires two clubs) ──────
-- Not automatable without two seeded admin sessions. Manual QA (see
-- QA_phase28a.md §Authorization) covers this by calling both RPCs as an
-- admin of Club A and confirming zero visibility into Club B's data.

-- ── K. Current policies on touched tables (informational — snapshot & diff) ─
select tablename, policyname, cmd
from pg_policies
where schemaname = 'public'
  and tablename in (
    'reservations', 'events', 'event_participants', 'event_guests',
    'club_memberships', 'program_enrollments', 'programs', 'courts',
    'operating_hours', 'operating_hours_override', 'clubs'
  )
order by tablename, policyname;
-- Informational only — this migration adds no policy to any of these
-- tables and alters none. Run once BEFORE applying 0095 and once after
-- (see QA_phase28a.md "Pre-apply baseline"); the two result sets must be
-- identical. Any new, missing, or altered row is the failure signal.
