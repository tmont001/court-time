-- verify_phase27b1.sql
-- Phase 27B1: Programs Schema Foundation — verification.
-- Run in the Supabase SQL Editor AFTER applying migration
-- 0087_programs_schema_foundation.sql.
--
-- READ-ONLY. Every statement in this file is a SELECT. No row is inserted,
-- updated, or deleted. Safe to run multiple times, in production, at any
-- time.
--
-- How to use:
--   1. Apply migration 0087.
--   2. Paste this entire file into the SQL Editor and run it.
--   3. Every "Expected: 0 rows" check must return zero rows. Every
--      "Expected: N rows" / "EXISTS" check must match.
--      Any unexpected row is a gap that must be resolved before 27B2.
--
-- This file does not attempt to verify anything that depends on an
-- auth.uid() session context (e.g. calling current_user_club_id()/
-- current_user_role() plainly from the SQL Editor, which runs without a JWT
-- and would misleadingly report auth.uid() as NULL). Section C confirms the
-- new RLS policies exist and reference the right helpers by inspecting
-- their definitions textually, not by executing them as a real user — a
-- disposable-user RLS smoke test is documented separately in
-- QA_phase27b1.md. Section D proves the table-privilege layer (revoke/grant
-- from migration 0087 section 7) directly against
-- information_schema.role_table_grants — no session context needed for
-- that, since privilege grants are role-level, not row-level.
-- ─────────────────────────────────────────────────────────────────────────────


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION A — TABLES, COLUMNS, CONSTRAINTS
-- ═══════════════════════════════════════════════════════════════════════════

-- A1. All four new tables exist.
-- Expected: 4 rows.
select table_name, 'EXISTS' as status
from information_schema.tables
where table_schema = 'public'
  and table_name in ('programs', 'program_schedule_rules', 'program_rule_courts', 'program_enrollments')
order by table_name;


-- A2. programs columns — exact set, type, nullability.
-- Expected: 15 rows.
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'programs'
order by ordinal_position;


-- A3. Missing programs columns.
-- Expected: 0 rows.
select expected.column_name as missing_column
from (values
  ('id'), ('club_id'), ('event_type_id'), ('title'), ('description'),
  ('enrollment_model'), ('status'), ('starts_on'), ('ends_on'),
  ('default_capacity'), ('created_by'), ('created_at'), ('updated_at'),
  ('archived_at'), ('archived_by')
) as expected(column_name)
left join information_schema.columns c
  on c.table_schema = 'public' and c.table_name = 'programs' and c.column_name = expected.column_name
where c.column_name is null;


-- A4. program_schedule_rules columns — exact set, type, nullability.
-- Expected: 8 rows.
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'program_schedule_rules'
order by ordinal_position;


-- A5. Missing program_schedule_rules columns.
-- Expected: 0 rows.
select expected.column_name as missing_column
from (values
  ('id'), ('program_id'), ('day_of_week'), ('start_time'),
  ('duration_minutes'), ('capacity_override'), ('created_at'), ('updated_at')
) as expected(column_name)
left join information_schema.columns c
  on c.table_schema = 'public' and c.table_name = 'program_schedule_rules' and c.column_name = expected.column_name
where c.column_name is null;


-- A6. program_rule_courts columns — exact set, type, nullability.
-- Expected: 4 rows.
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'program_rule_courts'
order by ordinal_position;


-- A7. program_enrollments columns — exact set, type, nullability.
-- Expected: 7 rows.
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'program_enrollments'
order by ordinal_position;


-- A8. New events columns — exact set, type, nullability.
-- Expected: 4 rows. program_id/program_schedule_rule_id/program_occurrence_date
-- nullable; is_program_exception NOT NULL with default false.
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'events'
  and column_name in ('program_id', 'program_schedule_rule_id', 'program_occurrence_date', 'is_program_exception')
order by column_name;


-- A9. Check constraints — programs (enrollment_model, status, ends_on,
-- default_capacity).
-- Expected: 4 rows.
select conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.programs'::regclass and contype = 'c'
order by conname;


-- A10. Check constraints — program_schedule_rules (day_of_week,
-- duration_minutes, capacity_override).
-- Expected: 3 rows.
select conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.program_schedule_rules'::regclass and contype = 'c'
order by conname;


-- A11. Check constraints — program_enrollments (status, offer-expiry
-- consistency).
-- Expected: 2 rows.
select conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.program_enrollments'::regclass and contype = 'c'
order by conname;


-- A12. Check constraint — events all-or-none program linkage.
-- Expected: 1 row.
select conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.events'::regclass and contype = 'c'
  and conname = 'events_program_linkage_all_or_none';


