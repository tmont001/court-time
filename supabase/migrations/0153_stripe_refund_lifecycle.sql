-- 0153_stripe_refund_lifecycle.sql
-- Phase 34E-B — Stripe Refunds / Partial Refunds for Court Time Payments.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- AUDIT FINDINGS THIS MIGRATION IS BUILT ON
-- ═══════════════════════════════════════════════════════════════════════════
-- 1. record_refund (0143/0151) is LOCAL-LEDGER-ONLY — it never calls
--    Stripe and is not wired to any Server Action. It remains exactly
--    that: a manual/offline refund-recording tool for Admins returning
--    cash/check money outside Stripe. A distinct new ledger event type is
--    added for the Stripe path instead (see "online_refund_recorded"
--    below), exactly mirroring how 0150 gave online PAYMENTS their own
--    'online_payment_recorded' event type rather than overloading
--    'manual_payment_recorded'.
--
--    CORRECTION PASS: record_refund's PRE-EXISTING ceiling check compared
--    against payments.amount_paid_cents — the AGGREGATE rollup, which
--    nets manual AND online (Stripe) money together. That let this
--    Stripe-agnostic RPC falsely mark Stripe-collected money "refunded"
--    without ever calling Stripe. This migration therefore DOES redefine
--    record_refund (CREATE OR REPLACE, same signature/grants, base body
--    is the CURRENTLY-APPLIED 0151 text) — its ceiling now derives
--    exclusively from non-reversed manual_payment_recorded minus non-
--    reversed refund_recorded, structurally excluding online_payment_
--    recorded/online_refund_recorded entirely. See section 11 below for
--    the full rationale and worked examples.
--
-- 2. _recompute_payment_rollup (0150) already nets manual + online payments
--    minus refunds, and already derives 'refunded'/'partially_refunded' as
--    a distinct status branch (checked before the plain unpaid/partially_
--    paid/paid branch, and after 'overpaid') whenever a non-reversed
--    refund_recorded event exists. This state-machine logic is CORRECT
--    and is NOT redesigned here — only its two SUM/EXISTS inputs are
--    widened to also recognize the new 'online_refund_recorded' event
--    type, exactly mirroring 0150's own online_payment_recorded widening.
--
-- 3. CRITICAL AUDIT QUESTION, answered: does the existing rollup already
--    keep a refunded/partially_refunded payment non-collectible? YES.
--    Traced both UI eligibility paths:
--      - isReservationPaymentEligibleForCheckout (paymentsConfig.ts) gates
--        Pay Now on status IN ('unpaid','partially_paid') — 'refunded'/
--        'partially_refunded' are NOT in that list, so Pay Now can never
--        resurrect for a refunded payment.
--      - isPaymentOpenForRecording (payments.ts) gates the Admin "Record
--        Payment" button on the identical status allowlist — same result.
--    No contradiction found. No workaround needed. This migration widens
--    the rollup's INPUTS only; the state machine and both UI gates are
--    left completely untouched.
--
-- 4. Stripe-refundable money is NOT payments.amount_paid_cents (which nets
--    manual + online together). It is computed fresh, per completed
--    payment_checkout_attempts row, as that attempt's own amount_
--    expected_cents (== what Stripe actually collected for it, per 0150's
--    own amount_mismatch guard in process_stripe_payment_event) minus
--    every succeeded/in-flight refund attempt already opened against
--    THAT SAME attempt. A $20 manual + $80 Stripe payment can only ever
--    expose $80 (minus any prior online refunds) as Stripe-refundable —
--    the $20 manual portion is structurally unreachable by this migration's
--    RPCs, which never read or write manual_payment_recorded/refund_
--    recorded at all.
--
-- 5. Provenance: stripe_account_id/livemode/PaymentIntent for a refund are
--    read from the payment's own latest COMPLETED payment_checkout_
--    attempts row (0150) — never from the club's currently-configured
--    Stripe connection (club_stripe_accounts / get_club_stripe_account_ref,
--    0147). If a club ever reconnected Stripe under a different account,
--    an old payment's refund still correctly targets the account that
--    actually collected it.
--
-- 6. 34E-A interaction: none of this migration's RPCs mutate amount_due_
--    cents/amount_paid_cents/status on a payments row via the same code
--    paths 34E-A guards (record_manual_payment/waive_payment/void_payment_
--    obligation/record_refund/reverse_payment_event/update_member_
--    reservation/admin_update_member_lesson) — refund creation inserts
--    into a NEW table and, on success, a NEW distinct payment_events type,
--    reusing the SAME payment_events_after_insert trigger. 34E-A's guard
--    (_invalidate_or_flag_open_checkout_attempt) is NOT invoked here: a
--    refund does not compete with an OPEN Checkout attempt the way a
--    manual-payment/waive/void/price-edit does — a refund can only ever
--    target an attempt that is already 'completed' (money already
--    collected), which by definition cannot also be the club's one
--    allowed-open 'open' attempt (payment_checkout_attempts_one_open_per_
--    payment, 0150, enforces at most one 'open' row per payment; a
--    'completed' row is a different row, or the SAME row already resolved
--    out of 'open'). No new interaction to guard, and 34E-A itself is not
--    modified anywhere in this migration.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHITECTURE
-- ═══════════════════════════════════════════════════════════════════════════
-- New table payment_refund_attempts — deny-all RLS, service-role-only
-- writes, mirroring payment_checkout_attempts' own discipline exactly.
-- Durable provenance + idempotency identity for exactly one Stripe refund
-- attempt: source_checkout_attempt_id (the trusted completed attempt this
-- refund targets), stripe_account_id/livemode/stripe_payment_intent_id
-- (all SNAPSHOTTED from that source attempt, never re-derived), requested_
-- amount_cents, status (Stripe's own five documented Refund.status values
-- — pending/requires_action/succeeded/failed/canceled, never invented),
-- stripe_refund_id (nullable until Stripe responds).
--
-- Seven new RPCs, one redefined RPC, two new internal helpers:
--   open_payment_refund_attempt       — service-role. Locks payments,
--     resolves/locks the source completed attempt, computes the online-
--     refundable ceiling for THAT attempt, validates the requested amount,
--     and either REUSES an existing not-yet-resolved ('pending', unbound)
--     attempt row for this payment for the SAME requested amount
--     (double-submit / retry-after-uncertainty safety — never mints a
--     second idempotency key for what may be the same in-flight Stripe
--     request), or FAILS CLOSED before any Stripe call when a different
--     amount is requested against that same unresolved attempt (never
--     silently substitutes the Admin's newly-requested amount onto an
--     attempt that may already be in flight for a different one), or
--     inserts a fresh attempt row.
--   backfill_refund_attempt_payment_intent — service-role, narrow. Called
--     by the Server Action, BEFORE ever calling stripe.refunds.create(),
--     when the source attempt's own stripe_payment_intent_id was null
--     (0150's own established nullable-PaymentIntent finding) and had to
--     be resolved fresh via a trusted Session retrieve — persists that
--     resolved PaymentIntent onto BOTH the refund attempt and its source
--     Checkout attempt, so it is never merely held in memory and never a
--     reason to fall back to trusting metadata.
--   mark_refund_attempt_local_failure — service-role. Only for a failure
--     BEFORE any Stripe API call was ever made (e.g. no PaymentIntent
--     could be resolved) — never called after stripe.refunds.create() has
--     been attempted, since that must always be safely retried via the
--     SAME pending row/idempotency key instead of ever being guessed at
--     as "failed" while Stripe's own outcome remains genuinely unknown.
--   bind_stripe_refund_result         — service-role. The Server Action's
--     own synchronous path, called immediately after stripe.refunds.
--     create() returns. Reconciles from that response's CURRENT state.
--     Trusts its own p_refund_attempt_id directly for RESOLUTION (a
--     same-request, server-generated value, never attacker-influenceable
--     — unlike the webhook path's metadata below), but still passes the
--     Refund's own reported PaymentIntent through for VALIDATION.
--   process_stripe_refund_webhook_event — service-role. The asynchronous
--     webhook path for refund.created/refund.updated/refund.failed. The
--     Route Handler RETRIEVES the Refund fresh from Stripe (never trusts
--     the event payload's own point-in-time snapshot — Stripe does not
--     guarantee webhook delivery ordering) and passes that CURRENT state
--     in. Dedupes on Stripe's own event id (stripe_event_receipts, reused
--     unchanged), then ALWAYS resolves the target attempt via
--     _resolve_or_import_refund_attempt_by_provenance — PaymentIntent/
--     account/livemode matching against a completed Court Time attempt,
--     NEVER the verified Refund's own metadata (a client-set, forgeable
--     Stripe field). A metadata-supplied candidate id, if present, is
--     only ever verified against that independently-resolved truth —
--     never used to resolve or override it; a mismatch fails closed.
--   get_online_refundable_amount_for_payments — authenticated, Admin/
--     Staff-role-checked internally (pure ledger read, no Stripe identity
--     involved — matches this schema's established authenticated-grant
--     category for non-livemode-sensitive reads, e.g. get_payment_states_
--     for_domains). The one sanctioned read path for "how much online
--     money can still be refunded," so /admin/payments never has to guess
--     from raw table access.
--   record_refund (0143/0151, REDEFINED — see finding 1 above and
--     section 11) — authenticated, Admin-only, unchanged grants. Still
--     local-ledger-only; its refund ceiling now derives exclusively from
--     manual/offline ledger events, never online (Stripe) ones.
--
-- Both money-moving entry RPCs (bind_stripe_refund_result, process_
-- stripe_refund_webhook_event) funnel through ONE shared internal helper,
-- _reconcile_stripe_refund_attempt, so the exactly-once/idempotent-
-- regardless-of-caller/terminal-state-safe/PaymentIntent-validated
-- reconciliation logic exists in exactly one place. A second internal
-- helper, _resolve_or_import_refund_attempt_by_provenance, resolves (by
-- PaymentIntent/account/livemode match, NEVER metadata) or imports the
-- target attempt before that same shared reconciler ever runs — serving
-- BOTH Court-Time-initiated and Dashboard-initiated webhook reconciliation
-- uniformly. BOTH internal helpers are revoked from public, anon,
-- authenticated, AND service_role — the 0152 lesson applied from the
-- start: a helper meant to be reachable only transitively must have
-- EVERY role's EXPLICIT grant revoked, not merely PUBLIC's.
--
-- Exactly-once ledger crediting: a partial unique index on payment_events
-- (club_id, external_reference) where event_type = 'online_refund_
-- recorded' (external_reference always the Stripe Refund id for this
-- event type — required, non-null, exactly mirroring online_payment_
-- recorded's own required Session-id external_reference) — the SAME
-- pattern as 0150's payment_events_online_payment_session_uniq, scoped to
-- the new event type only, so legacy record_refund's own free-text/
-- reusable external_reference is completely unaffected. Backed by the
-- application-level "was this attempt already 'succeeded' before this
-- call" idempotency check inside _reconcile_stripe_refund_attempt, mirror-
-- ing process_stripe_payment_event's own completed-attempt-no-op pattern.
--
-- Concurrency / over-refund: the online-refundable ceiling is computed
-- under the SAME canonical payments-row lock every other payment RPC in
-- this schema already takes first — no new locking primitive. A second,
-- concurrent open_payment_refund_attempt call for the same payment blocks
-- on that row lock until the first transaction commits or rolls back, so
-- it always sees the first attempt's newly-reserved amount before
-- deciding whether a further refund still fits. A DB backstop mirrors
-- payment_checkout_attempts_one_open_per_payment exactly: at most one
-- unresolved ('pending', unbound) refund attempt may exist per payment at
-- any time (payment_refund_attempts_one_pending_per_payment).
--
-- Idempotent Stripe creation: the Server Action derives the Stripe
-- idempotency key as `payment-refund:<refundAttemptId>` — stable across
-- retries because a retry always reuses the SAME (open_payment_refund_
-- attempt-returned) attempt row rather than minting a new one.
--
-- record_refund (0143/0151) is redefined (correction pass, section 11) to
-- close the manual/online refund-ceiling gap described in finding 1
-- above, but remains exclusively a manual/offline ledger-recording tool
-- — it still never calls Stripe.
--
-- Out of scope (explicit, matching the 34E-B task boundary): disputes,
-- the member-facing /payments page, broad admin/payments filtering or
-- export redesign, discounts/adjustments.
--
-- Apply in Supabase SQL Editor (cloud only).

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. payment_events — widen event_type/shape to add online_refund_recorded
-- ═══════════════════════════════════════════════════════════════════════════
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'payment_events_event_type_check'
       and conrelid = 'public.payment_events'::regclass
  ) then
    raise exception 'expected constraint payment_events_event_type_check not found on public.payment_events — 0153 must be corrected with the real constraint name before applying';
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
         'online_refund_recorded',
         'reverse_payment_event',
         'void_payment_obligation',
         'waived'
       ));

