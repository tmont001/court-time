-- verify_phase33e1.sql
-- Phase 33E1: Program Waitlist Lifecycle Correctness — POST-migration
-- verification for 0116_program_waitlist_lifecycle_correctness.sql.
--
-- Run in the Supabase SQL Editor AFTER 0116 has been applied. Every query
-- is read-only. Text-pattern function-body checks are not a full
-- behavioral proof — supplement with the runtime QA plan from the
-- implementation report (a real capacity=1 / claimed+no-account waitlist
-- repro is the only thing that truly proves the fix).
--
-- Scope note: reporting identity parity (get_member_engagement_summary /
-- get_reporting_overview) is OUT OF SCOPE for 33E1 — moved to 33E2.
-- Neither function is touched by 0116, and this script makes no assertion
-- about either.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Function existence, signatures unchanged, SECURITY DEFINER, fixed
--    search_path, grants preserved
-- ═══════════════════════════════════════════════════════════════════════════
with expected(proname) as (
  values
    ('_advance_program_waitlist_offer'),
    ('_expire_stale_program_offers')
)
select
  expected.proname,
  p.oid is not null                                              as function_exists,
  pg_get_function_identity_arguments(p.oid)                       as args,
  coalesce(p.prosecdef, false)                                   as is_security_definer,
  coalesce(
    exists (
      select 1 from unnest(p.proconfig) cfg
      where cfg like 'search_path=%public%'
        and cfg like '%pg_temp%'
    ),
    false
  )                                                               as has_fixed_search_path
from expected
left join pg_proc p
  on p.proname = expected.proname
 and p.pronamespace = 'public'::regnamespace
order by expected.proname;
-- Expect: 2 rows. function_exists / is_security_definer / has_fixed_
-- search_path all true. args must read exactly:
--   _advance_program_waitlist_offer(p_program_id uuid, p_club_id uuid,
--     p_program_title text)
--   _expire_stale_program_offers(p_program_id uuid, p_club_id uuid,
--     p_program_title text)
-- — identical to pre-0116, confirming both changes were body-only CREATE
-- OR REPLACE, no DROP anywhere in this migration.

select p.proname, count(*) as overload_count
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('_advance_program_waitlist_offer', '_expire_stale_program_offers')
group by p.proname;
-- Expect: 2 rows, every overload_count = 1.

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
  and p.proname in ('_advance_program_waitlist_offer', '_expire_stale_program_offers')
order by p.proname, g.grantee;
-- Expect: can_execute = false for every row — both remain internal-only,
-- unchanged from their 0091 posture.

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Mutation key uses durable row identity, not nullable profile_id
-- ═══════════════════════════════════════════════════════════════════════════
select
  pg_get_functiondef(p.oid) ~ 'select id, roster_member_id into v_next_id'
    as fifo_selects_row_id,
  pg_get_functiondef(p.oid) ~ 'where id = v_next_id'
    as update_targets_row_id,
  pg_get_functiondef(p.oid) !~ 'where program_id = p_program_id\s*\n?\s*and profile_id = v_next_profile'
    as no_leftover_profile_id_mutation_key,
  pg_get_functiondef(p.oid) ~ 'get diagnostics v_rows_updated = row_count'
    as has_fail_closed_write_guard
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = '_advance_program_waitlist_offer';
-- Expect: 1 row, all four columns true.

select
  pg_get_functiondef(p.oid) ~ 'select id, profile_id, roster_member_id'
    as loop_selects_row_id,
  pg_get_functiondef(p.oid) ~ 'where id = v_row\.id'
    as update_targets_row_id,
  pg_get_functiondef(p.oid) !~ 'where program_id = p_program_id\s*\n?\s*and profile_id = v_row\.profile_id'
    as no_leftover_profile_id_mutation_key,
  pg_get_functiondef(p.oid) ~ 'get diagnostics v_rows_updated = row_count'
    as has_fail_closed_write_guard
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = '_expire_stale_program_offers';
-- Expect: 1 row, all four columns true.

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. No-account Program promotion can now be represented — data-level proof
-- ═══════════════════════════════════════════════════════════════════════════
-- Structural proof only (this script cannot itself trigger a promotion —
-- see the runtime QA plan for the real repro). This query re-runs the
-- preflight's query 3 ("stuck stale offers") — any row it previously
-- found should be gone (resolved) the next time a leave/remove/expire
-- action touches that program, not immediately upon migration apply (0116
-- does not proactively sweep existing rows).
select
  pe.id, pe.program_id, pe.roster_member_id, pe.profile_id,
  pe.status, pe.offer_expires_at
from public.program_enrollments pe
where pe.status = 'offered'
  and pe.offer_expires_at < now();
-- Immediately after apply: may still show the same rows as the preflight
-- (expected — nothing proactively swept them). After the next natural
-- trigger (any leave_program/remove_program_member/remove_program_
-- roster_member/decline_program_waitlist_offer call against that
-- program, or a fresh join/add that calls _expire_stale_program_offers):
-- re-run this query and confirm the previously-stuck rows are gone
-- (resolved to 'cancelled' with the queue advanced).

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Notification NULL-recipient guard and metadata shape
-- ═══════════════════════════════════════════════════════════════════════════
select
  pg_get_functiondef(p.oid) ~ 'select claimed_by into v_current_member_id'
    as resolves_claimed_by_fresh,
  pg_get_functiondef(p.oid) ~ 'if v_current_member_id is not null then'
    as skips_notification_when_unclaimed,
  pg_get_functiondef(p.oid) ~ 'insert into public\.notifications'
    as inserts_notification,
  pg_get_functiondef(p.oid) ~ '''triggered_by'',\s*\n?\s*auth\.uid\(\)'
    as metadata_includes_triggered_by
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = '_advance_program_waitlist_offer';
-- Expect: 1 row, all four columns true.

-- Data-level canary: no notifications row should ever have a null user_id
-- (structurally impossible — the column is NOT NULL — included as a
-- direct assertion).
select count(*) as null_user_id_notifications
from public.notifications
where user_id is null;
-- Expect: 0 (would already be impossible without this migration; this is
-- a sanity check, not a new guarantee this migration introduces).

-- Confirms the notification's kind/metadata shape is exactly what
-- get_waitlist_delivery_context (0102, unmodified) already expects, and
-- that triggered_by is present for future dispatch-authorization
-- compatibility.
select
  n.id, n.kind, n.metadata, n.created_at
from public.notifications n
where n.kind = 'waitlist_offer'
  and n.metadata ? 'program_id'
order by n.created_at desc
limit 20;
-- Informational — after runtime QA produces at least one Program waitlist
-- offer for a claimed enrollee, confirm rows appear here with metadata
-- containing 'program_id', 'offer_expires_at', and 'triggered_by' — no
-- 'event_id' key.

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. No duplicate durable identities introduced; existing row counts
--    preserved (untouched-invariant regression canary)
-- ═══════════════════════════════════════════════════════════════════════════
select status, count(*) as row_count
from public.program_enrollments
group by status
order by status;
-- Compare directly against the preflight script's query 1 baseline — must
-- be byte-for-byte identical (0116 changes no program_enrollments row,
-- only the functions that read/write them).

-- A roster_member_id should never appear more than once among currently-
-- active (non-cancelled) rows for the same program — pre-existing
-- guarantee (0115's unique constraint), re-confirmed here as unaffected
-- by this migration.
select program_id, roster_member_id, count(*)
from public.program_enrollments
where status <> 'cancelled'
group by program_id, roster_member_id
having count(*) > 1;
-- Expect: 0 rows.
