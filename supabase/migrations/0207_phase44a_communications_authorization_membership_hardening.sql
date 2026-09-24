-- 0207_phase44a_communications_authorization_membership_hardening.sql
-- Phase 44A — Communications Authorization & Membership Hardening.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
-- The Phase 44 Communications v2 audit re-examined whether
-- 0177_announcement_active_membership_eligibility.sql's fix (Phase 36E —
-- club_memberships, never the profiles legacy projection, decides who may
-- send or receive a club communication) was applied everywhere the same
-- bug class could occur, not merely in send_announcement_v2. It was not.
-- Four more places were found still deriving sender/recipient/candidate
-- eligibility from profiles.club_id/profiles.role/profiles.status — the
-- SAME legacy projection that 0081_club_membership_compatibility_
-- foundation.sql's own trigger (trg_project_membership_to_profile)
-- deliberately leaves frozen at its last value once a club_memberships row
-- is removed (remove_club_member) or deactivated (set_member_status),
-- documented at 0081 lines 448-453 ("Legacy columns ... are deliberately
-- left untouched here"). This migration closes exactly those four gaps,
-- plus drops the one obsolete parallel announcement-send RPC nothing calls.
--
-- SECTION A — drop public.send_announcement(text, text). Confirmed (fresh
-- repository search, this checkpoint) zero application call sites: only
-- send_announcement_v2 is invoked from src/app/(app)/admin/communications/
-- communicationsActions.ts. The v1 function (0041, redefined once by 0043,
-- never touched again — 0102 explicitly left it "byte-for-byte... as-is")
-- still authorizes its sender via stale profiles.role and selects
-- recipients via stale profiles.club_id/profiles.status, i.e. it still
-- carries BOTH bugs 0177 fixed in send_announcement_v2. Rather than
-- maintain two parallel announcement-send implementations — one hardened,
-- one not — it is dropped outright. send_announcement_v2 remains the only
-- supported announcement-send RPC.
--
-- SECTION B — lesson provider/request eligibility. Each function below is
-- reproduced from its own LATEST EFFECTIVE body (identified by direct
-- migration-history read, cited per function, not reconstructed from
-- memory) with the minimum change required: caller club/role now resolved
-- via current_user_club_id()/current_user_role() (0082) wherever the
-- caller's own authorization is decided, and every provider/target
-- eligibility check now additionally requires an active, non-removed
-- public.club_memberships row in the SAME (verified) club, with candidate
-- role/is_lesson_provider read from that membership row rather than
-- profiles. No pricing, duration, capability-gate, roster-identity, or
-- audit-log behavior is changed. No caller-role authority is broadened —
-- admin_create_lesson_request stays admin-only; reassign_lesson_provider
-- stays admin-or-staff; get_admin_club_pros stays admin-or-staff;
-- get_club_pros stays open to any authenticated club member, unchanged.
--   - submit_lesson_request       — latest effective body: 0146
--   - admin_create_lesson_request — latest effective body: 0078 (never
--                                   redefined since)
--   - reassign_lesson_provider    — latest effective body: 0132
--   - get_club_pros               — latest effective body: 0132
--   - get_admin_club_pros         — latest effective body: 0132
--
-- SECTION C — cancel_event (latest effective body: 0161). Its actor
-- authorization still read v_profile.role/v_profile.club_id directly off
-- profiles — the identical bug class, on the caller side only. Corrected
-- to current_user_club_id()/current_user_role(), matching 0177's own
-- sender-side fix exactly. This is an auth-source correction only: event
-- row locking, the Phase 34F-B Stripe Checkout invalidation fan-out,
-- participant mutation, notifications, the Pro creator/ownership
-- restriction, and the return shape are all byte-identical to 0161.
--
-- SECTION D — notification_deliveries's "admin_select" RLS policy (defined
-- once, 0019, never altered since) still resolved club/role from profiles
-- directly in its USING clause — the same staleness class, at the RLS
-- layer. Corrected via ALTER POLICY (same name, so there is no window,
-- even transaction-internal, where the policy does not exist) to
-- current_user_club_id()/current_user_role(). Admin-only, current-active-
-- club-only, unchanged; no INSERT/UPDATE/DELETE privilege is added; no
-- other table's RLS is touched.
--
-- NOT IN SCOPE — deliberately unchanged by this migration: lesson pricing,
-- lesson lifecycle/status rules, event payment/checkout logic beyond
-- cancel_event's auth-source line, reservation behavior, waitlist
-- behavior, waiver behavior, Phase 39 (reservation collaboration/LFP)
-- behavior, notification kinds/preferences, and the Communications UI.
-- public.admin_reassign_confirmed_lesson_pro / get_confirmed_lesson_
-- reassignment_pros (0180) are a related but DISTINCT function pair, not
-- named in the Phase 44A scope — not touched here.
--
-- Apply in Supabase SQL Editor (cloud only). Not applied by this
-- checkpoint — prepared for migration review only.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION A — drop the obsolete, unauthorized-hardening-free v1 RPC
-- ═══════════════════════════════════════════════════════════════════════════
-- Deliberately not IF EXISTS: if this function is somehow already absent,
-- that is schema drift from what this migration's own preflight assumed,
-- and the migration must fail loudly rather than silently skip a step —
-- same fail-closed convention 0131 uses for its own constraint drops.
drop function public.send_announcement(text, text);


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION B — lesson provider/request eligibility
-- ═══════════════════════════════════════════════════════════════════════════

