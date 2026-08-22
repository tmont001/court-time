-- 0146_member_lesson_pricing_guard.sql
-- Phase 34C — final correction.
--
-- Baseline: the exact LIVE PRODUCTION body of
-- public.submit_lesson_request(uuid, integer, uuid, text, jsonb, uuid) as
-- pasted by the operator, not reconstructed from migration history.
--
-- Bug: a Member could submit a self-service Lesson request with no Lesson
-- Type at all (p_lesson_type_id NULL — the existing "Validate optional
-- lesson type" block is entirely skipped when NULL), or with a Lesson Type
-- whose unit_price_amount_cents is NULL ("not configured yet", distinct
-- from a genuine $0 Free type). Either way the request proceeds with
-- price_amount_cents NULL and no way for Admin/Pro's own proposal flow to
-- backfill a price afterward — the Lesson silently behaves as free.
--
-- Fix: two new fail-closed guards, scoped strictly to role = 'member' (the
-- same v_profile.role this function already resolves) so Admin/Pro/Staff
-- behavior of this RPC — none of which any UI in this app currently
-- exercises for lesson requests, but which the function still permits at
-- the RPC layer — is untouched:
--   A. p_lesson_type_id must not be NULL -> 'lesson_type_required'.
--   B. the selected Lesson Type's unit_price_amount_cents must not be
--      NULL -> 'lesson_price_not_configured'.
-- 0 remains valid and still snapshots as Free; positive prices are
-- unaffected. No other line of the production body is changed — same
-- signature, same RETURNS lesson_requests, same SECURITY DEFINER/
-- search_path, same every other validation, same notifications, same
-- audit log. No historical lesson_requests row is touched.
--
-- Apply in Supabase SQL Editor (cloud only).

begin;

create or replace function public.submit_lesson_request(p_pro_id uuid, p_duration_minutes integer, p_preferred_court_id uuid DEFAULT NULL::uuid, p_member_note text DEFAULT NULL::text, p_preferred_windows jsonb DEFAULT NULL::jsonb, p_lesson_type_id uuid DEFAULT NULL::uuid)
 RETURNS lesson_requests
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_profile           public.profiles%rowtype;
  v_pro                public.profiles%rowtype;
  v_result             public.lesson_requests%rowtype;
  -- Phase 33D1: the caller's own durable Member identity for this club.
  v_roster_member_id   uuid;
  -- FINAL LESSON PRICING REFINEMENT: flat-or-hourly price snapshot.
  v_pricing_basis            text;
  v_unit_price_amount_cents  integer;
  v_price_amount_cents       integer;
begin
  select * into v_profile from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.club_id is null then raise exception 'no_club'; end if;
  if v_profile.status <> 'active' then raise exception 'account_inactive'; end if;

  -- Phase 34A3: restated as an explicit admin/pro allowlist rather than a
  -- member-exclusion — see this section's header above.
  if v_profile.role not in ('admin', 'pro') and not public.current_club_has_capability('member_self_service') then
    raise exception 'capability_not_available';
  end if;

  -- Phase 34C consolidation: Member self-service must always name a
  -- Lesson Type — an unstructured, type-less request can never carry a
  -- knowable price, and nothing downstream can backfill one. Scoped to
  -- role = 'member' only; Admin/Pro's own (currently unused by any UI)
  -- ability to call this RPC without a Lesson Type is unchanged.
  if v_profile.role = 'member' and p_lesson_type_id is null then
    raise exception 'lesson_type_required';
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

  -- Validate pro: active, same club, role pro/admin/staff, is_lesson_provider = true
  select * into v_pro
    from public.profiles
   where id      = p_pro_id
     and club_id = v_profile.club_id
     and status  = 'active'
     and role    in ('pro', 'admin', 'staff')
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

    -- FINAL LESSON PRICING REFINEMENT: resolved once here at creation.
    -- flat: total = the configured unit amount. hourly: total = the
    -- configured hourly unit rate multiplied by this Lesson's requested
    -- duration, rounded to the nearest cent. A NULL unit price always
    -- yields a NULL total. No per-pro override; no per-participant math.
    select pricing_basis, unit_price_amount_cents
      into v_pricing_basis, v_unit_price_amount_cents
      from public.lesson_types where id = p_lesson_type_id;

    -- Phase 34C consolidation: a Member may never self-service a Lesson
    -- Type whose price isn't configured yet (NULL) — that would silently
    -- create a de facto free Lesson with no way to price it afterward.
    -- 0 (genuinely Free) and any positive amount remain valid. Scoped to
    -- role = 'member' only, matching the guard above.
    if v_profile.role = 'member' and v_unit_price_amount_cents is null then
      raise exception 'lesson_price_not_configured';
    end if;

    if v_pricing_basis = 'hourly' then
      if v_unit_price_amount_cents is not null then
        v_price_amount_cents := round(v_unit_price_amount_cents * p_duration_minutes / 60.0)::integer;
      else
        v_price_amount_cents := null;
      end if;
    else
      v_price_amount_cents := v_unit_price_amount_cents;
    end if;
  end if;

  insert into public.lesson_requests (
    club_id, member_id, pro_id, roster_member_id,
    preferred_court_id, duration_minutes,
    member_note, preferred_windows, status,
    lesson_type_id,
    last_actor_id, last_actor_role,
    pricing_basis, unit_price_amount_cents, price_amount_cents
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
    auth.uid(), 'member',
    v_pricing_basis, v_unit_price_amount_cents, v_price_amount_cents
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
$function$;

revoke execute on function public.submit_lesson_request(uuid, int, uuid, text, jsonb, uuid) from public, anon;
grant  execute on function public.submit_lesson_request(uuid, int, uuid, text, jsonb, uuid) to authenticated;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback (manual, cloud SQL Editor)
-- ═══════════════════════════════════════════════════════════════════════════
-- Re-run the exact production body pasted at the top of this file's header
-- comment via CREATE OR REPLACE FUNCTION (same signature) — no DROP is
-- needed since this migration never changed the signature or return type.
