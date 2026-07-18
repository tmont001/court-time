-- 0068_harden_phase22_function_search_path.sql
-- Phase 22D security hardening: fix missing fixed search_path on Phase 22
-- SECURITY DEFINER functions.
--
-- Why this matters
-- ----------------
-- A SECURITY DEFINER function runs with the privileges of the function owner
-- (typically postgres/superuser in Supabase).  Without a fixed search_path the
-- function's name resolution uses the caller's current search_path at call time.
-- A malicious or misconfigured caller could prepend a schema they control to
-- search_path, causing the function to resolve table and function names against
-- attacker-controlled objects rather than the intended public schema tables.
--
-- The canonical fix is:
--   ALTER FUNCTION ... SET search_path = public, pg_temp;
--
-- pg_temp is included so temporary objects (used in advisory-lock patterns and
-- intermediate query results) are still accessible, but no other schema can be
-- injected ahead of public.
--
-- Scope
-- -----
-- Migrations 0064–0066 defined their SECURITY DEFINER functions without a fixed
-- search_path.  Migration 0067 already includes the correct setting.  This
-- migration retroactively hardens 0064–0066, and also re-applies the setting to
-- the two 0067 functions as defense-in-depth (ALTER FUNCTION is idempotent for
-- this attribute — applying it to an already-correct function is safe).
--
-- What this migration does NOT change
-- ------------------------------------
-- - No function bodies are modified.
-- - No schema columns, tables, indexes, or data are modified.
-- - No role logic, eligibility checks, or audit behavior is altered.
-- - No REVOKE or GRANT statements: privileges established in 0064–0067 are unchanged.
--
-- Rerun safety
-- ------------
-- ALTER FUNCTION ... SET search_path is fully idempotent.  Applying this
-- migration more than once produces the same result as applying it once.
-- Safe to apply in any environment, including production.

-- ─── 0064: update_club_timezone ──────────────────────────────────────────────
alter function public.update_club_timezone(text)
  set search_path = public, pg_temp;

-- ─── 0065: create_event_type ─────────────────────────────────────────────────
alter function public.create_event_type(text, text)
  set search_path = public, pg_temp;

-- ─── 0065: update_event_type ─────────────────────────────────────────────────
alter function public.update_event_type(uuid, text, text)
  set search_path = public, pg_temp;

-- ─── 0065: set_event_type_active ─────────────────────────────────────────────
alter function public.set_event_type_active(uuid, boolean)
  set search_path = public, pg_temp;

-- ─── 0065: check_event_type_active (trigger function) ────────────────────────
-- Trigger functions are invoked by the database engine, not by users, so no
-- REVOKE/GRANT is needed or applicable.  The search_path hardening still applies:
-- a trigger function is SECURITY DEFINER and runs with owner privileges.
alter function public.check_event_type_active()
  set search_path = public, pg_temp;

-- ─── 0066: set_event_member_joinable ─────────────────────────────────────────
alter function public.set_event_member_joinable(uuid, boolean)
  set search_path = public, pg_temp;

-- ─── 0066: delete_event_type ─────────────────────────────────────────────────
alter function public.delete_event_type(uuid)
  set search_path = public, pg_temp;

-- ─── 0067: add_roster_member_and_invite (defense-in-depth) ───────────────────
alter function public.add_roster_member_and_invite(text, text, text, text, text, text)
  set search_path = public, pg_temp;

-- ─── 0067: accept_club_invite (defense-in-depth) ─────────────────────────────
alter function public.accept_club_invite(text)
  set search_path = public, pg_temp;
