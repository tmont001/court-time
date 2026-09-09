import { describe, expect, it } from "vitest";
import {
  resolveActivityDateRangeUTC,
  defaultCurrentMonthRange,
  signedAmountCentsForEvent,
  activitySourceLabel,
  activityRecordedByLabel,
  activityExternalReference,
  formatClubLocalDateTime,
  isGenuinelyOutstanding,
  selectLatestGenuinelyOutstandingPayments,
  buildOutstandingBalanceRow,
  buildPaymentActivityRow,
  outstandingBalancesFilename,
  paymentActivityFilename,
  OUTSTANDING_BALANCE_COLUMNS,
  PAYMENT_ACTIVITY_COLUMNS,
} from "./exportLogic";

// Phase 34G-C2 — genuine unit tests (real function calls, real assertions)
// for the pure Payments-CSV-export business logic. Letters below reference
// the corresponding §26 spec item; "Issue N" references the correction
// pass spec.

describe("resolveActivityDateRangeUTC — §9 half-open club-local date range, FAILS CLOSED (Issue 4)", () => {
  it("D. converts a club-local [from,to] into a half-open UTC range: >= start of `from`, < start of the day AFTER `to`", () => {
    const range = resolveActivityDateRangeUTC(
      { all: false, from: "2026-09-01", to: "2026-09-30" },
      "America/New_York",
    );
    expect(range.ok).toBe(true);
    if (!range.ok) throw new Error("expected ok");
    // Sept 1 00:00 America/New_York == Sept 1 04:00Z (EDT, UTC-4)
    expect(range.startUTC).toBe("2026-09-01T04:00:00.000Z");
    // Exclusive upper bound is the START of Oct 1 local, not 23:59:59 on Sept 30.
    expect(range.endUTC).toBe("2026-10-01T04:00:00.000Z");
  });

  it("E. 'All activity' applies no filter at all — the ONLY way to get an unfiltered export", () => {
    const range = resolveActivityDateRangeUTC({ all: true, from: null, to: null }, "America/New_York");
    expect(range.ok).toBe(true);
    if (!range.ok) throw new Error("expected ok");
    expect(range.startUTC).toBeNull();
    expect(range.endUTC).toBeNull();
  });

  it("Issue 4: a missing `from` (all:false) fails closed with an error — NEVER silently treated as All activity", () => {
    const result = resolveActivityDateRangeUTC({ all: false, from: null, to: "2026-09-30" }, "America/New_York");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toBeTruthy();
  });

  it("Issue 4: a missing `to` (all:false) fails closed with an error", () => {
    const result = resolveActivityDateRangeUTC({ all: false, from: "2026-09-01", to: null }, "America/New_York");
    expect(result.ok).toBe(false);
  });

  it("Issue 4: a malformed date string fails closed", () => {
    expect(resolveActivityDateRangeUTC({ all: false, from: "09/01/2026", to: "2026-09-30" }, "America/New_York").ok).toBe(false);
    expect(resolveActivityDateRangeUTC({ all: false, from: "2026-9-1", to: "2026-09-30" }, "America/New_York").ok).toBe(false);
  });

  it("Issue 4: an impossible calendar date (e.g. Feb 30) fails closed rather than silently rolling over to March", () => {
    const result = resolveActivityDateRangeUTC({ all: false, from: "2026-02-30", to: "2026-03-01" }, "America/New_York");
    expect(result.ok).toBe(false);
  });

  it("Issue 4: from > to fails closed", () => {
    const result = resolveActivityDateRangeUTC({ all: false, from: "2026-09-30", to: "2026-09-01" }, "America/New_York");
    expect(result.ok).toBe(false);
  });

  it("Issue 4: a valid same-day range succeeds", () => {
    const result = resolveActivityDateRangeUTC({ all: false, from: "2026-09-15", to: "2026-09-15" }, "America/New_York");
    expect(result.ok).toBe(true);
  });

  it("Issue 4: a valid multi-day range succeeds", () => {
    const result = resolveActivityDateRangeUTC({ all: false, from: "2026-09-01", to: "2026-09-30" }, "America/New_York");
    expect(result.ok).toBe(true);
  });

  it("a single-day range (from === to) still produces a correct 24h+ half-open window", () => {
    const range = resolveActivityDateRangeUTC(
      { all: false, from: "2026-09-15", to: "2026-09-15" },
      "America/New_York",
    );
    if (!range.ok) throw new Error("expected ok");
    expect(range.startUTC).toBe("2026-09-15T04:00:00.000Z");
    expect(range.endUTC).toBe("2026-09-16T04:00:00.000Z");
  });
});

