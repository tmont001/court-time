-- verify_phase26d1.sql
-- Phase 26D1: Additional-Club Invitation Acceptance — verification.
-- Run in the Supabase SQL Editor AFTER applying migration
-- 0084_additional_club_invitation_acceptance.sql (requires 0081-0083
-- already applied).
--
-- READ-ONLY. Every statement is a SELECT. Safe to run repeatedly, in
-- production, at any time. Source-of-truth checks use case-insensitive
-- substring/regex matching on pg_get_functiondef(), not exact formatting.
-- ─────────────────────────────────────────────────────────────────────────────


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION A — FUNCTION SIGNATURE AND GRANTS
-- ═══════════════════════════════════════════════════════════════════════════

-- A1. accept_club_invite(text) exists, unchanged signature/return type,
-- SECURITY DEFINER, VOLATILE (correct — it writes), fixed search_path.
-- Expected: 1 row, arguments = 'p_code text', return_type = 'jsonb',
-- is_security_definer = true, volatility = 'VOLATILE'.
select
  p.proname,
  pg_get_function_arguments(p.oid) as arguments,
  pg_get_function_result(p.oid)    as return_type,
  p.prosecdef                      as is_security_definer,
  case p.provolatile when 's' then 'STABLE' when 'v' then 'VOLATILE' when 'i' then 'IMMUTABLE' end as volatility,
  p.proconfig as search_path_setting
from pg_proc p
where p.pronamespace = 'public'::regnamespace and p.proname = 'accept_club_invite';

-- A2. authenticated-only EXECUTE, no anon/PUBLIC.
-- Expected: 1 row (authenticated) from the first query, 0 rows from the second.
select routine_name, grantee, privilege_type
from information_schema.routine_privileges
where routine_schema = 'public' and routine_name = 'accept_club_invite'
  and grantee = 'authenticated' and privilege_type = 'EXECUTE';

select routine_name, grantee, privilege_type
from information_schema.routine_privileges
where routine_schema = 'public' and routine_name = 'accept_club_invite'
  and grantee in ('PUBLIC', 'anon');


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION B — SOURCE-OF-TRUTH INSPECTION
-- ═══════════════════════════════════════════════════════════════════════════

-- B1. References club_memberships; does not write profiles.role/status/
-- is_lesson_provider directly (first_name/last_name/phone writes for the
-- roster auto-link are expected and excluded from this check).
-- Expected: 1 row, references_club_memberships = true,
-- writes_legacy_role_status_provider = false.
select
  pg_get_functiondef(p.oid) ilike '%club_memberships%' as references_club_memberships,
  (pg_get_functiondef(p.oid) ilike '%set role%'
    or pg_get_functiondef(p.oid) ilike '%set status%'
    or pg_get_functiondef(p.oid) ilike '%set is_lesson_provider%') as writes_legacy_role_status_provider
from pg_proc p
where p.pronamespace = 'public'::regnamespace and p.proname = 'accept_club_invite';

-- B2. Invite validation covers expiration, revocation, use, and email
-- matching; destination-membership conflict handling and set_active_club
-- reuse are present.
-- Expected: 1 row, all six booleans true.
select
  pg_get_functiondef(p.oid) ilike '%expires_at%'                    as checks_expiration,
  pg_get_functiondef(p.oid) ilike '%revoked_at%'                    as checks_revocation,
  pg_get_functiondef(p.oid) ilike '%accepted_at%'                   as checks_use,
  pg_get_functiondef(p.oid) ilike '%lower(v_auth_email)%'           as checks_email_match,
  (pg_get_functiondef(p.oid) ilike '%already_member%'
    and pg_get_functiondef(p.oid) ilike '%membership_state_conflict%') as has_conflict_handling,
  pg_get_functiondef(p.oid) ilike '%set_active_club(%'              as reuses_set_active_club
from pg_proc p
where p.pronamespace = 'public'::regnamespace and p.proname = 'accept_club_invite';

-- B3. Never accepts a caller-controlled user id: every club_memberships
-- reference is scoped by auth.uid(), never by a bare p_code-derived value.
-- (Sanity check only — confirms auth.uid() appears in the membership
-- lookup/insert region of the body.)
-- Expected: 1 row, uses_auth_uid = true.
select pg_get_functiondef(p.oid) ilike '%auth.uid()%' as uses_auth_uid
from pg_proc p
where p.pronamespace = 'public'::regnamespace and p.proname = 'accept_club_invite';


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION C — DATA INVARIANTS
-- ═══════════════════════════════════════════════════════════════════════════

-- C1. No duplicate (user_id, club_id) memberships (unique invariant,
-- structurally guaranteed by the constraint — sanity check).
-- Expected: 0 rows.
select user_id, club_id, count(*) from public.club_memberships
group by user_id, club_id having count(*) > 1;

-- C2. Every non-null active_club_id resolves to a live, active, non-removed
-- membership belonging to the same user (26B1/26B2 invariant, re-confirmed
-- since accept_club_invite now writes this path for a second scenario).
-- Expected: 0 rows.
select p.id from public.profiles p
where p.active_club_id is not null
  and not exists (
    select 1 from public.club_memberships cm
     where cm.user_id = p.id and cm.club_id = p.active_club_id
       and cm.status = 'active' and cm.removed_at is null
  );

-- C3. Legacy projection parity (26B1/26B2/26C1 invariant) — active
-- membership role/status/provider matches profiles' legacy columns.
-- Expected: 0 rows.
select p.id from public.profiles p
join public.club_memberships cm on cm.user_id = p.id and cm.club_id = p.active_club_id
where p.active_club_id is not null
  and (p.club_id is distinct from cm.club_id
    or p.role is distinct from cm.role
    or p.status is distinct from cm.status
    or p.is_lesson_provider is distinct from cm.is_lesson_provider);

-- C4. No club_invites row is both accepted and still unconsumed-looking
-- (accepted_at set implies accepted_by set) — sanity check on invite
-- consumption bookkeeping, unaffected in shape by this migration but worth
-- reconfirming since acceptance now has two source scenarios.
-- Expected: 0 rows.
select id from public.club_invites
where accepted_at is not null and accepted_by is null;
