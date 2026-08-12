-- verify_phase33d1.sql
-- Phase 33D1: Staff-Managed Lessons — Identity Foundation — POST-migration
-- verification for 0111_staff_managed_lessons_identity.sql.
--
-- Run in the Supabase SQL Editor AFTER 0111 has been applied. Every query
-- is read-only — safe to run against a live database. Where a query should
-- return an empty result set or a specific value for PASS, that is stated
-- beneath it. Text-pattern function-body checks are not a full behavioral
-- proof — if any is false, read the function directly with
-- `select pg_get_functiondef(oid) from pg_proc where proname = '<name>'`
-- and confirm by eye.
--
-- Rollback notes: see the "Rollback procedure" comment block at the end of
-- 0111_staff_managed_lessons_identity.sql if any check here fails.

-- ── A. lesson_requests schema ───────────────────────────────────────────────
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name   = 'lesson_requests'
  and column_name  in ('member_id', 'roster_member_id')
order by column_name;
-- Expect: 2 rows. member_id: is_nullable = 'YES'. roster_member_id:
-- data_type = 'uuid', is_nullable = 'NO'.

select conname, confdeltype
from pg_constraint c
join pg_class t on t.oid = c.conrelid
where t.relname = 'lesson_requests'
  and c.contype = 'f'
  and c.conname = 'lesson_requests_roster_member_id_fkey';
-- Expect: exactly 1 row.

select count(*) as lesson_requests_missing_roster_identity
from public.lesson_requests
where roster_member_id is null;
-- Expect: 0 (enforced by the NOT NULL constraint itself — this is a
-- redundant belt-and-suspenders check).

-- ── B. Every lesson_requests row's roster identity is correctly resolved ───
-- Every row with a non-null member_id must have roster_member_id pointing
-- at the SAME roster identity that member_id/club_id resolves to via
-- claimed_by — confirms the backfill (and, going forward, every write
-- path) never drifts the two apart.
select lr.id, lr.member_id, lr.roster_member_id, rm.claimed_by, rm.club_id as roster_club_id, lr.club_id as lesson_club_id
from public.lesson_requests lr
join public.roster_members rm on rm.id = lr.roster_member_id
where lr.member_id is not null
  and (rm.claimed_by is distinct from lr.member_id or rm.club_id is distinct from lr.club_id);
-- Expect: 0 rows.

-- ── C. New RPCs — signatures, security, grants ──────────────────────────────
select
  p.proname                                  as function_name,
  pg_get_function_identity_arguments(p.oid)  as args,
  p.prosecdef                                as is_security_definer,
  p.proconfig                                as config
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('admin_create_member_lesson', 'admin_update_member_lesson')
order by p.proname;
-- Expect: 2 rows, both is_security_definer = true, config contains
-- 'search_path=public, pg_temp'.

select
  p.proname as function_name,
  g.grantee,
  has_function_privilege(
    case g.grantee when 'PUBLIC' then 'public' else g.grantee end,
    p.oid, 'EXECUTE'
  ) as can_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join (values ('PUBLIC'), ('anon'), ('authenticated')) as g(grantee)
where n.nspname = 'public'
  and p.proname in ('admin_create_member_lesson', 'admin_update_member_lesson')
order by function_name, g.grantee;
-- Expect: can_execute = true ONLY for grantee = 'authenticated', for both
-- functions. Actual admin-only enforcement happens inside each function
-- body (current_user_role() = 'admin') — this only checks the outer grant.

select
  p.proname,
  pg_get_functiondef(p.oid) ~ 'current_user_role\(\)'      as uses_current_user_role,
  pg_get_functiondef(p.oid) !~ 'p_owner_user_id'            as no_client_supplied_owner,
  pg_get_functiondef(p.oid) ~ 'roster_member_id\s*=\s*p_roster_member_id'
    or pg_get_functiondef(p.oid) ~ 'id\s*=\s*p_roster_member_id' as validates_roster_member
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('admin_create_member_lesson', 'admin_update_member_lesson');
-- Expect: all three columns true for both rows.

-- ── D. get_pro_lesson_requests — widened for display continuity ────────────
select p.proname, count(*) as overload_count
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'get_pro_lesson_requests'
group by p.proname;
-- Expect: overload_count = 1 (DROP + CREATE, not an added overload — same
-- 2-argument input signature throughout).

