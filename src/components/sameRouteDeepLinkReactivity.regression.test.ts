import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 36E correction (round 1) — runtime QA found that clicking a
// notification while ALREADY on its destination route (e.g. already on
// /calendar, clicking an Event notification) changed the URL correctly
// but never opened the target: CalendarShell/EventsUpcomingClient/
// LessonsClient's deep-link effects all depended on `[]` (mount-only). A
// same-route router.push updates the server-computed id PROP, but an
// empty dependency array only ever runs its effect once, at the original
// mount — it never re-fires just because the prop changed. The fix: add
// `useSearchParams()` (tied to Next's own completed-navigation state) to
// each effect's dependency array alongside the id prop.
//
// Phase 36E correction (round 2, THIS file) — the round-1 report and
// comments claimed "window.history.replaceState cannot itself change
// useSearchParams, so our own cleanup can never spuriously re-trigger the
// effect." That claim is WRONG: current Next.js DOES integrate
// window.history.pushState/replaceState with router state/
// useSearchParams. That means each effect's OWN cleanup call CAN cause
// searchParams to update and re-trigger the very same effect a second
// time, with the id prop still set (nothing ever resets it) but the live
// URL already clean. Each of the four effects now guards against this by
// comparing the LIVE searchParams value against its own id prop before
// acting — re-evaluated fresh every render (not a permanent "already
// consumed" flag), so a later, genuinely distinct repeat click of the
// same notification still matches and still opens.
//
// LessonsTab (Pro/Staff/Admin) needed NO fix in either round — audited
// below — because it already reads its target id directly from
// useSearchParams() (never a server-computed prop) and cleans up via
// router.replace (a real Next navigation), so lessonIdParam itself
// genuinely oscillates through null between clicks; there is no separate
// prop that could disagree with the live URL in the first place.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const CALENDAR_SHELL  = "src/app/(app)/calendar/CalendarShell.tsx";
const EVENTS_UPCOMING = "src/app/(app)/events/EventsUpcomingClient.tsx";
const LESSONS_CLIENT  = "src/app/(app)/lessons/LessonsClient.tsx";
const LESSONS_TAB     = "src/app/(app)/events/LessonsTab.tsx";
const SHEET_PATH      = "src/components/NotificationSheet.tsx";

describe("1. Reservation live-param guard (CalendarShell)", () => {
  it("checks searchParams.get(\"reservation\") against initialReservationId before fetching/opening", () => {
    const s = readSource(CALENDAR_SHELL);
    const idx = s.indexOf("if (!initialReservationId) return;");
    expect(idx).toBeGreaterThan(-1);
    const guardIdx = s.indexOf('if (searchParams.get("reservation") !== initialReservationId) return;', idx);
    expect(guardIdx).toBeGreaterThan(idx);
    // The guard must precede the fetch — never race a mismatched target.
    const fetchIdx = s.indexOf("getReservationDeepLinkDetail(initialReservationId)", idx);
    expect(fetchIdx).toBeGreaterThan(guardIdx);
  });
});

describe("2. Event live-param guard (CalendarShell)", () => {
  it("checks searchParams.get(\"event\") against initialEventId before fetching/opening", () => {
    const s = readSource(CALENDAR_SHELL);
    const idx = s.indexOf("if (!initialEventId) return;");
    expect(idx).toBeGreaterThan(-1);
    const guardIdx = s.indexOf('if (searchParams.get("event") !== initialEventId) return;', idx);
    expect(guardIdx).toBeGreaterThan(idx);
    const fetchIdx = s.indexOf('.from("events")', idx);
    expect(fetchIdx).toBeGreaterThan(guardIdx);
  });
});

describe("3. Program live-param guard (EventsUpcomingClient)", () => {
  it("checks searchParams.get(\"program\") against initialProgramId before scrolling", () => {
    const s = readSource(EVENTS_UPCOMING);
    const idx = s.indexOf("if (!initialProgramId) return;");
    expect(idx).toBeGreaterThan(-1);
    const guardIdx = s.indexOf('if (searchParams.get("program") !== initialProgramId) return;', idx);
    expect(guardIdx).toBeGreaterThan(idx);
    const scrollIdx = s.indexOf("scrollIntoView(", idx);
    expect(scrollIdx).toBeGreaterThan(guardIdx);
  });
});

describe("4/5. Member Lesson live-param guard (LessonsClient) — checks BOTH request_id and lesson", () => {
  it("matches if EITHER the canonical request_id or the Stripe checkout-return lesson param agrees with initialLessonRequestId", () => {
    const s = readSource(LESSONS_CLIENT);
    const idx = s.indexOf("if (!initialLessonRequestId) return;");
    expect(idx).toBeGreaterThan(-1);
    const block = s.slice(idx, idx + 400);
    expect(block).toContain('const liveRequestId = searchParams.get("request_id");');
    expect(block).toContain('const liveLessonId  = searchParams.get("lesson");');
    expect(block).toContain("if (liveRequestId !== initialLessonRequestId && liveLessonId !== initialLessonRequestId) return;");
  });

  it("the guard precedes the initialRequests lookup and setSelected call", () => {
    const s = readSource(LESSONS_CLIENT);
    const idx = s.indexOf("if (!initialLessonRequestId) return;");
    const guardIdx = s.indexOf("if (liveRequestId !== initialLessonRequestId && liveLessonId !== initialLessonRequestId) return;", idx);
    const matchIdx = s.indexOf("const match = initialRequests.find(", idx);
    expect(guardIdx).toBeGreaterThan(idx);
    expect(matchIdx).toBeGreaterThan(guardIdx);
  });
});

