// Server-only. Never import from a Client Component or any module that
// could end up in the browser bundle.
//
// Phase 34E-A — Payment Lifecycle Resilience: Stale Checkout Prevention.
//
// Shared by every Admin/Staff Server Action that can mutate an existing
// payment's amount_due_cents/amount_paid_cents/status (recordManualPayment
// Action, updateMemberReservationAdmin, adminUpdateMemberLessonAction —
// and, once 34E-B/D wire them up, the not-yet-reachable waive/void/refund/
// reverse actions too). Each such RPC (0151) now raises
// open_checkout_requires_resolution BEFORE applying its local mutation
// whenever a bound, potentially-still-payable Stripe Checkout Session is
// open for that payment — Postgres cannot itself call Stripe to resolve
// it. This module is the one place that does: given a payment id, it
// fetches the blocking attempt's Stripe identity, retrieves the Session
// (in ITS OWN stored connected-account context, never the caller's), and
// either confirms it is no longer payable (already expired, or actively
// expired here) or reports that a payment is already processing/
// completed — mirroring reservationCheckoutActions.ts's own established
// must_expire_remote orchestration exactly, reused here for the opposite
// direction (invalidating a Session because of a LOCAL change, rather
// than because a fresh one is about to be created).
//
// Fails closed at every step (network/Stripe/DB error, livemode mismatch,
// or Stripe reporting the old Session already complete) — the caller must
// NOT retry its mutation RPC unless this resolves { ok: true }. Two
// distinct failure classes are kept apart (correction pass) so the Admin
// is never told a payment completed when the real problem was an
// infrastructure/verification failure:
//   CHECKOUT_STILL_PROCESSING — Stripe genuinely reports the Session
//     complete/processing, or the attempt was completed elsewhere (the
//     webhook) during this call's own round-trip. Real financial state.
//   RESOLUTION_FAILED — Court Time could not safely verify or expire the
//     Session at all (network/DB/livemode-mismatch failure). No financial
//     claim is made either way; nothing was changed.
import "server-only";
import { createPrivilegedClient } from "@/lib/supabase/privileged";
import { getStripeContext } from "@/lib/stripe/server";

export const CHECKOUT_STILL_PROCESSING_MESSAGE =
  "An online payment is already processing or completed. Refresh the payment before making another change.";

export const RESOLUTION_FAILED_MESSAGE =
  "Court Time could not verify the online payment status. No changes were made. Please try again.";

// The exact error code 0151's new mutation-RPC guard raises. Server
// Actions match their RPC call's error against this before attempting
// resolution + retry — any OTHER error is a normal validation failure and
// must be surfaced to the Admin as-is, never retried.
export const OPEN_CHECKOUT_REQUIRES_RESOLUTION = "open_checkout_requires_resolution";

// Stable machine codes, distinct from `message` (already human-readable),
// so a caller whose own convention re-maps a raw RPC-style code into UI
// copy (e.g. EditReservationSheet.tsx's mapEditError) can match on `code`
// without needing this module's own English copy baked into that
// mapping. A caller that surfaces `message` directly (recordManualPayment
// Action, adminUpdateMemberLessonAction) never needs `code` at all.
export const CHECKOUT_STILL_PROCESSING_CODE = "checkout_still_processing";
export const RESOLUTION_FAILED_CODE = "checkout_resolution_failed";

export type ResolveBlockingCheckoutResult =
  | { ok: true }
  | { ok: false; code: string; error: string };

export async function resolveBlockingCheckoutBeforeMutation(
  paymentId: string,
  clubId: string,
): Promise<ResolveBlockingCheckoutResult> {
  const context = getStripeContext();
  if (!context) return { ok: false, code: RESOLUTION_FAILED_CODE, error: RESOLUTION_FAILED_MESSAGE };

  const privileged = createPrivilegedClient();
  if (!privileged) return { ok: false, code: RESOLUTION_FAILED_CODE, error: RESOLUTION_FAILED_MESSAGE };

  const { data: blockingRows, error: lookupError } = await privileged.rpc(
    "get_blocking_checkout_attempt_for_payment",
    { p_payment_id: paymentId, p_club_id: clubId },
  );
  if (lookupError) return { ok: false, code: RESOLUTION_FAILED_CODE, error: RESOLUTION_FAILED_MESSAGE };

  const attempt = blockingRows?.[0];
  if (!attempt) {
    // Already resolved between the mutation RPC's own check and this call
    // (e.g. the Member let it expire naturally in the interim) — nothing
    // left to do, the caller's retry will proceed normally.
    return { ok: true };
  }

  // Correction pass: the blocking attempt's OWN stored environment must
  // match the server's current Stripe environment before it is ever
  // addressed — a mismatch means the current Stripe API key literally
  // cannot address that Session at all (test-mode and live-mode are
  // disjoint API key spaces, exactly like 0150's own stale_attempt_
  // environment_mismatch reasoning for Checkout creation). Fail closed:
  // never call Stripe, never expire anything, never let the caller retry
  // its local mutation.
  if (attempt.livemode !== context.livemode) {
    return { ok: false, code: RESOLUTION_FAILED_CODE, error: RESOLUTION_FAILED_MESSAGE };
  }

  let session;
  try {
    session = await context.client.checkout.sessions.retrieve(
      attempt.stripe_checkout_session_id,
      {},
      { stripeAccount: attempt.stripe_account_id },
    );
  } catch {
    // Cannot safely query the blocking Session — fail closed rather than
    // let the caller's competing local mutation proceed.
    return { ok: false, code: RESOLUTION_FAILED_CODE, error: RESOLUTION_FAILED_MESSAGE };
  }

  if (session.status === "complete") {
    // Stripe already collected payment (or is in the process of doing
    // so) on this Session — never let a competing local mutation proceed.
    // Webhook reconciliation (0150, unchanged) will finish this shortly
    // if it hasn't already.
    return { ok: false, code: CHECKOUT_STILL_PROCESSING_CODE, error: CHECKOUT_STILL_PROCESSING_MESSAGE };
  }

  if (session.status === "open") {
    try {
      await context.client.checkout.sessions.expire(
        attempt.stripe_checkout_session_id,
        {},
        { stripeAccount: attempt.stripe_account_id },
      );
    } catch {
      // Cannot safely expire the blocking Session — fail closed.
      return { ok: false, code: RESOLUTION_FAILED_CODE, error: RESOLUTION_FAILED_MESSAGE };
    }
  }
  // session.status === "expired" needs no Stripe action — already dead.

  const { data: finalizeRows, error: finalizeError } = await privileged.rpc(
    "expire_blocking_checkout_attempt",
    { p_attempt_id: attempt.id, p_payment_id: paymentId, p_club_id: clubId },
  );
  if (finalizeError) return { ok: false, code: RESOLUTION_FAILED_CODE, error: RESOLUTION_FAILED_MESSAGE };

  if (finalizeRows?.[0]?.action === "already_completed") {
    // Resolved (most likely by the webhook) during the Stripe round-trip
    // above — never let the competing local mutation proceed.
    return { ok: false, code: CHECKOUT_STILL_PROCESSING_CODE, error: CHECKOUT_STILL_PROCESSING_MESSAGE };
  }

  return { ok: true };
}
