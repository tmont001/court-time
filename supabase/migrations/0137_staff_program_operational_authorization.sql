-- 0137_staff_program_operational_authorization.sql
-- Phase 34A completion — Programs.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
-- Extends the same generic-operator (admin+staff) authority given Events
-- (0136) to Programs. Every body below is copied verbatim from the
-- Production pg_get_functiondef output supplied directly by the operator
-- (2026-08-20) — not reconstructed from migration history. The ONLY change
-- per function is the caller role-allowlist widening described below;
-- every validation, locking, capacity, waitlist, scheduling-rule,
-- session-generation, enrollment, and audit invariant is reproduced
-- byte-for-byte.
--
-- Every one of these 16 functions shares the identical pre-existing
-- pattern: `if v_role not in ('admin', 'pro') then raise exception
-- 'insufficient_role'; end if;`, and 14 of the 16 additionally have a
-- second, separate Pro-ownership guard: `if v_role = 'pro' and
-- v_program.created_by <> auth.uid() then raise exception
-- 'insufficient_role'; end if;`. Widening only the FIRST (allowlist)
-- check to admit 'staff' leaves the second guard's condition completely
-- unchanged — it can never evaluate true for a Staff caller (that
-- condition is a literal `v_role = 'pro'` comparison) — so Staff receives
-- the same unrestricted, non-owner-scoped access Admin already has,
-- exactly matching "Staff is generic operator and should not inherit
-- Pro's creator/self-scoping." create_program has no ownership guard
-- (nothing to own yet); generate_program_sessions/preview_program_sessions/
-- get_program_roster/get_program_eligible_members/
-- get_program_eligible_roster_members/add_program_member/
-- add_program_roster_member/remove_program_member/
-- remove_program_roster_member/force_confirm_program_roster_member all
-- have it.
--
-- get_program_roster additionally restricts email visibility to the
-- literal role 'admin' (`case when v_role = 'admin' then u.email::text
-- else null end`) — widened to `v_role in ('admin', 'staff')`, matching
-- the same operator-parity principle already established for Members
-- (get_members/get_admin_member_detail, 0132): Staff already sees Member
-- email addresses everywhere else in the app, so a Program roster
-- specifically hiding them from Staff (while showing them) would be an
-- inconsistent, accidental gap, not a deliberate boundary.
--
-- Member self-service Program RPCs (join_program, leave_program,
-- accept_program_waitlist_offer, decline_program_waitlist_offer) are
-- untouched and not part of this migration — Staff uses the operational
-- Admin-style paths above instead, per instruction.
--
-- No DROP anywhere in this migration: every CREATE OR REPLACE targets the
-- exact live function identity: signature, return type, SECURITY DEFINER,
-- and search_path. No REVOKE/GRANT needed — none of these functions'
-- authenticated-callable posture changes.
--
-- Does not modify 0131-0136. Not applied by this checkpoint. Apply in
-- Supabase SQL Editor (cloud only).
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ─────────────────────────────────────────────────────────────────────────
-- create_program — allowlist widened admin+pro -> admin+pro+staff. No
-- ownership restriction (nothing to own yet).
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_program(p_event_type_id uuid, p_title text, p_enrollment_model text, p_starts_on date, p_ends_on date, p_default_capacity integer, p_rules jsonb, p_description text DEFAULT NULL::text)
 RETURNS programs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_club_id               uuid;
  v_role                  text;
  v_event_type            public.event_types%rowtype;
  v_program                public.programs%rowtype;
  v_rule                   jsonb;
  v_court_ids               jsonb;
  v_court_count             int;
  v_distinct_court_count    int;
  v_cap_override            int;
  v_duplicate_rule_count    int;
  v_new_rule_id             uuid;
  v_court_id_text           text;
  v_court_uuid              uuid;
  v_day_of_week             int;
  v_start_time              time;
  v_duration_minutes        int;
