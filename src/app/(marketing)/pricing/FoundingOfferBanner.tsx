import Link from "next/link";
import { FOUNDING_OFFER } from "./planData";

// Phase 34G-A2 — Founding Club is a temporary promotional OFFER on top of
// the Connected tier (+ Court Time Payments included), not a third
// permanent tier — rendered as its own visually distinct, prominently
// highlighted banner above the standard Staff-Managed/Connected cards,
// never as a third card among equals.

export default function FoundingOfferBanner() {
  const offer = FOUNDING_OFFER;
  return (
    <div className="rounded-2xl border-2 border-gray-900 dark:border-gray-100 bg-gray-900 dark:bg-gray-100 p-6 sm:p-8">
      <span className="inline-block px-2.5 py-1 rounded-full text-[10px] font-semibold uppercase tracking-wide bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 mb-4">
        {offer.badgeLabel}
      </span>

      <div className="sm:flex sm:items-end sm:justify-between sm:gap-6">
        <div>
          <h2 className="text-xl font-bold text-white dark:text-gray-900">{offer.name}</h2>
          <p className="text-sm text-gray-300 dark:text-gray-600 mt-1 max-w-md">
            {offer.includesLabel} — priced at the Staff-Managed rate for our founding cohort.
          </p>
        </div>

        <p className="mt-4 sm:mt-0 shrink-0">
          <span className="text-3xl font-bold text-white dark:text-gray-900">{offer.monthly}</span>
          <span className="text-sm font-medium text-gray-400 dark:text-gray-500"> / month</span>
        </p>
      </div>

      <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
        or <span className="font-semibold text-gray-200 dark:text-gray-700">{offer.annual} / year</span> — {offer.annualNote}
      </p>

      <div className="mt-4 pt-4 border-t border-gray-700 dark:border-gray-300 grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs text-gray-300 dark:text-gray-600">
        <p><span className="text-white dark:text-gray-900 font-medium">Price protection:</span> {offer.priceProtection}</p>
        <p><span className="text-white dark:text-gray-900 font-medium">Onboarding:</span> {offer.onboarding}</p>
        <p><span className="text-white dark:text-gray-900 font-medium">Support:</span> {offer.support}</p>
      </div>

      <p className="mt-4 text-xs text-gray-400 dark:text-gray-500">{offer.availabilityNote}</p>

      <Link
        href={offer.ctaHref}
        className="mt-5 block w-full sm:w-auto sm:inline-block text-center px-6 py-3 rounded-xl text-sm font-semibold bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800 motion-safe:transition-colors motion-safe:duration-150"
      >
        {offer.ctaLabel}
      </Link>

      <p className="mt-3 text-[11px] text-gray-400 dark:text-gray-500 leading-relaxed">
        {offer.extraNotes.join(" · ")}
      </p>
    </div>
  );
}
