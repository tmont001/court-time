import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 34F-D, Item 3 — a Member clicking their own Lesson block on
// /calendar now reuses the SAME canonical LessonRequestDetail component
// /my-schedule?tab=lessons already uses, rather than being unable to open
// it at all (the previous regression: canManageLesson only ever allowed
// Admin or the assigned Pro to click into a pro_lesson block — a Member,
// even the lesson's own owner, got pointer-events-none).
//
// Covers items 8-13 from the 34F-D spec:
//   8. Member's own Lesson on /calendar is clickable
//   9. opens/reuses the canonical Lesson detail component
//   10. Pay Now is the SAME implementation/path as /my-schedule
//   11. a different Member cannot access Lesson detail (RPC-level boundary)
//   12. Admin/Staff/Pro calendar behavior unchanged
//   13. Reservation/Event click behavior unchanged

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const CALENDAR_SHELL_PATH = "src/app/(app)/calendar/CalendarShell.tsx";
const LESSON_DETAIL_PATH = "src/app/(app)/lessons/LessonRequestDetail.tsx";
const LESSONS_CLIENT_PATH = "src/app/(app)/lessons/LessonsClient.tsx";

function getLessonBlockSection(): string {
  const s = readSource(CALENDAR_SHELL_PATH);
  const start = s.indexOf("if (isLesson) {");
  const end = s.indexOf("// Phase 34A4A: a maintenance/admin block stays admin-only", start);
  return s.slice(start, end);
}

// ═══════════════════════════════════════════════════════════════════════════
// 8/9 — Member's own Lesson is clickable and opens the canonical detail
// ═══════════════════════════════════════════════════════════════════════════

