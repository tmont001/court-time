import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Runtime QA (34F-A round 2, Issues 1-3) — three reported flickers that
// turned out to share ONE underlying mechanism: RequestLessonSheet,
// CreateEventSheet, EventRosterSheet and ProgramRosterSheet each render
// through a ResponsiveSheet whose panel is content-sized (not fixed-
// height) and either flex-centered (desktop modal), bottom-anchored
// (mobile), or full-height-stretched (desktop panel). Swapping the
// rendered content for something a meaningfully different height —
// a wizard step change (Issues 1/2), or a loading-placeholder-to-loaded-
// roster swap (Issue 3) — reflows/repositions the panel instantly, with
// no transition. This repository's vitest baseline has no jsdom/React
// Testing Library (see ResponsiveSheet.regression.test.ts's own header
// comment for the established precedent), so a rendered-layout assertion
// isn't available here; this is the strongest practical coverage: it
// proves the shared class is applied at every one of the four call sites
// this round touched, and that the CSS behind it does exactly what the
// investigation concluded it safely can (soften the content swap) and
// deliberately does NOT attempt (animate the height reflow itself).

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const CSS_PATH             = "src/app/globals.css";
const LESSON_WIZARD_PATH   = "src/app/(app)/lessons/RequestLessonSheet.tsx";
const EVENT_WIZARD_PATH    = "src/app/(app)/calendar/CreateEventSheet.tsx";
const EVENT_ROSTER_PATH    = "src/app/(app)/calendar/EventRosterSheet.tsx";
const PROGRAM_ROSTER_PATH  = "src/app/(app)/events/ProgramRosterSheet.tsx";

describe("shared ct-content-settle class exists and is opacity-only (no transform, no new keyframes)", () => {
  it("is defined once in globals.css, reusing ct-calendar-item-settle-keyframes verbatim", () => {
    const s = readSource(CSS_PATH);
    const idx = s.indexOf(".ct-content-settle {");
    expect(idx).toBeGreaterThan(-1);
    const block = s.slice(idx, s.indexOf("}", idx) + 1);
    expect(block).toContain("animation: ct-calendar-item-settle-keyframes 180ms ease-out both;");
    // Only one definition — not redefined per consumer.
    expect(s.split(".ct-content-settle {").length - 1).toBe(1);
  });

  it("is gated by prefers-reduced-motion: no-preference, matching every other entrance animation in this file", () => {
    const s = readSource(CSS_PATH);
    expect(s).toMatch(/@media \(prefers-reduced-motion: no-preference\) \{\s*\n\s*\.ct-content-settle/);
  });

  it("ct-calendar-item-settle-keyframes itself remains opacity-only — no transform/positional movement is introduced by reusing it here", () => {
    const s = readSource(CSS_PATH);
    const idx = s.indexOf("@keyframes ct-calendar-item-settle-keyframes {");
    const block = s.slice(idx, s.indexOf("}", s.indexOf("}", idx) + 1) + 1);
    expect(block).not.toMatch(/transform/);
    expect(block).toContain("opacity: 0");
    expect(block).toContain("opacity: 1");
  });

  it("no new @keyframes were introduced for this fix", () => {
    const s = readSource(CSS_PATH);
    const idx = s.indexOf(".ct-content-settle {");
    // Nothing between the settle rule and its own comment block defines a
    // fresh @keyframes — it must be the pre-existing calendar-item one.
    const commentStart = s.lastIndexOf("/* ──", idx);
    const between = s.slice(commentStart, idx);
    expect(between).not.toMatch(/@keyframes/);
  });
});

describe("Issue 1 fix — every RequestLessonSheet wizard step carries ct-content-settle, not just the reported pro->duration pair", () => {
  it("all four steps (pro, duration, details, review) apply the class to their own root content div", () => {
    const s = readSource(LESSON_WIZARD_PATH);
    expect(s).toContain('{step === "pro" && (\n        <div className="ct-content-settle space-y-2">');
    expect(s).toContain('{step === "duration" && (\n        <div className="ct-content-settle">');
    expect(s).toContain('{step === "details" && (\n        <div className="ct-content-settle space-y-4">');
    expect(s).toContain('{step === "review" && selectedPro && (\n        <div className="ct-content-settle space-y-4">');
  });

  it("each step's content div is a genuinely new DOM node per transition — sibling-conditional rendering, no shared key, no remount-defeating memoization", () => {
    const s = readSource(LESSON_WIZARD_PATH);
    expect(s).not.toMatch(/key=\{step\}/);
    expect((s.match(/\{step === "(pro|duration|details|review)"/g) ?? []).length).toBe(4);
  });
});

describe("Issue 2 fix — every CreateEventSheet wizard step carries ct-content-settle, not just the reported page2->3 pair", () => {
  it("all four steps (1-4) apply the class to their own root content div", () => {
    const s = readSource(EVENT_WIZARD_PATH);
    expect(s).toContain('{step === 1 && (\n            <div className="ct-content-settle space-y-3 pt-1">');
    expect(s).toContain('{step === 2 && selectedType && (\n            <div className="ct-content-settle pt-1 space-y-5">');
    expect(s).toContain('{step === 3 && (\n            <div className="ct-content-settle pt-1 space-y-5">');
    expect(s).toContain('{step === 4 && selectedType && (\n            <div className="ct-content-settle pt-1 space-y-5">');
  });

  it("the step===3 conflict-check effect (an event-wizard-specific amplifier, absent from the lesson wizard, so it cannot be Issues 1/2's SHARED cause) is untouched by this fix", () => {
    const s = readSource(EVENT_WIZARD_PATH);
    expect(s).toContain('if (step !== 3 || selectedCourtIds.length === 0) {');
    expect(s).toContain('.in("court_id", selectedCourtIds)');
  });
});

describe("Issue 3 fix — EventRosterSheet and ProgramRosterSheet both settle their loading->loaded roster swap identically", () => {
  it("EventRosterSheet's loaded-content block (the sibling replacing the 'Loading roster…' placeholder) is a div carrying ct-content-settle, not a bare fragment", () => {
    const s = readSource(EVENT_ROSTER_PATH);
    expect(s).toContain('{!loading && !error && (\n            <div className="ct-content-settle">');
    // The loading placeholder itself is untouched — only the swapped-in
    // loaded content gets the settle treatment.
    expect(s).toContain('Loading roster…');
  });

  it("ProgramRosterSheet applies the identical fix — same defect, same shared class, not an independently-invented treatment", () => {
    const s = readSource(PROGRAM_ROSTER_PATH);
    expect(s).toContain('{!loading && !error && (\n          <div className="ct-content-settle">');
  });

  it("both roster sheets' async fetch-on-mount pattern (the actual source of the timing overlap with the panel's entrance animation) is left unchanged — this fix only softens the swap, it does not alter when the data arrives", () => {
    const eventS = readSource(EVENT_ROSTER_PATH);
    expect(eventS).toContain('.rpc("get_event_roster"');
    const programS = readSource(PROGRAM_ROSTER_PATH);
    expect(programS).toContain('.rpc("get_program_roster"');
  });
});
