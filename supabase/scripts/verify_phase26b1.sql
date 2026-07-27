-- verify_phase26b1.sql
-- Phase 26B1: Club Membership Compatibility Foundation — verification.
-- Run in the Supabase SQL Editor AFTER applying migration
-- 0081_club_membership_compatibility_foundation.sql.
--
-- READ-ONLY. Every statement in this file is a SELECT. No row is inserted,
-- updated, or deleted. Safe to run multiple times, in production, at any
-- time.
--
-- How to use:
--   1. Apply migration 0081.
--   2. Paste this entire file into the SQL Editor and run it.
--   3. Every "Expected: 0 rows" check must return zero rows.
--      Every "Expected: N rows" / "EXISTS" check must match.
--      Any unexpected row is a gap that must be resolved before Phase 26B2.
--
-- This file does NOT attempt to verify anything that depends on an
-- auth.uid() session context (e.g. calling a SECURITY DEFINER RPC plainly
-- from the SQL Editor, which runs without a JWT and would misleadingly
-- report auth.uid() as NULL). No such helper is introduced by 0081 — all
-- four trigger functions here key off the row data supplied by the
-- triggering statement, not off auth.uid(). This caveat becomes relevant
-- starting Phase 26B2 (current_user_club_id, current_user_role,
-- set_active_club) and must be re-stated then.
--
-- A separate, disposable-user, transactional (rolled-back) test of the
-- trigger cascade itself is documented in QA_phase26b1.md — deliberately
-- NOT included here, since it is the one part of this checkpoint that
-- writes data, even if only inside a transaction that is always rolled
-- back.
-- ─────────────────────────────────────────────────────────────────────────────


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION A — SCHEMA
-- ═══════════════════════════════════════════════════════════════════════════

-- A1. club_memberships table exists.
-- Expected: 1 row.
select table_name, 'EXISTS' as status
from information_schema.tables
where table_schema = 'public' and table_name = 'club_memberships';


-- A2. club_memberships columns — exact set, type, nullability.
-- Expected: 13 rows.
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'club_memberships'
order by ordinal_position;


-- A3. Missing club_memberships columns.
-- Expected: 0 rows.
select expected.column_name as missing_column
from (values
  ('id'), ('user_id'), ('club_id'), ('role'), ('status'),
  ('is_lesson_provider'), ('joined_at'), ('invited_by'),
  ('source_invite_id'), ('removed_at'), ('removed_by'),
  ('created_at'), ('updated_at')
) as expected(column_name)
left join information_schema.columns c
  on c.table_schema = 'public'
 and c.table_name   = 'club_memberships'
 and c.column_name  = expected.column_name
where c.column_name is null;


-- A4. profiles.active_club_id exists, nullable, uuid.
-- Expected: 1 row, is_nullable = 'YES'.
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'profiles' and column_name = 'active_club_id';


-- A5. Constraints on club_memberships — PK, unique, checks, FKs.
-- Expected: 1 PRIMARY KEY, 1 UNIQUE, 2 CHECK (role, status), 5 FOREIGN KEY
-- (user_id, club_id, invited_by, source_invite_id, removed_by).
select constraint_name, constraint_type
from information_schema.table_constraints
where table_schema = 'public' and table_name = 'club_memberships'
order by constraint_type, constraint_name;


-- A6. Foreign key targets for club_memberships — exact reference table/column.
-- Expected: 5 rows.
--   user_id          -> profiles.id       (delete: CASCADE)
--   club_id          -> clubs.id          (delete: CASCADE)
--   invited_by       -> profiles.id       (delete: SET NULL)
--   source_invite_id -> club_invites.id   (delete: SET NULL)
--   removed_by       -> profiles.id       (delete: SET NULL)
select
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
  and tc.table_name = 'club_memberships'
  and tc.constraint_type = 'FOREIGN KEY'
order by kcu.column_name;


-- A7. profiles.active_club_id foreign key target.
-- Expected: 1 row -> clubs.id, delete_rule = NO ACTION (matches the existing
-- profiles.club_id -> clubs(id) convention, per migration 0001 — no
-- composite FK; see the migration header comment for why).
select
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
  and tc.table_name = 'profiles'
  and tc.constraint_type = 'FOREIGN KEY'
  and kcu.column_name = 'active_club_id';


-- A8. Check-constraint definitions — confirm exact allowed values.
-- Expected: 2 rows, matching profiles' own role/status check constraints.
select conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.club_memberships'::regclass and contype = 'c'
order by conname;


-- A9. Indexes on club_memberships — exact set and predicates.
-- Expected: 3 rows (plus the implicit unique(user_id, club_id) and PK
-- indexes, which are not partial and are excluded by the predicate filter).
select indexname, indexdef
from pg_indexes
where schemaname = 'public'
  and tablename = 'club_memberships'
  and indexdef ilike '%where%'
order by indexname;


-- A10. Missing partial indexes (by name).
-- Expected: 0 rows.
select expected.indexname as missing_index
from (values
  ('club_memberships_user_active_idx'),
  ('club_memberships_club_active_idx'),
  ('club_memberships_club_admin_active_idx')
) as expected(indexname)
left join pg_indexes pi
  on pi.schemaname = 'public' and pi.tablename = 'club_memberships' and pi.indexname = expected.indexname
