import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeMemberUpcomingActivity, normalizeMemberHistoryActivity } from "./activityNormalization";
import type { Database } from "@/lib/db/types";

// Phase 45C1B — Member Activity Details Normalization.
//
// get_member_upcoming_activity/get_member_activity_history (migration 0132)
// return activity-specific data nested inside a `details` jsonb column, not
// as flat top-level columns. The application previously read several flat
// fields (pro_first_name, pro_last_name, proposed_starts_at, proposed_
// ends_at, proposed_court_name) that never actually existed on either raw
// RPC row — a pre-existing bug predating Phase 45C (every upcoming lesson
// always rendered "Awaiting proposal", since proposed_starts_at was always
// undefined at runtime). Fixed at the server/application boundary: a pure
// normalization adapter (activityNormalization.ts) both page.tsx's initial
// load and loadMoreMemberHistoryAction's pagination pass through, so they
// cannot drift from each other and MemberDetailClient never learns the raw
// jsonb schema.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const CLIENT_PATH     = "src/app/(app)/admin/members/[id]/MemberDetailClient.tsx";
const ACTIONS_PATH    = "src/app/(app)/admin/members/[id]/actions.ts";
const PAGE_PATH       = "src/app/(app)/admin/members/[id]/page.tsx";
const NORMALIZER_PATH = "src/app/(app)/admin/members/[id]/activityNormalization.ts";
const TYPES_PATH      = "src/lib/db/types.ts";
const MIGRATION_0211_PATH = "supabase/migrations/0211_member_notes_schema_reconciliation.sql";
const MIGRATION_0212_PATH = "supabase/migrations/0212_restore_member_note.sql";

type RawUpcomingRow = Database["public"]["Functions"]["get_member_upcoming_activity"]["Returns"][number];
type RawHistoryRow  = Database["public"]["Functions"]["get_member_activity_history"]["Returns"][number];

function rawUpcomingRow(overrides: Partial<RawUpcomingRow> = {}): RawUpcomingRow {
  return {
    activity_id:       "act-1",
    activity_type:     "event",
    title:             "Club Mixer",
    starts_at:         "2026-01-01T10:00:00Z",
    ends_at:           "2026-01-01T12:00:00Z",
    status:            "confirmed",
    attendance_status: null,
    outcome:           null,
    details:           {},
    ...overrides,
  };
}

