-- 0120_fix_lesson_edit_self_conflict.sql
-- Phase 33E3: Runtime QA correction — lesson edit self-conflict + missing
-- court-conflict pre-check on the staff lesson edit path.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
-- Runtime QA reproduction: an existing confirmed lesson (Member X, 10:00-
-- 11:00 AM, Court 1) is edited via admin_update_member_lesson, changing
-- ONLY the court (Court 1 -> Court 2), preserving time/Member/Pro. The save
-- fails with 'member_has_conflict' ("The member already has another
-- booking, event, or lesson at that time.") — incorrect: nothing about the
-- Member's schedule actually changed.
--
-- ROOT CAUSE #1 (bug fix 1, below): _lesson_check_member_availability
-- (live since 0111) takes p_exclude_request_id and correctly uses it to
-- exclude the lesson's own row from its LESSON-conflict check (the
-- lesson_requests query), but never applies it to its RESERVATION-conflict
-- check — unlike its sibling _lesson_check_pro_availability (live since
-- 0070), whose equivalent reservation query already excludes the request's
-- own linked_reservation_id. admin_update_member_lesson calls _lesson_
-- check_member_availability with p_exclude_request_id = p_request_id
-- (correct call site — the bug is entirely inside the helper), so editing
-- ANYTHING about an existing confirmed lesson while keeping the same time
-- always self-conflicts against the Member's own still-active linked
-- reservation (only soft-cancelled by admin_update_member_lesson AFTER
-- this check runs). Fixed by adding the identical exclusion clause
-- _lesson_check_pro_availability already has.
--
-- Separately, runtime QA also found a genuine court conflict (editing to
-- an already-occupied court) surfaces as the UI's generic "Something went
-- wrong. Please try again." rather than the friendly, already-mapped
-- court_conflict message ("That court is already occupied at the selected
-- time."). Traced the live scheduling path end to end — no minimum-
-- lead-time / "1 hour" rule exists anywhere in it (_lesson_check_
-- operating_hours only checks open/close hours; admin_update_member_lesson
-- and admin_create_member_lesson both only reject a start time strictly
-- before now(); no client-side lead-time check exists in LessonProSheet.tsx
-- or AdminRequestLessonSheet.tsx). The actual cause:
--
-- ROOT CAUSE #2 (bug fix 2, below): admin_update_member_lesson has NO
-- application-level court-availability pre-check at all — its sibling
-- propose_lesson_time (live since 0111) has one (raises 'court_conflict',
-- excluding the request's own linked reservation), but admin_update_
-- member_lesson relies solely on the reservations table's GiST EXCLUDE
-- constraint (0003) to catch a court double-book. A genuine conflict there
-- produces a raw, untranslated Postgres constraint-violation error, which
-- mapLessonError()'s exact-string lookup (src/app/(app)/lessons/actions.ts)
-- cannot match against any known code, so it falls through to the generic
-- fallback message. Not a lead-time bug — a missing friendly pre-check for
-- a real conflict. admin_create_member_lesson has the identical gap by the
-- same design (its own comment says so explicitly) but is NOT touched here
-- — out of scope: this migration fixes only the reported, reproduced path
-- (admin_update_member_lesson); the create-path gap is pre-existing,
-- deliberate-by-comment, and unrelated to this specific QA finding.
--
-- Fixed by adding the exact same pre-check propose_lesson_time already
-- uses, excluding v_old_reservation.id (this lesson's own currently-linked
-- reservation) — mirrors _lesson_check_pro_availability's proven pattern,
-- gated the same way the existing operating-hours/pro/member checks
-- already are (only when v_scheduling_changed or v_pro_changed).
--
-- SCOPE — function-only, no schema change:
--   1. _lesson_check_member_availability — CREATE OR REPLACE, same 5-arg
--      signature, live source 0111. One added exclusion clause on the
--      reservation-conflict query.
--   2. admin_update_member_lesson — CREATE OR REPLACE, same 10-arg
--      signature, live source 0111. One added court-conflict pre-check
--      inside the existing v_scheduling_changed/v_pro_changed guard block.
--
-- Both functions are reproduced from their exact current (0111) bodies —
-- byte-for-byte except the two additions described above. 0111 itself is
-- NOT modified (already production-applied). No preflight: no data is
-- transformed or backfilled. No verifier: risk is bounded to two narrow,
-- additive query clauses whose correctness is proven by mirroring an
-- already-live, already-correct sibling pattern in both cases.
--
-- Not applied by this checkpoint. Not committed. Does not modify 0107-0119.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. _lesson_check_member_availability — reservation-conflict query now
-- excludes the request's own linked reservation, exactly like _lesson_
-- check_pro_availability's equivalent check and exactly like this same
-- function's own lesson-conflict query three statements below.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public._lesson_check_member_availability(
  p_member_id           uuid,
  p_roster_member_id    uuid,
  p_starts_at           timestamptz,
  p_ends_at             timestamptz,
  p_exclude_request_id  uuid default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_conflict int;
  v_range    tstzrange;
begin
  v_range := tstzrange(p_starts_at, p_ends_at, '[)');

  -- Check overlapping court reservations owned by the member (by
  -- authenticated owner_user_id) OR attributed to the same durable roster
  -- identity (roster_member_id — populated for both member_booking, since
  -- 0108, and, as of this migration, pro_lesson reservations). p_member_id
  -- may be null (still-unclaimed roster Member); p_roster_member_id is
  -- always supplied by every call site, claimed or not.
  --
  -- Phase 33E3 fix: excludes the reservation currently linked to the
  -- lesson request being (re)proposed/edited against itself — without
  -- this, editing anything about an existing confirmed lesson while
  -- keeping the same time always self-conflicts against the Member's own
  -- still-active linked reservation. Mirrors _lesson_check_pro_
  -- availability's identical, already-correct exclusion.
  select count(*) into v_conflict
    from public.reservations r
   where r.status in ('pending', 'confirmed')
     and tstzrange(r.starts_at, r.ends_at, '[)') && v_range
     and (
       (p_member_id is not null and r.owner_user_id = p_member_id)
       or (p_roster_member_id is not null and r.roster_member_id = p_roster_member_id)
     )
     and (p_exclude_request_id is null
          or r.id not in (
            select linked_reservation_id from public.lesson_requests
             where id = p_exclude_request_id
               and linked_reservation_id is not null
          ));
  if v_conflict > 0 then raise exception 'member_has_conflict'; end if;

  -- Check overlapping event participation. NOT extended to roster_
  -- member_id: event_participants has no roster-identity column, and a
  -- no-account Member cannot join an event at all today (joining requires
  -- an authenticated profile_id) — there is no data this category could
  -- check for one. This is the one genuine, reported cross-domain
  -- limitation from this correction pass (see the migration header) —
  -- events/programs are explicitly out of scope for 33D1. Skipped
  -- entirely when p_member_id is null, exactly as before this migration.
  if p_member_id is not null then
    select count(*) into v_conflict
      from public.event_participants ep
      join public.reservations       er on er.event_id  = ep.event_id
                                       and er.status     in ('pending', 'confirmed')
                                       and tstzrange(er.starts_at, er.ends_at, '[)') && v_range
     where ep.profile_id = p_member_id
       and ep.status     in ('confirmed', 'offered');
    if v_conflict > 0 then raise exception 'member_has_event_conflict'; end if;
  end if;

  -- Check overlapping confirmed lessons the member is party to — by
  -- historical member_id OR by durable roster_member_id (same-migration
  -- extension, not cross-domain: this is the very table roster_member_id
  -- was just added to). Excludes the request being (re)proposed against
  -- itself — without this, a reschedule proposal that overlaps the
  -- still-active original confirmed time would incorrectly flag the
  -- lesson as conflicting with itself.
  select count(*) into v_conflict
    from public.lesson_requests lr
   where lr.status = 'confirmed'
     and tstzrange(lr.proposed_starts_at, lr.proposed_ends_at, '[)') && v_range
     and (p_exclude_request_id is null or lr.id is distinct from p_exclude_request_id)
     and (
       (p_member_id is not null and lr.member_id = p_member_id)
       or (p_roster_member_id is not null and lr.roster_member_id = p_roster_member_id)
     );
  if v_conflict > 0 then raise exception 'member_has_lesson_conflict'; end if;
end;
$$;

revoke execute on function public._lesson_check_member_availability(uuid, uuid, timestamptz, timestamptz, uuid) from public, anon;


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. admin_update_member_lesson — gains a court-conflict pre-check
-- (excluding this lesson's own currently-linked reservation), mirroring
-- propose_lesson_time's already-live pattern, so a genuine court double-
-- book raises the friendly, already-mapped 'court_conflict' error instead
-- of an untranslated raw Postgres constraint-violation message.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.admin_update_member_lesson(
  p_request_id          uuid,
  p_expected_club_id    uuid,
  p_expected_updated_at timestamptz,
  p_roster_member_id    uuid,
  p_pro_id              uuid,
  p_court_id            uuid,
  p_starts_at           timestamptz,
  p_ends_at             timestamptz,
  p_lesson_type_id      uuid default null,
  p_member_note         text default null
)
returns public.lesson_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
  if v_role is null or v_role <> 'admin' then raise exception 'insufficient_role'; end if;

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
         last_actor_role     = 'admin',
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
$$;

revoke execute on function public.admin_update_member_lesson(
  uuid, uuid, timestamptz, uuid, uuid, uuid, timestamptz, timestamptz, uuid, text
) from public, anon;
grant  execute on function public.admin_update_member_lesson(
  uuid, uuid, timestamptz, uuid, uuid, uuid, timestamptz, timestamptz, uuid, text
) to authenticated;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration created in
-- this checkpoint)
-- ═══════════════════════════════════════════════════════════════════════════
-- Both functions kept their exact pre-0120 signatures — rollback is a
-- direct CREATE OR REPLACE FUNCTION for each, using 0111's bodies verbatim
-- (reintroduces both bugs this migration fixes — only do this if 0111's
-- exact behavior is genuinely required for some other reason).
