// Phase 34B — shared money-formatting helpers. Amounts are always integer
// minor currency units (cents) — never floating point. NULL = no price
// configured (nothing to charge, informational absence); 0 = explicitly
// free. These are two distinct states — never collapse them.

export function formatMoney(amountCents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(amountCents / 100);
}

// Operator-facing (Admin/Staff/Pro): NULL -> "No price set", 0 -> "Free".
export function formatOperatorPrice(amountCents: number | null, currency: string): string {
  if (amountCents === null) return "No price set";
  if (amountCents === 0) return "Free";
  return formatMoney(amountCents, currency);
}

// Member-facing: NULL -> null (caller hides the price entirely, never
// shows a placeholder that could be misread as "payment required"),
// 0 -> "Free".
export function formatMemberPrice(amountCents: number | null, currency: string): string | null {
  if (amountCents === null) return null;
  if (amountCents === 0) return "Free";
  return formatMoney(amountCents, currency);
}

// Phase 34B (final lesson pricing refinement): a Lesson Type's configured
// amount is either a flat total for the whole Lesson, or an hourly rate —
// never per-participant. Operator-facing unit-price display, e.g.
// "No price set", "Free", "$50.00", or "$100.00/hour".
export function formatLessonUnitPrice(
  pricingBasis: "flat" | "hourly",
  unitPriceAmountCents: number | null,
  currency: string,
): string {
  if (unitPriceAmountCents === null) return "No price set";
  if (unitPriceAmountCents === 0) return "Free";
  const amount = formatMoney(unitPriceAmountCents, currency);
  return pricingBasis === "hourly" ? `${amount}/hour` : amount;
}

// Calculates a Lesson's total price from its Lesson Type's pricing_basis +
// unit price and the Lesson's own duration — mirrors the SQL-side
// round(unit_price_amount_cents * duration_minutes / 60) formula exactly,
// so the client-side estimate a Member/Staff/Admin sees before submitting
// always matches what the server actually snapshots. Returns null when no
// unit price is configured, whichever basis.
export function calculateLessonTotalCents(
  pricingBasis: "flat" | "hourly",
  unitPriceAmountCents: number | null,
  durationMinutes: number,
): number | null {
  if (unitPriceAmountCents === null) return null;
  if (pricingBasis === "flat") return unitPriceAmountCents;
  return Math.round((unitPriceAmountCents * durationMinutes) / 60);
}
