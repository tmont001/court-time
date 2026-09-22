import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Peak / Off-Peak Pricing — Checkpoint B, Part 2 regression coverage: the
// Admin management UI for court rate periods (CourtRatePeriodsSection).
// Originally wired into /admin/settings under the Pricing subsection;
// relocated by a later IA refinement to /admin/courts' Court Rates tab,
// consolidating the operator's court-pricing mental model into one page.
// Behavior is unchanged by that move — this file was itself relocated
// from admin/settings/ to admin/courts/ and its path constants/wiring
// assertions updated accordingly; the lifecycle/copy/authorization
// coverage below is otherwise the same coverage as before the move.
//
// Source-inspection style, matching this project's established convention
// for Server/Client Component files — see membershipSettingsPricingUI.
// regression.test.ts (this vitest baseline has no jsdom/React rendering).

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const COURTS_PAGE_PATH      = "src/app/(app)/admin/courts/page.tsx";
const SETTINGS_ACTIONS_PATH = "src/app/(app)/admin/settings/actions.ts";
const SECTION_PATH          = "src/app/(app)/admin/courts/CourtRatePeriodsSection.tsx";

// ═══════════════════════════════════════════════════════════════════════════
// A. Admin-only visibility
// ═══════════════════════════════════════════════════════════════════════════

