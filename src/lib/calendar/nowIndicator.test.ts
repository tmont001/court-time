import { describe, expect, it } from "vitest";
import {
  minutesSinceGridStart,
  getClubLocalDateISO,
  resolveNowIndicatorTop,
  resolveSmartScrollTop,
} from "./nowIndicator";

// Phase 35D — genuine behavior-level tests for the pure timezone/geometry
// logic behind the calendar grid's live "now" indicator and its one-shot
// smart initial vertical scroll. Every instant here is a fixed Date;
// nothing in this file depends on the real wall clock.

const NY = "America/New_York";

describe("minutesSinceGridStart — club-timezone minute calculation", () => {
  it("returns 0 exactly at the grid's start hour", () => {
    // 2026-06-15T12:00:00Z is 8:00 AM in America/New_York (EDT, UTC-4).
    expect(minutesSinceGridStart(new Date("2026-06-15T12:00:00.000Z"), NY, 8)).toBe(0);
  });

  it("returns elapsed minutes for a time after the grid start", () => {
    // 8:45 AM EDT
    expect(minutesSinceGridStart(new Date("2026-06-15T12:45:00.000Z"), NY, 8)).toBe(45);
  });

  it("returns a negative value for a time before the grid start", () => {
    // 6:00 AM EDT, grid starts at 8 AM
    expect(minutesSinceGridStart(new Date("2026-06-15T10:00:00.000Z"), NY, 8)).toBe(-120);
  });

  it("is evaluated in the CLUB timezone, not any implicit local/UTC reading", () => {
    // Same UTC instant, two different club timezones, two different results.
    const instant = new Date("2026-06-15T12:00:00.000Z"); // 8:00 AM EDT / 5:00 AM PDT
    expect(minutesSinceGridStart(instant, "America/New_York", 8)).toBe(0);
    expect(minutesSinceGridStart(instant, "America/Los_Angeles", 8)).toBe(-180);
  });
});

describe("getClubLocalDateISO — club-timezone determination of 'today'", () => {
  it("returns the club-local calendar date for a UTC instant", () => {
    expect(getClubLocalDateISO(new Date("2026-06-15T12:00:00.000Z"), NY)).toBe("2026-06-15");
  });

  it("CRITICAL: a UTC instant that has already crossed into the next UTC day can still be 'today' in an earlier timezone, and vice versa", () => {
    // 2026-06-16T02:00:00Z is 2026-06-15 10:00 PM in America/New_York (still June 15 locally).
    expect(getClubLocalDateISO(new Date("2026-06-16T02:00:00.000Z"), NY)).toBe("2026-06-15");
    // The same instant in a club timezone far enough east is already June 16.
    expect(getClubLocalDateISO(new Date("2026-06-16T02:00:00.000Z"), "Pacific/Auckland")).toBe("2026-06-16");
  });

  it("never derives from the browser/device local timezone — the timeZone argument is the sole source of truth", () => {
    const a = getClubLocalDateISO(new Date("2026-06-15T12:00:00.000Z"), "America/New_York");
    const b = getClubLocalDateISO(new Date("2026-06-15T12:00:00.000Z"), "Pacific/Auckland");
    expect(a).not.toBe(b);
  });
});

describe("resolveNowIndicatorTop — position calculation and outside-grid handling", () => {
  const range = { gridStartHour: 8, gridEndHour: 20, rowHeightPx: 48 };

  it("computes pixel top proportional to elapsed minutes / 30-minute rows", () => {
    // 30 minutes in -> exactly one row height.
    expect(resolveNowIndicatorTop(30, range)).toBe(48);
    // 90 minutes in -> exactly three row heights.
    expect(resolveNowIndicatorTop(90, range)).toBe(144);
  });

  it("returns 0 exactly at the grid start", () => {
    expect(resolveNowIndicatorTop(0, range)).toBe(0);
  });

  it("returns a position for the last minute still strictly before the grid end (exclusive boundary)", () => {
    // gridEndHour=20 (8:00 PM), gridStartHour=8 -> 719 minutes in = 7:59 PM, still allowed.
    expect(resolveNowIndicatorTop(719, range)).toBe((719 / 30) * 48);
  });

  it("CRITICAL: returns null (no indicator) EXACTLY at the grid end boundary — gridEndHour is exclusive, not inclusive", () => {
    // gridEndHour=20, gridStartHour=8 -> 720 minutes total -> exactly 8:00 PM must NOT render.
    expect(resolveNowIndicatorTop(720, range)).toBeNull();
  });

  it("CRITICAL: returns null (no indicator) before the grid's start hour", () => {
    expect(resolveNowIndicatorTop(-1, range)).toBeNull();
  });

  it("CRITICAL: returns null (no indicator) after the grid's end hour", () => {
    expect(resolveNowIndicatorTop(721, range)).toBeNull();
  });

  it("CRITICAL: returns null for a degenerate/closed-day grid (end <= start)", () => {
    expect(resolveNowIndicatorTop(0, { gridStartHour: 9, gridEndHour: 9, rowHeightPx: 48 })).toBeNull();
    expect(resolveNowIndicatorTop(0, { gridStartHour: 9, gridEndHour: 8, rowHeightPx: 48 })).toBeNull();
  });

  it("scales with the grid's actual current row height, not a fixed pixel value", () => {
    expect(resolveNowIndicatorTop(60, { ...range, rowHeightPx: 40 })).toBe(80);
    expect(resolveNowIndicatorTop(60, { ...range, rowHeightPx: 64 })).toBe(128);
  });
});