describe("defaultCurrentMonthRange", () => {
  it("F. defaults to the first of the club-local current month through club-local today", () => {
    // Noon UTC on Sept 15 is unambiguously Sept 15 in America/New_York.
    const nowUTC = new Date("2026-09-15T12:00:00.000Z");
    const range = defaultCurrentMonthRange("America/New_York", nowUTC);
    expect(range).toEqual({ from: "2026-09-01", to: "2026-09-15" });
  });

  it("uses the CLUB's local calendar date, not UTC's — a UTC instant just after local midnight rollover", () => {
    // 2026-09-01 02:00 UTC is still 2026-08-31 22:00 in America/New_York.
    const nowUTC = new Date("2026-09-01T02:00:00.000Z");
    const range = defaultCurrentMonthRange("America/New_York", nowUTC);
    expect(range).toEqual({ from: "2026-08-01", to: "2026-08-31" });
  });
});

describe("signedAmountCentsForEvent — §11/§12 signed, reversal-aware amounts", () => {
  it("G. a manual or online collection is positive", () => {
    expect(signedAmountCentsForEvent("manual_payment_recorded", 5000)).toBe(5000);
    expect(signedAmountCentsForEvent("online_payment_recorded", 5000)).toBe(5000);
  });

  it("H. a manual or online refund is negative", () => {
    expect(signedAmountCentsForEvent("refund_recorded", 1000)).toBe(-1000);
    expect(signedAmountCentsForEvent("online_refund_recorded", 1000)).toBe(-1000);
  });

  it("I. reversing a +$50 manual payment yields -$50.00 (negative of the target's own sign)", () => {
    const result = signedAmountCentsForEvent("reverse_payment_event", null, {
      eventType: "manual_payment_recorded", amountCents: 5000,
    });
    expect(result).toBe(-5000);
  });

  it("J. reversing a -$10 refund yields +$10.00 (negative of a negative)", () => {
    const result = signedAmountCentsForEvent("reverse_payment_event", null, {
      eventType: "refund_recorded", amountCents: 1000,
    });
    expect(result).toBe(1000);
  });

  it("K. a reversal with an unresolved target never fabricates an amount — returns null", () => {
    expect(signedAmountCentsForEvent("reverse_payment_event", null, null)).toBeNull();
    expect(signedAmountCentsForEvent("reverse_payment_event", null, undefined)).toBeNull();
  });

  it("an unrecognized event_type (obligation/waiver/void, never actually queried by the export) returns null", () => {
    expect(signedAmountCentsForEvent("obligation_created", 100)).toBeNull();
  });
});

describe("activitySourceLabel — §14", () => {
  it("L. manual/online events reuse the C1 provenance label exactly", () => {
    expect(activitySourceLabel("manual_payment_recorded", "cash")).toBe("Recorded manually · Cash");
    expect(activitySourceLabel("refund_recorded", null)).toBe("Recorded manually");
    expect(activitySourceLabel("online_payment_recorded", null)).toBe("Online · Stripe");
    expect(activitySourceLabel("online_refund_recorded", null)).toBe("Online · Stripe");
  });

  it("M. reverse_payment_event always renders a blank Source — a correction is not a new payment source", () => {
    expect(activitySourceLabel("reverse_payment_event", null)).toBe("");
  });
});

describe("activityRecordedByLabel — §15", () => {
  it("N. manual_payment_recorded/refund_recorded/reverse_payment_event show the actor name when present", () => {
    expect(activityRecordedByLabel("manual_payment_recorded", "Jane Staff")).toBe("Jane Staff");
    expect(activityRecordedByLabel("refund_recorded", "Jane Staff")).toBe("Jane Staff");
    expect(activityRecordedByLabel("reverse_payment_event", "Jane Staff")).toBe("Jane Staff");
  });

  it("O. online events never attribute to a human actor even if actorName is somehow non-null", () => {
    expect(activityRecordedByLabel("online_payment_recorded", "Jane Staff")).toBe("");
    expect(activityRecordedByLabel("online_refund_recorded", "Jane Staff")).toBe("");
  });

  it("a null actor name always renders blank regardless of event_type", () => {
    expect(activityRecordedByLabel("manual_payment_recorded", null)).toBe("");
  });
});

