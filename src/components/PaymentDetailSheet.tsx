"use client";

// Phase 34E-E — the operator-facing payment-detail surface. Answers,
// using canonical financial data only (payments/payment_events, never
// inferred from UI state): what the charge was for, current booking
// lifecycle state, current obligation, net amount retained, amount
// refunded, overpayment when applicable, payment status, dispute state,
// why the payment may need review, and what safe action is available.
//
// Deliberately read-only + a handoff to the EXISTING 34E-B/34C sheets for
// any mutation (Refund / Record Payment) — this component never calls a
// mutating RPC/Server Action itself, and never rewrites financial history.

import { useEffect, useState } from "react";
import ResponsiveSheet from "@/components/ResponsiveSheet";
import PaymentStateBadge from "@/components/PaymentStateBadge";
import { formatMoney } from "@/lib/money";
import {
  isPaymentOpenForRecording,
  computeOverpaidCents,
  formatPaymentEventLabel,
  toneClassName,
} from "@/lib/payments";
import { isOnlineRefundEligible } from "@/lib/stripe/refundConfig";
import { presentDisputeStatus, disputeToneClassName, formatDisputeReason } from "@/lib/stripe/disputeConfig";
import { fetchPaymentEventHistory, type PaymentEventHistoryItem } from "@/app/(app)/admin/payments/actions";
import { formatHistoryTimestamp } from "@/app/(app)/admin/payments/paymentContext";
import type { AdminPaymentRow } from "@/app/(app)/admin/payments/AdminPaymentsClient";

// Refund/refund-adjacent events net AGAINST net retained the exact same
// way _recompute_payment_rollup's own v_net does (0143/0150/0153/0157) —
// mirrored here for DISPLAY only, read-only, never fed back into any
// mutation or stored value.
const REFUND_EVENT_TYPES = new Set(["refund_recorded", "online_refund_recorded"]);