select
  pg_get_functiondef(p.oid) ~ 'left join public\.profiles mem'      as member_join_is_left,
  pg_get_functiondef(p.oid) ~ 'left join public\.roster_members rm' as has_roster_fallback_join,
  pg_get_functiondef(p.oid) ~ 'member_claimed'                       as returns_member_claimed
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'get_pro_lesson_requests';
-- Expect: all three columns true — a no-account Member's lesson is no
-- longer silently dropped from this admin/pro-facing list (the pre-0111
-- inner join on profiles would have excluded it entirely).

-- ── E. Required authorization fixes are present and roster-aware ───────────
-- (correction pass: cancel_lesson, accept/decline_lesson_proposal all now
-- have a roster-based Member route, not just a null-safe historical one —
-- required for claim continuity, not merely defense-in-depth. See item 2/4
-- below for the roster-specific assertions; this section confirms the
-- underlying null-safety property — via `is not null and =` rather than
-- `<>` — is still structurally present in each.)
select
  pg_get_functiondef(p.oid) ~ 'v_is_member_by_history\s*:=\s*v_request\.member_id\s+is\s+not\s+null\s+and\s+v_request\.member_id\s*=\s*auth\.uid\(\)'
    and pg_get_functiondef(p.oid) ~ 'v_is_member_by_roster\s*:=\s*v_caller_roster_id\s+is\s+not\s+null\s+and\s+v_request\.roster_member_id\s*=\s*v_caller_roster_id'
    as cancel_lesson_authz_is_null_safe_and_roster_aware
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'cancel_lesson';
-- Expect: true. Required (not defense-in-depth): without the roster
-- branch, a Member who claimed their account after this lesson was
-- created could never cancel it themselves (member_id stays null
-- forever); without null-safety on the historical branch, a non-party,
-- non-admin authenticated user could cancel any no-account Member's
-- lesson. See 0111's migration header for the full explanation.

select
  p.proname,
  pg_get_functiondef(p.oid) ~ '\(v_request\.member_id\s+is\s+not\s+null\s+and\s+v_request\.member_id\s*=\s*auth\.uid\(\)\)'
    and pg_get_functiondef(p.oid) ~ '\(v_caller_roster_id\s+is\s+not\s+null\s+and\s+v_request\.roster_member_id\s*=\s*v_caller_roster_id\)'
    as authz_is_roster_aware
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('accept_lesson_proposal', 'decline_lesson_proposal');
-- Expect: 2 rows, both authz_is_roster_aware = true. See item 4 below for
-- the claim-continuity-specific framing of this same check.

-- propose_lesson_time: the guard now resolves the lesson's roster row
-- fresh and tests its CURRENT claimed_by, not historical member_id. See
-- item 3 below for the fuller assertion.
select
  pg_get_functiondef(p.oid) ~ 'select\s+claimed_by\s+into\s+v_current_member_id\s*\n?\s*from\s+public\.roster_members\s*\n?\s*where\s+id\s*=\s*v_request\.roster_member_id'
    and pg_get_functiondef(p.oid) ~ 'if\s+v_current_member_id\s+is\s+null\s+then\s*\n?\s*raise\s+exception\s+''member_has_no_account'''
    as has_roster_resolved_member_has_no_account_guard
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'propose_lesson_time';
-- Expect: true.

-- ── F. accept_lesson_proposal writes roster_member_id onto the reservation ─
select
  pg_get_functiondef(p.oid) ~ 'roster_member_id'
    and pg_get_functiondef(p.oid) ~ 'v_request\.roster_member_id'
    as writes_roster_member_id_to_reservation
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'accept_lesson_proposal';
-- Expect: true.

-- ── G. submit_lesson_request resolves and writes the caller's own roster identity ─
select
  pg_get_functiondef(p.oid) ~ 'claimed_by\s*=\s*auth\.uid\(\)'
    and pg_get_functiondef(p.oid) ~ '''no_roster_identity'''
    as resolves_own_roster_identity
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'submit_lesson_request';
-- Expect: true.

-- ── H. Existing signatures unchanged — no stray overloads ───────────────────
select p.proname, count(*) as overload_count
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'submit_lesson_request', 'propose_lesson_time', 'accept_lesson_proposal',
    'decline_lesson_proposal', 'cancel_lesson'
  )