-- ---------------------------------------------------------------------------
-- B1. submit_lesson_request — latest effective body: 0146_member_lesson_
-- pricing_guard.sql (itself "the exact LIVE PRODUCTION body ... pasted by
-- the operator, not reconstructed from migration history" per 0146's own
-- header — reproduced here in that same style, minimum change only).
--
-- Change: caller club/role now resolved via current_user_club_id()/
-- current_user_role() instead of v_profile.club_id/v_profile.role for
-- every scoping and role-gate use. v_profile itself is still fetched and
-- still used for the account_inactive status check (an independently
-- meaningful, unchanged account-level guard) and for first_name/last_name
-- in the provider notification body — neither of those two uses is
-- authorization-by-club-membership, so neither is removed. The provider
-- validation, previously a single profiles query keyed on stale
-- profiles.status/role, now additionally requires an active, non-removed
-- club_memberships row in the caller's VERIFIED club with role in
-- ('pro','admin','staff') and is_lesson_provider = true, read entirely
-- from club_memberships (never profiles, which was never re-checked for
-- the provider after this migration). All pricing (flat/hourly snapshot,
-- lesson_price_not_configured guard), duration, lesson-type, preferred-
-- court, roster-identity, notification, and audit_log behavior is
-- byte-identical to 0146.
create or replace function public.submit_lesson_request(p_pro_id uuid, p_duration_minutes integer, p_preferred_court_id uuid DEFAULT NULL::uuid, p_member_note text DEFAULT NULL::text, p_preferred_windows jsonb DEFAULT NULL::jsonb, p_lesson_type_id uuid DEFAULT NULL::uuid)
 RETURNS lesson_requests
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_profile           public.profiles%rowtype;
  -- Phase 44A: the caller's VERIFIED club/role, resolved exclusively
  -- through club_memberships (0082's current_user_club_id()/
  -- current_user_role()) — never profiles.club_id/profiles.role, which
  -- stay frozen at their last known value once a membership is removed or
  -- deactivated (0081).
  v_club_id            uuid;
  v_role               text;
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

  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;
  if v_club_id is null then raise exception 'no_club'; end if;

  if v_profile.status <> 'active' then raise exception 'account_inactive'; end if;

  -- Phase 34A3: restated as an explicit admin/pro allowlist rather than a
  -- member-exclusion — see this section's header above.
  if v_role not in ('admin', 'pro') and not public.current_club_has_capability('member_self_service') then
    raise exception 'capability_not_available';
  end if;

  -- Phase 34C consolidation: Member self-service must always name a
  -- Lesson Type — an unstructured, type-less request can never carry a
  -- knowable price, and nothing downstream can backfill one. Scoped to
  -- role = 'member' only; Admin/Pro's own (currently unused by any UI)
  -- ability to call this RPC without a Lesson Type is unchanged.
  if v_role = 'member' and p_lesson_type_id is null then
    raise exception 'lesson_type_required';
  end if;

  -- Phase 33D1: resolve the caller's own roster identity in this club.
  -- Never client-supplied — auth.uid() and v_club_id are both
  -- server-derived, matching create_reservation's identical 0108 pattern.
  -- Fails closed: every active club member is expected to have one after
  -- 33B1's backfill and accept_club_invite's fail-closed roster
  -- resolution, so this should never legitimately raise.
  select id into v_roster_member_id
    from public.roster_members
   where club_id    = v_club_id
     and claimed_by = auth.uid();
  if not found then raise exception 'no_roster_identity'; end if;

  -- Phase 44A: provider eligibility now requires an active, non-removed
  -- club_memberships row for the SAME (verified) club — never
  -- profiles.status/role/club_id, which stay frozen at their last known
  -- value once a membership is removed or deactivated.
  if not exists (
    select 1
      from public.club_memberships cm
     where cm.user_id            = p_pro_id
       and cm.club_id            = v_club_id
       and cm.status             = 'active'
       and cm.removed_at         is null
       and cm.role               in ('pro', 'admin', 'staff')
       and cm.is_lesson_provider = true
  ) then
    raise exception 'pro_not_found';
  end if;

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
       and club_id  = v_club_id
       and is_active = true
  ) then
    raise exception 'court_not_found';
  end if;

  -- Validate optional lesson type (active, same club)
  if p_lesson_type_id is not null then
    if not exists (
      select 1 from public.lesson_types
       where id       = p_lesson_type_id
         and club_id  = v_club_id
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
    if v_role = 'member' and v_unit_price_amount_cents is null then
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
    v_club_id,
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
    v_club_id,
    p_pro_id,
    'lesson_request_received',
    trim(coalesce(v_profile.first_name, '') || ' ' || coalesce(v_profile.last_name, '')) ||
      ' has requested a ' || p_duration_minutes || '-minute lesson.',
    jsonb_build_object('request_id', v_result.id, 'target_path', '/events?tab=lessons')
  );

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'submit_lesson_request', 'lesson_request', v_result.id,
    jsonb_build_object('pro_id', p_pro_id, 'duration_minutes', p_duration_minutes, 'roster_member_id', v_roster_member_id)
  );

  return v_result;