-- Shape mirrors online_payment_recorded exactly (0150): method stays
-- NULL — a Stripe refund is never attributed to a
-- cash/check/card_terminal/... method, the event_type itself already says
-- how it moved — and external_reference is REQUIRED non-null, always the
-- Stripe REFUND id (_reconcile_stripe_refund_attempt, section 5, never
-- inserts this event type without one). Visible only to Admin/Staff
-- (payment_events RLS, 0143 — no new exposure).
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
      when 'online_refund_recorded' then
        amount_cents is not null and amount_cents > 0
          and method is null and reverses_event_id is null
          and external_reference is not null
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

-- Exactly-once ledger crediting per Stripe Refund id (locked decision 9).
-- Mirrors payment_events_online_payment_session_uniq (0150) exactly,
-- scoped to the new event type only — legacy refund_recorded's own
-- unconstrained, frequently-reused external_reference is untouched.
create unique index payment_events_online_refund_session_uniq
  on public.payment_events (club_id, external_reference)
  where event_type = 'online_refund_recorded';

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. _recompute_payment_rollup — widened to also net online_refund_recorded
-- ═══════════════════════════════════════════════════════════════════════════
-- Exact live body from 0150, changed in exactly two places: the v_net
-- negative-sum FILTER and the v_has_refund EXISTS check now also
-- recognize 'online_refund_recorded' alongside 'refund_recorded'. Same
-- signature, so CREATE OR REPLACE preserves the existing payment_events_
-- after_insert trigger binding untouched. The status-precedence state
-- machine itself (void > waived > overpaid > refunded/partially_refunded
-- > paid/partially_paid/unpaid) is NOT touched — see this migration's own
-- header comment, finding 2/3, for why that would be a redesign this
-- migration deliberately does not make.
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
    - coalesce(sum(amount_cents) filter (where event_type in ('refund_recorded', 'online_refund_recorded')), 0)
    into v_net
    from public.payment_events
   where payment_id = p_payment_id
     and id not in (
       select reverses_event_id from public.payment_events where reverses_event_id is not null
     );
  v_net := coalesce(v_net, 0);

  select exists(
    select 1 from public.payment_events
     where payment_id = p_payment_id and event_type in ('refund_recorded', 'online_refund_recorded')
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
-- 3. payment_refund_attempts — durable refund provenance + idempotency model
-- ═══════════════════════════════════════════════════════════════════════════
create table public.payment_refund_attempts (
  id                          uuid        primary key default gen_random_uuid(),
  club_id                     uuid        not null references public.clubs(id) on delete cascade,
  payment_id                  uuid        not null,

  -- Trusted provenance (locked decision 3/5) — the SPECIFIC completed
  -- online payment this refund targets. Never the club's current Stripe
  -- connection.
  source_checkout_attempt_id  uuid        not null references public.payment_checkout_attempts(id),

  -- Snapshotted from the source attempt at open_payment_refund_attempt
  -- time — immutable thereafter, exactly like payment_checkout_attempts'
  -- own stripe_account_id/livemode snapshot discipline (0150).
  stripe_account_id           text        not null,
  livemode                    boolean     not null,
  -- May be NULL at open-time (Stripe documents PaymentIntent as nullable
  -- even on a paid Session, 0150's own established finding) — the Server
  -- Action resolves it fresh via a Session retrieve before ever calling
  -- Stripe's refund API if so; this column is NOT re-validated to be
  -- non-null at the DB layer, since resolving it is an application-layer
  -- Stripe round-trip, not something Postgres can do.
  stripe_payment_intent_id    text,

  -- NULL until Stripe responds (bind_stripe_refund_result) or a webhook
  -- delivers it first (process_stripe_refund_webhook_event, race C).
  -- Globally unique once set — two different attempts must never claim
  -- the same Stripe Refund.
  stripe_refund_id            text        unique,

  requested_amount_cents      integer     not null check (requested_amount_cents > 0),

  -- Correction pass — a club's Full Stripe Dashboard access means a
  -- refund against a Court Time charge can be created entirely outside
  -- Court Time. 'stripe_dashboard' rows are IMPORTED (already bound to a
  -- real stripe_refund_id at insert time) by _find_or_import_dashboard_
  -- refund_attempt (section 6a) rather than opened speculatively by
  -- open_payment_refund_attempt — never a second, competing creation
  -- path, purely a provenance label.
  initiated_via                text        not null default 'court_time'
                                 check (initiated_via in ('court_time', 'stripe_dashboard')),

  -- Stripe's own five documented Refund.status values (installed SDK,
  -- Refunds.d.ts) — never invented. 'pending' is also this row's own
  -- honest initial value between "Court Time intends to refund" and
  -- "Stripe has responded at all".
  status                       text        not null default 'pending'
                                 check (status in ('pending', 'requires_action', 'succeeded', 'failed', 'canceled')),

  -- Set only by mark_refund_attempt_local_failure (a failure BEFORE any
  -- Stripe API call — e.g. PaymentIntent unresolvable) or relayed from
  -- Stripe's own Refund.failure_reason on a genuine 'failed' status.
  failure_reason               text,
  -- Admin's own free-text note — distinct from and never sent as Stripe's
  -- own constrained `reason` enum (duplicate/fraudulent/requested_by_
  -- customer), which this integration does not set at all.
  admin_reason                  text,

  created_by                   uuid        references public.profiles(id),
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),

  foreign key (payment_id, club_id) references public.payments(id, club_id)
);

