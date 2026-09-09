import { describe, expect, it } from "vitest";
import {
  computeOverpaidCents,
  formatPaymentEventLabel,
  formatPaymentStateLabel,
  isPaymentOpenForRecording,
  type PaymentStateRow,
} from "./payments";

// Phase 34E-E — genuine behavioral coverage for the real, production-used
// pure payment-presentation helpers (not source-inspection). Complements
// paymentsConfig.test.ts's own established convention.

function stateRow(overrides: Partial<PaymentStateRow>): PaymentStateRow {
  return {
    domain_id: "d1",
    current_payment_id: "p1",
    current_obligation_cycle: 1,
    current_amount_due_cents: 3000,
    current_amount_paid_cents: 3000,
    current_status: "paid",
    current_currency: "USD",
    unresolved_prior: [],
    ...overrides,
  };
}

describe("computeOverpaidCents — canonical financial data only, never negative", () => {
  it("requirement 7: due $30, paid $50 — overpaid amount is $20", () => {
    const row = stateRow({ current_amount_due_cents: 3000, current_amount_paid_cents: 5000, current_status: "overpaid" });
    expect(computeOverpaidCents(row)).toBe(2000);
  });

  it("returns 0 (never negative) when paid does not exceed due", () => {
    expect(computeOverpaidCents(stateRow({ current_amount_due_cents: 3000, current_amount_paid_cents: 2000 }))).toBe(0);
    expect(computeOverpaidCents(stateRow({ current_amount_due_cents: 3000, current_amount_paid_cents: 3000 }))).toBe(0);
  });

  it("returns 0 for a missing row — never throws, never fabricates", () => {
    expect(computeOverpaidCents(null)).toBe(0);
    expect(computeOverpaidCents(undefined)).toBe(0);
  });

  it("matches formatPaymentStateLabel's own 'overpaid' arithmetic exactly (same underlying formula)", () => {
    const row = stateRow({ current_amount_due_cents: 2000, current_amount_paid_cents: 3500, current_status: "overpaid" });
    const label = formatPaymentStateLabel(row);
    expect(label?.text).toContain("$15.00");
    expect(computeOverpaidCents(row)).toBe(1500);
  });
});

describe("formatPaymentEventLabel — operator-friendly labels for every payment_events.event_type", () => {
  it("requirement 8: maps every known event type to the exact operator-facing label", () => {
    expect(formatPaymentEventLabel("obligation_created")).toBe("Obligation created");
    expect(formatPaymentEventLabel("obligation_amount_adjusted")).toBe("Amount adjusted");
    expect(formatPaymentEventLabel("manual_payment_recorded")).toBe("Manual payment recorded");
    expect(formatPaymentEventLabel("online_payment_recorded")).toBe("Online payment received");
    expect(formatPaymentEventLabel("refund_recorded")).toBe("Refund recorded");
    expect(formatPaymentEventLabel("online_refund_recorded")).toBe("Online refund completed");
    expect(formatPaymentEventLabel("waived")).toBe("Waived");
    expect(formatPaymentEventLabel("void_payment_obligation")).toBe("Voided");
    expect(formatPaymentEventLabel("reverse_payment_event")).toBe("Payment/reversal correction");
  });

  it("falls back to a humanized version of an unrecognized future event type — never breaks rendering", () => {
    expect(formatPaymentEventLabel("some_new_event_type")).toBe("Some New Event Type");
  });
});

describe("isPaymentOpenForRecording — requirement 10: refunded/overpaid never reopen Pay Now / Record Payment", () => {
  it("overpaid is never open for recording", () => {
    expect(isPaymentOpenForRecording(stateRow({ current_status: "overpaid", current_amount_paid_cents: 5000 }))).toBe(false);
  });

  it("refunded is never open for recording", () => {
    expect(isPaymentOpenForRecording(stateRow({ current_status: "refunded", current_amount_paid_cents: 0 }))).toBe(false);
  });

  it("partially_refunded is never open for recording", () => {
    expect(isPaymentOpenForRecording(stateRow({ current_status: "partially_refunded", current_amount_paid_cents: 1000 }))).toBe(false);
  });

  it("paid is never open for recording", () => {
    expect(isPaymentOpenForRecording(stateRow({ current_status: "paid" }))).toBe(false);
  });

  it("waived/void are never open for recording", () => {
    expect(isPaymentOpenForRecording(stateRow({ current_status: "waived" }))).toBe(false);
    expect(isPaymentOpenForRecording(stateRow({ current_status: "void" }))).toBe(false);
  });

  it("unpaid/partially_paid WITH a genuine remaining balance ARE open for recording — unchanged, positive control", () => {
    expect(isPaymentOpenForRecording(stateRow({ current_status: "unpaid", current_amount_due_cents: 3000, current_amount_paid_cents: 0 }))).toBe(true);
    expect(isPaymentOpenForRecording(stateRow({ current_status: "partially_paid", current_amount_due_cents: 3000, current_amount_paid_cents: 1000 }))).toBe(true);
  });
});
