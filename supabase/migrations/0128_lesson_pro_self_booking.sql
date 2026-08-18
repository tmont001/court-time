-- 0128_lesson_pro_self_booking.sql
-- Phase 33G2: Lesson Scheduling + UX Polish.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
-- 33G2's locked product direction requires that BOTH Admin and Pro be able
-- to initiate Lesson creation directly from the Calendar using a selected
-- court/time slot, reusing the existing staff Lesson-creation flow rather
-- than building a second form. Inspection found the only existing
-- immediate-confirm staff flow — admin_create_member_lesson (0111, last
-- amended 0121) — hard-rejects any caller whose role is not exactly
-- 'admin' (`if v_role is null or v_role <> 'admin' then raise exception
-- 'insufficient_role'`), and its UI (AdminRequestLessonSheet) reads
-- roster_members directly from the client, whose RLS
-- (roster_members_select_admin, 0056) is admin-only — a Pro caller would
-- simply get zero rows, not an error. Both gaps block the locked Pro
-- Calendar-initiated flow entirely; this migration closes them with the
-- smallest possible surface:
--
--   1. admin_create_member_lesson: role check widened to ('admin', 'pro').
--      A Pro caller is additionally required to supply p_pro_id = auth.uid()
--      — a Pro may only book themselves as the lesson provider, never
--      assign another Pro (that remains admin-only, unchanged). This is a
--      role-gate relaxation only — every existing validation (member/court/
--      pro/duration/operating-hours/conflict checks, the 0126 Member
--      schedule guard via _lesson_check_member_availability, the reservation
--      GiST EXCLUDE constraint) is untouched and still runs identically
--      regardless of caller role. last_actor_role also changes from a
--      hardcoded 'admin' literal to the caller's actual v_role, so a
--      Pro-created lesson's audit trail correctly reflects who created it
--      (mirrors last_actor_role's existing meaning everywhere else in this
--      domain — the literal was only ever correct by coincidence while
--      'admin' was the sole caller).
--
--   2. New get_lesson_roster_members(): a SECURITY DEFINER, admin-OR-pro,
--      club-scoped read of active roster_members (id, first_name,
--      last_name, claimed_by) — the exact shape /admin/lessons/page.tsx
--      already selects directly from the table for its admin branch. This
--      does not touch roster_members' own RLS (unchanged, still
--      admin-only — direct table access remains restricted); it adds one
--      narrow, explicitly-authorized read path for the one additional case
--      this phase requires, mirroring the existing get_event_eligible_
--      members / get_program_eligible_roster_members admin+pro precedent
--      (0118, 0117) rather than widening a table policy.
--
-- No change to 0126 (Member schedule guards) or 0127 (Program/session
-- capacity guards) — this migration adds no new capacity- or
-- scheduling-consuming write path; it only widens who may call an existing,
-- already-fully-guarded write, and adds one new read-only function.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ─── Section 1: admin_create_member_lesson — allow Pro self-booking ────────