begin
  -- Membership-native auth capture — one statement, one snapshot. See 0083
  -- for why this must not be two separate calls.
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if v_role not in ('admin', 'pro', 'staff') then raise exception 'insufficient_role'; end if;

  if p_title is null or length(btrim(p_title)) = 0 then
    raise exception 'invalid_title';
  end if;

  if p_enrollment_model not in ('program', 'per_session', 'admin_managed') then
    raise exception 'invalid_enrollment_model';
  end if;

  if p_starts_on is null or p_ends_on is null or p_ends_on < p_starts_on then
    raise exception 'invalid_date_range';
  end if;
  if (p_ends_on - p_starts_on) > 182 then
    raise exception 'range_too_long';
  end if;

  if p_default_capacity is null or p_default_capacity <= 0 then
    raise exception 'invalid_capacity';
  end if;

  select * into v_event_type
    from public.event_types
    where id = p_event_type_id and club_id = v_club_id and is_active = true;
  if not found then raise exception 'event_type_not_found'; end if;

  if p_rules is null or jsonb_typeof(p_rules) <> 'array' or jsonb_array_length(p_rules) = 0 then
    raise exception 'invalid_rules_payload';
  end if;

  -- ── Pass 1: validate every rule and its courts. No writes yet. Every
  -- jsonb-derived scalar is parsed inside a narrow exception guard so a
  -- malformed payload raises this function's own documented error code
  -- instead of a raw Postgres cast error. ────────────────────────────────
  for v_rule in select * from jsonb_array_elements(p_rules) loop
    if jsonb_typeof(v_rule) <> 'object' then
      raise exception 'invalid_rules_payload';
    end if;

    if not (v_rule ? 'day_of_week')
       or jsonb_typeof(v_rule->'day_of_week') <> 'number' then
      raise exception 'invalid_day_of_week';
    end if;
    begin
      v_day_of_week := (v_rule->>'day_of_week')::int;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception 'invalid_day_of_week';
    end;
    if v_day_of_week not between 0 and 6 then
      raise exception 'invalid_day_of_week';
    end if;

    if v_rule->>'start_time' is null then
      raise exception 'invalid_start_time';
    end if;
    begin
      v_start_time := (v_rule->>'start_time')::time;
    exception when invalid_text_representation
                 or invalid_datetime_format
                 or datetime_field_overflow then
      raise exception 'invalid_start_time';
    end;

    if not (v_rule ? 'duration_minutes')
       or jsonb_typeof(v_rule->'duration_minutes') <> 'number' then
      raise exception 'invalid_duration';
    end if;
    begin
      v_duration_minutes := (v_rule->>'duration_minutes')::int;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception 'invalid_duration';
    end;
    if v_duration_minutes <= 0 then
      raise exception 'invalid_duration';
    end if;

    if v_rule ? 'capacity_override' and jsonb_typeof(v_rule->'capacity_override') <> 'null' then
      if jsonb_typeof(v_rule->'capacity_override') <> 'number' then
        raise exception 'invalid_capacity_override';
      end if;
      begin
        v_cap_override := (v_rule->>'capacity_override')::int;
      exception when invalid_text_representation or numeric_value_out_of_range then
        raise exception 'invalid_capacity_override';
      end;
      if v_cap_override <= 0 then
        raise exception 'invalid_capacity_override';
      end if;
      if p_enrollment_model = 'program' then
        raise exception 'capacity_override_not_allowed_for_program_enrollment';
      end if;
    else
      v_cap_override := null;
    end if;

    v_court_ids := v_rule->'court_ids';
    if v_court_ids is null or jsonb_typeof(v_court_ids) <> 'array' or jsonb_array_length(v_court_ids) = 0 then
      raise exception 'rule_requires_court';
    end if;

    select count(*), count(distinct value)
      into v_court_count, v_distinct_court_count
      from jsonb_array_elements_text(v_court_ids);
    if v_court_count <> v_distinct_court_count then
      raise exception 'duplicate_court_in_rule';
    end if;

    -- Every court must be a well-formed uuid belonging to the caller's
    -- active club and be active. Cast guarded individually per element so
    -- a malformed uuid string is reported as court_not_found rather than a
    -- raw cast error.
    for v_court_id_text in select value from jsonb_array_elements_text(v_court_ids) loop
      begin
        v_court_uuid := v_court_id_text::uuid;
      exception when invalid_text_representation then
        raise exception 'court_not_found';
      end;

      if not exists (
        select 1 from public.courts c
        where c.id = v_court_uuid and c.club_id = v_club_id and c.is_active = true
      ) then
        raise exception 'court_not_found';
      end if;
    end loop;
  end loop;

  -- No duplicate (day_of_week, start_time) rule pairs across the whole
  -- payload — enforced independently of court by the 0087 unique
  -- constraint program_schedule_rules_program_day_start_unique regardless.
  -- Safe to cast directly here: pass 1 already proved every element parses.
  select count(*) into v_duplicate_rule_count
  from (
    select (elem->>'day_of_week')::int as dow, (elem->>'start_time')::time as st
    from jsonb_array_elements(p_rules) as elem
    group by 1, 2
    having count(*) > 1
  ) dupes;
  if v_duplicate_rule_count > 0 then
    raise exception 'duplicate_rule';
  end if;

  -- Overlapping-rule rejection: two DIFFERENT rules (not an exact
  -- day_of_week+start_time duplicate, already rejected above) that share
  -- the same day_of_week, share at least one court, and whose
  -- [start_time, start_time+duration_minutes) windows overlap. Half-open
  -- comparison — adjacent windows (09:00-10:00 and 10:00-11:00) do not
  -- overlap, matching the reservations table's own '[)' exclude-constraint
  -- semantics (0003). Rules on entirely different courts are never
  -- rejected regardless of time overlap. Safe to cast directly: every
  -- element already proved well-formed in pass 1.
  if exists (
    select 1
    from jsonb_array_elements(p_rules) with ordinality as a(rule, idx)
    join jsonb_array_elements(p_rules) with ordinality as b(rule, idx)
      on a.idx < b.idx
    where (a.rule->>'day_of_week')::int = (b.rule->>'day_of_week')::int
      and exists (
        select 1
        from jsonb_array_elements_text(a.rule->'court_ids') as ac(court_id)
        join jsonb_array_elements_text(b.rule->'court_ids') as bc(court_id)
          on ac.court_id = bc.court_id
      )
      and (a.rule->>'start_time')::time
          < ((b.rule->>'start_time')::time + ((b.rule->>'duration_minutes')::int || ' minutes')::interval)::time
      and (b.rule->>'start_time')::time
          < ((a.rule->>'start_time')::time + ((a.rule->>'duration_minutes')::int || ' minutes')::interval)::time
  ) then
    raise exception 'overlapping_program_rules';
  end if;

  -- ── Pass 2: all validation passed — create the program (draft) and its
  -- rules/courts. ──────────────────────────────────────────────────────────
  insert into public.programs (
    club_id, event_type_id, title, description, enrollment_model,
    status, starts_on, ends_on, default_capacity, created_by
  ) values (
    v_club_id, p_event_type_id, btrim(p_title), p_description, p_enrollment_model,
    'draft', p_starts_on, p_ends_on, p_default_capacity, auth.uid()
  )
  returning * into v_program;

  for v_rule in select * from jsonb_array_elements(p_rules) loop
    v_cap_override := case
      when jsonb_typeof(v_rule->'capacity_override') = 'number'
        then (v_rule->>'capacity_override')::int
      else null
    end;

    insert into public.program_schedule_rules (
      program_id, day_of_week, start_time, duration_minutes, capacity_override
    ) values (
      v_program.id,
      (v_rule->>'day_of_week')::int,
      (v_rule->>'start_time')::time,
      (v_rule->>'duration_minutes')::int,
      v_cap_override
    )
    returning id into v_new_rule_id;

    for v_court_id_text in select value from jsonb_array_elements_text(v_rule->'court_ids') loop
      insert into public.program_rule_courts (program_schedule_rule_id, court_id)
      values (v_new_rule_id, v_court_id_text::uuid);
    end loop;
  end loop;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id,
    auth.uid(),
    'create_program',
    'program',
    v_program.id,
    jsonb_build_object(
      'title',            v_program.title,
      'enrollment_model', p_enrollment_model,
      'starts_on',        p_starts_on,
      'ends_on',          p_ends_on,
      'rule_count',       jsonb_array_length(p_rules)
    )
  );

  return v_program;
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- update_program — allowlist widened admin+pro -> admin+pro+staff.
-- Pro-ownership guard untouched, cannot apply to Staff.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.update_program(p_program_id uuid, p_event_type_id uuid, p_title text, p_enrollment_model text, p_starts_on date, p_ends_on date, p_default_capacity integer, p_rules jsonb, p_description text DEFAULT NULL::text)
 RETURNS programs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_club_id               uuid;
  v_role                  text;
  v_program                public.programs%rowtype;
  v_updated                public.programs%rowtype;
  v_event_type             public.event_types%rowtype;
  v_rule                   jsonb;
  v_court_ids               jsonb;
  v_court_count             int;
  v_distinct_court_count    int;
  v_cap_override            int;
  v_duplicate_rule_count    int;
  v_new_rule_id             uuid;
  v_court_id_text           text;
  v_court_uuid              uuid;
  v_day_of_week             int;
  v_start_time              time;
  v_duration_minutes        int;
