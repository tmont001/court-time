-- 0072_fix_phase23_confirmation_integration.sql
--
-- Three narrowly scoped fixes:
--
-- 1. get_lesson_notification_id: loosen the caller-role guard so that a lesson
--    party (member or pro on the same request) can fetch cross-user notification
--    context for email dispatch.  Previously the guard blocked member callers
--    from fetching the pro's notification ID, silently dropping pro email on
--    member acceptance.
--
-- 2. Add target_path to notification metadata in all five lesson notification-
--    inserting functions so NotificationSheet can navigate to the correct page
--    when the user taps a notification.
--
--    Paths per kind / recipient:
--      lesson_request_received   → pro   → /events?tab=lessons
--      lesson_request_proposed   → member → /lessons
--      lesson_request_confirmed  → member → /lessons
--      lesson_request_confirmed  → pro   → /events?tab=lessons
--      lesson_request_declined   → member → /lessons
--      lesson_cancelled          → member → /lessons
--      lesson_cancelled          → pro   → /events?tab=lessons
--
-- No DROP FUNCTION used.  Signatures and return types are unchanged.
-- Do not edit migrations 0069–0071.


-- ── 1. get_lesson_notification_id ─────────────────────────────────────────────
-- Caller may fetch cross-user notification context when:
--   (a) caller is the same user as the target, OR
--   (b) caller has role admin or pro, OR
--   (c) caller is a lesson party (member_id or pro_id) on p_request_id
--       in the same club (new — fixes member→pro email dispatch).

create or replace function public.get_lesson_notification_id(
  p_request_id uuid,
  p_user_id    uuid,
  p_kind       text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller_id       uuid := auth.uid();
  v_caller_club_id  uuid;
  v_caller_role     text;
  v_target_club_id  uuid;
  v_notif_id        uuid;
  v_notif_body      text;
begin
  if v_caller_id is null then return null; end if;

  select club_id, role into v_caller_club_id, v_caller_role
    from public.profiles where id = v_caller_id;
  if v_caller_club_id is null then return null; end if;

  select club_id into v_target_club_id
    from public.profiles where id = p_user_id;

  -- Caller and target must share a club.
  if v_caller_club_id is distinct from v_target_club_id then return null; end if;

  -- Caller must be: the target itself, an elevated role, or a lesson party
  -- on the specified request.
  if v_caller_id <> p_user_id and v_caller_role not in ('admin', 'pro') then
    if not exists (
      select 1 from public.lesson_requests lr
       where lr.id      = p_request_id
         and lr.club_id = v_caller_club_id
         and (lr.member_id = v_caller_id or lr.pro_id = v_caller_id)
    ) then
      return null;
    end if;
  end if;

  select id, body into v_notif_id, v_notif_body
    from public.notifications
   where user_id  = p_user_id
     and kind     = p_kind
     and (metadata->>'request_id')::uuid = p_request_id
   order by created_at desc
   limit 1;

  if v_notif_id is null then return null; end if;

  return jsonb_build_object('id', v_notif_id, 'body', v_notif_body);
end;
$$;

revoke execute on function public.get_lesson_notification_id(uuid, uuid, text) from public, anon;
grant  execute on function public.get_lesson_notification_id(uuid, uuid, text) to authenticated;


-- ── 2. submit_lesson_request (6-arg) ─────────────────────────────────────────
-- Adds target_path to pro notification metadata.  Full function body from 0070;
-- only the jsonb_build_object call changes.

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
  v_profile public.profiles%rowtype;
  v_pro     public.profiles%rowtype;
  v_result  public.lesson_requests%rowtype;
begin
  select * into v_profile from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.club_id is null then raise exception 'no_club'; end if;
  if v_profile.status <> 'active' then raise exception 'account_inactive'; end if;

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
    club_id, member_id, pro_id,
    preferred_court_id, duration_minutes,
    member_note, preferred_windows, status,
    lesson_type_id,
    last_actor_id, last_actor_role
  ) values (
    v_profile.club_id,
    auth.uid(),
    p_pro_id,
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
    jsonb_build_object('pro_id', p_pro_id, 'duration_minutes', p_duration_minutes)
  );

  return v_result;
end;
$$;

revoke execute on function public.submit_lesson_request(uuid, int, uuid, text, jsonb, uuid) from public, anon;
grant  execute on function public.submit_lesson_request(uuid, int, uuid, text, jsonb, uuid) to authenticated;


-- ── 3. propose_lesson_time ────────────────────────────────────────────────────
-- Adds target_path = '/lessons' to the member notification metadata.

