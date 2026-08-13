-- verify_phase33d2.sql
-- Phase 33D2a: Events Member Identity Parity — POST-migration verification
-- for 0113_staff_managed_events_identity.sql.
--
-- Run in the Supabase SQL Editor AFTER 0113 has been applied. Every query
-- is read-only — safe to run against a live database. Text-pattern
-- function-body checks are not a full behavioral proof — if any is false,
-- read the function directly with `select pg_get_functiondef(oid) from
-- pg_proc where proname = '<name>'` and confirm by eye. These static
-- checks must be supplemented by an authenticated end-to-end manual QA
-- pass this file cannot perform (join/leave/waitlist/offer/rejoin as both
-- a claimed and no-account Member; staff force-confirm/offer/expire/
-- attendance on a no-account participant; cancel/update an event with a
-- mix of claimed and no-account participants and confirm no crash and no
-- notification to the no-account one).
--
-- Rollback notes: see the "Rollback procedure" comment block at the end of
-- 0113_staff_managed_events_identity.sql if any check here fails.

-- ═══════════════════════════════════════════════════════════════════════════
-- 0. SEARCH_PATH / SECURITY DEFINER AUDIT — every SECURITY DEFINER function
--    modified or added by 0113 (18 total: 5 existing functions whose body
--    0113 changed but whose original declaration predated the fixed-
--    search_path convention, plus 13 that were already written with it in
--    this migration). Phase 33D2a correction: the first pass of this
--    verification script only checked the 6 new roster-aware RPCs — this
--    section replaces that narrower check with the full inventory.
-- ═══════════════════════════════════════════════════════════════════════════
with expected(proname) as (
  values
    ('admin_add_member'), ('join_event'), ('accept_waitlist_offer'), ('decline_waitlist_offer'),
    ('get_event_roster'), ('advance_waitlist_offer'), ('expire_stale_offers_for_event'),
    ('_leave_event_impl'), ('admin_add_roster_participant'), ('admin_remove_roster_participant'),
    ('admin_force_confirm_roster_participant'), ('admin_offer_spot_roster_participant'),
    ('admin_expire_offer_roster_participant'), ('mark_attendance_roster_participant'),
    ('cancel_event'), ('update_event'), ('_materialize_program_member_into_future_events'),
    ('generate_program_sessions')
)
select
  expected.proname,
  p.oid is not null                                              as function_exists,
  coalesce(p.prosecdef, false)                                   as is_security_definer,
  coalesce(
    exists (
      select 1 from unnest(p.proconfig) cfg
      where cfg like 'search_path=%public%'
        and cfg like '%pg_temp%'
    ),
    false
  )                                                               as has_fixed_search_path,
  p.proconfig                                                     as raw_config
from expected
left join pg_proc p
  on p.proname = expected.proname
 and p.pronamespace = 'public'::regnamespace
order by expected.proname;
-- Expect: 18 rows. function_exists = true, is_security_definer = true, and
-- has_fixed_search_path = true for every single row. Any row with
-- has_fixed_search_path = false is a live SECURITY DEFINER function
-- lacking search_path pinning — a genuine security gap (search_path
-- hijacking via a malicious same-session schema), not just a style
-- inconsistency, and must be fixed before this migration is applied.

-- Overload-count / signature-stability re-check for the five functions
-- corrected in this pass — proves the search_path fix did not introduce a
-- second overload or otherwise change the callable signature.
select
  p.proname,
  count(*)                                    as overload_count,
  array_agg(pg_get_function_identity_arguments(p.oid)) as arg_signatures
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'admin_add_member', 'join_event', 'accept_waitlist_offer',
    'decline_waitlist_offer', 'get_event_roster'
  )
group by p.proname
order by p.proname;
-- Expect: 5 rows, every overload_count = 1. arg_signatures should read:
-- admin_add_member(p_event_id uuid, p_profile_id uuid);
-- join_event(p_event_id uuid); accept_waitlist_offer(p_event_id uuid);
-- decline_waitlist_offer(p_event_id uuid); get_event_roster(p_event_id
-- uuid) — identical to their pre-0113 (and pre-this-correction)
-- signatures; only the declaration's search_path pinning changed.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. roster_member_id is NOT NULL (fail-closed backfill succeeded)
-- ═══════════════════════════════════════════════════════════════════════════
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name   = 'event_participants'
  and column_name  in ('profile_id', 'roster_member_id')
