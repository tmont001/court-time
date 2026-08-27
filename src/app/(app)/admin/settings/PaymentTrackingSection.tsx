"use client";

// Phase 34C — Admin-only payment tracking control. Admin only reaches this
// page at all (AdminSettingsPage redirects any non-admin), so no
// additional role gating is needed here beyond the RPC's own Admin check.
//
// Phase 34D-D3 — restructured from a single mutually-exclusive None /
// Manual / Court Time Payments selector into two conceptually separate
// ON/OFF controls (Payment Tracking, Online Payments) plus a
// non-interactive Offline Payments explainer — WITHOUT changing the
// underlying domain model. club_settings.payment_mode remains the exact
// same single 3-value enum it always was; both toggles below are pure
// DERIVED views of that one value (`mode` is the only client-side state
// that represents it — never a second, independently-tracked boolean that
// could drift), and every mutation still goes through the exact same two
// RPCs this component already called before this restructure:
// update_club_payment_mode (none/manual) and activate_court_time_payments
// (court_time_payments, Stripe-readiness-gated, unchanged). The 34D-D3
// audit found record_manual_payment was ALREADY independent of
// payment_mode/payment_mode_at_creation — offline recording was never
// actually gated by the old selector, only presented as if it were, which
// is the sole defect this restructure corrects.
//
// Locked mapping (from the audit, unchanged):
//   none                  = tracking OFF, online OFF
//   manual                = tracking ON,  online OFF
//   court_time_payments   = tracking ON,  online ON

import { useState, useTransition } from "react";
import { updateClubPaymentModeAction } from "@/app/(app)/admin/payments/actions";
import { isCourtTimePaymentsSelectable, type ConnectUIState } from "@/lib/stripe/connectConfig";
import DisablePaymentTrackingConfirmModal from "@/components/DisablePaymentTrackingConfirmModal";
import {
  isOnlinePaymentsOn,
  isPaymentTrackingOn,
  nextModeForOnlineToggle,
  nextModeForTrackingToggle,
  type PaymentMode,
} from "@/lib/paymentModeToggle";

// Mirrors StripeConnectSection's own wording for each non-ready state, so
// an Admin sees the same story in both places on this page.
const NOT_READY_COPY: Record<Exclude<ConnectUIState, "ready">, string> = {
  not_connected: "Connect a Stripe account below first.",
  pending: "Stripe is still reviewing your account.",
  action_required: "Finish Stripe setup below before turning this on.",
  unsupported: "Your Stripe account needs attention before this can be enabled.",
};

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
  stripeReadiness,
}: {
  clubId: string;
  currentMode: PaymentMode;
  stripeReadiness: ConnectUIState;
}) {
  // The ONE piece of client-side state representing payment_mode — both
  // toggles below are derived from it on every render, never tracked
  // independently, so they can never drift out of sync with each other or
  // with the actual enum value.
  const [mode, setMode] = useState<PaymentMode>(currentMode);
  const [isPending, startTransition] = useTransition();
  const [status, setStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [confirmingDisableTracking, setConfirmingDisableTracking] = useState(false);

  const trackingOn = isPaymentTrackingOn(mode);
  const onlineOn = isOnlinePaymentsOn(mode);
  const stripeReady = isCourtTimePaymentsSelectable(stripeReadiness);

  function submitMode(next: PaymentMode) {
    setStatus(null);
    startTransition(async () => {
      const result = await updateClubPaymentModeAction(next, clubId);
      if (result.error) {
        // Never optimistically flips — `mode` (and therefore both derived
        // toggles) stays exactly where it was before this attempt.
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

  function handleOnlineToggle() {
    if (isPending || !trackingOn) return;
    if (!onlineOn && !stripeReady) return;
    // activate_court_time_payments itself independently re-derives and
    // re-validates Stripe readiness server-side — the stripeReady check
    // above is only a UX convenience, never the authorization boundary.
    // Turning online payments off never needs confirmation — it only
    // stops NEW obligations from being online-payable; tracking itself
    // (and offline recording) is unaffected.
    submitMode(nextModeForOnlineToggle(mode, !onlineOn));
  }

  const onlineDisabled = !trackingOn || !stripeReady;
  const onlineDisabledReason = !trackingOn
    ? "Turn on payment tracking first."
    : !stripeReady
    ? NOT_READY_COPY[stripeReadiness as Exclude<ConnectUIState, "ready">]
    : null;

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
      </div>

      {/* Online payments */}
      <div
        className={`rounded-xl border border-gray-200 dark:border-gray-700 px-4 py-3.5 ${
          onlineDisabled ? "opacity-60" : ""
        }`}
      >
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">Court Time Payments</p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              {onlineOn
                ? "Members can pay tracked balances online through Stripe."
                : "Members cannot pay balances online. Staff can still record payments received outside Court Time."}
            </p>
          </div>
          <ToggleSwitch
            checked={onlineOn}
            disabled={isPending || onlineDisabled}
            label="Court Time Payments"
            onClick={handleOnlineToggle}
          />
        </div>
        {onlineDisabledReason && (
          <p className="mt-2 text-[11px] text-gray-400 dark:text-gray-500">{onlineDisabledReason}</p>
        )}
      </div>

      {/* Offline payments — informational only, never a toggle. Always
          true whenever a tracked balance exists — never gated by mode or
          payment_mode_at_creation (see this file's own header comment). */}
      <div className="rounded-xl border border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/40 px-4 py-3.5">
        <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">Offline payments</p>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
          {trackingOn
            ? "Cash, check, card terminal, bank transfer, digital wallet, and other payments can still be recorded by Admins/Staff whenever Court Time is tracking a balance."
            : "Existing tracked balances can still be resolved, but new bookings will not create balances."}
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
