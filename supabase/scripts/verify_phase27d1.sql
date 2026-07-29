-- verify_phase27d1.sql
-- Phase 27D1: Whole-Program Enrollment Backend — read-only verification.
--
-- Run in the Supabase SQL Editor AFTER 0091_whole_program_enrollment.sql
-- has been applied. Every query is read-only (no INSERT/UPDATE/DELETE) —
-- safe to run against a live database. Each block prints what it checks;
-- an empty result set from a "should be empty" query means PASS.
--
-- This version covers the 0091 correction pass: generation/enrollment
-- locking, FIFO rejoin fairness (waitlisted_at), the program lifecycle
-- contract, and the event_participants direct-write correction. Where a
-- property can only be proven by actually racing two transactions or
-- driving the RPCs through a real join/leave/rejoin cycle, this script
-- proves the *structural* precondition (the lock is taken, the guard
-- exists in the function body, the grant is actually revoked) and points
-- to the matching scenario in QA_phase27d1.md for the full behavioral
-- proof — a static read-only script cannot itself run a concurrency race
-- or impersonate the authenticated role.

-- ── A. Functions exist with the correct owner/security/search_path ────────
select
  p.proname                                  as function_name,
  pg_get_function_identity_arguments(p.oid)  as args,
  p.prosecdef                                as is_security_definer,
  p.proconfig                                as config      -- expect search_path=public, pg_temp
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'join_program',
    'leave_program',
    'accept_program_waitlist_offer',
    'decline_program_waitlist_offer',
    '_expire_stale_program_offers',
    '_advance_program_waitlist_offer',
    '_materialize_program_member_into_future_events',
    '_cancel_program_member_future_participation',
    '_program_is_enrollable',
    'generate_program_sessions'
  )
order by p.proname;
-- Expect: 10 rows (five private helpers, four public RPCs,
-- generate_program_sessions), is_security_definer = true on all, config
-- contains 'search_path=public, pg_temp' on all.

-- ── B. Grants on the public-facing RPCs: authenticated only, never PUBLIC/anon ─
select
  p.proname                                       as function_name,
  pg_get_function_identity_arguments(p.oid)       as args,
  g.grantee,
  has_function_privilege(
    case g.grantee when 'PUBLIC' then 'public' else g.grantee end,
    p.oid, 'EXECUTE'
  ) as can_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join (values ('PUBLIC'), ('anon'), ('authenticated')) as g(grantee)
where n.nspname = 'public'
  and p.proname in (
    'join_program', 'leave_program', 'accept_program_waitlist_offer',
    'decline_program_waitlist_offer', 'generate_program_sessions'
  )
order by p.proname, g.grantee;
-- Expect: can_execute = true ONLY for grantee = 'authenticated'; false for
-- both 'PUBLIC' and 'anon', on every row. A true on PUBLIC or anon means
-- the revoke was missed or a later statement re-granted it.

-- ── C. Grants on the five private helpers: nobody at the role level ───────
select
  p.proname  as function_name,
  g.grantee,
  has_function_privilege(
    case g.grantee when 'PUBLIC' then 'public' else g.grantee end,
    p.oid, 'EXECUTE'
  ) as can_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join (values ('PUBLIC'), ('anon'), ('authenticated')) as g(grantee)
where n.nspname = 'public'
  and p.proname in (
    '_expire_stale_program_offers',
    '_advance_program_waitlist_offer',
    '_materialize_program_member_into_future_events',
    '_cancel_program_member_future_participation',
    '_program_is_enrollable'
  )
order by p.proname, g.grantee;
-- Expect: can_execute = false for every row, every grantee — helpers are
-- callable only via SECURITY DEFINER from the RPCs above, never directly
-- by any role.

-- ── D. No direct authenticated write grants on program_enrollments ────────
select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name = 'program_enrollments'
  and grantee in ('anon', 'authenticated')
