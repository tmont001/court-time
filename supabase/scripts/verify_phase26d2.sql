-- verify_phase26d2.sql
-- Phase 26D2: Per-Club Membership Administration — verification.
-- Run in the Supabase SQL Editor AFTER applying migration
-- 0086_per_club_membership_administration.sql (requires 0081-0085 already
-- applied).
--
-- READ-ONLY. Every statement is a SELECT. Safe to run repeatedly, in
-- production, at any time.
-- ─────────────────────────────────────────────────────────────────────────────


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION A — FUNCTION SIGNATURES, SECURITY, GRANTS
-- ═══════════════════════════════════════════════════════════════════════════

-- A1. The three changed/new functions exist with expected security posture.
-- Expected: 3 rows, all SECURITY DEFINER, fixed search_path.
select
  p.proname,
  pg_get_function_arguments(p.oid) as arguments,
  pg_get_function_result(p.oid)    as return_type,
  p.prosecdef                      as is_security_definer,
  p.proconfig                      as search_path_setting
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname in ('set_member_status', 'remove_club_member', 'restore_club_member')
order by p.proname;

-- A2. get_members()/get_admin_member_detail(uuid) return contracts now
-- include removed_at.
-- Expected: 2 rows, both return_type text containing 'removed_at'.
select
  p.proname,
  pg_get_function_result(p.oid) ilike '%removed_at%' as includes_removed_at
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname in ('get_members', 'get_admin_member_detail')
order by p.proname;

-- A3. authenticated-only EXECUTE on the two new functions; no anon/PUBLIC.
-- Expected: 2 rows (authenticated) from the first query, 0 rows from the second.
select routine_name, grantee, privilege_type
from information_schema.routine_privileges
where routine_schema = 'public'
  and routine_name in ('remove_club_member', 'restore_club_member')
  and grantee = 'authenticated' and privilege_type = 'EXECUTE';

select routine_name, grantee, privilege_type
from information_schema.routine_privileges
where routine_schema = 'public'
  and routine_name in ('remove_club_member', 'restore_club_member')
  and grantee in ('PUBLIC', 'anon');


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION B — SOURCE-OF-TRUTH INSPECTION
-- ═══════════════════════════════════════════════════════════════════════════

-- B1. Function-specific source checks — each function is expected to
-- mention different things (set_member_status has no reason to reference
-- removed_at/removed_by; remove_club_member/restore_club_member have no
-- reason to reference 'suspended'), so no single "all booleans true for
-- every row" expectation applies across all three. None of the three may
-- write profiles.role/status/is_lesson_provider directly, regardless.

-- B1a. set_member_status references 'suspended' and does not write legacy
-- profile fields.
-- Expected: 1 row, mentions_suspended = true, writes_legacy_fields = false.
select
  p.proname,
  pg_get_functiondef(p.oid) ilike '%suspended%' as mentions_suspended,
  (pg_get_functiondef(p.oid) ilike '%update public.profiles%'
    and (pg_get_functiondef(p.oid) ilike '%set role%'
      or pg_get_functiondef(p.oid) ilike '%set status%'
      or pg_get_functiondef(p.oid) ilike '%set is_lesson_provider%')) as writes_legacy_fields
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname = 'set_member_status';

-- B1b. remove_club_member references removed_at and removed_by and does
-- not write legacy profile fields.
-- Expected: 1 row, both mention booleans true, writes_legacy_fields false.
select
  p.proname,
  pg_get_functiondef(p.oid) ilike '%removed_at%' as mentions_removed_at,
  pg_get_functiondef(p.oid) ilike '%removed_by%' as mentions_removed_by,
  (pg_get_functiondef(p.oid) ilike '%update public.profiles%'
    and (pg_get_functiondef(p.oid) ilike '%set role%'
      or pg_get_functiondef(p.oid) ilike '%set status%'
      or pg_get_functiondef(p.oid) ilike '%set is_lesson_provider%')) as writes_legacy_fields
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname = 'remove_club_member';