end;
$function$;


-- ---------------------------------------------------------------------------
-- B2. admin_create_lesson_request — latest effective body: 0078_admin_
-- lesson_ops.sql (never redefined since). Caller-role authority preserved
-- EXACTLY (admin-only) — only its derivation moves from v_actor.role/
-- v_actor.club_id to current_user_role()/current_user_club_id().
--
-- Phase 44A review correction: the Member and provider profiles lookups
-- below are loaded BY ID ONLY (no pr.club_id filter) — profiles.club_id is
-- a legacy projection and must never decide whether another user currently
-- belongs to the caller's club (this matters specifically for multi-club
-- identity: a user can hold a valid active club_memberships row for THIS
-- club even while their legacy profiles.club_id projection points
-- elsewhere). They are read solely for first_name/last_name, which feed
-- the two notification bodies below. SAME-CLUB ELIGIBILITY is decided
-- exclusively from club_memberships:
--   - Member: a missing profile OR a missing same-club club_memberships
--     row both raise member_not_found (a caller cannot distinguish
--     "doesn't exist" from "exists but never belonged to this club" — same
--     external contract as the profiles-scoped lookup it replaces); a
--     same-club membership row that exists but is not
--     (status='active' and removed_at is null) raises account_inactive.
--   - Provider: any failure — missing profile, no same-club membership,
--     wrong role, or is_lesson_provider=false — raises pro_not_found
--     uniformly, matching this function's pre-existing external contract
--     (it never distinguished those cases either). Eligible-role set
--     (pro, admin) is preserved exactly as-is — this function has never
--     included 'staff', and widening it is not part of Phase 44A's scope.
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
  v_actor_club_id     uuid;
  v_actor_role        text;
  v_member            public.profiles%rowtype;
  v_member_membership public.club_memberships%rowtype;
  v_pro               public.profiles%rowtype;
  v_result            public.lesson_requests%rowtype;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;

  select public.current_user_club_id(), public.current_user_role()
    into v_actor_club_id, v_actor_role;
  if v_actor_club_id is null then raise exception 'no_club'; end if;
  if v_actor_role is distinct from 'admin' then raise exception 'insufficient_role'; end if;

  -- Validate member: profile loaded by id only (display/name — never a
  -- club-eligibility gate). Same-club eligibility decided exclusively from
  -- club_memberships — never profiles.club_id, which stays frozen at its
  -- last known value once a membership is removed or deactivated (0081)
  -- and is not authoritative for multi-club identity in any case.
  select pr.* into v_member from public.profiles pr where pr.id = p_member_id;
  if not found then raise exception 'member_not_found'; end if;

  select cm.* into v_member_membership
    from public.club_memberships cm
   where cm.user_id = p_member_id
     and cm.club_id = v_actor_club_id;
  if not found then raise exception 'member_not_found'; end if;
  if v_member_membership.status <> 'active' or v_member_membership.removed_at is not null then
    raise exception 'account_inactive';
  end if;

  -- Validate provider: profile loaded by id only (display/name). Same-club
  -- role/provider eligibility decided exclusively from club_memberships;
  -- any failure raises pro_not_found uniformly, matching this function's
  -- pre-existing external contract. Eligible-role set unchanged (pro,
  -- admin) — never widened to staff.
  select pr.* into v_pro from public.profiles pr where pr.id = p_pro_id;
  if not found then raise exception 'pro_not_found'; end if;
  if not exists (
    select 1 from public.club_memberships cm
     where cm.user_id            = p_pro_id
       and cm.club_id            = v_actor_club_id
       and cm.status             = 'active'
       and cm.removed_at         is null
       and cm.role               in ('pro', 'admin')
       and cm.is_lesson_provider = true
  ) then
    raise exception 'pro_not_found';
  end if;

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
       and c.club_id   = v_actor_club_id
       and c.is_active = true
  ) then
    raise exception 'court_not_found';
  end if;

  -- Validate optional lesson type: active, same club
  if p_lesson_type_id is not null then
    if not exists (
      select 1 from public.lesson_types lt
       where lt.id        = p_lesson_type_id
         and lt.club_id   = v_actor_club_id
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
    v_actor_club_id, p_member_id, p_pro_id,
    p_lesson_type_id, p_preferred_court_id,
    p_duration_minutes,
    btrim(coalesce(p_member_note, '')),
    p_preferred_windows,
    'pending', auth.uid(), 'admin'
  ) returning * into v_result;

  -- Audit
  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_actor_club_id, auth.uid(), 'admin_create_lesson_request', 'lesson_request', v_result.id,
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
    v_actor_club_id,
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
    v_actor_club_id,
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