-- A13. Unique constraints — programs, program_schedule_rules,
-- program_rule_courts, program_enrollments.
-- Expected: 4 rows total (programs itself has no unique constraint beyond
-- its primary key):
--   program_schedule_rules_id_program_id_unique              (program_schedule_rules)
--   program_schedule_rules_program_day_start_unique           (program_schedule_rules)
--   program_rule_courts_program_schedule_rule_id_court_id_key (program_rule_courts)
--   program_enrollments_program_id_profile_id_key             (program_enrollments)
-- plus each table's own primary key is reported separately in A14.
select conrelid::regclass as table_name, conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid in (
    'public.programs'::regclass,
    'public.program_schedule_rules'::regclass,
    'public.program_rule_courts'::regclass,
    'public.program_enrollments'::regclass
  )
  and contype = 'u'
order by table_name, conname;


-- A14. Primary keys — one per new table.
-- Expected: 4 rows.
select conrelid::regclass as table_name, conname
from pg_constraint
where conrelid in (
    'public.programs'::regclass,
    'public.program_schedule_rules'::regclass,
    'public.program_rule_courts'::regclass,
    'public.program_enrollments'::regclass
  )
  and contype = 'p'
order by table_name;


-- A15. Foreign keys — new tables, exact reference + delete rule.
-- Expected: 9 rows:
--   programs.club_id                  -> clubs.id                   (CASCADE)
--   programs.event_type_id            -> event_types.id              (NO ACTION)
--   programs.created_by               -> profiles.id                 (NO ACTION)
--   programs.archived_by              -> profiles.id                 (SET NULL)
--   program_schedule_rules.program_id -> programs.id                 (CASCADE)
--   program_rule_courts.program_schedule_rule_id -> program_schedule_rules.id (CASCADE)
--   program_rule_courts.court_id      -> courts.id                   (CASCADE)
--   program_enrollments.program_id    -> programs.id                 (CASCADE)
--   program_enrollments.profile_id    -> profiles.id                 (NO ACTION)
select
  tc.table_name,
  kcu.column_name,
  ccu.table_name  as references_table,
  ccu.column_name as references_column,
  rc.delete_rule
from information_schema.table_constraints tc
join information_schema.key_column_usage kcu
  on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
join information_schema.constraint_column_usage ccu
  on ccu.constraint_name = tc.constraint_name and ccu.table_schema = tc.table_schema
join information_schema.referential_constraints rc
  on rc.constraint_name = tc.constraint_name and rc.constraint_schema = tc.table_schema
where tc.table_schema = 'public'
  and tc.table_name in ('programs', 'program_schedule_rules', 'program_rule_courts', 'program_enrollments')
  and tc.constraint_type = 'FOREIGN KEY'
order by tc.table_name, kcu.column_name;


-- A16. events — new plain FK (program_id -> programs.id) and composite FK
-- (program_schedule_rule_id, program_id) -> program_schedule_rules(id, program_id).
-- Expected: 2 rows.
select
  tc.constraint_name,
  string_agg(kcu.column_name, ', ' order by kcu.ordinal_position) as columns,
  ccu.table_name as references_table
from information_schema.table_constraints tc
join information_schema.key_column_usage kcu
  on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
join information_schema.constraint_column_usage ccu
  on ccu.constraint_name = tc.constraint_name and ccu.table_schema = tc.table_schema
where tc.table_schema = 'public'
  and tc.table_name = 'events'
  and tc.constraint_type = 'FOREIGN KEY'
  and tc.constraint_name in ('events_program_id_fkey', 'events_program_rule_fkey')
group by tc.constraint_name, ccu.table_name
order by tc.constraint_name;


-- A17. Indexes — new tables (non-constraint-backed) and events.
-- Expected: at least 7 rows: programs_club_id_idx, programs_created_by_idx,
-- program_schedule_rules_program_id_idx, program_rule_courts_rule_id_idx,
-- program_enrollments_program_id_idx, events_program_slot_unique_idx,
-- events_program_id_occurrence_idx.
select indexname, tablename, indexdef
from pg_indexes
where schemaname = 'public'
  and indexname in (
    'programs_club_id_idx',
    'programs_created_by_idx',
    'program_schedule_rules_program_id_idx',
    'program_rule_courts_rule_id_idx',
    'program_enrollments_program_id_idx',
    'events_program_slot_unique_idx',
    'events_program_id_occurrence_idx'
  )
order by tablename, indexname;


