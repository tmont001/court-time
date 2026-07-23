-- 0078_admin_lesson_ops.sql
-- Phase 24B: Admin lesson operations.
-- • Add notification kinds: lesson_provider_reassigned, lesson_admin_requested
-- • Extend notification_preferences and update_notification_preference for new kinds
-- • reassign_lesson_provider — admin reassigns pending/proposed request to a different provider
-- • admin_create_lesson_request — admin creates a lesson request on behalf of a member
--
-- NOTE: get_club_pros is NOT modified here.
-- The Phase 23 version (migration 0070) returns active lesson providers
-- (role in ('pro','admin'), is_lesson_provider = true, excludes caller) and is
-- used by both member and admin flows. Admin UIs reuse it as-is.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Extend notifications_kind_check for two new lesson notification kinds
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.notifications
  drop constraint if exists notifications_kind_check;

alter table public.notifications
  add constraint notifications_kind_check
  check (kind in (
    'reservation_confirmed',
    'reservation_cancelled_by_admin',
    'reservation_cancelled_by_member',
    'event_cancelled',
    'event_joined',
    'waitlist_promoted',
    'waitlist_offer',
    'announcement',
    'lesson_request_received',
    'lesson_request_proposed',
    'lesson_request_confirmed',
    'lesson_request_declined',
    'lesson_cancelled',
    'lesson_provider_reassigned',   -- notified when their provider is changed (member + old provider)
    'lesson_admin_requested'        -- member notified when admin creates a request for them
  ));


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Extend notification_preferences kind check and update_notification_preference
--    allowlist for the two new kinds.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.notification_preferences
  drop constraint if exists notification_preferences_kind_check;

alter table public.notification_preferences
  add constraint notification_preferences_kind_check
  check (kind in (
    'reservation_confirmed',
    'reservation_cancelled_by_member',
    'reservation_cancelled_by_admin',
    'event_joined',
    'event_cancelled',
    'waitlist_offer',
    'waitlist_promoted',
    'announcement',
    'lesson_request_received',
    'lesson_request_proposed',
    'lesson_request_confirmed',
    'lesson_request_declined',
    'lesson_cancelled',
    'lesson_provider_reassigned',
    'lesson_admin_requested'
  ));

