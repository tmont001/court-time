"use client";

// Phase 34G-B — the online-payment layer, split out of what was
// PaymentTrackingSection into its own component. Phase 34G-B (hierarchy
// correction) — rendered inside the "Online Payments" group, AFTER
// StripeConnectSection, both nested inside the single top-level "Payments"
// settings section (Operating Model -> Payments {Payment Tracking, then
// Online Payments: Stripe Account, Court Time Payments} -> Club Branding
// -> ...). The visual grouping itself communicates the Stripe Account ->
// Court Time Payments dependency now, so copy avoids "above"/"below"
// cross-references. Court Time Payments remains an OPTIONAL Connected-
// only feature — it is never itself a subscription tier.
//
// Derives from and mutates the SAME single club_settings.payment_mode
// enum PaymentTrackingSection does, via the SAME shared helpers
// (@/lib/paymentModeToggle) and the SAME Server Action
// (updateClubPaymentModeAction/activate_court_time_payments) — never a
// second, independently-tracked representation. Resyncs its own local
// `mode` state from the `currentMode` prop whenever it changes (see the
// useEffect below), which is what keeps it from drifting out of sync with
// PaymentTrackingSection after THAT section's own mutation —
// updateClubPaymentModeAction always calls
// revalidatePath("/admin/settings") on success, which re-renders the
// Server Component page and pushes a fresh `currentMode` prop into BOTH
// sibling client components, not only the one that mutated.
//
// Locked mapping (unchanged from 34D-D3):
//   court_time_payments = online payments ON
//   manual / none        = online payments OFF
//
// Phase 34G-B REQUIRED FIX — turning Court Time Payments OFF must remain
// available regardless of Connected/Stripe-readiness state; those
// prerequisites gate turning it ON, never turning it OFF. The prior
// version disabled the toggle unconditionally whenever Stripe wasn't
// ready, which meant an Admin could not turn Court Time Payments off
// after Stripe degraded post-activation — exactly the moment they'd most
// want to. handleOnlineToggle below branches on `onlineOn` FIRST: the OFF
// path only ever checks `isPending`; the ON path is the only one gated on
// trackingOn/connected/stripeReady. activate_court_time_payments (0164/
// 0165) independently re-derives and re-validates Connected and Stripe
// readiness server-side regardless of what this component computes — the
// checks here are a UX convenience only, never the authorization
// boundary, and this fix does not weaken that server-side gate in any way
// (the OFF path calls update_club_payment_mode, which has never had a
// Stripe-readiness precondition of its own).
import { useEffect, useState, useTransition } from "react";
import { updateClubPaymentModeAction } from "@/app/(app)/admin/payments/actions";
import { isCourtTimePaymentsSelectable, type ConnectUIState } from "@/lib/stripe/connectConfig";
import {
  isOnlinePaymentsOn,
  isPaymentTrackingOn,
  nextModeForOnlineToggle,
  type PaymentMode,
} from "@/lib/paymentModeToggle";

// Mirrors StripeConnectSection's own wording for each non-ready state, so
// an Admin sees the same story in both places on this page. Phase 34G-B
// (hierarchy correction): no "above"/"below" — Stripe Account and Court
// Time Payments are now visually grouped together under "Online
// Payments," so the relationship is obvious without directional language.
const NOT_READY_COPY: Record<Exclude<ConnectUIState, "ready">, string> = {
  not_connected: "Connect a Stripe account first.",
  pending: "Stripe is still reviewing your account.",
  action_required: "Finish Stripe setup before turning this on.",
  unsupported: "Your Stripe account needs attention before this can be enabled.",
};

// Locked copy — turning Court Time Payments off never retroactively
// disables online payment for an existing balance created while it was
// enabled (payment_mode_at_creation is an immutable per-payment snapshot,
// 0143/0150) — only NEW obligations are affected going forward. Does not
// repeat the manual-payments explainer — that now lives once, under
// Payment Tracking (see PaymentTrackingSection's own header comment).
const ONLINE_OFF_COPY =
  "Online payments are off for new charges. Existing balances created while Court Time Payments was enabled may still be payable online.";