where pi.indexname is null;


-- A11. updated_at trigger on club_memberships.
-- Expected: 1 row, calling trigger_set_updated_at.
select tgname, pg_get_triggerdef(oid) as definition
from pg_trigger
where tgrelid = 'public.club_memberships'::regclass and not tgisinternal
  and tgname = 'club_memberships_updated_at';


-- A12. All compatibility triggers exist — exact set, on the right tables/events.
-- Expected: 4 rows total (3 on profiles, 1 on club_memberships).
select
  c.relname as table_name,
  t.tgname  as trigger_name,
  pg_get_triggerdef(t.oid) as definition
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
where c.relname in ('profiles', 'club_memberships')
  and not t.tgisinternal
  and t.tgname in (
    'profiles_sync_active_club',
    'profiles_project_to_membership',
    'profiles_validate_active_club_switch',
    'club_memberships_project_to_profile'
  )
order by c.relname, t.tgname;


-- A13. Missing compatibility triggers.
-- Expected: 0 rows.
select expected.trigger_name as missing_trigger
from (values
  ('profiles_sync_active_club'),
  ('profiles_project_to_membership'),
  ('profiles_validate_active_club_switch'),
  ('club_memberships_project_to_profile')
) as expected(trigger_name)
left join pg_trigger t on t.tgname = expected.trigger_name and not t.tgisinternal
where t.tgname is null;


-- A14. Trigger functions are SECURITY DEFINER with a fixed search_path.
-- Expected: 4 rows, all is_security_definer = true, search_path_setting
-- containing 'search_path=public, pg_temp'.
select
  p.proname as function_name,
  p.prosecdef as is_security_definer,
  p.proconfig as config_settings
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'trg_sync_active_club_before',
    'trg_project_profile_to_membership',
    'trg_project_membership_to_profile',
    'trg_validate_active_club_switch'
  )
order by p.proname;


-- A15. No PUBLIC/anon/authenticated EXECUTE on any trigger function.
-- Expected: 0 rows.
select routine_name, grantee, privilege_type
from information_schema.routine_privileges
where routine_schema = 'public'
  and routine_name in (
    'trg_sync_active_club_before',
    'trg_project_profile_to_membership',
    'trg_project_membership_to_profile',
    'trg_validate_active_club_switch'
  )
  and grantee in ('PUBLIC', 'anon', 'authenticated');


-- A16. RLS is enabled on club_memberships.
-- Expected: 1 row, rowsecurity = true.
select relname, relrowsecurity as rls_enabled
from pg_class
where oid = 'public.club_memberships'::regclass;


-- A17. No RLS policies exist yet on club_memberships (by design for 26B1).
-- Expected: 0 rows.
select policyname
from pg_policies
where schemaname = 'public' and tablename = 'club_memberships';


-- A18. No direct anon/authenticated table privileges on club_memberships.
-- Expected: 0 rows.
select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name = 'club_memberships'
  and grantee in ('anon', 'authenticated');


-- A19. active_club_id is not client-updatable (no UPDATE grant to
-- anon/authenticated on that column, whether from an explicit grant or a
-- leftover table-level grant).
-- Expected: 0 rows.
select grantee, privilege_type, column_name
from information_schema.column_privileges
where table_schema = 'public'
  and table_name = 'profiles'
  and column_name = 'active_club_id'
  and privilege_type = 'UPDATE'
  and grantee in ('anon', 'authenticated');


