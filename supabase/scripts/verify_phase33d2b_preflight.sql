-- verify_phase33d2b_preflight.sql
-- Phase 33D2b: Programs (whole-program enrollment) Member Identity Parity —
-- PRE-migration verification, to run BEFORE 0115_program_enrollment_identity.sql.
--
-- Every query is read-only — safe to run against a live database. Uses
-- only pre-0115 schema (no roster_member_id column on program_enrollments
-- yet). Mirrors verify_phase33d2_preflight.sql's structure for the
-- equivalent Events-domain backfill.

-- ── 1. Baseline counts ──────────────────────────────────────────────────────
select
  count(*)                                       as total_program_enrollments,
  count(*) filter (where profile_id is not null)  as with_profile_id,
  count(distinct program_id)                      as distinct_programs
from public.program_enrollments;
-- Expect: with_profile_id = total_program_enrollments — profile_id is NOT
-- NULL pre-migration, so this should always match today.

select status, count(*) as row_count
from public.program_enrollments
group by status
order by status;
-- Informational baseline — record for before/after comparison.

select count(distinct pr.club_id) as distinct_clubs
from public.program_enrollments pe
join public.programs pr on pr.id = pe.program_id;
-- Informational baseline.

-- ── 2. Every program_enrollments row must resolve exactly one roster
--      identity in the SAME club as its program ──────────────────────────
-- This is the exact predicate 0115's own fail-closed DO guard re-checks
-- independently before backfilling — if this returns any rows, the
-- migration will refuse to proceed (by design) until they are resolved.
select
  pe.id, pe.program_id, pe.profile_id, pe.status, pe.created_at,
  pr.club_id, p.first_name, p.last_name, p.status as profile_status
from public.program_enrollments pe
join public.programs pr on pr.id = pe.program_id
left join public.profiles p on p.id = pe.profile_id
where pe.profile_id is not null
  and not exists (
    select 1 from public.roster_members rm
     where rm.claimed_by = pe.profile_id
       and rm.club_id    = pr.club_id
  )
order by pe.created_at;
-- Expect: 0 rows (item 1: "every existing profile_id resolves exactly one
-- same-club roster_members row"; item 2: "zero enrollment rows resolve no
-- roster identity" — the same query proves both simultaneously). Any row
-- here means a membership this profile_id/club_id pairing predates or
-- otherwise escaped the 33B1/0107 roster backfill — investigate that
-- membership before applying 0115. Do not fabricate a roster_members row
-- to force this to pass.

-- ── 3. Zero enrollment rows resolve MULTIPLE roster identities ─────────────
-- Sanity check: 0107 enforces roster_members_club_claimed_by_uniq (one
-- claimed_by per club), so this should never return rows — included for
-- defense-in-depth, matching every prior Phase 33 preflight's own
-- equivalent check.
select rm.claimed_by, rm.club_id, count(*) as roster_rows
from public.roster_members rm
where rm.claimed_by in (
  select distinct pe.profile_id
  from public.program_enrollments pe
  where pe.profile_id is not null
)
group by rm.claimed_by, rm.club_id
having count(*) > 1;
-- Expect: 0 rows.

-- ── 4. Zero cross-club program/enrollment/roster identity mismatches ───────
-- IMPORTANT — multi-club roster identity is allowed under the locked
-- architecture: one authenticated user may legitimately hold a separate
-- roster_members row in more than one club (e.g. a member of both Club A
-- and Club B). `roster_members.claimed_by = program_enrollments.profile_id`
-- alone can therefore match MULTIPLE roster rows for the same enrollment —
-- one per club that account holds an identity in. A roster row in a
-- DIFFERENT club than the enrollment's own program is NOT itself an error
-- as long as a valid SAME-club roster row also exists for that profile_id;
-- the earlier version of this query joined on claimed_by alone and flagged
-- every non-matching club row unconditionally, which produced a false
-- positive for exactly this legitimate multi-club case.
--
-- This query now reports a genuine wrong-club identity situation ONLY when
-- BOTH hold: (a) the enrollment has NO valid same-club roster_members
-- match, AND (b) at least one roster identity for that same claimed_by
-- exists in some OTHER club. Condition (a) is the exact same predicate
-- query 2 already enforces as the authoritative missing-same-club-identity
-- blocker — every row this query could return is therefore already a
-- subset of query 2's blocker set, surfaced here with the added diagnostic
-- context of which other club(s) the account does hold an identity in
-- (useful for an operator distinguishing "no roster identity anywhere" from
-- "has one, but in the wrong club" while investigating a query 2 failure).
-- Query 2 remains the authoritative blocker; this query never fires on its
-- own when query 2 is clean.
select
  pe.id, pe.program_id, pe.profile_id, pr.club_id as program_club_id,
  array_agg(rm.id order by rm.club_id)      as other_club_roster_ids,
  array_agg(rm.club_id order by rm.club_id) as other_club_ids
from public.program_enrollments pe
join public.programs pr on pr.id = pe.program_id
join public.roster_members rm on rm.claimed_by = pe.profile_id
where pe.profile_id is not null
  and rm.club_id is distinct from pr.club_id
  and not exists (
    select 1 from public.roster_members rm_same_club
     where rm_same_club.claimed_by = pe.profile_id
       and rm_same_club.club_id    = pr.club_id
  )
group by pe.id, pe.program_id, pe.profile_id, pr.club_id
order by pe.id;
-- Expect: 0 rows. A valid multi-club user (a same-club match exists,
-- alongside one or more other-club roster rows) never appears here — the
-- `not exists` clause excludes them by construction, regardless of how
-- many other clubs they also hold an identity in.

-- ── 5. Post-backfill duplicate-collision proof: zero duplicate
--      (program_id, roster_member_id) groups would result ─────────────────
-- Derives the SAME roster_member_id every enrollment row would receive
-- under 0115's backfill UPDATE, then checks whether two DIFFERENT
-- program_enrollments rows for the SAME program would collide on it —
-- which would violate the new unique(program_id, roster_member_id)
-- constraint at ADD CONSTRAINT time. Structurally this should be
-- impossible given program_enrollments' EXISTING unique(program_id,
-- profile_id) plus roster_members_club_claimed_by_uniq (each profile_id
-- maps to at most one roster_member_id, and each program already permits
-- at most one row per profile_id) — this query proves that reasoning
-- empirically rather than assuming it.
with derived as (
  select
    pe.program_id,
    rm.id as derived_roster_member_id
  from public.program_enrollments pe
  join public.programs pr on pr.id = pe.program_id
  join public.roster_members rm
    on rm.claimed_by = pe.profile_id
   and rm.club_id    = pr.club_id
  where pe.profile_id is not null
)
select program_id, derived_roster_member_id, count(*) as collision_count
from derived
group by program_id, derived_roster_member_id
having count(*) > 1;
-- Expect: 0 rows. Any row here is a hard blocker — 0115's
-- `alter table ... add constraint program_enrollments_roster_member_id_uniq
-- unique (program_id, roster_member_id)` would fail outright.

-- ── 6. Schema check — roster_member_id does not exist yet ──────────────────
select column_name
from information_schema.columns
where table_schema = 'public'
  and table_name   = 'program_enrollments'
  and column_name  = 'roster_member_id';
-- Expect: 0 rows — confirms this preflight is being run BEFORE 0115. If
-- this returns 1 row, 0115 has already been applied; re-run
-- verify_phase33d2b.sql (the post-migration script) instead.
