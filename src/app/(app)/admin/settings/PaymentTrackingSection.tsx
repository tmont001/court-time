"use client";

// Phase 34C — Admin-only payment tracking control. Admin only reaches this
// page at all (AdminSettingsPage redirects any non-admin), so no
// additional role gating is needed here beyond the RPC's own Admin check.
//
// Phase 34D-D3 — restructured from a single mutually-exclusive None /
// Manual / Court Time Payments selector into a two-value ON/OFF control —
// WITHOUT changing the underlying domain model. club_settings.payment_mode
// remains the exact same single 3-value enum it always was; the toggle
// below is a pure DERIVED view of that one value (`mode` is the only
// client-side state that represents it), and its mutation still goes
// through the exact same RPC this component already called before this
// restructure: update_club_payment_mode (none/manual).
//
// Phase 34G-B — this component is now responsible ONLY for the base
// tracking layer (Payment Tracking on/off). The online-payment layer
// (Court Time Payments) is its own sibling component, CourtTimePaymentsSection,
// grouped with StripeConnectSection under the same top-level "Payments"
// settings section (Payment Tracking, then an "Online Payments" group
// containing Stripe Account then Court Time Payments — see page.tsx).
// Both PaymentTrackingSection and CourtTimePaymentsSection derive from and
// mutate the SAME single club_settings.payment_mode enum via the SAME
// shared helpers (@/lib/paymentModeToggle) and the SAME Server Action
// (updateClubPaymentModeAction) — never a second, independently-tracked
// representation. Because they are two separate client component
// instances, each resyncs its own local `mode` state from the
// `currentMode` prop whenever it changes (see the useEffect below) — this
// is what keeps them from drifting out of sync with EACH OTHER after the
// OTHER section's own mutation: updateClubPaymentModeAction always calls
// revalidatePath("/admin/settings") on success, which re-renders this
// Server Component page and pushes a fresh `currentMode` prop into BOTH
// sibling client components, not only the one that mutated.
//
// Phase 34G-B (hierarchy correction) — the former standalone "Offline
// payments" card is removed. It visually matched the toggle card above it
// but had no toggle of its own, reading as a second configurable mode
// when it was purely informational. Its useful content (manual payments
// remain recordable regardless of this toggle) is now a single compact
// helper line INSIDE the Payment Tracking card itself — see the render
// below.
//
// Locked mapping (from the 34D-D3 audit, unchanged):
//   none                  = tracking OFF
//   manual                = tracking ON
//   court_time_payments   = tracking ON (Court Time Payments' own on/off
//                            state is CourtTimePaymentsSection's concern,
//                            not this component's)

import { useEffect, useState, useTransition } from "react";
import { updateClubPaymentModeAction } from "@/app/(app)/admin/payments/actions";
import DisablePaymentTrackingConfirmModal from "@/components/DisablePaymentTrackingConfirmModal";
import {
  isPaymentTrackingOn,
  nextModeForTrackingToggle,
  type PaymentMode,
} from "@/lib/paymentModeToggle";

function ToggleSwitch({
  checked,
  disabled,
  label,
  onClick,
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`relative shrink-0 inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-gray-400 dark:focus-visible:ring-offset-gray-800 ${
        disabled ? "opacity-40 cursor-not-allowed" : ""
      } ${checked ? "bg-accent" : "bg-gray-200 dark:bg-gray-700"}`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
          checked ? "translate-x-6" : "translate-x-1"
        }`}
      />
    </button>
  );
}

export default function PaymentTrackingSection({
  clubId,
  currentMode,
}: {
  clubId: string;
  currentMode: PaymentMode;
}) {
  // The ONE piece of client-side state representing payment_mode for THIS
  // component's own view of it — resynced from the server-confirmed prop
  // whenever it changes (see the module header comment above for why).
  const [mode, setMode] = useState<PaymentMode>(currentMode);
  const [isPending, startTransition] = useTransition();
  const [status, setStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [confirmingDisableTracking, setConfirmingDisableTracking] = useState(false);

  useEffect(() => {
    setMode(currentMode);
  }, [currentMode]);

  const trackingOn = isPaymentTrackingOn(mode);

  function submitMode(next: PaymentMode) {
    setStatus(null);
    startTransition(async () => {
      const result = await updateClubPaymentModeAction(next, clubId);
      if (result.error) {
        // Never optimistically flips — `mode` stays exactly where it was
        // before this attempt.
        setStatus({ type: "error", message: result.error });
      } else {
        setMode(next);
        setStatus({ type: "success", message: "Saved" });
        setTimeout(() => setStatus(null), 2000);
      }
    });
  }

  function handleTrackingToggle() {
    if (isPending) return;
    if (trackingOn) {
      // manual -> none, or court_time_payments -> none: both stop NEW
      // obligation creation (and, transitively, online payments) — an
      // intentional action, so it requires explicit confirmation rather
      // than firing immediately on click.
      setConfirmingDisableTracking(true);
      return;
    }
    submitMode(nextModeForTrackingToggle(mode, true));
  }

  function handleConfirmDisableTracking() {
    setConfirmingDisableTracking(false);
    submitMode(nextModeForTrackingToggle(mode, false));
  }

  return (
    <div className="space-y-3">
      {/* Payment tracking */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 px-4 py-3.5">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">Payment tracking</p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              {trackingOn
                ? "Court Time creates and maintains payment balances for new bookings."
                : "New bookings will not create payment balances. Existing balances and payment history remain available."}
            </p>
          </div>
          <ToggleSwitch
            checked={trackingOn}
            disabled={isPending}
            label="Payment tracking"
            onClick={handleTrackingToggle}
          />
        </div>
        {/* Compact helper line, folded in from the former standalone
            "Offline payments" card — informational only, never a toggle.
            Always true whenever a tracked balance exists — never gated by
            mode or payment_mode_at_creation (see this file's own header
            comment). Deliberately unconditional on trackingOn: existing
            balances remain recordable even after tracking is turned off,
            and this line must never imply that manual payment history
            disappears. */}
        <p className="mt-2 text-[11px] text-gray-400 dark:text-gray-500">
          Manual payments supported: Cash, check, card terminal, bank transfer, digital wallet,
          and other payments can be recorded by Admins/Staff.
        </p>
      </div>

      {status && (
        <p
          className={`text-xs font-medium ${
            status.type === "success" ? "text-green-600" : "text-red-500"
          }`}
        >
          {status.message}
        </p>
      )}

      {confirmingDisableTracking && (
        <DisablePaymentTrackingConfirmModal
          submitting={isPending}
          onConfirm={handleConfirmDisableTracking}
          onCancel={() => setConfirmingDisableTracking(false)}
        />
      )}
    </div>
  );
}
