-- verify_phase27c1.sql
-- Phase 27C.1: Draft Program Editing and Conflict Recovery — verification.
-- Covers 0090_draft_program_updates.sql (adds update_program only —
-- create_program, preview_program_sessions, generate_program_sessions, and
-- _validate_program_definition from 0088/0089 are untouched). Requires
-- 0087, 0088, and 0089 already applied.
--
-- Sections A–C are READ-ONLY (signatures, grants, textual body inspection)
-- and safe to run anywhere, anytime, repeatedly, with no live session
-- required.
--
-- Section D is NOT executable SQL and is NOT wrapped in a transaction — the
-- same convention as verify_phase27b2.sql's Section D and for the same
-- reason: update_program is SECURITY DEFINER and gated by
-- current_user_club_id()/current_user_role(), both of which resolve via
-- auth.uid(), which is NULL in the bare SQL Editor. Each item states the
-- RPC call to make as a real signed-in Admin/Pro, followed by a plain
-- read-only SELECT (which *can* run in the SQL Editor) to confirm the
-- result. Full step-by-step instructions are in QA_phase27c1.md — Section D
-- here is the condensed reference version.
-- ─────────────────────────────────────────────────────────────────────────────


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION A — FUNCTION SIGNATURE, SECURITY, GRANTS
-- ═══════════════════════════════════════════════════════════════════════════

-- A1. update_program exists with the expected argument/return shape.
-- Expected: 1 row.
--   update_program(uuid, uuid, text, text, date, date, integer, jsonb, text) -> programs
select
  p.proname as function_name,
  pg_get_function_identity_arguments(p.oid) as arguments,
  pg_get_function_result(p.oid) as returns
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'update_program';


-- A2. SECURITY DEFINER with search_path pinned to 'public, pg_temp'.
-- Expected: 1 row, is_security_definer = true, config_settings containing
-- 'search_path=public, pg_temp'.
select
  p.proname as function_name,
  p.prosecdef as is_security_definer,
  p.proconfig as config_settings
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'update_program';


-- A3. authenticated has EXECUTE on update_program.
-- Expected: 1 row, grantee = 'authenticated', privilege_type = 'EXECUTE'.
select routine_name, grantee, privilege_type
from information_schema.routine_privileges
where routine_schema = 'public'
  and routine_name = 'update_program'
  and grantee = 'authenticated';


-- A4. Zero PUBLIC/anon EXECUTE grants on update_program.
-- Expected: 0 rows.
select routine_name, grantee, privilege_type
from information_schema.routine_privileges
where routine_schema = 'public'
  and routine_name = 'update_program'
  and grantee in ('PUBLIC', 'anon');


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION B — MEMBERSHIP-NATIVE AUTHORIZATION (textual proof)
-- ═══════════════════════════════════════════════════════════════════════════

-- B1. update_program's body calls both membership-native helpers.
-- Expected: 1 row, both true.
select
  p.proname as function_name,
  (pg_get_functiondef(p.oid) ilike '%current_user_club_id()%') as uses_club_helper,
  (pg_get_functiondef(p.oid) ilike '%current_user_role()%')    as uses_role_helper
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'update_program';


-- B2. update_program's body never references the legacy profiles columns
-- for authorization.
-- Expected: 0 rows.
select p.proname as function_name
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'update_program'
  and (
    pg_get_functiondef(p.oid) ilike '%profiles.club_id%'
    or pg_get_functiondef(p.oid) ilike '%profiles.role%'
    or pg_get_functiondef(p.oid) ilike '%profiles.status%'
    or pg_get_functiondef(p.oid) ilike '%profiles.is_lesson_provider%'
    or pg_get_functiondef(p.oid) ilike '%from profiles%'
    or pg_get_functiondef(p.oid) ilike '%from public.profiles%'
  );