group by p.proname
order by p.proname;
-- Expect: 5 rows, every overload_count = 1 — every one of these RPCs kept
-- its exact pre-0111 signature; every change was a plain CREATE OR REPLACE.

-- ── I. Pro identity untouched — no schema/RLS change on profiles or the
--      lesson_requests.pro_id / reservations.owner_user_id (pro_lesson) shape ─
select column_name, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name   = 'lesson_requests'
  and column_name  = 'pro_id';
-- Expect: 1 row, is_nullable = 'NO' — unchanged from 0069.

-- ── J. reservations_member_booking_identity_guard (0108) unaffected ────────
select t.tgname
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
where c.relname = 'reservations'
  and t.tgname   = 'reservations_member_booking_identity_guard'
  and not t.tgisinternal;
-- Expect: exactly 1 row — still scoped to reason='member_booking' only
-- (0111 deliberately did not add an equivalent trigger for pro_lesson —
-- see the migration header's RLS/trigger-guard analysis for why none was
-- needed).

-- ── K. lesson_requests RLS unchanged — still SELECT-only ────────────────────
select policyname, cmd
from pg_policies
where schemaname = 'public'
  and tablename   = 'lesson_requests'
order by policyname;
-- Expect: the same 3 SELECT-only policies from 0069 (lesson_requests_
-- select_member, lesson_requests_select_pro, lesson_requests_select_admin)
-- — no INSERT/UPDATE/DELETE policy was added. All mutation, before and
-- after 0111, goes exclusively through SECURITY DEFINER RPCs.

-- ═══════════════════════════════════════════════════════════════════════════
-- CORRECTION PASS — items required by the 33D1 targeted review
-- ═══════════════════════════════════════════════════════════════════════════

-- ── L. [Required item 1] get_my_lesson_requests has roster-aware ownership
--      continuity ─────────────────────────────────────────────────────────
select
  pg_get_functiondef(p.oid) ~ 'select\s+id\s+into\s+v_roster_member_id\s*\n?\s*from\s+public\.roster_members\s*\n?\s*where\s+club_id\s*=\s*v_profile\.club_id\s*\n?\s*and\s+claimed_by\s*=\s*auth\.uid\(\)'
    as resolves_callers_own_current_roster_identity,
  pg_get_functiondef(p.oid) ~ 'lr\.member_id\s*=\s*auth\.uid\(\)\s*\n?\s*or\s*\(v_roster_member_id\s+is\s+not\s+null\s+and\s+lr\.roster_member_id\s*=\s*v_roster_member_id\)'
    as where_clause_matches_either_route,
  pg_get_functiondef(p.oid) !~ 'p_roster_member_id'
    as no_client_supplied_roster_id_param
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'get_my_lesson_requests';
-- Expect: all three columns true. A claimed Member now sees a historical
-- lesson attributed to them via roster_member_id even though member_id on
-- that row is still (and will remain) null — the roster identity used is
-- always the caller's own, server-resolved, never client-supplied (this
-- function takes zero arguments — see the third column).

select p.proname, count(*) as overload_count
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'get_my_lesson_requests'
group by p.proname;
-- Expect: overload_count = 1 — same 0-argument signature as 0071, plain
-- CREATE OR REPLACE, no coexistence concern.

-- ── M. [Required item 3] propose_lesson_time determines CURRENT account
--      availability from roster_members.claimed_by, not historical
--      member_id ──────────────────────────────────────────────────────────
select
  pg_get_functiondef(p.oid) !~ 'if\s+v_request\.member_id\s+is\s+null\s+then\s*\n?\s*raise\s+exception\s+''member_has_no_account'''
    as no_longer_tests_historical_member_id_for_account_state,
  pg_get_functiondef(p.oid) ~ 'v_current_member_id'
    as resolves_current_member_id_variable,
  pg_get_functiondef(p.oid) ~ 'user_id,\s*kind,\s*body,\s*metadata\)\s*\n?\s*values\s*\(\s*\n?\s*v_profile\.club_id,\s*\n?\s*v_current_member_id,\s*\n?\s*''lesson_request_proposed'''
    as notification_addressed_to_current_member_id
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'propose_lesson_time';
-- Expect: all three columns true. See also Section E above for the guard
-- itself (resolves claimed_by fresh from the roster row, tests THAT for
-- null — not v_request.member_id).

