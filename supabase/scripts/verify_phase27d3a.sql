-- verify_phase27d3a.sql
-- Phase 27D3A: Admin/Pro Program Roster Backend — read-only verification.
--
-- Run in the Supabase SQL Editor AFTER 0092_program_roster_management.sql
-- has been applied. Every query is read-only (no INSERT/UPDATE/DELETE) —
-- safe to run against a live database. Each block states what it checks;
-- an empty result set from a "should be empty" query means PASS.

-- ── A. Functions exist with correct owner/security/search_path ───────────
select
  p.proname                                  as function_name,
  pg_get_function_identity_arguments(p.oid)  as args,
  p.prosecdef                                as is_security_definer,
  p.proconfig                                as config      -- expect search_path=public, pg_temp
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('get_program_roster', 'add_program_member', 'remove_program_member')
order by p.proname;
-- Expect: 3 rows, is_security_definer = true on all, config contains
-- 'search_path=public, pg_temp' on all.

-- ── B. Grants: authenticated only, never PUBLIC or anon ───────────────────
select
  p.proname                                  as function_name,
  pg_get_function_identity_arguments(p.oid)  as args,
  g.grantee,
  has_function_privilege(
    case g.grantee when 'PUBLIC' then 'public' else g.grantee end,
    p.oid, 'EXECUTE'
  ) as can_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join (values ('PUBLIC'), ('anon'), ('authenticated')) as g(grantee)
where n.nspname = 'public'
  and p.proname in ('get_program_roster', 'add_program_member', 'remove_program_member')
order by p.proname, g.grantee;
-- Expect: can_execute = true ONLY for grantee = 'authenticated'; false for
-- both 'PUBLIC' and 'anon', on every row.

-- ── C. No new direct authenticated write grants on program_enrollments ────
select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name = 'program_enrollments'
  and grantee in ('anon', 'authenticated')
order by grantee, privilege_type;
-- Expect: authenticated -> SELECT only (unchanged from 0087/0091). No
-- INSERT/UPDATE/DELETE for authenticated or anon.

-- ── D. No new direct authenticated write grants on event_participants ─────
select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name = 'event_participants'
  and grantee in ('anon', 'authenticated')
order by grantee, privilege_type;
-- Expect: authenticated -> SELECT only (unchanged from 0091's correction).
-- No INSERT/UPDATE/DELETE for authenticated or anon.

-- ── E. RLS unchanged: same single SELECT policy on each table ─────────────
select
  polname,
  polcmd as cmd,
  pg_get_expr(polqual, polrelid) as using_expr
from pg_policy
where polrelid = 'public.program_enrollments'::regclass
order by polname;
-- Expect: exactly one policy, "program_enrollments_select" (cmd = 'r'),
-- same USING expression as 0087. This migration must not have added,
-- dropped, or altered any policy here.

select
  polname,
  polcmd as cmd,
  pg_get_expr(polqual, polrelid) as using_expr
from pg_policy
where polrelid = 'public.event_participants'::regclass
order by polname;
-- Expect: exactly one policy, "event_participants_select_same_club"
-- (cmd = 'r') — unchanged from 0091's correction pass.

-- ── F. Source-text proof: locking present where required ──────────────────
select
  p.proname as function_name,
  pg_get_functiondef(p.oid) ilike '%for update%' as has_row_lock
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('get_program_roster', 'add_program_member', 'remove_program_member')
order by p.proname;
-- Expect: has_row_lock = true for add_program_member and
-- remove_program_member (both mutate and must serialize against
-- join_program/leave_program/accept/decline/generate_program_sessions).
-- has_row_lock = false for get_program_roster (read-only; no lock needed
-- or taken — see migration header).

-- ── G. Source-text proof: target-membership check present only on add ─────
select
  p.proname as function_name,
  pg_get_functiondef(p.oid) ilike '%club_memberships%' as reads_club_memberships,
  pg_get_functiondef(p.oid) ilike '%profiles.club_id%'
    or pg_get_functiondef(p.oid) ilike '%profiles.role%'
    or pg_get_functiondef(p.oid) ilike '%profiles.status%'
    or pg_get_functiondef(p.oid) ilike '%is_lesson_provider%'          as touches_legacy_columns
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('get_program_roster', 'add_program_member', 'remove_program_member')
order by p.proname;
-- Expect: reads_club_memberships = true only for add_program_member.
-- touches_legacy_columns = false for all three — confirms membership-
-- native-only authorization, never profiles.club_id/role/status/
-- is_lesson_provider.

-- ── H. program_enrollments schema untouched by this migration ─────────────
select conname, pg_get_constraintdef(oid)
from pg_constraint
where conrelid = 'public.program_enrollments'::regclass
order by conname;
-- Expect: identical to 0091's post-migration state (status/uniqueness/
-- offer_expires_at/waitlisted_at CHECK constraints). No new constraint.

-- ── I. Roster completeness: every program_enrollments row for a
--      'program'-model program appears exactly once in get_program_roster
--      output (structural sanity — run manually with a real program id):
--   select count(*) from program_enrollments where program_id = '<id>';
--   select count(*) from get_program_roster('<id>');
-- Expect: the two counts match exactly (get_program_roster returns every
-- status, including cancelled — unlike get_event_roster).

-- ── J. Capacity never exceeded after any roster mutation ──────────────────
select pr.id as program_id, pr.title, pr.default_capacity, count(*) as held_count
from public.programs pr
join public.program_enrollments pe on pe.program_id = pr.id and pe.status in ('enrolled', 'offered')
group by pr.id, pr.title, pr.default_capacity
having count(*) > pr.default_capacity;
-- Expect: empty. Any row here is a capacity-overfill bug, whether caused
-- by a member action, a staff action, or a race between the two.

-- ── K. No more than one live offer per program at a time ──────────────────
select program_id, count(*)
from public.program_enrollments
where status = 'offered' and offer_expires_at > now()
group by program_id
having count(*) > 1;
-- Expect: empty — same one-live-offer invariant 0091 established,
-- preserved unchanged by this migration's staff RPCs.

-- ── L. waitlisted_at consistency (same invariant as 0091's own check) ─────
select id, program_id, profile_id, status, waitlisted_at
from public.program_enrollments
where (status = 'waitlisted' and waitlisted_at is null)
   or (status <> 'waitlisted' and waitlisted_at is not null);
-- Expect: empty.
