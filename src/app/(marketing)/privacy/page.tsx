import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy — Court Time",
  description:
    "How Court Time collects, uses, and protects data for club Members, Pros, Admins, and prospective clubs submitting a pilot inquiry.",
  alternates: { canonical: "/privacy" },
};

export default function PrivacyPage() {
  return (
    <div className="max-w-2xl mx-auto px-4 py-16">
      <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100 mb-2">
        Privacy Policy
      </h1>
      <p className="text-xs text-gray-400 dark:text-gray-500 mb-10">
        Last updated: August 8, 2026
      </p>

      <div className="space-y-8 text-sm text-gray-600 dark:text-gray-300 leading-relaxed">

        <section>
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">
            Overview
          </h2>
          <p>
            Court Time is scheduling and member management software for tennis
            clubs. This Privacy Policy explains what information we collect, how
            we use it, and your rights regarding your data.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">
            What Data We Collect
          </h2>
          <p className="mb-2">
            We collect and store the following types of information:
          </p>
          <ul className="space-y-1.5 list-none">
            <li>· <span className="font-medium text-gray-700 dark:text-gray-200">Account information:</span> name, email address, and password (hashed) for members who create accounts.</li>
            <li>· <span className="font-medium text-gray-700 dark:text-gray-200">Contact information:</span> phone numbers, where provided.</li>
            <li>· <span className="font-medium text-gray-700 dark:text-gray-200">Roster data:</span> member names and contact information entered by club administrators, including for members who have not created an account.</li>
            <li>· <span className="font-medium text-gray-700 dark:text-gray-200">Activity data:</span> court bookings, event and program registrations, lesson requests, and cancellations.</li>
            <li>· <span className="font-medium text-gray-700 dark:text-gray-200">Notification preferences:</span> your chosen delivery methods, including email and, if you opt in, SMS text alerts for supported updates.</li>
            <li>· <span className="font-medium text-gray-700 dark:text-gray-200">Admin notes:</span> internal notes added by club administrators about members.</li>
            <li>· <span className="font-medium text-gray-700 dark:text-gray-200">Technical and security data:</span> limited request metadata or derived identifiers — such as a one-way hash used to detect duplicate or abusive submissions — that we process to help prevent abuse and protect the security of the Service. For pilot inquiries submitted through our Contact page, we do not store your raw IP address.</li>
          </ul>
        </section>

        <section>
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">
            Why We Collect This Data
          </h2>
          <p>
            We use data to provide and operate Court Time, support club
            administration and product functionality, send service-related
            communications, provide customer support, and respond to and
            evaluate pilot inquiries. We also use limited data to help
            prevent abuse and protect the security and integrity of the
            Service. We do not sell your data, use it for advertising, or
            share it with third parties for marketing purposes.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">
            Who Can Access Your Data
          </h2>
          <ul className="space-y-1.5 list-none">
            <li>· <span className="font-medium text-gray-700 dark:text-gray-200">Club members</span> can see their own account information and their own bookings, event registrations, and lesson requests.</li>
            <li>· <span className="font-medium text-gray-700 dark:text-gray-200">Pros</span> can see lesson requests and details for lessons assigned to them.</li>
            <li>· <span className="font-medium text-gray-700 dark:text-gray-200">Club administrators</span> can see member roster information, booking activity, event rosters, and lesson activity for their club.</li>
            <li>· <span className="font-medium text-gray-700 dark:text-gray-200">Court Time operators</span> may access data as needed to provide support, investigate issues, and operate the Service.</li>
          </ul>
        </section>

        <section>
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">
            Pilot Inquiries
          </h2>
          <p className="mb-2">
            If you submit a pilot request through our Contact page, we
            collect the information you provide, which may include your
            contact name, work email, optional phone number, club or
            facility name, facility type, court count, approximate number
            of Members or regular users, optional website, your current
            scheduling or operations process, operational challenges, your
            preferred operating model, and any additional details you
            choose to share.
          </p>
          <p>
            We use this information to evaluate and respond to pilot
            inquiries, discuss onboarding and whether Court Time is a good
            fit for your club, and communicate with you about your
            requested pilot. Pilot inquiry information is accessible only
            to the Court Time team — it is not visible to any club
            administrator or shared with any club. It is not used for any
            other purpose, and is not linked to a Court Time club account
            unless you separately become a pilot club.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">
            Service Providers
          </h2>
          <p>
            We use service providers to help operate Court Time, including
            for infrastructure and hosting, authentication and data
            storage, email delivery, and, where enabled, SMS delivery.
            These providers process information only as needed to provide
            their services to us, in connection with operating the
            Service.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">
            Data Storage and Security
          </h2>
          <p>
            Data is stored using Supabase, a managed database platform,
            with safeguards designed to protect your information —
            including access controls, row-level security policies, and
            encrypted connections. No method of storage or transmission is
            completely secure, and we cannot guarantee absolute security.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">
            Email and SMS Notifications
          </h2>
          <p>
            We send transactional emails related to your use of the Service —
            such as booking confirmations, event updates, lesson requests, and
            waitlist offers. If you opt in and provide a phone number, we may
            also send SMS text alerts for supported updates. You can manage
            your email and SMS notification preferences in your account
            settings, including opting out of text alerts at any time. We do
            not send marketing emails or texts without your consent.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">
            Data Deletion Requests
          </h2>
          <p>
            To request deletion of your account and associated personal data,
            contact us at{" "}
            <a
              href="mailto:hello@court-time.app"
              className="underline underline-offset-2 hover:text-gray-900 dark:hover:text-gray-100 motion-safe:transition-colors"
            >
              hello@court-time.app
            </a>
            . For members whose data was added by a club administrator without
            an account, deletion requests can also be submitted by the club
            admin or by contacting us directly. The same address handles
            deletion requests for pilot inquiry information.
          </p>
          <p className="mt-2">
            Some information may be retained for a limited time after a
            deletion request where reasonably necessary for security, legal
            compliance, resolving disputes, or maintaining the integrity of
            the Service.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">
            Changes to This Policy
          </h2>
          <p>
            We may update this Privacy Policy as the Service evolves. We will
            post any changes on this page with a new &ldquo;Last updated&rdquo; date.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">
            Contact
          </h2>
          <p>
            Privacy questions or requests can be directed to{" "}
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
