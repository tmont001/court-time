"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import Link from "next/link";
import PaymentStateBadge from "@/components/PaymentStateBadge";
import RecordPaymentSheet from "@/components/RecordPaymentSheet";
import RefundPaymentSheet from "@/components/RefundPaymentSheet";
import RequestRefundSheet from "@/components/RequestRefundSheet";
import ReviewRefundRequestSheet from "@/components/ReviewRefundRequestSheet";
import { isPaymentOpenForRecording, toneClassName, type PaymentStateRow } from "@/lib/payments";
import { isOnlineRefundEligible } from "@/lib/stripe/refundConfig";
import { presentDisputeStatus, disputeToneClassName, formatDisputeReason } from "@/lib/stripe/disputeConfig";
import { formatMoney } from "@/lib/money";
import { ACTION_BUTTON_PRIMARY_COMPACT_TOUCH } from "@/components/styles/actionButtonStyles";
import PaymentDetailSheet from "@/components/PaymentDetailSheet";
import PaymentExportMenu from "./PaymentExportMenu";
import { getFinancialOverviewAction, type FinancialOverviewResult } from "./financialOverviewActions";
import type { StaffRefundRequestSummary } from "./refundActions";
import type { ReportRange } from "../reports/dateRange";

// Mirrors FINANCIAL_DOMAIN_LABEL in ./financialSummary.ts (a server-only
// module — hydrateExportDomainContext there performs real Supabase queries
// meant to run only from a Server Action/Component, so it is deliberately
// NOT imported into this client component; this tiny, stable label map is
// duplicated rather than sharing that import boundary).
const FINANCIAL_DOMAIN_LABEL: Record<string, string> = {
  reservation: "Court reservations",
  lesson:      "Lessons",
  event:       "Events",
  program:     "Programs",
  other:       "Other / Legacy",
};

export interface AdminPaymentDispute {
  status: string;
  reason: string;
  amountCents: number;
  currency: string;
  evidenceDueBy: string | null;
}

export interface AdminPaymentRow {
  key: string;
  domainType: "reservation" | "lesson_request" | "event_participant" | "event_guest" | "program_enrollment";
  title: string;
  identityName: string;
  dateLabel: string | null;
  href: string;
  // Phase 34E-E — the underlying domain's OWN lifecycle state (e.g.
  // "Booking Cancelled"), entirely independent from payment/financial
  // status. Null when the domain row is active or has no cancellation
  // concept at all (e.g. event_guest).
  lifecycleLabel: string | null;
  // Runtime QA polish — true only for a cancelled parent Event
  // (event_participant/event_guest). Withholds the Record Payment action
  // (list row + PaymentDetailSheet) without touching amount_due_cents/
  // amount_paid_cents/status — Unpaid/Partially Paid remains visible as
  // historical financial truth, and Refund (for an already-Paid payment)
  // is completely unaffected by this flag. Always false for every other
  // domain in this pass.
  recordPaymentBlocked: boolean;
  // Phase 34E-B — how much of this payment's ONLINE (Stripe) money is
  // still refundable. Never derived from state.current_amount_paid_cents,
  // which nets manual money in too (locked decision 1).
  refundableCents: number;
  // Phase 34E-C — the most recent Stripe dispute for this payment, if
  // any. INFORMATIONAL ONLY — never derived from or fed back into
  // state/refundableCents. Admin/Staff-only data (page.tsx never fetches
  // this for a Member/Pro-facing surface).
  dispute: AdminPaymentDispute | null;
  // True when ANY dispute on this payment currently reports Stripe's own
  // is_charge_refundable = false — used only to hide the Refund action so
  // it never misleadingly offers a call that Stripe would reject; Stripe
  // itself remains authoritative for any race after page render.
  disputeBlocksRefund: boolean;
  // Phase 38B Task 3 — the current pending Staff refund request for this
  // payment, if any (null when none exists). Drives the mutual-exclusivity
  // between Staff's "Request Refund", Admin's direct "Refund", and Admin's
  // "Review" — at most one of the three is ever available for a given
  // payment. Never reserves money on its own; the live refundableCents
  // above remains the authoritative current-refundable source.
  pendingRefundRequest: StaffRefundRequestSummary | null;
  // Phase 34G-C1 — reversal-aware compact collection-source summary
  // ("Stripe" / "Manual · Cash" / "Manual · Multiple" / "Mixed"), derived
  // server-side from payment_events (never from payment_mode_at_creation
  // or amount_paid_cents alone — see src/lib/paymentProvenance.ts). Null
  // when there is no effective (non-reversed) collection event yet —
  // renders no badge, never a fabricated default.
  sourceSummary: string | null;
  state: PaymentStateRow;
  sortKey: string;
}

