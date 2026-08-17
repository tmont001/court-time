-- 0125_fix_operator_on_conflict_ambiguity.sql
-- Phase 33F3C: set_club_tier_for_operator ON CONFLICT ambiguous-column hotfix.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
-- 0124's runtime test (grant-club-entitlement.mjs riverside staff_managed)
-- still failed with "column reference \"club_id\" is ambiguous" — the same
-- symptom, but 0124's fix (aliasing the club_invites revoke) never
-- actually runs first: execution reaches `insert into
-- public.club_subscriptions (...) on conflict (club_id) do update` before
-- it ever gets to the invite-revoke block. set_club_tier_for_operator's
-- RETURNS TABLE (club_id uuid, tier text, status text) declares club_id as
-- an implicitly-available PL/pgSQL variable for the whole function body,
-- and PostgreSQL resolves an ON CONFLICT (column) target's column name
-- against that scope the same way it resolves any other unqualified name
-- in a PL/pgSQL SQL command — the conflict target is not a plain DDL-style
-- column list immune to variable shadowing the way an INSERT column list
-- or an UPDATE SET target is (see 0124's own audit for that distinction).
--
-- Confirmed constraint name: club_subscriptions was created in 0122 with
-- an unnamed table-level `unique (club_id)` constraint (migration
-- 0122_entitlement_foundation.sql, Section 1). PostgreSQL's standard
-- auto-naming for an unnamed single-column UNIQUE constraint is
-- <table>_<column>_key, so the actual constraint is
-- club_subscriptions_club_id_key — verified directly against 0122's table
-- definition, not assumed.
--
-- FUNCTION-ONLY HOTFIX. This CREATE OR REPLACE reproduces 0124's exact
-- applied body verbatim, changing ONLY the ON CONFLICT clause from a
-- column-name target (ambiguous) to a named-constraint target
-- (unambiguous — a constraint name can never collide with a PL/pgSQL
-- variable, since constraint names and variable names occupy entirely
-- separate PostgreSQL namespaces). Every other statement, including the
-- 0124 `ci`-aliased invite-revoke UPDATE, is unchanged. Same signature,
-- same RETURNS TABLE shape, same SECURITY DEFINER/search_path/grants, same
-- entitlement/invitation behavior, same atomicity. No RLS policy, no other
-- function, no frontend file is touched. Does not modify 0122, 0123, or
-- 0124 — all three remain exactly as applied.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

create or replace function public.set_club_tier_for_operator(
  p_club_id uuid,
  p_tier    text
)
returns table (
  club_id uuid,
  tier    text,
  status  text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_exists        boolean;
  v_active_entitlement public.club_entitlements%rowtype;
  v_entitlement_found  boolean;
begin
  if p_tier not in ('staff_managed', 'connected') then
    raise exception 'invalid_tier';
  end if;

  select exists(select 1 from public.clubs where id = p_club_id) into v_club_exists;
  if not v_club_exists then
    raise exception 'club_not_found';
  end if;

  insert into public.club_subscriptions (club_id, tier, status, source)
  values (p_club_id, p_tier, 'active', 'manual_pilot')
  on conflict on constraint club_subscriptions_club_id_key do update
    set tier       = excluded.tier,
        status     = excluded.status,
        source     = excluded.source,
        updated_at = now();

  select ce.* into v_active_entitlement
    from public.club_entitlements ce
   where ce.club_id     = p_club_id
     and ce.capability  = 'member_self_service'
     and ce.revoked_at is null;
  v_entitlement_found := found;

  if p_tier = 'connected' then
    if not v_entitlement_found or not v_active_entitlement.enabled then
      if v_entitlement_found then
        update public.club_entitlements
           set revoked_at = now()
         where id = v_active_entitlement.id;
      end if;

      insert into public.club_entitlements (club_id, capability, enabled, granted_by, note)
      values (
        p_club_id, 'member_self_service', true, null,
        'Granted via set_club_tier_for_operator (manual_pilot).'
      );
    end if;
  else
    -- staff_managed: revoke the active grant if one exists. Never inserts
    -- a "disabled" row — absence of an active row already means false
    -- (club_has_capability's own fail-closed default), so there is
    -- nothing to represent beyond the revocation itself.
    if v_entitlement_found and v_active_entitlement.enabled then
      update public.club_entitlements
         set revoked_at = now()
       where id = v_active_entitlement.id;
    end if;

    -- Phase 33F3B: revoke every outstanding Member-role invitation for
    -- this club — never Admin/Pro invites, never an already-accepted or
    -- already-revoked invite of any role (the WHERE clause naturally
    -- excludes both by only matching rows still eligible to be accepted).
    -- Phase 33F3C (0124): aliased as `ci` and fully qualified — the
    -- previously unqualified `club_id` collided with this function's own
    -- RETURNS TABLE output variable of the same name. Unchanged here.
    update public.club_invites ci
       set revoked_at = now()
     where ci.club_id     = p_club_id
       and ci.role        = 'member'
       and ci.accepted_at is null
       and ci.revoked_at  is null;
  end if;

  return query
    select cs.club_id, cs.tier, cs.status
    from public.club_subscriptions cs
    where cs.club_id = p_club_id;
end;
$$;

revoke execute on function public.set_club_tier_for_operator(uuid, text) from public, anon, authenticated;
grant  execute on function public.set_club_tier_for_operator(uuid, text) to service_role;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration created in
-- this checkpoint)
-- ═══════════════════════════════════════════════════════════════════════════
-- `set_club_tier_for_operator` -> restore the CREATE OR REPLACE body from
-- supabase/migrations/0124_fix_operator_invite_revoke_ambiguity.sql (the
-- `on conflict (club_id)` version this migration replaces). No other
-- object is created, dropped, or altered by this migration.
