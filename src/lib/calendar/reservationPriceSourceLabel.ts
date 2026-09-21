// Peak/Off-Peak Pricing — Checkpoint C. Pure, presentation-only mapping
// from preview_court_reservation_price's applied_rate_source /
// applied_rate_period_name (0200/0201, canonical and authoritative) to a
// short, human-readable label for the booking price preview.
//
// This performs NO precedence decision of its own — it only relabels a
// value the server has already resolved. It must never invent, guess, or
// re-derive which source "won"; that stays exclusively server-side. Raw
// internal identifiers (e.g. "rate_period_non_member", "court_override_
// member", "club_default_non_member") must never reach the UI — every
// branch below returns either the server's own human period name or one
// of two fixed, generic labels.

export function reservationPriceSourceLabel(
  appliedRateSource: string | null | undefined,
  appliedRatePeriodName: string | null | undefined,
): string | null {
  // A named rate period always wins the label, regardless of which
  // membership-class variant of "rate_period_*" actually matched — the
  // Member/Non-Member distinction is a resolution detail, not something
  // this UI needs to surface (per the locked display contract).
  if (appliedRatePeriodName) return appliedRatePeriodName;

  if (!appliedRateSource) return null;

  if (appliedRateSource.startsWith("court_override")) return "Court rate";
  if (appliedRateSource.startsWith("club_default")) return "Standard rate";

  // "unpriced" (or any future/unrecognized source) has no meaningful
  // label — the caller is expected to be showing the NULL-price copy in
  // that case instead of a source line.
  return null;
}