begin
  -- Membership-native auth capture — one statement, one snapshot.
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if v_role not in ('admin', 'pro', 'staff') then raise exception 'insufficient_role'; end if;

  select * into v_program
    from public.programs
    where id = p_program_id and club_id = v_club_id;
  if not found then raise exception 'program_not_found'; end if;

  -- Admin may edit any in-club draft; Pro may edit only their own.
  if v_role = 'pro' and v_program.created_by <> auth.uid() then
    raise exception 'insufficient_role';
  end if;

  -- Editable-state gate — three separate guards, in this exact order, so
  -- each rejection reports the most specific applicable code (see the
  -- migration header for the full rationale).

  -- 1. Archived always wins, regardless of status or generated events.
  if v_program.archived_at is not null then
    raise exception 'program_not_editable';
  end if;

  -- 2. Checked before the plain status check: a normally generated/active
  -- program (which always has events) reports the more specific
  -- program_already_generated; this also independently catches an
  -- anomalous draft that somehow already has events.
  if exists (select 1 from public.events where program_id = v_program.id) then
    raise exception 'program_already_generated';
  end if;

  -- 3. Reached only for a non-archived, event-free, non-draft program
  -- (e.g. cancelled/completed with nothing generated).
  if v_program.status <> 'draft' then
    raise exception 'program_not_editable';
  end if;

  if p_title is null or length(btrim(p_title)) = 0 then
    raise exception 'invalid_title';
  end if;

  if p_enrollment_model not in ('program', 'per_session', 'admin_managed') then
    raise exception 'invalid_enrollment_model';
  end if;

  if p_starts_on is null or p_ends_on is null or p_ends_on < p_starts_on then
    raise exception 'invalid_date_range';
  end if;
  if (p_ends_on - p_starts_on) > 182 then
    raise exception 'range_too_long';
  end if;

  if p_default_capacity is null or p_default_capacity <= 0 then
    raise exception 'invalid_capacity';
  end if;

  select * into v_event_type
    from public.event_types
    where id = p_event_type_id and club_id = v_club_id and is_active = true;
  if not found then raise exception 'event_type_not_found'; end if;

  if p_rules is null or jsonb_typeof(p_rules) <> 'array' or jsonb_array_length(p_rules) = 0 then
    raise exception 'invalid_rules_payload';
  end if;

  -- ── Pass 1: validate every rule and its courts. No writes yet. Guarded
  -- exception handling matches create_program (0089) exactly — no
  -- WHEN OTHERS anywhere, only the specific malformed-input SQLSTATEs. ──
  for v_rule in select * from jsonb_array_elements(p_rules) loop
    if jsonb_typeof(v_rule) <> 'object' then
      raise exception 'invalid_rules_payload';
    end if;

    if not (v_rule ? 'day_of_week')
       or jsonb_typeof(v_rule->'day_of_week') <> 'number' then
      raise exception 'invalid_day_of_week';
    end if;
    begin
      v_day_of_week := (v_rule->>'day_of_week')::int;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception 'invalid_day_of_week';
    end;
    if v_day_of_week not between 0 and 6 then
      raise exception 'invalid_day_of_week';
    end if;

    if v_rule->>'start_time' is null then
      raise exception 'invalid_start_time';
    end if;
    begin
      v_start_time := (v_rule->>'start_time')::time;
    exception when invalid_text_representation
                 or invalid_datetime_format
                 or datetime_field_overflow then
      raise exception 'invalid_start_time';
    end;

    if not (v_rule ? 'duration_minutes')
       or jsonb_typeof(v_rule->'duration_minutes') <> 'number' then
      raise exception 'invalid_duration';
    end if;
    begin
      v_duration_minutes := (v_rule->>'duration_minutes')::int;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception 'invalid_duration';
    end;
    if v_duration_minutes <= 0 then
      raise exception 'invalid_duration';
    end if;

    if v_rule ? 'capacity_override' and jsonb_typeof(v_rule->'capacity_override') <> 'null' then
      if jsonb_typeof(v_rule->'capacity_override') <> 'number' then
        raise exception 'invalid_capacity_override';
      end if;
      begin
        v_cap_override := (v_rule->>'capacity_override')::int;
      exception when invalid_text_representation or numeric_value_out_of_range then
        raise exception 'invalid_capacity_override';
      end;
      if v_cap_override <= 0 then
        raise exception 'invalid_capacity_override';
      end if;
      if p_enrollment_model = 'program' then
        raise exception 'capacity_override_not_allowed_for_program_enrollment';
      end if;
    else
      v_cap_override := null;
    end if;

    v_court_ids := v_rule->'court_ids';
    if v_court_ids is null or jsonb_typeof(v_court_ids) <> 'array' or jsonb_array_length(v_court_ids) = 0 then
      raise exception 'rule_requires_court';
    end if;

    select count(*), count(distinct value)
      into v_court_count, v_distinct_court_count
      from jsonb_array_elements_text(v_court_ids);
    if v_court_count <> v_distinct_court_count then
      raise exception 'duplicate_court_in_rule';
    end if;

    for v_court_id_text in select value from jsonb_array_elements_text(v_court_ids) loop
      begin
        v_court_uuid := v_court_id_text::uuid;
      exception when invalid_text_representation then
        raise exception 'court_not_found';
      end;

      if not exists (
        select 1 from public.courts c
        where c.id = v_court_uuid and c.club_id = v_club_id and c.is_active = true
      ) then
        raise exception 'court_not_found';
      end if;
    end loop;
  end loop;

  -- No duplicate (day_of_week, start_time) rule pairs across the whole
  -- payload — enforced independently of court by the 0087 unique
  -- constraint program_schedule_rules_program_day_start_unique regardless.
  select count(*) into v_duplicate_rule_count
  from (
    select (elem->>'day_of_week')::int as dow, (elem->>'start_time')::time as st
    from jsonb_array_elements(p_rules) as elem
    group by 1, 2
    having count(*) > 1
  ) dupes;
  if v_duplicate_rule_count > 0 then
    raise exception 'duplicate_rule';
  end if;

  -- Overlapping-rule rejection — identical half-open-interval logic to
  -- create_program (0089): same day_of_week, at least one shared court,
  -- overlapping [start_time, start_time+duration_minutes) windows.
  -- Adjacent windows never overlap; different-court overlaps are allowed.
  if exists (
    select 1
    from jsonb_array_elements(p_rules) with ordinality as a(rule, idx)
    join jsonb_array_elements(p_rules) with ordinality as b(rule, idx)
      on a.idx < b.idx
    where (a.rule->>'day_of_week')::int = (b.rule->>'day_of_week')::int
      and exists (
        select 1
        from jsonb_array_elements_text(a.rule->'court_ids') as ac(court_id)
        join jsonb_array_elements_text(b.rule->'court_ids') as bc(court_id)
          on ac.court_id = bc.court_id
      )
      and (a.rule->>'start_time')::time
          < ((b.rule->>'start_time')::time + ((b.rule->>'duration_minutes')::int || ' minutes')::interval)::time
      and (b.rule->>'start_time')::time
          < ((a.rule->>'start_time')::time + ((a.rule->>'duration_minutes')::int || ' minutes')::interval)::time
  ) then
    raise exception 'overlapping_program_rules';
  end if;

  -- ── All validation passed — replace the definition atomically. ──────────
  -- created_by is deliberately absent from this SET list: ownership is
  -- never touched by an edit, regardless of who (Admin or the owning Pro)
  -- performs it.
  update public.programs set
    event_type_id     = p_event_type_id,
    title             = btrim(p_title),
    description       = p_description,
    enrollment_model  = p_enrollment_model,
    starts_on         = p_starts_on,
    ends_on           = p_ends_on,
    default_capacity  = p_default_capacity,
    updated_at        = now()
  where id = v_program.id
  returning * into v_updated;

  -- Cascades to program_rule_courts (0087: ON DELETE CASCADE).
  delete from public.program_schedule_rules where program_id = v_program.id;

  for v_rule in select * from jsonb_array_elements(p_rules) loop
    v_cap_override := case
      when jsonb_typeof(v_rule->'capacity_override') = 'number'
        then (v_rule->>'capacity_override')::int
      else null
    end;

    insert into public.program_schedule_rules (
      program_id, day_of_week, start_time, duration_minutes, capacity_override
    ) values (
      v_program.id,
      (v_rule->>'day_of_week')::int,
      (v_rule->>'start_time')::time,
      (v_rule->>'duration_minutes')::int,
      v_cap_override
    )
    returning id into v_new_rule_id;

    for v_court_id_text in select value from jsonb_array_elements_text(v_rule->'court_ids') loop
      insert into public.program_rule_courts (program_schedule_rule_id, court_id)
      values (v_new_rule_id, v_court_id_text::uuid);
    end loop;
  end loop;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id,
    auth.uid(),
    'update_program',
    'program',
    v_program.id,
    jsonb_build_object(
      'before', jsonb_build_object(
        'title',            v_program.title,
        'enrollment_model', v_program.enrollment_model,
        'starts_on',        v_program.starts_on,
        'ends_on',          v_program.ends_on,
        'default_capacity', v_program.default_capacity,
        'event_type_id',    v_program.event_type_id
      ),
      'after', jsonb_build_object(
        'title',            v_updated.title,
        'enrollment_model', v_updated.enrollment_model,
        'starts_on',        v_updated.starts_on,
        'ends_on',          v_updated.ends_on,
        'default_capacity', v_updated.default_capacity,
        'event_type_id',    v_updated.event_type_id
      ),
      'rule_count', jsonb_array_length(p_rules)
    )
  );

  return v_updated;
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- cancel_program — allowlist widened admin+pro -> admin+pro+staff.
-- Pro-ownership guard untouched, cannot apply to Staff.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cancel_program(p_program_id uuid)
 RETURNS programs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_club_id             uuid;
  v_role                text;
  v_program             public.programs%rowtype;
  v_result              public.programs%rowtype;
  v_cancelled_event_ids uuid[];
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;
  if v_club_id is null then raise exception 'not_authenticated'; end if;

  if v_role not in ('admin', 'pro', 'staff') then
    raise exception 'insufficient_role';
  end if;

  select * into v_program
    from public.programs
    where id = p_program_id and club_id = v_club_id
    for update;
  if not found then raise exception 'program_not_found'; end if;

  if v_role = 'pro' and v_program.created_by <> auth.uid() then
    raise exception 'insufficient_role';
  end if;

  -- Only a draft or active program can be cancelled — already-cancelled,
  -- already-completed, and archived programs all raise this same code
  -- (see migration header note on error-code minimalism).
  if v_program.archived_at is not null or v_program.status not in ('draft', 'active') then
    raise exception 'program_not_cancellable';
  end if;

  update public.programs
    set status = 'cancelled', updated_at = now()
    where id = p_program_id
    returning * into v_result;

  -- Bulk-cancel every scheduled, non-archived, future generated event under
  -- this program — same field updates as cancel_event (0063), applied
  -- set-based. Past events (starts_at < now()) are never selected here.
  select array_agg(id) into v_cancelled_event_ids
    from public.events
    where program_id  = p_program_id
      and status       = 'scheduled'
      and archived_at is null
      and starts_at   >= now();

  if v_cancelled_event_ids is not null then
    update public.events
      set status = 'cancelled', updated_at = now()
      where id = any(v_cancelled_event_ids);

    update public.reservations
      set status            = 'cancelled',
          cancelled_at      = now(),
          cancelled_by      = auth.uid(),
          cancellation_kind = 'admin',
          updated_at        = now()
      where event_id = any(v_cancelled_event_ids)
        and status   in ('pending', 'confirmed');

    -- Only 'offered' rows are cancelled, mirroring cancel_event exactly —
    -- confirmed/waitlisted event_participants rows are left as historical
    -- record, matching program_enrollments' own preservation below.
    update public.event_participants
      set status           = 'cancelled',
          offer_expires_at = null,
          updated_at       = now()
      where event_id = any(v_cancelled_event_ids)
        and status   = 'offered';
  end if;
  -- program_enrollments is intentionally never touched here — see
  -- migration header.

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'cancel_program', 'program', p_program_id,
    jsonb_build_object(
      'title',                 v_program.title,
      'previous_status',       v_program.status,
      'cancelled_event_count', coalesce(array_length(v_cancelled_event_ids, 1), 0),
      'actor_role',            v_role
    )
  );

  return v_result;
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- complete_program — allowlist widened admin+pro -> admin+pro+staff.
-- Pro-ownership guard untouched, cannot apply to Staff.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.complete_program(p_program_id uuid)
 RETURNS programs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_club_id             uuid;
  v_role                text;
  v_program             public.programs%rowtype;
  v_result              public.programs%rowtype;
  v_tz                  text;
  v_window_ended        boolean;
  v_has_future_sessions boolean;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;
  if v_club_id is null then raise exception 'not_authenticated'; end if;

  if v_role not in ('admin', 'pro', 'staff') then
    raise exception 'insufficient_role';
  end if;

  select * into v_program
    from public.programs
    where id = p_program_id and club_id = v_club_id
    for update;
  if not found then raise exception 'program_not_found'; end if;

  if v_role = 'pro' and v_program.created_by <> auth.uid() then
    raise exception 'insufficient_role';
  end if;

  if v_program.archived_at is not null or v_program.status <> 'active' then
    raise exception 'program_not_completable';
  end if;

  select timezone into v_tz from public.clubs where id = v_club_id;
  v_window_ended := v_program.ends_on < (now() at time zone coalesce(v_tz, 'UTC'))::date;

  select exists (
    select 1 from public.events
    where program_id  = p_program_id
      and status       = 'scheduled'
      and archived_at is null
      and starts_at   >= now()
  ) into v_has_future_sessions;

  if not (v_window_ended or not v_has_future_sessions) then
    raise exception 'program_not_completable';
  end if;

  update public.programs
    set status = 'completed', updated_at = now()
    where id = p_program_id
    returning * into v_result;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'complete_program', 'program', p_program_id,
    jsonb_build_object(
      'title',               v_program.title,
      'window_ended',        v_window_ended,
      'had_future_sessions', v_has_future_sessions,
      'actor_role',          v_role
    )
  );

  return v_result;
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- archive_program — allowlist widened admin+pro -> admin+pro+staff.
-- Pro-ownership guard untouched, cannot apply to Staff.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.archive_program(p_program_id uuid)
 RETURNS programs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_club_id uuid;
  v_role    text;
  v_program public.programs%rowtype;
  v_result  public.programs%rowtype;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;
  if v_club_id is null then raise exception 'not_authenticated'; end if;

  if v_role not in ('admin', 'pro', 'staff') then
    raise exception 'insufficient_role';
  end if;

  select * into v_program
    from public.programs
    where id = p_program_id and club_id = v_club_id
    for update;
  if not found then raise exception 'program_not_found'; end if;

  if v_role = 'pro' and v_program.created_by <> auth.uid() then
    raise exception 'insufficient_role';
  end if;

  if v_program.archived_at is not null then
    raise exception 'already_archived';
  end if;

  if v_program.status not in ('cancelled', 'completed') then
    raise exception 'program_not_archivable';
  end if;

  update public.programs
    set archived_at = now(), archived_by = auth.uid(), updated_at = now()
    where id = p_program_id
    returning * into v_result;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'archive_program', 'program', p_program_id,
    jsonb_build_object('title', v_program.title, 'status', v_program.status, 'actor_role', v_role)
  );

  return v_result;
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- unarchive_program — allowlist widened admin+pro -> admin+pro+staff.
-- Pro-ownership guard untouched, cannot apply to Staff.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.unarchive_program(p_program_id uuid)
 RETURNS programs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_club_id uuid;
  v_role    text;
  v_program public.programs%rowtype;
  v_result  public.programs%rowtype;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;
  if v_club_id is null then raise exception 'not_authenticated'; end if;

  if v_role not in ('admin', 'pro', 'staff') then
    raise exception 'insufficient_role';
  end if;

  select * into v_program
    from public.programs
    where id = p_program_id and club_id = v_club_id
    for update;
  if not found then raise exception 'program_not_found'; end if;

  if v_role = 'pro' and v_program.created_by <> auth.uid() then
    raise exception 'insufficient_role';
  end if;

  if v_program.archived_at is null then
    raise exception 'not_archived';
  end if;

  update public.programs
    set archived_at = null, archived_by = null, updated_at = now()
    where id = p_program_id
    returning * into v_result;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'unarchive_program', 'program', p_program_id,
    jsonb_build_object('title', v_program.title, 'status', v_program.status, 'actor_role', v_role)
  );

  return v_result;
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- generate_program_sessions — allowlist widened admin+pro -> admin+pro+
-- staff. Pro-ownership guard untouched, cannot apply to Staff.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.generate_program_sessions(p_program_id uuid, p_from_date date DEFAULT NULL::date, p_through_date date DEFAULT NULL::date)
 RETURNS TABLE(inserted_count integer, skipped_count integer, event_ids uuid[])
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_club_id            uuid;
  v_role               text;
  v_program            public.programs%rowtype;
  v_tz                 text;
  v_from               date;
  v_through            date;
  v_total_count        int;
  v_new_count          int;
  v_conflict_res_id    uuid;
  v_conflict_court_id  uuid;
  v_conflict_date      date;
  v_conflict_rule_a    uuid;
  v_conflict_rule_b    uuid;
  v_rec                record;
  v_starts_at          timestamptz;
  v_ends_at            timestamptz;
  v_capacity           int;
  v_court_count        int;
  v_member_joinable    boolean;
  v_new_event          public.events%rowtype;
  v_court_rec          record;
  v_inserted_ids       uuid[] := '{}';
  v_inserted_count     int    := 0;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if v_role not in ('admin', 'pro', 'staff') then raise exception 'insufficient_role'; end if;

  select * into v_program
    from public.programs
    where id = p_program_id and club_id = v_club_id
    for update;
  if not found then raise exception 'program_not_found'; end if;

  if v_role = 'pro' and v_program.created_by <> auth.uid() then
    raise exception 'insufficient_role';
  end if;

  if v_program.archived_at is not null then raise exception 'program_archived'; end if;
  if v_program.status not in ('draft', 'active') then raise exception 'program_not_generatable'; end if;

  perform public._validate_program_definition(p_program_id, v_club_id, v_program.event_type_id);

  v_from    := greatest(coalesce(p_from_date, v_program.starts_on), v_program.starts_on);
  v_through := least(coalesce(p_through_date, v_program.ends_on), v_program.ends_on);

  if v_through < v_from then raise exception 'invalid_date_range'; end if;
  if (v_through - v_from) > 182 then raise exception 'range_too_long'; end if;

  select timezone into v_tz from public.clubs where id = v_club_id;

  select count(*) into v_total_count
  from public.program_schedule_rules psr
  cross join generate_series(v_from::timestamp, v_through::timestamp, interval '1 day') as d
  where psr.program_id = p_program_id
    and extract(dow from d)::int = psr.day_of_week;

  drop table if exists pg27b2_candidates;

  create temporary table pg27b2_candidates (
    rule_id            uuid,
    occurrence_date    date,
    start_time         time,
    duration_minutes   int,
    capacity_override  int,
    court_id           uuid
  ) on commit drop;

  insert into pg27b2_candidates (rule_id, occurrence_date, start_time, duration_minutes, capacity_override, court_id)
  select psr.id, d::date, psr.start_time, psr.duration_minutes, psr.capacity_override, prc.court_id
  from public.program_schedule_rules psr
  cross join generate_series(v_from::timestamp, v_through::timestamp, interval '1 day') as d
  join public.program_rule_courts prc on prc.program_schedule_rule_id = psr.id
  where psr.program_id = p_program_id
    and extract(dow from d)::int = psr.day_of_week
    and not exists (
      select 1 from public.events e
      where e.program_schedule_rule_id = psr.id
        and e.program_occurrence_date  = d::date
    );

  select count(distinct (rule_id, occurrence_date)) into v_new_count from pg27b2_candidates;

  if v_new_count = 0 then
    insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
    values (
      v_club_id, auth.uid(), 'generate_program_sessions', 'program', p_program_id,
      jsonb_build_object(
        'inserted_count',   0,
        'skipped_count',    v_total_count,
        'from',             v_from,
        'through',          v_through,
        'program_owner_id', v_program.created_by,
        'generated_by_id',  auth.uid()
      )
    );
    return query select 0, v_total_count, '{}'::uuid[];
    return;
  end if;

  if v_new_count > 200 then
    raise exception 'too_many_occurrences';
  end if;

  select a.court_id, a.occurrence_date, a.rule_id, b.rule_id
    into v_conflict_court_id, v_conflict_date, v_conflict_rule_a, v_conflict_rule_b
  from pg27b2_candidates a
  join pg27b2_candidates b
    on a.court_id = b.court_id
   and a.occurrence_date = b.occurrence_date
   and a.rule_id < b.rule_id
   and a.start_time < (b.start_time + (b.duration_minutes || ' minutes')::interval)::time
   and b.start_time < (a.start_time + (a.duration_minutes || ' minutes')::interval)::time
  limit 1;

  if v_conflict_court_id is not null then
    raise exception 'court_conflict'
      using detail = format(
        'batch_self_conflict court_id=%s occurrence_date=%s rule_a=%s rule_b=%s',
        v_conflict_court_id, v_conflict_date, v_conflict_rule_a, v_conflict_rule_b
      );
  end if;

  select r.id, c.court_id, c.occurrence_date
    into v_conflict_res_id, v_conflict_court_id, v_conflict_date
  from pg27b2_candidates c
  join public.reservations r
    on r.court_id = c.court_id
   and r.status in ('pending', 'confirmed')
   and tstzrange(r.starts_at, r.ends_at, '[)')
       && tstzrange(
            (c.occurrence_date + c.start_time) at time zone v_tz,
            ((c.occurrence_date + c.start_time) at time zone v_tz) + (c.duration_minutes || ' minutes')::interval,
            '[)'
          )
  limit 1;

  if v_conflict_res_id is not null then
    raise exception 'court_conflict'
      using detail = format(
        'existing_reservation court_id=%s occurrence_date=%s reservation_id=%s',
        v_conflict_court_id, v_conflict_date, v_conflict_res_id
      );
  end if;

  for v_rec in
    select distinct rule_id, occurrence_date, start_time, duration_minutes, capacity_override
    from pg27b2_candidates
    order by occurrence_date, start_time
  loop
    v_starts_at := (v_rec.occurrence_date + v_rec.start_time) at time zone v_tz;
    v_ends_at   := v_starts_at + (v_rec.duration_minutes || ' minutes')::interval;
    v_capacity  := coalesce(v_rec.capacity_override, v_program.default_capacity);

    if v_program.enrollment_model = 'program' and v_capacity < v_program.default_capacity then
      raise exception 'capacity_override_below_program_capacity';
    end if;

    select count(*) into v_court_count
      from public.program_rule_courts
      where program_schedule_rule_id = v_rec.rule_id;

    v_member_joinable := (v_program.enrollment_model = 'per_session');

    insert into public.events (
      club_id, event_type_id, title, description,
      starts_at, ends_at, capacity, court_count, status, created_by,
      member_joinable, program_id, program_schedule_rule_id,
      program_occurrence_date, is_program_exception
    ) values (
      v_club_id, v_program.event_type_id, v_program.title, v_program.description,
      v_starts_at, v_ends_at, v_capacity, v_court_count, 'scheduled', v_program.created_by,
      v_member_joinable, v_program.id, v_rec.rule_id,
      v_rec.occurrence_date, false
    )
    returning * into v_new_event;

    for v_court_rec in
      select court_id from public.program_rule_courts where program_schedule_rule_id = v_rec.rule_id
    loop
      insert into public.reservations (
        club_id, court_id, owner_user_id,
        starts_at, ends_at, status, reason, event_id, created_by
      ) values (
        v_club_id, v_court_rec.court_id, v_program.created_by,
        v_starts_at, v_ends_at, 'confirmed', 'event', v_new_event.id, v_program.created_by
      );
    end loop;

    if v_program.enrollment_model = 'program' then
      insert into public.event_participants (event_id, profile_id, roster_member_id, role, status)
      select v_new_event.id, rm.claimed_by, pe.roster_member_id, 'participant', 'confirmed'
      from public.program_enrollments pe
      join public.roster_members rm
        on rm.id = pe.roster_member_id
      where pe.program_id = v_program.id
        and pe.status     = 'enrolled'
      order by pe.roster_member_id
      on conflict (event_id, profile_id) do nothing;
    end if;

    v_inserted_ids   := v_inserted_ids || v_new_event.id;
    v_inserted_count := v_inserted_count + 1;
  end loop;

  if v_program.status = 'draft' then
    update public.programs set status = 'active', updated_at = now() where id = v_program.id;
  end if;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'generate_program_sessions', 'program', p_program_id,
    jsonb_build_object(
      'inserted_count',   v_inserted_count,
      'skipped_count',    v_total_count - v_new_count,
      'from',             v_from,
      'through',          v_through,
      'event_ids',        to_jsonb(v_inserted_ids),
      'program_owner_id', v_program.created_by,
      'generated_by_id',  auth.uid()
    )
  );

  return query select v_inserted_count, (v_total_count - v_new_count), v_inserted_ids;
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- preview_program_sessions — allowlist widened admin+pro -> admin+pro+
-- staff. Pro-ownership guard untouched, cannot apply to Staff.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.preview_program_sessions(p_program_id uuid, p_from_date date DEFAULT NULL::date, p_through_date date DEFAULT NULL::date)
 RETURNS TABLE(program_schedule_rule_id uuid, occurrence_date date, starts_at timestamp with time zone, ends_at timestamp with time zone, court_id uuid, court_name text, already_generated boolean, has_conflict boolean, conflicting_reservation_id uuid, conflicting_event_id uuid, conflict_reason text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_club_id  uuid;
  v_role     text;
  v_program  public.programs%rowtype;
  v_tz       text;
  v_from     date;
  v_through  date;
  v_count    int;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if v_role not in ('admin', 'pro', 'staff') then raise exception 'insufficient_role'; end if;

  select * into v_program
    from public.programs
    where id = p_program_id and club_id = v_club_id;
  if not found then raise exception 'program_not_found'; end if;

  if v_role = 'pro' and v_program.created_by <> auth.uid() then
    raise exception 'insufficient_role';
  end if;

  -- Revalidate the program's definition on every call — event_type may
  -- have been deactivated, a rule may have had all its courts removed, or
  -- an assigned court may have been deactivated or moved out of the club
  -- since create_program ran.
  perform public._validate_program_definition(p_program_id, v_club_id, v_program.event_type_id);

  v_from    := greatest(coalesce(p_from_date, v_program.starts_on), v_program.starts_on);
  v_through := least(coalesce(p_through_date, v_program.ends_on), v_program.ends_on);

  if v_through < v_from then raise exception 'invalid_date_range'; end if;
  if (v_through - v_from) > 182 then raise exception 'range_too_long'; end if;

  select timezone into v_tz from public.clubs where id = v_club_id;

  -- Occurrence-level cap: rule x date pairs, not rule x date x court rows.
  select count(*) into v_count
  from public.program_schedule_rules psr
  cross join generate_series(v_from::timestamp, v_through::timestamp, interval '1 day') as d
  where psr.program_id = p_program_id
    and extract(dow from d)::int = psr.day_of_week;

  if v_count > 200 then raise exception 'too_many_occurrences'; end if;

  return query
    select
      psr.id                                                        as program_schedule_rule_id,
      d::date                                                       as occurrence_date,
      ((d::date + psr.start_time) at time zone v_tz)                as starts_at,
      ((d::date + psr.start_time) at time zone v_tz)
        + (psr.duration_minutes || ' minutes')::interval            as ends_at,
      prc.court_id,
      c.name                                                        as court_name,
      (existing.id is not null)                                     as already_generated,
      (existing.id is null and conflict.id is not null)             as has_conflict,
      conflict.id                                                   as conflicting_reservation_id,
      conflict.event_id                                             as conflicting_event_id,
      case when existing.id is null and conflict.id is not null
           then 'court_time_conflict' else null end                 as conflict_reason
    from public.program_schedule_rules psr
    cross join generate_series(v_from::timestamp, v_through::timestamp, interval '1 day') as d
    join public.program_rule_courts prc on prc.program_schedule_rule_id = psr.id
    join public.courts c on c.id = prc.court_id
    left join public.events existing
      on existing.program_schedule_rule_id = psr.id
     and existing.program_occurrence_date  = d::date
    left join public.reservations conflict
      on conflict.court_id = prc.court_id
     and conflict.status in ('pending', 'confirmed')
     and tstzrange(conflict.starts_at, conflict.ends_at, '[)')
         && tstzrange(
              (d::date + psr.start_time) at time zone v_tz,
              ((d::date + psr.start_time) at time zone v_tz) + (psr.duration_minutes || ' minutes')::interval,
              '[)'
            )
    where psr.program_id = p_program_id
      and extract(dow from d)::int = psr.day_of_week
    order by d, psr.start_time, c.display_order;
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- get_program_roster — allowlist widened admin+pro -> admin+pro+staff.
-- Pro-ownership guard untouched, cannot apply to Staff. Email visibility
-- widened admin-only -> admin+staff, matching Members-domain parity (see
-- migration header).
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_program_roster(p_program_id uuid)
 RETURNS TABLE(enrollment_id uuid, program_id uuid, profile_id uuid, roster_member_id uuid, first_name text, last_name text, email text, status text, waitlisted_at timestamp with time zone, offer_expires_at timestamp with time zone, created_at timestamp with time zone, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_club_id uuid;
  v_role    text;
  v_program public.programs%rowtype;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;
  if v_club_id is null then raise exception 'not_authenticated'; end if;

  if v_role not in ('admin', 'pro', 'staff') then
    raise exception 'insufficient_role';
  end if;

  select * into v_program
    from public.programs
    where id = p_program_id and club_id = v_club_id;
  if not found then raise exception 'program_not_found'; end if;

  if v_role = 'pro' and v_program.created_by <> auth.uid() then
    raise exception 'insufficient_role';
  end if;

  if v_program.enrollment_model <> 'program' then
    raise exception 'program_not_whole_enrollment';
  end if;

  return query
    select
      pe.id,
      pe.program_id,
      pe.profile_id,
      pe.roster_member_id,
      coalesce(p.first_name, rm.first_name),
      coalesce(p.last_name, rm.last_name),
      case when v_role in ('admin', 'staff') then u.email::text else null end,
      pe.status,
      pe.waitlisted_at,
      pe.offer_expires_at,
      pe.created_at,
      pe.updated_at
    from public.program_enrollments pe
    left join public.profiles p on p.id = pe.profile_id
    left join public.roster_members rm on rm.id = pe.roster_member_id
    left join auth.users u on u.id = pe.profile_id
    where pe.program_id = p_program_id
    order by
      case pe.status
        when 'enrolled'   then 1
        when 'offered'    then 2
        when 'waitlisted' then 3
        when 'cancelled'  then 4
      end,
      case when pe.status = 'waitlisted' then pe.waitlisted_at else pe.created_at end asc,
      pe.id asc;
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- get_program_eligible_members — allowlist widened admin+pro -> admin+
-- pro+staff. Pro-ownership guard untouched, cannot apply to Staff.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_program_eligible_members(p_program_id uuid)
 RETURNS TABLE(profile_id uuid, first_name text, last_name text, display_name text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_club_id uuid;
  v_role    text;
  v_program public.programs%rowtype;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;
  if v_club_id is null then raise exception 'not_authenticated'; end if;

  if v_role not in ('admin', 'pro', 'staff') then
    raise exception 'insufficient_role';
  end if;

  select * into v_program
    from public.programs
    where id = p_program_id and club_id = v_club_id;
  if not found then raise exception 'program_not_found'; end if;

  if v_role = 'pro' and v_program.created_by <> auth.uid() then
    raise exception 'insufficient_role';
  end if;

  if v_program.enrollment_model <> 'program' then
    raise exception 'program_not_whole_enrollment';
  end if;

  return query
    select
      cm.user_id,
      p.first_name,
      p.last_name,
      coalesce(nullif(trim(concat_ws(' ', p.first_name, p.last_name)), ''), 'Unknown')::text as display_name
    from public.club_memberships cm
    join public.profiles p on p.id = cm.user_id
    where cm.club_id    = v_club_id
      and cm.status     = 'active'
      and cm.removed_at is null
      and not exists (
        select 1 from public.program_enrollments pe
        where pe.program_id = p_program_id
          and pe.profile_id = cm.user_id
          and pe.status     in ('enrolled', 'offered', 'waitlisted')
      )
    order by p.last_name asc nulls last, p.first_name asc nulls last, cm.user_id asc;
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- get_program_eligible_roster_members — allowlist widened admin+pro ->
-- admin+pro+staff. Pro-ownership guard untouched, cannot apply to Staff.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_program_eligible_roster_members(p_program_id uuid)
 RETURNS TABLE(roster_member_id uuid, first_name text, last_name text, display_name text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_club_id uuid;
  v_role    text;
  v_program public.programs%rowtype;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;
  if v_club_id is null then raise exception 'not_authenticated'; end if;

  if v_role not in ('admin', 'pro', 'staff') then
    raise exception 'insufficient_role';
  end if;

  select * into v_program
    from public.programs
    where id = p_program_id and club_id = v_club_id;
  if not found then raise exception 'program_not_found'; end if;

  if v_role = 'pro' and v_program.created_by <> auth.uid() then
    raise exception 'insufficient_role';
  end if;

  if v_program.enrollment_model <> 'program' then
    raise exception 'program_not_whole_enrollment';
  end if;

  return query
    select
      rm.id,
      rm.first_name,
      rm.last_name,
      coalesce(nullif(trim(concat_ws(' ', rm.first_name, rm.last_name)), ''), 'Unknown')::text as display_name
    from public.roster_members rm
    where rm.club_id    = v_club_id
      and rm.claimed_by is null
      and rm.status      = 'active'
      and not exists (
        select 1 from public.program_enrollments pe
        where pe.program_id       = p_program_id
          and pe.roster_member_id = rm.id
          and pe.status           in ('enrolled', 'offered', 'waitlisted')
      )
    order by rm.last_name asc nulls last, rm.first_name asc nulls last, rm.id asc;
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- add_program_member — allowlist widened admin+pro -> admin+pro+staff.
-- Pro-ownership guard untouched, cannot apply to Staff.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.add_program_member(p_program_id uuid, p_profile_id uuid)
 RETURNS program_enrollments
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_club_id       uuid;
  v_role          text;
  v_program       public.programs%rowtype;
  v_target_status text;
  v_roster_member_id uuid;
  v_existing      public.program_enrollments%rowtype;
  v_existing_found boolean;
  v_count         int;
  v_new_status    text;
  v_result        public.program_enrollments%rowtype;
  v_no_op         boolean := false;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;
  if v_club_id is null then raise exception 'not_authenticated'; end if;

  if v_role not in ('admin', 'pro', 'staff') then
    raise exception 'insufficient_role';
  end if;

  select * into v_program
    from public.programs
    where id = p_program_id and club_id = v_club_id
    for update;
  if not found then raise exception 'program_not_found'; end if;

  if v_role = 'pro' and v_program.created_by <> auth.uid() then
    raise exception 'insufficient_role';
  end if;

  if v_program.enrollment_model <> 'program' then
    raise exception 'program_not_whole_enrollment';
  end if;

  if not public._program_is_enrollable(v_program) then
    raise exception 'program_not_enrollable';
  end if;

  -- Target membership: club_memberships is the sole source of truth here
  -- (unchanged from the pre-0115 body).
  select status into v_target_status
    from public.club_memberships
    where user_id    = p_profile_id
      and club_id    = v_club_id
      and removed_at is null;
  if not found then raise exception 'target_member_not_found'; end if;
  if v_target_status <> 'active' then raise exception 'target_member_inactive'; end if;

  -- Phase 33D2b: resolve the target's durable roster identity, fail
  -- closed — every account holder resolves one by construction (33B1
  -- backfill guarantee), matching admin_add_member's identical guard.
  select id into v_roster_member_id
    from public.roster_members
   where club_id    = v_club_id
     and claimed_by = p_profile_id;
  if not found then
    raise exception 'phase33d2_unresolved_member_identity';
  end if;

  -- Read the target's existing row FIRST, before any other side effect —
  -- required ordering, unchanged from the pre-0115 body. Phase 33D2b
  -- hotfix-in-advance: FOR UPDATE + immediate FOUND capture. Matched via
  -- profile_id OR roster_member_id, so a prior no-account enrollment for
  -- this same target (now claimed) is correctly recognized as the same
  -- durable enrollment.
  select * into v_existing
    from public.program_enrollments
    where program_id = p_program_id
      and (profile_id = p_profile_id or roster_member_id = v_roster_member_id)
    for update;
  v_existing_found := found;

  if v_existing_found and v_existing.status = 'enrolled' then
    -- Idempotent fast path — no expire/advance run, matching join_program's
    -- own identical fast path exactly.
    v_result := v_existing;
    v_no_op  := true;
  elsif v_existing_found and v_existing.status in ('waitlisted', 'offered') then
    -- Returned exactly unchanged — no expire/advance call is made in this
    -- branch (unchanged from the pre-0115 body's own documented rule).
    v_result := v_existing;
    v_no_op  := true;
  else
    perform public._expire_stale_program_offers(p_program_id, v_club_id, v_program.title);
    perform public._advance_program_waitlist_offer(p_program_id, v_club_id, v_program.title);

    select count(*) into v_count
      from public.program_enrollments
      where program_id = p_program_id
        and status     in ('enrolled', 'offered');

    if v_count >= v_program.default_capacity or exists (
      select 1 from public.program_enrollments
      where program_id = p_program_id and status = 'waitlisted'
    ) then
      v_new_status := 'waitlisted';
    else
      v_new_status := 'enrolled';
    end if;

    if v_existing_found then
      update public.program_enrollments
         set status           = v_new_status,
             profile_id       = p_profile_id,
             roster_member_id = v_roster_member_id,
             offer_expires_at = null,
             waitlisted_at    = case when v_new_status = 'waitlisted' then now() else null end,
             updated_at       = now()
       where id = v_existing.id
      returning * into v_result;
    else
      insert into public.program_enrollments (program_id, profile_id, roster_member_id, status, waitlisted_at)
      values (
        p_program_id, p_profile_id, v_roster_member_id, v_new_status,
        case when v_new_status = 'waitlisted' then now() else null end
      )
      returning * into v_result;
    end if;

    if v_result.id is null then
      raise exception 'program_enrollment_write_failed';
    end if;
  end if;

  if v_result.status = 'enrolled' then
    perform public._materialize_program_member_into_future_events(p_program_id, v_roster_member_id, v_club_id);
  end if;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'add_program_member', 'program', p_program_id,
    jsonb_build_object(
      'target_profile_id', p_profile_id,
      'roster_member_id',  v_roster_member_id,
      'final_status',      v_result.status,
      'no_op',             v_no_op,
      'actor_role',        v_role
    )
  );

  return v_result;
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- add_program_roster_member — allowlist widened admin+pro -> admin+pro+
-- staff. Pro-ownership guard untouched, cannot apply to Staff.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.add_program_roster_member(p_program_id uuid, p_expected_club_id uuid, p_roster_member_id uuid)
 RETURNS program_enrollments
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_club_id    uuid;
  v_role       text;
  v_program    public.programs%rowtype;
  v_roster     public.roster_members%rowtype;
  v_existing   public.program_enrollments%rowtype;
  v_existing_found boolean;
  v_count      int;
  v_new_status text;
  v_result     public.program_enrollments%rowtype;
  v_no_op      boolean := false;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;
  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
  if v_role not in ('admin', 'pro', 'staff') then raise exception 'insufficient_role'; end if;

  select * into v_program
    from public.programs
    where id = p_program_id and club_id = v_club_id
    for update;
  if not found then raise exception 'program_not_found'; end if;

  if v_role = 'pro' and v_program.created_by <> auth.uid() then
    raise exception 'insufficient_role';
  end if;

  if v_program.enrollment_model <> 'program' then
    raise exception 'program_not_whole_enrollment';
  end if;

  if not public._program_is_enrollable(v_program) then
    raise exception 'program_not_enrollable';
  end if;

  select * into v_roster
    from public.roster_members
   where id      = p_roster_member_id
     and club_id = v_club_id;
  if not found then raise exception 'roster_member_not_found'; end if;

  select * into v_existing
    from public.program_enrollments
    where program_id = p_program_id
      and (
        roster_member_id = p_roster_member_id
        or (v_roster.claimed_by is not null and profile_id = v_roster.claimed_by)
      )
    for update;
  v_existing_found := found;

  if v_existing_found and v_existing.status = 'enrolled' then
    v_result := v_existing;
    v_no_op  := true;
  elsif v_existing_found and v_existing.status in ('waitlisted', 'offered') then
    v_result := v_existing;
    v_no_op  := true;
  else
    perform public._expire_stale_program_offers(p_program_id, v_club_id, v_program.title);
    perform public._advance_program_waitlist_offer(p_program_id, v_club_id, v_program.title);

    select count(*) into v_count
      from public.program_enrollments
      where program_id = p_program_id
        and status     in ('enrolled', 'offered');

    if v_count >= v_program.default_capacity or exists (
      select 1 from public.program_enrollments
      where program_id = p_program_id and status = 'waitlisted'
    ) then
      v_new_status := 'waitlisted';
    elsif not public._program_candidate_fits_future_sessions(p_program_id, p_roster_member_id) then
      v_new_status := 'waitlisted';
    else
      v_new_status := 'enrolled';
    end if;

    if v_existing_found then
      update public.program_enrollments
         set status           = v_new_status,
             profile_id       = v_roster.claimed_by,
             roster_member_id = p_roster_member_id,
             offer_expires_at = null,
             waitlisted_at    = case when v_new_status = 'waitlisted' then now() else null end,
             updated_at       = now()
       where id = v_existing.id
      returning * into v_result;
    else
      insert into public.program_enrollments (program_id, profile_id, roster_member_id, status, waitlisted_at)
      values (
        p_program_id, v_roster.claimed_by, p_roster_member_id, v_new_status,
        case when v_new_status = 'waitlisted' then now() else null end
      )
      returning * into v_result;
    end if;

    if v_result.id is null then
      raise exception 'program_enrollment_write_failed';
    end if;
  end if;

  if v_result.status = 'enrolled' then
    perform public._materialize_program_member_into_future_events(p_program_id, p_roster_member_id, v_club_id);
  end if;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'add_program_roster_member', 'program', p_program_id,
    jsonb_build_object(
      'roster_member_id', p_roster_member_id,
      'member_id',        v_roster.claimed_by,
      'member_claimed',   v_roster.claimed_by is not null,
      'final_status',     v_result.status,
      'no_op',             v_no_op,
      'actor_role',        v_role
    )
  );

  return v_result;
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- remove_program_member — allowlist widened admin+pro -> admin+pro+staff.
-- Pro-ownership guard untouched, cannot apply to Staff.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.remove_program_member(p_program_id uuid, p_profile_id uuid)
 RETURNS program_enrollments
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_club_id uuid;
  v_role    text;
  v_program public.programs%rowtype;
  v_roster_member_id uuid;
  v_old     public.program_enrollments%rowtype;
  v_result  public.program_enrollments%rowtype;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;
  if v_club_id is null then raise exception 'not_authenticated'; end if;

  if v_role not in ('admin', 'pro', 'staff') then
    raise exception 'insufficient_role';
  end if;

  select * into v_program
    from public.programs
    where id = p_program_id and club_id = v_club_id
    for update;
  if not found then raise exception 'program_not_found'; end if;

  if v_role = 'pro' and v_program.created_by <> auth.uid() then
    raise exception 'insufficient_role';
  end if;

  if v_program.enrollment_model <> 'program' then
    raise exception 'program_not_whole_enrollment';
  end if;

  -- Phase 33D2b: resolve the target's roster identity for matching below.
  -- Deliberately NOT fail-closed here — unchanged from the pre-0115 body's
  -- own precedent of placing no membership-eligibility gate on removal
  -- (0092 header): a target whose account/roster identity has since
  -- become unresolvable for any reason must still be removable from a
  -- program roster they are still enrolled in.
  select id into v_roster_member_id
    from public.roster_members
   where club_id    = v_club_id
     and claimed_by = p_profile_id;

  select * into v_old
    from public.program_enrollments
    where program_id = p_program_id
      and (
        profile_id = p_profile_id
        or (v_roster_member_id is not null and roster_member_id = v_roster_member_id)
      )
      and status in ('enrolled', 'waitlisted', 'offered');
  if not found then raise exception 'enrollment_not_found'; end if;

  update public.program_enrollments
    set status           = 'cancelled',
        offer_expires_at = null,
        waitlisted_at    = null,
        updated_at       = now()
    where id = v_old.id
  returning * into v_result;

  if v_old.status = 'enrolled' then
    -- Phase 33D2b: propagate by the row's own durable roster_member_id
    -- (guaranteed NOT NULL), not the separately-resolved variable above —
    -- strictly more correct/durable.
    perform public._cancel_program_member_future_participation(p_program_id, v_old.roster_member_id, v_club_id);
  end if;

  if v_old.status in ('enrolled', 'offered') then
    perform public._expire_stale_program_offers(p_program_id, v_club_id, v_program.title);
    perform public._advance_program_waitlist_offer(p_program_id, v_club_id, v_program.title);
  end if;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'remove_program_member', 'program', p_program_id,
    jsonb_build_object(
      'target_profile_id', p_profile_id,
      'previous_status',   v_old.status,
      'actor_role',        v_role
    )
  );

  return v_result;
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- remove_program_roster_member — allowlist widened admin+pro -> admin+
-- pro+staff. Pro-ownership guard untouched, cannot apply to Staff.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.remove_program_roster_member(p_program_id uuid, p_expected_club_id uuid, p_roster_member_id uuid)
 RETURNS program_enrollments
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_club_id uuid;
  v_role    text;
  v_program public.programs%rowtype;
  v_old     public.program_enrollments%rowtype;
  v_result  public.program_enrollments%rowtype;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;
  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
  if v_role not in ('admin', 'pro', 'staff') then raise exception 'insufficient_role'; end if;

  select * into v_program
    from public.programs
    where id = p_program_id and club_id = v_club_id
    for update;
  if not found then raise exception 'program_not_found'; end if;

  if v_role = 'pro' and v_program.created_by <> auth.uid() then
    raise exception 'insufficient_role';
  end if;

  if v_program.enrollment_model <> 'program' then
    raise exception 'program_not_whole_enrollment';
  end if;

  select * into v_old
    from public.program_enrollments
    where program_id       = p_program_id
      and roster_member_id = p_roster_member_id
      and status            in ('enrolled', 'waitlisted', 'offered');
  if not found then raise exception 'enrollment_not_found'; end if;

  update public.program_enrollments
    set status           = 'cancelled',
        offer_expires_at = null,
        waitlisted_at    = null,
        updated_at       = now()
    where id = v_old.id
  returning * into v_result;

  if v_old.status = 'enrolled' then
    perform public._cancel_program_member_future_participation(p_program_id, p_roster_member_id, v_club_id);
  end if;

  if v_old.status in ('enrolled', 'offered') then
    perform public._expire_stale_program_offers(p_program_id, v_club_id, v_program.title);
    perform public._advance_program_waitlist_offer(p_program_id, v_club_id, v_program.title);
  end if;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_club_id, auth.uid(), 'remove_program_roster_member', 'program', p_program_id,
    jsonb_build_object(
      'roster_member_id', p_roster_member_id,
      'previous_status',  v_old.status,
      'actor_role',       v_role
    )
  );

  return v_result;
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- force_confirm_program_roster_member — allowlist widened admin+pro ->
-- admin+pro+staff. Pro-ownership guard untouched, cannot apply to Staff.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.force_confirm_program_roster_member(p_program_id uuid, p_expected_club_id uuid, p_roster_member_id uuid)
 RETURNS program_enrollments
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_club_id      uuid;
  v_role         text;
  v_program      public.programs%rowtype;
  v_old          public.program_enrollments%rowtype;
  v_result       public.program_enrollments%rowtype;
  v_occupied     int;
  v_was_over_cap boolean;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;
  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;
  if v_role not in ('admin', 'pro', 'staff') then raise exception 'insufficient_role'; end if;

  select * into v_program from public.programs where id = p_program_id and club_id = v_club_id for update;
  if not found then raise exception 'program_not_found'; end if;
  if v_role = 'pro' and v_program.created_by <> auth.uid() then raise exception 'insufficient_role'; end if;
  if v_program.enrollment_model <> 'program' then raise exception 'program_not_whole_enrollment'; end if;

  select * into v_old from public.program_enrollments
    where program_id = p_program_id and roster_member_id = p_roster_member_id
      and status in ('waitlisted', 'offered');
  if not found then raise exception 'enrollment_not_found'; end if;

  select count(*) into v_occupied from public.program_enrollments
    where program_id = p_program_id and status in ('enrolled', 'offered');
  v_was_over_cap := v_occupied >= v_program.default_capacity;

  perform set_config('courttime.skip_capacity_guard', 'true', true);

  update public.program_enrollments
     set status = 'enrolled', offer_expires_at = null, waitlisted_at = null, updated_at = now()
   where id = v_old.id
  returning * into v_result;
  if v_result.id is null then raise exception 'program_enrollment_write_failed'; end if;

  perform public._materialize_program_member_into_future_events(p_program_id, p_roster_member_id, v_club_id);

  perform set_config('courttime.skip_capacity_guard', 'false', true);

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (v_club_id, auth.uid(), 'force_confirm_program_roster_member', 'program', p_program_id,
    jsonb_build_object('roster_member_id', p_roster_member_id, 'previous_status', v_old.status,
      'was_over_capacity', v_was_over_cap));

  return v_result;
end;
$function$;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration created in
-- this checkpoint)
-- ═══════════════════════════════════════════════════════════════════════════
-- Restore each function by re-querying its live Production definition
-- (pg_get_functiondef) immediately before rolling back — this migration's
-- own bodies were sourced the same way. No RLS policy and no table is
-- touched by this migration — nothing else requires rollback.