describe("A. Admin-only visibility", () => {
  it("/admin/courts gates on hasAdminAuthority before rendering any tab, including Court Rates", () => {
    const page = readSource(COURTS_PAGE_PATH);
    expect(page).toContain('import { hasAdminAuthority } from "@/lib/auth/roles";');
    expect(page).toContain('if (!hasAdminAuthority(profile?.role)) redirect("/calendar");');
  });

  it("CourtRatePeriodsSection itself carries no independent role check — it relies on the page-level gate plus RPC-level enforcement, matching every sibling section (DefaultCourtRatesForm, CourtManagementList) on this page", () => {
    const section = readSource(SECTION_PATH);
    expect(section).not.toMatch(/role\s*!==\s*"admin"/);
    expect(section).not.toMatch(/redirect\(/);
  });

  it("upsertCourtRatePeriod / setCourtRatePeriodActive Server Actions perform no client-side role gating — authorization is the RPC's job (insufficient_role is mapped, never bypassed)", () => {
    const actions = readSource(SETTINGS_ACTIONS_PATH);
    expect(actions).toContain("insufficient_role:           \"Admin access required.\"");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. Wired into /admin/courts (Court Rates tab) — read path
// ═══════════════════════════════════════════════════════════════════════════

describe("B. /admin/courts reads and passes court_rate_periods on the Court Rates tab", () => {
  const page = readSource(COURTS_PAGE_PATH);

  it("imports and renders CourtRatePeriodsSection only inside the Court Rates (\"rates\") tab", () => {
    expect(page).toContain('import CourtRatePeriodsSection from "./CourtRatePeriodsSection";');
    const ratesStart = page.indexOf('tab === "rates"');
    expect(ratesStart).toBeGreaterThan(-1);
    expect(page.slice(ratesStart)).toContain("<CourtRatePeriodsSection");
  });

  it("queries court_rate_periods scoped to the admin's own club, using the existing RLS-respecting server client (no new read path invented)", () => {
    expect(page).toMatch(/\.from\("court_rate_periods"\)/);
    expect(page).toMatch(
      /\.select\("id, name, days_of_week, starts_at_local, ends_at_local, hourly_rate_cents, hourly_rate_non_member_cents, is_active"\)/,
    );
    const fromIdx = page.indexOf('.from("court_rate_periods")');
    const nextEqIdx = page.indexOf('.eq("club_id", clubId)', fromIdx);
    expect(nextEqIdx).toBeGreaterThan(fromIdx);
  });

  it("does not grant Members/Staff/Pro table access by widening RLS — no new policy is created anywhere in the app layer (RLS lives exclusively in 0200)", () => {
    expect(page).not.toMatch(/create policy/i);
  });

  it("passes currency and membershipsEnabled through from the SAME club_settings read DefaultCourtRatesForm uses — one source of truth for this tab, not a second fetch", () => {
    const sectionCallStart = page.indexOf("<CourtRatePeriodsSection");
    const sectionCallEnd = page.indexOf("/>", sectionCallStart);
    const call = page.slice(sectionCallStart, sectionCallEnd);
    expect(call).toContain('currency={settings?.currency ?? "USD"}');
    expect(call).toContain('membershipsEnabled={settings?.memberships_enabled ?? true}');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. Lifecycle wiring — Add/Edit/Deactivate/Reactivate, no hard Delete,
//    no direct table writes
// ═══════════════════════════════════════════════════════════════════════════

describe("C. Lifecycle uses ONLY the two existing 0200 RPCs, never a direct table write", () => {
  const actions = readSource(SETTINGS_ACTIONS_PATH);
  const section = readSource(SECTION_PATH);

  it("upsertCourtRatePeriod Server Action calls the real upsert_court_rate_period RPC with every field", () => {
    expect(actions).toContain("export async function upsertCourtRatePeriod(");
    expect(actions).toContain('supabase.rpc("upsert_court_rate_period", {');
    for (const arg of [
      "p_id: id",
      "p_name: name",
      "p_days_of_week: daysOfWeek",
      "p_starts_at_local: startsAtLocal",
      "p_ends_at_local: endsAtLocal",
      "p_hourly_rate_cents: hourlyRateCents",
      "p_hourly_rate_non_member_cents: hourlyRateNonMemberCents",
    ]) {
      expect(actions).toContain(arg);
    }
  });

  it("setCourtRatePeriodActive Server Action calls the real set_court_rate_period_active RPC", () => {
    expect(actions).toContain("export async function setCourtRatePeriodActive(");
    expect(actions).toContain('supabase.rpc("set_court_rate_period_active", {');
    expect(actions).toContain("p_id: id");
    expect(actions).toContain("p_active: active");
  });

  it("neither Server Action ever writes to court_rate_periods directly (.from(\"court_rate_periods\").insert/.update/.delete)", () => {
    expect(actions).not.toMatch(/from\("court_rate_periods"\)\.(insert|update|delete)/);
  });

  it("the relocated component imports the lifecycle actions cross-directory from settings/actions.ts — the same established Server Action import precedent MembershipsSection (admin/members) already uses for updateClubMembershipsEnabled", () => {
    expect(section).toContain(
      'import { upsertCourtRatePeriod, setCourtRatePeriodActive } from "@/app/(app)/admin/settings/actions";',
    );
  });

  it("the component calls upsertCourtRatePeriod for BOTH Add (null id) and Edit (existing id) — one Save path, matching the RPC's own single-function Add/Edit design", () => {
    expect(section).toContain("const targetId = editingId === \"__new__\" ? null : editingId;");
    expect(section).toContain("await upsertCourtRatePeriod(");
  });

  it("the component calls setCourtRatePeriodActive with explicit true/false for BOTH Deactivate and Reactivate — never a third state", () => {
    expect(section).toContain("await setCourtRatePeriodActive(p.id, active);");
    expect(section).toMatch(/onClick=\{\(\) => handleSetActive\(p, !p\.is_active\)\}/);
  });

  it("no hard-delete action exists anywhere in this UI surface", () => {
    expect(section).not.toMatch(/delete_court_rate_period|removeCourtRatePeriod|deleteCourtRatePeriod/i);
    expect(actions).not.toMatch(/delete_court_rate_period/i);
    expect(section).not.toMatch(/>\s*Delete\s*</);
  });

  it("the component never independently reproduces the pricing precedence chain — it only reflects each period's OWN configured rate fields, never resolves 'what rate applies'", () => {
    expect(section).not.toMatch(/coalesce\(/);
    // Functional-usage check, not a bare word search — this file's own
    // explanatory header comment names both RPCs in prose (documenting
    // that they are NOT called here), so the assertion targets actual
    // invocation syntax rather than plain word presence.
    expect(section).not.toMatch(/_resolve_court_reservation_rate\(/);
    expect(section).not.toMatch(/preview_court_reservation_price\(/);
    expect(section).not.toContain('.rpc("_resolve_court_reservation_rate"');
    expect(section).not.toContain('.rpc("preview_court_reservation_price"');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D. Add/Edit form fields
// ═══════════════════════════════════════════════════════════════════════════

describe("D. Add/Edit form exposes name, days, start/end time, and rates — nothing else", () => {
  const section = readSource(SECTION_PATH);

  it("has a 7-day toggle labeled Sun..Sat", () => {
    expect(section).toContain('const DAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];');
    expect(section).toContain("DAY_ABBR.map((label, idx) =>");
  });

  it("uses native time inputs for start/end (no overnight period support implied by the UI)", () => {
    const matches = section.match(/type="time"/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("has no court selector — periods remain club-wide, matching the locked v1 scope", () => {
    expect(section).not.toMatch(/court_id/);
    expect(section).not.toMatch(/<select[^>]*[Cc]ourt/);
  });

  it("has no priority/order field used as actual state, form data, or an RPC argument (the header comment's own prose mention of 'priority/order' is not itself such a usage)", () => {
    expect(section).not.toMatch(/\bpriority\s*[:=]/i);
    expect(section).not.toMatch(/\bsort_order\s*[:=]/i);
    expect(section).not.toMatch(/p_priority|p_sort_order/i);
  });

  it("converts dollars to cents only at the persistence boundary (Math.round(...*100)) — the form itself stays in dollars", () => {
    expect(section).toContain("Math.round(parseFloat(memberTrimmed) * 100)");
    expect(section).toContain("Math.round(parseFloat(nonMemberTrimmed) * 100)");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// E. Member/Non-Member presentation follows the Memberships product state
// ═══════════════════════════════════════════════════════════════════════════

describe("E. Non-Member presentation respects current Memberships state", () => {
  const section = readSource(SECTION_PATH);

  it("the Non-Member rate field/segment is gated on membershipsEnabled, matching DefaultCourtRatesForm/CourtManagementList's own convention", () => {
    expect(section).toMatch(/\{membershipsEnabled && \(/);
  });

  it("a blank/unconfigured Non-Member rate is described as 'Use fallback rate' — never phrased as 'uses the Member rate' or 'club default', which would misstate the actual multi-rung fallback chain", () => {
    expect(section).toContain('"Use fallback rate"');
    expect(section).not.toMatch(/uses standard\/member rate/i);
    expect(section).not.toMatch(/\(club default\)/i);
  });

  it("never deletes or clears a configured Non-Member rate merely because Memberships are off — the field is only hidden, the underlying value is untouched", () => {
    // Structural: the component never calls upsertCourtRatePeriod with a
    // hardcoded null for the non-member argument keyed off
    // membershipsEnabled — the value always flows from the form's own
    // (possibly still-populated) state.
    expect(section).not.toMatch(/membershipsEnabled\s*\?\s*null/);
    expect(section).not.toMatch(/!membershipsEnabled.*null/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F. Overlap and other DB errors are translated to operator-facing copy
// ═══════════════════════════════════════════════════════════════════════════

describe("F. DB errors are translated — no raw Postgres error reaches the UI", () => {
  const actions = readSource(SETTINGS_ACTIONS_PATH);

  it("maps rate_period_overlap to the exact required operator-facing copy", () => {
    expect(actions).toContain(
      'rate_period_overlap:          "This time overlaps another active rate period on one or more selected days."',
    );
  });

  it("maps invalid_time_range, rate_required, days_required, invalid_day_of_week, and rate_period_not_found to operator-friendly copy", () => {
    expect(actions).toContain('invalid_time_range:           "End time must be after start time."');
    expect(actions).toContain('rate_required:                "Enter a Member rate, a Non-Member rate, or both."');
    expect(actions).toContain('days_required:                "Please select at least one day."');
    expect(actions).toContain('invalid_day_of_week:          "Invalid day selection."');
    expect(actions).toContain(
      'rate_period_not_found:        "This rate period could not be found. Please refresh and try again."',
    );
  });

  it("reuses the existing name_required/invalid_rate copy rather than duplicating it with different wording", () => {
    expect(actions).toContain('name_required:               "Please enter a name."');
    expect(actions).toContain('invalid_rate:                "Rate must be zero or a positive amount."');
  });

  it("both new Server Actions fall back to a generic message for any unmapped error code — never surface error.message directly", () => {
    const upsertStart = actions.indexOf("export async function upsertCourtRatePeriod(");
    const upsertEnd = actions.indexOf("\n}\n", upsertStart);
    const upsertBody = actions.slice(upsertStart, upsertEnd);
    expect(upsertBody).toMatch(/ERROR_MESSAGES\[key\] \?\? "Failed to save rate period\."/);
    expect(upsertBody).not.toMatch(/error: error\.message/);

    const activeStart = actions.indexOf("export async function setCourtRatePeriodActive(");
    const activeEnd = actions.indexOf("\n}\n", activeStart);
    const activeBody = actions.slice(activeStart, activeEnd);
    expect(activeBody).toMatch(/ERROR_MESSAGES\[key\] \?\? "Failed to update rate period status\."/);
    expect(activeBody).not.toMatch(/error: error\.message/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// G. Inactive-period UX
// ═══════════════════════════════════════════════════════════════════════════

describe("G. Inactive periods remain visible with a clear status, and may be freely edited", () => {
  const section = readSource(SECTION_PATH);

  it("renders every period returned by the server, including inactive ones — no client-side filter drops inactive rows", () => {
    expect(section).toContain("periods.map((p) =>");
    expect(section).not.toMatch(/periods\.filter\(/);
  });

  it("shows an explicit Active/Inactive status pill on every row", () => {
    expect(section).toContain('{p.is_active ? "Active" : "Inactive"}');
  });

  it("the Deactivate/Reactivate button label and styling both flip based on is_active, so an inactive row is never mistaken for an active one", () => {
    expect(section).toMatch(/p\.is_active \? ACTION_BUTTON_WARNING_COMPACT : ACTION_BUTTON_POSITIVE_COMPACT/);
    expect(section).toMatch(/p\.is_active \? "Deactivate" : "Reactivate"/);
  });

  it("Edit is available regardless of is_active — an inactive period's own Edit path is identical to an active one's (the inactive-may-overlap exemption lives server-side in 0200, not in this UI)", () => {
    const editButtonMatches = section.match(/onClick=\{\(\) => startEdit\(p\)\}/g) ?? [];
    expect(editButtonMatches.length).toBeGreaterThan(0);
    // startEdit itself takes no is_active branch.
    const startEditStart = section.indexOf("function startEdit(p: RatePeriod)");
    const startEditEnd = section.indexOf("\n  }\n", startEditStart);
    expect(section.slice(startEditStart, startEditEnd)).not.toMatch(/is_active/);
  });

  it("a reactivation-overlap error surfaces the same status-banner error path as any other action — the period is left as returned by the server (no optimistic is_active flip before the RPC responds)", () => {
    const handleSetActiveStart = section.indexOf("function handleSetActive(");
    const handleSetActiveEnd = section.indexOf("\n  }\n", handleSetActiveStart);
    const body = section.slice(handleSetActiveStart, handleSetActiveEnd);
    expect(body).not.toMatch(/setPeriods\(/); // no optimistic local mutation
    expect(body).toContain("showStatus({ type: \"error\", message: result.error });");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// H. Helper copy accurately explains court overrides / fallbacks
// ═══════════════════════════════════════════════════════════════════════════

describe("H. Helper copy is accurate — never implies a period always wins over a court override", () => {
  const section = readSource(SECTION_PATH);

  it("states that a court-specific rate takes priority over a matching time-based rate (the true, locked precedence) rather than the reverse, and correctly names the Courts TAB (not 'page') now that both live on /admin/courts", () => {
    expect(section).toMatch(
      /A court-specific rate \(set on the Courts\s*\n?\s*tab\) for the same pricing type takes priority over a matching time-based rate\./,
    );
  });

  it("carries the SAME-PRICING-TYPE distinction — a Member override only outranks a matching period's Member rate, not its Non-Member rate (and vice versa)", () => {
    expect(section).toMatch(/for the same pricing type takes priority/);
  });

  it("states the general pricing-fallback behavior rather than a specific, potentially-stale precedence chain description", () => {
    expect(section).toMatch(/Court Time\s*\n?\s*otherwise follows your existing pricing fallbacks\./);
  });

  it("never states or implies a rate period always wins over a court override", () => {
    expect(section).not.toMatch(/period.{0,40}(always wins|takes precedence over|overrides).{0,40}court/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// I. Relocation itself — no reimplementation, no reintroduced staleness
// ═══════════════════════════════════════════════════════════════════════════

describe("I. Relocation from /admin/settings to /admin/courts introduced no new logic", () => {
  it("the old /admin/settings/CourtRatePeriodsSection.tsx no longer exists — this is a MOVE, not a copy left behind", () => {
    expect(() => readSource("src/app/(app)/admin/settings/CourtRatePeriodsSection.tsx")).toThrow();
  });

  it("/admin/settings no longer imports or renders CourtRatePeriodsSection", () => {
    const settingsPage = readSource("src/app/(app)/admin/settings/page.tsx");
    expect(settingsPage).not.toMatch(/CourtRatePeriodsSection/);
  });

  it("the underlying 0200 lifecycle RPCs and error-mapping logic in settings/actions.ts are untouched by the relocation — same RPC names, same argument lists as before the move", () => {
    const actions = readSource(SETTINGS_ACTIONS_PATH);
    expect(actions).toContain('supabase.rpc("upsert_court_rate_period", {');
    expect(actions).toContain('supabase.rpc("set_court_rate_period_active", {');
  });

  it("no migration was created or modified for this relocation", () => {
    for (const path of [COURTS_PAGE_PATH, SETTINGS_ACTIONS_PATH, SECTION_PATH]) {
      const s = readSource(path);
      expect(s).not.toMatch(/create or replace function|drop function|alter table|create table/i);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// J. Final pre-merge polish — start-time pricing rule explained in-context
// ═══════════════════════════════════════════════════════════════════════════

describe("J. Start-time pricing rule is explained in-context, with no new control/modal/tooltip", () => {
  const section = readSource(SECTION_PATH);

  it("states the exact required explanation of the locked start-time-only pricing rule", () => {
    expect(section).toContain(
      "Rates are determined by the reservation start time. The selected rate applies to the entire\n        reservation.",
    );
  });

  it("is placed alongside the section's own existing precedence/fallback copy, not gated behind any new UI control", () => {
    const precedenceIdx = section.indexOf("Court Time\n        otherwise follows your existing pricing fallbacks.");
    const startTimeIdx = section.indexOf("Rates are determined by the reservation start time.");
    expect(precedenceIdx).toBeGreaterThan(-1);
    expect(startTimeIdx).toBeGreaterThan(precedenceIdx);
    // Both live in the same plain <p> pattern as the rest of this
    // component's helper copy — no modal, dialog, or tooltip wrapper.
    expect(section).not.toMatch(/<Modal|<Dialog|Tooltip|title=".*start time/i);
  });

  it("does not change or split pricing by duration — no blended/proportional pricing language or logic is introduced", () => {
    expect(section).not.toMatch(/blend|proportional|split.{0,20}rate|partial.{0,20}rate/i);
  });

  it("adds no new settings control, checkbox, or toggle for this explanation", () => {
    const startTimeIdx = section.indexOf("Rates are determined by the reservation start time.");
    const surrounding = section.slice(Math.max(0, startTimeIdx - 200), startTimeIdx + 200);
    expect(surrounding).not.toMatch(/<input|<select|<button/);
  });
});