order by grantee, privilege_type;
-- Expect: authenticated -> SELECT only. No INSERT/UPDATE/DELETE for
-- authenticated or anon. Unchanged by 0091's correction pass (see
-- migration header, RLS/grants note).

-- ── E. event_participants direct writes are denied (the 0091 correction) ──
-- This is the strongest read-only proof available that a direct
-- authenticated write is impossible: the underlying table-level grant
-- itself is gone, which holds regardless of RLS policy state and
-- regardless of which client library or role performs the attempt.
select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name = 'event_participants'
  and grantee in ('anon', 'authenticated')
order by grantee, privilege_type;
-- Expect: exactly one row — authenticated / SELECT. No INSERT, UPDATE, or
-- DELETE for authenticated or anon. Before 0091's correction this would
-- have shown authenticated with INSERT and UPDATE as well (from 0004's
-- default grants, gated only by RLS) — their absence here is the fix.

-- ── F. program_enrollments CHECK constraints, including the new one ───────
select conname, pg_get_constraintdef(oid)
from pg_constraint
where conrelid = 'public.program_enrollments'::regclass
order by conname;
-- Expect: the same constraints as 0087 (status IN (...), unique(program_id,
-- profile_id), the offer_expires_at-paired-with-status CHECK), PLUS the new
-- program_enrollments_waitlisted_at_check from 0091's correction pass:
--   (status = 'waitlisted' AND waitlisted_at IS NOT NULL)
--   OR (status <> 'waitlisted' AND waitlisted_at IS NULL)

-- ── G. RLS on program_enrollments — unchanged, exactly one SELECT policy ──
select relrowsecurity, relforcerowsecurity
from pg_class
where oid = 'public.program_enrollments'::regclass;

select polname, pg_get_expr(polqual, polrelid) as using_expr
from pg_policy
where polrelid = 'public.program_enrollments'::regclass;
-- Expect: relrowsecurity = true, exactly one policy
-- "program_enrollments_select" with the same USING expression as 0087
-- (own row / admin in-club / pro who created the program). 0091 must not
-- have added, dropped, or altered any policy here.

-- ── H. RLS on event_participants — only the SELECT policy survives ────────
select polname, cmd, pg_get_expr(polqual, polrelid) as using_expr
from pg_policy
where polrelid = 'public.event_participants'::regclass
order by polname;
-- Expect: exactly one policy, "event_participants_select_same_club"
-- (cmd = 'r'). "event_participants_insert_own" and
-- "event_participants_cancel_own" (both from 0004) must be gone — 0091
-- drops them as dead policies once the underlying write grants are
-- revoked (see block E).

-- ── I. Materialization shape sanity: no duplicate event_participants rows ─
-- Should always be empty regardless of data — the (event_id, profile_id)
-- unique constraint should make this structurally impossible, but this
-- confirms it directly.
select event_id, profile_id, count(*)
from public.event_participants
group by event_id, profile_id
having count(*) > 1;

-- ── J. Every 'program' enrollment_model program's currently-enrolled ──────
--      members are materialized into every applicable future event, and
--      no offered/waitlisted member is materialized (adjust club/program
--      filter as needed against real data before relying on this).
-- J.1: enrolled members missing from an applicable future event (should be empty)
select pe.program_id, pe.profile_id, e.id as missing_event_id
from public.program_enrollments pe
join public.programs pr on pr.id = pe.program_id and pr.enrollment_model = 'program'
join public.events e on e.program_id = pr.id
  and e.status = 'scheduled' and e.archived_at is null and e.starts_at >= now()
where pe.status = 'enrolled'
  and not exists (
    select 1 from public.event_participants ep
    where ep.event_id = e.id and ep.profile_id = pe.profile_id and ep.status = 'confirmed'
  );