-- A20. profiles.updated_at trigger — exists, enabled, still calls
-- trigger_set_updated_at. The active_club_id backfill (Section B of the
-- migration) disables and re-enables this exact trigger around one
-- statement; this check confirms it was left enabled at COMMIT, not that it
-- was merely present. tgenabled = 'O' is the normal enabled state ("fires
-- in origin/local mode" — i.e. always, for a normal session). 'D' would
-- mean disabled, which must never be the post-migration state.
-- Expected: 1 row, tgenabled = 'O', definition mentioning
-- trigger_set_updated_at.
select
  tgname,
  tgenabled,
  case tgenabled
    when 'O' then 'ENABLED (normal)'
    when 'D' then 'DISABLED -- BUG: must be re-enabled'
    when 'R' then 'ENABLED (replica-only)'
    when 'A' then 'ENABLED (always)'
    else 'UNKNOWN'
  end as enabled_state,
  pg_get_triggerdef(oid) as definition
from pg_trigger
where tgrelid = 'public.profiles'::regclass
  and not tgisinternal
  and tgname = 'profiles_updated_at';


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION B — BACKFILL
-- ═══════════════════════════════════════════════════════════════════════════

-- B1. Every profile with a club has exactly one club_memberships row.
-- Expected: 0 rows (every count = 1; anything else appears here).
select p.id as profile_id, count(cm.id) as membership_row_count
from public.profiles p
left join public.club_memberships cm
  on cm.user_id = p.id and cm.club_id = p.club_id
where p.club_id is not null
group by p.id
having count(cm.id) <> 1;


-- B2. No duplicate (user_id, club_id) pairs.
-- Expected: 0 rows (also structurally guaranteed by the unique constraint —
-- this is a defense-in-depth sanity check).
select user_id, club_id, count(*) as row_count
from public.club_memberships
group by user_id, club_id
having count(*) > 1;


-- B3. Role / status / is_lesson_provider parity — profile vs. its backfilled
-- membership.
-- Expected: 0 rows.
select
  p.id as profile_id, p.club_id,
  p.role as profile_role, cm.role as membership_role,
  p.status as profile_status, cm.status as membership_status,
  p.is_lesson_provider as profile_provider, cm.is_lesson_provider as membership_provider
from public.profiles p
join public.club_memberships cm
  on cm.user_id = p.id and cm.club_id = p.club_id
where p.club_id is not null
  and (p.role is distinct from cm.role
    or p.status is distinct from cm.status
    or p.is_lesson_provider is distinct from cm.is_lesson_provider);


-- B4. joined_at / created_at / updated_at preserved from the source profile
-- for backfilled rows. Because the active_club_id backfill (Section 3 of
-- the migration) explicitly disables and re-enables profiles_updated_at
-- around its one UPDATE, profiles.updated_at is untouched by the backfill
-- itself — so it should still equal whatever club_memberships.updated_at
-- was copied from it at insert time, unless a genuine post-migration write
-- has since occurred (which would show up here as a real, expected
-- divergence — re-run this check freshly after the backfill, before any
-- live traffic, for the strictest signal).
-- Expected: 0 rows immediately after migration.
select p.id as profile_id,
       p.created_at as profile_created_at, cm.joined_at, cm.created_at as membership_created_at,
       p.updated_at as profile_updated_at, cm.updated_at as membership_updated_at
from public.profiles p
join public.club_memberships cm
  on cm.user_id = p.id and cm.club_id = p.club_id
where p.club_id is not null
  and (cm.joined_at is distinct from p.created_at
    or cm.created_at is distinct from p.created_at
    or cm.updated_at is distinct from p.updated_at);


-- B5. Active profiles have active_club_id = club_id.
-- Expected: 0 rows.
select id, club_id, status, active_club_id
from public.profiles
where club_id is not null
  and status = 'active'
  and active_club_id is distinct from club_id;


-- B6. Inactive/suspended profiles have active_club_id = NULL.
-- Expected: 0 rows.
select id, club_id, status, active_club_id
from public.profiles
where club_id is not null
  and status in ('inactive', 'suspended')
  and active_club_id is not null;


-- B7. No non-null active_club_id points to a missing, different-user,
-- inactive, or removed membership.
-- Expected: 0 rows.
select p.id as profile_id, p.active_club_id
from public.profiles p
where p.active_club_id is not null
  and not exists (
    select 1 from public.club_memberships cm
     where cm.user_id = p.id
       and cm.club_id = p.active_club_id
       and cm.status = 'active'
       and cm.removed_at is null
  );


-- B8. No orphan membership rows (no corresponding profile).
-- Expected: 0 rows (also structurally guaranteed by the FK — sanity check).
select cm.id, cm.user_id
from public.club_memberships cm
left join public.profiles p on p.id = cm.user_id
where p.id is null;


-- B9. No-club profiles (club_id is null) did not gain an active_club_id.
-- Expected: 0 rows. The backfill's WHERE clause excludes these rows
-- entirely, so active_club_id should remain at its column default (NULL)
-- for every one of them.
select id, club_id, active_club_id
from public.profiles
where club_id is null
  and active_club_id is not null;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION C — COMPATIBILITY (read-only parity)
-- ═══════════════════════════════════════════════════════════════════════════

-- C1. Legacy columns vs. the active membership, for every profile with a
-- non-null active_club_id. This must hold at every point in time, not just
-- immediately after backfill — re-run this after any manual trigger test.
-- Expected: 0 rows.
select
  p.id as profile_id, p.active_club_id,
  p.club_id as legacy_club_id, cm.club_id as membership_club_id,
  p.role as legacy_role, cm.role as membership_role,
  p.status as legacy_status, cm.status as membership_status,
  p.is_lesson_provider as legacy_provider, cm.is_lesson_provider as membership_provider
from public.profiles p
join public.club_memberships cm
  on cm.user_id = p.id and cm.club_id = p.active_club_id
where p.active_club_id is not null
  and (p.club_id is distinct from cm.club_id
    or p.role is distinct from cm.role
    or p.status is distinct from cm.status
    or p.is_lesson_provider is distinct from cm.is_lesson_provider);


-- C2. Allowed transitional state (informational, not a failure list):
-- active_club_id is NULL but a legacy club_id is retained, because the
-- underlying membership is inactive/suspended. This is the exact state
-- Phase 26B1 is required to preserve for existing admin RPCs. Row count
-- here should match B6's row count.
select p.id as profile_id, p.club_id as legacy_club_id, p.role as legacy_role,
       p.status as legacy_status, p.active_club_id
from public.profiles p
where p.club_id is not null
  and p.active_club_id is null
  and p.status in ('inactive', 'suspended');
