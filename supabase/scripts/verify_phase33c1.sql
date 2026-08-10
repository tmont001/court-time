-- verify_phase33c1.sql
-- Phase 33C1: Staff-Managed Reservations — Identity Foundation — POST-migration
-- verification.
--
-- Run in the Supabase SQL Editor AFTER
-- 0108_staff_managed_reservations_identity.sql has been applied. Every
-- query is read-only (no INSERT/UPDATE/DELETE) — safe to run against a
-- live database. Where a query should return an empty result set or a
-- specific value for PASS, that is stated beneath it.
--
-- Rollback notes: see the "Rollback procedure" comment block at the end of
-- 0108_staff_managed_reservations_identity.sql if any check here fails and
-- a revert is needed.

-- ── A. reservations.roster_member_id column and FK exist ───────────────────
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name   = 'reservations'
  and column_name  = 'roster_member_id';
-- Expect: exactly 1 row, data_type = 'uuid', is_nullable = 'YES'.

select conname, confdeltype
from pg_constraint c
join pg_class t on t.oid = c.conrelid
where t.relname = 'reservations'
  and c.contype = 'f'
  and c.conname = 'reservations_roster_member_id_fkey';
-- Expect: exactly 1 row. confdeltype = 'a' (NO ACTION) — deliberately NOT
-- 'n' (SET NULL), matching the migration's stated reasoning: a reservation
-- losing its Member attribution is real history loss, unlike the SET NULL
-- choice made for club_invites/event_guests in Phase 33B1.

-- ── B. reservations.owner_user_id is now nullable ───────────────────────────
select column_name, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name   = 'reservations'
  and column_name  = 'owner_user_id';
-- Expect: exactly 1 row, is_nullable = 'YES'.

-- ── C. Every existing member_booking reservation has a roster identity ─────
select count(*) as member_booking_missing_roster_identity
from public.reservations
where reason = 'member_booking'
  and roster_member_id is null;
-- Expect: 0.

-- ── D. No non-member_booking rows were touched by the backfill ─────────────
-- The migration's backfill UPDATE is filtered to reason='member_booking'
-- only — this independently confirms no maintenance/admin_block/event/
-- pro_lesson row picked up a roster_member_id value.
select reason, count(*) as roster_linked_count
from public.reservations
where roster_member_id is not null
  and reason <> 'member_booking'
group by reason;
-- Expect: zero rows (no reason other than member_booking should ever
-- appear here — pro_lesson is explicitly deferred to Phase 33D1 and was
-- never touched by this migration).

-- ── E. Every member_booking roster_member_id stays within its own club ─────
-- reservations.club_id and the linked roster_members.club_id must always
-- match — both create_reservation and admin_create_member_reservation
-- resolve the roster identity by (club_id, ...) lookups scoped to the
-- caller's own club, so this should be structurally unreachable; this
-- independently confirms that protection actually holds against live data.
select
  r.id as reservation_id, r.club_id as reservation_club_id,
  rm.id as roster_member_id, rm.club_id as roster_member_club_id
from public.reservations r
join public.roster_members rm on rm.id = r.roster_member_id
where r.roster_member_id is not null
  and rm.club_id <> r.club_id;
-- Expect: zero rows.

-- ── F. Structural identity-guard trigger exists and is correctly scoped ────
-- Proves the database-level enforcement added to close the gap RLS alone
-- cannot cover: a direct, RLS-permitted client INSERT into reservations
-- could otherwise satisfy reservations_insert_own while omitting
-- roster_member_id or pointing it at a cross-club/another person's roster
-- identity.
select
  t.tgname                                   as trigger_name,
  p.proname                                  as function_name,
  p.prosecdef                                as function_is_security_definer,
  p.proconfig                                as function_config,
  pg_get_triggerdef(t.oid)                   as trigger_definition
from pg_trigger t
join pg_proc p on p.oid = t.tgfoid
join pg_class c on c.oid = t.tgrelid
where c.relname = 'reservations'
  and t.tgname   = 'reservations_member_booking_identity_guard'
  and not t.tgisinternal;
