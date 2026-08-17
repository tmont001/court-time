-- 0121_fix_staff_lesson_create_conflict.sql
-- Phase 33E3: Runtime QA correction — staff lesson CREATE path is missing
-- the same friendly court-conflict precheck 0120 already added to the EDIT
-- path.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
-- Runtime QA reproduction: Admin attempts to create a confirmed staff-
-- managed lesson (Member, Pro, Court 1, a genuinely future start time) and
-- the UI returns the generic "Something went wrong. Please try again."
--
-- Traced against the live admin_create_member_lesson body (0111,
-- unmodified since — 0119/0120 did not touch it): confirmed there is NO
-- minimum-lead-time rule anywhere in this function or in _lesson_check_
-- operating_hours — the only time-in-the-past guard is
-- `if p_starts_at < now() then raise exception 'cannot_propose_past_time';`,
-- and that code is already friendly-mapped. The selected court had a
-- genuine, pre-existing scheduling conflict at the requested time — this is
-- the exact same class of bug 0120 already fixed for admin_update_member_
-- lesson: admin_create_member_lesson has NO application-level court-
-- conflict precheck (its own comment says so explicitly — "GiST EXCLUDE
-- handles court conflicts atomically — the final authority, same as every
-- other lesson-confirming path"), so a real conflict is only ever caught by
-- the reservations table's GiST EXCLUDE constraint (0003), whose raw,
-- untranslated Postgres error text mapLessonError() cannot match against
-- any known code — it falls through to the generic fallback message.
--
-- Not a lead-time bug. No lead-time/future-time rule is changed here.
--
-- SCOPE — function-only, no schema change:
--   admin_create_member_lesson — CREATE OR REPLACE, same 8-arg signature,
--   live source 0111 (reproduced faithfully). One narrow addition: a
--   court-conflict precheck raising the already-mapped 'court_conflict'
--   error, placed alongside the existing operating-hours/pro/member
--   preflight checks, before the reservation INSERT. No exclusion clause
--   is needed here (unlike 0120's edit-path fix) — a CREATE has no prior
--   linked reservation of its own to conflict against. The reservations
--   GiST EXCLUDE constraint remains untouched and remains the final
--   concurrency authority (this precheck narrows the window, it does not
--   replace the constraint).
--
-- No preflight: no data is transformed or backfilled. No verifier: risk is
-- bounded to one narrow, additive query clause mirroring 0120's own,
-- already-proven-correct pattern (which itself mirrors propose_lesson_
-- time's long-live pattern).
--
-- Not applied by this checkpoint. Not committed. Does not modify 0107-0120.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

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
  if v_role is null or v_role <> 'admin' then raise exception 'insufficient_role'; end if;

  -- Resolve and validate the target roster Member — never trusted as
  -- "proof" of anything beyond its own existence/club scope; the caller's
  -- own admin authorization above is the only authorization this function
  -- relies on.
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

  -- Phase 33E3 fix: court-conflict precheck — mirrors 0120's identical
  -- addition to admin_update_member_lesson (itself mirroring propose_
  -- lesson_time's long-live pattern). No exclusion clause needed: this is
  -- a brand-new booking with no prior linked reservation of its own. A
  -- genuine conflict now raises the friendly, already-mapped
  -- 'court_conflict' error instead of letting the reservations GiST
  -- EXCLUDE constraint (0003) surface an untranslated raw Postgres error
  -- that mapLessonError() cannot match. The constraint itself is
  -- unchanged and remains the final concurrency authority.
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

  -- Member conflict check — unconditional (correction pass — see header
  -- note above). p_roster_member_id always supplied; v_member_id may be
  -- null for a still-unclaimed roster Member.
  perform public._lesson_check_member_availability(v_member_id, p_roster_member_id, p_starts_at, p_ends_at, null);

  -- Create the reservation (GiST EXCLUDE handles court conflicts
  -- atomically — the final authority, same as every other lesson-
  -- confirming path). owner_user_id keeps its existing, unchanged
  -- "inverted" pro_lesson meaning (the Pro's profiles.id). created_by is
  -- the admin performing this booking, not the member or pro — this
  -- reservation was not self-service.
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
  -- ends_at/court_id carry the actual booked values (the existing UI
  -- displays a confirmed lesson's time from these columns; nothing was
  -- literally "proposed" here, matching the same overloaded-field
  -- convention the rest of this domain already uses for a directly-
  -- confirmed lesson).
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
    auth.uid(), 'admin'
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
      'duration_minutes', v_duration_minutes
    )
  );

  -- Notify pro — always (has an account by construction).
  insert into public.notifications (club_id, user_id, kind, body, metadata)
  values (
    v_club_id, p_pro_id, 'lesson_request_confirmed',
    'Lesson with ' || v_member_name || ' confirmed for ' ||
      to_char(p_starts_at at time zone v_tz, 'Mon DD "at" HH12:MI AM') || '.',
    jsonb_build_object('request_id', v_result.id, 'reservation_id', v_res_id)
  );

  -- Notify member — only if claimed. No-account Members receive no
  -- notification of any kind (communications for no-account Members
  -- remain explicitly deferred to Phase 33E, unchanged from every prior
  -- Phase 33 checkpoint).
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

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration created in
-- this checkpoint)
-- ═══════════════════════════════════════════════════════════════════════════
-- Same pre-0121 signature — rollback is a direct CREATE OR REPLACE
-- FUNCTION using 0111's body verbatim (reintroduces the raw-error-fallthrough
-- bug this migration fixes — only do this if 0111's exact behavior is
-- genuinely required for some other reason).