-- B1c. restore_club_member references removed_at and removed_by and does
-- not write legacy profile fields.
-- Expected: 1 row, both mention booleans true, writes_legacy_fields false.
select
  p.proname,
  pg_get_functiondef(p.oid) ilike '%removed_at%' as mentions_removed_at,
  pg_get_functiondef(p.oid) ilike '%removed_by%' as mentions_removed_by,
  (pg_get_functiondef(p.oid) ilike '%update public.profiles%'
    and (pg_get_functiondef(p.oid) ilike '%set role%'
      or pg_get_functiondef(p.oid) ilike '%set status%'
      or pg_get_functiondef(p.oid) ilike '%set is_lesson_provider%')) as writes_legacy_fields
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname = 'restore_club_member';

-- B2. Last-admin guard in set_member_status and remove_club_member requires
-- the target's CURRENT status to already be 'active' (the corrected
-- precondition — see the migration header for why the pre-0086 pattern was
-- insufficient once 'suspended' and removal exist).
-- Expected: 2 rows, both true.
select
  p.proname,
  pg_get_functiondef(p.oid) ilike '%v_target.status = ''active''%' as requires_target_currently_active
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname in ('set_member_status', 'remove_club_member')
order by p.proname;

-- B3. Every function scopes its target strictly to v_actor_club_id (never a
-- caller-controlled or unscoped club id) and captures actor club/role in
-- one statement (the established 0083 pattern).
-- Expected: 3 rows, both booleans true.
select
  p.proname,
  pg_get_functiondef(p.oid) ilike '%cm.club_id = v_actor_club_id%'                      as scoped_to_actor_club,
  pg_get_functiondef(p.oid) ilike '%select public.current_user_club_id(), public.current_user_role()%' as captures_actor_atomically
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname in ('set_member_status', 'remove_club_member', 'restore_club_member')
order by p.proname;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION C — DATA INVARIANTS
-- ═══════════════════════════════════════════════════════════════════════════

-- C1. Status vocabulary intact — no unexpected values.
-- Expected: 0 rows.
select id, status from public.club_memberships
where status not in ('active', 'inactive', 'suspended');

-- C2. removed_at/removed_by consistency. removed_by references
-- profiles(id) ON DELETE SET NULL, so a legitimately removed membership can
-- end up with removed_at populated and removed_by NULL (the removing
-- admin's own profile was later deleted) — that combination is valid, not
-- an invariant violation. The only invalid combination is the reverse:
-- removed_by populated while removed_at is NULL, which should never be
-- reachable through remove_club_member/restore_club_member.
-- Expected: 0 rows.
select id from public.club_memberships
where removed_at is null and removed_by is not null;

-- C3. No duplicate (user_id, club_id) memberships (unique invariant,
-- unaffected by this checkpoint — sanity re-check).
-- Expected: 0 rows.
select user_id, club_id, count(*) from public.club_memberships
group by user_id, club_id having count(*) > 1;

-- C4. Every non-null active_club_id resolves to a live, active, non-removed
-- membership belonging to the same user — the invariant remove/restore and
-- the extended set_member_status must all preserve via 0081's Trigger B.
-- Expected: 0 rows.
select p.id from public.profiles p
where p.active_club_id is not null
  and not exists (
    select 1 from public.club_memberships cm
     where cm.user_id = p.id and cm.club_id = p.active_club_id
       and cm.status = 'active' and cm.removed_at is null
  );

-- C5. Legacy projection parity (26B1/26B2/26C1/26D1 invariant) — active
-- membership role/status/provider matches profiles' legacy columns.
-- Expected: 0 rows.
select p.id from public.profiles p
join public.club_memberships cm on cm.user_id = p.id and cm.club_id = p.active_club_id
where p.active_club_id is not null
  and (p.club_id is distinct from cm.club_id
    or p.role is distinct from cm.role
    or p.status is distinct from cm.status
    or p.is_lesson_provider is distinct from cm.is_lesson_provider);

-- (Removed: a prior C6 asserted every club has at least one active,
-- non-removed admin as an expected-zero check. The database already
-- contains test/placeholder clubs with no active admin, so that condition
-- is not a valid migration invariant — it would fail today independent of
-- this checkpoint, and this script must not be read as calling for
-- production data changes to satisfy it. Last-admin protection itself
-- remains covered by the source-definition checks in B2 and by
-- QA_phase26d2.md's "Last-admin protection" and "Last-admin guard does not
-- over-block" scenarios, which test the guard's *behavior* directly rather
-- than inferring it from a whole-database snapshot.)
