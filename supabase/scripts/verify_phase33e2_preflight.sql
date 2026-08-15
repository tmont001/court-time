-- verify_phase33e2_preflight.sql
-- Phase 33E2: Durable Member/Guest Lifecycle + Attendance + Reporting —
-- PRE-migration verification, to run BEFORE
-- 0117_durable_member_guest_lifecycle_and_attendance.sql.
--
-- Every query is read-only. This checkpoint changes schema (roster_members
-- and event_guests both gain new columns, one with a data backfill), so
-- unlike 33E1 this preflight exists to PROVE the backfill assumption safe
-- before the migration's own fail-closed DO guard re-checks it, and to
-- establish baselines for before/after comparison.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. roster_members lifecycle backfill safety — the exact predicate 0117's
--    own fail-closed DO guard re-checks independently before backfilling.
--    If this returns any rows, the migration will refuse to proceed (by
--    design) until they are resolved.
-- ═══════════════════════════════════════════════════════════════════════════
select
  rm.id, rm.club_id, rm.first_name, rm.last_name, rm.claimed_by
from public.roster_members rm
where rm.claimed_by is not null
  and not exists (
    select 1 from public.club_memberships cm
    where cm.user_id = rm.claimed_by
      and cm.club_id = rm.club_id
  );
-- Expect: 0 rows. Any row here is a claimed roster identity with no
-- matching same-club club_memberships row — investigate before applying
-- 0117. Do not fabricate a club_memberships row to force this to pass.

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Baseline: what the roster lifecycle backfill will actually produce —
--    informational preview of the derived status/removed_at values,
--    grouped for a quick sanity read before/after comparison.
-- ═══════════════════════════════════════════════════════════════════════════
select
  (rm.claimed_by is not null)                                     as is_claimed,
  case
    when rm.claimed_by is null then 'active (default, unclaimed)'
    when cm.status = 'active' and cm.removed_at is null then 'active (from club_memberships)'
    else 'inactive (from club_memberships)'
  end                                                              as derived_status,
  count(*)                                                         as row_count
from public.roster_members rm
left join public.club_memberships cm
  on cm.user_id = rm.claimed_by and cm.club_id = rm.club_id
group by 1, 2
order by 1, 2;
-- Informational baseline. Record for before/after comparison — after 0117,
-- roster_members.status should match this derivation exactly (query 1 of
-- the post-verify script re-derives and diffs).

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. roster_members total row count (untouched-invariant regression canary
--    — 0117 adds columns and updates existing rows, it never inserts or
--    deletes a roster_members row)
-- ═══════════════════════════════════════════════════════════════════════════
select count(*) as total_roster_members
from public.roster_members;
-- Record for before/after comparison — must be byte-identical post-0117.

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. event_guests baseline — every existing row will default to
--    status = 'active' post-0117 (correct: the prior model only ever
--    hard-deleted a guest on removal, so every currently-existing row IS an
--    active guest today)
-- ═══════════════════════════════════════════════════════════════════════════
select count(*) as total_event_guests
from public.event_guests;
-- Record for before/after comparison — must be byte-identical post-0117
-- (0117 adds columns only, never inserts/deletes an event_guests row).

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. Reservations historical-identity check — confirms the exact production
--    finding this checkpoint's reporting re-key relies on: zero legitimate
--    'member_booking' reservations exist with an accountholder owner but no
--    resolved roster identity. (Already confirmed via a live read-only
--    query against this same database earlier in this checkpoint's audit —
--    re-run here as part of the formal preflight record.)
-- ═══════════════════════════════════════════════════════════════════════════
select r.id, r.owner_user_id, r.reason, r.status, r.starts_at
from public.reservations r
where r.owner_user_id is not null
  and r.roster_member_id is null
  and r.reason = 'member_booking';
-- Expect: 0 rows. Any row here is a genuine backfill gap the reporting
-- re-key in 0117 section L would silently drop from Member engagement
-- metrics — STOP and investigate rather than applying 0117 if this returns
-- any rows.

select r.reason, count(*) as row_count
from public.reservations r
where r.owner_user_id is not null
  and r.roster_member_id is null;
-- Informational — confirms the ONLY reservations lacking roster_member_id
-- despite having an owner are 'event'/'maintenance' housekeeping rows
-- (staff-owned), which the new roster-based query design excludes anyway
-- via its inner join to roster_members where role = 'member' (staff
-- accounts carry role = 'admin'/'pro' in roster_members too) — zero
-- regression risk from these rows specifically.

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. Current get_member_engagement_summary / get_reporting_overview active-
--    member counts (club_memberships-based, PRE-0117) — record for
--    before/after comparison. The post-0117 roster-based count will be
--    >= this value (it additionally includes no-account active Members,
--    which the club_memberships-only definition structurally cannot see).
-- ═══════════════════════════════════════════════════════════════════════════
select count(*) as club_memberships_active_member_count
from public.club_memberships
where status = 'active'
  and removed_at is null
  and role = 'member';

select count(*) as unclaimed_roster_members
from public.roster_members
where claimed_by is null
  and role = 'member';
-- Informational — every row counted here is a no-account Member the old
-- club_memberships-only definition could never include. The gap between
-- this preflight's query 6a and the post-verify script's new roster-based
-- count should be explained by (a) this population, plus/minus (b) any
-- claimed identity whose derived status differs between the two
-- definitions (should be none, by construction of the backfill in query 2
-- above).

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. Schema check — confirms this preflight is being run BEFORE 0117
-- ═══════════════════════════════════════════════════════════════════════════
select table_name, column_name
from information_schema.columns
where table_schema = 'public'
  and (
    (table_name = 'roster_members' and column_name in ('status', 'removed_at', 'removed_by'))
    or (table_name = 'event_guests' and column_name in ('status', 'attendance_status', 'cancelled_at', 'cancelled_by'))
  );
-- Expect: 0 rows. If this returns any rows, 0117 has already been applied
-- — re-run verify_phase33e2.sql (the post-migration script) instead.
