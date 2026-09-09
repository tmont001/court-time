import type { Metadata } from "next";
import Link from "next/link";
import MarketingReveal from "../components/MarketingReveal";
import PricingCards from "./PricingCards";
import FoundingOfferBanner from "./FoundingOfferBanner";
import ComparisonTable from "./ComparisonTable";

export const metadata: Metadata = {
  title: "Pricing — Court Time",
  description:
    "Court Time's standard plans: Staff-Managed at $149/month or $1,490/year, and Connected (adds Member self-service) at $199/month or $1,990/year. Founding Club pilot clubs get Connected plus Court Time Payments at the Staff-Managed rate.",
  alternates: { canonical: "/pricing" },
  openGraph: {
    title: "Pricing — Court Time",
    description:
      "Staff-Managed and Connected — two standard plans, no per-member fee. Founding Club pilot clubs get Connected plus Court Time Payments at the Staff-Managed rate.",
    url: "/pricing",
  },
};

const FAQ = [
  {
    q: "What's the difference between Staff-Managed and Connected?",
    a: "Staff-Managed covers everything your staff needs to run the club — scheduling, Events, Programs, Lessons, roster, reporting, and payment tracking — without Member accounts. Connected adds Member self-service on top: accounts, court self-booking, Event signup and waitlists, Program enrollment, Lesson requests, and self-service schedule/cancellation.",
  },
  {
    q: "Is Court Time Payments included?",
    a: "Court Time Payments (online Member Pay Now through Stripe) is an optional add-on available with Connected — it's not a plan by itself. Founding Club includes it at no additional charge during the founding/early-access period. Standard add-on pricing will be announced before general launch. Manual payment tracking and Record Payment are part of both standard plans and are never paywalled behind Court Time Payments.",
  },
  {
    q: "Is there a per-member fee?",
    a: "No. Your monthly or annual fee covers your entire club regardless of member count, on either plan.",
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
    a: "Paying annually is equivalent to two months free compared to paying monthly, on either plan.",
  },
  {
    q: "Can I cancel?",
    a: "Yes. Cancellation terms are outlined in your agreement, agreed before any charges begin.",
  },
  {
    q: "What happens after I request a pilot?",
    a: "We'll set up a conversation to learn about your club. If it's a fit, we'll walk through onboarding together — reaching out isn't a commitment.",
  },
  {
    q: "What about multi-location clubs or larger organizations?",
    a: "Contact us to talk through your club or network directly — larger and multi-location setups are handled individually rather than through a fixed plan.",
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
          Two standard plans — Staff-Managed and Connected. No per-member
          fees, no self-service checkout — every plan is arranged directly
          with our team.
        </p>
      </MarketingReveal>

      {/* Founding Club — promotional offer, not a third plan */}
      <MarketingReveal className="max-w-3xl mx-auto mb-10">
        <FoundingOfferBanner />
      </MarketingReveal>

      {/* Standard plan cards */}
      <MarketingReveal className="max-w-3xl mx-auto mb-6">
        <p className="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-widest text-center mb-4">
          Standard plans
        </p>
        <PricingCards />
      </MarketingReveal>

      <MarketingReveal className="text-center mb-4">
        <a
          href="#compare"
          className="text-sm underline underline-offset-2 text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 motion-safe:transition-colors motion-safe:duration-150"
        >
          Compare Staff-Managed and Connected
        </a>
      </MarketingReveal>

      {/* Disclosure */}
      <MarketingReveal className="max-w-2xl mx-auto mb-16">
        <div className="rounded-lg bg-gray-50 dark:bg-gray-800/50 border border-gray-100 dark:border-gray-700 px-4 py-3 text-center">
          <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
            There is no self-service checkout — Staff-Managed and Connected
            are both arranged directly with our team. Founding Club is a
            temporary offer for pilot clubs, not a separate permanent plan.
          </p>
        </div>
      </MarketingReveal>

      {/* Comparison table */}
      <section id="compare" tabIndex={-1} className="max-w-5xl mx-auto mb-16 scroll-mt-20 outline-none">
        <MarketingReveal>
          <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100 text-center mb-6">
            Compare Staff-Managed and Connected
          </h2>
          <ComparisonTable />
        </MarketingReveal>
      </section>

      {/* Multi-location / enterprise — simple contact-sales message, no technical tier */}
      <MarketingReveal className="max-w-2xl mx-auto mb-16 text-center">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Running multiple locations or a larger club network?{" "}
          <Link href="/contact" className="underline underline-offset-2 text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100">
            Contact us
          </Link>{" "}
          to talk through your club.
        </p>
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