-- Expect: exactly 1 row. function_is_security_definer = true,
-- function_config contains 'search_path=public, pg_temp'. trigger_
-- definition contains "WHEN ((new.reason = 'member_booking'::text))" and
-- references reason, roster_member_id, owner_user_id, and club_id as the
-- watched UPDATE OF columns — confirming it never fires for, and never
-- alters identity on, maintenance/admin_block/event/pro_lesson rows.

select
  pg_get_functiondef(p.oid) ~ 'new\.roster_member_id\s+is\s+null' as rejects_missing_roster_identity,
  pg_get_functiondef(p.oid) ~ 'v_roster\.club_id\s*<>\s*new\.club_id' as rejects_cross_club_roster_identity,
  pg_get_functiondef(p.oid) ~ 'new\.owner_user_id\s+is\s+not\s+null\s+and\s+v_roster\.claimed_by\s+is\s+distinct\s+from\s+new\.owner_user_id'
    as rejects_owner_mismatch_only_when_owner_present
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'enforce_member_booking_roster_identity';
-- Expect: all three columns true. The third pattern's own "new.owner_
-- user_id is not null AND ..." structure is itself the proof that a NULL
-- owner_user_id never triggers the mismatch check at all — matching
-- "owner_user_id IS NULL remains valid for a staff-created no-account
-- Member reservation." Text-pattern checks, not
-- a full behavioral proof — if any is false, read the function directly
-- with `select pg_get_functiondef(oid) from pg_proc where proname =
-- 'enforce_member_booking_roster_identity'` and confirm by eye, or run the
-- live behavioral test in the implementation report's test plan (attempt
-- a direct insert with roster_member_id null / cross-club / mismatched
-- owner and confirm each is rejected).

-- ── G. Existing reservation row count / id continuity ───────────────────────
-- The migration's backfill is a single UPDATE against reason='member_
-- booking' rows only (verified by reading 0108 directly — grep for
-- "delete from" or "delete from public.reservations" in the migration file
-- returns no matches); no reservation row is inserted, deleted, or
-- renumbered by this migration. No live query can retroactively prove "the
-- same set of ids exists" without a pre-migration snapshot — this section
-- gives a total count for a manual before/after diff against
-- verify_phase33c1_preflight.sql's Section D, run before applying:
select reason, count(*) as row_count
from public.reservations
group by reason
order by reason;
-- Compare against verify_phase33c1_preflight.sql's Section D snapshot,
-- taken before applying. Every reason's count should be identical — this
-- migration never inserts or deletes any reservations row (only the
-- backfill UPDATE and, going forward, ordinary new bookings through the
-- unchanged/new RPCs).

-- ── H. create_reservation — self-only, writes roster identity, fixed search_path ─
select
  p.proname                                  as function_name,
  pg_get_function_identity_arguments(p.oid)  as args,
  p.prosecdef                                as is_security_definer,
  p.proconfig                                as config
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'create_reservation';
-- Expect: exactly 1 row, args identical to the pre-0108 signature
-- (p_court_id uuid, p_starts_at timestamptz, p_ends_at timestamptz,
-- p_format text DEFAULT NULL::text, p_player_count integer DEFAULT
-- NULL::integer, p_guest_names text[] DEFAULT NULL::text[], p_notes text
-- DEFAULT NULL::text) — no new parameter added, confirming no p_target_
-- profile_id or similar was introduced. is_security_definer = true, config
-- contains 'search_path=public, pg_temp' (added in 0108 — the 0059 body
-- never had a fixed search_path).

