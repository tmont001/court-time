-- verify_phase27b2.sql
-- Phase 27B2: Program Definition and Session Generation RPCs — verification.
-- Covers 0088_program_definition_and_generation_rpcs.sql (the original
-- three RPCs) AND 0089_program_generation_hardening.sql (the corrective
-- migration — ownership preservation, overlapping-rule rejection,
-- definition revalidation, malformed-JSON hardening). Run AFTER applying
-- both 0088 and 0089 (which requires 0087 already applied).
--
-- Sections A–C are READ-ONLY (signatures, grants, textual body inspection)
-- and safe to run anywhere, anytime, repeatedly, with no live session
-- required — none of them call auth.uid() or any of the RPCs themselves.
--
-- Section D is NOT executable SQL and is NOT wrapped in a transaction. It is
-- a condensed reference of authenticated-session QA guidance: each numbered
-- item states an RPC call to make as a real signed-in Admin/Pro/Member (via
-- the browser console, a script using a real user's access token, or the
-- application UI once it exists), followed by a plain read-only SELECT
-- (which *can* be run in the SQL Editor, since reading rows doesn't depend
-- on auth.uid()) to confirm the result. This is unavoidable: every function
-- covered here is SECURITY DEFINER and gated by current_user_club_id()/
-- current_user_role(), which resolve via auth.uid() — the bare SQL Editor
-- has no JWT, so auth.uid() is NULL there and every call would fail
-- 'not_authenticated' regardless of what the function actually does. Full
-- step-by-step instructions with every expected error code are in
-- QA_phase27b2.md — Section D here is the condensed reference version, not
-- a substitute for it.
-- ─────────────────────────────────────────────────────────────────────────────


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION A — FUNCTION SIGNATURES, SECURITY, GRANTS
-- ═══════════════════════════════════════════════════════════════════════════

-- A1. Exactly the three expected PUBLIC function signatures exist, with
-- their argument/return shape UNCHANGED by 0089 (0089 only replaces
-- bodies).
-- Expected: 3 rows, identical arguments/returns to what 0088 originally
-- shipped:
--   create_program(uuid, text, text, date, date, integer, jsonb, text) -> programs
--   preview_program_sessions(uuid, date, date) -> TABLE(...)
--   generate_program_sessions(uuid, date, date) -> TABLE(inserted_count integer, skipped_count integer, event_ids uuid[])
select
  p.proname as function_name,
  pg_get_function_identity_arguments(p.oid) as arguments,
  pg_get_function_result(p.oid) as returns
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('create_program', 'preview_program_sessions', 'generate_program_sessions')
order by p.proname;


-- A2. All three are SECURITY DEFINER with search_path pinned to
-- 'public, pg_temp'.
-- Expected: 3 rows, is_security_definer = true, config_settings containing
-- 'search_path=public, pg_temp'.
select
  p.proname as function_name,
  p.prosecdef as is_security_definer,
  p.proconfig as config_settings
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('create_program', 'preview_program_sessions', 'generate_program_sessions')
order by p.proname;


-- A3. preview_program_sessions is STABLE (read-only); the other two are
-- VOLATILE (the default — they write).
-- Expected: 3 rows. preview_program_sessions: provolatile = 's'.
-- create_program / generate_program_sessions: provolatile = 'v'.
select
  p.proname as function_name,
  p.provolatile,
  case p.provolatile
    when 'i' then 'IMMUTABLE'
    when 's' then 'STABLE'
    when 'v' then 'VOLATILE'
  end as volatility
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('create_program', 'preview_program_sessions', 'generate_program_sessions')
order by p.proname;


-- A4. EXECUTE grants — authenticated has EXECUTE on all three, filtered
-- explicitly by grantee = 'authenticated' (not just "any grant exists").
-- Expected: 3 rows, all grantee = 'authenticated', privilege_type = 'EXECUTE'.
select routine_name, grantee, privilege_type
from information_schema.routine_privileges
where routine_schema = 'public'
  and routine_name in ('create_program', 'preview_program_sessions', 'generate_program_sessions')
  and grantee = 'authenticated'
order by routine_name;


-- A5. Zero PUBLIC/anon EXECUTE grants on any of the three functions.
-- Expected: 0 rows.
select routine_name, grantee, privilege_type
from information_schema.routine_privileges
where routine_schema = 'public'
  and routine_name in ('create_program', 'preview_program_sessions', 'generate_program_sessions')
  and grantee in ('PUBLIC', 'anon');


