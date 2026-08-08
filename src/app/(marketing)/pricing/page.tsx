import type { Metadata } from "next";
import MarketingReveal from "../components/MarketingReveal";
import PricingCards from "./PricingCards";
import ComparisonTable from "./ComparisonTable";

export const metadata: Metadata = {
  title: "Pricing — Court Time",
  description:
    "Court Time's Founding Club pricing for pilot clubs: $149/month or $1,490/year, with guided onboarding and direct founder support. Pilot scope and commercial terms are discussed with each club.",
  alternates: { canonical: "/pricing" },
  openGraph: {
    title: "Pricing — Court Time",
    description:
      "Court Time's Founding Club pricing for pilot clubs: $149/month or $1,490/year, with guided onboarding and direct founder support.",
    url: "/pricing",
  },
};

const FAQ = [
  {
    q: "Is there a per-member fee?",
    a: "No. Your monthly or annual fee covers your entire club regardless of member count.",
  },
  {
    q: "What does onboarding involve?",
    a: "We configure your club together — courts, operating hours, event types, and member settings. No technical work required from your team.",
  },
  {
    q: "When does billing start?",
    a: "Not before we agree on terms together. No charges apply during the founding evaluation and onboarding period without your agreement.",
  },
  {
    q: "How does annual pricing work?",
    a: "Paying annually is equivalent to two months free compared to paying monthly.",
  },
  {
    q: "Can I cancel?",
    a: "Yes. Cancellation terms are outlined in your agreement, agreed before any charges begin.",
  },
  {
    q: "What happens after I request a pilot?",
    a: "We'll set up a conversation to learn about your club. If it's a fit, we'll walk through onboarding together — reaching out isn't a commitment.",
  },
];

export default function PricingPage() {
  return (
    <div className="px-4 py-16">

      {/* Header */}
      <MarketingReveal className="text-center mb-12 max-w-xl mx-auto">
        <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100 mb-3">
          Simple, transparent pricing.
        </h1>
        <p className="text-base text-gray-600 dark:text-gray-300">
          One plan for pilot clubs today. No per-member fees, no self-service
          checkout — everything is arranged directly with our team.
        </p>
      </MarketingReveal>

      {/* Plan cards */}
      <MarketingReveal className="max-w-5xl mx-auto mb-6">
        <PricingCards />
      </MarketingReveal>

      <MarketingReveal className="text-center mb-4">
        <a
          href="#compare"
          className="text-sm underline underline-offset-2 text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 motion-safe:transition-colors motion-safe:duration-150"
        >
          Compare all features
        </a>
      </MarketingReveal>

      {/* Disclosure */}
      <MarketingReveal className="max-w-2xl mx-auto mb-16">
        <div className="rounded-lg bg-gray-50 dark:bg-gray-800/50 border border-gray-100 dark:border-gray-700 px-4 py-3 text-center">
          <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
            Starter and Club are planned standard packages and are not
            currently available for purchase. Final packaging may evolve
            before public launch. There is no self-service checkout —
            every plan is arranged directly with our team.
          </p>
        </div>
      </MarketingReveal>

      {/* Comparison table */}
      <section id="compare" tabIndex={-1} className="max-w-5xl mx-auto mb-16 scroll-mt-20 outline-none">
        <MarketingReveal>
          <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100 text-center mb-6">
            Compare all features
          </h2>
          <ComparisonTable />
        </MarketingReveal>
      </section>

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
