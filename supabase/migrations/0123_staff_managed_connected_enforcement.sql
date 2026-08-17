-- 0123_staff_managed_connected_enforcement.sql
-- Phase 33F3B: Staff-Managed / Connected Enforcement.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
-- 0122 (33F3A) added the entitlement foundation (club_subscriptions,
-- club_entitlements, club_has_capability, current_club_has_capability,
-- set_club_tier_for_operator) but enforced nothing — every existing club
-- was backfilled to Connected and no RLS policy, RPC, or route changed
-- behavior. This migration makes the Staff-Managed / Connected distinction
-- real for a Member (role='member') caller. Admin and Pro behavior is
-- completely unaffected by member_self_service, at every layer below —
-- never entitlement-gate a staff-only path.
--
-- Locked Staff-Managed Member experience: may access /my-schedule, own
-- confirmed/upcoming/past commitments, /profile*, and existing lesson-
-- request/proposal state needed to resolve an in-flight transaction, plus
-- valid exits from existing commitments. Must not gain club-wide calendar
-- access, club-wide reservation availability, general Event/Program
-- discovery, or the ability to newly book a court, join an Event, join a
-- Program, or submit a lesson request. Connected Members retain current
-- behavior — no regression for an existing Connected club.
--
-- ENFORCEMENT LAYERS — hiding UI alone is not sufficient, so this migration
-- covers the two database-side layers; the application-side layers
-- (navigation, route redirect, error mapping) are covered by companion
-- frontend changes in this same checkpoint, not by this file:
--   1. Mutation RPC layer — create_reservation, join_event, join_program,
--      submit_lesson_request now raise capability_not_available for a
--      role='member' caller at a Staff-Managed club. create_club_invite
--      raises the same for a NEW Member-role invite (resend_club_invite is
--      not separately gated — it calls create_club_invite internally for
--      the actual insert, so the gate already covers it).
--   2. Database/RLS data access — reservations, events, event_participants,
--      and programs SELECT policies now recognize three cases: Admin/Pro
--      (unaffected, full club read, exactly as today), Connected Member
--      (member_self_service=true, full club read, exactly as today), and
--      Staff-Managed Member (member_self_service=false, own-row/own-
--      participation/own-enrollment only). This holds even if the Member
--      queries Supabase directly, bypassing the Next.js app entirely.
--      reservations_insert_own (Section 2B) gets the identical three-way
--      condition on its WITH CHECK, for the same reason: gating
--      create_reservation alone does not stop a direct client INSERT that
--      independently satisfies both this policy and 0108's
--      reservations_member_booking_identity_guard trigger (which enforces
--      roster-identity integrity, not entitlement).
--
-- Continuity/exit RPCs are deliberately NOT gated: cancel_member_reservation,
-- leave_event_v2 (dispatched as leaveEvent), leave_program,
-- withdraw_lesson_request, decline_lesson_proposal,
-- decline_program_waitlist_offer, and the three accept/resolve paths
-- (accept_waitlist_offer, accept_program_waitlist_offer,
-- accept_lesson_proposal) all continue to work unconditionally for both
-- tiers — a Staff-Managed Member cannot newly join a waitlist or initiate a
-- lesson request post-enforcement, so an accept/resolve action necessarily
-- operates on an already-existing offer/request or a staff-driven workflow.
-- accept_club_invite is not capability-gated at all, per the same
-- reasoning applied to every other continuity path.
--
-- NON-RECURSIVE RLS: events and event_participants (and, separately,
-- programs and program_enrollments) each already depend on the other via a
-- one-directional exists() subquery from the participant/enrollment side
-- (unchanged, still true after this migration). Adding an own-
-- participation/own-enrollment check to the OTHER side (events, programs)
-- via a plain subquery would create a second, opposite-direction
-- dependency — mutual RLS recursion. Instead, events and programs consult
-- new SECURITY DEFINER helpers (current_user_participates_in_event,
-- current_user_enrolled_in_program) that read event_participants /
-- program_enrollments directly, bypassing THEIR OWN RLS internally (the
-- same bypass mechanism every existing current_user_*() helper in this
-- schema already relies on), so no policy ever gets re-evaluated as part
-- of resolving another policy. See Section 1 below for the full argument.
--
-- set_club_tier_for_operator (0122) is amended (CREATE OR REPLACE, same
-- signature, same existing body) to also bulk-revoke outstanding
-- (unaccepted, unrevoked) Member-role invitations when transitioning a
-- club to staff_managed — Admin/Pro invites and any already-accepted or
-- historical invite are untouched. The tier/entitlement write and the
-- invite revoke happen in the same function body, so a downgrade cannot
-- leave a club in a state where the tier changed but a Member invite it
-- should have revoked did not.
--
-- Not applied by this checkpoint. Not committed. Does not modify
-- 0107-0122. courts_select_same_club, program_schedule_rules_select_
-- same_club, program_rule_courts_select_same_club, program_enrollments_
-- select, and lesson_requests_select_* are all left unchanged — the first
-- is safe basic metadata, the middle two inherit correct behavior
-- automatically through their existing one-directional dependency on
-- programs, and the last two are already own-row scoped and are
-- deliberately not broadened.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Non-recursive helper functions.
--
-- Both are SECURITY DEFINER, STABLE, fixed search_path, revoked from
-- public/anon, granted to authenticated. The authenticated grant is
-- required (not merely internal-only, unlike club_has_capability) because
-- an RLS policy's USING clause is evaluated as the querying role itself
-- (authenticated, via PostgREST) — the function must be directly callable
-- by that role for the policy to succeed. This is safe here, unlike
-- club_has_capability, because neither function accepts a club_id or any
-- other cross-tenant-scoping argument: each only ever answers "does the
-- CALLING user (auth.uid() / their own current_user_roster_member_id())
-- participate in/enrolled in THIS SPECIFIC event/program row" — there is
-- no arbitrary-club probing surface.
--
-- Non-recursion argument: event_participants_select_same_club (Section 2)
-- depends on events via a plain exists() subquery (unchanged, one-
-- directional, as it has been since 0004). events_select_same_club
-- (Section 2) depends on event_participants only through this helper
-- function's OWN internal query — which runs as the function's owning
-- role (a bypassing role, the same mechanism current_user_club_id(),
-- current_user_role(), and current_user_roster_member_id() already rely
-- on), so it never triggers event_participants' RLS policy at all, let
-- alone recursively. The call chain terminates in one hop:
-- event_participants policy -> (subquery) -> events policy -> (function
-- call) -> raw bypassed read of event_participants. No policy is ever
-- evaluated twice in the same chain. The identical argument applies to
-- programs / program_enrollments / current_user_enrolled_in_program.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.current_user_participates_in_event(p_event_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.event_participants ep
     where ep.event_id = p_event_id
       and (
         ep.profile_id = auth.uid()
         or ep.roster_member_id = public.current_user_roster_member_id()
       )
  );
