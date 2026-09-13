-- 0180_admin_reassign_confirmed_lesson_pro.sql
-- Phase 38A — Admin/Staff Confirmed-Lesson Pro Reassignment.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 38A's architecture audit found reassign_lesson_provider (latest:
-- 0132) deliberately restricted to 'pending'/first-time-'proposed' requests
-- only (it resets status to 'pending' and clears the proposed schedule —
-- correct for "start negotiation over", structurally wrong for a lesson
-- that is already confirmed and scheduled). admin_update_member_lesson
-- (latest: 0138) CAN change pro_id on a confirmed lesson, but is deliberately
-- restricted to a no-account (unclaimed) Member's lesson only — it is the
-- "direct edit, no negotiation" answer to the one case the propose/accept
-- cycle cannot serve, per its own header comment ("reassign_lesson_provider
-- is NOT broadened to confirmed lessons by this migration — its existing
-- pending/proposed-only boundary is deliberate").
--
-- Net result: there was no path at all for Admin/Staff to change the
-- assigned Pro on a CLAIMED Member's confirmed lesson. This migration adds
-- exactly one new, narrow function to close that gap — it does not modify
-- reassign_lesson_provider or admin_update_member_lesson, and does not
-- touch payments, pricing, refunds, or any schema/table/column.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- LOCKED PRODUCT DECISIONS (Phase 38A)
-- ═══════════════════════════════════════════════════════════════════════════
--   - Admin AND Staff may reassign the Pro for a FUTURE confirmed lesson.
--     Pro may never reassign (self or another Pro) — this function has no
--     Pro-caller path at all, matching reassign_lesson_provider's own
--     precedent.
--   - An already-started lesson may not be reassigned (mirrors
--     admin_update_member_lesson's/propose_lesson_time's identical
--     cannot_reschedule_started_lesson guard).
--   - ONLY pro_id (lesson_requests) / owner_user_id (the linked reservation)
--     change. Member, court, starts_at, ends_at, duration, and lesson_type
--     are never touched by this function — they are not even parameters.
--     Since scheduling never changes, the existing reservation row is
--     updated IN PLACE (no soft-cancel-and-reinsert) — same reservation id,
--     same court/time, so payments (keyed on domain_type='lesson_request',
--     domain_id=lesson_requests.id — confirmed by direct reading of
--     cancel_lesson's own payment lookup) are structurally unreachable by
--     this function; it never queries or writes public.payments at all.
--   - New Pro must be active, same-club, role in ('pro','admin','staff'),
--     is_lesson_provider = true. Validated against public.club_memberships
--     (the canonical per-(user, club) source since Phase 26B2), scoped to
--     THIS lesson's club — never the target's currently active club — so a
--     Pro who belongs to more than one club is correctly evaluated on their
--     membership in the lesson's own club, matching the fix already applied
--     to send_announcement_v2 (0177) for the identical class of bug.
--     Deliberately NOT the same profiles-based query reassign_lesson_
--     provider/admin_update_member_lesson/get_admin_club_pros use — those
--     are pre-existing, already-applied migrations left unmodified.
--   - New Pro's availability at the lesson's existing (unchanged) time is
--     re-checked via a NEW private helper,
--     _lesson_check_pro_availability_for_club(p_pro_id, p_club_id,
--     p_starts_at, p_ends_at, p_exclude_request_id) — see the follow-up
--     correction below for why this is a new function rather than reusing
--     _lesson_check_pro_availability (0126, unmodified) directly.
--   - p_expected_updated_at optimistic-concurrency check — same pattern as
--     admin_update_member_lesson.
--   - Notifications reuse the existing 'lesson_provider_reassigned' kind
--     (already defined, already used by reassign_lesson_provider) — to the
--     old Pro, the new Pro, and the Member's profiles row when member_id is
--     not null (a no-account Member has no user_id to notify in-app; the
--     calling Server Action sends the operational email directly to
--     roster_members.email instead, mirroring cancelLesson's own no-account
--     branch — this migration does not need to special-case that at all,
--     since v_result.roster_member_id is already part of `returning *`).
--   - audit_log entry, same shape as reassign_lesson_provider's own
--     (old_pro_id/new_pro_id), new action value so it's distinguishable.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- MULTI-CLUB CORRECTION — availability/blackout validation (follow-up review)
-- ═══════════════════════════════════════════════════════════════════════════
-- The eligibility gate above was already corrected to read club_memberships
-- scoped to v_club_id (the lesson's own club), never the target Pro's
-- currently active club. But the ORIGINAL first draft of this migration
-- still called the existing _lesson_check_pro_availability(p_pro_id,
-- starts_at, ends_at, p_exclude_request_id) (0126) for the conflict/
-- blackout re-check — and that function derives ITS OWN club purely from
-- `select p.club_id into v_club_id from public.profiles p where p.id =
-- p_pro_id` — the exact same stale legacy projection the eligibility gate
-- was just corrected to stop trusting. For a multi-club Pro whose active
-- club differs from the lesson's club, this would validate blackout dates
-- using the WRONG club's timezone and the WRONG club's pro_blackout_dates
-- rows (that table is genuinely club-scoped — club_id not null, 0070) —
-- either wrongly blocking a valid reassignment (a blackout at their OTHER
-- club) or wrongly missing a real one (a blackout at THIS club never
-- checked because the wrong timezone/club was used to look it up).
--
-- Fix: a NEW private helper, _lesson_check_pro_availability_for_club(
-- p_pro_id, p_club_id, p_starts_at, p_ends_at, p_exclude_request_id),
-- reproducing _lesson_check_pro_availability's reservation/event conflict
-- checks VERBATIM (genuinely club-independent — a physical time conflict is
-- real regardless of which club either booking belongs to) but taking
-- p_club_id as an explicit parameter for the blackout check instead of
-- deriving it from the target's profile: both the timezone lookup and the
-- pro_blackout_dates row scan are filtered to p_club_id. A new function
-- was chosen over redefining _lesson_check_pro_availability directly
-- per instruction — that function is applied, stable, and has other
-- current callers (propose_lesson_time, admin_update_member_lesson,
-- accept_lesson_proposal) this checkpoint has no mandate to touch or
-- re-verify. Same-shaped precedent: send_announcement_v2 (0177) fixed the
-- identical class of bug (profiles legacy projection standing in for
-- verified club_memberships state) without touching any other caller.
--
-- Private/internal — SECURITY DEFINER, search_path pinned, EXECUTE revoked
-- from public/anon/authenticated (same posture as _current_user_active_
-- membership, 0082) since it is only ever invoked via `perform` from
-- another SECURITY DEFINER function owned by the same role; it never
-- becomes a new client-callable/browser capability.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- MULTI-CLUB CORRECTION — confirmed-reassignment provider picker
-- ═══════════════════════════════════════════════════════════════════════════
-- get_admin_club_pros (0132, unmodified) — the RPC the /admin/lessons and
-- /events UI already uses to populate every "New Pro" picker — also queries
-- public.profiles directly for club/status/role/is_lesson_provider, so a
-- valid Club A provider whose profile currently reflects Club B would never
-- even appear as an option, despite admin_reassign_confirmed_lesson_pro
-- above now correctly accepting them. Rather than broadening
-- get_admin_club_pros (which would also change the picker for
-- pending/proposed reassignment, lesson creation, and every other flow
-- still served by reassign_lesson_provider/admin_create_lesson_request —
-- RPCs that remain profiles-scoped and unmodified, and would then reject a
-- selection the broadened picker had offered), this migration adds a
-- SECOND, narrow, read-only RPC — get_confirmed_lesson_reassignment_pros()
-- — used ONLY by the confirmed-lesson reassignment mode. It sources
-- candidates from club_memberships scoped to current_user_club_id() (the
-- caller's own verified club), joined to profiles only for the global
-- identity fields (first_name/last_name) — the exact same club_memberships-
-- canonical shape admin_reassign_confirmed_lesson_pro's own eligibility
-- gate now uses. Admin/Staff only, matching get_admin_club_pros' own
-- caller gate exactly; Pro/Member obtain no new authority through it (they
-- are rejected before the query ever runs, identical to every other
-- operator-only lesson RPC in this schema).
--
-- Does not modify 0001-0179. No DROP of any existing function. Two new
-- functions added (one private helper, one public RPC) — no schema/table/
-- column/RLS/trigger change. Apply in Supabase SQL Editor (cloud only).
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- _lesson_check_pro_availability_for_club — new private helper (see
-- MULTI-CLUB CORRECTION header above). Reservation/event conflict checks
-- reproduced verbatim from _lesson_check_pro_availability (0126,
-- unmodified) — genuinely club-independent. Only the blackout check
-- differs: p_club_id (explicit, caller-verified) drives both the timezone
-- lookup and the pro_blackout_dates scope, never the target Pro's
-- profiles.club_id.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public._lesson_check_pro_availability_for_club(
  p_pro_id             uuid,
  p_club_id            uuid,
  p_starts_at          timestamptz,
  p_ends_at            timestamptz,
  p_exclude_request_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_conflict   int;
  v_range      tstzrange;
  v_tz         text;
  v_local_date date;
begin
  v_range := tstzrange(p_starts_at, p_ends_at, '[)');

  -- Check overlapping court reservations owned by the pro — reproduced
  -- verbatim from _lesson_check_pro_availability (0126).
  select count(*) into v_conflict
    from public.reservations r
   where r.owner_user_id = p_pro_id
     and r.status        in ('pending', 'confirmed')
     and tstzrange(r.starts_at, r.ends_at, '[)') && v_range
     and (p_exclude_request_id is null
          or r.id not in (
            select linked_reservation_id from public.lesson_requests
             where id = p_exclude_request_id
               and linked_reservation_id is not null
          ));

  if v_conflict > 0 then raise exception 'pro_has_conflict'; end if;

  -- Check overlapping event participation (host or confirmed participant)
  -- — reproduced verbatim from _lesson_check_pro_availability (0126).
  select count(*) into v_conflict
    from public.event_participants ep
    join public.reservations       er on er.event_id  = ep.event_id
                                     and er.status     in ('pending', 'confirmed')
                                     and tstzrange(er.starts_at, er.ends_at, '[)') && v_range
   where ep.profile_id = p_pro_id
     and ep.status     = 'confirmed';

  if v_conflict > 0 then raise exception 'pro_has_event_conflict'; end if;

  -- Also catch event creators who may not have an event_participants row —
  -- reproduced verbatim from _lesson_check_pro_availability (0126).
  select count(*) into v_conflict
    from public.events e
    join public.reservations er on er.event_id  = e.id
                               and er.status     in ('pending', 'confirmed')
                               and tstzrange(er.starts_at, er.ends_at, '[)') && v_range
   where e.created_by = p_pro_id
     and e.status     = 'scheduled'
     and not exists (
       select 1 from public.event_participants ep2
        where ep2.event_id   = e.id
          and ep2.profile_id = p_pro_id
     );

  if v_conflict > 0 then raise exception 'pro_has_event_conflict'; end if;

  -- Club-aware blackout check — the multi-club correction. p_club_id is
  -- the LESSON's own, caller-verified club, never derived from the target
  -- Pro's profiles.club_id. pro_blackout_dates.club_id is a real,
  -- not-null column (0070) — a blackout the Pro holds at a DIFFERENT club
  -- must never block this reassignment, and a genuine blackout at THIS
  -- club must be found using THIS club's own timezone.
  select timezone into v_tz from public.clubs where id = p_club_id;

  v_local_date := (p_starts_at at time zone v_tz)::date;

  if exists (
    select 1 from public.pro_blackout_dates b
     where b.pro_id       = p_pro_id
       and b.club_id      = p_club_id
       and b.blackout_date = v_local_date
  ) then
    raise exception 'pro_on_blackout';
  end if;
end;
$$;

revoke execute on function public._lesson_check_pro_availability_for_club(uuid, uuid, timestamptz, timestamptz, uuid)
  from public, anon, authenticated;


create or replace function public.admin_reassign_confirmed_lesson_pro(
  p_request_id          uuid,
  p_expected_updated_at timestamptz,
  p_new_pro_id          uuid
)
returns public.lesson_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id     uuid;
  v_role        text;
  v_request     public.lesson_requests%rowtype;
  v_reservation public.reservations%rowtype;
  v_new_pro_membership public.club_memberships%rowtype;
  v_new_pro     public.profiles%rowtype;
  v_member      public.profiles%rowtype;
  v_member_name text;
  v_old_pro_id  uuid;
  v_tz          text;
  v_result      public.lesson_requests%rowtype;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if v_role is null or v_role not in ('admin', 'staff') then raise exception 'insufficient_role'; end if;

  select * into v_request
    from public.lesson_requests
   where id      = p_request_id
     and club_id = v_club_id
   for update;
  if not found then raise exception 'request_not_found'; end if;

  if v_request.status <> 'confirmed' then raise exception 'invalid_status_for_pro_reassign'; end if;
  if v_request.updated_at is distinct from p_expected_updated_at then raise exception 'stale_edit_conflict'; end if;
  if v_request.linked_reservation_id is null then raise exception 'linked_reservation_not_found'; end if;

  select * into v_reservation
    from public.reservations
   where id      = v_request.linked_reservation_id
     and club_id = v_club_id
     and reason  = 'pro_lesson'
     and status  = 'confirmed'
   for update;
  if not found then raise exception 'linked_reservation_not_found'; end if;

  -- Already-started lesson: mirrors admin_update_member_lesson's/
  -- propose_lesson_time's identical guard exactly (0138/0159) — reassigning
  -- who taught a lesson that already happened corrects nothing.
  if v_reservation.starts_at <= now() then
    raise exception 'cannot_reschedule_started_lesson';
  end if;

  if v_request.pro_id = p_new_pro_id then
    raise exception 'same_pro';
  end if;

  -- Phase 38A correction (multi-club eligibility): reassign_lesson_provider
  -- (0132) / admin_update_member_lesson (0138) validate the target Pro
  -- against public.profiles.club_id/role/status/is_lesson_provider — a
  -- legacy compatibility PROJECTION of that user's CURRENTLY ACTIVE club
  -- membership only (0081), kept in sync only while a club_memberships row
  -- remains that user's current active membership — not a reliable
  -- per-club fact for a user who belongs to more than one club. A Pro
  -- active in Club A but currently viewing/active in Club B would
  -- incorrectly fail this check when Admin/Staff at Club A tries to
  -- reassign a Club A lesson to them, even though they hold a perfectly
  -- valid, active, lesson-providing membership in Club A. Since this
  -- function is new (not yet applied), it validates directly against
  -- public.club_memberships — the canonical per-(user, club) source since
  -- Phase 26B2 (0081's own header: "Source of truth starting Phase
  -- 26B2") — scoped to v_club_id (THIS lesson's own, caller-verified
  -- club), never the target's currently active club. Same fix shape
  -- already applied to send_announcement_v2 for the identical class of
  -- bug (0177) — reassign_lesson_provider/admin_update_member_lesson/
  -- get_admin_club_pros are pre-existing, already-applied migrations that
  -- share this same limitation and are intentionally left unmodified here.
  select * into v_new_pro_membership
    from public.club_memberships
   where user_id            = p_new_pro_id
     and club_id            = v_club_id
     and status              = 'active'
     and removed_at is null
     and role                in ('pro', 'admin', 'staff')
     and is_lesson_provider  = true;
  if not found then raise exception 'pro_not_found'; end if;

  -- Global identity (name) always comes from profiles regardless of which
  -- club is currently active — the same convention getAuthProfile/
  -- get_current_account_context already document (0081/0082): identity
  -- fields (id/first_name/last_name) are user-global, not club-scoped.
  select * into v_new_pro from public.profiles where id = p_new_pro_id;

  if v_request.member_id = p_new_pro_id then
    raise exception 'cannot_assign_to_self';
  end if;

  -- Club-aware availability/blackout check (multi-club correction — see
  -- header). v_club_id is THIS lesson's own, caller-verified club, never
  -- the target Pro's profiles.club_id. Already excludes this lesson's own
  -- linked reservation via p_exclude_request_id.
  perform public._lesson_check_pro_availability_for_club(
    p_new_pro_id, v_club_id, v_reservation.starts_at, v_reservation.ends_at, p_request_id
  );

  v_old_pro_id := v_request.pro_id;

  select * into v_member from public.profiles where id = v_request.member_id;
  v_member_name := trim(coalesce(v_member.first_name, '') || ' ' || coalesce(v_member.last_name, ''));
  if v_member_name = '' then
    select trim(coalesce(first_name, '') || ' ' || coalesce(last_name, ''))
      into v_member_name
      from public.roster_members
     where id = v_request.roster_member_id;
  end if;

  select timezone into v_tz from public.clubs where id = v_club_id;

  -- Scheduling never changes here — update the existing reservation row IN
  -- PLACE (never soft-cancel-and-reinsert), preserving its id, court, and
  -- time exactly. Only the assigned Pro (owner_user_id) and the descriptive
  -- note change.
  update public.reservations
     set owner_user_id = p_new_pro_id,
         notes         = 'Pro lesson with ' || v_member_name,
         updated_at    = now()
   where id = v_reservation.id;

  update public.lesson_requests
     set pro_id          = p_new_pro_id,
         last_actor_id   = auth.uid(),
         last_actor_role = v_role,
         updated_at      = now()
   where id = p_request_id
  returning * into v_result;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'admin_reassign_confirmed_lesson_pro', 'lesson_request', p_request_id,
    jsonb_build_object(
      'old_pro_id',      v_old_pro_id,
      'new_pro_id',      p_new_pro_id,
      'reservation_id',  v_reservation.id
    )
  );

  insert into public.notifications (club_id, user_id, kind, body, metadata)
  values (
    v_club_id, p_new_pro_id, 'lesson_provider_reassigned',
    'You have been assigned a confirmed lesson with ' || v_member_name || ' on ' ||
      to_char(v_reservation.starts_at at time zone v_tz, 'Mon DD "at" HH12:MI AM') || '.',
    jsonb_build_object('request_id', p_request_id, 'reservation_id', v_reservation.id)
  );

  insert into public.notifications (club_id, user_id, kind, body, metadata)
  values (
    v_club_id, v_old_pro_id, 'lesson_provider_reassigned',
    'Your lesson with ' || v_member_name || ' on ' ||
      to_char(v_reservation.starts_at at time zone v_tz, 'Mon DD "at" HH12:MI AM') ||
      ' has been reassigned to another pro.',
    jsonb_build_object('request_id', p_request_id, 'reservation_id', v_reservation.id)
  );

  -- A no-account Member (member_id null) has no user_id to notify in-app —
  -- the calling Server Action sends the operational email directly to
  -- roster_members.email instead (v_result.roster_member_id is already
  -- part of `returning *` above), mirroring cancelLesson's own no-account
  -- branch exactly. No new communications mechanism is introduced here.
  if v_request.member_id is not null then
    insert into public.notifications (club_id, user_id, kind, body, metadata)
    values (
      v_club_id, v_request.member_id, 'lesson_provider_reassigned',
      'Your lesson on ' || to_char(v_reservation.starts_at at time zone v_tz, 'Mon DD "at" HH12:MI AM') ||
        ' has been reassigned to ' ||
        trim(coalesce(v_new_pro.first_name, '') || ' ' || coalesce(v_new_pro.last_name, '')) || '.',
      jsonb_build_object('request_id', p_request_id, 'new_pro_id', p_new_pro_id)
    );
  end if;

  return v_result;
end;
$$;

revoke execute on function public.admin_reassign_confirmed_lesson_pro(uuid, timestamptz, uuid) from public, anon;
grant  execute on function public.admin_reassign_confirmed_lesson_pro(uuid, timestamptz, uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- get_confirmed_lesson_reassignment_pros — new public RPC (see MULTI-CLUB
-- CORRECTION — confirmed-reassignment provider picker, header above).
-- Admin/Staff only, read-only, club_memberships-canonical. Used ONLY by the
-- confirmed-lesson reassignment mode — get_admin_club_pros (0132) remains
-- completely unmodified and continues to serve pending/proposed
-- reassignment, lesson creation, and every other flow exactly as before.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.get_confirmed_lesson_reassignment_pros()
returns table (
  id                 uuid,
  first_name         text,
  last_name          text,
  role               text,
  is_lesson_provider boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
  v_role    text;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if v_role is null or v_role not in ('admin', 'staff') then raise exception 'insufficient_role'; end if;

  return query
    select p.id, p.first_name, p.last_name, cm.role, cm.is_lesson_provider
      from public.club_memberships cm
      join public.profiles         p on p.id = cm.user_id
     where cm.club_id            = v_club_id
       and cm.status              = 'active'
       and cm.removed_at is null
       and cm.role                in ('pro', 'admin', 'staff')
       and cm.is_lesson_provider  = true
     order by p.last_name nulls last, p.first_name nulls last;
end;
$$;

revoke execute on function public.get_confirmed_lesson_reassignment_pros() from public, anon;
grant  execute on function public.get_confirmed_lesson_reassignment_pros() to authenticated;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration created in
-- this checkpoint)
-- ═══════════════════════════════════════════════════════════════════════════
-- `drop function if exists public.admin_reassign_confirmed_lesson_pro(uuid, timestamptz, uuid);`
-- `drop function if exists public._lesson_check_pro_availability_for_club(uuid, uuid, timestamptz, timestamptz, uuid);`
-- `drop function if exists public.get_confirmed_lesson_reassignment_pros();`
-- No table, column, RLS policy, or trigger is created by this migration —
-- nothing else requires rollback.
