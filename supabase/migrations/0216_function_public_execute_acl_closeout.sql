-- 0216_function_public_execute_acl_closeout.sql
-- Phase 45D3C — closes out the PUBLIC EXECUTE gap left by migration 0215.
--
-- POST-0215 LIVE DIAGNOSIS (read-only, performed live before writing this
-- migration, not assumed): 0215 applied cleanly (missing_search_path_count
-- = 0, v_profile anon/authenticated privileges fully removed,
-- validate_club_invite still works anonymously, authenticated
-- get_audit_log smoke passed) but did NOT reduce effective client access
-- for the 49 functions it revoked anon/authenticated EXECUTE from. The
-- reason, confirmed directly against pg_proc.proacl via
-- aclexplode(pg_proc.proacl) for the complete 50-function cohort (39
-- Category B + 10 Category D + validate_club_invite): every one of them
-- still carries the implicit PUBLIC grant Postgres stamps on every
-- function at creation time (`=X/postgres` in proacl, i.e. grantee OID 0).
-- A PUBLIC grant applies unconditionally to every role, including anon —
-- REVOKE EXECUTE ... FROM anon (what 0215 did) has no effect on it,
-- because anon's effective privilege comes from the PUBLIC entry, not a
-- role-specific one. This is the actual reason anon_effective_exec and
-- authenticated_effective_exec still read true after 0215.
--
-- Live precheck result (this checkpoint, full 50-function cohort): ALL 50
-- matched the expected shape below, with zero deviations:
--   Category B (39): PUBLIC=true, anon=false, authenticated=true,
--     service_role=true
--   Category D (10): PUBLIC=true, anon=false, authenticated=false,
--     service_role=true
--   validate_club_invite: PUBLIC=true, anon=true, authenticated=true,
--     service_role=true
-- Since 0215 already put the correct anon/authenticated role-specific
-- grants in place, the only remaining gap is the PUBLIC entry itself, and
-- the only statement needed per function is REVOKE EXECUTE ... FROM
-- PUBLIC. No GRANT statements are needed anywhere — every intended
-- explicit grant (authenticated/service_role for Category B and
-- validate_club_invite; service_role only for Category D; anon for
-- validate_club_invite) already exists live and is untouched by a PUBLIC
-- revoke, which removes only the PUBLIC entry and never touches
-- individually-granted roles.
--
-- Resulting contract after this migration:
--   Category B:       anon NO EXECUTE / authenticated YES / service_role YES / PUBLIC NO
--   Category D:        anon NO EXECUTE / authenticated NO EXECUTE / service_role YES / PUBLIC NO
--   validate_club_invite: anon YES (explicit) / authenticated YES (explicit) / service_role YES (explicit) / PUBLIC NO
--
-- No function body changes. No CREATE OR REPLACE FUNCTION. No ALTER
-- FUNCTION. No ownership changes. No RLS changes. No table privilege
-- changes (v_profile untouched). No trigger definition changes. No
-- application code changes. Migrations 0213/0214/0215 are untouched.
--
-- Created by this checkpoint. Do NOT apply until reviewed.

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- CATEGORY B — 39 authenticated client RPCs: revoke the residual PUBLIC
-- EXECUTE grant. authenticated/service_role explicit grants (already in
-- place, confirmed live) are untouched.
-- ═══════════════════════════════════════════════════════════════════════════

