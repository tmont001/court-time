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
//
// Phase 38B Task 2 — Staff Refund Requests. Added below, in this same
// file (not a parallel implementation):
//   - executeOnlineRefund: the trusted-attempt-to-Stripe-and-back tail
//     extracted verbatim out of createOnlineRefundAction (this function's
//     own behavior is unchanged — it now simply calls the extracted
//     helper after opening its attempt exactly as before).
//   - createRefundRequestAction / fetchPendingRefundRequests /
//     rejectRefundRequestAction: thin wrappers over the plain-
//     authenticated create_refund_request / get_pending_refund_requests_
//     for_payments / reject_refund_request RPCs (0181) — each of those
//     RPCs is ALREADY the full authorization boundary via its own
//     current_user_club_id()/current_user_role() checks, exactly like
//     record_refund/reassign_lesson_provider's own established pattern,
//     so no redundant Server-Action-layer role check is added for these
//     three (there would be nothing for it to defend that the RPC does
//     not already defend, and a second copy of that logic could only
//     drift out of sync with the DB's own authoritative check).
//   - approveRefundRequestAction: calls begin_refund_request_execution
//     (service_role-only, 0181/0182) — THIS one DOES need the same
//     defense-in-depth "resolve role via getAuthProfile() before ever
//     reaching the privileged client" layer createOnlineRefundAction
//     already uses, for the identical reason: a service-role-invoked RPC
//     has no caller JWT to independently re-derive a role from, so the
//     Server Action is the ONLY authorization boundary for that call.
//     Accepts requestId ONLY from the client — never an amount; the DB
//     RPC uses the stored Staff-requested amount exclusively.

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

  // Phase 38B — Staff Refund Requests (create_refund_request,
  // get_pending_refund_requests_for_payments, reject_refund_request,
  // begin_refund_request_execution, 0181/0182). Reuses every code above
  // that these RPCs can ALSO raise (payment_not_found,
  // invalid_refund_amount, no_online_payment_to_refund,
  // refund_exceeds_online_remaining, insufficient_role,
  // not_authenticated) rather than a second, potentially-drifting copy —
  // only the codes genuinely NEW to this feature are added here.
  refund_reason_required: "Please enter a reason for this refund request.",
  refund_request_already_pending: "A refund request is already pending for this payment.",
  request_not_found: "That refund request could not be found.",
  request_not_pending: "That refund request has already been reviewed.",
  rejection_reason_required: "Please enter a reason for rejecting this request.",
  // Correction pass (0181) — a pending request whose linked Stripe
  // attempt has already begun executing (or already succeeded) can no
  // longer be rejected; the Admin should review its current outcome
  // instead, never silently reject money that may already be moving.
  refund_request_execution_started: "This request has already started executing and can no longer be rejected.",
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

// The trusted row shape BOTH open_payment_refund_attempt AND
// begin_refund_request_execution return — identical columns, in the same
// order, by design (0181/0182's own locked decision) — which is exactly
// what makes executeOnlineRefund below valid for either entry point
// without an adapter.
interface TrustedRefundAttempt {
  id: string;
  payment_id: string;
  club_id: string;
  source_checkout_attempt_id: string;
  stripe_account_id: string;
  livemode: boolean;
  stripe_checkout_session_id: string | null;
  stripe_payment_intent_id: string | null;
  requested_amount_cents: number;
  status: "pending" | "requires_action" | "succeeded" | "failed" | "canceled";
  currency: string;
}

type PrivilegedClient = NonNullable<ReturnType<typeof createPrivilegedClient>>;

