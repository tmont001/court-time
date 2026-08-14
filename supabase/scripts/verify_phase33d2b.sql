-- verify_phase33d2b.sql
-- Phase 33D2b: Programs (whole-program enrollment) Member Identity Parity —
-- POST-migration verification for 0115_program_enrollment_identity.sql.
--
-- Run in the Supabase SQL Editor AFTER 0115 has been applied. Every query
-- is read-only. Text-pattern function-body checks are not a full
-- behavioral proof — if any is false, read the function directly with
-- `select pg_get_functiondef(oid) from pg_proc where proname = '<name>'`
-- and confirm by eye. These static checks must be supplemented by an
-- authenticated end-to-end manual QA pass this file cannot perform (see
-- the runtime acceptance test matrix in the 33D2b implementation report).
--
-- Rollback notes: see the "Rollback procedure" comment block at the end of
-- 0115_program_enrollment_identity.sql if any check here fails.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. program_enrollments schema — roster_member_id NOT NULL, profile_id
--    nullable, both unique constraints present, FK correct
-- ═══════════════════════════════════════════════════════════════════════════
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name   = 'program_enrollments'
  and column_name  in ('profile_id', 'roster_member_id')
order by column_name;
-- Expect: 2 rows. profile_id: is_nullable = 'YES'. roster_member_id:
-- data_type = 'uuid', is_nullable = 'NO'.

select conname, contype
from pg_constraint c
join pg_class t on t.oid = c.conrelid
where t.relname = 'program_enrollments'
  and c.conname in (
    'program_enrollments_roster_member_id_uniq',
    'program_enrollments_program_id_profile_id_key'
  )
order by conname;
-- Expect: 2 rows (exact name of the pre-existing profile_id unique
-- constraint may differ slightly if Postgres auto-named it at table
-- creation — if this returns only 1 row, cross-check via:
--   select conname from pg_constraint where conrelid =
--   'public.program_enrollments'::regclass and contype = 'u';
-- and confirm both program_id+roster_member_id and program_id+profile_id
-- are covered). Both must be type 'u' (unique).

select conname
from pg_constraint c
join pg_class t on t.oid = c.conrelid
where t.relname = 'program_enrollments'
  and c.contype  = 'f'
  and c.conname  = 'program_enrollments_roster_member_id_fkey';
-- Expect: exactly 1 row.

select indexname
from pg_indexes
where schemaname = 'public'
  and tablename   = 'program_enrollments'
  and indexname   = 'program_enrollments_roster_member_id_idx';
-- Expect: exactly 1 row.

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. No NULL roster identities; existing rows backfilled correctly;
--    row counts preserved
-- ═══════════════════════════════════════════════════════════════════════════
select count(*) as rows_with_null_roster_member_id
from public.program_enrollments
where roster_member_id is null;
-- Expect: 0 (structurally impossible given the NOT NULL constraint above —
-- included as a direct data assertion, not just a schema-metadata one).

select pe.id, pe.profile_id, pe.roster_member_id, rm.claimed_by,
       rm.club_id as roster_club_id, pr.club_id as program_club_id
from public.program_enrollments pe
join public.programs pr on pr.id = pe.program_id
join public.roster_members rm on rm.id = pe.roster_member_id
where pe.profile_id is not null
  and (rm.claimed_by is distinct from pe.profile_id or rm.club_id is distinct from pr.club_id);
-- Expect: 0 rows — every backfilled row's roster identity matches its
-- historical profile_id and shares its program's club.