create or replace function public.propose_lesson_time(
  p_request_id   uuid,
  p_starts_at    timestamptz,
  p_ends_at      timestamptz,
  p_court_id     uuid   default null
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

  -- Fetch and lock
  select * into v_request
    from public.lesson_requests
   where id      = p_request_id
     and club_id = v_profile.club_id
   for update;
  if not found then raise exception 'request_not_found'; end if;

  -- Pros may only manage their own requests
  if v_profile.role = 'pro' and v_request.pro_id <> auth.uid() then
    raise exception 'not_assigned_pro';
  end if;

  if v_request.status not in ('pending', 'proposed') then
    raise exception 'invalid_status_for_propose';
  end if;

  if p_starts_at <= now() then raise exception 'cannot_propose_past_time'; end if;
  if p_ends_at   <= p_starts_at then raise exception 'invalid_duration'; end if;

  -- Duration must match what was requested
  if round(extract(epoch from (p_ends_at - p_starts_at)) / 60)::int <> v_request.duration_minutes then
    raise exception 'duration_mismatch';
  end if;

  -- Validate court if supplied
  if p_court_id is not null then
    if not exists (
      select 1 from public.courts
       where id = p_court_id
         and club_id   = v_profile.club_id
         and is_active = true
    ) then
      raise exception 'court_not_found';
    end if;
  end if;

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

  -- Notify the member
  insert into public.notifications (club_id, user_id, kind, body, metadata)
  values (
    v_profile.club_id,
    v_request.member_id,
    'lesson_request_proposed',
    trim(coalesce(v_profile.first_name, '') || ' ' || coalesce(v_profile.last_name, '')) ||
      ' proposed a time for your lesson. Please review and respond.',
    jsonb_build_object('request_id', p_request_id, 'target_path', '/lessons')
  );

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id, auth.uid(), 'propose_lesson_time', 'lesson_request', p_request_id,
    jsonb_build_object(
      'proposed_starts_at', p_starts_at,
      'proposed_ends_at',   p_ends_at,
      'court_id',           p_court_id
    )
  );

  return v_result;
end;
$$;

revoke execute on function public.propose_lesson_time(uuid, timestamptz, timestamptz, uuid) from public, anon;
grant  execute on function public.propose_lesson_time(uuid, timestamptz, timestamptz, uuid) to authenticated;


-- ── 4. accept_lesson_proposal ─────────────────────────────────────────────────
-- Adds target_path to both confirmation notifications:
--   member → /lessons
--   pro    → /events?tab=lessons

create or replace function public.accept_lesson_proposal(
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile public.profiles%rowtype;
  v_request public.lesson_requests%rowtype;
  v_pro     public.profiles%rowtype;
  v_member  public.profiles%rowtype;
  v_tz      text;
  v_res_id  uuid;
  v_time_label text;
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

  -- Operating hours check
  select timezone into v_tz from public.clubs where id = v_profile.club_id;
  perform public._lesson_check_operating_hours(
    v_profile.club_id,
    v_request.proposed_starts_at,
    v_request.proposed_ends_at,
    v_tz
  );

  -- Pro availability check
  perform public._lesson_check_pro_availability(
    v_request.pro_id,
    v_request.proposed_starts_at,
    v_request.proposed_ends_at,
    null
  );

  -- Member availability check (caller is the member accepting)
  perform public._lesson_check_member_availability(
    auth.uid(),
    v_request.proposed_starts_at,
    v_request.proposed_ends_at
  );

  -- Fetch names for notifications
  select * into v_pro    from public.profiles where id = v_request.pro_id;
  select * into v_member from public.profiles where id = auth.uid();

  -- Create the reservation (GiST EXCLUDE handles court conflicts atomically)
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
    jsonb_build_object('request_id', p_request_id, 'reservation_id', v_res_id, 'target_path', '/lessons')
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
    jsonb_build_object('request_id', p_request_id, 'reservation_id', v_res_id, 'target_path', '/events?tab=lessons')
  );

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id, auth.uid(), 'accept_lesson_proposal', 'lesson_request', p_request_id,
    jsonb_build_object('reservation_id', v_res_id)
  );

  return jsonb_build_object('request_id', p_request_id, 'reservation_id', v_res_id);
end;
$$;

revoke execute on function public.accept_lesson_proposal(uuid) from public, anon;
grant  execute on function public.accept_lesson_proposal(uuid) to authenticated;


-- ── 5. decline_lesson_request ─────────────────────────────────────────────────
-- Adds target_path = '/lessons' to the member notification metadata.

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

  if v_request.status not in ('pending', 'proposed') then
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


-- ── 6. cancel_lesson ─────────────────────────────────────────────────────────
-- Adds target_path to both cancellation notifications:
--   member → /lessons
--   pro    → /events?tab=lessons
-- Full function body from 0070; only the jsonb_build_object calls change.

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
  v_profile      public.profiles%rowtype;
  v_request      public.lesson_requests%rowtype;
  v_actor_role   text;
  v_result       public.lesson_requests%rowtype;
  v_member       public.profiles%rowtype;
  v_pro          public.profiles%rowtype;
  v_window_hours int;
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

  if v_request.status <> 'confirmed' then
    raise exception 'invalid_status_for_cancel';
  end if;

  -- Block cancellation of already-started or past lessons by non-admins
  if v_request.proposed_starts_at <= now() and v_profile.role <> 'admin' then
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
    if (extract(epoch from (v_request.proposed_starts_at - now())) / 3600) < v_window_hours then
      raise exception 'within_cancellation_window';
    end if;
  end if;

  -- Cancel the linked reservation.
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
      jsonb_build_object('request_id', p_request_id, 'target_path', '/lessons')
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
      jsonb_build_object('request_id', p_request_id, 'target_path', '/events?tab=lessons')
    );
  end if;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id, auth.uid(), 'cancel_lesson', 'lesson_request', p_request_id,
    jsonb_build_object('reason', p_reason, 'reservation_id', v_request.linked_reservation_id)
  );

  return v_result;
end;
$$;

revoke execute on function public.cancel_lesson(uuid, text) from public, anon;
grant  execute on function public.cancel_lesson(uuid, text) to authenticated;
