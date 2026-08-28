// Phase 34D-D1 — reservation Checkout payment reconciliation webhook.
// Deliberately SEPARATE from src/app/api/stripe/connect/account-events/
// route.ts (Accounts v2 lifecycle events): different Stripe event family
// (classic v1 Checkout/Event objects, not v2 thin events), different
// signature-verification call (stripe.webhooks.constructEvent, not
// parseEventNotification), different env-configured secret
// (STRIPE_PAYMENTS_WEBHOOK_SECRET, never STRIPE_CONNECT_ACCOUNT_WEBHOOK_
// SECRET). This endpoint is configured in Stripe as a Connect webhook, so
// delivered events for a connected account's own activity (this
// integration's direct-charge Checkout Sessions) carry a top-level
// `account` field identifying which connected account the event is for —
// compared against the stored attempt's own stripe_account_id inside the
// RPC below, never trusted from metadata.
//
// Handles checkout.session.completed (only when the Session's own
// payment_status is genuinely 'paid') and, since Phase 34E-B, the three
// Stripe Refund lifecycle events (refund.created/updated/failed) — for
// refunds, the handler RETRIEVES the Refund fresh by id (never trusting
// the event payload's own point-in-time snapshot, since Stripe does not
// guarantee webhook delivery ordering) and reconciles from THAT current
// state, never assumed from the event type alone (a refund.created
// delivery may already report status='succeeded'). No dispute lifecycle
// event is handled in this checkpoint. The browser's own success redirect
// is NEVER the authority for marking a payment paid or a refund
// succeeded; this verified webhook is.

import { NextResponse } from "next/server";
import { getStripeContext } from "@/lib/stripe/server";
import { createPrivilegedClient } from "@/lib/supabase/privileged";
import { isSupportedPaymentWebhookEventType } from "@/lib/stripe/paymentsConfig";
import { isRefundStatus, isSupportedRefundWebhookEventType } from "@/lib/stripe/refundConfig";
import type Stripe from "stripe";

