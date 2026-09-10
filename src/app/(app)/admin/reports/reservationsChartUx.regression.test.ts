import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  formatChartDate,
  dayDetailLines,
  getChartAxisLabels,
  defaultActiveDayIndex,
  type DailySeriesPoint,
} from "./reservationsChart";

// Reservations daily chart — readability refinement, twice corrected after
// runtime QA:
//
// (1) Overflow/tooltip architecture fix: the original DailyBarSeries put an
//     absolutely-positioned per-bar tooltip INSIDE the overflow-x-auto
//     scroll track, inflating its scrollable area (spurious horizontal AND
//     vertical scrollbars) and getting clipped by it. Fixed by
//     ReservationsDailyChart.tsx (a small "use client" component): ONE
//     shared active-day detail in a non-scrolling header, driven by a
//     single activeIndex state hover/focus/click on any bar updates.
//
// (2) Visual-polish fix (this file's current scope): the active day had no
//     visible highlight of its own, and per-bar-column sparse date labels
//     wrapped into two stacked lines under narrow columns, competing with
//     the bars. Fixed by: a restrained accent-tinted background/ring on the
//     active day's own button (bar colors themselves untouched), and
//     replacing per-column labels entirely with ONE independent start/
//     midpoint/end orientation axis below the track (getChartAxisLabels),
//     unrelated to individual columns.
//
// cancelled_count remains a strict SUBSET of total_count (same club-local
// day, same rows, filtered by status — see reservationsChart.ts's header) —
// unchanged by either correction, still proven here.
//
// Pure helpers are real-imported (genuine behavioral coverage).
// ReservationsDailyChart.tsx's JSX wiring is proven by source-inspection —
// this project's test baseline has no jsdom/React rendering, and per this
// directory's established convention, framework-coupled files (even a
// small "use client" one) are inspected as source, not imported and
// rendered.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const PAGE_PATH = "src/app/(app)/admin/reports/page.tsx";
const CHART_COMPONENT_PATH = "src/app/(app)/admin/reports/ReservationsDailyChart.tsx";

function pageSource(): string {
  return readSource(PAGE_PATH);
}

function chartComponentSource(): string {
  return readSource(CHART_COMPONENT_PATH);
}

// Isolates the JSX returned between the non-scrolling header block and the
// scroll container's own opening tag — i.e. everything that must NOT be
// inside the scroll container.
function headerRegion(s: string): string {
  const start = s.indexOf("return (");
  expect(start, "component return not found").toBeGreaterThan(-1);
  const end = s.indexOf('<div className="overflow-x-auto', start);
  expect(end, "overflow-x-auto scroll container not found").toBeGreaterThan(start);
  return s.slice(start, end);
}

// Isolates ONLY the scroll container's own contents — from its opening tag
// to the comment marking the start of the (separately-rendered, non-
// scrolling) orientation axis that immediately follows it in the JSX. This
// is the region that must never contain absolutely-positioned or otherwise-
// overflowing content, and must never contain per-column date labels.
function scrollContainerRegion(s: string): string {
  const start = s.indexOf('<div className="overflow-x-auto');
  expect(start, "overflow-x-auto scroll container not found").toBeGreaterThan(-1);
  const end = s.indexOf("{/* Orientation-only axis", start);
  expect(end, "orientation-axis comment not found after scroll container").toBeGreaterThan(start);
  return s.slice(start, end);
}

// Isolates the standalone orientation-axis block — from its own comment to
// the legend paragraph that follows it. This region sits OUTSIDE (after)
// the scroll container and must never be inside it.
function axisRegion(s: string): string {
  const start = s.indexOf("{/* Orientation-only axis");
  expect(start, "orientation-axis comment not found").toBeGreaterThan(-1);
  const end = s.indexOf('<p className="text-[10px] text-gray-400 dark:text-gray-500 mt-1.5 flex items-center gap-3">', start);
  expect(end, "legend paragraph not found after axis block").toBeGreaterThan(start);
  return s.slice(start, end);
}

