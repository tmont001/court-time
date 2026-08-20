-- 0135_staff_confirmed_lesson_reschedule.sql
-- Phase 34A completion — confirmed-Lesson operations, part 1 of 2.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
-- 0133 (applied, verified in Production) deliberately blocked a Staff
-- caller from rescheduling an already-confirmed lesson via a narrow guard
-- keyed off propose_lesson_time's own v_is_reschedule signal, documented
-- there as "deferred to 34A4B." That deferral is now lifted: Staff may
-- operationally reschedule an already-confirmed Member lesson, identically
-- to Admin's existing behavior (Pro's existing self-scoped behavior is
-- untouched either way).
--
-- The body below is byte-for-byte 0133's own CREATE OR REPLACE FUNCTION
-- public.propose_lesson_time(...) — itself sourced verbatim from Production
-- and applied — with exactly ONE change: the Staff-only reschedule guard
-- (0133's lines ~143-154) is removed. Nothing else in the function is
-- touched:
--   - the caller gate (`role not in ('pro','admin','staff')`) already
--     admits Staff and is unchanged;
--   - v_is_reschedule, the linked-reservation lookup/lock, the started-
--     lesson guard, optimistic concurrency (p_expected_updated_at), court/
--     operating-hours/pro/member conflict checks, the UPDATE (still never
--     touching linked_reservation_id/confirmed_at — the original confirmed
--     reservation stays untouched throughout the pending-proposal window,
--     exactly as before), notifications, and audit_log are all reproduced
--     verbatim;
--   - last_actor_role is already `v_profile.role` (dynamic, not a hardcoded
--     literal) — no separate fix needed here, unlike admin_update_member_
--     lesson (still deferred — see that function's own migration).
--
-- Resulting behavior:
--   Admin  — unchanged (new proposal and reschedule both allowed).
--   Pro    — unchanged (new proposal and reschedule both allowed, still
--            restricted to the assigned pro via not_assigned_pro).
--   Staff  — new proposal: unchanged (already allowed by 0133). Reschedule
--            of an already-confirmed lesson: now ALLOWED (new in this
--            migration) — same court/time/concurrency/conflict rules as
--            Admin, no separate rule invented.
--   Member — unchanged; this function has never admitted role='member'.
--
-- This migration does NOT touch admin_update_member_lesson (the separate,
-- still admin-only direct-edit RPC for a no-account Member's confirmed
-- lesson) — that remains deferred pending its own Production
-- pg_get_functiondef pull, tracked separately. reassign_lesson_provider
-- (0132) already correctly excludes confirmed/reschedule-in-flight
-- requests from provider reassignment and needs no change.
--
-- No DROP: this CREATE OR REPLACE targets the exact live function
-- identity, whose signature and return type are unchanged from 0133. No
-- REVOKE/GRANT needed — this function's authenticated-callable posture was
-- never touched by 0133 either, per that migration's own note.
--
-- Does not modify 0131, 0132, 0133, or 0134. Not applied by this
-- checkpoint. Apply in Supabase SQL Editor (cloud only).
-- ═══════════════════════════════════════════════════════════════════════════

begin;

CREATE OR REPLACE FUNCTION public.propose_lesson_time(p_request_id uuid, p_expected_updated_at timestamp with time zone, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone, p_court_id uuid DEFAULT NULL::uuid)
 RETURNS lesson_requests
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_profile        public.profiles%rowtype;
  v_request        public.lesson_requests%rowtype;
  v_result         public.lesson_requests%rowtype;
  v_old_reservation public.reservations%rowtype;
  v_is_reschedule  boolean;
  v_tz             text;
  -- Phase 33D1 correction: the lesson's CURRENT roster claim state — never
  -- read from historical v_request.member_id, which is a point-in-time
  -- snapshot that is not rewritten when the underlying identity is later
  -- claimed.
  v_current_member_id uuid;
begin
  select * into v_profile from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.club_id is null then raise exception 'no_club'; end if;
  if v_profile.role not in ('pro', 'admin', 'staff') then raise exception 'insufficient_role'; end if;

  select * into v_request
    from public.lesson_requests
   where id      = p_request_id
     and club_id = v_profile.club_id
   for update;
  if not found then raise exception 'request_not_found'; end if;

  -- Phase 33D1 correction: resolve the lesson's roster identity fresh and
  -- use ITS CURRENT claimed_by, not the historical v_request.member_id
  -- snapshot. A lesson created for a no-account Member who has since
  -- claimed their account is now correctly eligible for this negotiation
  -- cycle; one that is still genuinely unclaimed correctly is not. This
  -- RPC's negotiation cycle (propose → member accepts/declines)
  -- structurally requires an authenticated Member to respond — a Member
  -- with no CURRENT account has no session and can never call accept_
  -- lesson_proposal/decline_lesson_proposal — proceeding here would either
  -- strand the request in 'proposed' forever, or (see accept/decline's own
  -- fix) let a stale-vs-current identity mismatch admit the wrong caller.
  -- Direct edits for a still-unclaimed Member's lesson go through admin_
  -- update_member_lesson instead (Section F2).
  select claimed_by into v_current_member_id
    from public.roster_members
   where id = v_request.roster_member_id;

  if v_current_member_id is null then
    raise exception 'member_has_no_account';
  end if;

  if v_profile.role = 'pro' and v_request.pro_id <> auth.uid() then
    raise exception 'not_assigned_pro';
  end if;

  -- 'confirmed' begins a reschedule; a 'proposed' request whose
  -- linked_reservation_id is already set is an in-flight reschedule that
  -- may be revised again before the member responds.
  if v_request.status not in ('pending', 'proposed', 'confirmed') then
    raise exception 'invalid_status_for_propose';
  end if;

  -- Optimistic concurrency.
  if v_request.updated_at is distinct from p_expected_updated_at then
    raise exception 'stale_edit_conflict';
  end if;

  v_is_reschedule := v_request.linked_reservation_id is not null;

  -- Phase 34A completion: the 0133 Staff-only reschedule guard that lived
  -- here ("if v_profile.role = 'staff' and v_is_reschedule then raise
  -- exception 'insufficient_role'; end if;") is removed — Staff may now
  -- reschedule an already-confirmed lesson exactly like Admin. Everything
  -- below is unchanged from 0133.

  -- Authoritative original confirmed lesson. Once a reschedule is pending,
  -- lesson_requests.proposed_starts_at holds the *new* candidate, not the
  -- original — the still-active linked reservation is the only reliable
  -- source of the currently-confirmed court/time.
  if v_is_reschedule then
    select * into v_old_reservation
      from public.reservations
     where id      = v_request.linked_reservation_id
       and club_id = v_profile.club_id
       and reason  = 'pro_lesson'
       and status  = 'confirmed'
     for update;
    if not found then raise exception 'linked_reservation_not_found'; end if;

    if v_old_reservation.starts_at <= now() then
      raise exception 'cannot_reschedule_started_lesson';
    end if;
  end if;

  if p_starts_at <= now() then raise exception 'cannot_propose_past_time'; end if;
  if p_ends_at   <= p_starts_at then raise exception 'invalid_duration'; end if;

  if round(extract(epoch from (p_ends_at - p_starts_at)) / 60)::int <> v_request.duration_minutes then
    raise exception 'duration_mismatch';
  end if;

  -- ── Preflight conflict validation ─────────────────────────────────────────
  -- The still-active original lesson (and only that reservation) is excluded
  -- from every check below, so it never conflicts with its own proposed
  -- replacement. No other reservation is excluded. This is a preflight
  -- convenience only — acceptance re-validates via the GiST exclusion
  -- constraint, which remains the final authority.

  if p_court_id is not null then
    if not exists (
      select 1 from public.courts
       where id        = p_court_id
         and club_id   = v_profile.club_id
         and is_active = true
    ) then
      raise exception 'court_not_found';
    end if;

    if exists (
      select 1 from public.reservations r
       where r.court_id = p_court_id
         and r.status   in ('pending', 'confirmed')
         and tstzrange(r.starts_at, r.ends_at, '[)') && tstzrange(p_starts_at, p_ends_at, '[)')
         and (r.id is distinct from v_request.linked_reservation_id)
    ) then
      raise exception 'court_conflict';
    end if;
  end if;

  -- Operating hours
  select timezone into v_tz from public.clubs where id = v_profile.club_id;
  perform public._lesson_check_operating_hours(
    v_profile.club_id,
    p_starts_at,
    p_ends_at,
    v_tz
  );

  -- Pro conflicts — excludes this request's own linked reservation (the
  -- pro's own currently-confirmed lesson) so a reschedule never
  -- self-conflicts.
  perform public._lesson_check_pro_availability(
    v_request.pro_id,
    p_starts_at,
    p_ends_at,
    v_request.id
  );

  -- Member conflicts — same self-exclusion. Phase 33D1 correction: uses
  -- v_current_member_id (the lesson's CURRENT roster claimed_by, resolved
  -- above — guaranteed non-null past the guard) rather than historical
  -- member_id, plus the durable roster_member_id for the widened,
  -- roster-aware conflict categories (Section M).
  perform public._lesson_check_member_availability(
    v_current_member_id,
    v_request.roster_member_id,
    p_starts_at,
    p_ends_at,
    v_request.id
  );

  -- ── Commit ────────────────────────────────────────────────────────────────
  -- linked_reservation_id and confirmed_at are never in this SET list —
  -- the original confirmed reservation and its confirmation history are
  -- preserved untouched throughout the pending-proposal window.

  update public.lesson_requests
     set status             = 'proposed',
         proposed_starts_at = p_starts_at,
         proposed_ends_at   = p_ends_at,
         proposed_court_id  = p_court_id,
         last_actor_id      = auth.uid(),
         last_actor_role    = v_profile.role,
         updated_at         = now()
   where id = p_request_id
  returning * into v_result;

  -- Phase 33D1 correction: addressed to v_current_member_id (the CURRENT
  -- claimed_by, resolved above), not historical v_request.member_id —
  -- required for claim continuity (a lesson claimed after creation must
  -- notify the now-current account, and this is also what avoids a
  -- NOT NULL user_id crash for a still-unclaimed row, which the guard
  -- above already prevents reaching this point at all).
  insert into public.notifications (club_id, user_id, kind, body, metadata)
  values (
    v_profile.club_id,
    v_current_member_id,
    'lesson_request_proposed',
    trim(coalesce(v_profile.first_name, '') || ' ' || coalesce(v_profile.last_name, '')) ||
      case when v_is_reschedule
           then ' proposed a new time for your confirmed lesson. Please review and respond.'
           else ' proposed a time for your lesson. Please review and respond.'
      end,
    jsonb_build_object('request_id', p_request_id, 'target_path', '/lessons')
  );

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id, auth.uid(), 'propose_lesson_time', 'lesson_request', p_request_id,
    jsonb_build_object(
      'proposed_starts_at', p_starts_at,
      'proposed_ends_at',   p_ends_at,
      'court_id',           p_court_id,
      'is_reschedule',      v_is_reschedule
    )
  );

  return v_result;
end;
$function$;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration created in
-- this checkpoint)
-- ═══════════════════════════════════════════════════════════════════════════
-- Restore by re-applying 0133's CREATE OR REPLACE body verbatim (reinstating
-- the removed Staff-only reschedule guard). No RLS policy, no other
-- function, and no table is touched by this migration — nothing else
-- requires rollback.
