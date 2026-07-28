-- 0089_program_generation_hardening.sql
-- Phase 27B2 (corrective): ownership, overlap, revalidation, and JSON
-- hardening for the three Phase 27B2 RPCs shipped in 0088
-- (0088_program_definition_and_generation_rpcs.sql), which is already
-- applied to Supabase and immutable — this migration only CREATE OR
-- REPLACEs the same three function bodies under their exact existing
-- signatures. No application-facing argument or return contract changes.
--
-- Wrapped in one atomic transaction: if any statement below fails, nothing
-- in this migration is applied — 0088's function bodies remain exactly as
-- they were.
--
-- Four corrections, each independently motivated by a gap found in 0088's
-- functions:
--
--   1. Ownership preservation — generate_program_sessions previously
--      stamped events.created_by / reservations.owner_user_id /
--      reservations.created_by with auth.uid() (the invoking actor). When
--      an Admin generates a Pro-owned program, this silently reassigned
--      ownership of every generated event away from the Pro who defined
--      the program, breaking that Pro's existing created_by-based
--      management rights on cancel_event/archive_event/
--      set_event_member_joinable. Generation is now treated as the program
--      owner's own act of creating those event holds: events.created_by,
--      reservations.owner_user_id, and reservations.created_by are all
--      v_program.created_by. audit_log.actor_id remains auth.uid() (the
--      real invoking session), with program_owner_id/generated_by_id both
--      recorded in metadata so the distinction is never lost.
--
--   2. Overlapping-rule rejection — 0088's create_program only rejected
--      EXACT (day_of_week, start_time) duplicates (which the 0087 unique
--      constraint program_schedule_rules_program_day_start_unique already
--      enforces regardless of court). It did not reject two rules with
--      DIFFERENT start times whose windows still overlap on a shared
--      court (e.g. 09:00-10:30 and 10:00-11:00 on the same court) — such a
--      program would pass create_program successfully and then only fail,
--      confusingly, the first time generate_program_sessions hit the raw
--      reservations GiST exclude constraint. create_program now rejects
--      this case up front with a named error. generate_program_sessions
--      independently re-derives the same overlap check across its own new
--      candidate batch (defense in depth against programs whose rules
--      predate this migration, or any other path that could produce
--      overlapping rows) before issuing any INSERT.
--
--   3. Stale-definition revalidation — 0088's preview/generate trusted the
--      program/rule/court definition captured at create_program time
--      forever after. If an admin later deactivated the event_type, or
--      deactivated (or otherwise stopped assigning) a court a rule
--      depends on, preview/generate would silently keep previewing/
--      generating against a now-invalid definition — for a deactivated
--      event_type, the events_check_event_type_active trigger (0065)
--      would eventually catch it at INSERT time with an unrelated-looking
--      'inactive_event_type' error; for a court dropped to zero
--      assignments or deactivated, nothing would catch it at all (a
--      court_count = 0 event could be generated). Both functions now call
--      a new private helper, _validate_program_definition, immediately
--      after loading the program and confirming ownership.
--
--   4. Malformed JSON hardening — 0088's create_program cast jsonb fields
--      directly (e.g. (elem->>'day_of_week')::int) with no guard, so a
--      malformed payload surfaced as a raw Postgres cast error
--      (SQLSTATE 22P02 invalid_text_representation, or 22003
--      numeric_value_out_of_range) instead of one of the function's own
--      documented error codes. Every jsonb-derived scalar is now parsed
--      inside a narrow BEGIN/EXCEPTION block that re-raises the matching
--      documented code — no WHEN OTHERS is used anywhere, so an unrelated
--      database error (constraint violation, connection issue, etc.) still
--      propagates unmodified. day_of_week/duration_minutes additionally
--      check key presence explicitly (`v_rule ? '<key>'`) before checking
--      jsonb_typeof: a MISSING key makes `v_rule->'<key>'` evaluate to SQL
--      NULL, and `jsonb_typeof(NULL) <> 'number'` evaluates to NULL (not
--      TRUE) in three-valued logic, so a typeof-only check silently passed
--      a missing key straight through to the NOT NULL column constraint on
--      program_schedule_rules instead of this function's own named error.
--      start_time's guard additionally catches invalid_datetime_format and
--      datetime_field_overflow alongside invalid_text_representation, since
--      an out-of-range time literal (e.g. "25:99") can surface as any of
--      the three depending on exactly how it is malformed.
--
-- See supabase/scripts/verify_phase27b2.sql (updated by this checkpoint)
-- for the full read-only verification pass, and
-- supabase/scripts/QA_phase27b2.md (also updated) for manual QA steps.
--
-- Apply in Supabase SQL Editor (cloud only). Not applied by this checkpoint.

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 0. _validate_program_definition — new private helper
-- ═══════════════════════════════════════════════════════════════════════════
-- Not part of the three public RPC signatures named in this checkpoint's
-- contract — a new internal function, following the existing repo
-- convention for underscore-prefixed private helpers callable only from
-- other SECURITY DEFINER functions (see _current_user_active_membership,
-- 0082; _lesson_check_operating_hours et al., 0069). Revoked from
-- PUBLIC/anon/authenticated entirely: a SECURITY DEFINER caller executes
-- under its owner's privileges for the duration of the call, so this
-- revoke does not block preview_program_sessions/generate_program_sessions
-- from calling it — it only blocks a direct client RPC call, exactly like
-- check_event_type_active (0065) blocks direct invocation while still
-- firing correctly as an internal trigger.
--
-- Raises event_type_not_found if the program's event_type is no longer
-- active in the program's club, rule_requires_court if any schedule rule
-- under the program has zero court assignments, or court_not_found if any
-- assigned court no longer belongs to the program's club or is no longer
-- active. Returns void (no rows) on success.

