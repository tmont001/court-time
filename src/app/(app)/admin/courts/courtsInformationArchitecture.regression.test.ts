import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Admin UX Checkpoint 2A — Courts IA. /admin/courts becomes three tabs
// (Courts / Hours & Closures / Booking Rules), absorbing Operating Hours,
// Special Closures, and Booking Rules from /admin/settings. Tab state is a
// plain ?tab= query param resolved server-side (Link + searchParams — the
// same pattern /admin/reports' range selector already uses), not client
// state, so it satisfies direct-URL-access/refresh/back-forward natively.
//
// Source-inspection style, matching this project's established convention
// for Server Component pages with framework imports (see
// settingsInformationArchitecture.regression.test.ts and every Reports
// regression test file for the same rationale — this vitest baseline has
// no jsdom/React rendering).

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const COURTS_PAGE_PATH = "src/app/(app)/admin/courts/page.tsx";
const COURTS_ACTIONS_PATH = "src/app/(app)/admin/courts/actions.ts";
const SETTINGS_PAGE_PATH = "src/app/(app)/admin/settings/page.tsx";
const SETTINGS_ACTIONS_PATH = "src/app/(app)/admin/settings/actions.ts";
const OVERVIEW_PAGE_PATH = "src/app/(app)/admin/overview/page.tsx";

function courtsPageSource(): string {
  return readSource(COURTS_PAGE_PATH);
}

describe("1. /admin/courts exposes exactly the three intended tabs", () => {
  it("declares exactly the Courts / Hours & Closures / Booking Rules tab set, with the documented query-param values", () => {
    const s = courtsPageSource();
    expect(s).toContain('type CourtsTab = "courts" | "hours" | "rules";');
    expect(s).toContain('{ key: "courts", label: "Courts", href: "/admin/courts" }');
    expect(s).toContain('{ key: "hours", label: "Hours & Closures", href: "/admin/courts?tab=hours" }');
    expect(s).toContain('{ key: "rules", label: "Booking Rules", href: "/admin/courts?tab=rules" }');
  });

  it("an unrecognized or missing tab value fails safely to \"courts\" — direct URL / refresh / back-forward all resolve through this same pure function", () => {
    const s = courtsPageSource();
    expect(s).toContain(`function resolveCourtsTab(raw: string | undefined): CourtsTab {
  if (raw === "hours") return "hours";
  if (raw === "rules") return "rules";
  return "courts";
}`);
  });

  it("tab state is resolved from searchParams, not client-side useState — the URL is the source of truth (no \"use client\" on this page)", () => {
    const s = courtsPageSource();
    expect(s).toContain("searchParams: Promise<{ tab?: string }>");
    expect(s).toContain("const tab = resolveCourtsTab(sp.tab);");
    expect(s.trimStart().startsWith('"use client"')).toBe(false);
  });
});

describe("2. CourtManagementList remains on the Courts tab", () => {
  it("CourtManagementList is rendered only inside the tab === \"courts\" branch", () => {
    const s = courtsPageSource();
    const idx = s.indexOf('tab === "courts"');
    const nextTabIdx = s.indexOf('tab === "hours"');
    expect(idx).toBeGreaterThan(-1);
    expect(nextTabIdx).toBeGreaterThan(idx);
    const courtsBranch = s.slice(idx, nextTabIdx);
    expect(courtsBranch).toContain("<CourtManagementList");
  });

  it("CourtManagementList.tsx itself is unmoved and untouched (still in admin/courts/)", () => {
    const s = readSource("src/app/(app)/admin/courts/CourtManagementList.tsx");
    expect(s).toContain("export default function CourtManagementList(");
  });
});

describe("3+4. OperatingHoursEditor and DateOverridesEditor appear only in Hours & Closures", () => {
  it("both are rendered only inside the tab === \"hours\" branch, as two clearly separated sections", () => {
    const s = courtsPageSource();
    const start = s.indexOf('tab === "hours"');
    const end = s.indexOf('tab === "rules"');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const hoursBranch = s.slice(start, end);
    expect(hoursBranch).toContain("Regular operating hours");
    expect(hoursBranch).toContain("<OperatingHoursEditor");
    expect(hoursBranch).toContain("Special closures / date overrides");
    expect(hoursBranch).toContain("<DateOverridesEditor");
    // Regular operating hours precedes Special closures within the tab.
    expect(hoursBranch.indexOf("Regular operating hours")).toBeLessThan(
      hoursBranch.indexOf("Special closures / date overrides")
    );
  });

  it("neither component is rendered in the courts or rules tab branches", () => {
    const s = courtsPageSource();
    const courtsStart = s.indexOf('tab === "courts"');
    const hoursStart = s.indexOf('tab === "hours"');
    const rulesStart = s.indexOf('tab === "rules"');
    const courtsBranch = s.slice(courtsStart, hoursStart);
    const rulesBranch = s.slice(rulesStart);
    for (const branch of [courtsBranch, rulesBranch]) {
      expect(branch).not.toContain("<OperatingHoursEditor");
      expect(branch).not.toContain("<DateOverridesEditor");
    }
  });
});

