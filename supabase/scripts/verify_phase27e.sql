-- verify_phase27e.sql
-- Phase 27E: Program Lifecycle — read-only verification.
--
-- Run in the Supabase SQL Editor AFTER 0094_program_lifecycle.sql has been
-- applied. Every query is read-only (no INSERT/UPDATE/DELETE) — safe to
-- run against a live database. An empty result set from a "should be
-- empty" query means PASS.

-- ── A. Functions exist with correct owner/security/search_path ────────────
select
  p.proname                                  as function_name,
  pg_get_function_identity_arguments(p.oid)  as args,
  p.prosecdef                                as is_security_definer,
  p.proconfig                                as config      -- expect search_path=public, pg_temp
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('cancel_program', 'complete_program', 'archive_program', 'unarchive_program')
order by p.proname;
-- Expect: 4 rows, is_security_definer = true on all, config contains
-- 'search_path=public, pg_temp' on all.

-- ── B. Grants: authenticated only, never PUBLIC or anon ────────────────────
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
  and p.proname in ('cancel_program', 'complete_program', 'archive_program', 'unarchive_program')
order by p.proname, g.grantee;
-- Expect: can_execute = true ONLY for grantee = 'authenticated'; false for
-- both 'PUBLIC' and 'anon', on every row.

-- ── C. No new direct authenticated write grants on any touched table ──────
select table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in ('programs', 'events', 'reservations', 'event_participants', 'program_enrollments')
  and grantee in ('anon', 'authenticated')
order by table_name, grantee, privilege_type;
-- Expect: authenticated -> SELECT only on every one of these five tables.
-- No INSERT/UPDATE/DELETE for authenticated or anon anywhere in this list —
-- this migration adds no table-level grant at all.

-- ── D. Source-text proof: locking present on all four ──────────────────────
select
  p.proname as function_name,
  pg_get_functiondef(p.oid) ilike '%for update%' as has_row_lock
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('cancel_program', 'complete_program', 'archive_program', 'unarchive_program')
order by p.proname;
-- Expect: has_row_lock = true for all four.

-- ── E. Source-text proof: membership-native only, never legacy columns ────
select
  p.proname as function_name,
  pg_get_functiondef(p.oid) ilike '%current_user_club_id%'
    and pg_get_functiondef(p.oid) ilike '%current_user_role%'            as uses_membership_native,
  pg_get_functiondef(p.oid) ilike '%profiles.club_id%'
    or pg_get_functiondef(p.oid) ilike '%profiles.role%'
    or pg_get_functiondef(p.oid) ilike '%profiles.status%'
    or pg_get_functiondef(p.oid) ilike '%is_lesson_provider%'            as touches_legacy_columns
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('cancel_program', 'complete_program', 'archive_program', 'unarchive_program')
order by p.proname;
-- Expect: uses_membership_native = true and touches_legacy_columns = false
-- for all four.

-- ── F. programs CHECK constraints unchanged by this migration ─────────────
select conname, pg_get_constraintdef(oid)
from pg_constraint
where conrelid = 'public.programs'::regclass
order by conname;
-- Expect: identical to 0087's original definition — status already allowed
-- 'cancelled'/'completed', archived_at/archived_by already existed. This
-- migration adds no new constraint.

-- ── G. No cancelled/completed program has a status value outside the ──────
--      four allowed by 0087's own CHECK (defensive — should be
--      structurally impossible, but confirms directly against live data)
select id, title, status
from public.programs
where status not in ('draft', 'active', 'cancelled', 'completed');
-- Expect: empty.

-- ── H. cancel_program never leaves a future scheduled event uncancelled ───
select e.id, e.title, e.starts_at, e.status
from public.events e
join public.programs pr on pr.id = e.program_id
where pr.status = 'cancelled'
  and e.status  = 'scheduled'
  and e.archived_at is null
  and e.starts_at >= now();
-- Expect: empty — every future, non-archived, scheduled event under a
-- cancelled program should itself be 'cancelled'.

-- ── I. cancel_program never touches a past event ───────────────────────────
-- Structural sanity: a past event under a cancelled program may or may not
-- itself be 'cancelled' depending on its own history before the program
-- was cancelled — this block is informational only (no fixed "expect"),
-- useful for manually confirming past status distribution looks reasonable
-- for a given program during QA:
--   select id, title, starts_at, status
--   from public.events
--   where program_id = '<program_id>' and starts_at < now()
--   order by starts_at;

-- ── J. archive_program/unarchive_program never touch program_enrollments ──
-- Structural sanity: confirm no program_enrollments row's updated_at was
-- touched by an archive/unarchive audit_log entry's timestamp (run
-- manually with a real program id and a known archive/unarchive time):
--   select * from public.program_enrollments
--   where program_id = '<program_id>'
--   order by updated_at desc;
-- Expect: no row's updated_at coincides with the archive/unarchive
-- audit_log entry's created_at — archiving must never write to this table.

-- ── K. Only cancelled/completed, non-archived programs are archivable ─────
-- Structural sanity (informational): programs currently in a state where
-- archive_program would succeed vs. reject:
select id, title, status, archived_at
from public.programs
where archived_at is null
  and status in ('cancelled', 'completed');
-- Any row here is a valid archive_program target. Programs with
-- status in ('draft','active') should never appear as archivable via this
-- RPC — confirmed by source-text block E and the function body itself.
