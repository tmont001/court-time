"use client";

// Phase 38B Task 3 — Staff-only "Request Refund" sheet. STAFF MAY REQUEST.
// ADMIN CONTROLS THE MONEY: this sheet never executes a Stripe refund and
// never calls createOnlineRefundAction/approveRefundRequestAction/
// rejectRefundRequestAction — it calls ONLY createRefundRequestAction,
// which itself never reaches Stripe or the privileged client (see
// refundActions.ts's own header comment). Mirrors RefundPaymentSheet's
// established responsive interaction pattern and input conventions
// exactly, so the two sheets read as the same family of control.

import { useState } from "react";
import ResponsiveSheet from "@/components/ResponsiveSheet";
import { createRefundRequestAction } from "@/app/(app)/admin/payments/refundActions";
import { formatMoney } from "@/lib/money";
import { STALE_CLUB_MESSAGE } from "@/lib/staleClub";

function mapRequestError(message: string | undefined): string {
  if (!message) return "Something went wrong. Please try again.";
  if (message === STALE_CLUB_MESSAGE) return message;
  return message;
}

export default function RequestRefundSheet({
  paymentId,
  clubId,
  refundableCents,
  currency,
  title,
  onClose,
  onRequested,
}: {
  paymentId: string;
  clubId: string;
  refundableCents: number;
  currency: string;
  title: string;
  onClose: () => void;
  onRequested: () => void;
}) {
  const [amount, setAmount] = useState(refundableCents > 0 ? (refundableCents / 100).toFixed(2) : "");
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const amountCents = Math.round(parseFloat(amount || "0") * 100);
  const trimmedReason = reason.trim();
  const canSubmit =
    !submitting &&
    Number.isFinite(amountCents) &&
    amountCents > 0 &&
    amountCents <= refundableCents &&
    trimmedReason.length > 0;

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);

    const result = await createRefundRequestAction(
      { paymentId, amountCents, reason: trimmedReason, notes: notes.trim() || null },
      clubId,
    );

    if (result.error) {
      setError(mapRequestError(result.error));
      setSubmitting(false);
      return;
    }

    // Success — close through the callback, parent refreshes the payment
    // data (mirrors RefundPaymentSheet's onRefunded handoff exactly).
    onRequested();
  }

  return (
    <ResponsiveSheet
      onClose={submitting ? () => {} : onClose}
      variant="modal"
      mobileInteraction="draggable"
      label="Request Refund"
      header={<p className="text-base font-semibold text-gray-900 dark:text-gray-100">Request Refund</p>}
    >
      <div className="space-y-5 pt-1">
        <p className="text-xs text-gray-500 dark:text-gray-400">{title}</p>

        <p className="text-xs text-gray-400 dark:text-gray-500">
          {formatMoney(refundableCents, currency)} available to refund online. An Admin must approve this request
          before any money moves.
        </p>

        <div>
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
            Amount
          </label>
          <div className="mt-1.5 relative">
            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500 text-base md:text-sm">
              $
            </span>
            <input
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              max={(refundableCents / 100).toFixed(2)}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              className="w-full rounded-xl border border-gray-200 pl-7 pr-4 py-3 text-base md:text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent bg-white motion-safe:transition-all motion-safe:duration-150 dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100"
            />
          </div>
          <p className="mt-1 text-[11px] text-gray-400 dark:text-gray-500">
            Only the online (Stripe) portion of this payment can be refunded here. Cash, check, and other
            offline payments are never refunded through Stripe.
          </p>
        </div>

        <div>
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
            Reason
          </label>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why is this refund being requested?"
            className="mt-1.5 w-full rounded-xl border border-gray-200 px-4 py-3 text-base md:text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent bg-white motion-safe:transition-all motion-safe:duration-150 dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100"
          />
        </div>

        <div>
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
            Notes (optional)
          </label>
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Optional note for the Admin reviewing this request"
            className="mt-1.5 w-full rounded-xl border border-gray-200 px-4 py-3 text-base md:text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent bg-white motion-safe:transition-all motion-safe:duration-150 dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100"
          />
        </div>

        {error && <p className="text-xs text-red-500">{error}</p>}

        <button
          disabled={!canSubmit}
          onClick={handleSubmit}
          className="w-full py-3 rounded-xl bg-accent text-white dark:text-gray-900 text-sm font-semibold disabled:opacity-40 hover:brightness-110 motion-safe:hover:-translate-y-0.5 motion-safe:hover:shadow-md active:scale-[0.98] motion-safe:active:translate-y-0 motion-safe:transition-all motion-safe:duration-150"
        >
          {submitting ? "Submitting…" : "Submit Request"}
        </button>
      </div>
    </ResponsiveSheet>
  );
}
