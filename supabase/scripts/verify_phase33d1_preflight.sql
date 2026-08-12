-- verify_phase33d1_preflight.sql
-- Phase 33D1: Staff-Managed Lessons — Identity Foundation — PRE-migration
-- verification, to run BEFORE 0111_staff_managed_lessons_identity.sql.
--
-- Every query is read-only (no INSERT/UPDATE/DELETE) — safe to run against
-- a live database. Uses only pre-0111 schema (no roster_member_id column
-- on lesson_requests yet). Mirrors verify_phase33c1_preflight.sql's
-- structure for the equivalent reservations-domain backfill.

-- ── A. Baseline counts ──────────────────────────────────────────────────────
select
  count(*)                                         as total_lesson_requests,
  count(*) filter (where member_id is not null)    as with_member_id,
  count(distinct club_id)                          as distinct_clubs
from public.lesson_requests;
-- Expect: with_member_id = total_lesson_requests — member_id is NOT NULL
-- pre-migration, so this should always match today.

-- ── B. Every lesson_requests row must resolve exactly one roster identity ──
-- This is the exact predicate 0111's own fail-closed DO guard re-checks
-- independently before backfilling — if this returns any rows, the
-- migration will refuse to proceed (by design) until they are resolved.
select
  lr.id, lr.club_id, lr.member_id, lr.status, lr.created_at,
  p.first_name, p.last_name, p.status as profile_status
from public.lesson_requests lr
left join public.profiles p on p.id = lr.member_id
where lr.member_id is not null
  and not exists (
    select 1 from public.roster_members rm
     where rm.claimed_by = lr.member_id
       and rm.club_id    = lr.club_id
  )
order by lr.created_at;
-- Expect: 0 rows. Any row here means 33B1's own backfill (0107) did not
-- cover this member_id/club_id pairing — investigate that membership
-- before applying 0111. Do not fabricate a roster_members row to force
-- this to pass.

-- ── C. Multiple roster identities for the same (member_id, club_id) ────────
-- Sanity check: 0107 enforces roster_members_club_claimed_by_uniq (one
-- claimed_by per club), so this should never return rows — included for
-- defense-in-depth, matching 0108's preflight's own equivalent check.
select rm.claimed_by, rm.club_id, count(*) as roster_rows
from public.roster_members rm
where rm.claimed_by in (select distinct member_id from public.lesson_requests where member_id is not null)
group by rm.claimed_by, rm.club_id
having count(*) > 1;
-- Expect: 0 rows.

-- ── D. lesson_requests.roster_member_id does not exist yet (schema check) ──
-- (Section D was previously a "cross-club integrity" check that joined
-- roster_members on claimed_by = lr.member_id WITHOUT also constraining
-- club_id — under the locked multi-club architecture, one authenticated
-- user is explicitly allowed a roster identity in EACH club they belong
-- to, so that join could return multiple roster rows per lesson_requests
-- row, and any of that user's OTHER, unrelated club roster rows would
-- false-positive as "corruption" here. Removed rather than corrected —
-- Section B already performs the meaningful check (every lesson request
-- resolves to a roster identity in THE SAME club, via an exact-match join
-- on both claimed_by AND club_id), and Section C already checks for
-- ambiguous multiple-roster-rows-per-club-per-person, which is the only
-- kind of ambiguity that would actually indicate corruption. No
-- replacement check is added in its place.)
select column_name
from information_schema.columns
where table_schema = 'public'
  and table_name   = 'lesson_requests'
  and column_name  = 'roster_member_id';
-- Expect: 0 rows — confirms this preflight is being run BEFORE 0111. If
-- this returns 1 row, 0111 has already been applied; re-run
-- verify_phase33d1.sql (the post-migration script) instead.
