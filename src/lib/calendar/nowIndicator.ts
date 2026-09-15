// nowIndicator.ts — Phase 35D: pure, timezone-aware geometry behind the
// calendar grid's live "now" line and its one-shot smart initial vertical
// scroll.
//
// Deliberately split from CalendarShell.tsx (a large client component) so
// this timing/geometry math is independently unit-tested with fixed dates
// and a fake grid, never the real wall clock or a live DOM ref — the same
// separation-of-concerns already used by @/lib/calendar/feed and
// @/lib/ics for the calendar subscription/export features.
//
// minutesSinceGridStart is moved here verbatim from CalendarShell's own
// former local minsFromViewportTop — identical algorithm, now shared
// between reservation/event positioning (existing, unchanged) and the
// now-indicator/smart-scroll (new), so there is exactly one implementation
// of "minutes since the grid's visible start" in the codebase.

/**
 * Minutes elapsed since `gridStartHour` (club-local wall clock) for a given
 * UTC instant, in the given IANA timezone. Negative when `utcDate` is
 * earlier than the grid's visible start hour.
 */
export function minutesSinceGridStart(utcDate: Date, timeZone: string, gridStartHour: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(utcDate);
  const h = parseInt(parts.find(p => p.type === "hour")?.value ?? "0", 10);
  const m = parseInt(parts.find(p => p.type === "minute")?.value ?? "0", 10);
  const hour = h === 24 ? 0 : h;
  return hour * 60 + m - gridStartHour * 60;
}

/**
 * The club-local calendar date ("YYYY-MM-DD") for a given UTC instant.
 * Used to decide whether the viewed date IS today in the club's own
 * timezone — deliberately never the browser/device local timezone.
 */
export function getClubLocalDateISO(utcDate: Date, timeZone: string): string {
  return utcDate.toLocaleDateString("en-CA", { timeZone });
}

export interface GridRange {
  /** Club-local hour the visible grid starts at (e.g. 8 for 8:00 AM). */
  gridStartHour: number;
  /** Club-local hour the visible grid ends at (exclusive). */
  gridEndHour:   number;
  /** Pixel height of one 30-minute row — the grid's actual, current row height. */
  rowHeightPx:   number;
}

/**
 * Pixel offset from the top of the grid body for the current-time
 * indicator line, or null when `nowMinutes` falls outside the rendered
 * operating-hours grid (before gridStartHour, or at/after gridEndHour) —
 * callers must not render a misleading indicator in that case.
 */
export function resolveNowIndicatorTop(nowMinutes: number, range: GridRange): number | null {
  const totalMinutes = (range.gridEndHour - range.gridStartHour) * 60;
  if (totalMinutes <= 0 || nowMinutes < 0 || nowMinutes >= totalMinutes) return null;
  return (nowMinutes / 30) * range.rowHeightPx;
}

/**
 * Pixel `top` for the now-indicator PILL — centered on `top` (the exact
 * same value used for the line) but clamped so the entire pill stays
 * within the grid's own [0, gridHeightPx] bounds even when `top` is at or
 * near the grid's opening/closing edge. Never changes `top` itself —
 * callers must keep using the raw, unclamped `top` for the line; only the
 * pill's own position is adjusted here.
 */
export function resolveNowIndicatorPillTop(
  top: number,
  pillHeightPx: number,
  gridHeightPx: number,
): number {
  const half = pillHeightPx / 2;
  const min = 0;
  const max = Math.max(gridHeightPx - pillHeightPx, 0);
  return Math.min(Math.max(top - half, min), max);
}

/**
 * The gutter hour-label slot index (matching buildTimeSlots's own isHour
 * convention in CalendarShell.tsx — one label every OTHER 30-minute row,
 * i.e. slot indices 0, 2, 4, ...) whose label the now-indicator pill
 * visually collides with, given the pill's ACTUAL rendered center
 * (post-clamp) — or null when no hour label is close enough to need
 * suppressing. At most one hour-label row can ever be within
 * `pillHeightPx` of the pill's center, so this resolves the single
 * nearest candidate directly rather than scanning every slot.
 */
export function resolveNowIndicatorOccludedHourSlotIndex(
  pillCenter: number,
  rowHeightPx: number,
  pillHeightPx: number,
): number | null {
  const hourRowHeightPx = rowHeightPx * 2;
  const hourRowNumber   = Math.round(pillCenter / hourRowHeightPx);
  const hourSlotTop     = hourRowNumber * hourRowHeightPx;
  if (Math.abs(pillCenter - hourSlotTop) >= pillHeightPx) return null;
  return hourRowNumber * 2;
}

export interface SmartScrollInput extends GridRange {
  /** How many minutes of earlier context to leave visible above "now". */
  contextMinutes: number;
  /** The scroll container's full scrollable content height. */
  scrollHeight:   number;
  /** The scroll container's visible viewport height. */
  clientHeight:   number;
}

/**
 * The one-shot initial scrollTop that positions "now" usefully in view
 * (with `contextMinutes` of earlier context above it), clamped to the
 * container's actual scrollable range — or null when there is nothing
 * sensible to scroll to (now is outside the rendered grid). Callers must
 * leave the existing natural/default scroll position untouched when this
 * returns null, never scroll to an arbitrary or misleading position.
 */
export function resolveSmartScrollTop(nowMinutes: number, input: SmartScrollInput): number | null {
  const top = resolveNowIndicatorTop(nowMinutes, input);
  if (top === null) return null;
  const contextPx    = (input.contextMinutes / 30) * input.rowHeightPx;
  const maxScrollTop = Math.max(input.scrollHeight - input.clientHeight, 0);
  return Math.min(Math.max(top - contextPx, 0), maxScrollTop);
}
