import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms of Service — Court Time",
  description:
    "The terms governing use of Court Time's club operations software during its early access / pilot phase.",
  alternates: { canonical: "/terms" },
};

export default function TermsPage() {
  return (
    <div className="max-w-2xl mx-auto px-4 py-16">
      <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100 mb-2">
        Terms of Service
      </h1>
      <p className="text-xs text-gray-400 dark:text-gray-500 mb-10">
        Last updated: July 7, 2026
      </p>

      <div className="space-y-8 text-sm text-gray-600 dark:text-gray-300 leading-relaxed">

        <section>
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">
            1. Acceptance of Terms
          </h2>
          <p>
            By accessing or using Court Time (&ldquo;the Service&rdquo;), you agree to
            be bound by these Terms of Service. If you are accessing the Service
            on behalf of a tennis club or organization, you represent that you
            have authority to bind that organization to these terms.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">
            2. Early Access and Pilot Status
          </h2>
          <p>
            Court Time is currently in an early access / pilot phase. The Service
            is provided as-is and may change significantly as we develop it. We
            will communicate material changes to active clubs in advance when
            possible.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">
            3. Club Responsibility for Member Data
          </h2>
          <p>
            Clubs are responsible for the accuracy of the member information they
            enter into the Service, including names, email addresses, phone
            numbers, and roster records. Clubs should obtain appropriate consent
            from their members before adding their information to the Service.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">
            4. Acceptable Use
          </h2>
          <p>
            The Service is intended for tennis club operations. You agree not to
            use the Service for any unlawful purpose, to harm others, or in any
            way that violates applicable laws or regulations. Access to the
            Service is limited to authorized members of clubs that have an active
            arrangement with Court Time.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">
            5. Billing and Pricing
          </h2>
          <p>
            During the founding club and early access period, specific billing
            terms are agreed between Court Time and each club individually. No
            charges will be applied without advance notice and mutual agreement.
            Pricing and billing terms may change before a general paid launch.
            Active clubs will be given reasonable notice of any such changes.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">
            6. Limitation of Liability
          </h2>
          <p>
            Court Time is not liable for missed bookings, scheduling conflicts,
            or any disputes between club members or between a club and its
            members that arise from use of the Service. The Service is a
            scheduling and communication tool; enforcement of club rules and
            policies remains the responsibility of the club.
          </p>
          <p className="mt-2">
            To the fullest extent permitted by applicable law, Court Time&apos;s
            liability for any claim arising out of or related to the Service is
            limited to the amount paid by the club in the three months preceding
            the claim.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">
            7. Service Availability
          </h2>
          <p>
            We aim to keep the Service available and reliable, but we do not
            guarantee uninterrupted availability. We are not responsible for
            losses arising from downtime, maintenance, or technical issues beyond
            our reasonable control.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">
            8. Changes to These Terms
          </h2>
          <p>
            We may update these Terms from time to time. We will post the updated
            Terms on this page with a new &ldquo;Last updated&rdquo; date. Continued use of
            the Service after changes take effect constitutes acceptance of the
            revised Terms.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">
            9. Contact
          </h2>
          <p>
            For questions about these Terms, contact us at{" "}
            <a
              href="mailto:hello@court-time.app"
              className="underline underline-offset-2 hover:text-gray-900 dark:hover:text-gray-100 motion-safe:transition-colors"
            >
              hello@court-time.app
            </a>
            .
          </p>
        </section>

      </div>
    </div>
  );
}
