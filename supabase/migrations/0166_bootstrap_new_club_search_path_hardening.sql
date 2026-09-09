-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 34G-D1 — Production Code Hardening
-- Apply the established SECURITY DEFINER search_path convention to
-- bootstrap_new_club, the one confirmed gap found by the 34G-D
-- production-readiness audit.
--
-- bootstrap_new_club (originally 0035, last redefined by 0164) is
-- `language plpgsql security definer` but has never set an explicit
-- search_path — a verbatim carry-forward from its original 0035
-- definition, which predates the search_path-hardening convention every
-- other SECURITY DEFINER function in this schema (0143 onward) already
-- follows. Mitigated in practice: EXECUTE is revoked from public/anon/
-- authenticated and granted only to service_role (0164), so it is not
-- reachable by an ordinary tenant session — but it still deviates from
-- the pattern the rest of the codebase enforces, and closing it is cheap
-- defense-in-depth against a hijacked search_path in whatever session
-- eventually calls it.
--
-- This does NOT rewrite the already-applied 0164 migration or touch the
-- function's body, arguments, or grants in any way — ALTER FUNCTION ...
-- SET search_path attaches a function-level configuration parameter to
-- the EXISTING function by its exact signature, exactly like every other
-- hardened RPC in this schema already carries (`set search_path to
-- 'public', 'pg_temp'`).
-- ═══════════════════════════════════════════════════════════════════════════

alter function public.bootstrap_new_club(
  text, text, text, int, uuid, text[], time, time, int, int, int
) set search_path to 'public', 'pg_temp';
