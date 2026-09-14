import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 38B Task 3 (+ correction pass) — regression coverage for the
// USER-FACING Staff Request Refund / Admin Review workflow: the read-model
// wiring (page.tsx), fail-closed behavior on a read failure, the explicit
// Staff capability gate, the two sheets (RequestRefundSheet,
// ReviewRefundRequestSheet), attemptStatus-aware Review controls, and the
// mutual-exclusivity wiring in AdminPaymentsClient.tsx/PaymentDetailSheet.tsx.
// Source-inspection style, matching this repository's established
// convention for the React/Server-Action surfaces this project's vitest
// config cannot render (see paymentDetailUX.regression.test.ts and
// stripeRefund.regression.test.ts for precedent).

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

// Strips `//` comment lines — several assertions below need to check the
// ACTUAL code for a forbidden call/import, not prose in a doc comment that
// deliberately explains what the file does NOT do (e.g. this file's own
// header comments name the actions/Stripe explicitly, for documentation).
function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

const PAGE_PATH = "src/app/(app)/admin/payments/page.tsx";
const CLIENT_PATH = "src/app/(app)/admin/payments/AdminPaymentsClient.tsx";
const DETAIL_SHEET_PATH = "src/components/PaymentDetailSheet.tsx";
const REQUEST_SHEET_PATH = "src/components/RequestRefundSheet.tsx";
const REVIEW_SHEET_PATH = "src/components/ReviewRefundRequestSheet.tsx";
const REFUND_ACTIONS_PATH = "src/app/(app)/admin/payments/refundActions.ts";
const REFUND_CONFIG_PATH = "src/lib/stripe/refundConfig.ts";
const ROLES_PATH = "src/lib/auth/roles.ts";

// ═══════════════════════════════════════════════════════════════════════════
// 1/2 — read model: one batched fetch, row carries pendingRefundRequest
// ═══════════════════════════════════════════════════════════════════════════