-- A18. Missing expected indexes.
-- Expected: 0 rows.
select expected.indexname as missing_index
from (values
  ('programs_club_id_idx'),
  ('programs_created_by_idx'),
  ('program_schedule_rules_program_id_idx'),
  ('program_rule_courts_rule_id_idx'),
  ('program_enrollments_program_id_idx'),
  ('events_program_slot_unique_idx'),
  ('events_program_id_occurrence_idx')
) as expected(indexname)
left join pg_indexes pi on pi.schemaname = 'public' and pi.indexname = expected.indexname
where pi.indexname is null;


-- A19. events_program_slot_unique_idx is actually UNIQUE and partial
-- (has a WHERE clause).
-- Expected: 1 row, indexdef containing both "UNIQUE" and "WHERE".
select indexname, indexdef
from pg_indexes
where schemaname = 'public'
  and indexname = 'events_program_slot_unique_idx'
  and indexdef ilike '%unique%'
  and indexdef ilike '%where%';


-- A20. updated_at triggers on the three tables that carry updated_at
-- (programs, program_schedule_rules, program_enrollments — NOT
-- program_rule_courts, which has no updated_at column by design).
-- Expected: 3 rows.
select c.relname as table_name, t.tgname as trigger_name
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
where c.relname in ('programs', 'program_schedule_rules', 'program_enrollments')
  and not t.tgisinternal
order by c.relname;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION B — LINKAGE INTEGRITY
-- ═══════════════════════════════════════════════════════════════════════════

-- B1. No event violates all-or-none program linkage (defense-in-depth — also
-- structurally guaranteed by events_program_linkage_all_or_none).
-- Expected: 0 rows.
select id, program_id, program_schedule_rule_id, program_occurrence_date
from public.events
where (program_id is null)   <> (program_schedule_rule_id is null)
   or (program_id is null)   <> (program_occurrence_date is null);


-- B2. No pre-existing event was touched — every event has program_id NULL
-- and is_program_exception = false (no generation RPC exists yet in this
-- checkpoint, so this must be 100% of all rows).
-- Expected: 0 rows.
select id from public.events
where program_id is not null
   or program_schedule_rule_id is not null
   or program_occurrence_date is not null
   or is_program_exception is true;


-- B3. No duplicate generated-occurrence slots (defense-in-depth — also
-- structurally guaranteed by events_program_slot_unique_idx).
-- Expected: 0 rows.
select program_schedule_rule_id, program_occurrence_date, count(*) as row_count
from public.events
where program_schedule_rule_id is not null
group by program_schedule_rule_id, program_occurrence_date
having count(*) > 1;


-- B4. No program_schedule_rule is referenced by an event under a different
-- program (defense-in-depth — also structurally guaranteed by
-- events_program_rule_fkey).
-- Expected: 0 rows.
select e.id as event_id, e.program_id as event_program_id, psr.program_id as rule_program_id
from public.events e
join public.program_schedule_rules psr on psr.id = e.program_schedule_rule_id
where e.program_id is distinct from psr.program_id;


-- B5. programs table currently empty (expected in this checkpoint — no
-- creation RPC exists yet). Re-run after 27B2/27C ship; this row count will
-- legitimately become non-zero then.
-- Expected: 0.
select count(*) as program_count from public.programs;


-- B6. No cross-club court assignment: every program_rule_courts row's court
-- belongs to the same club as the owning program. Trivially 0 rows today
-- (no program exists yet — see B5), but this check remains meaningful after
-- 27B2/27C ship, once the create/update RPCs are expected to enforce it.
-- Expected: 0 rows.
select
  prc.id as program_rule_court_id,
  pr.club_id as program_club_id,
  c.club_id as court_club_id
from public.program_rule_courts prc
join public.program_schedule_rules psr on psr.id = prc.program_schedule_rule_id
join public.programs pr on pr.id = psr.program_id
join public.courts c on c.id = prc.court_id
where c.club_id is distinct from pr.club_id;


-- B7. No standalone event (program_id IS NULL) has is_program_exception =
-- true. Structurally guaranteed by the updated events_program_linkage_
-- all_or_none constraint (a standalone event's four program columns must be
-- NULL/NULL/NULL/false together) — this is a defense-in-depth read-back,
-- not a substitute for that constraint.
-- Expected: 0 rows.
select id, program_id, is_program_exception
from public.events
where program_id is null
  and is_program_exception = true;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION C — RLS: ENABLED, EXPECTED POLICIES, NO WRITE ACCESS
-- ═══════════════════════════════════════════════════════════════════════════

-- C1. RLS enabled on all four new tables.
-- Expected: 4 rows, rls_enabled = true.
select relname, relrowsecurity as rls_enabled
from pg_class
where oid in (
  'public.programs'::regclass,
  'public.program_schedule_rules'::regclass,
  'public.program_rule_courts'::regclass,
  'public.program_enrollments'::regclass
)
order by relname;


