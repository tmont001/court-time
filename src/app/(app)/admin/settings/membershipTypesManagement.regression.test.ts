import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 42C-3B — Membership Types management frontend. Wires the existing
// 0188 RPCs (create_membership_type, update_membership_type,
// set_membership_type_active — all applied/immutable) to a new
// MembershipTypesSection.tsx, moves the existing MembershipsSection
// toggle into its own top-level Settings group, and loads membership_types
// via a plain RLS-scoped table read (no new migration, no new RPC).
//
// Source-inspection style, matching this project's established convention
// (see settingsInformationArchitecture.regression.test.ts /
// membershipSettingsPricingUI.regression.test.ts).

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const PAGE_PATH = "src/app/(app)/admin/settings/page.tsx";
const ACTIONS_PATH = "src/app/(app)/admin/settings/actions.ts";
const TYPES_SECTION_PATH = "src/app/(app)/admin/members/MembershipTypesSection.tsx";
const TYPES_PAGE_PATH = "src/app/(app)/admin/members/types/page.tsx";

// ═══════════════════════════════════════════════════════════════════════════
// 1. Memberships has its own dedicated Admin Members hub page (Phase
//    43B-3E relocated it OUT of /admin/settings entirely — it is no
//    longer merely "its own group" on that page, it is a separate route)
// ═══════════════════════════════════════════════════════════════════════════
describe("1. Membership Types has its own dedicated page at /admin/members/types", () => {
  it("the page renders MembershipsSection then, when enabled, MembershipTypesSection", () => {
    const s = readSource(TYPES_PAGE_PATH);
    const componentIdx = s.indexOf("<MembershipsSection");
    const typesIdx = s.indexOf("<MembershipTypesSection");
    expect(componentIdx).toBeGreaterThan(-1);
    expect(typesIdx).toBeGreaterThan(componentIdx);
  });

  it("the move is frontend-only — no new RPC call was introduced on this page itself (plain RLS-scoped table reads only)", () => {
    const s = readSource(TYPES_PAGE_PATH);
    expect(s).not.toMatch(/\.rpc\(/);
  });

  it("the page renders the shared Members-area tab navigation and is Admin-only", () => {
    const s = readSource(TYPES_PAGE_PATH);
    expect(s).toContain("<MembersAreaTabs");
    expect(s).toContain('if (profile?.role !== "admin") redirect("/calendar");');
  });

  it("/admin/settings no longer renders a 'Memberships' group heading, MembershipsSection, or MembershipTypesSection — no duplicate live management surface", () => {
    const s = readSource(PAGE_PATH);
    expect(s).not.toMatch(/<h2[^>]*>Memberships<\/h2>/);
    expect(s).not.toMatch(/<MembershipsSection|<MembershipTypesSection/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. toggle remains visible when OFF
// ═══════════════════════════════════════════════════════════════════════════
describe("2. the Memberships On/Off toggle remains visible when off", () => {
  it("MembershipsSection is rendered unconditionally on the Membership Types page", () => {
    const s = readSource(TYPES_PAGE_PATH);
    const componentIdx = s.indexOf("<MembershipsSection");
    expect(componentIdx).toBeGreaterThan(-1);
    // Not wrapped in a `{membershipsEnabled && (` gate.
    const preceding = s.slice(0, componentIdx);
    expect(preceding.trimEnd().endsWith("{membershipsEnabled && (")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Membership Types management hides when OFF
// ═══════════════════════════════════════════════════════════════════════════
describe("3. Membership Types management hides entirely when Memberships are off", () => {
  it("MembershipTypesSection is gated behind membershipsEnabled", () => {
    const s = readSource(TYPES_PAGE_PATH);
    const gateIdx = s.indexOf("{membershipsEnabled && (");
    const sectionIdx = s.indexOf("<MembershipTypesSection");
    expect(gateIdx).toBeGreaterThan(-1);
    expect(sectionIdx).toBeGreaterThan(gateIdx);
  });

  it("hiding never deletes/clears data — page.tsx issues no UPDATE/DELETE against membership_types, only a SELECT", () => {
    const s = readSource(TYPES_PAGE_PATH);
    expect(s).toContain('.from("membership_types")');
    expect(s).toContain('.select("id, name, is_active")');
    expect(s).not.toMatch(/\.from\("membership_types"\)[\s\S]{0,80}\.(update|delete|insert)\(/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. list includes active + inactive types
// ═══════════════════════════════════════════════════════════════════════════
describe("4. the Membership Types list includes both active and inactive types", () => {
  it("page.tsx's membership_types query has no is_active filter — shows ALL types", () => {
    const s = readSource(PAGE_PATH);
    const queryIdx = s.indexOf('.from("membership_types")');
    const queryEnd = s.indexOf(",", s.indexOf(".order(", queryIdx));
    const query = s.slice(queryIdx, queryEnd > -1 ? queryEnd : queryIdx + 300);
    expect(query).not.toContain('.eq("is_active"');
  });

  it("MembershipTypesSection renders every type's Active/Inactive state as a badge, not by hiding inactive rows", () => {
    const s = readSource(TYPES_SECTION_PATH);
    expect(s).toContain("{type.is_active ? \"Active\" : \"Inactive\"}");
    // No filter excluding inactive types before mapping.
    expect(s).not.toMatch(/types\.filter\([^)]*is_active/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. create/rename/deactivate/reactivate use the correct 0188 RPCs
// ═══════════════════════════════════════════════════════════════════════════
describe("5. create/rename/deactivate/reactivate wire to the correct 0188 RPCs", () => {
  it("createMembershipTypeAction calls create_membership_type(p_name)", () => {
    const s = readSource(ACTIONS_PATH);
    const start = s.indexOf("export async function createMembershipTypeAction(");
    expect(start).toBeGreaterThan(-1);
    const body = s.slice(start, s.indexOf("\nexport async function", start + 1));
    expect(body).toContain('supabase.rpc("create_membership_type", { p_name: name });');
  });

  it("updateMembershipTypeAction (rename) calls update_membership_type(p_id, p_name)", () => {
    const s = readSource(ACTIONS_PATH);
    const start = s.indexOf("export async function updateMembershipTypeAction(");
    expect(start).toBeGreaterThan(-1);
    const body = s.slice(start, s.indexOf("\nexport async function", start + 1));
    expect(body).toContain('supabase.rpc("update_membership_type", { p_id: id, p_name: name });');
  });

  it("setMembershipTypeActiveAction calls set_membership_type_active(p_id, p_is_active) for both deactivate and reactivate", () => {
    const s = readSource(ACTIONS_PATH);
    const start = s.indexOf("export async function setMembershipTypeActiveAction(");
    expect(start).toBeGreaterThan(-1);
    const body = s.slice(start, s.indexOf("\nexport async function", start + 1));
    expect(body).toContain('supabase.rpc("set_membership_type_active", { p_id: id, p_is_active: isActive });');
  });

  it("MembershipTypesSection calls all three actions from the correct call sites (Add, Rename, Deactivate/Reactivate)", () => {
    const s = readSource(TYPES_SECTION_PATH);
    expect(s).toContain("await createMembershipTypeAction(trimmed);");
    expect(s).toContain("await updateMembershipTypeAction(id, trimmed);");
    expect(s).toContain("await setMembershipTypeActiveAction(type.id, isActive);");
  });

  it("uses the project-standard error mapping, useTransition/pending, success/error feedback, and router.refresh()", () => {
    const s = readSource(TYPES_SECTION_PATH);
    expect(s).toContain("useTransition");
    expect(s).toContain("isPending");
    expect(s).toContain("showStatus({ type: \"success\"");
    expect(s).toContain("showStatus({ type: \"error\"");
    expect(s).toContain("router.refresh();");
  });

  it("handles all seven documented 0188 error codes via ERROR_MESSAGES, without inventing a new error subsystem", () => {
    const s = readSource(ACTIONS_PATH);
    for (const code of [
      "name_required", "name_too_long", "membership_type_name_taken",
      "membership_type_not_found", "is_active_required",
      "not_authenticated", "insufficient_role",
    ]) {
      expect(s).toContain(`${code}:`);
    }
    // Same one ERROR_MESSAGES map every other action in this file already
    // uses — no second, parallel error-mapping structure.
    const errorMapDeclarations = (s.match(/const ERROR_MESSAGES: Record<string, string> = \{/g) ?? []).length;
    expect(errorMapDeclarations).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. no Delete UI/action exists
// ═══════════════════════════════════════════════════════════════════════════
describe("6. no Delete UI or action exists for Membership Types", () => {
  it("MembershipTypesSection renders no delete button/control", () => {
    const s = readSource(TYPES_SECTION_PATH);
    expect(s).not.toMatch(/>Delete</i);
    expect(s).not.toMatch(/onDelete|handleDelete|deleteMembershipType/i);
  });

  it("settings/actions.ts defines no delete-membership-type action, and calls no delete_membership_type RPC", () => {
    const s = readSource(ACTIONS_PATH);
    expect(s).not.toMatch(/delete_membership_type/i);
    expect(s).not.toMatch(/export async function deleteMembershipType/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Responsiveness (Section 10 of the checkpoint spec)
// ═══════════════════════════════════════════════════════════════════════════
describe("Membership Types rows work on narrow mobile widths", () => {
  it("the normal row uses the same mobile-first stacking (flex-col, sm:flex-row) as CourtManagementList's own precedent", () => {
    const s = readSource(TYPES_SECTION_PATH);
    expect(s).toContain('className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"');
  });

  it("the action-button row wraps on mobile, never forcing horizontal overflow", () => {
    const s = readSource(TYPES_SECTION_PATH);
    expect(s).toContain('className="flex items-center gap-1.5 flex-wrap sm:flex-nowrap sm:flex-shrink-0"');
  });
});
