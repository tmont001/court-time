-- verify_phase33c1_preflight.sql
-- Phase 33C1: Staff-Managed Reservations — Identity Foundation — PRE-migration
-- preflight.
--
-- Run in the Supabase SQL Editor BEFORE applying
-- supabase/migrations/0108_staff_managed_reservations_identity.sql. Every
-- query below is a standalone, independent SELECT — no INSERT/UPDATE/
-- DELETE, no DDL — strictly read-only, safe to run against production.
--
-- ██  DO NOT APPLY 0108 IF SECTION A SHOWS A NONZERO COUNT.  ██
-- ██  Resolve every row in Section B by hand, then re-run this script    ██
-- ██  until Section A is zero.                                          ██
--
-- This preflight runs against the PRE-0108 schema — reservations.
-- roster_member_id does not exist yet. Nothing here references it.
--
-- Matches migration 0108 Section B's fail-closed guard predicate exactly:
-- a reason='member_booking' reservation is unresolved when no
-- roster_members row in the same club has claimed_by = owner_user_id.
-- Coverage is expected to be complete given Phase 33B1's own backfill
-- covered every club_memberships row (including removed ones) — this
-- script exists to verify that expectation against real data, not assume
-- it.

-- ── A. Count of unresolved member_booking reservations ─────────────────────
select count(*) as unresolved_member_booking_count
from public.reservations r
where r.reason = 'member_booking'
  and not exists (
    select 1 from public.roster_members rm
     where rm.claimed_by = r.owner_user_id
       and rm.club_id    = r.club_id
  );
-- Expect: 0. If nonzero, do not apply 0108 — resolve every row in Section B
-- first (most likely cause: Phase 33B1's backfill did not fully cover the
-- club_memberships row behind this reservation's owner_user_id — verify
-- that membership actually has a linked roster_members row in this same
-- club; if not, that is itself a Phase 33B1 data-integrity question to
-- resolve before proceeding, not something this migration should guess at).

-- ── B. Detail rows for every unresolved reservation ─────────────────────────
-- Selects only reservation-row fields plus the owner's name from profiles
-- (no email, no auth.users column) — the minimum needed to identify which
-- booking and which person this concerns.
select
  r.id            as reservation_id,
  r.club_id,
  cl.name         as club_name,
  r.owner_user_id,
  p.first_name    as owner_first_name,
  p.last_name     as owner_last_name,
  r.court_id,
  r.starts_at,
  r.status,
  r.created_at
from public.reservations r
join public.clubs cl     on cl.id = r.club_id
left join public.profiles p on p.id = r.owner_user_id
where r.reason = 'member_booking'
  and not exists (
    select 1 from public.roster_members rm
     where rm.claimed_by = r.owner_user_id
       and rm.club_id    = r.club_id
  )
order by r.club_id, r.created_at;
-- Expect: zero rows.

-- ── C. Explicit apply-readiness flag ────────────────────────────────────────
select
  case
    when count(*) = 0 then 'READY — 0108 may be applied'
    else 'NOT READY — resolve Section B rows first, then re-run this script'
  end as preflight_result,
  count(*) as unresolved_member_booking_count
from public.reservations r
where r.reason = 'member_booking'
  and not exists (
    select 1 from public.roster_members rm
     where rm.claimed_by = r.owner_user_id
       and rm.club_id    = r.club_id
  );

-- ── D. Baseline row-count-by-reason snapshot (informational) ───────────────
-- Record this result before applying 0108. verify_phase33c1.sql's Section F
-- runs the identical query post-apply — every reason's count should be
-- unchanged, since this migration never inserts or deletes a reservations
-- row (only the backfill UPDATE, which only sets a previously-null column
-- on existing member_booking rows).
select reason, count(*) as row_count
from public.reservations
group by reason
order by reason;