-- ── N. [Required item 4] accept/decline Member authorization supports a
--      later claim ──────────────────────────────────────────────────────
select
  p.proname,
  pg_get_functiondef(p.oid) ~ 'select\s+id\s+into\s+v_caller_roster_id\s*\n?\s*from\s+public\.roster_members\s*\n?\s*where\s+club_id\s*=\s*v_profile\.club_id\s*\n?\s*and\s+claimed_by\s*=\s*auth\.uid\(\)'
    as resolves_callers_own_current_roster_identity,
  pg_get_functiondef(p.oid) !~ 'p_roster_member_id\s+uuid'
    as no_client_supplied_roster_id_param
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('accept_lesson_proposal', 'decline_lesson_proposal');
-- Expect: 2 rows, both columns true for each. Combined with Section E's
-- authz_is_roster_aware check above: a Member who was unclaimed when this
-- lesson was proposed to them, and has since claimed their account, can
-- now accept/decline it — authorization is never based on a roster id the
-- client supplies, only on the caller's own server-resolved identity.

-- ── O. [Required item 5] get_pro_lesson_requests member_claimed reflects
--      CURRENT roster claim state ───────────────────────────────────────
select
  pg_get_functiondef(p.oid) ~ 'left join public\.profiles mem on mem\.id\s*=\s*rm\.claimed_by'
    as member_profile_joined_via_current_claimed_by,
  pg_get_functiondef(p.oid) !~ 'left join public\.profiles mem on mem\.id\s*=\s*lr\.member_id'
    as no_longer_joined_via_historical_member_id
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'get_pro_lesson_requests';
-- Expect: both columns true. member_claimed (mem.id is not null) and the
-- displayed member name now both reflect roster_members.claimed_by at
-- query time, not whether the historical member_id snapshot happened to
-- be populated at creation.

-- ── P. [Required item 6] No function updates historical member_id merely
--      because an identity is claimed (no history rewrite) ──────────────
-- The only function in this migration that writes lesson_requests.
-- member_id in an UPDATE statement should be admin_update_member_lesson —
-- an explicit, audited admin reassignment action (mirroring 0109's
-- reservations precedent), never a passive side effect of someone
-- claiming their account. Every other function either never updates
-- member_id at all, or (get_my_lesson_requests, get_pro_lesson_requests,
-- propose_lesson_time, cancel_lesson) only ever SELECTs/resolves it.
select p.proname
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'submit_lesson_request', 'propose_lesson_time', 'accept_lesson_proposal',
    'decline_lesson_proposal', 'cancel_lesson', 'get_my_lesson_requests',
    'get_pro_lesson_requests'
  )
  and pg_get_functiondef(p.oid) ~ 'set\s+[^;]*\bmember_id\s*=';
