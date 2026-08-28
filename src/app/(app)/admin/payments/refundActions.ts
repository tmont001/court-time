"use server";

// Phase 34E-B — Stripe refunds/partial refunds for Court Time Payments.
// Admin-only — enforced with defense in depth: this Server Action
// independently resolves the caller's CURRENT role via getAuthProfile()
// and requires role === "admin" before ever reaching the privileged
// client (open_payment_refund_attempt/bind_stripe_refund_result/mark_
// refund_attempt_local_failure are all service_role-only — no
// authenticated browser session can reach them directly). Mirrors the
// 34D-D1/34E-A-established pattern for livemode-sensitive operations
// exactly: independently authenticate, derive livemode itself via
// getStripeContext(), only then reach through the privileged client.
//
// Stripe-refundable identity (connected account, livemode, PaymentIntent)
// always comes from the payment's own trusted, persisted, completed
// online payment_checkout_attempts row — NEVER from the club's currently
// configured Stripe connection (locked decision 3/5). The Server Action
// never resolves get_club_stripe_account_ref for this flow at all.

import { revalidatePath } from "next/cache";
import { getAuthUser, getAuthProfile } from "@/lib/supabase/user";
import { createClient } from "@/lib/supabase/server";
import { assertActiveClub } from "@/lib/supabase/staleClub";
import { STALE_CLUB_CONTEXT_ERROR, STALE_CLUB_MESSAGE } from "@/lib/staleClub";
import { createPrivilegedClient } from "@/lib/supabase/privileged";
import { getStripeContext } from "@/lib/stripe/server";
import { buildRefundIdempotencyKey, buildRefundMetadata, isRefundStatus } from "@/lib/stripe/refundConfig";
import { RESOLUTION_FAILED_MESSAGE } from "@/lib/stripe/checkoutInvalidation";

const ERROR_MESSAGES: Record<string, string> = {
  [STALE_CLUB_CONTEXT_ERROR]: STALE_CLUB_MESSAGE,
  not_authenticated: "You must be signed in.",
  insufficient_role: "Only an Admin can issue a refund.",
  payment_not_found: "That payment could not be found.",
  invalid_refund_amount: "Enter a valid refund amount greater than zero.",
  no_online_payment_to_refund: "There is no online payment on this balance to refund.",
  refund_exceeds_online_remaining: "That amount exceeds what's still refundable online for this payment.",
  // Correction pass — a different, still-unresolved refund request is
  // already in flight for this payment. Never silently substitute the
  // old request's amount; the Admin must wait for it to resolve (or
  // refresh) before requesting a different amount.
  pending_refund_amount_mismatch:
    "A refund for a different amount is already in progress for this payment. Wait for it to finish, then try again.",
  db_not_configured: "Something went wrong. Please try again.",
  court_time_payments_not_available: "Online payments aren't available right now. Please try again later.",
  // A mismatch between the original payment's own Stripe environment and
  // this server's current one — should not happen in normal operation;
  // fails closed rather than ever guessing which account to refund
  // through.
  environment_mismatch: RESOLUTION_FAILED_MESSAGE,
  stripe_error: RESOLUTION_FAILED_MESSAGE,
  // Stripe's own call may have actually succeeded even though this
  // response path failed (network uncertainty) — never told to the
  // Admin as a hard failure; the signed webhook will reconcile the real
  // outcome regardless of what this Server Action could confirm.
  refund_uncertain: "The refund was submitted. We couldn't confirm the result immediately — check back shortly.",
};

export interface RefundableAmount {
  paymentId: string;
  refundableCents: number;
  currency: string;
}

// Runtime QA (0154/0155) — server-side observability only, never
// user-facing. An infrastructure-level failure here (a DB/RPC error, or a
// Stripe call that could not be confirmed) must never vanish without a
// trace the way it did before 0154/0155: logs only a payment id plus an
// error code/message, never secrets, JWTs, PII, or full row/error
// objects. The Admin-facing message shown alongside this call is
// unchanged — this is additive logging, not a UX change.
function logUnexpectedRefundError(context: string, paymentId: string, err: { message?: string; code?: string } | null) {
  console.error(`[refund] ${context}`, {
    payment_id: paymentId,
    code: err?.code ?? null,
    message: err?.message ?? null,
  });
}

