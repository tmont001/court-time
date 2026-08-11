-- verify_phase33c3.sql
-- Phase 33C3: Reservation Claim Continuity + Regression Closeout —
-- POST-migration verification for 0110_reservation_claim_continuity.sql.
--
-- Run in the Supabase SQL Editor AFTER 0110 has been applied. Every query
-- is read-only (no INSERT/UPDATE/DELETE) — safe to run against a live
-- database. No preflight script accompanies 0110 — it makes no assumption
-- about existing data and performs no backfill (pure function
-- addition/replacement, no ALTER TABLE, no data write).
--
-- Rollback notes: see the "Rollback procedure" comment block at the end of
-- 0110_reservation_claim_continuity.sql if any check here fails and a
-- revert is needed.

-- ── A. current_user_roster_member_id() exists with the expected shape ──────
select
  p.proname                                  as function_name,
  pg_get_function_identity_arguments(p.oid)  as args,
  p.prosecdef                                as is_security_definer,
  p.proconfig                                as config,
  t.typname                                  as return_type
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
join pg_type t       on t.oid = p.prorettype
where n.nspname = 'public'
  and p.proname = 'current_user_roster_member_id';
-- Expect: exactly 1 row. args = '' (no parameters). is_security_definer =
-- true. config contains 'search_path=public, pg_temp'. return_type = 'uuid'.

select
  g.grantee,
  has_function_privilege(
    case g.grantee when 'PUBLIC' then 'public' else g.grantee end,
    p.oid, 'EXECUTE'
  ) as can_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join (values ('PUBLIC'), ('anon'), ('authenticated')) as g(grantee)
where n.nspname = 'public'
  and p.proname = 'current_user_roster_member_id'
order by g.grantee;
-- Expect: can_execute = true ONLY for grantee = 'authenticated'.

select
  pg_get_functiondef(p.oid) ~ 'club_id\s*=\s*public\.current_user_club_id\(\)'
    as scoped_by_active_club,
  pg_get_functiondef(p.oid) ~ 'claimed_by\s*=\s*auth\.uid\(\)'
    as matched_by_own_auth_uid,
  pg_get_functiondef(p.oid) !~ 'p_'
    as no_client_supplied_parameters
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'current_user_roster_member_id';
-- Expect: all three columns true. Confirms the helper resolves the
-- caller's own roster identity entirely from server-derived values
-- (current_user_club_id(), auth.uid()) — it accepts no parameters at all,
-- so there is no client input to distrust in the first place.

-- ── B. roster_members RLS was NOT widened by this migration ────────────────
select policyname, cmd, roles
from pg_policies
where schemaname = 'public'
  and tablename   = 'roster_members'
order by policyname;
-- Expect: the same 4 admin-only policies from 0056 (roster_members_select_
-- admin, roster_members_insert_admin, roster_members_update_admin,
-- roster_members_delete_admin) — no new policy. current_user_roster_
-- member_id() reaches roster_members via SECURITY DEFINER, not via a
-- relaxed policy.

-- ── C. cancel_member_reservation — same signature, roster-aware match ──────
select
  p.proname                                  as function_name,
  pg_get_function_identity_arguments(p.oid)  as args,
  p.prosecdef                                as is_security_definer,
  p.proconfig                                as config
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'cancel_member_reservation';
-- Expect: exactly 1 row (same 2-argument signature as 0097 — no overload
-- was created; this was a same-signature CREATE OR REPLACE, unlike 0109's
-- expand-only update_member_reservation change). is_security_definer =
-- true, config contains 'search_path=public, pg_temp'.

select
  g.grantee,
  has_function_privilege(
    case g.grantee when 'PUBLIC' then 'public' else g.grantee end,
    p.oid, 'EXECUTE'
  ) as can_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join (values ('PUBLIC'), ('anon'), ('authenticated')) as g(grantee)
where n.nspname = 'public'
  and p.proname = 'cancel_member_reservation'
order by g.grantee;
-- Expect: can_execute = true ONLY for grantee = 'authenticated' — grants
-- were never touched by this migration (CREATE OR REPLACE on the same
-- OID preserves them), this confirms they survived unchanged.

select
  pg_get_functiondef(p.oid) ~ 'v_roster_member_id\s*:=\s*public\.current_user_roster_member_id\(\)'
    as roster_identity_resolved_server_side,
  pg_get_functiondef(p.oid) ~ 'owner_user_id\s*=\s*auth\.uid\(\)\s*\n?\s*or\s*\(v_roster_member_id\s+is\s+not\s+null\s+and\s+roster_member_id\s*=\s*v_roster_member_id\)'
    as ownership_match_widened_correctly,
  pg_get_functiondef(p.oid) !~ 'p_roster_member_id'
    as no_client_supplied_roster_id_param
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'cancel_member_reservation';
-- Expect: all three columns true. Text-pattern checks, not a full
-- behavioral proof — if any is false, read the function directly with
-- `select pg_get_functiondef(oid) from pg_proc where proname =
-- 'cancel_member_reservation'` and confirm by eye. The third check in
-- particular guards against a regression where a future edit accepts a
-- roster_member_id as a function ARGUMENT (client-supplied ownership
-- proof) rather than resolving it server-side as this checkpoint requires.