-- B3. update_program's body never assigns created_by (ownership must be
-- preserved regardless of who edits). Uses a regex anchored to
-- "created_by" immediately followed by optional whitespace and "=" — an
-- assignment — rather than an unanchored ILIKE wildcard, which would
-- false-positive on the (legitimate, comparison-only) ownership check
-- `v_program.created_by <> auth.uid()` elsewhere in the same body (an
-- unanchored '%created_by%=%' matches across the entire remaining
-- function text, not just adjacent tokens, since '<>' is two characters
-- containing no '=').
-- Expected: 0 rows.
select p.proname as function_name
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'update_program'
  and pg_get_functiondef(p.oid) ~* 'created_by\s*=';


-- B4. update_program's body contains the editable-state and already-
-- generated guards, and reuses create_program's overlap/malformed-JSON
-- hardening (textual proxy — behavioral proof is Section D).
-- Expected: 1 row, every column true.
select
  p.proname as function_name,
  (pg_get_functiondef(p.oid) ilike '%program_not_editable%')      as has_editable_gate,
  (pg_get_functiondef(p.oid) ilike '%program_already_generated%') as has_generated_gate,
  (pg_get_functiondef(p.oid) ilike '%overlapping_program_rules%') as has_overlap_check,
  (pg_get_functiondef(p.oid) ilike '%when invalid_text_representation%') as has_guarded_json,
  (pg_get_functiondef(p.oid) not ilike '%when others%')           as has_no_blanket_when_others
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'update_program';


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION C — NO REGRESSION TO EXISTING RPCs / TABLE-PRIVILEGE / RLS POSTURE
-- ═══════════════════════════════════════════════════════════════════════════

-- C1. create_program, preview_program_sessions, generate_program_sessions,
-- and _validate_program_definition are unchanged — same signatures still
-- resolve (0090 does not touch any of them).
-- Expected: 4 rows.
select proname
from pg_proc
where pronamespace = 'public'::regnamespace
  and proname in ('create_program', 'preview_program_sessions', 'generate_program_sessions', '_validate_program_definition')
order by proname;


-- C2. authenticated privileges on the four Phase 27B1 tables are still
-- exactly SELECT — 0090 adds no table-level GRANT/REVOKE statement.
-- Expected: 4 rows, one per table, privilege_type = 'SELECT'.
select table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in ('programs', 'program_schedule_rules', 'program_rule_courts', 'program_enrollments')
  and grantee = 'authenticated'
order by table_name;


-- C3. Still no INSERT/UPDATE/DELETE RLS policy on any of the four tables —
-- 0090 adds zero RLS policies of any kind (writes remain RPC-only).
-- Expected: 0 rows.
select schemaname, tablename, policyname, cmd
from pg_policies
where schemaname = 'public'
  and tablename in ('programs', 'program_schedule_rules', 'program_rule_courts', 'program_enrollments')
  and cmd <> 'SELECT';


-- C4. create_event/join_event/leave_event/cancel_event/archive_event/
-- set_event_member_joinable remain unchanged — still no reference to any
-- Phase 27 table or column.
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


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION D — AUTHENTICATED-SESSION QA GUIDANCE
-- (NOT executable SQL, NOT transaction-wrapped — see header note)
-- ═══════════════════════════════════════════════════════════════════════════

-- D1. Admin updates a same-club draft — succeeds; rules/courts replaced.
-- Setup: Admin calls create_program (draft, 1 rule/1 court), then calls
-- update_program on it with a different rule set (2 rules/2 courts).
select id, day_of_week, start_time, duration_minutes
from public.program_schedule_rules
where program_id = '<program id from D1>'
order by day_of_week, start_time;
-- Expected: exactly the NEW rule set — the original rule's row is gone
-- entirely (not just superseded), confirming DELETE+INSERT replacement
-- rather than an in-place patch.
select prc.court_id
from public.program_rule_courts prc
join public.program_schedule_rules psr on psr.id = prc.program_schedule_rule_id
where psr.program_id = '<program id from D1>';
-- Expected: exactly the new court assignments.


