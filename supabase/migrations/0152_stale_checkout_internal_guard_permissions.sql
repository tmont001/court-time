-- 0152_stale_checkout_internal_guard_permissions.sql
-- Phase 34E-A follow-up — internal-helper permission correction.
--
-- Post-0151 runtime verification against the live database showed
-- explicit EXECUTE grants remained on public._invalidate_or_flag_open_
-- checkout_attempt(uuid) for anon, authenticated, AND service_role, even
-- though 0151's own `revoke all ... from public` was applied. Confirmed
-- diagnostics:
--   anon_can_execute          = true
--   authenticated_can_execute = true
--   service_role_can_execute  = true
-- information_schema.routine_privileges showed EXECUTE still granted to
-- anon, authenticated, postgres, and service_role.
--
-- `revoke all ... from public` revokes the privilege PUBLIC pseudo-role
-- grants to everyone by default — it does not retract an EXPLICIT prior
-- grant already held by a specific role. This function was created via
-- `create or replace function`, which does not reset previously-granted
-- privileges on a pre-existing routine of the same name/signature; the
-- explicit anon/authenticated/service_role grants were already present
-- (inherited from PostgreSQL's own default EXECUTE-to-PUBLIC behavior on
-- function creation, captured as explicit per-role rows before 0151's own
-- revoke ran) and 0151's blanket `from public` did not remove them.
--
-- This is an internal helper (revoke all on function ... from public
-- comment in 0151 already states the intent: "Not granted to any role —
-- callable only from within another SECURITY DEFINER function in this
-- schema"). It must only be reachable transitively, by another SECURITY
-- DEFINER function's own `perform` call — never directly by anon,
-- authenticated, or service_role. postgres/owner execution (the role
-- that runs migrations and owns the function) is untouched by this
-- revoke and remains available, exactly as for every other internal
-- helper in this schema (_create_payment_obligation, _adjust_payment_
-- obligation, _check_member_reassignment_allowed).
--
-- Scope discipline: 0151 is already applied and is not modified here —
-- this is a narrow, forward-only permission correction, no logic change,
-- no schema change, no new table/column/function.
--
-- Apply in Supabase SQL Editor (cloud only).

begin;

revoke execute
  on function public._invalidate_or_flag_open_checkout_attempt(uuid)
  from public, anon, authenticated, service_role;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback (manual, cloud SQL Editor) — re-grants exactly what this
-- migration revoked, restoring the pre-0152 (post-0151) grant state.
-- Uncomment and run top-to-bottom if 0152 must be reverted after being
-- applied.
-- ═══════════════════════════════════════════════════════════════════════════
-- begin;
--
-- grant execute
--   on function public._invalidate_or_flag_open_checkout_attempt(uuid)
--   to anon, authenticated, service_role;
--
-- commit;