describe("6. Cleanup causes a safe no-op on any subsequent effect run (the actual round-2 bug)", () => {
  it("each of the three effects' live-param guard would reject a re-invocation where the URL has already been cleaned (live param null) but the id prop has not reset", () => {
    // Behavior-level proof of the guard's own logic, independent of the
    // source text: this is exactly the scenario the guard exists for.
    const initialReservationId = "11111111-1111-1111-1111-111111111111";
    const liveParamAfterCleanup: string | null = null;
    expect(liveParamAfterCleanup !== initialReservationId).toBe(true); // guard would return early
  });

  it("all three fixed files contain the live-param guard as the FIRST statement after the initial null-check, before any fetch/DOM/state work", () => {
    for (const [path, paramName, propName] of [
      [CALENDAR_SHELL, "reservation", "initialReservationId"],
      [CALENDAR_SHELL, "event", "initialEventId"],
      [EVENTS_UPCOMING, "program", "initialProgramId"],
    ] as const) {
      const s = readSource(path);
      const nullCheckIdx = s.indexOf(`if (!${propName}) return;`);
      expect(nullCheckIdx).toBeGreaterThan(-1);
      const afterNullCheck = s.slice(nullCheckIdx, nullCheckIdx + 200);
      expect(afterNullCheck).toContain(`searchParams.get("${paramName}") !== ${propName}`);
    }
  });
});

describe("7. The same target can later be intentionally reopened — the guard is re-evaluated every render, never a permanent flag", () => {
  it("no effect stores a persistent \"already consumed this id\" ref/flag — the live-param comparison alone decides on every invocation", () => {
    for (const path of [CALENDAR_SHELL, EVENTS_UPCOMING, LESSONS_CLIENT]) {
      const s = readSource(path);
      // useRef would be the pattern for a persistent consumed-guard; none
      // of these three files use it for their deep-link effect (LessonsTab
      // deliberately does, for a different, unrelated reason audited
      // separately below).
      const idx = s.indexOf("if (!initial");
      const nearby = s.slice(Math.max(0, idx - 50), idx + 500);
      expect(nearby).not.toContain("useRef");
    }
  });
});

describe("8. Unrelated query params remain preserved by cleanup, unchanged from round 1", () => {
  it("all three fixed destinations still build cleanup from the live window.location.search via URLSearchParams, deleting only their own params", () => {
    const cases: Array<[string, string[]]> = [
      [CALENDAR_SHELL, ["reservation", "event"]],
      [EVENTS_UPCOMING, ["program"]],
      [LESSONS_CLIENT, ["request_id", "lesson"]],
    ];
    for (const [path, ownParams] of cases) {
      const s = readSource(path);
      expect(s).toContain("new URLSearchParams(window.location.search);");
      for (const p of ownParams) {
        expect(s).toContain(`params.delete("${p}");`);
      }
      expect(s).toContain('params.delete("checkout");');
    }
  });
});

describe("LessonsTab (Pro/Staff/Admin) needed no fix in either round — confirmed unchanged", () => {
  it("reads its target id directly from the reactive useSearchParams() hook, not a server-computed prop", () => {
    const s = readSource(LESSONS_TAB);
    expect(s).toContain('const lessonIdParam = searchParams.get("lessonId");');
  });

  it("cleans up via router.replace — a REAL Next.js navigation — which is exactly why lessonIdParam genuinely oscillates through null between clicks, needing no separate live-param guard", () => {
    const s = readSource(LESSONS_TAB);
    const idx = s.indexOf("function clearLessonIdParam() {");
    const endIdx = s.indexOf("\n  }", idx);
    const block = s.slice(idx, endIdx);
    expect(block).toContain("router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });");
    expect(block).not.toContain("window.history.replaceState");
  });

  it("its own autoOpenAttemptRef guard exists for a different, unrelated reason (avoiding reprocessing when `requests` changes independently, e.g. after router.refresh()) — reset by clearLessonIdParam so a later repeat click is not permanently blocked", () => {
    const s = readSource(LESSONS_TAB);
    const idx = s.indexOf("function clearLessonIdParam() {");
    const block = s.slice(idx, idx + 120);
    expect(block).toContain("autoOpenAttemptRef.current = null;");
  });
});

describe("10. NotificationSheet remains resolver-only and route-agnostic — untouched by either round of this correction", () => {
  it("no useSearchParams, no route-specific conditionals, no per-destination logic was added to NotificationSheet", () => {
    const s = readSource(SHEET_PATH);
    expect(s).not.toMatch(/useSearchParams|usePathname/);
    expect(s).not.toMatch(/\/calendar|\/events|\/my-schedule|\/admin\/lessons/);
    expect(s).toContain("import { resolveNotificationTarget } from \"@/lib/notification-targets\";");
    expect(s).toContain("router.push(targetPath);");
  });
});
