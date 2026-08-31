import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 34E-E — regression coverage for the /admin/payments booking-
// context + payment-detail UX, using this repository's established
// source-inspection style for the React/Server-Action surfaces that this
// project's vitest config cannot render (see paymentContext.test.ts and
// payments.test.ts for the GENUINE behavioral coverage of the pure
// helpers this feature is built from — those are real imports/function
// calls, not source-inspection).

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const PAGE_PATH = "src/app/(app)/admin/payments/page.tsx";
const CLIENT_PATH = "src/app/(app)/admin/payments/AdminPaymentsClient.tsx";
const ACTIONS_PATH = "src/app/(app)/admin/payments/actions.ts";
const DETAIL_SHEET_PATH = "src/components/PaymentDetailSheet.tsx";

// ═══════════════════════════════════════════════════════════════════════════
// Requirements 3, 4 — cancelled + Paid/Refunded shows BOTH the domain
// lifecycle AND the financial status, as two visually distinct elements.
// ═══════════════════════════════════════════════════════════════════════════

describe("domain lifecycle and payment status render as two SEPARATE, independent elements — never merged", () => {
  it("AdminPaymentsClient renders the lifecycle pill and PaymentStateBadge as two independent JSX elements, not one combined label", () => {
    const src = readSource(CLIENT_PATH);
    const lifecycleIdx = src.indexOf("{row.lifecycleLabel && (");
    expect(lifecycleIdx).toBeGreaterThan(0);
    const badgeIdx = src.indexOf("<PaymentStateBadge state={row.state} />", lifecycleIdx);
    expect(badgeIdx).toBeGreaterThan(lifecycleIdx);
    // The lifecycle pill's own condition never references payment status
    // at all — it renders purely from row.lifecycleLabel, which itself
    // (paymentContext.ts, genuinely tested) is computed ONLY from the
    // domain row's own status, never payments.status.
    const lifecycleBlock = src.slice(lifecycleIdx, badgeIdx);
    expect(lifecycleBlock).not.toMatch(/row\.state\.current_status/);
  });

  it("PaymentDetailSheet renders the SAME two-pill structure (lifecycle, then PaymentStateBadge, then dispute) — all three independently conditioned", () => {
    const src = readSource(DETAIL_SHEET_PATH);
    const lifecycleIdx = src.indexOf("{row.lifecycleLabel && (");
    const badgeIdx = src.indexOf("<PaymentStateBadge state={row.state} />");
    const disputeIdx = src.indexOf("{row.dispute && (");
    expect(lifecycleIdx).toBeGreaterThan(0);
    expect(badgeIdx).toBeGreaterThan(lifecycleIdx);
    expect(disputeIdx).toBeGreaterThan(badgeIdx);
  });

  it("a cancelled reservation's lifecycle label and a 'paid'/'refunded' payment status are computed from ENTIRELY different source tables (reservations.status vs payments.status via _recompute_payment_rollup) — structurally incapable of collapsing into one value", () => {
    const pageSrc = readSource(PAGE_PATH);
    // The reservation's own status feeds ONLY reservationLifecycleLabel;
    // the payment's own status feeds ONLY the `state.current_status`
    // passed to PaymentStateBadge. Confirm both source reads exist and
    // are visibly distinct.
    expect(pageSrc).toContain("lifecycleLabel = reservationLifecycleLabel(r.status);");
    expect(pageSrc).toContain("current_status: p.status,");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Requirements 5, 6 — Refund availability is based on real Stripe
// provenance (refundableCents/disputeBlocksRefund), NEVER on booking
// lifecycle; exhausted refundable balance removes the action.
// ═══════════════════════════════════════════════════════════════════════════

describe("Refund action is gated ONLY by real Stripe-refundable provenance, never by booking lifecycle", () => {
  it("requirement 5: the Refund button's render condition never references lifecycleLabel — a cancelled+Paid booking with real refundable money still shows Refund", () => {
    const src = readSource(CLIENT_PATH);
    const idx = src.indexOf("{isOnlineRefundEligible(row.refundableCents) && !row.disputeBlocksRefund && (");
    expect(idx).toBeGreaterThan(0);
    const block = src.slice(idx, src.indexOf("Refund\n", idx));
    expect(block).not.toMatch(/lifecycleLabel/);
  });

  it("requirement 6: the SAME condition is refundableCents-driven — isOnlineRefundEligible(0) is false, so an exhausted balance removes the button (no lifecycle involvement either way)", () => {
    const src = readSource(CLIENT_PATH);
    expect(src).toContain("isOnlineRefundEligible(row.refundableCents) && !row.disputeBlocksRefund");
  });

  it("PaymentDetailSheet's own Refund button uses the IDENTICAL gate (isOnlineRefundEligible + !disputeBlocksRefund), independent of row.lifecycleLabel", () => {
    const src = readSource(DETAIL_SHEET_PATH);
    expect(src).toContain("isOnlineRefundEligible(row.refundableCents) && !row.disputeBlocksRefund");
    const canRefundIdx = src.indexOf("const canRefund =");
    const canRefundLine = src.slice(canRefundIdx, src.indexOf(";", canRefundIdx));
    expect(canRefundLine).not.toMatch(/lifecycleLabel/);
  });

  it("Record Payment is gated by isPaymentOpenForRecording (status-based) — unaffected by refund state or dispute state, exactly as in 34E-B. Runtime QA (34F-B polish) added ONE additional, narrowly-scoped condition — !row.recordPaymentBlocked, true only for a cancelled parent Event's participant/guest payment (see recordPaymentLifecycle.regression.test.ts) — isPaymentOpenForRecording itself remains the same domain-neutral, status-only financial check for every domain.", () => {
    const clientSrc = readSource(CLIENT_PATH);
    expect(clientSrc).toContain("{isPaymentOpenForRecording(row.state) && !row.recordPaymentBlocked && (");
    const detailSrc = readSource(DETAIL_SHEET_PATH);
    expect(detailSrc).toContain("const canRecordPayment = isPaymentOpenForRecording(row.state) && !row.recordPaymentBlocked;");
    // The underlying financial check itself takes no lifecycle/dispute
    // argument at all — recordPaymentBlocked is computed entirely
    // separately (page.tsx, from the domain row), never inside
    // isPaymentOpenForRecording.
    const isPaymentOpenSrc = readSource("src/lib/payments.ts");
    const fnStart = isPaymentOpenSrc.indexOf("export function isPaymentOpenForRecording(");
    const fnEnd = isPaymentOpenSrc.indexOf("\n}", fnStart) + 2;
    expect(isPaymentOpenSrc.slice(fnStart, fnEnd)).not.toMatch(/lifecycle|dispute|cancelled/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Requirement 9 — dispute remains fully distinct from refund/payment
// status; never folded into the financial rollup.
// ═══════════════════════════════════════════════════════════════════════════

describe("dispute state remains fully distinct from payment/refund status", () => {
  it("the dispute badge is its own independently-conditioned element in both surfaces, never combined with PaymentStateBadge's own text", () => {
    const clientSrc = readSource(CLIENT_PATH);
    expect(clientSrc).toContain("{row.dispute && (");
    expect(clientSrc).toContain("<DisputeBadge dispute={row.dispute} />");

    const detailSrc = readSource(DETAIL_SHEET_PATH);
    expect(detailSrc).toContain("{row.dispute && (");
  });

  it("PaymentDetailSheet's financial numbers (obligation, net retained, refunded, overpaid) are computed ENTIRELY from row.state/history — never from row.dispute", () => {
    const src = readSource(DETAIL_SHEET_PATH);
    const overpaidIdx = src.indexOf("const overpaidCents = computeOverpaidCents(row.state);");
    const refundedIdx = src.indexOf("const refundedDisplay =");
    expect(overpaidIdx).toBeGreaterThan(0);
    expect(refundedIdx).toBeGreaterThan(0);
    // Neither computation references row.dispute at all.
    const refundedBlock = src.slice(refundedIdx, src.indexOf(";", src.indexOf("reduce(", refundedIdx)) + 1);
    expect(refundedBlock).not.toMatch(/row\.dispute/);
  });

  it("the dispute review note is additive prose only, computed separately from the financial-facts grid and never gating canRefund/canRecordPayment", () => {
    const src = readSource(DETAIL_SHEET_PATH);
    const disputeNoteIdx = src.indexOf("if (row.dispute) {");
    expect(disputeNoteIdx).toBeGreaterThan(0);
    const disputeNoteBlock = src.slice(disputeNoteIdx, src.indexOf("}", disputeNoteIdx) + 1);
    expect(disputeNoteBlock).toContain("reviewNotes.push(");
    expect(disputeNoteBlock).not.toMatch(/canRefund\s*=|canRecordPayment\s*=/);
    // The financial-facts grid's own JSX never references row.dispute.
    const gridIdx = src.indexOf('<div className="grid grid-cols-2');
    const gridEnd = src.indexOf("</div>", gridIdx);
    const gridBlock = src.slice(gridIdx, gridEnd);
    expect(gridBlock).not.toMatch(/row\.dispute/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Requirement 10 (component-level) — no new collection/Pay-Now-equivalent
// action is introduced by refunded/overpaid states.
// ═══════════════════════════════════════════════════════════════════════════

describe("no new collection action is introduced anywhere in this feature", () => {
  it("PaymentDetailSheet's only two action buttons are Refund and Record Payment — both reuse the EXISTING 34E-B/34C sheets via a handoff, no new mutation button", () => {
    const src = readSource(DETAIL_SHEET_PATH);
    expect(src).toContain("onRequestRefund");
    expect(src).toContain("onRequestRecordPayment");
    // No direct RPC/Server Action mutation call anywhere in this file —
    // it is read-only + a handoff.
    expect(src).not.toMatch(/\.rpc\(/);
    expect(src).not.toMatch(/recordManualPaymentAction|createOnlineRefundAction/);
  });

  it("fetchPaymentEventHistory is a read-only SELECT — no insert/update/delete/rpc call anywhere in the Server Action", () => {
    const src = readSource(ACTIONS_PATH);
    const fnStart = src.indexOf("export async function fetchPaymentEventHistory(");
    const fnEnd = src.indexOf("export async function updateClubPaymentModeAction(", fnStart);
    expect(fnEnd).toBeGreaterThan(fnStart);
    const fnBody = src.slice(fnStart, fnEnd);
    expect(fnBody).toContain(".select(");
    expect(fnBody).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\.rpc\(/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Requirement 11 — tenant/role scoping remains intact.
// ═══════════════════════════════════════════════════════════════════════════

describe("tenant/role scoping remains intact for the new history read path", () => {
  it("fetchPaymentEventHistory requires an active club (assertActiveClub) and an authenticated user before ever querying payment_events", () => {
    const src = readSource(ACTIONS_PATH);
    const fnStart = src.indexOf("export async function fetchPaymentEventHistory(");
    const queryIdx = src.indexOf(".from(\"payment_events\")", fnStart);
    const guardIdx = src.indexOf("assertActiveClub(expectedClubId)", fnStart);
    const authIdx = src.indexOf("ERROR_MESSAGES.not_authenticated", fnStart);
    expect(guardIdx).toBeGreaterThan(fnStart);
    expect(guardIdx).toBeLessThan(queryIdx);
    expect(authIdx).toBeGreaterThan(fnStart);
    expect(authIdx).toBeLessThan(queryIdx);
  });

  it("the query itself is explicitly scoped to BOTH payment_id and club_id — defense in depth on top of payment_events' own RLS policy (payment_events_select_admin_staff, 0143)", () => {
    const src = readSource(ACTIONS_PATH);
    const fnStart = src.indexOf("export async function fetchPaymentEventHistory(");
    const fnEnd = src.indexOf("export async function updateClubPaymentModeAction(", fnStart);
    const fnBody = src.slice(fnStart, fnEnd);
    expect(fnBody).toContain('.eq("payment_id", paymentId)');
    expect(fnBody).toContain('.eq("club_id", expectedClubId)');
  });

  it("/admin/payments remains gated by the SAME isOperator(profile.role) check — Member/Pro still redirected, unchanged by this feature", () => {
    const src = readSource(PAGE_PATH);
    expect(src).toContain('if (!profile || !isOperator(profile.role)) redirect("/calendar");');
  });

  it("no new RPC or migration is introduced — payment_events/reservations/lesson_requests/event_participants/program_enrollments are all read via the caller's own authenticated (RLS-governed) client, exactly like the pre-existing reservation/court reads on this same page", () => {
    const src = readSource(PAGE_PATH);
    expect(src).not.toMatch(/createPrivilegedClient/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Goal 6 — preserved money invariants (this feature is read-only/UX-only).
// ═══════════════════════════════════════════════════════════════════════════

describe("this feature never touches money-moving state — read-only UX only", () => {
  it("page.tsx's new domain-context reads add columns (ends_at/status) to EXISTING queries — never add a new write, never touch payments/payment_events directly for anything but the pre-existing refundable/dispute reads", () => {
    const src = readSource(PAGE_PATH);
    expect(src).toContain('select("id, court_id, starts_at, ends_at, status")');
    expect(src).toContain('select("id, pro_id, proposed_starts_at, proposed_ends_at, status")');
    expect(src).not.toMatch(/\.update\(|\.insert\(|\.delete\(/);
  });

  it("AdminPaymentsClient and PaymentDetailSheet never construct or reference amount_paid_cents as a WRITE target — read-only display via row.state", () => {
    const clientSrc = readSource(CLIENT_PATH);
    const detailSrc = readSource(DETAIL_SHEET_PATH);
    expect(clientSrc).not.toMatch(/amount_paid_cents\s*[:=]/);
    expect(detailSrc).not.toMatch(/amount_paid_cents\s*[:=]/);
  });

  it("PaymentDetailSheet's refunded amount is derived read-only from fetched history, filtered to non-reversed refund events only — mirrors the rollup's own reversal exclusion, never mutates or resubmits anything", () => {
    const src = readSource(DETAIL_SHEET_PATH);
    expect(src).toContain('REFUND_EVENT_TYPES.has(e.eventType) && !e.isReversed');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// External review correction — refunded amount must never be fabricated as
// $0.00 while financial history is still loading or failed to load.
// ═══════════════════════════════════════════════════════════════════════════

describe("refundedDisplay is loading/error-aware — never a fabricated $0.00", () => {
  it("shows 'Loading…' while history is null (not yet fetched), never formatMoney(0, ...)", () => {
    const src = readSource(DETAIL_SHEET_PATH);
    const idx = src.indexOf("const refundedDisplay = historyError");
    expect(idx).toBeGreaterThan(0);
    const block = src.slice(idx, src.indexOf("resolvedCurrency,\n        );", idx));
    expect(block).toContain('"Loading…"');
    expect(block).toContain("history === null");
  });

  it("shows 'Unavailable' when historyError is set, never formatMoney(0, ...)", () => {
    const src = readSource(DETAIL_SHEET_PATH);
    const idx = src.indexOf("const refundedDisplay = historyError");
    const block = src.slice(idx, src.indexOf("resolvedCurrency,\n        );", idx));
    expect(block).toContain('"Unavailable"');
  });

  it("the Refunded FinancialFact renders refundedDisplay directly, not a raw formatMoney(refundedCents, ...) call", () => {
    const src = readSource(DETAIL_SHEET_PATH);
    expect(src).toContain('<FinancialFact label="Refunded" value={refundedDisplay} />');
    expect(src).not.toContain('<FinancialFact label="Refunded" value={formatMoney(refundedCents');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// External review correction — lifecycle review prose must be domain-
// neutral, never assume "booking"/"cancellation" for every domain type.
// ═══════════════════════════════════════════════════════════════════════════

describe("lifecycle review prose is domain-neutral", () => {
  it("uses the exact neutral wording, never the domain-specific 'booking'/'cancellation' phrasing", () => {
    const src = readSource(DETAIL_SHEET_PATH);
    expect(src).toContain(
      '`The related activity is currently "${row.lifecycleLabel}". This lifecycle state does not automatically refund, waive, or void the payment.`',
    );
    expect(src).not.toMatch(/The booking is in a/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// External review correction — financial-history timestamps must use the
// club's own timezone, threaded from page.tsx through both client
// components, never the browser/device timezone.
// ═══════════════════════════════════════════════════════════════════════════

describe("clubTimezone is threaded to PaymentDetailSheet and used for financial-history timestamps", () => {
  it("page.tsx passes clubTimezone to AdminPaymentsClient", () => {
    const src = readSource(PAGE_PATH);
    expect(src).toMatch(/<AdminPaymentsClient[\s\S]*?clubTimezone={clubTimezone}/);
  });

  it("AdminPaymentsClient accepts clubTimezone and forwards it to PaymentDetailSheet", () => {
    const src = readSource(CLIENT_PATH);
    expect(src).toContain("clubTimezone,");
    expect(src).toContain("clubTimezone: string;");
    expect(src).toMatch(/<PaymentDetailSheet[\s\S]*?clubTimezone={clubTimezone}/);
  });

  it("PaymentDetailSheet accepts clubTimezone and uses formatHistoryTimestamp (never a raw toLocaleDateString) for each history item's timestamp", () => {
    const src = readSource(DETAIL_SHEET_PATH);
    expect(src).toContain("clubTimezone: string;");
    expect(src).toContain("formatHistoryTimestamp(item.occurredAt, clubTimezone)");
    expect(src).not.toMatch(/new Date\(item\.occurredAt\)\.toLocaleDateString/);
  });
});