order by column_name;
-- Expect: 2 rows. profile_id: is_nullable = 'YES'. roster_member_id:
-- data_type = 'uuid', is_nullable = 'NO'.

select conname
from pg_constraint c
join pg_class t on t.oid = c.conrelid
where t.relname = 'event_participants'
  and c.contype = 'f'
  and c.conname = 'event_participants_roster_member_id_fkey';
-- Expect: exactly 1 row.

select indexname, indexdef
from pg_indexes
where schemaname = 'public'
  and tablename   = 'event_participants'
  and indexname   in ('event_participants_roster_member_id_idx', 'event_participants_event_roster_uniq')
order by indexname;
-- Expect: 2 rows. event_participants_event_roster_uniq's indexdef contains
-- 'UNIQUE' and 'WHERE (roster_member_id IS NOT NULL)' — harmless now that
-- the column is NOT NULL (every row satisfies the predicate), kept as the
-- durable per-event uniqueness guard.

select count(*) as rows_with_null_roster_member_id
from public.event_participants
where roster_member_id is null;
-- Expect: 0 (would be structurally impossible given the NOT NULL
-- constraint above — included as a direct data assertion, not just a
-- schema-metadata one).

select ep.id, ep.profile_id, ep.roster_member_id, rm.claimed_by, rm.club_id as roster_club_id, e.club_id as event_club_id
from public.event_participants ep
join public.events e on e.id = ep.event_id
join public.roster_members rm on rm.id = ep.roster_member_id
where ep.profile_id is not null
  and (rm.claimed_by is distinct from ep.profile_id or rm.club_id is distinct from e.club_id);
-- Expect: 0 rows — every backfilled row's roster identity matches its
-- historical profile_id and shares its event's club.

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. No current writer can create an event_participants row without a
--    resolved roster identity
-- ═══════════════════════════════════════════════════════════════════════════
-- Every function that INSERTs event_participants must supply
-- roster_member_id in the same statement (the NOT NULL constraint would
-- reject any that doesn't, but this proves intent, not just enforcement —
-- a function relying on the constraint to catch its own bug would still
-- fail the live call with a raw not-null-violation instead of a friendly
-- error, which is itself worth flagging if found).
select
  p.proname,
  pg_get_functiondef(p.oid) ~ 'insert into (public\.)?event_participants\s*\([^)]*roster_member_id'
    as insert_supplies_roster_member_id
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'admin_add_member', 'join_event', 'admin_add_roster_participant',
    '_materialize_program_member_into_future_events', 'generate_program_sessions'
  )
  and pg_get_functiondef(p.oid) ~ 'insert into (public\.)?event_participants';
-- Expect: every returned row has insert_supplies_roster_member_id = true.

-- Program materialization fails closed instead of best-effort skipping.
select
  p.proname,
  pg_get_functiondef(p.oid) ~ 'phase33d2_unresolved_member_identity|phase33d2_unresolved_program_member_identit'
    as has_fail_closed_guard
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('_materialize_program_member_into_future_events', 'generate_program_sessions');
-- Expect: 2 rows, both true.

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Reactivation (rejoin) safely updates the existing row instead of
--    colliding with the new (event_id, roster_member_id) partial unique
--    index
-- ═══════════════════════════════════════════════════════════════════════════
select
  p.proname,
  pg_get_functiondef(p.oid) ~ 'for update'                                 as uses_row_lock,
  pg_get_functiondef(p.oid) !~ 'on conflict \(event_id, profile_id\)'      as no_vulnerable_on_conflict
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'admin_add_member', 'join_event', 'admin_add_roster_participant',
    '_materialize_program_member_into_future_events'
  )
order by p.proname;
-- Expect: 4 rows, all true. (generate_program_sessions is exempt — its
-- bulk insert only ever targets a brand-new event created in the same
-- statement, which cannot already have a colliding row; see migration
-- header.)

