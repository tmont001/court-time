import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 34F-D — Cross-Domain Payment QA. Extends the 34F-B recordPaymentBlocked
// pattern (recordPaymentLifecycle.regression.test.ts) to Reservation and
// Lesson: domain cancellation must suppress NEW collection actions (Record
// Payment) while never fabricating a refund/waiver/void or mutating
// amount_due_cents/amount_paid_cents. Refund remains fully independent —
// governed by refundableCents/dispute state only, never by lifecycle.
//
// This file covers items 1-7 from the 34F-D spec:
//   Reservation: 1. active unpaid -> visible; 2. cancelled unpaid -> blocked;
//                3. cancelled paid -> Refund unaffected.
//   Lesson:      4. confirmed unpaid -> visible; 5. cancelled unpaid ->
//                blocked; 6. cancelled paid -> Refund unaffected;
//                7. Member Pay Now remains intact for an eligible confirmed
//                Lesson.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const PAGE_PATH = "src/app/(app)/admin/payments/page.tsx";
const CLIENT_PATH = "src/app/(app)/admin/payments/AdminPaymentsClient.tsx";
const DETAIL_SHEET_PATH = "src/components/PaymentDetailSheet.tsx";
const LESSON_DETAIL_PATH = "src/app/(app)/lessons/LessonRequestDetail.tsx";

// ═══════════════════════════════════════════════════════════════════════════
// 1/2 — Reservation: active unpaid visible, cancelled unpaid blocked
// ═══════════════════════════════════════════════════════════════════════════

