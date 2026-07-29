/**
 * Phase 28A: pure calendar-date arithmetic for the Reports page's range
 * selector. Operates only on "YYYY-MM-DD" club-local date strings — no
 * timestamp/timezone conversion happens here (that happens once, server-side,
 * inside club_local_bounds() in the database). Uses Date.UTC arithmetic for
 * day-shifting, the same technique nextCalendarDay() in src/lib/timezone.ts
 * uses, so shifting is never affected by the *server's* runtime timezone.
 */

export type ReportRange = "today" | "7d" | "30d" | "custom";

export interface ResolvedRange {
  range: ReportRange;
  startDate: string; // YYYY-MM-DD, inclusive
  endDate: string; // YYYY-MM-DD, inclusive
  /** True only when range=custom was requested but the input was invalid; startDate/endDate then hold the 7d fallback. */
  invalid: boolean;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_INCLUSIVE_DAYS = 366;

function isValidDateStr(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

function shiftDateStr(dateStr: string, deltaDays: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + deltaDays));
  const yy = shifted.getUTCFullYear();
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(shifted.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function inclusiveDayCount(startDate: string, endDate: string): number {
  const [sy, sm, sd] = startDate.split("-").map(Number);
  const [ey, em, ed] = endDate.split("-").map(Number);
  const startMs = Date.UTC(sy, sm - 1, sd);
  const endMs = Date.UTC(ey, em - 1, ed);
  return Math.round((endMs - startMs) / 86_400_000) + 1;
}

/**
 * Resolves the requested range against `todayStr` (the club-local "today",
 * computed by the caller via toLocaleDateString("en-CA", { timeZone })).
 * Never returns unvalidated custom input — an invalid custom range falls
 * back to the 7d default with `invalid: true` so the caller can render a
 * stable message instead of passing bad values to the RPCs.
 */
export function resolveReportRange(
  todayStr: string,
  searchRange: string | undefined,
  searchStart: string | undefined,
  searchEnd: string | undefined
): ResolvedRange {
  if (searchRange === "today") {
    return { range: "today", startDate: todayStr, endDate: todayStr, invalid: false };
  }

  if (searchRange === "30d") {
    return { range: "30d", startDate: shiftDateStr(todayStr, -29), endDate: todayStr, invalid: false };
  }

  if (searchRange === "custom") {
    const start = searchStart ?? "";
    const end = searchEnd ?? "";
    const validFormat = isValidDateStr(start) && isValidDateStr(end);
    const validOrder = validFormat && end >= start;
    const validSize = validOrder && inclusiveDayCount(start, end) <= MAX_INCLUSIVE_DAYS;

    if (validFormat && validOrder && validSize) {
      return { range: "custom", startDate: start, endDate: end, invalid: false };
    }

    return {
      range: "7d",
      startDate: shiftDateStr(todayStr, -6),
      endDate: todayStr,
      invalid: true,
    };
  }

  // Default (including range=7d or an unrecognized value).
  return { range: "7d", startDate: shiftDateStr(todayStr, -6), endDate: todayStr, invalid: false };
}
