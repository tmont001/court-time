-- 0194_member_waiver_compliance_operations.sql
-- Phase 43B-1A — Member Waiver Compliance Read Foundation.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
-- /admin/members needs to show waiver compliance for the whole roster
-- without calling get_member_waiver_status once per row (N+1). This
-- migration adds exactly one new SET-BASED bulk RPC that computes every
-- roster member's compliance state in a single query, and widens the
-- existing single-Member detail RPC's read authorization from Admin-only
-- to Admin-or-Staff. Nothing else changes.
--
-- 0192 and 0193 are APPLIED and IMMUTABLE — not touched by this file.
-- get_member_waiver_status is redefined here via CREATE OR REPLACE with
-- an UNCHANGED signature (same as 0193's own accepted_at fix), so — per
-- that same established precedent — its existing grants are preserved
-- automatically; no REVOKE/GRANT is reissued for it in this file.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- SCOPE (locked)
-- ═══════════════════════════════════════════════════════════════════════════
--   B. NEW: get_club_member_waiver_compliance() — Admin+Staff, same-club,
--      one set-based query, no per-row evaluator calls.
--   E. WIDEN: get_member_waiver_status(uuid) — role check only, Admin-only
--      -> Admin-or-Staff. Return contract, same-club scoping, and
--      evaluator delegation are otherwise byte-identical to 0193.
--
-- NOT in this migration: /admin/members UI, Guest waiver documents/tokens/
-- acceptance/roster integration, booking/lesson/event enforcement, any
-- change to get_my_member_waiver_status/accept_member_waiver/the four
-- Admin authoring RPCs (create/update/publish_member_waiver_*, set_
-- member_waiver_required) — all untouched, unreferenced, and ungranted
-- to anyone new by this file.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- COLUMN-AMBIGUITY LESSON APPLIED (0192/0193 post-mortem)
-- ═══════════════════════════════════════════════════════════════════════════
-- get_club_member_waiver_compliance's RETURNS TABLE introduces
-- roster_member_id/waiver_configured/status as implicit PL/pgSQL
-- variables in scope for the whole function body — exactly the class of
-- name that caused 0192's 42702 bug. Every column reference in this
-- function's query is therefore alias-qualified without exception (rm.id,
-- w.id, w.is_required, w.current_version_id, a.waiver_version_id,
-- a.roster_member_id, v.waiver_id) — no bare column name is ever written,
-- and neither waiver_versions.status nor any bare "status"/"roster_
-- member_id" column is referenced anywhere in the query body. See the
-- "LIVE INVOCATION QA" block at the end of this file for exact post-apply
-- verification queries.
--
-- Apply in Supabase SQL Editor (cloud only). Not applied by this checkpoint.

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- B. get_club_member_waiver_compliance — bulk, set-based, Admin+Staff.
-- ═══════════════════════════════════════════════════════════════════════════
-- Returns exactly one row per roster_members row in the caller's club —
-- every role (member/pro/staff/admin), every roster_members.status
-- (active/inactive), claimed or unclaimed. This is a deliberate design
-- choice, not an oversight:
--   - Role-agnostic, matching 43A's own canonical evaluator and
--     accept_member_waiver: an Admin's or Pro's own roster identity is
--     just as subject to the Member waiver as anyone else's, so filtering
--     by role here would silently diverge from that semantics.
--   - No roster_members.status/claimed_by filter: locked decision G
--     requires an unclaimed roster member to evaluate correctly (never_
--     accepted when required and never accepted), and the /admin/members
--     surface this feeds already has its own active/inactive filtering
--     (get_roster_members' own p_include_inactive) — this RPC is a
--     complete lookup table keyed by roster_member_id; the caller decides
--     which subset of rows to actually display, exactly as get_members()/
--     get_roster_members() already do for membership fields.
--
-- Return shape:
--   roster_member_id   uuid    — join key back to get_members()/
--                                 get_roster_members()'s own roster_
--                                 member_id-bearing rows.
--   waiver_configured   boolean — true iff a club-wide Member waiver
--                                 document (waivers row, audience='member')
--                                 exists AT ALL, independent of is_required
--                                 or whether a version has ever been
--                                 published. This is the explicit,
--                                 authoritative discriminator the caller
--                                 MUST check first: "no waiver configured"
--                                 and "waiver configured but requirement
--                                 is off" are two different product
--                                 states (locked decision), and this
--                                 boolean is what tells them apart — never
--                                 inferred from status alone.
--   status              text    — one of the same four values 43A's
--                                 canonical _evaluate_member_waiver_status
--                                 already returns: not_required, current,
--                                 outdated, never_accepted. Deliberately
--                                 STILL 'not_required' (not null, not a
--                                 fifth value) when waiver_configured is
--                                 false — that remains an accurate
--                                 description of the roster member's
--                                 current obligation ("nothing to do
--                                 either way"), and keeping status a
--                                 always-one-of-four-values text (never
--                                 null) is simpler for every caller. The
--                                 caller branches on waiver_configured
--                                 FIRST to decide whether to show any
--                                 indicator at all (locked decision 5:
--                                 hide entirely when no waiver exists),
--                                 THEN on status for which pill to show.
--
-- accepted_at is deliberately NOT included here (evaluated, not added
-- speculatively): this bulk read's only consumer is a roster-wide colored
-- pill (Accepted/Needs acceptance/Updated waiver/Not required /
-- Not-shown-at-all) per the locked UI semantics — no date is displayed at
-- that grain. get_member_waiver_status (Section E below) already returns
-- accepted_at for the single-row Admin Member Detail surface, which does
-- show a date. Adding it here would mean an extra correlated lookup per
-- roster row for a value with no consumer in this checkpoint.
--
-- Status derivation mirrors _evaluate_member_waiver_status's four branches
-- exactly (not re-invented): not_required (no waiver row, OR is_required
-- = false, OR no current_version_id yet) -> current (an acceptance exists
-- for current_version_id) -> outdated (an acceptance exists for SOME
-- version of this waiver, but not the current one) -> never_accepted
-- (neither). Both EXISTS subqueries are correlated per roster row within
-- ONE query plan — this is ordinary set-based SQL, not a client-side or
-- PL/pgSQL loop calling an RPC/function once per row; it costs one query,
-- not N.
create or replace function public.get_club_member_waiver_compliance()
returns table (
  roster_member_id  uuid,
  waiver_configured boolean,
  status            text
)
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
  v_role    text;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if v_role is distinct from 'admin' and v_role is distinct from 'staff' then
    raise exception 'insufficient_role';
  end if;

  return query
    select
      rm.id,
      (w.id is not null),
      case
        when w.id is null                  then 'not_required'
        when w.is_required is false        then 'not_required'
        when w.current_version_id is null  then 'not_required'
        when exists (
          select 1 from public.waiver_acceptances a
           where a.waiver_version_id = w.current_version_id
             and a.roster_member_id  = rm.id
        ) then 'current'
        when exists (
          select 1
            from public.waiver_acceptances a
            join public.waiver_versions v on v.id = a.waiver_version_id
           where v.waiver_id        = w.id
             and a.roster_member_id = rm.id
        ) then 'outdated'
        else 'never_accepted'
      end
    from public.roster_members rm
    left join public.waivers w
      on w.club_id = rm.club_id and w.audience = 'member'
    where rm.club_id = v_club_id;
end;
$$;

comment on function public.get_club_member_waiver_compliance() is
  'Phase 43B-1A: bulk, set-based Member waiver compliance for the whole
   roster — Admin+Staff only, same-club. One row per roster_members row
   (every role, claimed or unclaimed, active or inactive). waiver_
   configured distinguishes "no Member waiver document exists" from
   "waiver exists but is not required/published" — status alone is never
   sufficient to tell those apart. No per-row RPC/evaluator call: both
   acceptance checks are correlated EXISTS subqueries inside one query.';

revoke execute on function public.get_club_member_waiver_compliance() from public, anon;
grant  execute on function public.get_club_member_waiver_compliance() to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- E. get_member_waiver_status — widen READ authorization only: Admin-only
--    -> Admin-or-Staff. Everything else is byte-identical to 0193's body
--    (same signature, same RETURNS TABLE, same same-club scoping, same
--    evaluator delegation, same accepted_at fix) — CREATE OR REPLACE on
--    an unchanged signature preserves existing grants automatically (same
--    established precedent as 0193 itself), so no REVOKE/GRANT follows
--    this redefinition.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.get_member_waiver_status(
  p_roster_member_id uuid
)
returns table (
  status              text,
  waiver_id           uuid,
  current_version_id  uuid,
  version_number      integer,
  title               text,
  published_at        timestamptz,
  accepted_at         timestamptz,
  is_required         boolean
)
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_club_id             uuid;
  v_role                text;
  v_status              text;
  v_waiver_id           uuid;
  v_current_version_id  uuid;
  v_version_number      integer;
  v_title               text;
  v_published_at        timestamptz;
  v_is_required         boolean;
  v_accepted_at         timestamptz;
begin
  select public.current_user_club_id(), public.current_user_role()
    into v_club_id, v_role;

  if v_club_id is null then raise exception 'not_authenticated'; end if;
  -- Phase 43B-1A: widened from Admin-only to Admin-or-Staff (locked
  -- decision 1). Member/Pro still rejected — this is a READ widening
  -- only; authoring/configuration RPCs (Section below, untouched) remain
  -- exactly as Admin-only as they were in 0192.
  if v_role is distinct from 'admin' and v_role is distinct from 'staff' then
    raise exception 'insufficient_role';
  end if;

  if not exists (
    select 1 from public.roster_members
     where id = p_roster_member_id and club_id = v_club_id
  ) then
    raise exception 'roster_member_not_found';
  end if;

  v_status := public._evaluate_member_waiver_status(p_roster_member_id, v_club_id);

  select w.id, w.current_version_id, cv.version_number, cv.title,
         cv.published_at, coalesce(w.is_required, false)
    into v_waiver_id, v_current_version_id, v_version_number, v_title,
         v_published_at, v_is_required
    from public.waivers w
    left join public.waiver_versions cv
      on cv.id = w.current_version_id and cv.status = 'published'
   where w.club_id = v_club_id and w.audience = 'member';

  if v_status = 'current' then
    select a.accepted_at into v_accepted_at
      from public.waiver_acceptances a
     where a.waiver_version_id = v_current_version_id
       and a.roster_member_id  = p_roster_member_id;
  end if;

  return query
    select v_status, v_waiver_id, v_current_version_id, v_version_number,
           v_title, v_published_at, v_accepted_at, coalesce(v_is_required, false);
end;
$$;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- LIVE INVOCATION QA (run after applying, in the Supabase SQL Editor —
-- this migration was explicitly designed to make this pass trivial after
-- the 0192 runtime lesson)
-- ═══════════════════════════════════════════════════════════════════════════
-- 1. As Admin or Staff, in your test club:
--      select * from public.get_club_member_waiver_compliance();
--    Expect one row per roster member, no error, waiver_configured/status
--    populated for every row (never a raw 42702 or any other Postgres
--    error — if this raises, STOP and do not treat this migration as safe).
--
-- 2. As Member or Pro:
--      select * from public.get_club_member_waiver_compliance();
--    Expect: error insufficient_role.
--
-- 3. As Staff, for a same-club roster member:
--      select * from public.get_member_waiver_status('<roster_member_id>');
--    Expect: succeeds, same shape as before this migration (status,
--    waiver_id, current_version_id, version_number, title, published_at,
--    accepted_at, is_required) — no new/missing columns.
--
-- 4. As Staff, for a DIFFERENT club's roster_member_id:
--      select * from public.get_member_waiver_status('<other_club_rm_id>');
--    Expect: error roster_member_not_found (same-club scoping intact).
--
-- 5. Confirm Staff is still rejected by every authoring/configuration RPC
--    (unchanged by this migration, sanity-check only):
--      select public.create_member_waiver_draft('x','y');       -- insufficient_role
--      select public.set_member_waiver_required(false);          -- insufficient_role
--      select public.publish_member_waiver_version(gen_random_uuid()); -- insufficient_role
--
-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration created
-- in this checkpoint)
-- ═══════════════════════════════════════════════════════════════════════════
-- drop function if exists public.get_club_member_waiver_compliance();
-- CREATE OR REPLACE get_member_waiver_status back to its exact 0193 body
-- (revert the role check to `if v_role is distinct from 'admin' then
-- raise exception 'insufficient_role'; end if;`) — no signature change
-- either direction, so no DROP is ever required for this function. No
-- table, constraint, RLS policy, trigger, or other function is touched by
-- this migration.
