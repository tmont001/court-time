-- 0101_lesson_reschedule_foundation.sql
-- Phase 30E: confirmed-lesson rescheduling via re-propose / re-confirm.
--
-- Locked product workflow (Phase 30E audit): Admin (any same-club lesson) or
-- the currently assigned Pro (their own lesson only) may propose a revised
-- date, start time, and court for an already-confirmed lesson. Duration is
-- unchanged by this phase — every proposal, original or reschedule, must
-- still match the request's existing duration_minutes exactly
-- (duration_mismatch, unchanged validation). The Member must explicitly
-- accept the revised proposal — nothing moves unilaterally. The original
-- confirmed reservation remains fully active and visible on Calendar until
-- acceptance; it is only cancelled, atomically, at the moment a replacement
-- reservation is inserted. Declining a reschedule restores the
-- lesson_request to 'confirmed' using the still-untouched linked
-- reservation as the authoritative source of the original time — never
-- lesson_requests.proposed_starts_at, which by then holds the new
-- candidate, not the original.
--
-- No tables, columns, notification kinds, or RLS policies are added. This
-- migration redefines the eight functions required for the workflow and to
-- protect the new pending-reschedule state from every other lesson
-- mutation RPC that could otherwise orphan the still-active original
-- reservation:
--   1. _lesson_check_member_availability — widened with the same
--      p_exclude_request_id self-conflict exclusion that
--      _lesson_check_pro_availability already had (added in 0070, but never
--      wired up for the member-side "overlapping confirmed lesson" check).
--   2. propose_lesson_time — allow proposing/re-proposing against a
--      'confirmed' or pending-reschedule 'proposed' request; add required
--      optimistic concurrency (p_expected_updated_at); guard against
--      rescheduling an already-started confirmed lesson; exclude the
--      request's own linked reservation from every conflict check.
--   3. accept_lesson_proposal — when linked_reservation_id is already set,
--      soft-cancel the old confirmed reservation (cancellation_kind='system')
--      before inserting the replacement, in the same transaction; reject if
--      the original lesson has already started (cannot_reschedule_started_lesson)
--      before touching the old reservation at all; revalidate the proposed
--      court is still active and same-club before either mutation
--      (court_not_found).
--   4. decline_lesson_proposal — when linked_reservation_id is set, restore
--      'confirmed' status and the original proposed_* fields from the
--      still-active linked reservation (now locked FOR UPDATE before the
--      restore), instead of reverting to 'pending'.
--   5. cancel_lesson — widen eligibility to also allow cancelling a
--      confirmed lesson with a pending reschedule proposal outstanding
--      (status='proposed' AND linked_reservation_id is not null); evaluate
--      the "already started"/cancellation-window guards against the
--      authoritative linked reservation's time, not the in-flight proposed
--      candidate.
--   6. withdraw_lesson_request — reject when the request is a pending
--      reschedule (status='proposed' with linked_reservation_id set); an
--      ordinary first-time pending/proposed request is unaffected. Without
--      this, a member could withdraw mid-reschedule and leave the original
--      confirmed reservation permanently orphaned (never cancelled, never
--      referenced by any live request).
--   7. decline_lesson_request — same pending-reschedule rejection. Without
--      it, declining "the whole request" during a pending reschedule would
--      move status to 'declined' while the original confirmed reservation
--      stayed active and orphaned.
--   8. reassign_lesson_provider — same pending-reschedule rejection.
--      Without it, reassigning the provider mid-reschedule would move
--      status to 'pending' under a *new* pro_id while linked_reservation_id
--      kept pointing at a reservation still owned by the *old* pro —
--      inconsistent ownership that a later propose_lesson_time/
--      accept_lesson_proposal call would then act on incorrectly.
-- Each of these three guards reuses that function's own existing
-- status-guard exception code (invalid_status_for_withdraw/_decline/
-- _reassign) — the pending-reschedule case is simply folded into "not an
-- eligible status for this action," no new error code introduced.
--
-- Does not modify migrations 0097–0100. Does not touch event, maintenance,
-- or personal-reservation (member_booking) behavior. Provider reassignment
-- on an ordinary confirmed lesson remains unsupported, unchanged, per the
-- Phase 30E audit — reassign_lesson_provider's only change here is the
-- pending-reschedule guard above.
-- Apply in Supabase SQL Editor (cloud only).

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. _lesson_check_member_availability — add p_exclude_request_id
-- ═══════════════════════════════════════════════════════════════════════════
-- Adding a parameter changes the signature even with a default value —
-- create-or-replace would add a new 4-arg overload alongside the old 3-arg
-- one rather than replacing it. This function is private (revoked from
-- public/anon, never granted to authenticated — only reachable via an
-- internal call from another SECURITY DEFINER function), so a stray old
-- overload has no security exposure, but the old 3-arg signature is
-- dropped anyway to leave exactly one, matching the rigor applied to
-- propose_lesson_time below and avoiding any overload ambiguity.

