-- 0193_fix_member_waiver_status_accepted_at_ambiguity.sql
-- Phase 43A-1 hotfix — column ambiguity in the two waiver-status read RPCs.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- BUG (found in runtime QA after 0192 was applied)
-- ═══════════════════════════════════════════════════════════════════════════
-- Postgres error 42702 ("column reference \"accepted_at\" is ambiguous")
-- when calling get_my_member_waiver_status(). Both waiver-status RPCs
-- declare RETURNS TABLE (..., accepted_at timestamptz, ...) — inside
-- PL/pgSQL, a RETURNS TABLE output column name is an implicitly-declared
-- variable in scope for the whole function body, exactly like a `declare`
-- variable. Both functions then read:
--
--   select accepted_at into v_accepted_at
--     from public.waiver_acceptances
--    where ...
--
-- "accepted_at" here could mean either the RETURNS TABLE output variable
-- or waiver_acceptances.accepted_at — Postgres cannot resolve which, and
-- rejects the statement outright. The same bug exists identically in both
-- get_my_member_waiver_status() and get_member_waiver_status(uuid).
--
-- 0192 is APPLIED and IMMUTABLE — not touched by this file. This is a
-- pure CREATE OR REPLACE FUNCTION hotfix, byte-identical to the 0192
-- bodies except for table-qualifying the one ambiguous read in each
-- function via an explicit `a` alias on waiver_acceptances. No table,
-- constraint, RLS policy, the evaluator, the acceptance RPC, any
-- authoring RPC, or any waiver semantics are touched.
--
-- Targeted scan of both full function bodies for any OTHER unqualified
-- column reference that collides with a RETURNS TABLE output name (status,
-- waiver_id, current_version_id, version_number, title, body [get_my_*
-- only], published_at, accepted_at, is_required): every other read in
-- both functions is already table/CTE-qualified (w.*, cv.*) or assigns
-- into v_-prefixed declared variables that cannot collide with a bare
-- column/output name. accepted_at is the only concrete ambiguity in
-- either function — nothing else is changed.
--
-- Because CREATE OR REPLACE FUNCTION preserves an existing function's
-- privileges when the signature is unchanged (Postgres behavior — matches
-- this repo's own established precedent, e.g. 0190's create_reservation/
-- admin_create_member_reservation/update_member_reservation replacements,
-- none of which re-issue REVOKE/GRANT), no REVOKE/GRANT statement appears
-- in this file — the 0192 grants (authenticated only) remain exactly as
-- they were.
--
-- Apply in Supabase SQL Editor (cloud only). Not applied by this checkpoint.

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- get_my_member_waiver_status — same signature/RETURNS TABLE/SECURITY
-- DEFINER/STABLE/search_path/role-agnostic behavior as 0192. Only change:
-- the accepted_at lookup now reads a.accepted_at from an aliased
-- waiver_acceptances a.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.get_my_member_waiver_status()
returns table (
  status              text,
  waiver_id           uuid,
  current_version_id  uuid,
  version_number      integer,
  title               text,
  body                text,
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
  v_roster_member_id    uuid;
  v_status              text;
  v_waiver_id           uuid;
  v_current_version_id  uuid;
  v_version_number      integer;
  v_title               text;
  v_body                text;
  v_published_at        timestamptz;
  v_is_required         boolean;
  v_accepted_at         timestamptz;
begin
  v_club_id := public.current_user_club_id();
  if v_club_id is null then raise exception 'not_authenticated'; end if;

  -- Role-agnostic (decision 6): resolved purely from claimed_by, no role
  -- check of any kind — a Member, Pro, Staff, or Admin's own roster
  -- identity resolves identically.
  select id into v_roster_member_id
    from public.roster_members
   where club_id    = v_club_id
     and claimed_by = auth.uid();
  if not found then raise exception 'no_roster_identity'; end if;

  v_status := public._evaluate_member_waiver_status(v_roster_member_id, v_club_id);

  select w.id, w.current_version_id, cv.version_number, cv.title, cv.body,
         cv.published_at, coalesce(w.is_required, false)
    into v_waiver_id, v_current_version_id, v_version_number, v_title, v_body,
         v_published_at, v_is_required
    from public.waivers w
    left join public.waiver_versions cv
      on cv.id = w.current_version_id and cv.status = 'published'
   where w.club_id = v_club_id and w.audience = 'member';

  if v_status = 'current' then
    -- 0193 fix: table-qualified via alias a — accepted_at alone is
    -- ambiguous against this function's own RETURNS TABLE output column
    -- of the same name.
    select a.accepted_at into v_accepted_at
      from public.waiver_acceptances a
     where a.waiver_version_id = v_current_version_id
       and a.roster_member_id  = v_roster_member_id;
  end if;

  return query
    select v_status, v_waiver_id, v_current_version_id, v_version_number,
           v_title, v_body, v_published_at, v_accepted_at,
           coalesce(v_is_required, false);
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- get_member_waiver_status — same signature/RETURNS TABLE/SECURITY
-- DEFINER/STABLE/search_path/Admin-only-same-club behavior as 0192. Only
-- change: the accepted_at lookup now reads a.accepted_at from an aliased
-- waiver_acceptances a.
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
  if v_role is distinct from 'admin' then raise exception 'insufficient_role'; end if;

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
    -- 0193 fix: table-qualified via alias a — accepted_at alone is
    -- ambiguous against this function's own RETURNS TABLE output column
    -- of the same name.
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
-- Rollback procedure (documentation only — no rollback migration created in
-- this checkpoint)
-- ═══════════════════════════════════════════════════════════════════════════
-- CREATE OR REPLACE both functions back to their exact 0192 bodies (revert
-- `select a.accepted_at into v_accepted_at from public.waiver_acceptances a
-- where a.waiver_version_id = ... and a.roster_member_id = ...` to the
-- original unqualified `select accepted_at into v_accepted_at from
-- public.waiver_acceptances where waiver_version_id = ... and
-- roster_member_id = ...` in both functions — this restores the 42702 bug,
-- so only do this if 0192 itself is also being rolled back). No table,
-- constraint, RLS policy, trigger, or other function is touched by this
-- migration — nothing else needs reverting.
