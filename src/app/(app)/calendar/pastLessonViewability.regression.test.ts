import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Approved product change (fix/admin-calendar-lesson-click follow-up):
// PAST CONFIRMED lessons are now viewable from /calendar for Admin (any) and
// the assigned Pro (own lesson only), exactly like future confirmed lessons
// already were. Only the time restriction on VIEWING was removed —
// role/ownership/status authorization, and every mutation RPC's own
// time/status gating, are untouched.
//
// This codebase has no jsdom/React Testing Library (vitest.config.mts uses
// environment: "node"), so — consistent with calendarLessonReuse.regression.
// test.ts — component behavior is proven via source-text assertions on the
// exact inline logic, not by mounting/rendering.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const CALENDAR_SHELL_PATH = "src/app/(app)/calendar/CalendarShell.tsx";
const LESSONS_TAB_PATH = "src/app/(app)/events/LessonsTab.tsx";
const CHECKOUT_MIGRATION_PATH = "supabase/migrations/0159_lesson_online_payment_checkout.sql";

function getLessonBlockSection(): string {
  const s = readSource(CALENDAR_SHELL_PATH);
  const start = s.indexOf("if (isLesson) {");
  const end = s.indexOf("// Phase 34A4A: a maintenance/admin block stays admin-only", start);
  return s.slice(start, end);
}

describe("1-5, 8. canManageLesson: confirmed + role/ownership only, no time restriction, status still required", () => {
  it("canManageLesson requires (Admin OR (Pro AND isOwn)) AND confirmed — no future/time clause", () => {
    const block = getLessonBlockSection();
    expect(block).toContain(
      "const canManageLesson =\n" +
      '                            (isAdmin || (userRole === "pro" && isOwn)) &&\n' +
      '                            res.status === "confirmed";',
    );
  });

  it("1/2. Admin qualifies via isAdmin alone — true for both a future AND a past confirmed lesson, since no starts_at comparison exists", () => {
    const block = getLessonBlockSection();
    // isAdmin is a standalone disjunct (not itself time-gated), and the only
    // remaining conjunct is status === 'confirmed' — no starts_at check.
    expect(block).toMatch(/const canManageLesson =\s*\n\s*\(isAdmin \|\|/);
    expect(block).not.toMatch(/canManageLesson[\s\S]{0,200}starts_at/);
  });

  it("3/4. assigned Pro qualifies via (userRole === 'pro' && isOwn) — true for both a future AND a past confirmed own lesson, since no starts_at comparison exists", () => {
    const block = getLessonBlockSection();
    expect(block).toContain('(userRole === "pro" && isOwn)');
  });

  it("5. a different Pro (not isOwn) never qualifies — the pro branch is strictly gated on isOwn, unchanged by this fix", () => {
    const block = getLessonBlockSection();
    const idx = block.indexOf("const canManageLesson =");
    const clauseEnd = block.indexOf(";", idx);
    const clause = block.slice(idx, clauseEnd);
    // The ONLY way userRole === "pro" satisfies canManageLesson is with
    // isOwn also true — there is no bare `userRole === "pro"` disjunct.
    expect(clause).not.toMatch(/userRole === "pro"\s*\)/); // no standalone pro-only clause
    expect(clause).toContain('userRole === "pro" && isOwn');
  });

  it("8. a pending/proposed/cancelled/declined lesson never qualifies — res.status === 'confirmed' remains a mandatory conjunct", () => {
    const block = getLessonBlockSection();
    const idx = block.indexOf("const canManageLesson =");
    const clauseEnd = block.indexOf(";", idx);
    const clause = block.slice(idx, clauseEnd);
    expect(clause).toContain('res.status === "confirmed"');
  });
});

describe("6/7. Member own-lesson viewability (canViewOwnLesson) is byte-identical — untouched by this change", () => {
  it("canViewOwnLesson still requires member + isOwn + confirmed, unchanged from before this fix", () => {
    const block = getLessonBlockSection();
    expect(block).toContain('const canViewOwnLesson = userRole === "member" && isOwn && res.status === "confirmed";');
  });

  it("canViewOwnLesson never grants access to another Member's lesson — isOwn remains a mandatory conjunct", () => {
    const block = getLessonBlockSection();
    const idx = block.indexOf("const canViewOwnLesson =");
    const lineEnd = block.indexOf(";", idx);
    expect(block.slice(idx, lineEnd)).toContain("isOwn");
  });
});

describe("12. No duplicate lesson-detail UI is introduced by this change", () => {
  it("Admin/Pro management click still routes exclusively through handleManageLesson (→ /admin/lessons), never a new in-calendar detail view", () => {
    const s = readSource(CALENDAR_SHELL_PATH);
    const fnIdx = s.indexOf("async function handleManageLesson(reservationId: string) {");
    expect(fnIdx).toBeGreaterThan(-1);
    const fnEnd = s.indexOf("\n  }", fnIdx);
    const fn = s.slice(fnIdx, fnEnd);
    expect(fn).toContain('router.push(`/admin/lessons?lessonId=${data.id}`);');
  });

  it("no second admin-facing lesson detail component was added — CalendarShell still imports exactly one lesson DETAIL component (LessonRequestDetail, for the Member-own path only)", () => {
    const s = readSource(CALENDAR_SHELL_PATH);
    const detailImports = s.match(/from "@\/app\/\(app\)\/lessons\/[A-Za-z]*Detail[A-Za-z]*"/g) ?? [];
    expect(detailImports).toEqual(['from "@/app/(app)/lessons/LessonRequestDetail"']);
  });
});

describe("9/10. LessonsTab reservationEligible: time requirement removed, all other checks preserved", () => {
  function getReservationEligibleClause(): string {
    const s = readSource(LESSONS_TAB_PATH);
    const idx = s.indexOf("const reservationEligible =");
    const end = s.indexOf(";", idx);
    return s.slice(idx, end);
  }

  it("9. no longer requires starts_at to be in the future — a past confirmed pro_lesson reservation is eligible", () => {
    const clause = getReservationEligibleClause();
    expect(clause).not.toMatch(/starts_at/);
  });

  it("10. still requires same club, pro_lesson reason, and confirmed status", () => {
    const clause = getReservationEligibleClause();
    expect(clause).toContain("!!reservation");
    expect(clause).toContain("reservation.club_id === clubId");
    expect(clause).toContain('reservation.reason === "pro_lesson"');
    expect(clause).toContain('reservation.status === "confirmed"');
  });
});

describe("11. Lesson mutation RPCs (propose_lesson_time, cancel_lesson) are untouched — their own time/status gating still exists exactly as before this change", () => {
  it("propose_lesson_time still rejects rescheduling an already-started lesson and proposing a past time", () => {
    const s = readSource(CHECKOUT_MIGRATION_PATH);
    expect(s).toContain("if v_old_reservation.starts_at <= now() then");
    expect(s).toContain("raise exception 'cannot_reschedule_started_lesson';");
    expect(s).toContain("if p_starts_at <= now() then raise exception 'cannot_propose_past_time'; end if;");
  });

  it("cancel_lesson still gives Admin/Staff (and only Admin/Staff) an already-started correction exemption", () => {
    const s = readSource(CHECKOUT_MIGRATION_PATH);
    expect(s).toContain("if v_effective_starts_at <= now() and v_profile.role not in ('admin', 'staff') then");
    expect(s).toContain("raise exception 'lesson_already_started';");
  });
});
