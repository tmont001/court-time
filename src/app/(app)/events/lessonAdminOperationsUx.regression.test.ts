import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 38A — regression coverage for the Cancel Lesson discoverability fix,
// the Active/Past/All list reorganization, and the new card-level Reassign
// Pro / Cancel Lesson actions on LessonsTab.tsx + LessonProSheet.tsx. Source-
// inspection style (no jsdom in this baseline) — see calendarLessonReuse.
// regression.test.ts / adminLessonDeepLink.regression.test.ts for the same
// established convention on these exact two files.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const TAB_PATH   = "src/app/(app)/events/LessonsTab.tsx";
const SHEET_PATH = "src/app/(app)/events/LessonProSheet.tsx";

function tabSource(): string { return readSource(TAB_PATH); }
function sheetSource(): string { return readSource(SHEET_PATH); }

function cardBlock(): string {
  const s = tabSource();
  const start = s.indexOf("{/* Request cards */}");
  const end = s.indexOf("{/* Detail sheet */}", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return s.slice(start, end);
}

// ═══════════════════════════════════════════════════════════════════════════
// FILTERING — Active / Past / All
// ═══════════════════════════════════════════════════════════════════════════

describe("Active/Past/All filter structure", () => {
  it("StatusFilter is now active | past | all — Past added alongside the existing Active/All, not replacing either", () => {
    const s = tabSource();
    expect(s).toContain('type StatusFilter = "active" | "past" | "all";');
  });

  it("isActiveRequest: pending/proposed are unconditionally active regardless of any date; only a confirmed lesson is time-gated", () => {
    const s = tabSource();
    const idx = s.indexOf("function isActiveRequest(");
    const end = s.indexOf("\n}", idx);
    const fn = s.slice(idx, end);
    expect(fn).toContain('if (r.status !== "confirmed") return true;');
    expect(fn).toContain("return !isPastConfirmedLesson(r.status, r.proposed_starts_at);");
  });

  it("isPastRequest: only a confirmed lesson whose effective start has passed — declined/cancelled/withdrawn are never 'past'", () => {
    const s = tabSource();
    const idx = s.indexOf("function isPastRequest(");
    const end = s.indexOf("\n}", idx);
    const fn = s.slice(idx, end);
    expect(fn).toContain('r.status === "confirmed" && isPastConfirmedLesson(r.status, r.proposed_starts_at)');
  });

  it("1. Active contains a future confirmed lesson (isPastConfirmedLesson false -> isActiveRequest true)", () => {
    const s = tabSource();
    expect(s).toContain("if (r.status !== \"confirmed\") return true;\n  return !isPastConfirmedLesson(r.status, r.proposed_starts_at);");
  });

  it("2. Active does NOT contain a past confirmed lesson — same branch above returns false once isPastConfirmedLesson is true", () => {
    const s = tabSource();
    const idx = s.indexOf("function isActiveRequest(");
    const end = s.indexOf("\n}", idx);
    const fn = s.slice(idx, end);
    // The only way a confirmed row reaches "true" is through the negated
    // isPastConfirmedLesson check — there is no other confirmed-status
    // branch that could return true regardless of time.
    expect(fn.match(/return/g)?.length).toBe(3);
  });

  it("3. Past contains a past confirmed lesson — isPastRequest's own definition", () => {
    const s = tabSource();
    expect(s).toContain('function isPastRequest(r: Pick<ProLessonRequestRow, "status" | "proposed_starts_at">): boolean {\n  return r.status === "confirmed" && isPastConfirmedLesson(r.status, r.proposed_starts_at);\n}');
  });

  it("4. All retains everything — the filter's 'all' branch has no predicate at all", () => {
    const s = tabSource();
    expect(s).toContain('.filter(r => filter === "active" ? isActiveRequest(r) : filter === "past" ? isPastRequest(r) : true)');
  });

  it("5. pending/proposed existing behavior is unchanged — ACTIVE_STATUSES (used by isActiveRequest's own status membership check and the unrelated isActive display flag) is untouched", () => {
    const s = tabSource();
    expect(s).toContain('const ACTIVE_STATUSES = ["pending", "proposed", "confirmed"];');
  });

  it("the Past tab renders alongside the existing Active/All tabs, with its own count", () => {
    const s = tabSource();
    expect(s).toContain('onClick={() => setFilter("past")}');
    expect(s).toContain("Past {pastCount > 0 && `(${pastCount})`}");
    expect(s).toContain("const pastCount   = requests.filter(isPastRequest).length;");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CARD UX — future confirmed Admin/Staff card
// ═══════════════════════════════════════════════════════════════════════════

describe("future confirmed lesson card actions", () => {
  it("canReschedule (Propose New Time / Revise Proposed Time) now also excludes a past confirmed lesson", () => {
    const s = tabSource();
    const idx = s.indexOf("const canReschedule = (r: ProLessonRequestRow) =>");
    const end = s.indexOf(";", idx);
    const fn = s.slice(idx, end);
    expect(fn).toContain('!(r.status === "confirmed" && isPastConfirmedLesson(r.status, r.proposed_starts_at))');
  });

  it("canReassignFromCard: Admin/Staff (isOperator) only, confirmed status, not past — never Pro, including their own lesson", () => {
    const s = tabSource();
    const idx = s.indexOf("const canReassignFromCard = (r: ProLessonRequestRow) =>");
    const end = s.indexOf(";", idx);
    const fn = s.slice(idx, end);
    expect(fn).toContain("isOperator(userRole)");
    expect(fn).toContain('r.status === "confirmed"');
    expect(fn).toContain("!isPastConfirmedLesson(r.status, r.proposed_starts_at)");
    expect(fn).not.toMatch(/userRole === "pro"/);
  });

  it("canCancelFromCard: Admin/Staff only, confirmed status, not past", () => {
    const s = tabSource();
    const idx = s.indexOf("const canCancelFromCard = (r: ProLessonRequestRow) =>");
    const end = s.indexOf(";", idx);
    const fn = s.slice(idx, end);
    expect(fn).toContain("isOperator(userRole)");
    expect(fn).toContain('r.status === "confirmed"');
    expect(fn).toContain("!isPastConfirmedLesson(r.status, r.proposed_starts_at)");
  });

  it("1. a future confirmed Admin/Staff card renders a Propose New Time button", () => {
    const block = cardBlock();
    expect(block).toContain('"Propose New Time"');
  });

  it("2. a future confirmed Admin/Staff card renders a Reassign Pro button, opening initialSheetMode 'reassign'", () => {
    const block = cardBlock();
    expect(block).toMatch(/canReassignFromCard\(r\) && \([\s\S]{0,300}setInitialSheetMode\("reassign"\)[\s\S]{0,200}Reassign Pro/);
  });

  it("3. a future confirmed Admin/Staff card renders a destructive Cancel Lesson button, opening initialSheetMode 'cancel'", () => {
    const block = cardBlock();
    expect(block).toMatch(/canCancelFromCard\(r\) && \([\s\S]{0,200}setInitialSheetMode\("cancel"\)[\s\S]{0,150}ACTION_BUTTON_DESTRUCTIVE[\s\S]{0,50}Cancel Lesson/);
  });

  it("4. the card-level Cancel button uses initialSheetMode -> LessonProSheet's existing mode='cancel' -> the existing cancelLesson action, never a second cancellation implementation on the card itself", () => {
    const block = cardBlock();
    // No local ReasonForm/confirmation/cancelLesson call exists in the card
    // block itself — it only ever sets state to open the shared sheet.
    expect(block).not.toMatch(/cancelLesson\(/);
    expect(block).not.toContain("ReasonForm");
  });

  it("5. Pro does not gain card-level reassign authority for their own lesson — canReassignFromCard has no pro-ownership branch at all", () => {
    const s = tabSource();
    const idx = s.indexOf("const canReassignFromCard = (r: ProLessonRequestRow) =>");
    const end = s.indexOf(";", idx);
    const fn = s.slice(idx, end);
    expect(fn).not.toContain("r.pro_id === userId");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CARD UX — past confirmed lesson card
// ═══════════════════════════════════════════════════════════════════════════

describe("past confirmed lesson card actions", () => {
  it("6. a past confirmed card does NOT show Propose New Time — the isPastConfirmed branch renders View Details instead of the action-button group entirely", () => {
    const block = cardBlock();
    const idx = block.indexOf("isPastConfirmed ? (");
    expect(idx).toBeGreaterThan(-1);
    const viewDetailsBlock = block.slice(idx, block.indexOf(") : (", idx));
    expect(viewDetailsBlock).not.toMatch(/Propose New Time|Revise Proposed Time/);
  });

  it("7. a past confirmed card does NOT show Reassign Pro", () => {
    const block = cardBlock();
    const idx = block.indexOf("isPastConfirmed ? (");
    const viewDetailsBlock = block.slice(idx, block.indexOf(") : (", idx));
    expect(viewDetailsBlock).not.toContain("Reassign Pro");
  });

  it("8. a past confirmed card does NOT show a direct Cancel Lesson button", () => {
    const block = cardBlock();
    const idx = block.indexOf("isPastConfirmed ? (");
    const viewDetailsBlock = block.slice(idx, block.indexOf(") : (", idx));
    expect(viewDetailsBlock).not.toContain("Cancel Lesson");
  });

  it("9. a past confirmed card instead offers a single View Details action opening the same LessonProSheet (default mode, undefined)", () => {
    const block = cardBlock();
    const idx = block.indexOf("isPastConfirmed ? (");
    const viewDetailsBlock = block.slice(idx, block.indexOf(") : (", idx));
    expect(viewDetailsBlock).toContain("View Details");
    expect(viewDetailsBlock).toContain("setInitialSheetMode(undefined)");
  });

  it("no archive/archived_at concept is introduced anywhere in this file — past status is derived purely from time, never persisted", () => {
    const s = tabSource();
    expect(s).not.toMatch(/archiv/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Member behavior unchanged
// ═══════════════════════════════════════════════════════════════════════════

describe("10. Member behavior is unchanged", () => {
  it("LessonsTab remains gated to canAccessOperationsWorkspace (admin/staff/pro) at the page level — Members never render this component (confirmed unchanged import/gate in events/page.tsx)", () => {
    const s = readSource("src/app/(app)/events/page.tsx");
    expect(s).toContain("const isAdminOrPro   = canAccessOperationsWorkspace(profile?.role);");
  });

  it("canPropose (the pending-request path Member never has any authority over) is untouched by this phase", () => {
    const s = tabSource();
    expect(s).toContain(
      'const canPropose = (r: ProLessonRequestRow) =>\n' +
      '    r.status === "pending" &&\n' +
      '    (isOperator(userRole) || (userRole === "pro" && r.pro_id === userId));',
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// LessonProSheet — sheet-level Reassign Pro for a future confirmed lesson,
// and reused Cancel Lesson / Reassign Pro form
// ═══════════════════════════════════════════════════════════════════════════

describe("LessonProSheet: sheet-level Reassign Pro on a future confirmed lesson", () => {
  it("a SEPARATE condition (not a broadening of the existing pending/proposed reassign button) shows Reassign Pro for isOperator + confirmed + not-past", () => {
    const s = sheetSource();
    const idx = s.indexOf("request.status === \"confirmed\" &&\n            !isPastConfirmedLesson(request.status, request.proposed_starts_at)");
    expect(idx).toBeGreaterThan(-1);
  });

  it("the pre-existing pending/proposed reassign button condition is byte-identical to before this phase", () => {
    const s = sheetSource();
    expect(s).toContain(
      'isOperator(userRole) && (pros?.length ?? 0) > 0 &&\n' +
      '            (request.status === "pending" || request.status === "proposed") &&\n' +
      '            !request.linked_reservation_id',
    );
  });

  it("the reassign submit branches by status: confirmed -> reassignConfirmedLessonProAction, else -> the unmodified reassignLessonProviderAction", () => {
    const s = sheetSource();
    expect(s).toMatch(/request\.status === "confirmed"\s*\n\s*\?\s*reassignConfirmedLessonProAction\(\{/);
    expect(s).toContain(": reassignLessonProviderAction(\n                  request.id,\n                  newProId,\n                  request.member_id,\n                  request.pro_id,\n                ))");
  });

  it("security review correction: the confirmed-path call site passes only mutation intent — never oldProId/memberId/actorId, which the action now derives server-side from trusted state", () => {
    const s = sheetSource();
    const idx = s.indexOf("reassignConfirmedLessonProAction({");
    const end = s.indexOf("})", idx);
    const call = s.slice(idx, end);
    expect(call).toContain("requestId:         request.id");
    expect(call).toContain("expectedUpdatedAt: request.updated_at");
    expect(call).toContain("newProId,");
    expect(call).toContain("expectedClubId:    clubId");
    expect(call).not.toMatch(/oldProId|memberId|actorId/);
  });

  it("no second Reassign Pro select/form is built for the confirmed case — the SAME mode === 'reassign' JSX block (pro <select>, exclude-current-pro filter) serves both", () => {
    const s = sheetSource();
    const occurrences = s.split('{mode === "reassign" && (').length - 1;
    expect(occurrences).toBe(1);
  });

  it("the reassign form still excludes the currently assigned pro from the <select> options", () => {
    const s = sheetSource();
    expect(s).toContain(".filter(p => p.id !== request.pro_id)");
  });
});

describe("LessonProSheet: Cancel Lesson wiring is fully reused, not duplicated", () => {
  it("initialMode now also accepts 'cancel' and 'reassign' (widened from 'propose' only) so a card button can open directly into either existing mode", () => {
    const s = sheetSource();
    expect(s).toContain('initialMode?: "propose" | "cancel" | "reassign";');
  });

  it("the mode === 'cancel' block (ReasonForm + cancelLesson call) is untouched by this phase — the exact same confirmation/reason flow serves both the card-triggered and sheet-triggered path", () => {
    const s = sheetSource();
    expect(s).toContain('title="Cancel this confirmed lesson? It will be removed from the calendar."');
    expect(s).toContain("submitLabel=\"Cancel Lesson\"");
    expect(s).toContain("destructive");
    expect(s).toMatch(/onSubmit=\{\(\) => doAction\(\(\) => cancelLesson\(\{/);
  });

  it("only one cancelLesson call site exists in this file — no second cancellation implementation was introduced", () => {
    const s = sheetSource();
    const occurrences = s.split("cancelLesson({").length - 1;
    expect(occurrences).toBe(1);
  });

  it("the sheet's own default-list Cancel Lesson button condition (confirmed, or a pending reschedule) is untouched — still shows for a PAST confirmed lesson too, preserving Admin/Staff's historical-correction ability inside the detail experience", () => {
    const s = sheetSource();
    expect(s).toContain(
      '{(request.status === "confirmed" ||\n' +
      '            (request.status === "proposed" && request.linked_reservation_id)) && (',
    );
  });
});

describe("multi-club correction: confirmed reassign uses a SEPARATE, club_memberships-backed provider list — pending/proposed keeps the existing pros prop untouched", () => {
  it("declares confirmedReassignPros state, independent of the pros prop", () => {
    const s = sheetSource();
    expect(s).toContain("const [confirmedReassignPros, setConfirmedReassignPros] = useState<ClubPro[] | null>(null);");
  });

  it("lazily fetches via getConfirmedReassignmentProsAction ONLY when mode is 'reassign' AND status is 'confirmed' AND not already fetched", () => {
    const s = sheetSource();
    const idx = s.indexOf("if (mode !== \"reassign\" || request.status !== \"confirmed\" || confirmedReassignPros !== null) return;");
    expect(idx).toBeGreaterThan(-1);
    const block = s.slice(idx, idx + 400);
    expect(block).toContain("getConfirmedReassignmentProsAction()");
    expect(block).toContain("setConfirmedReassignPros(res.pros ?? [])");
  });

  it("getConfirmedReassignmentProsAction is imported alongside (never replacing) reassignLessonProviderAction/reassignConfirmedLessonProAction", () => {
    const s = sheetSource();
    expect(s).toContain("getConfirmedReassignmentProsAction,");
    expect(s).toContain("reassignLessonProviderAction,");
  });

  it("the <select> sources options from confirmedReassignPros for a CONFIRMED request, and from the existing pros prop for every other status — same filter/map, only the array differs", () => {
    const s = sheetSource();
    expect(s).toContain(
      '(request.status === "confirmed" ? (confirmedReassignPros ?? []) : (pros ?? []))\n' +
      "                .filter(p => p.id !== request.pro_id)",
    );
  });

  it("pending/proposed reassignment reads ONLY the pros prop in that branch of the <select> — confirmedReassignPros never substitutes for it there", () => {
    const s = sheetSource();
    const idx = s.indexOf('(request.status === "confirmed" ? (confirmedReassignPros ?? []) : (pros ?? []))');
    expect(idx).toBeGreaterThan(-1);
    // The ternary's false branch (non-confirmed / pending-proposed) is
    // exactly `(pros ?? [])` — unchanged from before this correction.
    expect(s.slice(idx)).toContain(": (pros ?? []))");
  });

  it("no second reassign <select>/form exists for the confirmed case — still exactly one mode === 'reassign' JSX block total", () => {
    const s = sheetSource();
    const occurrences = s.split('{mode === "reassign" && (').length - 1;
    expect(occurrences).toBe(1);
  });
});

describe("multi-club correction does not grant new Pro/Member reassignment authority", () => {
  it("the sheet's own future-confirmed Reassign Pro button remains isOperator-gated (admin/staff), unaffected by the new provider-list source", () => {
    const s = sheetSource();
    expect(s).toMatch(/isOperator\(userRole\) && \(pros\?\.length \?\? 0\) > 0 &&\s*\n\s*request\.status === "confirmed"/);
  });

  it("getConfirmedReassignmentProsAction itself carries no client-supplied role/club parameter — authorization is entirely the RPC's own current_user_role()/current_user_club_id() check (see reassignConfirmedLessonProAction.regression.test.ts for the RPC-side proof)", () => {
    const actionsSrc = readSource("src/app/(app)/lessons/actions.ts");
    const idx = actionsSrc.indexOf("export async function getConfirmedReassignmentProsAction(");
    const end = actionsSrc.indexOf("\n}", actionsSrc.indexOf("return { pros:", idx));
    const fn = actionsSrc.slice(idx, end);
    expect(fn).toContain("export async function getConfirmedReassignmentProsAction(): Promise<");
  });
});
