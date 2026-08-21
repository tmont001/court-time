// Phase 34C — shared payment-state presentation helpers. Consumes the rows
// returned by get_payment_states_for_domains (the sanitized, batched read
// boundary — Member/Pro must never read payments/payment_events directly).
//
// A missing row (no payment ever created for a domain) is a distinct state
// from every payment status below — callers must render nothing for it,
// never fabricate "Unpaid".

import { formatMoney } from "@/lib/money";

export type PaymentStatus =
  | "unpaid"
  | "partially_paid"
  | "paid"
  | "overpaid"
  | "partially_refunded"
  | "refunded"
  | "waived"
  | "void";

export interface PaymentStateRow {
  domain_id: string;
  current_payment_id: string;
  current_obligation_cycle: number;
  current_amount_due_cents: number;
  current_amount_paid_cents: number;
  current_status: PaymentStatus;
  current_currency: string;
  unresolved_prior: {
    payment_id: string;
    obligation_cycle: number;
    amount_due_cents: number;
    amount_paid_cents: number;
    currency: string;
    status: string;
  }[];
}

export type PaymentStateTone = "neutral" | "warning" | "positive" | "info";

export interface PaymentStateLabel {
  text: string;
  tone: PaymentStateTone;
}

// Never returns a label for a missing row — the caller must render
// nothing in that case (no payment obligation exists at all, not "Unpaid").
export function formatPaymentStateLabel(
  row: PaymentStateRow | null | undefined,
): PaymentStateLabel | null {
  if (!row) return null;

  const due = row.current_amount_due_cents;
  const paid = row.current_amount_paid_cents;
  const currency = row.current_currency;

  // The neutral "adjusted to zero" case — technical status is still
  // 'unpaid' but nothing is actually owed. Checked before the status
  // switch so it takes priority over the generic "Unpaid" label.
  if (due === 0 && paid === 0) {
    return { text: "No balance due", tone: "neutral" };
  }

  switch (row.current_status) {
    case "unpaid":
      return { text: `Unpaid · ${formatMoney(due, currency)} due`, tone: "warning" };
    case "partially_paid":
      return {
        text: `Partially paid · ${formatMoney(paid, currency)} of ${formatMoney(due, currency)}`,
        tone: "warning",
      };
    case "paid":
      return { text: `Paid · ${formatMoney(paid, currency)}`, tone: "positive" };
    case "overpaid":
      return { text: `Overpaid by ${formatMoney(paid - due, currency)}`, tone: "info" };
    case "partially_refunded":
      // Never presented as new collectible debt — this is retained money
      // after a partial refund, not an outstanding balance.
      return {
        text: `Partially refunded · ${formatMoney(paid, currency)} retained`,
        tone: "neutral",
      };
    case "refunded":
      return { text: "Refunded", tone: "neutral" };
    case "waived":
      return { text: "Waived", tone: "neutral" };
    case "void":
      return { text: "Void", tone: "neutral" };
    default:
      return null;
  }
}

// Mirrors record_manual_payment's own guard exactly (status
// unpaid/partially_paid, positive due, due > paid) so the "Record
// Payment" action is never offered where the RPC would reject it anyway.
export function isPaymentOpenForRecording(row: PaymentStateRow | null | undefined): boolean {
  if (!row) return false;
  return (
    (row.current_status === "unpaid" || row.current_status === "partially_paid") &&
    row.current_amount_due_cents > 0 &&
    row.current_amount_due_cents > row.current_amount_paid_cents
  );
}

export const PAYMENT_METHOD_OPTIONS: { value: string; label: string }[] = [
  { value: "cash", label: "Cash" },
  { value: "check", label: "Check" },
  { value: "card_terminal", label: "Card terminal" },
  { value: "bank_transfer", label: "Bank transfer" },
  { value: "digital_wallet", label: "Digital wallet" },
  { value: "other", label: "Other" },
];

export function toneClassName(tone: PaymentStateTone): string {
  switch (tone) {
    case "warning":
      return "text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800";
    case "positive":
      return "text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800";
    case "info":
      return "text-blue-700 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800";
    case "neutral":
    default:
      return "text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700";
  }
}
