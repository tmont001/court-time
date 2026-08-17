-- 0122_entitlement_foundation.sql
-- Phase 33F3A: Entitlement Foundation — commercial tier scaffolding.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
-- Locked commercial model (33F1-33F3): Tier 1 Staff-Managed (complete
-- staff-operated club, no Member accounts required), Tier 2 Connected
-- (Staff-Managed + Member self-service). This migration adds ONLY the
-- foundation: two tables and two helper functions. It enforces NOTHING —
-- no RLS policy is modified, no self-service RPC is gated, no route
-- changes, no invitation changes. That is 33F3B. Applying this migration
-- must not change any current behavior for any existing club.
--
-- club_subscriptions = commercial state (what the club has purchased/been
-- assigned). club_entitlements = current runtime enforcement state (what
-- the app actually checks). Business logic reads ONLY club_entitlements —
-- never club_subscriptions, and never Stripe — Stripe (future) writes
-- club_subscriptions; a corresponding club_entitlements write is a
-- separate, explicit step (manual today via the pilot script below,
-- automated later). This keeps runtime authorization Stripe-ignorant by
-- construction.
--
-- BACKWARD-COMPATIBLE ROLLOUT (critical invariant): every club that exists
-- when this migration is applied currently behaves as Connected — there is
-- no prior tier concept, so "currently behaves as Connected" is simply
-- "full Member self-service already works today." This migration backfills
-- every existing club to tier='connected', source='backfill', with
-- member_self_service=true, so applying it changes no observable behavior.
-- Genuinely missing/unconfigured entitlement state (a club with no rows —
-- should never happen after this migration's backfill, but is the correct
-- posture for any future edge case) fails closed to false — Staff-Managed
-- posture — via club_has_capability's own coalesce default, never Connected.
--
-- CAPABILITY HELPER SECURITY: club_has_capability(p_club_id, p_capability)
-- is internal-only — SECURITY DEFINER, revoked from public/anon/
-- authenticated entirely. It accepts an arbitrary club_id, which is exactly
-- why it must never be directly callable by an authenticated session (that
-- would let any Member probe any OTHER club's entitlement state).
-- current_club_has_capability(p_capability) is the only client-reachable
-- entry point — it derives club_id internally via current_user_club_id(),
-- so a caller can only ever ask about their own active club, never an
-- arbitrary one. Both fail closed (coalesce(...,false)) for any missing/
-- revoked/unrecognized state.
--
-- SCOPE — additive only:
--   1. club_subscriptions (commercial record) — explicit REVOKE ALL from
--      public/anon/authenticated, defense in depth on top of RLS-with-
--      zero-policies.
--   2. club_entitlements (enforcement record) — same explicit REVOKE ALL;
--      granted_by references profiles(id) ON DELETE SET NULL, so history
--      survives a profile being removed later.
--   3. club_has_capability (internal)
--   4. current_club_has_capability (authenticated-callable)
--   5. set_club_tier_for_operator (service_role-only) — the single
--      atomic write path for a manual tier transition: one function body,
--      one transaction, updates club_subscriptions and reconciles
--      club_entitlements together or not at all.
--   6. Backfill: every existing club -> connected / member_self_service=true
--   7. Focused self-validation (row-count parity check, not a standalone
--      preflight/verifier script)
--
-- No RLS policy on any OTHER existing table is touched. No existing RPC is
-- modified. No route/frontend code is touched by this migration (frontend
-- changes in this checkpoint are limited to the new, non-route pilot
-- provisioning script under scripts/, which is never reachable over HTTP).
--
-- Not applied by this checkpoint. Not committed. Does not modify 0107-0121.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. club_subscriptions — commercial state. One row per club (unique
-- club_id) — a club has exactly one current commercial record, matching
-- the simplified (non-scheduled-transition) shape from the 33F3 design
-- correction: no pending_tier/pending_tier_effective_at — a downgrade is a
-- direct, manually-performed tier update (33F3B), not an automated
-- period-end engine. RLS enabled, zero policies — deny-all direct client
-- access, matching club_memberships' own established pattern; every read/
-- write goes through a SECURITY DEFINER function.
-- ═══════════════════════════════════════════════════════════════════════════
create table public.club_subscriptions (
  id                      uuid        primary key default gen_random_uuid(),
  club_id                 uuid        not null references public.clubs(id) on delete cascade,
  tier                    text        not null check (tier in ('staff_managed', 'connected')),
  status                  text        not null default 'active'
                                        check (status in ('active', 'trialing', 'past_due', 'canceled')),
  billing_period          text        check (billing_period in ('monthly', 'annual')),
  current_period_end      timestamptz,
  stripe_customer_id      text,
  stripe_subscription_id  text,
  source                  text        not null check (source in ('backfill', 'manual_pilot', 'manual_admin', 'stripe')),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (club_id)
);

alter table public.club_subscriptions enable row level security;
-- No policies: deny-all direct client access by design. Defense in depth
-- on top of that: explicit privilege revocation, so an ordinary browser
-- session has no table-level grant to fall back on even if a policy were
-- ever added carelessly later. service_role is untouched by this revoke —
-- it is the only intended direct-table caller, and only via the
-- SECURITY DEFINER operator function below, never ad hoc.
revoke all on public.club_subscriptions from public, anon, authenticated;

create trigger club_subscriptions_updated_at
  before update on public.club_subscriptions
  for each row execute function trigger_set_updated_at();


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. club_entitlements — runtime enforcement state. Row-per-grant (not a
-- single mutable flag) so history is preserved: a downgrade sets
-- revoked_at on the existing row rather than deleting or silently flipping
-- it, giving a durable audit trail of when a capability was granted and
-- when it stopped applying. The partial unique index enforces at most one
-- ACTIVE (non-revoked) grant per (club_id, capability) at a time, while
-- allowing a full history of past grants/revocations to accumulate.
-- capability is deliberately constrained to the single launch value —
-- widening this CHECK is the only schema change a future finer-grained
-- capability would need.
-- ═══════════════════════════════════════════════════════════════════════════
create table public.club_entitlements (
  id           uuid        primary key default gen_random_uuid(),
  club_id      uuid        not null references public.clubs(id) on delete cascade,
  capability   text        not null check (capability in ('member_self_service')),
  enabled      boolean     not null default false,
  granted_by   uuid        references public.profiles(id) on delete set null,
  granted_at   timestamptz not null default now(),
  revoked_at   timestamptz,
  note         text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create unique index club_entitlements_active_uniq
  on public.club_entitlements (club_id, capability)
  where revoked_at is null;

alter table public.club_entitlements enable row level security;
-- No policies: deny-all direct client access by design. Same defense-in-
-- depth revoke as club_subscriptions above.
revoke all on public.club_entitlements from public, anon, authenticated;

create trigger club_entitlements_updated_at
  before update on public.club_entitlements
  for each row execute function trigger_set_updated_at();


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. club_has_capability — INTERNAL ONLY. Accepts an arbitrary club_id, so
-- it must never be callable by an authenticated session directly (that
-- would let any Member probe any other club's commercial state). Callable
-- only from within other SECURITY DEFINER functions (which execute with
-- their owner's privileges, not the original caller's — the same
-- established pattern already used throughout this project for every
-- other internal-only helper, e.g. _lesson_check_member_availability,
-- _advance_program_waitlist_offer). Fail-closed: no matching active,
-- enabled row -> false. No exception path — an unrecognized capability
-- string or missing row are both just "not granted," never an error.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.club_has_capability(
  p_club_id    uuid,
  p_capability text
)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select coalesce(
    (select enabled
       from public.club_entitlements
      where club_id     = p_club_id
        and capability  = p_capability
        and revoked_at is null),
    false
  );
$$;

revoke execute on function public.club_has_capability(uuid, text) from public, anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. current_club_has_capability — the ONLY client-reachable entitlement
-- entry point. Derives club_id internally via current_user_club_id() —
-- the caller supplies no club_id at all, so there is no arbitrary-club
-- query surface regardless of caller role. Same fail-closed behavior as
-- club_has_capability (a caller with no resolvable active club gets
-- false, not an error — matches this function's read-only, non-
-- authoritative nature; callers needing a hard auth failure already get
-- one from current_user_club_id() itself inside whatever RPC calls this).
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.current_club_has_capability(
  p_capability text
)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select coalesce(public.club_has_capability(public.current_user_club_id(), p_capability), false);
$$;

revoke execute on function public.current_club_has_capability(text) from public, anon;
grant  execute on function public.current_club_has_capability(text) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 5. set_club_tier_for_operator — the ONLY write path for a manual tier
-- transition. Wraps the club_subscriptions upsert and the club_entitlements
-- reconciliation in a single function body, so both succeed or both roll
-- back together — no window where commercial state and enforcement state
-- can disagree because a second network request failed after the first
-- succeeded. Callable ONLY by service_role — revoked from public/anon/
-- authenticated entirely, matching club_has_capability's own "arbitrary
-- club_id argument -> never client-reachable" reasoning, but stricter:
-- even an authenticated session must never be able to change ITS OWN
-- club's commercial tier by calling this directly. There is no
-- platform-admin role or in-app caller of this function at all — the only
-- caller is scripts/grant-club-entitlement.mjs, using the service-role key.
--
-- Entitlement history is preserved exactly as club_entitlements' own
-- row-per-grant design requires: an existing active grant is REVOKED
-- (revoked_at set), never UPDATEd in place or deleted, before a fresh
-- grant row is inserted. v_entitlement_found captures FOUND immediately
-- after the single SELECT that produces it and is never relied on again
-- after any later statement — the same FOUND-lifetime discipline this
-- project has required since Phase 33D2a/0114's own hotfix.
--
-- No invitation behavior here — bulk-revoking outstanding Member invites
-- on a staff_managed transition is 33F3B enforcement, explicitly deferred.
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
  end if;

  return query
    select cs.club_id, cs.tier, cs.status
    from public.club_subscriptions cs
    where cs.club_id = p_club_id;
end;
$$;

revoke execute on function public.set_club_tier_for_operator(uuid, text) from public, anon, authenticated;
grant  execute on function public.set_club_tier_for_operator(uuid, text) to service_role;


-- ═══════════════════════════════════════════════════════════════════════════
-- 6. Backfill — every club that exists right now is grandfathered to
-- Connected with member_self_service enabled, preserving current behavior
-- exactly (there was no tier concept before this migration; every club's
-- Members already have full self-service today). source='backfill'
-- (never 'manual_pilot') distinguishes this one-time migration-time grant
-- from any later manually-assigned pilot tier.
-- ═══════════════════════════════════════════════════════════════════════════
insert into public.club_subscriptions (club_id, tier, status, source)
select c.id, 'connected', 'active', 'backfill'
from public.clubs c
on conflict (club_id) do nothing;

insert into public.club_entitlements (club_id, capability, enabled, granted_by, note)
select c.id, 'member_self_service', true, null,
       'Backfilled at 0122 — existing club grandfathered to Connected; no prior tier concept existed.'
from public.clubs c
on conflict (club_id, capability) where revoked_at is null do nothing;


-- ═══════════════════════════════════════════════════════════════════════════
-- 7. Focused self-validation — not a standalone preflight/verifier script;
-- a fail-closed guard inside this same migration, proving the backfill
-- covered every club before the transaction is allowed to commit.
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_club_count           int;
  v_subscription_count   int;
  v_entitlement_count    int;
  v_missing_subscription int;
  v_missing_entitlement  int;
begin
  select count(*) into v_club_count from public.clubs;

  select count(*) into v_subscription_count
    from public.club_subscriptions
   where source = 'backfill' and tier = 'connected' and status = 'active';

  select count(*) into v_entitlement_count
    from public.club_entitlements
   where capability = 'member_self_service' and enabled = true and revoked_at is null;

  select count(*) into v_missing_subscription
    from public.clubs c
    where not exists (
      select 1 from public.club_subscriptions cs where cs.club_id = c.id
    );

  select count(*) into v_missing_entitlement
    from public.clubs c
    where not exists (
      select 1 from public.club_entitlements ce
       where ce.club_id = c.id and ce.capability = 'member_self_service' and ce.revoked_at is null
    );

  if v_missing_subscription > 0 then
    raise exception 'entitlement_backfill_incomplete: % club(s) have no club_subscriptions row after backfill', v_missing_subscription;
  end if;

  if v_missing_entitlement > 0 then
    raise exception 'entitlement_backfill_incomplete: % club(s) have no active member_self_service row after backfill', v_missing_entitlement;
  end if;

  if v_subscription_count < v_club_count then
    raise exception 'entitlement_backfill_incomplete: % clubs but only % backfilled connected/active subscriptions', v_club_count, v_subscription_count;
  end if;

  if v_entitlement_count < v_club_count then
    raise exception 'entitlement_backfill_incomplete: % clubs but only % enabled member_self_service entitlements', v_club_count, v_entitlement_count;
  end if;
end $$;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration created in
-- this checkpoint)
-- ═══════════════════════════════════════════════════════════════════════════
-- `drop table if exists public.club_entitlements;`
-- `drop table if exists public.club_subscriptions;`
-- `drop function if exists public.set_club_tier_for_operator(uuid, text);`
-- `drop function if exists public.current_club_has_capability(text);`
-- `drop function if exists public.club_has_capability(uuid, text);`
-- No other object depends on any of these five — safe to drop in this
-- order (entitlements/subscriptions have no incoming FKs from elsewhere;
-- none of the three functions is yet called by any other function or by
-- any in-app code path, since 33F3B enforcement has not been implemented —
-- set_club_tier_for_operator's only caller is the external pilot script).
