-- 0215_legacy_security_hygiene.sql
-- Phase 45D3B — mechanical hygiene remediation for the 51-function set
-- identified by the Phase 45D3A read-only audit (live pg_proc/pg_namespace
-- metadata, re-verified fresh this checkpoint): 27 SECURITY DEFINER
-- functions missing an explicit search_path, and 50 with `anon` EXECUTE
-- (49 client-facing/trigger functions to correct + validate_club_invite,
-- which intentionally keeps anon), plus a table-privilege lock-down for the
-- dormant public.v_profile table. No function body is touched anywhere in
-- this migration, and v_profile's schema/rows/RLS are untouched — every
-- statement is ALTER FUNCTION ... SET search_path, REVOKE EXECUTE, or
-- REVOKE ALL PRIVILEGES ON TABLE public.v_profile, nothing else. This is
-- defense-in-depth/consistency hardening, not a fix for a live exploit:
-- every sampled function (18+ of 27 read in full across the 45D3A/45D
-- audits) already self-checks auth.uid()/role internally, and
-- `anon`/`authenticated` have no CREATE privilege on the public schema
-- (verified live), so search_path hijacking has no viable injection point
-- today regardless.
--
-- V_PROFILE ACL PROVENANCE PRECHECK (read-only, performed live before
-- writing this migration, not assumed):
--   - pg_class.relacl for public.v_profile:
--     {postgres=arwdDxtm/postgres, anon=arwdDxtm/postgres,
--      authenticated=arwdDxtm/postgres, service_role=arwdDxtm/postgres}
--     — anon/authenticated hold FULL relation-level privileges directly
--     (arwdDxtm = INSERT/SELECT/UPDATE/DELETE/TRUNCATE/REFERENCES/
--     TRIGGER/MAINTAIN), not merely SELECT/INSERT/UPDATE/REFERENCES.
--   - pg_attribute.attacl for all 14 non-dropped columns: NULL on every
--     single one. No explicit column-level ACL entries exist anywhere.
--   CONCLUSION: all client privileges on v_profile originate at the
--   RELATION level only, and cover every privilege type, not a narrow
--   subset. information_schema.role_column_grants reporting per-column
--   entries for anon/authenticated was Postgres's standard column-level-
--   grant-equivalent reporting of the underlying relation-level grant (its
--   normal behavior when attacl is null), not evidence of a separate
--   column ACL — confirmed directly against the catalog, not inferred.
--   Because the full grant is relation-level and covers every privilege
--   type, the correct fix is a plain relation-level
--   `REVOKE ALL PRIVILEGES ON TABLE ... FROM <role>` per role — narrower
--   REVOKEs (e.g. only SELECT/INSERT/UPDATE/REFERENCES) would leave
--   DELETE/TRUNCATE/TRIGGER/MAINTAIN behind, which migration review caught
--   and this revision corrects. No column-specific REVOKE statement is
--   needed (zero column ACLs exist to revoke).
--
-- Category recap (full evidence trail in the Phase 45D3A report):
--   A — validate_club_invite: intentionally anonymous (pre-auth invite
--       landing page, src/app/(auth)/join/[code]/page.tsx) — search_path
--       pinned here, EXECUTE ACL (anon + authenticated) explicitly left
--       untouched.
--   B — 39 authenticated client RPCs — anon EXECUTE revoked;
--       authenticated/service_role left untouched. Includes
--       admin_cancel_reservation and create_maintenance_block (confirmed
--       dead — superseded by _v2/plural — but their full retirement is
--       explicitly out of scope for this mechanical pass; only anon is
--       revoked, matching every other Category B function identically).
--   C — set_member_notes: ACL already service_role-only (confirmed live,
--       unchanged); only search_path is pinned here.
--   D — 10 trigger functions (confirmed live via pg_trigger — each has
--       exactly one real, enabled trigger on a real table; zero direct
--       app-code .rpc() callers found) — direct EXECUTE revoked from both
--       anon and authenticated. Postgres trigger invocation never checks
--       the firing role's EXECUTE privilege on the trigger function itself
--       — this is purely removing an unnecessary direct-call surface, and
--       does not affect trigger firing in any way.
--
-- No function body changes. No CREATE OR REPLACE FUNCTION. No RLS changes.
-- No policies added. v_profile is not dropped, no rows touched, no schema
-- change, and its owner/service_role grants are untouched.
--
-- Created by this checkpoint. Do NOT apply until reviewed.

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- A. SEARCH_PATH HARDENING — 27 signatures
-- ═══════════════════════════════════════════════════════════════════════════

