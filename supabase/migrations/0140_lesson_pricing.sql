-- 0140_lesson_pricing.sql
-- Phase 34B — Admin-Controlled Pricing Foundation, part 2 of 4.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
-- Production preflight (this checkpoint) confirmed lesson_types has ZERO
-- rows in Production — no rate_amount values, no currencies, nothing to
-- preserve or backfill. The dormant rate_amount/rate_currency design
-- (0070) is therefore cleanly replaced with integer cents + club-wide
-- currency (club_settings.currency, 0139), rather than retrofitted.
--
-- upsert_lesson_type had zero callers anywhere in src/ before this
-- checkpoint; get_lesson_types' two callers (admin/lessons/page.tsx,
-- admin/members/[id]/page.tsx) both discarded the rate fields before
-- render. Both are updated in this same checkpoint's UI work to actually
-- consume the new price field.
--
-- Because upsert_lesson_type's argument contract changes and
-- get_lesson_types' explicit RETURNS TABLE contract changes, CREATE OR
-- REPLACE is not sufficient for either (Postgres cannot alter a table
-- return shape or silently retire a prior overload) — both are explicitly
-- DROPped and recreated under their new canonical contract. This is safe
-- specifically because: lesson_types has zero Production rows,
-- upsert_lesson_type has zero current src/ callers, and get_lesson_types'
-- two callers are updated in this same checkpoint. Grants are reapplied
-- explicitly after each recreate.
--
-- admin_create_member_lesson, submit_lesson_request, and
-- admin_update_member_lesson (the last copied from the already-Production-
-- verified 0138 body, not reconstructed) are copied verbatim from
-- Production/0138 with only the price-snapshot logic added, described in
-- each function's own inline comment.
--
-- FINAL LESSON PRICING REFINEMENT (pre-apply correction): a Lesson Type's
-- price is either a FLAT total for the whole Lesson, or an HOURLY rate
-- multiplied by the Lesson's own duration — not flat-only. True
-- per-participant pricing (participant_count x per-person rate) is
-- explicitly NOT implemented: the Lesson domain has no lesson_participants
-- roster equivalent to Events, so there is no correct multi-participant
-- identity to calculate or collect against yet. max_participants remains
-- useful for defining Private/Semi-Private/Group Lesson Types; rate_notes
-- may describe a per-player breakdown informally (e.g. "$60 per player for
-- two players") but is never computed from. No per-pro override.
--
-- Does not modify 0131-0139 or admin_create_lesson_request (confirmed
-- orphaned — its wrapping action has zero callers anywhere in src/; not
-- touched). Not applied by this checkpoint. Apply in Supabase SQL Editor
-- (cloud only).
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ─────────────────────────────────────────────────────────────────────────
-- Schema
-- ─────────────────────────────────────────────────────────────────────────

-- FINAL LESSON PRICING REFINEMENT: a Lesson Type's configured price is
-- either a flat total for the whole Lesson, or an hourly rate the Lesson's
-- own duration is multiplied against — not always a flat amount. True
-- per-participant calculation (participant_count × per-person rate) is
-- explicitly NOT implemented here: the Lesson domain has no
-- lesson_participants roster equivalent to Events yet, so there is no
-- correct multi-participant identity to calculate or collect against.
-- max_participants remains useful for defining Private/Semi-Private/Group
-- Lesson Types; rate_notes may describe a per-player breakdown informally
-- (e.g. "$60 per player for two players") but that text is informational
-- only in 34B, never computed.
alter table public.lesson_types
  add column pricing_basis text not null default 'flat',
  add column unit_price_amount_cents integer null;

alter table public.lesson_types
  add constraint lesson_types_pricing_basis_check
    check (pricing_basis in ('flat', 'hourly'));

alter table public.lesson_types
  add constraint lesson_types_unit_price_amount_cents_nonneg
    check (unit_price_amount_cents is null or unit_price_amount_cents >= 0);

alter table public.lesson_types
  drop column rate_amount,
  drop column rate_currency;

-- lesson_requests snapshots all three: the type's pricing_basis and unit
-- price at the moment of snapshot, plus the calculated total
-- (price_amount_cents) — flat: total = unit; hourly: total =
-- round(unit * duration_minutes / 60). All three stay NULL together when
-- no Lesson Type is selected or the selected type has no price configured.
alter table public.lesson_requests
  add column pricing_basis text null,
  add column unit_price_amount_cents integer null,
  add column price_amount_cents integer null;

alter table public.lesson_requests
  add constraint lesson_requests_pricing_basis_check
    check (pricing_basis is null or pricing_basis in ('flat', 'hourly'));

alter table public.lesson_requests
  add constraint lesson_requests_unit_price_amount_cents_nonneg
    check (unit_price_amount_cents is null or unit_price_amount_cents >= 0);

alter table public.lesson_requests
  add constraint lesson_requests_price_amount_cents_nonneg
    check (price_amount_cents is null or price_amount_cents >= 0);

-- ─────────────────────────────────────────────────────────────────────────
-- upsert_lesson_type — argument contract changes (numeric rate_amount +
-- rate_currency -> pricing_basis text + unit_price_amount_cents integer,
-- currency dropped). Explicit DROP of the exact old 8-arg Production
-- signature before recreating under the new 8-arg canonical signature
-- (still 8 args, but the 6th/7th params changed shape, so the old
-- signature's exact types no longer match — DROP is still required).
-- ─────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.upsert_lesson_type(uuid, text, text, integer[], integer, numeric, text, text);

create or replace function public.upsert_lesson_type(
  p_id uuid DEFAULT NULL::uuid,
  p_name text DEFAULT NULL::text,
  p_description text DEFAULT NULL::text,
  p_allowed_durations integer[] DEFAULT NULL::integer[],
  p_max_participants integer DEFAULT 1,
  p_pricing_basis text DEFAULT 'flat'::text,
  p_unit_price_amount_cents integer DEFAULT NULL::integer,
  p_rate_notes text DEFAULT NULL::text
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_profile public.profiles%rowtype;
  v_result  uuid;
begin
  select * into v_profile from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.club_id is null then raise exception 'no_club'; end if;
  if v_profile.role <> 'admin' then raise exception 'insufficient_role'; end if;

  if p_name is null or btrim(p_name) = '' then raise exception 'name_required'; end if;
  if char_length(p_name) > 100 then raise exception 'name_too_long'; end if;

  -- Validate allowed_durations: non-empty when provided; each value must be a
  -- positive multiple of 15 (consistent with the lesson_requests.duration_minutes check).
  if p_allowed_durations is not null then
    if array_length(p_allowed_durations, 1) = 0 then
      raise exception 'allowed_durations_empty';
    end if;
    if exists (
      select 1 from unnest(p_allowed_durations) d(v)
       where v <= 0 or v % 15 <> 0
    ) then
      raise exception 'allowed_durations_invalid';
    end if;
  end if;

  -- FINAL LESSON PRICING REFINEMENT: pricing_basis is required (matches the
  -- NOT NULL column) — 'flat' (configured amount is the total Lesson
  -- price) or 'hourly' (configured amount is an hourly rate, multiplied by
  -- the Lesson's own duration at snapshot time). unit_price_amount_cents:
  -- NULL = no price configured, 0 = explicitly free, both valid — only a
  -- negative amount is rejected.
  if p_pricing_basis is null or p_pricing_basis not in ('flat', 'hourly') then
    raise exception 'invalid_pricing_basis';
  end if;
  if p_unit_price_amount_cents is not null and p_unit_price_amount_cents < 0 then
    raise exception 'unit_price_invalid';
  end if;

  -- max_participants: the CHECK constraint enforces >= 1, also guard here
  if p_max_participants < 1 then raise exception 'max_participants_invalid'; end if;

  if p_id is not null then
    -- Update existing
    update public.lesson_types
       set name                     = btrim(p_name),
           description              = p_description,
           allowed_durations        = p_allowed_durations,
           max_participants         = p_max_participants,
           pricing_basis            = p_pricing_basis,
           unit_price_amount_cents  = p_unit_price_amount_cents,
           rate_notes               = p_rate_notes,
           updated_at               = now()
     where id      = p_id
       and club_id = v_profile.club_id
    returning id into v_result;

    if not found then raise exception 'lesson_type_not_found'; end if;
  else
    insert into public.lesson_types (
      club_id, name, description, allowed_durations,
      max_participants, pricing_basis, unit_price_amount_cents, rate_notes
    ) values (
      v_profile.club_id,
      btrim(p_name),
      p_description,
      p_allowed_durations,
      p_max_participants,
      p_pricing_basis,
      p_unit_price_amount_cents,
      p_rate_notes
    ) returning id into v_result;
  end if;

  return v_result;
end;
$$;

revoke execute on function public.upsert_lesson_type(uuid, text, text, integer[], integer, text, integer, text) from public, anon;
grant  execute on function public.upsert_lesson_type(uuid, text, text, integer[], integer, text, integer, text) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- get_lesson_types — RETURNS TABLE contract changes (rate_amount numeric +
-- rate_currency text -> pricing_basis text + unit_price_amount_cents
-- integer, rate_currency dropped). Explicit DROP before recreate — CREATE
-- OR REPLACE cannot change a return-table shape.
-- ─────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.get_lesson_types();

create or replace function public.get_lesson_types()
returns table(
  id uuid,
  name text,
  description text,
  allowed_durations integer[],
  max_participants integer,
  pricing_basis text,
  unit_price_amount_cents integer,
  rate_notes text,
  is_active boolean
)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_id uuid;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  select p.club_id into v_club_id from public.profiles p where p.id = auth.uid();
  if v_club_id is null then raise exception 'no_club'; end if;

  return query
    select lt.id, lt.name, lt.description, lt.allowed_durations,
           lt.max_participants, lt.pricing_basis, lt.unit_price_amount_cents,
           lt.rate_notes, lt.is_active
      from public.lesson_types lt
     where lt.club_id  = v_club_id
       and lt.is_active = true
     order by lt.name;
end;
$$;

revoke execute on function public.get_lesson_types() from public, anon;
grant  execute on function public.get_lesson_types() to authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- admin_create_member_lesson — verbatim Production body + flat price
-- snapshot, resolved once at creation from the selected lesson_types row.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_create_member_lesson(p_expected_club_id uuid, p_roster_member_id uuid, p_pro_id uuid, p_court_id uuid, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone, p_lesson_type_id uuid DEFAULT NULL::uuid, p_member_note text DEFAULT NULL::text)
 RETURNS lesson_requests
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_club_id           uuid;
  v_role              text;
  v_roster            public.roster_members%rowtype;
  v_member_id         uuid;
  v_pro                public.profiles%rowtype;
  v_duration_minutes  int;
  v_tz                text;
  v_res_id            uuid;
  v_result            public.lesson_requests%rowtype;
  v_member_name       text;
  -- FINAL LESSON PRICING REFINEMENT: flat-or-hourly price snapshot,
  -- resolved once at creation from the selected lesson_types row.
  v_pricing_basis            text;
  v_unit_price_amount_cents  integer;
  v_price_amount_cents       integer;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
  if v_role is null or v_role not in ('admin', 'pro', 'staff') then raise exception 'insufficient_role'; end if;

  -- A Pro may only book themselves as the lesson provider — assigning a
  -- different Pro remains an admin/staff-only action. Unchanged: this
  -- check is keyed to role='pro' specifically, so it never applies to a
  -- Staff caller (see this section's header above).
  if v_role = 'pro' and p_pro_id <> auth.uid() then
    raise exception 'insufficient_role';
  end if;

  select * into v_roster
    from public.roster_members
   where id      = p_roster_member_id
     and club_id = v_club_id;
  if not found then raise exception 'roster_member_not_found'; end if;

  v_member_id   := v_roster.claimed_by;
  v_member_name := trim(coalesce(v_roster.first_name, '') || ' ' || coalesce(v_roster.last_name, ''));

  -- Validate pro: active, same club, role pro/admin/staff, is_lesson_provider = true
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

    -- FINAL LESSON PRICING REFINEMENT: resolved once here at creation.
    -- flat: total = the configured unit amount. hourly: total = the
    -- configured hourly unit rate multiplied by this Lesson's own
    -- duration, rounded to the nearest cent (same integer-safe pattern as
    -- court pricing). A NULL unit price always yields a NULL total,
    -- whichever basis. No per-pro override; no per-participant math.
    select pricing_basis, unit_price_amount_cents
      into v_pricing_basis, v_unit_price_amount_cents
      from public.lesson_types where id = p_lesson_type_id;

    if v_pricing_basis = 'hourly' then
      if v_unit_price_amount_cents is not null then
        v_price_amount_cents := round(v_unit_price_amount_cents * v_duration_minutes / 60.0)::integer;
      else
        v_price_amount_cents := null;
      end if;
    else
      v_price_amount_cents := v_unit_price_amount_cents;
    end if;
  end if;

  if length(p_member_note) > 500 then raise exception 'note_too_long'; end if;

  if exists (
    select 1 from public.reservations r
     where r.court_id = p_court_id
       and r.status   in ('pending', 'confirmed')
       and tstzrange(r.starts_at, r.ends_at, '[)') && tstzrange(p_starts_at, p_ends_at, '[)')
  ) then
    raise exception 'court_conflict';
  end if;

  select timezone into v_tz from public.clubs where id = v_club_id;
  perform public._lesson_check_operating_hours(v_club_id, p_starts_at, p_ends_at, v_tz);

  perform public._lesson_check_pro_availability(p_pro_id, p_starts_at, p_ends_at, null);

  perform public._lesson_check_member_availability(v_member_id, p_roster_member_id, p_starts_at, p_ends_at, null);

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

  insert into public.lesson_requests (
    club_id, member_id, pro_id, roster_member_id,
    duration_minutes, member_note, lesson_type_id,
    proposed_starts_at, proposed_ends_at, proposed_court_id,
    status, linked_reservation_id, confirmed_at,
    last_actor_id, last_actor_role,
    pricing_basis, unit_price_amount_cents, price_amount_cents
  ) values (
    v_club_id, v_member_id, p_pro_id, p_roster_member_id,
    v_duration_minutes, btrim(coalesce(p_member_note, '')), p_lesson_type_id,
    p_starts_at, p_ends_at, p_court_id,
    'confirmed', v_res_id, now(),
    auth.uid(), v_role,
    v_pricing_basis, v_unit_price_amount_cents, v_price_amount_cents
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

  if p_pro_id <> auth.uid() then
    insert into public.notifications (club_id, user_id, kind, body, metadata)
    values (
      v_club_id, p_pro_id, 'lesson_request_confirmed',
      'Lesson with ' || v_member_name || ' confirmed for ' ||
        to_char(p_starts_at at time zone v_tz, 'Mon DD "at" HH12:MI AM') || '.',
      jsonb_build_object('request_id', v_result.id, 'reservation_id', v_res_id)
    );
  end if;

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
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- submit_lesson_request — verbatim Production body + identical flat price
-- snapshot logic, resolved at creation from the selected lesson_types row.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.submit_lesson_request(p_pro_id uuid, p_duration_minutes integer, p_preferred_court_id uuid DEFAULT NULL::uuid, p_member_note text DEFAULT NULL::text, p_preferred_windows jsonb DEFAULT NULL::jsonb, p_lesson_type_id uuid DEFAULT NULL::uuid)
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

-- ─────────────────────────────────────────────────────────────────────────
-- admin_update_member_lesson — 0138 body (already Production-verified) +
-- lesson-type-change re-snapshot. If p_lesson_type_id is unchanged, the
-- existing price snapshot is preserved untouched (mirrors the reservation
-- rule: time/court/provider-only edits never reprice). If it changes, the
-- price is re-resolved from the NEW lesson type's current price (or NULL,
-- if changed to no lesson type) — mirrors the reservation court-change
-- rule: changing what is priced re-resolves from its current configuration.
-- ─────────────────────────────────────────────────────────────────────────
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
  -- FINAL LESSON PRICING REFINEMENT: lesson-type-change re-snapshot, plus
  -- duration-only recompute for an hourly-priced Lesson whose type is
  -- unchanged.
  v_lesson_type_changed boolean;
  v_duration_changed     boolean;
  v_pricing_basis            text;
  v_unit_price_amount_cents  integer;
  v_price_amount_cents       integer;
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

  -- FINAL LESSON PRICING REFINEMENT — full A/B/C-style edit invariants:
  --
  --  * lesson_type_id UNCHANGED, duration UNCHANGED (time/court/provider/
  --    member-only edits): preserve pricing_basis, unit price, and total
  --    exactly.
  --  * lesson_type_id UNCHANGED, duration CHANGED: preserve the existing
  --    pricing_basis + unit price snapshot. flat -> total stays exactly
  --    what it was (a flat Lesson price does not scale with duration).
  --    hourly -> recompute total from the PRESERVED unit rate times the
  --    NEW duration. A NULL preserved unit price always keeps the total
  --    NULL — never silently adopt today's Lesson Type rate merely because
  --    an existing Lesson's duration changed.
  --  * lesson_type_id CHANGES: snapshot the NEW type's CURRENT
  --    pricing_basis + unit price, and calculate a fresh total from the
  --    Lesson's current (possibly also-changed) duration — changing what
  --    is priced re-resolves from its current configuration, exactly like
  --    the reservation court-change rule. Changing to no Lesson Type at
  --    all (NULL) clears all three snapshot fields to NULL.
  v_lesson_type_changed := p_lesson_type_id is distinct from v_before.lesson_type_id;
  v_duration_changed    := v_duration_minutes is distinct from v_before.duration_minutes;

  if v_lesson_type_changed then
    if p_lesson_type_id is not null then
      select pricing_basis, unit_price_amount_cents
        into v_pricing_basis, v_unit_price_amount_cents
        from public.lesson_types where id = p_lesson_type_id;

      if v_pricing_basis = 'hourly' then
        if v_unit_price_amount_cents is not null then
          v_price_amount_cents := round(v_unit_price_amount_cents * v_duration_minutes / 60.0)::integer;
        else
          v_price_amount_cents := null;
        end if;
      else
        v_price_amount_cents := v_unit_price_amount_cents;
      end if;
    else
      v_pricing_basis           := null;
      v_unit_price_amount_cents := null;
      v_price_amount_cents      := null;
    end if;
  else
    v_pricing_basis           := v_before.pricing_basis;
    v_unit_price_amount_cents := v_before.unit_price_amount_cents;

    if v_duration_changed and v_pricing_basis = 'hourly' and v_unit_price_amount_cents is not null then
      v_price_amount_cents := round(v_unit_price_amount_cents * v_duration_minutes / 60.0)::integer;
    else
      v_price_amount_cents := v_before.price_amount_cents;
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
         pricing_basis           = v_pricing_basis,
         unit_price_amount_cents = v_unit_price_amount_cents,
         price_amount_cents      = v_price_amount_cents,
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
        'ends_at',          v_old_reservation.ends_at,
        'lesson_type_id',   v_before.lesson_type_id,
        'pricing_basis',    v_before.pricing_basis,
        'unit_price_amount_cents', v_before.unit_price_amount_cents,
        'price_amount_cents', v_before.price_amount_cents
      ),
      'after', jsonb_build_object(
        'roster_member_id', p_roster_member_id,
        'member_id',        v_member_id,
        'pro_id',           p_pro_id,
        'court_id',         p_court_id,
        'starts_at',        p_starts_at,
        'ends_at',          p_ends_at,
        'lesson_type_id',   p_lesson_type_id,
        'pricing_basis',    v_pricing_basis,
        'unit_price_amount_cents', v_unit_price_amount_cents,
        'price_amount_cents', v_price_amount_cents
      ),
      'scheduling_changed', v_scheduling_changed,
      'member_changed',     v_member_changed,
      'pro_changed',        v_pro_changed,
      'lesson_type_changed', v_lesson_type_changed,
      'duration_changed',    v_duration_changed,
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
-- Restore admin_create_member_lesson, submit_lesson_request, and
-- admin_update_member_lesson by re-querying their live Production
-- definitions immediately before rolling back. Drop the new
-- pricing_basis/unit_price_amount_cents/price_amount_cents columns and
-- constraints on lesson_requests. For lesson_types: since Production has
-- zero rows, re-add rate_amount numeric(10,2) and rate_currency text
-- default 'USD', drop pricing_basis/unit_price_amount_cents, and
-- DROP/recreate upsert_lesson_type and get_lesson_types under their prior
-- 0070/0071 contracts (re-querying Production if this migration was ever
-- actually applied and any row exists by rollback time).
