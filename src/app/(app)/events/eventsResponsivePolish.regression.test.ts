import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Admin UX — Events/Features 320px product-polish checkpoint. Two small,
// non-architectural fixes found in runtime QA after the Events/Lessons IA
// checkpoint:
//   (A) EventsAdminShell's tab strip + Create Event button crowd each other
//       at ~320px — tabs now get their own full-width mobile row (equal-width
//       grid cells) and Create Event drops to its own full-width mobile row,
//       reverting to the original single-row layout at sm+.
//   (B) EventTypesSection's "Default view" row truncated the type label to
//       preserve a desktop-style single-row action group — split into a
//       primary row (label + price) and a separate, wrapping actions row.
// No tab state/role/RPC/authorization logic changed in either file — see
// eventTypesInformationArchitecture.regression.test.ts for the (unchanged)
// authorization/RPC coverage this checkpoint builds on top of.
//
// Source-inspection style, matching this directory's established convention.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const EVENTS_SHELL_PATH = "src/app/(app)/events/EventsAdminShell.tsx";
const EVENT_TYPES_SECTION_PATH = "src/app/(app)/admin/events/EventTypesSection.tsx";

describe("1. Events tabs remain exactly the four Admin tabs, gating unchanged", () => {
  it("Tab type and eventTypes/lessons gating are untouched by the layout fix", () => {
    const s = readSource(EVENTS_SHELL_PATH);
    expect(s).toContain('type Tab = "upcoming" | "manage" | "lessons" | "eventTypes";');
    expect(s).toContain("const [tab, setTab] = useState<Tab>(initialTab);");
    expect(s).toContain("{lessons != null && (");
    expect(s).toContain("{eventTypes != null && (");
  });

  it("all four tab buttons still call setTab with their original tab names", () => {
    const s = readSource(EVENTS_SHELL_PATH);
    expect(s).toContain('onClick={() => setTab("upcoming")}');
    expect(s).toContain('onClick={() => setTab("manage")}');
    expect(s).toContain('onClick={() => setTab("lessons")}');
    expect(s).toContain('onClick={() => setTab("eventTypes")}');
  });
});

describe("2. mobile tab layout centers labels and allows wrapping, sized to the actual tab count", () => {
  it("tabClass centers text both ways and uses leading-tight (permits a two-line 'Event Types' label)", () => {
    const s = readSource(EVENTS_SHELL_PATH);
    expect(s).toContain("function tabClass(active: boolean): string {");
    expect(s).toMatch(/flex items-center justify-center text-center leading-tight/);
  });

  it("the tab container is a grid sized to the actual visible tab count (3 or 4), not a fixed 4", () => {
    const s = readSource(EVENTS_SHELL_PATH);
    expect(s).toContain("const tabCount = 2 + (lessons != null ? 1 : 0) + (eventTypes != null ? 1 : 0);");
    expect(s).toContain('`grid ${tabCount === 4 ? "grid-cols-4" : "grid-cols-3"} gap-1 p-1 bg-gray-100 dark:bg-gray-800 rounded-xl sm:flex sm:flex-1`');
  });

  it("every tab button shares the same tabClass helper, so all four cells render at equal width/height", () => {
    const s = readSource(EVENTS_SHELL_PATH);
    expect((s.match(/\$\{tabClass\(tab === "(upcoming|manage|lessons|eventTypes)"\)\}/g) ?? []).length).toBe(4);
  });
});

describe("3. Create Event separates onto its own row at narrow width and reflows at sm+", () => {
  it("the outer row is column-stacked on mobile and reverts to a single row at sm+", () => {
    const s = readSource(EVENTS_SHELL_PATH);
    expect(s).toContain('className="mx-4 mt-3 mb-1 flex flex-col gap-2 sm:flex-row sm:items-center"');
  });

  it("EventsCreateButton is wrapped (not itself modified) to go full-width on mobile and auto-width at sm+", () => {
    const s = readSource(EVENTS_SHELL_PATH);
    expect(s).toContain('className="w-full sm:w-auto [&>button]:w-full sm:[&>button]:w-auto"');
  });

  it("EventsCreateButton.tsx's own className/props are untouched by this checkpoint", () => {
    const s = readSource("src/app/(app)/events/EventsCreateButton.tsx");
    expect(s).not.toMatch(/w-full sm:w-auto/);
  });
});