-- D2. Pro updates their own draft — succeeds.
-- Setup: Pro A creates a draft, then calls update_program on it.
-- Expected: success, returned row's created_by is still Pro A's id.


-- D3. Pro cannot update another owner's draft.
-- Setup: Pro A creates a draft. Pro B (same club) calls update_program on
-- Pro A's program_id.
-- Expected: 'insufficient_role'. Confirm the program's definition is
-- unchanged:
select title, updated_at from public.programs where id = '<program id from D3>';
-- Expected: updated_at unchanged from before Pro B's attempt.


-- D4. Cross-club isolation.
-- Setup: Admin of Club A calls update_program with a program_id belonging
-- to Club B.
-- Expected: 'program_not_found' (not a permission-specific error — matches
-- every other club-scoped RPC's not-found-not-forbidden convention).


-- D5. Generated/active program rejection.
-- Setup A: create a draft, generate_program_sessions on it (now active,
-- has events), then attempt update_program.
-- Expected: 'program_already_generated' (checked independently of status —
-- see migration header). Setup B: directly flip a draft's status to
-- 'active' without generating (service role, simulating a future status
-- transition path) and attempt update_program.
-- Expected: 'program_not_editable'.
-- Both cases: confirm zero program_schedule_rules changes resulted:
select count(*) from public.program_schedule_rules where program_id = '<program id from D5>';
-- Expected: unchanged from before the attempt.


-- D6. Conflict removed after editing — the exact 27C.1 scenario.
-- Setup: create a draft whose rule conflicts with an existing reservation
-- (preview_program_sessions shows has_conflict=true for that occurrence).
-- Call update_program changing that rule's start_time (or court) so it no
-- longer conflicts. Call preview_program_sessions again.
-- Expected: the previously conflicting occurrence's has_conflict is now
-- false (or the occurrence no longer appears, if the time/day changed);
-- Generate is no longer blocked.


-- D7. Previous definition survives a rejected update.
-- Setup: create a valid draft (note its rules/courts). Attempt
-- update_program with a payload that fails validation partway through
-- pass 1 (e.g. an overlapping-rule payload, which fails after pass 1
-- completes but before any write) or with a malformed field.
select psr.day_of_week, psr.start_time, psr.duration_minutes, array_agg(prc.court_id) as court_ids
from public.program_schedule_rules psr
left join public.program_rule_courts prc on prc.program_schedule_rule_id = psr.id
where psr.program_id = '<program id from D7>'
group by psr.id, psr.day_of_week, psr.start_time, psr.duration_minutes;
-- Expected: identical to the pre-attempt rule/court set — nothing was
-- deleted or partially replaced.


-- D8. created_by remains unchanged across an edit by a different-role
-- manager.
-- Setup: Pro A creates a draft. Admin calls update_program on it (Admin
-- may edit any in-club draft).
select created_by from public.programs where id = '<program id from D8>';
-- Expected: still Pro A's id, never the Admin's.


-- D9. Malformed input returns stable, documented error codes — same
-- payload shapes as 0089/create_program's own hardening, exercised here
-- against update_program instead:
--   missing day_of_week                    -> invalid_day_of_week
--   day_of_week: 3.7                       -> invalid_day_of_week
--   start_time: "not-a-time"               -> invalid_start_time
--   start_time: "25:99"                    -> invalid_start_time
--   missing duration_minutes               -> invalid_duration
--   capacity_override: "abc"               -> invalid_capacity_override
--   court_ids: ["not-a-uuid"]              -> court_not_found
--   rule elements not objects              -> invalid_rules_payload
--   court_ids not an array                 -> rule_requires_court
-- Expected: every payload raises the named code, not a raw Postgres cast
-- error; confirm the program's definition is unchanged after each attempt
-- (same query as D7).


-- D10. create_program and generation behavior remain unchanged.
-- Re-run QA_phase27b2.md's create_program/preview_program_sessions/
-- generate_program_sessions checks (27B2-1 through 27B2-18) — all
-- expected results are identical to before 0090.