-- C2. Exactly one SELECT policy per new table, named as expected.
-- Expected: 4 rows.
select schemaname, tablename, policyname, cmd
from pg_policies
where schemaname = 'public'
  and tablename in ('programs', 'program_schedule_rules', 'program_rule_courts', 'program_enrollments')
order by tablename;


-- C3. No INSERT/UPDATE/DELETE policy exists on any new table (writes are
-- RPC-only starting 27B2/27C).
-- Expected: 0 rows.
select schemaname, tablename, policyname, cmd
from pg_policies
where schemaname = 'public'
  and tablename in ('programs', 'program_schedule_rules', 'program_rule_courts', 'program_enrollments')
  and cmd <> 'SELECT';


-- C4. Policy definitions reference current_user_club_id()/
-- current_user_role() — not profiles.club_id/profiles.role — confirming the
-- membership-native permission contract textually.
-- Expected: 4 rows, each qual containing "current_user_club_id" and/or
-- "current_user_role"; none containing "profiles.club_id" or "profiles.role".
select
  tablename,
  policyname,
  qual,
  (qual ilike '%current_user_club_id%' or qual ilike '%current_user_role%') as uses_membership_helper,
  (qual ilike '%profiles.club_id%' or qual ilike '%profiles.role%')          as uses_legacy_profile_column
from pg_policies
where schemaname = 'public'
  and tablename in ('programs', 'program_schedule_rules', 'program_rule_courts', 'program_enrollments')
order by tablename;


-- C5. No existing events/event_participants/event_guests/reservations RLS
-- policy was touched by this migration — spot-check the well-known policy
-- names from 0004/0048/0050 are still present, unchanged in count.
-- Expected: >= 3 rows (events_select_same_club, events_insert_pro_admin,
-- event_participants_select_same_club, plus others already in place).
select schemaname, tablename, policyname, cmd
from pg_policies
where schemaname = 'public'
  and tablename in ('events', 'event_participants', 'event_guests', 'reservations')
order by tablename, policyname;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION D — TABLE PRIVILEGES: EXACT authenticated/anon/PUBLIC GRANTS
-- ═══════════════════════════════════════════════════════════════════════════
-- Proves migration 0087 section 7's explicit revoke/grant statements landed
-- exactly as written: authenticated has SELECT and nothing else on each of
-- the four new tables; anon and PUBLIC have nothing at all.

-- D1. authenticated has exactly one privilege — SELECT — per new table.
-- Expected: 4 rows, one per table, privilege_type = 'SELECT' in every row.
select table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in ('programs', 'program_schedule_rules', 'program_rule_courts', 'program_enrollments')
  and grantee = 'authenticated'
order by table_name, privilege_type;


-- D2. authenticated has NO INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, or
-- TRIGGER privilege on any of the four new tables.
-- Expected: 0 rows.
select table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in ('programs', 'program_schedule_rules', 'program_rule_courts', 'program_enrollments')
  and grantee = 'authenticated'
  and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER');


-- D3. anon has zero privileges of any kind on any of the four new tables.
-- Expected: 0 rows.
select table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in ('programs', 'program_schedule_rules', 'program_rule_courts', 'program_enrollments')
  and grantee = 'anon';


-- D4. PUBLIC has zero privileges of any kind on any of the four new tables
-- (defense-in-depth — the migration's revoke statement names PUBLIC
-- explicitly alongside anon/authenticated).
-- Expected: 0 rows.
select table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in ('programs', 'program_schedule_rules', 'program_rule_courts', 'program_enrollments')
  and grantee = 'PUBLIC';


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION E — NO EXISTING BEHAVIOR CHANGED
-- ═══════════════════════════════════════════════════════════════════════════

-- E1. events row count unchanged in shape — every existing row still passes
-- every pre-existing constraint (defense-in-depth: if this query returns
-- anything other than a clean count, the migration broke something on an
-- existing row, which should be impossible given every new events
-- constraint is satisfied by NULL/false).
select count(*) as total_events from public.events;


-- E2. No existing RPC named in 0004/0048/0049/0050/0060/0062/0066 was
-- redefined by 0087 (spot-check signatures still resolve).
-- Expected: 8 rows, all present.
select proname
from pg_proc
where pronamespace = 'public'::regnamespace
  and proname in (
    'create_event', 'join_event', 'leave_event', 'cancel_event',
    'accept_waitlist_offer', 'decline_waitlist_offer',
    'archive_event', 'set_event_member_joinable'
  )
order by proname;
