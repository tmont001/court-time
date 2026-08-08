import { redirect } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import MarketingReveal from './components/MarketingReveal';
import CourtScheduleVisual from './components/product-visuals/CourtScheduleVisual';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Court Time — Less chaos. More tennis.',
  description:
    'Club operations software for tennis clubs — court scheduling, events and programs, lesson coordination, member administration, and reporting in one system.',
  alternates: { canonical: '/' },
  openGraph: {
    title: 'Court Time — Less chaos. More tennis.',
    description:
      'Club operations software for tennis clubs — court scheduling, events and programs, lesson coordination, member administration, and reporting in one system.',
    url: '/',
  },
};

// ─── Feature data ─────────────────────────────────────────────────────────────

const FEATURES = [
  {
    title: 'Court Scheduling',
    label: 'Scheduling',
    description:
      'Members book courts in real time. Set operating hours, closures, and maintenance blocks, and edit or cancel reservations from the admin dashboard.',
  },
  {
    title: 'Events, Programs & Waitlists',
    label: 'Events',
    description:
      'Run clinics, leagues, socials, and recurring programs with rosters, capacity limits, and automatic waitlist offers.',
  },
  {
    title: 'Lessons & Pro Requests',
    label: 'Lessons',
    description:
      'Members request lessons; Pros propose times and confirm bookings. No more coordinating over text.',
  },
  {
    title: 'Member Directory & Onboarding',
    label: 'Members',
    description:
      "Keep your full roster, including members who haven't created an account yet. Invite by email or import from a spreadsheet.",
  },
  {
    title: 'Reporting & Oversight',
    label: 'Admin',
    description:
      'Court utilization, event participation, and cancellation trends, plus an audit log of admin activity — for every club you run.',
  },
  {
    title: 'Announcements & Alerts',
    label: 'Communication',
    description:
      'Email notifications and an in-app notification bell keep members in the loop, with optional text alerts for supported updates.',
  },
];

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function MarketingHomePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) redirect('/calendar');

  return (
    <>
      {/* ── Hero ──────────────────────────────────────────────────────────── */}
      <section className="px-4 pt-16 pb-12 md:pt-24 md:pb-20 max-w-7xl mx-auto">
        <div className="flex flex-col lg:flex-row items-center gap-12 lg:gap-16">
          {/* Text side */}
          <div className="flex-1 text-center lg:text-left max-w-xl mx-auto lg:mx-0">
            {/* Eyebrow */}
            <p className="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-widest mb-4">
              Club operations software
            </p>

            <h1 className="text-4xl md:text-5xl font-bold text-gray-900 dark:text-gray-100 leading-tight tracking-tight">
              Less chaos.
              <br />
              More tennis.
            </h1>

            <p className="mt-5 text-lg text-gray-600 dark:text-gray-300 leading-relaxed">
              Court Time gives your club one system for court scheduling,
              events and programs, lesson coordination, and club
              administration — without the group texts.
            </p>

            <p className="mt-3 text-sm text-gray-400 dark:text-gray-500">
              Built for Admins, Pros, and Members who need club operations
              to feel simple.
            </p>

            <div className="mt-8 flex flex-col sm:flex-row items-center justify-center lg:justify-start gap-3">
              <Link
                href="/contact"
                className="w-full sm:w-auto px-6 py-3 rounded-xl bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-semibold hover:bg-gray-700 dark:hover:bg-gray-300 motion-safe:transition-colors motion-safe:duration-150"
              >
                Request a pilot
              </Link>
              <Link
                href="/features"
                className="w-full sm:w-auto px-6 py-3 rounded-xl border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-700 dark:text-gray-300 hover:border-gray-400 dark:hover:border-gray-500 hover:text-gray-900 dark:hover:text-gray-100 motion-safe:transition-all motion-safe:duration-150"
              >
                Explore features →
              </Link>
            </div>
          </div>

          {/* Product preview — the same faithful calendar visual used on /features */}
          <div className="flex-1 w-full max-w-sm lg:max-w-none">
            <CourtScheduleVisual />
          </div>
        </div>
      </section>

      {/* ── Court line divider ─────────────────────────────────────────────── */}
      <div className="max-w-5xl mx-auto px-4">
        <div className="border-t-2 border-gray-100 dark:border-gray-800" />
        <div className="border-t border-gray-50 dark:border-gray-800/60 mt-1" />
      </div>

      {/* ── Pain / Problem ────────────────────────────────────────────────── */}
      <section className="px-4 py-12 bg-gray-50 dark:bg-gray-800/50">
        <MarketingReveal className="max-w-2xl mx-auto text-center">
          <p className="text-base text-gray-600 dark:text-gray-300 leading-relaxed">
            Managing courts by group text. Sending schedules by email. Finding
            out who showed up only after they left. If this sounds familiar,
            Court Time was built for you.
          </p>
        </MarketingReveal>
      </section>

      {/* ── Features ──────────────────────────────────────────────────────── */}
      <section className="px-4 py-16 max-w-5xl mx-auto">
        <MarketingReveal className="text-center mb-12">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            Everything your club needs
          </h2>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
            One tool for courts, events, and members.
          </p>
        </MarketingReveal>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          {FEATURES.map((f, i) => (
            <MarketingReveal
              key={f.title}
              delay={`delay-${(i % 2) + 1}` as 'delay-1' | 'delay-2'}
            >
              <div className="group h-full rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 px-5 py-5 relative overflow-hidden hover:border-gray-300 dark:hover:border-gray-600 hover:shadow-md motion-safe:transition-all motion-safe:duration-200">
                {/* Top accent line */}
                <div className="absolute top-0 left-0 right-0 h-0.5 bg-gray-900 dark:bg-gray-100 opacity-0 group-hover:opacity-100 motion-safe:transition-opacity motion-safe:duration-200" />
                <p className="text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-widest mb-2">
                  {f.label}
                </p>
                <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-1.5">
                  {f.title}
                </p>
                <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed">
                  {f.description}
                </p>
              </div>
            </MarketingReveal>
          ))}
        </div>
      </section>

      {/* ── Court line divider ─────────────────────────────────────────────── */}
      <div className="max-w-5xl mx-auto px-4">
        <div className="border-t-2 border-gray-100 dark:border-gray-800" />
        <div className="border-t border-gray-50 dark:border-gray-800/60 mt-1" />
      </div>

      {/* ── How it works ──────────────────────────────────────────────────── */}
      <section className="px-4 py-16 max-w-3xl mx-auto">
        <MarketingReveal>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 text-center mb-12">
            Guided setup, built around your club
          </h2>
        </MarketingReveal>
        <div className="flex flex-col gap-8">
          {[
            {
              step: '1',
              heading: 'We set up your club with you.',
              body: 'Courts, operating hours, event types, and member settings — configured together, with no technical work required from your team.',
            },
            {
              step: '2',
              heading: 'Your admin manages everything from one dashboard.',
              body: 'Bookings, events and programs, lesson requests, your full member directory, reporting, and announcements — all in one place.',
            },
            {
              step: '3',
              heading: 'Members and Pros use it from any device.',
              body: 'No app download. Members book courts, join events, and request lessons; Pros manage their own schedule — all from a browser.',
            },
          ].map((item, i) => (
            <MarketingReveal
              key={item.step}
              delay={`delay-${i + 1}` as 'delay-1' | 'delay-2' | 'delay-3'}
            >
              <div className="flex gap-5 items-start">
                <div className="shrink-0 flex flex-col items-center">
                  <div className="w-9 h-9 rounded-full bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 flex items-center justify-center text-xs font-bold">
                    {item.step}
                  </div>
                  {i < 2 && (
                    <div className="w-px flex-1 bg-gray-200 dark:bg-gray-700 mt-2 min-h-[2rem]" />
                  )}
                </div>
                <div className="pt-1 pb-4">
                  <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-1.5">
                    {item.heading}
                  </p>
                  <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed">
                    {item.body}
                  </p>
                </div>
              </div>
            </MarketingReveal>
          ))}
        </div>
      </section>

      {/* ── Differentiation ──────────────────────────────────────────────── */}
      <section className="px-4 py-16 max-w-4xl mx-auto">
        <MarketingReveal className="text-center mb-10">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            Focused on the workflows tennis clubs use every day.
          </h2>
        </MarketingReveal>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
          {[
            {
              title: 'Tennis-focused operations',
              body: 'Built around how tennis clubs actually run — court scheduling, events, and lessons in one system, not adapted from a general-purpose sports platform.',
            },
            {
              title: 'Guided onboarding',
              body: "We configure your club together, so you're not left to work through a complex setup alone.",
            },
            {
              title: 'Transparent pricing',
              body: 'One flat price for your whole club, published on our pricing page, with no per-member fee.',
            },
          ].map((point, i) => (
            <MarketingReveal
              key={point.title}
              delay={`delay-${i + 1}` as 'delay-1' | 'delay-2' | 'delay-3'}
            >
              <div className="h-full rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 px-5 py-5 text-center hover:border-gray-300 dark:hover:border-gray-600 hover:shadow-md motion-safe:transition-all motion-safe:duration-200">
                <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-1.5">
                  {point.title}
                </p>
                <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed">
                  {point.body}
                </p>
              </div>
            </MarketingReveal>
          ))}
        </div>
      </section>

      {/* ── Pilot CTA — dark treatment ────────────────────────────────────── */}
      <section className="bg-gray-900 dark:bg-gray-950">
        <div className="max-w-3xl mx-auto px-4 py-16 text-center">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-widest mb-4">
            Founding clubs
          </p>
          <h2 className="text-2xl font-bold text-white mb-3">
            Currently onboarding founding clubs.
          </h2>
          <p className="text-sm text-gray-400 leading-relaxed mb-2 max-w-lg mx-auto">
            We're working with a small number of clubs to shape the product.
            Founding clubs get protected pricing and direct access to the
            team while we build alongside real pilot use.
          </p>
          <p className="text-sm text-gray-500 mb-8">
            No credit card required during the founding evaluation and
            onboarding period.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <Link
              href="/contact"
              className="w-full sm:w-auto px-6 py-3 rounded-xl bg-white text-gray-900 text-sm font-semibold hover:bg-gray-100 motion-safe:transition-colors motion-safe:duration-150"
            >
              Request a pilot
            </Link>
            <Link
              href="/pricing"
              className="w-full sm:w-auto px-6 py-3 rounded-xl border border-gray-700 text-sm font-medium text-gray-300 hover:border-gray-500 hover:text-white motion-safe:transition-all motion-safe:duration-150"
            >
              See pricing →
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
