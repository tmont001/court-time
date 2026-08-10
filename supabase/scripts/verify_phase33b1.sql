-- verify_phase33b1.sql
-- Phase 33B1: Stable Member Identity Foundation — POST-migration verification.
--
-- Run in the Supabase SQL Editor AFTER 0107_roster_identity_foundation.sql
-- has been applied. Every query is read-only (no INSERT/UPDATE/DELETE) —
-- safe to run against a live database. Where a query should return an empty
-- result set or a specific value for PASS, that is stated beneath it.
--
-- Rollback notes: see the "Rollback procedure" comment block at the end of
-- 0107_roster_identity_foundation.sql itself if any check here fails and
-- revert is needed. No rollback migration exists — reverts are documented,
-- manual CREATE OR REPLACE / index / targeted DELETE-or-UPDATE operations.

-- ── A. Zero club_memberships rows lack a roster identity ───────────────────
-- Re-runs the exact same classification as the preflight script. After a
-- successful apply, every row must be A_ALREADY_LINKED — B/C should have
-- been fully resolved by the migration, and D should have been impossible
-- (the migration's own Section 3 guard would have aborted it otherwise).
with membership_identity as (
  select cm.club_id, cm.user_id
  from public.club_memberships cm
  -- No removed_at filter — matches 0107's own scope exactly.
),
classified as (
  select mi.*,
    exists (
      select 1 from public.roster_members rm
       where rm.club_id = mi.club_id and rm.claimed_by = mi.user_id
    ) as is_already_linked
  from membership_identity mi
)
select
  count(*)                                             as total_memberships,
  count(*) filter (where is_already_linked)             as linked,
  count(*) filter (where not is_already_linked)         as unlinked_should_be_zero
from classified;
-- Expect: unlinked_should_be_zero = 0, linked = total_memberships.

-- ── B. Exactly one roster identity per (club, authenticated user) ──────────
select club_id, claimed_by, count(*) as row_count
from public.roster_members
where claimed_by is not null
group by club_id, claimed_by
having count(*) > 1;
-- Expect: zero rows. (The roster_members_club_claimed_by_uniq index from
-- 0107 enforces this at the database level — this query independently
-- confirms no violation exists, which also confirms the index is actually
-- in effect.)

-- ── C. Same authenticated user CAN hold roster identities in multiple clubs ─
select claimed_by, count(distinct club_id) as distinct_clubs
from public.roster_members
where claimed_by is not null
group by claimed_by
having count(distinct club_id) > 1
order by distinct_clubs desc;
-- Informational, not pass/fail on its own. If this club's data includes any
-- genuinely multi-club members, they should appear here with
-- distinct_clubs >= 2 — confirms the old global-uniqueness block (at most
-- one roster identity per user, product-wide) no longer applies. An empty
-- result is still a PASS if no member in this dataset actually belongs to
-- more than one club yet.

-- ── D. Per-club email uniqueness remains intact ─────────────────────────────
select
  indexname,
  indexdef
from pg_indexes
where schemaname = 'public'
  and tablename  = 'roster_members'
  and indexname  = 'roster_members_club_email_uniq';
-- Expect: exactly 1 row, indexdef containing
-- "UNIQUE INDEX roster_members_club_email_uniq ... (club_id, lower(email))
-- WHERE (email IS NOT NULL)" — unchanged by 0107, which never touches this
-- index.

select club_id, lower(email) as normalized_email, count(*) as row_count
from public.roster_members
where email is not null
group by club_id, lower(email)
having count(*) > 1;
-- Expect: zero rows — no per-club email duplicate exists post-migration.

-- ── E. The new per-club claimed_by index exists and the old global one is gone ─
select indexname, indexdef
from pg_indexes
where schemaname = 'public'
  and tablename  = 'roster_members'
  and indexname  = 'roster_members_club_claimed_by_uniq';
-- Expect: exactly 1 row, indexdef containing
-- "UNIQUE INDEX roster_members_club_claimed_by_uniq ... (club_id,
-- claimed_by) WHERE (claimed_by IS NOT NULL)".

select conname
from pg_constraint c
join pg_class t on t.oid = c.conrelid
where t.relname = 'roster_members'
  and c.conname = 'roster_members_claimed_by_key';
-- Expect: zero rows — the old global UNIQUE constraint was dropped.

select conname, confdeltype
from pg_constraint c
join pg_class t on t.oid = c.conrelid
where t.relname = 'roster_members'
  and c.contype = 'f'
  and c.conname = 'roster_members_claimed_by_fkey';