describe("activityExternalReference — §16", () => {
  it("P. manual events surface their human-entered external_reference", () => {
    expect(activityExternalReference("manual_payment_recorded", "CHK-1029")).toBe("CHK-1029");
    expect(activityExternalReference("refund_recorded", "REG-4471")).toBe("REG-4471");
  });

  it("Q. online events NEVER export their raw Stripe id, even when present", () => {
    expect(activityExternalReference("online_payment_recorded", "cs_test_abc123")).toBe("");
    expect(activityExternalReference("online_refund_recorded", "re_test_xyz789")).toBe("");
  });

  it("reverse_payment_event has no external reference semantics defined — blank", () => {
    expect(activityExternalReference("reverse_payment_event", "whatever")).toBe("");
  });
});

describe("formatClubLocalDateTime", () => {
  it("R. formats as club-local 'YYYY-MM-DD HH:mm', never browser-locale-dependent", () => {
    // 2026-09-02T18:30:00Z is 2:30 PM America/New_York (EDT, UTC-4).
    expect(formatClubLocalDateTime("2026-09-02T18:30:00.000Z", "America/New_York")).toBe("2026-09-02 14:30");
  });

  it("a null timestamp renders blank, never invented", () => {
    expect(formatClubLocalDateTime(null, "America/New_York")).toBe("");
  });
});

describe("isGenuinelyOutstanding — §2 defensive filter", () => {
  it("S. unpaid/partially_paid with remaining > 0 is outstanding", () => {
    expect(isGenuinelyOutstanding("unpaid", 5000, 0)).toBe(true);
    expect(isGenuinelyOutstanding("partially_paid", 5000, 2000)).toBe(true);
  });

  it("T. paid/refunded/waived/void are never outstanding regardless of amounts", () => {
    expect(isGenuinelyOutstanding("paid", 5000, 5000)).toBe(false);
    expect(isGenuinelyOutstanding("refunded", 5000, 0)).toBe(false);
    expect(isGenuinelyOutstanding("waived", 5000, 0)).toBe(false);
    expect(isGenuinelyOutstanding("void", 5000, 0)).toBe(false);
  });

  it("U. a technically-unpaid row with zero remaining balance is excluded", () => {
    expect(isGenuinelyOutstanding("unpaid", 5000, 5000)).toBe(false);
    expect(isGenuinelyOutstanding("unpaid", 0, 0)).toBe(false);
  });
});

