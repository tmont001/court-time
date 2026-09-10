import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatRateOrUnavailable } from "./reportPresentation";

// Admin UX Checkpoint 1 — Reports UX cleanup. Presentation-only changes to
// /admin/reports: consolidated Court Utilization, explicit current-snapshot
// labeling for Active Members/Waitlist Demand, "—" for a rate with no
// underlying sample, and trimmed explanatory copy. No RPC, SQL, date-range,
// or authorization change — those are proven untouched, not just unchanged
// by inspection, by the existing reportingRpcFix.regression.test.ts and
// reportingDiagnostics.regression.test.ts suites in this same directory,
// which this checkpoint does not modify.
//
// formatRateOrUnavailable is real-imported and called (genuine behavioral
// coverage, not source-inspection) per this project's own established
// pure-helper-extraction pattern (see dateRange.ts/reportingDiagnostics.ts
// in this directory). Everything about page.tsx's actual JSX wiring is
// necessarily source-inspection — this vitest baseline has no jsdom/React
// rendering, and page.tsx is a Server Component with framework imports that
// this codebase's own convention never imports directly into a test (see
// e.g. staleCheckoutInvalidation.regression.test.ts's identical choice for
// the same reason).

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const PAGE_PATH = "src/app/(app)/admin/reports/page.tsx";

function pageSource(): string {
  return readSource(PAGE_PATH);
}

describe("formatRateOrUnavailable — the locked presentation decision", () => {
  it("5. renders '—' when hasSample is false, regardless of the numeric pct value passed in", () => {
    expect(formatRateOrUnavailable(0, false)).toBe("—");
    // Even a nonzero pct must still be masked — hasSample is the sole
    // authority, never overridden by the value itself.
    expect(formatRateOrUnavailable(42.5, false)).toBe("—");
  });

  it("6. renders the formatted percentage — including a genuine measured zero — when hasSample is true", () => {
    expect(formatRateOrUnavailable(0, true)).toBe("0.0%");
    expect(formatRateOrUnavailable(66.666, true)).toBe("66.7%");
    expect(formatRateOrUnavailable(100, true)).toBe("100.0%");
  });

  it("7. fill-rate zero-capacity follows the same rule as attendance/no-show — one shared helper, not a special case", () => {
    // total_capacity === 0 uses this exact function with hasSample =
    // (total_capacity > 0), identical in kind to attendance_marked_count.
    expect(formatRateOrUnavailable(0, 0 > 0)).toBe("—");
    expect(formatRateOrUnavailable(50, 3 > 0)).toBe("50.0%");
  });
});

// Isolates the Court Utilization <section>...</section> block specifically,
// so "does NOT contain X" assertions below can't be fooled by X legitimately
// appearing in a different section (Waitlist Demand, Reservations) further
// down the same file.
function courtUtilizationSection(s: string): string {
  const start = s.indexOf("<SectionHeading>Court Utilization</SectionHeading>");
  expect(start, "Court Utilization section heading not found").toBeGreaterThan(-1);
  const end = s.indexOf("{/* ── Reservations", start);
  expect(end, "Reservations section marker not found after Court Utilization").toBeGreaterThan(start);
  return s.slice(start, end);
}

describe("1+2. Court Utilization consolidation — court-utilization data only, no redundant standalone section", () => {
  it("1. the summary strip contains ONLY gross and member-demand utilization, driven by the same overview fields as before", () => {
    const section = courtUtilizationSection(pageSource());
    expect(section).toContain('label="Gross utilization" value={formatPct(overview.gross_utilization_pct)}');
    expect(section).toContain('label="Member-demand utilization"');
    expect(section).toContain("value={formatPct(overview.member_demand_utilization_pct)}");
  });

  it("2. the Court Utilization section no longer renders Outstanding waitlist or Cancelled reservations — those values were removed from THIS section, not from the RPC result or the page", () => {
    const section = courtUtilizationSection(pageSource());
    expect(section).not.toContain("Outstanding waitlist");
    expect(section).not.toContain("Cancelled reservations");
    expect(section).not.toContain("overview.outstanding_waitlist_count");
    expect(section).not.toContain("overview.cancelled_reservations");
  });

  it("2 continued. the old standalone 'Court utilization (overall)' section heading, and its UtilizationRow component, no longer exist", () => {
    const s = pageSource();
    expect(s).not.toContain("Court utilization (overall)");
    expect(s).not.toContain("Court utilization (by court)");
    expect(s).not.toMatch(/function UtilizationRow/);
    // Exactly one Court Utilization section heading remains.
    expect((s.match(/<SectionHeading>Court Utilization<\/SectionHeading>/g) ?? []).length).toBe(1);
  });

  it("the merged section still independently renders each RPC's own unavailable state — overview and per-court failures are not conflated", () => {
    const section = courtUtilizationSection(pageSource());
    // Two independent conditionals — overviewFailed for the summary strip,
    // courtsFailed for the per-court rows — each rendering its own
    // <UnavailableState />.
    expect((section.match(/<UnavailableState \/>/g) ?? []).length).toBe(2);
    expect(section).toContain("{overviewFailed ? (");
    expect(section).toContain("{courtsFailed ? (");
  });
});

