import Link from "next/link";
import type { Metadata } from "next";
import MarketingReveal from "../components/MarketingReveal";

export const metadata: Metadata = {
  title: "Pricing — Court Time",
  description:
    "Simple, transparent pricing for clubs. Founding club offer: $149/month or $1,490/year — two months free.",
};

const FOUNDING_FEATURES = [
  "Unlimited court bookings",
  "Event management with waitlists",
  "Full member roster, including no-account members",
  "Bulk member import from spreadsheet",
  "Admin dashboard with audit log",
  "Email and in-app notifications",
  "Mobile-friendly member experience",
  "Direct access to the Court Time team",
  "Early access to new features",
];

const FAQ = [
  {
    q: "Is there a per-member fee?",
    a: "No. Your monthly or annual fee covers your entire club regardless of member count.",
  },
  {
    q: "What does setup involve?",
    a: "We configure your club together — courts, operating hours, event types, and member settings. No technical work required from your team.",
  },
  {
    q: "When does billing start?",
    a: "Not during the founding period. We'll agree on billing terms before any charges apply.",
  },
  {
    q: "Can I cancel?",
    a: "Yes. We want clubs that want to be here. Cancellation terms will be outlined in your agreement.",
  },
];

export default function PricingPage() {
  return (
    <div className="max-w-4xl mx-auto px-4 py-16">

      {/* Header */}
      <MarketingReveal className="text-center mb-14">
        <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100 mb-3">
          Simple, transparent pricing.
        </h1>
        <p className="text-base text-gray-600 dark:text-gray-300 max-w-xl mx-auto">
          One plan. Everything included. No per-member fees.
        </p>
      </MarketingReveal>

      {/* Founding Club card */}
      <MarketingReveal className="mb-4 max-w-lg mx-auto">
        <div className="rounded-2xl border-2 border-gray-900 dark:border-gray-100 bg-white dark:bg-gray-800 p-8 hover:shadow-xl motion-safe:transition-shadow motion-safe:duration-300">

          {/* Header row */}
          <div className="flex items-start justify-between gap-4 mb-5">
            <div>
              <p className="text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-widest mb-1.5">
                Founding Club
              </p>
              <h2 className="text-4xl font-bold text-gray-900 dark:text-gray-100 leading-none">
                $149
                <span className="text-lg font-medium text-gray-500 dark:text-gray-400"> / month</span>
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1.5">
                or{" "}
                <span className="font-semibold text-gray-800 dark:text-gray-200">$1,490 / year</span>
                {" "}— two months free
              </p>
            </div>
            <span className="shrink-0 inline-block px-2.5 py-1 text-[10px] font-semibold bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 rounded-full mt-1">
              Limited availability
            </span>
          </div>

          {/* Founding period note */}
          <div className="rounded-lg bg-gray-50 dark:bg-gray-700/40 border border-gray-100 dark:border-gray-700 px-4 py-3 mb-6">
            <p className="text-xs text-gray-600 dark:text-gray-300 leading-relaxed">
              Founding Club pricing is available for the first 10 clubs or until
              public launch, whichever comes first. Founding clubs keep this price
              for their first 12 months.
            </p>
          </div>

          {/* Feature list */}
          <ul className="space-y-2.5 mb-8">
            {FOUNDING_FEATURES.map((f) => (
              <li
                key={f}
                className="flex items-start gap-2.5 text-sm text-gray-700 dark:text-gray-300"
              >
                <span className="mt-0.5 text-green-600 dark:text-green-400 shrink-0 font-bold">✓</span>
                {f}
              </li>
            ))}
          </ul>

          <Link
            href="/contact"
            className="block w-full text-center py-3 rounded-xl bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-semibold hover:bg-gray-700 dark:hover:bg-gray-300 active:scale-[0.98] motion-safe:transition-all motion-safe:duration-150"
          >
            Contact us to get started
          </Link>

          <p className="text-center text-xs text-gray-400 dark:text-gray-500 mt-4">
            No credit card required · Setup is free during the founding period
          </p>
        </div>
      </MarketingReveal>

      {/* Future standard plans */}
      <MarketingReveal delay="delay-1" className="max-w-lg mx-auto mb-14">
        <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 px-6 py-6 hover:border-gray-200 dark:hover:border-gray-600 hover:shadow-sm motion-safe:transition-all motion-safe:duration-200">
          <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-widest mb-5">
            Standard plans — after founding period
          </p>
          <div className="flex flex-col gap-5">

            {/* Starter */}
            <div className="group rounded-lg border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-4 hover:border-gray-200 dark:hover:border-gray-600 hover:shadow-sm motion-safe:transition-all motion-safe:duration-200">
              <div className="flex items-baseline justify-between gap-2 mb-1.5">
                <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">Starter</p>
                <div className="text-right shrink-0">
                  <span className="text-sm font-medium text-gray-700 dark:text-gray-300">$249 / month</span>
                  <span className="ml-2 text-xs text-gray-400 dark:text-gray-500">or $2,490 / yr</span>
                </div>
              </div>
              <p className="text-xs text-gray-400 dark:text-gray-500 leading-relaxed">
                For small clubs, HOAs, and community courts. Up to 5 courts and
                100 members. Simple booking, member access, and basic event
                sign-ups.
              </p>
            </div>

            {/* Club */}
            <div className="group rounded-lg border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-4 hover:border-gray-200 dark:hover:border-gray-600 hover:shadow-sm motion-safe:transition-all motion-safe:duration-200">
              <div className="flex items-baseline justify-between gap-2 mb-1.5">
                <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">Club</p>
                <div className="text-right shrink-0">
                  <span className="text-sm font-medium text-gray-700 dark:text-gray-300">$399 / month</span>
                  <span className="ml-2 text-xs text-gray-400 dark:text-gray-500">or $3,990 / yr</span>
                </div>
              </div>
              <p className="text-xs text-gray-400 dark:text-gray-500 leading-relaxed">
                For larger clubs with more operational needs. Up to 12 courts and
                300 members. Includes event rosters, waitlists, bulk imports, more
                admins and pros, and priority support.
              </p>
            </div>

          </div>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">
            Annual plans include two months free. Founding clubs are not affected by standard plan pricing during their first 12 months.
          </p>
        </div>
      </MarketingReveal>

      {/* FAQ */}
      <div className="max-w-lg mx-auto">
        <p className="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-widest mb-5">
          Common questions
        </p>
        <div className="space-y-3">
          {FAQ.map((item, i) => (
            <MarketingReveal key={item.q} delay={`delay-${(i % 3) + 1}` as "delay-1" | "delay-2" | "delay-3"}>
              <div className="rounded-xl border border-gray-100 dark:border-gray-700 px-5 py-4 hover:border-gray-200 dark:hover:border-gray-600 hover:shadow-sm motion-safe:transition-all motion-safe:duration-200">
                <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-1.5">{item.q}</p>
                <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed">{item.a}</p>
              </div>
            </MarketingReveal>
          ))}
        </div>
      </div>

    </div>
  );
}
