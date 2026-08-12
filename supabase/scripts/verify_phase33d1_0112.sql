-- verify_phase33d1_0112.sql
-- Phase 33D1 runtime fix — POST-migration verification for
-- 0112_fix_my_lesson_roster_lookup_ambiguity.sql.
--
-- Run in the Supabase SQL Editor AFTER 0112 has been applied. Every query
-- is read-only — safe to run against a live database. Text-pattern
-- function-body checks are not a full behavioral proof — if any is false,
-- read the function directly with `select pg_get_functiondef(oid) from
-- pg_proc where proname = 'get_my_lesson_requests'` and confirm by eye.
--
-- Rollback notes: see the "Rollback procedure" comment block at the end of
-- 0112_fix_my_lesson_roster_lookup_ambiguity.sql if any check here fails.

-- ── 1. Exactly one zero-argument get_my_lesson_requests() exists ───────────
select
  p.proname,
  pg_get_function_identity_arguments(p.oid) as args,
  count(*) over () as overload_count
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'get_my_lesson_requests';
-- Expect: exactly 1 row, args = '' (zero arguments), overload_count = 1.

-- ── 2/3. SECURITY DEFINER + fixed search_path ───────────────────────────────
select
  p.prosecdef as is_security_definer,
  p.proconfig as config,
  p.proconfig @> array['search_path=public, pg_temp'] as search_path_is_fixed
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'get_my_lesson_requests';
-- Expect: is_security_definer = true, search_path_is_fixed = true.

-- ── 4/5/6. Grants — authenticated true, anon/PUBLIC false ──────────────────
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
  and p.proname = 'get_my_lesson_requests'
order by g.grantee;
-- Expect: can_execute = true ONLY for grantee = 'authenticated' (false for
-- 'PUBLIC' and 'anon').

-- ── 7/8/9. Roster lookup is fully qualified (the actual fix) ───────────────
select
  pg_get_functiondef(p.oid) ~ 'select\s+rm\.id\s+into\s+v_roster_member_id'
    as roster_id_lookup_is_qualified,
  pg_get_functiondef(p.oid) ~ 'rm\.club_id\s*=\s*v_profile\.club_id'
    as roster_club_id_is_qualified,
  pg_get_functiondef(p.oid) ~ 'rm\.claimed_by\s*=\s*auth\.uid\(\)'
    as roster_claimed_by_is_qualified,
  pg_get_functiondef(p.oid) !~ 'select\s+id\s+into\s+v_roster_member_id'
    as no_longer_has_bare_unqualified_id_select
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'get_my_lesson_requests';
-- Expect: all four columns true. The fourth is the specific negative
-- assertion that the original ambiguous form is gone, not just that a
-- qualified form was added somewhere else in the body.

-- ── 10. Roster-aware ownership predicate is unchanged ───────────────────────
select
  pg_get_functiondef(p.oid) ~ 'lr\.member_id\s*=\s*auth\.uid\(\)\s*\n?\s*or\s*\(v_roster_member_id\s+is\s+not\s+null\s+and\s+lr\.roster_member_id\s*=\s*v_roster_member_id\)'
    as ownership_predicate_unchanged
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'get_my_lesson_requests';
-- Expect: true — same claim-continuity predicate 0111 introduced, byte-
-- for-byte, only the roster-lookup line above it was touched.

-- ── Focused scan: any other unqualified column colliding with a RETURNS
--    TABLE output name? ─────────────────────────────────────────────────
-- The function's RETURNS TABLE output names are: id, pro_id,
-- pro_first_name, pro_last_name, preferred_court_id, preferred_court_name,
-- duration_minutes, member_note, preferred_windows, proposed_starts_at,
-- proposed_ends_at, proposed_court_id, proposed_court_name, status,
-- decline_reason, cancellation_reason, linked_reservation_id, created_at,
-- updated_at, confirmed_at, lesson_type_id, lesson_type_name,
-- lesson_outcome. Every reference to each of these names anywhere in the
-- function body other than the fixed roster lookup already carries a
-- table alias (lr./pro./pc./xc./lt.) or is a v_profile.* record-field
-- access — neither of which is a bare column reference, so neither can
-- collide with an output-column variable regardless of name overlap. This
-- query is a coarse structural confirmation, not a full parser: it fails
-- (returns > 0) only if a bare, alias-free reference to `status` (the
-- single output-name word most likely to appear unqualified by accident
-- elsewhere in the codebase) appears anywhere in the body outside the
-- already-qualified `lr.status` select-list entry.
select
  (select count(*) from regexp_matches(pg_get_functiondef(p.oid), '(?<![\.\w])status(?!\s*\w)', 'g')) as bare_status_token_occurrences,
  pg_get_functiondef(p.oid) ~ 'lr\.status,' as qualified_status_present
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'get_my_lesson_requests';
-- Expect: qualified_status_present = true, and bare_status_token_occurrences
-- should correspond only to the RETURNS TABLE declaration line ("status
-- text,") and the qualified "lr.status," select-list entry — both of which
-- this coarse regex cannot fully distinguish from a genuine bare
-- reference, so treat this as a prompt to eyeball pg_get_functiondef's
-- output directly rather than a strict pass/fail gate. Manual inspection
-- of the full function body (performed as part of this migration's own
-- header) already confirmed every other RETURNS TABLE output name is only
-- ever referenced via an explicit table alias or a v_profile.* field
-- access throughout the function — no other collision exists.
