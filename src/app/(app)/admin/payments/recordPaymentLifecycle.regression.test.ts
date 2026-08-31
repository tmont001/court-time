import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Runtime QA (34F-B polish, post-runtime-QA-pass) — regression coverage for
// two related /admin/payments corrections, using this repository's
// established source-inspection style (see paymentContext.test.ts for the
// GENUINE behavioral coverage of the pure helpers these corrections reuse
// — dateTimeRangeLabel is imported and called directly there, not
// re-tested via source-inspection here).
//
// 1. A cancelled Event's participant/guest payment must not encourage
//    staff to collect the original fee: Record Payment is withheld while
//    the Unpaid/Partially Paid balance stays visible as historical
//    financial truth (no waive/void/refund/mutation of any kind), and a
//    Paid payment's Refund action is completely unaffected.
// 2. Event context on /admin/payments (row + Detail sheet) now shows the
//    full start/end time range, matching Reservation/Lesson's own
//    dateTimeRangeLabel convention, not just a bare date.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const PAGE_PATH = "src/app/(app)/admin/payments/page.tsx";
const CLIENT_PATH = "src/app/(app)/admin/payments/AdminPaymentsClient.tsx";
const DETAIL_SHEET_PATH = "src/components/PaymentDetailSheet.tsx";

// ═══════════════════════════════════════════════════════════════════════════
// 1/2/3 — cancelled Event withholds Record Payment; active Event keeps it;
// Paid + cancelled keeps Refund
// ═══════════════════════════════════════════════════════════════════════════