drop function if exists public._lesson_check_member_availability(uuid, timestamptz, timestamptz);

create or replace function public._lesson_check_member_availability(
  p_member_id           uuid,
  p_starts_at           timestamptz,
  p_ends_at             timestamptz,
  p_exclude_request_id  uuid default null  -- exclude this request's own confirmed lesson from the "member has lesson conflict" check
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

  -- Check overlapping court reservations owned by the member
  select count(*) into v_conflict
    from public.reservations r
   where r.owner_user_id = p_member_id
     and r.status        in ('pending', 'confirmed')
     and tstzrange(r.starts_at, r.ends_at, '[)') && v_range;
  if v_conflict > 0 then raise exception 'member_has_conflict'; end if;

  -- Check overlapping event participation
  select count(*) into v_conflict
    from public.event_participants ep
    join public.reservations       er on er.event_id  = ep.event_id
                                     and er.status     in ('pending', 'confirmed')
                                     and tstzrange(er.starts_at, er.ends_at, '[)') && v_range
   where ep.profile_id = p_member_id
     and ep.status     in ('confirmed', 'offered');
  if v_conflict > 0 then raise exception 'member_has_event_conflict'; end if;

  -- Check overlapping confirmed lessons the member is party to. Excludes
  -- the request being (re)proposed against itself — without this, a
  -- reschedule proposal that overlaps the still-active original confirmed
  -- time would incorrectly flag the lesson as conflicting with itself.
  select count(*) into v_conflict
    from public.lesson_requests lr
   where lr.member_id           = p_member_id
     and lr.status              = 'confirmed'
     and tstzrange(lr.proposed_starts_at, lr.proposed_ends_at, '[)') && v_range
     and (p_exclude_request_id is null or lr.id is distinct from p_exclude_request_id);
  if v_conflict > 0 then raise exception 'member_has_lesson_conflict'; end if;
end;
$$;

revoke execute on function public._lesson_check_member_availability(uuid, timestamptz, timestamptz, uuid) from public, anon;


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. propose_lesson_time — reschedule-eligible + optimistic concurrency
-- ═══════════════════════════════════════════════════════════════════════════
-- The deployed signature (from 0073) is
-- propose_lesson_time(uuid, timestamptz, timestamptz, uuid). Adding
-- p_expected_updated_at changes the argument list, so Postgres would treat
-- create-or-replace as a *new* overload rather than a replacement — the old
-- 4-arg signature must be dropped explicitly or it remains callable
-- (bypassing the new concurrency check and reschedule eligibility) forever.

drop function if exists public.propose_lesson_time(uuid, timestamptz, timestamptz, uuid);

create or replace function public.propose_lesson_time(
  p_request_id            uuid,
  p_expected_updated_at   timestamptz,
  p_starts_at             timestamptz,
  p_ends_at               timestamptz,
  p_court_id              uuid default null
)
returns public.lesson_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile        public.profiles%rowtype;
  v_request        public.lesson_requests%rowtype;
  v_result         public.lesson_requests%rowtype;
  v_old_reservation public.reservations%rowtype;
  v_is_reschedule  boolean;
  v_tz             text;
begin
  select * into v_profile from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.club_id is null then raise exception 'no_club'; end if;
  if v_profile.role not in ('pro', 'admin') then raise exception 'insufficient_role'; end if;

  select * into v_request
    from public.lesson_requests
   where id      = p_request_id
     and club_id = v_profile.club_id
   for update;
  if not found then raise exception 'request_not_found'; end if;

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

  -- Member conflicts — same self-exclusion.
  perform public._lesson_check_member_availability(
    v_request.member_id,
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

  insert into public.notifications (club_id, user_id, kind, body, metadata)
  values (
    v_profile.club_id,
    v_request.member_id,
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
$$;

revoke execute on function public.propose_lesson_time(uuid, timestamptz, timestamptz, timestamptz, uuid) from public, anon;
grant  execute on function public.propose_lesson_time(uuid, timestamptz, timestamptz, timestamptz, uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. accept_lesson_proposal — replace the old reservation atomically
-- ═══════════════════════════════════════════════════════════════════════════
-- Signature unchanged (still accept_lesson_proposal(uuid)) — no drop needed.

create or replace function public.accept_lesson_proposal(
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile         public.profiles%rowtype;
  v_request         public.lesson_requests%rowtype;
  v_pro             public.profiles%rowtype;
  v_member          public.profiles%rowtype;
  v_old_reservation public.reservations%rowtype;
  v_is_reschedule   boolean;
  v_tz              text;
  v_res_id          uuid;
  v_time_label      text;
begin
  select * into v_profile from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.club_id is null then raise exception 'no_club'; end if;

  -- Fetch and row-lock
  select * into v_request
    from public.lesson_requests
   where id      = p_request_id
     and club_id = v_profile.club_id
   for update;
  if not found then raise exception 'request_not_found'; end if;

  -- Only the member who submitted can accept
  if v_request.member_id <> auth.uid() then raise exception 'not_your_request'; end if;

  -- Must be in 'proposed' status
  if v_request.status <> 'proposed' then raise exception 'invalid_status_for_accept'; end if;

  -- proposed_starts_at / proposed_ends_at must be populated (enforced by constraint but guard anyway)
  if v_request.proposed_starts_at is null or v_request.proposed_ends_at is null then
    raise exception 'proposed_time_missing';
  end if;

  -- Proposed time must still be in the future
  if v_request.proposed_starts_at <= now() then raise exception 'proposed_time_in_past'; end if;

  -- Court required
  if v_request.proposed_court_id is null then raise exception 'proposed_court_missing'; end if;

  -- Revalidate the proposed court is still active and belongs to this club
  -- — it may have been deactivated at any point between proposal and
  -- acceptance. Uses the same court_not_found vocabulary as
  -- propose_lesson_time's own court check. Applies to every acceptance,
  -- not only a reschedule — accept_lesson_proposal previously trusted
  -- proposed_court_id unconditionally.
  if not exists (
    select 1 from public.courts
     where id        = v_request.proposed_court_id
       and club_id   = v_profile.club_id
       and is_active = true
  ) then
    raise exception 'court_not_found';
  end if;

  v_is_reschedule := v_request.linked_reservation_id is not null;

  -- Reschedule: lock and soft-cancel the old confirmed reservation before
  -- inserting its replacement, in this same transaction. Any failure below
  -- (including a genuine court conflict on the new slot, raised as Postgres
  -- 23P01 by the GiST exclusion constraint) rolls back this entire
  -- function, so the old reservation is left exactly as it was —
  -- 'confirmed' — never left cancelled with no replacement.
  if v_is_reschedule then
    select * into v_old_reservation
      from public.reservations
     where id      = v_request.linked_reservation_id
       and club_id = v_profile.club_id
       and reason  = 'pro_lesson'
       and status  = 'confirmed'
     for update;
    if not found then raise exception 'linked_reservation_not_found'; end if;

    -- The original lesson may have started (or already ended) in the time
    -- between proposal and acceptance. Checked before any mutation —
    -- including the old reservation's own cancellation below — so a stale
    -- acceptance can never cancel a lesson that has already happened.
    if v_old_reservation.starts_at <= now() then
      raise exception 'cannot_reschedule_started_lesson';
    end if;

    update public.reservations
       set status            = 'cancelled',
           cancelled_at      = now(),
           cancelled_by      = auth.uid(),
           cancellation_kind = 'system',
           updated_at        = now()
     where id = v_old_reservation.id;
  end if;

  -- Operating hours check
  select timezone into v_tz from public.clubs where id = v_profile.club_id;
  perform public._lesson_check_operating_hours(
    v_profile.club_id,
    v_request.proposed_starts_at,
    v_request.proposed_ends_at,
    v_tz
  );

  -- Pro availability check — excludes this request's own (already
  -- soft-cancelled above, if a reschedule) linked reservation.
  perform public._lesson_check_pro_availability(
    v_request.pro_id,
    v_request.proposed_starts_at,
    v_request.proposed_ends_at,
    v_request.id
  );

  -- Member availability check (caller is the member accepting)
  perform public._lesson_check_member_availability(
    auth.uid(),
    v_request.proposed_starts_at,
    v_request.proposed_ends_at,
    v_request.id
  );

  -- Fetch names for notifications
  select * into v_pro    from public.profiles where id = v_request.pro_id;
  select * into v_member from public.profiles where id = auth.uid();

  -- Create the replacement reservation (GiST EXCLUDE handles court conflicts atomically)
  insert into public.reservations (
    club_id, court_id, owner_user_id,
    starts_at, ends_at, status, reason,
    notes, show_notes_to_members, created_by
  ) values (
    v_profile.club_id,
    v_request.proposed_court_id,
    v_request.pro_id,
    v_request.proposed_starts_at,
    v_request.proposed_ends_at,
    'confirmed',
    'pro_lesson',
    'Pro lesson with ' || trim(coalesce(v_member.first_name, '') || ' ' || coalesce(v_member.last_name, '')),
    false,
    auth.uid()
  ) returning id into v_res_id;

  -- Update the request
  update public.lesson_requests
     set status               = 'confirmed',
         linked_reservation_id = v_res_id,
         confirmed_at         = now(),
         last_actor_id        = auth.uid(),
         last_actor_role      = 'member',
         updated_at           = now()
   where id = p_request_id;

  v_time_label := to_char(v_request.proposed_starts_at at time zone v_tz, 'Mon DD "at" HH12:MI AM');

  -- Notify member
  insert into public.notifications (club_id, user_id, kind, body, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'lesson_request_confirmed',
    'Your lesson with ' ||
      trim(coalesce(v_pro.first_name, '') || ' ' || coalesce(v_pro.last_name, '')) ||
      ' is confirmed for ' || v_time_label || '.',
    jsonb_build_object('request_id', p_request_id, 'reservation_id', v_res_id)
  );

  -- Notify pro
  insert into public.notifications (club_id, user_id, kind, body, metadata)
  values (
    v_profile.club_id,
    v_request.pro_id,
    'lesson_request_confirmed',
    'Lesson with ' ||
      trim(coalesce(v_member.first_name, '') || ' ' || coalesce(v_member.last_name, '')) ||
      ' confirmed for ' || v_time_label || '.',
    jsonb_build_object('request_id', p_request_id, 'reservation_id', v_res_id)
  );

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id, auth.uid(), 'accept_lesson_proposal', 'lesson_request', p_request_id,
    jsonb_build_object(
      'reservation_id',     v_res_id,
      'new_reservation_id', v_res_id,
      'old_reservation_id', case when v_is_reschedule then v_old_reservation.id else null end,
      'is_reschedule',      v_is_reschedule
    )
  );

  return jsonb_build_object('request_id', p_request_id, 'reservation_id', v_res_id);
end;
$$;

revoke execute on function public.accept_lesson_proposal(uuid) from public, anon;
grant  execute on function public.accept_lesson_proposal(uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. decline_lesson_proposal — restore original confirmed lesson
-- ═══════════════════════════════════════════════════════════════════════════
-- Signature unchanged (still decline_lesson_proposal(uuid)) — no drop needed.

create or replace function public.decline_lesson_proposal(
  p_request_id uuid
)
returns public.lesson_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile         public.profiles%rowtype;
  v_request         public.lesson_requests%rowtype;
  v_result          public.lesson_requests%rowtype;
  v_old_reservation public.reservations%rowtype;
  v_is_reschedule   boolean;
begin
  select * into v_profile from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.club_id is null then raise exception 'no_club'; end if;

  select * into v_request
    from public.lesson_requests
   where id      = p_request_id
     and club_id = v_profile.club_id
   for update;
  if not found then raise exception 'request_not_found'; end if;

  if v_request.member_id <> auth.uid() then raise exception 'not_your_request'; end if;
  if v_request.status <> 'proposed' then raise exception 'invalid_status_for_decline_proposal'; end if;

  v_is_reschedule := v_request.linked_reservation_id is not null;

  if v_is_reschedule then
    -- Restore from the still-untouched linked reservation — the
    -- authoritative original confirmed lesson. Locked FOR UPDATE before
    -- reading, consistent with every other place this migration treats
    -- the linked reservation as authoritative. The reservation itself is
    -- left completely alone; only the request's status and proposed_*
    -- fields are reverted to mirror it again.
    select * into v_old_reservation
      from public.reservations
     where id      = v_request.linked_reservation_id
       and club_id = v_profile.club_id
       and reason  = 'pro_lesson'
       and status  = 'confirmed'
     for update;
    if not found then raise exception 'linked_reservation_not_found'; end if;

    update public.lesson_requests
       set status              = 'confirmed',
           proposed_starts_at  = v_old_reservation.starts_at,
           proposed_ends_at    = v_old_reservation.ends_at,
           proposed_court_id   = v_old_reservation.court_id,
           last_actor_id       = auth.uid(),
           last_actor_role     = 'member',
           updated_at          = now()
     where id = p_request_id
    returning * into v_result;
  else
    update public.lesson_requests
       set status              = 'pending',
           proposed_starts_at  = null,
           proposed_ends_at    = null,
           proposed_court_id   = null,
           last_actor_id       = auth.uid(),
           last_actor_role     = 'member',
           updated_at          = now()
     where id = p_request_id
    returning * into v_result;
  end if;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id, auth.uid(), 'decline_lesson_proposal', 'lesson_request', p_request_id,
    jsonb_build_object(
      'previous_proposed_starts_at', v_request.proposed_starts_at,
      'is_reschedule',               v_is_reschedule,
      'restored_starts_at',          case when v_is_reschedule then v_old_reservation.starts_at else null end
    )
  );

  return v_result;
end;
$$;

revoke execute on function public.decline_lesson_proposal(uuid) from public, anon;
grant  execute on function public.decline_lesson_proposal(uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 5. cancel_lesson — allow cancelling while a reschedule is pending
-- ═══════════════════════════════════════════════════════════════════════════
-- Signature unchanged (still cancel_lesson(uuid, text)) — no drop needed.

create or replace function public.cancel_lesson(
  p_request_id uuid,
  p_reason     text default null
)
returns public.lesson_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile          public.profiles%rowtype;
  v_request          public.lesson_requests%rowtype;
  v_actor_role        text;
  v_result            public.lesson_requests%rowtype;
  v_member             public.profiles%rowtype;
  v_pro                public.profiles%rowtype;
  v_window_hours       int;
  v_old_reservation    public.reservations%rowtype;
  v_effective_starts_at timestamptz;
begin
  select * into v_profile from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.club_id is null then raise exception 'no_club'; end if;

  select * into v_request
    from public.lesson_requests
   where id      = p_request_id
     and club_id = v_profile.club_id
   for update;
  if not found then raise exception 'request_not_found'; end if;

  -- Authorisation: member of the lesson, the pro, or an admin
  if v_request.member_id <> auth.uid()
     and v_request.pro_id    <> auth.uid()
     and v_profile.role      <> 'admin' then
    raise exception 'not_authorised_to_cancel';
  end if;

  -- Eligible: an ordinary confirmed lesson, or a confirmed lesson with a
  -- reschedule proposal currently pending (status='proposed' with a linked
  -- reservation still active). An ordinary first-time proposal
  -- (status='proposed', linked_reservation_id null) remains ineligible —
  -- it is declined or withdrawn, never "cancelled".
  if not (
    v_request.status = 'confirmed'
    or (v_request.status = 'proposed' and v_request.linked_reservation_id is not null)
  ) then
    raise exception 'invalid_status_for_cancel';
  end if;

  -- Authoritative original confirmed lesson time. Once a reschedule is
  -- pending, proposed_starts_at holds the new candidate, not the lesson
  -- that is actually still on the calendar — the linked reservation (if
  -- any) is locked here and used for every time-based guard below.
  if v_request.linked_reservation_id is not null then
    select * into v_old_reservation
      from public.reservations
     where id      = v_request.linked_reservation_id
       and club_id = v_profile.club_id
       and reason  = 'pro_lesson'
       and status  = 'confirmed'
     for update;
    if not found then raise exception 'linked_reservation_not_found'; end if;
    v_effective_starts_at := v_old_reservation.starts_at;
  else
    v_effective_starts_at := v_request.proposed_starts_at;
  end if;

  -- Block cancellation of already-started or past lessons by non-admins
  if v_effective_starts_at <= now() and v_profile.role <> 'admin' then
    raise exception 'lesson_already_started';
  end if;

  -- Derive actor role for audit / notification context
  v_actor_role := case
    when v_profile.role = 'admin' then 'admin'
    when auth.uid() = v_request.pro_id then 'pro'
    else 'member'
  end;

  -- Honor the club's cancellation window for member-initiated cancellations
  if v_actor_role = 'member' then
    select coalesce(cs.cancellation_window_hours, 24) into v_window_hours
      from public.club_settings cs
     where cs.club_id = v_profile.club_id;
    if (extract(epoch from (v_effective_starts_at - now())) / 3600) < v_window_hours then
      raise exception 'within_cancellation_window';
    end if;
  end if;

  -- Cancel the linked reservation (the still-active original — the same
  -- row locked above when present).
  -- cancellation_kind only allows 'member'|'admin'|'system'; map 'pro' → 'admin'.
  if v_request.linked_reservation_id is not null then
    update public.reservations
       set status            = 'cancelled',
           cancelled_at      = now(),
           cancelled_by      = auth.uid(),
           cancellation_kind = case when v_actor_role = 'member' then 'member' else 'admin' end
     where id = v_request.linked_reservation_id;
  end if;

  -- Update the request; set lesson_outcome = 'cancelled' so status and outcome
  -- remain consistent (outcome is never left null for a cancelled lesson).
  -- Any pending reschedule candidate in proposed_* is discarded as
  -- unresolved — status='cancelled' makes those fields purely historical.
  update public.lesson_requests
     set status              = 'cancelled',
         lesson_outcome      = 'cancelled',
         cancellation_reason = p_reason,
         cancelled_at        = now(),
         cancelled_by        = auth.uid(),
         last_actor_id       = auth.uid(),
         last_actor_role     = v_actor_role,
         updated_at          = now()
   where id = p_request_id
  returning * into v_result;

  -- Fetch names for notification bodies
  select * into v_member from public.profiles where id = v_request.member_id;
  select * into v_pro    from public.profiles where id = v_request.pro_id;

  -- Notify both parties (skip actor — they already know)
  if auth.uid() <> v_request.member_id then
    insert into public.notifications (club_id, user_id, kind, body, metadata)
    values (
      v_profile.club_id,
      v_request.member_id,
      'lesson_cancelled',
      'Your lesson with ' ||
        trim(coalesce(v_pro.first_name, '') || ' ' || coalesce(v_pro.last_name, '')) ||
        ' has been cancelled.' ||
        case when p_reason is not null and btrim(p_reason) <> ''
             then ' Reason: ' || btrim(p_reason)
             else ''
        end,
      jsonb_build_object('request_id', p_request_id)
    );
  end if;

  if auth.uid() <> v_request.pro_id then
    insert into public.notifications (club_id, user_id, kind, body, metadata)
    values (
      v_profile.club_id,
      v_request.pro_id,
      'lesson_cancelled',
      'Lesson with ' ||
        trim(coalesce(v_member.first_name, '') || ' ' || coalesce(v_member.last_name, '')) ||
        ' has been cancelled.' ||
        case when p_reason is not null and btrim(p_reason) <> ''
             then ' Reason: ' || btrim(p_reason)
             else ''
        end,
      jsonb_build_object('request_id', p_request_id)
    );
  end if;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id, auth.uid(), 'cancel_lesson', 'lesson_request', p_request_id,
    jsonb_build_object(
      'reason',              p_reason,
      'reservation_id',      v_request.linked_reservation_id,
      'cancelled_during_pending_reschedule', v_request.status = 'proposed'
    )
  );

  return v_result;
end;
$$;

revoke execute on function public.cancel_lesson(uuid, text) from public, anon;
grant  execute on function public.cancel_lesson(uuid, text) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 6. withdraw_lesson_request — reject a pending reschedule
-- ═══════════════════════════════════════════════════════════════════════════
-- Signature unchanged (still withdraw_lesson_request(uuid)) — no drop
-- needed. Full body otherwise unchanged from 0069 — only the status guard
-- gains the pending-reschedule OR clause, reusing the existing
-- invalid_status_for_withdraw code.

create or replace function public.withdraw_lesson_request(
  p_request_id uuid
)
returns public.lesson_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile public.profiles%rowtype;
  v_request public.lesson_requests%rowtype;
  v_result  public.lesson_requests%rowtype;
begin
  select * into v_profile from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.club_id is null then raise exception 'no_club'; end if;

  -- Fetch and lock the request
  select * into v_request
    from public.lesson_requests
   where id      = p_request_id
     and club_id = v_profile.club_id
   for update;
  if not found then raise exception 'request_not_found'; end if;

  -- Only the member who submitted can withdraw
  if v_request.member_id <> auth.uid() then raise exception 'not_your_request'; end if;

  -- Only pending or proposed requests can be withdrawn. A pending
  -- reschedule (status='proposed' with linked_reservation_id set) is
  -- explicitly excluded — withdrawing here would leave the still-active
  -- original confirmed reservation permanently orphaned, since this path
  -- never touches linked_reservation_id or the reservations table at all.
  -- Use accept_lesson_proposal, decline_lesson_proposal, or cancel_lesson
  -- instead for a pending reschedule.
  if v_request.status not in ('pending', 'proposed')
     or (v_request.status = 'proposed' and v_request.linked_reservation_id is not null)
  then
    raise exception 'invalid_status_for_withdraw';
  end if;

  update public.lesson_requests
     set status         = 'withdrawn',
         last_actor_id  = auth.uid(),
         last_actor_role = 'member',
         updated_at     = now()
   where id = p_request_id
  returning * into v_result;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id, auth.uid(), 'withdraw_lesson_request', 'lesson_request', p_request_id,
    jsonb_build_object('previous_status', v_request.status)
  );

  return v_result;
end;
$$;

revoke execute on function public.withdraw_lesson_request(uuid) from public, anon;
grant  execute on function public.withdraw_lesson_request(uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 7. decline_lesson_request — reject a pending reschedule
-- ═══════════════════════════════════════════════════════════════════════════
-- Signature unchanged (still decline_lesson_request(uuid, text)) — no drop
-- needed. Full body otherwise unchanged from 0072 — only the status guard
-- gains the pending-reschedule OR clause, reusing the existing
-- invalid_status_for_decline code.

create or replace function public.decline_lesson_request(
  p_request_id uuid,
  p_reason     text default null
)
returns public.lesson_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile public.profiles%rowtype;
  v_request public.lesson_requests%rowtype;
  v_result  public.lesson_requests%rowtype;
begin
  select * into v_profile from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.club_id is null then raise exception 'no_club'; end if;
  if v_profile.role not in ('pro', 'admin') then raise exception 'insufficient_role'; end if;

  select * into v_request
    from public.lesson_requests
   where id      = p_request_id
     and club_id = v_profile.club_id
   for update;
  if not found then raise exception 'request_not_found'; end if;

  if v_profile.role = 'pro' and v_request.pro_id <> auth.uid() then
    raise exception 'not_assigned_pro';
  end if;

  -- A pending reschedule (status='proposed' with linked_reservation_id
  -- set) is explicitly excluded — declining "the whole request" here would
  -- move status to 'declined' while the original confirmed reservation
  -- stayed active and orphaned, since this path never touches
  -- linked_reservation_id or the reservations table. Use
  -- decline_lesson_proposal or cancel_lesson instead for a pending
  -- reschedule.
  if v_request.status not in ('pending', 'proposed')
     or (v_request.status = 'proposed' and v_request.linked_reservation_id is not null)
  then
    raise exception 'invalid_status_for_decline';
  end if;

  update public.lesson_requests
     set status          = 'declined',
         decline_reason  = p_reason,
         declined_at     = now(),
         last_actor_id   = auth.uid(),
         last_actor_role = v_profile.role,
         updated_at      = now()
   where id = p_request_id
  returning * into v_result;

  -- Notify the member
  insert into public.notifications (club_id, user_id, kind, body, metadata)
  values (
    v_profile.club_id,
    v_request.member_id,
    'lesson_request_declined',
    trim(coalesce(v_profile.first_name, '') || ' ' || coalesce(v_profile.last_name, '')) ||
      ' is unable to take your lesson request.' ||
      case when p_reason is not null and btrim(p_reason) <> ''
           then ' Reason: ' || btrim(p_reason)
           else ''
      end,
    jsonb_build_object('request_id', p_request_id, 'target_path', '/lessons')
  );

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id, auth.uid(), 'decline_lesson_request', 'lesson_request', p_request_id,
    jsonb_build_object('reason', p_reason)
  );

  return v_result;
end;
$$;

revoke execute on function public.decline_lesson_request(uuid, text) from public, anon;
grant  execute on function public.decline_lesson_request(uuid, text) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 8. reassign_lesson_provider — reject a pending reschedule
-- ═══════════════════════════════════════════════════════════════════════════
-- Signature unchanged (still reassign_lesson_provider(uuid, uuid)) — no
-- drop needed. Full body otherwise unchanged from 0078 — only the status
-- guard gains the pending-reschedule OR clause, reusing the existing
-- invalid_status_for_reassign code.

create or replace function public.reassign_lesson_provider(
  p_request_id  uuid,
  p_new_pro_id  uuid
)
returns public.lesson_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor      public.profiles%rowtype;
  v_request    public.lesson_requests%rowtype;
  v_new_pro    public.profiles%rowtype;
  v_member     public.profiles%rowtype;
  v_result     public.lesson_requests%rowtype;
  v_old_pro_id uuid;
  v_old_status text;
begin
  select pr.* into v_actor from public.profiles pr where pr.id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_actor.club_id is null then raise exception 'no_club'; end if;
  if v_actor.role <> 'admin' then raise exception 'insufficient_role'; end if;

  -- Load and lock the request
  select lr.* into v_request
    from public.lesson_requests lr
   where lr.id      = p_request_id
     and lr.club_id = v_actor.club_id
   for update;
  if not found then raise exception 'request_not_found'; end if;

  -- Only pending or proposed can be reassigned. A pending reschedule
  -- (status='proposed' with linked_reservation_id set) is explicitly
  -- excluded — this path reassigns pro_id and resets status to 'pending'
  -- without ever touching linked_reservation_id, which would otherwise
  -- keep pointing at a reservation still owned by the *old* pro under a
  -- request now assigned to a *new* one. Reassigning a confirmed lesson's
  -- provider remains unsupported entirely, unchanged from before this
  -- migration.
  if v_request.status not in ('pending', 'proposed')
     or (v_request.status = 'proposed' and v_request.linked_reservation_id is not null)
  then
    raise exception 'invalid_status_for_reassign';
  end if;

  -- Validate new provider: active, same club, role pro or admin, is_lesson_provider
  select pr.* into v_new_pro from public.profiles pr
   where pr.id                 = p_new_pro_id
     and pr.club_id            = v_actor.club_id
     and pr.status             = 'active'
     and pr.role               in ('pro', 'admin')
     and pr.is_lesson_provider = true;
  if not found then raise exception 'pro_not_found'; end if;

  -- Cannot reassign to the same provider
  if v_request.pro_id = p_new_pro_id then
    raise exception 'same_pro';
  end if;

  -- Cannot reassign to the member themselves
  if v_request.member_id = p_new_pro_id then
    raise exception 'cannot_assign_to_self';
  end if;

  v_old_pro_id := v_request.pro_id;
  v_old_status := v_request.status;

  -- Load member for notification body
  select pr.* into v_member from public.profiles pr where pr.id = v_request.member_id;

  -- Perform the reassignment: clear any proposal, reset to pending
  update public.lesson_requests
     set pro_id             = p_new_pro_id,
         status             = 'pending',
         proposed_starts_at = null,
         proposed_ends_at   = null,
         proposed_court_id  = null,
         last_actor_id      = auth.uid(),
         last_actor_role    = 'admin',
         updated_at         = now()
   where id = p_request_id
  returning * into v_result;

  -- Audit
  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_actor.club_id, auth.uid(), 'reassign_lesson_provider', 'lesson_request', p_request_id,
    jsonb_build_object(
      'old_pro_id',  v_old_pro_id,
      'new_pro_id',  p_new_pro_id,
      'old_status',  v_old_status,
      'new_status',  'pending'
    )
  );

  -- Notify new provider
  insert into public.notifications (club_id, user_id, kind, body, metadata)
  values (
    v_actor.club_id,
    p_new_pro_id,
    'lesson_request_received',
    trim(coalesce(v_member.first_name, '') || ' ' || coalesce(v_member.last_name, ''))
      || ' has a ' || v_request.duration_minutes || '-minute lesson request (reassigned to you).',
    jsonb_build_object(
      'request_id',  p_request_id,
      'member_id',   v_request.member_id,
      'target_path', '/events?tab=lessons'
    )
  );

  -- Notify old provider (both pending and proposed — both had visibility of the request)
  insert into public.notifications (club_id, user_id, kind, body, metadata)
  values (
    v_actor.club_id,
    v_old_pro_id,
    'lesson_provider_reassigned',
    'A lesson request from '
      || trim(coalesce(v_member.first_name, '') || ' ' || coalesce(v_member.last_name, ''))
      || ' has been reassigned to another provider.',
    jsonb_build_object(
      'request_id',  p_request_id,
      'member_id',   v_request.member_id,
      'target_path', '/events?tab=lessons'
    )
  );

  -- Notify member: their provider was changed
  insert into public.notifications (club_id, user_id, kind, body, metadata)
  values (
    v_actor.club_id,
    v_request.member_id,
    'lesson_provider_reassigned',
    'Your lesson request has been reassigned to '
      || trim(coalesce(v_new_pro.first_name, '') || ' ' || coalesce(v_new_pro.last_name, ''))
      || '.',
    jsonb_build_object(
      'request_id',  p_request_id,
      'new_pro_id',  p_new_pro_id,
      'target_path', '/lessons'
    )
  );

  return v_result;
end;
$$;

revoke execute on function public.reassign_lesson_provider(uuid, uuid) from public, anon;
grant  execute on function public.reassign_lesson_provider(uuid, uuid) to authenticated;
