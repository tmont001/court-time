// PriceSummary — Phase 34B shared price-transparency pattern, used
// wherever a user is about to make or operate a commitment (court booking,
// Lesson request/edit, Event join/detail, Program enrollment/detail).
//
// Not a payment UI: never shows Paid/Unpaid, never implies a charge has
// been collected. It only answers "what does this cost" with clear visual
// hierarchy — a small label, a prominent total, and an optional secondary
// breakdown line (e.g. "$50.00/hour x 90 min").
//
// Display rules (locked, Phase 34B):
//   Member:              NULL -> render nothing. 0 -> "Free". >0 -> prominent.
//   Admin/Staff/Pro:      NULL -> "No price set" (muted, not prominent).
//                          0 -> "Free". >0 -> prominent.

import { formatMoney } from "@/lib/money";

interface Props {
  label:        string;
  amountCents:  number | null;
  currency:     string;
  viewer:       "member" | "operator";
  breakdown?:   string | null;
  className?:   string;
}

export default function PriceSummary({ label, amountCents, currency, viewer, breakdown, className }: Props) {
  if (amountCents === null) {
    if (viewer === "member") return null;
    return (
      <div className={className}>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
          {label}
        </p>
        <p className="text-sm text-gray-400 dark:text-gray-500">No price set</p>
      </div>
    );
  }

  return (
    <div className={className}>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
        {label}
      </p>
      <p className="text-lg font-bold text-gray-900 dark:text-gray-100 leading-tight">
        {amountCents === 0 ? "Free" : formatMoney(amountCents, currency)}
      </p>
      {breakdown && (
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{breakdown}</p>
      )}
    </div>
  );
}