describe("read model — pending refund requests fetched in ONE batched call, threaded onto the row", () => {
  it("page.tsx calls fetchPendingRefundRequests exactly once, with the full paymentIds array — never per-row", () => {
    const src = readSource(PAGE_PATH);
    expect(src).toContain('import { fetchPendingRefundRequests } from "./refundActions";');
    const occurrences = src.split("fetchPendingRefundRequests(paymentIds)").length - 1;
    expect(occurrences).toBe(1);
    // Never called inside the per-payment row-construction loop (the
    // SECOND "for (const p of latestPayments)" loop — the first, earlier
    // one only collects per-domain ids).
    const loopStart = src.lastIndexOf("for (const p of latestPayments) {");
    const loopBody = src.slice(loopStart, src.indexOf("\n  rows.sort(", loopStart));
    expect(loopBody).not.toMatch(/fetchPendingRefundRequests/);
  });

  it("builds a paymentId -> request Map from the batched result, mirroring the existing refundableByPaymentId pattern", () => {
    const src = readSource(PAGE_PATH);
    expect(src).toContain("const pendingRequestByPaymentId = new Map(");
    expect(src).toContain("(pendingRequestsResult.data ?? []).map(r => [r.paymentId, r])");
  });

  it("AdminPaymentRow gains pendingRefundRequest: StaffRefundRequestSummary | null, populated from the map", () => {
    const clientSrc = readSource(CLIENT_PATH);
    expect(clientSrc).toContain('import type { StaffRefundRequestSummary } from "./refundActions";');
    expect(clientSrc).toContain("pendingRefundRequest: StaffRefundRequestSummary | null;");

    const pageSrc = readSource(PAGE_PATH);
    expect(pageSrc).toContain("pendingRefundRequest: pendingRequestByPaymentId.get(p.id) ?? null,");
  });

  it("the existing refundableCents (live/current refundable) read is untouched — pendingRefundRequest is an ADDITIONAL field, not a replacement", () => {
    const src = readSource(PAGE_PATH);
    expect(src).toContain("get_online_refundable_amount_for_payments");
    expect(src).toContain("refundableCents: refundableByPaymentId.get(p.id) ?? 0,");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Correction pass §1 — fail-closed on a pending-request read failure
// ═══════════════════════════════════════════════════════════════════════════

describe("fail-closed — a pending-request read failure never falls through to 'no pending request'", () => {
  it("page.tsx derives refundRequestReadFailed from the result's own error, logs it server-side, and never fabricates a request row", () => {
    const src = readSource(PAGE_PATH);
    const idx = src.indexOf("const refundRequestReadFailed = Boolean(pendingRequestsResult.error);");
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, src.indexOf("const pendingRequestByPaymentId", idx));
    expect(block).toContain("if (refundRequestReadFailed) {");
    expect(block).toContain("console.error(");
    // No fabricated/placeholder request row is ever synthesized.
    expect(block).not.toMatch(/requestId:\s*["']/);
  });

  it("pendingRequestByPaymentId is still built from an empty array on failure (fetchPendingRefundRequests returns no `data` on error) — never a per-row fallback fetch", () => {
    const src = readSource(PAGE_PATH);
    expect(src).toContain("(pendingRequestsResult.data ?? []).map(r => [r.paymentId, r])");
    // Still exactly one batched call — see the read-model describe block
    // above for the dedicated "exactly once" assertion.
    expect(src.split("await fetchPendingRefundRequests(paymentIds)").length - 1).toBe(1);
  });

  it("refundRequestReadFailed is threaded down to AdminPaymentsClient as its own prop — never conflated with isAdmin/isStaff/eligibility", () => {
    const src = readSource(PAGE_PATH);
    expect(src).toContain("refundRequestReadFailed={refundRequestReadFailed}");
  });

  it("AdminPaymentsClient derives refundActionsAvailable = !refundRequestReadFailed and requires it in ALL THREE refund-action conditions (Request Refund, Refund, Review)", () => {
    const src = readSource(CLIENT_PATH);
    expect(src).toContain("const refundActionsAvailable = !refundRequestReadFailed;");
    expect(src).toContain("isStaff && refundActionsAvailable && !row.pendingRefundRequest && isOnlineRefundEligible");
    expect(src).toContain("isAdmin && refundActionsAvailable && !row.pendingRefundRequest && isOnlineRefundEligible");
    expect(src).toContain("isAdmin && refundActionsAvailable && row.pendingRefundRequest && (");
  });

  it("PaymentDetailSheet requires the SAME refundActionsAvailable prop in canRefund/canReview/canRequestRefundRequest", () => {
    const src = readSource(DETAIL_SHEET_PATH);
    expect(src).toContain("refundActionsAvailable: boolean;");
    expect(src).toContain("const canRefund = isAdmin && refundActionsAvailable && isRefundEligible && !hasPendingRefundRequest;");
    expect(src).toContain("const canReview = isAdmin && refundActionsAvailable && hasPendingRefundRequest;");
    expect(src).toContain("const canRequestRefundRequest = isStaff && refundActionsAvailable && isRefundEligible && !hasPendingRefundRequest;");
  });

  it("AdminPaymentsClient shows a concise unavailability notice whenever refundRequestReadFailed is true", () => {
    const src = readSource(CLIENT_PATH);
    const idx = src.indexOf("{refundRequestReadFailed && (");
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 300);
    expect(block).toMatch(/Refund actions unavailable/);
  });

  it("no code path can enable a refund action when refundActionsAvailable is false — every occurrence of the three action conditions includes it", () => {
    const src = readSource(CLIENT_PATH);
    // Every one of the three row-action gates includes refundActionsAvailable.
    const staffCond = src.match(/isStaff && [^\n]*isOnlineRefundEligible/)?.[0] ?? "";
    const adminRefundCond = src.match(/\{isAdmin && [^\n]*isOnlineRefundEligible/)?.[0] ?? "";
    const adminReviewCond = src.match(/\{isAdmin && [^\n]*row\.pendingRefundRequest && \(/)?.[0] ?? "";
    for (const cond of [staffCond, adminRefundCond, adminReviewCond]) {
      expect(cond).toMatch(/refundActionsAvailable/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Correction pass §2 — explicit Staff gate, never !isAdmin
// ═══════════════════════════════════════════════════════════════════════════

describe("explicit Staff capability gate — never derived as !isAdmin", () => {
  it("page.tsx imports isStaff alongside isAdmin/isOperator and computes isStaffRole = isStaff(profile.role)", () => {
    const src = codeOnly(readSource(PAGE_PATH));
    expect(src).toContain('import { isOperator, isAdmin, isStaff } from "@/lib/auth/roles";');
    expect(src).toContain("const isStaffRole = isStaff(profile.role);");
    expect(src).toContain("isStaff={isStaffRole}");
  });

  it("isStaff(role) itself is a positive role === 'staff' check, distinct from isAdmin and from a route-level exclusion", () => {
    const src = codeOnly(readSource(ROLES_PATH));
    const fnStart = src.indexOf("export function isStaff(");
    const fn = src.slice(fnStart, src.indexOf("\n}", fnStart) + 2);
    expect(fn).toContain('return role === "staff";');
  });

  it("Staff sees Request Refund only when eligible AND no pending request exists AND the read succeeded — gated on isStaff, never !isAdmin", () => {
    const src = readSource(CLIENT_PATH);
    expect(src).toContain(
      "{isStaff && refundActionsAvailable && !row.pendingRefundRequest && isOnlineRefundEligible(row.refundableCents) && !row.disputeBlocksRefund && (",
    );
    // The literal negated-admin pattern must not be the Staff gate anywhere.
    expect(src).not.toMatch(/\{!isAdmin && [^\n]*isOnlineRefundEligible/);
  });

  it("Admin cannot see Request Refund — the Request Refund condition requires isStaff, and isAdmin/isStaff are mutually exclusive role facts", () => {
    const src = readSource(CLIENT_PATH);
    const idx = src.indexOf("{isStaff && refundActionsAvailable && !row.pendingRefundRequest");
    expect(idx).toBeGreaterThan(-1);
    // The Admin-facing actions (Refund/Review) are separately gated on
    // isAdmin — Request Refund's own condition never includes isAdmin at all.
    const block = src.slice(idx, src.indexOf("Request Refund", idx));
    expect(block).not.toMatch(/isAdmin/);
  });

  it("PaymentDetailSheet's canRequestRefundRequest is gated on isStaff, never !isAdmin", () => {
    const src = readSource(DETAIL_SHEET_PATH);
    expect(src).toContain("isStaff: boolean;");
    expect(src).toContain("const canRequestRefundRequest = isStaff && refundActionsAvailable && isRefundEligible && !hasPendingRefundRequest;");
    expect(src).not.toMatch(/canRequestRefundRequest = !isAdmin/);
  });

  it("a Member/Pro/non-Staff caller cannot receive the Staff Request Refund action even if this component somehow rendered for them — isStaff is a POSITIVE check (role === 'staff'), false for member/pro/admin alike, so no role other than 'staff' can satisfy it", () => {
    const rolesSrc = codeOnly(readSource(ROLES_PATH));
    const fnStart = rolesSrc.indexOf("export function isStaff(");
    const fn = rolesSrc.slice(fnStart, rolesSrc.indexOf("\n}", fnStart) + 2);
    // A strict equality check against the literal 'staff' string returns
    // false for every other role value ('member', 'pro', 'admin', null,
    // undefined, or any unrecognized string) — there is no route-level
    // exclusion this depends on.
    expect(fn).toBe('export function isStaff(role: string | null | undefined): boolean {\n  return role === "staff";\n}');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3/4/7/9/16 — mutual exclusivity in AdminPaymentsClient's list rows
// ═══════════════════════════════════════════════════════════════════════════

describe("AdminPaymentsClient — at most ONE refund action renders per row, per role/state", () => {
  it("Admin's direct Refund is suppressed while a request is pending (mutual exclusivity with Review)", () => {
    const src = readSource(CLIENT_PATH);
    expect(src).toContain(
      "{isAdmin && refundActionsAvailable && !row.pendingRefundRequest && isOnlineRefundEligible(row.refundableCents) && !row.disputeBlocksRefund && (",
    );
  });

  it("Admin's Review renders purely from row.pendingRefundRequest — independent of current refundableCents/disputeBlocksRefund (a pending request must be reviewable even if no longer fully refundable, so it can still be rejected)", () => {
    const src = readSource(CLIENT_PATH);
    const idx = src.indexOf("{isAdmin && refundActionsAvailable && row.pendingRefundRequest && (");
    expect(idx).toBeGreaterThan(0);
    const block = src.slice(idx, src.indexOf("Review", idx));
    expect(block).not.toMatch(/isOnlineRefundEligible|disputeBlocksRefund/);
  });

  it("Staff never sees isAdmin-gated Refund or Review buttons — every Admin-only refund action is prefixed with isAdmin", () => {
    const src = readSource(CLIENT_PATH);
    expect(src).toContain("isAdmin && refundActionsAvailable && !row.pendingRefundRequest && isOnlineRefundEligible");
    expect(src).toContain("isAdmin && refundActionsAvailable && row.pendingRefundRequest && (");
  });

  it("the three action conditions are structurally mutually exclusive by construction: Request Refund requires isStaff, Refund and Review both require isAdmin, and Refund additionally requires !pendingRefundRequest while Review requires pendingRefundRequest", () => {
    const src = readSource(CLIENT_PATH);
    expect(src).toContain("{isStaff && refundActionsAvailable && !row.pendingRefundRequest && isOnlineRefundEligible");
    expect(src).toContain("{isAdmin && refundActionsAvailable && !row.pendingRefundRequest && isOnlineRefundEligible");
    expect(src).toContain("{isAdmin && refundActionsAvailable && row.pendingRefundRequest && (");
  });

  it("a 'Refund requested' badge renders for BOTH roles whenever pendingRefundRequest exists, independent of the action buttons", () => {
    const src = readSource(CLIENT_PATH);
    const idx = src.indexOf("{row.pendingRefundRequest && (");
    expect(idx).toBeGreaterThan(0);
    const block = src.slice(idx, idx + 320);
    expect(block).toContain("Refund requested");
    expect(block).not.toMatch(/isAdmin|isStaff/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8/9 — Admin pending-state renders Review INSTEAD of Refund; no-pending
// preserves existing direct Refund
// ═══════════════════════════════════════════════════════════════════════════

describe("Admin: pending state shows Review instead of Refund; no-pending state is byte-identical to the pre-38B condition plus the new clauses", () => {
  it("the existing Refund condition gained EXACTLY two new clauses (refundActionsAvailable, !row.pendingRefundRequest) — every other clause (isOnlineRefundEligible, disputeBlocksRefund) is untouched", () => {
    const src = readSource(CLIENT_PATH);
    expect(src).toContain(
      "{isAdmin && refundActionsAvailable && !row.pendingRefundRequest && isOnlineRefundEligible(row.refundableCents) && !row.disputeBlocksRefund && (",
    );
  });

  it("Review is a DISTINCT button from Refund — different label, different state target (reviewTarget, not refundTarget)", () => {
    const src = readSource(CLIENT_PATH);
    expect(src).toContain("const [reviewTarget, setReviewTarget] = useState<AdminPaymentRow | null>(null);");
    const onClickIdx = src.indexOf("onClick={() => setReviewTarget(row)}");
    expect(onClickIdx).toBeGreaterThan(-1);
    const buttonEnd = src.indexOf("</button>", onClickIdx);
    expect(src.slice(onClickIdx, buttonEnd)).toContain("Review");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 15/16 — PaymentDetailSheet keeps distinct Staff/Admin handoff callbacks
// ═══════════════════════════════════════════════════════════════════════════

describe("PaymentDetailSheet — distinct callbacks, never conflated, no conflicting actions", () => {
  it("declares THREE distinct refund-related callbacks: onRequestRefund (Admin direct), onRequestRefundRequest (Staff), onReviewRefundRequest (Admin review) — never overloading one name for two purposes", () => {
    const src = readSource(DETAIL_SHEET_PATH);
    expect(src).toContain("onRequestRefund: () => void;");
    expect(src).toContain("onRequestRefundRequest: () => void;");
    expect(src).toContain("onReviewRefundRequest: () => void;");
    const names = ["onRequestRefund", "onRequestRefundRequest", "onReviewRefundRequest"];
    expect(new Set(names).size).toBe(3);
  });

  it("canRefund/canReview/canRequestRefundRequest are mutually exclusive by construction: canRefund and canRequestRefundRequest both require !hasPendingRefundRequest, canReview requires hasPendingRefundRequest, and canRefund/canRequestRefundRequest are gated on isAdmin/isStaff respectively (not on negating one another)", () => {
    const src = readSource(DETAIL_SHEET_PATH);
    expect(src).toContain("const hasPendingRefundRequest = row.pendingRefundRequest !== null;");
    expect(src).toContain("const canRefund = isAdmin && refundActionsAvailable && isRefundEligible && !hasPendingRefundRequest;");
    expect(src).toContain("const canReview = isAdmin && refundActionsAvailable && hasPendingRefundRequest;");
    expect(src).toContain("const canRequestRefundRequest = isStaff && refundActionsAvailable && isRefundEligible && !hasPendingRefundRequest;");
  });

  it("each button is wired to its own distinct callback — Refund to onRequestRefund, Review to onReviewRefundRequest, Request Refund to onRequestRefundRequest", () => {
    const src = readSource(DETAIL_SHEET_PATH);
    expect(src).toContain("{canRefund && (");
    expect(src).toContain("onClick={onRequestRefund}");
    expect(src).toContain("{canReview && (");
    expect(src).toContain("onClick={onReviewRefundRequest}");
    expect(src).toContain("{canRequestRefundRequest && (");
    expect(src).toContain("onClick={onRequestRefundRequest}");
  });

  it("the 'Refund requested' badge renders independent of isAdmin/isStaff, matching AdminPaymentsClient's own row-level badge", () => {
    const src = readSource(DETAIL_SHEET_PATH);
    const idx = src.indexOf("{hasPendingRefundRequest && (");
    expect(idx).toBeGreaterThan(0);
    const block = src.slice(idx, idx + 320);
    expect(block).toContain("Refund requested");
    expect(block).not.toMatch(/isAdmin|isStaff/);
  });
});

describe("AdminPaymentsClient — PaymentDetailSheet handoff closes Detail before opening the target sheet (no stacked sheets)", () => {
  it("onRequestRefund/onRequestRefundRequest/onReviewRefundRequest/onRequestRecordPayment each set their own target AND close Detail in the same handler", () => {
    const src = readSource(CLIENT_PATH);
    const handoffs = [
      "onRequestRefund={() => { setRefundTarget(detailTarget); setDetailTarget(null); }}",
      "onRequestRefundRequest={() => { setRequestRefundTarget(detailTarget); setDetailTarget(null); }}",
      "onReviewRefundRequest={() => { setReviewTarget(detailTarget); setDetailTarget(null); }}",
      "onRequestRecordPayment={() => { setRecordTarget(detailTarget); setDetailTarget(null); }}",
    ];
    for (const h of handoffs) {
      expect(src).toContain(h);
    }
  });

  it("each of the five sheet targets (record/refund/requestRefund/review/detail) is rendered from its OWN independent `{target && (...)}` block — never nested inside another sheet's block, so at most one renders at a time per user action", () => {
    const src = readSource(CLIENT_PATH);
    for (const guard of [
      "{recordTarget && (",
      "{refundTarget && (",
      "{requestRefundTarget && (",
      "{reviewTarget && reviewTarget.pendingRefundRequest && (",
      "{detailTarget && (",
    ]) {
      expect(src).toContain(guard);
    }
  });

  it("PaymentDetailSheet is handed isStaff and refundActionsAvailable, not re-derived locally from isAdmin", () => {
    const src = readSource(CLIENT_PATH);
    expect(src).toContain("isStaff={isStaff}");
    expect(src).toContain("refundActionsAvailable={refundActionsAvailable}");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5/17 — RequestRefundSheet calls ONLY createRefundRequestAction
// ═══════════════════════════════════════════════════════════════════════════

describe("RequestRefundSheet — Staff only, calls ONLY createRefundRequestAction, no Stripe/execution path", () => {
  it("imports and calls createRefundRequestAction — never createOnlineRefundAction, approveRefundRequestAction, or rejectRefundRequestAction (checked against CODE only — the header comment deliberately names these in prose to document what this file does NOT do)", () => {
    const src = readSource(REQUEST_SHEET_PATH);
    expect(src).toContain('import { createRefundRequestAction } from "@/app/(app)/admin/payments/refundActions";');
    expect(src).toContain("createRefundRequestAction(");
    expect(codeOnly(src)).not.toMatch(/createOnlineRefundAction|approveRefundRequestAction|rejectRefundRequestAction/);
  });

  it("never imports or calls the Stripe SDK or any privileged/service-role client (checked against CODE only — the user-facing copy legitimately says the word \"Stripe\" to explain online-only refunds, matching RefundPaymentSheet's own identical copy)", () => {
    const src = readSource(REQUEST_SHEET_PATH);
    expect(codeOnly(src)).not.toMatch(/from ["']stripe["']|createPrivilegedClient|getStripeContext|\.refunds\.create/i);
  });

  it("on success (no error), closes through the onRequested callback — never calls onClose separately (mirrors RefundPaymentSheet's onRefunded handoff)", () => {
    const src = readSource(REQUEST_SHEET_PATH);
    expect(src).toContain("onRequested();");
    const fnStart = src.indexOf("async function handleSubmit()");
    const fnBody = src.slice(fnStart);
    expect(fnBody).not.toMatch(/onClose\(\);/);
  });
});

describe("RequestRefundSheet — amount and reason validation", () => {
  it("reason is required and trimmed — whitespace-only input cannot submit", () => {
    const src = readSource(REQUEST_SHEET_PATH);
    expect(src).toContain("const trimmedReason = reason.trim();");
    const canSubmitIdx = src.indexOf("const canSubmit =");
    const canSubmitBlock = src.slice(canSubmitIdx, src.indexOf(";", src.indexOf("trimmedReason.length", canSubmitIdx)) + 1);
    expect(canSubmitBlock).toContain("trimmedReason.length > 0");
  });

  it("amount must be > 0 and bounded by the current refundableCents prop — never allowed to exceed it", () => {
    const src = readSource(REQUEST_SHEET_PATH);
    const canSubmitIdx = src.indexOf("const canSubmit =");
    const canSubmitBlock = src.slice(canSubmitIdx, src.indexOf(";", src.indexOf("trimmedReason.length", canSubmitIdx)) + 1);
    expect(canSubmitBlock).toContain("amountCents > 0");
    expect(canSubmitBlock).toContain("amountCents <= refundableCents");
  });

  it("notes is optional — trimmed and sent as null when empty, never required for canSubmit", () => {
    const src = readSource(REQUEST_SHEET_PATH);
    expect(src).toContain("notes: notes.trim() || null");
    const canSubmitIdx = src.indexOf("const canSubmit =");
    const canSubmitEnd = src.indexOf(";", src.indexOf("trimmedReason.length", canSubmitIdx));
    expect(src.slice(canSubmitIdx, canSubmitEnd)).not.toMatch(/notes/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6/10/11 — ReviewRefundRequestSheet: display + approval never takes amount
// ═══════════════════════════════════════════════════════════════════════════

describe("ReviewRefundRequestSheet — displays requester/amount/current refundable/reason/notes", () => {
  it("displays requestedByName, requestedAmountCents, currentRefundableCents, reason, and notes (when present)", () => {
    const src = readSource(REVIEW_SHEET_PATH);
    expect(src).toContain('<ReviewFact label="Requested by" value={request.requestedByName} />');
    expect(src).toContain('<ReviewFact label="Requested amount" value={formatMoney(request.requestedAmountCents, currency)} />');
    expect(src).toContain('<ReviewFact label="Currently refundable" value={formatMoney(currentRefundableCents, currency)} />');
    expect(src).toContain("{request.reason}");
    expect(src).toContain("{request.notes && (");
    expect(src).toContain("{request.notes}");
  });
});

describe("ReviewRefundRequestSheet — approval receives requestId ONLY, no amount", () => {
  it("approveRefundRequestAction is called with { requestId: request.requestId } only — no amount field in the call", () => {
    const src = readSource(REVIEW_SHEET_PATH);
    const callIdx = src.indexOf("approveRefundRequestAction({ requestId: request.requestId }, clubId)");
    expect(callIdx).toBeGreaterThan(-1);
  });

  it("never references requestedAmountCents as an argument to approveRefundRequestAction — only for display/comparison", () => {
    const src = readSource(REVIEW_SHEET_PATH);
    const approveFnStart = src.indexOf("async function handleApprove()");
    const approveFnEnd = src.indexOf("\n  async function handleReject()");
    const approveFn = src.slice(approveFnStart, approveFnEnd);
    expect(approveFn).not.toMatch(/amountCents\s*:/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 12 — Approve disabled when requested amount exceeds current refundable
// ═══════════════════════════════════════════════════════════════════════════

describe("ReviewRefundRequestSheet — Approve disabled when requested amount exceeds current refundable", () => {
  it("amountExceedsRefundable compares requestedAmountCents against the LIVE currentRefundableCents prop, never a stale/captured amount", () => {
    const src = readSource(REVIEW_SHEET_PATH);
    expect(src).toContain(
      "const amountExceedsRefundable = request.requestedAmountCents > currentRefundableCents;",
    );
  });

  it("canApprove is false whenever amountExceedsRefundable is true, and the button's disabled prop is wired to canApprove", () => {
    const src = readSource(REVIEW_SHEET_PATH);
    expect(src).toContain("const canApprove = !submitting && !isLocked && !amountExceedsRefundable;");
    expect(src).toContain("disabled={!canApprove}");
  });

  it("never substitutes a different/lower amount when exceeded — the approve call and the displayed 'Approve & Refund $X' label both still use the ORIGINAL requestedAmountCents, never currentRefundableCents", () => {
    const src = readSource(REVIEW_SHEET_PATH);
    expect(src).toContain("Approve & Refund ${formatMoney(request.requestedAmountCents, currency)}");
    expect(src).not.toMatch(/amountCents:\s*currentRefundableCents/);
  });

  it("shows an explanatory notice when exceeded (and not locked), without ever silently lowering/substituting", () => {
    const src = readSource(REVIEW_SHEET_PATH);
    const idx = src.indexOf("{!isLocked && amountExceedsRefundable && (");
    expect(idx).toBeGreaterThan(0);
    const block = src.slice(idx, idx + 400);
    expect(block).toMatch(/no longer fully refundable/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 13 — rejection requires a reason
// ═══════════════════════════════════════════════════════════════════════════

describe("ReviewRefundRequestSheet — rejection requires a reason", () => {
  it("rejectRefundRequestAction is called only with a trimmed, non-empty rejectionReason", () => {
    const src = readSource(REVIEW_SHEET_PATH);
    expect(src).toContain("const trimmedRejectionReason = rejectionReason.trim();");
    expect(src).toContain("const canReject = !submitting && !isLocked && trimmedRejectionReason.length > 0;");
    expect(src).toContain("rejectionReason: trimmedRejectionReason");
  });

  it("the Confirm Reject button's disabled prop is wired to canReject — whitespace-only input cannot submit", () => {
    const src = readSource(REVIEW_SHEET_PATH);
    const idx = src.indexOf("Confirm Reject");
    expect(idx).toBeGreaterThan(0);
    const buttonStart = src.lastIndexOf("<button", idx);
    const surrounding = src.slice(buttonStart, idx);
    expect(surrounding).toContain("disabled={!canReject}");
  });

  it("rejectRefundRequestAction is called — never a Stripe/refund-execution call — in the reject handler", () => {
    const src = readSource(REVIEW_SHEET_PATH);
    const fnStart = src.indexOf("async function handleReject()");
    const fnEnd = src.indexOf("\n\n  return (", fnStart);
    const fn = src.slice(fnStart, fnEnd);
    expect(fn).toContain("rejectRefundRequestAction(");
    expect(fn).not.toMatch(/approveRefundRequestAction|createOnlineRefundAction|refunds\.create/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Correction pass §3 — attemptStatus-aware Review controls
// ═══════════════════════════════════════════════════════════════════════════

describe("ReviewRefundRequestSheet — attemptStatus locks the review controls", () => {
  it("isExecutionInProgress is true for pending/requires_action ONLY; isExecutionSucceeded is true for succeeded ONLY; isLocked is their union", () => {
    const src = readSource(REVIEW_SHEET_PATH);
    expect(src).toContain(
      'const isExecutionInProgress = request.attemptStatus === "pending" || request.attemptStatus === "requires_action";',
    );
    expect(src).toContain('const isExecutionSucceeded = request.attemptStatus === "succeeded";');
    expect(src).toContain("const isLocked = isExecutionInProgress || isExecutionSucceeded;");
  });

  it("null and failed/canceled attemptStatus values are NOT locked — canApprove/canReject only additionally require !isLocked, so null/failed/canceled behave exactly as the normal review state", () => {
    const src = readSource(REVIEW_SHEET_PATH);
    // isLocked is derived ONLY from pending/requires_action/succeeded —
    // null, 'failed', and 'canceled' are absent from its own definition,
    // so isLocked is structurally false for all three.
    const isLockedIdx = src.indexOf("const isLocked = isExecutionInProgress || isExecutionSucceeded;");
    expect(isLockedIdx).toBeGreaterThan(-1);
    expect(src).not.toMatch(/attemptStatus === "failed"/);
    expect(src).not.toMatch(/attemptStatus === "canceled"/);
  });

  it("Reject is NOT offered/enabled when isLocked (pending/requires_action/succeeded) — canReject requires !isLocked, and the Reject entry-point button is only rendered in the non-locked review branch", () => {
    const src = readSource(REVIEW_SHEET_PATH);
    expect(src).toContain("const canReject = !submitting && !isLocked && trimmedRejectionReason.length > 0;");
    // The Reject/Approve button row only renders when !isLocked (the
    // ternary's non-locked branch) — see the isLocked ? ... : mode ===
    // "review" ? ... structure below.
    const ternaryIdx = src.indexOf("{isLocked ? (");
    expect(ternaryIdx).toBeGreaterThan(-1);
    const reviewBranchIdx = src.indexOf(') : mode === "review" ? (', ternaryIdx);
    expect(reviewBranchIdx).toBeGreaterThan(ternaryIdx);
    const lockedBranch = src.slice(ternaryIdx, reviewBranchIdx);
    expect(lockedBranch).not.toContain("setMode(\"reject\")");
  });

  it("Approve is NOT offered/enabled when isLocked — canApprove requires !isLocked", () => {
    const src = readSource(REVIEW_SHEET_PATH);
    expect(src).toContain("const canApprove = !submitting && !isLocked && !amountExceedsRefundable;");
  });

  it("a concise processing/in-progress message replaces the decision controls when locked — distinct copy for succeeded (transient/fail-closed) vs pending/requires_action (in progress)", () => {
    const src = readSource(REVIEW_SHEET_PATH);
    const idx = src.indexOf("{isLocked ? (");
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 1100);
    expect(block).toMatch(/currently processing in Stripe/);
    expect(block).toMatch(/already completed/);
    expect(block).toContain("isExecutionSucceeded");
  });

  it("failed/canceled attemptStatus remain retry/reject eligible — isLocked's own definition excludes them, so canApprove/canReject are governed only by submitting/amountExceedsRefundable/reason exactly as the null case", () => {
    const src = readSource(REVIEW_SHEET_PATH);
    // Structural proof: isLocked is defined purely in terms of pending/
    // requires_action/succeeded (asserted above) — failed and canceled
    // therefore fall through to isLocked === false, the identical path
    // null takes, with no special-casing anywhere else in the file.
    const failedOrCanceledSpecialCase = src.match(/attemptStatus === "failed"|attemptStatus === "canceled"/g);
    expect(failedOrCanceledSpecialCase).toBeNull();
  });
});

describe("ReviewRefundRequestSheet — a pending/requires_action approval result closes + refreshes rather than leaving stale controls visible", () => {
  it("handleApprove routes a 'notice' outcome (pending/requires_action) to onResolved(), NOT to a stayed-open statusNotice display", () => {
    const src = readSource(REVIEW_SHEET_PATH);
    const fnStart = src.indexOf("async function handleApprove()");
    const fnEnd = src.indexOf("\n  async function handleReject()");
    const fn = src.slice(fnStart, fnEnd);
    expect(fn).toContain('if (outcome.kind === "notice") {');
    const noticeIdx = fn.indexOf('if (outcome.kind === "notice") {');
    const noticeBlockEnd = fn.indexOf("return;", noticeIdx);
    const noticeBlock = fn.slice(noticeIdx, noticeBlockEnd);
    expect(noticeBlock).toContain("onResolved();");
    // No stale-controls path: statusNotice state no longer exists in this
    // file at all — the sheet only ever stays open on a genuine 'error'.
    expect(src).not.toMatch(/statusNotice/);
  });

  it("only a genuine 'error' outcome (failed/canceled/unrecognized) keeps the sheet open with setError — success and notice both close via onResolved", () => {
    const src = readSource(REVIEW_SHEET_PATH);
    const fnStart = src.indexOf("async function handleApprove()");
    const fnEnd = src.indexOf("\n  async function handleReject()");
    const fn = src.slice(fnStart, fnEnd);
    const successIdx = fn.indexOf('outcome.kind === "success"');
    const noticeIdx = fn.indexOf('outcome.kind === "notice"');
    expect(fn.slice(successIdx, fn.indexOf("return;", successIdx))).toContain("onResolved();");
    expect(fn.slice(noticeIdx, fn.indexOf("return;", noticeIdx))).toContain("onResolved();");
    // After both explicit branches return, only the fallthrough (error) path remains.
    const afterNotice = fn.slice(fn.indexOf("return;", noticeIdx));
    expect(afterNotice).toContain("setError(outcome.message);");
    expect(afterNotice).toContain("setSubmitting(false);");
  });

  it("still reuses the ONE shared interpretRefundStatus helper — no second refund-status state machine introduced by this correction", () => {
    const src = readSource(REVIEW_SHEET_PATH);
    expect(src).toContain('import { interpretRefundStatus } from "@/lib/stripe/refundConfig";');
    expect(src).toContain("interpretRefundStatus(result.status)");
    expect(src).not.toMatch(/switch\s*\(result\.status\)/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 17/18 — no new Stripe execution path in UI code; existing Admin Refund
// regressions remain green (proven by the untouched full suite run, but
// re-asserted here structurally as belt-and-suspenders)
// ═══════════════════════════════════════════════════════════════════════════

describe("no new Stripe execution path exists anywhere in the new UI code", () => {
  it("RequestRefundSheet and ReviewRefundRequestSheet never call stripe.refunds.create or any privileged client", () => {
    for (const path of [REQUEST_SHEET_PATH, REVIEW_SHEET_PATH]) {
      const src = readSource(path);
      expect(src).not.toMatch(/refunds\.create\(|createPrivilegedClient/);
    }
  });

  it("the ONLY place stripe.refunds.create is ever called across the whole refund feature remains executeOnlineRefund in refundActions.ts (Task 2's shared helper) — exactly one occurrence, UI included", () => {
    const actionsSrc = readSource(REFUND_ACTIONS_PATH);
    const occurrences = actionsSrc.split("context.client.refunds.create(").length - 1;
    expect(occurrences).toBe(1);
  });

  it("interpretRefundStatus (refundConfig.ts) is pure UI-copy interpretation — it never calls Stripe or any RPC itself", () => {
    const src = readSource(REFUND_CONFIG_PATH);
    const fnStart = src.indexOf("export function interpretRefundStatus(");
    const fnBody = src.slice(fnStart);
    expect(fnBody).not.toMatch(/stripe\.|\.rpc\(/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Error-copy audit (§6, prior pass) — createRefundRequestAction must never
// surface the Admin-issuance message to a Staff-request creation flow.
// ═══════════════════════════════════════════════════════════════════════════

describe("error copy — createRefundRequestAction never surfaces 'Only an Admin can issue a refund.' for its own insufficient_role case", () => {
  it("mapRefundRequestError accepts a context param and overrides insufficient_role specifically for context === \"create\"", () => {
    const src = readSource(REFUND_ACTIONS_PATH);
    const fnStart = src.indexOf('function mapRefundRequestError(message: string, context?: "create")');
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = src.indexOf("\n}", fnStart);
    const fn = src.slice(fnStart, fnEnd);
    expect(fn).toContain('if (context === "create" && key === "insufficient_role") {');
    expect(fn).toContain('"Only Staff can request a refund."');
  });

  it("createRefundRequestAction passes context: \"create\" to mapRefundRequestError — the ONLY call site that does", () => {
    const src = readSource(REFUND_ACTIONS_PATH);
    const createFnStart = src.indexOf("export async function createRefundRequestAction(");
    const createFnEnd = src.indexOf("\nexport async function fetchPendingRefundRequests(");
    const createFn = src.slice(createFnStart, createFnEnd);
    expect(createFn).toContain('mapRefundRequestError(error.message, "create")');

    const occurrences = src.split('mapRefundRequestError(error.message, "create")').length - 1;
    expect(occurrences).toBe(1);
  });

  it("the shared ERROR_MESSAGES.insufficient_role entry itself is untouched — still correct for createOnlineRefundAction/approveRefundRequestAction's own explicit admin checks", () => {
    const src = readSource(REFUND_ACTIONS_PATH);
    expect(src).toContain('insufficient_role: "Only an Admin can issue a refund.",');
    const occurrences = src.split("insufficient_role:").length - 1;
    expect(occurrences).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Responsive UX (§7, prior pass) — reuses ResponsiveSheet exactly as
// RefundPaymentSheet/RecordPaymentSheet do; no new modal/sheet framework.
// ═══════════════════════════════════════════════════════════════════════════

describe("responsive UX — RequestRefundSheet and ReviewRefundRequestSheet reuse the existing ResponsiveSheet conventions", () => {
  it("both sheets use ResponsiveSheet with variant=\"modal\" and mobileInteraction=\"draggable\", exactly like RefundPaymentSheet/RecordPaymentSheet", () => {
    for (const path of [REQUEST_SHEET_PATH, REVIEW_SHEET_PATH]) {
      const src = readSource(path);
      expect(src).toContain('import ResponsiveSheet from "@/components/ResponsiveSheet";');
      expect(src).toContain('variant="modal"');
      expect(src).toContain('mobileInteraction="draggable"');
      expect(src).toContain("label=");
      expect(src).toContain("header={");
    }
  });

  it("neither sheet imports any other modal/dialog framework", () => {
    for (const path of [REQUEST_SHEET_PATH, REVIEW_SHEET_PATH]) {
      const src = readSource(path);
      expect(src).not.toMatch(/react-modal|@headlessui|radix-ui/);
    }
  });

  it("submitting disables the close handler, matching RefundPaymentSheet's own guard against closing mid-submit", () => {
    for (const path of [REQUEST_SHEET_PATH, REVIEW_SHEET_PATH]) {
      const src = readSource(path);
      expect(src).toContain("onClose={submitting ? () => {} : onClose}");
    }
  });
});