select count(*) as total_program_enrollments_post_migration
from public.program_enrollments;
-- Compare against the preflight script's "total_program_enrollments"
-- baseline — must be identical (0115 backfills a column, it never
-- inserts, updates the status of, or deletes any existing row).

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Duplicate durable-enrollment canary
-- ═══════════════════════════════════════════════════════════════════════════
select program_id, roster_member_id, count(*)
from public.program_enrollments
group by program_id, roster_member_id
having count(*) > 1;
-- Expect: 0 rows — the new unique constraint enforces this going forward;
-- this also proves no pre-existing data already violates it.

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. SEARCH_PATH / SECURITY DEFINER audit — every function modified or
--    added by 0115
-- ═══════════════════════════════════════════════════════════════════════════
with expected(proname) as (
  values
    ('join_program'), ('leave_program'), ('accept_program_waitlist_offer'),
    ('decline_program_waitlist_offer'), ('add_program_member'), ('remove_program_member'),
    ('add_program_roster_member'), ('remove_program_roster_member'),
    ('force_confirm_program_roster_member'), ('get_program_eligible_roster_members'),
    ('generate_program_sessions'), ('get_program_roster'),
    ('_materialize_program_member_into_future_events'),
    ('_cancel_program_member_future_participation')
)
select
  expected.proname,
  p.oid is not null                                              as function_exists,
  coalesce(p.prosecdef, false)                                   as is_security_definer,
  coalesce(
    exists (
      select 1 from unnest(p.proconfig) cfg
      where cfg like 'search_path=%public%'
        and cfg like '%pg_temp%'
    ),
    false
  )                                                               as has_fixed_search_path,
  p.proconfig                                                     as raw_config
from expected
left join pg_proc p
  on p.proname = expected.proname
 and p.pronamespace = 'public'::regnamespace
order by expected.proname;
-- Expect: 14 rows, function_exists / is_security_definer / has_fixed_
-- search_path all true for every row. Note: if a function is legitimately
-- overloaded (it is not, for any of these 14 — each has exactly one
-- signature after 0115), this join could under- or over-count; the
-- overload-count check in section 5 independently guards against that.

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. Function signatures / return shapes / grants
-- ═══════════════════════════════════════════════════════════════════════════
select
  p.proname,
  count(*)                                              as overload_count,
  array_agg(pg_get_function_identity_arguments(p.oid))  as arg_signatures,
  array_agg(pg_get_function_result(p.oid))              as return_shapes
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'join_program', 'leave_program', 'accept_program_waitlist_offer',
    'decline_program_waitlist_offer', 'add_program_member', 'remove_program_member',
    'add_program_roster_member', 'remove_program_roster_member',
    'force_confirm_program_roster_member', 'get_program_eligible_roster_members',
    'generate_program_sessions', 'get_program_roster',
    '_materialize_program_member_into_future_events',
    '_cancel_program_member_future_participation',
    'get_program_eligible_members', 'cancel_program', 'complete_program',
    'archive_program', 'unarchive_program', '_expire_stale_program_offers',
    '_advance_program_waitlist_offer', '_program_is_enrollable'
  )
group by p.proname
order by p.proname;
-- Expect: 22 rows, every overload_count = 1. In particular:
--   join_program(uuid), leave_program(uuid), accept_program_waitlist_
--     offer(uuid), decline_program_waitlist_offer(uuid), add_program_
--     member(uuid, uuid), remove_program_member(uuid, uuid),
--     generate_program_sessions(uuid, date, date) — signatures IDENTICAL
--     to pre-0115 (every change to these seven was CREATE OR REPLACE only).
--   _materialize_program_member_into_future_events(uuid, uuid, uuid),
--     _cancel_program_member_future_participation(uuid, uuid, uuid) — same
--     PostgreSQL type identity as before (uuid, uuid, uuid) but via
--     explicit DROP+CREATE (second-argument semantic change).
--   get_program_roster(uuid) — same input signature, DROP+CREATE for the
--     return-shape change; return_shapes should now include
--     roster_member_id uuid in its TABLE(...) listing.
--   add_program_roster_member(uuid, uuid, uuid), remove_program_roster_
--     member(uuid, uuid, uuid), force_confirm_program_roster_member(uuid,
--     uuid, uuid), get_program_eligible_roster_members(uuid) — brand new.
--   get_program_eligible_members, cancel_program, complete_program,
--     archive_program, unarchive_program, _expire_stale_program_offers,
--     _advance_program_waitlist_offer, _program_is_enrollable — untouched,
--     confirming 0115 did not accidentally introduce a stray overload of
--     anything outside its own stated scope.

