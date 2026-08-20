import type { Metadata } from "next";
import MarketingReveal from "../components/MarketingReveal";
import PilotInquiryForm from "./PilotInquiryForm";

export const metadata: Metadata = {
  title: "Request a Pilot — Court Time",
  description:
    "Request a pilot for your tennis club. Tell us about your club and preferred operating model, and we'll be in touch to talk through onboarding.",
  alternates: { canonical: "/contact" },
  openGraph: {
    title: "Request a Pilot — Court Time",
    description:
      "Request a pilot for your tennis club. Tell us about your club and preferred operating model, and we'll be in touch to talk through onboarding.",
    url: "/contact",
  },
};

export default function ContactPage() {
  return (
    <div className="max-w-2xl mx-auto px-4 py-16">

      <MarketingReveal>
        <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100 mb-3">
          Request a pilot.
        </h1>
        <p className="text-base text-gray-600 dark:text-gray-300 leading-relaxed mb-2">
          We&apos;re personally reviewing each pilot request. Submitting starts a
          conversation and is not a commitment. Tell us about your club and
          how you would like Court Time to fit into its day-to-day
          operations.
        </p>
        <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed mb-10">
          Court Time supports clubs with different operational models —
          from fully staff-managed to Member self-service. Let us know what
          fits your club so we can talk through the right approach.
        </p>
      </MarketingReveal>

      <MarketingReveal delay="delay-1">
        <PilotInquiryForm />
      </MarketingReveal>

      {/* Secondary fallback */}
      <MarketingReveal delay="delay-2" className="mt-10">
        <div className="rounded-xl border border-gray-100 dark:border-gray-700 px-5 py-4 text-center">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Prefer email?{" "}
            <a
              href="mailto:hello@court-time.app"
              className="underline underline-offset-2 hover:text-gray-700 dark:hover:text-gray-200 motion-safe:transition-colors motion-safe:duration-150"
            >
              hello@court-time.app
            </a>
          </p>
        </div>
      </MarketingReveal>

    </div>
  );
}