describe("8/9. Member's own pro_lesson block on /calendar is clickable and opens the canonical LessonRequestDetail component", () => {
  it("canViewOwnLesson is true for a member who owns the block and it is currently confirmed — a new, additive eligibility path alongside the pre-existing canManageLesson", () => {
    const block = getLessonBlockSection();
    expect(block).toContain('const canViewOwnLesson = userRole === "member" && isOwn && res.status === "confirmed";');
    expect(block).toContain("const isLessonClickable = canManageLesson || canViewOwnLesson;");
  });

  it("clicking calls handleOpenMemberLesson (never handleManageLesson, which navigates Admin/Pro away to /admin/lessons) for the Member's own-view path", () => {
    const block = getLessonBlockSection();
    expect(block).toContain("const handleLessonClick = canManageLesson\n                            ? () => handleManageLesson(res.id)\n                            : canViewOwnLesson\n                              ? () => handleOpenMemberLesson(res.id)\n                              : undefined;");
  });

  it("the block's role/tabIndex/onClick/onKeyDown/cursor styling are all driven by isLessonClickable (canManageLesson OR canViewOwnLesson) — a Member's own confirmed lesson is no longer rendered pointer-events-none", () => {
    const block = getLessonBlockSection();
    expect(block).toContain('role={isLessonClickable ? "button" : undefined}');
    expect(block).toContain("isLessonClickable ? \"cursor-pointer\" : \"pointer-events-none\"");
  });

  it("9. handleOpenMemberLesson resolves the full LessonRequestRow via get_my_lesson_requests (the SAME RPC /my-schedule's own page.tsx calls) and renders it through the imported LessonRequestDetail — never a second Lesson detail implementation", () => {
    const s = readSource(CALENDAR_SHELL_PATH);
    expect(s).toContain('import LessonRequestDetail from "@/app/(app)/lessons/LessonRequestDetail";');
    const fnIdx = s.indexOf("async function handleOpenMemberLesson(reservationId: string) {");
    const fnEnd = s.indexOf("\n  }", fnIdx);
    const fn = s.slice(fnIdx, fnEnd);
    expect(fn).toContain('supabase.rpc("get_my_lesson_requests")');
    expect(fn).toContain("r.linked_reservation_id === reservationId");
    expect(fn).toContain("setSelectedLessonRequest(match)");

    expect(s).toContain("{selectedLessonRequest && (\n        <LessonRequestDetail");
  });

  it("no second Lesson payment/detail implementation is built in CalendarShell.tsx — it renders the imported component with props only, no duplicated withdraw/accept/decline/cancel/Pay Now logic of its own", () => {
    const s = readSource(CALENDAR_SHELL_PATH);
    expect(s).not.toMatch(/withdrawLessonRequest|acceptLessonProposal|declineLessonProposal|cancelLesson\(/);
    expect(s).not.toMatch(/createLessonCheckoutAction|getLessonCheckoutEligibilityAction/);
  });

  it("the sheet's own onClose bumps refreshTick so the calendar's client-side reservations refetch picks up any mutation (withdraw/cancel) made from within the reused detail sheet, in addition to LessonRequestDetail's own router.refresh()", () => {
    const s = readSource(CALENDAR_SHELL_PATH);
    const idx = s.indexOf("<LessonRequestDetail");
    const end = s.indexOf("/>", idx);
    const block = s.slice(idx, end);
    expect(block).toContain("onClose={() => { setSelectedLessonRequest(null); setRefreshTick(t => t + 1); }}");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10 — Pay Now is the same implementation/path as /my-schedule
// ═══════════════════════════════════════════════════════════════════════════

describe("10. Pay Now reached from /calendar is the IDENTICAL implementation LessonsClient/(my-schedule) already uses — not a parallel one", () => {
  it("LessonsClient (the /my-schedule?tab=lessons surface) renders the SAME LessonRequestDetail component CalendarShell now also renders", () => {
    const calendarSrc = readSource(CALENDAR_SHELL_PATH);
    const lessonsClientSrc = readSource(LESSONS_CLIENT_PATH);
    expect(calendarSrc).toContain('from "@/app/(app)/lessons/LessonRequestDetail"');
    expect(lessonsClientSrc).toContain('import LessonRequestDetail from "./LessonRequestDetail";');
  });

  it("LessonRequestDetail's own Pay Now wiring (handlePayNow / getLessonCheckoutEligibilityAction / createLessonCheckoutAction) is untouched by this checkpoint — CalendarShell only ever supplies request/userId/clubId/clubTimezone/currency/onClose props, never overriding or wrapping its internal payment logic", () => {
    const s = readSource(LESSON_DETAIL_PATH);
    expect(s).toContain("async function handlePayNow() {");
    expect(s).toContain("createLessonCheckoutAction(request.id, clubId)");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 11 — a different Member cannot access another Member's Lesson detail
// ═══════════════════════════════════════════════════════════════════════════

describe("11. a different Member cannot reach another Member's Lesson detail — the RPC's own server-side identity scoping is the real boundary, not merely the UI's isOwn pre-filter", () => {
  it("get_my_lesson_requests (0112, unmodified by this checkpoint) is SECURITY DEFINER and resolves the caller's own identity server-side (auth.uid() plus their own current roster identity) — it can structurally never return a different Member's row regardless of which reservation id CalendarShell asks about", () => {
    const s = readSource("supabase/migrations/0112_fix_my_lesson_roster_lookup_ambiguity.sql");
    const fnStart = s.indexOf("create or replace function public.get_my_lesson_requests()");
    const fnEnd = s.indexOf("\n$$;", fnStart) + "\n$$;".length;
    const fn = s.slice(fnStart, fnEnd);
    expect(fn).toContain("security definer");
    expect(fn).toContain("select * into v_profile from public.profiles p where p.id = auth.uid();");
    expect(fn).toContain("rm.claimed_by = auth.uid()");
  });

  it("isOwn (CalendarShell's own click-eligibility pre-filter) is documented as a UX filter only, not the security boundary, in handleOpenMemberLesson's own comment", () => {
    const s = readSource(CALENDAR_SHELL_PATH);
    const fnIdx = s.indexOf("async function handleOpenMemberLesson(reservationId: string) {");
    const commentBlock = s.slice(Math.max(0, fnIdx - 900), fnIdx);
    expect(commentBlock).toMatch(/UX pre-filter|not\s+the security boundary/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 12 — Admin/Staff/Pro calendar behavior unchanged
// ═══════════════════════════════════════════════════════════════════════════

describe("12. Admin/Staff/Pro calendar Lesson-block behavior is unchanged", () => {
  it("canManageLesson's own definition (role/ownership/status/future-only) is byte-identical to its pre-existing shape — only the click dispatch (handleLessonClick) was generalized to also check canViewOwnLesson, never canManageLesson's own eligibility", () => {
    const block = getLessonBlockSection();
    expect(block).toContain(
      "const canManageLesson =\n" +
      '                            (isAdmin || (userRole === "pro" && isOwn)) &&\n' +
      '                            res.status === "confirmed" &&\n' +
      "                            new Date(res.starts_at) > new Date();",
    );
  });

  it("Admin/Pro's own click still routes to handleManageLesson (navigates to /admin/lessons) exactly as before — never intercepted by the new Member-view path", () => {
    const block = getLessonBlockSection();
    const canManageIdx = block.indexOf("const canManageLesson =");
    const dispatchIdx = block.indexOf("const handleLessonClick =");
    expect(canManageIdx).toBeGreaterThan(-1);
    expect(dispatchIdx).toBeGreaterThan(canManageIdx);
    expect(block.slice(dispatchIdx)).toMatch(/canManageLesson\s*\n\s*\?\s*\(\)\s*=>\s*handleManageLesson\(res\.id\)/);
  });

  it("lesson identity privacy (canSeeLessonIdentity, the Private Lesson label logic) is untouched — still isOwn || isOperator, unaffected by the new click-eligibility addition", () => {
    const s = readSource(CALENDAR_SHELL_PATH);
    expect(s).toContain("const canSeeLessonIdentity = isOwn || isOperator(userRole);");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 13 — Reservation/Event click behavior unchanged
// ═══════════════════════════════════════════════════════════════════════════

describe("13. Reservation and Event click behavior on /calendar is unchanged by this correction", () => {
  it("the member_booking/maintenance block's own isClickable predicate (isBlocked ? isAdmin : (isOperator(userRole) || isOwn)) is untouched — the new Lesson-only variables (canViewOwnLesson/isLessonClickable/handleLessonClick) never leak into this branch", () => {
    const s = readSource(CALENDAR_SHELL_PATH);
    expect(s).toContain("const isClickable = isBlocked ? isAdmin : (isOperator(userRole) || isOwn);");
  });

  it("Event click handling (selectedEvent/setSelectedEvent, EventDetailSheet) is a completely separate code path from the reservations-grid Lesson-block branch touched here — no shared state, no shared click dispatcher", () => {
    const s = readSource(CALENDAR_SHELL_PATH);
    expect(s).toContain("const [selectedEvent, setSelectedEvent] = useState<EventWithDetails | null>(null);");
    expect(s).not.toMatch(/setSelectedEvent\(match\)|setSelectedEvent\(.*handleOpenMemberLesson/);
  });
});