// Read-only, batched — the one sanctioned way /admin/payments learns how
// much online money is still Stripe-refundable per payment. Mirrors
// fetchPaymentStates' own shape/discipline exactly.
export async function fetchOnlineRefundableAmounts(
  paymentIds: string[],
): Promise<{ data?: RefundableAmount[]; error?: string }> {
  if (paymentIds.length === 0) return { data: [] };

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const { data, error } = await supabase.rpc("get_online_refundable_amount_for_payments", {
    p_payment_ids: paymentIds,
  });
  if (error) {
    const key = error.message.match(/not_authenticated|insufficient_role/)?.[0] ?? "";
    return { error: ERROR_MESSAGES[key] ?? "Failed to load refundable amounts." };
  }

  return {
    data: (data ?? []).map((row) => ({
      paymentId: row.payment_id,
      refundableCents: row.refundable_cents,
      currency: row.currency,
    })),
  };
}

export interface CreateRefundResult {
  status?: "pending" | "requires_action" | "succeeded" | "failed" | "canceled";
  error?: string;
}

export async function createOnlineRefundAction(
  params: {
    paymentId: string;
    amountCents: number;
    reason?: string | null;
  },
  expectedClubId: string,
): Promise<CreateRefundResult> {
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: ERROR_MESSAGES[guard.error] };

  const user = await getAuthUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  // Defense in depth, layer 1 — the locked "Admin only" invariant
  // (locked decision 12). open_payment_refund_attempt/bind_stripe_
  // refund_result are service-role-only (layer 2) — reachable only
  // through this Server Action, never directly from a browser session,
  // and neither re-checks role itself (consistent with 0150's own
  // open_payment_checkout_attempt, which likewise trusts the Server
  // Action's own auth — a service-role-invoked RPC has no caller JWT to
  // independently re-derive a role from).
  const profile = await getAuthProfile();
  if (!profile || profile.role !== "admin") {
    return { error: ERROR_MESSAGES.insufficient_role };
  }

  const context = getStripeContext();
  if (!context) return { error: ERROR_MESSAGES.court_time_payments_not_available };

  const privileged = createPrivilegedClient();
  if (!privileged) return { error: ERROR_MESSAGES.db_not_configured };

  const { data: attemptRows, error: openError } = await privileged.rpc("open_payment_refund_attempt", {
    p_payment_id: params.paymentId,
    p_club_id: expectedClubId,
    p_requested_amount_cents: params.amountCents,
    p_actor_id: user.id,
    p_admin_reason: params.reason || null,
  });

  if (openError || !attemptRows || attemptRows.length === 0) {
    const key =
      openError?.message.match(
        /payment_not_found|invalid_refund_amount|no_online_payment_to_refund|refund_exceeds_online_remaining|pending_refund_amount_mismatch|invalid_arguments/,
      )?.[0] ?? "";
    if (openError && !key) {
      // Not one of this RPC's own documented application errors — an
      // unexpected infrastructure failure, never silently hidden.
      logUnexpectedRefundError("open_payment_refund_attempt", params.paymentId, openError);
    }
    return { error: ERROR_MESSAGES[key] ?? "Failed to start refund." };
  }
  const attempt = attemptRows[0];

  // Already resolved (e.g. a prior attempt for this exact payment
  // already succeeded and this call merely reused/observed it) — return
  // its current status directly rather than re-submitting to Stripe.
  if (attempt.status !== "pending") {
    revalidatePath("/admin/payments");
    return { status: attempt.status };
  }

  // Trusted provenance check (locked decision 3/5) — the ORIGINAL
  // payment's own stored Stripe environment must match this server's
  // CURRENT one before it is ever addressed. A mismatch means the
  // current Stripe API key literally cannot address that PaymentIntent
  // at all (test-mode and live-mode are disjoint API key spaces).
  if (attempt.livemode !== context.livemode) {
    return { error: ERROR_MESSAGES.environment_mismatch };
  }

  // Stripe documents PaymentIntent as nullable even on a paid Checkout
  // Session (0150's own established finding) — resolve it fresh via the
  // stored Session id if the source attempt never captured one. This
  // never calls Stripe until we are certain we have a real refund
  // target.
  let paymentIntentId = attempt.stripe_payment_intent_id;
  let resolvedFreshly = false;
  if (!paymentIntentId && attempt.stripe_checkout_session_id) {
    try {
      const session = await context.client.checkout.sessions.retrieve(
        attempt.stripe_checkout_session_id,
        { expand: ["payment_intent"] },
        { stripeAccount: attempt.stripe_account_id },
      );
      paymentIntentId =
        typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id ?? null;
      resolvedFreshly = paymentIntentId != null;
    } catch {
      paymentIntentId = null;
    }
  }

  if (!paymentIntentId) {
    // Never reached Stripe's refund API at all — safe to mark this
    // specific attempt failed locally (mark_refund_attempt_local_failure
    // itself refuses once a Stripe Refund id is ever bound).
    await privileged.rpc("mark_refund_attempt_local_failure", {
      p_refund_attempt_id: attempt.id,
      p_failure_reason: "payment_intent_unresolvable",
    });
    return { error: ERROR_MESSAGES.stripe_error };
  }

  // Correction pass — a freshly-resolved PaymentIntent is durably
  // persisted (both onto this refund attempt and its source Checkout
  // attempt, via a narrow service-role boundary) BEFORE refunds.create()
  // is ever called. Never held only in memory, and never a reason to
  // later fall back to trusting metadata for provenance — the webhook's
  // own provenance resolver (0153) depends on the SOURCE Checkout
  // attempt's own stored PaymentIntent to correctly match future events.
  if (resolvedFreshly) {
    const { error: backfillError } = await privileged.rpc("backfill_refund_attempt_payment_intent", {
      p_refund_attempt_id: attempt.id,
      p_stripe_payment_intent_id: paymentIntentId,
    });
    if (backfillError) {
      logUnexpectedRefundError("backfill_refund_attempt_payment_intent", params.paymentId, backfillError);
      return { error: ERROR_MESSAGES.stripe_error };
    }
  }

  let refund;
  try {
    refund = await context.client.refunds.create(
      {
        amount: attempt.requested_amount_cents,
        payment_intent: paymentIntentId,
        metadata: buildRefundMetadata({
          refundAttemptId: attempt.id,
          paymentId: params.paymentId,
          clubId: expectedClubId,
        }),
      },
      {
        stripeAccount: attempt.stripe_account_id,
        idempotencyKey: buildRefundIdempotencyKey(attempt.id),
      },
    );
  } catch (err) {
    // Failure-recovery scenario A/E: Stripe's own outcome is genuinely
    // unknown (network error, timeout) AFTER the refund API may already
    // have received the request — financially inaccurate to say "no
    // changes were made" here (correction pass). Never mark this attempt
    // 'failed' — the SAME idempotency key makes a later retry (a fresh
    // Admin click, which will REUSE this exact pending attempt via
    // open_payment_refund_attempt) safe regardless of whether Stripe
    // actually processed the original request.
    logUnexpectedRefundError("refunds.create", params.paymentId, {
      message: err instanceof Error ? err.message : String(err),
    });
    return { error: ERROR_MESSAGES.refund_uncertain };
  }

  // Stripe's own SDK types Refund.status loosely (string | null) even
  // though only five documented values are ever returned — validated
  // here rather than trusting it blindly before it ever reaches the DB
  // layer's own matching CHECK constraint.
  if (!isRefundStatus(refund.status)) {
    logUnexpectedRefundError("refunds.create", params.paymentId, { message: `unrecognized status: ${refund.status}` });
    return { error: ERROR_MESSAGES.refund_uncertain };
  }

  // Failure-recovery scenario B: Stripe succeeded, but this synchronous
  // bind call itself might still fail (network blip on the way back to
  // our own database). The refund attempt row + the signed webhook
  // (which Stripe will still deliver regardless) remain the durable
  // source of truth — never told to the Admin as if nothing happened.
  const { error: bindError } = await privileged.rpc("bind_stripe_refund_result", {
    p_refund_attempt_id: attempt.id,
    p_stripe_refund_id: refund.id,
    p_status: refund.status,
    p_amount_cents: refund.amount,
    p_stripe_account_id: attempt.stripe_account_id,
    p_livemode: attempt.livemode,
    p_currency: refund.currency,
    p_failure_reason: refund.failure_reason ?? null,
    p_stripe_payment_intent_id:
      typeof refund.payment_intent === "string" ? refund.payment_intent : refund.payment_intent?.id ?? null,
  });
  if (bindError) {
    logUnexpectedRefundError("bind_stripe_refund_result", params.paymentId, bindError);
    return { error: ERROR_MESSAGES.refund_uncertain };
  }

  revalidatePath("/admin/payments");
  return { status: refund.status };
}