export default function PaymentDetailSheet({
  row, clubId, currency, clubTimezone, onClose, onRequestRefund, onRequestRecordPayment,
}: {
  row: AdminPaymentRow;
  clubId: string;
  currency: string;
  clubTimezone: string;
  onClose: () => void;
  onRequestRefund: () => void;
  onRequestRecordPayment: () => void;
}) {
  const [history, setHistory] = useState<PaymentEventHistoryItem[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchPaymentEventHistory(row.state.current_payment_id, clubId).then(({ data, error }) => {
      if (cancelled) return;
      if (error) setHistoryError(error);
      else setHistory(data ?? []);
    });
    return () => { cancelled = true; };
  }, [row.state.current_payment_id, clubId]);

  const resolvedCurrency = row.state.current_currency || currency;
  const overpaidCents = computeOverpaidCents(row.state);
  // External review correction — refundedCents must never be silently
  // coerced to 0 while history is still loading or failed to load. A
  // fabricated "Refunded $0.00" is a false financial fact, so the three
  // states (loading / error / loaded) are kept explicit all the way
  // through to display.
  const refundedDisplay = historyError
    ? "Unavailable"
    : history === null
      ? "Loading…"
      : formatMoney(
          // Non-reversed refund events only — mirrors the rollup's own
          // reversal exclusion (payment_events where id not in
          // reverses_event_id targets).
          history
            .filter(e => REFUND_EVENT_TYPES.has(e.eventType) && !e.isReversed)
            .reduce((sum, e) => sum + (e.amountCents ?? 0), 0),
          resolvedCurrency,
        );

  const canRefund = isOnlineRefundEligible(row.refundableCents) && !row.disputeBlocksRefund;
  // Runtime QA polish — a cancelled parent Event withholds Record Payment
  // eligibility without touching row.state at all (no waive/void/refund,
  // no amount_due_cents/amount_paid_cents mutation) — the balance stays
  // visible above as historical financial truth. Refund (canRefund, above)
  // is completely independent of this flag.
  const canRecordPayment = isPaymentOpenForRecording(row.state) && !row.recordPaymentBlocked;

  // Goal 5 — a "why review" block only when there is actually something
  // to explain: overpaid, a cancelled/declined/withdrawn domain lifecycle,
  // or an active dispute. Otherwise omitted entirely — no noise for the
  // ordinary case.
  const reviewNotes: string[] = [];
  if (row.state.current_status === "overpaid") {
    reviewNotes.push(
      `Collected ${formatMoney(row.state.current_amount_paid_cents, resolvedCurrency)} against a current obligation of ` +
      `${formatMoney(row.state.current_amount_due_cents, resolvedCurrency)} — ` +
      `${formatMoney(overpaidCents, resolvedCurrency)} more than owed. Court Time never refunds this automatically.`,
    );
    reviewNotes.push(
      canRefund
        ? "Refund is available for the Stripe-collected portion, if appropriate."
        : "No Stripe-refundable balance currently remains for this payment.",
    );
  }
  if (row.lifecycleLabel) {
    reviewNotes.push(
      `The related activity is currently "${row.lifecycleLabel}". This lifecycle state does not automatically refund, waive, or void the payment.`,
    );
  }
  if (row.dispute) {
    reviewNotes.push(
      "This payment has an active Stripe dispute. Disputes are informational only in Court Time — " +
      "they are never treated as a refund and never change the amount retained. Manage the dispute directly in Stripe.",
    );
  }
  if (row.recordPaymentBlocked && isPaymentOpenForRecording(row.state)) {
    reviewNotes.push(
      `${row.lifecycleLabel ?? "This booking was cancelled"}, so Record Payment is withheld here — the balance above remains ` +
      "historical truth and is never automatically waived or voided. Use Refund if money was already collected and should be returned.",
    );
  }

  return (
    <ResponsiveSheet
      onClose={onClose}
      variant="modal"
      mobileInteraction="draggable"
      label="Payment detail"
      header={<p className="text-base font-semibold text-gray-900 dark:text-gray-100">Payment Detail</p>}
    >
      <div className="space-y-5 pt-1 pb-2">
        {/* Who / what this charge was for */}
        <div>
          <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{row.identityName}</p>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            {row.title}
            {row.dateLabel ? ` · ${row.dateLabel}` : ""}
          </p>
        </div>

        {/* Lifecycle + financial status, kept visually distinct (two
            separate pills), never merged into one indistinguishable
            badge. */}
        <div className="flex flex-wrap items-center gap-2">
          {row.lifecycleLabel && (
            <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${toneClassName("neutral")}`}>
              {row.lifecycleLabel}
            </span>
          )}
          <PaymentStateBadge state={row.state} />
          {row.dispute && (
            <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${disputeToneClassName(presentDisputeStatus(row.dispute.status).tone)}`}>
              {presentDisputeStatus(row.dispute.status).label} · {formatMoney(row.dispute.amountCents, row.dispute.currency)} · {formatDisputeReason(row.dispute.reason)}
            </span>
          )}
        </div>

        {/* Canonical financial data — never inferred from UI state. */}
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-xl bg-gray-50 dark:bg-gray-800/60 p-3">
          <FinancialFact label="Current obligation" value={formatMoney(row.state.current_amount_due_cents, resolvedCurrency)} />
          <FinancialFact label="Net retained" value={formatMoney(row.state.current_amount_paid_cents, resolvedCurrency)} />
          <FinancialFact label="Refunded" value={refundedDisplay} />
          {overpaidCents > 0 && (
            <FinancialFact label="Overpaid" value={formatMoney(overpaidCents, resolvedCurrency)} />
          )}
        </div>

        {/* Goal 5 — why review, only when there is something to explain. */}
        {reviewNotes.length > 0 && (
          <div className="rounded-xl border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-900/20 p-3 space-y-1.5">
            {reviewNotes.map((note, i) => (
              <p key={i} className="text-xs text-amber-800 dark:text-amber-300">{note}</p>
            ))}
          </div>
        )}

        {/* Safe actions available — reuses the EXISTING 34E-B/34C sheets;
            this component never mutates anything itself. */}
        {(canRefund || canRecordPayment) && (
          <div className="flex gap-2">
            {canRefund && (
              <button
                onClick={onRequestRefund}
                className="flex-1 px-3 py-2.5 rounded-xl text-sm font-semibold text-red-600 dark:text-red-400 border border-red-200 dark:border-red-900 hover:bg-red-50 dark:hover:bg-red-900/20 motion-safe:transition-colors motion-safe:duration-100"
              >
                Refund
              </button>
            )}
            {canRecordPayment && (
              <button
                onClick={onRequestRecordPayment}
                className="flex-1 px-3 py-2.5 rounded-xl text-sm font-semibold bg-accent text-white dark:text-gray-900 hover:brightness-110 motion-safe:transition-all motion-safe:duration-100"
              >
                Record Payment
              </button>
            )}
          </div>
        )}

        {/* Financial history — chronological, read-only, never rewritten. */}
        <div>
          <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
            Financial History
          </p>
          {historyError && (
            <p className="text-xs text-red-500">{historyError}</p>
          )}
          {!historyError && history === null && (
            <p className="text-xs text-gray-400 dark:text-gray-500">Loading…</p>
          )}
          {!historyError && history !== null && history.length === 0 && (
            <p className="text-xs text-gray-400 dark:text-gray-500">No ledger events yet.</p>
          )}
          {!historyError && history !== null && history.length > 0 && (
            <ul className="space-y-2">
              {[...history].reverse().map(item => (
                <li key={item.id} className="flex items-start justify-between gap-3 text-xs">
                  <div className="min-w-0">
                    <p className="text-gray-700 dark:text-gray-300 font-medium">
                      {formatPaymentEventLabel(item.eventType)}
                      {item.isReversed && <span className="text-gray-400 dark:text-gray-500"> (reversed)</span>}
                    </p>
                    <p className="text-gray-400 dark:text-gray-500 mt-0.5">
                      {formatHistoryTimestamp(item.occurredAt, clubTimezone)}
                      {item.method ? ` · ${item.method.replace(/_/g, " ")}` : ""}
                    </p>
                  </div>
                  {item.amountCents !== null && (
                    <span className={`shrink-0 font-medium ${item.isReversed ? "text-gray-400 dark:text-gray-500 line-through" : "text-gray-700 dark:text-gray-300"}`}>
                      {formatMoney(item.amountCents, resolvedCurrency)}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </ResponsiveSheet>
  );
}

function FinancialFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wide">{label}</p>
      <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 mt-0.5">{value}</p>
    </div>
  );
}