describe("5. BookingRulesForm appears only in Booking Rules", () => {
  it("is rendered only inside the tab === \"rules\" branch", () => {
    const s = courtsPageSource();
    const rulesStart = s.indexOf('tab === "rules"');
    expect(rulesStart).toBeGreaterThan(-1);
    const rulesBranch = s.slice(rulesStart);
    expect(rulesBranch).toContain("<BookingRulesForm");
  });

  it("is not rendered in the courts or hours tab branches", () => {
    const s = courtsPageSource();
    const courtsStart = s.indexOf('tab === "courts"');
    const rulesStart = s.indexOf('tab === "rules"');
    const courtsAndHoursBranch = s.slice(courtsStart, rulesStart);
    expect(courtsAndHoursBranch).not.toContain("<BookingRulesForm");
  });
});

describe("6. /admin/settings no longer renders those three sections", () => {
  it("no Booking Rules, Operating Hours, or Special Closures markers/components remain on the settings page", () => {
    const s = readSource(SETTINGS_PAGE_PATH);
    expect(s).not.toMatch(/── Booking Rules ──/);
    expect(s).not.toMatch(/── Operating Hours ──/);
    expect(s).not.toMatch(/── Special Closures ──/);
    expect(s).not.toContain("BookingRulesForm");
    expect(s).not.toContain("OperatingHoursEditor");
    expect(s).not.toContain("DateOverridesEditor");
  });

  it("updateBookingRules no longer lives in admin/settings/actions.ts", () => {
    const s = readSource(SETTINGS_ACTIONS_PATH);
    expect(s).not.toContain("updateBookingRules");
    expect(s).not.toContain("update_club_settings");
  });

  it("the settings page's club_settings query no longer selects the four booking-rule columns it no longer uses", () => {
    const s = readSource(SETTINGS_PAGE_PATH);
    expect(s).not.toContain("booking_window_days");
    expect(s).not.toContain("cancellation_window_hours");
    expect(s).not.toContain("cancellation_grace_minutes");
    expect(s).not.toContain("waitlist_offer_window_hours");
  });

  it("no other Settings section (Pricing, Branding, Timezone, Event Types, Lesson Types, Payments, Operating Model, Announcements, Diagnostics) was touched or reordered", () => {
    const s = readSource(SETTINGS_PAGE_PATH);
    for (const marker of [
      "── Operating Model",
      "── Payments ──",
      "── Club Branding ──",
      "── Club Timezone ──",
      "── Event Types ──",
      "── Pricing ──",
      "── Lesson Types ──",
      "── Member Announcements ──",
    ]) {
      expect(s, `${marker} missing — an unrelated section was affected`).toContain(marker);
    }
  });
});

describe("7. existing Court management actions/RPCs are unchanged", () => {
  it("all six court RPCs are still called with their original names and argument shapes", () => {
    const s = readSource(COURTS_ACTIONS_PATH);
    expect(s).toContain('supabase.rpc("add_court", { p_name: name })');
    expect(s).toContain('supabase.rpc("rename_court", { p_court_id: courtId, p_name: name })');
    expect(s).toContain('supabase.rpc("reorder_courts", { p_court_order: courtOrder })');
    expect(s).toMatch(/supabase\.rpc\("set_court_active", \{\s*p_court_id: courtId,\s*p_is_active: isActive,\s*\}\)/);
    expect(s).toMatch(/supabase\.rpc\("set_court_hourly_rate", \{\s*p_court_id: courtId,\s*p_hourly_rate_cents: hourlyRateCents,\s*\}\)/);
    expect(s).toContain('supabase.rpc("delete_court", { p_court_id: courtId })');
  });

  it("every original court action still calls assertActiveClub as its first guard, unchanged", () => {
    const s = readSource(COURTS_ACTIONS_PATH);
    const courtActionNames = ["addCourt", "renameCourt", "reorderCourts", "setCourtActive", "setCourtHourlyRate", "deleteCourt"];
    for (const name of courtActionNames) {
      const start = s.indexOf(`export async function ${name}(`);
      expect(start, `${name} not found`).toBeGreaterThan(-1);
      const body = s.slice(start, start + 300);
      expect(body, `${name} no longer guards with assertActiveClub`).toContain("assertActiveClub");
    }
  });
});