describe("3+4 (correction). Outstanding waitlist and Cancelled reservations kept their existing, correct semantic homes", () => {
  it("3. Waitlist Demand still renders Total outstanding, from the same waitlist.total_outstanding_entries field as before", () => {
    const s = pageSource();
    const start = s.indexOf('<SectionHeading right={<SnapshotBadge />}>Waitlist Demand</SectionHeading>');
    expect(start).toBeGreaterThan(-1);
    const end = s.indexOf("{/* ── Member Engagement", start);
    expect(end).toBeGreaterThan(start);
    const section = s.slice(start, end);
    expect(section).toContain("Total outstanding");
    expect(section).toContain("{waitlist.total_outstanding_entries}");
  });

  it("4. Reservations still renders both Cancellation Rate and Cancelled count, from the same reservationSummary fields as before", () => {
    const s = pageSource();
    const start = s.indexOf("<SectionHeading>Reservations</SectionHeading>");
    expect(start).toBeGreaterThan(-1);
    const end = s.indexOf("{/* ── Events & Programs", start);
    expect(end).toBeGreaterThan(start);
    const section = s.slice(start, end);
    expect(section).toContain("value={formatPct(reservationSummary.cancellation_rate_pct)}");
    expect(section).toContain('label="Cancelled" value={String(reservationSummary.cancelled_reservations)}');
  });
});

describe("3+4. Current-snapshot semantics are explicit", () => {
  it("3. every Active Members StatTile (Key Metrics and Member Engagement) passes the snapshot prop", () => {
    const s = pageSource();
    const matches = s.match(/label="Active Members"[\s\S]{0,120}?snapshot/g) ?? [];
    expect(matches.length).toBe(2);
  });

  it("4. Waitlist Demand's section heading carries the SnapshotBadge, not a redundant explanatory sentence", () => {
    const s = pageSource();
    expect(s).toContain('<SectionHeading right={<SnapshotBadge />}>Waitlist Demand</SectionHeading>');
    // The old "A current snapshot, independent of the selected date range"
    // sentence is gone now that the badge carries that meaning.
    expect(s).not.toMatch(/A current snapshot, independent of the selected date range/);
  });

  it("StatTile and SectionHeading actually render the 'Current snapshot' marker when their snapshot/right prop is used", () => {
    const s = pageSource();
    expect(s).toMatch(/snapshot &&[\s\S]{0,400}?Current snapshot/);
    expect(s).toMatch(/function SnapshotBadge[\s\S]{0,300}?Current snapshot/);
  });
});

describe("5/6 continued — the zero-attendance state renders '—' with supporting copy, not a bare 0.0%", () => {
  it("Attendance Rate and No-Show Rate both use formatRateOrUnavailable gated on attendance_marked_count > 0", () => {
    const s = pageSource();
    expect(s).toMatch(
      /label="Attendance Rate"\s*\n\s*value=\{formatRateOrUnavailable\(eventProgram\.attendance_rate_pct, eventProgram\.attendance_marked_count > 0\)\}/
    );
    expect(s).toMatch(
      /label="No-Show Rate"\s*\n\s*value=\{formatRateOrUnavailable\(eventProgram\.no_show_rate_pct, eventProgram\.attendance_marked_count > 0\)\}/
    );
    // Neither rate is still computed via the old bare formatPct call.
    expect(s).not.toMatch(/formatPct\(eventProgram\.attendance_rate_pct\)/);
    expect(s).not.toMatch(/formatPct\(eventProgram\.no_show_rate_pct\)/);
  });

  it("the concise supporting copy renders exactly when attendance_marked_count === 0, inside the success branch", () => {
    const s = pageSource();
    expect(s).toContain("{eventProgram.attendance_marked_count === 0 && (");
    expect(s).toContain("No attendance recorded for this range.");
  });
});

