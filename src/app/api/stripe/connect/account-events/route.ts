// Phase 34D-B — Stripe Connect account lifecycle/readiness synchronization.
// Keeps club_stripe_accounts.card_payments_status current when Stripe
// later changes a connected club's onboarding requirements or Merchant
// card-payments capability, WITHOUT relying on the Admin manually
// returning through an Account Link (34D-A's return route only syncs at
// that one moment).
//
// Subscribes to exactly two Accounts v2 THIN event types — no unrelated
// Account event is handled without a concrete reason:
//   v2.core.account[requirements].updated
//   v2.core.account[configuration.merchant].capability_status_updated
// (v1's account.updated has no v2 equivalent as a single event; Accounts
// v2 splits it into these narrower, purpose-specific thin events.)
//
// "Thin" means the webhook body itself carries only enough to identify
// WHICH event happened and where to look for more — never enough to act
// on directly. This handler therefore never trusts card_payments_status
// from the request body: after verifying the signature, it re-fetches the
// full Event via the SDK, then separately re-retrieves the current
// Account state (with configuration.merchant included) via the same
// authenticated API call 34D-A's return route already uses — the
// verified webhook only ever tells us "something changed for this
// account," never what the new value is.
//
// Uses the installed stable stripe SDK's own v2 thin-event surface
// (stripe.parseEventNotification, notification.fetchEvent(),
// stripe.v2.core.accounts.retrieve) — no raw fetch, no preview API
// version. See src/lib/stripe/connectConfig.ts for why Accounts v2 (not
// v1) is this integration's foundation.

import { NextResponse } from "next/server";
import { getStripeContext } from "@/lib/stripe/server";
import { createPrivilegedClient } from "@/lib/supabase/privileged";
import {
  CONNECT_ACCOUNT_RETRIEVE_PARAMS,
  extractCardPaymentsStatus,
  SUPPORTED_ACCOUNT_LIFECYCLE_EVENT_TYPES,
} from "@/lib/stripe/connectConfig";

export async function POST(request: Request) {
  // Our own configuration, not the caller's fault if missing — Stripe
  // should retry once it's fixed, so 500 rather than 4xx.
  const webhookSecret = process.env.STRIPE_CONNECT_ACCOUNT_WEBHOOK_SECRET;
  if (!webhookSecret) return new NextResponse(null, { status: 500 });

  const context = getStripeContext();
  if (!context) return new NextResponse(null, { status: 500 });

  const signature = request.headers.get("stripe-signature");
  if (!signature) return new NextResponse(null, { status: 400 });

  // Raw body, never request.json() first — re-serializing JSON can change
  // the exact bytes Stripe signed, breaking verification.
  const rawBody = await request.text();

  let notification;
  try {
    notification = context.client.parseEventNotification(rawBody, signature, webhookSecret);
  } catch {
    // Invalid signature or malformed payload — never trust anything
    // inside it.
    return new NextResponse(null, { status: 400 });
  }

  // Everything below this line has a Stripe-verified signature behind it.
  // notification.livemode is part of that verified payload — never a
  // browser/query-supplied value — and is threaded through unchanged into
  // the RPC's own (account_id, livemode) match below.
  if (
    notification.type !== SUPPORTED_ACCOUNT_LIFECYCLE_EVENT_TYPES[0] &&
    notification.type !== SUPPORTED_ACCOUNT_LIFECYCLE_EVENT_TYPES[1]
  ) {
    // A real, verified Stripe event we simply don't act on — safely
    // ignored, not an error.
    return new NextResponse(null, { status: 200 });
  }

  // Re-fetch the full, versioned Event via the SDK using the verified
  // notification's own id — never trust the thin body's own fields
  // (including its own copy of related_object) as sufficient on their own.
  let event;
  try {
    event = await notification.fetchEvent();
  } catch {
    return new NextResponse(null, { status: 500 });
  }

  const accountId = event.related_object.id;

  // Separately re-retrieve current Account state with configuration.
  // merchant included — the same params/helper 34D-A's return route uses,
  // so both paths always read card_payments_status identically. The event
  // itself never tells us the new status value; only that something
  // changed.
  let account;
  try {
    account = await context.client.v2.core.accounts.retrieve(accountId, CONNECT_ACCOUNT_RETRIEVE_PARAMS);
  } catch {
    return new NextResponse(null, { status: 500 });
  }

  const privileged = createPrivilegedClient();
  if (!privileged) return new NextResponse(null, { status: 500 });

  const { error } = await privileged.rpc("process_stripe_connect_account_event", {
    p_stripe_event_id: event.id,
    p_event_type: event.type,
    p_livemode: event.livemode,
    p_stripe_account_id: accountId,
    p_card_payments_status: extractCardPaymentsStatus(account),
  });
  if (error) return new NextResponse(null, { status: 500 });

  // Handled (first delivery, applied) or safely no-op (duplicate delivery,
  // or a verified event for an account Court Time doesn't know about) —
  // both are a successfully processed valid Stripe event from Stripe's
  // point of view, so both are 2xx.
  return new NextResponse(null, { status: 200 });
}
