import type { Metadata } from "next";
import Link from "next/link";
import MarketingReveal from "../components/MarketingReveal";
import CourtScheduleVisual from "../components/product-visuals/CourtScheduleVisual";
import EventRosterVisual from "../components/product-visuals/EventRosterVisual";
import LessonWorkflowVisual from "../components/product-visuals/LessonWorkflowVisual";
import MemberDirectoryVisual from "../components/product-visuals/MemberDirectoryVisual";
import ReportingVisual from "../components/product-visuals/ReportingVisual";

export const metadata: Metadata = {
  title: "Features — Court Time",
  description:
    "See Court Time in action: real-time court scheduling, events and waitlists, lesson coordination, member administration, and reporting in one system.",
  alternates: { canonical: "/features" },
  openGraph: {
    title: "Features — Court Time",
    description:
      "See Court Time in action: real-time court scheduling, events and waitlists, lesson coordination, member administration, and reporting in one system.",
    url: "/features",
  },
};

const STORIES = [
  {
    heading: "See every court at a glance.",
    body: "A live, real-time court schedule shows every reservation and event across every court. Set operating hours and date-specific closures, take a court out of rotation with a maintenance block, and edit, reschedule, or cancel any reservation from the admin dashboard.",
    Visual: CourtScheduleVisual,
  },
  {
    heading: "Run programs without spreadsheet rosters.",
    body: "Create clinics, leagues, socials, and recurring programs with a capacity limit and a live participant roster. When an event fills up, members join a waitlist and get an automatic spot offer if a place opens — no manual list-keeping. Admins and Pros manage events within their own permissions.",
    Visual: EventRosterVisual,
  },
  {
    heading: "Coordinate lessons without the back-and-forth.",
    body: "Members request a lesson directly in the app. Pros propose a time, and confirm, reschedule, or cancel from their own schedule. Both sides see upcoming lessons in one place — no more coordinating over text.",
    Visual: LessonWorkflowVisual,
  },
  {
    heading: "Keep every member and staff role organized.",
    body: "A full member directory, including members who haven't created an account yet. Invite by email or onboard a club at once with a spreadsheet import. Member, Pro, and Admin roles keep everyone's access appropriate to their job.",
    Visual: MemberDirectoryVisual,
  },
  {
    heading: "Know what's happening across the club.",
    body: "Court utilization, reservation activity, and event and program participation, with cancellation and session fill-rate visibility for admins. Keep members in the loop with in-app notifications, email announcements, and optional text alerts for supported updates.",
    Visual: ReportingVisual,
  },
];

const ROLES = [
  {
    name: "Admins",
    summary: "Oversee courts, programs, members, settings, and reporting.",
  },
  {
    name: "Pros",
    summary: "Respond to lesson requests and manage permitted scheduling and event work.",
  },
  {
    name: "Members",
    summary: "Reserve courts, join events, manage waitlists, and request lessons.",
  },
];

const BEFORE = [
  "Schedules spread across messages and spreadsheets",
  "Manually maintained event rosters",
  "Lesson requests handled through text threads",
  "Limited operational visibility",
];

const AFTER = [
  "One live court schedule",
  "Structured rosters and waitlists",
  "One Member–Pro lesson workflow",
  "Reporting and communication in one place",
];

