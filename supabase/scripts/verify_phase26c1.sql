-- verify_phase26c1.sql
-- Phase 26C1: Auth Context and Admin Membership Controls — verification.
-- Run in the Supabase SQL Editor AFTER applying migration
-- 0083_auth_context_and_membership_controls.sql (requires 0081 and 0082
-- already applied).
--
-- READ-ONLY. Every statement in this file is a SELECT. No row is inserted,
-- updated, or deleted. Safe to run multiple times, in production, at any
-- time.
--
-- Source-of-truth checks below match on meaningful SQL tokens (table/
-- function names, keywords) via case-insensitive substring search over
-- pg_get_functiondef(), not on exact whitespace/formatting — reformatting a
-- function body without changing its logic will not break these checks.
-- ─────────────────────────────────────────────────────────────────────────────


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION A — FUNCTIONS
-- ═══════════════════════════════════════════════════════════════════════════

-- A1. get_current_account_context() exists with the expected signature.
-- Expected: 1 row, no arguments, SECURITY DEFINER, STABLE.
select
  p.proname,
  pg_get_function_arguments(p.oid) as arguments,
  pg_get_function_result(p.oid)    as return_type,
  p.prosecdef                      as is_security_definer,
  case p.provolatile when 's' then 'STABLE' when 'v' then 'VOLATILE' when 'i' then 'IMMUTABLE' end as volatility,
  p.proconfig as search_path_setting
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname = 'get_current_account_context';


-- A2. The five converted admin-membership functions exist with unchanged
-- signatures (Args) and unchanged Returns shape versus their pre-0083
-- contracts.
-- Expected: 5 rows. is_security_definer = true for all. get_members and
-- get_admin_member_detail are VOLATILE (plpgsql default, unchanged — they
-- were never marked STABLE); set_member_role/set_member_status/
-- set_lesson_provider_status are VOLATILE (they write).
select
  p.proname,
  pg_get_function_arguments(p.oid) as arguments,
  pg_get_function_result(p.oid)    as return_type,
  p.prosecdef                      as is_security_definer,
  case p.provolatile when 's' then 'STABLE' when 'v' then 'VOLATILE' when 'i' then 'IMMUTABLE' end as volatility,
  p.proconfig as search_path_setting
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname in (
    'get_members', 'get_admin_member_detail', 'set_member_role',
    'set_member_status', 'set_lesson_provider_status'
  )
order by p.proname;


-- A3. Missing functions.
-- Expected: 0 rows.
select expected.function_name as missing_function
from (values
  ('get_current_account_context'),
  ('get_members'), ('get_admin_member_detail'), ('set_member_role'),
  ('set_member_status'), ('set_lesson_provider_status')
) as expected(function_name)
left join pg_proc p
  on p.proname = expected.function_name and p.pronamespace = 'public'::regnamespace
where p.oid is null;


-- A4. All six functions have a fixed search_path.
-- Expected: 6 rows, all containing 'search_path=public, pg_temp'.
select p.proname, p.proconfig
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname in (
    'get_current_account_context', 'get_members', 'get_admin_member_detail',
    'set_member_role', 'set_member_status', 'set_lesson_provider_status'
  )
  and not exists (
    select 1 from unnest(p.proconfig) cfg where cfg ilike 'search_path=public, pg_temp'
  );
-- Expected: 0 rows (this variant lists any function MISSING the setting).


-- A5. authenticated-only EXECUTE — no anon/PUBLIC EXECUTE on any of the six.
-- Expected: 0 rows.
select routine_name, grantee, privilege_type
from information_schema.routine_privileges
where routine_schema = 'public'
  and routine_name in (
    'get_current_account_context', 'get_members', 'get_admin_member_detail',
    'set_member_role', 'set_member_status', 'set_lesson_provider_status'
  )
  and grantee in ('PUBLIC', 'anon');

-- A5b. Confirm authenticated DOES have EXECUTE on all six.
-- Expected: 6 rows.
select routine_name, grantee, privilege_type
from information_schema.routine_privileges
where routine_schema = 'public'
  and routine_name in (
    'get_current_account_context', 'get_members', 'get_admin_member_detail',
    'set_member_role', 'set_member_status', 'set_lesson_provider_status'
  )
  and grantee = 'authenticated'
  and privilege_type = 'EXECUTE'
order by routine_name;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION B — SOURCE-OF-TRUTH INSPECTION
-- ═══════════════════════════════════════════════════════════════════════════
-- Uses pg_get_functiondef() text search (case-insensitive substring, never
-- exact-format matching) to prove the converted functions reference
-- club_memberships, use the Phase 26B2 helpers where appropriate, and do
-- NOT authorize through or write profiles.role/club_id/status/
-- is_lesson_provider.

-- B1. The five Admin RPCs reference club_memberships directly in their
-- body. get_current_account_context() is intentionally excluded from this
-- check: after the scalar-variable correction, it resolves membership data
-- exclusively through public._current_user_active_membership() and never
-- names club_memberships directly — that is correct, not a regression (see
-- B1b below for its equivalent check).
-- Expected: 5 rows, references_club_memberships = true.
select
  p.proname,
  pg_get_functiondef(p.oid) ilike '%club_memberships%' as references_club_memberships
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname in (
    'get_members', 'get_admin_member_detail',
    'set_member_role', 'set_member_status', 'set_lesson_provider_status'
  )
