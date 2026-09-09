-- 0156_stripe_dispute_visibility.sql
-- Phase 34E-C — Stripe Dispute Visibility (INFORMATIONAL ONLY).
--
-- ── Locked product scope ─────────────────────────────────────────────────
-- Stripe Connect DIRECT CHARGES: clubs are the merchant, Members are the
-- buyer, the charge belongs to the connected club account. Court Time's
-- role here is strictly informational: detect disputes on Court Time-
-- created Stripe payments, persist their current Stripe state, associate
-- them with the correct Court Time payment, surface useful information to
-- Admin/Staff, and direct the club to Stripe for actual dispute
-- management (evidence submission, accept/close). Court Time never
-- submits evidence, never accepts/closes a dispute, never auto-refunds
-- because of one, and never exposes dispute data to Members.
--
-- ── CRITICAL MONEY INVARIANT ─────────────────────────────────────────────
-- A Stripe dispute — including an active or LOST dispute — is NOT a Court
-- Time refund and NOT a new member receivable. Reconciling a dispute NEVER
-- touches payments.amount_paid_cents, never re-enables Member Pay Now,
-- never inserts refund_recorded/online_refund_recorded, never mutates any
-- existing payment/refund ledger event, never cancels the reservation,
-- never changes the booking price. The payment remains historically paid.
-- This migration proves that structurally: payment_disputes is a
-- dedicated table, entirely separate from payment_events/payment_
-- refund_attempts, and process_stripe_dispute_webhook_event below never
-- references public.payments' amount_due_cents/amount_paid_cents/status
-- columns in an UPDATE — it only ever SELECTs from payments (read-only,
-- to resolve club_id/payment_id identity) and only ever INSERT/UPDATEs
-- public.payment_disputes.
--
-- ── Reconciliation model (deliberately simpler than 34E-B's refund flow) ──
-- Every dispute event is a TRIGGER to retrieve Stripe's CURRENT Dispute
-- object fresh (handled in the webhook Route Handler, TypeScript — Postgres
-- cannot call the Stripe API), never the event payload's own point-in-time
-- snapshot. Unlike payment_refund_attempts (which has a local state
-- machine — pending/succeeded/failed/canceled — requiring explicit
-- terminal-state protection against out-of-order delivery), payment_
-- disputes has NO local state machine: every reconciliation call
-- overwrites the row with whatever Stripe's live Dispute object currently
-- says, at the time of THAT call. Out-of-order webhook DELIVERY is
-- therefore automatically safe by construction — an older event's own
-- handler-side retrieve() call still fetches Stripe's CURRENT state at
-- call time, not the stale payload, so it can never regress the row to
-- older data. See this migration's own "known limitations" note for the
-- one narrow, deliberately-accepted exception (a rare concurrent-retrieve
-- race, harmless because this data is informational-only).
--
-- ── Provenance — fail closed, never metadata ─────────────────────────────
-- A dispute is never Court-Time-initiated (always cardholder/Stripe-
-- initiated), so unlike 0153's refund flow there is no Court-Time-side
-- candidate id to reconcile against, and disputes carry no Court Time
-- metadata at all. Resolution is ALWAYS by verified provenance: event.
-- account (stripe_account_id) + livemode + the verified PaymentIntent,
-- matched against a COMPLETED public.payment_checkout_attempts row.
-- Stripe Dispute.payment_intent can be null (installed SDK, Disputes.d.ts)
-- — the Route Handler falls back to retrieving the Dispute's own Charge
-- (Dispute.charge is never null) under the SAME connected-account context
-- and reads Charge.payment_intent. If a resolved PaymentIntent still
-- cannot be matched to a completed Court Time attempt, this is a
-- genuinely foreign/unmatched Stripe dispute — safely ignored after
-- event-receipt handling, never guessed at.
--
-- ── Avoiding the 0153/0154/0155 PL/pgSQL OUT-variable ambiguity class ────
-- process_stripe_dispute_webhook_event below returns a plain `boolean`
-- (matched: true/false) — NOT `returns table (...)`. A scalar return has
-- no implicit OUT parameters, so there is no PL/pgSQL variable able to
-- shadow a table column name at all; this sidesteps the entire bug class
-- fixed by 0154/0155 by construction, not by careful qualification. Every
-- table reference is still explicitly alias-qualified (pca for payment_
-- checkout_attempts, pd for payment_disputes) as a matter of discipline.
--
-- ── Reads never need a new RPC ───────────────────────────────────────────
-- Unlike payment_checkout_attempts/payment_refund_attempts (deny-all RLS,
-- requiring get_online_refundable_amount_for_payments), payment_disputes
-- has a normal club-scoped SELECT policy, mirroring public.payments'
-- own established pattern exactly (payments_select_admin_staff, 0143).
-- /admin/payments reads it with a plain `.from("payment_disputes").select
-- (...)` call — no new PL/pgSQL read function, no RETURNS TABLE risk on
-- the read path at all.
--
-- ── Status/reason are NOT constrained by CHECK ───────────────────────────
-- Dispute.status is SDK-typed as an open union (known values | OtherString
-- — installed SDK, Disputes.d.ts) specifically because Stripe can add new
-- values. A CHECK constraint here would make ingestion fail PERMANENTLY
-- the moment Stripe introduces one. Both `status` and `reason` are plain
-- `text not null` columns; the UI (src/lib/stripe/disputeConfig.ts) maps
-- known values to friendly labels with a safe generic fallback ("Disputed").
--
-- ── Known, deliberately-accepted limitations ─────────────────────────────
-- 1. A completed Checkout attempt whose own stripe_payment_intent_id is
--    still null (0150's documented nullable-PaymentIntent edge case,
--    never backfilled because no refund was ever attempted against it) is
--    unmatchable by this migration's provenance lookup; a dispute against
--    such a payment is safely ignored as unmatched rather than
--    associated. In practice process_stripe_payment_event (0150) stores
--    the PaymentIntent at Checkout completion whenever Stripe's own
--    checkout.session.completed event includes one, which it does for the
--    overwhelming majority of paid Sessions — this gap is a documented,
--    narrow edge case, not the common path.
-- 2. Two webhook deliveries racing to independently RETRIEVE the Dispute
--    from Stripe (outside any DB lock, since the retrieve happens in the
--    Route Handler before the DB call) could theoretically complete their
--    OWN DB writes in the reverse order of their OWN retrieves, leaving a
--    momentarily stale status until Stripe's next event resyncs it. This
--    data is informational-only (never financial authority per the locked
--    money invariant), so this narrow, self-correcting race is accepted
--    rather than engineered around.
-- 3. No "Manage in Stripe" deep-link button: no existing safe Stripe
--    Dashboard link primitive exists anywhere in this repo (audited), and
--    the locked scope explicitly forbids inventing an undocumented/
--    brittle deep-link format merely to add a button.
--
-- Apply in Supabase SQL Editor (cloud only).

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. payment_disputes — dedicated dispute persistence, never overloading
--    payment_events/payment_refund_attempts.
-- ═══════════════════════════════════════════════════════════════════════════

create table public.payment_disputes (
  id                          uuid        primary key default gen_random_uuid(),
  club_id                     uuid        not null references public.clubs(id) on delete cascade,
  payment_id                  uuid        not null,
  -- Trusted provenance — the SPECIFIC completed online payment this
  -- dispute was matched against. Never the club's current Stripe
  -- connection. Mirrors payment_refund_attempts.source_checkout_
  -- attempt_id (0153) exactly.
  source_checkout_attempt_id  uuid        not null references public.payment_checkout_attempts(id),

  -- External review correction — a bare stripe_dispute_id is NOT trusted
  -- as globally unique on its own: it must never be assumed unique across
  -- DIFFERENT connected accounts or across test-vs-live environments
  -- without also anchoring to stripe_account_id/livemode. The real
  -- idempotency identity is the COMPOSITE unique constraint below
  -- (stripe_account_id, livemode, stripe_dispute_id) — the ON CONFLICT
  -- target the RPC upserts against.
  stripe_dispute_id           text        not null,
  -- Dispute.charge is never null (installed SDK) — always available
  -- directly from the retrieved Dispute object.
  stripe_charge_id            text        not null,
  -- The VERIFIED PaymentIntent this row was actually matched on — either
  -- Dispute.payment_intent directly, or derived via the Charge fallback
  -- when that was null. A row only ever exists here once this was
  -- successfully resolved (see the RPC below) — never null for a
  -- persisted row.
  stripe_payment_intent_id    text        not null,
  stripe_account_id           text        not null,
  livemode                    boolean     not null,

  -- Disputed amount — "usually the amount of the charge, but it can
  -- differ" (installed SDK, Disputes.d.ts) — never assumed equal to the
  -- payment's own amount_paid_cents.
  amount_cents                integer     not null check (amount_cents > 0),
  currency                    text        not null check (currency ~ '^[A-Z]{3}$'),

  -- Stripe's own raw dispute status string — deliberately NOT constrained
  -- to a fixed enum. See this migration's own header comment.
  status                       text        not null,
  reason                       text        not null,

  -- Stripe's evidence_details.due_by (unix seconds, or 0/null when the
  -- customer's bank doesn't allow a response) — normalized to NULL for
  -- "no deadline" by the Route Handler before this is ever called.
  evidence_due_by              timestamptz,
  -- Stripe's own live signal for whether a Court Time Refund action
  -- should still be offered (locked "Refund interaction" requirement) —
  -- reconciled fresh on every event, never derived locally.
  is_charge_refundable         boolean     not null,

  stripe_created_at            timestamptz not null,
  -- Updated on every successful reconciliation call, whether or not the
  -- Stripe-sourced fields actually changed — the one honest "last
  -- confirmed against Stripe" timestamp.
  last_synced_at               timestamptz not null default now(),

  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),

  -- Composite FK, mirroring payment_refund_attempts' own (payment_id,
  -- club_id) -> payments(id, club_id) pattern exactly (0143's own unique
  -- (id, club_id) is what makes this possible) — cross-validates that
  -- payment_id and club_id are mutually consistent, never independently
  -- trusted.
  foreign key (payment_id, club_id) references public.payments(id, club_id),

  -- External review correction — the real Stripe dispute identity is
  -- SCOPED to the connected account and livemode it belongs to, not the
  -- bare dispute id alone. This is the ON CONFLICT target the RPC below
  -- upserts against.
  unique (stripe_account_id, livemode, stripe_dispute_id)
);

