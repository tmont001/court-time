// Phase 34C — compact payment-state pill. Renders nothing when there is no
// payment row (never fabricates "Unpaid" for a domain that was never
// priced/tracked). Distinct from PriceSummary, which shows a configured
// price, never a payment status.

import { formatPaymentStateLabel, toneClassName, type PaymentStateRow } from "@/lib/payments";

export default function PaymentStateBadge({
  state,
  className = "",
}: {
  state: PaymentStateRow | null | undefined;
  className?: string;
}) {
  const label = formatPaymentStateLabel(state);
  if (!label) return null;

  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${toneClassName(label.tone)} ${className}`}
    >
      {label.text}
    </span>
  );
}