order by p.proname;


-- B1b. get_current_account_context() resolves membership/club data through
-- _current_user_active_membership(), not by naming club_memberships
-- directly.
-- Expected: 1 row, references_private_helper = true.
select
  p.proname,
  pg_get_functiondef(p.oid) ilike '%_current_user_active_membership()%' as references_private_helper
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname = 'get_current_account_context';


-- B2. The five admin-membership functions use current_user_club_id()
-- and/or current_user_role() for actor authorization (get_current_account_
-- context deliberately does not — it authorizes via a direct auth.uid()
-- check plus its own _current_user_active_membership() call, which is the
-- primitive those two wrapper functions are themselves built on).
-- Expected: 5 rows, all true.
select
  p.proname,
  (pg_get_functiondef(p.oid) ilike '%current_user_club_id()%'
    or pg_get_functiondef(p.oid) ilike '%current_user_role()%') as uses_phase26b2_helper
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname in (
    'get_members', 'get_admin_member_detail', 'set_member_role',
    'set_member_status', 'set_lesson_provider_status'
  )
order by p.proname;


-- B2b. Each of the five Admin RPCs captures current_user_club_id() and
-- current_user_role() TOGETHER in a single `select ... into` statement, not
-- as two separate calls/statements — a separate-statement resolution would
-- let a concurrent account-global active-club switch (set_active_club, a
-- different session) land between them, potentially pairing an Admin role
-- from one club with a different now-active club. Matched via a
-- whitespace/newline-tolerant regex on the semantic pattern (both calls in
-- one statement, in that order, feeding two variables), not on exact
-- formatting — reformatting the migration without changing this logic will
-- not break this check.
-- Expected: 0 rows (any row here is a function NOT using the combined
-- single-statement capture).
select p.proname
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname in (
    'get_members', 'get_admin_member_detail', 'set_member_role',
    'set_member_status', 'set_lesson_provider_status'
  )
  and pg_get_functiondef(p.oid) !~*
    'select\s+public\.current_user_club_id\(\)\s*,\s*public\.current_user_role\(\)\s+into\s+v_actor_club_id\s*,\s*v_actor_role';


-- B2c. Companion check to B2b: current_user_club_id() and
-- current_user_role() each appear exactly once in every one of the five
-- function bodies — catches a leftover/duplicate separate call left in
-- alongside the combined capture, which B2b's presence check alone would
-- not detect.
-- Expected: 5 rows, club_id_call_count = 1 and role_call_count = 1 for
-- every row.
select
  p.proname,
  (length(pg_get_functiondef(p.oid))
    - length(replace(pg_get_functiondef(p.oid), 'current_user_club_id()', '')))
    / length('current_user_club_id()') as club_id_call_count,
  (length(pg_get_functiondef(p.oid))
    - length(replace(pg_get_functiondef(p.oid), 'current_user_role()', '')))
    / length('current_user_role()') as role_call_count
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname in (
    'get_members', 'get_admin_member_detail', 'set_member_role',
    'set_member_status', 'set_lesson_provider_status'
  )
order by p.proname;


-- B3. None of the six functions authorizes the ACTOR through a direct
-- profiles.role/profiles.club_id read (the pre-0083 pattern:
-- `from profiles ... where id = auth.uid()` used for authorization). This
-- is a targeted check for the specific pre-0083 idiom, not a blanket ban on
-- referencing "profiles" at all (every one of these functions still joins
-- profiles for global identity fields like first_name/last_name/phone/
-- email, which is expected and correct).
-- Expected: 0 rows.
select
  p.proname
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname in (
    'get_current_account_context', 'get_members', 'get_admin_member_detail',
    'set_member_role', 'set_member_status', 'set_lesson_provider_status'
  )
  and (
    pg_get_functiondef(p.oid) ilike '%v_profile.role%'
    or pg_get_functiondef(p.oid) ilike '%v_profile.club_id%'
    or pg_get_functiondef(p.oid) ilike '%v_actor.role%'
    or pg_get_functiondef(p.oid) ilike '%v_actor.club_id%'
    or pg_get_functiondef(p.oid) ilike '%v_actor.status%'
  );


-- B4. None of the six functions writes profiles.role, profiles.status, or
-- profiles.is_lesson_provider directly (an explicit `update profiles ...
-- set role|status|is_lesson_provider`). All mutation of those fields must
-- happen only via club_memberships, with migration 0081's Trigger B
-- projecting onto profiles as a side effect.
-- Expected: 0 rows.
select p.proname
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname in (
    'set_member_role', 'set_member_status', 'set_lesson_provider_status'
  )
  and (
    (pg_get_functiondef(p.oid) ilike '%update public.profiles%'
      or pg_get_functiondef(p.oid) ilike '%update profiles%')
    and (
      pg_get_functiondef(p.oid) ilike '%set role%'
      or pg_get_functiondef(p.oid) ilike '%set status%'
      or pg_get_functiondef(p.oid) ilike '%set is_lesson_provider%'
    )
  );