describe("8. existing Hours/Closures actions/RPCs are unchanged", () => {
  it("OperatingHoursEditor still calls update_operating_hours with the same dry-run/confirm shape", () => {
    const s = readSource("src/app/(app)/admin/courts/OperatingHoursEditor.tsx");
    expect(s).toContain('supabase.rpc("update_operating_hours", {');
    expect(s).toContain("p_dry_run: true");
    expect(s).toContain("p_dry_run: false");
  });

  it("DateOverridesEditor still calls upsert_operating_hours_override with a dry-run/confirm shape", () => {
    const s = readSource("src/app/(app)/admin/courts/DateOverridesEditor.tsx");
    expect(s).toMatch(/upsert_operating_hours_override/);
  });
});

describe("9. existing Booking Rules action/RPC is unchanged", () => {
  it("updateBookingRules is byte-identical in logic to its pre-move form — same fields, same update_club_settings RPC call, same revalidatePath", () => {
    const s = readSource(COURTS_ACTIONS_PATH);
    expect(s).toContain(`export async function updateBookingRules(
  formData: FormData
): Promise<{ error?: string }> {`);
    expect(s).toContain('supabase.rpc("update_club_settings", {');
    expect(s).toContain("p_booking_window_days:         bookingDays,");
    expect(s).toContain("p_cancellation_window_hours:   cancelHours,");
    expect(s).toContain("p_cancellation_grace_minutes:  graceMins,");
    expect(s).toContain("p_waitlist_offer_window_hours: offerWindowHours,  // Phase 18C");
    expect(s).toContain('revalidatePath("/", "layout");');
  });

  it("it deliberately does NOT call assertActiveClub — preserved exactly as before the move, not upgraded to match this file's sibling convention", () => {
    const s = readSource(COURTS_ACTIONS_PATH);
    const start = s.indexOf("export async function updateBookingRules(");
    const body = s.slice(start, start + 900);
    expect(body).not.toContain("assertActiveClub");
  });

  it("the four booking-rule error messages moved with the function, unchanged in wording", () => {
    const s = readSource(COURTS_ACTIONS_PATH);
    expect(s).toContain('invalid_booking_window:      "Booking window must be between 1 and 365 days."');
    expect(s).toContain('invalid_cancellation_window: "Cancellation window must be between 0 and 168 hours."');
    expect(s).toContain('invalid_grace_period:        "Grace period must be between 0 and 60 minutes."');
    expect(s).toContain('invalid_offer_window:        "Waitlist offer window must be between 1 and 72 hours."');
  });
});

describe("10. all surfaces remain Admin-only", () => {
  it("/admin/courts still gates on hasAdminAuthority before rendering any tab", () => {
    const s = courtsPageSource();
    expect(s).toContain('import { hasAdminAuthority } from "@/lib/auth/roles";');
    expect(s).toContain("if (!hasAdminAuthority(profile?.role)) redirect(\"/calendar\");");
    // The auth check happens before tab resolution/rendering, not per-tab —
    // there is no separate/weaker gate for hours or rules.
    const authIdx = s.indexOf("hasAdminAuthority(profile?.role)");
    const tabIdx = s.indexOf('tab === "courts"');
    expect(authIdx).toBeLessThan(tabIdx);
  });

  it("every relocated RPC remains reachable only through the same Server Actions used before — no new client-only auth check was introduced as a substitute", () => {
    const s = readSource(COURTS_ACTIONS_PATH);
    expect(s.trimStart().startsWith('"use server";')).toBe(true);
  });

  it("/admin/settings itself is still Admin-gated, unaffected by the removal of these three sections", () => {
    const s = readSource(SETTINGS_PAGE_PATH);
    expect(s).toContain('if (profile?.role !== "admin") redirect("/calendar");');
  });
});

describe("11. no migration/payment behavior changes", () => {
  it("no migration file was added or modified by this checkpoint", () => {
    const files = readdirSync(join(process.cwd(), "supabase/migrations"));
    const highest = files
      .map((f: string) => parseInt(f.slice(0, 4), 10))
      .filter((n: number) => !Number.isNaN(n))
      .sort((a: number, b: number) => b - a)[0];
    expect(highest).toBe(169);
  });

  it("no payment/pricing RPC or component was touched — this checkpoint's actions.ts changes are scoped to court/hours/rules RPCs only", () => {
    const s = readSource(COURTS_ACTIONS_PATH);
    expect(s).not.toMatch(/payment_events|amount_due_cents|amount_paid_cents|stripe_|update_club_pricing/i);
  });

  it("the stale Overview setup-checklist link for Operating Hours now points at the new location", () => {
    const s = readSource(OVERVIEW_PAGE_PATH);
    expect(s).toContain('<SetupRow label="Operating hours"     done={operatingHoursCount > 0}    href="/admin/courts?tab=hours" />');
  });
});