create or replace function public.update_notification_preference(
  p_kind    text,
  p_enabled boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;

  if p_kind not in (
    'reservation_confirmed',
    'reservation_cancelled_by_member',
    'reservation_cancelled_by_admin',
    'event_joined',
    'event_cancelled',
    'waitlist_offer',
    'waitlist_promoted',
    'announcement',
    'lesson_request_received',
    'lesson_request_proposed',
    'lesson_request_confirmed',
    'lesson_request_declined',
    'lesson_cancelled',
    'lesson_provider_reassigned',
    'lesson_admin_requested'
  ) then
    raise exception 'invalid_kind';
  end if;

  select club_id into v_club_id from public.profiles where id = auth.uid();

  insert into public.notification_preferences (user_id, club_id, kind, enabled, updated_at)
  values (auth.uid(), v_club_id, p_kind, p_enabled, now())
  on conflict (user_id, kind) do update
    set enabled    = excluded.enabled,
        updated_at = now();
end;
$$;

revoke execute on function public.update_notification_preference(text, boolean) from public, anon;
grant  execute on function public.update_notification_preference(text, boolean) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. reassign_lesson_provider
-- Admin-only. Moves a pending or proposed lesson request to a new provider.
-- For proposed requests: clears the proposal and resets to pending.
-- Old provider is notified for BOTH pending and proposed — both were visible.
-- Notifications:
--   • New provider: lesson_request_received   → /events?tab=lessons
--   • Old provider: lesson_provider_reassigned → /events?tab=lessons
--   • Member:       lesson_provider_reassigned → /lessons
-- Audit metadata: old_pro_id, new_pro_id, old_status, new_status
-- ═══════════════════════════════════════════════════════════════════════════

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

  -- Only pending or proposed can be reassigned
  if v_request.status not in ('pending', 'proposed') then
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


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. admin_create_lesson_request
-- Admin-only. Creates a lesson request on behalf of a member.
-- Validation mirrors submit_lesson_request (Phase 23, migration 0070):
--   • provider: active, same club, role in ('pro','admin'), is_lesson_provider = true
--   • duration: >= 30 min, multiple of 15
--   • note: max 500 chars, btrim normalized
--   • preferred court: active, same club (when provided)
--   • lesson type: active, same club (when provided)
--   • duration compatible with lesson type's allowed_durations (when both set)
-- last_actor_role = 'admin'; status = 'pending'; no proposal; no reservation.
-- Member acceptance required before the lesson is confirmed.
-- Notifications:
--   • Provider: lesson_request_received   → /events?tab=lessons
--   • Member:   lesson_admin_requested    → /lessons
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.admin_create_lesson_request(
  p_member_id          uuid,
  p_pro_id             uuid,
  p_duration_minutes   int,
  p_lesson_type_id     uuid        default null,
  p_preferred_court_id uuid        default null,
  p_member_note        text        default null,
  p_preferred_windows  jsonb       default null
)
returns public.lesson_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor   public.profiles%rowtype;
  v_member  public.profiles%rowtype;
  v_pro     public.profiles%rowtype;
  v_result  public.lesson_requests%rowtype;
begin
  select pr.* into v_actor from public.profiles pr where pr.id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_actor.club_id is null then raise exception 'no_club'; end if;
  if v_actor.role <> 'admin' then raise exception 'insufficient_role'; end if;

  -- Validate member: active, same club
  select pr.* into v_member from public.profiles pr
   where pr.id      = p_member_id
     and pr.club_id = v_actor.club_id;
  if not found then raise exception 'member_not_found'; end if;
  if v_member.status <> 'active' then raise exception 'account_inactive'; end if;

  -- Validate provider: active, same club, role in ('pro','admin'), is_lesson_provider = true
  select pr.* into v_pro from public.profiles pr
   where pr.id                 = p_pro_id
     and pr.club_id            = v_actor.club_id
     and pr.status             = 'active'
     and pr.role               in ('pro', 'admin')
     and pr.is_lesson_provider = true;
  if not found then raise exception 'pro_not_found'; end if;

  -- Member and provider cannot be the same person
  if p_member_id = p_pro_id then raise exception 'cannot_request_yourself'; end if;

  -- Duration: positive multiple of 15 minutes, minimum 30
  if p_duration_minutes < 30 or p_duration_minutes % 15 <> 0 then
    raise exception 'invalid_duration';
  end if;

  -- Input length: request note max 500 chars (same as submit_lesson_request)
  if length(p_member_note) > 500 then raise exception 'note_too_long'; end if;

  -- Validate optional preferred court: active, same club
  if p_preferred_court_id is not null and not exists (
    select 1 from public.courts c
     where c.id        = p_preferred_court_id
       and c.club_id   = v_actor.club_id
       and c.is_active = true
  ) then
    raise exception 'court_not_found';
  end if;

  -- Validate optional lesson type: active, same club
  if p_lesson_type_id is not null then
    if not exists (
      select 1 from public.lesson_types lt
       where lt.id        = p_lesson_type_id
         and lt.club_id   = v_actor.club_id
         and lt.is_active = true
    ) then
      raise exception 'lesson_type_not_found';
    end if;

    -- Duration must be within the type's allowed_durations (when set)
    if exists (
      select 1 from public.lesson_types lt
       where lt.id               = p_lesson_type_id
         and lt.allowed_durations is not null
         and array_length(lt.allowed_durations, 1) > 0
         and not (p_duration_minutes = any(lt.allowed_durations))
    ) then
      raise exception 'duration_not_allowed_for_type';
    end if;
  end if;

  insert into public.lesson_requests (
    club_id, member_id, pro_id,
    lesson_type_id, preferred_court_id,
    duration_minutes, member_note, preferred_windows,
    status, last_actor_id, last_actor_role
  ) values (
    v_actor.club_id, p_member_id, p_pro_id,
    p_lesson_type_id, p_preferred_court_id,
    p_duration_minutes,
    btrim(coalesce(p_member_note, '')),
    p_preferred_windows,
    'pending', auth.uid(), 'admin'
  ) returning * into v_result;

  -- Audit
  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_actor.club_id, auth.uid(), 'admin_create_lesson_request', 'lesson_request', v_result.id,
    jsonb_build_object(
      'member_id',        p_member_id,
      'pro_id',           p_pro_id,
      'duration_minutes', p_duration_minutes,
      'lesson_type_id',   p_lesson_type_id
    )
  );

  -- Notify provider
  insert into public.notifications (club_id, user_id, kind, body, metadata)
  values (
    v_actor.club_id,
    p_pro_id,
    'lesson_request_received',
    trim(coalesce(v_member.first_name, '') || ' ' || coalesce(v_member.last_name, ''))
      || ' has a ' || p_duration_minutes || '-minute lesson request (submitted by club staff).',
    jsonb_build_object(
      'request_id',  v_result.id,
      'member_id',   p_member_id,
      'target_path', '/events?tab=lessons'
    )
  );

  -- Notify member
  insert into public.notifications (club_id, user_id, kind, body, metadata)
  values (
    v_actor.club_id,
    p_member_id,
    'lesson_admin_requested',
    'Club staff has submitted a ' || p_duration_minutes || '-minute lesson request for you with '
      || trim(coalesce(v_pro.first_name, '') || ' ' || coalesce(v_pro.last_name, '')) || '.',
    jsonb_build_object(
      'request_id',  v_result.id,
      'pro_id',      p_pro_id,
      'target_path', '/lessons'
    )
  );

  return v_result;
end;
$$;

revoke execute on function public.admin_create_lesson_request(uuid, uuid, int, uuid, uuid, text, jsonb) from public, anon;
grant  execute on function public.admin_create_lesson_request(uuid, uuid, int, uuid, uuid, text, jsonb) to authenticated;
