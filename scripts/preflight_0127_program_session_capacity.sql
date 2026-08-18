-- scripts/preflight_0127_program_session_capacity.sql
-- Phase 33G1D preflight — READ-ONLY. Run this against the live database
-- BEFORE applying migration 0127. Deliberately self-contained (does not
-- reference _event_effective_occupancy or any other object 0127 itself
-- introduces, since this must be able to run before 0127 exists) —
-- inlines the identical occupancy formula 0127's new guards will enforce.
--
-- Scope: 0127 installs a capacity guard on event_participants/event_guests
-- covering EVERY Event, not only enrollment_model='program' generated
-- sessions — admin_add_guest in particular has been capacity-blind for
-- ANY Event since its creation. This report therefore covers every
-- current/future scheduled, non-archived Event; program_id/program_title
-- are simply null for a non-Program (or per_session/admin_managed) Event,
-- and the Program-offer reservation term is correctly 0 for those.
--
-- Reports every such Event whose existing occupancy already exceeds its
-- own capacity under the new invariant: confirmed participants + offered
-- participants + active Guests + active (status='offered' AND
-- offer_expires_at > now() — the same "active offer" predicate
-- _advance_program_waitlist_offer's own idempotency guard already uses)
-- unmaterialized whole-Program offers for that Event's program, where
-- applicable.
--
-- If this returns ANY rows: investigate each one before applying 0127.
-- The new guards would reject the NEXT capacity-consuming write to an
-- already-over-capacity Event even if that write itself did not cause the
-- overflow — surfacing a confusing failure unrelated to whatever is
-- actually being attempted at that point. This script performs no writes
-- of any kind.
--
-- If this returns zero rows: existing data already satisfies the new
-- invariant, and 0127 introduces no behavior change for any historical
-- row — it only starts enforcing the rule going forward.

select
  e.club_id,
  cl.name                                                              as club_name,
  p.id                                                                 as program_id,
  p.title                                                              as program_title,
  e.id                                                                 as event_id,
  e.starts_at,
  e.capacity,
  confirmed.cnt                                                        as confirmed_participant_count,
  offered.cnt                                                          as offered_participant_count,
  guests.cnt                                                           as active_guest_count,
  reserved.cnt                                                         as unmaterialized_program_offer_count,
  (confirmed.cnt + offered.cnt + guests.cnt + reserved.cnt)            as effective_occupancy,
  (confirmed.cnt + offered.cnt + guests.cnt + reserved.cnt) - e.capacity as amount_over_capacity
from public.events e
left join public.programs p on p.id = e.program_id and p.enrollment_model = 'program'
left join public.clubs cl on cl.id = e.club_id
cross join lateral (
  select count(*) as cnt
    from public.event_participants ep
   where ep.event_id = e.id
     and ep.status   = 'confirmed'
     and ep.role     = 'participant'
) confirmed
cross join lateral (
  select count(*) as cnt
    from public.event_participants ep
   where ep.event_id = e.id
     and ep.status   = 'offered'
     and ep.role     = 'participant'
) offered
cross join lateral (
  select count(*) as cnt
    from public.event_guests eg
   where eg.event_id = e.id
     and eg.status   = 'active'
) guests
cross join lateral (
  -- Mirrors 0127's own reservation term exactly: an ACTIVE (status =
  -- 'offered' AND offer_expires_at > now()) outstanding Program-level
  -- offer for this Event's program that has not yet been materialized
  -- into a confirmed OR offered event_participants row for THIS specific
  -- session. Zero rows whenever p.id is null (non-Program, or
  -- per_session/admin_managed, Event).
  select count(*) as cnt
    from public.program_enrollments pe
   where p.id is not null
     and pe.program_id       = p.id
     and pe.status           = 'offered'
     and pe.offer_expires_at > now()
     and not exists (
       select 1 from public.event_participants ep2
        where ep2.event_id         = e.id
          and ep2.roster_member_id = pe.roster_member_id
          and ep2.status           in ('confirmed', 'offered')
     )
) reserved
where e.status            = 'scheduled'
  and e.archived_at       is null
  and e.starts_at         >= now()
  and (confirmed.cnt + offered.cnt + guests.cnt + reserved.cnt) > e.capacity
order by e.club_id, e.starts_at;