describe("dayDetailLines — the locked four-line active-day detail format (9. exact date still appears)", () => {
  it("exact date, Total, Cancelled, and Cancellation rate all appear, in order, matching the locked example shape", () => {
    // Locked example from the spec: Sep 7 / Total: 8 / Cancelled: 5 / rate 62.5%.
    const lines = dayDetailLines("2026-09-07", 8, 5);
    expect(lines).toEqual(["Sep 7", "Total: 8", "Cancelled: 5", "Cancellation rate: 62.5%"]);
  });

  it("cancellation rate is correctly derived as a share of total, not of some other denominator", () => {
    expect(dayDetailLines("2026-09-07", 4, 1)[3]).toBe("Cancellation rate: 25.0%");
    expect(dayDetailLines("2026-09-07", 3, 3)[3]).toBe("Cancellation rate: 100.0%");
    expect(dayDetailLines("2026-09-07", 10, 0)[3]).toBe("Cancellation rate: 0.0%");
  });

  it("a zero-total day never divides by zero — renders '—', reusing the page's own locked zero-sample rule, not NaN/Infinity", () => {
    const lines = dayDetailLines("2026-09-07", 0, 0);
    expect(lines).toEqual(["Sep 7", "Total: 0", "Cancelled: 0", "Cancellation rate: —"]);
  });
});

describe("formatChartDate — the sole date formatter, optional year for cross-year disambiguation", () => {
  it("omits the year by default", () => {
    expect(formatChartDate("2026-01-01")).toBe("Jan 1");
    expect(formatChartDate("2026-12-31")).toBe("Dec 31");
  });

  it("includes the year when explicitly requested", () => {
    expect(formatChartDate("2026-12-31", { includeYear: true })).toBe("Dec 31, 2026");
  });

  it("is parsed as plain calendar components, never reinterpreted through any timezone", () => {
    expect(dayDetailLines("2026-12-31", 1, 0)[0]).toBe("Dec 31");
  });
});

describe("6+7+8. getChartAxisLabels — start/midpoint/end orientation, cross-year disambiguation", () => {
  const day = (local_date: string): DailySeriesPoint => ({ local_date, total_count: 0, cancelled_count: 0 });

  it("6. empty series -> no labels", () => {
    expect(getChartAxisLabels([])).toEqual([]);
  });

  it("7. one-day range -> a single label for that day", () => {
    const labels = getChartAxisLabels([day("2026-09-09")]);
    expect(labels).toEqual([{ index: 0, label: "Sep 9" }]);
  });

  it("6. two-day range -> start and end only, no synthetic midpoint between two adjacent days", () => {
    const labels = getChartAxisLabels([day("2026-09-08"), day("2026-09-09")]);
    expect(labels).toEqual([
      { index: 0, label: "Sep 8" },
      { index: 1, label: "Sep 9" },
    ]);
  });

  it("6. multi-day range (30 days) -> exactly start, midpoint, and end", () => {
    // 2026-08-11 through 2026-09-09 inclusive = 30 days. Built via Date.UTC
    // arithmetic (never manual month-rollover string math) so the fixture
    // itself can't be wrong about calendar boundaries.
    const series = Array.from({ length: 30 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 7, 11 + i)); // month 7 = August (0-indexed)
      const dateStr = d.toISOString().slice(0, 10);
      return day(dateStr);
    });
    // Locked example from the spec: 30-day -> Aug 11 / Aug 25 / Sep 9.
    const labels = getChartAxisLabels(series);
    expect(labels.length).toBe(3);
    expect(labels[0]).toEqual({ index: 0, label: "Aug 11" });
    expect(labels[1]).toEqual({ index: 14, label: "Aug 25" });
    expect(labels[2]).toEqual({ index: 29, label: "Sep 9" });
  });

  it("6. 7-day range -> matches the spec's own locked example (Sep 3 / Sep 6 / Sep 9)", () => {
    const series = [3, 4, 5, 6, 7, 8, 9].map(d => day(`2026-09-0${d}`));
    const labels = getChartAxisLabels(series);
    expect(labels.map(l => l.label)).toEqual(["Sep 3", "Sep 6", "Sep 9"]);
  });

  it("8. a range spanning a year boundary includes the year on every label, so two same-looking month/day pairs are never ambiguous", () => {
    const series = [day("2025-12-20"), day("2025-12-27"), day("2026-01-03")];
    const labels = getChartAxisLabels(series);
    expect(labels.every(l => /\d{4}/.test(l.label))).toBe(true);
    expect(labels[0].label).toBe("Dec 20, 2025");
    expect(labels[2].label).toBe("Jan 3, 2026");
  });

  it("8. a range entirely within one year never includes the year", () => {
    const series = [day("2026-08-11"), day("2026-08-25"), day("2026-09-09")];
    const labels = getChartAxisLabels(series);
    expect(labels.every(l => !/\d{4}/.test(l.label))).toBe(true);
  });
});

