-- 0218_admin_cancel_reservation_v1_retirement.sql
-- Phase 45E2 — ACL-only retirement of the obsolete v1 Admin cancellation
-- RPC from normal authenticated application callers.
--
-- APPROVED FINDING (Phase 45E audit, P1): public.admin_cancel_reservation
-- (uuid) predates the current payment/cancellation foundation and lacks
-- the protections public.admin_cancel_reservation_v2(uuid) has — no
-- payment-row locking, no Stripe Checkout-invalidation guard, no
-- uncollected-balance release, no refund-request workflow. It remained
-- EXECUTE-granted to `authenticated` only because its full retirement was
-- explicitly out of scope for the Phase 45D3B mechanical hygiene pass
-- (0215), which only revoked its `anon` grant alongside every other
-- Category B function, preserving `authenticated`/`service_role`
-- identically. This checkpoint closes that gap directly.
--
-- FRESH LIVE PRECHECK (performed this checkpoint, not assumed):
--   admin_cancel_reservation(uuid):    owner postgres, SECURITY DEFINER,
--     search_path=public,pg_temp, proacl {postgres=X, authenticated=X,
--     service_role=X} — no PUBLIC, no anon.
--   admin_cancel_reservation_v2(uuid): owner postgres, SECURITY DEFINER,
--     search_path=public,pg_temp, proacl {postgres=X, authenticated=X,
--     service_role=X} — no PUBLIC, no anon. Unchanged, canonical, not
--     touched by this migration.
--   App call-site search: the sole application entry point,
--   adminCancelReservation() in src/app/(app)/calendar/actions.ts, calls
--   ONLY "admin_cancel_reservation_v2" (both its initial call and its
--   checkout-resolution retry). No `.rpc("admin_cancel_reservation"` call
--   (v1) exists anywhere in application code — the few remaining mentions
--   of the bare name are historical/informal prose comments referring to
--   "the admin cancellation path" by its original name, not literal calls.
--   SQL dependency search: no other live public function body references
--   admin_cancel_reservation( — confirmed via pg_get_functiondef text
--   search across every function in the public schema.
--   Conclusion: v1 has zero current runtime dependency from any
--   authenticated-role caller, application or SQL.
--
-- THE FIX: revoke EXECUTE from `authenticated` only. `service_role`
-- retains its existing explicit access (unaffected — no client-facing
-- surface uses it, but its ACL is not part of this remediation's scope).
-- No GRANT, no CREATE OR REPLACE, no ALTER FUNCTION, no DROP FUNCTION, no
-- function body change, no RLS change, no table change. v1's SQL body is
-- untouched and remains exactly as evidenced above — only its reachability
-- from `authenticated` clients (direct REST/JS RPC calls, independent of
-- any UI code path) is removed.
--
-- Resulting contract:
--   admin_cancel_reservation(uuid) v1:  PUBLIC no EXECUTE / anon no EXECUTE
--     / authenticated no EXECUTE / service_role unchanged.
--   admin_cancel_reservation_v2(uuid):  unchanged in every respect.
--
-- Created by this checkpoint. Do NOT apply until reviewed.

begin;

revoke execute
on function public.admin_cancel_reservation(uuid)
from authenticated;

commit;