// Phase 34G-C2 correction — Issue 1: the LOCKED order (true latest cycle
// FIRST, outstanding-ness evaluated only on that latest cycle). Uses the
// exact worked examples from the correction spec.
describe("selectLatestGenuinelyOutstandingPayments — Issue 1 locked cycle-selection order", () => {
  it("A. cycle 1 unpaid, cycle 2 paid => EXCLUDED (the paid latest cycle supersedes the unpaid earlier one)", () => {
    const result = selectLatestGenuinelyOutstandingPayments([
      { domainType: "reservation", domainId: "r1", obligationCycle: 1, status: "unpaid", amountDueCents: 5000, amountPaidCents: 0 },
      { domainType: "reservation", domainId: "r1", obligationCycle: 2, status: "paid", amountDueCents: 5000, amountPaidCents: 5000 },
    ]);
    expect(result).toEqual([]);
  });

  it("B. cycle 1 paid, cycle 2 unpaid => cycle 2 INCLUDED", () => {
    const result = selectLatestGenuinelyOutstandingPayments([
      { domainType: "reservation", domainId: "r1", obligationCycle: 1, status: "paid", amountDueCents: 5000, amountPaidCents: 5000 },
      { domainType: "reservation", domainId: "r1", obligationCycle: 2, status: "unpaid", amountDueCents: 3000, amountPaidCents: 0 },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].obligationCycle).toBe(2);
  });

  it("C. cycle 1 partially_paid, cycle 2 waived => historical cycle 1 EXCLUDED (never falls back to it)", () => {
    const result = selectLatestGenuinelyOutstandingPayments([
      { domainType: "reservation", domainId: "r1", obligationCycle: 1, status: "partially_paid", amountDueCents: 5000, amountPaidCents: 2000 },
      { domainType: "reservation", domainId: "r1", obligationCycle: 2, status: "waived", amountDueCents: 3000, amountPaidCents: 0 },
    ]);
    expect(result).toEqual([]);
  });

  it("C (variant). cycle 1 partially_paid, cycle 2 void => historical cycle 1 EXCLUDED", () => {
    const result = selectLatestGenuinelyOutstandingPayments([
      { domainType: "reservation", domainId: "r1", obligationCycle: 1, status: "partially_paid", amountDueCents: 5000, amountPaidCents: 2000 },
      { domainType: "reservation", domainId: "r1", obligationCycle: 2, status: "void", amountDueCents: 3000, amountPaidCents: 0 },
    ]);
    expect(result).toEqual([]);
  });

  it("C (variant). cycle 1 partially_paid, cycle 2 refunded => historical cycle 1 EXCLUDED", () => {
    const result = selectLatestGenuinelyOutstandingPayments([
      { domainType: "reservation", domainId: "r1", obligationCycle: 1, status: "partially_paid", amountDueCents: 5000, amountPaidCents: 2000 },
      { domainType: "reservation", domainId: "r1", obligationCycle: 2, status: "refunded", amountDueCents: 3000, amountPaidCents: 3000 },
    ]);
    expect(result).toEqual([]);
  });

  it("does not depend on query/array ordering — the same result regardless of row order", () => {
    const forward = selectLatestGenuinelyOutstandingPayments([
      { domainType: "reservation", domainId: "r1", obligationCycle: 1, status: "unpaid", amountDueCents: 5000, amountPaidCents: 0 },
      { domainType: "reservation", domainId: "r1", obligationCycle: 2, status: "paid", amountDueCents: 5000, amountPaidCents: 5000 },
    ]);
    const reversed = selectLatestGenuinelyOutstandingPayments([
      { domainType: "reservation", domainId: "r1", obligationCycle: 2, status: "paid", amountDueCents: 5000, amountPaidCents: 5000 },
      { domainType: "reservation", domainId: "r1", obligationCycle: 1, status: "unpaid", amountDueCents: 5000, amountPaidCents: 0 },
    ]);
    expect(forward).toEqual(reversed);
  });

  it("different domains are independent — one domain's outstanding cycle doesn't affect another's", () => {
    const result = selectLatestGenuinelyOutstandingPayments([
      { domainType: "reservation", domainId: "r1", obligationCycle: 1, status: "unpaid", amountDueCents: 5000, amountPaidCents: 0 },
      { domainType: "reservation", domainId: "r2", obligationCycle: 1, status: "paid", amountDueCents: 5000, amountPaidCents: 5000 },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].domainId).toBe("r1");
  });

  it("the same domainId across DIFFERENT domainTypes are treated as distinct domains (composite key)", () => {
    const result = selectLatestGenuinelyOutstandingPayments([
      { domainType: "reservation", domainId: "x1", obligationCycle: 1, status: "unpaid", amountDueCents: 5000, amountPaidCents: 0 },
      { domainType: "lesson_request", domainId: "x1", obligationCycle: 1, status: "unpaid", amountDueCents: 3000, amountPaidCents: 0 },
    ]);
    expect(result).toHaveLength(2);
  });
});

describe("buildOutstandingBalanceRow — §3/§4 remaining-balance math", () => {
  it("V. computes remaining = max(due - paid, 0) from canonical cents, formats as plain decimals", () => {
    const row = buildOutstandingBalanceRow({
      identityName: "Jane Doe",
      title: "Court 3",
      domainTypeLabel: "Court Reservation",
      serviceDateTime: "2026-09-02 14:00",
      lifecycleLabel: null,
      status: "partially_paid",
      amountDueCents: 5000,
      amountPaidCents: 2000,
      currency: "USD",
      sourceSummary: "Manual · Cash",
      lastPaymentDateISO: "2026-09-01T18:00:00.000Z",
      clubTimezone: "America/New_York",
      paymentId: "pay_1",
    });
    expect(row.amountDue).toBe("50.00");
    expect(row.amountPaid).toBe("20.00");
    expect(row.remainingBalance).toBe("30.00");
    expect(row.paymentStatus).toBe("Partially paid");
    expect(row.lifecycleStatus).toBe("");
    expect(row.paymentSource).toBe("Manual · Cash");
  });

  it("no Overpaid concept exists here — remaining never goes negative even if paid somehow exceeds due", () => {
    const row = buildOutstandingBalanceRow({
      identityName: "Jane Doe", title: "Court 3", domainTypeLabel: "Court Reservation",
      serviceDateTime: "", lifecycleLabel: null, status: "unpaid",
      amountDueCents: 1000, amountPaidCents: 1500, currency: "USD",
      sourceSummary: null, lastPaymentDateISO: null, clubTimezone: "America/New_York", paymentId: "pay_2",
    });
    expect(row.remainingBalance).toBe("0.00");
  });

  it("a null Payment Source / Last Payment Date render blank, never fabricated", () => {
    const row = buildOutstandingBalanceRow({
      identityName: "Jane Doe", title: "Court 3", domainTypeLabel: "Court Reservation",
      serviceDateTime: "", lifecycleLabel: "Booking Cancelled", status: "unpaid",
      amountDueCents: 1000, amountPaidCents: 0, currency: "USD",
      sourceSummary: null, lastPaymentDateISO: null, clubTimezone: "America/New_York", paymentId: "pay_3",
    });
    expect(row.paymentSource).toBe("");
    expect(row.lastPaymentDate).toBe("");
    expect(row.lifecycleStatus).toBe("Booking Cancelled");
  });
});