describe("defaultActiveDayIndex — sensible initial state before any interaction", () => {
  const day = (local_date: string, total_count: number, cancelled_count = 0): DailySeriesPoint => ({
    local_date,
    total_count,
    cancelled_count,
  });

  it("picks the MOST RECENT day with at least one reservation, not simply the last day in the series", () => {
    const series = [day("2026-09-01", 3), day("2026-09-02", 0), day("2026-09-03", 5), day("2026-09-04", 0)];
    expect(defaultActiveDayIndex(series)).toBe(2); // 2026-09-03, index 2
  });

  it("returns null when no day in the whole range has any reservations", () => {
    const series = [day("2026-09-01", 0), day("2026-09-02", 0)];
    expect(defaultActiveDayIndex(series)).toBeNull();
  });

  it("returns null for an empty series", () => {
    expect(defaultActiveDayIndex([])).toBeNull();
  });
});

describe("cancelled remains a subset of total — never added, always driven by the existing fields", () => {
  it("Total and Cancelled bars are each scaled against the SAME max — cancelledPct is not (total - cancelled) and is not added to totalPct", () => {
    const s = chartComponentSource();
    expect(s).toContain("const totalPct = (p.total_count / max) * 100;");
    expect(s).toContain("const cancelledPct = (p.cancelled_count / max) * 100;");
    expect(s).not.toMatch(/totalPct \+ cancelledPct/);
    expect(s).not.toMatch(/cancelledPct \+ totalPct/);
  });

  it("both bars are still driven directly by the existing daily_series fields (p.total_count / p.cancelled_count) — no new field invented", () => {
    const s = chartComponentSource();
    expect(s).toContain("p.total_count");
    expect(s).toContain("p.cancelled_count");
  });

  it("DailySeriesPoint's shape is declared once (reservationsChart.ts) and imported, not redeclared", () => {
    const shared = readSource("src/app/(app)/admin/reports/reservationsChart.ts");
    expect(shared).toContain(`export type DailySeriesPoint = {
  local_date: string;
  total_count: number;
  cancelled_count: number;
};`);
    expect(pageSource()).toContain('import type { DailySeriesPoint } from "./reservationsChart";');
    expect(chartComponentSource()).toContain("type DailySeriesPoint,");
  });
});

