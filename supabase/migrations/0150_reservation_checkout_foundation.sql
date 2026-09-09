-- 0150_reservation_checkout_foundation.sql
-- Phase 34D-D1 — Reservation Checkout + Successful Payment Reconciliation.
--
-- Scope: Stripe-hosted Checkout (direct charge, cards only, mode=payment,
-- no application fee) for a Member's own reservation-backed
-- court_time_payments obligation, plus atomic, exactly-once webhook
-- reconciliation into the existing 34C ledger. Does not modify 0143-0149
-- (already applied) — everything here is either a brand-new object, a
-- CREATE OR REPLACE of an existing function whose signature/return shape
-- is unchanged, or an ALTER TABLE widening an existing CHECK constraint by
-- name, per this project's established forward-only migration convention.
--
-- Out of scope (see 34D-D's own task boundary): destination charges,
-- application_fee, Court Time's own percentage, Elements/custom card
-- forms, subscriptions, saved payment methods, lessons/events/programs
-- online payment, Event Guest payer identity, refunds, disputes, async
-- payment methods, automatic cancellation of abandoned checkouts.
--
-- ── Event-receipt dedupe: reusing stripe_event_receipts (0148) ──────────
-- stripe_event_receipts' own header comment already frames it as
-- "technical webhook-delivery infrastructure" keyed by Stripe's own
-- globally-unique event id — that uniqueness holds regardless of which
-- webhook endpoint or event family (Connect account lifecycle vs.
-- Checkout/PaymentIntent) delivered it, so the SAME table safely serves as
-- the single Stripe event-id receipt table for both. This migration does
-- NOT alter that table's shape — it adds a second, independent RPC
-- (process_stripe_payment_event, section 6) that performs its own
-- INSERT ... ON CONFLICT DO NOTHING against it, exactly mirroring 0148's
-- process_stripe_connect_account_event, but reconciling the payment ledger
-- instead of club_stripe_accounts. No second/competing dedupe model is
-- created.
--
-- ── Ledger vocabulary: online payments are never "manual" ───────────────
-- payment_events' event_type/shape CHECK constraints (0143) are widened to
-- add 'online_payment_recorded' — a distinct event type from
-- 'manual_payment_recorded', so a Stripe-collected card payment is never
-- misrepresented as money an Admin/Staff physically recorded.
-- _recompute_payment_rollup (0143) is widened (CREATE OR REPLACE, same
-- signature, same trigger binding) to also sum this new event type into
-- amount_paid_cents/status — otherwise a successful online payment would
-- be ledger-recorded but never reflected in the obligation's own rollup.
--
-- ── Attempt model: payment_checkout_attempts ─────────────────────────────
-- A dedicated table (not a single Session/PaymentIntent field bolted onto
-- payments) because one obligation may retry checkout multiple times
-- (abandoned session, expired session, changed balance). Deny-all RLS,
-- service-role-only — identical discipline to club_stripe_accounts (0147)
-- and stripe_event_receipts (0148). A partial unique index enforces "at
-- most one OPEN attempt per payment" as a hard DB backstop; the owning RPC
-- additionally takes a row lock on the payments row itself, which already
-- serializes concurrent callers for the same payment_id (see section 4's
-- own comment for why no separate advisory lock is needed here, unlike
-- _create_payment_obligation's pre-row-existence case).
--
-- ── Authorization boundary ────────────────────────────────────────────────
-- get_reservation_payment_for_checkout (section 3) is the ONLY new
-- `authenticated`-grant object in this migration — pure read, no livemode
-- involved. It independently re-derives BOTH the caller's current role
-- (must be exactly 'member' — the locked "authenticated Member only"
-- invariant; an Admin/Staff/Pro who also happens to hold a roster identity
-- must not reach the checkout path this feeds) AND the caller's own
-- roster identity via current_user_roster_member_id() (0110), exactly
-- like get_payment_states_for_domains' own Member branch — so neither a
-- non-Member role nor another Member's payment_id can ever be resolved
-- through it. Every other new RPC
-- (open_payment_checkout_attempt, record_checkout_session_created,
-- process_stripe_payment_event) takes livemode and/or a Stripe connected-
-- account id as a parameter — exactly the class of RPC 0149's own header
-- comment establishes must be service-role-only, reachable only through a
-- Next.js Server Action that independently authenticates the caller and
-- derives livemode itself via getStripeContext(), never from any
-- browser/client-supplied value.
--
-- Apply in Supabase SQL Editor (cloud only).

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. payment_events — widen event_type/shape to add online_payment_recorded
-- ═══════════════════════════════════════════════════════════════════════════
-- The event_type column's CHECK was declared inline (`event_type text not
-- null check (...)`) in 0143 with no explicit constraint name, so Postgres
-- assigned it the standard default name for a single-column inline CHECK:
-- {table}_{column}_check. This DO block fails loudly at apply time if that
-- assumption is ever wrong, rather than silently leaving a stale stricter
-- constraint in place alongside a newly-added one (which would make every
-- online payment insert fail with a confusing constraint violation).
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'payment_events_event_type_check'
       and conrelid = 'public.payment_events'::regclass
  ) then
    raise exception 'expected constraint payment_events_event_type_check not found on public.payment_events — 0150 must be corrected with the real constraint name before applying';
  end if;
end $$;

alter table public.payment_events
  drop constraint payment_events_event_type_check,
  add  constraint payment_events_event_type_check
       check (event_type in (
         'obligation_created',
         'obligation_amount_adjusted',
         'manual_payment_recorded',
         'online_payment_recorded',
         'refund_recorded',
         'reverse_payment_event',
         'void_payment_obligation',
         'waived'
       ));

-- payment_events_shape was explicitly named in 0143 — no name-guessing
-- needed. Similar shape to manual_payment_recorded (positive amount, no
-- reversal linkage) except method stays NULL (there is no
-- cash/check/card_terminal/... method for an online card payment — the
-- event_type itself already says how it was collected) and
-- external_reference is REQUIRED non-null — unlike manual_payment_
-- recorded's own unconstrained external_reference, this one always holds
-- the Stripe CHECKOUT SESSION id (never the PaymentIntent id, which
-- Stripe documents as nullable even for a paid mode=payment Session and
-- must never be relied on as always-present): process_stripe_payment_event
-- (section 6b) never inserts this event type without a Session id
-- (p_stripe_checkout_session_id is a required, non-nullable argument
-- there, and is the function's own immutable reconciliation identity),
-- so the shape CHECK enforces the same guarantee at the table level, not
-- merely by convention. Visible only to Admin/Staff (payment_events RLS,
-- 0143 — no new exposure).
alter table public.payment_events
  drop constraint payment_events_shape,
  add  constraint payment_events_shape check (
    case event_type
      when 'obligation_created' then
        amount_cents is not null and amount_cents > 0
          and method is null and reverses_event_id is null
          and external_reference is null
      when 'obligation_amount_adjusted' then
        amount_cents is not null and amount_cents >= 0
          and method is null and reverses_event_id is null
          and external_reference is null
      when 'manual_payment_recorded' then
        amount_cents is not null and amount_cents > 0
          and method is not null and reverses_event_id is null
      when 'online_payment_recorded' then
        amount_cents is not null and amount_cents > 0
          and method is null and reverses_event_id is null
          and external_reference is not null
      when 'refund_recorded' then
        amount_cents is not null and amount_cents > 0
          and reverses_event_id is null
      when 'reverse_payment_event' then
        amount_cents is null and method is null and external_reference is null
          and reverses_event_id is not null
      when 'waived' then
        amount_cents is not null and amount_cents > 0
          and method is null and reverses_event_id is null
          and external_reference is null
      when 'void_payment_obligation' then
        amount_cents is not null and amount_cents > 0
          and method is null and reverses_event_id is null
          and external_reference is null
      else false
    end
  );

-- Hard DB backstop against a double credit, independent of and in
-- addition to the exactly-once machinery already provided by stripe_
-- event_receipts (event-id dedupe) and payment_checkout_attempts.status
-- (completed-attempt no-op) in process_stripe_payment_event (section 6b)
-- — this holds even if a future change to that application logic
-- regresses. A single Stripe Checkout Session (external_reference, always
-- the Session id for this event type — section 1's shape CHECK above)
-- can never produce two online_payment_recorded rows for the same club.
-- Scoped by club_id defensively, matching this schema's general
-- per-club-ledger-isolation convention, even though Stripe Session ids
-- are already globally unique on their own. The partial WHERE clause
-- means manual_payment_recorded's own (unconstrained, frequently
-- repeated) external_reference is completely unaffected.
create unique index payment_events_online_payment_session_uniq
  on public.payment_events (club_id, external_reference)
  where event_type = 'online_payment_recorded';

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. _recompute_payment_rollup — widened to also sum online_payment_recorded
-- ═══════════════════════════════════════════════════════════════════════════
-- Exact live production body from 0143, changed in exactly two ways. Same
-- signature, so CREATE OR REPLACE preserves the existing payment_events_
-- after_insert trigger binding — the trigger itself is not touched.
--
-- (a) The v_net FILTER clause now includes 'online_payment_recorded'
--     alongside 'manual_payment_recorded' — otherwise a successful online
--     payment would be ledger-recorded but never reflected in the
--     obligation's own rollup.
--
-- (b) 'void' now only wins the status precedence when v_net <= 0 (`if
--     v_void and v_net <= 0`, was unconditional `if v_void`). Before
--     34D-D1, void_payment_obligation (0143) could only ever be called
--     when amount_paid_cents = 0 — a void row could structurally never
--     have retained money, so the precedence never needed to consider the
--     combination. process_stripe_payment_event (section 6b) now
--     deliberately reconciles a genuinely paid Stripe Session regardless
--     of the local payment's current status, which makes "voided, then a
--     late online payment arrives" newly reachable — a void row must
--     never claim "nothing collected" once real money has actually
--     landed; the status falls through to the ordinary overpaid/paid/
--     partially_paid branches below instead, so the rollup tells the
--     truth about money that moved. Remediation (e.g. refunding an
--     accidental late payment against a voided obligation) is 34D-E
--     policy, not this function's job.
--
--     'waived' is deliberately LEFT UNCONDITIONAL, unlike 'void' — this
--     is not an oversight. waive_payment (0143) can legitimately be
--     called on a row that ALREADY has retained money (a partial manual
--     payment, then the remaining balance forgiven), and 0143's own
--     _check_member_reassignment_allowed comment explicitly anticipates
--     and handles exactly that combination — by checking amount_paid_
--     cents = 0 INDEPENDENTLY of status, never inferring "zero retained
--     money" from status = 'waived' alone. That existing, shipped,
--     already-tested 34C behavior must not change here. Reassignment
--     safety for a LATE online payment arriving after a waive is already
--     correctly preserved by that same independent amount_paid_cents
--     check (a waived row's amount_paid_cents > 0, for ANY reason, old or
--     new, already fails that check and blocks reassignment) — no
--     additional change is needed there.
create or replace function public._recompute_payment_rollup(p_payment_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_due    integer;
  v_net    integer;
  v_has_refund boolean;
  v_void   boolean;
  v_waived boolean;
  v_status text;
begin
  select amount_cents into v_due
    from public.payment_events
   where payment_id = p_payment_id
     and event_type in ('obligation_created', 'obligation_amount_adjusted')
     and id not in (
       select reverses_event_id from public.payment_events where reverses_event_id is not null
     )
   order by created_at desc, id desc
   limit 1;
  v_due := coalesce(v_due, 0);

  select
    coalesce(sum(amount_cents) filter (where event_type in ('manual_payment_recorded', 'online_payment_recorded')), 0)
    - coalesce(sum(amount_cents) filter (where event_type = 'refund_recorded'), 0)
    into v_net
    from public.payment_events
   where payment_id = p_payment_id
     and id not in (
       select reverses_event_id from public.payment_events where reverses_event_id is not null
     );
  v_net := coalesce(v_net, 0);

  select exists(
    select 1 from public.payment_events
     where payment_id = p_payment_id and event_type = 'refund_recorded'
       and id not in (
         select reverses_event_id from public.payment_events where reverses_event_id is not null
       )
  ) into v_has_refund;

  select exists(
    select 1 from public.payment_events
     where payment_id = p_payment_id and event_type = 'void_payment_obligation'
       and id not in (
         select reverses_event_id from public.payment_events where reverses_event_id is not null
       )
  ) into v_void;

  select exists(
    select 1 from public.payment_events
     where payment_id = p_payment_id and event_type = 'waived'
       and id not in (
         select reverses_event_id from public.payment_events where reverses_event_id is not null
       )
  ) into v_waived;

  if v_void and v_net <= 0 then
    v_status := 'void';
  elsif v_waived then
    v_status := 'waived';
  elsif v_net > v_due then
    v_status := 'overpaid';
  elsif v_has_refund then
    if v_net <= 0 then
      v_status := 'refunded';
    elsif v_net < v_due then
      v_status := 'partially_refunded';
    else
      v_status := 'paid';
    end if;
  else
    if v_net <= 0 then
      v_status := 'unpaid';
    elsif v_net < v_due then
      v_status := 'partially_paid';
    else
      v_status := 'paid';
    end if;
  end if;

  update public.payments
     set amount_due_cents = v_due,
         amount_paid_cents = v_net,
         status = v_status
   where id = p_payment_id;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. get_reservation_payment_for_checkout — Member-owned reservation read
-- ═══════════════════════════════════════════════════════════════════════════
-- Read-only. Returns at most one row: the CALLER's own latest payment
-- obligation for a reservation, only when the caller's CURRENT role is
-- exactly 'member' (the locked "authenticated Member only" invariant — an
-- Admin/Staff/Pro who also holds a roster identity in this club must not
-- pass this check, even though such a person could otherwise satisfy the
-- ownership match below) AND its snapshotted roster_member_id matches the
-- caller's own current roster identity (0110's
-- current_user_roster_member_id(), auth.uid()-derived — never a
-- client-supplied identity). Hardcoded to domain_type = 'reservation' —
-- Event Guest (whose payer identity is unresolved by design, 0143) is
-- structurally unreachable through this function regardless of what a
-- caller passes. Returns payment_mode_at_creation so the caller (a Server
-- Action) can enforce "obligation not created under court_time_payments is
-- never chargeable online" without trusting the club's CURRENT payment_mode
-- — an obligation created while the club was in 'manual' stays
-- manual-only forever, even if the club later turns on Court Time
-- Payments (matches 0149's own _create_payment_obligation widening,
-- section 2 there).
create or replace function public.get_reservation_payment_for_checkout(
  p_reservation_id uuid
)
returns table (
  payment_id                uuid,
  club_id                   uuid,
  amount_due_cents          integer,
  amount_paid_cents         integer,
  currency                  text,
  status                    text,
  payment_mode_at_creation  text
)
language plpgsql
security definer
stable
set search_path to 'public', 'pg_temp'
as $$
declare
  v_role              text;
  v_roster_member_id uuid;
begin
  v_role := public.current_user_role();
  if v_role is null then
    raise exception 'not_authenticated';
  end if;
  if v_role <> 'member' then
    raise exception 'insufficient_role';
  end if;

  v_roster_member_id := public.current_user_roster_member_id();
  if v_roster_member_id is null then
    raise exception 'not_authenticated';
  end if;

  return query
    select p.id, p.club_id, p.amount_due_cents, p.amount_paid_cents, p.currency, p.status, p.payment_mode_at_creation
      from public.payments p
     where p.domain_type = 'reservation'
       and p.domain_id = p_reservation_id
       and p.roster_member_id = v_roster_member_id
     order by p.obligation_cycle desc
     limit 1;
end;
$$;

revoke execute on function public.get_reservation_payment_for_checkout(uuid) from public, anon;
grant  execute on function public.get_reservation_payment_for_checkout(uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. payment_checkout_attempts — dedicated checkout-attempt model
-- ═══════════════════════════════════════════════════════════════════════════
create table public.payment_checkout_attempts (
  id                          uuid        primary key default gen_random_uuid(),
  payment_id                  uuid        not null,
  club_id                     uuid        not null references public.clubs(id) on delete cascade,

  -- Immutable snapshot of the Stripe environment this attempt was created
  -- in, exactly like club_stripe_accounts.livemode (0147) — always
  -- server-derived, never client-supplied.
  stripe_account_id           text        not null,
  livemode                    boolean     not null,

  -- NULL until the Server Action's Stripe Checkout Session create call
  -- returns (record_checkout_session_created, section 6a) — a fresh
  -- attempt row exists before the Stripe API call so a lost response can
  -- still be reconciled by retrying with the SAME idempotency key derived
  -- from this row's own id. Globally unique once set: two different
  -- attempts (even across different payments) must never claim the same
  -- Stripe Checkout Session.
  stripe_checkout_session_id  text        unique,
  -- Stripe's own authoritative Session expiration (its `expires_at`,
  -- returned by the create call and stored verbatim by record_checkout_
  -- session_created, section 6a) — the real signal for whether a bound
  -- Session can still be reused, replacing any arbitrary local freshness
  -- heuristic. NULL until a Session is bound, exactly like stripe_
  -- checkout_session_id itself.
  stripe_session_expires_at   timestamptz,
  -- Populated at webhook-reconciliation time (section 6) once Stripe
  -- reports it on the completed Session.
  stripe_payment_intent_id    text,

  -- Immutable expected-amount snapshot, re-derived fresh from the payments
  -- row at attempt-open time (never trusted from an earlier caller-side
  -- read) — this is what the webhook RPC compares an incoming Session's
  -- amount_total against, so a stale/tampered client value can never
  -- substitute for what Court Time itself computed as owed.
  amount_expected_cents       integer     not null check (amount_expected_cents > 0),
  currency_expected            text        not null check (currency_expected ~ '^[A-Z]{3}$'),

  status                       text        not null default 'open'
                                 check (status in ('open', 'completed', 'expired', 'canceled')),

  created_by                   uuid        references public.profiles(id),
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),

  foreign key (payment_id, club_id) references public.payments(id, club_id)
);

-- Hard DB backstop: at most one OPEN attempt per payment at any time. The
-- owning RPC (section 5) additionally serializes concurrent callers via a
-- row lock on the payments row itself before ever reaching this table, so
-- this index is defense in depth, not the only guard.
create unique index payment_checkout_attempts_one_open_per_payment
  on public.payment_checkout_attempts (payment_id)
  where status = 'open';

create index payment_checkout_attempts_payment_idx on public.payment_checkout_attempts (payment_id);
create index payment_checkout_attempts_club_idx on public.payment_checkout_attempts (club_id);

create trigger payment_checkout_attempts_updated_at
  before update on public.payment_checkout_attempts
  for each row execute function public.trigger_set_updated_at();

alter table public.payment_checkout_attempts enable row level security;
-- No policies: deny-all direct client access by design, identical to
-- club_stripe_accounts (0147) / stripe_event_receipts (0148). service_role
-- is untouched by this revoke — every read/write of this table goes
-- through the SECURITY DEFINER RPCs below.
revoke all on public.payment_checkout_attempts from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5a. open_payment_checkout_attempt — service-role-only, resolves what to
--     do WITHOUT ever creating two simultaneously payable Stripe Sessions
-- ═══════════════════════════════════════════════════════════════════════════
-- The database itself cannot call Stripe — it cannot expire a remote
-- Checkout Session, and a local status change (marking an attempt
-- 'canceled'/'expired' in this table) does NOT invalidate that Session's
-- own Stripe-hosted URL, which remains genuinely payable until Stripe
-- itself expires or completes it. So this function never unilaterally
-- supersedes an attempt that has a BOUND Stripe Session — doing so would
-- risk exposing two live, simultaneously payable Sessions for the same
-- payment (the old bound one, still reachable at its original URL, and a
-- new one). Instead it returns one of two outcomes for the caller (the
-- Server Action) to act on:
--
--   action = 'ready'             — either an existing OPEN attempt was
--     reused as-is (amount, currency, connected account, AND Stripe
--     environment/livemode all still match, and — if it already has a
--     bound Session — that Session's own Stripe-reported expiration is
--     still in the future), or no superseding was needed at all (no
--     existing open attempt with a bound Session blocks a fresh one — see
--     the UNBOUND case below) and a fresh attempt row was opened. The
--     caller may proceed straight to creating/reusing a Checkout Session.
--
--   action = 'must_expire_remote' — an existing OPEN attempt needs to be
--     replaced (amount/currency/account/livemode changed, or its bound
--     Session's own Stripe-reported expiration has passed) AND it already
--     has a bound Stripe Session that may still be genuinely payable.
--     NOTHING is mutated in this case — the stale attempt is returned
--     as-is. The caller MUST retrieve that Session from Stripe (in the
--     STALE attempt's own stored stripe_account_id context — never the
--     new one) and either confirm it is no longer payable (expired, or
--     actively expire it via Stripe while still 'open') or, if Stripe
--     reports it already complete/paid, stop entirely and let webhook
--     reconciliation finish — before calling supersede_checkout_attempt_
--     and_open_fresh (section 5b) to close the local row and open a
--     replacement. If Stripe cannot be safely queried/expired, the caller
--     must not create a replacement at all.
--
-- The stale-but-UNBOUND case (an existing OPEN attempt needs replacing but
-- has NO stripe_checkout_session_id yet) is handled entirely within THIS
-- function, synchronously: no remote Stripe artifact exists yet for it,
-- so there is nothing that could still be payable, and it is safely
-- marked 'canceled' before a fresh attempt is opened in the same
-- transaction — action='ready' is returned directly.
--
-- Environment mismatch fails closed: if the existing OPEN attempt has a
-- bound Session but its own livemode differs from the CURRENT p_livemode,
-- this function raises immediately (stale_attempt_environment_mismatch)
-- rather than returning 'must_expire_remote' — a livemode mismatch means
-- the CURRENT Stripe API key literally cannot address that Session at all
-- (test-mode and live-mode are disjoint API key spaces), so it can never
-- be safely queried/expired, and this migration's own financial-identity-
-- immutability discipline (matching 0147's upsert_club_stripe_account)
-- means the old attempt's stored identity is never mutated to pretend
-- otherwise. A connected-account-only change (same livemode) is NOT a
-- hard failure — the OLD account remains addressable via the CURRENT
-- Stripe API key using its own stored stripe_account_id, so that case
-- routes through the normal 'must_expire_remote' path instead.
--
-- Re-derives amount owed and eligibility fresh from the payments row under
-- a row lock — never trusts amount/eligibility computed by an earlier
-- caller-side read (closes the TOCTOU window between the Server Action's
-- own eligibility pre-check and this, the actual money-relevant step).
-- Canonical lock order (payments -> payment_checkout_attempts, section 4
-- correction, matching process_stripe_payment_event and section 5b
-- below): the `for update` row lock on the target payments row already
-- serializes any two concurrent calls for the SAME payment_id (the second
-- caller blocks until the first's transaction commits or rolls back) —
-- unlike _create_payment_obligation (0143), which needs an advisory lock
-- because no payments row exists yet at the time it must serialize, here
-- the row already exists, so its own row lock is sufficient and no
-- separate advisory lock is added.
create or replace function public.open_payment_checkout_attempt(
  p_payment_id         uuid,
  p_club_id            uuid,
  p_stripe_account_id  text,
  p_livemode           boolean,
  p_actor_id           uuid
)
returns table (
  action                      text,
  id                          uuid,
  payment_id                  uuid,
  club_id                     uuid,
  stripe_account_id           text,
  livemode                    boolean,
  stripe_checkout_session_id  text,
  stripe_session_expires_at   timestamptz,
  stripe_payment_intent_id    text,
  amount_expected_cents       integer,
  currency_expected           text,
  status                      text,
  created_by                  uuid,
  created_at                  timestamptz,
  updated_at                  timestamptz
)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_payment    public.payments%rowtype;
  v_remaining  integer;
  v_existing   public.payment_checkout_attempts%rowtype;
  v_result     public.payment_checkout_attempts%rowtype;
begin
  if p_payment_id is null or p_club_id is null or p_stripe_account_id is null
     or p_livemode is null or p_actor_id is null then
    raise exception 'invalid_arguments';
  end if;

  select * into v_payment
    from public.payments p
   where p.id = p_payment_id and p.club_id = p_club_id
   for update;
  if not found then
    raise exception 'payment_not_found';
  end if;

  if v_payment.payment_mode_at_creation <> 'court_time_payments' then
    raise exception 'not_online_payable';
  end if;

  if v_payment.status not in ('unpaid', 'partially_paid') then
    raise exception 'payment_not_open_for_checkout';
  end if;

  v_remaining := v_payment.amount_due_cents - v_payment.amount_paid_cents;
  if v_remaining <= 0 then
    raise exception 'no_balance_due';
  end if;

  select * into v_existing
    from public.payment_checkout_attempts a
   where a.payment_id = p_payment_id and a.status = 'open'
   for update;

  if found then
    if v_existing.amount_expected_cents = v_remaining
       and v_existing.currency_expected = v_payment.currency
       and v_existing.stripe_account_id = p_stripe_account_id
       and v_existing.livemode = p_livemode
       and (v_existing.stripe_session_expires_at is null or v_existing.stripe_session_expires_at > now()) then
      return query select 'ready'::text, v_existing.id, v_existing.payment_id, v_existing.club_id,
        v_existing.stripe_account_id, v_existing.livemode, v_existing.stripe_checkout_session_id,
        v_existing.stripe_session_expires_at, v_existing.stripe_payment_intent_id,
        v_existing.amount_expected_cents, v_existing.currency_expected, v_existing.status,
        v_existing.created_by, v_existing.created_at, v_existing.updated_at;
      return;
    end if;

    if v_existing.stripe_checkout_session_id is null then
      -- No remote Session exists yet — nothing could still be payable.
      -- Safe to supersede locally right now, in this same transaction.
      update public.payment_checkout_attempts a
         set status = 'canceled', updated_at = now()
       where a.id = v_existing.id;
      -- Falls through to the fresh insert below.
    else
      if v_existing.livemode <> p_livemode then
        raise exception 'stale_attempt_environment_mismatch';
      end if;

      -- A remote Session may still be genuinely payable. Nothing is
      -- mutated — the caller must resolve it via Stripe first (see this
      -- function's own header comment).
      return query select 'must_expire_remote'::text, v_existing.id, v_existing.payment_id, v_existing.club_id,
        v_existing.stripe_account_id, v_existing.livemode, v_existing.stripe_checkout_session_id,
        v_existing.stripe_session_expires_at, v_existing.stripe_payment_intent_id,
        v_existing.amount_expected_cents, v_existing.currency_expected, v_existing.status,
        v_existing.created_by, v_existing.created_at, v_existing.updated_at;
      return;
    end if;
  end if;

  insert into public.payment_checkout_attempts (
    payment_id, club_id, stripe_account_id, livemode,
    amount_expected_cents, currency_expected, status, created_by
  ) values (
    p_payment_id, p_club_id, p_stripe_account_id, p_livemode,
    v_remaining, v_payment.currency, 'open', p_actor_id
  ) returning * into v_result;

  return query select 'ready'::text, v_result.id, v_result.payment_id, v_result.club_id,
    v_result.stripe_account_id, v_result.livemode, v_result.stripe_checkout_session_id,
    v_result.stripe_session_expires_at, v_result.stripe_payment_intent_id,
    v_result.amount_expected_cents, v_result.currency_expected, v_result.status,
    v_result.created_by, v_result.created_at, v_result.updated_at;
end;
$$;

revoke execute on function public.open_payment_checkout_attempt(uuid, uuid, text, boolean, uuid) from public, anon, authenticated;
grant  execute on function public.open_payment_checkout_attempt(uuid, uuid, text, boolean, uuid) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5b. supersede_checkout_attempt_and_open_fresh — service-role-only, the
--     ONLY way to close a stale BOUND attempt and open its replacement
-- ═══════════════════════════════════════════════════════════════════════════
-- Called ONLY after the Server Action has independently confirmed via
-- Stripe (using the stale attempt's own stripe_account_id context) that
-- its bound Session is no longer payable — either Stripe reported it
-- already 'expired', or the Server Action actively expired an 'open' one
-- through Stripe first. Never called when Stripe reports the old Session
-- already complete/paid (the Server Action stops before ever reaching
-- this function in that case) or when Stripe couldn't be safely queried.
--
-- Re-validates payment eligibility fresh (same checks as section 5a) —
-- state may have changed during the Stripe round-trip between the two
-- calls. Additionally re-checks the stale attempt is STILL 'open' at this
-- exact moment: if something else resolved it in the meantime (most
-- notably, the webhook itself completing it — a real possibility, since
-- the whole point of the 'must_expire_remote' path is that the old
-- Session might still be genuinely payable) this returns
-- action='already_completed' with the (now non-open) row, and creates NO
-- new attempt — the caller must stop and let that state stand rather than
-- open a second, redundant attempt on top of one that just succeeded.
--
-- Canonical lock order (payments -> payment_checkout_attempts, section 4):
-- identical order to open_payment_checkout_attempt and process_stripe_
-- payment_event.
create or replace function public.supersede_checkout_attempt_and_open_fresh(
  p_stale_attempt_id   uuid,
  p_payment_id         uuid,
  p_club_id            uuid,
  p_stripe_account_id  text,
  p_livemode           boolean,
  p_actor_id           uuid
)
returns table (
  action                      text,
  id                          uuid,
  payment_id                  uuid,
  club_id                     uuid,
  stripe_account_id           text,
  livemode                    boolean,
  stripe_checkout_session_id  text,
  stripe_session_expires_at   timestamptz,
  stripe_payment_intent_id    text,
  amount_expected_cents       integer,
  currency_expected           text,
  status                      text,
  created_by                  uuid,
  created_at                  timestamptz,
  updated_at                  timestamptz
)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_payment   public.payments%rowtype;
  v_remaining integer;
  v_stale     public.payment_checkout_attempts%rowtype;
  v_result    public.payment_checkout_attempts%rowtype;
begin
  if p_stale_attempt_id is null or p_payment_id is null or p_club_id is null
     or p_stripe_account_id is null or p_livemode is null or p_actor_id is null then
    raise exception 'invalid_arguments';
  end if;

  select * into v_payment
    from public.payments p
   where p.id = p_payment_id and p.club_id = p_club_id
   for update;
  if not found then
    raise exception 'payment_not_found';
  end if;

  if v_payment.payment_mode_at_creation <> 'court_time_payments' then
    raise exception 'not_online_payable';
  end if;

  if v_payment.status not in ('unpaid', 'partially_paid') then
    raise exception 'payment_not_open_for_checkout';
  end if;

  v_remaining := v_payment.amount_due_cents - v_payment.amount_paid_cents;
  if v_remaining <= 0 then
    raise exception 'no_balance_due';
  end if;

  select * into v_stale
    from public.payment_checkout_attempts a
   where a.id = p_stale_attempt_id and a.payment_id = p_payment_id
   for update;
  if not found then
    raise exception 'checkout_attempt_not_found';
  end if;

  if v_stale.status <> 'open' then
    -- Resolved by something else since the caller checked with Stripe
    -- (most notably: the webhook completing it) — never create a second
    -- attempt on top. The caller must stop and let that state stand.
    return query select 'already_completed'::text, v_stale.id, v_stale.payment_id, v_stale.club_id,
      v_stale.stripe_account_id, v_stale.livemode, v_stale.stripe_checkout_session_id,
      v_stale.stripe_session_expires_at, v_stale.stripe_payment_intent_id,
      v_stale.amount_expected_cents, v_stale.currency_expected, v_stale.status,
      v_stale.created_by, v_stale.created_at, v_stale.updated_at;
    return;
  end if;

  update public.payment_checkout_attempts a
     set status = 'expired', updated_at = now()
   where a.id = v_stale.id;

  insert into public.payment_checkout_attempts (
    payment_id, club_id, stripe_account_id, livemode,
    amount_expected_cents, currency_expected, status, created_by
  ) values (
    p_payment_id, p_club_id, p_stripe_account_id, p_livemode,
    v_remaining, v_payment.currency, 'open', p_actor_id
  ) returning * into v_result;

  return query select 'ready'::text, v_result.id, v_result.payment_id, v_result.club_id,
    v_result.stripe_account_id, v_result.livemode, v_result.stripe_checkout_session_id,
    v_result.stripe_session_expires_at, v_result.stripe_payment_intent_id,
    v_result.amount_expected_cents, v_result.currency_expected, v_result.status,
    v_result.created_by, v_result.created_at, v_result.updated_at;
end;
$$;

revoke execute on function public.supersede_checkout_attempt_and_open_fresh(uuid, uuid, uuid, text, boolean, uuid) from public, anon, authenticated;
grant  execute on function public.supersede_checkout_attempt_and_open_fresh(uuid, uuid, uuid, text, boolean, uuid) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6a. record_checkout_session_created — service-role-only, fails loudly
-- ═══════════════════════════════════════════════════════════════════════════
-- Called once the Server Action's Stripe Checkout Session create call
-- returns, and its success is REQUIRED before the Server Action may ever
-- return a checkout URL to the Member — process_stripe_payment_event
-- (section 6b) finds an attempt SOLELY by stripe_checkout_session_id, so a
-- Member must never be sent to pay a Session Court Time failed to durably
-- bind to its attempt (an unbindable Session would be reconciled as
-- 'checkout_attempt_not_found' forever, silently losing a real payment
-- from Court Time's own point of view). This function therefore RAISES —
-- never a silent zero-rows-affected no-op — for every failure case:
--   attempt missing              -> checkout_attempt_not_found
--   attempt status <> 'open'     -> checkout_attempt_not_open
--   different stored session id  -> checkout_session_mismatch
-- The status check matters on its own, distinct from the session-id
-- check: a canceled/expired/completed attempt (open_payment_checkout_
-- attempt / supersede_checkout_attempt_and_open_fresh, section 5,
-- supersede rather than delete a superseded attempt) must never be
-- (re)bound to a Session — binding a non-open attempt could let a Member
-- be sent to pay a Session that process_stripe_payment_event would either
-- never find as the CURRENT open attempt for that payment, or worse,
-- could bind a fresh Session id onto a row already 'completed'. Binding
-- the SAME session id again onto a still-open attempt (a retry of the
-- Server Action after a lost response) is idempotent success — safe
-- because the attempt-derived Stripe idempotency key (paymentsConfig.ts)
-- guarantees a retried Session-create call for the SAME attempt returns
-- the identical Stripe Session, so this is genuinely re-binding the same
-- fact, not a race between two different Sessions.
--
-- p_stripe_session_expires_at stores Stripe's own authoritative Session
-- expiration (the create response's `expires_at`) — this is what
-- open_payment_checkout_attempt's reuse decision (section 5a) now checks
-- instead of any local, arbitrary freshness heuristic.
create or replace function public.record_checkout_session_created(
  p_attempt_id                  uuid,
  p_stripe_checkout_session_id  text,
  p_stripe_session_expires_at   timestamptz
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_attempt public.payment_checkout_attempts%rowtype;
begin
  if p_attempt_id is null or p_stripe_checkout_session_id is null or p_stripe_session_expires_at is null then
    raise exception 'invalid_arguments';
  end if;

  select * into v_attempt
    from public.payment_checkout_attempts
   where id = p_attempt_id
   for update;

  if not found then
    raise exception 'checkout_attempt_not_found';
  end if;

  if v_attempt.status <> 'open' then
    raise exception 'checkout_attempt_not_open';
  end if;

  if v_attempt.stripe_checkout_session_id is not null
     and v_attempt.stripe_checkout_session_id <> p_stripe_checkout_session_id then
    raise exception 'checkout_session_mismatch';
  end if;

  update public.payment_checkout_attempts
     set stripe_checkout_session_id = p_stripe_checkout_session_id,
         stripe_session_expires_at = p_stripe_session_expires_at,
         updated_at = now()
   where id = p_attempt_id;
end;
$$;

revoke execute on function public.record_checkout_session_created(uuid, text, timestamptz) from public, anon, authenticated;
grant  execute on function public.record_checkout_session_created(uuid, text, timestamptz) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6b. process_stripe_payment_event — the one atomic payment-reconciliation RPC
-- ═══════════════════════════════════════════════════════════════════════════
-- service_role only. The webhook Route Handler independently verifies the
-- Stripe webhook signature and extracts these fields from the verified
-- Event/Session BEFORE ever calling this — every parameter here is already
-- server-verified by the time it arrives. Defense in depth beyond that
-- trust boundary: p_event_type is still validated against the single
-- supported value.
--
-- p_stripe_payment_intent_id is NULLABLE and MUST stay that way — Stripe's
-- own Checkout Session object documents payment_intent as nullable even
-- for a paid mode=payment Session (its presence/timing is an
-- implementation detail of how Stripe processed that specific Session,
-- not something this integration may assume). A genuinely paid, signature-
-- verified Checkout Session must NEVER be permanently dropped merely
-- because payment_intent happens to be null — p_stripe_checkout_session_id
-- (required, matched 1:1 against the attempt this function looks up by)
-- is this function's real immutable Stripe reconciliation identity;
-- payment_status = 'paid' on that verified Session is this cards-only
-- flow's authoritative success signal, independent of PaymentIntent
-- presence. Account, livemode, Session id, currency, and amount
-- validation remain mandatory and unaffected by this. Because
-- p_stripe_payment_intent_id may be null, online_payment_recorded's own
-- external_reference (section 1, required non-null) stores the Stripe
-- CHECKOUT SESSION id instead — that field is always genuinely available,
-- giving every online ledger event a guaranteed Stripe reference
-- regardless of whether a PaymentIntent was ever reported.
--
-- PaymentIntent consistency across events for the SAME attempt (relevant
-- only once an attempt is already 'completed' — see below): if both the
-- stored and incoming PaymentIntent ids are non-null and DIFFER, that is a
-- real conflict (Stripe reporting two different PaymentIntents against
-- one Session/attempt) and raises payment_intent_mismatch. If the stored
-- id is null and the incoming one is non-null, the attempt is updated to
-- record it (Stripe supplying, on a later event, information it omitted
-- on an earlier one) WITHOUT creating a second ledger credit — the
-- ledger's own exactly-once guarantee is the receipt/attempt-status
-- machinery, never PaymentIntent presence. A known non-null PaymentIntent
-- is never replaced by a different one, and never erased by a later null.
--
-- Dedupe: an INSERT ... ON CONFLICT DO NOTHING against the SAME
-- stripe_event_receipts table 0148 already established (see this
-- migration's own header comment for why reuse is safe) — a duplicate
-- delivery (the SAME Stripe event id redelivered) is a proven-by-
-- construction no-op, identical in shape to process_stripe_connect_
-- account_event.
--
-- Immutable-identity validation runs BEFORE the completed-attempt no-op —
-- deliberately NOT the same thing as the event-id dedupe above. A second,
-- genuinely distinct Stripe event id that merely REFERENCES an
-- already-completed attempt (e.g. Stripe redelivering a differently-shaped
-- event, or a bug/replay attempt supplying a foreign account/session) must
-- still prove it describes the SAME account/livemode/currency/amount/
-- PaymentIntent before this function ever treats it as a safe no-op —
-- otherwise "attempt already completed" could be used to smuggle
-- mismatched data past validation entirely. Every mismatch raises on
-- mismatch, which rolls back this whole call's transaction INCLUDING the
-- just-inserted event receipt — so a genuinely valid Stripe payment that
-- Court Time cannot safely reconcile is never permanently recorded as
-- processed; Stripe's own automatic webhook retry will redeliver it. The
-- one successful reconciliation path (all checks pass, attempt not yet
-- completed) inserts the online_payment_recorded ledger event and marks
-- the attempt completed in the SAME transaction as the receipt insert —
-- all three commit together or none do.
--
-- Canonical lock order (payments -> payment_checkout_attempts, matching
-- open_payment_checkout_attempt/supersede_checkout_attempt_and_open_fresh
-- above) — deliberately NOT "lock the attempt row by Session id, then
-- lock payments," which would invert the order those two functions use
-- and create a real deadlock opportunity under concurrent load (one
-- transaction holding payments-then-wanting-attempts while another holds
-- attempts-then-wanting-payments). Since this function must first locate
-- WHICH payment a Session belongs to before it can lock that payments
-- row, it does so via a plain, non-locking SELECT — never a `for update`
-- on payment_checkout_attempts before payments is locked — then locks
-- payments, then re-reads/locks the attempt row and revalidates that it
-- still refers to the same Session/payment before proceeding. This is the
-- one place in this migration where an attempt row must be located before
-- its owning payment is known; every other RPC already has payment_id in
-- hand from its own caller-supplied argument and locks payments first
-- directly.
--
-- Once every immutable Stripe identity check below has passed, Stripe has
-- genuinely collected real money against a Court Time-created, durably
-- bound attempt. This function does NOT gate reconciliation on the local
-- payments row's CURRENT status (unlike earlier revisions of this
-- migration) — a concurrent manual payment, a price change, a waiver, or
-- a void that happened locally after the Checkout Session was created
-- must never cause Court Time to drop or endlessly retry a payment Stripe
-- has actually collected. The ledger tells the truth about money that
-- moved first; reconciling those overlaps (refunding an accidental
-- overpayment, etc.) is 34D-E policy, not this function's job. See
-- _recompute_payment_rollup's own header comment (section 2) for the
-- matching correction that keeps 'void'/'waived' from ever describing a
-- row that has since received real retained money.
create or replace function public.process_stripe_payment_event(
  p_stripe_event_id            text,
  p_event_type                 text,
  p_livemode                   boolean,
  p_stripe_account_id          text,
  p_stripe_checkout_session_id text,
  p_stripe_payment_intent_id   text,
  p_amount_total_cents         integer,
  p_currency                   text
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
  v_lookup_payment_id uuid;
  v_attempt     public.payment_checkout_attempts%rowtype;
  v_payment     public.payments%rowtype;
begin
  -- p_stripe_payment_intent_id is deliberately NOT included in this check
  -- — it is genuinely nullable (see this function's own header comment).
  if p_stripe_event_id is null or p_event_type is null or p_livemode is null
     or p_stripe_account_id is null or p_stripe_checkout_session_id is null
     or p_amount_total_cents is null or p_currency is null then
    raise exception 'invalid_arguments';
  end if;

  if p_event_type <> 'checkout.session.completed' then
    raise exception 'invalid_event_type';
  end if;

  insert into public.stripe_event_receipts (
    stripe_event_id, event_type, livemode, stripe_account_id, processed_at
  ) values (
    p_stripe_event_id, p_event_type, p_livemode, p_stripe_account_id, now()
  )
  on conflict (stripe_event_id) do nothing;

  v_new_receipt := found;

  if not v_new_receipt then
    -- Proven-by-construction duplicate of the SAME Stripe event id,
    -- already successfully processed — no ledger insert repeated.
    return query select true, true;
    return;
  end if;

  -- Canonical lock order — non-locking lookup ONLY, to identify which
  -- payment this Session belongs to (see this function's own header
  -- comment). No `for update` here; payment_checkout_attempts is not
  -- locked before payments below.
  select payment_id into v_lookup_payment_id
    from public.payment_checkout_attempts
   where stripe_checkout_session_id = p_stripe_checkout_session_id;

  if v_lookup_payment_id is null then
    -- No known attempt for this Session yet — could be a genuine race
    -- (record_checkout_session_created hasn't committed yet) or an
    -- unrelated/foreign Session. Either way this must be retryable, never
    -- silently dropped, so this raises and rolls back the receipt insert
    -- above too, exactly like 0148's unknown-account handling.
    raise exception 'checkout_attempt_not_found';
  end if;

  select * into v_payment
    from public.payments
   where id = v_lookup_payment_id
   for update;

  if not found then
    raise exception 'payment_not_found';
  end if;

  -- Re-read/lock the attempt row now that payments is locked, and
  -- revalidate it still refers to this exact Session — the canonical
  -- lock order's own "revalidate after acquiring locks" step. Structurally
  -- should always still match (stripe_checkout_session_id is set once and
  -- never reassigned to a different attempt — see record_checkout_
  -- session_created's own conflict guard), but this is the actual
  -- authoritative read this function acts on, not the earlier
  -- non-locking lookup.
  select * into v_attempt
    from public.payment_checkout_attempts
   where stripe_checkout_session_id = p_stripe_checkout_session_id
   for update;

  if not found or v_attempt.payment_id <> v_payment.id then
    raise exception 'checkout_attempt_not_found';
  end if;

  -- Immutable identity validation — BEFORE the completed-attempt no-op
  -- below (see this section's own header comment for why the ordering
  -- matters).
  if v_attempt.stripe_account_id <> p_stripe_account_id then
    raise exception 'stripe_account_mismatch';
  end if;

  if v_attempt.livemode <> p_livemode then
    raise exception 'livemode_mismatch';
  end if;

  if v_attempt.currency_expected <> upper(p_currency) then
    raise exception 'currency_mismatch';
  end if;

  if v_attempt.amount_expected_cents <> p_amount_total_cents then
    raise exception 'amount_mismatch';
  end if;

  if v_attempt.status = 'completed' then
    -- A second, genuinely distinct Stripe event id for an attempt this
    -- function already completed. A real conflict — raise — only when
    -- BOTH the stored and incoming PaymentIntent ids are non-null and
    -- differ; a different PaymentIntent for the same Session/attempt
    -- would mean Stripe collected payment twice against a Session Court
    -- Time already considers paid, which must never be silently accepted
    -- as a matching no-op.
    if v_attempt.stripe_payment_intent_id is not null
       and p_stripe_payment_intent_id is not null
       and v_attempt.stripe_payment_intent_id <> p_stripe_payment_intent_id then
      raise exception 'payment_intent_mismatch';
    end if;

    -- Stripe supplying, on this later event, a PaymentIntent id it
    -- omitted on the original completing event — recorded onto the
    -- attempt for reference, without creating a second ledger credit. A
    -- known non-null id is never overwritten (the branch above already
    -- guards the only case that could attempt that with a DIFFERENT id;
    -- an identical id here is a harmless no-op write).
    if v_attempt.stripe_payment_intent_id is null and p_stripe_payment_intent_id is not null then
      update public.payment_checkout_attempts
         set stripe_payment_intent_id = p_stripe_payment_intent_id,
             updated_at = now()
       where id = v_attempt.id;
    end if;

    return query select true, true;
    return;
  end if;

  -- payment_mode_at_creation is immutable (0143) and was already
  -- validated when this attempt was opened — re-checked here as defense
  -- in depth only, not because it can actually change. club/payment
  -- identity is structurally guaranteed by payment_checkout_attempts'
  -- own composite FK (payment_id, club_id) references payments(id,
  -- club_id) (section 4) — a payment/club mismatch cannot exist to check.
  if v_payment.payment_mode_at_creation <> 'court_time_payments' then
    raise exception 'not_online_payable';
  end if;

  -- Deliberately NOT gated on v_payment.status — see this function's own
  -- header comment. Stripe has genuinely collected money against an
  -- attempt whose full immutable identity just matched; that money is
  -- recorded regardless of what happened to the local payment row's
  -- status since the Session was created (concurrent manual payment,
  -- price change, waiver, void). _recompute_payment_rollup (section 2)
  -- ensures the resulting status reflects this real, retained money
  -- rather than a stale void/waived label.
  update public.payment_checkout_attempts
     set status = 'completed',
         stripe_payment_intent_id = p_stripe_payment_intent_id,
         updated_at = now()
   where id = v_attempt.id;

  -- external_reference stores the Stripe CHECKOUT SESSION id (always
  -- non-null, unlike the PaymentIntent id) — see this function's own
  -- header comment for why.
  insert into public.payment_events (
    payment_id, club_id, event_type, amount_cents, external_reference, actor_id
  ) values (
    v_attempt.payment_id, v_attempt.club_id, 'online_payment_recorded',
    p_amount_total_cents, p_stripe_checkout_session_id, null
  );

  return query select false, true;
end;
$$;

revoke execute on function public.process_stripe_payment_event(text, text, boolean, text, text, text, integer, text) from public, anon, authenticated;
grant  execute on function public.process_stripe_payment_event(text, text, boolean, text, text, text, integer, text) to service_role;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback (manual, cloud SQL Editor) — every statement below is the exact,
-- genuinely executable pre-0150 (0143) text, copied verbatim, never a
-- placeholder. Uncomment and run top-to-bottom if 0150 must be reverted
-- after being applied.
-- ═══════════════════════════════════════════════════════════════════════════
-- begin;
--
-- drop function if exists public.process_stripe_payment_event(text, text, boolean, text, text, text, integer, text);
-- drop function if exists public.record_checkout_session_created(uuid, text, timestamptz);
-- drop function if exists public.supersede_checkout_attempt_and_open_fresh(uuid, uuid, uuid, text, boolean, uuid);
-- drop function if exists public.open_payment_checkout_attempt(uuid, uuid, text, boolean, uuid);
-- drop table if exists public.payment_checkout_attempts;
-- drop function if exists public.get_reservation_payment_for_checkout(uuid);
-- drop index if exists public.payment_events_online_payment_session_uniq;
--
-- create or replace function public._recompute_payment_rollup(p_payment_id uuid)
-- returns void
-- language plpgsql
-- security definer
-- set search_path to 'public', 'pg_temp'
-- as $$
-- declare
--   v_due    integer;
--   v_net    integer;
--   v_has_refund boolean;
--   v_void   boolean;
--   v_waived boolean;
--   v_status text;
-- begin
--   select amount_cents into v_due
--     from public.payment_events
--    where payment_id = p_payment_id
--      and event_type in ('obligation_created', 'obligation_amount_adjusted')
--      and id not in (
--        select reverses_event_id from public.payment_events where reverses_event_id is not null
--      )
--    order by created_at desc, id desc
--    limit 1;
--   v_due := coalesce(v_due, 0);
--
--   select
--     coalesce(sum(amount_cents) filter (where event_type = 'manual_payment_recorded'), 0)
--     - coalesce(sum(amount_cents) filter (where event_type = 'refund_recorded'), 0)
--     into v_net
--     from public.payment_events
--    where payment_id = p_payment_id
--      and id not in (
--        select reverses_event_id from public.payment_events where reverses_event_id is not null
--      );
--   v_net := coalesce(v_net, 0);
--
--   select exists(
--     select 1 from public.payment_events
--      where payment_id = p_payment_id and event_type = 'refund_recorded'
--        and id not in (
--          select reverses_event_id from public.payment_events where reverses_event_id is not null
--        )
--   ) into v_has_refund;
--
--   select exists(
--     select 1 from public.payment_events
--      where payment_id = p_payment_id and event_type = 'void_payment_obligation'
--        and id not in (
--          select reverses_event_id from public.payment_events where reverses_event_id is not null
--        )
--   ) into v_void;
--
--   select exists(
--     select 1 from public.payment_events
--      where payment_id = p_payment_id and event_type = 'waived'
--        and id not in (
--          select reverses_event_id from public.payment_events where reverses_event_id is not null
--        )
--   ) into v_waived;
--
--   if v_void then
--     v_status := 'void';
--   elsif v_waived then
--     v_status := 'waived';
--   elsif v_net > v_due then
--     v_status := 'overpaid';
--   elsif v_has_refund then
--     if v_net <= 0 then
--       v_status := 'refunded';
--     elsif v_net < v_due then
--       v_status := 'partially_refunded';
--     else
--       v_status := 'paid';
--     end if;
--   else
--     if v_net <= 0 then
--       v_status := 'unpaid';
--     elsif v_net < v_due then
--       v_status := 'partially_paid';
--     else
--       v_status := 'paid';
--     end if;
--   end if;
--
--   update public.payments
--      set amount_due_cents = v_due,
--          amount_paid_cents = v_net,
--          status = v_status
--    where id = p_payment_id;
-- end;
-- $$;
--
-- alter table public.payment_events
--   drop constraint payment_events_shape,
--   add  constraint payment_events_shape check (
--     case event_type
--       when 'obligation_created' then
--         amount_cents is not null and amount_cents > 0
--           and method is null and reverses_event_id is null
--           and external_reference is null
--       when 'obligation_amount_adjusted' then
--         amount_cents is not null and amount_cents >= 0
--           and method is null and reverses_event_id is null
--           and external_reference is null
--       when 'manual_payment_recorded' then
--         amount_cents is not null and amount_cents > 0
--           and method is not null and reverses_event_id is null
--       when 'refund_recorded' then
--         amount_cents is not null and amount_cents > 0
--           and reverses_event_id is null
--       when 'reverse_payment_event' then
--         amount_cents is null and method is null and external_reference is null
--           and reverses_event_id is not null
--       when 'waived' then
--         amount_cents is not null and amount_cents > 0
--           and method is null and reverses_event_id is null
--           and external_reference is null
--       when 'void_payment_obligation' then
--         amount_cents is not null and amount_cents > 0
--           and method is null and reverses_event_id is null
--           and external_reference is null
--       else false
--     end
--   );
--
-- alter table public.payment_events
--   drop constraint payment_events_event_type_check,
--   add  constraint payment_events_event_type_check
--        check (event_type in (
--          'obligation_created', 'obligation_amount_adjusted', 'manual_payment_recorded',
--          'refund_recorded', 'reverse_payment_event', 'void_payment_obligation', 'waived'
--        ));
--
-- commit;