-- ---------------------------------------------------------------------------
-- B3. reassign_lesson_provider — latest effective body: 0132_staff_
-- operational_authorization.sql. Caller-role authority preserved EXACTLY
-- (admin-or-staff, this function's existing operator tier) — only its
-- derivation moves from v_actor.role/v_actor.club_id to
-- current_user_role()/current_user_club_id(); last_actor_role now writes
-- v_actor_role (the same verified value the authorization check itself
-- just used) rather than the stale v_actor.role, preserving 0132's own
-- Phase 34A4A intent (record the caller's ACTUAL role) with a source that
-- can no longer be stale. New provider eligibility now additionally
-- requires an active, non-removed club_memberships row (role/
-- is_lesson_provider read from that row; eligible-role set pro/admin/staff
-- unchanged). New: the old provider and the Member are each notified only
-- if they still hold an active, non-removed membership in this club — the
-- ORIGINAL body notified both unconditionally, with no membership check of
-- any kind (that recipient id came straight off the stored lesson_requests
-- row). The new provider's own notification needs no separate guard: the
-- provider-eligibility check above already proves it. No other
-- reassignment semantics (status transition, proposal-window clearing,
-- same_pro/cannot_assign_to_self guards, audit_log) are changed.
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
  v_actor_club_id uuid;
  v_actor_role    text;
  v_request    public.lesson_requests%rowtype;
  v_new_pro    public.profiles%rowtype;
  v_member     public.profiles%rowtype;
  v_result     public.lesson_requests%rowtype;
  v_old_pro_id uuid;
  v_old_status text;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;

  select public.current_user_club_id(), public.current_user_role()
    into v_actor_club_id, v_actor_role;
  if v_actor_club_id is null then raise exception 'no_club'; end if;
  if v_actor_role not in ('admin', 'staff') then raise exception 'insufficient_role'; end if;

  select lr.* into v_request
    from public.lesson_requests lr
   where lr.id      = p_request_id
     and lr.club_id = v_actor_club_id
   for update;
  if not found then raise exception 'request_not_found'; end if;

  if v_request.status not in ('pending', 'proposed')
     or (v_request.status = 'proposed' and v_request.linked_reservation_id is not null)
  then
    raise exception 'invalid_status_for_reassign';
  end if;

  -- Phase 44A (review correction): v_new_pro is loaded BY ID ONLY —
  -- display/name information for the notification bodies below, never a
  -- club-eligibility gate. Whether p_new_pro_id is a valid provider for
  -- THIS club is decided exclusively from club_memberships: an active,
  -- non-removed row with role in ('pro','admin','staff') and
  -- is_lesson_provider = true. Never profiles.club_id/status/role, which
  -- stay frozen at their last known value once a membership is removed or
  -- deactivated (0081) and are not authoritative for multi-club identity
  -- in any case — a user can hold a valid active club_memberships row for
  -- THIS club even while their legacy profiles.club_id projection points
  -- elsewhere. Any invalid/no-membership case raises pro_not_found,
  -- matching this function's pre-existing external contract.
  select pr.* into v_new_pro from public.profiles pr where pr.id = p_new_pro_id;
  if not found then raise exception 'pro_not_found'; end if;
  if not exists (
    select 1 from public.club_memberships cm
     where cm.user_id            = p_new_pro_id
       and cm.club_id            = v_actor_club_id
       and cm.status             = 'active'
       and cm.removed_at         is null
       and cm.role               in ('pro', 'admin', 'staff')
       and cm.is_lesson_provider = true
  ) then
    raise exception 'pro_not_found';
  end if;

  if v_request.pro_id = p_new_pro_id then
    raise exception 'same_pro';
  end if;

  if v_request.member_id = p_new_pro_id then
    raise exception 'cannot_assign_to_self';
  end if;

  v_old_pro_id := v_request.pro_id;
  v_old_status := v_request.status;

  select pr.* into v_member from public.profiles pr where pr.id = v_request.member_id;

  update public.lesson_requests
     set pro_id             = p_new_pro_id,
         status             = 'pending',
         proposed_starts_at = null,
         proposed_ends_at   = null,
         proposed_court_id  = null,
         last_actor_id      = auth.uid(),
         -- Phase 34A4A / Phase 44A: the caller's VERIFIED actual role
         -- (v_actor_role, from current_user_role()) — 'admin' for an
         -- Admin caller (identical result to before), correctly 'staff'
         -- for a Staff caller, and now impossible to source from a stale
         -- profiles.role value.
         last_actor_role    = v_actor_role,
         updated_at         = now()
   where id = p_request_id
  returning * into v_result;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_actor_club_id, auth.uid(), 'reassign_lesson_provider', 'lesson_request', p_request_id,
    jsonb_build_object(
      'old_pro_id',  v_old_pro_id,
      'new_pro_id',  p_new_pro_id,
      'old_status',  v_old_status,
      'new_status',  'pending'
    )
  );

  insert into public.notifications (club_id, user_id, kind, body, metadata)
  values (
    v_actor_club_id,
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

  -- Phase 44A: the old provider is notified only if they still hold an
  -- active, non-removed membership in this club. The pre-44A body
  -- notified v_old_pro_id unconditionally — that id comes straight off
  -- the stored lesson_requests row and was never membership-checked.
  if exists (
    select 1 from public.club_memberships cm
     where cm.user_id    = v_old_pro_id
       and cm.club_id    = v_actor_club_id
       and cm.status     = 'active'
       and cm.removed_at is null
  ) then
    insert into public.notifications (club_id, user_id, kind, body, metadata)
    values (
      v_actor_club_id,
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
  end if;

  -- Phase 44A: the Member is notified only if they still hold an active,
  -- non-removed membership in this club — same reasoning as the old
  -- provider above.
  if exists (
    select 1 from public.club_memberships cm
     where cm.user_id    = v_request.member_id
       and cm.club_id    = v_actor_club_id
       and cm.status     = 'active'
       and cm.removed_at is null
  ) then
    insert into public.notifications (club_id, user_id, kind, body, metadata)
    values (
      v_actor_club_id,
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
  end if;

  return v_result;
end;
$$;


-- ---------------------------------------------------------------------------
-- B4. get_club_pros — latest effective body: 0132_staff_operational_
-- authorization.sql. No caller-role gate (unchanged — any authenticated
-- club member may call this). Candidates now come from the caller's
-- verified club's active, non-removed club_memberships rows, with role/
-- is_lesson_provider read from that membership row rather than profiles.
-- Self-exclusion and the eligible-role set (pro, admin, staff) are
-- unchanged; return shape (id, first_name, last_name, role,
-- is_lesson_provider) and ordering are unchanged.
create or replace function public.get_club_pros()
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
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;

  select public.current_user_club_id() into v_club_id;
  if v_club_id is null then raise exception 'no_club'; end if;

  return query
    select p.id, p.first_name, p.last_name, cm.role, cm.is_lesson_provider
      from public.club_memberships cm
      join public.profiles p on p.id = cm.user_id
     where cm.club_id            = v_club_id
       and cm.status             = 'active'
       and cm.removed_at         is null
       and cm.user_id            <> auth.uid()
       and cm.role               in ('pro', 'admin', 'staff')
       and cm.is_lesson_provider = true
     order by p.last_name nulls last, p.first_name nulls last;
end;
$$;


-- ---------------------------------------------------------------------------
-- B5. get_admin_club_pros — latest effective body: 0132_staff_operational_
-- authorization.sql. Caller-role authority preserved EXACTLY (admin-or-
-- staff) — only its derivation moves to current_user_role()/
-- current_user_club_id(). Candidates now come from the caller's verified
-- club's active, non-removed club_memberships rows, identical eligibility
-- rule to get_club_pros above (no self-exclusion here, matching 0132 —
-- this is the admin-facing full-roster listing).
create or replace function public.get_admin_club_pros()
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
  if auth.uid() is null then raise exception 'not_authenticated'; end if;

  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;
  if v_club_id is null then raise exception 'no_club'; end if;
  if v_role not in ('admin', 'staff') then raise exception 'insufficient_role'; end if;

  return query
    select p.id, p.first_name, p.last_name, cm.role, cm.is_lesson_provider
      from public.club_memberships cm
      join public.profiles p on p.id = cm.user_id
     where cm.club_id            = v_club_id
       and cm.status             = 'active'
       and cm.removed_at         is null
       and cm.role               in ('pro', 'admin', 'staff')
       and cm.is_lesson_provider = true
     order by p.last_name nulls last, p.first_name nulls last;
end;
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION C — cancel_event caller authorization
-- ═══════════════════════════════════════════════════════════════════════════
-- Latest effective body: 0161_event_online_payment_checkout.sql (itself
-- "reproduced VERBATIM... every other check, computation, mutation,
-- notification, and audit_log entry... byte-identical" to its own 0136
-- baseline, per 0161's own header). v_profile was used ONLY for
-- .club_id/.role in this function — confirmed by direct read of the full
-- body, no other field referenced anywhere. Both are now resolved via
-- current_user_club_id()/current_user_role() instead, matching 0177's own
-- sender-authorization fix exactly. This is an auth-source correction
-- only: the events row FOR UPDATE lock, the Phase 34F-B Stripe Checkout
-- invalidation fan-out, the Pro creator/ownership restriction
-- (v_event.created_by is distinct from auth.uid()), participant/
-- reservation mutation, notifications, and the returned jsonb shape are
-- all byte-identical to 0161.
create or replace function public.cancel_event(p_event_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_id               uuid;
  v_role                  text;
  v_event                 public.events%rowtype;
  v_result                public.events%rowtype;
  v_affected_roster_ids   uuid[];
  v_affected_member_ids   uuid[];
  v_notifications         jsonb;
  -- Phase 34F-B: fan-out pre-mutation Stripe Checkout invalidation.
  v_payment_id_for_checkout_guard uuid;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;

  -- Phase 44A: the caller's VERIFIED club/role, resolved exclusively
  -- through club_memberships (0082) — never profiles.club_id/profiles.role
  -- directly, which stay frozen at their last known value once a
  -- membership is removed or deactivated (0081). This is the identical
  -- bug class 0177 already fixed for send_announcement_v2's own sender
  -- authorization.
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  -- Phase 34F-B delta 1 of 2 (concurrency correction, unchanged) — FOR
  -- UPDATE on this authoritative Event lookup, now scoped to v_club_id
  -- rather than a stale profile column. A caller with no current active
  -- membership anywhere (v_club_id is null) can never match any row here,
  -- so this raises event_not_found before the role check below is ever
  -- reached — identical fail-closed shape to the pre-44A body, whose
  -- v_profile.club_id was also null for such a caller.
  select * into v_event
    from public.events
    where id      = p_event_id
      and club_id = v_club_id
      and status  = 'scheduled'
    for update;
  if not found then raise exception 'event_not_found'; end if;

  if v_event.archived_at is not null then raise exception 'event_archived'; end if;

  if v_role is distinct from 'admin' and v_role is distinct from 'pro' and v_role is distinct from 'staff' then
    raise exception 'insufficient_role';
  end if;

  if v_role = 'pro' and v_event.created_by is distinct from auth.uid() then
    raise exception 'insufficient_role';
  end if;

  -- Capture the exact affected roster identity set BEFORE any participant
  -- status mutation runs — same ordering-safety reasoning as before
  -- (0102), now keyed by the durable roster_member_id (NOT NULL) rather
  -- than the possibly-null profile_id.
  select coalesce(array_agg(roster_member_id), '{}') into v_affected_roster_ids
    from public.event_participants
    where event_id = p_event_id
      and status   in ('confirmed', 'waitlisted', 'offered');

  -- Phase 34F-B delta 2 of 2 — fan-out pre-mutation Stripe Checkout
  -- invalidation. Mirrors update_event's identical new block (section 8)
  -- exactly — see 0161's own header for the full event-cancellation-fan-out
  -- design. Genuinely serialized against a concurrent Checkout attempt-open
  -- by the events row lock acquired above.
  for v_payment_id_for_checkout_guard in
    select distinct on (p.domain_id) p.id
      from event_participants ep
      join payments p
        on p.club_id     = v_club_id
       and p.domain_type = 'event_participant'
       and p.domain_id   = ep.id
     where ep.event_id = p_event_id
       and ep.status   = 'confirmed'
     order by p.domain_id, p.obligation_cycle desc
  loop
    perform public._invalidate_or_flag_open_checkout_attempt(v_payment_id_for_checkout_guard);
  end loop;

  update public.events
    set status = 'cancelled', updated_at = now()
    where id = p_event_id
    returning * into v_result;

  update public.reservations set
    status            = 'cancelled',
    cancelled_at      = now(),
    cancelled_by      = auth.uid(),
    cancellation_kind = 'admin',
    updated_at        = now()
  where event_id = p_event_id
    and status in ('pending', 'confirmed');

  update public.event_participants
    set status           = 'cancelled',
        offer_expires_at = null,
        updated_at       = now()
    where event_id = p_event_id
      and status   = 'offered';

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id,
    auth.uid(),
    'cancel_event',
    'event',
    p_event_id,
    jsonb_build_object('title', v_event.title, 'starts_at', v_event.starts_at)
  );

  -- Phase 33D2: resolve CURRENT accounts fresh via roster_members.
  -- claimed_by, filtering out still-unclaimed identities BEFORE the
  -- notification insert — this is what makes the NULL-user_id crash
  -- structurally impossible, rather than relying on a NOT NULL roster_
  -- member_id guarantee upstream alone.
  select coalesce(array_agg(claimed_by), '{}') into v_affected_member_ids
    from public.roster_members
    where id = any(v_affected_roster_ids)
      and claimed_by is not null;

  with ins as (
    insert into public.notifications (club_id, user_id, kind, body, metadata)
    select
      v_event.club_id,
      mid,
      'event_cancelled',
      '"' || v_event.title || '" has been cancelled.',
      jsonb_build_object('event_id', p_event_id)
    from unnest(v_affected_member_ids) as mid
    returning id, user_id
  )
  select coalesce(
    jsonb_agg(jsonb_build_object('notification_id', id, 'user_id', user_id)),
    '[]'::jsonb
  )
  into v_notifications
  from ins;

  return jsonb_build_object(
    'event',         to_jsonb(v_result),
    'notifications', v_notifications
  );
end;
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION D — notification_deliveries "admin_select" RLS policy
-- ═══════════════════════════════════════════════════════════════════════════
-- Defined once (0019_notification_deliveries.sql), never altered since.
-- ALTER POLICY (not DROP + CREATE) keeps the exact same policy name, so
-- there is no window, even transaction-internal, where the policy does not
-- exist. Admin-only, current-active-club-only — unchanged in effect for
-- every currently active Admin; a removed/deactivated former Admin, whose
-- profiles.role/club_id stayed frozen at 'admin'/their old club, can no
-- longer satisfy this policy. No INSERT/UPDATE/DELETE policy is added
-- (none existed before); no other table's RLS is touched.
alter policy "admin_select"
  on public.notification_deliveries
  using (
    club_id = public.current_user_club_id()
    and public.current_user_role() = 'admin'
  );

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFICATION (run manually after applying — NOT executed automatically by
-- this file)
-- ═══════════════════════════════════════════════════════════════════════════
-- 1. select proname from pg_proc where proname = 'send_announcement';
--    -- must return zero rows. select proname from pg_proc where
--    proname = 'send_announcement_v2'; -- must return exactly one row.
--
-- 2. As an Admin, remove or deactivate a test Pro in your club, then:
--    a. As a Member, call get_club_pros() — that Pro must no longer appear.
--    b. As a Member, attempt submit_lesson_request(p_pro_id => <that
--       Pro's id>, ...) — must fail with pro_not_found.
--    c. As an Admin, call get_admin_club_pros() — that Pro must no longer
--       appear.
--    d. As an Admin, attempt admin_create_lesson_request(p_pro_id => <that
--       Pro's id>, ...) — must fail with pro_not_found.
--
-- 3. As an Admin, remove or deactivate a test Member, then attempt
--    admin_create_lesson_request(p_member_id => <that Member's id>, ...)
--    as an active Admin — must fail with account_inactive.
--
-- 4. reassign_lesson_provider: create a pending lesson_request, then
--    remove/deactivate its current pro_id's membership and its member_id's
--    membership. As an active Admin, reassign it to a different, currently
--    active Pro. The reassignment itself must still succeed; select *
--    from notifications where kind in ('lesson_provider_reassigned') and
--    user_id in (<old pro id>, <member id>) order by created_at desc
--    limit 2; must show NO new rows for either. Confirm an active Member/
--    Pro pair still receives both lesson_provider_reassigned notifications
--    exactly as before when neither has been removed/deactivated.
--
-- 5. cancel_event: as an Admin, remove or deactivate ANOTHER Admin account
--    in your club (not your own — set_member_status/remove_club_member
--    both already reject changing your own membership), then attempt
--    cancel_event as that removed/deactivated former Admin — must fail
--    with event_not_found or insufficient_role (never succeed). Confirm a
--    current active Admin, Staff, and the creating Pro can each still
--    cancel exactly as before, and that Stripe Checkout invalidation,
--    participant/reservation cancellation, and event_cancelled
--    notifications to currently-active affected members are unchanged.
--
-- 6. notification_deliveries: as a removed/deactivated former Admin,
--    attempt to select from notification_deliveries — must return zero
--    rows. Confirm a current active Admin still sees their own club's
--    delivery records exactly as before, and cannot see another club's.
-- ═══════════════════════════════════════════════════════════════════════════
-- End of 0207_phase44a_communications_authorization_membership_hardening.sql
-- ═══════════════════════════════════════════════════════════════════════════