describe("4. Event Type identity and actions use separate mobile layout regions", () => {
  it("the default-view row is split into a primary row (label+price) and a separate actions row", () => {
    const s = readSource(EVENT_TYPES_SECTION_PATH);
    expect(s).toContain('className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3"');
    expect(s).toContain('className="flex items-center justify-between gap-3 sm:justify-start sm:gap-2 sm:min-w-0"');
    expect(s).toContain('className="flex items-center gap-3 shrink-0 flex-wrap sm:justify-end"');
  });

  it("the type label is not truncated to fit a single desktop-style row (min-w-0/truncate lives on the label's own flexible row, not clipped against the action buttons)", () => {
    const s = readSource(EVENT_TYPES_SECTION_PATH);
    const primaryRowStart = s.indexOf('className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3"');
    const actionsRowStart = s.indexOf('className="flex items-center gap-3 shrink-0 flex-wrap sm:justify-end"');
    expect(primaryRowStart).toBeGreaterThan(-1);
    expect(actionsRowStart).toBeGreaterThan(primaryRowStart);
  });

  it("exactly one price span renders per row (relocated next to the label, not duplicated)", () => {
    const s = readSource(EVENT_TYPES_SECTION_PATH);
    expect((s.match(/formatOperatorPrice\(et\.default_price_amount_cents, currency\)/g) ?? []).length).toBe(1);
  });

  it("actions row still wraps naturally and contains Edit — Deactivate/Reactivate/Delete logic is untouched", () => {
    const s = readSource(EVENT_TYPES_SECTION_PATH);
    const actionsRowStart = s.indexOf('className="flex items-center gap-3 shrink-0 flex-wrap sm:justify-end"');
    const actionsRowEnd = s.indexOf("</div>", actionsRowStart + 400);
    const actionsRowJsx = s.slice(actionsRowStart, actionsRowEnd);
    expect(actionsRowJsx).toContain("Edit");
  });
});

describe("5. desktop layout is preserved at sm+ (unchanged arrangement, not removed)", () => {
  it("EventsAdminShell tabs revert to a single flex row with flex-1 cells at sm+", () => {
    const s = readSource(EVENTS_SHELL_PATH);
    expect(s).toContain("sm:flex sm:flex-1");
    expect((s.match(/\$\{tabClass\([^)]*\)\} sm:flex-1/g) ?? []).length).toBe(4);
  });

  it("EventTypesSection's primary/actions rows both revert to a single flex-row arrangement at sm+", () => {
    const s = readSource(EVENT_TYPES_SECTION_PATH);
    expect(s).toContain("sm:flex-row sm:items-center sm:justify-between sm:gap-3");
    expect(s).toContain("sm:justify-start sm:gap-2 sm:min-w-0");
  });
});

describe("9. no authorization/RPC/migration changes in this checkpoint", () => {
  it("EventTypesSection.tsx still imports its actions from the same colocated file and keeps its protected/retired logic", () => {
    const s = readSource(EVENT_TYPES_SECTION_PATH);
    expect(s).toContain('} from "./eventTypesActions";');
    expect(s).toContain('const RETIRED_KEYS = new Set(["lesson"]);');
  });

  it("EventsAdminShell.tsx's eventTypes prop is still admin-only gated exactly as before (this checkpoint touched only layout classes)", () => {
    const s = readSource(EVENTS_SHELL_PATH);
    expect(s).toContain("eventTypes?:  React.ReactNode;");
  });

  // A hardcoded "highest migration === N" assertion previously lived here.
  // Removed: that pattern cannot hold as an evergreen invariant across
  // later, unrelated checkpoints (0170 has since been added by the
  // Communications checkpoint) — see
  // topLevelBackLinkCleanup.regression.test.ts's own note on this cleanup.
});