-- ── D. Cancellation-window/grace calculation is byte-for-byte unchanged
--      from 0097 — 33C3's scope is claim-continuity ownership matching
--      only; this migration must not bundle any window/grace correction ──
select
  pg_get_functiondef(p.oid) ~ 'reason\s*<>\s*''member_booking''' as still_member_booking_only,
  pg_get_functiondef(p.oid) ~ 'status\s*<>\s*''confirmed''' as still_confirmed_only,
  -- Confirms the settings lookup itself is unconditional (no added filter
  -- beyond club_id = v_club_id) — this migration did not scope it further.
  pg_get_functiondef(p.oid) ~ 'select\s+cancellation_window_hours,\s*cancellation_grace_minutes\s*\n?\s*into\s+v_cancellation_window_hours,\s*v_cancellation_grace_minutes\s*\n?\s*from\s+club_settings\s*\n?\s*where\s+club_id\s*=\s*v_club_id;'
    as settings_lookup_unfiltered_and_unconditional,
  -- Confirms the exact pre-0110/0097 fallback-defaulting structure: no
  -- club_settings row -> 24h/5min; a row exists -> coalesce each column to
  -- 24/5 individually. A stricter structural match than merely checking
  -- that "24" and "5" appear somewhere, so it actually distinguishes this
  -- known-good pre-0110 shape from a reworked/newly-introduced one.
  pg_get_functiondef(p.oid) ~ 'if\s+not\s+found\s+then\s*\n?\s*v_cancellation_window_hours\s*:=\s*24;\s*\n?\s*v_cancellation_grace_minutes\s*:=\s*5;\s*\n?\s*else\s*\n?\s*v_cancellation_window_hours\s*:=\s*coalesce\(v_cancellation_window_hours,\s*24\);\s*\n?\s*v_cancellation_grace_minutes\s*:=\s*coalesce\(v_cancellation_grace_minutes,\s*5\);\s*\n?\s*end\s+if;'
    as fallback_defaulting_structure_matches_0097,
  pg_get_functiondef(p.oid) ~ 'v_outside_window\s*:=\s*\(v_before\.starts_at\s*-\s*now\(\)\)\s*\n?\s*>=\s*make_interval\(hours\s*=>\s*v_cancellation_window_hours\)'
    as outside_window_calc_unchanged,
  pg_get_functiondef(p.oid) ~ 'v_within_grace\s*:=\s*v_cancellation_grace_minutes\s*>\s*0\s*\n?\s*and\s*\(now\(\)\s*-\s*v_before\.created_at\)\s*\n?\s*<\s*make_interval\(mins\s*=>\s*v_cancellation_grace_minutes\)'
    as within_grace_calc_unchanged
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'cancel_member_reservation';
-- Expect: all six columns true. If fallback_defaulting_structure_matches_
-- 0097 or settings_lookup_unfiltered_and_unconditional is false, this
-- migration has diverged from 0097's window/grace behavior — that is out
-- of 33C3's scope and must be reverted, not carried forward here.

-- ── E. Notification recipient/gating unchanged (never keyed off ownership) ─
select
  pg_get_functiondef(p.oid) ~ '''reservation_cancelled_by_member'''
    as still_reservation_cancelled_by_member_kind,
  pg_get_functiondef(p.oid) ~ 'user_pref_enabled\(auth\.uid\(\),\s*''reservation_cancelled_by_member''\)'
    as still_gated_by_actor_preference,
  pg_get_functiondef(p.oid) ~ 'insert into notifications \(club_id, user_id, kind, body, metadata\)\s*\n?\s*values\s*\(\s*\n?\s*v_club_id,\s*\n?\s*auth\.uid\(\)'
    as still_addressed_to_acting_auth_uid
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'cancel_member_reservation';
-- Expect: all three columns true. The notification was always addressed to
-- the acting auth.uid() (the person cancelling their own booking), never
-- to v_before.owner_user_id — so the ownership-match widening in this
-- migration has no bearing on notification correctness, and this section
-- confirms that stayed true.

-- ── F. Audit trail carries roster_member_id alongside owner_user_id ────────
select
  pg_get_functiondef(p.oid) ~ '''roster_member_id'',\s*v_before\.roster_member_id'
    as audit_log_includes_roster_member_id,
  pg_get_functiondef(p.oid) ~ '''owner_user_id'',\s*v_before\.owner_user_id'
    as audit_log_still_includes_owner_user_id
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'cancel_member_reservation';
-- Expect: both columns true.

-- ── G. 0108/0109 objects untouched by this migration ────────────────────────
select t.tgname as trigger_name
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
where c.relname = 'reservations'
  and t.tgname   = 'reservations_member_booking_identity_guard'
  and not t.tgisinternal;
-- Expect: exactly 1 row — the 0108 identity-guard trigger still exists,
-- unmodified by this migration.

select p.proname, count(*) as overload_count
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'update_member_reservation'
group by p.proname;
-- Expect: overload_count = 2 — 0109's expand-stage overloads are
-- unaffected by this migration (0110 does not touch update_member_
-- reservation at all).

-- ── H. RLS still enabled, unchanged ─────────────────────────────────────────
select relname as table_name, relrowsecurity as rls_enabled
from pg_class
where relname in ('reservations', 'roster_members')
  and relnamespace = 'public'::regnamespace
order by relname;
-- Expect: rls_enabled = true on both rows — this migration does not touch
-- RLS on any table (the roster_members admin-only policies from 0056 are
-- untouched — see Section B above).