-- Duplicate-row canary: no two active-or-cancelled rows for the same
-- (event_id, roster_member_id) should ever exist post-migration — the
-- partial unique index enforces this going forward, but this also proves
-- no pre-existing data already violates it.
select event_id, roster_member_id, count(*)
from public.event_participants
group by event_id, roster_member_id
having count(*) > 1;
-- Expect: 0 rows.

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Waitlist helpers (advance_waitlist_offer, expire_stale_offers_for_
--    event) are roster-aware: FIFO by row id, notification recipient
--    resolved fresh via roster_members.claimed_by, never from a stale
--    profile_id
-- ═══════════════════════════════════════════════════════════════════════════
select
  p.proname,
  pg_get_function_identity_arguments(p.oid) as args,
  pg_get_functiondef(p.oid) ~ 'select id, roster_member_id into v_next_id'
    as fifo_by_row_id,
  pg_get_functiondef(p.oid) ~ 'select claimed_by into v_current_member_id\s*\n?\s*from public\.roster_members'
    as resolves_current_claimed_by,
  pg_get_functiondef(p.oid) ~ 'if v_current_member_id is not null then'
    as skips_notification_when_unclaimed
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'advance_waitlist_offer';
-- Expect: 1 row, args = 'p_event_id uuid, p_club_id uuid, p_event_title
-- text, p_actor_id uuid DEFAULT NULL::uuid' (signature unchanged from
-- 0102), all three boolean columns true.

select
  p.proname,
  pg_get_functiondef(p.oid) ~ 'update public\.event_participants\s*\n?\s*set status\s*=\s*.cancelled.,\s*\n?\s*offer_expires_at\s*=\s*null,\s*\n?\s*updated_at\s*=\s*now\(\)\s*\n?\s*where id = v_row\.id'
    as expires_by_row_id
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'expire_stale_offers_for_event';
-- Expect: 1 row, true.

-- Both remain internal-only (never called directly by a client) — no
-- grant to authenticated, matching their 0102 posture exactly.
select
  p.proname, g.grantee,
  has_function_privilege(
    case g.grantee when 'PUBLIC' then 'public' else g.grantee end,
    p.oid, 'EXECUTE'
  ) as can_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join (values ('PUBLIC'), ('anon'), ('authenticated')) as g(grantee)
where n.nspname = 'public'
  and p.proname in ('advance_waitlist_offer', 'expire_stale_offers_for_event', '_leave_event_impl')
order by p.proname, g.grantee;
-- Expect: can_execute = false for every row (all three remain internal-
-- only, unchanged from their 0102 posture).

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. leave_event / leave_event_v2 continuity — _leave_event_impl is
--    roster-aware; the two thin wrappers were not redeclared by 0113 and
--    so are byte-identical to their live 0102 definitions
-- ═══════════════════════════════════════════════════════════════════════════
select
  p.proname,
  pg_get_function_identity_arguments(p.oid) as args,
  pg_get_function_result(p.oid) as return_type
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('leave_event', 'leave_event_v2', '_leave_event_impl')
order by p.proname;
-- Expect: 3 rows. leave_event(uuid) returns uuid; leave_event_v2(uuid)
-- returns jsonb; _leave_event_impl(uuid) returns jsonb. All three
-- signatures identical to pre-0113 (0102) — 0113 changed _leave_event_
-- impl's BODY only, and did not touch the other two at all.

select
  pg_get_functiondef(p.oid) ~ 'v_roster_member_id is not null and roster_member_id = v_roster_member_id'
    as leave_matches_by_roster_identity,
  pg_get_functiondef(p.oid) ~ 'offered_profile_id.*notification_id|notification_id.*offered_profile_id'
    as preserves_exact_result_contract
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = '_leave_event_impl';
-- Expect: 1 row, both columns true.

select
  p.proname, g.grantee,
  has_function_privilege(
    case g.grantee when 'PUBLIC' then 'public' else g.grantee end,
    p.oid, 'EXECUTE'
  ) as can_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join (values ('PUBLIC'), ('anon'), ('authenticated')) as g(grantee)
where n.nspname = 'public'
  and p.proname in ('leave_event', 'leave_event_v2')
