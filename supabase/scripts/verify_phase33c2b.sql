-- verify_phase33c2b.sql
-- Phase 33C2 completion: Admin Reservation Edit — Member Reassignment —
-- POST-migration verification for 0109_reservation_member_reassignment.sql.
--
-- Run in the Supabase SQL Editor AFTER 0109 has been applied. Every query
-- is read-only (no INSERT/UPDATE/DELETE) — safe to run against a live
-- database. No preflight script accompanies 0109 — it makes no assumption
-- about existing data (pure function signature/behavior change, no
-- backfill, no ALTER TABLE).
--
-- EXPAND, NOT CONTRACT: 0109 adds a NEW 11-argument update_member_reservation
-- overload (with p_roster_member_id) alongside the existing, untouched
-- 10-argument overload from 0097. Both must coexist after this migration —
-- the legacy 10-argument overload is only removed by a later, separate
-- CONTRACT migration, not by 0109. Every behavioral check below (sections
-- B–F) therefore targets the NEW 11-argument overload specifically, via
-- `new_overload` (matched on the presence of p_roster_member_id in its
-- identity arguments) — NOT by proname alone, which would ambiguously match
-- both overloads.

-- ── A. update_member_reservation — two coexisting overloads (EXPAND stage) ─
select
  p.proname                                  as function_name,
  pg_get_function_identity_arguments(p.oid)  as args,
  p.prosecdef                                as is_security_definer,
  p.proconfig                                as config
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'update_member_reservation'
order by pg_get_function_identity_arguments(p.oid);
-- Expect: exactly 2 rows.
--   • Legacy 10-argument overload: args do NOT contain "p_roster_member_id".
--     is_security_definer = true, config contains 'search_path=public,
--     pg_temp' (unchanged from 0097 — this row must be byte-for-byte the
--     pre-0109 function; see the body check below).
--   • New 11-argument overload: args include "p_roster_member_id uuid" (no
--     default — positioned before the defaulted p_format/p_player_count/
--     p_guest_names/p_notes). is_security_definer = true, config contains
--     'search_path=public, pg_temp'.
-- If only 1 row appears, or the legacy overload's args contain
-- "p_roster_member_id", the CONTRACT step has (incorrectly) already
-- happened — investigate before treating this as a pass.

select p.proname, count(*) as overload_count
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'update_member_reservation'
group by p.proname;
-- Expect: overload_count = 2 — confirms the legacy 10-arg signature (without
-- p_roster_member_id) still coexists with the new 11-arg signature. This is
-- the EXPAND stage; the CONTRACT migration that eventually drops the legacy
-- overload is a separate, later, deferred change — not part of 0109.

select
  pg_get_functiondef(p.oid) !~ 'v_member_changed'
    and pg_get_functiondef(p.oid) !~ 'p_roster_member_id'
    and pg_get_functiondef(p.oid) !~ '''member_reassigned'''
    as legacy_overload_body_has_no_reassignment_logic
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'update_member_reservation'
  and pg_get_function_identity_arguments(p.oid) !~ 'p_roster_member_id';
-- Expect: true. Confirms the legacy 10-argument overload was left
-- completely untouched by 0109 — it contains none of the new
-- reassignment logic, which only exists in the new 11-argument overload.

select
  p.proname as function_name,
  pg_get_function_identity_arguments(p.oid) as args,
  g.grantee,
  has_function_privilege(
    case g.grantee when 'PUBLIC' then 'public' else g.grantee end,
    p.oid, 'EXECUTE'
  ) as can_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join (values ('PUBLIC'), ('anon'), ('authenticated')) as g(grantee)
where n.nspname = 'public'
  and p.proname = 'update_member_reservation'
order by args, g.grantee;
-- Expect: can_execute = true ONLY for grantee = 'authenticated' — for BOTH
-- overloads. The legacy overload's grants are unchanged from 0097; the new
-- overload's grants are set explicitly by 0109's own revoke/grant block.

-- ── B. owner_user_id is derived server-side, never a direct RPC input ──────
-- (checked against the NEW 11-argument overload only — see note above)
with new_overload as (
  select p.oid
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'update_member_reservation'
    and pg_get_function_identity_arguments(p.oid) ~ 'p_roster_member_id'
)
select
  pg_get_functiondef(p.oid) ~ 'v_new_owner_id\s*:=\s*v_roster\.claimed_by'
    as owner_derived_from_roster_row,
  pg_get_functiondef(p.oid) !~ 'p_owner_user_id'
    as no_client_supplied_owner_param,
  pg_get_functiondef(p.oid) ~ 'id\s*=\s*p_roster_member_id\s*\n?\s*and\s*club_id\s*=\s*v_club_id'
    as roster_lookup_is_club_scoped
