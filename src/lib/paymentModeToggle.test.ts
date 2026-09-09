import { describe, expect, it } from "vitest";
import {
  isOnlinePaymentsOn,
  isPaymentTrackingOn,
  nextModeForOnlineToggle,
  nextModeForTrackingToggle,
  type PaymentMode,
} from "./paymentModeToggle";

// Phase 34D-D3 — hybrid payments UX. Genuine unit tests (not source
// inspection) for the pure club_settings.payment_mode derivation/
// transition helpers PaymentTrackingSection's two toggles are built from.
// The underlying enum is unchanged (none/manual/court_time_payments);
// these functions are the ONE place the "Payment tracking" / "Online
// payments" UI concepts are derived from and mapped back onto it.

describe("isPaymentTrackingOn / isOnlinePaymentsOn — derived state for all three enum values (requirements 1-3)", () => {
  it("none renders tracking OFF / online OFF", () => {
    expect(isPaymentTrackingOn("none")).toBe(false);
    expect(isOnlinePaymentsOn("none")).toBe(false);
  });

  it("manual renders tracking ON / online OFF", () => {
    expect(isPaymentTrackingOn("manual")).toBe(true);
    expect(isOnlinePaymentsOn("manual")).toBe(false);
  });

  it("court_time_payments renders tracking ON / online ON", () => {
    expect(isPaymentTrackingOn("court_time_payments")).toBe(true);
    expect(isOnlinePaymentsOn("court_time_payments")).toBe(true);
  });
});

describe("nextModeForTrackingToggle — payment tracking transitions (requirements 4-6)", () => {
  it("tracking ON from none maps to manual", () => {
    expect(nextModeForTrackingToggle("none", true)).toBe("manual");
  });

  it("tracking OFF from manual maps to none", () => {
    expect(nextModeForTrackingToggle("manual", false)).toBe("none");
  });

  it("tracking OFF from court_time_payments maps to none", () => {
    expect(nextModeForTrackingToggle("court_time_payments", false)).toBe("none");
  });

  it("turning tracking ON never jumps straight to court_time_payments — online payments is always a separate, explicit second action", () => {
    expect(nextModeForTrackingToggle("none", true)).not.toBe("court_time_payments");
  });

  it("turning tracking ON while already on (manual or court_time_payments) is a no-op — the caller is expected not to call this for an already-on state, but the function itself stays safe either way", () => {
    expect(nextModeForTrackingToggle("manual", true)).toBe("manual");
    expect(nextModeForTrackingToggle("court_time_payments", true)).toBe("court_time_payments");
  });
});

describe("nextModeForOnlineToggle — online payments transitions (requirements 7-8)", () => {
  it("online ON from manual maps to court_time_payments", () => {
    expect(nextModeForOnlineToggle("manual", true)).toBe("court_time_payments");
  });

  it("online OFF from court_time_payments maps to manual", () => {
    expect(nextModeForOnlineToggle("court_time_payments", false)).toBe("manual");
  });

  it("turning online ON from 'none' is a no-op at the pure-function level — the caller (PaymentTrackingSection) is responsible for disabling the toggle entirely while tracking is off, never relying on this function to reject it", () => {
    expect(nextModeForOnlineToggle("none", true)).toBe("none");
  });

  it("turning online OFF from 'manual' (already off) or 'none' is a no-op", () => {
    expect(nextModeForOnlineToggle("manual", false)).toBe("manual");
    expect(nextModeForOnlineToggle("none", false)).toBe("none");
  });
});

describe("round-trip consistency — every reachable transition composes back to a self-consistent derived state", () => {
  const allModes: PaymentMode[] = ["none", "manual", "court_time_payments"];

  it("every mode's derived (trackingOn, onlineOn) pair is unique — no two enum values render identically", () => {
    const pairs = allModes.map((m) => `${isPaymentTrackingOn(m)}:${isOnlinePaymentsOn(m)}`);
    expect(new Set(pairs).size).toBe(allModes.length);
  });

  it("online payments is never ON while tracking is OFF, for any reachable mode", () => {
    for (const m of allModes) {
      if (!isPaymentTrackingOn(m)) {
        expect(isOnlinePaymentsOn(m)).toBe(false);
      }
    }
  });
});
