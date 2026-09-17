import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Admin UX Checkpoint 2A — mobile responsive polish pass. Runtime QA at
// ~320-428px found three presentation issues in the otherwise-approved
// Courts IA: (1) CourtManagementList's 6-button action row squeezed the
// court name/status/rate down to an unreadable sliver, (2) OperatingHours
// Editor's [start] to [end] row forced two native time inputs into too
// little width, (3) the tab strip's "Hours & Closures" label wrapping to
// two lines wasn't vertically/horizontally centered against its two
// single-line siblings. All three fixes are pure Tailwind responsive
// classes (mobile-first, sm: override back to the original desktop
// layout) — no RPC, action, auth, or data-fetching change.
//
// Source-inspection style, matching this directory's established
// convention (see courtsInformationArchitecture.regression.test.ts).

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const COURT_LIST_PATH = "src/app/(app)/admin/courts/CourtManagementList.tsx";
const HOURS_EDITOR_PATH = "src/app/(app)/admin/courts/OperatingHoursEditor.tsx";
const COURTS_PAGE_PATH = "src/app/(app)/admin/courts/page.tsx";
const PAGE_TABS_PATH = "src/components/PageTabs.tsx";
const COURTS_ACTIONS_PATH = "src/app/(app)/admin/courts/actions.ts";

function normalRowSection(): string {
  const s = readSource(COURT_LIST_PATH);
  const start = s.indexOf("/* ── Normal row ──");
  expect(start, "Normal row section not found").toBeGreaterThan(-1);
  const end = s.indexOf(")}\n\n            </div>", start);
  expect(end, "end of Normal row section not found").toBeGreaterThan(start);
  return s.slice(start, end);
}

describe("1. court names are not forced into the same cramped mobile action row", () => {
  it("the Normal row's outer container stacks name/rate and actions onto separate rows on mobile (flex-col), reverting to one row only at sm+", () => {
    const section = normalRowSection();
    expect(section).toContain("flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between");
  });

  it("the name/status/pricing block is a distinct flex item from the action-button block, not interleaved with buttons", () => {
    // Phase 42C-2 UX polish pass restructured the former single-line
    // "Name + badge + rate" comment into "Name + status, then pricing on
    // its own compact row" — the underlying invariant (this block is a
    // separate flex item from the action-button block) is unchanged.
    const section = normalRowSection();
    const nameBlockIdx = section.indexOf("Name + status, then pricing");
    const actionsBlockIdx = section.indexOf("Action buttons");
    expect(nameBlockIdx).toBeGreaterThan(-1);
    expect(actionsBlockIdx).toBeGreaterThan(nameBlockIdx);
  });
});

describe("2. court actions can wrap/reflow on mobile", () => {
  it("the action-button container allows wrapping by default and only disables it at sm+ (restoring the original single-line desktop row)", () => {
    const section = normalRowSection();
    expect(section).toContain('className="flex items-center gap-1.5 flex-wrap sm:flex-nowrap sm:flex-shrink-0"');
  });

  it("all six original court actions (reorder x2, Rename, Rate, Deactivate/Activate, Delete) are still present, unchanged", () => {
    const section = normalRowSection();
    expect(section).toContain('aria-label="Move up"');
    expect(section).toContain('aria-label="Move down"');
    expect(section).toMatch(/>\s*Rename\s*<\/button>/);
    expect(section).toMatch(/>\s*Rate\s*<\/button>/);
    expect(section).toContain('"Deactivate"');
    expect(section).toContain('"Activate"');
    expect(section).toMatch(/>\s*Delete\s*<\/button>/);
  });
});

describe("3. time inputs use a mobile-friendly responsive layout", () => {
  it("a mobile-only Opens/Closes two-column grid exists, hidden at sm+", () => {
    const s = readSource(HOURS_EDITOR_PATH);
    expect(s).toMatch(/grid grid-cols-2 gap-3 mt-2 sm:hidden/);
    expect(s).toContain(">Opens<");
    expect(s).toContain(">Closes<");
  });

  it("the mobile Opens/Closes inputs are bound to the same opens_at/closes_at fields and updateDay handler as before — no new state introduced", () => {
    const s = readSource(HOURS_EDITOR_PATH);
    const gridStart = s.indexOf("grid grid-cols-2 gap-3 mt-2 sm:hidden");
    const gridEnd = s.indexOf("</div>\n          </div>\n        ))}");
    const grid = s.slice(gridStart, gridEnd);
    expect(grid).toContain("value={d.opens_at}");
    expect(grid).toContain("updateDay(d.day_of_week, { opens_at: e.target.value })");
    expect(grid).toContain("value={d.closes_at}");
    expect(grid).toContain("updateDay(d.day_of_week, { closes_at: e.target.value })");
    expect(grid).toContain("disabled={d.is_closed}");
  });

  it("mobile time inputs use text-base (not a smaller size) to avoid iOS zoom-on-focus, matching this app's own established input-sizing convention", () => {
    const s = readSource(HOURS_EDITOR_PATH);
    const gridStart = s.indexOf("grid grid-cols-2 gap-3 mt-2 sm:hidden");
    const gridEnd = s.indexOf("</div>\n          </div>\n        ))}");
    const grid = s.slice(gridStart, gridEnd);
    expect(grid).toMatch(/text-base text-gray-900/);
  });
});