-- Hard DB backstop (locked decision 5): at most one UNRESOLVED refund
-- attempt per payment at any time — mirrors payment_checkout_attempts_
-- one_open_per_payment (0150) exactly. The owning RPC additionally
-- serializes concurrent callers via the payments row lock before ever
-- reaching this table, so this index is defense in depth, not the only
-- guard.
create unique index payment_refund_attempts_one_pending_per_payment
  on public.payment_refund_attempts (payment_id)
  where stripe_refund_id is null and status = 'pending';

create index payment_refund_attempts_payment_idx on public.payment_refund_attempts (payment_id);
create index payment_refund_attempts_club_idx on public.payment_refund_attempts (club_id);
create index payment_refund_attempts_source_attempt_idx on public.payment_refund_attempts (source_checkout_attempt_id);

create trigger payment_refund_attempts_updated_at
  before update on public.payment_refund_attempts
  for each row execute function public.trigger_set_updated_at();

alter table public.payment_refund_attempts enable row level security;
-- No policies: deny-all direct client access by design, identical to
-- payment_checkout_attempts / club_stripe_accounts / stripe_event_
-- receipts. service_role is untouched by this revoke — every read/write
-- goes through the SECURITY DEFINER RPCs below.
revoke all on public.payment_refund_attempts from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. open_payment_refund_attempt — service-role-only
-- ═══════════════════════════════════════════════════════════════════════════
-- Resolves the payment's own latest COMPLETED online attempt as trusted
-- refund provenance, computes that attempt's own remaining Stripe-
-- refundable ceiling (its amount_expected_cents — what Stripe actually
-- collected, per 0150's own amount_mismatch guard — minus every succeeded
-- or still-in-flight refund attempt already opened against it), and
-- either reuses an existing unresolved ('pending', unbound) attempt for
-- this payment (double-submit / retry-after-network-uncertainty safety —
-- 34E-B failure-recovery scenarios D/E — never mints a second Stripe
-- idempotency key for what may be the same in-flight request) or opens a
-- fresh one. Canonical lock order (payments -> payment_checkout_attempts
-- -> payment_refund_attempts, extending 0150's own convention) — the
-- `for update` lock on payments already serializes any two concurrent
-- callers for the SAME payment_id, which is what makes the refundable-
-- ceiling computation below immune to concurrent over-refund (locked
-- decision 5): a second caller blocks until the first's transaction
-- commits or rolls back, and then sees the first's newly-reserved amount.
--
-- Correction pass — reuse is SAFE ONLY when the retried request is for
-- the SAME amount as the still-unresolved attempt. A pending/unbound
-- attempt already represents a specific, possibly-already-in-flight
-- Stripe request; silently substituting a NEW Admin-requested amount
-- onto that SAME attempt (and therefore the SAME idempotency key) would
-- either desync from what the Admin currently intends, or — if the
-- earlier request actually reaches Stripe first — refund the WRONG
-- amount under a key the Admin believes corresponds to their newer
-- request. A mismatched amount fails closed, before any Stripe call,
-- rather than ever guessing which amount the Admin actually wants.
create or replace function public.open_payment_refund_attempt(
  p_payment_id             uuid,
  p_club_id                uuid,
  p_requested_amount_cents integer,
  p_actor_id               uuid,
  p_admin_reason           text default null
)
returns table (
  id                          uuid,
  payment_id                  uuid,
  club_id                      uuid,
  source_checkout_attempt_id  uuid,
  stripe_account_id            text,
  livemode                     boolean,
  stripe_checkout_session_id   text,
  stripe_payment_intent_id     text,
  requested_amount_cents       integer,
  status                       text,
  currency                     text
)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_payment          public.payments%rowtype;
  v_source           public.payment_checkout_attempts%rowtype;
  v_existing_pending public.payment_refund_attempts%rowtype;
  v_reserved_total    integer;
  v_refundable         integer;
  v_result_id           uuid;
begin
  if p_payment_id is null or p_club_id is null or p_actor_id is null then
    raise exception 'invalid_arguments';
  end if;

  if p_requested_amount_cents is null or p_requested_amount_cents <= 0 then
    raise exception 'invalid_refund_amount';
  end if;

  select * into v_payment
    from public.payments p
   where p.id = p_payment_id and p.club_id = p_club_id
   for update;
  if not found then
    raise exception 'payment_not_found';
  end if;

  -- Reuse-before-create: never mint a second idempotency key for what may
  -- be the same in-flight Stripe request (locked decisions 6, 7 D/E) —
  -- but ONLY when the retried request is for the identical amount (see
  -- this function's own header comment). A different amount fails
  -- closed, before any Stripe call and before this existing attempt's
  -- own financial identity is ever touched.
  select * into v_existing_pending
    from public.payment_refund_attempts
   where payment_id = p_payment_id and stripe_refund_id is null and status = 'pending'
   for update;

  if found then
    if v_existing_pending.requested_amount_cents <> p_requested_amount_cents then
      raise exception 'pending_refund_amount_mismatch';
    end if;
    select * into v_source from public.payment_checkout_attempts where id = v_existing_pending.source_checkout_attempt_id;
    return query select
      v_existing_pending.id, v_existing_pending.payment_id, v_existing_pending.club_id,
      v_existing_pending.source_checkout_attempt_id, v_existing_pending.stripe_account_id,
      v_existing_pending.livemode, v_source.stripe_checkout_session_id, v_existing_pending.stripe_payment_intent_id,
      v_existing_pending.requested_amount_cents, v_existing_pending.status, v_payment.currency;
    return;
  end if;

  -- Trusted provenance (locked decision 3/5): the payment's own latest
  -- COMPLETED online attempt — never the club's currently-configured
  -- Stripe connection.
  select * into v_source
    from public.payment_checkout_attempts
   where payment_id = p_payment_id and status = 'completed'
   order by created_at desc
   limit 1
   for update;
  if not found then
    raise exception 'no_online_payment_to_refund';
  end if;

  -- Stripe-refundable ceiling for THIS specific completed attempt only
  -- (locked decision 1) — never payments.amount_paid_cents, which nets
  -- manual money in too.
  select coalesce(sum(requested_amount_cents), 0) into v_reserved_total
    from public.payment_refund_attempts
   where source_checkout_attempt_id = v_source.id
     and status in ('succeeded', 'pending', 'requires_action');

  v_refundable := v_source.amount_expected_cents - v_reserved_total;
  if p_requested_amount_cents > v_refundable then
    raise exception 'refund_exceeds_online_remaining';
  end if;

  insert into public.payment_refund_attempts (
    club_id, payment_id, source_checkout_attempt_id, stripe_account_id, livemode,
    stripe_payment_intent_id, requested_amount_cents, status, admin_reason, created_by
  ) values (
    p_club_id, p_payment_id, v_source.id, v_source.stripe_account_id, v_source.livemode,
    v_source.stripe_payment_intent_id, p_requested_amount_cents, 'pending', p_admin_reason, p_actor_id
  ) returning id into v_result_id;

  return query select
    v_result_id, p_payment_id, p_club_id, v_source.id, v_source.stripe_account_id,
    v_source.livemode, v_source.stripe_checkout_session_id, v_source.stripe_payment_intent_id,
    p_requested_amount_cents, 'pending'::text, v_payment.currency;
end;
$$;

revoke execute on function public.open_payment_refund_attempt(uuid, uuid, integer, uuid, text) from public, anon, authenticated;
grant  execute on function public.open_payment_refund_attempt(uuid, uuid, integer, uuid, text) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4a. backfill_refund_attempt_payment_intent — service-role-only, narrow
-- ═══════════════════════════════════════════════════════════════════════════
-- Correction pass — 0150 deliberately allows a completed Checkout
-- attempt to have a NULL stripe_payment_intent_id (Stripe documents
-- PaymentIntent as nullable even for a paid Session). When refund
-- creation resolves it fresh (retrieving the trusted SOURCE Checkout
-- Session), that resolved PaymentIntent must be durably persisted BEFORE
-- refunds.create() is ever called — never merely held in memory, and
-- never a reason to fall back to trusting metadata instead. This is that
-- narrow, single-purpose persistence boundary: it backfills BOTH the
-- payment_refund_attempts row's own snapshot (used by _reconcile_stripe_
-- refund_attempt's PaymentIntent validation, section 6) AND the SOURCE
-- payment_checkout_attempts row itself (used by _resolve_or_import_
-- refund_attempt_by_provenance's own matching query, section 8, so a
-- LATER refund — Court-Time-initiated or Dashboard-initiated — against
-- the SAME source attempt can still be correctly provenance-matched).
--
-- Idempotent-safe: a KNOWN non-null value is never overwritten (only a
-- genuine identity conflict — a different PaymentIntent than what is
-- already stored — raises payment_intent_mismatch); re-calling with the
-- SAME value already stored is a harmless no-op.
create or replace function public.backfill_refund_attempt_payment_intent(
  p_refund_attempt_id          uuid,
  p_stripe_payment_intent_id   text
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_attempt public.payment_refund_attempts%rowtype;
  v_payment public.payments%rowtype;
begin
  if p_refund_attempt_id is null or p_stripe_payment_intent_id is null then
    raise exception 'invalid_arguments';
  end if;

  select * into v_attempt from public.payment_refund_attempts where id = p_refund_attempt_id;
  if not found then
    raise exception 'refund_attempt_not_found';
  end if;

  select * into v_payment from public.payments where id = v_attempt.payment_id for update;

  if v_attempt.stripe_payment_intent_id is not null then
    if v_attempt.stripe_payment_intent_id <> p_stripe_payment_intent_id then
      raise exception 'payment_intent_mismatch';
    end if;
    return; -- already correctly set — idempotent no-op.
  end if;

  update public.payment_refund_attempts
     set stripe_payment_intent_id = p_stripe_payment_intent_id, updated_at = now()
   where id = p_refund_attempt_id;

  update public.payment_checkout_attempts
     set stripe_payment_intent_id = p_stripe_payment_intent_id, updated_at = now()
   where id = v_attempt.source_checkout_attempt_id
     and stripe_payment_intent_id is null;
end;
$$;

revoke execute on function public.backfill_refund_attempt_payment_intent(uuid, text) from public, anon, authenticated;
grant  execute on function public.backfill_refund_attempt_payment_intent(uuid, text) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. mark_refund_attempt_local_failure — service-role-only
-- ═══════════════════════════════════════════════════════════════════════════
-- Only for a failure BEFORE any Stripe API call was ever made (e.g. no
-- PaymentIntent could be resolved for the source attempt) — raises if a
-- Stripe Refund id is already bound, since once Stripe has been asked to
-- create a refund, its outcome must be learned from Stripe itself
-- (bind_stripe_refund_result / process_stripe_refund_webhook_event),
-- never guessed at locally.
create or replace function public.mark_refund_attempt_local_failure(
  p_refund_attempt_id uuid,
  p_failure_reason     text
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_attempt public.payment_refund_attempts%rowtype;
begin
  if p_refund_attempt_id is null then
    raise exception 'invalid_arguments';
  end if;

  select * into v_attempt from public.payment_refund_attempts where id = p_refund_attempt_id for update;
  if not found then
    raise exception 'refund_attempt_not_found';
  end if;

  if v_attempt.stripe_refund_id is not null then
    raise exception 'refund_already_submitted_to_stripe';
  end if;

  update public.payment_refund_attempts
     set status = 'failed', failure_reason = p_failure_reason, updated_at = now()
   where id = p_refund_attempt_id;
end;
$$;

revoke execute on function public.mark_refund_attempt_local_failure(uuid, text) from public, anon, authenticated;
grant  execute on function public.mark_refund_attempt_local_failure(uuid, text) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. Internal helper — _reconcile_stripe_refund_attempt
-- ═══════════════════════════════════════════════════════════════════════════
-- The ONE place refund state is reconciled from Stripe's CURRENT report —
-- called by both bind_stripe_refund_result (synchronous, right after
-- stripe.refunds.create() returns) and process_stripe_refund_webhook_event
-- (asynchronous, refund.created/updated/failed), so their idempotent-
-- regardless-of-ordering behavior can never drift apart. Revoked from
-- EVERY role including service_role (the 0152 lesson, applied from the
-- start) — reachable only transitively via the two wrapper RPCs below.
--
-- Lookup prefers an already-bound match by stripe_refund_id (a later or
-- duplicate event for a refund this function already knows about); falls
-- back to p_refund_attempt_id (the first-ever reconciliation, which may
-- race between the Server Action's own synchronous bind and an early
-- webhook delivery — failure-recovery scenario C). Canonical lock order
-- (payments -> payment_refund_attempts): a plain non-locking SELECT
-- identifies which payment owns the target row (mirrors process_stripe_
-- payment_event's own non-locking-lookup-then-lock-payments-first
-- pattern, 0150, to avoid a deadlock opportunity against open_payment_
-- refund_attempt's own payments-first order), then payments is locked,
-- then the refund-attempt row is re-locked and revalidated.
--
-- Immutable-identity validation (stripe_account_id, livemode, currency,
-- and — correction pass — PaymentIntent) runs before ever treating an
-- already-terminal attempt as a no-op — identical discipline to
-- process_stripe_payment_event, so a terminal state can never be used to
-- smuggle mismatched data past validation. amount is validated to MATCH
-- the originally requested amount — a genuine mismatch fails loud
-- (retryable) rather than silently recording a different amount than
-- what was actually requested.
--
-- PaymentIntent validation (correction pass) — the CURRENT Stripe
-- Refund's own reported payment_intent must match the attempt's own
-- stored one whenever BOTH are known; this closes the residual gap where
-- neither the webhook's provenance-matching resolver nor the Server
-- Action's own trusted attempt id happened to catch a genuine identity
-- conflict. A known non-null stored PaymentIntent is never silently
-- overwritten by a DIFFERENT reported one (raises payment_intent_
-- mismatch, fails BEFORE any status/ledger mutation) — only a null-to-
-- non-null backfill is ever applied, mirroring process_stripe_payment_
-- event's own established PaymentIntent-consistency discipline (0150).
--
-- Terminal-state safety (correction pass) — 'succeeded', 'failed', and
-- 'canceled' are all Stripe-FINAL for a given Refund object: a succeeded
-- refund never un-succeeds; a failed/canceled refund never itself
-- resumes (a genuine retry creates an entirely new Stripe Refund id).
-- Once v_old_status is any of these three, THIS FUNCTION RETURNS
-- WITHOUT MUTATING status AT ALL — a stale/out-of-order event (e.g. a
-- 'pending' snapshot delivered after a 'succeeded' one, per Stripe's own
-- non-guaranteed webhook ordering) can never regress a terminal status,
-- and — because the ledger-insert guard is only ever reached for a
-- genuinely NEW transition into 'succeeded' below — a second delivery
-- reporting 'succeeded' again can never attempt a second ledger insert.
-- The one exception: a 'failed' attempt whose failure_reason was not yet
-- captured may still have it filled in by a later delivery of the SAME
-- terminal status, without touching status itself.
--
-- Ledger rule (locked decision 10): the online_refund_recorded ledger
-- event is inserted exactly once — only on the transition INTO
-- 'succeeded' from a non-terminal old status — never for pending/
-- requires_action, and structurally never reachable a second time for an
-- already-succeeded attempt (the terminal-state return above).
create or replace function public._reconcile_stripe_refund_attempt(
  p_refund_attempt_id uuid,
  p_stripe_refund_id   text,
  p_status              text,
  p_amount_cents        integer,
  p_stripe_account_id   text,
  p_livemode            boolean,
  p_currency            text,
  p_failure_reason      text default null,
  p_stripe_payment_intent_id text default null
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_lookup_payment_id uuid;
  v_payment            public.payments%rowtype;
  v_attempt            public.payment_refund_attempts%rowtype;
  v_old_status         text;
begin
  if p_status is null or p_amount_cents is null or p_stripe_account_id is null
     or p_livemode is null or p_currency is null then
    raise exception 'invalid_arguments';
  end if;
  if p_refund_attempt_id is null and p_stripe_refund_id is null then
    raise exception 'invalid_arguments';
  end if;
  if p_status not in ('pending', 'requires_action', 'succeeded', 'failed', 'canceled') then
    raise exception 'invalid_status';
  end if;

  select payment_id into v_lookup_payment_id
    from public.payment_refund_attempts
   where (p_stripe_refund_id is not null and stripe_refund_id = p_stripe_refund_id)
      or (p_refund_attempt_id is not null and id = p_refund_attempt_id)
   limit 1;

  if v_lookup_payment_id is null then
    raise exception 'refund_attempt_not_found';
  end if;

  select * into v_payment from public.payments where id = v_lookup_payment_id for update;
  if not found then
    raise exception 'payment_not_found';
  end if;

  select * into v_attempt
    from public.payment_refund_attempts
   where payment_id = v_payment.id
     and (
       (p_stripe_refund_id is not null and stripe_refund_id = p_stripe_refund_id)
       or (p_refund_attempt_id is not null and id = p_refund_attempt_id)
     )
   for update;
  if not found then
    raise exception 'refund_attempt_not_found';
  end if;

  if v_attempt.stripe_account_id <> p_stripe_account_id then
    raise exception 'stripe_account_mismatch';
  end if;

  if v_attempt.livemode <> p_livemode then
    raise exception 'livemode_mismatch';
  end if;

  -- PaymentIntent provenance validation (correction pass) — see this
  -- function's own header comment. Runs BEFORE any status/ledger
  -- mutation.
  if v_attempt.stripe_payment_intent_id is not null
     and p_stripe_payment_intent_id is not null
     and v_attempt.stripe_payment_intent_id <> p_stripe_payment_intent_id then
    raise exception 'payment_intent_mismatch';
  end if;

  if upper(p_currency) <> v_payment.currency then
    raise exception 'currency_mismatch';
  end if;

  if v_attempt.requested_amount_cents <> p_amount_cents then
    raise exception 'refund_amount_mismatch';
  end if;

  -- Backfill a previously-unknown PaymentIntent now that Stripe has
  -- genuinely confirmed it — never required before this point since
  -- refundActions.ts already backfills it via backfill_refund_attempt_
  -- payment_intent (section 5a) BEFORE ever calling refunds.create(); a
  -- Dashboard-imported row always carries its PaymentIntent from import
  -- time. This is defense in depth for any residual gap, mirroring
  -- process_stripe_payment_event's own null-to-non-null backfill
  -- discipline (0150) — never overwrites a KNOWN value (guarded above).
  if v_attempt.stripe_payment_intent_id is null and p_stripe_payment_intent_id is not null then
    update public.payment_refund_attempts
       set stripe_payment_intent_id = p_stripe_payment_intent_id, updated_at = now()
     where id = v_attempt.id;
  end if;

  if v_attempt.stripe_refund_id is null then
    if p_stripe_refund_id is null then
      raise exception 'invalid_arguments';
    end if;
    update public.payment_refund_attempts
       set stripe_refund_id = p_stripe_refund_id
     where id = v_attempt.id;
  elsif p_stripe_refund_id is not null and v_attempt.stripe_refund_id <> p_stripe_refund_id then
    raise exception 'refund_id_mismatch';
  end if;

  v_old_status := v_attempt.status;

  -- Terminal-state safety backstop — see this function's own header
  -- comment. Nothing below this point runs once a terminal status has
  -- already been recorded.
  if v_old_status in ('succeeded', 'failed', 'canceled') then
    if v_old_status = 'failed' and p_status = 'failed'
       and p_failure_reason is not null and v_attempt.failure_reason is null then
      update public.payment_refund_attempts
         set failure_reason = p_failure_reason, updated_at = now()
       where id = v_attempt.id;
    end if;
    return;
  end if;

  update public.payment_refund_attempts
     set status = p_status,
         failure_reason = coalesce(p_failure_reason, failure_reason),
         updated_at = now()
   where id = v_attempt.id;

  if p_status = 'succeeded' then
    insert into public.payment_events (
      payment_id, club_id, event_type, amount_cents, external_reference, actor_id
    ) values (
      v_attempt.payment_id, v_attempt.club_id, 'online_refund_recorded',
      p_amount_cents, p_stripe_refund_id, null
    );
  end if;
end;
$$;

revoke all on function public._reconcile_stripe_refund_attempt(uuid, text, text, integer, text, boolean, text, text, text)
  from public, anon, authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. bind_stripe_refund_result — service-role-only
-- ═══════════════════════════════════════════════════════════════════════════
-- Called by the Server Action immediately after its own stripe.refunds.
-- create() call returns — reconciles from that response's CURRENT state.
-- The Server Action's own p_refund_attempt_id is trusted directly for
-- RESOLUTION (unlike the webhook path's metadata — this value is the
-- Server Action's own same-request, server-generated RPC return value
-- from open_payment_refund_attempt, never attacker-influenceable). The
-- correction pass instead extends VALIDATION here: p_stripe_payment_
-- intent_id (Stripe's own reported PaymentIntent on the just-created
-- Refund) is passed through to the shared helper, which confirms it
-- matches trusted original-transaction provenance before ever mutating
-- status/ledger — closing the residual gap where a resolution that was
-- never in doubt could still, in principle, be refunding the wrong
-- PaymentIntent.
create or replace function public.bind_stripe_refund_result(
  p_refund_attempt_id uuid,
  p_stripe_refund_id   text,
  p_status              text,
  p_amount_cents        integer,
  p_stripe_account_id   text,
  p_livemode            boolean,
  p_currency            text,
  p_failure_reason      text default null,
  p_stripe_payment_intent_id text default null
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if p_refund_attempt_id is null or p_stripe_refund_id is null then
    raise exception 'invalid_arguments';
  end if;
  perform public._reconcile_stripe_refund_attempt(
    p_refund_attempt_id, p_stripe_refund_id, p_status, p_amount_cents,
    p_stripe_account_id, p_livemode, p_currency, p_failure_reason, p_stripe_payment_intent_id
  );
end;
$$;

revoke execute on function public.bind_stripe_refund_result(uuid, text, text, integer, text, boolean, text, text, text) from public, anon, authenticated;
grant  execute on function public.bind_stripe_refund_result(uuid, text, text, integer, text, boolean, text, text, text) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 8. Internal helper — _resolve_or_import_refund_attempt_by_provenance
-- ═══════════════════════════════════════════════════════════════════════════
-- Correction pass — the SOLE resolution mechanism for the webhook path.
-- Metadata (a client-set Stripe field, forgeable by anyone with API/
-- Dashboard access to the connected account) is NEVER used to resolve
-- which local attempt a Refund belongs to. The only trustworthy signal is
-- the verified Refund's own payment_intent, matched server-side against a
-- COMPLETED Court Time payment_checkout_attempts row by (stripe_payment_
-- intent_id, stripe_account_id, livemode). This single provenance match
-- correctly resolves THREE distinct cases:
--   1. Already-bound (a later/duplicate event for a refund this function
--      already resolved once, Court-Time-initiated OR Dashboard-
--      imported) — matched directly by stripe_refund_id, no PI lookup
--      needed.
--   2. Court-Time-initiated, first reconciliation — open_payment_refund_
--      attempt already opened a 'pending', unbound payment_refund_
--      attempts row against the SAME source_checkout_attempt_id the PI
--      match resolves to. That row is returned to be bound, entirely
--      independent of whatever the Refund's own metadata claims.
--   3. Dashboard-initiated (no Court-Time attempt was ever opened) — a
--      new row is imported, using Stripe's own reported amount directly.
--   4. No PI match at all — genuinely foreign (a charge unrelated to
--      Court Time on the same connected account); returns NULL, caller
--      must safely ignore, never raise.
--
-- Idempotent: a second call for the SAME Stripe Refund id (e.g. a second
-- webhook event before the first transaction committed) is serialized by
-- the SAME payments-row lock every other refund RPC in this schema takes
-- first — the second caller blocks until the first commits, then finds
-- and returns the existing/bound row instead of attempting a duplicate
-- (which the table's own stripe_refund_id UNIQUE constraint would reject
-- as a hard backstop regardless).
--
-- Never enforces open_payment_refund_attempt's own online-refundable
-- ceiling when IMPORTING (case 3) — that check exists to stop COURT TIME
-- from ever requesting more than Stripe can refund; an import only ever
-- RECORDS a refund Stripe has already independently accepted (via the
-- Dashboard), using Stripe's own reported amount directly.
create or replace function public._resolve_or_import_refund_attempt_by_provenance(
  p_stripe_refund_id          text,
  p_stripe_payment_intent_id  text,
  p_stripe_account_id         text,
  p_livemode                  boolean,
  p_amount_cents               integer
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_source      public.payment_checkout_attempts%rowtype;
  v_payment     public.payments%rowtype;
  v_existing_id uuid;
  v_pending_id  uuid;
  v_new_id      uuid;
begin
  -- Case 1 — already resolved once (bound), no PI lookup needed.
  select id into v_existing_id
    from public.payment_refund_attempts
   where stripe_refund_id = p_stripe_refund_id;
  if v_existing_id is not null then
    return v_existing_id;
  end if;

  if p_stripe_payment_intent_id is null then
    -- Cannot match without a PaymentIntent to compare against — this
    -- integration's own attempts always carry the Session id, but a
    -- pre-PaymentIntent-resolution Refund object legitimately might not
    -- have one; treat as unmatched rather than guessing.
    return null;
  end if;

  select * into v_source
    from public.payment_checkout_attempts
   where stripe_payment_intent_id = p_stripe_payment_intent_id
     and stripe_account_id = p_stripe_account_id
     and livemode = p_livemode
     and status = 'completed'
   limit 1;

  if not found then
    return null; -- Case 4 — genuinely foreign.
  end if;

  select * into v_payment from public.payments where id = v_source.payment_id for update;

  -- Case 2 — a Court-Time-opened attempt is already waiting against THIS
  -- SPECIFIC source attempt (never just "any pending row for the
  -- payment" — the multi-attempt edge case, 34E-B, is resolved
  -- precisely).
  select id into v_pending_id
    from public.payment_refund_attempts
   where source_checkout_attempt_id = v_source.id
     and stripe_refund_id is null
     and status = 'pending'
   for update;

  if v_pending_id is not null then
    return v_pending_id;
  end if;

  -- Case 3 — nothing Court-Time-initiated is waiting; import.
  insert into public.payment_refund_attempts (
    club_id, payment_id, source_checkout_attempt_id, stripe_account_id, livemode,
    stripe_payment_intent_id, stripe_refund_id, requested_amount_cents, status, initiated_via
  ) values (
    v_payment.club_id, v_payment.id, v_source.id, p_stripe_account_id, p_livemode,
    p_stripe_payment_intent_id, p_stripe_refund_id, p_amount_cents, 'pending', 'stripe_dashboard'
  ) returning id into v_new_id;

  return v_new_id;
end;
$$;

revoke all on function public._resolve_or_import_refund_attempt_by_provenance(text, text, text, boolean, integer)
  from public, anon, authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 9. process_stripe_refund_webhook_event — service-role-only
-- ═══════════════════════════════════════════════════════════════════════════
-- The asynchronous webhook path for refund.created/refund.updated/
-- refund.failed. Dedupes on Stripe's own event id via stripe_event_
-- receipts (reused unchanged, 0148) THEN reconciles from the CURRENT
-- Stripe-retrieved Refund state the Route Handler passes in (never the
-- event payload's own point-in-time snapshot — Stripe does not guarantee
-- webhook delivery ordering, and a refund.created delivery may already
-- report status='succeeded', locked decision 8).
--
-- p_refund_attempt_id (from the verified Refund's own metadata) is NEVER
-- used to resolve/authorize which local attempt this event belongs to
-- (correction pass — metadata is a client-set Stripe field, forgeable by
-- anyone with API/Dashboard access to the connected account). Resolution
-- is ALWAYS performed by _resolve_or_import_refund_attempt_by_provenance,
-- matching the verified Refund's own payment_intent/account/livemode
-- against a completed Court Time attempt — this correctly and uniformly
-- resolves Court-Time-initiated refunds (binding an already-open pending
-- attempt), Dashboard-initiated refunds (importing a new row), and
-- genuinely foreign refunds (no match, safely ignored, matched = false).
-- p_refund_attempt_id, when present, is then used ONLY as a candidate to
-- verify AGAINST that independently-resolved truth: a mismatch (a forged
-- or stale metadata value that disagrees with what the PaymentIntent
-- actually proves) raises refund_attempt_provenance_mismatch and rolls
-- back the whole call (including the just-inserted event receipt, so
-- Stripe's own retry can be investigated) — it is never silently
-- substituted for, and never silently ignored either, since a genuine
-- mismatch here would indicate either an active forgery attempt or a
-- real bug in Court Time's own metadata generation, either of which
-- deserves to fail loudly rather than be papered over.
create or replace function public.process_stripe_refund_webhook_event(
  p_stripe_event_id            text,
  p_event_type                  text,
  p_livemode                    boolean,
  p_stripe_account_id           text,
  p_stripe_refund_id            text,
  p_refund_attempt_id           uuid,
  p_stripe_payment_intent_id    text,
  p_status                       text,
  p_amount_cents                 integer,
  p_currency                      text,
  p_failure_reason                text default null
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
  v_resolved_attempt_id uuid;
begin
  if p_stripe_event_id is null or p_event_type is null or p_livemode is null
     or p_stripe_account_id is null or p_stripe_refund_id is null then
    raise exception 'invalid_arguments';
  end if;

  if p_event_type not in ('refund.created', 'refund.updated', 'refund.failed') then
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
    return query select true, true;
    return;
  end if;

  -- Resolution is ALWAYS by verified PaymentIntent/account/livemode
  -- provenance — never by the metadata-supplied p_refund_attempt_id
  -- directly (correction pass, see this function's own header comment).
  v_resolved_attempt_id := public._resolve_or_import_refund_attempt_by_provenance(
    p_stripe_refund_id, p_stripe_payment_intent_id, p_stripe_account_id, p_livemode, p_amount_cents
  );
  if v_resolved_attempt_id is null then
    -- Genuinely foreign — not a Court Time charge at all. Ignore.
    return query select false, false;
    return;
  end if;

  -- The metadata-supplied id, if present, is only ever a candidate to be
  -- PROVEN against the independently-resolved truth above — never used
  -- to resolve or override it. A mismatch fails closed before any
  -- status/ledger mutation.
  if p_refund_attempt_id is not null and p_refund_attempt_id <> v_resolved_attempt_id then
    raise exception 'refund_attempt_provenance_mismatch';
  end if;

  perform public._reconcile_stripe_refund_attempt(
    v_resolved_attempt_id, p_stripe_refund_id, p_status, p_amount_cents,
    p_stripe_account_id, p_livemode, p_currency, p_failure_reason, p_stripe_payment_intent_id
  );

  return query select false, true;
end;
$$;

revoke execute on function public.process_stripe_refund_webhook_event(text, text, boolean, text, text, uuid, text, text, integer, text, text) from public, anon, authenticated;
grant  execute on function public.process_stripe_refund_webhook_event(text, text, boolean, text, text, uuid, text, text, integer, text, text) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 10. get_online_refundable_amount_for_payments — Admin/Staff batched read
-- ═══════════════════════════════════════════════════════════════════════════
-- Pure ledger read, no Stripe identity/livemode involved — matches this
-- schema's established authenticated-grant category (e.g.
-- get_payment_states_for_domains) rather than the service-role-only
-- category reserved for livemode/Stripe-account-bearing RPCs. The one
-- sanctioned read path for "how much online money is still Stripe-
-- refundable" — /admin/payments never reads payment_checkout_attempts or
-- payment_refund_attempts directly (both are deny-all RLS).
create or replace function public.get_online_refundable_amount_for_payments(
  p_payment_ids uuid[]
)
returns table (
  payment_id       uuid,
  refundable_cents integer,
  currency          text
)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_id uuid;
  v_role    text;
begin
  v_club_id := public.current_user_club_id();
  v_role    := public.current_user_role();
  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if v_role not in ('admin', 'staff') then raise exception 'insufficient_role'; end if;

  return query
    with sources as (
      select a.id as attempt_id, a.payment_id, a.amount_expected_cents, a.created_at, p.currency
        from public.payment_checkout_attempts a
        join public.payments p on p.id = a.payment_id
       where a.club_id = v_club_id
         and a.payment_id = any(p_payment_ids)
         and a.status = 'completed'
    ),
    latest as (
      select distinct on (payment_id) attempt_id, payment_id, amount_expected_cents, currency
        from sources
       order by payment_id, created_at desc
    ),
    reserved as (
      select source_checkout_attempt_id as attempt_id, coalesce(sum(requested_amount_cents), 0) as reserved_cents
        from public.payment_refund_attempts
       where club_id = v_club_id
         and status in ('succeeded', 'pending', 'requires_action')
       group by source_checkout_attempt_id
    )
    select l.payment_id, greatest(l.amount_expected_cents - coalesce(r.reserved_cents, 0), 0)::integer, l.currency
      from latest l
      left join reserved r on r.attempt_id = l.attempt_id;
end;
$$;

revoke execute on function public.get_online_refundable_amount_for_payments(uuid[]) from public, anon;
grant  execute on function public.get_online_refundable_amount_for_payments(uuid[]) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 11. record_refund — CREATE OR REPLACE, manual/offline refundable ceiling only
-- ═══════════════════════════════════════════════════════════════════════════
-- Correction pass — the CURRENTLY-APPLIED 0151 body (which itself added
-- ONE line, the 34E-A Checkout-invalidation guard, to the original 0143
-- body) is the base here, changed in exactly ONE further place: the
-- refund ceiling. It previously compared against payments.amount_paid_
-- cents — the AGGREGATE rollup, which nets manual AND online (Stripe)
-- money together. That meant this local-ledger-only RPC (it never calls
-- Stripe — see this migration's own header comment, finding 1) could
-- falsely mark Stripe-collected money "refunded" without any Stripe
-- refund ever occurring.
--
-- The ceiling is now computed directly from the ledger, scoped to
-- EXACTLY the two manual/offline event types:
--   non-reversed manual_payment_recorded MINUS non-reversed refund_recorded
-- online_payment_recorded and online_refund_recorded never contribute —
-- structurally unreachable by this computation, mirroring (in the
-- opposite direction) how open_payment_refund_attempt's own online
-- ceiling never reads manual_payment_recorded/refund_recorded at all.
-- Examples: $100 Stripe-only -> 0 manually refundable, any amount
-- rejected. $20 cash + $80 Stripe -> at most $20. $20 cash with a prior
-- $5 manual refund -> at most $15 remains. Stripe-collected money
-- remains refundable EXCLUSIVELY through the 34E-B Stripe refund flow
-- (open_payment_refund_attempt and its own online ceiling).
--
-- Admin-only auth, method validation, the 34E-A Checkout-invalidation
-- guard's placement (after validation, before the ledger insert — 34E-A
-- correction pass discipline), and the existing audit_log/event-insert
-- behavior are ALL preserved byte-for-byte from the currently-applied
-- 0151 body. Same signature — CREATE OR REPLACE preserves existing
-- grants untouched (still authenticated, Admin-checked internally; see
-- the unchanged revoke/grant lines below, included here only for
-- clarity, not because either actually changes).
create or replace function public.record_refund(
  p_payment_id         uuid,
  p_amount_cents       integer,
  p_method             text default null,
  p_occurred_at        timestamptz default now(),
  p_external_reference text default null,
  p_notes              text default null
)
returns public.payments
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_id uuid;
  v_role    text;
  v_payment public.payments%rowtype;
  v_result  public.payments%rowtype;
  v_manual_refundable integer;
begin
  v_club_id := public.current_user_club_id();
  v_role    := public.current_user_role();
  if v_club_id is null then raise exception 'not_authenticated'; end if;
  if v_role <> 'admin' then raise exception 'insufficient_role'; end if;

  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'invalid_refund_amount';
  end if;
  if p_method is not null and p_method not in ('cash', 'check', 'card_terminal', 'bank_transfer', 'digital_wallet', 'other') then
    raise exception 'invalid_payment_method';
  end if;

  select * into v_payment from public.payments where id = p_payment_id and club_id = v_club_id for update;
  if not found then raise exception 'payment_not_found'; end if;

  -- Correction pass — offline/manual refundable ceiling ONLY. Online
  -- (Stripe) money is structurally excluded from this SUM regardless of
  -- the payment's own aggregate amount_paid_cents.
  select
    coalesce(sum(amount_cents) filter (where event_type = 'manual_payment_recorded'), 0)
    - coalesce(sum(amount_cents) filter (where event_type = 'refund_recorded'), 0)
    into v_manual_refundable
    from public.payment_events
   where payment_id = p_payment_id
     and id not in (
       select reverses_event_id from public.payment_events where reverses_event_id is not null
     );
  v_manual_refundable := coalesce(v_manual_refundable, 0);

  if p_amount_cents > v_manual_refundable then
    raise exception 'refund_exceeds_manual_amount_paid';
  end if;

  -- Phase 34E-A (correction pass): pre-mutation Stripe Checkout
  -- invalidation. Runs only after the refund-amount validation above has
  -- passed — an invalid refund request must never expire a legitimate
  -- Stripe Checkout Session before Court Time even knows the requested
  -- local action would fail.
  perform public._invalidate_or_flag_open_checkout_attempt(p_payment_id);

  insert into public.payment_events (
    payment_id, club_id, event_type, amount_cents, method, external_reference, notes, actor_id, occurred_at
  ) values (
    p_payment_id, v_club_id, 'refund_recorded', p_amount_cents, p_method, p_external_reference, p_notes,
    auth.uid(), coalesce(p_occurred_at, now())
  );

  select * into v_result from public.payments where id = p_payment_id;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (v_club_id, auth.uid(), 'record_refund', 'payment', p_payment_id,
    jsonb_build_object('amount_cents', p_amount_cents));

  return v_result;
end;
$$;

revoke execute on function public.record_refund(uuid, integer, text, timestamptz, text, text) from public, anon;
grant  execute on function public.record_refund(uuid, integer, text, timestamptz, text, text) to authenticated;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback (manual, cloud SQL Editor) — every statement below is the exact,
-- genuinely executable pre-0153 text, never a placeholder. Uncomment and
-- run top-to-bottom if 0153 must be reverted after being applied.
-- ═══════════════════════════════════════════════════════════════════════════
-- begin;
--
-- drop function if exists public.get_online_refundable_amount_for_payments(uuid[]);
-- drop function if exists public.process_stripe_refund_webhook_event(text, text, boolean, text, text, uuid, text, text, integer, text, text);
-- drop function if exists public._resolve_or_import_refund_attempt_by_provenance(text, text, text, boolean, integer);
-- drop function if exists public.bind_stripe_refund_result(uuid, text, text, integer, text, boolean, text, text, text);
-- drop function if exists public._reconcile_stripe_refund_attempt(uuid, text, text, integer, text, boolean, text, text, text);
-- drop function if exists public.mark_refund_attempt_local_failure(uuid, text);
-- drop function if exists public.backfill_refund_attempt_payment_intent(uuid, text);
-- drop function if exists public.open_payment_refund_attempt(uuid, uuid, integer, uuid, text);
-- drop table if exists public.payment_refund_attempts;
-- drop index if exists public.payment_events_online_refund_session_uniq;
--
-- create or replace function public.record_refund(
--   p_payment_id         uuid,
--   p_amount_cents       integer,
--   p_method             text default null,
--   p_occurred_at        timestamptz default now(),
--   p_external_reference text default null,
--   p_notes              text default null
-- )
-- returns public.payments
-- language plpgsql
-- security definer
-- set search_path to 'public', 'pg_temp'
-- as $$
-- declare
--   v_club_id uuid;
--   v_role    text;
--   v_payment public.payments%rowtype;
--   v_result  public.payments%rowtype;
-- begin
--   v_club_id := public.current_user_club_id();
--   v_role    := public.current_user_role();
--   if v_club_id is null then raise exception 'not_authenticated'; end if;
--   if v_role <> 'admin' then raise exception 'insufficient_role'; end if;
--
--   if p_amount_cents is null or p_amount_cents <= 0 then
--     raise exception 'invalid_refund_amount';
--   end if;
--   if p_method is not null and p_method not in ('cash', 'check', 'card_terminal', 'bank_transfer', 'digital_wallet', 'other') then
--     raise exception 'invalid_payment_method';
--   end if;
--
--   select * into v_payment from public.payments where id = p_payment_id and club_id = v_club_id for update;
--   if not found then raise exception 'payment_not_found'; end if;
--
--   if p_amount_cents > v_payment.amount_paid_cents then
--     raise exception 'refund_exceeds_amount_paid';
--   end if;
--
--   -- Phase 34E-A (correction pass): pre-mutation Stripe Checkout
--   -- invalidation. Runs only after the refund-amount validation above has
--   -- passed — an invalid refund request must never expire a legitimate
--   -- Stripe Checkout Session before Court Time even knows the requested
--   -- local action would fail.
--   perform public._invalidate_or_flag_open_checkout_attempt(p_payment_id);
--
--   insert into public.payment_events (
--     payment_id, club_id, event_type, amount_cents, method, external_reference, notes, actor_id, occurred_at
--   ) values (
--     p_payment_id, v_club_id, 'refund_recorded', p_amount_cents, p_method, p_external_reference, p_notes,
--     auth.uid(), coalesce(p_occurred_at, now())
--   );
--
--   select * into v_result from public.payments where id = p_payment_id;
--
--   insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
--   values (v_club_id, auth.uid(), 'record_refund', 'payment', p_payment_id,
--     jsonb_build_object('amount_cents', p_amount_cents));
--
--   return v_result;
-- end;
-- $$;
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
--     coalesce(sum(amount_cents) filter (where event_type in ('manual_payment_recorded', 'online_payment_recorded')), 0)
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
--   if v_void and v_net <= 0 then
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
--       when 'online_payment_recorded' then
--         amount_cents is not null and amount_cents > 0
--           and method is null and reverses_event_id is null
--           and external_reference is not null
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
--          'obligation_created',
--          'obligation_amount_adjusted',
--          'manual_payment_recorded',
--          'online_payment_recorded',
--          'refund_recorded',
--          'reverse_payment_event',
--          'void_payment_obligation',
--          'waived'
--        ));
--
-- commit;
