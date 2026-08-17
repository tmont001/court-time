-- scripts/preflight_0126_member_schedule_conflicts.sql
-- Phase 33G1C preflight — READ-ONLY. Run this against the live database
-- BEFORE applying migration 0126. It detects every EXISTING pair of
-- overlapping CONFIRMED commitments (court Reservation / Event / Lesson)
-- held by the same roster Member that the new 0126 guards would treat as
-- invalid going forward. This script performs no writes at all — it never
-- deletes, cancels, or rewrites anything.
--
-- If this returns ANY rows: BLOCK application of 0126 and investigate each
-- row before deciding how to resolve the underlying real-world conflict
-- (that is a business decision, not something this script or 0126 should
-- make automatically).
--
-- If this returns zero rows: existing data already satisfies the new
-- invariant, and 0126 introduces no behavior change for any historical row
-- — it only starts enforcing the rule going forward.
--
-- Covers all six same-Member pairings, including three same-domain cases
-- the current schema does NOT already prevent on its own:
--   - Reservation x Reservation on DIFFERENT courts (the existing GiST
--     EXCLUDE constraint on `reservations` only prevents a same-court
--     double-booking, never a Member holding two confirmed courts at once)
--   - Event x Event (no existing constraint of any kind)
--   - Lesson x Lesson (lesson_requests has no exclusion constraint at all)
-- plus the three cross-domain pairings (Reservation x Event, Reservation x
-- Lesson, Event x Lesson) audited in 33G1A/33G1B.
--
-- Domain filters match 0126's own _assert_roster_member_schedule_available
-- exactly: reservations.reason = 'member_booking' only (a pro_lesson
-- reservation is the Lesson's own commitment, listed once via
-- lesson_requests, never counted a second time here); events must be
-- status = 'scheduled' and archived_at is null.

with commitments as (
  select
    r.club_id,
    r.roster_member_id,
    'reservation'::text as kind,
    r.id                as object_id,
    r.starts_at,
    r.ends_at
  from public.reservations r
  where r.reason = 'member_booking'
    and r.status = 'confirmed'
    and r.roster_member_id is not null

  union all

  select
    e.club_id,
    ep.roster_member_id,
    'event'::text as kind,
    ep.id         as object_id,
    e.starts_at,
    e.ends_at
  from public.event_participants ep
  join public.events e on e.id = ep.event_id
  where ep.status = 'confirmed'
    and e.status   = 'scheduled'
    and e.archived_at is null
    and ep.roster_member_id is not null

  union all

  select
    lr.club_id,
    lr.roster_member_id,
    'lesson'::text as kind,
    lr.id          as object_id,
    lr.proposed_starts_at as starts_at,
    lr.proposed_ends_at   as ends_at
  from public.lesson_requests lr
  where lr.status = 'confirmed'
    and lr.roster_member_id is not null
    and lr.proposed_starts_at is not null
    and lr.proposed_ends_at   is not null
)
select
  c1.club_id,
  cl.name                                                              as club_name,
  c1.roster_member_id,
  trim(coalesce(rm.first_name, '') || ' ' || coalesce(rm.last_name, '')) as member_name,
  rm.status                                                            as roster_member_status,
  (rm.claimed_by is not null)                                          as member_has_account,
  c1.kind                                                              as object_a_type,
  c1.object_id                                                         as object_a_id,
  c1.starts_at                                                         as object_a_starts_at,
  c1.ends_at                                                           as object_a_ends_at,
  c2.kind                                                              as object_b_type,
  c2.object_id                                                         as object_b_id,
  c2.starts_at                                                         as object_b_starts_at,
  c2.ends_at                                                           as object_b_ends_at
from commitments c1
join commitments c2
  on c1.club_id           = c2.club_id
 and c1.roster_member_id  = c2.roster_member_id
 and (c1.kind, c1.object_id) < (c2.kind, c2.object_id)
 and tstzrange(c1.starts_at, c1.ends_at, '[)') && tstzrange(c2.starts_at, c2.ends_at, '[)')
left join public.roster_members rm on rm.id = c1.roster_member_id
left join public.clubs          cl on cl.id = c1.club_id
order by c1.club_id, c1.roster_member_id, c1.starts_at;