order by p.proname, g.grantee;
-- Expect: can_execute = true only for grantee = 'authenticated', for both
-- — unchanged client-facing posture.

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. cancel_event / update_event never attempt notifications.user_id =
--    NULL for a no-account participant
-- ═══════════════════════════════════════════════════════════════════════════
select
  -- Phase 33D2a correction: the original regex required `roster_member_id)`
  -- to be immediately followed by `into` — the real code has `, '{}')` in
  -- between (`coalesce(array_agg(roster_member_id), '{}') into
  -- v_affected_roster_ids`), so it never matched (false negative). Split
  -- into two independent, order-agnostic substring checks instead.
  pg_get_functiondef(p.oid) ~ 'array_agg\(roster_member_id\)'
    and pg_get_functiondef(p.oid) ~ 'into v_affected_roster_ids'
    as captures_by_roster_member_id,
  pg_get_functiondef(p.oid) ~ 'where id = any\(v_affected_roster_ids\)\s*\n?\s*and claimed_by is not null'
    as filters_to_claimed_before_insert,
  pg_get_functiondef(p.oid) !~ 'array_agg\(profile_id\)'
    as no_longer_aggregates_profile_id
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'cancel_event';
-- Expect: 1 row, all three true. This is the direct fix for the confirmed
-- crash risk: array_agg(profile_id) -> unnest() -> insert user_id=NULL
-- would previously abort the ENTIRE cancel_event call for any event with
-- one no-account participant.

select
  pg_get_functiondef(p.oid) ~ 'select claimed_by into v_notify_member_id\s*\n?\s*from roster_members'
    as resolves_claimed_by_per_participant,
  pg_get_functiondef(p.oid) ~ 'if v_notify_member_id is not null then'
    as skips_insert_when_unclaimed,
  pg_get_functiondef(p.oid) ~ 'select roster_member_id from event_participants'
    as loop_iterates_roster_member_id
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'update_event';
-- Expect: 1 row, all three true.

select
  p.proname,
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
  and p.proname in ('cancel_event', 'update_event')
order by p.proname, g.grantee;
-- Expect: can_execute = true only for grantee = 'authenticated', for
-- both — signatures and grants unchanged from 0102/0099.

-- A structural guarantee that a no-account participant's cancel/update
-- pass cannot deadlock the whole event's notifications: the total
-- notifications produced by cancel_event for a scheduled cancellation
-- should never exceed the count of participants with a claimed roster
-- identity.
select
  ep.event_id,
  count(*) filter (where rm.claimed_by is not null) as claimed_active_participants,
  count(*) filter (where rm.claimed_by is null)     as unclaimed_active_participants
from public.event_participants ep
join public.roster_members rm on rm.id = ep.roster_member_id
where ep.status in ('confirmed', 'waitlisted', 'offered')
group by ep.event_id
having count(*) filter (where rm.claimed_by is null) > 0;
-- Informational — lists events that currently have at least one active
-- no-account participant. Manually cancel or edit one of these (in a
-- non-production/staging pass) to confirm cancel_event/update_event
-- complete successfully and the claimed participants are still notified.

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. Roster-aware staff parity — 4 new admin RPCs mirror the profile-based
--    originals exactly, keyed by roster_member_id
-- ═══════════════════════════════════════════════════════════════════════════
select
  p.proname,
  pg_get_function_identity_arguments(p.oid) as args,
  p.prosecdef as is_security_definer,
  p.proconfig as config
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'admin_add_roster_participant', 'admin_remove_roster_participant',
    'admin_force_confirm_roster_participant', 'admin_offer_spot_roster_participant',
    'admin_expire_offer_roster_participant', 'mark_attendance_roster_participant'
  )
order by p.proname;
-- Expect: 6 rows, all is_security_definer = true, config contains
-- 'search_path=public, pg_temp'.

select
  p.proname, g.grantee,
  has_function_privilege(
    case g.grantee when 'PUBLIC' then 'public' else g.grantee end,
    p.oid, 'EXECUTE'
  ) as can_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join (values ('PUBLIC'), ('anon'), ('authenticated')) as g(grantee)
where n.nspname = 'public'
  and p.proname in (
    'admin_add_roster_participant', 'admin_remove_roster_participant',
    'admin_force_confirm_roster_participant', 'admin_offer_spot_roster_participant',
    'admin_expire_offer_roster_participant', 'mark_attendance_roster_participant'
  )
