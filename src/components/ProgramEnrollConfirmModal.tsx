"use client";

// Phase 34C consolidation — commitment confirmation for enrolling in a
// positive-price Whole Program. Mirrors EventJoinConfirmModal's pattern
// (commitment language, never checkout language — Court Time does not
// collect online in 34C) but is deliberately its own component: unlike an
// Event, a Member has no client-visible signal for whether a Whole
// Program still has an open spot (program_enrollments RLS never exposes
// other members' rows to a plain Member, and adding a capacity-count RPC
// is out of scope for this pass) — so "Join Program" cannot honestly claim
// either "you'll be enrolled" or "you'll be waitlisted" ahead of time, only
// "Rejoin Waitlist" (re-entering a queue the Member was already in) can.
// Reusing EventJoinConfirmModal's two-state willWaitlist boolean would
// force one of those two inaccurate claims onto the unknown-outcome case.

import ResponsiveSheet from "@/components/ResponsiveSheet";
import { formatMoney } from "@/lib/money";

interface Props {
  programTitle: string;
  priceCents: number;
  currency: string;
  // true  — definitely joining the waitlist (Rejoin Waitlist, re-entering
  //         a queue the Member was already in).
  // false — outcome isn't knowable client-side (initial Join Program) —
  //         may enroll immediately or land on the waitlist depending on
  //         real-time capacity, resolved only by the RPC itself.
  willDefinitelyWaitlist: boolean;
  submitting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ProgramEnrollConfirmModal({
  programTitle, priceCents, currency, willDefinitelyWaitlist, submitting, onConfirm, onCancel,
}: Props) {
  const priceLabel = formatMoney(priceCents, currency);

  return (
    <ResponsiveSheet
      onClose={submitting ? () => {} : onCancel}
      variant="modal"
      mobileInteraction="draggable"
      label={willDefinitelyWaitlist ? "Join Waitlist?" : "Enroll?"}
      header={
        <p className="text-base font-semibold text-gray-900 dark:text-gray-100">
          {willDefinitelyWaitlist ? `Join the waitlist for ${programTitle}?` : `Enroll in ${programTitle}?`}
        </p>
      }
    >
      <div className="space-y-4">
        {willDefinitelyWaitlist ? (
          <p className="text-sm text-gray-600 dark:text-gray-300">
            You&rsquo;ll join the waitlist. No payment obligation is created unless your spot is
            confirmed. If a spot opens and is confirmed, the Program price of {priceLabel} will apply.
          </p>
        ) : (
          <>
            <p className="text-sm text-gray-600 dark:text-gray-300">
              Program price: <span className="font-semibold text-gray-900 dark:text-gray-100">{priceLabel}</span> total
            </p>
            <p className="text-sm text-gray-600 dark:text-gray-300">
              Confirm that you want to enroll. If the program is full, you&rsquo;ll join the waitlist
              instead — the price only applies once a spot is confirmed.
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
            {submitting ? "Joining…" : willDefinitelyWaitlist ? "Join Waitlist" : `Enroll for ${priceLabel}`}
          </button>
        </div>
      </div>
    </ResponsiveSheet>
  );
}
