"use client";

// Phase 34E-B — compact Refund action for Admin only. Only ever rendered
// when there is eligible online Stripe money (caller gates visibility via
// isOnlineRefundEligible); this sheet itself does not re-derive that gate
// — it trusts the caller and lets the RPC be the final authority, exactly
// mirroring RecordPaymentSheet's own established discipline.

import { useState } from "react";
import ResponsiveSheet from "@/components/ResponsiveSheet";
import { createOnlineRefundAction } from "@/app/(app)/admin/payments/refundActions";
import { formatMoney } from "@/lib/money";
import { STALE_CLUB_MESSAGE } from "@/lib/staleClub";

function mapRefundError(message: string | undefined): string {
  if (!message) return "Something went wrong. Please try again.";
  if (message === STALE_CLUB_MESSAGE) return message;
  return message;
}

export default function RefundPaymentSheet({
  paymentId,
  clubId,
  refundableCents,
  currency,
  title,
  onClose,
  onRefunded,
}: {
  paymentId: string;
  clubId: string;
  refundableCents: number;
  currency: string;
  title: string;
  onClose: () => void;
  onRefunded: () => void;
}) {
  const [amount, setAmount] = useState(refundableCents > 0 ? (refundableCents / 100).toFixed(2) : "");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Correction pass — distinct from `error`: a genuinely non-error
  // outcome (pending/requires_action) still needs feedback, but must
  // never be styled/worded like the destructive `failed`/`canceled`
  // outcomes below it. Kept as its own state rather than folded into
  // `error` so the two tones can never be conflated.
  const [statusNotice, setStatusNotice] = useState<string | null>(null);

  const amountCents = Math.round(parseFloat(amount || "0") * 100);
  const canSubmit = !submitting && Number.isFinite(amountCents) && amountCents > 0 && amountCents <= refundableCents;

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    setStatusNotice(null);

    const result = await createOnlineRefundAction(
      { paymentId, amountCents, reason: reason.trim() || null },
      clubId,
    );

    if (result.error) {
      setError(mapRefundError(result.error));
      setSubmitting(false);
      return;
    }

    // Correction pass — every one of Stripe's five documented Refund
    // statuses is handled explicitly. Only 'succeeded' is treated as
    // success (onRefunded); every other status shows clear, distinct
    // feedback and never calls onRefunded as though money had moved.
    switch (result.status) {
      case "succeeded":
        onRefunded();
        return;
      case "pending":
        // Cards resolve synchronously in the overwhelming majority of
        // cases — this branch exists for the rare method/timing where
        // Stripe hasn't finished yet. The signed webhook (0153) will
        // finish reconciling regardless of whether this sheet stays open.
        setStatusNotice("Refund submitted — it will finish processing shortly.");
        setSubmitting(false);
        return;
      case "requires_action":
        setStatusNotice("This refund needs further action in Stripe before it can complete. It has not been refunded yet.");
        setSubmitting(false);
        return;
      case "failed":
        setError("The refund failed. No money was returned. Check Stripe for details, or try again.");
        setSubmitting(false);
        return;
      case "canceled":
        setError("The refund was canceled. No money was returned.");
        setSubmitting(false);
        return;
      default:
        // Structurally unreachable (createOnlineRefundAction only ever
        // returns one of the five statuses above alongside a non-error
        // result) — fails closed rather than silently treating an
        // unrecognized status as success.
        setError("Something went wrong. Please check back before trying again.");
        setSubmitting(false);
        return;
    }
  }

  return (
    <ResponsiveSheet
      onClose={submitting ? () => {} : onClose}
      variant="modal"
      mobileInteraction="draggable"
      label="Refund"
      header={<p className="text-base font-semibold text-gray-900 dark:text-gray-100">Refund</p>}
    >
      <div className="space-y-5 pt-1">
        <p className="text-xs text-gray-500 dark:text-gray-400">{title}</p>

        <p className="text-xs text-gray-400 dark:text-gray-500">
          {formatMoney(refundableCents, currency)} available to refund online
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
            Reason (optional)
          </label>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Optional note"
            className="mt-1.5 w-full rounded-xl border border-gray-200 px-4 py-3 text-base md:text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent bg-white motion-safe:transition-all motion-safe:duration-150 dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100"
          />
        </div>

        {error && <p className="text-xs text-red-500">{error}</p>}
        {statusNotice && <p className="text-xs text-amber-600 dark:text-amber-400">{statusNotice}</p>}

        <button
          disabled={!canSubmit}
          onClick={handleSubmit}
          className="w-full py-3 rounded-xl bg-accent text-white dark:text-gray-900 text-sm font-semibold disabled:opacity-40 hover:brightness-110 motion-safe:hover:-translate-y-0.5 motion-safe:hover:shadow-md active:scale-[0.98] motion-safe:active:translate-y-0 motion-safe:transition-all motion-safe:duration-150"
        >
          {submitting ? "Refunding…" : "Refund"}
        </button>
      </div>
    </ResponsiveSheet>
  );
}
