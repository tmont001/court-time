// Phase 34D-D3 — pure club_settings.payment_mode derivation/transition
// helpers. Deliberately zero imports (mirrors src/lib/stripe/
// connectConfig.ts and paymentsConfig.ts's own established pattern) so
// this module stays testable under this repo's deliberately minimal
// vitest config (no path-alias resolution — see vitest.config.mts).
//
// The single 3-value enum (club_settings.payment_mode) is unchanged by
// this checkpoint; these functions are the ONE place the "Payment
// tracking" / "Online payments" UI concepts are derived from and mapped
// back onto it, so PaymentTrackingSection's two toggles can never
// independently drift out of sync with each other or with the real value.
//
// Locked mapping (from the Phase 34D-D3 audit):
//   none                  = tracking OFF, online OFF
//   manual                = tracking ON,  online OFF
//   court_time_payments   = tracking ON,  online ON
export type PaymentMode = "none" | "manual" | "court_time_payments";

export function isPaymentTrackingOn(mode: PaymentMode): boolean {
  return mode !== "none";
}

export function isOnlinePaymentsOn(mode: PaymentMode): boolean {
  return mode === "court_time_payments";
}

// Turning tracking ON only ever goes none -> manual — online payments is
// always a separate, explicit second action, never implied by turning
// tracking on. Turning tracking OFF always goes to 'none' regardless of
// the current mode (manual or court_time_payments), which also implicitly
// turns online payments off — the confirmation copy shown before this is
// called says so explicitly.
export function nextModeForTrackingToggle(current: PaymentMode, turnOn: boolean): PaymentMode {
  if (turnOn) return current === "none" ? "manual" : current;
  return "none";
}

// Only meaningful while tracking is already on — callers must gate the
// online toggle's interactivity on isPaymentTrackingOn(current) themselves
// (and on Stripe readiness); this function does not re-derive either.
export function nextModeForOnlineToggle(current: PaymentMode, turnOn: boolean): PaymentMode {
  if (turnOn) return current === "manual" ? "court_time_payments" : current;
  return current === "court_time_payments" ? "manual" : current;
}