describe("4. desktop horizontal hours layout remains available at larger breakpoints", () => {
  it("the original [start] to [end] inline row still exists, now shown only at sm+", () => {
    const s = readSource(HOURS_EDITOR_PATH);
    expect(s).toMatch(/hidden sm:flex sm:items-center sm:gap-2 transition-opacity/);
    expect(s).toContain('<span className="text-xs text-gray-400 dark:text-gray-500 select-none">to</span>');
  });

  it("the desktop time inputs keep the original text-base md:text-sm sizing, unchanged", () => {
    const s = readSource(HOURS_EDITOR_PATH);
    const desktopStart = s.indexOf("hidden sm:flex sm:items-center sm:gap-2");
    const desktopEnd = s.indexOf("Mobile time inputs");
    const desktopBlock = s.slice(desktopStart, desktopEnd);
    expect((desktopBlock.match(/text-base md:text-sm/g) ?? []).length).toBe(2);
  });

  it("Closed toggle behavior, values, and update_operating_hours dry-run/confirm flow are untouched", () => {
    const s = readSource(HOURS_EDITOR_PATH);
    expect(s).toContain('supabase.rpc("update_operating_hours", {');
    expect(s).toContain("p_dry_run: true");
    expect(s).toContain("p_dry_run: false");
    expect(s).toContain("checked={d.is_closed}");
    expect(s).toContain('updateDay(d.day_of_week, { is_closed: e.target.checked })');
  });
});

describe("5+6. all three tabs use equal-width centered alignment; wrapped label uses compact line-height (Phase 43B-3E2 — this markup now lives in the shared PageTabs component, src/components/PageTabs.tsx, rendered by courts/page.tsx via <PageTabs items={...} />)", () => {
  it("courts/page.tsx renders its tab strip via the shared PageTabs component", () => {
    const s = readSource(COURTS_PAGE_PATH);
    expect(s).toContain('import PageTabs from "@/components/PageTabs";');
    expect(s).toMatch(/<PageTabs\s/);
  });

  it("5. each tab cell centers its content both horizontally and vertically, and stays equal width (flex-1)", () => {
    const s = readSource(PAGE_TABS_PATH);
    expect(s).toMatch(/flex-1 flex items-center justify-center text-center leading-tight/);
  });

  it("6. leading-tight is present so a wrapped two-line label (\"Hours & Closures\") stays compact rather than double-line-height", () => {
    const s = readSource(PAGE_TABS_PATH);
    const tabLinkClassStart = s.indexOf("flex-1 flex items-center justify-center");
    expect(tabLinkClassStart).toBeGreaterThan(-1);
    const classSnippet = s.slice(tabLinkClassStart, tabLinkClassStart + 80);
    expect(classSnippet).toContain("leading-tight");
  });

  it("no hard-coded pixel height/position was introduced — equal height comes from flex stretch, not a fixed min-height/top/left value", () => {
    const s = readSource(PAGE_TABS_PATH);
    const tabStripStart = s.indexOf('className={`ct-card flex divide-x');
    expect(tabStripStart).toBeGreaterThan(-1);
    const tabStrip = s.slice(tabStripStart, tabStripStart + 400);
    expect(tabStrip).not.toMatch(/min-h-\[|height:\s*['"`]?\d|top-\[|left-\[/);
  });

  it("all three tab labels, hrefs, and keys are unchanged", () => {
    const s = readSource(COURTS_PAGE_PATH);
    expect(s).toContain('{ key: "courts", label: "Courts", href: "/admin/courts" }');
    expect(s).toContain('{ key: "hours", label: "Hours & Closures", href: "/admin/courts?tab=hours" }');
    expect(s).toContain('{ key: "rules", label: "Booking Rules", href: "/admin/courts?tab=rules" }');
  });
});

describe("7. no RPC/action/auth changes", () => {
  it("all six court RPCs are still called with their original names and argument shapes", () => {
    const s = readSource(COURTS_ACTIONS_PATH);
    expect(s).toContain('supabase.rpc("add_court", { p_name: name })');
    expect(s).toContain('supabase.rpc("rename_court", { p_court_id: courtId, p_name: name })');
    expect(s).toContain('supabase.rpc("reorder_courts", { p_court_order: courtOrder })');
    expect(s).toMatch(/supabase\.rpc\("set_court_active"/);
    expect(s).toMatch(/supabase\.rpc\("set_court_hourly_rate"/);
    expect(s).toContain('supabase.rpc("delete_court", { p_court_id: courtId })');
    expect(s).toContain('supabase.rpc("update_club_settings", {');
  });

  it("the page's admin-only authorization check is unchanged and still gates before any tab renders", () => {
    const s = readSource(COURTS_PAGE_PATH);
    expect(s).toContain('import { hasAdminAuthority } from "@/lib/auth/roles";');
    expect(s).toContain('if (!hasAdminAuthority(profile?.role)) redirect("/calendar");');
  });

  it("tab query-param keys/URLs are unchanged from the prior checkpoint", () => {
    const s = readSource(COURTS_PAGE_PATH);
    expect(s).toContain('type CourtsTab = "courts" | "hours" | "rules";');
    expect(s).toContain("searchParams: Promise<{ tab?: string }>");
  });

  // A hardcoded "highest migration === N" assertion previously lived here.
  // Removed: that pattern cannot hold as an evergreen invariant across
  // later, unrelated checkpoints (0170 has since been added by the
  // Communications checkpoint) — see
  // topLevelBackLinkCleanup.regression.test.ts's own note on this cleanup.
});
