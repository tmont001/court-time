-- 0148_stripe_connect_lifecycle_events.sql
-- Phase 34D-B — Stripe Connect account lifecycle/readiness synchronization.
--
-- Scope: ONLY technical webhook-delivery idempotency + the one atomic RPC
-- that syncs club_stripe_accounts.card_payments_status/last_synced_at from
-- a verified Stripe Connect account lifecycle event. No money movement, no
-- payment_mode widening, no PaymentIntent/Checkout — none of that exists
-- yet. This migration does not touch club_stripe_accounts' shape (0147,
-- untouched) beyond writing to its two existing readiness columns through
-- the new RPC below.
--
-- stripe_event_receipts is deliberately NOT payment_events: payment_events
-- (0143) is Court Time's domain financial ledger (money actually moved,
-- who recorded it, what method) — this table is technical webhook-
-- delivery infrastructure (which Stripe event IDs we have already
-- processed, so a retried delivery is a clean no-op). Conflating the two
-- would put non-financial webhook plumbing inside the financial ledger's
-- audit trail. No full Stripe payload is stored here, no secrets, nothing
-- beyond what's needed to (a) deduplicate a retried delivery and (b) know
-- which account/mode/event-type it was for.
--
-- Pre-apply correction: a first-delivery event for an account/mode with no
-- matching club_stripe_accounts row must be RETRYABLE, never a permanently
-- recorded no-op — see the RPC's own comment below for why and how.
--
-- Apply in Supabase SQL Editor (cloud only).

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. stripe_event_receipts — durable webhook-delivery idempotency record
-- ═══════════════════════════════════════════════════════════════════════════
-- One row per Stripe event ID that has been SUCCESSFULLY processed — i.e.
-- one that matched a known (stripe_account_id, livemode) row and actually
-- updated it. An event that never matched a known account never gets a
-- durable row here at all (see the RPC's own comment) — stripe_event_id
-- is the primary key: Stripe's own globally unique identifier for the
-- event, which is what a retried delivery repeats verbatim.
create table public.stripe_event_receipts (
  stripe_event_id    text        primary key,
  event_type         text        not null,
  livemode           boolean     not null,
  -- NOT NULL: every row here corresponds to a real, matched
  -- club_stripe_accounts update (see the RPC below) — an event that never
  -- matched a known account never reaches this table at all, so there is
  -- no case where the account id is unknown/absent for a persisted row.
  stripe_account_id  text        not null,
  processed_at       timestamptz not null default now(),
  created_at         timestamptz not null default now()
);

alter table public.stripe_event_receipts enable row level security;
-- No policies: deny-all direct client access by design, identical to
-- club_stripe_accounts (0147). Defense in depth: explicit privilege
-- revocation so an ordinary authenticated session has no table-level
-- grant to fall back on. service_role is untouched by this revoke — see
-- section 2's service-role-only RPC, the only intended direct-table
-- caller (via the webhook Route Handler's privileged Supabase client).
revoke all on public.stripe_event_receipts from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. process_stripe_connect_account_event — the one atomic lifecycle RPC
-- ═══════════════════════════════════════════════════════════════════════════
-- service_role only — never callable from an authenticated browser
-- session, matching 0147's exact established pattern. The webhook Route
-- Handler independently verifies the Stripe webhook signature and
-- retrieves the current Accounts v2 state itself BEFORE ever calling this
-- — every parameter here is already server-verified by the time it
-- arrives. Defense in depth beyond that trust boundary: p_event_type and
-- p_card_payments_status are still explicitly validated against their
-- exact closed sets below and fail closed on anything else.
--
-- Idempotency for a genuine duplicate delivery: a stripe_event_receipts
-- row only ever exists for an event that was already fully, successfully
-- processed (see below — an unmatched event never gets a row at all), so
-- finding one on INSERT ... ON CONFLICT DO NOTHING is proof by
-- construction that the earlier delivery already matched a known account
-- and already applied the status update. The duplicate is therefore a
-- clean no-op — no second UPDATE, no other side effect, and it stays a
-- 2xx (via the caller returning already_processed=true rather than an
-- error).
--
-- Unknown-account / livemode-mismatch handling (the pre-apply
-- correction): if no club_stripe_accounts row matches BOTH
-- stripe_account_id AND livemode — including the case where Stripe has
-- created the account but Court Time's own row from 34D-A's onboarding
-- flow hasn't committed yet, a real possible race — this must be
-- RETRYABLE, not silently and permanently dropped. The whole function
-- runs as one implicit transaction per call: raising an exception AFTER
-- the INSERT rolls back that INSERT too, so the event receipt is never
-- left committed for an event that didn't actually update anything. The
-- Route Handler surfaces the resulting RPC error as a 500, and Stripe's
-- own automatic webhook retry redelivers the event later — once the
-- account mapping exists, that retry's INSERT succeeds fresh (no
-- conflicting receipt from the failed attempt exists), and the UPDATE
-- then matches normally. This never creates a new club_stripe_accounts
-- row and never attaches the event to a different account/mode — it only
-- ever updates the row that already matches both fields, or raises.
create or replace function public.process_stripe_connect_account_event(
  p_stripe_event_id      text,
  p_event_type           text,
  p_livemode             boolean,
  p_stripe_account_id    text,
  p_card_payments_status text
)
returns table (
  already_processed boolean,
  matched            boolean
)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_new_receipt boolean;
begin
  if p_stripe_event_id is null or p_event_type is null or p_livemode is null
     or p_stripe_account_id is null or p_card_payments_status is null then
    raise exception 'invalid_arguments';
  end if;

  if p_event_type not in (
    'v2.core.account[requirements].updated',
    'v2.core.account[configuration.merchant].capability_status_updated'
  ) then
    raise exception 'invalid_event_type';
  end if;

  if p_card_payments_status not in ('active', 'pending', 'restricted', 'unsupported') then
    raise exception 'invalid_card_payments_status';
  end if;

  insert into public.stripe_event_receipts (
    stripe_event_id, event_type, livemode, stripe_account_id, processed_at
  ) values (
    p_stripe_event_id, p_event_type, p_livemode, p_stripe_account_id, now()
  )
  on conflict (stripe_event_id) do nothing;

  v_new_receipt := found;

  if not v_new_receipt then
    -- Proven-by-construction duplicate of an already-successfully-
    -- processed event (see header comment) — no update repeated.
    return query select true, true;
    return;
  end if;

  update public.club_stripe_accounts
     set card_payments_status = p_card_payments_status,
         last_synced_at       = now(),
         updated_at           = now()
   where stripe_account_id = p_stripe_account_id
     and livemode           = p_livemode;

  if not found then
    -- No known Court Time account for this (stripe_account_id, livemode)
    -- yet. Raising here aborts this entire function call's transaction,
    -- rolling back the event receipt INSERT above too — this event is
    -- never left permanently (mis)recorded as handled. See header
    -- comment for the full retry story.
    raise exception 'stripe_account_not_found';
  end if;

  return query select false, true;
end;
$$;

revoke execute on function public.process_stripe_connect_account_event(text, text, boolean, text, text) from public, anon, authenticated;
grant  execute on function public.process_stripe_connect_account_event(text, text, boolean, text, text) to service_role;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback (manual, cloud SQL Editor)
-- ═══════════════════════════════════════════════════════════════════════════
-- drop function if exists public.process_stripe_connect_account_event(text, text, boolean, text, text);
-- drop table if exists public.stripe_event_receipts;
-- 0147's club_stripe_accounts table/columns are unaffected by this
-- migration — nothing there needs restoring.
