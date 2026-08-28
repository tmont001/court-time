"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import PaymentStateBadge from "@/components/PaymentStateBadge";
import RecordPaymentSheet from "@/components/RecordPaymentSheet";
import RefundPaymentSheet from "@/components/RefundPaymentSheet";
import { isPaymentOpenForRecording, type PaymentStateRow } from "@/lib/payments";
import { isOnlineRefundEligible } from "@/lib/stripe/refundConfig";
import { presentDisputeStatus, disputeToneClassName, formatDisputeReason } from "@/lib/stripe/disputeConfig";
import { formatMoney } from "@/lib/money";
import { ACTION_BUTTON_PRIMARY_COMPACT_TOUCH } from "@/lib/actionButtonStyles";

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

type Filter = "outstanding" | "all";

export default function AdminPaymentsClient({
  rows, clubId, currency,
}: {
  rows: AdminPaymentRow[];
  clubId: string;
  currency: string;
}) {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("outstanding");
  const [query, setQuery]   = useState("");
  const [recordTarget, setRecordTarget] = useState<AdminPaymentRow | null>(null);
  const [refundTarget, setRefundTarget] = useState<AdminPaymentRow | null>(null);

  const filtered = useMemo(() => {
    // Locked semantics (runtime QA correction) — Outstanding means
    // "balances the member still owes": unpaid/partially_paid only. A
    // fully paid, Stripe-refundable transaction belongs on All, never
    // Outstanding — Refund remains reachable there via row.refundableCents
    // (see the Refund button's own, separate render condition below).
    let list = filter === "outstanding" ? rows.filter(r => isPaymentOpenForRecording(r.state)) : rows;
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter(r =>
        r.identityName.toLowerCase().includes(q) || r.title.toLowerCase().includes(q)
      );
    }
    return list;
  }, [rows, filter, query]);

  return (
    <div className="px-4 pb-8 pt-4">
      <p className="text-xs text-gray-400 dark:text-gray-500 mb-4">
        Who owes money, what for, and how much — reflects current payment state only.
        Not a revenue report or transaction ledger.
      </p>

      <div className="flex flex-col sm:flex-row gap-2 mb-4">
        <div className="flex w-full sm:w-auto gap-1 bg-gray-100 dark:bg-gray-800 rounded-xl p-1">
          <button
            onClick={() => setFilter("outstanding")}
            className={`flex-1 sm:flex-none px-4 py-2 rounded-lg text-sm font-semibold motion-safe:transition-colors motion-safe:duration-100 ${
              filter === "outstanding"
                ? "bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 shadow-sm"
                : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
            }`}
          >
            Outstanding
          </button>
          <button
            onClick={() => setFilter("all")}
            className={`flex-1 sm:flex-none px-4 py-2 rounded-lg text-sm font-semibold motion-safe:transition-colors motion-safe:duration-100 ${
              filter === "all"
                ? "bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 shadow-sm"
                : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
            }`}
          >
            All
          </button>
        </div>
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search by name…"
          className="w-full sm:flex-1 ct-input text-base md:text-sm"
        />
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-gray-400 dark:text-gray-500 py-12 text-center">
          {filter === "outstanding" ? "No outstanding balances." : "No payments to show."}
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
                <PaymentStateBadge state={row.state} />
                <div className="flex gap-2">
                  {isOnlineRefundEligible(row.refundableCents) && !row.disputeBlocksRefund && (
                    <button
                      onClick={() => setRefundTarget(row)}
                      className="px-3 py-2 rounded-lg text-xs font-semibold text-red-600 dark:text-red-400 border border-red-200 dark:border-red-900 hover:bg-red-50 dark:hover:bg-red-900/20 motion-safe:transition-colors motion-safe:duration-100"
                    >
                      Refund
                    </button>
                  )}
                  {isPaymentOpenForRecording(row.state) && (
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
