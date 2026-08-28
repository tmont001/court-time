-- 0158_payment_internal_helper_privilege_hardening.sql
-- Phase 34E-D runtime verification follow-up — internal-helper privilege
-- hardening. Targeted repair only, not a permissions-model rewrite.
--
-- ── The problem (live PostgreSQL evidence, post-0157) ────────────────────
-- After 0157 was applied, live pg_proc.proacl was inspected directly for
-- the payment-internal SECURITY DEFINER helpers below and showed:
--
--   {postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
--
-- This is NOT inherited PUBLIC access — anon and authenticated hold
-- EXPLICIT per-role grants. Every one of these seven functions already
-- carries a `revoke all ... from public` statement in its own origin
-- migration (0143/0149), but — exactly as 0152 already established for
-- _invalidate_or_flag_open_checkout_attempt — revoking PUBLIC's access
-- does not retract an ALREADY-EXPLICIT prior grant held by a specific
-- role. In this project, Supabase's own default-privileges mechanism
-- grants EXECUTE on every newly created public-schema function to anon/
-- authenticated/service_role explicitly at creation time, independent of
-- any `revoke ... from public` the migration itself issues. That explicit
-- grant is what live pg_proc.proacl actually showed.
--
-- Every one of these seven functions is a pure internal PL/pgSQL helper
-- or trigger function (see this phase's own source audit — confirmed via
-- direct search of src/ and every migration): none is ever called
-- directly from application/server code (zero `.rpc("_...")` call sites
-- anywhere in src/), and none is intended for direct anon/authenticated
-- invocation. anon/authenticated holding live EXECUTE on them is an
-- unintended, unnecessary direct-browser-role invocation surface that
-- must be closed.
--
-- ── The fix ───────────────────────────────────────────────────────────
-- For exactly the seven functions below: `revoke execute ... from
-- public, anon, authenticated` — explicitly naming anon/authenticated,
-- never relying on a bare `from public` again. service_role is left
-- completely untouched (still has EXECUTE) — every one of these helpers
-- still fires correctly as a trigger (SECURITY DEFINER trigger functions
-- run under the function owner's privileges regardless of the invoking
-- role's own EXECUTE grant — trigger firing does not require the firing
-- role to hold EXECUTE) and _recompute_payment_rollup/_create_payment_
-- obligation/_adjust_payment_obligation/_check_member_reassignment_
-- allowed still work exactly as before when called via `perform` from
-- another SECURITY DEFINER function (an internal PL/pgSQL call, not a
-- role-level RPC invocation — also does not require the calling role to
-- separately hold EXECUTE on the callee).
--
-- ── Scope discipline ──────────────────────────────────────────────────
-- No function body, SECURITY DEFINER status, search_path, table,
-- constraint, index, trigger, RLS policy, or any OTHER function's grants
-- are touched. No Supabase global/default-privileges configuration is
-- altered — this migration only revokes the SPECIFIC, ALREADY-EXPLICIT
-- per-role grants live evidence proved exist on these seven functions.
-- Other underscore-prefixed helpers (including lesson-availability
-- helpers confirmed to intentionally allow authenticated execution) are
-- NOT touched — this is a targeted list of exactly seven, not a mass
-- underscore-prefix sweep.
--
-- Apply in Supabase SQL Editor (cloud only).

begin;

revoke execute on function public._adjust_payment_obligation(uuid, text, uuid, uuid, integer, uuid)
  from public, anon, authenticated;

revoke execute on function public._check_member_reassignment_allowed(uuid, text, uuid)
  from public, anon, authenticated;

revoke execute on function public._create_payment_obligation(uuid, text, uuid, uuid, integer, uuid, boolean)
  from public, anon, authenticated;

revoke execute on function public._enforce_currency_lock_on_payment_history()
  from public, anon, authenticated;

revoke execute on function public._payment_events_after_insert()
  from public, anon, authenticated;

revoke execute on function public._recompute_payment_rollup(uuid)
  from public, anon, authenticated;

revoke execute on function public._validate_payment_event_reversal()
  from public, anon, authenticated;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback (manual, cloud SQL Editor) — re-grants exactly what this
-- migration revoked (anon, authenticated — service_role was never
-- touched), restoring the pre-0158 live grant state. Uncomment and run
-- top-to-bottom if 0158 must be reverted after being applied.
-- ═══════════════════════════════════════════════════════════════════════════
-- begin;
--
-- grant execute on function public._adjust_payment_obligation(uuid, text, uuid, uuid, integer, uuid)
--   to anon, authenticated;
--
-- grant execute on function public._check_member_reassignment_allowed(uuid, text, uuid)
--   to anon, authenticated;
--
-- grant execute on function public._create_payment_obligation(uuid, text, uuid, uuid, integer, uuid, boolean)
--   to anon, authenticated;
--
-- grant execute on function public._enforce_currency_lock_on_payment_history()
--   to anon, authenticated;
--
-- grant execute on function public._payment_events_after_insert()
--   to anon, authenticated;
--
-- grant execute on function public._recompute_payment_rollup(uuid)
--   to anon, authenticated;
--
-- grant execute on function public._validate_payment_event_reversal()
--   to anon, authenticated;
--
-- commit;
