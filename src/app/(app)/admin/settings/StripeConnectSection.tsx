"use client";

// Phase 34D-A — Admin-only Stripe Connect onboarding entry point. Clearly
// separate from PaymentTrackingSection above it: that section controls
// whether Court Time tracks balances at all (none/manual/court_time_
// payments); this section is the connected-account plumbing a future
// checkpoint's activation gate will require before court_time_payments
// can ever be selected — selecting it is still hard-blocked everywhere
// today (UI, update_club_payment_mode, _create_payment_obligation),
// unchanged by this checkpoint.
//
// Accounts v2 readiness model: Stripe reports per-capability status
// (active/pending/restricted/unsupported) rather than v1's charges_
// enabled/details_submitted pair — deriveConnectUIState (shared, tested)
// maps that directly to this section's states, never inventing a
// v1-flavored "incomplete" in between.

import { useState, useTransition } from "react";
import { startStripeOnboardingAction } from "./stripeConnectActions";
import { deriveConnectUIState, type CardPaymentsStatus } from "@/lib/stripe/connectConfig";

type ConnectStatus = {
  connected: boolean;
  cardPaymentsStatus: CardPaymentsStatus | null;
  lastSyncedAt: string | null;
};

export default function StripeConnectSection({
  clubId,
  initialStatus,
  configured,
}: {
  clubId: string;
  initialStatus: ConnectStatus;
  // Server-only STRIPE_SECRET_KEY presence check (same pattern as this
  // page's own smsConfigured/emailConfigured) — only the boolean reaches
  // this Client Component, never the key or its name. When false, this
  // never shows a clickable action that would just fail closed on click;
  // it shows a plain "not available" state instead, matching how
  // PaymentTrackingSection already treats court_time_payments itself.
  configured: boolean;
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const state = deriveConnectUIState(initialStatus.connected, initialStatus.cardPaymentsStatus);

  function handleConnect() {
    setError(null);
    startTransition(async () => {
      const result = await startStripeOnboardingAction(clubId);
      if (result.error) {
        setError(result.error);
        return;
      }
      if (result.url) {
        // External Stripe-hosted destination — a plain browser navigation,
        // not a Next.js route.
        window.location.href = result.url;
      }
    });
  }

  if (!configured) {
    return (
      <div className="space-y-3">
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 px-4 py-3 opacity-60">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">Not available</p>
            <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
              Coming Soon
            </span>
          </div>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Stripe connection setup isn&apos;t available yet.
          </p>
        </div>
      </div>
    );
  }

  const canConnect = state === "not_connected" || state === "action_required";

  return (
    <div className="space-y-3">
      <div
        className={`rounded-xl border px-4 py-3 ${
          state === "ready"
            ? "border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20"
            : state === "action_required" || state === "unsupported"
            ? "border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20"
            : state === "pending"
            ? "border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20"
            : "border-gray-200 dark:border-gray-700"
        }`}
      >
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {state === "ready" ? "Ready for payments"
              : state === "pending" ? "Pending review"
              : state === "action_required" ? "Onboarding incomplete"
              : state === "unsupported" ? "Needs attention"
              : "Not connected"}
          </p>
          {state === "ready" && (
            <span className="text-[10px] font-semibold uppercase tracking-wide text-green-700 dark:text-green-400">
              Connected
            </span>
          )}
          {state === "pending" && (
            <span className="text-[10px] font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-400">
              Pending
            </span>
          )}
          {(state === "action_required" || state === "unsupported") && (
            <span className="text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">
              Action Required
            </span>
          )}
        </div>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {state === "ready"
            ? "Stripe has confirmed this club can accept payments. Court Time Payments activation is coming in a future update."
            : state === "pending"
            ? "Stripe is reviewing this account. This can take a little while — no action is needed right now."
            : state === "action_required"
            ? "Stripe needs a bit more information before this club can accept payments."
            : state === "unsupported"
            ? "This Stripe account needs attention. Contact support for help resolving it."
            : "Connect a Stripe account to prepare this club for Court Time Payments."}
        </p>

        {canConnect && (
          <button
            type="button"
            onClick={handleConnect}
            disabled={isPending}
            className="mt-3 w-full sm:w-auto px-4 py-2.5 rounded-lg text-sm font-semibold text-white dark:text-gray-900 bg-accent hover:brightness-110 disabled:opacity-50 motion-safe:transition-all motion-safe:duration-150"
          >
            {isPending ? "Redirecting…" : state === "action_required" ? "Continue setup" : "Connect with Stripe"}
          </button>
        )}

        {error && (
          <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>
        )}
      </div>

      <p className="text-xs text-gray-400 dark:text-gray-500">
        Stripe manages onboarding, identity verification, and your payout schedule directly — Court
        Time never sees or stores your banking details.
      </p>
    </div>
  );
}