select
  pg_get_functiondef(p.oid) ~ 'claimed_by\s*=\s*auth\.uid\(\)' as resolves_callers_own_identity,
  pg_get_functiondef(p.oid) ~ 'roster_member_id' as writes_roster_member_id,
  pg_get_functiondef(p.oid) !~ 'p_target_profile_id' as no_target_profile_param,
  pg_get_functiondef(p.oid) !~ 'p_roster_member_id' as no_client_supplied_roster_param
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'create_reservation';
-- Expect: all four columns true. Text-pattern checks on the function body,
-- not a full behavioral proof — if any is false, read the function
-- directly with `select pg_get_functiondef(oid) from pg_proc where
-- proname = 'create_reservation'` and confirm by eye.

-- ── I. admin_create_member_reservation — security, grants, search_path ─────
select
  p.proname                                  as function_name,
  pg_get_function_identity_arguments(p.oid)  as args,
  p.prosecdef                                as is_security_definer,
  p.proconfig                                as config
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'admin_create_member_reservation';
-- Expect: exactly 1 row. is_security_definer = true, config contains
-- 'search_path=public, pg_temp'. args include p_roster_member_id uuid —
-- NOT p_owner_user_id or any owner-identity parameter.

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
  and p.proname = 'admin_create_member_reservation'
order by g.grantee;
-- Expect: can_execute = true ONLY for grantee = 'authenticated'.

-- ── J. owner_user_id is derived server-side, never an RPC identity input ───
select
  pg_get_functiondef(p.oid) ~ 'v_owner_id\s*:=\s*v_roster\.claimed_by'
    as owner_derived_from_roster_row,
  pg_get_functiondef(p.oid) !~ 'p_owner_user_id'
    as no_client_supplied_owner_param,
  pg_get_functiondef(p.oid) ~ 'v_role\s+is\s+distinct\s+from\s+''admin'''
    as admin_only_authorization,
  pg_get_functiondef(p.oid) ~ 'id\s*=\s*p_roster_member_id\s*and\s*club_id\s*=\s*v_club_id'
    as roster_lookup_is_club_scoped
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'admin_create_member_reservation';
-- Expect: all four columns true. Text-pattern checks, not a full
-- behavioral proof — if any is false, read the function directly with
-- `select pg_get_functiondef(oid) from pg_proc where proname =
-- 'admin_create_member_reservation'` and confirm by eye that: (a)
-- owner_user_id is assigned only from the validated roster row's own
-- claimed_by column; (b) no parameter accepts a client-supplied owner
-- identity; (c) the role check rejects any non-admin caller; (d) the
-- roster_member_id lookup is scoped to the caller's own club_id.

-- ── K. RLS still enabled on reservations and roster_members ─────────────────
select relname as table_name, relrowsecurity as rls_enabled
from pg_class
where relname in ('reservations', 'roster_members')
  and relnamespace = 'public'::regnamespace
order by relname;
-- Expect: rls_enabled = true on both rows — this migration does not alter
-- RLS on any table; this confirms it is still on.

select policyname, tablename, cmd
from pg_policies
where schemaname = 'public'
  and tablename   = 'reservations'
order by policyname;
-- Expect: the same two pre-existing policies (reservations_select_
-- same_club, reservations_insert_own) — this migration adds or changes
-- neither of them. A third policy, reservations_cancel_own, existed
-- alongside these two prior to Phase 30B but is correctly ABSENT here: the
-- Phase 30B expand/deploy/contract sequence intentionally removed it in
-- migration 0098, after member self-cancel moved to the RPC-backed
-- cancel_member_reservation path — migration 0097 explicitly documents
-- this planned 0098 removal. Its absence is expected, pre-existing
-- production state, unrelated to and unchanged by 0108. admin_create_
-- member_reservation and the updated create_reservation both remain
-- SECURITY DEFINER, so neither is gated by these client-facing policies at
-- all — same pattern as every other admin/system reservation RPC
-- (update_member_reservation, admin_cancel_reservation, create_
-- maintenance_blocks, create_event). The new reservations_member_booking_
-- identity_guard trigger (Section F) is the layer that now independently
-- protects reservations_insert_own's own direct-client-insert path, since
-- RLS itself still cannot see roster_members.