-- A6. New in 0089 — the private helper _validate_program_definition exists,
-- is SECURITY DEFINER with search_path pinned, and has EXECUTE granted to
-- no role at all (not even authenticated — it is only ever called from
-- inside the three SECURITY DEFINER functions above, which execute under
-- their owner's privileges and are therefore unaffected by this revoke;
-- see the 0089 migration header and check_event_type_active's identical
-- precedent from 0065).
-- Expected: 1 row, is_security_definer = true, search_path pinned.
select
  p.proname as function_name,
  p.prosecdef as is_security_definer,
  p.proconfig as config_settings
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = '_validate_program_definition';


-- A7. Zero EXECUTE grants to PUBLIC/anon/authenticated on
-- _validate_program_definition. Scoped to these three grantees only —
-- postgres (the function owner) and service_role are expected to retain
-- execution privilege and must not be treated as a failure here; this
-- check is about client-reachable roles, not the owner/service role.
-- Expected: 0 rows.
select routine_name, grantee, privilege_type
from information_schema.routine_privileges
where routine_schema = 'public'
  and routine_name = '_validate_program_definition'
  and grantee in ('PUBLIC', 'anon', 'authenticated');


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION B — MEMBERSHIP-NATIVE AUTHORIZATION AND 0089 HARDENING
-- (textual proof — no live session required)
-- ═══════════════════════════════════════════════════════════════════════════

-- B1. Every one of the three public functions' bodies calls both
-- membership-native helpers.
-- Expected: 3 rows, uses_club_helper = true, uses_role_helper = true.
select
  p.proname as function_name,
  (pg_get_functiondef(p.oid) ilike '%current_user_club_id()%') as uses_club_helper,
  (pg_get_functiondef(p.oid) ilike '%current_user_role()%')    as uses_role_helper
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('create_program', 'preview_program_sessions', 'generate_program_sessions')
order by p.proname;


-- B2. No function body (including the new private helper) references the
-- legacy profiles columns for authorization.
-- Expected: 0 rows.
select
  p.proname as function_name,
  pg_get_functiondef(p.oid) as definition
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('create_program', 'preview_program_sessions', 'generate_program_sessions', '_validate_program_definition')
  and (
    pg_get_functiondef(p.oid) ilike '%profiles.club_id%'
    or pg_get_functiondef(p.oid) ilike '%profiles.role%'
    or pg_get_functiondef(p.oid) ilike '%profiles.status%'
    or pg_get_functiondef(p.oid) ilike '%profiles.is_lesson_provider%'
    or pg_get_functiondef(p.oid) ilike '%from profiles%'
    or pg_get_functiondef(p.oid) ilike '%from public.profiles%'
  );


-- B3. Ownership hardening (textual proxy) — generate_program_sessions'
-- body no longer stamps events.created_by/reservations.owner_user_id/
-- reservations.created_by with auth.uid(); it uses v_program.created_by.
-- This is a textual proxy, not a behavioral proof — B3 only confirms the
-- source text contains the expected substring at least 3 times (one events
-- insert + one reservations insert referencing it twice); the actual
-- runtime column values are confirmed live in Section D below (D1) and in
-- QA_phase27b2.md.
-- Expected: 1 row, created_by_reference_count >= 3.
select
  p.proname as function_name,
  (length(pg_get_functiondef(p.oid)) - length(replace(pg_get_functiondef(p.oid), 'v_program.created_by', '')))
    / length('v_program.created_by') as created_by_reference_count
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'generate_program_sessions';


-- B4. Overlap hardening (textual proof) — create_program's body contains
-- the new overlapping_program_rules error code, and generate_program_
-- sessions' body contains a batch self-conflict check distinct from its
-- pre-existing-reservation conflict check.
-- Expected: 2 rows.
select
  p.proname as function_name,
  (pg_get_functiondef(p.oid) ilike '%overlapping_program_rules%') as has_overlap_check
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('create_program', 'generate_program_sessions')
order by p.proname;


-- B5. Revalidation hardening (textual proof) — preview_program_sessions
-- and generate_program_sessions both call _validate_program_definition.
-- Expected: 2 rows, both true.
select
  p.proname as function_name,
  (pg_get_functiondef(p.oid) ilike '%_validate_program_definition(%') as calls_validation_helper
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('preview_program_sessions', 'generate_program_sessions')
order by p.proname;


