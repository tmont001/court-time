-- 0090_draft_program_updates.sql
-- Phase 27C.1: Draft Program Editing and Conflict Recovery.
--
-- Adds one new SECURITY DEFINER RPC, update_program, that lets an Admin or
-- the owning Pro edit a program's definition (basics + schedule rules +
-- court assignments) while it is still a draft with no generated sessions
-- — the scenario this exists for is an admin previewing a new program,
-- discovering a court conflict, and needing to fix the offending rule
-- without recreating the whole program from scratch.
--
-- Locked architecture (unchanged, not repeated here beyond this pointer):
-- generated occurrences are events rows; no program_sessions table or
-- parallel participant/guest/roster/attendance/waitlist/reservation/
-- notification table exists or is added here. This checkpoint adds no
-- table, touches no existing table's columns, and does not modify
-- create_program, preview_program_sessions, generate_program_sessions, or
-- _validate_program_definition (0088/0089, both already applied and
-- immutable) — update_program is a new, independent function.
--
-- update_program validation is a byte-for-byte copy of create_program's
-- validation contract (0089): title, enrollment_model, date range (<=182
-- days), capacity, active same-club event_type, per-rule field validation
-- with guarded JSON parsing (no raw Postgres cast errors reach the
-- caller), capacity_override positivity + its exclusivity against
-- enrollment_model='program', per-rule court validation (active, same
-- club, no in-rule duplicates), cross-rule exact-duplicate rejection
-- (duplicate_rule), and cross-rule overlapping-same-court rejection
-- (overlapping_program_rules). See create_program's own comments in 0089
-- for the rationale behind each of these — reproduced here, not
-- reinvented.
--
-- Editable-state gate (new to this checkpoint): the target program must be
-- club-scoped, not archived, have zero events rows referencing it, and
-- have status = 'draft' — checked in that exact order, as three separate
-- guards rather than one combined condition, so each rejection reports the
-- most specific applicable code:
--   1. archived_at is not null            -> program_not_editable
--      (archived always wins, regardless of status or generated events)
--   2. any events row references it       -> program_already_generated
--      (checked before the plain status check so a normally generated/
--      active program — which always has events — reports the more
--      specific "already generated" rather than the generic "not
--      editable"; also independently catches an anomalous draft that
--      somehow already has events)
--   3. status <> 'draft'                  -> program_not_editable
--      (reached only for a non-archived, event-free, non-draft program —
--      e.g. cancelled/completed with nothing generated)
--
-- Atomicity: validation runs to completion — full pass 1 over every rule,
-- then the cross-rule duplicate/overlap checks — before any write
-- statement executes, identical to create_program's own two-pass
-- structure. The actual replacement (UPDATE programs, DELETE the old
-- program_schedule_rules — which cascades to program_rule_courts via
-- 0087's ON DELETE CASCADE — then INSERT the new rules/courts) only
-- begins once every check has passed. Since this entire function body is
-- one implicit transaction and validation front-loads every failure mode,
-- a rejected call never reaches the DELETE at all, and any unexpected
-- failure during the write sequence itself rolls back everything already
-- executed in this call — the previous definition is left completely
-- intact either way. programs.created_by is never included in the UPDATE
-- SET list, so ownership is preserved regardless of who edits the draft.
--
-- See supabase/scripts/verify_phase27c1.sql for the full read-only
-- verification pass, and supabase/scripts/QA_phase27c1.md for manual QA
-- steps.
--
-- Apply in Supabase SQL Editor (cloud only). Not applied by this checkpoint.

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- update_program
-- ═══════════════════════════════════════════════════════════════════════════
-- p_rules shape — identical to create_program (0088/0089):
--   [{
--     "day_of_week":       0-6,
--     "start_time":        "HH:MM" (or "HH:MM:SS"),
--     "duration_minutes":  positive int,
--     "capacity_override": positive int or null/omitted,
--     "court_ids":         ["<uuid>", ...]  -- at least one, no duplicates
--   }, ...]
--
-- Error codes: not_authenticated, insufficient_role, program_not_found,
-- program_not_editable, program_already_generated, invalid_title,
-- invalid_enrollment_model, invalid_date_range, range_too_long,
-- invalid_capacity, event_type_not_found, invalid_rules_payload,
-- invalid_day_of_week, invalid_start_time, invalid_duration,
-- invalid_capacity_override, capacity_override_not_allowed_for_program_enrollment,
-- rule_requires_court, duplicate_court_in_rule, court_not_found,
-- duplicate_rule, overlapping_program_rules.

create or replace function public.update_program(
  p_program_id        uuid,
  p_event_type_id     uuid,
  p_title             text,
  p_enrollment_model  text,
  p_starts_on         date,
  p_ends_on           date,
  p_default_capacity  int,
  p_rules             jsonb,
  p_description       text default null
)
returns public.programs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
  if v_role not in ('admin', 'pro') then raise exception 'insufficient_role'; end if;

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
$$;

revoke execute on function public.update_program(uuid, uuid, text, text, date, date, int, jsonb, text) from public, anon;
grant  execute on function public.update_program(uuid, uuid, text, text, date, date, int, jsonb, text) to authenticated;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ═══════════════════════════════════════════════════════════════════════════
-- Safe to roll back at any point before this checkpoint's UI (CreateProgramSheet
-- edit mode / ProgramPreviewSheet's Edit Draft button) is exercised in
-- production. update_program is a brand-new function with no other object
-- depending on it — dropping it does not affect create_program,
-- preview_program_sessions, generate_program_sessions, or any existing
-- program/rule/court/event/reservation row.
--
--   drop function if exists public.update_program(uuid, uuid, text, text, date, date, int, jsonb, text);
--
-- This does not undo any program/rule/court row already edited by
-- update_program while it existed — those are ordinary data rows, not
-- schema, and are unaffected by dropping the function.
