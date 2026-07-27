-- verify_phase26b2.sql
-- Phase 26B2: Active-Club Authorization Foundation — verification.
-- Run in the Supabase SQL Editor AFTER applying migration
-- 0082_active_club_authorization_foundation.sql (which itself requires
-- 0081_club_membership_compatibility_foundation.sql already applied).
--
-- READ-ONLY. Every statement in this file is a SELECT. No row is inserted,
-- updated, or deleted. Safe to run multiple times, in production, at any
-- time.
--
-- How to use:
--   1. Apply migration 0082.
--   2. Paste this entire file into the SQL Editor and run it.
--   3. Every "Expected: 0 rows" check must return zero rows.
--      Every "Expected: N rows" / "EXISTS" check must match.
--
-- IMPORTANT — this file does NOT call current_user_club_id(),
-- current_user_role(), current_user_is_lesson_provider(), or
-- set_active_club() directly. A plain SQL Editor session has no
-- application JWT, so auth.uid() would resolve to NULL and every one of
-- those calls would misleadingly return NULL/empty regardless of whether
-- the function is correct. Section D below proves equivalence with pure,
-- auth.uid()-independent data queries instead. The one thing that
-- genuinely requires an authenticated session — set_active_club's
-- behavior under a real auth.uid() — is covered separately in
-- QA_phase26b2.md's transactional authenticated test, never here.
-- ─────────────────────────────────────────────────────────────────────────────


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION A — FUNCTION DEFINITIONS
-- ═══════════════════════════════════════════════════════════════════════════

-- A1. All five functions introduced/redefined by 0082 exist, with the
-- expected security/volatility/search_path posture.
-- Expected: 5 rows. is_security_definer = true for all. provolatile: 's'
-- (stable) for the four read helpers, 'v' (volatile, the plpgsql default)
-- for set_active_club — STABLE is not valid for a function that writes.
-- search_path_setting must contain 'search_path=public, pg_temp' for all 5.
select
  p.proname as function_name,
  p.prosecdef as is_security_definer,
  case p.provolatile
    when 'i' then 'IMMUTABLE'
    when 's' then 'STABLE'
    when 'v' then 'VOLATILE'
  end as volatility,
  p.proconfig as search_path_setting,
  pg_get_function_result(p.oid) as return_type,
  pg_get_function_arguments(p.oid) as arguments
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    '_current_user_active_membership',
    'current_user_club_id',
    'current_user_role',
    'current_user_is_lesson_provider',
    'set_active_club'
  )
order by p.proname;


-- A2. Missing functions.
-- Expected: 0 rows.
select expected.function_name as missing_function
from (values
  ('_current_user_active_membership'),
  ('current_user_club_id'),
  ('current_user_role'),
  ('current_user_is_lesson_provider'),
  ('set_active_club')
) as expected(function_name)
left join pg_proc p
  on p.proname = expected.function_name
 and p.pronamespace = 'public'::regnamespace
where p.oid is null;


-- A3. current_user_club_id() and current_user_role() preserved their exact
-- pre-0082 name, zero-argument signature, and return type (uuid / text).
-- Expected: 2 rows, arguments = '' (empty), matching original signatures.
select p.proname, pg_get_function_arguments(p.oid) as arguments,
       pg_get_function_result(p.oid) as return_type
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname in ('current_user_club_id', 'current_user_role')
order by p.proname;


-- A4. set_active_club(uuid) return contract — exact column set and order.
-- Expected: 1 row, returning table(club_id uuid, role text, status text,
-- is_lesson_provider boolean).
select pg_get_function_result(oid) as return_contract
from pg_proc
where pronamespace = 'public'::regnamespace and proname = 'set_active_club';


-- A5. Private helper has NO EXECUTE grant to PUBLIC, anon, or authenticated
-- (not exposed through PostgREST to any client role).
-- Expected: 0 rows.
select routine_name, grantee, privilege_type
from information_schema.routine_privileges
where routine_schema = 'public'
  and routine_name = '_current_user_active_membership'
  and grantee in ('PUBLIC', 'anon', 'authenticated');