-- Expect: exactly 1 row, confdeltype = 'n' (ON DELETE SET NULL) — the FK to
-- auth.users and its ON DELETE behavior are unchanged by 0107.

-- ── F. Auto-linked (Classification B) roster rows are still present ────────
-- A row where created_by <> claimed_by and claimed_by is not null was
-- created by an admin (add_roster_member/add_roster_member_and_invite)
-- before this migration and later linked — either by 0107's backfill or by
-- accept_club_invite's own auto-link, both of which only ever UPDATE
-- claimed_by/updated_at on the existing row, never delete or replace it.
select count(*) as auto_linked_rows_present
from public.roster_members
where claimed_by is not null
  and created_by <> claimed_by;
-- Informational — confirms such rows exist and were not deleted. Cannot
-- assert an exact expected count without a pre-migration snapshot; cross-
-- check this number is >= the count recorded from
-- verify_phase33b1_preflight.sql's B_SAFE_AUTO_LINK total, run immediately
-- before applying 0107.

-- ── G. Classification-C rows carry the documented created_by = claimed_by signature ─
select count(*) as system_backfilled_rows
from public.roster_members
where claimed_by is not null
  and created_by = claimed_by;
-- Informational — these are rows 0107's Section 5 created. Cross-check this
-- number is >= the preflight's C_CREATE_NEW total.

-- ── H. club_memberships is untouched — role/status/removed_at unaffected ───
-- 0107 contains zero INSERT/UPDATE/DELETE statements against
-- club_memberships anywhere in its body (verify by reading the migration
-- file directly — grep for "club_memberships" shows only SELECT/EXISTS
-- reads). No live query can retroactively prove "nothing changed" without a
-- pre-migration snapshot; this section instead asserts the invariant that
-- should hold given the migration's actual statements, for a manual diff
-- against any snapshot the operator took before applying:
select
  club_id, role, status, count(*) as row_count
from public.club_memberships
group by club_id, role, status
order by club_id, role, status;
-- Compare this distribution against a pre-apply snapshot of the same query,
-- if one was taken. It should be identical — 0107 never writes this table.

-- ── I. No activity-table schema changed ─────────────────────────────────────
select table_name, column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name in
      ('reservations', 'event_participants', 'program_enrollments', 'lesson_requests', 'event_guests')
order by table_name, ordinal_position;
-- Expect: identical to the pre-0107 baseline (Phase 33A's audit — see
-- docs/AUDIT_phase33a.md §2/§3, docs/DESIGN_phase33b.md §2) — no
-- roster_member_id column, no owner_user_id nullability change, no new
-- constraint anywhere in this list. 0107 does not alter any of these
-- tables; this query is here so a diff against that baseline is trivial.

-- ── J. accept_club_invite — grants, security, search_path unchanged in shape ─
select
  p.proname                                  as function_name,
  pg_get_function_identity_arguments(p.oid)  as args,
  p.prosecdef                                as is_security_definer,
  p.provolatile                              as volatility,
  p.proconfig                                as config
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'accept_club_invite';
-- Expect: 1 row, is_security_definer = true, config contains
-- 'search_path=public, pg_temp' — identical to the pre-0107 (0084) function.

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
  and p.proname = 'accept_club_invite'
order by g.grantee;
-- Expect: can_execute = true ONLY for grantee = 'authenticated' — unchanged
-- from 0084.

-- ── K. accept_club_invite's claimed_by guard is now club-scoped, not global ─
-- Regex (not a literal LIKE) so this survives pg_get_functiondef's own
-- whitespace/indentation formatting, which does not necessarily match this
-- migration file's exact spacing. Order-independent: the actual function
-- (0107 Section 3, A_ALREADY_LINKED lookup) writes `club_id = v_invite.
-- club_id and claimed_by = auth.uid()` — club_id first — not `claimed_by =
-- auth.uid() and club_id = ...`. A prior version of this check assumed the
-- latter order and returned a false negative against the correct function.
-- Matching either order proves the same thing (claimed_by is scoped to
-- v_invite.club_id, not global) without being coupled to which clause was
-- written first.
select
  pg_get_functiondef(p.oid) ~ (
    '(club_id\s*=\s*v_invite\.club_id\s*and\s*claimed_by\s*=\s*auth\.uid\(\))' ||
    '|' ||
    '(claimed_by\s*=\s*auth\.uid\(\)\s*and\s*club_id\s*=\s*v_invite\.club_id)'
  ) as guard_is_now_club_scoped
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'accept_club_invite';
-- Expect: guard_is_now_club_scoped = true. This is a text-pattern check on
-- the function body, not a full semantic proof — if this returns false,
-- read the function directly with `select pg_get_functiondef(oid) from
-- pg_proc where proname = 'accept_club_invite'` and confirm by eye that the
-- roster lookup scoped by claimed_by = auth.uid() also carries a club_id =
-- v_invite.club_id condition in the same WHERE clause, matching 0107
-- Section 3's A_ALREADY_LINKED check.