create or replace function public.admin_create_member_lesson(
  p_expected_club_id uuid,
  p_roster_member_id uuid,
  p_pro_id            uuid,
  p_court_id          uuid,
  p_starts_at         timestamptz,
  p_ends_at           timestamptz,
  p_lesson_type_id    uuid default null,
  p_member_note       text default null
)
returns public.lesson_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id           uuid;
  v_role              text;
  v_roster            public.roster_members%rowtype;
  v_member_id         uuid;
  v_pro               public.profiles%rowtype;
  v_duration_minutes  int;
  v_tz                text;
  v_res_id            uuid;
  v_result            public.lesson_requests%rowtype;
  v_member_name       text;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
  if v_role is null or v_role not in ('admin', 'pro') then raise exception 'insufficient_role'; end if;

  -- A Pro may only book themselves as the lesson provider — assigning a
  -- different Pro remains an admin-only action (matches every other
  -- Lesson-domain admin/pro split: a Pro always acts as themselves, never
  -- on another Pro's behalf).
  if v_role = 'pro' and p_pro_id <> auth.uid() then
    raise exception 'insufficient_role';
  end if;

  -- Resolve and validate the target roster Member — never trusted as
  -- "proof" of anything beyond its own existence/club scope; the caller's
  -- own admin/pro authorization above is the only authorization this
  -- function relies on.
  select * into v_roster
    from public.roster_members
   where id      = p_roster_member_id
     and club_id = v_club_id;
  if not found then raise exception 'roster_member_not_found'; end if;

  v_member_id   := v_roster.claimed_by;
  v_member_name := trim(coalesce(v_roster.first_name, '') || ' ' || coalesce(v_roster.last_name, ''));

  -- Validate pro: active, same club, role pro or admin, is_lesson_provider = true
  select * into v_pro
    from public.profiles
   where id                 = p_pro_id
     and club_id            = v_club_id
     and status              = 'active'
     and role                in ('pro', 'admin')
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

  -- Validate court: active, same club
  if not exists (
    select 1 from public.courts
     where id        = p_court_id
       and club_id   = v_club_id
       and is_active = true
  ) then
    raise exception 'court_not_found';
  end if;

  -- Validate optional lesson type: active, same club, duration allowed
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

  -- Court-conflict precheck (0121) — unchanged.
  if exists (
    select 1 from public.reservations r
     where r.court_id = p_court_id
       and r.status   in ('pending', 'confirmed')
       and tstzrange(r.starts_at, r.ends_at, '[)') && tstzrange(p_starts_at, p_ends_at, '[)')
  ) then
    raise exception 'court_conflict';
  end if;

  -- Operating hours check — same helper self-service uses.
  select timezone into v_tz from public.clubs where id = v_club_id;
  perform public._lesson_check_operating_hours(v_club_id, p_starts_at, p_ends_at, v_tz);

  -- Pro conflict check — same helper self-service uses. Always applies:
  -- every Pro has an account by construction (profiles.role NOT NULL FK).
  perform public._lesson_check_pro_availability(p_pro_id, p_starts_at, p_ends_at, null);

  -- Member conflict check — unconditional. p_roster_member_id always
  -- supplied; v_member_id may be null for a still-unclaimed roster Member.
  perform public._lesson_check_member_availability(v_member_id, p_roster_member_id, p_starts_at, p_ends_at, null);

  -- Create the reservation (GiST EXCLUDE handles court conflicts
  -- atomically — the final authority, same as every other lesson-
  -- confirming path; the 0126 Member schedule guard on `reservations`
  -- fires here too, unchanged). owner_user_id keeps its existing,
  -- unchanged "inverted" pro_lesson meaning (the Pro's profiles.id).
  -- created_by is the staff member (admin or pro) performing this
  -- booking, not the member — this reservation was not self-service.
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

  -- Create the lesson_requests row already confirmed — proposed_starts_at/
  -- ends_at/court_id carry the actual booked values. last_actor_role is
  -- the caller's actual role (admin or pro), not a hardcoded literal —
  -- correction from 0111/0121, which always wrote 'admin' regardless of
  -- who called this function.
  insert into public.lesson_requests (
    club_id, member_id, pro_id, roster_member_id,
    duration_minutes, member_note, lesson_type_id,
    proposed_starts_at, proposed_ends_at, proposed_court_id,
    status, linked_reservation_id, confirmed_at,
    last_actor_id, last_actor_role
  ) values (
    v_club_id, v_member_id, p_pro_id, p_roster_member_id,
    v_duration_minutes, btrim(coalesce(p_member_note, '')), p_lesson_type_id,
    p_starts_at, p_ends_at, p_court_id,
    'confirmed', v_res_id, now(),
    auth.uid(), v_role
  ) returning * into v_result;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'admin_create_member_lesson', 'lesson_request', v_result.id,
    jsonb_build_object(
      'roster_member_id', p_roster_member_id,
      'member_id',        v_member_id,
      'member_claimed',   v_member_id is not null,
      'pro_id',           p_pro_id,
      'reservation_id',   v_res_id,
      'duration_minutes', v_duration_minutes,
      'actor_role',       v_role
    )
  );

  -- Notify pro — always (has an account by construction). Skipped when the
  -- Pro booked themselves — no need to notify yourself of your own action,
  -- matching the existing self-action-skips-notification convention used
  -- elsewhere in this domain (e.g. cancel_lesson's actor-vs-recipient split).
  if p_pro_id <> auth.uid() then
    insert into public.notifications (club_id, user_id, kind, body, metadata)
    values (
      v_club_id, p_pro_id, 'lesson_request_confirmed',
      'Lesson with ' || v_member_name || ' confirmed for ' ||
        to_char(p_starts_at at time zone v_tz, 'Mon DD "at" HH12:MI AM') || '.',
      jsonb_build_object('request_id', v_result.id, 'reservation_id', v_res_id)
    );
  end if;

  -- Notify member — only if claimed. No-account Members receive no
  -- notification of any kind, unchanged.
  if v_member_id is not null then
    insert into public.notifications (club_id, user_id, kind, body, metadata)
    values (
      v_club_id, v_member_id, 'lesson_request_confirmed',
      'Your lesson with ' ||
        trim(coalesce(v_pro.first_name, '') || ' ' || coalesce(v_pro.last_name, '')) ||
        ' is confirmed for ' || to_char(p_starts_at at time zone v_tz, 'Mon DD "at" HH12:MI AM') || '.',
      jsonb_build_object('request_id', v_result.id, 'reservation_id', v_res_id)
    );
  end if;

  return v_result;
end;
$$;

revoke execute on function public.admin_create_member_lesson(
  uuid, uuid, uuid, uuid, timestamptz, timestamptz, uuid, text
) from public, anon;
grant  execute on function public.admin_create_member_lesson(
  uuid, uuid, uuid, uuid, timestamptz, timestamptz, uuid, text
) to authenticated;

-- ─── Section 2: get_lesson_roster_members — admin+pro roster read ─────────
-- Read-only, club-scoped, active-only roster listing for the Lesson-booking
-- Member picker. roster_members itself stays admin-only RLS (0056) —
-- unchanged; this is a narrow, explicitly-authorized SECURITY DEFINER read
-- path for the one additional (Pro) caller this phase requires, mirroring
-- get_event_eligible_members (0118) / get_program_eligible_roster_members
-- (0117)'s existing admin+pro precedent.

create or replace function public.get_lesson_roster_members()
returns table (
  id         uuid,
  first_name text,
  last_name  text,
  claimed_by uuid
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
  if v_role is null or v_role not in ('admin', 'pro') then raise exception 'insufficient_role'; end if;

  return query
    select rm.id, rm.first_name, rm.last_name, rm.claimed_by
      from public.roster_members rm
     where rm.club_id = v_club_id
       and rm.status   = 'active'
     order by rm.last_name nulls last, rm.first_name nulls last;
end;
$$;

revoke execute on function public.get_lesson_roster_members() from public, anon;
grant  execute on function public.get_lesson_roster_members() to authenticated;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration created in
-- this checkpoint)
-- ═══════════════════════════════════════════════════════════════════════════
-- admin_create_member_lesson: CREATE OR REPLACE using 0121's body verbatim
-- (reintroduces the admin-only role check and the hardcoded 'admin'
-- last_actor_role literal).
-- get_lesson_roster_members: `drop function if exists
-- public.get_lesson_roster_members();`
