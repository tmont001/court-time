"use client";

// Phase 34C — Admin-only payment tracking mode selector. Admin only reaches
// this page at all (AdminSettingsPage redirects any non-admin), so no
// additional role gating is needed here beyond the RPC's own Admin check.
//
// Phase 34D-C: court_time_payments is no longer unconditionally disabled —
// it's selectable exactly when the club's Stripe Connect account for the
// CURRENT server environment is ready (stripeReadiness === "ready", i.e.
// card_payments_status = "active"). stripeReadiness is computed server-side
// by AdminSettingsPage via the same deriveConnectUIState/getStripeContext
// path StripeConnectSection already uses — never faked, never guessed here.

import { useState, useTransition } from "react";
import { updateClubPaymentModeAction } from "@/app/(app)/admin/payments/actions";
import { isCourtTimePaymentsSelectable, type ConnectUIState } from "@/lib/stripe/connectConfig";

type PaymentMode = "none" | "manual" | "court_time_payments";

const MODE_COPY: Record<PaymentMode, { title: string; description: string }> = {
  none: {
    title: "None",
    description: "Court Time does not create or track new payment obligations.",
  },
  manual: {
    title: "Manual",
    description: "Track balances and record payments received outside Court Time (cash, check, card terminal, etc.).",
  },
  court_time_payments: {
    title: "Court Time Payments",
    description: "Collect payments online through Stripe.",
  },
};

// Mirrors StripeConnectSection's own wording for each non-ready state, so
// an Admin sees the same story in both places on this page.
const NOT_READY_COPY: Record<Exclude<ConnectUIState, "ready">, string> = {
  not_connected: "Connect a Stripe account below first.",
  pending: "Stripe is still reviewing your account.",
  action_required: "Finish Stripe setup below before turning this on.",
  unsupported: "Your Stripe account needs attention before this can be enabled.",
};

export default function PaymentTrackingSection({
  clubId,
  currentMode,
  stripeReadiness,
}: {
  clubId: string;
  currentMode: PaymentMode;
  stripeReadiness: ConnectUIState;
}) {
  const [mode, setMode] = useState<PaymentMode>(currentMode);
  const [isPending, startTransition] = useTransition();
  const [status, setStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const courtTimePaymentsReady = isCourtTimePaymentsSelectable(stripeReadiness);

  function handleSelect(next: PaymentMode) {
    if (next === mode || isPending) return;
    if (next === "court_time_payments" && !courtTimePaymentsReady) return;

    setStatus(null);
    startTransition(async () => {
      const result = await updateClubPaymentModeAction(next, clubId);
      if (result.error) {
        setStatus({ type: "error", message: result.error });
      } else {
        setMode(next);
        setStatus({ type: "success", message: "Saved" });
        setTimeout(() => setStatus(null), 2000);
      }
    });
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-3">
        {(["none", "manual", "court_time_payments"] as PaymentMode[]).map((option) => {
          const isSelected = mode === option;
          const isDisabled = option === "court_time_payments" && !courtTimePaymentsReady;
          return (
            <button
              key={option}
              type="button"
              disabled={isDisabled || isPending}
              onClick={() => handleSelect(option)}
              className={`text-left rounded-xl border px-4 py-3 motion-safe:transition-all motion-safe:duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-800 active:scale-[0.98] ${
                isSelected
                  ? "border-accent bg-accent/5 dark:bg-accent/10"
                  : "border-gray-200 dark:border-gray-700 hover:border-accent/60"
              } ${isDisabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                  {MODE_COPY[option].title}
                </p>
                {isSelected && (
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-accent">Active</span>
                )}
                {isDisabled && (
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
                    Not Ready
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {option === "court_time_payments" && isDisabled
                  ? NOT_READY_COPY[stripeReadiness as Exclude<ConnectUIState, "ready">]
                  : MODE_COPY[option].description}
              </p>
            </button>
          );
        })}
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

      <p className="text-xs text-gray-400 dark:text-gray-500">
        Switching from Manual to None does not erase existing payment obligations — any balances
        already tracked remain visible and can still be resolved.
      </p>
    </div>
  );
}