alter function public.add_court(text) set search_path = public, pg_temp;
alter function public.admin_cancel_reservation(uuid) set search_path = public, pg_temp;
alter function public.admin_expire_offer(uuid, uuid) set search_path = public, pg_temp;
alter function public.archive_event(uuid) set search_path = public, pg_temp;
alter function public.create_event(uuid, text, timestamp with time zone, timestamp with time zone, uuid[], text, integer, text, boolean) set search_path = public, pg_temp;
alter function public.create_maintenance_block(uuid, timestamp with time zone, timestamp with time zone, text) set search_path = public, pg_temp;
alter function public.create_maintenance_blocks(uuid[], timestamp with time zone, timestamp with time zone, text, boolean) set search_path = public, pg_temp;
alter function public.create_maintenance_blocks(uuid[], timestamp with time zone, timestamp with time zone, text) set search_path = public, pg_temp;
alter function public.delete_court(uuid) set search_path = public, pg_temp;
alter function public.delete_operating_hours_override(date, boolean) set search_path = public, pg_temp;
alter function public.delete_roster_member(uuid) set search_path = public, pg_temp;
alter function public.email_already_delivered(uuid) set search_path = public, pg_temp;
alter function public.get_audit_log(integer, integer) set search_path = public, pg_temp;
alter function public.get_user_email_for_notification(uuid) set search_path = public, pg_temp;
alter function public.notify_reservation_cancelled_by_member(uuid) set search_path = public, pg_temp;
alter function public.record_delivery_attempt(uuid, text, text, text, text, text, timestamp with time zone) set search_path = public, pg_temp;
alter function public.rename_court(uuid, text) set search_path = public, pg_temp;
alter function public.reorder_courts(uuid[]) set search_path = public, pg_temp;
alter function public.set_court_active(uuid, boolean) set search_path = public, pg_temp;
alter function public.set_member_notes(uuid, text) set search_path = public, pg_temp;
alter function public.unarchive_event(uuid) set search_path = public, pg_temp;
alter function public.update_club_name(text) set search_path = public, pg_temp;
alter function public.update_club_settings(integer, integer, integer, integer) set search_path = public, pg_temp;
alter function public.update_operating_hours(jsonb, boolean) set search_path = public, pg_temp;
alter function public.update_sms_preference(boolean, text) set search_path = public, pg_temp;
alter function public.upsert_operating_hours_override(date, boolean, time, time, text, boolean) set search_path = public, pg_temp;
alter function public.validate_club_invite(text) set search_path = public, pg_temp;

-- ═══════════════════════════════════════════════════════════════════════════
-- B. CATEGORY B — remove anon EXECUTE, preserve authenticated + service_role
--    (39 signatures)
-- ═══════════════════════════════════════════════════════════════════════════