select
  p.proname, g.grantee,
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
    'decline_program_waitlist_offer', 'add_program_member', 'remove_program_member',
    'add_program_roster_member', 'remove_program_roster_member',
    'force_confirm_program_roster_member', 'get_program_eligible_roster_members',
    'generate_program_sessions', 'get_program_roster'
  )
order by p.proname, g.grantee;
-- Expect: can_execute = true ONLY for grantee = 'authenticated', for all
-- twelve — every client-facing function's exposure is unchanged/correctly
-- new (admin-only/pro-owner enforcement happens inside each function body,
-- not at the grant level).

select
  p.proname, g.grantee,
  has_function_privilege(
    case g.grantee when 'PUBLIC' then 'public' else g.grantee end,
    p.oid, 'EXECUTE'
  ) as can_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join (values ('PUBLIC'), ('anon'), ('authenticated')) as g(grantee)
where n.nspname = 'public'
  and p.proname in (
    '_materialize_program_member_into_future_events',
    '_cancel_program_member_future_participation'
  )
order by p.proname, g.grantee;
-- Expect: can_execute = false for every row — both remain internal-only,
-- exactly as before their DROP+CREATE (grants explicitly re-issued as
-- "none" in 0115, not merely assumed to survive the DROP).

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. FOUND-lifetime correctness — every reactivation writer
-- ═══════════════════════════════════════════════════════════════════════════
-- join_program, add_program_member, add_program_roster_member, and
-- _materialize_program_member_into_future_events are the four functions
-- with a genuine UPDATE-vs-INSERT reactivation branch. Each must capture
-- FOUND into a stable v_existing_found boolean immediately after its own
-- `SELECT ... FOR UPDATE`, branch only on that boolean (never a later bare
-- FOUND), and guard its write with a fail-closed null-id check.
select
  p.proname,
  pg_get_functiondef(p.oid) ~ 'v_existing_found := found;'
    as captures_stable_found_immediately,
  pg_get_functiondef(p.oid) ~ 'if v_existing_found then'
    as branches_on_stable_boolean,
  pg_get_functiondef(p.oid) !~ 'if found then\s*\n\s*update'
    as no_leftover_bare_found_reactivation_branch,
  pg_get_functiondef(p.oid) ~ 'v_result\.id is null'
    as has_fail_closed_write_guard
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'join_program', 'add_program_member', 'add_program_roster_member',
    '_materialize_program_member_into_future_events'
  )
order by p.proname;
-- Expect: 4 rows, all four columns true for every row.

-- leave_program, remove_program_member, remove_program_roster_member,
-- accept_program_waitlist_offer, decline_program_waitlist_offer, and
-- force_confirm_program_roster_member deliberately have NO reactivation
-- branch (each only ever UPDATEs a row already located by its own primary
-- key) — confirm none of them was given a spurious v_existing_found
-- variable it doesn't need (a signal the implementation drifted from the
-- approved architecture) and, for force_confirm specifically, that it
-- still carries its own fail-closed write guard despite having no
-- reactivation branch.
select
  p.proname,
  pg_get_functiondef(p.oid) ~ 'v_existing_found'
    as has_reactivation_variable_unexpectedly
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'leave_program', 'remove_program_member', 'remove_program_roster_member',
    'accept_program_waitlist_offer', 'decline_program_waitlist_offer',
    'force_confirm_program_roster_member'
  )
order by p.proname;
-- Expect: 6 rows, has_reactivation_variable_unexpectedly = false for every
-- row.

select
  pg_get_functiondef(p.oid) ~ 'v_result\.id is null'
    as has_fail_closed_write_guard
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'force_confirm_program_roster_member';
-- Expect: 1 row, true.

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. Materialization / cancellation use roster identity, not profile_id
-- ═══════════════════════════════════════════════════════════════════════════
select
  pg_get_function_identity_arguments(p.oid) as args,
  pg_get_functiondef(p.oid) ~ 'select claimed_by into v_current_member_id'
    as resolves_claimed_by_fresh,
  pg_get_functiondef(p.oid) ~ 'roster_member_id = p_roster_member_id'
    as matches_by_roster_identity
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = '_materialize_program_member_into_future_events';
-- Expect: 1 row, args = 'p_program_id uuid, p_roster_member_id uuid,
-- p_club_id uuid' (parameter RENAMED, not merely reordered — confirms the
-- DROP+CREATE actually took effect rather than a stale cached definition),
-- both boolean columns true.