// Shown whenever Court Time Payments is ON but Stripe has since degraded
// (e.g. a capability restriction after activation) — distinct from the
// OFF-direction "not ready yet" copy above, since this is "was ready, no
// longer is" rather than "never got ready."
const STRIPE_DEGRADED_WHILE_ON_COPY =
  "Stripe reported an issue with this account. Members can't start new online payments right now. Resolve the Stripe issue, or turn Court Time Payments off.";

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

export default function CourtTimePaymentsSection({
  clubId,
  currentMode,
  stripeReadiness,
  connected,
}: {
  clubId: string;
  currentMode: PaymentMode;
  stripeReadiness: ConnectUIState;
  // Phase 34G-A2 — Court Time Payments is commercially locked to
  // Connected (member_self_service). Sourced from the same profile.
  // memberSelfService value every other capability check already uses
  // (src/lib/supabase/user.ts) — never a new read. Purely a UX pre-check:
  // activate_court_time_payments (0164/0165) independently re-enforces
  // this exact rule server-side regardless of what this prop says.
  connected: boolean;
}) {
  const [mode, setMode] = useState<PaymentMode>(currentMode);
  const [isPending, startTransition] = useTransition();
  const [status, setStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);

  useEffect(() => {
    setMode(currentMode);
  }, [currentMode]);

  const trackingOn = isPaymentTrackingOn(mode);
  const onlineOn = isOnlinePaymentsOn(mode);
  const stripeReady = isCourtTimePaymentsSelectable(stripeReadiness);

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

  function handleOnlineToggle() {
    if (isPending) return;
    if (onlineOn) {
      // Turning OFF must remain available regardless of Connected/Stripe-
      // readiness state — those are requirements for turning ON, never
      // for turning OFF. See this file's own header comment for the full
      // reasoning. activate_court_time_payments's own server-side gate is
      // unaffected either way — this path calls update_club_payment_mode
      // (manual), which has never had a Stripe-readiness precondition.
      submitMode(nextModeForOnlineToggle(mode, false));
      return;
    }
    // Turning ON requires tracking + Connected + Stripe ready — the
    // authoritative re-check still happens server-side in
    // activate_court_time_payments regardless of this UX pre-check.
    if (!trackingOn || !connected || !stripeReady) return;
    submitMode(nextModeForOnlineToggle(mode, true));
  }

  // Only the pending-mutation state disables the OFF direction. Every
  // other precondition below gates the ON direction only.
  const onlineDisabled = isPending || (!onlineOn && (!trackingOn || !connected || !stripeReady));

  // Two distinct explanatory notes, never conflated: "why can't I turn
  // this on yet" (below, computed only when currently off) vs "this is on
  // but something has since gone wrong" (computed only when currently on).
  const turnOnBlockedReason = onlineOn
    ? null
    : !trackingOn
    ? "Turn on Payment Tracking first."
    : !connected
    ? "Court Time Payments requires the Connected plan. Contact us to upgrade."
    : !stripeReady
    ? NOT_READY_COPY[stripeReadiness as Exclude<ConnectUIState, "ready">]
    : null;

  const degradedWhileOnReason = onlineOn && !stripeReady ? STRIPE_DEGRADED_WHILE_ON_COPY : null;

  return (
    <div className="space-y-3">
      {/* Phase 34G-B (readability correction) — no whole-card opacity when
          disabled. The explanatory reason line below (e.g. "Court Time
          Payments requires the Connected plan...") must stay fully
          readable — only the ToggleSwitch itself uses its own disabled
          styling (opacity-40 + cursor-not-allowed on the switch alone) to
          communicate that the control can't be clicked. Presentation-only:
          does not change onlineDisabled, the click guard, or any gating
          rule. */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 px-4 py-3.5">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">Court Time Payments</p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              {onlineOn ? "Allow Members to pay eligible balances online through Stripe." : ONLINE_OFF_COPY}
            </p>
          </div>
          <ToggleSwitch
            checked={onlineOn}
            disabled={onlineDisabled}
            label="Court Time Payments"
            onClick={handleOnlineToggle}
          />
        </div>
        {degradedWhileOnReason && (
          <p className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">{degradedWhileOnReason}</p>
        )}
        {turnOnBlockedReason && (
          <p className="mt-2 text-[11px] text-gray-400 dark:text-gray-500">{turnOnBlockedReason}</p>
        )}
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
    </div>
  );
}