order by p.proname, g.grantee;
-- Expect: can_execute = true ONLY for grantee = 'authenticated', for all
-- six. Admin-only enforcement happens inside each function body
-- (current_user_role() in ('admin','pro')) — this only checks the outer
-- grant.

select
  p.proname,
  pg_get_functiondef(p.oid) ~ 'current_user_role\(\)'   as uses_current_user_role,
  pg_get_functiondef(p.oid) ~ 'stale_club_context'        as checks_stale_club_context,
  pg_get_functiondef(p.oid) ~ 'participant_not_found'      as validates_participant_row_exists
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'admin_add_roster_participant', 'admin_remove_roster_participant',
    'admin_force_confirm_roster_participant', 'admin_offer_spot_roster_participant',
    'admin_expire_offer_roster_participant', 'mark_attendance_roster_participant'
  )
order by p.proname;
-- Expect: 6 rows, uses_current_user_role and checks_stale_club_context
-- true for every row. validates_participant_row_exists true for all
-- except admin_add_roster_participant, which is the only one of the six
-- that ADDS a participant (nothing to "not find" yet).

-- Phase 33D2a correction: the prior version of this check required ALL SIX
-- roster-aware RPCs to raise roster_member_not_found — overly broad. Only
-- three of them perform an independent roster_members existence lookup
-- before touching event_participants; the other three (admin_remove_
-- roster_participant, admin_expire_offer_roster_participant, mark_
-- attendance_roster_participant) validate existence implicitly by
-- querying event_participants directly filtered on roster_member_id — if
-- nothing matches, participant_not_found is the correct and sufficient
-- error, and a separate roster_members lookup would be redundant, not
-- missing functionality.
select
  p.proname,
  pg_get_functiondef(p.oid) ~ 'roster_member_not_found' as raises_roster_member_not_found
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'admin_add_roster_participant',
    'admin_force_confirm_roster_participant',
    'admin_offer_spot_roster_participant'
  )
order by p.proname;
-- Expect: 3 rows, all true — these three look up roster_members
-- independently (to resolve claimed_by for notification purposes) before
-- ever touching event_participants, so they can and do raise this code.

-- admin_remove_roster_participant only advances the queue when a capacity
-- slot was actually freed (previous status confirmed/offered) — matching
-- admin_remove_participant's exact rule, waitlisted removal frees nothing.
select
  pg_get_functiondef(p.oid) ~ 'if v_old_status in \(.confirmed., .offered.\) then'
    as conditional_expire_advance_matches_admin_remove_participant
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'admin_remove_roster_participant';
-- Expect: 1 row, true.

-- admin_force_confirm_roster_participant / admin_offer_spot_roster_
-- participant notify only when claimed, exactly like the roster-aware
-- waitlist helpers above.
select
  p.proname,
  pg_get_functiondef(p.oid) ~ 'if v_current_member_id is not null then'
    as skips_notification_when_unclaimed
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('admin_force_confirm_roster_participant', 'admin_offer_spot_roster_participant')
order by p.proname;
-- Expect: 2 rows, both true.

-- ═══════════════════════════════════════════════════════════════════════════
-- 8. Existing signatures unchanged — no stray overloads
-- ═══════════════════════════════════════════════════════════════════════════
select p.proname, count(*) as overload_count
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'admin_add_member', 'join_event', 'leave_event', 'leave_event_v2', '_leave_event_impl',
    'accept_waitlist_offer', 'decline_waitlist_offer', 'get_event_roster',
    'advance_waitlist_offer', 'expire_stale_offers_for_event',
    'cancel_event', 'update_event',
    '_materialize_program_member_into_future_events', 'generate_program_sessions',
    'admin_remove_participant', 'admin_force_confirm', 'admin_offer_spot', 'admin_expire_offer',
    'mark_attendance', 'admin_add_roster_member_to_event'
  )
group by p.proname
order by p.proname;
-- Expect: 20 rows, every overload_count = 1 — every one of these RPCs
-- (both the ones 0113 modified and the profile-based originals it left
-- untouched) kept its exact pre-0113 signature; every change was a plain
-- CREATE OR REPLACE, no DROP+CREATE anywhere in this migration.

