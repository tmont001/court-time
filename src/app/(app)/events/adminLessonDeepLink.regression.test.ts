import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 36D correction — regression coverage for the Pro/Staff/Admin
// Lesson deep link (/admin/lessons?lessonId=<uuid>, implemented inside
// the shared LessonsTab component both /admin/lessons and the legacy
// /events?tab=lessons route render).
//
// This SUPERSEDES the prior 36D pass's "known scope boundary": that pass
// found the auto-open effect only opened pending/proposed(no-reservation)
// /declined/cancelled/withdrawn requests' pages, never the request
// itself, because the effect required a live, confirmed linked
// reservation for EVERY status before opening anything. That was too
// strict — a manual click on the same card (the row's own onClick)
// performs no such check for any status. This correction makes the
// validation STATE-AWARE: only the two states whose actionable workflow
// genuinely depends on a live reservation (confirmed; a proposed
// RESCHEDULE with linked_reservation_id already set) still get the live
// re-validation. Every other authorized state opens directly — exactly
// like a manual click.
//
// AUTHORIZATION IS UNCHANGED: `requests` is still the caller's own
// RPC-scoped list (get_pro_lesson_requests — Pro sees only pro_id=
// auth.uid() rows, Admin/Staff see the whole club). Matching lessonId
// against that array, never an independent lookup, is what makes this
// safe — an unrelated Pro's requests array structurally cannot contain
// another Pro's row, so a manually typed lessonId for someone else's
// lesson still finds no match regardless of status.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const TAB_PATH        = "src/app/(app)/events/LessonsTab.tsx";
const LESSON_ACCESS   = "src/lib/lessons/lessonAccess.ts";

function getEffect(): string {
  const s = readSource(TAB_PATH);
  const idx = s.indexOf("useEffect(() => {\n    if (!lessonIdParam) return;");
  const endIdx = s.indexOf("}, [lessonIdParam, requests]);", idx);
  expect(idx).toBeGreaterThan(-1);
  expect(endIdx).toBeGreaterThan(idx);
  return s.slice(idx, endIdx);
}

describe("authorization is checked FIRST and is the only gate on whether a match exists at all", () => {
  it("matches lessonId against `requests` (get_pro_lesson_requests-scoped) before anything else", () => {
    const effect = getEffect();
    const matchIdx = effect.indexOf("const match = requests.find(r => r.id === lessonIdParam);");
    expect(matchIdx).toBeGreaterThan(-1);
    // The no-match short-circuit must appear immediately after, before any
    // state-dependent branching.
    const afterMatch = effect.slice(matchIdx, matchIdx + 200);
    expect(afterMatch).toContain("if (!match) { clearLessonIdParam(); return; }");
  });

  it("a non-matching lessonId (unauthorized, nonexistent, reassigned-away) clears the param and opens nothing — before any status check runs", () => {
    const effect = getEffect();
    const noMatchIdx = effect.indexOf("if (!match) { clearLessonIdParam(); return; }");
    const stateCheckIdx = effect.indexOf("lessonDependsOnLiveReservation(");
    expect(noMatchIdx).toBeGreaterThan(-1);
    expect(stateCheckIdx).toBeGreaterThan(noMatchIdx);
  });
});

describe("state-aware validation: only a live-reservation-dependent state gets the async re-validation", () => {
  it("uses the shared lessonDependsOnLiveReservation predicate — the same one canReschedule uses — rather than a second, potentially-drifting inline condition", () => {
    const s = readSource(TAB_PATH);
    expect(s).toContain('import { lessonDependsOnLiveReservation } from "@/lib/lessons/lessonAccess";');
    const occurrences = s.split("lessonDependsOnLiveReservation(").length - 1;
    // One call site in canReschedule, one in the auto-open effect.
    expect(occurrences).toBe(2);
  });

  it("a request whose state does NOT depend on a live reservation opens DIRECTLY — setSelected called synchronously, no async reservation fetch first", () => {
    const effect = getEffect();
    const idx = effect.indexOf("if (!lessonDependsOnLiveReservation(match.status, match.linked_reservation_id)) {");
    expect(idx).toBeGreaterThan(-1);
    const block = effect.slice(idx, idx + 200);
    expect(block).toContain("setSelected(match);");
    expect(block).toContain("setProposeMode(false);");
    expect(block).toContain("return;");
  });

  it("a request whose state DOES depend on a live reservation still goes through the async re-validation before opening", () => {
    const effect = getEffect();
    const idx = effect.indexOf("if (!match.linked_reservation_id) { clearLessonIdParam(); return; }");
    expect(idx).toBeGreaterThan(-1);
    const block = effect.slice(idx);
    expect(block).toContain(".from(\"reservations\")");
    expect(block).toContain('reservation.club_id === clubId');
    expect(block).toContain('reservation.reason === "pro_lesson"');
    expect(block).toContain('reservation.status === "confirmed"');
    expect(block).toContain("if (!reservationEligible) {\n        clearLessonIdParam();\n        return;\n      }");
    expect(block).toContain("setSelected(match);");
  });

  // Approved product change: viewing a lesson's detail is not time-restricted
  // — a past confirmed lesson is a valid, viewable lesson. The mutation RPCs
  // (propose_lesson_time, cancel_lesson) remain the authoritative gate on
  // which actions a past lesson still permits, independent of this
  // re-validation.
  it("no longer requires the reservation to be in the future — reservationEligible has no starts_at/now() comparison", () => {
    const effect = getEffect();
    const idx = effect.indexOf("const reservationEligible =");
    expect(idx).toBeGreaterThan(-1);
    const endIdx = effect.indexOf(";", idx);
    const block = effect.slice(idx, endIdx);
    expect(block).not.toMatch(/starts_at/);
    expect(block).not.toMatch(/new Date\(\)/);
  });

  it("still requires same-club, pro_lesson reason, and confirmed status — only the time requirement was removed", () => {
    const effect = getEffect();
    const idx = effect.indexOf("const reservationEligible =");
    const endIdx = effect.indexOf(";", idx);
    const block = effect.slice(idx, endIdx);
    expect(block).toContain("!!reservation");
    expect(block).toContain("reservation.club_id === clubId");
    expect(block).toContain('reservation.reason === "pro_lesson"');
    expect(block).toContain('reservation.status === "confirmed"');
  });
});

describe("clearing preserves every other query param — a plain URLSearchParams-based strip, not a blunt full reset", () => {
  it("clearLessonIdParam only removes lessonId", () => {
    const s = readSource(TAB_PATH);
    const idx = s.indexOf("function clearLessonIdParam() {");
    const endIdx = s.indexOf("\n  }", idx);
    const block = s.slice(idx, endIdx);
    expect(block).toContain("new URLSearchParams(searchParams.toString());");
    expect(block).toContain('params.delete("lessonId");');
  });
});

describe("Pro and Admin/Staff share the identical mechanism — role scope comes entirely from get_pro_lesson_requests, not from a branch inside this effect", () => {
  it("no role check anywhere in the auto-open effect", () => {
    const effect = getEffect();
    expect(effect).not.toMatch(/isOperator|userRole/);
  });
});

describe("lessonAccess.ts — the shared predicate itself", () => {
  it("is framework-independent (no React/router/Supabase import)", () => {
    const s = readSource(LESSON_ACCESS);
    expect(s).not.toMatch(/from "react"|from "next\/|from "@supabase/);
  });
});