select
  pg_get_function_identity_arguments(p.oid) as args,
  pg_get_functiondef(p.oid) ~ 'ep\.roster_member_id\s*=\s*p_roster_member_id'
    as matches_by_roster_identity
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = '_cancel_program_member_future_participation';
-- Expect: 1 row, args = 'p_program_id uuid, p_roster_member_id uuid,
-- p_club_id uuid', matches_by_roster_identity = true.

-- Every caller of these two helpers must pass a roster_member_id variable,
-- never auth.uid()/p_profile_id, as the second argument.
select
  p.proname,
  pg_get_functiondef(p.oid) ~ '_materialize_program_member_into_future_events\(p_program_id,\s*(v_roster_member_id|p_roster_member_id)'
    as materialize_call_uses_roster_identity
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'join_program', 'accept_program_waitlist_offer', 'add_program_member',
    'add_program_roster_member', 'force_confirm_program_roster_member'
  )
  and pg_get_functiondef(p.oid) ~ '_materialize_program_member_into_future_events\(';
-- Expect: every returned row has materialize_call_uses_roster_identity = true.

select
  p.proname,
  pg_get_functiondef(p.oid) ~ '_cancel_program_member_future_participation\(p_program_id,\s*(v_roster_member_id|p_roster_member_id|v_old\.roster_member_id)'
    as cancel_call_uses_roster_identity
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('leave_program', 'remove_program_member', 'remove_program_roster_member')
  and pg_get_functiondef(p.oid) ~ '_cancel_program_member_future_participation\(';
-- Expect: every returned row has cancel_call_uses_roster_identity = true.

-- ═══════════════════════════════════════════════════════════════════════════
-- 8. generate_program_sessions uses roster identity for materialization
-- ═══════════════════════════════════════════════════════════════════════════
select
  pg_get_functiondef(p.oid) ~ 'join public\.roster_members rm\s*\n?\s*on\s+rm\.id\s*=\s*pe\.roster_member_id'
    as joins_by_roster_member_id,
  pg_get_functiondef(p.oid) ~ 'select v_new_event\.id,\s*rm\.claimed_by,\s*pe\.roster_member_id'
    as inserts_roster_member_id_and_fresh_claimed_by,
  pg_get_functiondef(p.oid) !~ 'v_unresolved_members'
    as removed_now_unreachable_preflight_guard
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'generate_program_sessions';
-- Expect: 1 row, all three columns true.

-- ═══════════════════════════════════════════════════════════════════════════
-- 9. get_program_roster — roster-aware return shape and display fallback
-- ═══════════════════════════════════════════════════════════════════════════
select
  pg_get_function_result(p.oid) as returns_table_shape,
  pg_get_functiondef(p.oid) ~ 'left join public\.profiles p on p\.id = pe\.profile_id'
    as profile_join_is_left_join,
  pg_get_functiondef(p.oid) ~ 'left join public\.roster_members rm on rm\.id = pe\.roster_member_id'
    as has_roster_fallback_join,
  pg_get_functiondef(p.oid) ~ 'coalesce\(p\.first_name,\s*rm\.first_name\)'
    as falls_back_to_roster_name
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'get_program_roster';
-- Expect: 1 row. returns_table_shape must include "roster_member_id uuid"
-- in its TABLE(...) listing. All three boolean columns true — the INNER
-- joins from the pre-0115 body were deliberately widened to LEFT JOINs
-- (a no-account row's profile_id is null; an INNER join would silently
-- drop that row from the roster view entirely).

