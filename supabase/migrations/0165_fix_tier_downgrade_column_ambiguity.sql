-- 0165_fix_tier_downgrade_column_ambiguity.sql
-- Phase 34G-A2 — Runtime QA fix: PL/pgSQL column ambiguity in the
-- Connected -> Staff-Managed downgrade block added to
-- set_club_tier_for_operator by 0164 (already applied, NOT modified by
-- this migration) — AND repair of a historical-migration regression
-- discovered while diagnosing it.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- CRITICAL CORRECTION (this revision) — 0164 REGRESSED 0124/0125
-- ═══════════════════════════════════════════════════════════════════════════
-- The first draft of this migration built its CREATE OR REPLACE from the
-- applied 0164 body of set_club_tier_for_operator, on the assumption that
-- 0164 was itself built on the correct predecessor. It was not.
--
-- Full chronological history of public.set_club_tier_for_operator(uuid,
-- text), confirmed by direct read of every migration that touches it:
--   0122 (original)  — insert ... on conflict (club_id) do update ...; no
--                       invite-revoke block (33F3B enforcement was
--                       explicitly deferred, per 0122's own header).
--   0123             — adds the Staff-Managed Member-invite bulk-revoke
--                       block to the staff_managed branch, using an
--                       UNQUALIFIED `where club_id = p_club_id`. Still
--                       `on conflict (club_id)` from 0122, unchanged.
--   0124             — runtime hotfix: the FIRST real Connected ->
--                       Staff-Managed transition failed with "column
--                       reference \"club_id\" is ambiguous" because
--                       RETURNS TABLE (club_id, tier, status) makes all
--                       three implicit PL/pgSQL output variables, and the
--                       invite-revoke UPDATE's bare `club_id` collided
--                       with the output variable. Fixed by aliasing the
--                       UPDATE as `ci` and qualifying every column
--                       (`ci.club_id`, `ci.role`, `ci.accepted_at`,
--                       `ci.revoked_at`). `on conflict (club_id)` was
--                       NOT touched — that ambiguity had not yet been
--                       discovered, because execution never reached it in
--                       the specific run that surfaced 0124's bug.
--   0125             — a SECOND runtime hotfix on the SAME transition
--                       attempt: still failed with the identical
--                       "column reference \"club_id\" is ambiguous"
--                       symptom, because `on conflict (club_id)`'s
--                       conflict-target column name is ALSO resolved
--                       against the RETURNS TABLE output-variable scope
--                       (unlike a plain INSERT column-list or an UPDATE
--                       SET target, which are always table-column-only —
--                       see 0125's own header for the full distinction).
--                       Fixed by switching to the named-constraint form
--                       `on conflict on constraint
--                       club_subscriptions_club_id_key do update` — a
--                       constraint name occupies a separate namespace
--                       from PL/pgSQL variables, so it can never collide.
--                       Confirmed against 0122's own DDL: `unique
--                       (club_id)` as an unnamed table-level constraint
--                       on public.club_subscriptions auto-names to
--                       `club_subscriptions_club_id_key` under Postgres's
--                       standard <table>_<column>_key convention — grep
--                       against 0122 and every later migration confirms
--                       this constraint is never dropped or renamed.
--   0164 (applied)   — Pricing & Packaging Alignment. Its own header
--                       documents it as "Reproduced VERBATIM from its
--                       sole authoritative body (0122)" — this premise
--                       was WRONG. 0122 was superseded by 0123, then
--                       0124, then 0125 as the true pre-0164 effective
--                       body. By rebuilding from 0122, 0164 silently
--                       REGRESSED two already-shipped, already-runtime-
--                       verified fixes: it reintroduced the unqualified
--                       `on conflict (club_id)` (0125's fix, undone) and
--                       it omitted the Member-invite bulk-revoke block
--                       entirely (0123/0124's behavior, dropped). 0164 is
--                       already applied and is NOT edited by this
--                       migration — these regressions are corrected here,
--                       in 0165, layered on top.
--
-- CORRECTLY TREATED BASELINE FOR THIS MIGRATION: 0125 is the true
-- authoritative functional predecessor immediately before 0164 — not
-- 0122. The function below reproduces 0125's full body (named-constraint
-- ON CONFLICT restored, `ci`-aliased invite-revoke block restored), with
-- 0164's INTENDED commercial-safety additions (canonical advisory lock,
-- Checkout fan-out guard, payment_mode step-down) layered on top, and the
-- newly-added payment_mode UPDATE's own club_id reference qualified from
-- the start (see below) rather than repeating the exact bare-identifier
-- mistake 0124/0125 already had to fix twice in this same function.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- ORIGINAL ROOT CAUSE (confirmed via real operator downgrade runtime failure)
-- ═══════════════════════════════════════════════════════════════════════════
-- node --env-file=.env.local scripts/grant-club-entitlement.mjs riverside staff_managed
--   -> set_club_tier_for_operator failed: column reference "club_id" is
--      ambiguous
--
-- This was NOT a Checkout-resolution failure: all four stale Stripe
-- Checkout Sessions for the club had already independently confirmed
-- status=expired, all four expire_blocking_checkout_attempt(...) calls
-- had already returned 'proceed', and a direct query for remaining
-- payment_checkout_attempts.status='open' for the club returned zero
-- rows before this call was made.
--
-- 0164's downgrade block added:
--
--   update public.club_settings
--      set payment_mode = 'manual', updated_at = now()
--    where club_id = p_club_id
--      and payment_mode = 'court_time_payments';
--
-- The bare `club_id` in the WHERE clause is ambiguous between
-- club_settings' own club_id column and the function's own RETURNS TABLE
-- output variable of the identical name — Postgres cannot resolve it and
-- raises 42702 the instant this UPDATE actually plans and executes, i.e.
-- only on the genuine-downgrade code path once payment_mode was already
-- 'court_time_payments'. Exactly the same collision class 0124 and 0125
-- had already independently discovered and fixed twice in this same
-- function, on the two OTHER statements 0164 (working from the wrong
-- 0122 baseline) never saw.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- FIX (this migration)
-- ═══════════════════════════════════════════════════════════════════════════
-- set_club_tier_for_operator is reproduced from 0125's true authoritative
-- body (named-constraint ON CONFLICT, `ci`-aliased invite-revoke block —
-- both restored verbatim), with 0164's canonical advisory-lock
-- acquisition, current-tier read, and Checkout fan-out/payment_mode
-- step-down block layered in at the same position 0164 intended (after
-- the club-existence check, before the club_subscriptions upsert), and
-- with the payment_mode UPDATE's target table qualified (`as cs` /
-- `cs.club_id` / `cs.payment_mode`) so it never repeats the bare-
-- identifier mistake this function has now hit three times across
-- 0123->0124, 0124->0125, and 0164. No other line changes beyond
-- restoring the two 0164 regressions and this one new qualification: same
-- signature, same RETURNS TABLE shape, same SECURITY DEFINER, same
-- search_path, same service_role-only grants, same canonical advisory-
-- lock acquisition and lock order, same Checkout fan-out guard (calling
-- the existing, unmodified _invalidate_or_flag_open_checkout_attempt),
-- same genuine-downgrade detection, same tier/entitlement upsert-and-
-- revoke logic, same Member-invite revoke semantics, same returned
-- result shape. No Checkout-opening/supersede function, activation
-- function, refund/dispute/ledger logic, or pricing/UI file is touched
-- by this migration.
--
-- 0164 itself is NOT modified — this is a targeted CREATE OR REPLACE of
-- exactly this one function, applied on top of the already-live 0164.
--
-- Apply in Supabase SQL Editor (cloud only). NOT YET APPLIED.

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- set_club_tier_for_operator — restores the 0124/0125 fixes 0164
-- regressed, plus the intended 0164 commercial-safety additions, plus a
-- preemptive qualification fix on the new payment_mode UPDATE
-- ═══════════════════════════════════════════════════════════════════════════
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
  -- Phase 34G-A2: downgrade-safe commercial lock/fan-out.
  v_current_tier                  text;
  v_payment_id_for_checkout_guard uuid;
begin
  if p_tier not in ('staff_managed', 'connected') then
    raise exception 'invalid_tier';
  end if;

  select exists(select 1 from public.clubs where id = p_club_id) into v_club_exists;
  if not v_club_exists then
    raise exception 'club_not_found';
  end if;

  -- Phase 34G-A2 — canonical commercial lock (see 0164's own header
  -- section for the full lock-order proof; unchanged by this migration).
  perform pg_advisory_xact_lock(hashtextextended('club_commercial_tier:' || p_club_id::text, 0));

  select cs.tier into v_current_tier
    from public.club_subscriptions cs
   where cs.club_id = p_club_id;

  -- Phase 34G-A2 — Connected -> Staff-Managed downgrade fan-out guard.
  -- Only runs for a genuine downgrade — see 0164's own header comment
  -- for the full reasoning (unchanged by this migration).
  if p_tier = 'staff_managed' and v_current_tier is distinct from 'staff_managed' then
    for v_payment_id_for_checkout_guard in
      select distinct p.id
        from public.payments p
        join public.payment_checkout_attempts a
          on a.payment_id = p.id
         and a.club_id    = p_club_id
         and a.status     = 'open'
       where p.club_id = p_club_id
    loop
      perform public._invalidate_or_flag_open_checkout_attempt(v_payment_id_for_checkout_guard);
    end loop;

    -- The club can no longer be commercially configured as actively
    -- offering Member online payments once Connected is lost. Only ever
    -- touches the LIVE club_settings row — no historical payments/
    -- payment_events row is mutated by this statement.
    --
    -- Runtime QA fix (0165): cs.club_id/cs.payment_mode — the bare
    -- `club_id` here collided with this function's own RETURNS TABLE
    -- output variable of the identical name (42702, column reference is
    -- ambiguous) — the same collision class 0124/0125 already fixed
    -- twice elsewhere in this function. Qualified with an explicit alias
    -- so no PL/pgSQL output-variable collision is possible.
    update public.club_settings as cs
       set payment_mode = 'manual',
           updated_at = now()
     where cs.club_id = p_club_id
       and cs.payment_mode = 'court_time_payments';
  end if;

  -- Phase 33F3C (0125) — named-constraint ON CONFLICT target, restored.
  -- `on conflict (club_id)` (0122/0123/0124's form, and 0164's mistaken
  -- reintroduction of it) resolves its column-name conflict target
  -- against this function's own RETURNS TABLE output-variable scope —
  -- unlike an INSERT column-list or an UPDATE SET target, a conflict
  -- target is not immune to that collision. A constraint name occupies a
  -- separate namespace from PL/pgSQL variables, so it can never collide.
  -- club_subscriptions_club_id_key is 0122's own unnamed `unique
  -- (club_id)` table constraint under Postgres's standard auto-naming.
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

    -- Phase 33F3B (0123): revoke every outstanding Member-role invitation
    -- for this club — never Admin/Pro invites, never an already-accepted
    -- or already-revoked invite of any role (the WHERE clause naturally
    -- excludes both by only matching rows still eligible to be
    -- accepted). Phase 33F3C (0124): aliased as `ci` and fully
    -- qualified — the previously unqualified `club_id` collided with
    -- this function's own RETURNS TABLE output variable of the same
    -- name. 0164 (applied, wrongly built from 0122) dropped this entire
    -- block; restored here verbatim from 0125's true authoritative body.
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
-- Rollback procedure (documentation only — no rollback migration created)
-- ═══════════════════════════════════════════════════════════════════════════
-- Mechanically, rolling back 0165 restores set_club_tier_for_operator to
-- its exact currently-applied 0164 body — the state immediately before
-- this migration. IMPORTANT: that rollback target is the KNOWN-REGRESSED
-- state — it still lacks the 0123/0124 Member-invite revoke block, still
-- uses the 0122/0125-superseded `on conflict (club_id)` form (ambiguous
-- against this function's own RETURNS TABLE scope), and still raises
-- 42702 on a genuine downgrade via the unqualified club_settings UPDATE.
-- Rolling back is therefore restoring a function known to regress prior,
-- already-shipped fixes and to fail at runtime — not a neutral or safe
-- default. Do so only if 0165 itself is found to be unsafe, and prefer a
-- forward fix (a new migration) over this rollback whenever possible.
--
-- begin;
--
-- create or replace function public.set_club_tier_for_operator(
--   p_club_id uuid,
--   p_tier    text
-- )
-- returns table (
--   club_id uuid,
--   tier    text,
--   status  text
-- )
-- language plpgsql
-- security definer
-- set search_path = public, pg_temp
-- as $$
-- declare
--   v_club_exists        boolean;
--   v_active_entitlement public.club_entitlements%rowtype;
--   v_entitlement_found  boolean;
--   -- Phase 34G-A2: downgrade-safe commercial lock/fan-out.
--   v_current_tier                  text;
--   v_payment_id_for_checkout_guard uuid;
-- begin
--   if p_tier not in ('staff_managed', 'connected') then
--     raise exception 'invalid_tier';
--   end if;
--
--   select exists(select 1 from public.clubs where id = p_club_id) into v_club_exists;
--   if not v_club_exists then
--     raise exception 'club_not_found';
--   end if;
--
--   -- Phase 34G-A2 — canonical commercial lock (see this migration's own
--   -- header section immediately above for the full lock-order proof).
--   perform pg_advisory_xact_lock(hashtextextended('club_commercial_tier:' || p_club_id::text, 0));
--
--   select cs.tier into v_current_tier
--     from public.club_subscriptions cs
--    where cs.club_id = p_club_id;
--
--   -- Phase 34G-A2 — Connected -> Staff-Managed downgrade fan-out guard.
--   -- Only runs for a genuine downgrade — see this function's own header
--   -- comment above for the full reasoning.
--   if p_tier = 'staff_managed' and v_current_tier is distinct from 'staff_managed' then
--     for v_payment_id_for_checkout_guard in
--       select distinct p.id
--         from public.payments p
--         join public.payment_checkout_attempts a
--           on a.payment_id = p.id
--          and a.club_id    = p_club_id
--          and a.status     = 'open'
--        where p.club_id = p_club_id
--     loop
--       perform public._invalidate_or_flag_open_checkout_attempt(v_payment_id_for_checkout_guard);
--     end loop;
--
--     -- The club can no longer be commercially configured as actively
--     -- offering Member online payments once Connected is lost. Only ever
--     -- touches the LIVE club_settings row — no historical payments/
--     -- payment_events row is mutated by this statement.
--     update public.club_settings
--        set payment_mode = 'manual', updated_at = now()
--      where club_id = p_club_id
--        and payment_mode = 'court_time_payments';
--   end if;
--
--   insert into public.club_subscriptions (club_id, tier, status, source)
--   values (p_club_id, p_tier, 'active', 'manual_pilot')
--   on conflict (club_id) do update
--     set tier       = excluded.tier,
--         status     = excluded.status,
--         source     = excluded.source,
--         updated_at = now();
--
--   select ce.* into v_active_entitlement
--     from public.club_entitlements ce
--    where ce.club_id     = p_club_id
--      and ce.capability  = 'member_self_service'
--      and ce.revoked_at is null;
--   v_entitlement_found := found;
--
--   if p_tier = 'connected' then
--     if not v_entitlement_found or not v_active_entitlement.enabled then
--       if v_entitlement_found then
--         update public.club_entitlements
--            set revoked_at = now()
--          where id = v_active_entitlement.id;
--       end if;
--
--       insert into public.club_entitlements (club_id, capability, enabled, granted_by, note)
--       values (
--         p_club_id, 'member_self_service', true, null,
--         'Granted via set_club_tier_for_operator (manual_pilot).'
--       );
--     end if;
--   else
--     -- staff_managed: revoke the active grant if one exists. Never inserts
--     -- a "disabled" row — absence of an active row already means false
--     -- (club_has_capability's own fail-closed default), so there is
--     -- nothing to represent beyond the revocation itself.
--     if v_entitlement_found and v_active_entitlement.enabled then
--       update public.club_entitlements
--          set revoked_at = now()
--        where id = v_active_entitlement.id;
--     end if;
--   end if;
--
--   return query
--     select cs.club_id, cs.tier, cs.status
--     from public.club_subscriptions cs
--     where cs.club_id = p_club_id;
-- end;
-- $$;
--
-- revoke execute on function public.set_club_tier_for_operator(uuid, text) from public, anon, authenticated;
-- grant  execute on function public.set_club_tier_for_operator(uuid, text) to service_role;
--
-- commit;
