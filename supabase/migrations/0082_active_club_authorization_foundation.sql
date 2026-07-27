-- 0082_active_club_authorization_foundation.sql
-- Phase 26B2: Active-Club Authorization Foundation
--
-- Redefines current_user_club_id() and current_user_role() to derive from
-- club_memberships (via profiles.active_club_id) instead of reading
-- profiles.club_id/role directly, adds current_user_is_lesson_provider(),
-- and adds set_active_club() — the only authenticated primitive that may
-- change a user's active club.
--
-- Focused pre-implementation audit (see the Phase 26B2 report for full
-- detail) confirmed:
--   • current_user_club_id()/current_user_role() are defined once, in
--     0002_rls_policies.sql, and have never been redefined or given an
--     explicit REVOKE/GRANT — they are PUBLIC-executable by Postgres
--     default today. This migration is the first to lock that down.
--   • Every RLS policy in the schema that authorizes by club/role does so
--     through these two functions, with ONE exception:
--     lesson_requests_select_admin (0069_lesson_requests.sql) reads
--     `(select role from public.profiles where id = auth.uid())` directly,
--     bypassing the helper entirely. This is unaffected by this migration
--     either way (it never called the helper before, and still doesn't) —
--     flagged for Phase 26C's RLS conversion pass, not touched here.
--   • No RPC body (other than the RLS policies discussed below) calls
--     either helper function directly — every existing RPC does its own
--     independent `select * into v_profile from profiles where id =
--     auth.uid()`. This migration changes no RPC body.
--   • No application code calls either helper directly (confirmed via
--     repository search) — only auto-generated Supabase types reference
--     their names.
--
-- THIS MIGRATION DOES CHANGE EXACTLY TWO RLS POLICIES — both narrowly, both
-- on public.profiles, both made necessary by the fail-closed redefinition
-- above (see section 4 below for the full detail and reasoning):
--
--   • profiles_select_same_club — the original USING clause
--     (`club_id = current_user_club_id()`) relied on current_user_club_id()
--     returning a value for every existing user, which was true under the
--     OLD (status-blind) definition but is no longer true for an inactive/
--     suspended/removed/no-club user under the new one. Without a
--     correction, such a user would lose the ability to read even their
--     OWN profile row — breaking basic self-identity lookups (e.g.
--     getAuthProfile) for every account this migration is specifically
--     supposed to leave working. Corrected to add an `id = auth.uid()`
--     branch so a user can always see their own row, in addition to same
--     (active) club visibility.
--
--   • profiles_update_own_row — the original WITH CHECK
--     (`role = current_user_role()`) was a role-escalation guard that
--     depended on current_user_role() reflecting profiles.role
--     unconditionally. After this migration, current_user_role() correctly
--     returns NULL whenever there is no valid active membership, which
--     would reject even an inactive user's legitimate
--     first_name/last_name/phone self-edit. The guard is also now
--     redundant: migration 0079 already restricts authenticated UPDATE to
--     exactly first_name/last_name/phone at the column-privilege level, so
--     role escalation is already structurally impossible regardless of any
--     RLS check. Corrected to drop the role comparison entirely, leaving a
--     plain own-row check.
--
-- No other RLS policy is changed. Neither correction broadens what any
-- user can see or do beyond their own row and their own active club — see
-- the Phase 26B2 report for the full non-broadening argument.
--
-- No existing SECURITY DEFINER RPC body is changed by this migration.
-- No application code is touched.
--
-- ATOMICITY: the entire file runs inside one transaction. If any statement
-- fails, the whole migration rolls back — no partial redefinition can ever
-- be left in place. No exception handler here catches and swallows a
-- migration failure.
--
-- Independently safe to deploy and leave in production with zero Phase 26C
-- application changes: every currently-active single-club user resolves the
-- exact same club_id/role/is_lesson_provider as before (proven by the
-- static parity query in verify_phase26b2.sql), every existing RLS policy
-- and RPC (other than the two narrow corrections above) keeps working
-- unchanged, and set_active_club is unreachable by any UI that doesn't yet
-- exist.
--
-- Apply in Supabase SQL Editor (cloud only). Not applied by this checkpoint.

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Private helper — public._current_user_active_membership()
-- ═══════════════════════════════════════════════════════════════════════════
-- Underscore-prefixed per the repository's existing convention for internal,
-- non-client-facing helpers (see _lesson_check_pro_availability,
-- _lesson_check_operating_hours, _lesson_check_member_availability in
-- 0070_lesson_competitive_foundation.sql).
--
-- Returns only the four columns needed for authorization — never the full
-- club_memberships row, never joined_at/invited_by/removed_by/
-- source_invite_id/timestamps. Zero rows in every invalid state (see the
-- predicate below); at most one row, guaranteed by club_memberships'
-- unique(user_id, club_id) constraint together with the single-valued
-- profiles.active_club_id join.
--
-- SQL language (not PL/pgSQL) — a single SELECT is the simplest and
-- clearest form for this predicate. SECURITY DEFINER so it can read
-- club_memberships despite that table's RLS being enabled with zero
-- policies (0081) — the same established pattern current_user_club_id()/
-- current_user_role() already use to read profiles despite profiles' own
-- RLS. EXECUTE is revoked from PUBLIC, anon, AND authenticated — this
-- helper is never meant to be called directly by any client, and revoking
-- authenticated EXECUTE also means PostgREST will not expose it as a
-- callable RPC endpoint for any role.
create or replace function public._current_user_active_membership()
returns table (
  club_id            uuid,
  role               text,
  status             text,
  is_lesson_provider boolean
)
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select cm.club_id, cm.role, cm.status, cm.is_lesson_provider
    from public.club_memberships cm
    join public.profiles p
      on p.active_club_id = cm.club_id
   where p.id = auth.uid()
     and cm.user_id = auth.uid()
     and cm.status = 'active'
     and cm.removed_at is null;
$$;

revoke execute on function public._current_user_active_membership()
  from public, anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. current_user_club_id() — redefined
-- ═══════════════════════════════════════════════════════════════════════════
-- Same name, same (zero) argument list, same uuid return type as the
-- original 0002_rls_policies.sql definition, so CREATE OR REPLACE keeps
-- every existing RLS policy and dependency intact with no further change.
-- No longer reads profiles.club_id at all, directly or as a fallback —
-- resolves exclusively through the private active-membership helper, so an
-- invalid/stale active_club_id (pointing at an inactive, suspended, or
-- removed membership) can never be trusted: it simply yields no row, hence
-- NULL.
create or replace function public.current_user_club_id()
returns uuid
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select club_id from public._current_user_active_membership();
$$;

revoke execute on function public.current_user_club_id() from public, anon;
grant  execute on function public.current_user_club_id() to authenticated;
-- The focused audit found no prior explicit grant to any other role for
-- this function (it was PUBLIC-executable by unrevoked Postgres default) —
-- there is nothing else to preserve.


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. current_user_role() — redefined
-- ═══════════════════════════════════════════════════════════════════════════
-- Same name/signature/return type as the original. No longer reads
-- profiles.role directly or as a fallback — the per-club role now comes
-- exclusively from the active membership.
create or replace function public.current_user_role()
returns text
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select role from public._current_user_active_membership();
$$;

revoke execute on function public.current_user_role() from public, anon;
grant  execute on function public.current_user_role() to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. profiles RLS — two narrow corrections made necessary by sections 2-3
-- ═══════════════════════════════════════════════════════════════════════════
-- Both use ALTER POLICY (not DROP + CREATE) so each policy keeps its exact
-- original name and there is no window, even a transaction-internal one,
-- where the policy does not exist. Both are scoped to public.profiles only
-- — no other table's RLS is touched.

-- ---------------------------------------------------------------------------
-- 4a. profiles_select_same_club
-- ---------------------------------------------------------------------------
-- Before: using (club_id = current_user_club_id())
-- This worked unconditionally pre-0082 because the old current_user_club_id()
-- returned profiles.club_id regardless of status, so it always equaled the
-- caller's own row's club_id, making the caller's own row visible as a side
-- effect of the same-club check. After sections 2-3 above,
-- current_user_club_id() is NULL for any user without a valid active
-- membership — for such a user the old expression would match nothing at
-- all, including their own row.
--
-- After: a user may always select their own row (id = auth.uid()),
-- independent of active-club state, PLUS same-active-club visibility for
-- everyone else exactly as before. The `club_id` on the right of the OR
-- refers to the CANDIDATE ROW being tested (i.e. some other user's
-- profiles.club_id, ordinary row data) compared against the caller's own
-- membership-derived current_user_club_id() — this is the identical
-- pattern every other "select_same_club" policy in this schema already
-- uses (clubs_select_same_club, courts_select_same_club, etc.); it does not
-- read the LEGACY profiles.club_id for the CALLER's own authorization
-- context, only for the row being evaluated, which is not a caller-identity
-- concept at all.
--
-- No broadening: an inactive/suspended/removed/no-club caller still cannot
-- see any row belonging to any other user (current_user_club_id() is NULL,
-- so the second branch never matches); an active caller still cannot see
-- any row outside their own active club. The only row newly visible beyond
-- pre-0082 behavior, in any state, is the caller's own — which pre-0082
-- was already visible in every state via the (then status-blind) same-club
-- match.
alter policy "profiles_select_same_club" on public.profiles
  using (
    id = auth.uid()
    or club_id = public.current_user_club_id()
  );

-- ---------------------------------------------------------------------------
-- 4b. profiles_update_own_row
-- ---------------------------------------------------------------------------
-- Before: using (id = auth.uid()) with check (id = auth.uid() and
-- role = current_user_role())
-- The `role = current_user_role()` clause was a role-escalation guard.
-- After sections 2-3, current_user_role() is NULL for any user without a
-- valid active membership, so `role = NULL` is never true — such a user's
-- otherwise-legitimate first_name/last_name/phone self-edit would be
-- rejected outright.
--
-- The guard is also redundant, independent of the above: migration 0079
-- already revoked table-level UPDATE and re-granted it column-by-column to
-- exactly (first_name, last_name, phone). A client cannot include role,
-- status, club_id, active_club_id, is_lesson_provider, or admin_notes in an
-- UPDATE's SET list at all — PostgreSQL rejects that at the column-privilege
-- level before RLS's WITH CHECK is ever evaluated. Column-level grants (0079)
-- now provide the sensitive-column boundary; this policy's job is only the
-- own-row boundary, which a bare `id = auth.uid()` already fully expresses
-- on both USING and WITH CHECK.
--
-- No broadening: nothing about which COLUMNS are writable changes — that
-- boundary is enforced entirely by 0079's grants, untouched here. This
-- correction only removes a role comparison that had become an unconditional
-- rejection for a subset of users, without ever having added any real
-- privilege-escalation protection beyond what the column grants already
-- provide.
alter policy "profiles_update_own_row" on public.profiles
  using (id = auth.uid())
  with check (id = auth.uid());


-- ═══════════════════════════════════════════════════════════════════════════
-- 5. current_user_is_lesson_provider() — new
-- ═══════════════════════════════════════════════════════════════════════════
-- Returns the ACTIVE membership's is_lesson_provider — never
-- profiles.is_lesson_provider, no fallback. Coalesced to a concrete `false`
-- (rather than left NULL like the two functions above) because this value
-- is intended for direct use in boolean expressions, where a bare NULL
-- would propagate unpredictably through AND/OR rather than failing closed
-- the way an equality comparison against NULL already does.
--
-- Not wired into any existing Lesson RPC in this migration — that
-- conversion is explicitly Phase 26C3's scope.
create or replace function public.current_user_is_lesson_provider()
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select coalesce(
    (select is_lesson_provider from public._current_user_active_membership()),
    false
  );
$$;

revoke execute on function public.current_user_is_lesson_provider() from public, anon;
grant  execute on function public.current_user_is_lesson_provider() to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 6. set_active_club(uuid) — new
-- ═══════════════════════════════════════════════════════════════════════════
-- The only authenticated primitive that may change profiles.active_club_id.
--
-- Lock order: profiles row FIRST, club_memberships row SECOND. This is not
-- an arbitrary choice — it is the exact order already implicitly
-- established by every existing legacy writer's own cascade through the
-- 0081 triggers: set_member_role/set_member_status/set_lesson_provider_status
-- all UPDATE a profiles row first (acquiring that row's lock), and only as
-- a consequence (via Trigger A2's AFTER-trigger upsert) ever touch a
-- club_memberships row. Locking in the same order here — profiles, then
-- club_memberships — means no code path in this system ever locks the two
-- tables in opposite order, which is what would be required to produce a
-- classic lock-order-inversion deadlock between set_active_club and a
-- concurrent admin action on the same user.
--
-- The target membership row is locked FOR UPDATE (not merely SELECTed) so
-- a concurrent admin deactivation/removal cannot race between this
-- function's validation and its write — any concurrent set_member_status/
-- set_member_role/removal touching the same membership row will block
-- until this transaction commits or rolls back, and vice versa.
--
-- All invalid-target cases collapse to the same stable, non-enumerating
-- 'invalid_active_club' error, so a caller cannot distinguish "that club
-- doesn't exist," "you're not a member," "your membership is inactive,"
-- "suspended," or "removed" from one another.
--
-- IDENTIFIER SAFETY: this function's own RETURNS TABLE declares columns
-- named club_id, role, status, and is_lesson_provider — the exact same
-- names as columns on both public.profiles and public.club_memberships.
-- Every table reference below is therefore explicitly aliased (public.
-- profiles p, public.club_memberships cm) and every column reference is
-- qualified through that alias or through the v_profile/v_membership
-- record variables, so no bare identifier can ever be resolved against the
-- function's own OUT parameters instead of the intended table column. No
-- plpgsql.variable_conflict directive is used anywhere — ambiguity is
-- eliminated structurally, not silenced.
create or replace function public.set_active_club(p_club_id uuid)
returns table (
  club_id            uuid,
  role               text,
  status             text,
  is_lesson_provider boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile    public.profiles%rowtype;
  v_membership public.club_memberships%rowtype;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  -- 1. Lock the caller's own profiles row first. p_club_id is never used to
  -- look up any row belonging to another user — every query in this
  -- function is scoped by auth.uid(). Aliased as p throughout, even though
  -- "id" alone does not collide with any OUT parameter name, for
  -- consistency with the club_memberships lookup below (which does have a
  -- real collision) and to make every table reference in this function
  -- unambiguous by inspection.
  select p.* into v_profile
    from public.profiles p
   where p.id = auth.uid()
   for update;

  if not found then
    raise exception 'not_authenticated';
  end if;

  if p_club_id is null then
    raise exception 'invalid_active_club';
  end if;

  -- 2. Lock the target membership row second, stabilizing it against a
  -- concurrent deactivation/removal for the remainder of this transaction.
  -- Scoped strictly to (auth.uid(), p_club_id) — this can never resolve to
  -- another user's membership regardless of what p_club_id is. Aliased as
  -- cm: club_id here would otherwise be ambiguous between the
  -- club_memberships.club_id column and this function's own OUT parameter
  -- of the same name.
  select cm.* into v_membership
    from public.club_memberships cm
   where cm.user_id = auth.uid()
     and cm.club_id = p_club_id
   for update;

  if not found
     or v_membership.status <> 'active'
     or v_membership.removed_at is not null
  then
    -- Covers: unrelated club, missing membership, inactive, suspended, and
    -- removed — identically, on purpose. Never reveal which.
    raise exception 'invalid_active_club';
  end if;

  -- Idempotent path: verification above already ran unconditionally, so an
  -- already-active target is confirmed valid before we ever get here. No
  -- write, no profiles.updated_at change, no audit entry.
  if v_profile.active_club_id = p_club_id then
    return query
      select v_membership.club_id  as club_id,
             v_membership.role     as role,
             v_membership.status   as status,
             v_membership.is_lesson_provider as is_lesson_provider;
    return;
  end if;

  -- Genuine switch: touch active_club_id only. profiles.club_id/role/
  -- status/is_lesson_provider are deliberately never set explicitly here —
  -- Trigger C from migration 0081 (profiles_validate_active_club_switch)
  -- re-validates the same membership and projects its values onto the
  -- legacy fields as part of this exact statement. That trigger fires
  -- because active_club_id is in this statement's own SET list; it does
  -- not cause Trigger A1/A2 to fire (they are bound to club_id/role/status/
  -- is_lesson_provider, none of which are targets of this UPDATE's SET
  -- clause) — see the Phase 26B1 report's recursion-termination proof.
  -- The alias `p` is used for the WHERE clause; the SET target column
  -- (active_club_id) is deliberately left unqualified, since Postgres UPDATE
  -- syntax requires the assigned column name in the SET list to be bare
  -- regardless of whether the target table is aliased.
  update public.profiles p
     set active_club_id = p_club_id
   where p.id = auth.uid();

  return query
    select v_membership.club_id  as club_id,
           v_membership.role     as role,
           v_membership.status   as status,
           v_membership.is_lesson_provider as is_lesson_provider;
end;
$$;

revoke execute on function public.set_active_club(uuid) from public, anon;
grant  execute on function public.set_active_club(uuid) to authenticated;

-- No audit_log entry is written for a routine active-club switch, by
-- deliberate decision: audit_log is visible to the DESTINATION club's
-- admins (audit_log_select_admin, 0005_audit_log.sql), so recording a
-- switch there would reveal to that club's admins that this user also
-- belongs to (or was formerly active in) another club — a cross-club
-- membership disclosure this checkpoint's own security invariants forbid.
-- A routine context switch is also not an administrative mutation of any
-- club's state, unlike every other audit_log-writing RPC in this schema.

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration is created
-- in this checkpoint)
-- ═══════════════════════════════════════════════════════════════════════════
-- Rolling back 0082 must NOT roll back 0081. To revert 0082 in place:
--   1. CREATE OR REPLACE FUNCTION public.current_user_club_id() back to its
--      pre-0082 body:
--        returns uuid language sql security definer stable as $$
--          select club_id from profiles where id = auth.uid();
--        $$;
--      (drop the explicit REVOKE/GRANT pair, or leave it — the audit found
--      no evidence the original PUBLIC-executable default was relied upon
--      by anything; re-granting to PUBLIC is optional and not required for
--      correctness.)
--   2. CREATE OR REPLACE FUNCTION public.current_user_role() back to its
--      pre-0082 body:
--        returns text language sql security definer stable as $$
--          select role from profiles where id = auth.uid();
--        $$;
--   3. ALTER POLICY "profiles_select_same_club" ON public.profiles
--        USING (club_id = current_user_club_id());
--   4. ALTER POLICY "profiles_update_own_row" ON public.profiles
--        USING (id = auth.uid())
--        WITH CHECK (id = auth.uid() and role = current_user_role());
--      Steps 3-4 must run AFTER steps 1-2 (the pre-0082 helper bodies must
--      already be restored, since the restored policy text calls them).
--   5. DROP FUNCTION public.current_user_is_lesson_provider();
--   6. DROP FUNCTION public.set_active_club(uuid);
--   7. DROP FUNCTION public._current_user_active_membership();
-- Steps 5-7 must run before nothing else references them (nothing in this
-- repository does, by design — no RPC, RLS policy, or application code
-- calls any of the four objects introduced here except through the two
-- redefined functions' own bodies). club_memberships, profiles.active_club_id,
-- and all four 0081 compatibility triggers remain untouched by this
-- rollback — they are safe to leave in place indefinitely regardless of
-- whether 0082 is applied.