describe("buildPaymentActivityRow — §13/§11", () => {
  it("W. assembles a full row, Amount already-signed passed straight through as a plain decimal", () => {
    const row = buildPaymentActivityRow({
      occurredAtISO: "2026-09-02T18:00:00.000Z",
      identityName: "Jane Doe",
      title: "Court 3",
      domainTypeLabel: "Court Reservation",
      eventType: "refund_recorded",
      signedAmountCents: -1000,
      currency: "USD",
      method: "cash",
      actorName: "Staff Member",
      externalReference: "REG-1",
      notes: "Customer complaint",
      paymentId: "pay_1",
      clubTimezone: "America/New_York",
    });
    expect(row.amount).toBe("-10.00");
    expect(row.activityType).toBe("Refund recorded");
    expect(row.source).toBe("Recorded manually · Cash");
    expect(row.recordedBy).toBe("Staff Member");
    expect(row.externalReference).toBe("REG-1");
    expect(row.notes).toBe("Customer complaint");
  });

  it("a null signedAmountCents (unresolved reversal target) renders a blank Amount, never 0.00", () => {
    const row = buildPaymentActivityRow({
      occurredAtISO: "2026-09-02T18:00:00.000Z", identityName: "Jane Doe", title: "Court 3",
      domainTypeLabel: "Court Reservation", eventType: "reverse_payment_event", signedAmountCents: null,
      currency: "USD", method: null, actorName: null, externalReference: null, notes: null,
      paymentId: "pay_1", clubTimezone: "America/New_York",
    });
    expect(row.amount).toBe("");
  });
});

describe("column definitions — protect flags never let a trusted numeric value get formula-neutralized", () => {
  it("X. Outstanding Balances: money/currency/date/id columns are protect:false; free-text columns default to protected", () => {
    const trusted = new Set(["Service Date/Time", "Amount Due", "Amount Paid", "Remaining Balance", "Currency", "Last Payment Date", "Payment ID"]);
    for (const col of OUTSTANDING_BALANCE_COLUMNS) {
      expect(Boolean(col.protect === false)).toBe(trusted.has(col.header));
    }
  });

  it("Y. Payment Activity: Activity Date/Time, Amount, Currency, Payment ID are protect:false; the rest default to protected", () => {
    const trusted = new Set(["Activity Date/Time", "Amount", "Currency", "Payment ID"]);
    for (const col of PAYMENT_ACTIVITY_COLUMNS) {
      expect(Boolean(col.protect === false)).toBe(trusted.has(col.header));
    }
  });
});

describe("filenames — §24", () => {
  it("Z. Outstanding Balances filename is safely sanitized and dated", () => {
    expect(outstandingBalancesFilename("riverside-tennis", "2026-09-07")).toBe(
      "court-time-outstanding-balances-riverside-tennis-2026-09-07.csv",
    );
  });

  it("AA. Payment Activity filename reflects the date range, or 'all' when unfiltered", () => {
    expect(paymentActivityFilename("riverside-tennis", { all: false, from: "2026-09-01", to: "2026-09-30" })).toBe(
      "court-time-payment-activity-riverside-tennis-2026-09-01-to-2026-09-30.csv",
    );
    expect(paymentActivityFilename("riverside-tennis", { all: true, from: null, to: null })).toBe(
      "court-time-payment-activity-riverside-tennis-all.csv",
    );
  });
});
