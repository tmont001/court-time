import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getAuthUser, getAuthProfile } from "@/lib/supabase/user";
import Header from "@/components/Header";
import { resolveReportRange, type ReportRange } from "./dateRange";
import { logReportingRpcFailure } from "./reportingDiagnostics";
import { formatRateOrUnavailable } from "./reportPresentation";
import type { DailySeriesPoint } from "./reservationsChart";
import ReservationsDailyChart from "./ReservationsDailyChart";
import { formatMoney } from "@/lib/money";
import { getFinancialRangeSummary, getOutstandingSnapshot, FINANCIAL_DOMAIN_LABEL } from "../payments/financialSummary";
import ReportExportButton from "./ReportExportButton";
import type { ReportSummaryRow } from "./reportExport";

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

function SectionHeading({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 mb-2">
      <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
        {children}
      </p>
      {right}
    </div>
  );
}

// Restrained, scannable marker for a value that is NOT governed by the
// page's selected date range (e.g. a live roster/queue count) — deliberately
// not a long paragraph, so it reads at a glance next to or inside the metric
// itself. Reuses this page's existing small-caption visual language (the
// same text-[10px]/uppercase/tracking-wider treatment SectionHeading and
// StatTile's own label already use) rather than introducing a new badge
// style.
function SnapshotBadge() {
  return (
    <span className="inline-flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
      <span aria-hidden="true" className="inline-block w-1 h-1 rounded-full bg-gray-400 dark:bg-gray-500" />
      Current snapshot
    </span>
  );
}

function EmptyState({ label }: { label: string }) {
  return <p className="text-sm text-gray-500 dark:text-gray-400 px-1">{label}</p>;
}

function UnavailableState() {
  return (
    <p className="text-sm text-orange-500 dark:text-orange-400 px-1">
      Data unavailable — try refreshing.
    </p>
  );
}

// Two-per-row compact stat, for a summary strip inside a card rather than
// its own bordered tile — used by the Court Utilization overall-summary
// strip, deliberately lighter-weight than StatTile so it doesn't compete
// visually with the per-court rows beneath it.
function CompactStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{value}</p>
      <p className="text-[10px] text-gray-500 dark:text-gray-400 leading-tight mt-0.5">{label}</p>
    </div>
  );
}

function StatTile({
  label,
  value,
  snapshot,
  title,
}: {
  label: string;
  value: string;
  /** Renders the same restrained "Current snapshot" marker SnapshotBadge
   * uses, sized for a tile rather than a section heading. */
  snapshot?: boolean;
  /** Native title attribute — used to explain a "—" value inline without an
   * external tooltip dependency. */
  title?: string;
}) {
  return (
    <div className="ct-card px-3 py-3 text-center" title={title}>
      <p className="text-lg font-bold text-gray-900 dark:text-gray-100">{value}</p>
      <p className="text-[10px] text-gray-500 dark:text-gray-400 mt-0.5 leading-tight">{label}</p>
      {snapshot && (
        <p className="text-[9px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mt-1">
          Current snapshot
        </p>
      )}
    </div>
  );
}