create or replace function public._validate_program_definition(
  p_program_id    uuid,
  p_club_id       uuid,
  p_event_type_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from public.event_types
    where id = p_event_type_id and club_id = p_club_id and is_active = true
  ) then
    raise exception 'event_type_not_found';
  end if;

  if exists (
    select 1
    from public.program_schedule_rules psr
    where psr.program_id = p_program_id
      and not exists (
        select 1 from public.program_rule_courts prc
        where prc.program_schedule_rule_id = psr.id
      )
  ) then
    raise exception 'rule_requires_court';
  end if;

  if exists (
    select 1
    from public.program_rule_courts prc
    join public.program_schedule_rules psr on psr.id = prc.program_schedule_rule_id
    join public.courts c on c.id = prc.court_id
    where psr.program_id = p_program_id
      and (c.club_id <> p_club_id or c.is_active = false)
  ) then
    raise exception 'court_not_found';
  end if;
end;
$$;

revoke execute on function public._validate_program_definition(uuid, uuid, uuid) from public, anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 1. create_program — hardened
-- ═══════════════════════════════════════════════════════════════════════════
-- Same signature as 0088. Adds: guarded (exception-safe) JSON field
-- parsing throughout pass 1, and a new overlapping-rule check
-- (overlapping_program_rules) after the existing duplicate_rule check.
-- Every other check from 0088 (title, enrollment_model, date range,
-- capacity, event_type, per-rule field/court validation, court club/active
-- membership, duplicate court within a rule, duplicate exact
-- day_of_week+start_time across rules, insert, audit log) is preserved
-- unchanged in substance.
--
-- p_rules shape — unchanged from 0088:
--   [{
--     "day_of_week":       0-6,
--     "start_time":        "HH:MM" (or "HH:MM:SS"),
--     "duration_minutes":  positive int,
--     "capacity_override": positive int or null/omitted,
--     "court_ids":         ["<uuid>", ...]  -- at least one, no duplicates
--   }, ...]
--
-- Error codes: not_authenticated, insufficient_role, invalid_title,
-- invalid_enrollment_model, invalid_date_range, range_too_long,
-- invalid_capacity, event_type_not_found, invalid_rules_payload,
-- invalid_day_of_week, invalid_start_time, invalid_duration,
-- invalid_capacity_override, capacity_override_not_allowed_for_program_enrollment,
-- rule_requires_court, duplicate_court_in_rule, court_not_found,
-- duplicate_rule, overlapping_program_rules (new).