revoke execute on function public.accept_waitlist_offer(uuid) from public;
revoke execute on function public.add_court(text) from public;
revoke execute on function public.add_roster_member(text, text, text, text, text, text) from public;
revoke execute on function public.admin_add_guest(uuid, text) from public;
revoke execute on function public.admin_add_member(uuid, uuid) from public;
revoke execute on function public.admin_add_roster_member_to_event(uuid, uuid) from public;
revoke execute on function public.admin_cancel_reservation(uuid) from public;
revoke execute on function public.admin_expire_offer(uuid, uuid) from public;
revoke execute on function public.admin_remove_guest(uuid, uuid) from public;
revoke execute on function public.admin_remove_participant(uuid, uuid) from public;
revoke execute on function public.archive_event(uuid) from public;
revoke execute on function public.create_event(uuid, text, timestamp with time zone, timestamp with time zone, uuid[], text, integer, text, boolean) from public;
revoke execute on function public.create_maintenance_block(uuid, timestamp with time zone, timestamp with time zone, text) from public;
revoke execute on function public.create_maintenance_blocks(uuid[], timestamp with time zone, timestamp with time zone, text, boolean) from public;
revoke execute on function public.create_maintenance_blocks(uuid[], timestamp with time zone, timestamp with time zone, text) from public;
revoke execute on function public.create_reservation(uuid, timestamp with time zone, timestamp with time zone, text, integer, text[], text) from public;
revoke execute on function public.decline_waitlist_offer(uuid) from public;
revoke execute on function public.delete_court(uuid) from public;
revoke execute on function public.delete_operating_hours_override(date, boolean) from public;
revoke execute on function public.delete_roster_member(uuid) from public;
revoke execute on function public.email_already_delivered(uuid) from public;
revoke execute on function public.get_audit_log(integer, integer) from public;
revoke execute on function public.get_club_invites() from public;
revoke execute on function public.get_event_roster(uuid) from public;
revoke execute on function public.get_user_email_for_notification(uuid) from public;
revoke execute on function public.join_event(uuid) from public;
revoke execute on function public.notify_reservation_cancelled_by_member(uuid) from public;
revoke execute on function public.record_delivery_attempt(uuid, text, text, text, text, text, timestamp with time zone) from public;
revoke execute on function public.rename_court(uuid, text) from public;
revoke execute on function public.reorder_courts(uuid[]) from public;
revoke execute on function public.revoke_club_invite(text) from public;
revoke execute on function public.set_court_active(uuid, boolean) from public;
revoke execute on function public.unarchive_event(uuid) from public;
revoke execute on function public.update_club_name(text) from public;
revoke execute on function public.update_club_settings(integer, integer, integer, integer) from public;
revoke execute on function public.update_operating_hours(jsonb, boolean) from public;
revoke execute on function public.update_roster_member(uuid, text, text, text, text, text, text) from public;
revoke execute on function public.update_sms_preference(boolean, text) from public;
revoke execute on function public.upsert_operating_hours_override(date, boolean, time, time, text, boolean) from public;

-- ═══════════════════════════════════════════════════════════════════════════
-- CATEGORY D — 10 trigger functions: revoke the residual PUBLIC EXECUTE
-- grant. service_role's explicit grant (already in place) is untouched.
-- Trigger firing never checks the firing role's EXECUTE privilege on the
-- trigger function, so this has no effect on trigger behavior.
-- ═══════════════════════════════════════════════════════════════════════════

revoke execute on function public.check_event_type_active() from public;
revoke execute on function public.enforce_event_capacity_reduction() from public;
revoke execute on function public.enforce_event_guest_capacity() from public;
revoke execute on function public.enforce_event_member_schedule() from public;
revoke execute on function public.enforce_event_participant_capacity() from public;
revoke execute on function public.enforce_event_participant_member_schedule() from public;
revoke execute on function public.enforce_lesson_request_member_schedule() from public;
revoke execute on function public.enforce_member_booking_roster_identity() from public;
revoke execute on function public.enforce_reservation_member_schedule() from public;
revoke execute on function public.handle_new_user() from public;

-- ═══════════════════════════════════════════════════════════════════════════
-- validate_club_invite — Category A (intentionally anonymous). Revoke only
-- the residual PUBLIC grant; anon/authenticated/service_role's explicit
-- grants (already in place, confirmed live) are untouched, preserving
-- anonymous access to the pre-auth invite landing page exactly as before.
-- ═══════════════════════════════════════════════════════════════════════════

revoke execute on function public.validate_club_invite(text) from public;

commit;