-- Expect: 0 rows — none of these RPCs sets member_id anywhere in an
-- UPDATE ... SET list. (submit_lesson_request's own INSERT of member_id =
-- auth.uid() at creation time is not matched by this pattern — it is not
-- an UPDATE, and is the caller's own account at the moment they create
-- their own request, not a claim-triggered rewrite of someone else's row.)

select
  pg_get_functiondef(p.oid) ~ 'member_id\s*=\s*v_member_id'
    as admin_update_member_lesson_reassigns_member_id_explicitly
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'admin_update_member_lesson';
-- Expect: true — confirms the one legitimate write path (explicit,
-- audited admin Member reassignment) still exists and is exactly where
-- expected, not accidentally removed by this correction pass.

-- ── Q. [Required item 8] Existing Member conflict semantics extended to
--      no-account roster Members where identity data permits ───────────
select
  p.proname,
  pg_get_function_identity_arguments(p.oid) as args,
  p.prosecdef as is_security_definer,
  p.proconfig as config
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = '_lesson_check_member_availability';
-- Expect: exactly 1 row (DROP + CREATE, not an added overload). args
-- include p_roster_member_id (new). is_security_definer = true, config
-- contains 'search_path=public, pg_temp'.

select
  g.grantee,
  has_function_privilege(
    case g.grantee when 'PUBLIC' then 'public' else g.grantee end,
    p.oid, 'EXECUTE'
  ) as can_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join (values ('PUBLIC'), ('anon'), ('authenticated')) as g(grantee)
where n.nspname = 'public'
  and p.proname = '_lesson_check_member_availability'
order by g.grantee;
-- Expect: can_execute = false for ALL THREE grantees, including
-- 'authenticated' — this is a private helper, matching 0101's own
-- precedent for this exact function (revoked from public/anon, never
-- granted to authenticated at all; reachable only via an internal
-- `perform` call from another SECURITY DEFINER function).

select
  pg_get_functiondef(p.oid) ~ 'r\.owner_user_id\s*=\s*p_member_id\)\s*\n?\s*or\s*\(p_roster_member_id\s+is\s+not\s+null\s+and\s+r\.roster_member_id\s*=\s*p_roster_member_id\)'
    as reservation_conflict_category_is_roster_aware,
  pg_get_functiondef(p.oid) ~ 'lr\.member_id\s*=\s*p_member_id\)\s*\n?\s*or\s*\(p_roster_member_id\s+is\s+not\s+null\s+and\s+lr\.roster_member_id\s*=\s*p_roster_member_id\)'
    as lesson_conflict_category_is_roster_aware,
  pg_get_functiondef(p.oid) ~ 'if\s+p_member_id\s+is\s+not\s+null\s+then\s*\n?\s*select\s+count\(\*\)\s+into\s+v_conflict\s*\n?\s*from\s+public\.event_participants'
    as event_conflict_category_still_member_id_only
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = '_lesson_check_member_availability';
-- Expect: all three columns true. The first two confirm the SAME existing
-- conflict rule (not a new one) now also matches via the durable roster
-- identity, closing the gap for a no-account Member; the third confirms
-- the one genuine, reported, out-of-scope limitation (event-participation
-- conflict — event_participants has no roster-identity column, and a
-- no-account Member cannot join an event at all today) is still exactly
-- that — a documented gap, not silently invented around or silently
-- dropped.

select
  pg_get_functiondef(p.oid) ~ '_lesson_check_member_availability\(v_member_id,\s*p_roster_member_id,'
    as admin_create_calls_it_unconditionally
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'admin_create_member_lesson';
-- Expect: true — confirms the old `if v_member_id is not null then` gate
-- around this call was removed (the function is now called
-- unconditionally and narrows itself internally).

select
  pg_get_functiondef(p.oid) ~ '_lesson_check_member_availability\(v_member_id,\s*p_roster_member_id,'
    as admin_update_calls_it_unconditionally
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'admin_update_member_lesson';
-- Expect: true — same gate removal in the edit path.

-- ── R. [Required item 9] Existing null-safe authorization protections
--      remain present (not regressed by this correction pass) ──────────
select
  pg_get_functiondef(p.oid) ~ 'v_is_member_by_history\s*:=\s*v_request\.member_id\s+is\s+not\s+null\s+and'
    and pg_get_functiondef(p.oid) ~ 'v_is_pro\s*:=\s*v_request\.pro_id\s*=\s*auth\.uid\(\)'
    and pg_get_functiondef(p.oid) ~ 'v_is_admin\s*:=\s*v_profile\.role\s*=\s*''admin'''
    as cancel_lesson_all_four_authorization_routes_present
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'cancel_lesson';
-- Expect: true — pro and admin authorization routes are unchanged
-- alongside the two Member routes (historical + roster).

-- ── S. [Required item 10] New/admin RPC grants and fixed search_path
--      remain correct (re-confirms Section C after this correction pass'
--      edits to admin_create/admin_update_member_lesson's conflict-check
--      call sites) ─────────────────────────────────────────────────────
select
  p.proname,
  p.prosecdef as is_security_definer,
  p.proconfig as config
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('admin_create_member_lesson', 'admin_update_member_lesson')
order by p.proname;
-- Expect: 2 rows, both is_security_definer = true, config contains
-- 'search_path=public, pg_temp' — unchanged by this correction pass'
-- edits (which only touched the _lesson_check_member_availability call
-- sites inside each body, not the function headers/grants).

-- ═══════════════════════════════════════════════════════════════════════════
-- FINAL COMPATIBILITY PASS — pro_confirm_lesson_request investigation
-- ═══════════════════════════════════════════════════════════════════════════
-- A targeted review raised pro_confirm_lesson_request as a possible live,
-- admin-only RPC that still calls the OLD 4-argument _lesson_check_member_
-- availability signature 0111 drops, and asked for it to be redefined
-- inside 0111 to close the gap.
--
-- Investigated before making any change (per the standing project
-- discipline of verifying a claim against actual repo state before acting
-- on it) — finding: this function was never live. It appears exactly
-- twice in the entire migrations directory, both inside 0069_lesson_
-- requests.sql itself: once as a bullet in that migration's own
-- descriptive header listing originally-planned RPCs, and once in a
-- stray inline comment ("Same availability and operating-hours checks as
-- pro_confirm_lesson_request") inside accept_lesson_proposal. Neither is
-- a `create or replace function` statement — no migration, at 0069 or
-- any point since, ever actually created this function.
--
-- Conclusive corroborating evidence: supabase/scripts/QA_phase23.md — the
-- QA checklist for the very phase (23) that introduced the lesson
-- domain — explicitly documents its removal before ship:
--   "-- Confirm all lesson RPCs exist (pro_confirm_lesson_request is NOT
--   included — removed)" (with a 22-function existence check that
--   excludes it), and separately:
--   "-- Confirm pro_confirm_lesson_request does NOT exist
--    SELECT COUNT(*) FROM pg_proc ... WHERE proname =
--    'pro_confirm_lesson_request'; -- Expected: 0"
--   and a checklist line: "`pro_confirm_lesson_request` is NOT in
--   db/types.ts (removed)".
-- It was part of an earlier design draft (apparently a one-step "pro
-- directly confirms" RPC) superseded, before Phase 23 shipped, by the
-- two-step propose_lesson_time → accept_lesson_proposal negotiation flow
-- actually implemented — the header bullet and the one stray comment
-- reference are leftover prose that was never scrubbed from 0069's text,
-- not evidence of a shipped function.
--
-- Because it was never live, "redefining" it inside 0111 would not
-- preserve any existing behavior — there is no pre-0111 definition to
-- preserve. It would instead CREATE, for the first time, a new admin-only
-- direct-lesson-confirmation capability that has never existed in this
-- product. That is new product functionality, not an identity/
-- compatibility fix, and is explicitly out of this migration's scope (see
-- 0111's own "Explicitly OUT OF SCOPE" list: no new capability beyond
-- staff-managed identity parity). No change was made to 0111 for this
-- item — there is nothing to fix.
--
-- Corollary of the same investigation (also directly answers this pass'
-- "call-site compatibility" requirement): every historical call site of
-- _lesson_check_member_availability across ALL migrations was traced to
-- its enclosing function and checked against that function's LATEST
-- (live) definition. 0069:749, 0072:389, and 0073:107 are all inside
-- superseded intermediate definitions of accept_lesson_proposal /
-- propose_lesson_time (each later redefined again by 0101, and again by
-- this correction pass) — dead migration-log text, not live code; only a
-- function's most recent `create or replace` reflects current behavior.
-- The two queries below prove this holds for the actual post-0111
-- database state, not just the migration text.

