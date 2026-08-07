import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy — Court Time",
};

export default function PrivacyPage() {
  return (
    <div className="max-w-2xl mx-auto px-4 py-16">
      <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100 mb-2">
        Privacy Policy
      </h1>
      <p className="text-xs text-gray-400 dark:text-gray-500 mb-10">
        Last updated: August 6, 2026
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
          </ul>
        </section>

        <section>
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">
            Why We Collect This Data
          </h2>
          <p>
            All data is collected solely to provide the Service: enabling court
            bookings, event management, member communication, and club
            administration. We do not sell your data, use it for advertising, or
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
            Data Storage and Security
          </h2>
          <p>
            Data is stored securely using Supabase, a managed database platform
            with industry-standard security practices. We implement access
            controls, row-level security policies, and encrypted connections to
            protect your data.
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
            admin or by contacting us directly.
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