-- ═══════════════════════════════════════════════════════════════════════════
-- 10. Eligible-roster lookup authorization
-- ═══════════════════════════════════════════════════════════════════════════
select
  pg_get_functiondef(p.oid) ~ 'current_user_role\(\)'
    as uses_current_user_role,
  pg_get_functiondef(p.oid) ~ 'v_role = .pro. and v_program\.created_by <> auth\.uid\(\)'
    as enforces_pro_ownership,
  pg_get_functiondef(p.oid) ~ 'claimed_by is null'
    as sources_unclaimed_roster_only,
  pg_get_functiondef(p.oid) ~ 'not exists'
    as excludes_already_enrolled
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'get_program_eligible_roster_members';
-- Expect: 1 row, all four columns true.

-- Confirm get_roster_members() itself was NOT modified by 0115 (the
-- architecture explicitly forbids broadening it).
select prosrc is not null as function_exists
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname  = 'get_roster_members';
-- Expect: 1 row, true — existence only check; this script does not (and
-- should not) assert anything about its body, since 0115 must not touch it.

-- ═══════════════════════════════════════════════════════════════════════════
-- 11. RLS — claim-continuity policy is roster-aware, cross-club safe
-- ═══════════════════════════════════════════════════════════════════════════
select policyname, cmd, qual
from pg_policies
where schemaname = 'public'
  and tablename   = 'program_enrollments'
order by policyname;
-- Expect: exactly 1 policy, "program_enrollments_select", cmd = 'SELECT'.
-- qual text should contain both
-- "program_enrollments.profile_id = auth.uid()" and
-- "program_enrollments.roster_member_id = current_user_roster_member_id()"
-- joined by OR, alongside the unchanged admin/pro branches, and the outer
-- "pr.club_id = current_user_club_id()" scoping — confirm the roster
-- clause sits INSIDE that same exists() as the profile_id clause (not a
-- separate, unscoped top-level OR, which would be a cross-club leak).

select relrowsecurity as rls_enabled
from pg_class
where relname = 'program_enrollments' and relnamespace = 'public'::regnamespace;
-- Expect: true — unchanged.

-- ═══════════════════════════════════════════════════════════════════════════
-- 12. Historical identity fields never rewritten passively
-- ═══════════════════════════════════════════════════════════════════════════
-- No function should ever UPDATE profile_id on an existing row for a
-- reason other than an explicit reactivation action (join_program /
-- add_program_member / add_program_roster_member reactivating a row they
-- own) — none of these is a passive claim-triggered rewrite. The pure
-- read/lifecycle/notification-path functions below must never write
-- profile_id at all.
select p.proname
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'leave_program', 'accept_program_waitlist_offer', 'decline_program_waitlist_offer',
    'remove_program_member', 'remove_program_roster_member',
    'force_confirm_program_roster_member', '_expire_stale_program_offers',
    '_advance_program_waitlist_offer', 'generate_program_sessions'
  )
  and pg_get_functiondef(p.oid) ~ 'set\s+[^;]*\bprofile_id\s*=';
-- Expect: 0 rows — none of these nine functions ever sets profile_id in an
-- UPDATE ... SET list. (generate_program_sessions only ever INSERTs new
-- event_participants rows, never UPDATEs program_enrollments.profile_id —
-- this check specifically guards program_enrollments writes, and none of
-- these nine touch that column via UPDATE at all.)

-- ═══════════════════════════════════════════════════════════════════════════
-- 13. Scope discipline — untouched functions/tables remain untouched
-- ═══════════════════════════════════════════════════════════════════════════
select prosrc is not null as still_exists
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'create_program', 'update_program', 'preview_program_sessions',
    'cancel_program', 'complete_program', 'archive_program', 'unarchive_program',
    'get_program_eligible_members', '_expire_stale_program_offers',
    '_advance_program_waitlist_offer', '_program_is_enrollable', 'get_roster_members'
  );
-- Expect: 12 rows (one per proname matched), all still_exists = true —
-- confirms nothing in this out-of-scope list was accidentally dropped.

select relrowsecurity
from pg_class
where relname in ('programs', 'program_schedule_rules', 'program_rule_courts', 'event_guests')
  and relnamespace = 'public'::regnamespace;
-- Expect: all true, unchanged — 0115 touches no RLS outside program_
-- enrollments.
