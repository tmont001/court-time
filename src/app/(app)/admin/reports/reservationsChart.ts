/**
 * Reservations daily chart — readability refinement. Pure, dependency-free
 * helpers (same "extracted, real-imported, unit-testable" shape as
 * dateRange.ts/reportingDiagnostics.ts/reportPresentation.ts in this
 * directory) — presentation only, never a change to daily_series' own
 * semantics or the RPC that produces it.
 *
 * daily_series semantics (get_reservation_summary, 0096, unchanged by this
 * checkpoint): total_count is every reservation that started that club-local
 * day, regardless of status; cancelled_count is the FILTERED subset of that
 * SAME day's rows whose status = 'cancelled' — cancelled_count is always
 * <= total_count, drawn from the same population, never a separate/additive
 * count. Any visualization must size cancelled independently against the
 * same shared scale, never stack it on top of (add it to) total's own bar.
 */

import { formatRateOrUnavailable } from "./reportPresentation";

/** Shared with page.tsx (the RPC row shape) and ReservationsDailyChart.tsx
 * (the client component that renders it) — one definition, not duplicated. */
export type DailySeriesPoint = {
  local_date: string;
  total_count: number;
  cancelled_count: number;
};

/** "YYYY-MM-DD" -> "Sep 7" (or "Sep 7, 2026" with `includeYear`), parsed as
 * plain calendar-date components (not re-interpreted through any timezone)
 * — same explicit y/m/d + Date.UTC technique dateRange.ts already
 * established for this exact string shape, so this never depends on the
 * reader's or server's runtime timezone. The sole date formatter in this
 * module — both the active-day detail and the chart axis route through it,
 * so date formatting is never duplicated. */
export function formatChartDate(dateStr: string, options?: { includeYear?: boolean }): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: options?.includeYear ? "numeric" : undefined,
    timeZone: "UTC",
  });
}

/**
 * The exact four-line hover/focus detail for one day, in the locked format:
 *   <date>
 *   Total: <count>
 *   Cancelled: <count>
 *   Cancellation rate: <percentage>
 * A zero-total day never divides by zero — reuses formatRateOrUnavailable's
 * already-locked "no sample -> —" rule (same helper the rest of this page's
 * rates use) rather than a separate ad-hoc zero-guard.
 */
export function dayDetailLines(dateStr: string, totalCount: number, cancelledCount: number): string[] {
  const rate = totalCount > 0 ? (cancelledCount / totalCount) * 100 : 0;
  return [
    formatChartDate(dateStr),
    `Total: ${totalCount}`,
    `Cancelled: ${cancelledCount}`,
    `Cancellation rate: ${formatRateOrUnavailable(rate, totalCount > 0)}`,
  ];
}

export interface ChartAxisLabel {
  /** Index into the series this label refers to — lets the caller key/
   * dedupe without re-deriving which day a label belongs to. */
  index: number;
  /** Fully formatted, ready to render — includes the year when (and only
   * when) the axis as a whole spans a year boundary, so two same-looking
   * "Dec 31"/"Jan 1" labels are never ambiguous about which year is which. */
  label: string;
}

/**
 * Runtime-QA correction: per-bar-column sparse date labels (one under every
 * Nth bar, via the now-removed sparseDateLabelIndices) read as visually
 * intrusive — a narrow bar column forced "Aug 17" to wrap into two stacked
 * lines, competing with the bars themselves. Replaced with ONE independent
 * orientation axis, entirely decoupled from individual bar columns: at most
 * three labels — start, midpoint, end — meant to be rendered in a single
 * row below (not inside) the bar track. The exact date for any given day
 * already lives in the active-day header detail; this axis is orientation
 * only, never a per-day lookup.
 *
 * - Empty series -> no labels.
 * - One day -> a single label (that day).
 * - Two days -> start and end only (no genuine "middle" exists between two
 *   adjacent days worth a separate label).
 * - Three or more days -> start, midpoint, end.
 */
export function getChartAxisLabels(series: DailySeriesPoint[]): ChartAxisLabel[] {
  if (series.length === 0) return [];

  const lastIndex = series.length - 1;
  const startYear = series[0].local_date.slice(0, 4);
  const endYear = series[lastIndex].local_date.slice(0, 4);
  const spansYears = startYear !== endYear;

  const label = (index: number): ChartAxisLabel => ({
    index,
    label: formatChartDate(series[index].local_date, { includeYear: spansYears }),
  });

  if (series.length === 1) {
    return [label(0)];
  }

  if (series.length === 2) {
    return [label(0), label(lastIndex)];
  }

  const midIndex = Math.floor(lastIndex / 2);
  return [label(0), label(midIndex), label(lastIndex)];
}

/**
 * The chart's default active-day index before any hover/focus/tap — the
 * most recent day in the range with at least one reservation, or `null`
 * when nothing in the whole range has any (an empty/quiet range shows no
 * detail rather than a misleading "Aug 1 — Total: 0"). Chosen over "no
 * detail until interaction" so the header region is never empty on first
 * paint for the common case (a range with real activity) — a GM opening
 * Reports sees a populated, informative header immediately, not a blank
 * "hover a day" prompt.
 */
export function defaultActiveDayIndex(series: DailySeriesPoint[]): number | null {
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i].total_count > 0) return i;
  }
  return null;
}
