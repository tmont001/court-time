"use client";

// Phase 34D-D3 — confirmation required before turning Payment Tracking
// OFF, since doing so stops NEW payment obligations (and, transitively,
// new online-payable obligations) from being created going forward.
// Existing balances and payment history are never affected by this
// action — record_manual_payment and every other resolution path remain
// independent of the club's current payment_mode (see
// PaymentTrackingSection's own header comment for why).

import ResponsiveSheet from "@/components/ResponsiveSheet";

interface Props {
  submitting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function DisablePaymentTrackingConfirmModal({ submitting, onConfirm, onCancel }: Props) {
  return (
    <ResponsiveSheet
      onClose={submitting ? () => {} : onCancel}
      variant="modal"
      mobileInteraction="draggable"
      label="Turn off payment tracking?"
      header={
        <p className="text-base font-semibold text-gray-900 dark:text-gray-100">
          Turn off payment tracking?
        </p>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-gray-600 dark:text-gray-300">
          New bookings will no longer create payment balances or offer online payment. Existing
          balances and payment history will remain available.
        </p>

        <div className="flex gap-2 pt-1">
          <button
            onClick={onCancel}
            disabled={submitting}
            className="flex-1 py-3 rounded-xl text-sm font-semibold bg-gray-50 dark:bg-gray-700/60 text-gray-900 dark:text-gray-100 border border-gray-200 dark:border-gray-600 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={submitting}
            className="flex-1 py-3 rounded-xl bg-red-600 text-white text-sm font-semibold disabled:opacity-40 hover:brightness-110 active:scale-[0.98] motion-safe:transition-all motion-safe:duration-150"
          >
            {submitting ? "Turning off…" : "Turn Off"}
          </button>
        </div>
      </div>
    </ResponsiveSheet>
  );
}