-- ═══════════════════════════════════════════════════════════════════════════
-- 9. RETURNS TABLE / output-column ambiguity scan (same bug class as the
--    get_my_lesson_requests incident fixed in migration 0112)
-- ═══════════════════════════════════════════════════════════════════════════
-- Every function modified by 0113 that declares RETURNS TABLE, checked for
-- an unqualified column reference matching one of its own output-column
-- names. get_event_roster and generate_program_sessions are the only two
-- RETURNS TABLE functions 0113 touches.
-- Phase 33D2a correction: proname/oid were left unqualified here despite
-- the query joining pg_proc AND pg_namespace, both of which have their own
-- oid column — an unqualified oid reference is genuinely ambiguous and
-- would raise "column reference is ambiguous" at runtime (the exact bug
-- class this section exists to detect elsewhere, ironically present here
-- in the verification script itself). Fixed by qualifying with p.
select
  p.proname,
  pg_get_function_result(p.oid) as returns_table_shape
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('get_event_roster', 'generate_program_sessions')
  and pg_get_function_result(p.oid) like 'TABLE%';
-- Expect: 2 rows. get_event_roster's output columns are profile_id,
-- display_name, role, status, attendance_status, offer_expires_at,
-- waitlist_position, roster_member_id — every SELECT inside the function
-- body qualifies these with a table alias (r., rm., p., c., eg.) rather
-- than leaving them bare; manually confirmed by reading the function (see
-- migration section I) rather than by regex, since a reliable ambiguity
-- regex would need a full SQL parser. generate_program_sessions's own
-- output columns (inserted_count, skipped_count, event_ids) do not
-- collide with any local variable or table column name it selects
-- unqualified.

-- ═══════════════════════════════════════════════════════════════════════════
-- 10. Historical identity fields never rewritten passively
-- ═══════════════════════════════════════════════════════════════════════════
-- No function should ever UPDATE profile_id on an existing row for a
-- reason other than an explicit reactivation action (admin_add_member /
-- admin_add_roster_participant / join_event reactivating a row they own,
-- or _materialize_program_member_into_future_events reactivating a
-- program member's own row) — none of these is a passive claim-triggered
-- rewrite (see migration header). The pure read/notification-path
-- functions below must never write profile_id at all.
select p.proname
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    '_leave_event_impl', 'accept_waitlist_offer', 'decline_waitlist_offer',
    'advance_waitlist_offer', 'expire_stale_offers_for_event',
    'cancel_event', 'update_event',
    'admin_remove_roster_participant', 'admin_force_confirm_roster_participant',
    'admin_offer_spot_roster_participant', 'admin_expire_offer_roster_participant',
    'mark_attendance_roster_participant'
  )
  and pg_get_functiondef(p.oid) ~ 'set\s+[^;]*\bprofile_id\s*=';
-- Expect: 0 rows — none of these twelve RPCs ever sets profile_id in an
-- UPDATE ... SET list.

-- ═══════════════════════════════════════════════════════════════════════════
-- 11. Calendar / My Schedule identity fields available (frontend claim
--     continuity)
-- ═══════════════════════════════════════════════════════════════════════════
-- No SQL-side assertion possible for frontend query strings — recorded
-- here as a manual cross-check: confirm CalendarShell.tsx's events
-- .select() includes `event_participants(profile_id, roster_member_id,
-- role, status, offer_expires_at)`, my-schedule/page.tsx's event_
-- participants query is `.or(\`profile_id.eq.${user.id},roster_member_id.
-- eq.${rosterMemberId}\`)`, and EventDetailSheet/EventRosterSheet both
-- accept and use roster_member_id for ownership/action-target matching.
select true as manual_frontend_cross_check_required;

-- ═══════════════════════════════════════════════════════════════════════════
-- 12. event_guests / true Guests untouched; admin_add_roster_member_to_
--     event left in place but no longer called by the new frontend
-- ═══════════════════════════════════════════════════════════════════════════
select count(*) as event_guests_row_count_unchanged_marker
from public.event_guests;
-- No fixed expectation — record this count before and after applying
-- 0113 and confirm it is identical (0113 never inserts, updates, or
-- deletes any event_guests row).

