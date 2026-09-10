import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Admin UX Checkpoint 3 — Lessons IA. Lesson Types moves from
// /admin/settings into /admin/lessons, as a second, Admin-only tab
// ("Lesson Requests" | "Lesson Types") — /admin/lessons had no pre-existing
// tab mechanism, so this uses the same Link + searchParams pattern already
// established for /admin/courts' three tabs. Pro/Staff never see the tab
// strip at all; their page renders exactly as before this checkpoint.
// LessonTypesSection/lessonTypesActions.ts moved as a self-contained pair
// with zero content changes (their relative import between them still
// resolves correctly since both moved to the same new directory together).
//
// Source-inspection style, matching this directory's established
// convention (see courtsInformationArchitecture.regression.test.ts).

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const LESSONS_PAGE_PATH = "src/app/(app)/admin/lessons/page.tsx";
const LESSON_TYPES_SECTION_PATH = "src/app/(app)/admin/lessons/LessonTypesSection.tsx";
const LESSON_TYPES_ACTIONS_PATH = "src/app/(app)/admin/lessons/lessonTypesActions.ts";
const ADMIN_LESSONS_WRAPPER_PATH = "src/app/(app)/admin/lessons/AdminLessonsWrapper.tsx";
const SETTINGS_ACTIONS_PATH = "src/app/(app)/admin/settings/actions.ts";

describe("2. Lesson Types no longer lives in admin/settings", () => {
  it("lessonTypesActions.ts/upsert_lesson_type are absent from settings/actions.ts (they never lived there — confirms no stray duplicate was left behind)", () => {
    const s = readSource(SETTINGS_ACTIONS_PATH);
    expect(s).not.toContain("upsert_lesson_type");
    expect(s).not.toContain("archive_lesson_type");
  });
});

describe("4. Admin can reach Lesson Types from Lessons", () => {
  it("the page declares a requests/types tab type and resolves it via resolveLessonsTab", () => {
    const s = readSource(LESSONS_PAGE_PATH);
    expect(s).toContain('type LessonsTab = "requests" | "types";');
    expect(s).toContain("function resolveLessonsTab(raw: string | undefined, isAdmin: boolean): LessonsTab {");
    expect(s).toContain('const tab = resolveLessonsTab(sp.tab, userRole === "admin");');
  });

  it("the Lesson Types tab renders LessonTypesSection with the already-fetched currency/lessonTypes — no second query", () => {
    const s = readSource(LESSONS_PAGE_PATH);
    expect(s).toContain('import LessonTypesSection from "./LessonTypesSection";');
    expect(s).toContain('<LessonTypesSection currency={currency} initialTypes={lessonTypes} />');
    // Exactly one actual get_lesson_types RPC call — reused, not
    // duplicated (a second, unrelated mention of the name appears in this
    // file's own explanatory comment, hence matching the RPC call itself
    // rather than a bare substring count).
    expect((s.match(/supabase\.rpc\("get_lesson_types"\)/g) ?? []).length).toBe(1);
  });

  it('href="/admin/lessons?tab=types" is the exact tab link', () => {
    const s = readSource(LESSONS_PAGE_PATH);
    expect(s).toContain('href: "/admin/lessons?tab=types"');
  });
});

describe("5. non-Admin roles do not receive the Lesson Types destination", () => {
  it("the tab strip is rendered only when userRole === \"admin\" — Pro/Staff see no tab UI at all, not a disabled/hidden one", () => {
    const s = readSource(LESSONS_PAGE_PATH);
    expect(s).toContain('{userRole === "admin" && (');
  });

  it('resolveLessonsTab requires isAdmin true for "types" — any non-admin caller (or unknown tab value) falls back to "requests"', () => {
    const s = readSource(LESSONS_PAGE_PATH);
    expect(s).toContain('return raw === "types" && isAdmin ? "types" : "requests";');
  });
});

describe("7. existing Lesson Type RPC/actions are unchanged", () => {
  it("upsert_lesson_type and archive_lesson_type are called with their original names/params", () => {
    const s = readSource(LESSON_TYPES_ACTIONS_PATH);
    expect(s).toContain('supabase.rpc("upsert_lesson_type", {');
    expect(s).toContain('supabase.rpc("archive_lesson_type", { p_type_id: id });');
  });

  it("every error message is byte-identical to the pre-move version", () => {
    const s = readSource(LESSON_TYPES_ACTIONS_PATH);
    expect(s).toContain('allowed_durations_invalid: "Durations must be positive multiples of 15 minutes."');
    expect(s).toContain('unit_price_invalid:       "Amount must be zero or a positive amount."');
  });

  it("LessonTypesSection.tsx's own relative import to lessonTypesActions still resolves (both moved to the same new directory together)", () => {
    const s = readSource(LESSON_TYPES_SECTION_PATH);
    expect(s).toContain('} from "./lessonTypesActions";');
  });

  it("pricing/duration configuration semantics (flat vs hourly, pricing notes, durations) are untouched", () => {
    const s = readSource(LESSON_TYPES_SECTION_PATH);
    expect(s).toContain('{ basis === "flat" ? "Total price per lesson" : "Total hourly lesson rate" }'.replace(/\s*\{\s*/, "{").replace(/\s*\}\s*/, "}"));
    expect(s).toContain("function parseDurations(raw: string): number[] | null {");
  });
});

describe("9. operational Lessons Admin/Pro scoping is unchanged", () => {
  it("AdminLessonsWrapper (the Pro/Admin operational lesson-request board) is untouched — same LessonsTab reuse, same Book Lesson sheet", () => {
    const s = readSource(ADMIN_LESSONS_WRAPPER_PATH);
    expect(s).toContain('import LessonsTab from "@/app/(app)/events/LessonsTab";');
    expect(s).toContain("<AdminRequestLessonSheet");
    expect(s).toContain('pros={isOperator(userRole) ? pros : undefined}');
  });

  it("for the requests tab (the only tab Pro/Staff ever see), AdminLessonsWrapper receives the exact same props as before this checkpoint", () => {
    const s = readSource(LESSONS_PAGE_PATH);
    const wrapperStart = s.indexOf("<AdminLessonsWrapper");
    const wrapperEnd = s.indexOf("/>", wrapperStart);
    const wrapperJsx = s.slice(wrapperStart, wrapperEnd);
    for (const prop of ["requests", "courts", "userId", "userName", "userRole", "clubId", "clubTimezone", "pros", "rosterMembers", "lessonTypes", "currency"]) {
      expect(wrapperJsx, `${prop} prop missing from AdminLessonsWrapper`).toContain(`${prop}=`);
    }
  });

  it("Pro/Staff role gating (canAccessOperationsWorkspace) at the page level is unchanged", () => {
    const s = readSource(LESSONS_PAGE_PATH);
    expect(s).toContain("if (!profile || !canAccessOperationsWorkspace(profile.role)) redirect(\"/calendar\");");
  });
});

// 11. "no migration was added by this checkpoint" was previously asserted
// here as a hardcoded "highest migration === N" ceiling. Removed: that
// pattern cannot hold as an evergreen invariant across later, unrelated
// checkpoints (0170 has since been added by the Communications checkpoint)
// — see topLevelBackLinkCleanup.regression.test.ts's own note on this same
// cleanup.

describe("12. no Phase 34 Payments behavior touched", () => {
  it("lessonTypesActions.ts never references payment_events/amount_due_cents/amount_paid_cents/stripe", () => {
    const s = readSource(LESSON_TYPES_ACTIONS_PATH);
    expect(s).not.toMatch(/payment_events|amount_due_cents|amount_paid_cents|stripe_/i);
  });
});