-- B5. Confirm the three mutating functions DO write club_memberships (the
-- positive counterpart of B4 — they must write role/status/
-- is_lesson_provider somewhere, and it must be this table).
-- Expected: 3 rows, all true.
select
  p.proname,
  (pg_get_functiondef(p.oid) ilike '%update public.club_memberships%'
    or pg_get_functiondef(p.oid) ilike '%update club_memberships%') as writes_club_memberships
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname in ('set_member_role', 'set_member_status', 'set_lesson_provider_status')
order by p.proname;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION C — LAST-ADMIN PROTECTION
-- ═══════════════════════════════════════════════════════════════════════════

-- C1. set_member_role and set_member_status both reference every element
-- of the last-admin predicate: active status, removed_at is null, role
-- admin, and the active club scope (current_user_club_id()).
-- Expected: 2 rows, all four booleans true.
select
  p.proname,
  pg_get_functiondef(p.oid) ilike '%status     = ''active''%'
    or pg_get_functiondef(p.oid) ilike '%status = ''active''%'      as checks_active_status,
  pg_get_functiondef(p.oid) ilike '%removed_at is null%'            as checks_removed_at_null,
  pg_get_functiondef(p.oid) ilike '%role       = ''admin''%'
    or pg_get_functiondef(p.oid) ilike '%role = ''admin''%'         as checks_admin_role,
  pg_get_functiondef(p.oid) ilike '%club_id    = v_actor_club_id%'
    or pg_get_functiondef(p.oid) ilike '%club_id = v_actor_club_id%' as scoped_to_active_club
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname in ('set_member_role', 'set_member_status')
order by p.proname;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION D — RLS
-- ═══════════════════════════════════════════════════════════════════════════

-- D1. lesson_requests_select_admin now uses both current_user_club_id() and
-- current_user_role(), and no longer contains the inline profiles.role
-- subquery.
-- Expected: 1 row, uses_current_user_club_id = true,
-- uses_current_user_role = true, uses_inline_profiles_role_subquery = false.
select
  policyname,
  qual as using_expression,
  qual ilike '%current_user_club_id()%'                             as uses_current_user_club_id,
  qual ilike '%current_user_role()%'                                as uses_current_user_role,
  qual ilike '%select role from public.profiles%'
    or qual ilike '%select role from profiles%'                     as uses_inline_profiles_role_subquery
from pg_policies
where schemaname = 'public' and tablename = 'lesson_requests'
  and policyname = 'lesson_requests_select_admin';


-- D2. Member and Pro lesson-request policies are unchanged (sanity check —
-- this migration must not have touched them).
-- Expected: 2 rows, both still present with their original club-scoped
-- shape (member_id/pro_id = auth.uid() and club_id = current_user_club_id()).
select policyname, qual as using_expression
from pg_policies
where schemaname = 'public' and tablename = 'lesson_requests'
  and policyname in ('lesson_requests_select_member', 'lesson_requests_select_pro')
order by policyname;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION E — DATA PARITY (unchanged invariants from 26B1/26B2)
-- ═══════════════════════════════════════════════════════════════════════════

-- E1. Active membership role/status/provider matches the legacy profiles
-- projection for every profile with a non-null active_club_id.
-- Expected: 0 rows.
select
  p.id as profile_id, p.active_club_id,
  p.club_id as legacy_club_id, cm.club_id as membership_club_id,
  p.role as legacy_role, cm.role as membership_role,
  p.status as legacy_status, cm.status as membership_status,
  p.is_lesson_provider as legacy_provider, cm.is_lesson_provider as membership_provider
from public.profiles p
join public.club_memberships cm
  on cm.user_id = p.id and cm.club_id = p.active_club_id
where p.active_club_id is not null
  and (p.club_id is distinct from cm.club_id
    or p.role is distinct from cm.role
    or p.status is distinct from cm.status
    or p.is_lesson_provider is distinct from cm.is_lesson_provider);


-- E2. No duplicate (user_id, club_id) memberships.
-- Expected: 0 rows.
select user_id, club_id, count(*) as row_count
from public.club_memberships
group by user_id, club_id
having count(*) > 1;


-- E3. Every non-null active_club_id resolves to a live, active, non-removed
-- membership belonging to the same user.
-- Expected: 0 rows.
select p.id as profile_id, p.active_club_id
from public.profiles p
where p.active_club_id is not null
  and not exists (
    select 1 from public.club_memberships cm
     where cm.user_id = p.id
       and cm.club_id = p.active_club_id
       and cm.status = 'active'
       and cm.removed_at is null
  );


-- E4. Inactive/suspended profiles have active_club_id NULL (26B1 invariant,
-- re-confirmed here since it underlies get_current_account_context's
-- "no valid active membership" behavior for such users).
-- Expected: 0 rows.
select id, club_id, status, active_club_id
from public.profiles
where club_id is not null
  and status in ('inactive', 'suspended')
  and active_club_id is not null;
