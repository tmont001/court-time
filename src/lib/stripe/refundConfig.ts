// Phase 34E-B — pure, side-effect-free Stripe refund helpers. No secrets,
// no network I/O, no "server-only" guard — deliberately importable from
// tests and Server Actions alike, mirroring paymentsConfig.ts's own
// separation.
//
// LOCKED Court Time refund model:
//   Refunds a specific completed online payment's own PaymentIntent —
//     never a club's currently-configured Stripe connection.
//   Created via the connected club account's own context (RequestOptions.
//     stripeAccount) — a DIRECT-charge refund, exactly mirroring how the
//     original charge was collected.
//   Court Time's own `reason` is never sent to Stripe's constrained
//     duplicate/fraudulent/requested_by_customer enum — it stays a local,
//     free-text admin note only.

// Deterministic per-refund-attempt idempotency key. Two calls for the
// SAME attempt id (double submit, browser retry, or a deliberate re-open
// of a still-unresolved existing attempt — see 0153's
// open_payment_refund_attempt) resolve to the SAME Stripe Refund at
// Stripe's own idempotency layer, rather than creating a duplicate. Never
// derived from anything a browser supplies.
export function buildRefundIdempotencyKey(refundAttemptId: string): string {
  return `payment-refund:${refundAttemptId}`;
}

export interface RefundMetadata {
  court_time_refund_attempt_id: string;
  court_time_payment_id: string;
  court_time_club_id: string;
  [key: string]: string;
}

// Embedded on the Stripe Refund at creation time so the signed webhook
// can recover the local attempt even if the Server Action's own
// synchronous bind call never completed (failure-recovery scenario B/C).
// Observability/recovery only, never authorization — process_stripe_
// refund_webhook_event still independently re-validates stripe_account_
// id/livemode/currency/amount against the attempt's own trusted stored
// values, never trusts metadata as authority.
export function buildRefundMetadata(input: {
  refundAttemptId: string;
  paymentId: string;
  clubId: string;
}): RefundMetadata {
  return {
    court_time_refund_attempt_id: input.refundAttemptId,
    court_time_payment_id: input.paymentId,
    court_time_club_id: input.clubId,
  };
}

// The three Stripe Refund lifecycle events this integration's webhook
// acts on. A club's Full Stripe Dashboard access means a Refund can be
// created entirely outside Court Time (directly in the Dashboard) for the
// same connected account — unlike checkout.session.completed (every
// Session in this integration is exclusively Court-Time-created), the
// webhook route must gracefully IGNORE any refund event whose metadata
// carries no recognizable court_time_refund_attempt_id, never raise on
// it.
export const SUPPORTED_REFUND_WEBHOOK_EVENT_TYPES = [
  "refund.created",
  "refund.updated",
  "refund.failed",
] as const;

export type SupportedRefundWebhookEventType = (typeof SUPPORTED_REFUND_WEBHOOK_EVENT_TYPES)[number];

export function isSupportedRefundWebhookEventType(type: string): type is SupportedRefundWebhookEventType {
  return (SUPPORTED_REFUND_WEBHOOK_EVENT_TYPES as readonly string[]).includes(type);
}

// Stripe's own five documented Refund.status values (installed SDK,
// Refunds.d.ts JSDoc) — never invented, matches payment_refund_attempts'
// own CHECK constraint (0153) exactly.
export const REFUND_STATUS_VALUES = ["pending", "requires_action", "succeeded", "failed", "canceled"] as const;
export type RefundStatus = (typeof REFUND_STATUS_VALUES)[number];

export function isRefundStatus(value: string | null | undefined): value is RefundStatus {
  return value != null && (REFUND_STATUS_VALUES as readonly string[]).includes(value);
}

// Mirrors 0153's own open_payment_refund_attempt gate exactly — used only
// to decide whether the Admin-facing Refund action should render/be
// enabled at all. The actual money-relevant step (refund creation) always
// re-derives eligibility fresh server-side, never trusts this function's
// result as authority.
export function isOnlineRefundEligible(refundableCents: number | null | undefined): boolean {
  return typeof refundableCents === "number" && refundableCents > 0;
}