$$;

revoke execute on function public.current_user_participates_in_event(uuid) from public, anon;
grant  execute on function public.current_user_participates_in_event(uuid) to authenticated;


create or replace function public.current_user_enrolled_in_program(p_program_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.program_enrollments pe
     where pe.program_id = p_program_id
       and (
         pe.profile_id = auth.uid()
         or pe.roster_member_id = public.current_user_roster_member_id()
       )
  );
$$;

revoke execute on function public.current_user_enrolled_in_program(uuid) from public, anon;
grant  execute on function public.current_user_enrolled_in_program(uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Capability-aware SELECT policies.
--
-- Every replacement keeps the original club-scoping term (club_id =
-- current_user_club_id(), or the equivalent one-hop exists() for
-- event_participants) as an unconditional prerequisite, then ORs in three
-- cases: Admin/Pro (unaffected invariant), Connected (member_self_service
-- = true, matches today's club-wide read exactly), Staff-Managed Member
-- (own row / own participation / own enrollment via BOTH the profile-based
-- and durable roster identity paths — a claimed Member's pre-claim,
-- staff-created row has no profile_id/owner_user_id set, only
-- roster_member_id, so both must be checked or My Schedule and this
-- policy would silently disagree).
-- ═══════════════════════════════════════════════════════════════════════════

drop policy if exists "reservations_select_same_club" on reservations;
create policy "reservations_select_same_club"
  on reservations for select
  using (
    club_id = current_user_club_id()
    and (
      current_user_role() in ('admin', 'pro')
      or current_club_has_capability('member_self_service')
      or owner_user_id = auth.uid()
      or roster_member_id = current_user_roster_member_id()
    )
  );

drop policy if exists "events_select_same_club" on events;
create policy "events_select_same_club"
  on events for select
  using (
    club_id = current_user_club_id()
    and (
      current_user_role() in ('admin', 'pro')
      or current_club_has_capability('member_self_service')
      or current_user_participates_in_event(id)
    )
  );

drop policy if exists "event_participants_select_same_club" on event_participants;
create policy "event_participants_select_same_club"
  on event_participants for select
  using (
    exists (
      select 1 from events
      where events.id        = event_participants.event_id
        and events.club_id   = current_user_club_id()
    )
    and (
      current_user_role() in ('admin', 'pro')
      or current_club_has_capability('member_self_service')
      or profile_id = auth.uid()
      or roster_member_id = current_user_roster_member_id()
    )
  );

drop policy if exists "programs_select_same_club" on public.programs;
create policy "programs_select_same_club"
  on public.programs for select
  using (
    club_id = public.current_user_club_id()
    and (
      current_user_role() in ('admin', 'pro')
      or current_club_has_capability('member_self_service')
      or current_user_enrolled_in_program(id)
    )
  );


-- ═══════════════════════════════════════════════════════════════════════════
-- 2B. Direct-INSERT entitlement gate — reservations_insert_own.
--
-- Latest effective definition: 0003_reservations.sql (never redefined
-- since). Gating create_reservation (Section 3 below) is not sufficient on
-- its own: reservations_insert_own's WITH CHECK already permits an
-- authenticated client to INSERT a reason='member_booking' row directly
-- via PostgREST, entirely bypassing the RPC. 0108's
-- reservations_member_booking_identity_guard trigger (unchanged, not
-- touched here) only verifies the roster_member_id/owner_user_id identity
-- pairing on such a direct insert — it has no concept of entitlement and
-- was never meant to — so a Staff-Managed Member who resolves their own
-- current_user_roster_member_id() (an authenticated-callable RPC) could
-- still satisfy both the policy and the trigger and insert a booking
-- directly, exactly as if create_reservation's own new gate did not exist.
--
-- Fix: add the same three-way capability condition used by the Section 2
-- SELECT policies to this INSERT policy's WITH CHECK, ANDed alongside
-- every one of its four original requirements (all four preserved
-- verbatim, none loosened or removed). Admin/Pro direct-insert is
-- unaffected (create_reservation itself writes reason='member_booking'
-- regardless of caller role, so admin/pro must retain this direct path
-- exactly as today). Connected Member direct-insert is unaffected
-- (member_self_service=true). Staff-Managed Member direct-insert is
-- rejected by RLS itself, independent of and in addition to
-- create_reservation's own RPC-layer gate.
-- ═══════════════════════════════════════════════════════════════════════════
drop policy if exists "reservations_insert_own" on reservations;
create policy "reservations_insert_own"
  on reservations for insert
  with check (
    owner_user_id = auth.uid()
    and created_by   = auth.uid()
    and reason       = 'member_booking'
    and club_id      = current_user_club_id()
    and (
      current_user_role() in ('admin', 'pro')
      or current_club_has_capability('member_self_service')
    )
  );


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Self-service entry RPCs — each gets exactly one inserted conditional,
-- placed immediately after the existing account_inactive / not_authenticated
-- guard and before any identity resolution, mirroring create_reservation's
-- pre-existing "role = 'member'" conditional pattern for outside_booking_
-- window. Every other line below is reproduced byte-for-byte from the
-- latest effective body (confirmed via direct read of the migration that
-- last defined each function, immediately before writing this file — see
-- the accompanying report for exact source citations). The gate is
-- conditional on role = 'member' specifically so Admin/Pro self-service
-- (an Admin booking a court for themselves, a Pro requesting a lesson from
-- another Pro) is never blocked, matching the Admin/Pro invariant.
-- ═══════════════════════════════════════════════════════════════════════════

-- create_reservation — latest effective body: 0108_staff_managed_
-- reservations_identity.sql.
create or replace function public.create_reservation(
  p_court_id     uuid,
  p_starts_at    timestamptz,
  p_ends_at      timestamptz,
  p_format       text    default null,
  p_player_count int     default null,
  p_guest_names  text[]  default null,
  p_notes        text    default null
)
returns reservations
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile           profiles%rowtype;
  v_settings          club_settings%rowtype;
  v_court              courts%rowtype;
  v_tz                  text;
  v_date                date;                             -- Phase 17A: local booking date
  v_override            operating_hours_override%rowtype;  -- Phase 17A: date-specific override
  v_dow                 int;
  v_hours               operating_hours%rowtype;
  v_result              reservations%rowtype;
  -- Phase 33C1: the caller's own durable Member identity for this club.
  v_roster_member_id    uuid;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_profile.status <> 'active' then raise exception 'account_inactive'; end if;

  -- Phase 33F3B: Staff-Managed Members may not book a NEW court reservation.
  -- Never gates Admin/Pro self-booking.
  if v_profile.role = 'member' and not current_club_has_capability('member_self_service') then
    raise exception 'capability_not_available';
  end if;

  -- Phase 33C1: resolve the caller's own roster identity in this club.
  -- Never client-supplied — auth.uid() and v_profile.club_id are both
  -- server-derived, exactly like every other identity resolution in this
  -- function. A member can never specify another person's identity here;
  -- this only ever resolves the CALLER's own roster row. Fails closed:
  -- every active club member is expected to have one (Phase 33B1's own
  -- backfill plus accept_club_invite's fail-closed roster resolution both
  -- guarantee this for anyone who could reach this point), so this should
  -- never legitimately raise — it is verified, not assumed.
  select id into v_roster_member_id
    from roster_members
   where club_id    = v_profile.club_id
     and claimed_by = auth.uid();
  if not found then raise exception 'no_roster_identity'; end if;

  select * into v_court
    from courts
    where id        = p_court_id
      and club_id   = v_profile.club_id
      and is_active = true;
  if not found then raise exception 'court_not_found'; end if;

  select * into v_settings from club_settings where club_id = v_profile.club_id;

  select timezone into v_tz from clubs where id = v_profile.club_id;

  -- Past-date guard: applies to all roles. Admins and pros may not book in the past.
  if p_starts_at < now() then
    raise exception 'cannot_book_past';
  end if;

  -- Booking-window guard: members only. Admins and pros may book beyond the window.
  if v_profile.role = 'member'
     and p_starts_at > now() + (v_settings.booking_window_days || ' days')::interval then
    raise exception 'outside_booking_window';
  end if;

  if p_ends_at <= p_starts_at then
    raise exception 'invalid_duration';
  end if;

  -- Phase 20D-B: member court reservations must use one of the supported durations.
  if extract(epoch from (p_ends_at - p_starts_at)) / 60 not in (30, 60, 90, 120) then
    raise exception 'invalid_duration';
  end if;

  -- ---------------------------------------------------------------------------
  -- Phase 17A: check for a date-specific override before falling back to the
  -- weekly operating_hours. The override lookup uses the club-local calendar
  -- date (v_date) derived from the booking's starts_at timestamp.
  -- ---------------------------------------------------------------------------
  v_date := (p_starts_at at time zone v_tz)::date;
  v_dow  := extract(dow from p_starts_at at time zone v_tz)::int;

  select * into v_override
    from operating_hours_override
    where club_id       = v_profile.club_id
      and override_date = v_date;

  if found then
    -- An override exists for this date — it takes priority over weekly hours.
    if v_override.is_closed then
      raise exception 'club_closed_this_day';
    end if;
    -- When special hours are set, reject bookings that fall outside them.
    if v_override.opens_at is not null and v_override.closes_at is not null then
      if (p_starts_at at time zone v_tz)::time < v_override.opens_at
         or (p_ends_at at time zone v_tz)::time > v_override.closes_at then
        raise exception 'outside_operating_hours';
      end if;
    end if;
    -- Override exists and booking is within bounds; skip the weekly check below.
  else
    -- No override for this date — apply normal weekly operating_hours.
    select * into v_hours
      from operating_hours
      where club_id     = v_profile.club_id
        and day_of_week = v_dow;

    if not found or v_hours.is_closed then
      raise exception 'club_closed_this_day';
    end if;

    if (p_starts_at at time zone v_tz)::time < v_hours.opens_at
       or (p_ends_at at time zone v_tz)::time > v_hours.closes_at then
      raise exception 'outside_operating_hours';
    end if;
  end if;
  -- ---------------------------------------------------------------------------

  insert into reservations (
    club_id, court_id, owner_user_id, roster_member_id,
    starts_at, ends_at, status, reason,
    format, player_count, guest_names, notes, created_by
  ) values (
    v_profile.club_id, p_court_id, auth.uid(), v_roster_member_id,
    p_starts_at, p_ends_at, 'confirmed', 'member_booking',
    p_format, p_player_count, p_guest_names, p_notes, auth.uid()
  )
  returning * into v_result;

  -- Phase 16F: only insert the in-app notification if the member has this kind enabled.
  -- Unchanged from the currently-effective (0059) body — not touched by 33C1.
  if user_pref_enabled(auth.uid(), 'reservation_confirmed') then
    insert into notifications (club_id, user_id, kind, body, metadata)
    values (
      v_profile.club_id,
      auth.uid(),
      'reservation_confirmed',
      v_court.name || ' booked for '
        || to_char(p_starts_at at time zone v_tz, 'Mon DD "at" HH12:MI AM'),
      jsonb_build_object('reservation_id', v_result.id, 'court_id', p_court_id)
    );
  end if;

  return v_result;
end;
$$;


-- join_event — latest effective body: 0117_durable_member_guest_lifecycle_
-- and_attendance.sql.
create or replace function join_event(p_event_id uuid)
returns event_participants
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile  profiles%rowtype;
  v_event    events%rowtype;
  v_existing event_participants%rowtype;
  v_existing_found boolean;
  v_count    int;
  v_result   event_participants%rowtype;
  v_roster_member_id uuid;
begin
  select * into v_profile from profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;

  if v_profile.status <> 'active' then raise exception 'account_inactive'; end if;

  -- Phase 33F3B: Staff-Managed Members may not newly join an Event. Never
  -- gates Admin/Pro self-joining.
  if v_profile.role = 'member' and not current_club_has_capability('member_self_service') then
    raise exception 'capability_not_available';
  end if;

  select * into v_event
    from events
    where id      = p_event_id
      and club_id = v_profile.club_id
      and status  = 'scheduled';
  if not found then raise exception 'event_not_found'; end if;

  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

  if not v_event.member_joinable then
    raise exception 'event_not_joinable';
  end if;

  if v_event.starts_at < now() then
    raise exception 'event_already_started';
  end if;

  select id into v_roster_member_id
    from roster_members
   where club_id    = v_profile.club_id
     and claimed_by = auth.uid();
  if not found then
    raise exception 'phase33d2_unresolved_member_identity';
  end if;

  perform expire_stale_offers_for_event(p_event_id, v_profile.club_id, v_event.title);
  perform advance_waitlist_offer(p_event_id, v_profile.club_id, v_event.title);

  select * into v_existing
    from event_participants
   where event_id = p_event_id
     and (profile_id = auth.uid() or roster_member_id = v_roster_member_id)
   for update;
  v_existing_found := found;

  if v_existing_found and v_existing.status in ('confirmed', 'waitlisted', 'offered') then
    raise exception 'already_joined';
  end if;

  select
    (select count(*)
       from event_participants
       where event_id = p_event_id
         and status   in ('confirmed', 'offered')
         and role     = 'participant')
    +
    (select count(*)
       from event_guests
       where event_id = p_event_id
         and status   = 'active')
    into v_count;

  if v_count >= v_event.capacity then
    if v_existing_found then
      update event_participants
         set status = 'waitlisted', profile_id = auth.uid(), roster_member_id = v_roster_member_id, updated_at = now()
       where id = v_existing.id
      returning * into v_result;
    else
      insert into event_participants (event_id, profile_id, roster_member_id, role, status)
      values (p_event_id, auth.uid(), v_roster_member_id, 'participant', 'waitlisted')
      returning * into v_result;
    end if;

    if v_result.id is null then
      raise exception 'event_participant_write_failed';
    end if;
  else
    if v_existing_found then
      update event_participants
         set status = 'confirmed', profile_id = auth.uid(), roster_member_id = v_roster_member_id, updated_at = now()
       where id = v_existing.id
      returning * into v_result;
    else
      insert into event_participants (event_id, profile_id, roster_member_id, role, status)
      values (p_event_id, auth.uid(), v_roster_member_id, 'participant', 'confirmed')
      returning * into v_result;
    end if;

    if v_result.id is null then
      raise exception 'event_participant_write_failed';
    end if;

    if user_pref_enabled(auth.uid(), 'event_joined') then
      insert into notifications (club_id, user_id, kind, body, metadata)
      values (
        v_profile.club_id,
        auth.uid(),
        'event_joined',
        'You''ve joined "' || v_event.title || '".',
        jsonb_build_object('event_id', p_event_id)
      );
    end if;
  end if;

  return v_result;
end;
$$;


-- join_program — latest effective body: 0115_program_enrollment_identity.sql.
create or replace function public.join_program(p_program_id uuid)
returns public.program_enrollments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id  uuid;
  v_role     text;
  v_roster_member_id uuid;
  v_program  public.programs%rowtype;
  v_existing public.program_enrollments%rowtype;
  v_existing_found boolean;
  v_count    int;
  v_new_status text;
  v_result   public.program_enrollments%rowtype;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;
  if v_club_id is null then raise exception 'not_authenticated'; end if;

  -- Phase 33F3B: Staff-Managed Members may not newly join a Program. Never
  -- gates Admin/Pro self-enrollment.
  if v_role = 'member' and not public.current_club_has_capability('member_self_service') then
    raise exception 'capability_not_available';
  end if;

  -- Phase 33D2b: resolve the caller's own durable roster identity once,
  -- fail closed — mirrors join_event's identical guard (0113/0114).
  v_roster_member_id := public.current_user_roster_member_id();
  if v_roster_member_id is null then
    raise exception 'phase33d2_unresolved_member_identity';
  end if;

  select * into v_program
    from public.programs
    where id = p_program_id and club_id = v_club_id
    for update;
  if not found then raise exception 'program_not_found'; end if;

  if v_program.enrollment_model <> 'program' then
    raise exception 'program_not_whole_enrollment';
  end if;

  if not public._program_is_enrollable(v_program) then
    raise exception 'program_not_enrollable';
  end if;

  -- Idempotent fast path for an already-enrolled member — no state
  -- change, no audit entry, matching the pre-0115 body's own precedent.
  -- Phase 33D2b: matched via profile_id OR roster_member_id, so a claimed
  -- Member whose pre-claim enrollment was staff-added is recognized here
  -- too.
  select * into v_existing
    from public.program_enrollments
    where program_id = p_program_id
      and (profile_id = auth.uid() or roster_member_id = v_roster_member_id);
  if found and v_existing.status = 'enrolled' then
    return v_existing;
  end if;

  perform public._expire_stale_program_offers(p_program_id, v_club_id, v_program.title);
  perform public._advance_program_waitlist_offer(p_program_id, v_club_id, v_program.title);

  -- Re-read after expiry/promotion may have changed this caller's own row.
  -- Phase 33D2b hotfix-in-advance: FOR UPDATE + immediate FOUND capture —
  -- the capacity aggregate below issues its own SELECT INTO and would
  -- otherwise silently overwrite a bare FOUND before the write branch
  -- reads it (the exact 0113 bug class).
  select * into v_existing
    from public.program_enrollments
    where program_id = p_program_id
      and (profile_id = auth.uid() or roster_member_id = v_roster_member_id)
    for update;
  v_existing_found := found;

  if v_existing_found and v_existing.status in ('waitlisted', 'offered') then
    raise exception 'already_enrolled';
  end if;

  select count(*) into v_count
    from public.program_enrollments
    where program_id = p_program_id
      and status     in ('enrolled', 'offered');

  -- Queue-bypass guard: unchanged from the pre-0115 body — a brand-new
  -- caller must never enroll ahead of anyone already waitlisted, even if
  -- raw capacity looks open.
  if v_count >= v_program.default_capacity or exists (
    select 1 from public.program_enrollments
    where program_id = p_program_id and status = 'waitlisted'
  ) then
    v_new_status := 'waitlisted';
  else
    v_new_status := 'enrolled';
  end if;

  if v_existing_found then
    update public.program_enrollments
       set status           = v_new_status,
           profile_id       = auth.uid(),
           roster_member_id = v_roster_member_id,
           offer_expires_at = null,
           waitlisted_at    = case when v_new_status = 'waitlisted' then now() else null end,
           updated_at       = now()
     where id = v_existing.id
    returning * into v_result;
  else
    insert into public.program_enrollments (program_id, profile_id, roster_member_id, status, waitlisted_at)
    values (
      p_program_id, auth.uid(), v_roster_member_id, v_new_status,
      case when v_new_status = 'waitlisted' then now() else null end
    )
    returning * into v_result;
  end if;

  -- Phase 33D2b hotfix-in-advance: fail closed before any success side
  -- effect or return.
  if v_result.id is null then
    raise exception 'program_enrollment_write_failed';
  end if;

  if v_new_status = 'enrolled' then
    perform public._materialize_program_member_into_future_events(p_program_id, v_roster_member_id, v_club_id);
  end if;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'join_program', 'program', p_program_id,
    jsonb_build_object('status', v_result.status, 'actor_role', v_role)
  );

  return v_result;
end;
$$;

revoke execute on function public.join_program(uuid) from public, anon;
grant  execute on function public.join_program(uuid) to authenticated;


-- submit_lesson_request — latest effective body: 0111_staff_managed_lessons_
-- identity.sql.
create or replace function public.submit_lesson_request(
  p_pro_id             uuid,
  p_duration_minutes   int,
  p_preferred_court_id uuid    default null,
  p_member_note        text    default null,
  p_preferred_windows  jsonb   default null,
  p_lesson_type_id     uuid    default null
)
returns public.lesson_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile           public.profiles%rowtype;
  v_pro                public.profiles%rowtype;
  v_result             public.lesson_requests%rowtype;
  -- Phase 33D1: the caller's own durable Member identity for this club.
  v_roster_member_id   uuid;
begin
  select * into v_profile from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.club_id is null then raise exception 'no_club'; end if;
  if v_profile.status <> 'active' then raise exception 'account_inactive'; end if;

  -- Phase 33F3B: Staff-Managed Members may not submit a NEW lesson request.
  -- Never gates Admin/Pro self-request.
  if v_profile.role = 'member' and not public.current_club_has_capability('member_self_service') then
    raise exception 'capability_not_available';
  end if;

  -- Phase 33D1: resolve the caller's own roster identity in this club.
  -- Never client-supplied — auth.uid() and v_profile.club_id are both
  -- server-derived, matching create_reservation's identical 0108 pattern.
  -- Fails closed: every active club member is expected to have one after
  -- 33B1's backfill and accept_club_invite's fail-closed roster
  -- resolution, so this should never legitimately raise.
  select id into v_roster_member_id
    from public.roster_members
   where club_id    = v_profile.club_id
     and claimed_by = auth.uid();
  if not found then raise exception 'no_roster_identity'; end if;

  -- Validate pro: active, same club, role pro or admin, is_lesson_provider = true
  select * into v_pro
    from public.profiles
   where id      = p_pro_id
     and club_id = v_profile.club_id
     and status  = 'active'
     and role    in ('pro', 'admin')
     and is_lesson_provider = true;
  if not found then raise exception 'pro_not_found'; end if;

  if p_pro_id = auth.uid() then raise exception 'cannot_request_yourself'; end if;

  -- Duration: positive multiple of 15 minutes, minimum 30
  if p_duration_minutes < 30 or p_duration_minutes % 15 <> 0 then
    raise exception 'invalid_duration';
  end if;

  -- Input length validation
  if length(p_member_note) > 500 then raise exception 'note_too_long'; end if;

  -- Validate optional preferred court
  if p_preferred_court_id is not null and not exists (
    select 1 from public.courts
     where id       = p_preferred_court_id
       and club_id  = v_profile.club_id
       and is_active = true
  ) then
    raise exception 'court_not_found';
  end if;

  -- Validate optional lesson type (active, same club)
  if p_lesson_type_id is not null then
    if not exists (
      select 1 from public.lesson_types
       where id       = p_lesson_type_id
         and club_id  = v_profile.club_id
         and is_active = true
    ) then
      raise exception 'lesson_type_not_found';
    end if;

    -- Enforce that requested duration is among the type's allowed durations (when set)
    if exists (
      select 1 from public.lesson_types lt
       where lt.id            = p_lesson_type_id
         and lt.allowed_durations is not null
         and array_length(lt.allowed_durations, 1) > 0
         and not (p_duration_minutes = any(lt.allowed_durations))
    ) then
      raise exception 'duration_not_allowed_for_type';
    end if;
  end if;

  insert into public.lesson_requests (
    club_id, member_id, pro_id, roster_member_id,
    preferred_court_id, duration_minutes,
    member_note, preferred_windows, status,
    lesson_type_id,
    last_actor_id, last_actor_role
  ) values (
    v_profile.club_id,
    auth.uid(),
    p_pro_id,
    v_roster_member_id,
    p_preferred_court_id,
    p_duration_minutes,
    btrim(coalesce(p_member_note, '')),
    p_preferred_windows,
    'pending',
    p_lesson_type_id,
    auth.uid(), 'member'
  ) returning * into v_result;

  insert into public.notifications (club_id, user_id, kind, body, metadata)
  values (
    v_profile.club_id,
    p_pro_id,
    'lesson_request_received',
    trim(coalesce(v_profile.first_name, '') || ' ' || coalesce(v_profile.last_name, '')) ||
      ' has requested a ' || p_duration_minutes || '-minute lesson.',
    jsonb_build_object('request_id', v_result.id, 'target_path', '/events?tab=lessons')
  );

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id, auth.uid(), 'submit_lesson_request', 'lesson_request', v_result.id,
    jsonb_build_object('pro_id', p_pro_id, 'duration_minutes', p_duration_minutes, 'roster_member_id', v_roster_member_id)
  );

  return v_result;
