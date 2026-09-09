import { describe, expect, it } from "vitest";
import {
  COLLECTION_EVENT_TYPES,
  deriveEffectiveCollectionSummary,
  formatEventProvenanceLabel,
  type ProvenanceLedgerEvent,
} from "./paymentProvenance";

// Phase 34G-C1 — genuine unit tests (not source inspection) for the pure
// payment-provenance derivation helpers. Canonical provenance is always
// payment_events.event_type + payment_events.method — these tests never
// reference payment_mode_at_creation at all, by construction (it isn't
// even a parameter either function accepts).

function evt(
  id: string,
  eventType: string,
  method: string | null = null,
  reversesEventId: string | null = null,
): ProvenanceLedgerEvent {
  return { id, eventType, method, reversesEventId };
}

describe("formatEventProvenanceLabel — per-event Financial History label (items A, B, C)", () => {
  it("A. every manual method maps to 'Recorded manually · {Label}'", () => {
    expect(formatEventProvenanceLabel("manual_payment_recorded", "cash")).toBe("Recorded manually · Cash");
    expect(formatEventProvenanceLabel("manual_payment_recorded", "check")).toBe("Recorded manually · Check");
    expect(formatEventProvenanceLabel("manual_payment_recorded", "card_terminal")).toBe("Recorded manually · Card terminal");
    expect(formatEventProvenanceLabel("manual_payment_recorded", "bank_transfer")).toBe("Recorded manually · Bank transfer");
    expect(formatEventProvenanceLabel("manual_payment_recorded", "digital_wallet")).toBe("Recorded manually · Digital wallet");
    expect(formatEventProvenanceLabel("manual_payment_recorded", "other")).toBe("Recorded manually · Other");
  });

  it("A. refund_recorded with a method also maps to 'Recorded manually · {Label}'", () => {
    expect(formatEventProvenanceLabel("refund_recorded", "cash")).toBe("Recorded manually · Cash");
  });

  it("A. refund_recorded with no method (offline refund's own method is optional per its CHECK constraint) falls back to bare 'Recorded manually'", () => {
    expect(formatEventProvenanceLabel("refund_recorded", null)).toBe("Recorded manually");
  });

  it("B. online_payment_recorded and online_refund_recorded both map to 'Online · Stripe'", () => {
    expect(formatEventProvenanceLabel("online_payment_recorded", null)).toBe("Online · Stripe");
    expect(formatEventProvenanceLabel("online_refund_recorded", null)).toBe("Online · Stripe");
  });

  it("C. obligation/waiver/void/reversal events are never labeled Stripe or Manual — they return null", () => {
    expect(formatEventProvenanceLabel("obligation_created", null)).toBeNull();
    expect(formatEventProvenanceLabel("obligation_amount_adjusted", null)).toBeNull();
    expect(formatEventProvenanceLabel("waived", null)).toBeNull();
    expect(formatEventProvenanceLabel("void_payment_obligation", null)).toBeNull();
    expect(formatEventProvenanceLabel("reverse_payment_event", null)).toBeNull();
  });
});

describe("COLLECTION_EVENT_TYPES — exactly the two money-collection event types", () => {
  it("contains only manual_payment_recorded and online_payment_recorded", () => {
    expect(COLLECTION_EVENT_TYPES.has("manual_payment_recorded")).toBe(true);
    expect(COLLECTION_EVENT_TYPES.has("online_payment_recorded")).toBe(true);
    expect(COLLECTION_EVENT_TYPES.size).toBe(2);
  });

  it("never includes refund events — a refund is not a collection event", () => {
    expect(COLLECTION_EVENT_TYPES.has("refund_recorded")).toBe(false);
    expect(COLLECTION_EVENT_TYPES.has("online_refund_recorded")).toBe(false);
  });
});