from pg_proc p
join new_overload no on no.oid = p.oid;
-- Expect: all three columns true. Text-pattern checks, not a full
-- behavioral proof — if any is false, read the function directly with
-- `select pg_get_functiondef(oid) from pg_proc where proname =
-- 'update_member_reservation' and pg_get_function_identity_arguments(oid)
-- ~ 'p_roster_member_id'` and confirm by eye.

-- ── C. created_by is never rewritten by this RPC ────────────────────────────
-- (checked against the NEW 11-argument overload only)
with new_overload as (
  select p.oid
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'update_member_reservation'
    and pg_get_function_identity_arguments(p.oid) ~ 'p_roster_member_id'
)
select
  pg_get_functiondef(p.oid) !~ 'created_by\s*=\s*auth\.uid\(\)'
    as created_by_not_in_update_set_list
from pg_proc p
join new_overload no on no.oid = p.oid;
-- Expect: true. (The function does read/write auth.uid() elsewhere — as
-- audit_log.actor_id and notifications recipient context — this check is
-- specifically for the absence of a `created_by = auth.uid()` assignment,
-- which is what would indicate created_by being rewritten in the UPDATE
-- SET list.)

-- ── D. Notification addressed to the CURRENT owner, guarded against null ───
-- (checked against the NEW 11-argument overload only)
with new_overload as (
  select p.oid
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'update_member_reservation'
    and pg_get_function_identity_arguments(p.oid) ~ 'p_roster_member_id'
)
select
  pg_get_functiondef(p.oid) ~ 'v_scheduling_changed\s+and\s+v_after\.owner_user_id\s+is\s+not\s+null'
    as notification_guarded_by_scheduling_and_nonnull_owner,
  pg_get_functiondef(p.oid) ~ '''reservation_rescheduled''' -- kind unchanged
    as still_reservation_rescheduled_kind,
  pg_get_functiondef(p.oid) !~ 'v_before\.owner_user_id,\s*\n\s*''reservation_rescheduled'''
    as notification_no_longer_addressed_to_before_owner
from pg_proc p
join new_overload no on no.oid = p.oid;
-- Expect: all three columns true. Confirms the notification (a) only
-- fires when both a scheduling change occurred AND the current owner is
-- non-null, (b) is still the same 'reservation_rescheduled' kind (no new
-- notification type invented), and (c) is no longer addressed to the OLD
-- (pre-edit) owner.

-- ── E. Member-reassignment audit trail present ──────────────────────────────
-- (checked against the NEW 11-argument overload only)
with new_overload as (
  select p.oid
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'update_member_reservation'
    and pg_get_function_identity_arguments(p.oid) ~ 'p_roster_member_id'
)
select
  pg_get_functiondef(p.oid) ~ '''member_reassigned''' as has_member_reassigned_flag,
  pg_get_functiondef(p.oid) ~ '''roster_member_id'',\s*v_before\.roster_member_id' as audits_roster_member_id_before,
  pg_get_functiondef(p.oid) ~ '''roster_member_id'',\s*v_after\.roster_member_id'  as audits_roster_member_id_after
from pg_proc p
join new_overload no on no.oid = p.oid;
-- Expect: all three columns true.

-- ── F. Existing restrictions unchanged (still member_booking/confirmed/future only) ─
-- (checked against the NEW 11-argument overload — the legacy overload
-- retains its own unchanged copy of these same checks, see section A's
-- legacy_overload_body_has_no_reassignment_logic check for its integrity)
with new_overload as (
  select p.oid
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'update_member_reservation'
    and pg_get_function_identity_arguments(p.oid) ~ 'p_roster_member_id'
)
select
  pg_get_functiondef(p.oid) ~ 'reason\s*<>\s*''member_booking''' as still_member_booking_only,
  pg_get_functiondef(p.oid) ~ 'status\s*<>\s*''confirmed''' as still_confirmed_only,
  pg_get_functiondef(p.oid) ~ 'v_before\.starts_at\s*<=\s*now\(\)' as still_future_only
from pg_proc p
join new_overload no on no.oid = p.oid;
-- Expect: all three columns true — this migration does not relax which
-- reservations are editable.

-- ── G. 0108 objects untouched by this migration ─────────────────────────────
select
  t.tgname as trigger_name
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
where c.relname = 'reservations'
  and t.tgname   = 'reservations_member_booking_identity_guard'
  and not t.tgisinternal;
-- Expect: exactly 1 row — the 0108 identity-guard trigger still exists,
-- unmodified by this migration.

select p.proname, pg_get_function_identity_arguments(p.oid) as args
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'admin_create_member_reservation';
-- Expect: exactly 1 row, identical args to 0108's original definition —
-- confirms 0109 did not touch this function at all.

-- ── H. RLS still enabled, unchanged ─────────────────────────────────────────
select relname as table_name, relrowsecurity as rls_enabled
from pg_class
where relname in ('reservations', 'roster_members')
  and relnamespace = 'public'::regnamespace
order by relname;
-- Expect: rls_enabled = true on both rows — this migration does not touch
-- RLS on any table.