revoke execute on function public.accept_waitlist_offer(uuid) from anon;
revoke execute on function public.add_court(text) from anon;
revoke execute on function public.add_roster_member(text, text, text, text, text, text) from anon;
revoke execute on function public.admin_add_guest(uuid, text) from anon;
revoke execute on function public.admin_add_member(uuid, uuid) from anon;
revoke execute on function public.admin_add_roster_member_to_event(uuid, uuid) from anon;
revoke execute on function public.admin_cancel_reservation(uuid) from anon;
revoke execute on function public.admin_expire_offer(uuid, uuid) from anon;
revoke execute on function public.admin_remove_guest(uuid, uuid) from anon;
revoke execute on function public.admin_remove_participant(uuid, uuid) from anon;
revoke execute on function public.archive_event(uuid) from anon;
revoke execute on function public.create_event(uuid, text, timestamp with time zone, timestamp with time zone, uuid[], text, integer, text, boolean) from anon;
revoke execute on function public.create_maintenance_block(uuid, timestamp with time zone, timestamp with time zone, text) from anon;
revoke execute on function public.create_maintenance_blocks(uuid[], timestamp with time zone, timestamp with time zone, text, boolean) from anon;
revoke execute on function public.create_maintenance_blocks(uuid[], timestamp with time zone, timestamp with time zone, text) from anon;
revoke execute on function public.create_reservation(uuid, timestamp with time zone, timestamp with time zone, text, integer, text[], text) from anon;
revoke execute on function public.decline_waitlist_offer(uuid) from anon;
revoke execute on function public.delete_court(uuid) from anon;
revoke execute on function public.delete_operating_hours_override(date, boolean) from anon;
revoke execute on function public.delete_roster_member(uuid) from anon;
revoke execute on function public.email_already_delivered(uuid) from anon;
revoke execute on function public.get_audit_log(integer, integer) from anon;
revoke execute on function public.get_club_invites() from anon;
revoke execute on function public.get_event_roster(uuid) from anon;
revoke execute on function public.get_user_email_for_notification(uuid) from anon;
revoke execute on function public.join_event(uuid) from anon;
revoke execute on function public.notify_reservation_cancelled_by_member(uuid) from anon;
revoke execute on function public.record_delivery_attempt(uuid, text, text, text, text, text, timestamp with time zone) from anon;
revoke execute on function public.rename_court(uuid, text) from anon;
revoke execute on function public.reorder_courts(uuid[]) from anon;
revoke execute on function public.revoke_club_invite(text) from anon;
revoke execute on function public.set_court_active(uuid, boolean) from anon;
revoke execute on function public.unarchive_event(uuid) from anon;
revoke execute on function public.update_club_name(text) from anon;
revoke execute on function public.update_club_settings(integer, integer, integer, integer) from anon;
revoke execute on function public.update_operating_hours(jsonb, boolean) from anon;
revoke execute on function public.update_roster_member(uuid, text, text, text, text, text, text) from anon;
revoke execute on function public.update_sms_preference(boolean, text) from anon;
revoke execute on function public.upsert_operating_hours_override(date, boolean, time, time, text, boolean) from anon;

-- ═══════════════════════════════════════════════════════════════════════════
-- C. CATEGORY D — trigger functions: revoke direct client EXECUTE from both
--    anon and authenticated (10 signatures). Trigger firing itself never
--    checks this privilege — see header note above.
-- ═══════════════════════════════════════════════════════════════════════════

revoke execute on function public.check_event_type_active() from anon, authenticated;
revoke execute on function public.enforce_event_capacity_reduction() from anon, authenticated;
revoke execute on function public.enforce_event_guest_capacity() from anon, authenticated;
revoke execute on function public.enforce_event_member_schedule() from anon, authenticated;
revoke execute on function public.enforce_event_participant_capacity() from anon, authenticated;
revoke execute on function public.enforce_event_participant_member_schedule() from anon, authenticated;
revoke execute on function public.enforce_lesson_request_member_schedule() from anon, authenticated;
revoke execute on function public.enforce_member_booking_roster_identity() from anon, authenticated;
revoke execute on function public.enforce_reservation_member_schedule() from anon, authenticated;
revoke execute on function public.handle_new_user() from anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- D. public.v_profile — full relation-level privilege revocation (the live
--    precheck above found anon/authenticated hold ALL relation-level
--    privileges, not a narrow subset, and zero column-level ACLs exist —
--    a plain REVOKE ALL PRIVILEGES per role is therefore the correct,
--    complete fix). service_role left untouched.
-- ═══════════════════════════════════════════════════════════════════════════

revoke all privileges on table public.v_profile from anon;
revoke all privileges on table public.v_profile from authenticated;

commit;
