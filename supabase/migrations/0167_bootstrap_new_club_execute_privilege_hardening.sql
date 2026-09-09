-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 34G-D1 — Production Code Hardening (QA correction)
--
-- LIVE DATABASE FINDING: after applying 0166, direct ACL inspection of
-- bootstrap_new_club (aclexplode) showed EXPLICIT, DIRECT EXECUTE grants to
-- anon and authenticated — not merely inherited PUBLIC access:
--
--   proacl = {postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,
--             service_role=X/postgres}
--
-- ROOT CAUSE (confirmed by reading every migration that has ever touched
-- bootstrap_new_club — 0035 original CREATE, 0074 CREATE OR REPLACE,
-- 0129 CREATE OR REPLACE, 0164 CREATE OR REPLACE, 0166 search_path only):
-- EVERY revoke/grant pair this schema has ever applied to this function
-- (0035:250-256, 0074:249-255, 0164:377-383) is exactly
--
--   revoke execute on function ... from public;
--   grant  execute on function ... to service_role;
--
-- `revoke execute ... from public` only removes the implicit PUBLIC
-- pseudo-role grant every new Postgres function receives by default — it
-- does NOT remove a SEPARATE, explicit grant made directly to a named role
-- (anon/authenticated) at some other point. No migration in this schema's
-- history ever explicitly granted EXECUTE to anon or authenticated on this
-- function, and none ever explicitly revoked it from them either — the
-- live explicit grants observed above therefore did not originate from
-- any migration in this repository (most likely a manual/out-of-band
-- grant applied directly against the database at some point). Because
-- `revoke ... from public` silently coexists with an untouched explicit
-- per-role grant, every prior revoke/grant pass believed this function was
-- already locked down when it was not.
--
-- CONFIRMED before writing this migration:
--   - 0164 is the latest function BODY (no CREATE OR REPLACE after it).
--   - 0166 is the latest search_path configuration (unaffected by this
--     migration — not touched here).
--   - No migration after this one exists yet, so none can restore
--     anon/authenticated execution behind this fix.
--   - There is only the one deployed signature — matches the live ACL
--     inspection's own signature exactly (text/int/time are Postgres-
--     synonymous with the canonical integer/"time without time zone"
--     spelling the live inspection displayed; both forms resolve to the
--     identical function for REVOKE/GRANT's own signature matching).
--
-- This migration does NOT redefine the function body, its arguments, or
-- its search_path (0166, untouched) — REVOKE/GRANT only, explicitly
-- naming every role that must never execute this operator-only,
-- SECURITY DEFINER club-bootstrap function, rather than relying on
-- PUBLIC revocation alone to imply their absence.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

revoke execute
on function public.bootstrap_new_club(
  text,
  text,
  text,
  integer,
  uuid,
  text[],
  time without time zone,
  time without time zone,
  integer,
  integer,
  integer
)
from public, anon, authenticated;

grant execute
on function public.bootstrap_new_club(
  text,
  text,
  text,
  integer,
  uuid,
  text[],
  time without time zone,
  time without time zone,
  integer,
  integer,
  integer
)
to service_role;

commit;