describe("recordPaymentBlocked — computed server-side, true ONLY for a cancelled parent Event's participant/guest payment", () => {
  const src = () => readSource(PAGE_PATH);

  it("1. event_participant: recordPaymentBlocked is set from the PARENT Event's own status ('cancelled'), never from the participant row's own status or the payment's own financial status", () => {
    const s = src();
    const idx = s.indexOf('} else if (p.domain_type === "event_participant") {');
    const nextIdx = s.indexOf('} else if (p.domain_type === "event_guest") {');
    const block = s.slice(idx, nextIdx);
    expect(block).toContain('recordPaymentBlocked = ev?.status === "cancelled";');
    // Never derived from the payment's own status/amounts, and never from
    // the participant row's own (intentionally preserved) status.
    expect(block).not.toMatch(/recordPaymentBlocked = r\.status/);
    expect(block).not.toMatch(/recordPaymentBlocked = p\.status/);
  });

  it("2. event_guest gets the identical treatment for the identical reason (a guest's manual-mode payment is the only kind a guest can ever have, 0149) — symmetry, not a gap", () => {
    const s = src();
    const idx = s.indexOf('} else if (p.domain_type === "event_guest") {');
    const nextIdx = s.indexOf("} else {", idx);
    const block = s.slice(idx, nextIdx);
    expect(block).toContain('recordPaymentBlocked = ev?.status === "cancelled";');
  });

  it("3. defaults to false for every other domain (reservation, lesson_request, program_enrollment) — this pass does not extend the treatment there", () => {
    const s = src();
    expect(s).toContain("let recordPaymentBlocked = false;");
    const reservationIdx = s.indexOf('if (p.domain_type === "reservation") {');
    const lessonIdx = s.indexOf('} else if (p.domain_type === "lesson_request") {');
    const reservationBlock = s.slice(reservationIdx, lessonIdx);
    expect(reservationBlock).not.toMatch(/recordPaymentBlocked/);
    const programIdx = s.indexOf("} else {\n      const r = programEnrollmentById.get");
    const rowsPushIdx = s.indexOf("rows.push({");
    const programBlock = s.slice(programIdx, rowsPushIdx);
    expect(programBlock).not.toMatch(/recordPaymentBlocked\s*=/);
  });

  it("propagated into AdminPaymentRow and consumed by BOTH the list-view Record Payment button and PaymentDetailSheet's canRecordPayment — never touching isPaymentOpenForRecording's own domain-neutral financial check", () => {
    const s = src();
    expect(s).toContain("recordPaymentBlocked,");

    const clientSrc = readSource(CLIENT_PATH);
    expect(clientSrc).toContain("isPaymentOpenForRecording(row.state) && !row.recordPaymentBlocked");

    const detailSrc = readSource(DETAIL_SHEET_PATH);
    expect(detailSrc).toContain("const canRecordPayment = isPaymentOpenForRecording(row.state) && !row.recordPaymentBlocked;");
  });

  it("does not gate Refund at all — canRefund is computed independently, from isOnlineRefundEligible/disputeBlocksRefund only, never referencing recordPaymentBlocked. A Paid, cancelled Event keeps its Refund action.", () => {
    const detailSrc = readSource(DETAIL_SHEET_PATH);
    const canRefundIdx = detailSrc.indexOf("const canRefund =");
    const canRecordIdx = detailSrc.indexOf("const canRecordPayment =");
    const canRefundLine = detailSrc.slice(canRefundIdx, canRecordIdx);
    expect(canRefundLine).not.toMatch(/recordPaymentBlocked/);
    expect(canRefundLine).toContain("isOnlineRefundEligible(row.refundableCents) && !row.disputeBlocksRefund");

    const clientSrc = readSource(CLIENT_PATH);
    const refundButtonIdx = clientSrc.indexOf("isOnlineRefundEligible(row.refundableCents) && !row.disputeBlocksRefund && (");
    expect(refundButtonIdx).toBeGreaterThan(-1);
    // The Refund button's own render condition never mentions recordPaymentBlocked.
    const refundBlock = clientSrc.slice(refundButtonIdx, refundButtonIdx + 300);
    expect(refundBlock).not.toMatch(/recordPaymentBlocked/);
  });

  it("no financial mutation is introduced anywhere in this correction — page.tsx never calls waive_payment/void_payment_obligation/record_refund, and recordPaymentBlocked is derived purely from ev.status, never written back to payments", () => {
    const s = readSource(PAGE_PATH);
    expect(s).not.toMatch(/waive_payment|void_payment_obligation|record_refund/);
  });

  it("PaymentDetailSheet surfaces an explanatory review note only when Record Payment would otherwise have been open — never fabricated for an already-unopenable payment (paid/refunded/etc.)", () => {
    const s = readSource(DETAIL_SHEET_PATH);
    const idx = s.indexOf("if (row.recordPaymentBlocked && isPaymentOpenForRecording(row.state)) {");
    expect(idx).toBeGreaterThan(-1);
    const block = s.slice(idx, s.indexOf("}", s.indexOf("reviewNotes.push", idx)) + 1);
    expect(block).toMatch(/never automatically waived or voided/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4/5 — Event context includes start/end time, club timezone, historical
// for cancelled Events
// ═══════════════════════════════════════════════════════════════════════════

describe("Event payment context includes start/end time (club timezone), matching Reservation/Lesson's own convention", () => {
  const src = () => readSource(PAGE_PATH);

  it("4. event_participant and event_guest both use dateTimeRangeLabel(ev.starts_at, ev.ends_at, clubTimezone) — never the old bare-date-only shortDate helper, which no longer exists in this file", () => {
    const s = src();
    const participantIdx = s.indexOf('} else if (p.domain_type === "event_participant") {');
    const guestIdx = s.indexOf('} else if (p.domain_type === "event_guest") {');
    const programIdx = s.indexOf("} else {\n      const r = programEnrollmentById.get");
    const participantBlock = s.slice(participantIdx, guestIdx);
    const guestBlock = s.slice(guestIdx, programIdx);
    expect(participantBlock).toContain("dateLabel = ev ? dateTimeRangeLabel(ev.starts_at, ev.ends_at, clubTimezone) : null;");
    expect(guestBlock).toContain("dateLabel = ev ? dateTimeRangeLabel(ev.starts_at, ev.ends_at, clubTimezone) : null;");
    expect(s).not.toMatch(/function shortDate/);
  });

  it("5. dateTimeRangeLabel is called with the SAME clubTimezone variable Reservation/Lesson already use — never a hardcoded zone, never the browser's own local zone", () => {
    const s = src();
    expect(s).toContain("dateTimeRangeLabel(r.starts_at, r.ends_at, clubTimezone)"); // reservation, pre-existing
    expect(s).toContain("dateTimeRangeLabel(r.proposed_starts_at, r.proposed_ends_at, clubTimezone)"); // lesson, pre-existing
    // Both new Event call sites use the identical clubTimezone symbol.
    const occurrences = s.split("dateTimeRangeLabel(ev.starts_at, ev.ends_at, clubTimezone)").length - 1;
    expect(occurrences).toBe(2);
  });

  it("the events query now selects ends_at (previously only starts_at/status) — required for the range label to have an end time at all", () => {
    const s = src();
    expect(s).toContain('supabase.from("events").select("id, title, starts_at, ends_at, status")');
  });

  it("a cancelled Event still shows its ORIGINALLY scheduled time — starts_at/ends_at are never mutated by cancel_event (confirmed elsewhere: cancel_event only ever sets events.status/updated_at), so this is genuinely historical context, not a live schedule", () => {
    const cancelEventMigration = readSource("supabase/migrations/0136_staff_event_operational_authorization.sql");
    const fnStart = cancelEventMigration.indexOf("CREATE OR REPLACE FUNCTION public.cancel_event(p_event_id uuid)");
    const fnEnd = cancelEventMigration.indexOf("$function$;", fnStart);
    const fn = cancelEventMigration.slice(fnStart, fnEnd);
    expect(fn).toContain("update public.events\n    set status = 'cancelled', updated_at = now()");
    expect(fn).not.toMatch(/starts_at\s*=|ends_at\s*=/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 11 — Reservation/Lesson/Program payment actions are unaffected
// ═══════════════════════════════════════════════════════════════════════════

describe("11. Reservation/Lesson/Program Record Payment eligibility is unaffected by this correction", () => {
  it("isPaymentOpenForRecording itself (the shared, domain-neutral financial check every domain's Record Payment button uses) is untouched — no lifecycle parameter was added to it", () => {
    const s = readSource("src/lib/payments.ts");
    const fnStart = s.indexOf("export function isPaymentOpenForRecording(");
    const fnEnd = s.indexOf("\n}", fnStart) + 2;
    const fn = s.slice(fnStart, fnEnd);
    expect(fn).toContain("row: PaymentStateRow | null | undefined");
    expect(fn).not.toMatch(/lifecycle|cancelled|recordPaymentBlocked/i);
  });

  it("recordPaymentBlocked defaults to false for reservation/lesson_request/program_enrollment rows, so `!row.recordPaymentBlocked` is always true for them — the added condition is a structural no-op outside Events", () => {
    const s = readSource(PAGE_PATH);
    // Already proven above that these three branches never assign
    // recordPaymentBlocked = true; re-asserted here as the explicit
    // "Reservation/Lesson/Program unaffected" requirement.
    const reservationIdx = s.indexOf('if (p.domain_type === "reservation") {');
    const lessonEndIdx = s.indexOf('} else if (p.domain_type === "event_participant") {');
    const reservationAndLessonBlock = s.slice(reservationIdx, lessonEndIdx);
    expect(reservationAndLessonBlock).not.toMatch(/recordPaymentBlocked\s*=\s*true|recordPaymentBlocked\s*=\s*ev/);
  });
});