// Phase 38B extraction — the trusted execution tail of createOnlineRefundAction,
// unchanged in behavior, now shared by BOTH the existing direct Admin
// Refund path and the new Staff-refund-request Approve & Refund path.
// Accepts a TRUSTED refund-attempt row already opened/reused/resolved by
// one of the two service-role RPCs above — never raw client authority;
// this function itself never re-derives club/actor/role from anything,
// it only ever acts on the attempt it is handed.
async function executeOnlineRefund(
  attempt: TrustedRefundAttempt,
  context: NonNullable<ReturnType<typeof getStripeContext>>,
  privileged: PrivilegedClient,
  params: { paymentId: string; clubId: string },
): Promise<CreateRefundResult> {
  // Already resolved — either a prior attempt for this exact payment
  // already reached a terminal/in-progress state and this call merely
  // reused/observed it (open_payment_refund_attempt's own reuse rule),
  // or begin_refund_request_execution just healed an already-succeeded
  // attempt to 'completed' without this call ever needing to touch
  // Stripe. Return its current status directly rather than re-submitting
  // to Stripe — this is what guarantees no second stripe.refunds.create()
  // call is ever made for an attempt that isn't genuinely 'pending'.
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
          clubId: params.clubId,
        }),
      },
      {
        stripeAccount: attempt.stripe_account_id,
        // Deterministic per-refund-attempt idempotency key — the SAME key
        // for any retry of THIS exact attempt id, regardless of whether
        // the attempt was opened via the direct Admin Refund path or the
        // Staff-request approval path. No second idempotency scheme.
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
    // open_payment_refund_attempt/begin_refund_request_execution) safe
    // regardless of whether Stripe actually processed the original
    // request.
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
  // bind_stripe_refund_result's own shared reconciler (_reconcile_stripe_
  // refund_attempt) is what idempotently completes a linked refund
  // request, if any, on genuine success (0181's own extension) — this
  // Server Action never touches payment_refund_requests directly.
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

  // G-D1 correction — expectedClubId is a stale-context preflight ONLY
  // (checked above via assertActiveClub). The authoritative financial
  // tenant identity for every DB/RPC/Stripe-metadata operation below is
  // the server-derived profile.club_id, never the client-supplied value —
  // matching exportActions.ts's own established pattern exactly.
  const clubId = profile.club_id;
  if (!clubId) return { error: ERROR_MESSAGES.db_not_configured };

  const context = getStripeContext();
  if (!context) return { error: ERROR_MESSAGES.court_time_payments_not_available };

  const privileged = createPrivilegedClient();
  if (!privileged) return { error: ERROR_MESSAGES.db_not_configured };

  const { data: attemptRows, error: openError } = await privileged.rpc("open_payment_refund_attempt", {
    p_payment_id: params.paymentId,
    p_club_id: clubId,
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

  // Existing direct Admin Refund behavior, functionally unchanged: open
  // the attempt exactly as before, then hand it to the SAME shared
  // execution tail the new Staff-request approval path also uses.
  return executeOnlineRefund(attemptRows[0], context, privileged, { paymentId: params.paymentId, clubId });
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 38B — Staff Refund Requests
// ═══════════════════════════════════════════════════════════════════════════
//
// Core rule: STAFF MAY REQUEST. ADMIN CONTROLS THE MONEY.
//
// create_refund_request / get_pending_refund_requests_for_payments /
// reject_refund_request are all plain AUTHENTICATED RPCs (not
// service-role) that derive club/role/actor exclusively via
// current_user_club_id()/current_user_role()/auth.uid() internally —
// never from a parameter. No club/actor/role is ever accepted from the
// client by these three Server Actions either; the RPC is the sole
// authorization boundary, exactly like record_refund/
// reassignLessonProviderAction's own established precedent (a plain
// authenticated RPC that already checks role itself needs no redundant
// Server-Action-layer recheck — see this file's own header comment).

export interface StaffRefundRequestSummary {
  requestId: string;
  paymentId: string;
  requestedBy: string;
  requestedByName: string;
  requestedAmountCents: number;
  reason: string;
  notes: string | null;
  refundAttemptId: string | null;
  attemptStatus: "pending" | "requires_action" | "succeeded" | "failed" | "canceled" | null;
  createdAt: string;
}

// Phase 38B Task 3 correction — `context: "create"` covers the ONE case
// where the shared ERROR_MESSAGES.insufficient_role copy ("Only an Admin
// can issue a refund.") would be actively wrong: create_refund_request
// (0181) raises insufficient_role for anyone who is NOT 'staff' — the
// opposite requirement from every other caller of this shared map, which
// all require 'admin'. Rather than forking ERROR_MESSAGES into a second,
// drifting copy, this is the smallest possible override: one extra key
// checked only for this one call site, everything else still falls
// through to the SAME shared map every other action in this file uses.
function mapRefundRequestError(message: string, context?: "create"): string {
  const key =
    message.match(
      /not_authenticated|insufficient_role|payment_not_found|invalid_refund_amount|no_online_payment_to_refund|refund_exceeds_online_remaining|refund_reason_required|refund_request_already_pending|request_not_found|request_not_pending|rejection_reason_required|refund_request_execution_started|invalid_arguments/,
    )?.[0] ?? "";
  if (context === "create" && key === "insufficient_role") {
    return "Only Staff can request a refund.";
  }
  return ERROR_MESSAGES[key] ?? "Something went wrong. Please try again.";
}

// ─── createRefundRequestAction — Staff only ──────────────────────────────────
//
// Inputs accepted from the client are exactly what a Staff member
// legitimately enters by hand: paymentId, amountCents, reason, optional
// notes. No club id, actor id, or role — create_refund_request derives
// the caller's club/role itself and inserts requested_by = auth.uid()
// server-side; nothing here could substitute a different identity even
// if a malicious client tried.
export async function createRefundRequestAction(
  params: {
    paymentId: string;
    amountCents: number;
    reason: string;
    notes?: string | null;
  },
  expectedClubId: string,
): Promise<{ error?: string }> {
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: ERROR_MESSAGES[guard.error] };

  const supabase = await createClient();
  const { error } = await supabase.rpc("create_refund_request", {
    p_payment_id: params.paymentId,
    p_amount_cents: params.amountCents,
    p_reason: params.reason,
    p_notes: params.notes ?? null,
  });

  if (error) return { error: mapRefundRequestError(error.message, "create") };

  revalidatePath("/admin/payments");
  return {};
}

// ─── fetchPendingRefundRequests — Admin + Staff, read-only ───────────────────
//
// Mirrors fetchOnlineRefundableAmounts' own exact shape/discipline: no
// assertActiveClub (a stale read is never a security concern — the RPC's
// own current_user_club_id() scoping is always correct for whichever
// club the caller currently belongs to; staleness only matters for
// mutations).
export async function fetchPendingRefundRequests(
  paymentIds: string[],
): Promise<{ data?: StaffRefundRequestSummary[]; error?: string }> {
  if (paymentIds.length === 0) return { data: [] };

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const { data, error } = await supabase.rpc("get_pending_refund_requests_for_payments", {
    p_payment_ids: paymentIds,
  });
  if (error) return { error: mapRefundRequestError(error.message) };

  return {
    data: (data ?? []).map((row) => ({
      requestId: row.request_id,
      paymentId: row.payment_id,
      requestedBy: row.requested_by,
      requestedByName: row.requested_by_name,
      requestedAmountCents: row.requested_amount_cents,
      reason: row.reason,
      notes: row.notes,
      refundAttemptId: row.refund_attempt_id,
      attemptStatus: row.attempt_status,
      createdAt: row.created_at,
    })),
  };
}

// ─── rejectRefundRequestAction — Admin only ──────────────────────────────────
//
// Never touches Stripe, never reaches the privileged client — reject_
// refund_request is a plain authenticated RPC and is the sole
// authorization boundary (current_user_role() is distinct from 'admin'
// check, 0181). No refund attempt is created by this path.
export async function rejectRefundRequestAction(
  params: {
    requestId: string;
    rejectionReason: string;
  },
  expectedClubId: string,
): Promise<{ error?: string }> {
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: ERROR_MESSAGES[guard.error] };

  const supabase = await createClient();
  const { error } = await supabase.rpc("reject_refund_request", {
    p_request_id: params.requestId,
    p_rejection_reason: params.rejectionReason,
  });

  if (error) return { error: mapRefundRequestError(error.message) };

  revalidatePath("/admin/payments");
  return {};
}

// ─── approveRefundRequestAction — Admin only, executes immediately ──────────
//
// Accepts requestId ONLY — there is no amount parameter anywhere in this
// function's own signature, so a client literally cannot supply one; the
// DB's begin_refund_request_execution always uses the STORED Staff-
// requested amount. club id and actor id are both derived server-side
// (profile.club_id / user.id) and passed to the service-role RPC — never
// accepted as client input.
//
// Defense in depth, layer 1 — the SAME "Admin only" pattern
// createOnlineRefundAction already uses: begin_refund_request_execution
// is service-role-only (layer 2) and does not re-check role itself (it
// has no caller JWT to derive one from), so THIS Server Action is the
// only place that authorization is actually enforced for this call.
export async function approveRefundRequestAction(
  params: { requestId: string },
  expectedClubId: string,
): Promise<CreateRefundResult> {
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: ERROR_MESSAGES[guard.error] };

  const user = await getAuthUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const profile = await getAuthProfile();
  if (!profile || profile.role !== "admin") {
    return { error: ERROR_MESSAGES.insufficient_role };
  }

  const clubId = profile.club_id;
  if (!clubId) return { error: ERROR_MESSAGES.db_not_configured };

  const context = getStripeContext();
  if (!context) return { error: ERROR_MESSAGES.court_time_payments_not_available };

  const privileged = createPrivilegedClient();
  if (!privileged) return { error: ERROR_MESSAGES.db_not_configured };

  const { data: attemptRows, error: beginError } = await privileged.rpc("begin_refund_request_execution", {
    p_request_id: params.requestId,
    p_club_id: clubId,
    p_actor_id: user.id,
  });

  if (beginError || !attemptRows || attemptRows.length === 0) {
    const key =
      beginError?.message.match(
        /invalid_arguments|request_not_found|payment_not_found|request_not_pending|no_online_payment_to_refund|refund_exceeds_online_remaining|pending_refund_amount_mismatch/,
      )?.[0] ?? "";
    if (beginError && !key) {
      logUnexpectedRefundError("begin_refund_request_execution", params.requestId, beginError);
    }
    return { error: ERROR_MESSAGES[key] ?? "Failed to approve refund." };
  }

  // Trusted attempt context (fresh, reused, or already-healed-to-
  // succeeded — begin_refund_request_execution's own return shape is
  // identical to open_payment_refund_attempt's) handed to the SAME
  // shared execution tail direct Admin Refund uses. If the attempt is
  // already 'succeeded' (the heal branch), executeOnlineRefund's own
  // first check returns immediately without ever calling Stripe again —
  // no second refund, no duplicated Stripe logic.
  return executeOnlineRefund(attemptRows[0], context, privileged, {
    paymentId: attemptRows[0].payment_id,
    clubId,
  });
}