describe("resolveSmartScrollTop — smart-scroll target and clamping", () => {
  const range = { gridStartHour: 8, gridEndHour: 20, rowHeightPx: 48, contextMinutes: 60, scrollHeight: 24 * 48, clientHeight: 400 };

  it("scrolls to (now's top - context) when there is room above and below", () => {
    // now at 3 hours in (180 min) -> top = 6 rows * 48 = 288; context = 2 rows * 48 = 96.
    expect(resolveSmartScrollTop(180, range)).toBe(288 - 96);
  });

  it("clamps to 0 when now is near the very start of the grid (not a negative scrollTop)", () => {
    // now at 30 min in -> top = 48; context = 96 -> would be -48, clamped to 0.
    expect(resolveSmartScrollTop(30, range)).toBe(0);
  });

  it("clamps to the container's max scrollable range when now is near the very end of the grid", () => {
    const maxScrollTop = range.scrollHeight - range.clientHeight;
    // now essentially at the grid's end.
    expect(resolveSmartScrollTop(710, range)).toBe(maxScrollTop);
  });

  it("returns 0 (not null) when the content is shorter than the viewport (nothing to scroll)", () => {
    const shortRange = { ...range, scrollHeight: 300, clientHeight: 400 };
    expect(resolveSmartScrollTop(180, shortRange)).toBe(0);
  });

  it("CRITICAL: returns null (leave the default position alone) when now is outside the rendered grid", () => {
    expect(resolveSmartScrollTop(-30, range)).toBeNull();
    expect(resolveSmartScrollTop(800, range)).toBeNull();
  });

  it("CRITICAL: returns null EXACTLY at the grid end boundary, matching resolveNowIndicatorTop's exclusive gridEndHour", () => {
    // gridEndHour=20, gridStartHour=8 -> 720 minutes total -> exactly 8:00 PM must not scroll.
    expect(resolveSmartScrollTop(720, range)).toBeNull();
  });

  it("derives the offset from the grid's actual row height rather than a hardcoded pixel value", () => {
    const a = resolveSmartScrollTop(300, { ...range, rowHeightPx: 40 });
    const b = resolveSmartScrollTop(300, { ...range, rowHeightPx: 64 });
    expect(a).not.toBe(b);
  });
});

describe("today vs non-today gating (composition, as used by the calendar shell)", () => {
  it("a non-today date should never resolve a smart-scroll target or indicator position — verified at the call-site level via getClubLocalDateISO", () => {
    const now = new Date("2026-06-15T15:00:00.000Z"); // 11:00 AM EDT
    const viewedDateISO = "2026-06-14"; // a different, non-today date
    const isToday = getClubLocalDateISO(now, NY) === viewedDateISO;
    expect(isToday).toBe(false);
    // The calendar shell must skip resolveNowIndicatorTop/resolveSmartScrollTop
    // entirely when isToday is false — nothing further to assert here since
    // those functions have no date-identity concept of their own by design;
    // "today" is decided once, at the call site, from getClubLocalDateISO.
  });

  it("the same instant IS today when it matches the viewed date's club-local ISO", () => {
    const now = new Date("2026-06-15T15:00:00.000Z");
    expect(getClubLocalDateISO(now, NY) === "2026-06-15").toBe(true);
  });
});