describe("deriveEffectiveCollectionSummary — reversal-aware list-row summary (items D-H, examples A-G from the spec)", () => {
  it("A. one Stripe capture => 'Stripe'", () => {
    const events = [evt("e1", "online_payment_recorded")];
    expect(deriveEffectiveCollectionSummary(events)).toBe("Stripe");
  });

  it("B. one cash payment => 'Manual · Cash'", () => {
    const events = [evt("e1", "manual_payment_recorded", "cash")];
    expect(deriveEffectiveCollectionSummary(events)).toBe("Manual · Cash");
  });

  it("C./F. cash + check (two distinct manual methods) => 'Manual · Multiple'", () => {
    const events = [
      evt("e1", "manual_payment_recorded", "cash"),
      evt("e2", "manual_payment_recorded", "check"),
    ];
    expect(deriveEffectiveCollectionSummary(events)).toBe("Manual · Multiple");
  });

  it("D./E. Stripe + cash => 'Mixed'", () => {
    const events = [
      evt("e1", "online_payment_recorded"),
      evt("e2", "manual_payment_recorded", "cash"),
    ];
    expect(deriveEffectiveCollectionSummary(events)).toBe("Mixed");
  });

  it("E./G. cash event later reversed, no other collection => no source (null)", () => {
    const events = [
      evt("e1", "manual_payment_recorded", "cash"),
      evt("e2", "reverse_payment_event", null, "e1"),
    ];
    expect(deriveEffectiveCollectionSummary(events)).toBeNull();
  });

  it("F. Stripe event reversed, later cash collection => 'Manual · Cash' (the reversed Stripe event contributes nothing)", () => {
    const events = [
      evt("e1", "online_payment_recorded"),
      evt("e2", "reverse_payment_event", null, "e1"),
      evt("e3", "manual_payment_recorded", "cash"),
    ];
    expect(deriveEffectiveCollectionSummary(events)).toBe("Manual · Cash");
  });

  it("G./H. Stripe payment later refunded => 'Stripe' — a refund never rewrites the original collection channel", () => {
    const events = [
      evt("e1", "online_payment_recorded"),
      evt("e2", "online_refund_recorded"),
    ];
    expect(deriveEffectiveCollectionSummary(events)).toBe("Stripe");
  });

  it("no effective collection event at all => null, never a fabricated default", () => {
    expect(deriveEffectiveCollectionSummary([])).toBeNull();
    // Only obligation-lifecycle events, no money ever collected.
    expect(deriveEffectiveCollectionSummary([evt("e1", "obligation_created")])).toBeNull();
  });

  it("three distinct manual methods still collapse to 'Manual · Multiple', not an enumerated list", () => {
    const events = [
      evt("e1", "manual_payment_recorded", "cash"),
      evt("e2", "manual_payment_recorded", "check"),
      evt("e3", "manual_payment_recorded", "card_terminal"),
    ];
    expect(deriveEffectiveCollectionSummary(events)).toBe("Manual · Multiple");
  });

  it("the SAME manual method recorded twice (e.g. two separate cash payments) is still just 'Manual · Cash', not 'Multiple'", () => {
    const events = [
      evt("e1", "manual_payment_recorded", "cash"),
      evt("e2", "manual_payment_recorded", "cash"),
    ];
    expect(deriveEffectiveCollectionSummary(events)).toBe("Manual · Cash");
  });

  it("multiple Stripe captures alone still collapse to 'Stripe', never 'Mixed'", () => {
    const events = [
      evt("e1", "online_payment_recorded"),
      evt("e2", "online_payment_recorded"),
    ];
    expect(deriveEffectiveCollectionSummary(events)).toBe("Stripe");
  });

  it("a reversal targeting an event NOT present in this payment's own list is harmless (defensive) — unrelated collection events are unaffected", () => {
    const events = [
      evt("e1", "manual_payment_recorded", "cash"),
      evt("e2", "reverse_payment_event", null, "some-other-payments-event-id"),
    ];
    expect(deriveEffectiveCollectionSummary(events)).toBe("Manual · Cash");
  });
});