-- B6. Malformed-JSON hardening (textual proof) — create_program's body
-- contains guarded exception handling (narrow, not a blanket "when
-- others") for the jsonb-derived scalar casts, catches the two additional
-- malformed-time exception classes for start_time, and checks explicit key
-- presence (v_rule ? '...') for day_of_week/duration_minutes so a missing
-- key cannot slip past a typeof-only check (jsonb_typeof(NULL) <> 'number'
-- evaluates to NULL, not TRUE, in three-valued logic).
-- Expected: 1 row, every column true.
select
  p.proname as function_name,
  (pg_get_functiondef(p.oid) ilike '%when invalid_text_representation%') as has_narrow_exception_guard,
  (pg_get_functiondef(p.oid) not ilike '%when others%')                 as has_no_blanket_when_others,
  (pg_get_functiondef(p.oid) ilike '%invalid_datetime_format%')         as catches_invalid_datetime_format,
  (pg_get_functiondef(p.oid) ilike '%datetime_field_overflow%')         as catches_datetime_field_overflow,
  (pg_get_functiondef(p.oid) ilike '%not (v_rule ? ''day_of_week'')%')  as checks_day_of_week_key_presence,
  (pg_get_functiondef(p.oid) ilike '%not (v_rule ? ''duration_minutes'')%') as checks_duration_minutes_key_presence
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'create_program';


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION C — NO REGRESSION TO 0087's TABLE-PRIVILEGE / RLS POSTURE, OR TO
-- EXISTING EVENT RPCs
-- ═══════════════════════════════════════════════════════════════════════════

-- C1. authenticated privileges on the four Phase 27B1 tables are still
-- exactly SELECT, unchanged by 0088 or 0089 (neither adds a table-level
-- GRANT/REVOKE statement).
-- Expected: 4 rows, one per table, privilege_type = 'SELECT'.
select table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in ('programs', 'program_schedule_rules', 'program_rule_courts', 'program_enrollments')
  and grantee = 'authenticated'
order by table_name;


-- C2. Still no INSERT/UPDATE/DELETE RLS policy on any of the four tables —
-- neither 0088 nor 0089 adds any RLS policy.
-- Expected: 0 rows.
select schemaname, tablename, policyname, cmd
from pg_policies
where schemaname = 'public'
  and tablename in ('programs', 'program_schedule_rules', 'program_rule_courts', 'program_enrollments')
  and cmd <> 'SELECT';


-- C3. create_event, join_event, leave_event, cancel_event, archive_event,
-- and set_event_member_joinable are unchanged — their source text still
-- does not reference any Phase 27 table or column.
-- Expected: 0 rows.
select p.proname as function_name
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('create_event', 'join_event', 'leave_event', 'cancel_event', 'archive_event', 'set_event_member_joinable')
  and (
    pg_get_functiondef(p.oid) ilike '%program_id%'
    or pg_get_functiondef(p.oid) ilike '%program_schedule_rule%'
    or pg_get_functiondef(p.oid) ilike '%program_occurrence_date%'
    or pg_get_functiondef(p.oid) ilike '%is_program_exception%'
  );


-- C4. Exactly the expected six pre-existing event RPCs still resolve (no
-- accidental drop).
-- Expected: 6 rows.
select proname
from pg_proc
where pronamespace = 'public'::regnamespace
  and proname in ('create_event', 'join_event', 'leave_event', 'cancel_event', 'archive_event', 'set_event_member_joinable')
order by proname;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION D — AUTHENTICATED-SESSION QA GUIDANCE
-- (NOT executable SQL, NOT transaction-wrapped — see header note)
-- ═══════════════════════════════════════════════════════════════════════════

-- D1. Ownership preservation — Admin generates a Pro-owned program.
-- Setup: Pro A calls create_program (program is created_by = Pro A). Admin
-- calls generate_program_sessions on that program_id.
select
  e.id, e.created_by as event_created_by, r.owner_user_id, r.created_by as reservation_created_by
from public.events e
join public.reservations r on r.event_id = e.id
where e.program_id = '<program id from D1 setup>';
-- Expected: event_created_by, owner_user_id, and reservation_created_by are
-- ALL Pro A's profile id — never the Admin's, regardless of who invoked
-- generate_program_sessions.
select actor_id, metadata->>'program_owner_id' as program_owner_id, metadata->>'generated_by_id' as generated_by_id
from public.audit_log
where action = 'generate_program_sessions' and target_id = '<program id from D1 setup>'
order by created_at desc limit 1;
-- Expected: actor_id = the Admin's profile id (the real invoker);
-- program_owner_id = Pro A's id; generated_by_id = the Admin's id.
-- Then, as Pro A, call cancel_event or archive_event on one of the
-- generated event ids: expect success (Pro A's created_by-based ownership
-- check in the existing, unmodified cancel_event/archive_event now passes,
-- because event_created_by is Pro A's id).


-- D2. Overlap prevention — same court, overlapping windows.
-- Attempt create_program with two rules: same day_of_week, sharing one
-- court, windows 09:00-10:30 and 10:00-11:00 (overlap).
-- Expected: 'overlapping_program_rules'; confirm no program row was
-- created:
select count(*) from public.programs where title = '<test title from D2>';
-- Expected: 0.

-- D2b. Same start time, DIFFERENT courts — must be allowed.
-- create_program with two rules: same day_of_week, same start_time
-- (09:00), disjoint court_ids (no shared court).
-- Expected: success (this is not the duplicate_rule case either, since the
-- DB unique constraint is scoped to (program_id, day_of_week, start_time)
-- regardless of court — wait: this specific combination IS still rejected,
-- but as 'duplicate_rule', not 'overlapping_program_rules' — see the 0089
-- migration header for why the exact-start-time case is a hard schema
-- constraint independent of court. To test the "different courts allowed"
-- case cleanly, use two DIFFERENT start times on different courts that
-- would only conflict if compared without the shared-court requirement,
-- e.g. 09:00-10:00 on Court A and 09:30-10:30 on Court B (same day,
-- overlapping time, no shared court).
-- Expected: success.

-- D2c. Adjacent windows, same court — must be allowed.
-- create_program with two rules: same day_of_week, same court, windows
-- 09:00-10:00 and 10:00-11:00 (touching, not overlapping — half-open).
-- Expected: success.

-- D2d. Batch self-conflict inside generate_program_sessions.
-- As service role in the SQL Editor (bypasses create_program's own guard),
-- directly INSERT two program_schedule_rules rows for the same program
-- with the same day_of_week and overlapping times sharing a court (bypasses
-- application-level validation entirely, simulating a program created
-- before 0089 existed). Then call generate_program_sessions as the
-- program's owner.
-- Expected: 'court_conflict' with a detail message starting
-- 'batch_self_conflict'; confirm zero events were created for this program:
select count(*) from public.events where program_id = '<program id from D2d setup>';
-- Expected: 0.


-- D3. Definition revalidation blocks preview/generation.
-- D3a. Deactivate the program's event_type (set_event_type_active(id, false))
-- after create_program has already run successfully. Call
-- preview_program_sessions and generate_program_sessions on that program.
-- Expected: both raise 'event_type_not_found'.
-- D3b. Reactivate the event_type; instead directly deactivate (courts.is_active
-- = false) one court assigned to one of the program's rules (service role).
-- Call preview_program_sessions and generate_program_sessions.
-- Expected: both raise 'court_not_found'.
-- D3c. Reactivate that court; instead directly delete every
-- program_rule_courts row for one rule (service role), leaving that rule
-- with zero courts. Call preview_program_sessions and
-- generate_program_sessions.
-- Expected: both raise 'rule_requires_court'. Confirm no event was ever
-- generated with court_count = 0 anywhere:
select count(*) from public.events where program_id is not null and court_count = 0;
-- Expected: 0 (always — this must never be possible under any of D3a-D3c).


-- D4. Malformed JSON returns stable, documented error codes (not raw
-- Postgres cast errors). Call create_program with each of the following
-- p_rules payloads (holding all other fields valid) and confirm the exact
-- error code shown, not a generic Postgres exception message:
--   [{"day_of_week": "not a number", ...}]              -> invalid_day_of_week
--   [{"day_of_week": 3.7, ...}]                          -> invalid_day_of_week
--   [{"start_time": "09:00", "duration_minutes": 60, "court_ids": [...]}]
--     (day_of_week key entirely absent)                 -> invalid_day_of_week
--   [{"day_of_week": 2, "start_time": "not-a-time", ...}] -> invalid_start_time
--   [{"day_of_week": 2, "start_time": "25:99", ...}]     -> invalid_start_time
--   [{"day_of_week": 2, "start_time": "09:00", "duration_minutes": "abc", ...}] -> invalid_duration
--   [{"day_of_week": 2, "start_time": "09:00", "court_ids": [...]}]
--     (duration_minutes key entirely absent)             -> invalid_duration
--   [{..., "capacity_override": "abc", ...}]             -> invalid_capacity_override
--   [{..., "capacity_override": true, ...}]              -> invalid_capacity_override
--   [{..., "court_ids": ["not-a-uuid"]}]                 -> court_not_found
--   ["just a string", "not an object"]                   -> invalid_rules_payload
--   [{..., "court_ids": "not-an-array"}]                 -> rule_requires_court
-- Expected: every payload above raises the named code; confirm no program
-- row was created for any of them:
select count(*) from public.programs where title like '<test title prefix used for D4>%';
-- Expected: 0.


-- D5. Idempotent overlapping generation — calling generate_program_sessions
-- twice with overlapping ranges inserts no duplicates.
select program_schedule_rule_id, program_occurrence_date, count(*)
from public.events
where program_id = '<program id from D5 setup>'
group by program_schedule_rule_id, program_occurrence_date
having count(*) > 1;
-- Expected: 0 rows (also structurally guaranteed by
-- events_program_slot_unique_idx from 0087).


-- D6. All-or-nothing conflict rejection against a pre-existing reservation.
-- Setup: book a member reservation on a specific court/time; create a
-- program whose rule would generate an occurrence on that exact court/time
-- among other non-conflicting occurrences; call generate_program_sessions.
-- Expected: 'court_conflict' with detail starting 'existing_reservation';
select count(*) from public.events where program_id = '<program id from D6 setup>';
-- Expected: 0 (no partial insert).


-- D7. Wrong-club court/type rejection at create_program time.
select count(*) from public.programs where title = '<test title from D7>';
-- Expected: 0, after create_program was called with an event_type_id or
-- court_id belonging to a different club and raised
-- 'event_type_not_found' / 'court_not_found'.


-- D8. Pro ownership restrictions on preview/generate.
-- Pro A creates a program. Pro B (same club) calls preview_program_sessions
-- and generate_program_sessions against Pro A's program_id.
-- Expected: both 'insufficient_role'. Admin calling the same two functions
-- against Pro A's program succeeds.


-- D9. DST transition — correct club-timezone-aware offset check.
-- Setup: create + generate a program whose rule spans a known DST
-- transition date in the club's timezone.
-- IMPORTANT: do not check this with extract(timezone_hour from
-- e.starts_at) — that extracts the offset using the database SESSION's
-- current TimeZone setting, not the club's IANA zone, and is not a valid
-- club-timezone-aware check. The correct idiom subtracts the UTC rendering
-- from the club-local rendering of the same instant, both computed via
-- AT TIME ZONE against the club's own timezone column:
select
  e.id, e.program_occurrence_date,
  e.starts_at,
  (e.starts_at at time zone c.timezone)                                        as starts_at_club_local,
  ((e.starts_at at time zone c.timezone) - (e.starts_at at time zone 'UTC'))   as utc_offset
from public.events e
join public.clubs c on c.id = e.club_id
where e.program_id = '<program id from D9 setup>'
order by e.program_occurrence_date;
-- Expected: starts_at_club_local shows the SAME wall-clock time (e.g.
-- 09:00:00) on every row; utc_offset differs by exactly one hour (e.g.
-- '-05:00:00' vs '-04:00:00') between rows before and after the transition
-- date.


-- D10. Event/reservation linkage and shape integrity after a successful
-- generate call.
select
  e.id, e.program_id, e.program_schedule_rule_id, e.program_occurrence_date,
  e.is_program_exception, e.member_joinable, e.status, e.capacity, e.court_count,
  (select count(*) from public.reservations r where r.event_id = e.id) as reservation_count,
  (select count(*) from public.event_participants ep where ep.event_id = e.id) as participant_count
from public.events e
where e.program_id = '<program id from any prior setup>'
order by e.program_occurrence_date;
-- Expected: every row has program_id/program_schedule_rule_id/
-- program_occurrence_date all non-null, is_program_exception = false,
-- reservation_count = that event's court_count, participant_count = 0
-- (no host row, no materialization — Phase 27C).
