-- 0138_staff_confirmed_lesson_direct_edit.sql
-- Phase 34A completion — confirmed-Lesson operations, part 2 of 2.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
-- 0135 lifted the Staff block on propose_lesson_time's reschedule path
-- (claimed-Member confirmed lessons, negotiation cycle). The remaining
-- confirmed-Lesson gap is public.admin_update_member_lesson — the direct,
-- no-negotiation edit path for a no-account Member's confirmed lesson
-- (LessonProSheet's "Edit Lesson" button, canAdminEditDirectly). It was
-- admin-only with no Pro path at all — never touched by 0131-0135.
--
-- The body below is the exact Production pg_get_functiondef output for
-- public.admin_update_member_lesson(uuid, uuid, timestamptz, uuid, uuid,
-- uuid, timestamptz, timestamptz, uuid, text), supplied directly by the
-- operator (2026-08-20) and copied verbatim — not reconstructed from 0111
-- or 0120. Exactly three changes from that verbatim text:
--
--   1. Caller gate widened so a Staff caller is admitted alongside the
--      existing Admin role: `v_role <> 'admin'` -> `v_role not in
--      ('admin', 'staff')`.
--
--   2. Provider eligibility for the (possibly reassigned) target pro
--      widened to include a Staff+Provider account, matching the
--      established Staff+Pro eligibility pattern already used by
--      reassign_lesson_provider and get_admin_club_pros (0132):
--      `role in ('pro', 'admin')` -> `role in ('pro', 'admin', 'staff')`
--      (is_lesson_provider = true unchanged — still required regardless
--      of role).
--
--   3. last_actor_role was hardcoded to the literal 'admin' in the
--      lesson_requests UPDATE — changed to the actual caller role
--      (`v_role`), matching the identical correction already applied to
--      reassign_lesson_provider in 0132 and already-dynamic in
--      propose_lesson_time (0133/0135). Admin's recorded value is
--      unchanged ('admin' either way); Staff is now correctly recorded as
--      'staff' instead of being silently misattributed as an Admin action.
--
-- Resulting behavior:
--   Admin  — unchanged (full direct-edit authority).
--   Staff  — direct-edit authority for a no-account Member's confirmed
--            lesson (new in this migration), identical rules to Admin:
--            same concurrency protection (p_expected_updated_at), same
--            court-conflict pre-check, same operating-hours/pro/member
--            re-validation on scheduling or provider change, same
--            soft-cancel-and-reinsert vs. update-in-place branching for
--            the linked reservation, same notifications, same audit.
--   Pro    — unchanged; this function has never admitted role='pro' as a
--            caller and still does not.
--   Member — unchanged; this function has never admitted role='member'.
--
-- Every other line — request/reservation locking, roster/pro resolution,
-- duration/court/lesson-type validation, the scheduling-changed vs.
-- member/pro-changed branching for the reservation row, both audit_log
-- fields, and both notification inserts — reproduced verbatim from
-- Production.
--
-- reassign_lesson_provider (0132) is NOT broadened to confirmed lessons by
-- this migration — its existing pending/proposed-only boundary is
-- deliberate and unrelated to this direct-edit path, per instruction.
--
-- No DROP: this CREATE OR REPLACE targets the exact live function
-- identity, whose signature and return type are unchanged. No REVOKE/
-- GRANT needed — this function's authenticated-callable posture is
-- unchanged.
--
-- Does not modify 0131-0137. Not applied by this checkpoint. Apply in
-- Supabase SQL Editor (cloud only).
-- ═══════════════════════════════════════════════════════════════════════════

begin;

CREATE OR REPLACE FUNCTION public.admin_update_member_lesson(p_request_id uuid, p_expected_club_id uuid, p_expected_updated_at timestamp with time zone, p_roster_member_id uuid, p_pro_id uuid, p_court_id uuid, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone, p_lesson_type_id uuid DEFAULT NULL::uuid, p_member_note text DEFAULT NULL::text)
 RETURNS lesson_requests
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_club_id           uuid;
  v_role              text;
  v_before            public.lesson_requests%rowtype;
  v_old_reservation   public.reservations%rowtype;
  v_roster            public.roster_members%rowtype;
  v_member_id         uuid;
  v_pro               public.profiles%rowtype;
  v_duration_minutes  int;
  v_tz                text;
  v_scheduling_changed boolean;
  v_member_changed     boolean;
  v_pro_changed        boolean;
  v_res_id             uuid;
  v_member_name        text;
  v_result             public.lesson_requests%rowtype;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
  if v_role is null or v_role not in ('admin', 'staff') then raise exception 'insufficient_role'; end if;

  select * into v_before
    from public.lesson_requests
   where id      = p_request_id
     and club_id = v_club_id
   for update;
  if not found then raise exception 'request_not_found'; end if;

  if v_before.status <> 'confirmed' then raise exception 'invalid_status_for_edit'; end if;
  if v_before.updated_at is distinct from p_expected_updated_at then raise exception 'stale_edit_conflict'; end if;
  if v_before.linked_reservation_id is null then raise exception 'linked_reservation_not_found'; end if;

  select * into v_old_reservation
    from public.reservations
   where id      = v_before.linked_reservation_id
     and club_id = v_club_id
     and reason  = 'pro_lesson'
     and status  = 'confirmed'
   for update;
  if not found then raise exception 'linked_reservation_not_found'; end if;

  if v_old_reservation.starts_at <= now() then
    raise exception 'cannot_reschedule_started_lesson';
  end if;

  -- Resolve and validate the (possibly reassigned) target roster Member.
  select * into v_roster
    from public.roster_members
   where id      = p_roster_member_id
     and club_id = v_club_id;
  if not found then raise exception 'roster_member_not_found'; end if;

  v_member_id   := v_roster.claimed_by;
  v_member_name := trim(coalesce(v_roster.first_name, '') || ' ' || coalesce(v_roster.last_name, ''));

  -- Validate (possibly reassigned) pro.
  select * into v_pro
    from public.profiles
   where id                 = p_pro_id
     and club_id            = v_club_id
     and status              = 'active'
     and role                in ('pro', 'admin', 'staff')
     and is_lesson_provider  = true;
  if not found then raise exception 'pro_not_found'; end if;

  if v_member_id is not null and v_member_id = p_pro_id then
    raise exception 'cannot_request_yourself';
  end if;

  if p_starts_at < now() then raise exception 'cannot_propose_past_time'; end if;
  if p_ends_at  <= p_starts_at then raise exception 'invalid_duration'; end if;

  v_duration_minutes := round(extract(epoch from (p_ends_at - p_starts_at)) / 60)::int;
  if v_duration_minutes < 30 or v_duration_minutes % 15 <> 0 then
    raise exception 'invalid_duration';
  end if;

  if not exists (
    select 1 from public.courts
     where id        = p_court_id
       and club_id   = v_club_id
       and is_active = true
  ) then
    raise exception 'court_not_found';
  end if;

  if p_lesson_type_id is not null then
    if not exists (
      select 1 from public.lesson_types lt
       where lt.id        = p_lesson_type_id
         and lt.club_id   = v_club_id
         and lt.is_active = true
    ) then
      raise exception 'lesson_type_not_found';
    end if;

    if exists (
      select 1 from public.lesson_types lt
       where lt.id               = p_lesson_type_id
         and lt.allowed_durations is not null
         and array_length(lt.allowed_durations, 1) > 0
         and not (v_duration_minutes = any(lt.allowed_durations))
    ) then
      raise exception 'duration_not_allowed_for_type';
    end if;
  end if;

  if length(p_member_note) > 500 then raise exception 'note_too_long'; end if;

  v_scheduling_changed := (p_court_id, p_starts_at, p_ends_at)
    is distinct from (v_old_reservation.court_id, v_old_reservation.starts_at, v_old_reservation.ends_at);
  v_member_changed := p_roster_member_id is distinct from v_before.roster_member_id;
  v_pro_changed     := p_pro_id is distinct from v_before.pro_id;

  select timezone into v_tz from public.clubs where id = v_club_id;

  if v_scheduling_changed or v_pro_changed then
    -- Phase 33E3 fix: court-conflict pre-check, excluding this lesson's
    -- own currently-linked reservation — mirrors propose_lesson_time's
    -- already-live pattern. Without this, a genuine court double-book was
    -- only ever caught by the raw GiST EXCLUDE constraint on reservations,
    -- whose untranslated error text mapLessonError() cannot match, so the
    -- UI showed a generic "Something went wrong" instead of the friendly,
    -- already-mapped court_conflict message.
    if exists (
      select 1 from public.reservations r
       where r.court_id = p_court_id
         and r.status   in ('pending', 'confirmed')
         and tstzrange(r.starts_at, r.ends_at, '[)') && tstzrange(p_starts_at, p_ends_at, '[)')
         and r.id is distinct from v_old_reservation.id
    ) then
      raise exception 'court_conflict';
    end if;

    -- Time and/or pro changed — re-validate operating hours / pro /
    -- member conflicts, excluding this lesson's own still-active
    -- reservation, exactly like a self-service reschedule. Member check
    -- is unconditional (correction pass — see admin_create_member_
    -- lesson's header note above); p_roster_member_id always supplied.
    perform public._lesson_check_operating_hours(v_club_id, p_starts_at, p_ends_at, v_tz);
    perform public._lesson_check_pro_availability(p_pro_id, p_starts_at, p_ends_at, p_request_id);
    perform public._lesson_check_member_availability(v_member_id, p_roster_member_id, p_starts_at, p_ends_at, p_request_id);
  end if;

  if v_scheduling_changed then
    -- Soft-cancel the old reservation and insert a new one — mirrors
    -- accept_lesson_proposal's own reschedule pattern exactly. The new
    -- row's created_by is this admin: it is a genuinely new row, not a
    -- rewrite of the old one's created_by (which stays untouched on the
    -- now-cancelled row).
    update public.reservations
       set status            = 'cancelled',
           cancelled_at      = now(),
           cancelled_by      = auth.uid(),
           cancellation_kind = 'system',
           updated_at        = now()
     where id = v_old_reservation.id;

    insert into public.reservations (
      club_id, court_id, owner_user_id, roster_member_id,
      starts_at, ends_at, status, reason,
      notes, show_notes_to_members, created_by
    ) values (
      v_club_id, p_court_id, p_pro_id, p_roster_member_id,
      p_starts_at, p_ends_at, 'confirmed', 'pro_lesson',
      'Pro lesson with ' || v_member_name,
      false,
      auth.uid()
    ) returning id into v_res_id;
  elsif v_member_changed or v_pro_changed then
    -- Nothing time-related changed — update the existing reservation row
    -- directly in place (no history-losing replace) rather than the
    -- soft-cancel-and-reinsert pattern above, which is reserved for an
    -- actual scheduling change.
    update public.reservations
       set owner_user_id    = p_pro_id,
           roster_member_id = p_roster_member_id,
           notes            = 'Pro lesson with ' || v_member_name,
           updated_at       = now()
     where id = v_old_reservation.id;
    v_res_id := v_old_reservation.id;
  else
    v_res_id := v_old_reservation.id;
  end if;

  update public.lesson_requests
     set roster_member_id    = p_roster_member_id,
         member_id           = v_member_id,
         pro_id              = p_pro_id,
         duration_minutes    = v_duration_minutes,
         member_note         = btrim(coalesce(p_member_note, '')),
         lesson_type_id      = p_lesson_type_id,
         proposed_starts_at  = p_starts_at,
         proposed_ends_at    = p_ends_at,
         proposed_court_id   = p_court_id,
         linked_reservation_id = v_res_id,
         last_actor_id       = auth.uid(),
         last_actor_role     = v_role,
         updated_at          = now()
   where id = p_request_id
  returning * into v_result;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'admin_update_member_lesson', 'lesson_request', p_request_id,
    jsonb_build_object(
      'before', jsonb_build_object(
        'roster_member_id', v_before.roster_member_id,
        'member_id',        v_before.member_id,
        'pro_id',           v_before.pro_id,
        'court_id',         v_old_reservation.court_id,
        'starts_at',        v_old_reservation.starts_at,
        'ends_at',          v_old_reservation.ends_at
      ),
      'after', jsonb_build_object(
        'roster_member_id', p_roster_member_id,
        'member_id',        v_member_id,
        'pro_id',           p_pro_id,
        'court_id',         p_court_id,
        'starts_at',        p_starts_at,
        'ends_at',          p_ends_at
      ),
      'scheduling_changed', v_scheduling_changed,
      'member_changed',     v_member_changed,
      'pro_changed',        v_pro_changed,
      'reservation_id',     v_res_id,
      'old_reservation_id', case when v_scheduling_changed then v_old_reservation.id else null end
    )
  );

  -- Notify pro — always, when the pro or the schedule changed (always has
  -- an account). Notify member only if claimed and something material
  -- changed. Reuses the existing lesson_request_confirmed kind — no new
  -- notification kind is introduced.
  if v_scheduling_changed or v_pro_changed then
    insert into public.notifications (club_id, user_id, kind, body, metadata)
    values (
      v_club_id, p_pro_id, 'lesson_request_confirmed',
      'Lesson with ' || v_member_name || ' updated — now ' ||
        to_char(p_starts_at at time zone v_tz, 'Mon DD "at" HH12:MI AM') || '.',
      jsonb_build_object('request_id', p_request_id, 'reservation_id', v_res_id)
    );
  end if;

  if v_member_id is not null and (v_scheduling_changed or v_pro_changed or v_member_changed) then
    insert into public.notifications (club_id, user_id, kind, body, metadata)
    values (
      v_club_id, v_member_id, 'lesson_request_confirmed',
      'Your lesson with ' ||
        trim(coalesce(v_pro.first_name, '') || ' ' || coalesce(v_pro.last_name, '')) ||
        ' is confirmed for ' || to_char(p_starts_at at time zone v_tz, 'Mon DD "at" HH12:MI AM') || '.',
      jsonb_build_object('request_id', p_request_id, 'reservation_id', v_res_id)
    );
  end if;

  return v_result;
end;
$function$;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration created in
-- this checkpoint)
-- ═══════════════════════════════════════════════════════════════════════════
-- Restore by re-querying the live Production function definition
-- (pg_get_functiondef) immediately before rolling back — this migration's
-- own body was sourced the same way (supplied directly by the operator),
-- not from 0111/0120 or any other migration file. No RLS policy, no other
-- function, and no table is touched by this migration — nothing else
-- requires rollback.