-- ── L. RLS still enabled on every table this checkpoint touches ────────────
select relname as table_name, relrowsecurity as rls_enabled
from pg_class
where relname in ('roster_members', 'club_memberships', 'club_invites', 'profiles')
  and relnamespace = 'public'::regnamespace
order by relname;
-- Expect: rls_enabled = true on every row — 0107 does not alter RLS on any
-- table, this confirms it is still on.

select policyname, tablename, cmd
from pg_policies
where schemaname = 'public'
  and tablename   = 'roster_members'
order by policyname;
-- Expect: the same four policies from 0056 (roster_members_select_admin,
-- roster_members_insert_admin, roster_members_update_admin,
-- roster_members_delete_admin) — 0107 adds or changes none of them.

-- ── M. CORRECTED note — no "skip and log" behavior exists ──────────────────
-- An earlier draft of this section queried audit_log for a
-- 'roster_link_skipped_name_mismatch' action, describing accept_club_invite
-- as skipping the roster auto-link on a name contradiction while still
-- creating the membership. That is not the current implementation:
-- accept_club_invite's v_names_contradict check (0107 Section 3) instead
-- RAISEs roster_identity_conflict and rolls back the ENTIRE acceptance —
-- no membership, no invite consumption, no roster link, no audit_log entry
-- at all, since the whole transaction aborts. No audit action is added
-- here merely to preserve the old text; there is nothing to query, because
-- a rolled-back transaction leaves no row to find. Section Q below verifies
-- the RAISE-based behavior directly against the function's source instead.

-- ── N. SUPERSEDED note ───────────────────────────────────────────────────
-- An earlier revision of this script flagged "Send Invite"/"Resend
-- Invite"/bulk "Generate Invite Links" as an unclosed, database-unfixable
-- gap allowing a membership with no roster identity. That gap is closed as
-- of this revision: invite creation is roster-first (Sections O-P below
-- confirm the RPC shapes), and accept_club_invite (Section Q) independently
-- RAISEs rather than creating such a membership, regardless of invite
-- origin. Section A above remains the authoritative proof for memberships
-- that existed at apply time; Sections O-S below cover the ongoing,
-- forward-looking guarantees this revision adds.

-- ── O. club_invites.roster_member_id column and FK exist ───────────────────
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name   = 'club_invites'
  and column_name  = 'roster_member_id';
-- Expect: exactly 1 row, data_type = 'uuid', is_nullable = 'YES'.

select conname, confdeltype
from pg_constraint c
join pg_class t on t.oid = c.conrelid
where t.relname = 'club_invites'
  and c.contype = 'f'
  and c.conname = 'club_invites_roster_member_id_fkey';
-- Expect: exactly 1 row, confdeltype = 'n' (ON DELETE SET NULL).

-- ── P. create_club_invite / resend_club_invite — signatures, grants, security ─
select
  p.proname                                  as function_name,
  pg_get_function_identity_arguments(p.oid)  as args,
  p.prosecdef                                as is_security_definer,
  p.proconfig                                as config
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('create_club_invite', 'resend_club_invite')
order by p.proname;
-- Expect: 2 rows. create_club_invite's args include "p_roster_member_id
-- uuid" (NOT "p_email text") — confirms the old free-form-email signature
-- is gone, not just shadowed by an overload. Both rows: is_security_definer
-- = true, config contains 'search_path=public, pg_temp'.

select p.proname, p.proargnames
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'create_club_invite';
-- Expect: exactly 1 row (confirms drop function if exists in 0107 actually
-- removed the old 3-arg (text, text, timestamptz) overload rather than
-- leaving two create_club_invite functions coexisting).

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
  and p.proname in ('create_club_invite', 'resend_club_invite')
order by p.proname, g.grantee;
-- Expect: can_execute = true ONLY for grantee = 'authenticated', on both
-- functions.