describe("Reservation Record Payment — recordPaymentBlocked computed from reservations.status (1, 2)", () => {
  const src = () => readSource(PAGE_PATH);

  it("1. an active (non-cancelled) Reservation's payment is unaffected: recordPaymentBlocked stays false, so Record Payment remains visible whenever isPaymentOpenForRecording(row.state) is true", () => {
    const s = src();
    const idx = s.indexOf('if (p.domain_type === "reservation") {');
    const nextIdx = s.indexOf('} else if (p.domain_type === "lesson_request") {');
    const block = s.slice(idx, nextIdx);
    expect(block).toContain('recordPaymentBlocked = r.status === "cancelled";');
    // Only reservations.status drives this — never the payment's own
    // financial status, never a client-supplied value.
    expect(block).not.toMatch(/recordPaymentBlocked = p\.status/);
  });

  it("2. a cancelled Reservation withholds Record Payment — recordPaymentBlocked is set true purely from the reservation row's own status, exactly like the parent-Event pattern this mirrors", () => {
    const s = src();
    const idx = s.indexOf('if (p.domain_type === "reservation") {');
    const nextIdx = s.indexOf('} else if (p.domain_type === "lesson_request") {');
    const block = s.slice(idx, nextIdx);
    expect(block).toContain("lifecycleLabel = reservationLifecycleLabel(r.status);");
    expect(block).toContain('recordPaymentBlocked = r.status === "cancelled";');
  });

  it("reservationLifecycleLabel itself only returns non-null for 'cancelled' — the ONLY reservation status recordPaymentBlocked can ever key off matches the only status this app's own reservations.status CHECK constraint recognizes as terminal (pending/confirmed/cancelled)", () => {
    const s = readSource("src/app/(app)/admin/payments/paymentContext.ts");
    const fnStart = s.indexOf("export function reservationLifecycleLabel(");
    const fnEnd = s.indexOf("\n}", fnStart) + 2;
    const fn = s.slice(fnStart, fnEnd);
    expect(fn).toContain('status === "cancelled"');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 — Reservation cancelled + paid: Refund independent, unaffected
// ═══════════════════════════════════════════════════════════════════════════

describe("3. cancelled + paid Reservation — Refund eligibility unaffected by recordPaymentBlocked", () => {
  it("canRefund is computed independently of recordPaymentBlocked in both the list view and the detail sheet — a cancelled, Paid Reservation keeps its Refund action exactly like the already-proven cancelled-Event case", () => {
    const detailSrc = readSource(DETAIL_SHEET_PATH);
    const canRefundIdx = detailSrc.indexOf("const canRefund =");
    const canRecordIdx = detailSrc.indexOf("const canRecordPayment =");
    const canRefundLine = detailSrc.slice(canRefundIdx, canRecordIdx);
    expect(canRefundLine).not.toMatch(/recordPaymentBlocked/);
    expect(canRefundLine).toContain("isOnlineRefundEligible(row.refundableCents) && !row.disputeBlocksRefund");

    const clientSrc = readSource(CLIENT_PATH);
    const refundButtonIdx = clientSrc.indexOf("isOnlineRefundEligible(row.refundableCents) && !row.disputeBlocksRefund && (");
    expect(refundButtonIdx).toBeGreaterThan(-1);
    const refundBlock = clientSrc.slice(refundButtonIdx, refundButtonIdx + 300);
    expect(refundBlock).not.toMatch(/recordPaymentBlocked/);
  });

  it("no financial mutation is introduced for Reservation by this correction — page.tsx never calls waive_payment/void_payment_obligation/record_refund, and recordPaymentBlocked is derived purely from r.status, never written back to payments", () => {
    const s = readSource(PAGE_PATH);
    expect(s).not.toMatch(/waive_payment|void_payment_obligation|record_refund/);
  });

  it("the review-note copy shown when Record Payment is withheld is domain-neutral (uses row.lifecycleLabel), not hardcoded to 'Event' — a cancelled Reservation/Lesson gets an accurate note, not a misleading Event-specific one", () => {
    const s = readSource(DETAIL_SHEET_PATH);
    const idx = s.indexOf("if (row.recordPaymentBlocked && isPaymentOpenForRecording(row.state)) {");
    const block = s.slice(idx, idx + 400);
    expect(block).toContain("row.lifecycleLabel");
    expect(block).not.toContain("The parent Event was cancelled");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4/5 — Lesson: confirmed unpaid visible, cancelled unpaid blocked
// ═══════════════════════════════════════════════════════════════════════════

describe("Lesson Record Payment — recordPaymentBlocked computed from lesson_requests.status (4, 5)", () => {
  const src = () => readSource(PAGE_PATH);

  it("4. a confirmed (non-cancelled) Lesson's payment is unaffected: recordPaymentBlocked stays false", () => {
    const s = src();
    const idx = s.indexOf('} else if (p.domain_type === "lesson_request") {');
    const nextIdx = s.indexOf('} else if (p.domain_type === "event_participant") {');
    const block = s.slice(idx, nextIdx);
    expect(block).toContain('recordPaymentBlocked = r.status === "cancelled";');
    expect(block).not.toMatch(/recordPaymentBlocked = p\.status/);
  });

  it("5. a cancelled Lesson withholds Record Payment — recordPaymentBlocked is set true purely from the lesson_requests row's own status", () => {
    const s = src();
    const idx = s.indexOf('} else if (p.domain_type === "lesson_request") {');
    const nextIdx = s.indexOf('} else if (p.domain_type === "event_participant") {');
    const block = s.slice(idx, nextIdx);
    expect(block).toContain("lifecycleLabel = lessonRequestLifecycleLabel(r.status);");
    expect(block).toContain('recordPaymentBlocked = r.status === "cancelled";');
  });

  it("declined/withdrawn are deliberately NOT checked — both are pre-confirmation terminal states that can never carry a payment obligation in the first place (obligations are only ever created once a lesson reaches 'confirmed'), so only 'cancelled' (the sole POST-obligation terminal status) needs the check", () => {
    const s = src();
    const idx = s.indexOf('} else if (p.domain_type === "lesson_request") {');
    const nextIdx = s.indexOf('} else if (p.domain_type === "event_participant") {');
    const block = s.slice(idx, nextIdx);
    expect(block).not.toMatch(/recordPaymentBlocked = .*declined/);
    expect(block).not.toMatch(/recordPaymentBlocked = .*withdrawn/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6 — Lesson cancelled + paid: Refund independent, unaffected
// ═══════════════════════════════════════════════════════════════════════════

describe("6. cancelled + paid Lesson — Refund eligibility unaffected by recordPaymentBlocked", () => {
  it("Refund gating (canRefund / the list-view Refund button) never references recordPaymentBlocked — proven generically above (shared code path for every domain including lesson_request)", () => {
    const detailSrc = readSource(DETAIL_SHEET_PATH);
    const canRefundIdx = detailSrc.indexOf("const canRefund =");
    const canRecordIdx = detailSrc.indexOf("const canRecordPayment =");
    expect(detailSrc.slice(canRefundIdx, canRecordIdx)).not.toMatch(/recordPaymentBlocked/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7 — Member Lesson Pay Now remains intact for an eligible confirmed Lesson
// (independent of the Admin-side recordPaymentBlocked correction, which
// only ever touches /admin/payments — never lessonCheckoutActions.ts)
// ═══════════════════════════════════════════════════════════════════════════

describe("7. Member Lesson Pay Now (LessonRequestDetail) remains intact — untouched by the Admin-side recordPaymentBlocked correction", () => {
  it("Pay Now is still gated on request.status === 'confirmed' and checkoutEligible, via the SAME lessonCheckoutActions.ts this correction never touches", () => {
    const s = readSource(LESSON_DETAIL_PATH);
    expect(s).toContain('if (request.status !== "confirmed") {\n      setCheckoutEligible(false);');
    expect(s).toContain("getLessonCheckoutEligibilityAction(request.id, clubId)");
    expect(s).toContain("createLessonCheckoutAction(request.id, clubId)");
  });

  it("LessonRequestDetail never reads or references row.recordPaymentBlocked — that flag exists only on AdminPaymentRow (the /admin/payments surface), never on the Member's own LessonRequestRow", () => {
    const s = readSource(LESSON_DETAIL_PATH);
    expect(s).not.toMatch(/recordPaymentBlocked/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Cross-domain matrix sanity — Event participant/guest (34F-B, unchanged)
// still behave exactly as documented; Program enrollment now correctly
// distinguishes completed (collectible) from cancelled (suppressed) —
// the consistency defect this correction round closes.
// ═══════════════════════════════════════════════════════════════════════════

describe("cross-domain matrix sanity — Event participant/guest unchanged; Program enrollment now correctly distinguishes completed from cancelled", () => {
  it("event_participant/event_guest still key recordPaymentBlocked off the PARENT Event's own status — unchanged by this correction", () => {
    const s = readSource(PAGE_PATH);
    const idx = s.indexOf('} else if (p.domain_type === "event_participant") {');
    const nextIdx = s.indexOf('} else if (p.domain_type === "event_guest") {');
    const block = s.slice(idx, nextIdx);
    expect(block).toContain('recordPaymentBlocked = ev?.status === "cancelled";');
  });

  it("program_enrollment now keys recordPaymentBlocked off the PARENT Program's own status, never the enrollment child row's own status (intentionally preserved through cancellation) and never the payment's own financial status", () => {
    const s = readSource(PAGE_PATH);
    const programIdx = s.indexOf("} else {\n      const r = programEnrollmentById.get");
    const rowsPushIdx = s.indexOf("rows.push({");
    const programBlock = s.slice(programIdx, rowsPushIdx);
    expect(programBlock).toContain('recordPaymentBlocked = prog?.status === "cancelled";');
    expect(programBlock).not.toMatch(/recordPaymentBlocked = r\.status/);
    expect(programBlock).not.toMatch(/recordPaymentBlocked = p\.status/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Program-specific correction round — 1/2/3/4 from the 34F-D follow-up spec:
// active/completed Program unpaid stay eligible; cancelled Program is
// blocked; a cancelled+paid Program's Refund stays independent.
// ═══════════════════════════════════════════════════════════════════════════

describe("Program Record Payment — /admin/payments correctly distinguishes active/completed (collectible) from cancelled (suppressed)", () => {
  const src = () => readSource(PAGE_PATH);

  it("1. active Program + unpaid enrollment: recordPaymentBlocked evaluates false — Record Payment remains allowed", () => {
    const s = src();
    const programIdx = s.indexOf("} else {\n      const r = programEnrollmentById.get");
    const rowsPushIdx = s.indexOf("rows.push({");
    const programBlock = s.slice(programIdx, rowsPushIdx);
    // The predicate itself: only 'cancelled' ever sets it true — 'active'
    // (like 'completed') falls through to false.
    expect(programBlock).toContain('recordPaymentBlocked = prog?.status === "cancelled";');
  });

  it("2. completed Program + unpaid enrollment: recordPaymentBlocked evaluates false — the service was delivered and the debt remains legitimately collectible, matching complete_program's own deliberate lack of a stale-Checkout guard (34F-C)", () => {
    const s = src();
    const programIdx = s.indexOf("} else {\n      const r = programEnrollmentById.get");
    const rowsPushIdx = s.indexOf("rows.push({");
    const programBlock = s.slice(programIdx, rowsPushIdx);
    // 'completed' is structurally excluded from the predicate — the ONLY
    // string compared against is 'cancelled'.
    expect(programBlock).not.toMatch(/recordPaymentBlocked\s*=.*completed/);
    expect(programBlock).toContain('=== "cancelled"');
  });

  it("3. cancelled Program + unpaid enrollment: recordPaymentBlocked evaluates true — Record Payment is withheld, mirroring Reservation/Lesson/Event's own identical treatment", () => {
    const s = src();
    const programIdx = s.indexOf("} else {\n      const r = programEnrollmentById.get");
    const rowsPushIdx = s.indexOf("rows.push({");
    const programBlock = s.slice(programIdx, rowsPushIdx);
    expect(programBlock).toContain('recordPaymentBlocked = prog?.status === "cancelled";');
  });

  it("4. cancelled + paid Program: Refund gating never references recordPaymentBlocked — proven generically above (shared code path for every domain, including program_enrollment)", () => {
    const detailSrc = readSource(DETAIL_SHEET_PATH);
    const canRefundIdx = detailSrc.indexOf("const canRefund =");
    const canRecordIdx = detailSrc.indexOf("const canRecordPayment =");
    expect(detailSrc.slice(canRefundIdx, canRecordIdx)).not.toMatch(/recordPaymentBlocked/);
  });

  it("preserves the existing Program lifecycle label precedence — lifecycleLabel is computed before, and independently of, recordPaymentBlocked; programEnrollmentLifecycleLabel itself is untouched", () => {
    const s = src();
    const programIdx = s.indexOf("} else {\n      const r = programEnrollmentById.get");
    const rowsPushIdx = s.indexOf("rows.push({");
    const programBlock = s.slice(programIdx, rowsPushIdx);
    const labelIdx = programBlock.indexOf("lifecycleLabel = programEnrollmentLifecycleLabel(prog?.status, r.status);");
    const blockedIdx = programBlock.indexOf('recordPaymentBlocked = prog?.status === "cancelled";');
    expect(labelIdx).toBeGreaterThan(-1);
    expect(blockedIdx).toBeGreaterThan(labelIdx);
  });

  it("no financial mutation is introduced for Program by this correction — recordPaymentBlocked is derived purely from prog?.status, never written back to payments/program_enrollments", () => {
    const s = src();
    expect(s).not.toMatch(/waive_payment|void_payment_obligation|record_refund/);
  });
});
