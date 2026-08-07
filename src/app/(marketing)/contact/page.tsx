import Link from "next/link";
import type { Metadata } from "next";
import MarketingReveal from "../components/MarketingReveal";

export const metadata: Metadata = {
  title: "Request a Pilot — Court Time",
  description:
    "Request a pilot for your tennis club. Tell us about your club and we'll be in touch to talk through onboarding.",
};

export default function ContactPage() {
  return (
    <div className="max-w-2xl mx-auto px-4 py-16">

      <MarketingReveal>
        <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100 mb-3">
          Request a pilot.
        </h1>
        <p className="text-base text-gray-600 dark:text-gray-300 leading-relaxed mb-10">
          We're personally onboarding each pilot club. There's no sales funnel —
          just a conversation. Tell us a bit about your club and we'll take it
          from there.
        </p>
      </MarketingReveal>

      {/* What to include */}
      <MarketingReveal delay="delay-1" className="mb-8">
        <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 px-5 py-5 hover:border-gray-200 dark:hover:border-gray-600 motion-safe:transition-colors motion-safe:duration-200">
          <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-widest mb-3">
            Helpful to include
          </p>
          <ul className="space-y-1.5 text-sm text-gray-600 dark:text-gray-300">
            <li>· Your club or facility name</li>
            <li>· Number of courts</li>
            <li>· Approximate membership size</li>
            <li>· How you currently handle bookings and events (email, texts, spreadsheets)</li>
            <li>· Your biggest operational challenge right now</li>
            <li>· The best way to reach you</li>
          </ul>
        </div>
      </MarketingReveal>

      {/* Primary CTA */}
      <MarketingReveal delay="delay-1" className="mb-10">
        <div className="rounded-xl border-2 border-gray-900 dark:border-gray-100 bg-white dark:bg-gray-800 px-6 py-6 hover:shadow-lg motion-safe:transition-shadow motion-safe:duration-200">
          <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-1">
            Email us directly
          </p>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
            We read and respond to every message.
          </p>
          <a
            href="mailto:hello@court-time.app"
            className="inline-block px-5 py-2.5 rounded-xl bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-semibold hover:bg-gray-700 dark:hover:bg-gray-300 active:scale-[0.98] motion-safe:transition-all motion-safe:duration-150"
          >
            hello@court-time.app
          </a>
        </div>
      </MarketingReveal>

      {/* Features / pricing reference */}
      <MarketingReveal>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Not sure yet?{" "}
          <Link
            href="/features"
            className="underline underline-offset-2 hover:text-gray-700 dark:hover:text-gray-200 motion-safe:transition-colors motion-safe:duration-150"
          >
            See what Court Time helps you manage
          </Link>
          {" "}or{" "}
          <Link
            href="/pricing"
            className="underline underline-offset-2 hover:text-gray-700 dark:hover:text-gray-200 motion-safe:transition-colors motion-safe:duration-150"
          >
            check the Founding Club pricing →
          </Link>
        </p>
      </MarketingReveal>

    </div>
  );
}