end;
$$;

revoke execute on function public.submit_lesson_request(uuid, int, uuid, text, jsonb, uuid) from public, anon;
grant  execute on function public.submit_lesson_request(uuid, int, uuid, text, jsonb, uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Member invitation gate — latest effective body: 0117_durable_member_
-- guest_lifecycle_and_attendance.sql. resend_club_invite (same migration,
-- unchanged, not reproduced here) is NOT separately gated: it calls
-- public.create_club_invite(...) internally to perform the actual insert
-- (see its own body), so gating create_club_invite already covers a
-- resend of a Member-role invite. Admin/Pro invite creation and resend
-- remain fully unaffected — the gate is conditional on p_role = 'member'.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.create_club_invite(
  p_role             text,
  p_roster_member_id uuid,
  p_expires_at       timestamptz default now() + interval '7 days'
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile   public.profiles%rowtype;
  v_roster    public.roster_members%rowtype;
  v_invite_id uuid;
  v_code      text;
begin
  select * into v_profile from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.role <> 'admin' then raise exception 'insufficient_role'; end if;
  if v_profile.club_id is null then raise exception 'no_club'; end if;

  if p_role not in ('member', 'pro', 'admin') then
    raise exception 'invalid_role';
  end if;

  -- Phase 33F3B: a Staff-Managed club may not create a NEW Member-role
  -- invitation. Admin/Pro invitations are unaffected.
  if p_role = 'member' and not public.current_club_has_capability('member_self_service') then
    raise exception 'capability_not_available';
  end if;

  if p_roster_member_id is null then
    raise exception 'roster_identity_required';
  end if;

  select * into v_roster
    from public.roster_members
   where id      = p_roster_member_id
     and club_id = v_profile.club_id
   for update;
  if not found                       then raise exception 'roster_member_not_found';         end if;
  if v_roster.claimed_by is not null then raise exception 'roster_member_already_claimed';   end if;
  if v_roster.email is null          then raise exception 'roster_email_required';           end if;
  -- Phase 33E2-correction: an inactive roster identity is not eligible for
  -- invitation.
  if v_roster.status is distinct from 'active' then raise exception 'roster_member_inactive'; end if;

  -- One active pending invite per roster identity at a time. resend_club_
  -- invite always revokes the old one first (in the same transaction), so
  -- this only ever blocks a genuine duplicate attempt, never the normal
  -- resend path.
  if exists (
    select 1 from public.club_invites
     where roster_member_id = p_roster_member_id
       and accepted_at is null
       and revoked_at  is null
       and expires_at  > now()
  ) then
    raise exception 'invite_already_pending';
  end if;

  insert into public.club_invites (club_id, role, email, roster_member_id, created_by, expires_at)
  values (
    v_profile.club_id,
    p_role,
    v_roster.email,
    p_roster_member_id,
    auth.uid(),
    p_expires_at
  )
  returning id, code into v_invite_id, v_code;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'create_invite',
    'club_invite',
    v_invite_id,
    jsonb_build_object('role', p_role, 'roster_member_id', p_roster_member_id, 'expires_at', p_expires_at)
  );

  return v_code;
end;
$$;

revoke execute on function public.create_club_invite(text, uuid, timestamptz) from public, anon;
grant  execute on function public.create_club_invite(text, uuid, timestamptz) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 5. set_club_tier_for_operator — CREATE OR REPLACE, same signature, same
-- existing body (0122, unmodified in this file — 0122 itself is not
-- edited), plus one addition: transitioning to staff_managed now also
-- bulk-revokes every outstanding (unaccepted, unrevoked) Member-role
-- invitation for that club, in the same function body/transaction as the
-- tier and entitlement write. Admin/Pro invites, and any already-accepted
-- or already-revoked invite of any role, are untouched. No existing
-- Member account, Reservation, Lesson, Event, or Program is modified.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.set_club_tier_for_operator(
  p_club_id uuid,
  p_tier    text
)
returns table (
  club_id uuid,
  tier    text,
  status  text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_exists        boolean;
  v_active_entitlement public.club_entitlements%rowtype;
  v_entitlement_found  boolean;
begin
  if p_tier not in ('staff_managed', 'connected') then
    raise exception 'invalid_tier';
  end if;

  select exists(select 1 from public.clubs where id = p_club_id) into v_club_exists;
  if not v_club_exists then
    raise exception 'club_not_found';
  end if;

  insert into public.club_subscriptions (club_id, tier, status, source)
  values (p_club_id, p_tier, 'active', 'manual_pilot')
  on conflict (club_id) do update
    set tier       = excluded.tier,
        status     = excluded.status,
        source     = excluded.source,
        updated_at = now();

  select ce.* into v_active_entitlement
    from public.club_entitlements ce
   where ce.club_id     = p_club_id
     and ce.capability  = 'member_self_service'
     and ce.revoked_at is null;
  v_entitlement_found := found;

  if p_tier = 'connected' then
    if not v_entitlement_found or not v_active_entitlement.enabled then
      if v_entitlement_found then
        update public.club_entitlements
           set revoked_at = now()
         where id = v_active_entitlement.id;
      end if;

      insert into public.club_entitlements (club_id, capability, enabled, granted_by, note)
      values (
        p_club_id, 'member_self_service', true, null,
        'Granted via set_club_tier_for_operator (manual_pilot).'
      );
    end if;
  else
    -- staff_managed: revoke the active grant if one exists. Never inserts
    -- a "disabled" row — absence of an active row already means false
    -- (club_has_capability's own fail-closed default), so there is
    -- nothing to represent beyond the revocation itself.
    if v_entitlement_found and v_active_entitlement.enabled then
      update public.club_entitlements
         set revoked_at = now()
       where id = v_active_entitlement.id;
    end if;

    -- Phase 33F3B: revoke every outstanding Member-role invitation for
    -- this club — never Admin/Pro invites, never an already-accepted or
    -- already-revoked invite of any role (the WHERE clause naturally
    -- excludes both by only matching rows still eligible to be accepted).
    update public.club_invites
       set revoked_at = now()
     where club_id     = p_club_id
       and role        = 'member'
       and accepted_at is null
       and revoked_at  is null;
  end if;

  return query
    select cs.club_id, cs.tier, cs.status
    from public.club_subscriptions cs
    where cs.club_id = p_club_id;
end;
$$;

revoke execute on function public.set_club_tier_for_operator(uuid, text) from public, anon, authenticated;
grant  execute on function public.set_club_tier_for_operator(uuid, text) to service_role;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration created in
-- this checkpoint)
-- ═══════════════════════════════════════════════════════════════════════════
-- Functions — restore the prior CREATE OR REPLACE body from its cited
-- source migration (no gate/no invite-revoke block):
--   `create_reservation`            -> supabase/migrations/0108_staff_managed_reservations_identity.sql
--   `join_event`                    -> supabase/migrations/0117_durable_member_guest_lifecycle_and_attendance.sql
--   `join_program`                  -> supabase/migrations/0115_program_enrollment_identity.sql
--   `submit_lesson_request`         -> supabase/migrations/0111_staff_managed_lessons_identity.sql
--   `create_club_invite`            -> supabase/migrations/0117_durable_member_guest_lifecycle_and_attendance.sql
--   `set_club_tier_for_operator`    -> supabase/migrations/0122_entitlement_foundation.sql
-- New helper functions — safe to drop, nothing else in the schema depends
-- on them once the Section 2 policies below are reverted first:
--   `drop function if exists public.current_user_participates_in_event(uuid);`
--   `drop function if exists public.current_user_enrolled_in_program(uuid);`
-- Policies — restore the prior definition from its cited source migration
-- (drop this file's version first, in this order, then recreate):
--   `reservations_select_same_club`            -> supabase/migrations/0003_reservations.sql
--   `events_select_same_club`                  -> supabase/migrations/0004_events.sql
--   `event_participants_select_same_club`      -> supabase/migrations/0004_events.sql
--   `programs_select_same_club`                -> supabase/migrations/0087_programs_schema_foundation.sql
--   `reservations_insert_own`                  -> supabase/migrations/0003_reservations.sql