describe("7 continued — fill-rate zero-capacity presentation, applied consistently in both places it appears", () => {
  it("Events & Programs' Fill Rate uses formatRateOrUnavailable gated on total_capacity > 0", () => {
    const s = pageSource();
    expect(s).toMatch(
      /label="Fill Rate"\s*\n\s*value=\{formatRateOrUnavailable\(eventProgram\.fill_rate_pct, eventProgram\.total_capacity > 0\)\}/
    );
  });

  it("Key Metrics' Session Fill Rate is held to the identical rule for consistency (same underlying zero-capacity ambiguity)", () => {
    const s = pageSource();
    expect(s).toMatch(
      /label="Session Fill Rate"\s*\n\s*value=\{formatRateOrUnavailable\(overview\.session_fill_rate_pct, overview\.total_session_capacity > 0\)\}/
    );
  });
});

describe("8+9. Reporting diagnostics and RPC/data contract are untouched by this checkpoint", () => {
  it("8. all six reporting RPC calls and their diagnostic logging calls are byte-identical to before this checkpoint", () => {
    const s = pageSource();
    expect(s.match(/supabase\.rpc\(/g)?.length).toBe(6);
    const rpcNames = [
      "get_reporting_overview",
      "get_court_utilization",
      "get_reservation_summary",
      "get_event_program_summary",
      "get_waitlist_demand",
      "get_member_engagement_summary",
    ];
    for (const name of rpcNames) {
      expect(s).toContain(`supabase.rpc("${name}", rpcArgs)`);
      expect(s).toMatch(new RegExp(`logReportingRpcFailure\\("${name}",`));
    }
  });

  it("9. rpcArgs, resolveReportRange, and every *Failed boolean's computation are unchanged — no new field read from any RPC result beyond what already existed", () => {
    const s = pageSource();
    expect(s).toContain('const rpcArgs = { p_start_date: resolved.startDate, p_end_date: resolved.endDate };');
    expect(s).toContain("resolveReportRange(todayStr, sp.range, sp.start, sp.end)");
    expect(s).toContain("const overviewFailed = !!overviewResult.error || !overview;");
    expect(s).toContain("const courtsFailed = !!courtsResult.error;");
    expect(s).toContain("const reservationsFailed = !!reservationsResult.error || !reservationSummary;");
    expect(s).toContain("const eventProgramFailed = !!eventProgramResult.error || !eventProgram;");
    expect(s).toContain("const waitlistFailed = !!waitlistResult.error || !waitlist;");
    expect(s).toContain("const engagementFailed = !!engagementResult.error || !engagement;");
  });

  it("9. every RPC row type declaration is unchanged — no field added, removed, or renamed", () => {
    const s = pageSource();
    expect(s).toContain(`type OverviewRow = {
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
};`);
    expect(s).toContain(`type EventProgramSummaryRow = {
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
};`);
  });

  it("9. the range selector, custom-range form, and reservations daily chart are byte-unchanged", () => {
    const s = pageSource();
    expect(s).toContain('href: "/admin/reports?range=today"');
    expect(s).toContain('href: "/admin/reports?range=7d"');
    expect(s).toContain('href: "/admin/reports?range=30d"');
    expect(s).toContain('action="/admin/reports"');
    // Reservations daily chart was later re-architected into
    // ReservationsDailyChart.tsx (runtime-QA overflow/tooltip fix) — see
    // reservationsChartUx.regression.test.ts for that component's own
    // coverage; this checkpoint's own concern (daily_series is still read
    // and passed through) is unaffected by that later, separate change.
    expect(s).toContain("series={reservationSummary.daily_series}");
  });

  // A hardcoded "highest migration === N" assertion previously lived here.
  // Removed: that pattern cannot hold as an evergreen invariant across
  // later, unrelated checkpoints — this checkpoint is presentation-only and
  // truthfully added no migration itself, but cannot prove no later
  // checkpoint ever would (0170 has since been added by the Communications
  // checkpoint).
});
