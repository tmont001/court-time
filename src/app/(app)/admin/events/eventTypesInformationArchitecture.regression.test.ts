import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Admin UX Checkpoint 3 — Events IA. Event Types moves from /admin/settings
// into /events, as a fourth, Admin-only tab (Upcoming | Manage | Lessons |
// Event Types) alongside the existing three — which stay exactly as they
// were for every role (canAccessOperationsWorkspace: admin/pro/staff).
// EventTypesSection/eventTypesActions.ts moved verbatim in behavior — same
// five RPCs, same validation, same messages; only their file location and
// the ONE import path inside EventTypesSection.tsx changed.
//
// Source-inspection style, matching this directory's established
// convention (see courtsInformationArchitecture.regression.test.ts).

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const EVENTS_PAGE_PATH = "src/app/(app)/events/page.tsx";
const EVENTS_SHELL_PATH = "src/app/(app)/events/EventsAdminShell.tsx";
const EVENT_TYPES_SECTION_PATH = "src/app/(app)/admin/events/EventTypesSection.tsx";
const EVENT_TYPES_ACTIONS_PATH = "src/app/(app)/admin/events/eventTypesActions.ts";
const SETTINGS_ACTIONS_PATH = "src/app/(app)/admin/settings/actions.ts";

describe("1. Event Types no longer lives in admin/settings/actions.ts", () => {
  it("none of the five event-type RPC wrapper functions remain in settings/actions.ts", () => {
    const s = readSource(SETTINGS_ACTIONS_PATH);
    for (const fn of ["createEventType", "updateEventType", "setEventTypeActive", "deleteEventType", "setEventTypePrice"]) {
      expect(s).not.toContain(`export async function ${fn}(`);
    }
    expect(s).not.toContain("create_event_type");
    expect(s).not.toContain("event_type_retired");
  });
});

describe("3. Admin can reach Event Types from Events", () => {
  it("EventsAdminShell declares a fourth eventTypes tab/panel, gated on eventTypes != null exactly like the existing lessons tab", () => {
    const s = readSource(EVENTS_SHELL_PATH);
    expect(s).toContain('type Tab = "upcoming" | "manage" | "lessons" | "eventTypes";');
    expect(s).toContain('onClick={() => setTab("eventTypes")}');
    expect(s).toContain("Event Types");
    expect(s).toContain("{eventTypes != null && (");
    expect(s).toMatch(/tab === "eventTypes" \? undefined : "hidden"/);
  });

  it("events/page.tsx renders EventTypesSection inside the eventTypes prop, fetching the same event_types columns settings used to", () => {
    const s = readSource(EVENTS_PAGE_PATH);
    expect(s).toContain('import EventTypesSection from "@/app/(app)/admin/events/EventTypesSection";');
    expect(s).toContain("<EventTypesSection clubId={clubId} currency={currency} initialTypes={eventTypes} />");
    expect(s).toContain('.select("id, key, label, color, is_active, default_price_amount_cents")');
  });
});

