import { redirect } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import MarketingReveal from './components/MarketingReveal';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Court Time — Less chaos. More tennis.',
  description:
    'Simple court booking and event roster software for clubs that need less chaos, fewer texts, and cleaner court management.',
};

// ─── Feature data ─────────────────────────────────────────────────────────────

const FEATURES = [
  {
    title: 'Court Booking',
    label: 'Scheduling',
    description:
      "Members book courts in seconds. You see the full picture — who's on which court, when, and for how long — in real time.",
  },
  {
    title: 'Event Rosters',
    label: 'Events',
    description:
      'Create clinics, leagues, and socials. Manage sign-ups, waitlists, and attendance without a single spreadsheet.',
  },
  {
    title: 'Member Roster',
    label: 'Members',
    description:
      "Keep your full club directory, even for members who haven't created an account yet. Invite them when they're ready.",
  },
  {
    title: 'Mobile-Friendly',
    label: 'Everywhere',
    description:
      'Works on any phone, no app download required. Simple enough for every generation of member.',
  },
];

// ─── Mock product preview ─────────────────────────────────────────────────────

const PREVIEW_COURTS = [
  {
    name: 'Court 1',
    status: 'Booking',
    member: 'J. Martinez · 9–10:30 AM',
    busy: true,
  },
  {
    name: 'Court 2',
    status: 'Clinic',
    member: 'Adult Clinic · 9–11 AM',
    busy: true,
  },
  { name: 'Court 3', status: 'Open', member: 'Available', busy: false },
];

const PREVIEW_EVENTS = [
  { title: 'Social Tennis', attending: 18, waitlisted: 3 },
  { title: 'Junior Clinic', attending: 12, waitlisted: 1 },
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
              Court Time gives your club a simple, modern system for booking
              courts, managing events, and keeping your roster organized —
              without the group texts.
            </p>

            <p className="mt-3 text-sm text-gray-400 dark:text-gray-500">
              Built for clubs, pros, and coordinators who need court operations
              to feel simple.
            </p>

            <div className="mt-8 flex flex-col sm:flex-row items-center justify-center lg:justify-start gap-3">
              <Link
                href="/contact"
                className="w-full sm:w-auto px-6 py-3 rounded-xl bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-semibold hover:bg-gray-700 dark:hover:bg-gray-300 motion-safe:transition-colors motion-safe:duration-150"
              >
                Request early access
              </Link>
              <Link
                href="/sign-in"
                className="w-full sm:w-auto px-6 py-3 rounded-xl border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-700 dark:text-gray-300 hover:border-gray-400 dark:hover:border-gray-500 hover:text-gray-900 dark:hover:text-gray-100 motion-safe:transition-all motion-safe:duration-150"
              >
                Sign in →
              </Link>
            </div>
          </div>

          {/* Product preview card */}
          <div className="flex-1 w-full max-w-sm lg:max-w-none">
            <div className="rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-xl overflow-hidden">
              {/* App chrome bar */}
              <div className="bg-gray-50 dark:bg-gray-700/60 border-b border-gray-100 dark:border-gray-700 px-4 py-2.5 flex items-center justify-between">
                <span className="text-xs font-semibold text-gray-700 dark:text-gray-300">
                  Court Time
                </span>
                <span className="text-[10px] text-gray-400 dark:text-gray-500">
                  Riverside Tennis Club
                </span>
              </div>

              {/* Courts section */}
              <div className="px-4 pt-4 pb-2">
                <p className="text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-widest mb-3">
                  Today's Courts
                </p>
                <div className="space-y-2">
                  {PREVIEW_COURTS.map((c) => (
                    <div key={c.name} className="flex items-center gap-3">
                      <div
                        className={`shrink-0 w-1.5 h-8 rounded-full ${c.busy ? 'bg-gray-900 dark:bg-gray-100' : 'bg-gray-200 dark:bg-gray-600'}`}
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium text-gray-900 dark:text-gray-100">
                          {c.name}
                        </p>
                        <p className="text-[11px] text-gray-400 dark:text-gray-500 truncate">
                          {c.member}
                        </p>
                      </div>
                      <span
                        className={`shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded ${c.busy ? 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300' : 'bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-400'}`}
                      >
                        {c.status}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Divider — evokes a court baseline */}
              <div className="mx-4 my-3 border-t border-gray-100 dark:border-gray-700" />
              <div className="mx-4 mb-3 border-t border-gray-50 dark:border-gray-700/50" />

              {/* Events section */}
              <div className="px-4 pb-4">
                <p className="text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-widest mb-3">
                  Upcoming Events
                </p>
                <div className="space-y-2.5">
                  {PREVIEW_EVENTS.map((e) => (
                    <div
                      key={e.title}
                      className="flex items-center justify-between gap-3"
                    >
                      <p className="text-xs font-medium text-gray-900 dark:text-gray-100">
                        {e.title}
                      </p>
                      <div className="shrink-0 flex items-center gap-1.5">
                        <span className="text-[10px] text-gray-500 dark:text-gray-400">
                          {e.attending} attending
                        </span>
                        {e.waitlisted > 0 && (
                          <span className="text-[10px] text-amber-600 dark:text-amber-400">
                            · {e.waitlisted} waitlisted
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
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
            Up and running in a day
          </h2>
        </MarketingReveal>
        <div className="flex flex-col gap-8">
          {[
            {
              step: '1',
              heading: 'We set up your club.',
              body: 'Courts, operating hours, member settings, and event types — configured and ready in hours, not weeks. No technical work required from you.',
            },
            {
              step: '2',
              heading: 'Your admin manages everything from one place.',
              body: 'Bookings, event rosters, your full member directory, announcements, and club settings — all from a clean web dashboard.',
            },
            {
              step: '3',
              heading: 'Members book courts and join events from any device.',
              body: 'No app download. No learning curve. Just a link and a simple interface your whole club can use.',
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
            Founding clubs get early-access pricing and a direct line to the
            team — and help build something they'll actually want to keep using.
          </p>
          <p className="text-sm text-gray-500 mb-8">
            No credit card required. Setup is free during the founding period.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <Link
              href="/contact"
              className="w-full sm:w-auto px-6 py-3 rounded-xl bg-white text-gray-900 text-sm font-semibold hover:bg-gray-100 motion-safe:transition-colors motion-safe:duration-150"
            >
              Talk to us about your club
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
