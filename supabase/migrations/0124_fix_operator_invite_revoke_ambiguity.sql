-- 0124_fix_operator_invite_revoke_ambiguity.sql
-- Phase 33F3C: set_club_tier_for_operator ambiguous-column hotfix.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
-- 0123 (applied) added a Member-invite bulk-revoke block to the staff_
-- managed branch of set_club_tier_for_operator. The first real Connected ->
-- Staff-Managed transition (grant-club-entitlement.mjs riverside
-- staff_managed) failed at runtime with "column reference \"club_id\" is
-- ambiguous". Root cause: set_club_tier_for_operator's RETURNS TABLE clause
-- declares an output parameter named club_id (alongside tier and status),
-- which PL/pgSQL treats as an implicitly-declared variable in scope for the
-- entire function body. The invite-revoke UPDATE's WHERE clause referenced
-- club_id unqualified — `where club_id = p_club_id` — which collides with
-- that output variable exactly the way 0122's own SELECT into
-- v_active_entitlement once did (fixed there via a `ce.` alias, before this
-- new block existed). This block was added in 0123 and was never covered
-- by that earlier fix.
--
-- Every other statement in the function was re-audited against all three
-- output-variable names (club_id, tier, status) — see the function body
-- below for the full statement-by-statement account. Only the one
-- reference is actually ambiguous; everything else already qualifies via
-- an alias, or is an INSERT column list / UPDATE SET target list, both of
-- which Postgres always resolves against the target table's own columns,
-- never against a PL/pgSQL variable of the same name, regardless of
-- qualification.
--
-- FUNCTION-ONLY HOTFIX. This CREATE OR REPLACE reproduces the current
-- effective body of public.set_club_tier_for_operator(uuid, text) — the
-- exact body 0123 applied, unchanged in every respect — with the invite-
-- revoke UPDATE's WHERE clause now referencing an explicit `ci` alias.
-- Same signature, same return shape, same SECURITY DEFINER/search_path/
-- grants, same entitlement behavior, same invitation semantics, same
-- atomicity (subscription + entitlement + Member-invite revoke still
-- commit or roll back together as one function body). No RLS policy, no
-- other function, no frontend file is touched. Does not modify 0122 or
-- 0123 — both remain exactly as applied.
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
  on conflict (club_id) do update
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
    -- Phase 33F3C: aliased as `ci` and fully qualified — the previously
    -- unqualified `club_id` collided with this function's own RETURNS
    -- TABLE output variable of the same name, raising "column reference
    -- \"club_id\" is ambiguous" at runtime. role/accepted_at/revoked_at
    -- were never actually ambiguous (no output variable shares those
    -- names), but are qualified too for consistency with club_id in the
    -- same WHERE clause.
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
-- supabase/migrations/0123_staff_managed_connected_enforcement.sql (the
-- unaliased, ambiguous version this migration replaces). No other object
-- is created, dropped, or altered by this migration.