export default function FeaturesPage() {
  return (
    <div>

      {/* ── Hero ──────────────────────────────────────────────────────────── */}
      <section className="px-4 pt-16 pb-14 max-w-3xl mx-auto text-center">
        <MarketingReveal>
          <h1 className="text-3xl md:text-4xl font-bold text-gray-900 dark:text-gray-100 mb-4 leading-tight">
            Everything your club needs to stay organized.
          </h1>
          <p className="text-base text-gray-600 dark:text-gray-300 max-w-xl mx-auto leading-relaxed mb-8">
            Court Time brings scheduling, events, lessons, members, reporting,
            and communication into one straightforward system — built for
            tennis clubs, not adapted from a broader platform.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <Link
              href="/contact"
              className="w-full sm:w-auto px-6 py-3 rounded-xl bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-semibold hover:bg-gray-700 dark:hover:bg-gray-300 motion-safe:transition-colors motion-safe:duration-150"
            >
              Request a pilot
            </Link>
            <Link
              href="/pricing"
              className="w-full sm:w-auto px-6 py-3 rounded-xl border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-700 dark:text-gray-300 hover:border-gray-400 dark:hover:border-gray-500 hover:text-gray-900 dark:hover:text-gray-100 motion-safe:transition-all motion-safe:duration-150"
            >
              See pricing
            </Link>
          </div>
        </MarketingReveal>
      </section>

      {/* ── Product-tour stories ─────────────────────────────────────────── */}
      <div className="max-w-5xl mx-auto px-4 flex flex-col gap-16 md:gap-20 pb-20">
        {STORIES.map((story, i) => (
          <section
            key={story.heading}
            className={`flex flex-col lg:flex-row items-center gap-8 lg:gap-14 ${
              i % 2 === 1 ? "lg:flex-row-reverse" : ""
            }`}
          >
            <MarketingReveal className="flex-1 max-w-lg mx-auto lg:mx-0">
              <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-3 leading-tight">
                {story.heading}
              </h2>
              <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed">
                {story.body}
              </p>
            </MarketingReveal>
            <MarketingReveal
              delay="delay-1"
              className="flex-1 w-full max-w-sm mx-auto lg:mx-0 lg:max-w-none"
            >
              <story.Visual />
            </MarketingReveal>
          </section>
        ))}
      </div>

      {/* ── Court line divider ─────────────────────────────────────────────── */}
      <div className="max-w-5xl mx-auto px-4">
        <div className="border-t-2 border-gray-100 dark:border-gray-800" />
        <div className="border-t border-gray-50 dark:border-gray-800/60 mt-1" />
      </div>

      {/* ── Role section ──────────────────────────────────────────────────── */}
      <section className="px-4 py-16 max-w-4xl mx-auto">
        <MarketingReveal className="text-center mb-10">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            Built around how your club actually works
          </h2>
        </MarketingReveal>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
          {ROLES.map((role, i) => (
            <MarketingReveal
              key={role.name}
              delay={`delay-${i + 1}` as "delay-1" | "delay-2" | "delay-3"}
            >
              <div className="h-full rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 px-5 py-6 text-center hover:border-gray-300 dark:hover:border-gray-600 hover:shadow-md motion-safe:transition-all motion-safe:duration-200">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">
                  {role.name}
                </h3>
                <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed">
                  {role.summary}
                </p>
              </div>
            </MarketingReveal>
          ))}
        </div>
      </section>

      {/* ── Before / after ────────────────────────────────────────────────── */}
      <section className="px-4 py-16 bg-gray-50 dark:bg-gray-800/50">
        <MarketingReveal className="max-w-3xl mx-auto">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 text-center mb-10">
            Replace scattered workflows with one clear system.
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-6 py-6">
              <p className="text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-widest mb-4">
                Before Court Time
              </p>
              <ul className="space-y-2.5 text-sm text-gray-600 dark:text-gray-300 leading-relaxed list-none">
                {BEFORE.map((item) => (
                  <li key={item} className="flex gap-2">
                    <span className="text-gray-300 dark:text-gray-600 shrink-0">·</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-xl border-2 border-gray-900 dark:border-gray-100 bg-white dark:bg-gray-800 px-6 py-6">
              <p className="text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-widest mb-4">
                With Court Time
              </p>
              <ul className="space-y-2.5 text-sm text-gray-700 dark:text-gray-300 leading-relaxed list-none">
                {AFTER.map((item) => (
                  <li key={item} className="flex gap-2">
                    <span className="mt-0.5 text-green-600 dark:text-green-400 shrink-0 font-bold">✓</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </MarketingReveal>
      </section>

      {/* ── Closing CTA ───────────────────────────────────────────────────── */}
      <section className="px-4 py-16 text-center">
        <MarketingReveal>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">
            See how a pilot works, or request one for your club.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <Link
              href="/contact"
              className="w-full sm:w-auto px-6 py-3 rounded-xl bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-semibold hover:bg-gray-700 dark:hover:bg-gray-300 motion-safe:transition-colors motion-safe:duration-150"
            >
              Request a pilot
            </Link>
            <Link
              href="/pricing"
              className="w-full sm:w-auto px-6 py-3 rounded-xl border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-700 dark:text-gray-300 hover:border-gray-400 dark:hover:border-gray-500 hover:text-gray-900 dark:hover:text-gray-100 motion-safe:transition-all motion-safe:duration-150"
            >
              See pricing →
            </Link>
          </div>
        </MarketingReveal>
      </section>

    </div>
  );
}
