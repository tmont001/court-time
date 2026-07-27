-- verify_phase26e1.sql
-- Phase 26E1: Membership List and Club Switcher — verification.
-- Run in the Supabase SQL Editor AFTER applying migration
-- 0085_my_club_memberships.sql (requires 0081-0084 already applied).
--
-- READ-ONLY. Every statement is a SELECT. Safe to run repeatedly, in
-- production, at any time.
-- ─────────────────────────────────────────────────────────────────────────────


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION A — RPC SIGNATURE, SECURITY, GRANTS
-- ═══════════════════════════════════════════════════════════════════════════

-- A1. get_my_club_memberships() exists with the expected contract:
-- SECURITY DEFINER, STABLE, fixed search_path, and the exact 7-column
-- return shape.
-- Expected: 1 row, is_security_definer = true, volatility = 'STABLE'.
select
  p.proname,
  pg_get_function_arguments(p.oid) as arguments,
  pg_get_function_result(p.oid)    as return_type,
  p.prosecdef                      as is_security_definer,
  case p.provolatile when 's' then 'STABLE' when 'v' then 'VOLATILE' when 'i' then 'IMMUTABLE' end as volatility,
  p.proconfig as search_path_setting
from pg_proc p
where p.pronamespace = 'public'::regnamespace and p.proname = 'get_my_club_memberships';

-- A2. authenticated-only EXECUTE; no anon/PUBLIC.
-- Expected: 1 row (authenticated) from the first query, 0 rows from the second.
select routine_name, grantee, privilege_type
from information_schema.routine_privileges
where routine_schema = 'public' and routine_name = 'get_my_club_memberships'
  and grantee = 'authenticated' and privilege_type = 'EXECUTE';

select routine_name, grantee, privilege_type
from information_schema.routine_privileges
where routine_schema = 'public' and routine_name = 'get_my_club_memberships'
  and grantee in ('PUBLIC', 'anon');

-- A3. No direct authenticated SELECT grant on club_memberships (unchanged
-- from migration 0081 — this migration must not have altered it).
-- Expected: 0 rows.
select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'club_memberships'
  and grantee in ('anon', 'authenticated');


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION B — SOURCE-OF-TRUTH INSPECTION
-- ═══════════════════════════════════════════════════════════════════════════

-- B1. Scoped by auth.uid() only — no caller-controlled user-id parameter;
-- filters on status = 'active' and removed_at is null.
-- Expected: 1 row, all three booleans true.
select
  pg_get_functiondef(p.oid) ilike '%cm.user_id = auth.uid()%'    as scoped_by_auth_uid,
  pg_get_functiondef(p.oid) ilike '%status = ''active''%'        as filters_active_status,
  pg_get_functiondef(p.oid) ilike '%removed_at is null%'         as filters_non_removed
from pg_proc p
where p.pronamespace = 'public'::regnamespace and p.proname = 'get_my_club_memberships';

-- B2. Function argument list is empty (no p_user_id-style parameter of any
-- kind could be accepted even if the body ignored auth.uid()).
-- Expected: 1 row, arguments = '' (empty).
select pg_get_function_arguments(p.oid) as arguments
from pg_proc p
where p.pronamespace = 'public'::regnamespace and p.proname = 'get_my_club_memberships';


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION C — DATA INVARIANTS (unchanged from 26B1/26B2/26C1/26D1)
-- ═══════════════════════════════════════════════════════════════════════════

-- C1. No duplicate (user_id, club_id) memberships.
-- Expected: 0 rows.
select user_id, club_id, count(*) from public.club_memberships
group by user_id, club_id having count(*) > 1;

-- C2. Every non-null active_club_id resolves to a live, active, non-removed
-- membership belonging to the same user — this is exactly the set of rows
-- get_my_club_memberships() must be able to mark is_active_club = true for.
-- Expected: 0 rows.
select p.id from public.profiles p
where p.active_club_id is not null
  and not exists (
    select 1 from public.club_memberships cm
     where cm.user_id = p.id and cm.club_id = p.active_club_id
       and cm.status = 'active' and cm.removed_at is null
  );

-- C3. Legacy projection parity — active membership role/status/provider
-- matches profiles' legacy columns.
-- Expected: 0 rows.
select p.id from public.profiles p
join public.club_memberships cm on cm.user_id = p.id and cm.club_id = p.active_club_id
where p.active_club_id is not null
  and (p.club_id is distinct from cm.club_id
    or p.role is distinct from cm.role
    or p.status is distinct from cm.status
    or p.is_lesson_provider is distinct from cm.is_lesson_provider);

-- C4. Any user with two or more active, non-removed memberships has
-- exactly one of them marked as the active club (i.e. active_club_id is
-- always one of that user's own active memberships, never ambiguous or
-- pointing outside the set) — the exact invariant the switcher's "current
-- club" marker depends on.
-- Expected: 0 rows.
select cm.user_id
from public.club_memberships cm
where cm.status = 'active' and cm.removed_at is null
group by cm.user_id
having count(*) > 1
   and sum(case when cm.club_id = (select active_club_id from public.profiles p where p.id = cm.user_id)
                then 1 else 0 end) <> 1;