export async function POST(request: Request) {
  // Our own configuration, not the caller's fault if missing — Stripe
  // should retry once it's fixed, so 500 rather than 4xx.
  const webhookSecret = process.env.STRIPE_PAYMENTS_WEBHOOK_SECRET;
  if (!webhookSecret) return new NextResponse(null, { status: 500 });

  const context = getStripeContext();
  if (!context) return new NextResponse(null, { status: 500 });

  const signature = request.headers.get("stripe-signature");
  if (!signature) return new NextResponse(null, { status: 400 });

  // Raw body, never request.json() first — re-serializing JSON can change
  // the exact bytes Stripe signed, breaking verification.
  const rawBody = await request.text();

  let event: Stripe.Event;
  try {
    event = context.client.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch {
    // Invalid signature or malformed payload — never trust anything
    // inside it.
    return new NextResponse(null, { status: 400 });
  }

  // Everything below this line has a Stripe-verified signature behind it.

  if (isSupportedRefundWebhookEventType(event.type)) {
    return handleRefundEvent(event);
  }

  if (!isSupportedPaymentWebhookEventType(event.type)) {
    // A real, verified Stripe event we simply don't act on — safely
    // ignored, not an error.
    return new NextResponse(null, { status: 200 });
  }

  const session = event.data.object as Stripe.Checkout.Session;

  // Structural shape checks against the verified Session object itself —
  // never assumed from the event type alone. A card-only, mode=payment
  // Checkout Session should always satisfy these; anything else is
  // ignored rather than forced through reconciliation.
  if (session.mode !== "payment") {
    return new NextResponse(null, { status: 200 });
  }
  if (session.payment_status !== "paid") {
    // Genuinely unpaid/incomplete session — never credits the ledger.
    return new NextResponse(null, { status: 200 });
  }

  const stripeAccountId = event.account;
  if (!stripeAccountId) {
    // A checkout.session.completed event with no connected-account
    // context cannot belong to this integration's direct-charge model —
    // safely ignored rather than guessed at.
    return new NextResponse(null, { status: 200 });
  }
  if (session.amount_total === null || session.currency === null) {
    // Every earlier check has already confirmed this event IS one of
    // ours: supported type, mode=payment, payment_status=paid, and a
    // connected-account context. A genuinely paid Session missing its own
    // amount_total/currency at this point is a data anomaly, not a
    // legitimate skip — returning 200 here would tell Stripe delivery
    // succeeded while Court Time recorded nothing for a real payment.
    // Fail retryably instead.
    return new NextResponse(null, { status: 500 });
  }

  // Stripe documents Checkout Session.payment_intent as nullable even for
  // a paid mode=payment Session — this integration must never assume it
  // is always present. A genuinely paid, signature-verified Session is
  // NEVER dropped merely because this is null; session.id (required,
  // always present) is the real reconciliation identity passed to the RPC
  // below, and payment_status === 'paid' (already checked above) is this
  // cards-only flow's authoritative success signal.
  const paymentIntentId =
    typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id ?? null;

  const privileged = createPrivilegedClient();
  if (!privileged) return new NextResponse(null, { status: 500 });

  const { error } = await privileged.rpc("process_stripe_payment_event", {
    p_stripe_event_id: event.id,
    p_event_type: event.type,
    p_livemode: event.livemode,
    p_stripe_account_id: stripeAccountId,
    p_stripe_checkout_session_id: session.id,
    p_stripe_payment_intent_id: paymentIntentId,
    p_amount_total_cents: session.amount_total,
    p_currency: session.currency,
  });
  if (error) return new NextResponse(null, { status: 500 });

  // Handled (first delivery, applied) or safely no-op (duplicate delivery)
  // — both are a successfully processed valid Stripe event from Stripe's
  // point of view, so both are 2xx.
  return new NextResponse(null, { status: 200 });
}

// Phase 34E-B (correction pass) — refund.created/refund.updated/
// refund.failed. Stripe does not guarantee webhook delivery ordering, so
// the event payload's own point-in-time snapshot is NEVER trusted as the
// reconciliation source — this handler RETRIEVES the Refund fresh, by id,
// in the event's own verified connected-account context, and reconciles
// from THAT current state via process_stripe_refund_webhook_event (0153).
// A Refund with no recognizable Court Time metadata is not assumed
// foreign: a club's Full Stripe Dashboard access means a refund against a
// Court Time charge can be created entirely outside Court Time, so the
// verified Refund's own payment_intent is always passed through, letting
// the RPC match it against a completed Court Time attempt server-side
// before ever concluding an event is genuinely unrelated.
async function handleRefundEvent(event: Stripe.Event): Promise<NextResponse> {
  const eventRefund = event.data.object as Stripe.Refund;

  const stripeAccountId = event.account;
  if (!stripeAccountId) {
    // A refund event with no connected-account context cannot belong to
    // this integration's direct-charge model — safely ignored.
    return new NextResponse(null, { status: 200 });
  }

  const context = getStripeContext();
  if (!context) return new NextResponse(null, { status: 500 });

  // Current-state retrieve (correction pass) — in the event's own
  // verified connected-account context, never a caller-derived one.
  let refund: Stripe.Refund;
  try {
    refund = await context.client.refunds.retrieve(
      eventRefund.id,
      {},
      { stripeAccount: stripeAccountId },
    );
  } catch {
    // Cannot safely confirm the current state — retryable, not a
    // legitimate skip.
    return new NextResponse(null, { status: 500 });
  }

  if (!isRefundStatus(refund.status)) {
    // A Refund object missing one of Stripe's five documented statuses
    // at this point is a data anomaly, not a legitimate skip — fail
    // retryably.
    return new NextResponse(null, { status: 500 });
  }

  const paymentIntentId =
    typeof refund.payment_intent === "string" ? refund.payment_intent : refund.payment_intent?.id ?? null;

  const refundAttemptId = refund.metadata?.court_time_refund_attempt_id ?? null;

  const privileged = createPrivilegedClient();
  if (!privileged) return new NextResponse(null, { status: 500 });

  const { error } = await privileged.rpc("process_stripe_refund_webhook_event", {
    p_stripe_event_id: event.id,
    p_event_type: event.type,
    p_livemode: event.livemode,
    p_stripe_account_id: stripeAccountId,
    p_stripe_refund_id: refund.id,
    p_refund_attempt_id: refundAttemptId,
    p_stripe_payment_intent_id: paymentIntentId,
    p_status: refund.status,
    p_amount_cents: refund.amount,
    p_currency: refund.currency,
    p_failure_reason: refund.failure_reason ?? null,
  });
  if (error) return new NextResponse(null, { status: 500 });

  // Either reconciled (a genuine Court Time charge, whether Court-Time-
  // or Dashboard-initiated) or genuinely foreign (matched: false, no
  // PaymentIntent/account/livemode match) — both are a successfully
  // processed valid Stripe event from Stripe's point of view.
  return new NextResponse(null, { status: 200 });
}