select relname as table_name, relrowsecurity as rls_enabled
from pg_class
where relname in ('event_participants', 'event_guests', 'program_enrollments')
  and relnamespace = 'public'::regnamespace
order by relname;
-- Expect: rls_enabled = true on all three — this migration does not touch
-- RLS on any table.

select tablename, policyname, cmd
from pg_policies
where schemaname = 'public'
  and tablename   in ('event_participants', 'event_guests')
order by tablename, policyname;
-- Expect: event_participants has only event_participants_select_same_club
-- (SELECT); event_guests has only event_guests_select_club_members
-- (SELECT) — same policies as before this migration, no new policy added.

-- ═══════════════════════════════════════════════════════════════════════════
-- 13. PL/pgSQL FOUND-lifetime correctness (0114 hotfix) — admin_add_member,
--     join_event, admin_add_roster_participant
-- ═══════════════════════════════════════════════════════════════════════════
-- 0113's original bodies located an existing row via `select * into
-- v_existing ... for update`, then issued an intervening SELECT INTO
-- (the capacity aggregate) that always returns exactly one row and
-- therefore always resets FOUND = true — before a later `if found then
-- update ... else insert ...` branch read it. For a genuinely new
-- participant (v_existing correctly not found), this silently forced the
-- UPDATE branch, which matched zero rows (v_existing.id was null) and
-- left v_result unpopulated with no error, no row written, and no
-- indication of failure — audit_log still committed as if it had
-- succeeded. 0114 fixes this by capturing FOUND into a stable
-- v_existing_found boolean immediately after the v_existing lookup, using
-- only that boolean thereafter, and adding a fail-closed guard on
-- v_result.id before any success side effect.
select
  p.proname,
  pg_get_functiondef(p.oid) ~ 'v_existing_found := found;'
    as captures_stable_found_immediately,
  pg_get_functiondef(p.oid) ~ 'if v_existing_found then'
    as branches_on_stable_boolean,
  pg_get_functiondef(p.oid) !~ 'if found then\s*\n\s*update (public\.)?event_participants'
    as no_leftover_bare_found_reactivation_branch,
  pg_get_functiondef(p.oid) ~ 'v_result\.id is null'
    and pg_get_functiondef(p.oid) ~ 'event_participant_write_failed'
    as has_fail_closed_write_guard
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('admin_add_member', 'join_event', 'admin_add_roster_participant')
order by p.proname;
-- Expect: 3 rows, all four columns true for every row.
--
-- _materialize_program_member_into_future_events is deliberately NOT
-- included here — it branches on FOUND immediately after its own
-- v_existing lookup with no intervening SQL statement, so it was never
-- affected by this bug class and needs no v_existing_found capture. Confirm
-- that remains true (no SQL statement was inserted between its lookup and
-- its FOUND check by any later change):
select
  pg_get_functiondef(p.oid) ~ 'for update;\s*\n\s*\n?\s*if found then'
    as branches_immediately_after_lookup
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = '_materialize_program_member_into_future_events';
-- Expect: 1 row, true.

-- Data-level canary: given the 0114 fix, no event_participants row should
-- ever exist with a null id (structurally impossible — id is the primary
-- key — included only as a trivial sanity check) and, more meaningfully,
-- every add-family audit_log entry with final_status confirmed/waitlisted
-- should correspond to an actual current-or-since-superseded
-- event_participants row for that same (event_id, roster_member_id) pair.
select
  al.id as audit_log_id, al.action, al.target_id as event_id,
  al.metadata->>'roster_member_id' as roster_member_id,
  al.created_at
from public.audit_log al
where al.action in ('admin_add_member', 'admin_add_roster_participant')
  and al.metadata->>'final_status' in ('confirmed', 'waitlisted')
  and not exists (
    select 1 from public.event_participants ep
    where ep.event_id         = al.target_id
      and ep.roster_member_id = (al.metadata->>'roster_member_id')::uuid
  )
order by al.created_at desc
limit 50;
-- Expect: 0 rows for any add logged AFTER 0114 is applied. Rows here dated
-- BEFORE 0114 was applied are the known pre-fix incidents (e.g. the 33D2A
-- Claim Continuity repro) and do not indicate a live defect — they
-- reflect audit entries written while the bug was still active, for
-- writes that never actually persisted a participant row.