describe("10. desktop overflow architecture remains unchanged — active-day detail outside the scroll track; no vertical scroll", () => {
  it("the active-day detail block is rendered in the header region, BEFORE the scroll container's own opening tag", () => {
    const header = headerRegion(chartComponentSource());
    expect(header).toContain("Reservations by day");
    expect(header).toContain("activeDetail");
  });

  it("the scroll container contains no absolutely/fixed-positioned element — nothing inside it can overflow its own box", () => {
    const scroll = scrollContainerRegion(chartComponentSource());
    expect(scroll).not.toMatch(/\babsolute\b/);
    expect(scroll).not.toMatch(/\bfixed\b/);
    expect(scroll).not.toMatch(/bottom-full/);
  });

  it("the scroll container is overflow-x only — overflow-y is explicitly hidden, and no overflow-y-auto/scroll class exists anywhere in the component", () => {
    const s = chartComponentSource();
    expect(s).toContain('className="overflow-x-auto overflow-y-hidden"');
    expect(s).not.toMatch(/overflow-y-auto|overflow-y-scroll/);
  });

  it("no min-width is forced on the track merely to preserve scrolling — sizing is w-max (fits content), not an artificially large fixed width", () => {
    const scroll = scrollContainerRegion(chartComponentSource());
    expect(scroll).toContain("w-max");
    expect(scroll).not.toMatch(/min-w-\[\d{3,}/); // no large arbitrary min-width hack
  });

  it("the orientation axis itself is OUTSIDE the scroll container, not inside it", () => {
    const scroll = scrollContainerRegion(chartComponentSource());
    expect(scroll).not.toContain("getChartAxisLabels");
    expect(scroll).not.toContain("axisLabels.map");
    const axis = axisRegion(chartComponentSource());
    expect(axis).toContain("axisLabels.map");
  });
});

describe("4+5. per-column sparse date labels are gone; no NBSP placeholders remain", () => {
  it("sparseDateLabelIndices no longer exists as a function/export/usage anywhere in this directory's chart code (a historical mention in an explanatory comment is fine)", () => {
    expect(chartComponentSource()).not.toMatch(/sparseDateLabelIndices|showLabel/);
    expect(readSource("src/app/(app)/admin/reports/reservationsChart.ts")).not.toMatch(
      /export function sparseDateLabelIndices/
    );
  });

  it("no per-column date label or NBSP/space placeholder is rendered inside the scroll container", () => {
    const scroll = scrollContainerRegion(chartComponentSource());
    expect(scroll).not.toMatch(/formatChartDate\(p\.local_date\)/);
    expect(scroll).not.toContain('" "');
    // The bar column is a single <button> now — no sibling <span> holding a
    // per-day label or blank placeholder underneath it.
    expect(scroll).not.toMatch(/<span[^>]*>\s*( |&nbsp;)?\s*<\/span>\s*<\/div>/);
  });
});

describe("1+2. active day receives a dedicated visual-state treatment; non-active days do not", () => {
  it("1. the active bar-pair column gets a restrained NEUTRAL background wash — no ring, no accent tint (accent already colors the Total bar, so a persistent accent ring/tint would compete with the data series)", () => {
    const s = chartComponentSource();
    expect(s).toContain("const isActive = activeIndex === i;");
    // Solid (not translucent) neutral washes — the original translucent
    // bg-gray-100/70 / dark:bg-gray-800/70 read as effectively invisible in
    // dark mode against the surrounding dark surface; these solid grays
    // give clearer contrast against both light and dark surfaces.
    expect(s).toMatch(/isActive \? "bg-gray-200 dark:bg-gray-700" : ""/);
    expect(s).not.toMatch(/isActive \?[^"]*"[^"]*ring-1[^"]*accent/);
  });

  it("2. the non-active branch of that same ternary applies NO treatment — the highlight is exclusively conditional on isActive", () => {
    const s = chartComponentSource();
    const match = s.match(/isActive \? "([^"]*)" : "([^"]*)"/);
    expect(match, "active/inactive ternary not found").not.toBeNull();
    expect(match![1].length).toBeGreaterThan(0); // active branch has real classes
    expect(match![2]).toBe(""); // inactive branch is empty — no treatment
  });

  it("the actual Total/Cancelled bar segment colors are never touched by the active-day treatment — accent stays accent, red stays red, unconditionally", () => {
    const s = chartComponentSource();
    // bg-accent (Total) and bg-red-400 (Cancelled) on the bar segments are
    // NOT inside any isActive-conditional expression.
    expect(s).toContain('className="w-full rounded-t-sm bg-accent"');
    expect(s).toContain('className="w-full rounded-t-sm bg-red-400 dark:bg-red-500"');
  });

  it("the keyboard focus-visible ring remains present, independent of the active-day background classes, and uses `brand`/`brand-tint` (Court Time's own fixed brand green and its dark-surface derivative) rather than `accent` — accent already colors the Total bar, so a same-colored focus ring would visually compete with the data series", () => {
    const s = chartComponentSource();
    expect(s).toMatch(/focus-visible:ring-2 focus-visible:ring-brand dark:focus-visible:ring-brand-tint focus-visible:ring-offset-1/);
    expect(s).not.toMatch(/focus-visible:ring-accent/);
  });
});

describe("3. hover/focus/click still share activeIndex", () => {
  it("keyboard focus updates the active day", () => {
    expect(chartComponentSource()).toContain("onFocus={() => setActiveIndex(i)}");
  });

  it("mouse hover updates the active day", () => {
    expect(chartComponentSource()).toContain("onMouseEnter={() => setActiveIndex(i)}");
  });

  it("click/tap updates the active day (mobile has no hover — tap fires a click event on a <button>)", () => {
    expect(chartComponentSource()).toContain("onClick={() => setActiveIndex(i)}");
  });

  it("each bar remains a real, focusable <button> with an accessible name carrying the full date/total/cancelled/rate detail", () => {
    const s = chartComponentSource();
    expect(s).toMatch(/<button[\s\S]{0,80}type="button"/);
    expect(s).toContain('aria-label={detail.join(", ")}');
  });

  it("state is the smallest possible — a single activeIndex, nothing broader", () => {
    const s = chartComponentSource();
    expect(s.match(/= useState[<(]/g)?.length).toBe(1);
    expect(s).toContain("useState<number | null>(() => defaultActiveDayIndex(series));");
  });

  it('"use client" is present on this component, and ONLY this component — page.tsx itself is not a client component', () => {
    expect(chartComponentSource().trimStart().startsWith('"use client";')).toBe(true);
    expect(pageSource()).not.toContain('"use client"');
  });
});

describe("responsive axis behavior — midpoint hides on narrow widths via CSS only, no viewport JS", () => {
  it("the axis uses justify-between (or justify-center for a single label), never a fixed pixel layout", () => {
    const axis = axisRegion(chartComponentSource());
    expect(axis).toMatch(/justify-between|justify-center/);
  });

  it("the midpoint label (only present for a 3-label axis) is hidden below the sm breakpoint via a plain CSS class — no window/matchMedia/resize listener anywhere in the component", () => {
    const s = chartComponentSource();
    expect(s).toContain('axisLabels.length === 3 && idx === 1 ? "hidden sm:inline" : undefined');
    expect(s).not.toMatch(/matchMedia|addEventListener\(.resize/);
  });
});

describe("legend and chart title wording", () => {
  it("the chart is labeled 'Reservations by day' and the legend uses the locked wording", () => {
    const s = chartComponentSource();
    expect(s).toContain("Reservations by day");
    expect(s).toContain("Total reservations");
    expect(s).toMatch(/<span className="inline-block w-2 h-2 rounded-sm bg-red-400 dark:bg-red-500" \/> Cancelled/);
  });
});

describe("11. no RPC/data-contract change", () => {
  it("get_reservation_summary is still called with the same rpcArgs, and daily_series is still read the same way, via the new component", () => {
    const s = pageSource();
    expect(s).toContain('supabase.rpc("get_reservation_summary", rpcArgs)');
    expect(s).toContain("<ReservationsDailyChart series={reservationSummary.daily_series} />");
  });

  it("all six reporting RPC calls and their diagnostic logging remain exactly as before this checkpoint", () => {
    const s = pageSource();
    // Admin Cleanup Checkpoint 6 legitimately added a 7th diagnostic-logged
    // read for the new Financial Summary section — but it goes through
    // getFinancialRangeSummary (../payments/financialSummary.ts), never a
    // direct supabase.rpc( call written in page.tsx itself, so THAT count
    // is still exactly 6; only logReportingRpcFailure( grew to 7. This
    // checkpoint's own concern (the reservations chart) is unaffected.
    expect(s.match(/supabase\.rpc\(/g)?.length).toBe(6);
    expect(s.match(/logReportingRpcFailure\(/g)?.length).toBe(7);
  });

  it("the old DailyBarSeries function no longer exists anywhere in page.tsx", () => {
    expect(pageSource()).not.toMatch(/function DailyBarSeries/);
  });
});
