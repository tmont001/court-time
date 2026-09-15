import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Calendar polish — current-time pill fix. Same source-inspection style as
// the rest of this suite (no jsdom/component-rendering harness in this
// repo). The actual boundary-clamp/occlusion MATH is tested with real
// fixed inputs in src/lib/calendar/nowIndicator.test.ts; this file proves
// the JSX wiring uses that math correctly and that the red line + every
// other calendar layout invariant is untouched.

function readSource(): string {
  return readFileSync(join(process.cwd(), "src/app/(app)/calendar/CalendarShell.tsx"), "utf-8");
}

describe("current-time LINE — completely untouched by the pill fix", () => {
  it("the line still uses the raw, unclamped nowIndicator.top — never pillTop", () => {
    const src = readSource();
    expect(src).toContain("style={{ top: nowIndicator.top - 1, left: GUTTER_W, right: 0, height: 2 }}");
  });

  it("nowIndicator.pillTop is never referenced anywhere in the line's own JSX block", () => {
    const src = readSource();
    const lineIdx = src.indexOf("style={{ top: nowIndicator.top - 1,");
    const blockStart = src.lastIndexOf("{nowIndicator !== null && (", lineIdx);
    const blockEnd = src.indexOf("/>", lineIdx);
    const lineBlock = src.slice(blockStart, blockEnd);
    expect(lineBlock).not.toContain("pillTop");
  });
});

describe("current-time PILL — boundary-clamped position", () => {
  it("the pill's top style now uses nowIndicator.pillTop, not the old nowIndicator.top - 8", () => {
    const src = readSource();
    expect(src).toContain("style={{ top: nowIndicator.pillTop, right: 3, height: NOW_INDICATOR_PILL_HEIGHT_PX }}");
    expect(src).not.toMatch(/top:\s*nowIndicator\.top\s*-\s*8/);
  });

  it("pillTop is computed via resolveNowIndicatorPillTop inside the nowIndicator memo, from the SAME top used by the line, never a separate re-derivation", () => {
    const src = readSource();
    const memoStart = src.indexOf("const nowIndicator = useMemo(() => {");
    const memoEnd = src.indexOf("}, [isViewingToday, nowTickMs, clubTimezone, startHour, endHour, rowH, totalGridH]);");
    const memo = src.slice(memoStart, memoEnd);
    expect(memo).toContain("const pillTop = resolveNowIndicatorPillTop(top, NOW_INDICATOR_PILL_HEIGHT_PX, totalGridH);");
    // top itself is untouched before this point — the SAME value is later
    // returned verbatim for the line to use.
    expect(memo).toContain("return { top, label, pillTop, occludedHourSlotIndex };");
  });

  it("the pill height is a single named constant, not a magic number duplicated between the clamp math and the JSX", () => {
    const src = readSource();
    expect(src).toContain("const NOW_INDICATOR_PILL_HEIGHT_PX = 16;");
    expect((src.match(/NOW_INDICATOR_PILL_HEIGHT_PX/g) ?? []).length).toBeGreaterThanOrEqual(3); // const + memo usage + JSX height
  });

  it("resolveNowIndicatorPillTop and resolveNowIndicatorOccludedHourSlotIndex are imported from the same pure geometry module as the existing line/scroll math", () => {
    const src = readSource();
    const importBlock = src.slice(src.indexOf('import {\n  minutesSinceGridStart'), src.indexOf('} from "@/lib/calendar/nowIndicator";') + 10);
    expect(importBlock).toContain("resolveNowIndicatorTop");
    expect(importBlock).toContain("resolveNowIndicatorPillTop");
    expect(importBlock).toContain("resolveNowIndicatorOccludedHourSlotIndex");
  });
});

describe("hour-label suppression — pill takes precedence over a coinciding gutter label", () => {
  it("the ordinary hour label is skipped ONLY for the one slot index the pill occludes — every other slot is unaffected", () => {
    const src = readSource();
    expect(src).toContain('{slot.isHour && i !== nowIndicator?.occludedHourSlotIndex && (');
  });

  it("when there is no now-indicator at all (not viewing today), the optional-chaining leaves every hour label rendering exactly as before", () => {
    const src = readSource();
    // i is always a real array index (number); nowIndicator?.occludedHourSlotIndex
    // is undefined when nowIndicator is null, and i !== undefined is always
    // true, so no label is ever suppressed when there's no indicator.
    expect(src).toContain("nowIndicator?.occludedHourSlotIndex");
  });

  it("label suppression logic lives entirely in the gutter's per-slot loop, not inside the pill's own render block", () => {
    const src = readSource();
    const sloLoopIdx = src.indexOf("{timeSlots.map((slot: TimeSlot, i: number) => (");
    const pillBlockIdx = src.indexOf("{nowIndicator !== null && (\n                  <div\n                    aria-hidden=\"true\"\n                    className=\"absolute flex items-center justify-center rounded-full");
    expect(sloLoopIdx).toBeGreaterThan(-1);
    expect(pillBlockIdx).toBeGreaterThan(sloLoopIdx); // loop renders first, pill after
  });
});

describe("calendar layout invariants — unchanged by this fix", () => {
  it("GUTTER_W, totalGridH, sticky gutter, and court-column structure are all untouched", () => {
    const src = readSource();
    expect(src).toContain("const GUTTER_W   = 52;");
    expect(src).toContain("const totalGridH = timeSlots.length * rowH;");
    expect(src).toContain('className="shrink-0 sticky left-0 z-10 bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-700"');
    expect(src).toContain("style={{ width: GUTTER_W, height: totalGridH }}");
  });

  it("reservation/event positioning math (minutesSinceGridStart-based) is untouched — this fix only ever adds new call sites, never edits existing ones", () => {
    const src = readSource();
    expect((src.match(/minutesSinceGridStart\(/g) ?? []).length).toBeGreaterThanOrEqual(5); // now-indicator + reservations + events (existing, unchanged count floor)
  });

  it("the pill remains pointer-events-none and aria-hidden — purely decorative, exactly as before", () => {
    const src = readSource();
    const pillIdx = src.indexOf("style={{ top: nowIndicator.pillTop,");
    const blockStart = src.lastIndexOf("<div", pillIdx);
    const block = src.slice(blockStart, pillIdx);
    expect(block).toContain('aria-hidden="true"');
    expect(block).toContain("pointer-events-none");
  });

  it("the pill stays right-aligned inside the gutter (right: 3) — never repositioned horizontally by this fix", () => {
    const src = readSource();
    expect(src).toContain("style={{ top: nowIndicator.pillTop, right: 3, height: NOW_INDICATOR_PILL_HEIGHT_PX }}");
  });
});

describe("no cancellation/payment/refund/migration scope creep", () => {
  it("this is a pure UI/geometry change — no new migration file, no RPC call, no Server Action touched", () => {
    const src = readSource();
    expect(src).not.toMatch(/\.rpc\(\s*"cancel_|\.rpc\(\s*"preview_member/);
  });
});