create index payment_disputes_payment_idx on public.payment_disputes (payment_id);
create index payment_disputes_club_idx on public.payment_disputes (club_id);

create trigger payment_disputes_updated_at
  before update on public.payment_disputes
  for each row execute function public.trigger_set_updated_at();

-- Club-scoped Admin/Staff read — mirrors payments_select_admin_staff
-- (0143) exactly. No Member/Pro access; no direct INSERT/UPDATE/DELETE
-- policy for `authenticated` at all — every mutation is service-role-only
-- (see the RPC's own grants below), reachable only through the verified
-- webhook Route Handler, never directly from a browser session.
grant select on public.payment_disputes to authenticated;

alter table public.payment_disputes enable row level security;

create policy "payment_disputes_select_admin_staff"
  on public.payment_disputes for select
  using (
    club_id = public.current_user_club_id()
    and public.current_user_role() in ('admin', 'staff')
  );

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. process_stripe_dispute_webhook_event — service-role-only webhook
--    reconciliation. Scalar `boolean` return (matched) — deliberately NOT
--    RETURNS TABLE (see this migration's own header comment).
-- ═══════════════════════════════════════════════════════════════════════════
-- Reuses the SAME shared stripe_event_receipts table (0148) already used
-- by process_stripe_payment_event (0150) and process_stripe_refund_
-- webhook_event (0153) for exactly-once event-receipt dedupe — no new
-- dedupe infrastructure. p_stripe_payment_intent_id and p_evidence_due_by
-- are the only nullable inputs (the Route Handler may have been unable to
-- resolve a PaymentIntent at all even via the Charge fallback, and not
-- every dispute has an evidence deadline) — every other field is
-- required, matching what the installed SDK types as always-present on a
-- retrieved Dispute object.
create or replace function public.process_stripe_dispute_webhook_event(
  p_stripe_event_id           text,
  p_event_type                text,
  p_livemode                  boolean,
  p_stripe_account_id         text,
  p_stripe_dispute_id         text,
  p_stripe_charge_id          text,
  p_stripe_payment_intent_id  text,
  p_amount_cents               integer,
  p_currency                   text,
  p_status                     text,
  p_reason                     text,
  p_evidence_due_by            timestamptz,
  p_is_charge_refundable       boolean,
  p_stripe_created_at          timestamptz
)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_new_receipt boolean;
  v_source      public.payment_checkout_attempts%rowtype;
  v_payment     public.payments%rowtype;
begin
  if p_stripe_event_id is null or p_event_type is null or p_livemode is null
     or p_stripe_account_id is null or p_stripe_dispute_id is null
     or p_stripe_charge_id is null or p_amount_cents is null or p_currency is null
     or p_status is null or p_reason is null or p_is_charge_refundable is null
     or p_stripe_created_at is null then
    raise exception 'invalid_arguments';
  end if;

  if p_event_type not in (
    'charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed',
    'charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated'
  ) then
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
    -- already successfully processed — no ledger/state mutation repeated.
    return true;
  end if;

  -- Provenance resolution (fail closed) — a COMPLETED Court Time Checkout
  -- attempt for the same connected account, livemode, and verified
  -- PaymentIntent. Never trusts metadata; there is no Court-Time-side
  -- candidate id for a dispute (always cardholder/Stripe-initiated).
  -- p_stripe_payment_intent_id may be null here (Route Handler could not
  -- resolve one even via the Charge fallback) — SQL NULL comparison
  -- semantics mean that case naturally falls through to "not found"
  -- below, with no special-case handling required.
  select * into v_source
    from public.payment_checkout_attempts pca
   where pca.stripe_account_id = p_stripe_account_id
     and pca.livemode = p_livemode
     and pca.stripe_payment_intent_id = p_stripe_payment_intent_id
     and pca.status = 'completed'
   limit 1;

  if not found then
    -- Genuinely foreign/unmatched — safely ignored. The event receipt
    -- above still stands, so a retried delivery of this SAME event id
    -- remains a no-op rather than re-evaluated.
    return false;
  end if;

  -- Read-only — NEVER locked, NEVER updated. This RPC only ever resolves
  -- payments.club_id/id for the new row's own identity columns; it does
  -- not (and structurally cannot, by never appearing in any UPDATE/SET
  -- clause below) touch amount_due_cents/amount_paid_cents/status. This
  -- is the money invariant made structural, not just documented.
  select * into v_payment from public.payments where id = v_source.payment_id;

  -- External review correction — DB backstops against the resolved
  -- COMPLETED Checkout attempt, before this dispute is ever persisted.
  -- Currency must match exactly (a dispute is always denominated in the
  -- original charge's own currency; installed SDK has no field
  -- suggesting otherwise). Amount must NOT exceed the charge's own
  -- expected amount — but need not equal it, since Stripe explicitly
  -- documents a dispute's amount can be LESS than the full charge
  -- ("usually the amount of the charge, but it can differ... because
  -- only part of the order is disputed", Disputes.d.ts) — a genuine
  -- partial dispute. amount_cents > 0 is already enforced by this
  -- table's own CHECK constraint on every INSERT/UPDATE.
  if upper(p_currency) <> v_source.currency_expected then
    raise exception 'currency_mismatch';
  end if;
  if p_amount_cents > v_source.amount_expected_cents then
    raise exception 'dispute_amount_exceeds_charge';
  end if;

  -- External review correction — for an ALREADY-persisted dispute
  -- (matched by the composite stripe_account_id/livemode/
  -- stripe_dispute_id identity), club_id/payment_id/source_checkout_
  -- attempt_id/stripe_account_id/livemode/stripe_charge_id/stripe_
  -- payment_intent_id are IDENTITY, never mutable state — a subsequent
  -- reconciliation must never silently change any of them, so they are
  -- deliberately absent from the SET list below and instead enforced by
  -- the DO UPDATE's own WHERE guard. amount_cents/currency are extended
  -- into that SAME immutable-identity treatment: Stripe's Dispute object
  -- has no update-amount/update-currency capability at all (DisputeUpdateParams
  -- only supports evidence/metadata/submit, installed SDK) — both are
  -- fixed at dispute-creation time, so guarding them the same way as the
  -- explicitly-listed identity columns is the safer, symmetric choice
  -- rather than leaving them silently mutable. Only genuinely live Stripe
  -- STATE — status, reason, evidence_due_by, is_charge_refundable, and
  -- the sync timestamps — is ever written by the DO UPDATE SET clause.
  insert into public.payment_disputes as pd (
    club_id, payment_id, source_checkout_attempt_id, stripe_dispute_id, stripe_charge_id,
    stripe_payment_intent_id, stripe_account_id, livemode, amount_cents, currency, status, reason,
    evidence_due_by, is_charge_refundable, stripe_created_at, last_synced_at
  ) values (
    v_payment.club_id, v_payment.id, v_source.id, p_stripe_dispute_id, p_stripe_charge_id,
    p_stripe_payment_intent_id, p_stripe_account_id, p_livemode, p_amount_cents, upper(p_currency), p_status, p_reason,
    p_evidence_due_by, p_is_charge_refundable, p_stripe_created_at, now()
  )
  on conflict (stripe_account_id, livemode, stripe_dispute_id) do update set
    status                = excluded.status,
    reason                = excluded.reason,
    evidence_due_by        = excluded.evidence_due_by,
    is_charge_refundable    = excluded.is_charge_refundable,
    last_synced_at           = now(),
    updated_at                = now()
  where pd.club_id = v_payment.club_id
    and pd.payment_id = v_payment.id
    and pd.source_checkout_attempt_id = v_source.id
    and pd.stripe_account_id = p_stripe_account_id
    and pd.livemode = p_livemode
    and pd.stripe_charge_id = p_stripe_charge_id
    and pd.stripe_payment_intent_id = p_stripe_payment_intent_id
    and pd.amount_cents = p_amount_cents
    and pd.currency = upper(p_currency);

  -- A conflict existed but the provenance guard above prevented the
  -- UPDATE — a later event for the SAME (account, livemode, dispute id)
  -- reported a DIFFERENT club/payment/checkout attempt/charge/
  -- PaymentIntent/amount/currency than what was already persisted. That
  -- must never be silently accepted (it would mean either Stripe
  -- reassigned a dispute's own identity, which it does not, or something
  -- upstream is corrupted) — fails closed, consistent with this
  -- codebase's established discipline (e.g. 0153's payment_intent_mismatch).
  if not found then
    raise exception 'dispute_provenance_mismatch';
  end if;

  return true;
end;
$$;

revoke execute on function public.process_stripe_dispute_webhook_event(text, text, boolean, text, text, text, text, integer, text, text, text, timestamptz, boolean, timestamptz) from public, anon, authenticated;
grant  execute on function public.process_stripe_dispute_webhook_event(text, text, boolean, text, text, text, text, integer, text, text, text, timestamptz, boolean, timestamptz) to service_role;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback (manual, cloud SQL Editor) — restores the exact pre-0156
-- schema (payment_disputes never existed, process_stripe_dispute_
-- webhook_event never existed). Uncomment and run top-to-bottom if 0156
-- must be reverted after being applied.
-- ═══════════════════════════════════════════════════════════════════════════
-- begin;
--
-- drop function if exists public.process_stripe_dispute_webhook_event(text, text, boolean, text, text, text, text, integer, text, text, text, timestamptz, boolean, timestamptz);
-- drop table if exists public.payment_disputes;
--
-- commit;
