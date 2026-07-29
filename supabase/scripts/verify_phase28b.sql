-- verify_phase28b.sql
-- Phase 28B: Operational Reporting Sections — read-only verification.
--
-- Run in the Supabase SQL Editor AFTER 0096_reporting_sections.sql has been
-- applied. Every query is read-only (no INSERT/UPDATE/DELETE) — safe to run
-- against a live database. An empty result set from a "should be empty"
-- query means PASS.

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
    'get_reservation_summary',
    'get_event_program_summary',
    'get_waitlist_demand',
    'get_member_engagement_summary'
  )
order by p.proname;
-- Expect: 4 rows, is_security_definer = true on all, volatility = 's' on
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
  and p.proname in (
    'get_reservation_summary',
    'get_event_program_summary',
    'get_waitlist_demand',
    'get_member_engagement_summary'
  )
order by p.proname, g.grantee;
-- Expect: can_execute = true ONLY for grantee = 'authenticated'; false for
-- both 'PUBLIC' and 'anon', on every row.

-- ── C. Non-SELECT table grants (informational — snapshot & diff, not empty) ─
-- Same caveat as verify_phase28a.sql block D: not a pass/fail check on its
-- own. 0096 itself adds no table-level grant anywhere. If you kept the
-- pre-0095 baseline from QA_phase28a.md §0, this result should still match
-- it exactly — 0096 does not change it further. If not, treat this run as
-- the new baseline for any future checkpoint.
select table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in (
    'reservations', 'events', 'event_participants', 'event_guests',
    'club_memberships', 'program_enrollments', 'programs', 'clubs'
  )
  and grantee in ('anon', 'authenticated')
  and privilege_type <> 'SELECT'
order by table_name, grantee, privilege_type;

-- ── D. RLS still enabled on every table this checkpoint reads ──────────────
select relname as table_name, relrowsecurity as rls_enabled
from pg_class
where relnamespace = 'public'::regnamespace
  and relname in (
    'reservations', 'events', 'event_participants', 'event_guests',
    'club_memberships', 'program_enrollments', 'programs', 'clubs'
  )
order by relname;
-- Expect: rls_enabled = true for every row. This migration adds no table,
-- alters no RLS policy, and does not disable RLS anywhere.

-- ── E. Source-text proof: membership-native only, never legacy columns ─────
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
  and p.proname in (
    'get_reservation_summary',
    'get_event_program_summary',
    'get_waitlist_demand',
    'get_member_engagement_summary'
  )
order by p.proname;
-- Expect: uses_membership_native = true and touches_legacy_columns = false
-- for all four.

-- ── F. Source-text proof: none accept a client club id ──────────────────────
select
  p.proname as function_name,
  pg_get_function_arguments(p.oid) as args
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'get_reservation_summary',
    'get_event_program_summary',
    'get_waitlist_demand',
    'get_member_engagement_summary'
  )
order by p.proname;
-- Expect: args contain only p_start_date/p_end_date on every row — no
-- p_club_id or similar parameter on any of the four.

-- ── G. Source-text proof: all four reuse club_local_bounds ─────────────────
select
  p.proname as function_name,
  pg_get_functiondef(p.oid) ilike '%club_local_bounds%' as calls_club_local_bounds
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'get_reservation_summary',
    'get_event_program_summary',
    'get_waitlist_demand',
    'get_member_engagement_summary'
  )
order by p.proname;
-- Expect: calls_club_local_bounds = true for all four (get_waitlist_demand
-- calls it via `perform` for validation only — its returned range is
-- intentionally unused, see QA §3).

-- ── H. Index exists: event_guests (event_id) ────────────────────────────────
select indexname, indexdef
from pg_indexes
where schemaname = 'public'
  and tablename  = 'event_guests'
  and indexname  = 'event_guests_event_id_idx';
-- Expect: exactly 1 row, indexdef shows btree (event_id).

-- ── I. Cross-club isolation smoke check (manual — requires two clubs) ──────
-- Not automatable without two seeded admin sessions. Manual QA (see
-- QA_phase28b.md §Authorization) covers this by calling all four RPCs as
-- an admin of Club A and confirming zero visibility into Club B's data.

-- ── J. get_reservation_summary's daily_series is bounded and well-shaped ───
-- Source-text sanity: confirm the function generates the series from the
-- date range itself (days CTE), not from an unbounded reservation scan.
select
  pg_get_functiondef(oid) ilike '%generate_series(0, (p_end_date - p_start_date))%' as bounded_by_date_range
from pg_proc
where proname = 'get_reservation_summary' and pronamespace = 'public'::regnamespace;
-- Expect: true. Combined with club_local_bounds' own 366-day cap (block G
-- above, reused from 0095), this guarantees daily_series never exceeds 366
-- elements.

-- ── K. Source-text proof: daily_series is chronologically ordered ──────────
-- A CTE's own ORDER BY (the `series` CTE) is not guaranteed to survive an
-- aggregate reading from it — jsonb_agg needs its OWN ORDER BY. This check
-- collapses all whitespace/newlines to single spaces before matching, so it
-- is not sensitive to how the function body happens to be indented or
-- wrapped — reformatting the migration file would not silently break this
-- check the way a single fixed multi-line string comparison would.
select
  regexp_replace(pg_get_functiondef(oid), '\s+', ' ', 'g')
    ilike '%jsonb_agg(jsonb_build_object(%order by s.local_date%'
    as jsonb_agg_has_explicit_order
from pg_proc
where proname = 'get_reservation_summary' and pronamespace = 'public'::regnamespace;
-- Expect: true — jsonb_agg(...) must carry its own "order by s.local_date"
-- clause, not rely on the series CTE's ordering alone.

-- ── L. Source-text proof: program engagement requires whole-program model ──
-- members_with_program_enrollment must restrict to enrollment_model='program'
-- — an 'enrolled' row on a per_session or admin_managed program does not
-- qualify. Whitespace-normalized for the same reason as block K.
select
  regexp_replace(pg_get_functiondef(oid), '\s+', ' ', 'g')
    ilike '%enrollment_model = ''program''%'
    as restricts_to_whole_program_enrollment
from pg_proc
where proname = 'get_member_engagement_summary' and pronamespace = 'public'::regnamespace;
-- Expect: true.

-- ── M. Current policies on every table 0096 reads (informational snapshot) ─
-- NOT a pass/fail check on its own — 0096 adds no table, alters no RLS
-- policy, and does not disable RLS anywhere. This is a snapshot to diff
-- against, not an emptiness claim. If you kept the pre-0095/0096 baseline
-- from QA_phase28a.md §0, this result must match it EXACTLY (see
-- QA_phase28b.md "Policy baseline"). Any new, missing, or altered row here
-- is the real regression signal.
select tablename, policyname, cmd
from pg_policies
where schemaname = 'public'
  and tablename in (
    'reservations', 'events', 'event_participants', 'event_guests',
    'club_memberships', 'program_enrollments', 'programs', 'clubs'
  )
order by tablename, policyname;
