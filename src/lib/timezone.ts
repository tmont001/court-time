/**
 * timezone.ts — dependency-free IANA timezone utilities.
 *
 * Uses Intl.DateTimeFormat.formatToParts exclusively. This makes all functions
 * safe on any server timezone (including UTC on Vercel and local dev machines
 * in non-UTC timezones). The toLocaleString + new Date() "fake-UTC" technique
 * is intentionally NOT used because it depends on the runtime timezone.
 *
 * Exported API
 * ──────────────
 * getZonedDayBoundsUTC(date, timeZone)
 *   Returns the UTC ISO strings for local midnight at the start and end of the
 *   calendar day that `date` falls in, for the given IANA timezone.
 *   Correctly handles spring-forward (23-hour day) and fall-back (25-hour day).
 *
 * localDateTimeToUTC(dateStr, hour, minute, timeZone)
 *   Returns the UTC Date for a local wall-clock time on a given calendar date.
 *   DST-safe: uses the same two-pass localMidnightToUTC algorithm.
 */

// ── Internal helpers ─────────────────────────────────────────────────────────

function makeFmt(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    year:   "numeric",
    month:  "2-digit",
    day:    "2-digit",
    hour:   "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23", // guarantees hour values 0-23; avoids h24 midnight = 24
  });
}

type LocalParts = { y: number; m: number; d: number; h: number; min: number; s: number };

function getLocalParts(utcMs: number, fmt: Intl.DateTimeFormat): LocalParts {
  const parts = fmt.formatToParts(new Date(utcMs));
  const get   = (type: string) =>
    parseInt(parts.find(p => p.type === type)?.value ?? "0", 10);
  const h = get("hour");
  return {
    y: get("year"), m: get("month"), d: get("day"),
    h: h === 24 ? 0 : h, // normalize in case the engine returns 24 for midnight
    min: get("minute"), s: get("second"),
  };
}

/**
 * Convert a "YYYY-MM-DD" local calendar date to the UTC instant of its
 * local midnight in `timeZone`.
 *
 * Algorithm (two iterations):
 *  1. Start at UTC noon of the target date. UTC noon is always the correct
 *     local calendar date in any IANA timezone (UTC noon is never past local
 *     midnight, and always within the same 24-hour window as local noon).
 *  2. Read the local time at that UTC instant using formatToParts.
 *  3. Compute the fake-UTC offset between local time and target midnight;
 *     apply it to shift the estimate toward local midnight.
 *  4. Repeat once to handle the case where the first shift crossed a DST
 *     boundary (e.g., the shift lands at 11 PM the night before instead of
 *     midnight).
 *
 * Why two iterations suffice: DST transitions are discrete jumps of exactly
 * ±1h. After iteration 1 the estimate is within 1h of midnight. Iteration 2
 * resolves the final offset at that close-to-midnight point, always converging.
 */
function localMidnightToUTC(dateStr: string, timeZone: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  const fmt = makeFmt(timeZone);

  // Fake-UTC encoding of the target midnight:
  // Date.UTC(y, m-1, d) gives the millisecond value that, when used in
  // Date.UTC(y, m-1, d, h, min, s), represents "YYYY-MM-DD 00:00:00" as
  // a timestamp-like value — no timezone assumptions involved.
  const targetMs = Date.UTC(y, m - 1, d, 0, 0, 0);

  // Start at UTC noon of the target date (always the correct local date)
  let utcMs = Date.UTC(y, m - 1, d, 12, 0, 0);

  for (let pass = 0; pass < 2; pass++) {
    const p  = getLocalParts(utcMs, fmt);
    // Fake-UTC encoding of the local clock reading at utcMs
    const localMs = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s);
    const delta   = targetMs - localMs;
    if (delta === 0) break; // already at midnight — no further adjustment needed
    utcMs += delta;
  }

  return utcMs;
}

/**
 * Advance a "YYYY-MM-DD" string by exactly one calendar day.
 * Uses Date.UTC arithmetic — no local or IANA timezone involved.
 */
function nextCalendarDay(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1)); // JS Date normalises month/day overflow
  const ny   = next.getUTCFullYear();
  const nm   = String(next.getUTCMonth() + 1).padStart(2, "0");
  const nd   = String(next.getUTCDate()).padStart(2, "0");
  return `${ny}-${nm}-${nd}`;
}

// ── Exported API ─────────────────────────────────────────────────────────────

/**
 * Convert a local wall-clock date+time into its UTC Date. DST-safe.
 *
 * Uses a two-pass correction on the specific target time (not just midnight),
 * so times after a DST transition on spring-forward or fall-back days are
 * correctly resolved. Spring-forward gap times (e.g., 2:30 AM on a US
 * spring-forward date) are silently advanced to the post-transition equivalent
 * (3:30 AM EDT in the two-pass result).
 */
export function localDateTimeToUTC(
  dateStr:  string,
  hour:     number,
  minute:   number,
  timeZone: string,
): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  const fmt = makeFmt(timeZone);
  // Fake-UTC encoding of the target local time (no timezone assumed)
  const targetMs = Date.UTC(y, m - 1, d, hour, minute, 0);
  // Initial estimate: midnight + wall-clock offset (may be off by 1h across DST boundary)
  let utcMs = localMidnightToUTC(dateStr, timeZone) + (hour * 60 + minute) * 60_000;
  // Two correction passes, same technique as localMidnightToUTC.
  for (let pass = 0; pass < 2; pass++) {
    const p      = getLocalParts(utcMs, fmt);
    const localMs = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s);
    const delta   = targetMs - localMs;
    if (delta === 0) break;
    utcMs += delta;
  }
  return new Date(utcMs);
}


export interface DayBoundsUTC {
  /** ISO string for local midnight at the start of the day (inclusive lower bound). */
  start:       string;
  /** ISO string for local midnight at the start of the NEXT day (exclusive upper bound). */
  nextDayStart: string;
}

/**
 * For a given UTC instant (`date`), return the UTC boundaries of the local
 * calendar day it falls in, in the given IANA `timeZone`.
 *
 * Verified correct for:
 * - Normal days (America/New_York summer): 24-hour result
 * - Spring-forward days (America/New_York 2026-03-08): 23-hour result
 * - Fall-back days (America/New_York 2026-11-01): 25-hour result
 * - Non-DST timezones (America/Phoenix): always 24-hour result
 *
 * Use with .gte("starts_at", start) and .lt("starts_at", nextDayStart)
 * — NOT .lte("starts_at", some-23:59:59 string).
 */
export function getZonedDayBoundsUTC(date: Date, timeZone: string): DayBoundsUTC {
  const todayStr    = date.toLocaleDateString("en-CA", { timeZone }); // "YYYY-MM-DD"
  const tomorrowStr = nextCalendarDay(todayStr);
  return {
    start:        new Date(localMidnightToUTC(todayStr,    timeZone)).toISOString(),
    nextDayStart: new Date(localMidnightToUTC(tomorrowStr, timeZone)).toISOString(),
  };
}
