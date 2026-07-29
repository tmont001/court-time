import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getAuthUser, getAuthProfile } from "@/lib/supabase/user";
import Header from "@/components/Header";
import { resolveReportRange, type ReportRange } from "./dateRange";

// ── Types ─────────────────────────────────────────────────────────────────────

type OverviewRow = {
  gross_utilization_pct: number;
  member_demand_utilization_pct: number;
  total_reservations: number;
  cancelled_reservations: number;
  cancellation_rate_pct: number;
  sessions_held: number;
  total_session_capacity: number;
  total_session_enrollment: number;
  session_fill_rate_pct: number;
  active_member_count: number;
  outstanding_waitlist_count: number;
};

type CourtUtilizationRow = {
  court_id: string;
  court_name: string;
  available_hours: number;
  gross_reserved_hours: number;
  member_demand_reserved_hours: number;
  gross_utilization_pct: number;
  member_demand_utilization_pct: number;
};

type DailySeriesPoint = {
  local_date: string;
  total_count: number;
  cancelled_count: number;
};

type ReservationSummaryRow = {
  total_reservations: number;
  pending_reservations: number;
  confirmed_reservations: number;
  cancelled_reservations: number;
  cancellation_rate_pct: number;
  member_booking_count: number;
  event_count: number;
  pro_lesson_count: number;
  maintenance_count: number;
  admin_block_count: number;
  daily_series: DailySeriesPoint[];
};

type EventProgramSummaryRow = {
  standalone_sessions_held: number;
  program_sessions_held: number;
  total_sessions_held: number;
  total_capacity: number;
  confirmed_members: number;
  guests: number;
  total_enrollment: number;
  fill_rate_pct: number;
  attended_count: number;
  no_show_count: number;
  attendance_marked_count: number;
  attendance_rate_pct: number;
  no_show_rate_pct: number;
  cancelled_standalone_sessions: number;
  cancelled_program_sessions: number;
};

type WaitlistDemandRow = {
  event_waitlisted_entries: number;
  event_live_offer_entries: number;
  program_waitlisted_entries: number;
  program_live_offer_entries: number;
  total_outstanding_entries: number;
};

type MemberEngagementRow = {
  active_member_snapshot_count: number;
  engaged_member_count: number;
  members_with_reservations: number;
  members_with_event_participation: number;
  members_with_program_enrollment: number;
};

// ── Display helpers ───────────────────────────────────────────────────────────

function formatPct(n: number): string {
  return `${n.toFixed(1)}%`;
}

function formatHours(n: number): string {
  return `${n.toFixed(1)}h`;
}

// ── Layout components ─────────────────────────────────────────────────────────

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2">
      {children}
    </p>
  );
}

function EmptyState({ label }: { label: string }) {
  return <p className="text-sm text-gray-400 dark:text-gray-500 px-1">{label}</p>;
}

function UnavailableState() {
  return (
    <p className="text-sm text-orange-500 dark:text-orange-400 px-1">
      Data unavailable — try refreshing.
    </p>
  );
}

function UtilizationRow({ label, pct }: { label: string; pct: number }) {
  return (
    <div className="px-4 py-2.5 flex items-center justify-between">
      <span className="text-sm text-gray-700 dark:text-gray-200">{label}</span>
      <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{formatPct(pct)}</span>
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="ct-card px-3 py-3 text-center">
      <p className="text-lg font-bold text-gray-900 dark:text-gray-100">{value}</p>
      <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-0.5 leading-tight">{label}</p>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-4 py-2.5 flex items-center justify-between">
      <span className="text-sm text-gray-700 dark:text-gray-200">{label}</span>
      <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{value}</span>
    </div>
  );
}