create or replace function public.create_program(
  p_event_type_id    uuid,
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
  if v_role not in ('admin', 'pro') then raise exception 'insufficient_role'; end if;

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
$$;

revoke execute on function public.create_program(uuid, text, text, date, date, int, jsonb, text) from public, anon;
grant  execute on function public.create_program(uuid, text, text, date, date, int, jsonb, text) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. preview_program_sessions — hardened
-- ═══════════════════════════════════════════════════════════════════════════
-- Same signature and return shape as 0088. Adds one call to
-- _validate_program_definition immediately after the program lookup and
-- ownership check, before any date-range/candidate computation. All other
-- logic (range clamping, 26-week/200-occurrence ceilings, already_generated/
-- has_conflict computation) is preserved unchanged from 0088.
--
-- Error codes: not_authenticated, insufficient_role, program_not_found,
-- event_type_not_found, rule_requires_court, court_not_found (new — via
-- _validate_program_definition), invalid_date_range, range_too_long,
-- too_many_occurrences.

create or replace function public.preview_program_sessions(
  p_program_id    uuid,
  p_from_date     date default null,
  p_through_date  date default null
)
returns table (
  program_schedule_rule_id    uuid,
  occurrence_date              date,
  starts_at                    timestamptz,
  ends_at                      timestamptz,
  court_id                     uuid,
  court_name                   text,
  already_generated            boolean,
  has_conflict                 boolean,
  conflicting_reservation_id   uuid,
  conflicting_event_id         uuid,
  conflict_reason              text
)
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
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
  if v_role not in ('admin', 'pro') then raise exception 'insufficient_role'; end if;

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
$$;

revoke execute on function public.preview_program_sessions(uuid, date, date) from public, anon;
grant  execute on function public.preview_program_sessions(uuid, date, date) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. generate_program_sessions — hardened
-- ═══════════════════════════════════════════════════════════════════════════
-- Same signature and return shape as 0088. Changes from 0088:
--   • Calls _validate_program_definition after the program lookup and
--     ownership check, same as preview.
--   • events.created_by / reservations.owner_user_id /
--     reservations.created_by are now v_program.created_by (the program
--     owner), not auth.uid() (the invoking actor) — see the migration
--     header for the full rationale. audit_log.actor_id remains auth.uid();
--     metadata now carries both program_owner_id and generated_by_id.
--   • The new-candidate set is now materialized once into a session-local
--     temporary table (dropped at the end of this call's transaction via
--     ON COMMIT DROP) rather than repeated inline across five separate
--     queries as in 0088 — the added batch self-conflict check below
--     brought the number of reuses of the same candidate set to five,
--     past the point where copy-pasting the same 10-line query five times
--     is a safe way to guarantee they stay identical. This is a pure
--     internal refactor; the candidate SET and its filtering logic
--     (rule.day_of_week matches the date, not already generated) are
--     unchanged from 0088.
--   • A new batch self-conflict check runs BEFORE the existing
--     pre-existing-reservation conflict check: two different NEW
--     candidates in this same call that would land on the same court and
--     occurrence_date with overlapping time windows (possible for a
--     program whose rules predate 0089's create_program overlap guard)
--     now raise 'court_conflict' with descriptive detail, instead of
--     surfacing as a raw GiST exclude-constraint violation mid-insert.
--     The exclude constraint remains the authoritative backstop for any
--     same-transaction race neither check can see.
--
-- Error codes: not_authenticated, insufficient_role, program_not_found,
-- event_type_not_found, rule_requires_court, court_not_found (new — via
-- _validate_program_definition), program_archived, program_not_generatable,
-- invalid_date_range, range_too_long, too_many_occurrences, court_conflict.

create or replace function public.generate_program_sessions(
  p_program_id    uuid,
  p_from_date     date default null,
  p_through_date  date default null
)
returns table (
  inserted_count int,
  skipped_count  int,
  event_ids      uuid[]
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
  if v_role not in ('admin', 'pro') then raise exception 'insufficient_role'; end if;

  select * into v_program
    from public.programs
    where id = p_program_id and club_id = v_club_id;
  if not found then raise exception 'program_not_found'; end if;

  if v_role = 'pro' and v_program.created_by <> auth.uid() then
    raise exception 'insufficient_role';
  end if;

  if v_program.archived_at is not null then raise exception 'program_archived'; end if;
  if v_program.status not in ('draft', 'active') then raise exception 'program_not_generatable'; end if;

  -- Revalidate the program's definition on every call — see
  -- _validate_program_definition and the migration header for why.
  perform public._validate_program_definition(p_program_id, v_club_id, v_program.event_type_id);

  v_from    := greatest(coalesce(p_from_date, v_program.starts_on), v_program.starts_on);
  v_through := least(coalesce(p_through_date, v_program.ends_on), v_program.ends_on);

  if v_through < v_from then raise exception 'invalid_date_range'; end if;
  if (v_through - v_from) > 182 then raise exception 'range_too_long'; end if;

  select timezone into v_tz from public.clubs where id = v_club_id;

  -- Total possible (rule, date) slots in range, regardless of already
  -- generated — used only for the skipped_count arithmetic below.
  select count(*) into v_total_count
  from public.program_schedule_rules psr
  cross join generate_series(v_from::timestamp, v_through::timestamp, interval '1 day') as d
  where psr.program_id = p_program_id
    and extract(dow from d)::int = psr.day_of_week;

  -- Materialize the NEW (not yet generated) candidate set once. Session-
  -- local, dropped automatically when this call's transaction ends. The
  -- defensive DROP IF EXISTS guards the (not expected under normal
  -- PostgREST one-request-one-transaction usage) case of this function
  -- being invoked a second time within an already-open outer transaction.
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

  -- Batch self-conflict: two different NEW candidates in this same call
  -- that would land on the same court + occurrence_date with overlapping
  -- time windows. Possible for a program whose rules predate 0089's
  -- create_program overlap guard. Fails the whole call before any INSERT.
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

  -- Pre-flight conflict check against existing pending/confirmed
  -- reservations — same overlap semantics as the reservations table's own
  -- GiST exclude constraint (0003). Fails the whole call before any INSERT
  -- if anything conflicts.
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

  -- All clear — one events row per new (rule, date), one reservations row
  -- per assigned court. Same insert shape as create_event (0062): same
  -- events columns, same reservations columns/reason/event linkage, no
  -- operating-hours check (create_event has none), no host participant row
  -- (removed from create_event in 0058). No program_enrollments row is
  -- read or written here — enrollment/materialization is Phase 27C.
  --
  -- Ownership: events.created_by, reservations.owner_user_id, and
  -- reservations.created_by are all v_program.created_by (the program
  -- owner), not auth.uid() — generation is the owner's own act regardless
  -- of who actually invoked it. auth.uid() is recorded only in
  -- audit_log.actor_id / metadata.generated_by_id below.
  for v_rec in
    select distinct rule_id, occurrence_date, start_time, duration_minutes, capacity_override
    from pg27b2_candidates
    order by occurrence_date, start_time
  loop
    v_starts_at := (v_rec.occurrence_date + v_rec.start_time) at time zone v_tz;
    v_ends_at   := v_starts_at + (v_rec.duration_minutes || ' minutes')::interval;
    v_capacity  := coalesce(v_rec.capacity_override, v_program.default_capacity);

    select count(*) into v_court_count
      from public.program_rule_courts
      where program_schedule_rule_id = v_rec.rule_id;

    -- member_joinable: true only for per_session; false for program
    -- (whole-series enrollment, no per-session self-join) and admin_managed
    -- (roster is admin-only).
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

    v_inserted_ids   := v_inserted_ids || v_new_event.id;
    v_inserted_count := v_inserted_count + 1;
  end loop;

  -- A successful generation transitions a draft program to active. Already-
  -- active programs are left alone; there is no other status this function
  -- can reach at this point (program_archived/program_not_generatable
  -- already rejected everything else above).
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
$$;

revoke execute on function public.generate_program_sessions(uuid, date, date) from public, anon;
grant  execute on function public.generate_program_sessions(uuid, date, date) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ═══════════════════════════════════════════════════════════════════════════
-- 0088 is already applied to production and immutable — dropping these
-- functions is NOT an acceptable rollback (it would remove
-- create_program/preview_program_sessions/generate_program_sessions
-- entirely, breaking anything already depending on them existing). The
-- only acceptable rollback is to CREATE OR REPLACE each of the three
-- public functions back to its exact 0088 body, and to drop the new
-- private helper (which 0088 never had):
--
--   1. Re-apply the three CREATE OR REPLACE FUNCTION statements from
--      0088_program_definition_and_generation_rpcs.sql verbatim for
--      create_program, preview_program_sessions, and
--      generate_program_sessions (that file is immutable and already
--      applied — copy its function bodies, do not edit it in place).
--   2. drop function if exists public._validate_program_definition(uuid, uuid, uuid);
--
-- This restores 0088's exact runtime behavior (including the ownership,
-- overlap, and validation gaps this migration fixes) without touching any
-- program/rule/court/event/reservation/audit_log row already created under
-- either version of these functions — those are ordinary data rows, not
-- schema, and are unaffected by which function body is currently active.

commit;
