-- verify_phase33e1_preflight.sql
-- Phase 33E1: Program Waitlist Lifecycle Correctness — PRE-migration
-- verification, to run BEFORE 0116_program_waitlist_lifecycle_correctness.sql.
--
-- Every query is read-only — safe to run against a live database. No
-- schema change is made by 0116, so there is no backfill-safety guard to
-- prove the way earlier Phase 33 preflights did — this script instead
-- establishes baselines for before/after comparison and surfaces the
-- exact population the fix affects.
--
-- Scope note: reporting identity parity (get_member_engagement_summary /
-- get_reporting_overview) is OUT OF SCOPE for 33E1 — moved to 33E2. This
-- script accordingly contains no reporting-specific assertions or
-- baselines; every query below is scoped to the Program waitlist lifecycle
-- fix and its immediate regression surface only.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Program enrollment counts/statuses — baseline
-- ═══════════════════════════════════════════════════════════════════════════
select status, count(*) as row_count
from public.program_enrollments
group by status
order by status;
-- Informational baseline — record for before/after comparison. Row counts
-- must be identical after 0116 (it changes no program_enrollments row,
-- only the functions that operate on them).

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Currently offered/waitlisted rows, split by claim status — the exact
--    population the fix affects
-- ═══════════════════════════════════════════════════════════════════════════
select
  pe.status,
  (rm.claimed_by is not null) as is_claimed,
  count(*) as row_count
from public.program_enrollments pe
join public.roster_members rm on rm.id = pe.roster_member_id
where pe.status in ('waitlisted', 'offered')
group by pe.status, (rm.claimed_by is not null)
order by pe.status, is_claimed;
-- Informational. Any 'waitlisted'/is_claimed=false rows here are
-- candidates that should have promoted already had the pre-0116 bug not
-- existed — do not manually "fix" them before applying; 0116 (once
-- applied) plus a subsequent leave/remove/expire event on that program
-- will resolve them going forward.

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Stuck stale offers — an 'offered' row whose offer has already expired
--    (the _expire_stale_program_offers half of the bug)
-- ═══════════════════════════════════════════════════════════════════════════
select
  pe.id, pe.program_id, pe.roster_member_id, pe.profile_id,
  pe.offer_expires_at, (rm.claimed_by is not null) as is_claimed
from public.program_enrollments pe
join public.roster_members rm on rm.id = pe.roster_member_id
where pe.status = 'offered'
  and pe.offer_expires_at < now()
order by pe.offer_expires_at;
-- Informational. Any row here (especially is_claimed = false) is
-- currently stuck exactly as described in the bug report — expired but
-- never actually cancelled/re-advanced. Record for a targeted post-apply
-- check (query 3 of the post-verify script should show these resolved on
-- their next natural trigger).

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. NULL roster_member_id regression canary — program_enrollments
-- ═══════════════════════════════════════════════════════════════════════════
select
  count(*) as total_rows,
  count(*) filter (where profile_id is null)       as null_profile_id_rows,
  count(*) filter (where roster_member_id is null) as null_roster_member_id_rows
from public.program_enrollments;
-- Expect: null_roster_member_id_rows = 0 (NOT NULL by schema since 0115 —
-- this query is a direct data assertion of that guarantee, not just a
-- schema-metadata one, and a useful untouched-invariant canary regardless
-- of the reporting-scope change). null_profile_id_rows > 0 is expected and
-- correct wherever no-account enrollments exist.

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. Notification schema sanity check — confirms 'waitlist_offer' is
--    already an allowed kind (no schema change needed for the new
--    Program notification insert)
-- ═══════════════════════════════════════════════════════════════════════════
select pg_get_constraintdef(oid)
from pg_constraint
where conrelid = 'public.notifications'::regclass
  and contype  = 'c'
  and pg_get_constraintdef(oid) like '%kind%';
-- Expect: the CHECK constraint definition includes 'waitlist_offer' in
-- its allowed-values list (added 0048, unchanged since).
