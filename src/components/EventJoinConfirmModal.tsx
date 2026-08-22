"use client";

// Phase 34C — lightweight commitment confirmation for joining a
// positive-price Event. Deliberately commitment language, never checkout
// language — Court Time is not collecting online in 34C. Only ever shown
// when price_amount_cents > 0; callers keep the existing frictionless
// flow for Free/unpriced events entirely unchanged.

import ResponsiveSheet from "@/components/ResponsiveSheet";
import { formatMoney } from "@/lib/money";

interface Props {
  eventTitle: string;
  priceCents: number;
  currency: string;
  // Known at click time from the same occupancy count already driving the
  // "Join Event" / "Join Waitlist" button label — not re-derived here.
  willWaitlist: boolean;
  submitting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function EventJoinConfirmModal({
  eventTitle, priceCents, currency, willWaitlist, submitting, onConfirm, onCancel,
}: Props) {
  const priceLabel = formatMoney(priceCents, currency);

  return (
    <ResponsiveSheet
      onClose={submitting ? () => {} : onCancel}
      variant="modal"
      mobileInteraction="draggable"
      label={willWaitlist ? "Join Waitlist?" : "Join Event?"}
      header={
        <p className="text-base font-semibold text-gray-900 dark:text-gray-100">
          {willWaitlist ? `Join the waitlist for ${eventTitle}?` : `Join ${eventTitle}?`}
        </p>
      }
    >
      <div className="space-y-4">
        {willWaitlist ? (
          <p className="text-sm text-gray-600 dark:text-gray-300">
            You&rsquo;ll join the waitlist. No payment obligation is created unless your spot is
            confirmed. If a spot opens and is confirmed, the Event price of {priceLabel} will apply.
          </p>
        ) : (
          <>
            <p className="text-sm text-gray-600 dark:text-gray-300">
              Price: <span className="font-semibold text-gray-900 dark:text-gray-100">{priceLabel}</span> per participant
            </p>
            <p className="text-sm text-gray-600 dark:text-gray-300">
              Confirm that you want to reserve your spot.
            </p>
          </>
        )}

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
            className="flex-1 py-3 rounded-xl bg-accent text-white dark:text-gray-900 text-sm font-semibold disabled:opacity-40 hover:brightness-110 active:scale-[0.98] motion-safe:transition-all motion-safe:duration-150"
          >
            {submitting ? "Joining…" : willWaitlist ? "Join Waitlist" : `Join for ${priceLabel}`}
          </button>
        </div>
      </div>
    </ResponsiveSheet>
  );
}