// Native <details>/<summary> disclosure for lower-value explanatory copy —
// this project's own established pattern (see DeliveryDiagnosticsSection and
// NotificationPreferencesForm's groups) rather than a tooltip library.
function InfoDisclosure({ summary, children }: { summary: string; children: React.ReactNode }) {
  return (
    <details className="group mt-1.5">
      <summary className="cursor-pointer select-none list-none inline-flex items-center gap-1 text-[10px] text-gray-500 dark:text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 px-1">
        <span aria-hidden="true" className="inline-block motion-safe:transition-transform group-open:rotate-90">
          ›
        </span>
        {summary}
      </summary>
      <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 px-1">{children}</p>
    </details>
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

function ReportsUnavailablePage() {
  return (
    <>
      <Header screenTitle="Reports" />
      <div className="overflow-y-auto" style={{ height: "var(--page-fill-height)" }}>
        <div className="md:max-w-2xl md:mx-auto px-4 pt-3 pb-8 space-y-6">
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

  // Admin Cleanup Checkpoint 6 — currency for the new Financial Summary
  // section, sourced the same way admin/payments/page.tsx already does
  // (club_settings.currency, "USD" fallback) — no silent-failure risk here
  // the way an unset timezone has, since a missing currency safely falls
  // back to the same default every other money display in this app uses.
  const { data: clubSettings } = await supabase
    .from("club_settings")
    .select("currency")
    .eq("club_id", clubId)
    .single();
  const currency = clubSettings?.currency ?? "USD";

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

  logReportingRpcFailure("get_reporting_overview", overviewResult.error);
  logReportingRpcFailure("get_court_utilization", courtsResult.error);
  logReportingRpcFailure("get_reservation_summary", reservationsResult.error);
  logReportingRpcFailure("get_event_program_summary", eventProgramResult.error);
  logReportingRpcFailure("get_waitlist_demand", waitlistResult.error);
  logReportingRpcFailure("get_member_engagement_summary", engagementResult.error);

  // Admin Cleanup Checkpoint 6 — Financial Summary. Consumes the SAME
  // authoritative layer /admin/payments' Overview tab consumes (never a
  // second, competing formula) — Collected/Refunded/Net for this exact
  // selected range (same club_local_bounds boundary every RPC above
  // already uses), plus Outstanding as a CURRENT SNAPSHOT (reusing the
  // existing Outstanding Balances computation, not re-derived here).
  const [financialSummaryResult, outstandingResult] = await Promise.all([
    getFinancialRangeSummary(supabase, resolved.startDate, resolved.endDate),
    getOutstandingSnapshot(supabase, clubId, tz),
  ]);
  if (financialSummaryResult.error) {
    logReportingRpcFailure("get_financial_range_summary", financialSummaryResult.error);
  }
  if ("error" in outstandingResult) {
    console.error("[AdminReports] outstanding snapshot failed:", { message: outstandingResult.error });
  }
  const financialSummary = financialSummaryResult.data;
  const outstandingCents = "error" in outstandingResult ? null : outstandingResult.outstandingCents;
  // Correction — the range summary (Collected/Refunded/Net) and the
  // Outstanding snapshot are two INDEPENDENT reads (separate awaited
  // results above) that can fail independently; a single combined
  // "financialFailed" boolean would misreport one as unavailable merely
  // because the other failed. Tracked separately so both the UI and the
  // CSV export can represent each half's real status truthfully.
  const financialRangeFailed = !financialSummary;
  const outstandingFailed = outstandingCents === null;

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

  // Admin Cleanup Checkpoint 6 (correction pass) — Export report (.csv).
  // Curated summary metrics from sections ALREADY loaded above — never
  // every field, never a raw dataset dump. A failed section is NEVER
  // silently omitted (a downloaded file has no surrounding UI context to
  // explain a gap the way the page's own UnavailableState does) — it
  // contributes exactly one truthful "Data status: Unavailable" row
  // instead, never a fabricated metric value. One section failing never
  // blocks any other section's real rows from exporting.
  const reportSummaryRows: ReportSummaryRow[] = [];

  // "Court Utilization" here mirrors the page's own Court Utilization
  // section's gross/member-demand summary strip, which reads exclusively
  // from `overview` (get_reporting_overview) — gated on overviewFailed
  // alone, matching that strip's own render condition; courtsFailed
  // governs only the separate per-court list, which this curated export
  // does not include at all.
  if (!overviewFailed) {
    reportSummaryRows.push(
      { section: "Court Utilization", metric: "Gross utilization", value: formatPct(overview!.gross_utilization_pct), scope: "Selected range" },
      { section: "Court Utilization", metric: "Member demand utilization", value: formatPct(overview!.member_demand_utilization_pct), scope: "Selected range" },
    );
  } else {
    reportSummaryRows.push({ section: "Court Utilization", metric: "Data status", value: "Unavailable", scope: "Selected range" });
  }

  if (!reservationsFailed) {
    reportSummaryRows.push(
      { section: "Reservations", metric: "Total reservations", value: String(reservationSummary!.total_reservations), scope: "Selected range" },
      { section: "Reservations", metric: "Cancelled reservations", value: String(reservationSummary!.cancelled_reservations), scope: "Selected range" },
      { section: "Reservations", metric: "Cancellation rate", value: formatPct(reservationSummary!.cancellation_rate_pct), scope: "Selected range" },
    );
  } else {
    reportSummaryRows.push({ section: "Reservations", metric: "Data status", value: "Unavailable", scope: "Selected range" });
  }

  if (!eventProgramFailed) {
    reportSummaryRows.push(
      { section: "Events & Programs", metric: "Total sessions held", value: String(eventProgram!.total_sessions_held), scope: "Selected range" },
      { section: "Events & Programs", metric: "Total enrollment", value: String(eventProgram!.total_enrollment), scope: "Selected range" },
      { section: "Events & Programs", metric: "Fill rate", value: formatPct(eventProgram!.fill_rate_pct), scope: "Selected range" },
      { section: "Events & Programs", metric: "Attendance rate", value: formatPct(eventProgram!.attendance_rate_pct), scope: "Selected range" },
    );
  } else {
    reportSummaryRows.push({ section: "Events & Programs", metric: "Data status", value: "Unavailable", scope: "Selected range" });
  }

  if (!waitlistFailed) {
    reportSummaryRows.push(
      { section: "Waitlist Demand", metric: "Total outstanding entries", value: String(waitlist!.total_outstanding_entries), scope: "Current snapshot" },
    );
  } else {
    reportSummaryRows.push({ section: "Waitlist Demand", metric: "Data status", value: "Unavailable", scope: "Current snapshot" });
  }

  if (!engagementFailed) {
    reportSummaryRows.push(
      { section: "Member Engagement", metric: "Active members", value: String(engagement!.active_member_snapshot_count), scope: "Current snapshot" },
      { section: "Member Engagement", metric: "Engaged members", value: String(engagement!.engaged_member_count), scope: "Selected range" },
    );
  } else {
    reportSummaryRows.push({ section: "Member Engagement", metric: "Data status", value: "Unavailable", scope: "Selected range" });
  }

  // Financial: range (Collected/Refunded/Net) and snapshot (Outstanding)
  // fail independently — each contributes its own real rows or its own
  // truthful status row, never coupled to the other's outcome.
  if (!financialRangeFailed) {
    reportSummaryRows.push(
      { section: "Financial", metric: "Collected", value: formatMoney(financialSummary!.collectedCents, currency), scope: "Selected range" },
      { section: "Financial", metric: "Refunded", value: formatMoney(financialSummary!.refundedCents, currency), scope: "Selected range" },
      { section: "Financial", metric: "Net collected", value: formatMoney(financialSummary!.netCollectedCents, currency), scope: "Selected range" },
    );
  } else {
    reportSummaryRows.push({ section: "Financial", metric: "Data status", value: "Unavailable", scope: "Selected range" });
  }
  if (!outstandingFailed) {
    reportSummaryRows.push(
      { section: "Financial", metric: "Outstanding", value: formatMoney(outstandingCents!, currency), scope: "Current snapshot" },
    );
  } else {
    reportSummaryRows.push({ section: "Financial", metric: "Data status", value: "Unavailable", scope: "Current snapshot" });
  }

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
              className={`ct-card mt-2 px-3 py-3 grid grid-cols-1 gap-3 w-full min-w-0 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] md:items-end md:gap-2 md:py-2.5 ${
                resolved.range === "custom" ? "ring-1 ring-accent" : ""
              }`}
            >
              <input type="hidden" name="range" value="custom" />
              <div className="flex flex-col gap-1 w-full min-w-0 max-w-full">
                <label htmlFor="report-start" className="text-[10px] text-gray-500 dark:text-gray-400">
                  Custom start
                </label>
                <input
                  id="report-start"
                  type="date"
                  name="start"
                  defaultValue={resolved.range === "custom" ? resolved.startDate : ""}
                  className="ct-input ct-date-input text-base md:text-xs py-1.5 w-full min-w-0 max-w-full box-border"
                />
              </div>
              <div className="flex flex-col gap-1 w-full min-w-0 max-w-full">
                <label htmlFor="report-end" className="text-[10px] text-gray-500 dark:text-gray-400">
                  Custom end
                </label>
                <input
                  id="report-end"
                  type="date"
                  name="end"
                  defaultValue={resolved.range === "custom" ? resolved.endDate : ""}
                  className="ct-input ct-date-input text-base md:text-xs py-1.5 w-full min-w-0 max-w-full box-border"
                />
              </div>
              <button type="submit" className="ct-button-secondary text-xs py-1.5 px-3 w-full md:w-auto">
                Apply
              </button>
            </form>

            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1.5 px-1">
              {resolved.startDate === resolved.endDate
                ? `Showing ${resolved.startDate}.`
                : `Showing ${resolved.startDate} – ${resolved.endDate}.`}
              {resolved.range === "today" &&
                " Today includes scheduled court occupancy for the entire local date."}
              {" "}A custom range can span at most 366 days.
            </p>
          </section>

          {/* ── Export (Admin Cleanup Checkpoint 6) ──────────────────────────
              The SUMMARY report — detailed transaction exports remain owned
              by /admin/payments. Built entirely from the already-loaded
              values above (reportSummaryRows), never a second query. */}
          <section>
            <ReportExportButton
              rows={reportSummaryRows}
              startDate={resolved.startDate}
              endDate={resolved.endDate}
            />
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
                <StatTile label="Court Utilization" value={formatPct(overview.gross_utilization_pct)} />
                <StatTile label="Total Reservations" value={String(overview.total_reservations)} />
                <StatTile label="Sessions Held" value={String(overview.sessions_held)} />
                <StatTile
                  label="Session Fill Rate"
                  value={formatRateOrUnavailable(overview.session_fill_rate_pct, overview.total_session_capacity > 0)}
                  title={overview.total_session_capacity > 0 ? undefined : "No session capacity in range."}
                />
                <StatTile label="Cancellation Rate" value={formatPct(overview.cancellation_rate_pct)} />
                <StatTile label="Active Members" value={String(overview.active_member_count)} snapshot />
              </div>
            )}
          </section>

          {/* ── Court utilization ──────────────────────────────────────────── */}
          {/* Consolidated: the overall gross/member-demand summary now sits as
              a compact strip above the per-court rows it used to duplicate as
              its own full section — same two RPCs (get_reporting_overview,
              get_court_utilization), each still independently rendered as
              unavailable if its own RPC failed. Outstanding waitlist and
              cancelled reservations are deliberately NOT shown here — this
              section is court-utilization information only; those two values
              live in their own semantic homes (Waitlist Demand's "Total
              outstanding", Reservations' cancellation rate/count) rather than
              being duplicated here too. overview.outstanding_waitlist_count
              and overview.cancelled_reservations/.total_reservations remain
              read from this same RPC result elsewhere on this page — nothing
              was removed from the RPC call or the page's data, only from this
              one section's presentation. */}
          <section>
            <SectionHeading>Court Utilization</SectionHeading>
            {overviewFailed ? (
              <UnavailableState />
            ) : (
              <div className="ct-card px-4 py-3 grid grid-cols-2 gap-x-4 gap-y-3 mb-2">
                <CompactStat label="Gross utilization" value={formatPct(overview.gross_utilization_pct)} />
                <CompactStat
                  label="Member-demand utilization"
                  value={formatPct(overview.member_demand_utilization_pct)}
                />
              </div>
            )}
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
                    <p className="text-[10px] text-gray-500 dark:text-gray-400 mt-1">
                      {formatPct(c.gross_utilization_pct)} gross · {formatPct(c.member_demand_utilization_pct)}{" "}
                      member-demand
                    </p>
                  </div>
                ))}
              </div>
            )}
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1.5 px-1">
              Historical ranges use today&apos;s court and hours configuration, not what was in
              effect at the time.
            </p>
            <InfoDisclosure summary="What do these numbers mean?">
              Gross utilization includes maintenance and admin blocks; member-demand utilization
              excludes them.
            </InfoDisclosure>
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
                    <ReservationsDailyChart series={reservationSummary.daily_series} />
                  </div>
                )}
              </>
            )}
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1.5 px-1">
              Includes reservations on courts since deactivated.
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
                  <StatTile
                    label="Fill Rate"
                    value={formatRateOrUnavailable(eventProgram.fill_rate_pct, eventProgram.total_capacity > 0)}
                    title={eventProgram.total_capacity > 0 ? undefined : "No session capacity in range."}
                  />
                  <StatTile
                    label="Attendance Rate"
                    value={formatRateOrUnavailable(eventProgram.attendance_rate_pct, eventProgram.attendance_marked_count > 0)}
                    title={eventProgram.attendance_marked_count > 0 ? undefined : "No attendance recorded for this range."}
                  />
                  <StatTile
                    label="No-Show Rate"
                    value={formatRateOrUnavailable(eventProgram.no_show_rate_pct, eventProgram.attendance_marked_count > 0)}
                    title={eventProgram.attendance_marked_count > 0 ? undefined : "No attendance recorded for this range."}
                  />
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
                {eventProgram.attendance_marked_count === 0 && (
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1.5 px-1">
                    No attendance recorded for this range.
                  </p>
                )}
              </>
            )}
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1.5 px-1">
              Attendance rates count only confirmed participants with a recorded attendance mark;
              guests are never included, since guest attendance isn&apos;t tracked.
            </p>
          </section>

          {/* ── Waitlist Demand ─────────────────────────────────────────────── */}
          <section>
            <SectionHeading right={<SnapshotBadge />}>Waitlist Demand</SectionHeading>
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
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1.5 px-1">
              Counts entries, not distinct people; a member can appear more than once.
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
                  snapshot
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
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1.5 px-1">
              Every figure here (besides Active Members) counts distinct members, not total
              actions. Engaged Members is the union across reservations, event participation, and
              program enrollment — a member active in more than one way is still counted once.
            </p>
          </section>

          {/* ── Financial Summary ──────────────────────────────────────────────
              Admin Cleanup Checkpoint 6 — consumes the exact same
              get_financial_range_summary RPC + Outstanding-snapshot layer
              /admin/payments' Overview tab consumes; no formula is
              duplicated here. */}
          <section>
            <SectionHeading>Financial Summary</SectionHeading>
            {/* Correction — Collected/Refunded/Net (range) and Outstanding
                (snapshot) are two independent reads that can fail
                independently; each renders its own truthful state rather
                than one combined all-or-nothing UnavailableState. */}
            <div className="grid grid-cols-2 gap-2">
              {financialRangeFailed ? (
                <div className="col-span-2">
                  <UnavailableState />
                </div>
              ) : (
                <>
                  <StatTile label="Collected" value={formatMoney(financialSummary!.collectedCents, currency)} />
                  <StatTile label="Refunded" value={formatMoney(financialSummary!.refundedCents, currency)} />
                  <StatTile label="Net Collected" value={formatMoney(financialSummary!.netCollectedCents, currency)} />
                </>
              )}
              {outstandingFailed ? (
                <div className="col-span-2">
                  <UnavailableState />
                </div>
              ) : (
                <StatTile label="Outstanding" value={formatMoney(outstandingCents!, currency)} snapshot />
              )}
            </div>
            {!financialRangeFailed && financialSummary!.domainBreakdown.length > 0 && (
              <>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mt-3 mb-1.5 px-1">
                  Net collected by domain
                </p>
                <div className="ct-card divide-y divide-gray-100 dark:divide-gray-800 overflow-hidden">
                  {financialSummary!.domainBreakdown.map(d => (
                    <DetailRow
                      key={d.domain}
                      label={FINANCIAL_DOMAIN_LABEL[d.domain]}
                      value={formatMoney(d.netCollectedCents, currency)}
                    />
                  ))}
                </div>
              </>
            )}
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1.5 px-1">
              Collected/Refunded/Net Collected reflect the selected range above. Outstanding is a
              current snapshot, not filtered by the selected range.
            </p>
          </section>
        </div>
      </div>
    </>
  );
}
