"use client";

// Phase 38B Task 3 — Admin-only "Review" sheet for a pending Staff refund
// request. STAFF MAY REQUEST. ADMIN CONTROLS THE MONEY: Approve here
// EXECUTES the Stripe refund immediately (via approveRefundRequestAction,
// which hands the trusted attempt to the SAME shared executeOnlineRefund
// helper direct Admin Refund uses — refundActions.ts) — it never merely
// marks something approved. Reject never touches Stripe at all
// (rejectRefundRequestAction). Both calls accept ONLY requestId/
// rejectionReason — this sheet never sends an amount to Approve, and
// never substitutes a different amount than what Staff originally
// requested.

import { useState } from "react";
import ResponsiveSheet from "@/components/ResponsiveSheet";
import { approveRefundRequestAction, rejectRefundRequestAction, type StaffRefundRequestSummary } from "@/app/(app)/admin/payments/refundActions";
import { formatMoney } from "@/lib/money";
import { STALE_CLUB_MESSAGE } from "@/lib/staleClub";
import { interpretRefundStatus } from "@/lib/stripe/refundConfig";

function mapError(message: string | undefined): string {
  if (!message) return "Something went wrong. Please try again.";
  if (message === STALE_CLUB_MESSAGE) return message;
  return message;
}

export default function ReviewRefundRequestSheet({
  request,
  clubId,
  currentRefundableCents,
  currency,
  title,
  onClose,
  onResolved,
}: {
  request: StaffRefundRequestSummary;
  clubId: string;
  // The LIVE/current refundable amount for this payment (row.refundableCents)
  // — never the amount captured at request-creation time, which may since
  // have changed (a partial manual refund, another attempt, etc.).
  currentRefundableCents: number;
  currency: string;
  title: string;
  onClose: () => void;
  onResolved: () => void;
}) {
  const [mode, setMode] = useState<"review" | "reject">("review");
  const [rejectionReason, setRejectionReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Correction pass — respect request.attemptStatus's own locked meaning
  // (0181/0182): null/failed/canceled mean execution has never started or
  // did not succeed — Reject and Approve/retry both remain available.
  // pending/requires_action mean execution has STARTED — Reject must not
  // be offered, and a second Approve click must not be encouraged.
  // succeeded should normally already be healed out of the pending read
  // model entirely; if observed here transiently, this fails closed the
  // same way pending/requires_action does (no Reject, no second Approve).
  const isExecutionInProgress = request.attemptStatus === "pending" || request.attemptStatus === "requires_action";
  const isExecutionSucceeded = request.attemptStatus === "succeeded";
  const isLocked = isExecutionInProgress || isExecutionSucceeded;

  // LOCKED invariant — if the originally requested amount now exceeds
  // what's actually still refundable, Approve must never silently
  // substitute a lower amount; it is simply disabled, with an explanation,
  // and the Admin's only path forward is Reject (Staff can submit a fresh
  // request afterward).
  const amountExceedsRefundable = request.requestedAmountCents > currentRefundableCents;
  const canApprove = !submitting && !isLocked && !amountExceedsRefundable;
  const trimmedRejectionReason = rejectionReason.trim();
  const canReject = !submitting && !isLocked && trimmedRejectionReason.length > 0;

  async function handleApprove() {
    if (!canApprove) return;
    setSubmitting(true);
    setError(null);

    // No amount argument — approveRefundRequestAction accepts requestId
    // ONLY; the DB uses the stored Staff-requested amount exclusively.
    const result = await approveRefundRequestAction({ requestId: request.requestId }, clubId);

    if (result.error) {
      setError(mapError(result.error));
      setSubmitting(false);
      return;
    }

    // Existing RefundPaymentSheet status behavior/copy, reused via the
    // ONE shared interpretation — never a second refund-status state
    // machine.
    const outcome = interpretRefundStatus(result.status);
    if (outcome.kind === "success") {
      onResolved();
      return;
    }
    if (outcome.kind === "notice") {
      // Correction pass — a "notice" outcome means execution has now
      // STARTED (pending/requires_action). Leaving this sheet open would
      // show stale pre-execution controls (Approve would still look
      // clickable, inviting a second click). Close + let the parent
      // refresh instead, exactly like a successful outcome, so the
      // freshly reloaded pendingRefundRequest reflects the new, locked
      // attemptStatus if this sheet is reopened.
      onResolved();
      return;
    }
    setError(outcome.message);
    setSubmitting(false);
  }

  async function handleReject() {
    if (!canReject) return;
    setSubmitting(true);
    setError(null);

    const result = await rejectRefundRequestAction(
      { requestId: request.requestId, rejectionReason: trimmedRejectionReason },
      clubId,
    );

    if (result.error) {
      setError(mapError(result.error));
      setSubmitting(false);
      return;
    }

    onResolved();
  }

  return (
    <ResponsiveSheet
      onClose={submitting ? () => {} : onClose}
      variant="modal"
      mobileInteraction="draggable"
      label="Review refund request"
      header={<p className="text-base font-semibold text-gray-900 dark:text-gray-100">Review Refund Request</p>}
    >
      <div className="space-y-5 pt-1">
        <p className="text-xs text-gray-500 dark:text-gray-400">{title}</p>

        <div className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-xl bg-gray-50 dark:bg-gray-800/60 p-3">
          <ReviewFact label="Requested by" value={request.requestedByName} />
          <ReviewFact label="Requested amount" value={formatMoney(request.requestedAmountCents, currency)} />
          <ReviewFact label="Currently refundable" value={formatMoney(currentRefundableCents, currency)} />
        </div>

        <div>
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">Reason</p>
          <p className="mt-1 text-sm text-gray-900 dark:text-gray-100">{request.reason}</p>
        </div>

        {request.notes && (
          <div>
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">Notes</p>
            <p className="mt-1 text-sm text-gray-900 dark:text-gray-100">{request.notes}</p>
          </div>
        )}

        {!isLocked && amountExceedsRefundable && (
          <p className="text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-900 rounded-lg px-3 py-2">
            The requested amount is no longer fully refundable — only {formatMoney(currentRefundableCents, currency)} remains
            available online. Approve &amp; Refund is disabled; reject this request so Staff can submit a new one for
            the correct amount.
          </p>
        )}

        {error && <p className="text-xs text-red-500">{error}</p>}

        {isLocked ? (
          // Correction pass — execution has started (pending/requires_
          // action) or, transiently, already succeeded. Neither Reject
          // nor Approve is offered here: rejecting money that may already
          // be moving is unsafe, and a second Approve click must never be
          // encouraged. A concise processing/resolved notice replaces the
          // decision controls entirely — never a second Stripe-status
          // state machine, just this sheet declining to act further.
          <p className="text-xs text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2">
            {isExecutionSucceeded
              ? "This refund has already completed. Refresh to see the latest status."
              : "This refund is currently processing in Stripe. No action is needed here — check back shortly."}
          </p>
        ) : mode === "review" ? (
          <div className="flex gap-2">
            <button
              disabled={submitting}
              onClick={() => setMode("reject")}
              className="flex-1 px-3 py-2.5 rounded-xl text-sm font-semibold text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-40 motion-safe:transition-colors motion-safe:duration-100"
            >
              Reject
            </button>
            <button
              disabled={!canApprove}
              onClick={handleApprove}
              className="flex-1 py-2.5 rounded-xl bg-accent text-white dark:text-gray-900 text-sm font-semibold disabled:opacity-40 hover:brightness-110 motion-safe:transition-all motion-safe:duration-150"
            >
              {submitting ? "Refunding…" : `Approve & Refund ${formatMoney(request.requestedAmountCents, currency)}`}
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                Rejection reason
              </label>
              <input
                type="text"
                value={rejectionReason}
                onChange={(e) => setRejectionReason(e.target.value)}
                placeholder="Why is this request being rejected?"
                className="mt-1.5 w-full rounded-xl border border-gray-200 px-4 py-3 text-base md:text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent bg-white motion-safe:transition-all motion-safe:duration-150 dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100"
              />
            </div>
            <div className="flex gap-2">
              <button
                disabled={submitting}
                onClick={() => { setMode("review"); setRejectionReason(""); setError(null); }}
                className="flex-1 px-3 py-2.5 rounded-xl text-sm font-semibold text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-40 motion-safe:transition-colors motion-safe:duration-100"
              >
                Back
              </button>
              <button
                disabled={!canReject}
                onClick={handleReject}
                className="flex-1 py-2.5 rounded-xl bg-red-600 text-white text-sm font-semibold disabled:opacity-40 hover:brightness-110 motion-safe:transition-all motion-safe:duration-150"
              >
                {submitting ? "Rejecting…" : "Confirm Reject"}
              </button>
            </div>
          </div>
        )}
      </div>
    </ResponsiveSheet>
  );
}

function ReviewFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wide">{label}</p>
      <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 mt-0.5">{value}</p>
    </div>
  );
}