-- ── Q. accept_club_invite — roster resolution precedes membership INSERT ───
-- Text-pattern check, not a full behavioral proof (that requires exercising
-- the function against real acceptance attempts — see Testing section of
-- the implementation report for the scenarios this was validated against
-- conceptually). Confirms the fail-closed exception strings exist AND that
-- both appear, in the function's source text, BEFORE the club_memberships
-- INSERT — i.e., identity resolution is not merely present somewhere but
-- textually precedes the irreversible write, matching Section 3's design.
select
  pg_get_functiondef(p.oid) ~ 'no_roster_identity'         as has_c_no_roster_identity_check,
  pg_get_functiondef(p.oid) ~ 'roster_identity_conflict'    as has_d_identity_conflict_check,
  position('no_roster_identity' in pg_get_functiondef(p.oid))
    < position('insert into public.club_memberships' in pg_get_functiondef(p.oid))
    as no_roster_identity_check_precedes_membership_insert,
  position('roster_identity_conflict' in pg_get_functiondef(p.oid))
    < position('insert into public.club_memberships' in pg_get_functiondef(p.oid))
    as identity_conflict_check_precedes_membership_insert
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'accept_club_invite';
-- Expect: all four columns true. If any is false, read the function
-- directly with `select pg_get_functiondef(oid) from pg_proc where proname
-- = 'accept_club_invite'` and confirm by eye.

select
  p.prosecdef as is_security_definer,
  p.proconfig as config
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'accept_club_invite';
-- Expect: is_security_definer = true, config contains
-- 'search_path=public, pg_temp' — unchanged from 0084/prior revisions.

-- ── R. No obsolete GLOBAL claimed_by guard remains anywhere ─────────────────
-- The pre-33B1 guard pattern was the exact literal text
-- `where claimed_by = auth.uid()` with no club_id qualification on the same
-- line — Postgres's regex engine does not support lookahead, so this is a
-- deterministic literal-substring check rather than a regex, avoiding any
-- risk of the query itself erroring.
select
  position('where claimed_by = auth.uid()' in pg_get_functiondef(p.oid)) = 0
    as no_unscoped_claimed_by_guard_found
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'accept_club_invite';
-- Expect: true (position 0 means the old unscoped substring was not found
-- anywhere in the function body). If false, read
-- `select pg_get_functiondef(oid) from pg_proc where proname =
-- 'accept_club_invite'` directly and confirm by eye.

-- ── S. Post-apply legacy-invite check (should already be zero — operator
--      resolution happens at PREFLIGHT time, per verify_phase33b1_
--      preflight.sql Section E; this re-confirms nothing slipped through) ──
select
  ci.id as invite_id, ci.code, ci.club_id, ci.email, ci.role, ci.created_at
from public.club_invites ci
where ci.accepted_at is null
  and ci.revoked_at  is null
  and ci.expires_at  > now()
  and (
    (ci.roster_member_id is null and ci.email is null)
    or (
      ci.roster_member_id is null
      and ci.email is not null
      and not exists (
        select 1 from public.roster_members rm
         where rm.club_id      = ci.club_id
           and rm.claimed_by   is null
           and lower(rm.email) = lower(ci.email)
      )
    )
    or (
      ci.roster_member_id is not null
      and exists (
        select 1 from public.roster_members rm
         where rm.id = ci.roster_member_id
           and rm.claimed_by is not null
      )
    )
  );
-- Expect: zero rows. A nonzero result here does not mean 0107 malfunctioned
-- — accept_club_invite will still correctly RAISE for any of these rather
-- than create an unsafe membership — but it means the preflight's Section E
-- was not fully resolved before applying, and these invites are dead links
-- an admin should revoke and recreate.

-- ── T. Integrity check — every roster_member_id-linked invite stays within
--      its own club (verification hardening only) ─────────────────────────
-- create_club_invite's own lookup (0107 Section 2: `where id =
-- p_roster_member_id and club_id = v_profile.club_id`) and
-- accept_club_invite's own lookup (Section 3: `where id =
-- v_invite.roster_member_id and club_id = v_invite.club_id`) both already
-- scope by club_id at write/read time, so this should be structurally
-- unreachable — this check exists to independently confirm that
-- protection is actually in effect against live data, not to compensate
-- for a known gap.
select
  ci.id      as invite_id,
  ci.code,
  ci.club_id as invite_club_id,
  rm.id      as roster_member_id,
  rm.club_id as roster_member_club_id
from public.club_invites ci
join public.roster_members rm on rm.id = ci.roster_member_id
where ci.roster_member_id is not null
  and rm.club_id <> ci.club_id;
-- Expect: zero rows.