-- J.2: offered/waitlisted members incorrectly materialized (should be empty)
select pe.program_id, pe.profile_id, ep.event_id
from public.program_enrollments pe
join public.programs pr on pr.id = pe.program_id and pr.enrollment_model = 'program'
join public.events e on e.program_id = pr.id
join public.event_participants ep on ep.event_id = e.id and ep.profile_id = pe.profile_id
where pe.status in ('offered', 'waitlisted')
  and ep.status = 'confirmed';

-- ── K. member_joinable correctness per enrollment_model on generated events ─
select pr.enrollment_model, e.member_joinable, count(*)
from public.events e
join public.programs pr on pr.id = e.program_id
where e.program_id is not null
group by pr.enrollment_model, e.member_joinable
order by pr.enrollment_model;
-- Expect: enrollment_model='per_session' -> member_joinable=true only.
-- enrollment_model in ('program','admin_managed') -> member_joinable=false only.

-- ── L. Capacity never exceeded: enrolled+offered vs default_capacity ──────
select pr.id as program_id, pr.title, pr.default_capacity, count(*) as held_count
from public.programs pr
join public.program_enrollments pe on pe.program_id = pr.id and pe.status in ('enrolled', 'offered')
group by pr.id, pr.title, pr.default_capacity
having count(*) > pr.default_capacity;
-- Expect: empty. Any row here is a capacity-overfill bug — see
-- QA_phase27d1.md §11 for the concurrent-join race that actually exercises this.

-- ── M. No more than one non-expired offered row per program at a time ─────
select program_id, count(*)
from public.program_enrollments
where status = 'offered' and offer_expires_at > now()
group by program_id
having count(*) > 1;
-- Expect: empty. More than one live offer per program is a double-offer bug
-- — see QA_phase27d1.md §12 for the concurrent-promotion race.

-- ── N. waitlisted_at is never null while status='waitlisted' or vice versa ─
-- Redundant with the CHECK constraint in block F, but confirms directly
-- against live data rather than only the constraint definition text.
select id, program_id, profile_id, status, waitlisted_at
from public.program_enrollments
where (status = 'waitlisted' and waitlisted_at is null)
   or (status <> 'waitlisted' and waitlisted_at is not null);
-- Expect: empty.

-- ── O. Structural proof: draft programs have no enrollment rows ───────────
-- join_program has always rejected draft (program_not_enrollable) and no
-- other write path into program_enrollments exists — this should be
-- empty on any database where 0091's join_program has been the only write
-- path since the column existed.
select pe.id, pe.program_id, pr.status
from public.program_enrollments pe
join public.programs pr on pr.id = pe.program_id
where pr.status = 'draft';
-- Expect: empty. See QA_phase27d1.md §15 for the direct join_program call
-- against a draft program (expect program_not_enrollable).

-- ── P. Source-text proof: locking, lifecycle gate, and queue-bypass guard ─
-- Confirms the required guards are actually present in the deployed
-- function bodies — a structural precondition for the concurrency and
-- lifecycle behavior QA_phase27d1.md exercises end-to-end.
select
  p.proname as function_name,
  pg_get_functiondef(p.oid) ilike '%for update%'                       as has_row_lock,
  pg_get_functiondef(p.oid) ilike '%_program_is_enrollable%'           as calls_lifecycle_check,
  pg_get_functiondef(p.oid) ilike '%status = ''waitlisted''%'          as has_queue_bypass_guard
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'join_program', 'leave_program', 'accept_program_waitlist_offer',
    'decline_program_waitlist_offer', 'generate_program_sessions'
  )
order by p.proname;
-- Expect: has_row_lock = true for all five (this is the generation-vs-
-- enrollment locking correction — see QA_phase27d1.md §23/§24 for the
-- actual races). calls_lifecycle_check = true for join_program and
-- accept_program_waitlist_offer only (false for leave_program,
-- decline_program_waitlist_offer, generate_program_sessions — no
-- lifecycle gate on those by design; see migration header lifecycle
-- matrix). has_queue_bypass_guard = true for join_program only.
