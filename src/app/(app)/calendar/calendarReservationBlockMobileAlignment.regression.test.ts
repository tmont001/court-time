import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Browser QA correction — mobile calendar: an ordinary member_booking
// reservation block's visible label rendered left-aligned while event
// blocks read as visually centered. Fix is a mobile-first Tailwind class
// addition to the SHARED reservation/maintenance blockCls only —
// maintenance/admin (isBlocked) blocks, event blocks, and lesson blocks
// are all explicitly untouched. Source-inspection style, matching this
// project's established convention (no jsdom — see courtsMobileResponsive.
// regression.test.ts for the same precedent on a different page).

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const CALENDAR_SHELL_PATH = "src/app/(app)/calendar/CalendarShell.tsx";

function blockClsBlock(src: string): string {
  const start = src.indexOf("const blockCls = `absolute rounded text-[10px] font-medium px-1 overflow-hidden flex items-center");
  expect(start, "blockCls declaration not found").toBeGreaterThan(-1);
  const end = src.indexOf("const blockStyle = {", start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe("Mobile QA correction: member_booking reservation blocks center their label on mobile, matching event blocks", () => {
  const src = readSource(CALENDAR_SHELL_PATH);
  const block = blockClsBlock(src);

  it("adds mobile-first centering (no prefix = smallest breakpoint) for the non-blocked (member_booking) case", () => {
    expect(block).toContain('!isBlocked ? "justify-center text-center sm:justify-start sm:text-left" : ""');
  });

  it("reverts to the pre-existing left alignment at sm: and up — desktop appearance is preserved, not newly centered", () => {
    expect(block).toContain("sm:justify-start sm:text-left");
  });

  it("maintenance/admin (isBlocked) blocks are explicitly excluded from the centering change — their rendering is untouched", () => {
    // The ternary's false branch is an empty string: isBlocked blocks get
    // no justify-content/text-align class at all, exactly as before this
    // fix (still defaulting to flex-start/left).
    expect(block).toMatch(/!isBlocked \? "justify-center text-center sm:justify-start sm:text-left" : ""/);
  });

  it("does not change block colors, borders, or the own-booking/other-booking distinction", () => {
    expect(block).toContain("border-2 border-blue-500 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300");
    expect(block).toContain('"text-gray-400"');
    expect(block).toContain('"bg-gray-500 text-white"');
  });

  it("does not change click-affordance classes (cursor-pointer / pointer-events-none)", () => {
    expect(block).toContain('isClickable ? "cursor-pointer" : "pointer-events-none"');
  });

  it("does not introduce any width/height/position style changes — blockStyle itself is untouched", () => {
    const styleStart = src.indexOf("const blockStyle = {", src.indexOf("const blockCls ="));
    const styleEnd = src.indexOf("};", styleStart) + 2;
    const styleBlock = src.slice(styleStart, styleEnd);
    expect(styleBlock).toContain("...blockPos,");
    expect(styleBlock).not.toMatch(/justify-content|text-align/);
  });

  it("vertical centering (items-center) on the shared block container is unchanged", () => {
    expect(block).toContain("flex items-center");
  });
});

describe("Event/lesson rendering is untouched by this correction", () => {
  const src = readSource(CALENDAR_SHELL_PATH);

  it("the event block's own className template has no new justify-content/text-align classes", () => {
    const eventBlockStart = src.indexOf("{/* Event blocks — colored, tappable, span the full column */}");
    expect(eventBlockStart).toBeGreaterThan(-1);
    const eventBlockEnd = src.indexOf("{ev.title}", eventBlockStart);
    const eventBlock = src.slice(eventBlockStart, eventBlockEnd);
    expect(eventBlock).toContain("flex items-start pt-1");
    expect(eventBlock).not.toMatch(/justify-center|text-center|sm:justify-start|sm:text-left/);
  });

  it("the Pro-lesson label's own early-return branch is untouched (rendered before blockCls is even computed, so it structurally cannot be affected by this change)", () => {
    const lessonLabelIdx = src.indexOf("{lessonLabel}");
    const blockClsIdx = src.indexOf("const blockCls = `absolute rounded text-[10px] font-medium px-1 overflow-hidden flex items-center");
    expect(lessonLabelIdx).toBeGreaterThan(-1);
    expect(blockClsIdx).toBeGreaterThan(lessonLabelIdx);
  });
});
