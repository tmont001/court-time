-- verify_phase27d3_member_lookup.sql
-- Phase 27D3C: get_program_eligible_members — read-only verification.
--
-- Run in the Supabase SQL Editor AFTER
-- 0093_program_roster_member_lookup.sql has been applied. Every query is
-- read-only (no INSERT/UPDATE/DELETE) — safe to run against a live
-- database. An empty result set from a "should be empty" query means PASS.

-- ── A. Function exists with correct owner/security/search_path ────────────
select
  p.proname                                  as function_name,
  pg_get_function_identity_arguments(p.oid)  as args,
  p.prosecdef                                as is_security_definer,
  p.proconfig                                as config      -- expect search_path=public, pg_temp
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'get_program_eligible_members';
-- Expect: 1 row, is_security_definer = true, config contains
-- 'search_path=public, pg_temp'.

-- ── B. Grants: authenticated only, never PUBLIC or anon ────────────────────
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
  and p.proname  = 'get_program_eligible_members'
order by g.grantee;
-- Expect: can_execute = true ONLY for grantee = 'authenticated'; false for
-- both 'PUBLIC' and 'anon'.

-- ── C. No table grant or RLS change anywhere this function reads ──────────
-- club_memberships and profiles' own grants/RLS are untouched by this
-- migration — it only adds a SECURITY DEFINER function, which bypasses RLS
-- for its own internal read regardless.
select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name   = 'club_memberships'
  and grantee in ('anon', 'authenticated');
-- Expect: identical to whatever this club already had before 0093 — this
-- migration must not have added or removed any row here.

-- ── D. Source-text proof: club_memberships-sourced, never legacy columns ──
select
  pg_get_functiondef(p.oid) ilike '%club_memberships%'        as reads_club_memberships,
  pg_get_functiondef(p.oid) ilike '%profiles.club_id%'
    or pg_get_functiondef(p.oid) ilike '%profiles.role%'
    or pg_get_functiondef(p.oid) ilike '%profiles.status%'
    or pg_get_functiondef(p.oid) ilike '%is_lesson_provider%'  as touches_legacy_columns,
  pg_get_functiondef(p.oid) ilike '%.email%'                   as exposes_email
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname  = 'get_program_eligible_members';
-- Expect: reads_club_memberships = true, touches_legacy_columns = false,
-- exposes_email = false.

-- ── E. Behavioral spot-check (run manually with a real program id) ────────
--   select * from get_program_eligible_members('<program_id>');
-- Expect: only active, non-removed same-club members; alphabetical by
-- last_name then first_name; no row for anyone with an enrolled/offered/
-- waitlisted program_enrollments row for that program; a cancelled-status
-- or no-row member DOES appear; no email column in the result at all.
