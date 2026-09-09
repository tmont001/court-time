import Link from "next/link";
import { STANDARD_TIERS, type StandardTier } from "./planData";

// Phase 34G-A2 — simplified from a 3-card horizontal-scroll rail (Founding
// Club / Starter / Club) to a plain 2-column grid: Staff-Managed and
// Connected are the only two standard, purchasable tiers now. Founding
// Club is rendered separately (FoundingOfferBanner) as a promotional offer,
// not a third card among equals — no rail/carousel machinery is needed for
// just two cards.

// Phase 34G-C3 — Connected gets a modest, restrained Court Time brand-green
// treatment (border + filled primary CTA) instead of the prior graphite/
// black-white "highlighted" emphasis — communicating "more capable"
// without a badge or loud promotional styling. Staff-Managed is completely
// untouched: neutral gray border, neutral outlined CTA — a legitimate,
// complete plan in its own right, never styled as inferior.
function TierCard({ tier, highlighted }: { tier: StandardTier; highlighted?: boolean }) {
  return (
    <div
      className={`h-full flex flex-col rounded-2xl bg-white dark:bg-gray-800 p-6 ${
        highlighted
          ? "border-2 border-brand shadow-xl"
          : "border border-gray-200 dark:border-gray-700"
      }`}
    >
      <h3 className="text-lg font-bold text-gray-900 dark:text-gray-100">{tier.name}</h3>
      <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{tier.tagline}</p>

      <p className="mt-4">
        <span className="text-3xl font-bold text-gray-900 dark:text-gray-100">{tier.monthly}</span>
        <span className="text-sm font-medium text-gray-500 dark:text-gray-400"> / month</span>
      </p>
      <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
        or <span className="font-semibold text-gray-700 dark:text-gray-300">{tier.annual} / year</span> — {tier.annualNote}
      </p>

      <p className="mt-4 pt-4 border-t border-gray-100 dark:border-gray-700 text-xs text-gray-500 dark:text-gray-400">
        No per-member fee
      </p>

      <Link
        href={tier.ctaHref}
        className={
          highlighted
            ? "mt-5 block w-full text-center py-3 rounded-xl text-sm font-semibold bg-brand text-white hover:bg-brand-hover motion-safe:transition-all motion-safe:duration-150"
            : "mt-5 block w-full text-center py-3 rounded-xl text-sm font-semibold border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:border-gray-500 dark:hover:border-gray-400 motion-safe:transition-all motion-safe:duration-150"
        }
      >
        {tier.ctaLabel}
      </Link>
    </div>
  );
}

export default function PricingCards() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      {STANDARD_TIERS.map((tier) => (
        <TierCard key={tier.id} tier={tier} highlighted={tier.id === "connected"} />
      ))}
    </div>
  );
}
