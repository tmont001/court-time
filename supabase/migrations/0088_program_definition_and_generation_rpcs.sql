-- 0088_program_definition_and_generation_rpcs.sql
-- Phase 27B2: Program Definition and Session Generation RPCs.
--
-- Adds three SECURITY DEFINER RPCs on top of the Phase 27B1 schema (0087):
--
--   1. create_program              — creates a draft program, its weekly
--                                     schedule rule(s), and normalized court
--                                     assignments, atomically.
--   2. preview_program_sessions    — read-only. Returns one row per
--                                     candidate rule/date/court combination
--                                     with conflict/already-generated status.
--                                     Writes nothing.
--   3. generate_program_sessions   — re-derives the candidate set inside the
--                                     write transaction (never trusts an
--                                     earlier preview) and inserts one
--                                     events row per new (rule, date), with
--                                     one reservations row per assigned
--                                     court — the exact shape create_event
--                                     already produces (0062). All-or-
--                                     nothing on any court conflict.
--
-- Locked architecture (Phase 27, do not repeat/relitigate here): generated
-- occurrences ARE events. No program_sessions table, no parallel
-- participant/guest/roster/attendance/waitlist/reservation/notification
-- table of any kind is created or will ever be created for this feature.
-- event_participants/event_guests/reservations/notifications remain the
-- only tables that ever represent a member/guest/court/notification at a
-- specific occurrence.
--
-- Explicitly NOT included in this checkpoint (by design — Phase 27C):
--   • No member enrollment RPC (enroll_program).
--   • No withdrawal RPC (withdraw_program_enrollment /
--     admin_remove_program_enrollment).
--   • No waitlist/offer RPC for program_enrollments.
--   • No event_participants materialization from program_enrollments —
--     generate_program_sessions creates zero event_participants rows,
--     exactly mirroring create_event's own current behavior (0058 removed
--     the auto-host-participant insert; this migration does not reintroduce
--     one for generated events either).
--   • No notification of any kind — no row is ever inserted into
--     notifications by any function in this file.
--   • No UI.
--
-- Mirrors create_event exactly, not a superset of it: as of 0058/0059/0062,
-- create_event (a) does not check operating_hours or operating_hours_override
-- at all — only create_reservation does; (b) does not check court club/
-- active status before inserting a reservation; (c) does not insert a host
-- participant row; (d) relies on the reservations table's own GiST exclude
-- constraint (0003) for conflict rejection, not a manual pre-check.
-- generate_program_sessions reproduces (a)/(c) faithfully. It intentionally
-- ADDS an explicit pre-flight conflict check ahead of the insert loop (see
-- section 3 below) so a conflicting batch fails cleanly with a named error
-- instead of an arbitrary mid-loop constraint violation — this does not
-- change what counts as a conflict, only when and how clearly it is
-- reported; the same GiST exclude constraint remains the authoritative
-- backstop for both the pre-check and the actual inserts.
--
-- DST safety: every occurrence's starts_at is computed independently as
-- (occurrence_date + rule.start_time) AT TIME ZONE <club timezone>, which
-- asks Postgres to resolve that specific naive wall-clock timestamp against
-- that specific calendar date's UTC offset in the club's IANA zone — never
-- by adding a fixed 7-day/604800-second interval to an anchor timestamptz.
-- Each occurrence in a generation batch is therefore correct independently
-- of every other occurrence, including across a DST transition inside the
-- requested range. ends_at is then starts_at + duration_minutes (interval
-- arithmetic on a timestamptz is absolute-duration/UTC-correct, which is
-- the desired "N real minutes later" semantics for a session's length).
--
-- Range/count ceilings (defined identically in all three functions,
-- repeated per-function rather than centralized — there is no shared-
-- constant convention in this schema, see e.g. update_club_settings's
-- repeated 1–72 waitlist-offer-window bounds):
--   • 182 days (26 weeks) maximum between starts_on/ends_on (create_program)
--     and between any requested from/through window (preview/generate).
--   • 200 maximum candidate occurrences (rule × date pairs, not rule × date
--     × court rows) per preview call, and 200 maximum newly-inserted
--     occurrences per generate call.
--
-- Security: every function is SECURITY DEFINER, sets search_path = public,
-- pg_temp, revokes execute from PUBLIC/anon, and grants execute only to
-- authenticated. Every authorization decision is made from a single
-- `select current_user_club_id(), current_user_role() into ...` statement
-- captured once per call (Phase 26C1 pattern, 0083) — no function in this
-- file reads profiles.club_id, profiles.role, profiles.status, or
-- profiles.is_lesson_provider. 0087's table-privilege posture on
-- programs/program_schedule_rules/program_rule_courts/program_enrollments
-- (authenticated: SELECT only; anon: nothing) is untouched — these
-- SECURITY DEFINER functions write to those tables as their owner, which is
-- unaffected by the revokes on the calling roles.
--
-- No begin/commit wrapper: each CREATE OR REPLACE FUNCTION plus its
-- revoke/grant pair is independently atomic and does not depend on the
-- others succeeding first, matching the established convention for
-- function-only migrations in this schema (0038, 0058, 0059, 0069) as
-- opposed to the explicit-transaction convention used for migrations that
-- mix table DDL with backfills (0081, 0083).
--
-- See supabase/scripts/verify_phase27b2.sql for the full read-only
-- verification pass, and supabase/scripts/QA_phase27b2.md for manual QA
-- steps.
--
-- Apply in Supabase SQL Editor (cloud only). Not applied by this checkpoint.


-- ═══════════════════════════════════════════════════════════════════════════
-- 1. create_program
-- ═══════════════════════════════════════════════════════════════════════════
-- Creates a draft program, its schedule rule(s), and normalized court
-- assignments in one call. Validates fully before writing anything — no
-- partial program/rule/court state is ever left behind on a rejected call
-- (a single uncaught exception aborts this entire function's implicit
-- transaction; nothing before the RAISE is visible to any other session).
--
-- p_rules shape (jsonb array, one element per weekly rule):
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
-- duplicate_rule, invalid_day_of_week, invalid_start_time, invalid_duration,
-- invalid_capacity_override, capacity_override_not_allowed_for_program_enrollment,
-- rule_requires_court, duplicate_court_in_rule, court_not_found.

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

  -- ── Pass 1: validate every rule and its courts. No writes yet. ──────────
  for v_rule in select * from jsonb_array_elements(p_rules) loop
    if v_rule->>'day_of_week' is null
       or (v_rule->>'day_of_week')::int not between 0 and 6 then
      raise exception 'invalid_day_of_week';
    end if;

    -- A malformed (non-null, non-castable) start_time raises Postgres's own
    -- cast error rather than this custom code — same accepted tradeoff as
    -- 0038's identical unwrapped ::time/::boolean casts on jsonb input.
    if v_rule->>'start_time' is null then
      raise exception 'invalid_start_time';
    end if;

    if v_rule->>'duration_minutes' is null or (v_rule->>'duration_minutes')::int <= 0 then
      raise exception 'invalid_duration';
    end if;

    v_cap_override := case
      when jsonb_typeof(v_rule->'capacity_override') = 'number'
        then (v_rule->>'capacity_override')::int
      else null
    end;
    if v_cap_override is not null and v_cap_override <= 0 then
      raise exception 'invalid_capacity_override';
    end if;
    if v_cap_override is not null and p_enrollment_model = 'program' then
      raise exception 'capacity_override_not_allowed_for_program_enrollment';
    end if;

    v_court_ids := coalesce(v_rule->'court_ids', '[]'::jsonb);
    if jsonb_typeof(v_court_ids) <> 'array' or jsonb_array_length(v_court_ids) = 0 then
      raise exception 'rule_requires_court';
    end if;

    select count(*), count(distinct value)
      into v_court_count, v_distinct_court_count
      from jsonb_array_elements_text(v_court_ids);
    if v_court_count <> v_distinct_court_count then
      raise exception 'duplicate_court_in_rule';
    end if;

    -- Every court must belong to the caller's active club and be active.
    if exists (
      select 1
      from jsonb_array_elements_text(v_court_ids) as cid
      where not exists (
        select 1 from public.courts c
        where c.id = cid::uuid and c.club_id = v_club_id and c.is_active = true
      )
    ) then
      raise exception 'court_not_found';
    end if;
  end loop;

  -- No duplicate (day_of_week, start_time) rule pairs across the whole
  -- payload. Runs after pass 1 so every element is already known-castable.
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

    for v_court_id_text in
      select value from jsonb_array_elements_text(coalesce(v_rule->'court_ids', '[]'::jsonb))
    loop
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
-- 2. preview_program_sessions
-- ═══════════════════════════════════════════════════════════════════════════
-- Read-only. One row per candidate (rule, date, court) combination in the
-- requested window (clamped to the program's own starts_on/ends_on).
-- Writes nothing — STABLE, no INSERT/UPDATE/DELETE anywhere in this body.
--
-- already_generated is computed per (rule, occurrence_date) — the same
-- granularity generation itself uses (one events row per rule/date covering
-- every assigned court) — so every court row for an already-generated
-- occurrence reports already_generated = true together.
--
-- has_conflict is deliberately forced false whenever already_generated is
-- true: an already-generated occurrence's own reservation would otherwise
-- overlap itself and be misreported as a brand-new conflict. This is the
-- literal "existing generated slots ... are not treated as new conflicts"
-- requirement.
--
-- Error codes: not_authenticated, insufficient_role, program_not_found,
-- invalid_date_range, range_too_long, too_many_occurrences.

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
-- 3. generate_program_sessions
-- ═══════════════════════════════════════════════════════════════════════════
-- Re-derives the candidate set from scratch inside this call's own write
-- transaction — never trusts a caller-supplied preview result. Skips any
-- (rule, occurrence_date) slot that already has an events row (idempotent).
-- If any remaining new candidate's court/time conflicts with an existing
-- pending/confirmed reservation, the entire call fails via RAISE EXCEPTION
-- before any INSERT runs — and because everything below is one function
-- call's implicit transaction, an exception at any later point (including
-- the reservations table's own GiST exclude constraint, kept as the
-- authoritative backstop against a same-transaction race) rolls back every
-- events/reservations row this call may have already inserted. No partial
-- program's-worth of sessions is ever left behind.
--
-- Error codes: not_authenticated, insufficient_role, program_not_found,
-- program_archived, program_not_generatable, invalid_date_range,
-- range_too_long, too_many_occurrences, court_conflict.

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

  v_from    := greatest(coalesce(p_from_date, v_program.starts_on), v_program.starts_on);
  v_through := least(coalesce(p_through_date, v_program.ends_on), v_program.ends_on);

  if v_through < v_from then raise exception 'invalid_date_range'; end if;
  if (v_through - v_from) > 182 then raise exception 'range_too_long'; end if;

  select timezone into v_tz from public.clubs where id = v_club_id;

  -- Total possible (rule, date) slots in range, and how many are new
  -- (not yet generated) — the difference is the idempotent skip count.
  select count(*) into v_total_count
  from public.program_schedule_rules psr
  cross join generate_series(v_from::timestamp, v_through::timestamp, interval '1 day') as d
  where psr.program_id = p_program_id
    and extract(dow from d)::int = psr.day_of_week;

  select count(*) into v_new_count
  from public.program_schedule_rules psr
  cross join generate_series(v_from::timestamp, v_through::timestamp, interval '1 day') as d
  where psr.program_id = p_program_id
    and extract(dow from d)::int = psr.day_of_week
    and not exists (
      select 1 from public.events e
      where e.program_schedule_rule_id = psr.id
        and e.program_occurrence_date  = d::date
    );

  if v_new_count = 0 then
    insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
    values (
      v_club_id, auth.uid(), 'generate_program_sessions', 'program', p_program_id,
      jsonb_build_object(
        'inserted_count', 0, 'skipped_count', v_total_count,
        'from', v_from, 'through', v_through
      )
    );
    return query select 0, v_total_count, '{}'::uuid[];
    return;
  end if;

  if v_new_count > 200 then
    raise exception 'too_many_occurrences';
  end if;

  -- Pre-flight conflict check across every new candidate's court/time pairs
  -- against existing pending/confirmed reservations — same overlap
  -- semantics as the reservations table's own GiST exclude constraint
  -- (0003: same court, overlapping [starts_at, ends_at) range, status in
  -- ('pending','confirmed')). Fail the entire call with no writes yet if
  -- anything conflicts.
  select r.id, prc.court_id, d::date
    into v_conflict_res_id, v_conflict_court_id, v_conflict_date
  from public.program_schedule_rules psr
  cross join generate_series(v_from::timestamp, v_through::timestamp, interval '1 day') as d
  join public.program_rule_courts prc on prc.program_schedule_rule_id = psr.id
  join public.reservations r
    on r.court_id = prc.court_id
   and r.status in ('pending', 'confirmed')
   and tstzrange(r.starts_at, r.ends_at, '[)')
       && tstzrange(
            (d::date + psr.start_time) at time zone v_tz,
            ((d::date + psr.start_time) at time zone v_tz) + (psr.duration_minutes || ' minutes')::interval,
            '[)'
          )
  where psr.program_id = p_program_id
    and extract(dow from d)::int = psr.day_of_week
    and not exists (
      select 1 from public.events e2
      where e2.program_schedule_rule_id = psr.id
        and e2.program_occurrence_date  = d::date
    )
  limit 1;

  if v_conflict_res_id is not null then
    raise exception 'court_conflict'
      using detail = format('court_id=%s occurrence_date=%s reservation_id=%s',
                             v_conflict_court_id, v_conflict_date, v_conflict_res_id);
  end if;

  -- All clear — one events row per new (rule, date), one reservations row
  -- per assigned court. Same insert shape as create_event (0062): same
  -- events columns, same reservations columns/reason/event linkage, no
  -- operating-hours check (create_event has none), no host participant row
  -- (removed from create_event in 0058). No program_enrollments row is
  -- read or written here — enrollment/materialization is Phase 27C.
  for v_rec in
    select psr.id as rule_id, d::date as occurrence_date, psr.start_time,
           psr.duration_minutes, psr.capacity_override
    from public.program_schedule_rules psr
    cross join generate_series(v_from::timestamp, v_through::timestamp, interval '1 day') as d
    where psr.program_id = p_program_id
      and extract(dow from d)::int = psr.day_of_week
      and not exists (
        select 1 from public.events e3
        where e3.program_schedule_rule_id = psr.id
          and e3.program_occurrence_date  = d::date
      )
    order by d, psr.start_time
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
      v_starts_at, v_ends_at, v_capacity, v_court_count, 'scheduled', auth.uid(),
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
        v_club_id, v_court_rec.court_id, auth.uid(),
        v_starts_at, v_ends_at, 'confirmed', 'event', v_new_event.id, auth.uid()
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
      'inserted_count', v_inserted_count,
      'skipped_count',  v_total_count - v_new_count,
      'from',           v_from,
      'through',        v_through,
      'event_ids',      to_jsonb(v_inserted_ids)
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
-- Safe to roll back at any point — every function here either writes
-- nothing (preview) or writes rows (programs/program_schedule_rules/
-- program_rule_courts/events/reservations/audit_log) that are ordinary,
-- independently-valid rows with no other object depending on these three
-- function definitions. Dropping the functions does not touch any row they
-- already created.
--
--   drop function if exists public.generate_program_sessions(uuid, date, date);
--   drop function if exists public.preview_program_sessions(uuid, date, date);
--   drop function if exists public.create_program(uuid, text, text, date, date, int, jsonb, text);
--
-- This does not undo any program/rule/court/event/reservation rows already
-- created by these functions while they existed — those are ordinary data
-- rows, not schema, and are outside the scope of a function-drop rollback.
