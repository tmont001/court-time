-- 0149_court_time_payments_activation_gate.sql
-- Phase 34D-C — Court Time Payments activation gate.
--
-- Scope: activation/readiness logic only. No money movement — no
-- PaymentIntent, no Checkout, no Stripe charge, no application fee, no
-- refunds/disputes, no Member Pay Now UI, no reservation payment
-- processing. Does not modify 0143-0148 (already applied) — everything
-- here is either a brand-new object or a CREATE OR REPLACE of an existing
-- function, per this project's established forward-only migration
-- convention (e.g. 0145/0146 redefining 0143/0069 functions).
--
-- Replaces the previously unconditional court_time_payments lock with a
-- real, environment-aware readiness check: a club may activate
-- court_time_payments if and only if its club_stripe_accounts row for the
-- CURRENT Stripe environment (livemode) has card_payments_status =
-- 'active'. club_stripe_accounts (0147) already anticipated this exact
-- gate in its own comments ("card_payments_status ... is the only value a
-- later checkpoint's payment_mode activation gate may ever treat as
-- ready").
--
-- ── Why a new dedicated service-role-only RPC, not a widened
--    update_club_payment_mode ──────────────────────────────────────────
-- "Current Stripe environment" (livemode) is derived server-side from
-- which STRIPE_SECRET_KEY is configured (src/lib/stripe/connectConfig.ts's
-- deriveLivemode(), read via getStripeContext()) — an application-layer
-- fact Postgres cannot independently know. It must be threaded in as a
-- parameter from trusted server code. update_club_payment_mode (0143) is
-- granted directly to `authenticated` — any admin's browser session can
-- call it via the Supabase client without going through Court Time's own
-- Server Action. Adding a livemode parameter to that function would let a
-- caller supply their own livemode value directly, which is exactly what
-- "no client-controlled value may be trusted to bypass the readiness
-- gate" rules out. Activation therefore goes through a NEW, separate,
-- service-role-only RPC (activate_court_time_payments) — matching every
-- other livemode-sensitive operation already in this codebase
-- (get_club_stripe_connect_status, get_club_stripe_account_ref,
-- upsert_club_stripe_account, process_stripe_connect_account_event, all
-- 0147/0148) — reachable ONLY through a Next.js Server Action that
-- independently authenticates the caller as Admin via the normal SSR
-- client and derives livemode via getStripeContext() itself, then calls
-- through the privileged/service-role Supabase client. No authenticated
-- browser session can call this RPC directly at all, regardless of what
-- livemode it would want to claim.
--
-- update_club_payment_mode (0143) itself is UNCHANGED by this migration —
-- not redefined, not touched — it remains the none/manual (downgrade)
-- path exactly as it works today, and continues to unconditionally
-- reject a direct 'court_time_payments' argument, so there is no path to
-- activation other than the new gated RPC below.
--
-- Apply in Supabase SQL Editor (cloud only).

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. activate_court_time_payments — the ONLY path to court_time_payments
-- ═══════════════════════════════════════════════════════════════════════════
-- service_role only. Checks club_stripe_accounts for a row matching BOTH
-- p_club_id and p_livemode with card_payments_status = 'active' — not
-- "any active row for this club" (that would blur test/live isolation).
-- Fails closed with a stable, UI-mappable error when not ready. On
-- success, updates club_settings exactly like update_club_payment_mode's
-- own none/manual path does (same audit_log action name, so an audit
-- query over 'update_club_payment_mode' sees every payment_mode change
-- uniformly regardless of which function performed it).
create or replace function public.activate_court_time_payments(
  p_club_id  uuid,
  p_livemode boolean,
  p_actor_id uuid
)
returns public.club_settings
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_ready  boolean;
  v_result public.club_settings%rowtype;
begin
  if p_club_id is null or p_livemode is null or p_actor_id is null then
    raise exception 'invalid_arguments';
  end if;

  select exists (
    select 1 from public.club_stripe_accounts
     where club_id = p_club_id
       and livemode = p_livemode
       and card_payments_status = 'active'
  ) into v_ready;

  if not v_ready then
    raise exception 'stripe_connect_not_ready';
  end if;

  update public.club_settings
     set payment_mode = 'court_time_payments',
         updated_at   = now()
   where club_id = p_club_id
  returning * into v_result;

  if not found then
    raise exception 'club_not_found';
  end if;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    p_club_id, p_actor_id, 'update_club_payment_mode', 'club_settings', p_club_id,
    jsonb_build_object('payment_mode', 'court_time_payments', 'livemode', p_livemode)
  );

  return v_result;
end;
$$;

