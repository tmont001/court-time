import { formatMoney } from "@/lib/money";

// Peak/Off-Peak Pricing — Checkpoint C. Reservation-specific price
// preview display, shared by the booking-create sheet (CalendarShell) and
// the booking-edit sheet (EditReservationSheet). Deliberately NOT built on
// the shared cross-domain PriceSummary component (src/components/
// PriceSummary.tsx, also used by Lessons/Events/Programs) — this
// checkpoint is reservations-only, and the required NULL-price copy here
// ("No court fee" / "No court fee configured", see below) differs from
// PriceSummary's own generic "No price set" (and PriceSummary hides NULL
// entirely for a Member viewer, which this component deliberately does
// NOT do), both of which must stay unchanged for those other domains.
//
// This component performs NO pricing logic — every value it renders
// (totalCents, hourlyRateCents, sourceLabel) is either passed straight
// through from preview_court_reservation_price's own response or, for the
// edit surface's duration-only case, the reservation's own already-
// snapshotted hourly_rate_cents re-multiplied by the proposed duration
// (never a freshly resolved rate). It never queries court_rate_periods,
// never classifies Member vs Non-Member, and never decides which source
// "won" — reservationPriceSourceLabel (src/lib/calendar/
// reservationPriceSourceLabel.ts) only relabels an already-resolved
// source for display.

export type ReservationPricePreviewStatus = "idle" | "loading" | "ready" | "error";

interface Props {
  status:          ReservationPricePreviewStatus;
  totalCents:      number | null;
  hourlyRateCents: number | null;
  sourceLabel:     string | null;
  currency:        string;
  // Locked NULL-price contract (corrected after Checkpoint C review): a
  // NULL total always renders a truthful, neutral message — never an
  // empty/hidden render — for BOTH viewers. Only the WORDING differs:
  // Member sees the concise "No court fee", operator sees the more
  // explicit "No court fee configured" (matching the Admin/Staff context
  // of actually configuring that fee). This deliberately diverges from
  // PriceSummary's own Member-hides-null convention (Phase 34B) — that
  // component is unchanged and untouched; this one's own contract is
  // reservations-specific and locked separately. Loading/error are
  // likewise shown to both viewers, unaffected by this distinction.
  viewer:          "member" | "operator";
  className?:      string;
}

export default function ReservationPricePreview({
  status, totalCents, hourlyRateCents, sourceLabel, currency, viewer, className,
}: Props) {
  if (status === "idle") return null;

  if (status === "loading") {
    return (
      <div className={className}>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
          Price
        </p>
        <p className="text-sm text-gray-400 dark:text-gray-500">Checking price…</p>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className={className}>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
          Price
        </p>
        <p className="text-sm text-gray-400 dark:text-gray-500">Price unavailable right now.</p>
      </div>
    );
  }

  // status === "ready"
  if (totalCents === null) {
    return (
      <div className={className}>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
          Price
        </p>
        <p className="text-sm text-gray-400 dark:text-gray-500">
          {viewer === "member" ? "No court fee" : "No court fee configured"}
        </p>
      </div>
    );
  }

  const breakdown =
    sourceLabel && hourlyRateCents !== null
      ? `${sourceLabel} · ${formatMoney(hourlyRateCents, currency)}/hr`
      : null;

  return (
    <div className={className}>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
        Price
      </p>
      <p className="text-lg font-bold text-gray-900 dark:text-gray-100 leading-tight">
        {totalCents === 0 ? "Free" : formatMoney(totalCents, currency)}
      </p>
      {breakdown && (
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{breakdown}</p>
      )}
    </div>
  );
}
