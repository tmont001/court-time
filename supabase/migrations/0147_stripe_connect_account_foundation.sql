-- 0147_stripe_connect_account_foundation.sql
-- Phase 34D-A — Stripe Connect account foundation (Accounts v2).
--
-- Scope: ONLY the connected-account/onboarding data model and its narrow
-- read/write RPC surface. No money movement, no payment_mode widening, no
-- webhook/event handling — none of that exists yet. This migration is
-- behaviorally inert for every existing scheduling/payment flow: nothing
-- in 0001-0146 reads or writes club_stripe_accounts, and update_club_
-- payment_mode / _create_payment_obligation (0143) are NOT touched here —
-- 'court_time_payments' remains exactly as locked (UI disabled, RPC
-- rejects it, obligation-creation helper only ever acts on 'manual').
--
-- Root cause of the runtime failure this version corrects: the first
-- applied version of this migration's application code called
-- POST /v1/accounts (stripe.accounts.create). Stripe rejected it —
-- current Stripe direction requires new Connect integrations to create
-- connected accounts via POST /v2/core/accounts instead. This version's
-- schema reflects the Accounts v2 model: a v2 Account's readiness is
-- reported per-capability (configuration.merchant.capabilities.
-- card_payments.status: active/pending/restricted/unsupported) — there is
-- no v1-style charges_enabled/details_submitted pair in Accounts v2, and
-- this schema does not pretend otherwise.
--
-- club_stripe_accounts is entirely separate from club_subscriptions /
-- club_entitlements (0122, Court Time's own SaaS billing relationship
-- with a club) — same "deny-all direct client access, service-role/
-- SECURITY DEFINER only" shape as those tables, by the same established
-- convention, but a distinct financial relationship (a club collecting
-- from its own Members via Stripe Connect, not a club paying Court Time).
--
-- Deliberately NOT stored: bank details, KYC documents, card data, Stripe
-- secrets, OAuth/access tokens, or a duplicated copy of the Stripe Account
-- object. Only what's needed to (a) map (club_id, livemode) -> Stripe
-- account id, (b) represent readiness via the single field Stripe itself
-- treats as authoritative for card payments, and (c) know when that state
-- was last synchronized from Stripe — everything else is fetched live
-- from the Stripe API when needed, never cached here.
--
-- Test/live separation: Court Time's local/Preview/test-mode Stripe
-- onboarding may use the same Supabase database as Production, so a club
-- can legitimately need both a test-mode AND a live-mode connected
-- account over its lifetime. The unique invariant is (club_id, livemode),
-- not club_id alone. livemode is always derived server-side from which
-- STRIPE_SECRET_KEY is configured (src/lib/stripe/server.ts's
-- getStripeContext()), never client-supplied — every RPC below takes it
-- as an explicit parameter precisely so the CALLER (trusted server code)
-- controls it, never an authenticated browser session picking its own
-- value.
--
-- Apply in Supabase SQL Editor (cloud only).

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. club_stripe_accounts — one row per (club, Stripe mode), at most
-- ═══════════════════════════════════════════════════════════════════════════
-- unique(club_id, livemode) is the "one connected account per club per
-- Stripe environment" invariant — a club may have both a test-mode row
-- and a live-mode row simultaneously, but never two of the same mode.
-- unique(stripe_account_id) stays a plain single-column constraint (not
-- composite with livemode): Stripe account ids are already globally
-- unique across all of Stripe regardless of mode, so this is strictly
-- stronger than a composite constraint would be — it makes it
-- structurally impossible for the SAME Stripe account id to ever be
-- attached to two different (club_id, livemode) rows, full stop.
create table public.club_stripe_accounts (
  id                    uuid        primary key default gen_random_uuid(),
  club_id               uuid        not null references public.clubs(id) on delete cascade,

  -- Stripe's v2 "acct_..." identifier. Never exposed to any browser
  -- session — read only by service-role-only RPCs (section 2), used
  -- exclusively to make further Stripe API calls server-side.
  stripe_account_id     text        not null,

  -- Which Stripe environment this row's stripe_account_id belongs to.
  -- Matches Stripe's own Account/Event `livemode` field name and meaning
  -- exactly, so a future webhook handler (34D-B) can compare an incoming
  -- Event's own livemode against this column with no translation. Always
  -- derived server-side from the configured secret key's prefix — never
  -- client-supplied, never guessed.
  livemode              boolean     not null,

  -- Accounts v2's own capability-readiness vocabulary for the single
  -- capability this integration requests (card_payments) — read directly
  -- from account.configuration.merchant.capabilities.card_payments.status.
  -- 'active' is the only value a later checkpoint's payment_mode
  -- activation gate may ever treat as "ready". Defaults to 'pending' —
  -- the honest state between "row created" and "first real Stripe read",
  -- which upsert_club_stripe_account (section 2) always overwrites with
  -- a real value in the same statement that creates the row.
  card_payments_status  text        not null default 'pending'
                          check (card_payments_status in ('active', 'pending', 'restricted', 'unsupported')),

  -- When this row's card_payments_status was last refreshed from a real
  -- Stripe API read (account creation, or a return-from-onboarding sync)
  -- — never bumped merely because some other column changed.
  last_synced_at        timestamptz,

  created_by            uuid        references public.profiles(id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  unique (club_id, livemode),
  unique (stripe_account_id)
);

alter table public.club_stripe_accounts enable row level security;
-- No policies: deny-all direct client access by design, identical to
-- club_subscriptions/club_entitlements (0122). Defense in depth: explicit
-- privilege revocation so an ordinary authenticated session has no
-- table-level grant to fall back on. service_role is untouched by this
-- revoke — see section 2's service-role-only RPCs, the only intended
-- direct-table callers.
revoke all on public.club_stripe_accounts from public, anon, authenticated;

create trigger club_stripe_accounts_updated_at
  before update on public.club_stripe_accounts
  for each row execute function public.trigger_set_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Service-role-only RPCs — the only ways club_stripe_accounts is ever
--    read or written. All three revoked from authenticated/anon/public and
--    granted only to service_role, matching set_club_tier_for_operator
--    (0122)'s exact established pattern: the Next.js Server Action/Server
--    Component independently authenticates the caller as an Admin,
--    resolves their real club_id via the normal SSR client, AND derives
--    livemode from the server's own configured Stripe key (never from any
--    request/browser input) BEFORE ever touching these — these RPCs trust
--    their caller completely because only trusted server code (using
--    src/lib/supabase/privileged.ts's service-role client) can reach them
--    at all; no authenticated browser session has EXECUTE on any of them,
--    which also means no authenticated session can pick its own livemode
--    value merely by calling the RPC directly.
-- ═══════════════════════════════════════════════════════════════════════════

-- Status read for the Admin Settings page — the derived readiness signal
-- for one specific (club, mode), never the raw stripe_account_id. Always
-- returns exactly one row (via the left join against a single dummy row)
-- so "no connected account in this mode yet" is a clean "not connected"
-- result rather than an empty resultset the caller has to special-case.
create or replace function public.get_club_stripe_connect_status(
  p_club_id  uuid,
  p_livemode boolean
)
returns table (
  connected             boolean,
  card_payments_status  text,
  last_synced_at        timestamptz
)
language sql
security definer
stable
set search_path to 'public', 'pg_temp'
as $$
  select
    (csa.club_id is not null)  as connected,
    csa.card_payments_status,
    csa.last_synced_at
  from (select 1) as _one
  left join public.club_stripe_accounts csa
    on csa.club_id = p_club_id and csa.livemode = p_livemode;
$$;

revoke execute on function public.get_club_stripe_connect_status(uuid, boolean) from public, anon, authenticated;
grant  execute on function public.get_club_stripe_connect_status(uuid, boolean) to service_role;

-- Internal lookup used by the onboarding Server Action to decide whether a
-- Stripe account already exists for a (club, mode) before ever calling the
-- Stripe API — the "repeated clicks must not create duplicate accounts"
-- guard's first half (the second half is a deterministic, mode-aware
-- Stripe idempotency key on the accounts.create call itself, since this
-- lookup alone cannot close a true concurrent-request race — see the
-- upsert function's own comment).
create or replace function public.get_club_stripe_account_ref(
  p_club_id  uuid,
  p_livemode boolean
)
returns text
language sql
security definer
stable
set search_path to 'public', 'pg_temp'
as $$
  select stripe_account_id
    from public.club_stripe_accounts
   where club_id = p_club_id and livemode = p_livemode;
$$;

revoke execute on function public.get_club_stripe_account_ref(uuid, boolean) from public, anon, authenticated;
grant  execute on function public.get_club_stripe_account_ref(uuid, boolean) to service_role;

-- Idempotent create-or-sync, scoped to (club_id, livemode). Called once
-- right after a brand-new Stripe account is created, and again every time
-- the onboarding return route re-reads the account from Stripe — never
-- called with locally-guessed values, always with whatever the Stripe API
-- just returned for that mode's account.
--
-- Financial-identity immutability: once a (club_id, livemode) row has a
-- stripe_account_id, ordinary status sync must never be able to silently
-- repoint it at a different Stripe account. The ON CONFLICT clause below
-- therefore never assigns stripe_account_id in its SET list, and only
-- fires at all when the conflicting row's existing stripe_account_id
-- already equals the one being upserted (the WHERE clause) — card_
-- payments_status/last_synced_at/updated_at are the only things an
-- existing row can ever have changed through this path. Two requests
-- racing to CREATE the same never-before-connected (club_id, livemode)
-- resolve safely because Stripe's own idempotency key on accounts.create
-- (see the Server Action) guarantees both calls here receive the
-- identical stripe_account_id — so the WHERE condition holds for both,
-- and the update is a harmless no-op repeat, not a conflict. If an upsert
-- is ever attempted for an existing (club_id, livemode) with a genuinely
-- DIFFERENT stripe_account_id, the WHERE condition excludes that row from
-- the update, the INSERT..ON CONFLICT affects zero rows, FOUND is false,
-- and the function fails closed with stripe_account_mismatch rather than
-- silently overwriting the club's financial identity. A deliberate
-- account-replacement/disconnect workflow is out of scope for 34D-A and
-- would be designed (and audited) separately.
create or replace function public.upsert_club_stripe_account(
  p_club_id              uuid,
  p_stripe_account_id    text,
  p_card_payments_status text,
  p_actor_id             uuid,
  p_livemode             boolean
)
returns public.club_stripe_accounts
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_result public.club_stripe_accounts%rowtype;
begin
  if p_club_id is null or p_stripe_account_id is null or p_actor_id is null or p_livemode is null
     or p_card_payments_status is null then
    raise exception 'invalid_arguments';
  end if;

  insert into public.club_stripe_accounts (
    club_id, stripe_account_id, livemode, card_payments_status,
    last_synced_at, created_by
  ) values (
    p_club_id, p_stripe_account_id, p_livemode, p_card_payments_status,
    now(), p_actor_id
  )
  on conflict (club_id, livemode) do update
    set card_payments_status = excluded.card_payments_status,
        last_synced_at       = now(),
        updated_at           = now()
  where public.club_stripe_accounts.stripe_account_id = excluded.stripe_account_id
  returning * into v_result;

  if not found then
    raise exception 'stripe_account_mismatch';
  end if;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    p_club_id, p_actor_id, 'upsert_club_stripe_account', 'club_stripe_accounts', v_result.id,
    jsonb_build_object('livemode', p_livemode, 'card_payments_status', p_card_payments_status)
  );

  return v_result;
end;
$$;

revoke execute on function public.upsert_club_stripe_account(uuid, text, text, uuid, boolean) from public, anon, authenticated;
grant  execute on function public.upsert_club_stripe_account(uuid, text, text, uuid, boolean) to service_role;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback (manual, cloud SQL Editor)
-- ═══════════════════════════════════════════════════════════════════════════
-- drop function if exists public.upsert_club_stripe_account(uuid, text, text, uuid, boolean);
-- drop function if exists public.get_club_stripe_account_ref(uuid, boolean);
-- drop function if exists public.get_club_stripe_connect_status(uuid, boolean);
-- drop table if exists public.club_stripe_accounts;
-- No other object is touched by this migration, so nothing else needs
-- restoring.