// Simple CSS-only sparkline: one bar per day, height proportional to that
// day's total, with a darker cap segment showing the cancelled share.
// Horizontally scrollable so a 366-day custom range never overflows the page.
function DailyBarSeries({ series }: { series: DailySeriesPoint[] }) {
  const max = Math.max(1, ...series.map(p => p.total_count));
  return (
    <div className="overflow-x-auto">
      <div className="flex items-end gap-[3px] h-16 min-w-max px-1">
        {series.map(p => {
          const totalPct = (p.total_count / max) * 100;
          const cancelledPct = p.total_count > 0 ? (p.cancelled_count / p.total_count) * 100 : 0;
          return (
            <div
              key={p.local_date}
              title={`${p.local_date}: ${p.total_count} total, ${p.cancelled_count} cancelled`}
              className="w-2 shrink-0 rounded-t bg-gray-100 dark:bg-gray-800 flex flex-col justify-end overflow-hidden"
              style={{ height: "100%" }}
            >
              <div className="w-full flex flex-col justify-end" style={{ height: `${totalPct}%` }}>
                <div
                  className="w-full bg-red-400 dark:bg-red-500"
                  style={{ height: `${cancelledPct}%` }}
                />
                <div
                  className="w-full bg-accent"
                  style={{ height: `${100 - cancelledPct}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ReportsUnavailablePage() {
  return (
    <>
      <Header screenTitle="Reports" />
      <div className="overflow-y-auto" style={{ height: "var(--page-fill-height)" }}>
        <div className="md:max-w-2xl md:mx-auto px-4 pt-3 pb-8 space-y-6">
          <Link
            href="/admin/overview"
            className="inline-flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 hover:text-accent motion-safe:transition-colors motion-safe:duration-150"
          >
            ← Back to Overview
          </Link>
          <div className="rounded-xl border border-orange-200 dark:border-orange-800 bg-orange-50 dark:bg-orange-950/30 px-4 py-3">
            <p className="text-sm text-orange-700 dark:text-orange-300">
              Reports are temporarily unavailable — we couldn&apos;t load your club&apos;s
              configuration. Try refreshing the page.
            </p>
          </div>
        </div>
      </div>
    </>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function AdminReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; start?: string; end?: string }>;
}) {
  const user = await getAuthUser();
  if (!user) redirect("/sign-in");

  // Admin-only for Phase 28A — this check is what actually gates the route;
  // the SideNav entry only controls whether the link is *shown*. Both
  // reporting RPCs independently re-enforce this same admin-only,
  // membership-native check server-side, so this page never relies on the
  // nav or this redirect alone for real authorization.
  const profile = await getAuthProfile();
  if (profile?.role !== "admin") redirect("/calendar");

  const supabase = await createClient();
  const clubId = profile?.activeClubId ?? "";

  const { data: club, error: clubError } = await supabase
    .from("clubs")
    .select("timezone")
    .eq("id", clubId)
    .single();

  // No silent timezone fallback: a failed lookup or a club row with no
  // timezone must not silently compute report dates against a guessed
  // zone (that would produce numbers that are quietly wrong, not just
  // unavailable). Stop before any date math or RPC call.
  if (clubError || !club?.timezone) {
    return <ReportsUnavailablePage />;
  }

  const tz = club.timezone;

  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: tz });

  const sp = await searchParams;
  const resolved = resolveReportRange(todayStr, sp.range, sp.start, sp.end);

  const rpcArgs = { p_start_date: resolved.startDate, p_end_date: resolved.endDate };

  const [overviewResult, courtsResult, reservationsResult, eventProgramResult, waitlistResult, engagementResult] =
    await Promise.all([
      supabase.rpc("get_reporting_overview", rpcArgs),
      supabase.rpc("get_court_utilization", rpcArgs),
      supabase.rpc("get_reservation_summary", rpcArgs),
      supabase.rpc("get_event_program_summary", rpcArgs),
      supabase.rpc("get_waitlist_demand", rpcArgs),
      supabase.rpc("get_member_engagement_summary", rpcArgs),
    ]);

  const overviewRows = (overviewResult.data ?? []) as OverviewRow[];
  const overview = overviewRows[0] ?? null;
  const overviewFailed = !!overviewResult.error || !overview;

  const courts = (courtsResult.data ?? []) as CourtUtilizationRow[];
  const courtsFailed = !!courtsResult.error;

  const reservationRows = (reservationsResult.data ?? []) as ReservationSummaryRow[];
  const reservationSummary = reservationRows[0] ?? null;
  const reservationsFailed = !!reservationsResult.error || !reservationSummary;

  const eventProgramRows = (eventProgramResult.data ?? []) as EventProgramSummaryRow[];
  const eventProgram = eventProgramRows[0] ?? null;
  const eventProgramFailed = !!eventProgramResult.error || !eventProgram;

  const waitlistRows = (waitlistResult.data ?? []) as WaitlistDemandRow[];
  const waitlist = waitlistRows[0] ?? null;
  const waitlistFailed = !!waitlistResult.error || !waitlist;

  const engagementRows = (engagementResult.data ?? []) as MemberEngagementRow[];
  const engagement = engagementRows[0] ?? null;
  const engagementFailed = !!engagementResult.error || !engagement;

  const rangeLinks: { key: ReportRange; label: string; href: string }[] = [
    { key: "today", label: "Today", href: "/admin/reports?range=today" },
    { key: "7d", label: "Last 7 days", href: "/admin/reports?range=7d" },
    { key: "30d", label: "Last 30 days", href: "/admin/reports?range=30d" },
  ];

  return (
    <>
      <Header screenTitle="Reports" />
      <div className="overflow-y-auto" style={{ height: "var(--page-fill-height)" }}>
        <div className="md:max-w-2xl md:mx-auto px-4 pt-3 pb-8 space-y-6">
          <Link
            href="/admin/overview"
            className="inline-flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 hover:text-accent motion-safe:transition-colors motion-safe:duration-150"
          >
            ← Back to Overview
          </Link>

          <section className="space-y-1">
            <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">Operational reports</p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Court usage, bookings, and session activity for the selected date range.
            </p>
          </section>

          {/* ── Range selector ─────────────────────────────────────────────── */}
          <section>
            <div className="ct-card flex divide-x divide-gray-100 dark:divide-gray-800 overflow-hidden">
              {rangeLinks.map(r => {
                const active = resolved.range === r.key && !resolved.invalid;
                return (
                  <Link
                    key={r.key}
                    href={r.href}
                    className={`flex-1 text-center py-2 text-xs font-medium motion-safe:transition-colors motion-safe:duration-100 ${
                      active
                        ? "bg-accent text-white"
                        : "text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800/50"
                    }`}
                  >
                    {r.label}
                  </Link>
                );
              })}
            </div>

            {/* Custom range — plain server-rendered GET form, no client JS.
                Submitting navigates to /admin/reports?range=custom&start=&end=,
                which the server resolves and validates on the next render. */}
            <form
              method="GET"
              action="/admin/reports"
              className={`ct-card mt-2 px-3 py-2.5 flex flex-wrap items-end gap-2 ${
                resolved.range === "custom" ? "ring-1 ring-accent" : ""
              }`}
            >
              <input type="hidden" name="range" value="custom" />
              <div className="flex flex-col gap-1">
                <label htmlFor="report-start" className="text-[10px] text-gray-500 dark:text-gray-400">
                  Custom start
                </label>
                <input
                  id="report-start"
                  type="date"
                  name="start"
                  defaultValue={resolved.range === "custom" ? resolved.startDate : ""}
                  className="ct-input text-xs py-1.5 w-auto"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor="report-end" className="text-[10px] text-gray-500 dark:text-gray-400">
                  Custom end
                </label>
                <input
                  id="report-end"
                  type="date"
                  name="end"
                  defaultValue={resolved.range === "custom" ? resolved.endDate : ""}
                  className="ct-input text-xs py-1.5 w-auto"
                />
              </div>
              <button type="submit" className="ct-button-secondary text-xs py-1.5 px-3">
                Apply
              </button>
            </form>

            <p className="text-xs text-gray-400 dark:text-gray-500 mt-1.5 px-1">
              {resolved.startDate === resolved.endDate
                ? `Showing ${resolved.startDate}.`
                : `Showing ${resolved.startDate} – ${resolved.endDate}.`}
              {resolved.range === "today" &&
                " Today includes scheduled court occupancy for the entire local date."}
              {" "}A custom range can span at most 366 days.
            </p>
          </section>

          {resolved.invalid && (
            <div className="rounded-xl border border-orange-200 dark:border-orange-800 bg-orange-50 dark:bg-orange-950/30 px-4 py-3">
              <p className="text-sm text-orange-700 dark:text-orange-300">
                That custom date range wasn&apos;t valid, so the last 7 days are shown instead. A
                custom range needs a start date on or before the end date, spanning no more than
                about a year.
              </p>
            </div>
          )}

          {/* ── KPI tiles ───────────────────────────────────────────────────── */}
          <section>
            <SectionHeading>Key metrics</SectionHeading>
            {overviewFailed ? (
              <UnavailableState />
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {[
                  { label: "Court Utilization", value: formatPct(overview.gross_utilization_pct) },
                  { label: "Total Reservations", value: String(overview.total_reservations) },
                  { label: "Sessions Held", value: String(overview.sessions_held) },
                  { label: "Session Fill Rate", value: formatPct(overview.session_fill_rate_pct) },
                  { label: "Cancellation Rate", value: formatPct(overview.cancellation_rate_pct) },
                  { label: "Active Members", value: String(overview.active_member_count) },
                ].map(t => (
                  <div key={t.label} className="ct-card px-3 py-3 text-center">
                    <p className="text-lg font-bold text-gray-900 dark:text-gray-100">{t.value}</p>
                    <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-0.5 leading-tight">
                      {t.label}
                    </p>
                  </div>
                ))}
              </div>
            )}
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-1.5 px-1">
              Active Members is a current snapshot, not specific to the selected range.
            </p>
          </section>

          {/* ── Overall utilization summary ────────────────────────────────── */}
          <section>
            <SectionHeading>Court utilization (overall)</SectionHeading>
            {overviewFailed ? (
              <UnavailableState />
            ) : (
              <div className="ct-card divide-y divide-gray-100 dark:divide-gray-800 overflow-hidden">
                <UtilizationRow label="Gross utilization" pct={overview.gross_utilization_pct} />
                <UtilizationRow
                  label="Member-demand utilization"
                  pct={overview.member_demand_utilization_pct}
                />
                <div className="px-4 py-2.5 flex items-center justify-between">
                  <span className="text-sm text-gray-700 dark:text-gray-200">Outstanding waitlist</span>
                  <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    {overview.outstanding_waitlist_count}
                  </span>
                </div>
                <div className="px-4 py-2.5 flex items-center justify-between">
                  <span className="text-sm text-gray-700 dark:text-gray-200">Cancelled reservations</span>
                  <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    {overview.cancelled_reservations} / {overview.total_reservations}
                  </span>
                </div>
              </div>
            )}
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-1.5 px-1">
              Gross utilization includes maintenance and admin blocks; member-demand utilization
              excludes them. Outstanding waitlist counts current entries, not distinct people —
              a member can appear more than once. Historical ranges use the club&apos;s current
              active-court configuration and current operating-hours configuration, not what was
              in effect at the time — a reservation on a court that has since been deactivated
              is excluded, and past dates are valued at today&apos;s hours, not their own.
            </p>
          </section>

          {/* ── Per-court utilization ──────────────────────────────────────── */}
          <section>
            <SectionHeading>Court utilization (by court)</SectionHeading>
            {courtsFailed ? (
              <UnavailableState />
            ) : courts.length === 0 ? (
              <EmptyState label="No active courts." />
            ) : (
              <div className="space-y-2">
                {courts.map(c => (
                  <div key={c.court_id} className="ct-card px-4 py-2.5">
                    <div className="flex items-center justify-between mb-1.5">
                      <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                        {c.court_name}
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        {formatHours(c.gross_reserved_hours)} / {formatHours(c.available_hours)}
                      </p>
                    </div>
                    {/* Bar width is visually clamped to 100% (a bar can't render wider than
                        its track) — the percentage TEXT below is never capped, so over-capacity
                        or over-100%-utilization values stay visible. */}
                    <div className="h-1.5 rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden">
                      <div
                        className="h-full bg-accent"
                        style={{ width: `${Math.max(0, Math.min(100, c.gross_utilization_pct))}%` }}
                      />
                    </div>
                    <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-1">
                      {formatPct(c.gross_utilization_pct)} gross · {formatPct(c.member_demand_utilization_pct)}{" "}
                      member-demand
                    </p>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* ── Reservations ────────────────────────────────────────────────── */}
          <section>
            <SectionHeading>Reservations</SectionHeading>
            {reservationsFailed ? (
              <UnavailableState />
            ) : (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <StatTile label="Total" value={String(reservationSummary.total_reservations)} />
                  <StatTile
                    label="Cancellation Rate"
                    value={formatPct(reservationSummary.cancellation_rate_pct)}
                  />
                  <StatTile label="Pending" value={String(reservationSummary.pending_reservations)} />
                  <StatTile label="Confirmed" value={String(reservationSummary.confirmed_reservations)} />
                  <StatTile label="Cancelled" value={String(reservationSummary.cancelled_reservations)} />
                </div>
                <div className="ct-card mt-2 divide-y divide-gray-100 dark:divide-gray-800 overflow-hidden">
                  <DetailRow label="Member booking" value={String(reservationSummary.member_booking_count)} />
                  <DetailRow label="Event" value={String(reservationSummary.event_count)} />
                  <DetailRow label="Pro lesson" value={String(reservationSummary.pro_lesson_count)} />
                  <DetailRow label="Maintenance" value={String(reservationSummary.maintenance_count)} />
                  <DetailRow label="Admin block" value={String(reservationSummary.admin_block_count)} />
                </div>
                {reservationSummary.daily_series.length > 0 && (
                  <div className="ct-card mt-2 px-3 py-3">
                    <DailyBarSeries series={reservationSummary.daily_series} />
                    <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-1.5 flex items-center gap-3">
                      <span className="inline-flex items-center gap-1">
                        <span className="inline-block w-2 h-2 rounded-sm bg-accent" /> total
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <span className="inline-block w-2 h-2 rounded-sm bg-red-400 dark:bg-red-500" /> cancelled
                      </span>
                    </p>
                  </div>
                )}
              </>
            )}
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-1.5 px-1">
              Every date in the selected range appears in the daily chart, including zero-count
              days. Reservation counts reflect all courts, including any court since deactivated.
            </p>
          </section>

          {/* ── Events & Programs ───────────────────────────────────────────── */}
          <section>
            <SectionHeading>Events &amp; Programs</SectionHeading>
            {eventProgramFailed ? (
              <UnavailableState />
            ) : (
              <>
                <div className="grid grid-cols-3 gap-2">
                  <StatTile label="Sessions Held" value={String(eventProgram.total_sessions_held)} />
                  <StatTile label="Standalone" value={String(eventProgram.standalone_sessions_held)} />
                  <StatTile label="Program-Generated" value={String(eventProgram.program_sessions_held)} />
                  <StatTile label="Fill Rate" value={formatPct(eventProgram.fill_rate_pct)} />
                  <StatTile label="Attendance Rate" value={formatPct(eventProgram.attendance_rate_pct)} />
                  <StatTile label="No-Show Rate" value={formatPct(eventProgram.no_show_rate_pct)} />
                </div>
                <div className="ct-card mt-2 divide-y divide-gray-100 dark:divide-gray-800 overflow-hidden">
                  <DetailRow label="Total capacity" value={String(eventProgram.total_capacity)} />
                  <DetailRow label="Confirmed members" value={String(eventProgram.confirmed_members)} />
                  <DetailRow label="Guests" value={String(eventProgram.guests)} />
                  <DetailRow label="Total enrollment" value={String(eventProgram.total_enrollment)} />
                  <DetailRow label="Attended" value={String(eventProgram.attended_count)} />
                  <DetailRow label="No-show" value={String(eventProgram.no_show_count)} />
                  <DetailRow label="Attendance marked" value={String(eventProgram.attendance_marked_count)} />
                  <DetailRow
                    label="Cancelled standalone sessions"
                    value={String(eventProgram.cancelled_standalone_sessions)}
                  />
                  <DetailRow
                    label="Cancelled program sessions"
                    value={String(eventProgram.cancelled_program_sessions)}
                  />
                </div>
              </>
            )}
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-1.5 px-1">
              &ldquo;Program-generated&rdquo; sessions are events created by a program&apos;s
              schedule — there is no separate session table. Attendance rates count only confirmed
              participants with a recorded attendance mark; guests are never included, since guest
              attendance isn&apos;t tracked.
            </p>
          </section>

          {/* ── Waitlist Demand ─────────────────────────────────────────────── */}
          <section>
            <SectionHeading>Waitlist Demand</SectionHeading>
            {waitlistFailed ? (
              <UnavailableState />
            ) : (
              <div className="ct-card divide-y divide-gray-100 dark:divide-gray-800 overflow-hidden">
                <DetailRow label="Event — waitlisted" value={String(waitlist.event_waitlisted_entries)} />
                <DetailRow label="Event — live offers" value={String(waitlist.event_live_offer_entries)} />
                <DetailRow label="Program — waitlisted" value={String(waitlist.program_waitlisted_entries)} />
                <DetailRow
                  label="Program — live offers"
                  value={String(waitlist.program_live_offer_entries)}
                />
                <div className="px-4 py-2.5 flex items-center justify-between">
                  <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    Total outstanding
                  </span>
                  <span className="text-sm font-bold text-gray-900 dark:text-gray-100">
                    {waitlist.total_outstanding_entries}
                  </span>
                </div>
              </div>
            )}
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-1.5 px-1">
              A current snapshot, independent of the selected date range — not a historical count
              of offers made, accepted, or expired over the period, which this checkpoint does not
              track. Counts entries, not distinct people; a member can appear more than once.
            </p>
          </section>

          {/* ── Member Engagement ───────────────────────────────────────────── */}
          <section>
            <SectionHeading>Member Engagement</SectionHeading>
            {engagementFailed ? (
              <UnavailableState />
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <StatTile
                  label="Active Members"
                  value={String(engagement.active_member_snapshot_count)}
                />
                <StatTile label="Engaged Members" value={String(engagement.engaged_member_count)} />
                <StatTile
                  label="With Reservations"
                  value={String(engagement.members_with_reservations)}
                />
                <StatTile
                  label="With Event Participation"
                  value={String(engagement.members_with_event_participation)}
                />
                <StatTile
                  label="With Program Enrollment"
                  value={String(engagement.members_with_program_enrollment)}
                />
              </div>
            )}
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-1.5 px-1">
              Active Members is a current snapshot. Every other figure here counts distinct
              members, not total actions — a member with several reservations in range still
              counts once. Engaged Members is the union across reservations, event participation,
              and program enrollment, so a member active in more than one way is still counted
              once, not once per source.
            </p>
          </section>
        </div>
      </div>
    </>
  );
}
