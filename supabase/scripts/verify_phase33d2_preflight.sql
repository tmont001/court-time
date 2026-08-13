-- verify_phase33d2_preflight.sql
-- Phase 33D2: Programs / Events Member Identity Parity (Events scope) —
-- PRE-migration verification, to run BEFORE
-- 0113_staff_managed_events_identity.sql.
--
-- Every query is read-only — safe to run against a live database. Uses
-- only pre-0113 schema (no roster_member_id column on event_participants
-- yet). Mirrors verify_phase33c1_preflight.sql / verify_phase33d1_
-- preflight.sql's structure for the equivalent reservations/lessons
-- domain backfills.

-- ── A. Baseline counts ──────────────────────────────────────────────────────
select
  count(*)                                      as total_event_participants,
  count(*) filter (where profile_id is not null) as with_profile_id,
  count(distinct e.club_id)                      as distinct_clubs
from public.event_participants ep
join public.events e on e.id = ep.event_id;
-- Expect: with_profile_id = total_event_participants — profile_id is NOT
-- NULL pre-migration, so this should always match today.

-- ── B. Every event_participants row must resolve exactly one roster
--      identity in the SAME club as its event ─────────────────────────────
-- This is the exact predicate 0113's own fail-closed DO guard re-checks
-- independently before backfilling — if this returns any rows, the
-- migration will refuse to proceed (by design) until they are resolved.
select
  ep.id, ep.event_id, ep.profile_id, ep.status, ep.created_at,
  e.club_id, p.first_name, p.last_name, p.status as profile_status
from public.event_participants ep
join public.events e on e.id = ep.event_id
left join public.profiles p on p.id = ep.profile_id
where ep.profile_id is not null
  and not exists (
    select 1 from public.roster_members rm
     where rm.claimed_by = ep.profile_id
       and rm.club_id    = e.club_id
  )
order by ep.created_at;
-- Expect: 0 rows. Any row here means 33B1's own backfill (0107) did not
-- cover this profile_id/club_id pairing — investigate that membership
-- before applying 0113. Do not fabricate a roster_members row to force
-- this to pass.

-- ── C. Multiple roster identities for the same (profile_id, club_id) ───────
-- Sanity check: 0107 enforces roster_members_club_claimed_by_uniq (one
-- claimed_by per club), so this should never return rows — included for
-- defense-in-depth, matching 0108/0111's preflight's own equivalent check.
select rm.claimed_by, rm.club_id, count(*) as roster_rows
from public.roster_members rm
where rm.claimed_by in (select distinct profile_id from public.event_participants where profile_id is not null)
group by rm.claimed_by, rm.club_id
having count(*) > 1;
-- Expect: 0 rows.

-- ── D. event_participants.roster_member_id does not exist yet (schema check) ─
select column_name
from information_schema.columns
where table_schema = 'public'
  and table_name   = 'event_participants'
  and column_name  = 'roster_member_id';
-- Expect: 0 rows — confirms this preflight is being run BEFORE 0113. If
-- this returns 1 row, 0113 has already been applied; re-run
-- verify_phase33d2.sql (the post-migration script) instead.

-- ── E. event_guests rows already tied to an (unclaimed) roster identity ────
-- BLOCKER (Phase 33D2a correction — was informational-only). 0113 does
-- NOT migrate/move/delete these rows automatically (see the migration
-- header) — any existing "Member added as Guest" row represents a data
-- decision that must be made explicitly, not silently carried forward.
-- The exact rows are listed below; if this returns any rows, STOP. Do
-- not apply 0113 until each row has been explicitly reviewed and, if
-- appropriate, migrated by a separate, deliberate data-migration step
-- (out of scope for 0113 itself).
select
  eg.id, eg.event_id, eg.roster_member_id, eg.display_name, eg.created_at,
  e.club_id, e.title as event_title,
  rm.first_name, rm.last_name, rm.claimed_by
from public.event_guests eg
join public.events e on e.id = eg.event_id
left join public.roster_members rm on rm.id = eg.roster_member_id
where eg.roster_member_id is not null
order by eg.created_at;
-- Expect: 0 rows for a direct, unblocked apply.

do $$
declare
  v_count int;
begin
  select count(*) into v_count
    from public.event_guests
   where roster_member_id is not null;

  if v_count > 0 then
    raise exception
      'phase33d2_preflight_blocker: % event_guests row(s) already carry a roster_member_id (Member-as-Guest). 0113 does not migrate these automatically. Review the row-level query above and make an explicit data decision before applying 0113.',
      v_count;
  end if;
end $$;
-- Expect: no exception. If this raises, 0113 must not be applied yet.
