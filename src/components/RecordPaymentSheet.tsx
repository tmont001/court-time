"use client";

// Phase 34C — compact Record Payment action for Admin + Staff. Only ever
// rendered for an OPEN obligation (caller gates visibility via
// isPaymentOpenForRecording); this sheet itself does not re-derive that
// gate, it trusts the caller and lets the RPC be the final authority.

import { useState } from "react";
import ResponsiveSheet from "@/components/ResponsiveSheet";
import { recordManualPaymentAction } from "@/app/(app)/admin/payments/actions";
import { PAYMENT_METHOD_OPTIONS } from "@/lib/payments";
import { formatMoney } from "@/lib/money";
import { STALE_CLUB_MESSAGE } from "@/lib/staleClub";

function mapRecordPaymentError(message: string | undefined): string {
  if (!message) return "Something went wrong. Please try again.";
  if (message === STALE_CLUB_MESSAGE) return message;
  return message;
}

export default function RecordPaymentSheet({
  paymentId,
  clubId,
  amountDueCents,
  amountPaidCents,
  currency,
  title,
  onClose,
  onRecorded,
}: {
  paymentId: string;
  clubId: string;
  amountDueCents: number;
  amountPaidCents: number;
  currency: string;
  title: string;
  onClose: () => void;
  onRecorded: () => void;
}) {
  const remainingCents = Math.max(0, amountDueCents - amountPaidCents);
  const [amount, setAmount] = useState(remainingCents > 0 ? (remainingCents / 100).toFixed(2) : "");
  const [method, setMethod] = useState("cash");
  const [externalReference, setExternalReference] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const amountCents = Math.round(parseFloat(amount || "0") * 100);
  const canSubmit = !submitting && Number.isFinite(amountCents) && amountCents > 0;

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);

    const { error: rpcError } = await recordManualPaymentAction(
      {
        paymentId,
        amountCents,
        method,
        externalReference: externalReference.trim() || null,
        notes: notes.trim() || null,
      },
      clubId,
    );

    if (rpcError) {
      setError(mapRecordPaymentError(rpcError));
      setSubmitting(false);
      return;
    }

    onRecorded();
  }

  return (
    <ResponsiveSheet
      onClose={onClose}
      variant="modal"
      mobileInteraction="draggable"
      label="Record Payment"
      header={<p className="text-base font-semibold text-gray-900 dark:text-gray-100">Record Payment</p>}
    >
      <div className="space-y-5 pt-1">
        <p className="text-xs text-gray-500 dark:text-gray-400">{title}</p>

        {remainingCents > 0 && (
          <p className="text-xs text-gray-400 dark:text-gray-500">
            {formatMoney(remainingCents, currency)} remaining
          </p>
        )}

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
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              className="w-full rounded-xl border border-gray-200 pl-7 pr-4 py-3 text-base md:text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent bg-white motion-safe:transition-all motion-safe:duration-150 dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100"
            />
          </div>
          <p className="mt-1 text-[11px] text-gray-400 dark:text-gray-500">
            The amount may exceed the remaining balance if this is intentionally an overpayment.
          </p>
        </div>

        <div>
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
            Method
          </label>
          <select
            value={method}
            onChange={(e) => setMethod(e.target.value)}
            className="mt-1.5 w-full rounded-xl border border-gray-200 px-4 py-3 text-base md:text-sm text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100 motion-safe:transition-all motion-safe:duration-150"
          >
            {PAYMENT_METHOD_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
            Reference (optional)
          </label>
          <input
            type="text"
            value={externalReference}
            onChange={(e) => setExternalReference(e.target.value)}
            placeholder="e.g. check number, terminal receipt #"
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
            placeholder="Optional note"
            className="mt-1.5 w-full rounded-xl border border-gray-200 px-4 py-3 text-base md:text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent bg-white motion-safe:transition-all motion-safe:duration-150 dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100"
          />
        </div>

        {error && <p className="text-xs text-red-500">{error}</p>}

        <button
          disabled={!canSubmit}
          onClick={handleSubmit}
          className="w-full py-3 rounded-xl bg-accent text-white dark:text-gray-900 text-sm font-semibold disabled:opacity-40 hover:brightness-110 motion-safe:hover:-translate-y-0.5 motion-safe:hover:shadow-md active:scale-[0.98] motion-safe:active:translate-y-0 motion-safe:transition-all motion-safe:duration-150"
        >
          {submitting ? "Recording…" : "Record Payment"}
        </button>
      </div>
    </ResponsiveSheet>
  );
}