-- A6. The four public wrapper/setter functions have EXECUTE granted to
-- authenticated and NOT to anon or PUBLIC.
-- Expected: exactly 4 rows, one per function, grantee = 'authenticated'.
select routine_name, grantee, privilege_type
from information_schema.routine_privileges
where routine_schema = 'public'
  and routine_name in (
    'current_user_club_id', 'current_user_role',
    'current_user_is_lesson_provider', 'set_active_club'
  )
  and privilege_type = 'EXECUTE'
order by routine_name;


-- A7. Confirm no anon/PUBLIC EXECUTE leaked onto the four public wrappers.
-- Expected: 0 rows.
select routine_name, grantee, privilege_type
from information_schema.routine_privileges
where routine_schema = 'public'
  and routine_name in (
    'current_user_club_id', 'current_user_role',
    'current_user_is_lesson_provider', 'set_active_club'
  )
  and grantee in ('PUBLIC', 'anon');


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION B — DATA READINESS
-- ═══════════════════════════════════════════════════════════════════════════

-- B1. Every non-null active_club_id still resolves to an active, non-removed
-- membership belonging to the same user (identical to 0081's B7 check —
-- re-run here since 0082's correctness depends entirely on this holding).
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


-- B2. Active profile legacy fields match the selected (active) membership.
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


-- B3. Inactive/suspended/removed memberships are never the one referenced
-- by any profile's active_club_id.
-- Expected: 0 rows.
select p.id as profile_id, p.active_club_id, cm.status, cm.removed_at
from public.profiles p
join public.club_memberships cm
  on cm.user_id = p.id and cm.club_id = p.active_club_id
where p.active_club_id is not null
  and (cm.status <> 'active' or cm.removed_at is not null);


-- B4. No membership duplicates.
-- Expected: 0 rows.
select user_id, club_id, count(*) as row_count
from public.club_memberships
group by user_id, club_id
having count(*) > 1;


-- B5. Phase 26B1 parity checks remain green post-0082 (0082 does not touch
-- club_memberships or the backfill, but this confirms nothing regressed).
-- Expected: 0 rows.
select id, club_id, status, active_club_id
from public.profiles
where club_id is not null and status = 'active'
  and active_club_id is distinct from club_id;

select id, club_id, status, active_club_id
from public.profiles
where club_id is not null and status in ('inactive', 'suspended')
  and active_club_id is not null;

select id, club_id, active_club_id
from public.profiles
where club_id is null and active_club_id is not null;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION C — POLICY INVENTORY
-- ═══════════════════════════════════════════════════════════════════════════

-- C1. Every RLS policy whose definition references current_user_club_id or
-- current_user_role, across every table. This is the exact set of policies
-- whose behavior changes as a direct consequence of 0082's redefinition
-- (their SQL text is unchanged for 33 of them — only what the two functions
-- resolve to changes; two of them, profiles_select_same_club and
-- profiles_update_own_row, ALSO have new SQL text, see Section E below).
-- Expected: 34 rows — NOT 35. profiles_update_own_row's corrected WITH
-- CHECK (`id = auth.uid()` only) no longer contains either helper's name at
-- all, so it drops out of this filter entirely; profiles_select_same_club
-- remains in the set (its new USING clause still calls
-- current_user_club_id()). 35 policies referenced a helper before 0082; 34
-- do after, with profiles_select_same_club's text changed but still
-- present, and profiles_update_own_row no longer matching this filter by
-- name (its own-row check needs no helper at all now — see Section E for
-- its exact new text).
select
  schemaname, tablename, policyname, cmd,
  qual as using_expression,
  with_check as with_check_expression
from pg_policies
where schemaname = 'public'
  and (qual ilike '%current_user_club_id%' or qual ilike '%current_user_role%'
    or with_check ilike '%current_user_club_id%' or with_check ilike '%current_user_role%')
order by tablename, policyname;


-- C2. Policy count that references either helper — a single number to
-- compare against the Phase 26B2 report's baseline on every future run.
select count(*) as policy_count_using_helpers
from pg_policies
where schemaname = 'public'
  and (qual ilike '%current_user_club_id%' or qual ilike '%current_user_role%'
    or with_check ilike '%current_user_club_id%' or with_check ilike '%current_user_role%');


-- C3. Known PARTIAL bypass — lesson_requests_select_admin uses
-- current_user_club_id() for its club check (and so DOES benefit from
-- 0082's fail-closed improvement for that half), but reads
-- `(select role from public.profiles where id = auth.uid())` directly for
-- its admin-role check, bypassing current_user_role() entirely for that
-- half. Confirms this specific, previously-audited exception still exists
-- exactly as documented (not silently changed by 0082, which does not
-- touch it) and has not spread to any other policy.
-- Expected: 1 row, using_expression containing both
-- 'current_user_club_id()' and the inline 'select role from
-- public.profiles' subquery.
select schemaname, tablename, policyname, qual as using_expression
from pg_policies
where schemaname = 'public'
  and tablename = 'lesson_requests'
  and policyname = 'lesson_requests_select_admin';


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION D — STATIC PARITY (no auth.uid() dependency)
-- ═══════════════════════════════════════════════════════════════════════════
-- Proves, using only ordinary data queries (never by calling the helper
-- functions, which would be meaningless without a real JWT session), that
-- for every profile the new helpers WOULD resolve — via
-- club_memberships/active_club_id, exactly as their bodies do — to the same
-- values the OLD helpers read directly off profiles. This is the strongest
-- claim this script can make without an authenticated session; the actual
-- authenticated behavior is proven separately in QA_phase26b2.md.

-- D1. current_user_club_id() parity: for every active profile with a club,
-- the membership-derived value (what the new helper computes) equals the
-- legacy profiles.club_id value (what the old helper used to return).
-- Expected: 0 rows.
select p.id as profile_id, p.club_id as old_helper_would_return,
       cm.club_id as new_helper_would_return
from public.profiles p
join public.club_memberships cm
  on cm.user_id = p.id and cm.club_id = p.active_club_id
 and cm.status = 'active' and cm.removed_at is null
where p.club_id is not null and p.status = 'active'
  and p.club_id is distinct from cm.club_id;


-- D2. current_user_role() parity.
-- Expected: 0 rows.
select p.id as profile_id, p.role as old_helper_would_return,
       cm.role as new_helper_would_return
from public.profiles p
join public.club_memberships cm
  on cm.user_id = p.id and cm.club_id = p.active_club_id
 and cm.status = 'active' and cm.removed_at is null
where p.club_id is not null and p.status = 'active'
  and p.role is distinct from cm.role;


-- D3. current_user_is_lesson_provider() parity.
-- Expected: 0 rows.
select p.id as profile_id, p.is_lesson_provider as old_value,
       cm.is_lesson_provider as new_helper_would_return
from public.profiles p
join public.club_memberships cm
  on cm.user_id = p.id and cm.club_id = p.active_club_id
 and cm.status = 'active' and cm.removed_at is null
where p.club_id is not null and p.status = 'active'
  and p.is_lesson_provider is distinct from cm.is_lesson_provider;


-- D4. Coverage check: every active, club-having profile actually has a row
-- to join against in D1-D3 (i.e. the parity checks above aren't vacuously
-- true because the join silently excluded rows with no match).
-- Expected: 0 rows. Any row here means D1-D3 could not evaluate that
-- profile at all — a gap distinct from a parity mismatch.
select p.id as profile_id, p.club_id, p.status
from public.profiles p
where p.club_id is not null
  and p.status = 'active'
  and not exists (
    select 1 from public.club_memberships cm
     where cm.user_id = p.id and cm.club_id = p.active_club_id
       and cm.status = 'active' and cm.removed_at is null
  );


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION E — PROFILES RLS CORRECTIONS (profiles_select_same_club,
-- profiles_update_own_row)
-- ═══════════════════════════════════════════════════════════════════════════

-- E1. profiles_select_same_club — exact current USING expression. Confirm
-- by inspection it is exactly `(id = auth.uid()) OR (club_id =
-- current_user_club_id())` and nothing broader (no reference to any other
-- table, no OR-ed-in condition beyond these two, no reference to
-- active_club_id, role, or status).
-- Expected: 1 row.
select schemaname, tablename, policyname, cmd,
       qual as using_expression, with_check as with_check_expression
from pg_policies
where schemaname = 'public'
  and tablename = 'profiles'
  and policyname = 'profiles_select_same_club';

-- E1b. Machine check that the USING expression contains exactly the two
-- expected branches and nothing else recognizable as a third condition.
-- Expected: 1 row, is_own_row_branch_present = true,
-- is_active_club_branch_present = true, mentions_active_club_id = false,
-- mentions_role_or_status = false.
select
  qual ilike '%id = auth.uid()%' as is_own_row_branch_present,
  qual ilike '%current_user_club_id()%' as is_active_club_branch_present,
  qual ilike '%active_club_id%' as mentions_active_club_id,
  (qual ilike '%role%' or qual ilike '%status%') as mentions_role_or_status
from pg_policies
where schemaname = 'public' and tablename = 'profiles'
  and policyname = 'profiles_select_same_club';


-- E2. profiles_update_own_row — exact current USING/WITH CHECK. Confirm
-- both are own-row-only: `id = auth.uid()`, with no role/status/club
-- comparison of any kind.
-- Expected: 1 row.
select schemaname, tablename, policyname, cmd,
       qual as using_expression, with_check as with_check_expression
from pg_policies
where schemaname = 'public'
  and tablename = 'profiles'
  and policyname = 'profiles_update_own_row';

-- E2b. Machine check that neither expression references role, status,
-- current_user_role, current_user_club_id, club_id, or active_club_id —
-- i.e. the sensitive-column boundary is not (and does not need to be)
-- re-implemented in RLS text at all.
-- Expected: 1 row, both booleans false.
select
  (qual ilike '%role%' or qual ilike '%status%' or qual ilike '%club_id%'
    or qual ilike '%current_user_%') as using_references_sensitive_state,
  (with_check ilike '%role%' or with_check ilike '%status%' or with_check ilike '%club_id%'
    or with_check ilike '%current_user_%') as with_check_references_sensitive_state
from pg_policies
where schemaname = 'public' and tablename = 'profiles'
  and policyname = 'profiles_update_own_row';


-- E3. Column-level grants — authenticated UPDATE on profiles remains
-- limited to exactly first_name, last_name, phone (migration 0079,
-- unchanged by 0082). This is the boundary profiles_update_own_row's
-- comment now explicitly relies on instead of an RLS role check.
-- Expected: 3 rows — first_name, last_name, phone. No other column,
-- and specifically none of club_id, active_club_id, role, status,
-- is_lesson_provider, or admin_notes.
select column_name
from information_schema.column_privileges
where table_schema = 'public'
  and table_name = 'profiles'
  and grantee = 'authenticated'
  and privilege_type = 'UPDATE'
order by column_name;

-- E3b. Explicit check that none of the sensitive columns are UPDATE-
-- granted to authenticated.
-- Expected: 0 rows.
select column_name
from information_schema.column_privileges
where table_schema = 'public'
  and table_name = 'profiles'
  and grantee = 'authenticated'
  and privilege_type = 'UPDATE'
  and column_name in (
    'club_id', 'active_club_id', 'role', 'status',
    'is_lesson_provider', 'admin_notes'
  );