select count(*) as pro_confirm_lesson_request_exists
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'pro_confirm_lesson_request';
-- Expect: 0 — confirms in the live database what QA_phase23.md already
-- documented at the time: this function does not exist and was never
-- shipped. If this ever returns > 0, something outside this migration
-- history created it — investigate before assuming 0111 is responsible.

select p.proname, pg_get_function_identity_arguments(p.oid) as args
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname <> '_lesson_check_member_availability'
  and pg_get_functiondef(p.oid) ~ '_lesson_check_member_availability\(';
-- Expect: exactly 4 rows — propose_lesson_time, accept_lesson_proposal,
-- admin_create_member_lesson, admin_update_member_lesson. These are the
-- only live functions in the entire public schema whose body calls
-- _lesson_check_member_availability at all; every one of them was
-- updated by this migration/correction pass to use the new 5-argument
-- form. If this ever returns a row for any OTHER function name, that
-- function still expects the dropped 4-argument signature and 0111 is
-- NOT safe to apply until it is fixed.

select
  pg_get_functiondef(p.oid) ~ '_lesson_check_member_availability\([^,]+,\s*[^,]+,\s*[^,]+,\s*[^,]+,\s*[^)]+\)'
    as calls_with_five_args
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'propose_lesson_time', 'accept_lesson_proposal',
    'admin_create_member_lesson', 'admin_update_member_lesson'
  );
-- Expect: 4 rows, all calls_with_five_args = true — a coarse arity check
-- (five comma-delimited-ish argument positions) as a second, independent
-- signal alongside the previous query's simpler substring match.