describe("5. non-Admin roles do not receive the Event Types destination", () => {
  it("the eventTypes prop is computed from isAdmin (profile.role === \"admin\"), not isAdminOrPro — Staff/Pro get undefined, not a hidden panel", () => {
    const s = readSource(EVENTS_PAGE_PATH);
    expect(s).toContain('const isAdmin        = profile?.role === "admin";');
    expect(s).toMatch(/eventTypes=\{\s*isAdmin \? \(/);
  });

  it("the event_types data fetch itself is admin-gated — Staff/Pro's page load never receives this data over the wire, not just a hidden UI", () => {
    const s = readSource(EVENTS_PAGE_PATH);
    const fetchStart = s.indexOf('.select("id, key, label, color, is_active, default_price_amount_cents")');
    const precedingCode = s.slice(Math.max(0, fetchStart - 400), fetchStart);
    expect(precedingCode).toMatch(/isAdmin\s*\n\s*\?\s*supabase/);
  });
});

describe("6. existing Event Type RPC/actions are unchanged", () => {
  it("all five RPCs are called with their original names and argument shapes", () => {
    const s = readSource(EVENT_TYPES_ACTIONS_PATH);
    expect(s).toContain('supabase.rpc("create_event_type", {');
    expect(s).toContain('supabase.rpc("update_event_type", {');
    expect(s).toContain('supabase.rpc("set_event_type_active", {');
    expect(s).toContain('supabase.rpc("delete_event_type", { p_id: id });');
    expect(s).toContain('supabase.rpc("set_event_type_price", {');
  });

  it("every error-message key/text is byte-identical to the pre-move version", () => {
    const s = readSource(EVENT_TYPES_ACTIONS_PATH);
    expect(s).toContain('protected_event_type:        "Built-in event types cannot be deleted."');
    expect(s).toContain('event_type_in_use:           "This type has been used by existing events, including cancelled or archived events, so it cannot be permanently deleted. Keep it inactive instead."');
    expect(s).toContain("This event type has been retired and can't be reactivated. Book Lesson is now the canonical Lesson workflow.");
  });

  it("EventTypesSection.tsx imports its actions from the new colocated file, and its own component logic (protected/retired/pricing/color) is untouched", () => {
    const s = readSource(EVENT_TYPES_SECTION_PATH);
    expect(s).toContain('} from "./eventTypesActions";');
    expect(s).toContain('const RETIRED_KEYS = new Set(["lesson"]);');
    expect(s).toContain('clinic:     { label: "Group Clinic",   color: "#2E9B5E" },');
    expect(s).toContain("function dollarsToPriceCents(dollars: string): number | null {");
  });
});

describe("8. operational Events role behavior is unchanged", () => {
  it("the existing Upcoming/Manage/Lessons tabs and their isAdminOrPro gating are untouched", () => {
    const s = readSource(EVENTS_PAGE_PATH);
    expect(s).toContain('const isAdminOrPro   = canAccessOperationsWorkspace(profile?.role);');
    expect(s).toContain("<AdminEventsClient");
    expect(s).toContain("<ProgramsManageClient");
    expect(s).toContain("<LessonsTab");
  });

  it("a plain Member still renders only upcomingContent, with no admin shell at all", () => {
    const s = readSource(EVENTS_PAGE_PATH);
    expect(s).toMatch(/isAdminOrPro \? \(/);
    expect(s).toContain("/* Members: upcoming events list with search and type filter */");
    expect(s).toContain("upcomingContent");
  });
});

describe("10. direct URL/fallback behavior for the new Events tab", () => {
  it("?tab=eventTypes only resolves for an Admin caller — any other role (or an unrecognized tab) falls back to upcoming", () => {
    const s = readSource(EVENTS_PAGE_PATH);
    expect(s).toContain('const initialTab = sp.tab === "eventTypes" && isAdmin ? "eventTypes" : initialTabFromUrl;');
    expect(s).toContain('const initialTabFromUrl = sp.tab === "manage" ? "manage" : sp.tab === "lessons" ? "lessons" : "upcoming";');
  });
});

// 11. "no migration was added by this checkpoint" was previously asserted
// here as a hardcoded "highest migration === N" ceiling. Removed: that
// pattern cannot hold as an evergreen invariant across later, unrelated
// checkpoints (0170 has since been added by the Communications checkpoint)
// — see topLevelBackLinkCleanup.regression.test.ts's own note on this same
// cleanup.

describe("12. no Phase 34 Payments behavior touched", () => {
  it("eventTypesActions.ts never references payment_events/amount_due_cents/amount_paid_cents/stripe", () => {
    const s = readSource(EVENT_TYPES_ACTIONS_PATH);
    expect(s).not.toMatch(/payment_events|amount_due_cents|amount_paid_cents|stripe_/i);
  });
});