const DOMAIN_LABEL: Record<AdminPaymentRow["domainType"], string> = {
  reservation:        "Court Reservation",
  lesson_request:     "Lesson",
  event_participant:  "Event",
  event_guest:        "Event (Guest)",
  program_enrollment: "Program",
};

// Admin Cleanup Checkpoint 6 — Target Payments IA: Overview / Outstanding /
// Payment Activity. "Outstanding" and "Payment Activity" are the exact
// same two views this component already had (previously named via a
// `Filter` type: "outstanding" | "all" — "all" is renamed "activity" here,
// with byte-identical filtering behavior, never rebuilt). "Overview" is
// new: Admin-only financial analytics, never shown to Staff (who keep
// their existing Outstanding/Payment Activity access unchanged).
type Tab = "overview" | "outstanding" | "activity";

export default function AdminPaymentsClient({
  rows, clubId, currency, clubTimezone, truncated, isAdmin, isStaff, refundRequestReadFailed, initialFinancialOverview,
}: {
  rows: AdminPaymentRow[];
  clubId: string;
  currency: string;
  clubTimezone: string;
  // G-D1 — true when the server query hit page.tsx's own MAX_ROWS cap
  // (interactive-list-only; the cap itself is unchanged this checkpoint).
  // Never implies data was deleted — only that older payments aren't
  // shown in THIS list; Export remains the complete, uncapped source.
  truncated?: boolean;
  // G-D1 QA correction — server-derived (page.tsx's own isAdmin(profile.
  // role), the same predicate the rest of the app uses for Admin-only
  // authority). UI-only: gates whether the Refund action is ever
  // RENDERED, here and in PaymentDetailSheet. The real authorization
  // boundary remains createOnlineRefundAction's own server-side
  // `profile.role !== "admin"` check (refundActions.ts), unchanged and
  // untouched by this — hiding the button never substitutes for it.
  // Admin Cleanup Checkpoint 6 — ALSO now gates whether the Overview tab
  // is ever rendered at all (never merely hidden by CSS): Staff passes
  // the page's isOperator gate but must never see financial analytics.
  // The real boundary is still server-side — get_financial_range_summary
  // itself raises 'insufficient_role' for a non-admin caller, and
  // getFinancialOverviewAction independently re-checks role === "admin"
  // before ever calling it.
  isAdmin: boolean;
  // Correction pass — the EXPLICIT Staff capability (page.tsx's own
  // isStaff(profile.role)), never derived here as !isAdmin. Gates Staff's
  // "Request Refund" action (list row + PaymentDetailSheet) so it renders
  // for the actual product rule ("Staff may request refunds"), not as an
  // accident of this page's route-level isOperator gate excluding every
  // other role. Backend authorization (create_refund_request's own
  // current_user_role() = 'staff' check, 0181) remains unchanged and is
  // the real boundary — this is UI visibility only.
  isStaff: boolean;
  // Correction pass — true when page.tsx's batched fetchPendingRefundRequests
  // read failed, meaning pending-request state for every row on this page
  // is UNKNOWN rather than "none." Fails closed: suppresses Staff Request
  // Refund, Admin direct Refund, and Admin Review everywhere (their mutual
  // exclusivity depends entirely on knowing pendingRefundRequest per row) —
  // never falls through to treating an unknown state as "no request."
  refundRequestReadFailed: boolean;
  // Server-rendered Overview figures for the default range (7d), or null
  // when isAdmin is false (never fetched for Staff) or the initial fetch
  // failed. The Overview panel's own range switch refetches via
  // getFinancialOverviewAction — this prop only seeds the first render.
  initialFinancialOverview: FinancialOverviewResult | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [tab, setTab] = useState<Tab>(isAdmin ? "overview" : "outstanding");
  const [query, setQuery]   = useState("");
  const [recordTarget, setRecordTarget] = useState<AdminPaymentRow | null>(null);
  const [refundTarget, setRefundTarget] = useState<AdminPaymentRow | null>(null);
  const [detailTarget, setDetailTarget] = useState<AdminPaymentRow | null>(null);
  // Phase 38B Task 3 — Staff's Request Refund sheet and Admin's Review
  // sheet, each its own target state exactly like refundTarget/recordTarget
  // above, so at most one sheet is ever mounted at a time.
  const [requestRefundTarget, setRequestRefundTarget] = useState<AdminPaymentRow | null>(null);
  const [reviewTarget, setReviewTarget] = useState<AdminPaymentRow | null>(null);

  // Correction pass — fail-closed derivation: Request Refund/Refund/
  // Review all depend on correctly knowing row.pendingRefundRequest, so
  // ALL THREE are suppressed together whenever that read failed, rather
  // than falling through to "assume no pending request."
  const refundActionsAvailable = !refundRequestReadFailed;

  // Phase 38B notification polish — ?refundRequest=<request id> deep link,
  // following the SAME ?lessonId= auto-open pattern LessonsTab.tsx already
  // uses (Phase 30G/36): match against `rows` (already the caller's own
  // RLS/RPC-scoped list, so an unrelated club's request id simply finds no
  // match — never an independent lookup), fire once per distinct value via
  // the ref, and strip the param afterward so re-visiting the same URL or
  // clicking the same notification again can re-open it. Authorization:
  // the match against `rows` PLUS the isAdmin gate below are the only
  // checks — a resolved/rejected/missing request, or a non-Admin viewer,
  // both fall through to "load normally," never a crash or stale state.
  //
  // Correction pass — while refundRequestReadFailed is true,
  // row.pendingRefundRequest is UNKNOWN for every row (fail-closed, see
  // refundActionsAvailable above), not "none." "No match" must therefore
  // NEVER be treated as "resolved/missing" here: the request may still
  // genuinely exist, we simply failed to load pending-request state. In
  // that case this effect does nothing at all — no auto-open, no
  // clearRefundRequestParam, no ref write — so the URL param survives
  // untouched and the SAME deep link can still auto-open correctly once
  // the user refreshes and the read succeeds.
  const refundRequestParam = searchParams.get("refundRequest");
  const autoOpenReviewAttemptRef = useRef<string | null>(null);

  function clearRefundRequestParam() {
    autoOpenReviewAttemptRef.current = null;
    const params = new URLSearchParams(searchParams.toString());
    if (!params.has("refundRequest")) return;
    params.delete("refundRequest");
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  useEffect(() => {
    if (!refundRequestParam) return;
    if (autoOpenReviewAttemptRef.current === refundRequestParam) return;
    // Fail closed: never mark this param "attempted," never clear it,
    // never open Review — pendingRefundRequest state is untrustworthy
    // while the batched read failed. Retried automatically (this effect
    // re-runs) once refundRequestReadFailed flips back to false.
    if (refundRequestReadFailed) return;
    autoOpenReviewAttemptRef.current = refundRequestParam;

    const match = rows.find(r => r.pendingRefundRequest?.requestId === refundRequestParam);
    if (!match || !isAdmin) {
      clearRefundRequestParam();
      return;
    }

    setReviewTarget(match);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refundRequestParam, rows, isAdmin, refundRequestReadFailed]);

  const [financialOverview, setFinancialOverview] = useState(initialFinancialOverview);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [isOverviewPending, startOverviewTransition] = useTransition();

  function handleRangeChange(range: ReportRange) {
    setOverviewError(null);
    startOverviewTransition(async () => {
      const result = await getFinancialOverviewAction(range);
      if (result.error || !result.data) {
        setOverviewError(result.error ?? "Financial summary could not be loaded.");
      } else {
        setFinancialOverview(result.data);
      }
    });
  }

  const filtered = useMemo(() => {
    // Locked semantics (runtime QA correction) — Outstanding means
    // "balances the member still owes": unpaid/partially_paid only. A
    // fully paid, Stripe-refundable transaction belongs on Payment
    // Activity, never Outstanding — Refund remains reachable there via
    // row.refundableCents
    // (see the Refund button's own, separate render condition below).
    let list = tab === "outstanding" ? rows.filter(r => isPaymentOpenForRecording(r.state)) : rows;
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter(r =>
        r.identityName.toLowerCase().includes(q) || r.title.toLowerCase().includes(q)
      );
    }
    return list;
  }, [rows, tab, query]);

  return (
    <div className="px-4 pb-8 pt-4">
      {tab === "overview" ? (
        <p className="text-xs text-gray-400 dark:text-gray-500 mb-4">
          Money collected, refunded, and still owed — sourced from your club&apos;s payment ledger.
        </p>
      ) : (
        <p className="text-xs text-gray-400 dark:text-gray-500 mb-4">
          Who owes money, what for, and how much — reflects current payment state only.
          Not a revenue report or transaction ledger.
        </p>
      )}

      {/* Admin IA — tab strip gets its own full-width row (equal-width
          grid cells), matching the approved tab-strip treatment used
          elsewhere in this app (Courts/Lessons/Communications). Overview
          is only ever rendered for isAdmin — never merely hidden by CSS,
          simply absent from the DOM for Staff, matching the real
          server-side authorization boundary (get_financial_range_summary
          itself is Admin-only). */}
      <div className={`grid ${isAdmin ? "grid-cols-3" : "grid-cols-2"} gap-1 p-1 bg-gray-100 dark:bg-gray-800 rounded-xl mb-4`}>
        {isAdmin && (
          <button
            onClick={() => setTab("overview")}
            className={tabClass(tab === "overview")}
          >
            Overview
          </button>
        )}
        <button
          onClick={() => setTab("outstanding")}
          className={tabClass(tab === "outstanding")}
        >
          Outstanding
        </button>
        <button
          onClick={() => setTab("activity")}
          className={tabClass(tab === "activity")}
        >
          Payment Activity
        </button>
      </div>

      {tab === "overview" ? (
        <FinancialOverviewPanel
          overview={financialOverview}
          error={overviewError}
          isPending={isOverviewPending}
          currency={currency}
          onRangeChange={handleRangeChange}
        />
      ) : (
        <>
          <div className="flex flex-col sm:flex-row gap-2 mb-4">
            <input
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search by name…"
              className="w-full sm:flex-1 ct-input text-base md:text-sm"
            />
            <PaymentExportMenu clubId={clubId} clubTimezone={clubTimezone} />
          </div>

          {truncated && (
            <p className="text-xs text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 mb-4">
              Showing the 500 most recent payments. Use Export for complete payment history.
            </p>
          )}

          {/* Correction pass — fail-closed notice: shown whenever the
              batched pending-refund-request read failed server-side.
              Everything else on this page (financial state, Record
              Payment, Details) is unaffected — only the three refund
              actions whose mutual exclusivity depends on this data are
              suppressed. */}
          {refundRequestReadFailed && (
            <p className="text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-900 rounded-lg px-3 py-2 mb-4">
              Refund actions unavailable. Refresh and try again.
            </p>
          )}

          {filtered.length === 0 ? (
            <p className="text-sm text-gray-400 dark:text-gray-500 py-12 text-center">
              {tab === "outstanding" ? "No outstanding balances." : "No payments to show."}
            </p>
          ) : (
            <div className="space-y-2">
              {filtered.map(row => (
            <div key={row.key} className="ct-card px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <Link href={row.href} className="min-w-0 flex-1 hover:opacity-75 motion-safe:transition-opacity motion-safe:duration-100">
                  <p className="text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wide">
                    {DOMAIN_LABEL[row.domainType]}
                  </p>
                  <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 mt-0.5 truncate">
                    {row.identityName}
                  </p>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 truncate">
                    {row.title}
                    {row.dateLabel ? ` · ${row.dateLabel}` : ""}
                  </p>
                </Link>
              </div>
              {row.dispute && (
                <DisputeBadge dispute={row.dispute} />
              )}
              <div className="mt-2 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  {/* Phase 34E-E — domain lifecycle (e.g. "Booking
                      Cancelled") is always its own, visually distinct
                      pill, never merged into the financial-status badge. */}
                  {row.lifecycleLabel && (
                    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${toneClassName("neutral")}`}>
                      {row.lifecycleLabel}
                    </span>
                  )}
                  <PaymentStateBadge state={row.state} />
                  {/* Phase 34G-C1 — collection-source provenance, kept
                      deliberately neutral/informational: never Court Time
                      brand green, never Stripe-readiness green. This
                      answers "was this Stripe or manual," not a
                      success/commercial state. */}
                  {row.sourceSummary && (
                    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${toneClassName("neutral")}`}>
                      {row.sourceSummary}
                    </span>
                  )}
                  {/* Phase 38B Task 3 — shown to BOTH roles whenever a
                      Staff refund request is pending, independent of
                      isAdmin. This is what makes "Refund requested" and
                      the direct Refund button mutually exclusive below.
                      Phase 41B: amber ("warning" tone) — a pending refund
                      is an attention-required state Admin should be able
                      to scan for, distinct from an error (red) and from
                      the plain informational neutral pills around it. */}
                  {row.pendingRefundRequest && (
                    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${toneClassName("warning")}`}>
                      Refund requested
                    </span>
                  )}
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => setDetailTarget(row)}
                    className="px-3 py-2 rounded-lg text-xs font-semibold text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 motion-safe:transition-colors motion-safe:duration-100"
                  >
                    Details
                  </button>
                  {/* Correction pass — mutual exclusivity: at most ONE of
                      Staff "Request Refund" / Admin "Refund" / Admin
                      "Review" is ever rendered for a given payment. Each
                      is ALSO gated on refundActionsAvailable — if the
                      batched pending-request read failed, all three are
                      suppressed together (fail closed), never assumed
                      absent. isStaff is the EXPLICIT capability gate for
                      Request Refund — never !isAdmin. */}
                  {isStaff && refundActionsAvailable && !row.pendingRefundRequest && isOnlineRefundEligible(row.refundableCents) && !row.disputeBlocksRefund && (
                    <button
                      onClick={() => setRequestRefundTarget(row)}
                      className="px-3 py-2 rounded-lg text-xs font-semibold text-red-600 dark:text-red-400 border border-red-200 dark:border-red-900 hover:bg-red-50 dark:hover:bg-red-900/20 motion-safe:transition-colors motion-safe:duration-100"
                    >
                      Request Refund
                    </button>
                  )}
                  {isAdmin && refundActionsAvailable && !row.pendingRefundRequest && isOnlineRefundEligible(row.refundableCents) && !row.disputeBlocksRefund && (
                    <button
                      onClick={() => setRefundTarget(row)}
                      className="px-3 py-2 rounded-lg text-xs font-semibold text-red-600 dark:text-red-400 border border-red-200 dark:border-red-900 hover:bg-red-50 dark:hover:bg-red-900/20 motion-safe:transition-colors motion-safe:duration-100"
                    >
                      Refund
                    </button>
                  )}
                  {isAdmin && refundActionsAvailable && row.pendingRefundRequest && (
                    <button
                      onClick={() => setReviewTarget(row)}
                      className="px-3 py-2 rounded-lg text-xs font-semibold text-red-600 dark:text-red-400 border border-red-200 dark:border-red-900 hover:bg-red-50 dark:hover:bg-red-900/20 motion-safe:transition-colors motion-safe:duration-100"
                    >
                      Review
                    </button>
                  )}
                  {isPaymentOpenForRecording(row.state) && !row.recordPaymentBlocked && (
                    <button
                      onClick={() => setRecordTarget(row)}
                      className={ACTION_BUTTON_PRIMARY_COMPACT_TOUCH}
                    >
                      Record Payment
                    </button>
                  )}
                </div>
              </div>
            </div>
              ))}
            </div>
          )}
        </>
      )}

      {recordTarget && (
        <RecordPaymentSheet
          paymentId={recordTarget.state.current_payment_id}
          clubId={clubId}
          amountDueCents={recordTarget.state.current_amount_due_cents}
          amountPaidCents={recordTarget.state.current_amount_paid_cents}
          currency={recordTarget.state.current_currency || currency}
          title={recordTarget.identityName}
          onClose={() => setRecordTarget(null)}
          onRecorded={() => { setRecordTarget(null); router.refresh(); }}
        />
      )}

      {refundTarget && (
        <RefundPaymentSheet
          paymentId={refundTarget.state.current_payment_id}
          clubId={clubId}
          refundableCents={refundTarget.refundableCents}
          currency={refundTarget.state.current_currency || currency}
          title={refundTarget.identityName}
          onClose={() => setRefundTarget(null)}
          onRefunded={() => { setRefundTarget(null); router.refresh(); }}
        />
      )}

      {requestRefundTarget && (
        <RequestRefundSheet
          paymentId={requestRefundTarget.state.current_payment_id}
          clubId={clubId}
          refundableCents={requestRefundTarget.refundableCents}
          currency={requestRefundTarget.state.current_currency || currency}
          title={requestRefundTarget.identityName}
          onClose={() => setRequestRefundTarget(null)}
          onRequested={() => { setRequestRefundTarget(null); router.refresh(); }}
        />
      )}

      {reviewTarget && reviewTarget.pendingRefundRequest && (
        <ReviewRefundRequestSheet
          request={reviewTarget.pendingRefundRequest}
          clubId={clubId}
          currentRefundableCents={reviewTarget.refundableCents}
          currency={reviewTarget.state.current_currency || currency}
          title={reviewTarget.identityName}
          onClose={() => setReviewTarget(null)}
          onResolved={() => { setReviewTarget(null); router.refresh(); }}
        />
      )}

      {detailTarget && (
        <PaymentDetailSheet
          row={detailTarget}
          clubId={clubId}
          currency={currency}
          clubTimezone={clubTimezone}
          isAdmin={isAdmin}
          isStaff={isStaff}
          refundActionsAvailable={refundActionsAvailable}
          onClose={() => setDetailTarget(null)}
          // Detail is read-only — any actual mutation hands off to the
          // SAME existing 34E-B/34C sheets (plus the two new Phase 38B
          // sheets), closing Detail first so only one sheet is ever open
          // at a time. onRequestRefund (Admin direct refund) and
          // onRequestRefundRequest (Staff request) are deliberately
          // distinct callbacks — never conflated.
          onRequestRefund={() => { setRefundTarget(detailTarget); setDetailTarget(null); }}
          onRequestRefundRequest={() => { setRequestRefundTarget(detailTarget); setDetailTarget(null); }}
          onReviewRefundRequest={() => { setReviewTarget(detailTarget); setDetailTarget(null); }}
          onRequestRecordPayment={() => { setRecordTarget(detailTarget); setDetailTarget(null); }}
        />
      )}
    </div>
  );
}

// Admin Cleanup Checkpoint 6 — shared per-cell style for the 2/3-cell tab
// strip above, mirroring the approved Courts/Communications tab treatment
// (flex items-center justify-center text-center leading-tight) so a
// wrapped "Payment Activity" label at narrow widths stays centered and no
// taller than its row requires.
function tabClass(active: boolean): string {
  return `flex items-center justify-center text-center leading-tight py-1.5 rounded-lg text-xs font-medium motion-safe:transition-colors motion-safe:duration-100 ${
    active
      ? "bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm"
      : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
  }`;
}

// Admin Cleanup Checkpoint 6 — Financial Overview. Selected-range Collected/
// Refunded/Net collected (locked relationship: Net = Collected - Refunded,
// enforced once in financialSummary.ts, never re-derived here) plus a
// clearly-labeled current-snapshot Outstanding total, plus — only when the
// authoritative layer actually returned domain activity for the range — a
// compact Net collected by domain breakdown. Deliberately no chart: a
// meaningful trend visualization would need daily-bucketed figures this
// RPC does not return (it returns one range-wide aggregate, not a daily
// series) — adding that is out of this checkpoint's scope, and a chart
// with no real underlying series would be decorative, not truthful.
function FinancialOverviewPanel({
  overview, error, isPending, currency, onRangeChange,
}: {
  overview: FinancialOverviewResult | null;
  error: string | null;
  isPending: boolean;
  currency: string;
  onRangeChange: (range: ReportRange) => void;
}) {
  const rangeLinks: { key: ReportRange; label: string }[] = [
    { key: "today", label: "Today" },
    { key: "7d", label: "7 days" },
    { key: "30d", label: "30 days" },
  ];

  return (
    <div className="space-y-4">
      <div className="ct-card flex divide-x divide-gray-100 dark:divide-gray-800 overflow-hidden">
        {rangeLinks.map(r => (
          <button
            key={r.key}
            type="button"
            onClick={() => onRangeChange(r.key)}
            disabled={isPending}
            className={`flex-1 flex items-center justify-center text-center leading-tight px-2 py-2 text-xs font-medium motion-safe:transition-colors motion-safe:duration-100 disabled:opacity-50 ${
              overview?.range === r.key
                ? "bg-accent text-white"
                : "text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800/50"
            }`}
          >
            {r.label}
          </button>
        ))}
      </div>

      {error ? (
        <p className="text-sm text-orange-500 dark:text-orange-400 px-1">{error}</p>
      ) : !overview ? (
        <p className="text-sm text-gray-400 dark:text-gray-500 py-12 text-center">
          Financial summary unavailable.
        </p>
      ) : (
        <>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-2">
              Selected range
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <OverviewStat label="Collected" value={formatMoney(overview.summary.collectedCents, currency)} />
              <OverviewStat label="Refunded" value={formatMoney(overview.summary.refundedCents, currency)} />
              <OverviewStat label="Net collected" value={formatMoney(overview.summary.netCollectedCents, currency)} emphasize />
            </div>
          </div>

          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-2">
              Current snapshot
            </p>
            <OverviewStat label="Outstanding" value={formatMoney(overview.outstandingCents, currency)} fullWidth />
          </div>

          {overview.summary.domainBreakdown.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-2">
                Net collected by domain · Selected range
              </p>
              <div className="grid grid-cols-2 lg:grid-cols-3 gap-2">
                {overview.summary.domainBreakdown.map(d => (
                  <OverviewStat
                    key={d.domain}
                    label={FINANCIAL_DOMAIN_LABEL[d.domain] ?? d.domain}
                    value={formatMoney(d.netCollectedCents, currency)}
                  />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function OverviewStat({
  label, value, emphasize, fullWidth,
}: {
  label: string;
  value: string;
  emphasize?: boolean;
  fullWidth?: boolean;
}) {
  return (
    <div className={`ct-card px-3 py-3 text-center ${fullWidth ? "w-full" : ""}`}>
      <p className={`font-bold text-gray-900 dark:text-gray-100 ${emphasize ? "text-lg" : "text-base"}`}>{value}</p>
      <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-0.5 leading-tight">{label}</p>
    </div>
  );
}

// Phase 34E-C — compact, informational-only dispute line. Court Time
// never submits evidence or manages the dispute here; the club uses
// Stripe directly for that (locked scope). Kept deliberately minimal —
// broad payment-status visual polish is 34G-C.
function DisputeBadge({ dispute }: { dispute: AdminPaymentDispute }) {
  const presentation = presentDisputeStatus(dispute.status);
  return (
    <p
      className={`mt-2 inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${disputeToneClassName(presentation.tone)}`}
    >
      {presentation.label} · {formatMoney(dispute.amountCents, dispute.currency)} · {formatDisputeReason(dispute.reason)}
    </p>
  );
}