function rawHistoryRow(overrides: Partial<RawHistoryRow> = {}): RawHistoryRow {
  return {
    activity_id:       "act-1",
    activity_type:     "event",
    title:             "Club Mixer",
    starts_at:         "2026-01-01T10:00:00Z",
    ends_at:           "2026-01-01T12:00:00Z",
    status:            "cancelled",
    attendance_status: null,
    outcome:           null,
    details:           {},
    sort_ts:           "2026-01-01T10:00:00Z",
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 1-3. Unit tests: each activity_type normalizes its documented details
// fields.
// ─────────────────────────────────────────────────────────────────────────

describe("normalizeMemberUpcomingActivity — per activity_type", () => {
  it("event row: normalizes safely; event's own details keys (event_type/event_color/ep_role) are real but unused, so court_name/pro_name/duration_minutes stay null", () => {
    const row = rawUpcomingRow({
      activity_id: "ev-1", activity_type: "event", title: "Club Mixer",
      details: { event_type: "Social", event_color: "#fff", ep_role: "participant" },
    });
    const result = normalizeMemberUpcomingActivity(row);
    expect(result.activity_id).toBe("ev-1");
    expect(result.activity_type).toBe("event");
    expect(result.title).toBe("Club Mixer");
    expect(result.court_name).toBeNull();
    expect(result.pro_name).toBeNull();
    expect(result.duration_minutes).toBeNull();
  });

  it("lesson row: normalizes documented pro_name and duration_minutes; no court field exists for lessons at all (never fabricated)", () => {
    const row = rawUpcomingRow({
      activity_id: "lr-1", activity_type: "lesson", title: "Beginner Clinic",
      details: { pro_id: "p1", pro_name: "Jane Pro", lesson_type: "Private", duration_minutes: 60 },
    });
    const result = normalizeMemberUpcomingActivity(row);
    expect(result.pro_name).toBe("Jane Pro");
    expect(result.duration_minutes).toBe(60);
    expect(result.court_name).toBeNull();
  });

  it("reservation row: normalizes documented court_name; no pro/duration fields exist for reservations", () => {
    const row = rawUpcomingRow({
      activity_id: "r1", activity_type: "reservation", title: "Court 3",
      details: { court_id: "c1", court_name: "Court 3", format: "singles", notes: null },
    });
    const result = normalizeMemberUpcomingActivity(row);
    expect(result.court_name).toBe("Court 3");
    expect(result.pro_name).toBeNull();
    expect(result.duration_minutes).toBeNull();
  });
});

describe("normalizeMemberHistoryActivity — per activity_type, plus lesson_outcome from the TOP-LEVEL outcome column", () => {
  it("lesson row: normalizes pro_name/duration_minutes from details, and lesson_outcome from the raw top-level outcome column (not details)", () => {
    const row = rawHistoryRow({
      activity_type: "lesson", status: "confirmed", outcome: "completed",
      details: { pro_id: "p1", pro_name: "Jane Pro", lesson_type: "Private", duration_minutes: 60, cancelled_at: null },
    });
    const result = normalizeMemberHistoryActivity(row);
    expect(result.pro_name).toBe("Jane Pro");
    expect(result.duration_minutes).toBe(60);
    expect(result.lesson_outcome).toBe("completed");
  });

  it("reservation row: normalizes documented court_name", () => {
    const row = rawHistoryRow({
      activity_type: "reservation", status: "cancelled",
      details: { court_id: "c1", court_name: "Court 5", format: "doubles", cancelled_at: "2026-01-05T00:00:00Z" },
    });
    const result = normalizeMemberHistoryActivity(row);
    expect(result.court_name).toBe("Court 5");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4-8. JSON safety — never throws, always degrades to null.
// ─────────────────────────────────────────────────────────────────────────

describe("defensive details extraction never throws and degrades to null", () => {
  it("null details does not throw and yields null for every details-derived field", () => {
    const row = rawUpcomingRow({ activity_type: "lesson", details: null });
    expect(() => normalizeMemberUpcomingActivity(row)).not.toThrow();
    const result = normalizeMemberUpcomingActivity(row);
    expect(result.court_name).toBeNull();
    expect(result.pro_name).toBeNull();
    expect(result.duration_minutes).toBeNull();
  });

  it("a primitive details value (string/number/boolean) does not throw", () => {
    for (const primitive of ["oops", 42, true] as const) {
      const row = rawUpcomingRow({ details: primitive as unknown as RawUpcomingRow["details"] });
      expect(() => normalizeMemberUpcomingActivity(row)).not.toThrow();
      const result = normalizeMemberUpcomingActivity(row);
      expect(result.court_name).toBeNull();
      expect(result.pro_name).toBeNull();
      expect(result.duration_minutes).toBeNull();
    }
  });

  it("array details does not throw", () => {
    const row = rawUpcomingRow({ details: [1, 2, 3] as unknown as RawUpcomingRow["details"] });
    expect(() => normalizeMemberUpcomingActivity(row)).not.toThrow();
    const result = normalizeMemberUpcomingActivity(row);
    expect(result.court_name).toBeNull();
    expect(result.pro_name).toBeNull();
    expect(result.duration_minutes).toBeNull();
  });

  it("a details field with an unexpected type becomes null, never coerced (string where number expected, number where string expected)", () => {
    const row = rawUpcomingRow({
      activity_type: "lesson",
      details: { pro_name: 12345, duration_minutes: "60" } as unknown as RawUpcomingRow["details"],
    });
    const result = normalizeMemberUpcomingActivity(row);
    expect(result.pro_name).toBeNull();
    expect(result.duration_minutes).toBeNull();
  });

  it("missing details keys become null (an empty {} details object)", () => {
    const row = rawUpcomingRow({ activity_type: "lesson", details: {} });
    const result = normalizeMemberUpcomingActivity(row);
    expect(result.pro_name).toBeNull();
    expect(result.duration_minutes).toBeNull();
    expect(result.court_name).toBeNull();
  });

  it("the same JSON-safety holds for history rows too", () => {
    for (const details of [null, "oops", 42, [1, 2]] as unknown[] as RawHistoryRow["details"][]) {
      const row = rawHistoryRow({ activity_type: "lesson", details });
      expect(() => normalizeMemberHistoryActivity(row)).not.toThrow();
      const result = normalizeMemberHistoryActivity(row);
      expect(result.pro_name).toBeNull();
      expect(result.duration_minutes).toBeNull();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 9-10. Canonical top-level fields (and sort_ts for history) are preserved
// unchanged.
// ─────────────────────────────────────────────────────────────────────────

describe("canonical top-level fields are preserved exactly", () => {
  it("upcoming: activity_id/activity_type/title/starts_at/ends_at/status/attendance_status/outcome pass through unchanged", () => {
    const row = rawUpcomingRow({
      activity_id: "x1", activity_type: "reservation", title: "Court 1",
      starts_at: "2026-02-01T00:00:00Z", ends_at: "2026-02-01T01:00:00Z",
      status: "confirmed", attendance_status: null, outcome: null,
    });
    const result = normalizeMemberUpcomingActivity(row);
    expect(result).toMatchObject({
      activity_id: "x1", activity_type: "reservation", title: "Court 1",
      starts_at: "2026-02-01T00:00:00Z", ends_at: "2026-02-01T01:00:00Z",
      status: "confirmed", attendance_status: null, outcome: null,
    });
  });

  it("upcoming: a real, non-null attendance_status (event branch) passes through unchanged", () => {
    const row = rawUpcomingRow({ activity_type: "event", attendance_status: "attended" });
    const result = normalizeMemberUpcomingActivity(row);
    expect(result.attendance_status).toBe("attended");
  });

  it("history: sort_ts is preserved exactly", () => {
    const row = rawHistoryRow({ sort_ts: "2025-12-25T00:00:00Z" });
    const result = normalizeMemberHistoryActivity(row);
    expect(result.sort_ts).toBe("2025-12-25T00:00:00Z");
  });

  it("history: activity_id/activity_type/title/starts_at/ends_at/status/attendance_status pass through unchanged", () => {
    const row = rawHistoryRow({
      activity_id: "h1", activity_type: "event", title: "Cancelled Mixer",
      starts_at: "2026-03-01T00:00:00Z", ends_at: "2026-03-01T02:00:00Z",
      status: "cancelled", attendance_status: null,
    });
    const result = normalizeMemberHistoryActivity(row);
    expect(result).toMatchObject({
      activity_id: "h1", activity_type: "event", title: "Cancelled Mixer",
      starts_at: "2026-03-01T00:00:00Z", ends_at: "2026-03-01T02:00:00Z",
      status: "cancelled", attendance_status: null,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 11-12. Both call sites pass through the SAME adapter.
// ─────────────────────────────────────────────────────────────────────────

describe("initial page load and history pagination both use the same normalization adapter", () => {
  it("page.tsx imports and applies normalizeMemberUpcomingActivity/normalizeMemberHistoryActivity, not a blind `as` cast", () => {
    const s = readSource(PAGE_PATH);
    expect(s).toContain('import { normalizeMemberUpcomingActivity, normalizeMemberHistoryActivity } from "./activityNormalization";');
    expect(s).toContain("(upcomingResult.data ?? []).map(normalizeMemberUpcomingActivity)");
    expect(s).toContain("(historyResult.data ?? []).map(normalizeMemberHistoryActivity)");
    expect(s).not.toContain("as UpcomingItem[]");
    expect(s).not.toContain("as HistoryItem[]");
  });

  it("loadMoreMemberHistoryAction applies the SAME normalizeMemberHistoryActivity function, not a duplicate mapping", () => {
    const s = readSource(ACTIONS_PATH);
    expect(s).toContain('import { normalizeMemberHistoryActivity, type HistoryItem } from "./activityNormalization";');
    const idx = s.indexOf("export async function loadMoreMemberHistoryAction(");
    expect(idx).toBeGreaterThan(-1);
    const block = s.slice(idx, s.indexOf("\n}", idx));
    expect(block).toContain("(data ?? []).map(normalizeMemberHistoryActivity)");
    expect(block).not.toContain("as HistoryItem[]");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 13-14. MemberDetailClient never learns the raw jsonb schema.
// ─────────────────────────────────────────────────────────────────────────

describe("MemberDetailClient contains no raw `.details` access and no duplicate mapping logic", () => {
  it("no `.details` property access anywhere in MemberDetailClient.tsx", () => {
    const s = readSource(CLIENT_PATH);
    expect(s).not.toMatch(/\.details\b/);
    expect(s).not.toMatch(/\bdetails\[/);
  });

  it("no fabricated fields (pro_first_name/pro_last_name/proposed_starts_at/proposed_ends_at/proposed_court_name) remain anywhere", () => {
    const s = readSource(CLIENT_PATH);
    for (const stale of [
      "pro_first_name", "pro_last_name",
      "proposed_starts_at", "proposed_ends_at", "proposed_court_name",
    ]) {
      expect(s).not.toContain(stale);
    }
  });

  it("the Upcoming lesson block reads item.pro_name and item.starts_at directly, not a fabricated conditional", () => {
    const s = readSource(CLIENT_PATH);
    expect(s).toContain("{item.pro_name ?? \"Pro\"}");
    expect(s).not.toContain("Awaiting proposal");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 15-16. The stale full-return overrides are gone from types.ts.
// ─────────────────────────────────────────────────────────────────────────

describe("types.ts no longer hand-declares the full stale Returns shape for either activity RPC", () => {
  it("get_member_upcoming_activity's override is the narrow OverrideArrayReturns form, not a full object literal", () => {
    const s = readSource(TYPES_PATH);
    expect(s).not.toContain("pro_first_name: string | null;");
    expect(s).not.toContain("proposed_starts_at: string | null;");
    expect(s).toContain("get_member_upcoming_activity: OverrideArrayReturns<");
  });

  it("get_member_activity_history's override is the narrow OverrideArrayReturns form, not a full object literal", () => {
    const s = readSource(TYPES_PATH);
    expect(s).toContain("get_member_activity_history: OverrideArrayReturns<");
    // Both overrides share the same narrow correction object; confirm it's
    // the literal-union + nullability shape, not a full return redeclare.
    const idx = s.indexOf("get_member_upcoming_activity: OverrideArrayReturns<");
    const end = s.indexOf("\n};", idx);
    const block = s.slice(idx, end);
    expect(block).toContain('activity_type: "reservation" | "event" | "lesson";');
    expect(block).toContain("attendance_status: string | null;");
    expect(block).toContain("outcome: string | null;");
    expect(block).not.toContain("court_name");
    expect(block).not.toContain("duration_minutes");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 17. Raw types derive from the generated Database function return types.
// ─────────────────────────────────────────────────────────────────────────

describe("the normalizer's raw input types derive from Database's generated Functions, not a hand-copied structure", () => {
  it("activityNormalization.ts declares its raw row types via Database[\"public\"][\"Functions\"][...][\"Returns\"][number], never a hand-copied interface", () => {
    const s = readSource(NORMALIZER_PATH);
    expect(s).toContain('Database["public"]["Functions"]["get_member_upcoming_activity"]["Returns"][number]');
    expect(s).toContain('Database["public"]["Functions"]["get_member_activity_history"]["Returns"][number]');
    expect(s).toContain('import type { Database, Json } from "@/lib/db/types";');
  });

  it("Database[\"public\"][\"Functions\"] (composed, includes the narrow types.ts corrections) is reachable and its Returns row carries a details key — confirming this is real generated structure, not fabricated", () => {
    // Type-level: if this file compiles, Database's composed Functions map
    // really does expose get_member_upcoming_activity/get_member_activity_
    // history with a `details` field on each Returns row.
    const sample: RawUpcomingRow["details"] = null;
    expect(sample).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 18. Unrelated domain overrides remain untouched.
// ─────────────────────────────────────────────────────────────────────────

describe("unrelated, previously-justified domain overrides in types.ts are untouched", () => {
  it("get_member_notes' nullable author_id/archived_at/archived_by refinement is still present", () => {
    const s = readSource(TYPES_PATH);
    expect(s).toContain("get_member_notes: OverrideArrayReturns<");
    expect(s).toContain('Pick<GeneratedTables["member_notes"]["Row"], "author_id" | "archived_at" | "archived_by">');
  });

  it("add_member_note's narrow Pick-derived Returns refinement is still present", () => {
    const s = readSource(TYPES_PATH);
    expect(s).toContain("add_member_note: Omit<GeneratedFunctions[\"add_member_note\"], \"Returns\">");
  });

  it("CHECK-domain TablesOverride entries (club_settings, payments, profiles, reservations) are still present", () => {
    const s = readSource(TYPES_PATH);
    expect(s).toContain("type ClubSettingsRow");
    expect(s).toContain("type PaymentsRow");
    expect(s).toContain("type ProfilesRow");
    expect(s).toContain("type ReservationsRow");
  });

  it("restore_member_note still flows through from GeneratedFunctions unmodified (Phase 45C1A3 — not reintroduced as an override)", () => {
    const s = readSource(TYPES_PATH);
    expect(s).not.toMatch(/restore_member_note:\s*\{/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 19-20. 0211/0212 untouched.
// ─────────────────────────────────────────────────────────────────────────

// "0212 is the highest migration — no 0213" was previously asserted here as
// a hardcoded "highest migration === 212" ceiling. Removed: that pattern is
// invalid for a historical checkpoint's regression suite — it cannot prove
// no LATER, unrelated checkpoint will ever add a migration (several have
// since: 0213-0216, added by Phase 45D). The two content checks below
// continue to prove 0211/0212 remain byte-for-byte as this checkpoint left
// them; migration-specific claims for later migrations belong in the test
// suite of the checkpoint that actually owns them. See
// topLevelBackLinkCleanup.regression.test.ts's own note on this same
// cleanup.
describe("0211 and 0212 remain byte-for-byte untouched", () => {
  it("0211 still contains its full evolved content (all three correction rounds)", () => {
    const s = readSource(MIGRATION_0211_PATH);
    expect(s).toContain("-- 0211_member_notes_schema_reconciliation.sql");
    expect(s).toContain("-- 1a. member_notes — member_id FK convergence (ON DELETE CASCADE)");
    expect(s).toContain("\\mlength\\s*\\(");
    expect(s.trim().endsWith("commit;")).toBe(true);
  });

  it("0212 still contains its full restore_member_note contract", () => {
    const s = readSource(MIGRATION_0212_PATH);
    expect(s).toContain("-- 0212_restore_member_note.sql");
    expect(s).toContain("create or replace function public.restore_member_note(");
    expect(s).toContain("if not v_note.is_archived then raise exception 'note_not_archived'; end if;");
    expect(s.trim().endsWith("commit;")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Phase 45C1B visual closeout — Lesson outcome action buttons ("Record
// outcome", "Change") were bare text-links inconsistent with the compact
// bordered action-button vocabulary already used elsewhere on this exact
// page (Lesson Pro Enable/Disable, Member Notes Edit/Archive/Restore).
// Restyled to the same ACTION_BUTTON_SECONDARY_COMPACT constant — styling
// only, no wording/behavior/RPC/permission change. Event attendance is a
// deliberately separate, untouched concept — no Event outcome action exists
// or was added.
// ─────────────────────────────────────────────────────────────────────────

describe("Lesson outcome action buttons reuse ACTION_BUTTON_SECONDARY_COMPACT (styling-only fix)", () => {
  it("'Change' (shown once an outcome is already recorded) uses ACTION_BUTTON_SECONDARY_COMPACT, not its old bare gray text-link (the visually-identical Attendance 'Clear' button elsewhere on this page is a DIFFERENT, untouched control — this check is scoped to Change's own onClick, not a file-wide ban on that class string)", () => {
    const s = readSource(CLIENT_PATH);
    const idx = s.indexOf("onClick={() => setOutcomeModeId(item.activity_id)}");
    expect(idx).toBeGreaterThan(-1);
    const block = s.slice(idx, idx + 220);
    expect(block).toContain("className={ACTION_BUTTON_SECONDARY_COMPACT}");
    expect(block).not.toContain('className="text-xs text-gray-400');
    expect(block).toContain("Change");
  });

  it("'Record outcome' uses ACTION_BUTTON_SECONDARY_COMPACT, not a bare accent text-link", () => {
    const s = readSource(CLIENT_PATH);
    expect(s).not.toContain('className="text-xs font-medium text-accent hover:underline disabled:opacity-40"');
    const idx = s.indexOf("Record outcome");
    expect(idx).toBeGreaterThan(-1);
    const block = s.slice(Math.max(0, idx - 250), idx);
    expect(block).toContain("className={ACTION_BUTTON_SECONDARY_COMPACT}");
  });

  it("the outcome-option pills and their Cancel button are untouched (only Record outcome/Change were in scope)", () => {
    const s = readSource(CLIENT_PATH);
    expect(s).toContain(
      "className=\"px-2.5 py-1 rounded-lg text-xs font-medium border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-accent hover:text-accent motion-safe:transition-colors disabled:opacity-40\"",
    );
    expect(s).toContain('className="text-xs text-gray-400 hover:text-gray-600"');
  });

  it("outcome wording, handler wiring, and the underlying RPC action are unchanged", () => {
    const s = readSource(CLIENT_PATH);
    expect(s).toContain("Record outcome");
    expect(s).toContain(">\n                                  Change\n");
    expect(s).toContain("onClick={() => handleOutcome(item.activity_id, item.activity_id, opt.value)}");
    const handlerIdx = s.indexOf("function handleOutcome(");
    expect(handlerIdx).toBeGreaterThan(-1);
    const handlerBlock = s.slice(handlerIdx, s.indexOf("\n  }\n", handlerIdx));
    expect(handlerBlock).toContain("recordLessonOutcomeFromDetailAction(");
  });

  it("Event attendance controls remain present and untouched — no Event outcome concept was introduced", () => {
    const s = readSource(CLIENT_PATH);
    expect(s).toContain("ATTENDANCE_OPTIONS.map(opt =>");
    expect(s).toContain('"Attended" : "No-Show"');
    expect(s).toContain("onClick={() => handleAttendance(item.activity_id, item.activity_id, opt.value)}");

    // Confirm "Record outcome"/outcome controls live ONLY inside the lesson
    // branch, never inside the event branch.
    const eventBlockStart = s.indexOf('{item.activity_type === "event" && (');
    const eventBlockEnd   = s.indexOf('{item.activity_type === "lesson" && (', eventBlockStart);
    expect(eventBlockStart).toBeGreaterThan(-1);
    expect(eventBlockEnd).toBeGreaterThan(eventBlockStart);
    const eventBlock = s.slice(eventBlockStart, eventBlockEnd);
    expect(eventBlock).not.toContain("Record outcome");
    expect(eventBlock).not.toContain("handleOutcome");
  });

  it("activityNormalization.ts itself is untouched by this styling-only checkpoint", () => {
    const s = readSource(NORMALIZER_PATH);
    expect(s).toContain("export function normalizeMemberUpcomingActivity(row: RawUpcomingRow): UpcomingItem {");
    expect(s).toContain("export function normalizeMemberHistoryActivity(row: RawHistoryRow): HistoryItem {");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Lesson outcome "Change" functional fix. Root cause: the outcome-controls
// ternary checked `currentOutcome` BEFORE `isOutMode`, so once an outcome
// existed, the picker branch (gated on isOutMode) was unreachable — Change
// correctly called setOutcomeModeId(item.activity_id), but the JSX branch
// that would have shown the picker could never win. Fixed by checking
// isOutMode first: `isOutMode ? <picker> : currentOutcome ? <Change> :
// <Record outcome>`. mark_lesson_outcome's own UPDATE (migration 0132,
// canonical/never redefined since) unconditionally overwrites
// lesson_outcome regardless of its prior value and unconditionally inserts
// an audit_log row on every successful call — the backend already fully
// supported changing an existing outcome; only the UI could never reach
// it. No migration was needed or created.
// ─────────────────────────────────────────────────────────────────────────

describe("Lesson outcome picker: isOutMode is checked before currentOutcome, so Change opens the SAME picker Record outcome does", () => {
  it("the outcome-controls ternary checks isOutMode first, not currentOutcome first", () => {
    const s = readSource(CLIENT_PATH);
    // "{/* Outcome controls" is a unique marker (appears exactly once, in
    // the History lesson branch) — the window is wide enough to skip past
    // the full explanatory comment above the ternary itself.
    const idx = s.indexOf("{/* Outcome controls");
    expect(idx).toBeGreaterThan(-1);
    const block = s.slice(idx, idx + 1500);
    expect(block).toMatch(/\{isOutMode\s*\?\s*\(/);
    // currentOutcome is still checked, but only as the ELSE branch — found
    // independently rather than assuming a fixed distance, since the full
    // picker (option pills + Cancel button) sits between the two.
    const elseIdx = s.indexOf(") : currentOutcome ? (", idx);
    expect(elseIdx).toBeGreaterThan(idx);
    expect(elseIdx).toBeLessThan(idx + 3000);
  });

  it("exactly ONE outcome-option picker exists (OUTCOME_OPTIONS.map appears once) — not duplicated for the Change path", () => {
    const s = readSource(CLIENT_PATH);
    const matches = s.match(/OUTCOME_OPTIONS\.map\(opt =>/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("no-outcome lessons expose 'Record outcome', and clicking it sets outcomeModeId to this row (opens the picker)", () => {
    const s = readSource(CLIENT_PATH);
    const idx = s.indexOf("Record outcome");
    expect(idx).toBeGreaterThan(-1);
    const block = s.slice(Math.max(0, idx - 250), idx);
    expect(block).toContain("onClick={() => setOutcomeModeId(item.activity_id)}");
  });

  it("existing-outcome lessons expose 'Change', and clicking it sets outcomeModeId to the SAME row (opens the SAME picker Record outcome does)", () => {
    const s = readSource(CLIENT_PATH);
    const idx = s.indexOf(">\n                                  Change\n");
    expect(idx).toBeGreaterThan(-1);
    const block = s.slice(Math.max(0, idx - 250), idx);
    expect(block).toContain("onClick={() => setOutcomeModeId(item.activity_id)}");
  });

  it("Cancel inside the picker only resets outcomeModeId — no mutation, no handleOutcome call", () => {
    const s = readSource(CLIENT_PATH);
    const idx = s.indexOf('onClick={() => setOutcomeModeId(null)}');
    expect(idx).toBeGreaterThan(-1);
    const block = s.slice(idx, s.indexOf("</button>", idx));
    expect(block).not.toContain("handleOutcome");
    expect(block).toContain("Cancel");
  });

  it("selecting an outcome option in the picker calls the SAME handleOutcome/recordLessonOutcomeFromDetailAction path used for first-time recording", () => {
    const s = readSource(CLIENT_PATH);
    expect(s).toContain("onClick={() => handleOutcome(item.activity_id, item.activity_id, opt.value)}");
    const handlerIdx = s.indexOf("function handleOutcome(");
    const handlerBlock = s.slice(handlerIdx, s.indexOf("\n  }\n", handlerIdx));
    expect(handlerBlock).toContain("recordLessonOutcomeFromDetailAction(requestId, outcome)");
  });

  it("handleOutcome updates outcomeUpdates with the new value and resets outcomeModeId to null on success — the SAME success path serves both first-time recording and a change", () => {
    const s = readSource(CLIENT_PATH);
    const handlerIdx = s.indexOf("function handleOutcome(");
    expect(handlerIdx).toBeGreaterThan(-1);
    const handlerBlock = s.slice(handlerIdx, s.indexOf("\n  }\n", handlerIdx));
    expect(handlerBlock).toContain("setOutcomeUpdates(prev => ({ ...prev, [activityId]: outcome }));");
    expect(handlerBlock).toContain("setOutcomeModeId(null);");
  });

  it("valid outcome options remain exactly completed/member_no_show/pro_no_show — cancelled is never introduced as a manual choice", () => {
    const s = readSource(CLIENT_PATH);
    const idx = s.indexOf("const OUTCOME_OPTIONS = [");
    expect(idx).toBeGreaterThan(-1);
    const block = s.slice(idx, s.indexOf("];", idx));
    expect(block).toContain('"completed"');
    expect(block).toContain('"member_no_show"');
    expect(block).toContain('"pro_no_show"');
    expect(block).not.toContain('"cancelled"');
  });

  it("Event attendance controls (JSX and handlers) are untouched by this fix", () => {
    const s = readSource(CLIENT_PATH);
    expect(s).toContain("ATTENDANCE_OPTIONS.map(opt =>");
    expect(s).toContain("onClick={() => handleAttendance(item.activity_id, item.activity_id, opt.value)}");
    expect(s).toContain("onClick={() => handleAttendance(item.activity_id, item.activity_id, null)}");
  });

  it("no Event outcome concept exists — outcome controls live only inside the lesson branch", () => {
    const s = readSource(CLIENT_PATH);
    const eventBlockStart = s.indexOf('{item.activity_type === "event" && (');
    const eventBlockEnd   = s.indexOf('{item.activity_type === "lesson" && (', eventBlockStart);
    expect(eventBlockStart).toBeGreaterThan(-1);
    expect(eventBlockEnd).toBeGreaterThan(eventBlockStart);
    const eventBlock = s.slice(eventBlockStart, eventBlockEnd);
    expect(eventBlock).not.toContain("handleOutcome");
    expect(eventBlock).not.toContain("OUTCOME_OPTIONS");
  });
});

describe("mark_lesson_outcome (canonical, migration 0132) already permits changing an existing outcome — no migration was needed or created", () => {
  it("the UPDATE unconditionally overwrites lesson_outcome, with no guard on its prior value", () => {
    const s = readSource("supabase/migrations/0132_staff_operational_authorization.sql");
    const idx = s.indexOf("-- mark_lesson_outcome — latest effective body");
    expect(idx).toBeGreaterThan(-1);
    const fnEnd = s.indexOf("revoke execute on function public.mark_lesson_outcome", idx);
    const block = s.slice(idx, fnEnd);
    expect(block).toContain("set lesson_outcome = p_outcome,");
    expect(block).not.toMatch(/if\s+v_request\.lesson_outcome/);
    expect(block).not.toContain("already");
  });

  it("only completed/member_no_show/pro_no_show are ever accepted — invalid_outcome otherwise", () => {
    const s = readSource("supabase/migrations/0132_staff_operational_authorization.sql");
    const idx = s.indexOf("-- mark_lesson_outcome — latest effective body");
    const fnEnd = s.indexOf("revoke execute on function public.mark_lesson_outcome", idx);
    const block = s.slice(idx, fnEnd);
    expect(block).toContain("if p_outcome not in ('completed', 'member_no_show', 'pro_no_show') then");
    expect(block).toContain("raise exception 'invalid_outcome';");
  });

  it("every successful call (first-time or a change) writes an audit_log row — no separate audit mechanism was introduced", () => {
    const s = readSource("supabase/migrations/0132_staff_operational_authorization.sql");
    const idx = s.indexOf("-- mark_lesson_outcome — latest effective body");
    const fnEnd = s.indexOf("revoke execute on function public.mark_lesson_outcome", idx);
    const block = s.slice(idx, fnEnd);
    expect(block).toContain("insert into public.audit_log");
    expect(block).toContain("'mark_lesson_outcome', 'lesson_request', p_request_id,");
  });

  it("same-club Admin/Staff or the assigned Pro authorization is unchanged", () => {
    const s = readSource("supabase/migrations/0132_staff_operational_authorization.sql");
    const idx = s.indexOf("-- mark_lesson_outcome — latest effective body");
    const fnEnd = s.indexOf("revoke execute on function public.mark_lesson_outcome", idx);
    const block = s.slice(idx, fnEnd);
    expect(block).toContain("if v_request.pro_id <> auth.uid() and v_profile.role not in ('admin', 'staff') then");
  });

  // "0212 is still the highest migration — no new migration was created for
  // this fix" was previously asserted here as a hardcoded
  // "highest migration === 212" ceiling. Removed: that pattern is invalid
  // for a historical checkpoint's regression suite — it cannot prove no
  // LATER, unrelated checkpoint will ever add a migration (several have
  // since: 0213-0216, added by Phase 45D). The content check below
  // continues to prove 0211/0212 remain byte-for-byte as this checkpoint
  // left them, which is the durable fact this fix actually needed no new
  // migration to achieve (mark_lesson_outcome's existing 0132 body already
  // permitted changing an outcome). See
  // topLevelBackLinkCleanup.regression.test.ts's own note on this same
  // cleanup.
  it("0211 and 0212 remain untouched (fingerprints from every prior correction round still present)", () => {
    const s211 = readSource(MIGRATION_0211_PATH);
    expect(s211).toContain("-- 1a. member_notes — member_id FK convergence (ON DELETE CASCADE)");
    expect(s211).toContain("\\mlength\\s*\\(");
    const s212 = readSource(MIGRATION_0212_PATH);
    expect(s212).toContain("if not v_note.is_archived then raise exception 'note_not_archived'; end if;");
  });
});