revoke execute on function public.activate_court_time_payments(uuid, boolean, uuid) from public, anon, authenticated;
grant  execute on function public.activate_court_time_payments(uuid, boolean, uuid) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. _create_payment_obligation — widened to also act under
--    court_time_payments (still zero money movement)
-- ═══════════════════════════════════════════════════════════════════════════
-- Exact live production body from 0143, unchanged in every respect except
-- two additions below: the widened mode gate, and an event_guest carve-out
-- for court_time_payments. This only makes the function willing to create
-- the SAME internal payments/payment_events rows it already creates for
-- 'manual' — no PaymentIntent, no Checkout, no Stripe charge, no
-- application fee is created anywhere in this function or anywhere else
-- in this migration. payment_mode_at_creation's own CHECK constraint
-- (0143) already allowed 'court_time_payments' as a stored value — this
-- is the first migration that lets that value actually get written by
-- something other than a hypothetical future caller.
--
-- Event Guest online payer identity is unresolved and stays out of scope:
-- court_time_payments never creates an obligation for domain_type =
-- 'event_guest' (manual mode still does, unchanged). Every call site
-- invokes this function via `perform` (0144), discarding the return
-- value, so the existing return-null no-op convention (already used for
-- the amount<=0 guard) is the correct, minimal way to express the
-- exclusion — no new exception type is needed.
create or replace function public._create_payment_obligation(
  p_club_id          uuid,
  p_domain_type      text,
  p_domain_id        uuid,
  p_roster_member_id uuid,
  p_amount_cents     integer,
  p_actor_id         uuid,
  p_new_cycle        boolean default false
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_mode        text;
  v_currency    text;
  v_next_cycle  integer;
  v_payment_id  uuid;
  v_existing    public.payments%rowtype;
  v_needs_new_cycle boolean;
begin
  if p_amount_cents is null or p_amount_cents <= 0 then
    return null;
  end if;

  select payment_mode, currency into v_mode, v_currency
    from public.club_settings
   where club_id = p_club_id;

  -- IS DISTINCT FROM (not NOT IN) preserves the original fail-closed
  -- behavior for a null/unrecognized v_mode: `null not in (...)` evaluates
  -- to NULL, which would fall through the `if` as false and let execution
  -- proceed — IS DISTINCT FROM treats NULL as genuinely distinct from
  -- every listed value, so an unrecognized mode still returns null here.
  if v_mode is distinct from 'manual'
     and v_mode is distinct from 'court_time_payments' then
    return null;
  end if;

  -- Phase 34D-C: Event Guest online payer identity is unresolved and
  -- remains deliberately out of scope for court_time_payments until a
  -- future checkpoint designs it — only manual mode may create an
  -- obligation for an event_guest domain. Every caller invokes this
  -- function via `perform` (0144), discarding the return value entirely,
  -- so returning null here is a safe no-op, identical in shape to the
  -- amount<=0 guard above.
  if v_mode = 'court_time_payments' and p_domain_type = 'event_guest' then
    return null;
  end if;

  if p_domain_type = 'event_guest' then
    if p_roster_member_id is not null then
      raise exception 'event_guest_must_not_have_roster_member_id';
    end if;
  else
    if p_roster_member_id is null then
      raise exception 'roster_member_id_required';
    end if;
    if not exists (
      select 1 from public.roster_members
       where id = p_roster_member_id and club_id = p_club_id
    ) then
      raise exception 'cross_club_roster_member_not_allowed';
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_domain_type || ':' || p_domain_id::text, 0));

  if p_new_cycle then
    v_needs_new_cycle := true;
  else
    select * into v_existing
      from public.payments
     where club_id = p_club_id
       and domain_type = p_domain_type
       and domain_id = p_domain_id
     order by obligation_cycle desc
     limit 1;

    if found and v_existing.roster_member_id is not distinct from p_roster_member_id then
      return v_existing.id;
    end if;

    -- found=true here means a latest payment exists but belongs to a
    -- different roster identity — a fresh cycle is needed, same as the
    -- explicit p_new_cycle=true path. found=false means genuinely no
    -- payment exists yet — a fresh cycle 1, handled below.
    v_needs_new_cycle := found;
  end if;

  if v_needs_new_cycle then
    select coalesce(max(obligation_cycle), 0) + 1 into v_next_cycle
      from public.payments
     where club_id = p_club_id
       and domain_type = p_domain_type
       and domain_id = p_domain_id;
  else
    v_next_cycle := 1;
  end if;

  insert into public.payments (
    club_id, domain_type, domain_id, obligation_cycle, roster_member_id,
    amount_due_cents, amount_paid_cents, currency, status,
    payment_mode_at_creation, created_by
  ) values (
    p_club_id, p_domain_type, p_domain_id, v_next_cycle, p_roster_member_id,
    0, 0, v_currency, 'unpaid',
    v_mode, p_actor_id
  ) returning id into v_payment_id;

  insert into public.payment_events (payment_id, club_id, event_type, amount_cents, actor_id)
  values (v_payment_id, p_club_id, 'obligation_created', p_amount_cents, p_actor_id);

  return v_payment_id;
end;
$$;

revoke all on function public._create_payment_obligation(uuid, text, uuid, uuid, integer, uuid, boolean) from public;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback (manual, cloud SQL Editor)
-- ═══════════════════════════════════════════════════════════════════════════
-- drop function if exists public.activate_court_time_payments(uuid, boolean, uuid);
-- Restore _create_payment_obligation to its pre-0149 (0143) body via
-- CREATE OR REPLACE — same signature, only the mode gate line reverts to:
--   if v_mode is distinct from 'manual' then return null; end if;
-- (see 0143_payment_mode_and_ledger_foundation.sql, section 7, for the
-- exact pre-0149 body to re-run verbatim).
