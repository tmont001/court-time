import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Phase 42C-3B — Complete Membership Management Frontend (Members list +
// Member Detail). Widens the existing 0190 read models (get_members(),
// get_roster_members()) and the 0191 read model (get_admin_member_detail)
// on the frontend, wires the existing 0188 RPCs
// (set_roster_member_membership_status/set_roster_member_membership_type)
// to both the unclaimed-roster editor on the Members list AND the claimed-
// person Membership block on Member Detail, and adds explicit "Membership:
// " wording distinct from the existing lifecycle status badge. No new
// migration, no new RPC, no authorization change.
//
// Source-inspection style, matching this project's established convention.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const MEMBERS_PAGE_PATH        = "src/app/(app)/admin/members/page.tsx";
const MEMBERS_CLIENT_PATH      = "src/app/(app)/admin/members/MembersClient.tsx";
const MEMBERS_ACTIONS_PATH     = "src/app/(app)/admin/members/actions.ts";
const DETAIL_PAGE_PATH         = "src/app/(app)/admin/members/[id]/page.tsx";
const DETAIL_CLIENT_PATH       = "src/app/(app)/admin/members/[id]/MemberDetailClient.tsx";
const DETAIL_ACTIONS_PATH      = "src/app/(app)/admin/members/[id]/actions.ts";
const ADD_MEMBER_SHEET_PATH    = "src/app/(app)/admin/members/AddMemberSheet.tsx";

function functionBody(source: string, exportName: string): string {
  const start = source.indexOf(`export async function ${exportName}(`);
  expect(start, `${exportName} not found`).toBeGreaterThan(-1);
  const nextExportIdx = source.indexOf("\nexport async function", start + 1);
  return source.slice(start, nextExportIdx > -1 ? nextExportIdx : undefined);
}

// ═══════════════════════════════════════════════════════════════════════════
// MEMBERS LIST — DATA
// ═══════════════════════════════════════════════════════════════════════════

describe("7. the widened claimed Member frontend type consumes all 3 membership fields", () => {
  it("MembersClient's Member type includes membership_status/membership_type_id/membership_type_name, nullable (matches get_members()'s LEFT JOIN)", () => {
    const s = readSource(MEMBERS_CLIENT_PATH);
    const start = s.indexOf("type Member = {");
    const end = s.indexOf("\n};", start);
    const body = s.slice(start, end);
    expect(body).toMatch(/membership_status:\s*"active" \| "inactive" \| "suspended" \| "non_member" \| null;/);
    expect(body).toContain("membership_type_id:   string | null;");
    expect(body).toContain("membership_type_name: string | null;");
  });
});

describe("8. the widened RosterMember frontend type consumes all 3 membership fields", () => {
  it("MembersClient's RosterMember type includes membership_status (non-null, matches get_roster_members()'s own-row LEFT JOIN target) plus type id/name", () => {
    const s = readSource(MEMBERS_CLIENT_PATH);
    const start = s.indexOf("export type RosterMember = {");
    const end = s.indexOf("\n};", start);
    const body = s.slice(start, end);
    expect(body).toMatch(/membership_status:\s*"active" \| "inactive" \| "suspended" \| "non_member";/);
    expect(body).not.toMatch(/membership_status:\s*"active" \| "inactive" \| "suspended" \| "non_member" \| null;/);
    expect(body).toContain("membership_type_id:   string | null;");
    expect(body).toContain("membership_type_name: string | null;");
  });
});

describe("members/page.tsx loads memberships_enabled and (Admin only) active membership types, without broadening Staff access", () => {
  it("selects club_settings.memberships_enabled and passes it through", () => {
    const s = readSource(MEMBERS_PAGE_PATH);
    expect(s).toContain('.from("club_settings").select("memberships_enabled")');
    expect(s).toContain("membershipsEnabled={membershipsEnabled}");
  });

  it("the membership_types query is gated on isAdmin, not merely on isOperator (Staff never triggers it)", () => {
    const s = readSource(MEMBERS_PAGE_PATH);
    expect(s).toContain('const isAdmin = profile?.role === "admin";');
    const queryIdx = s.indexOf('.from("membership_types")');
    expect(queryIdx).toBeGreaterThan(-1);
    const precedingLine = s.slice(s.lastIndexOf("\n", s.lastIndexOf("isAdmin && clubId", queryIdx)), queryIdx);
    expect(precedingLine).toContain("isAdmin && clubId");
  });

  it("does not add a duplicate club_settings/get_roster_members fetch — reuses the existing Promise.all", () => {
    const s = readSource(MEMBERS_PAGE_PATH);
    const settingsMatches = s.match(/\.from\("club_settings"\)/g) ?? [];
    const rosterRpcMatches = s.match(/supabase\.rpc\("get_roster_members"/g) ?? [];
    expect(settingsMatches.length).toBe(1);
    expect(rosterRpcMatches.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MEMBERS LIST — CLAIMED PEOPLE
// ═══════════════════════════════════════════════════════════════════════════

describe("9. explicit \"Membership:\" wording is used, never confusable with the lifecycle badge", () => {
  it("MembersClient's shared membershipLine() helper always prefixes \"Membership: \"", () => {
    const s = readSource(MEMBERS_CLIENT_PATH);
    expect(s).toContain('return `Membership: ${statusLabel}${membershipTypeName ? ` · ${membershipTypeName}` : ""}`;');
  });

  it("labels are exactly Active/Inactive/Suspended/Non-Member — matching the locked copy, never a bare status word alone", () => {
    const s = readSource(MEMBERS_CLIENT_PATH);
    const start = s.indexOf("const MEMBERSHIP_STATUS_LABELS: Record<string, string> = {");
    const end = s.indexOf("};", start);
    const body = s.slice(start, end);
    expect(body).toContain('active:      "Active",');
    expect(body).toContain('inactive:    "Inactive",');
    expect(body).toContain('suspended:   "Suspended",');
    expect(body).toContain('non_member:  "Non-Member",');
  });

  it("ProfileCard renders the line via membershipLine(), not an ad hoc inline string", () => {
    const s = readSource(MEMBERS_CLIENT_PATH);
    expect(s).toContain("membershipLine(m.membership_status, m.membership_type_name)");
  });

  it("RosterCard renders the line via the same membershipLine() helper", () => {
    const s = readSource(MEMBERS_CLIENT_PATH);
    expect(s).toContain("membershipLine(rm.membership_status, rm.membership_type_name)");
  });
});

describe("10. the membership line hides entirely when Memberships are off", () => {
  it("ProfileCard's membership line is gated behind the membershipsEnabled prop", () => {
    const s = readSource(MEMBERS_CLIENT_PATH);
    const profileCardStart = s.indexOf("function ProfileCard(");
    const profileCardEnd = s.indexOf("\nfunction RosterCard(", profileCardStart);
    const body = s.slice(profileCardStart, profileCardEnd);
    expect(body).toMatch(/\{membershipsEnabled && membershipLine\(/);
  });

  it("RosterCard's membership line is gated behind the membershipsEnabled prop", () => {
    const s = readSource(MEMBERS_CLIENT_PATH);
    const rosterCardStart = s.indexOf("function RosterCard(");
    const body = s.slice(rosterCardStart);
    const lineIdx = body.indexOf("{membershipLine(rm.membership_status");
    expect(lineIdx).toBeGreaterThan(-1);
    const gateIdx = body.lastIndexOf("{membershipsEnabled && (", lineIdx);
    expect(gateIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(lineIdx);
  });

  it("hiding is a pure display gate — no membership data is ever cleared/mutated merely by the toggle being off (no UPDATE against roster_members in either client file)", () => {
    for (const path of [MEMBERS_CLIENT_PATH, MEMBERS_PAGE_PATH]) {
      const s = readSource(path);
      expect(s).not.toMatch(/\.from\("roster_members"\)[\s\S]{0,80}\.update\(/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MEMBERS LIST — UNCLAIMED ROSTER PEOPLE
// ═══════════════════════════════════════════════════════════════════════════

describe("11. the unclaimed-roster Membership editor exists for Admin when Memberships are ON", () => {
  it("RosterCard renders a 'Membership' toggle button gated on membershipsEnabled AND isAdmin", () => {
    const s = readSource(MEMBERS_CLIENT_PATH);
    const rosterCardStart = s.indexOf("function RosterCard(");
    const body = s.slice(rosterCardStart);
    expect(body).toContain("const isAdmin = userRole === \"admin\";");
    expect(body).toMatch(/\{membershipsEnabled && isAdmin && \(\s*<button\s*onClick=\{\(\) => onToggleEditor\(rm\)\}/);
  });

  it("the inline editor block itself (Status + Type selects) is gated on the same membershipsEnabled && isAdmin && editorOpen condition", () => {
    const s = readSource(MEMBERS_CLIENT_PATH);
    expect(s).toContain("{membershipsEnabled && isAdmin && editorOpen && (");
  });

  it("no new roster-member detail route was created — the editor lives inline on the existing list card", () => {
    // The Membership editor's own state/props never reference a route or
    // navigation — it's pure inline component state (editorOpen boolean),
    // never a Link/router.push to a per-roster-member URL.
    const s = readSource(MEMBERS_CLIENT_PATH);
    const rosterCardStart = s.indexOf("function RosterCard(");
    const rosterCardBody = s.slice(rosterCardStart, s.indexOf("\n}", s.lastIndexOf("return (", s.length)));
    expect(rosterCardBody).not.toMatch(/router\.push|<Link\s+href=\{`\/admin\/members\/roster/);
  });
});

describe("12. the unclaimed editor hides entirely when Memberships are off", () => {
  it("both the toggle button and the editor block share the membershipsEnabled gate — neither can render independently while off", () => {
    const s = readSource(MEMBERS_CLIENT_PATH);
    const toggleButtonGate = s.match(/\{membershipsEnabled && isAdmin && \(\s*<button/);
    const editorBlockGate = s.match(/\{membershipsEnabled && isAdmin && editorOpen && \(/);
    expect(toggleButtonGate).not.toBeNull();
    expect(editorBlockGate).not.toBeNull();
  });
});

describe("13. unclaimed status/type mutations use the correct 0188 RPCs", () => {
  it("setRosterMemberMembershipStatusAction calls set_roster_member_membership_status(p_roster_member_id, p_membership_status)", () => {
    const s = readSource(MEMBERS_ACTIONS_PATH);
    const body = functionBody(s, "setRosterMemberMembershipStatusAction");
    expect(body).toContain('supabase.rpc("set_roster_member_membership_status", {');
    expect(body).toContain("p_roster_member_id: rosterMemberId,");
    expect(body).toContain("p_membership_status: membershipStatus,");
  });

  it("setRosterMemberMembershipTypeAction calls set_roster_member_membership_type(p_roster_member_id, p_membership_type_id)", () => {
    const s = readSource(MEMBERS_ACTIONS_PATH);
    const body = functionBody(s, "setRosterMemberMembershipTypeAction");
    expect(body).toContain('supabase.rpc("set_roster_member_membership_type", {');
    expect(body).toContain("p_roster_member_id: rosterMemberId,");
    expect(body).toContain("p_membership_type_id: membershipTypeId,");
  });

  it("the two mutations remain independent — RosterCard calls them via two separate handlers/selects, never combined into one call", () => {
    const s = readSource(MEMBERS_CLIENT_PATH);
    expect(s).toContain("onChange={(e) => onStatusChange(rm, e.target.value as \"active\" | \"inactive\" | \"suspended\" | \"non_member\")}");
    expect(s).toContain("onChange={(e) => onTypeChange(rm, e.target.value)}");
  });

  it("both actions are exported once each — RosterCard's editor and Member Detail's Membership block share this same wrapper (Section 7 of the checkpoint spec), no duplicate copy exists", () => {
    const s = readSource(MEMBERS_ACTIONS_PATH);
    const statusExports = (s.match(/export async function setRosterMemberMembershipStatusAction/g) ?? []).length;
    const typeExports = (s.match(/export async function setRosterMemberMembershipTypeAction/g) ?? []).length;
    expect(statusExports).toBe(1);
    expect(typeExports).toBe(1);
    const detailClient = readSource(DETAIL_CLIENT_PATH);
    expect(detailClient).toContain('import {\n  setRosterMemberMembershipStatusAction,\n  setRosterMemberMembershipTypeAction,\n} from "../actions";');
  });
});

describe("14. the inactive-type assignment rule is represented correctly in the unclaimed editor's options", () => {
  it("typeOptions always includes the currently-assigned type even when it's absent from the active-only membershipTypes pool, marked inactive", () => {
    const s = readSource(MEMBERS_CLIENT_PATH);
    const rosterCardStart = s.indexOf("function RosterCard(");
    const body = s.slice(rosterCardStart, s.indexOf("return (", rosterCardStart));
    expect(body).toMatch(/rm\.membership_type_id && !membershipTypes\.some\(\(t\) => t\.id === rm\.membership_type_id\)/);
    expect(body).toContain("inactive: true");
  });

  it("the select option renders the explicit \"(inactive type)\" wording only for that one synthetic entry, never for the general active pool", () => {
    // UX polish pass: "(inactive)" alone read as if the PERSON's
    // membership were inactive — corrected to "(inactive type)" so it's
    // unambiguous that only the TYPE itself was deactivated.
    const s = readSource(MEMBERS_CLIENT_PATH);
    expect(s).toContain('{t.name}{t.inactive ? " (inactive type)" : ""}');
    expect(s).not.toContain('{t.name}{t.inactive ? " (inactive)" : ""}');
  });

  it("no OTHER inactive type is ever fetched or exposed — the page-level query is active-only", () => {
    const s = readSource(MEMBERS_PAGE_PATH);
    const queryIdx = s.indexOf('.from("membership_types")');
    const queryLine = s.slice(queryIdx, s.indexOf("\n", queryIdx));
    expect(queryLine).toContain('.eq("is_active", true)');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CLAIMED MEMBER DETAIL
// ═══════════════════════════════════════════════════════════════════════════

describe("15. Member Detail consumes all 3 0191 fields", () => {
  it("MemberDetail interface includes membership_status/membership_type_id/membership_type_name, nullable (matches 0191's LEFT JOIN)", () => {
    const s = readSource(DETAIL_CLIENT_PATH);
    const start = s.indexOf("export interface MemberDetail {");
    const end = s.indexOf("\n}", start);
    const body = s.slice(start, end);
    expect(body).toMatch(/membership_status:\s*"active" \| "inactive" \| "suspended" \| "non_member" \| null;/);
    expect(body).toContain("membership_type_id:   string | null;");
    expect(body).toContain("membership_type_name: string | null;");
  });

  it("local component state is seeded from all three member.* fields", () => {
    const s = readSource(DETAIL_CLIENT_PATH);
    expect(s).toContain("useState<\"active\" | \"inactive\" | \"suspended\" | \"non_member\" | null>(member.membership_status);");
    expect(s).toContain("useState<string | null>(member.membership_type_id);");
    expect(s).toContain("useState<string | null>(member.membership_type_name);");
  });
});

describe("16-17. the Membership block shows when ON and hides entirely when OFF", () => {
  it("the block is gated behind the membershipsEnabled prop", () => {
    const s = readSource(DETAIL_CLIENT_PATH);
    expect(s).toContain("{membershipsEnabled && (");
    const gateIdx = s.indexOf("{membershipsEnabled && (");
    const headingIdx = s.indexOf('<p className="text-xs font-medium text-gray-700 dark:text-gray-300">Membership</p>');
    expect(headingIdx).toBeGreaterThan(gateIdx);
  });

  it("hiding never clears local state or calls a mutation — it is a pure render gate", () => {
    const s = readSource(DETAIL_CLIENT_PATH);
    // The gate wraps ONLY the JSX block; no setMembershipStatus/setMembershipTypeId
    // call exists anywhere outside the two handler functions.
    const setterCallSites = (s.match(/setMembershipStatus\(|setMembershipTypeId\(/g) ?? []).length;
    // Exactly 2: once inside handleMembershipStatusChange, once inside
    // handleMembershipTypeChange's success path — never a third call
    // triggered by the visibility toggle itself.
    expect(setterCallSites).toBe(2);
  });
});

describe("18. Admin receives edit controls", () => {
  it("the Status <select> and Type <select> are rendered only when isMembershipAdmin (userRole === 'admin') is true", () => {
    // UX polish pass (round 2): pill+select redundancy removed — each
    // field is now a single three-way ternary (admin+rosterMemberId ?
    // <select> : value ? <pill> : <empty-state>). The <select> branch is
    // still gated on the exact same isMembershipAdmin && rosterMemberId
    // condition as before, just as the FIRST branch of a ternary rather
    // than an && block.
    const s = readSource(DETAIL_CLIENT_PATH);
    expect(s).toContain('const isMembershipAdmin = userRole === "admin";');
    const statusSelectGate = s.match(/\{isMembershipAdmin && rosterMemberId \? \(\s*<select\s*\n\s*value=\{membershipStatus/);
    const typeSelectGate = s.match(/\{isMembershipAdmin && rosterMemberId \? \(\s*<select\s*\n\s*value=\{membershipTypeId/);
    expect(statusSelectGate).not.toBeNull();
    expect(typeSelectGate).not.toBeNull();
  });

  it("the edit handlers call the shared roster mutation actions with the resolved rosterMemberId", () => {
    const s = readSource(DETAIL_CLIENT_PATH);
    expect(s).toContain("await setRosterMemberMembershipStatusAction(rosterMemberId, status);");
    expect(s).toContain("await setRosterMemberMembershipTypeAction(rosterMemberId, typeId || null);");
  });
});

describe("19. Staff gets read-only membership data — no edit controls, no mutation actions exposed", () => {
  it("Staff sees only the shared read-only badge — never a <select> — for both Status and Type", () => {
    // UX polish pass (round 2): the pill+select redundancy from round 1
    // is gone. Each field is now ONE three-way ternary:
    //   isMembershipAdmin && rosterMemberId ? <select> : value ? <pill> : <empty>
    // A non-admin viewer (Staff) fails the first condition and falls
    // through to the pill branch — proving Staff gets the pill, never a
    // <select>, without a separate isMembershipAdmin check duplicated
    // inside the pill branch itself (the ternary structure alone already
    // guarantees exclusivity).
    const s = readSource(DETAIL_CLIENT_PATH);

    const statusTernaryStartMatch = /\{isMembershipAdmin && rosterMemberId \? \(\s*<select\s*\n\s*value=\{membershipStatus/.exec(s);
    expect(statusTernaryStartMatch).not.toBeNull();
    const statusTernaryStart = statusTernaryStartMatch!.index;
    const statusTernaryEnd = s.indexOf(")}", s.indexOf("</select>", statusTernaryStart));
    const statusTernary = s.slice(statusTernaryStart, statusTernaryEnd);
    expect(statusTernary).toContain(") : membershipStatus ? (");
    expect(statusTernary).toContain("MEMBERSHIP_STATUS_BADGE_CLASSES[membershipStatus] ?? MEMBERSHIP_STATUS_BADGE_CLASSES.inactive");
    expect(statusTernary).toContain(") : (");

    const typeTernaryStartMatch = /\{isMembershipAdmin && rosterMemberId \? \(\s*<select\s*\n\s*value=\{membershipTypeId/.exec(s);
    expect(typeTernaryStartMatch).not.toBeNull();
    const typeTernaryStart = typeTernaryStartMatch!.index;
    const typeTernaryEnd = s.indexOf(")}", s.indexOf("</select>", typeTernaryStart));
    const typeTernary = s.slice(typeTernaryStart, typeTernaryEnd);
    expect(typeTernary).toContain(") : membershipTypeName ? (");
    expect(typeTernary).toContain("${MEMBERSHIP_TYPE_BADGE_CLASSES}");
    expect(typeTernary).toContain(") : (");
  });

  it("handleMembershipStatusChange/handleMembershipTypeChange are the ONLY call sites of the two mutation actions — nothing fires them outside an explicit Admin-only select onChange", () => {
    const s = readSource(DETAIL_CLIENT_PATH);
    const statusActionCalls = (s.match(/setRosterMemberMembershipStatusAction\(/g) ?? []).length;
    const typeActionCalls = (s.match(/setRosterMemberMembershipTypeAction\(/g) ?? []).length;
    // One import reference + one call site each = 2 total occurrences of
    // the bare identifier; the import line uses the same token once more,
    // captured by the dedicated import-shape test in item 13 above — here
    // we only need to confirm the ACTUAL CALL (with an opening paren)
    // appears exactly once, i.e. from exactly one handler.
    expect(statusActionCalls).toBe(1);
    expect(typeActionCalls).toBe(1);
  });
});

describe("20. status options are exactly active/inactive/suspended/non_member", () => {
  it("the Status <select> offers exactly the four locked values, no more, no fewer", () => {
    const s = readSource(DETAIL_CLIENT_PATH);
    const selectStart = s.indexOf('onChange={(e) => handleMembershipStatusChange(e.target.value as "active" | "inactive" | "suspended" | "non_member")}');
    const selectEnd = s.indexOf("</select>", selectStart);
    const select = s.slice(selectStart, selectEnd);
    expect(select).toContain('<option value="active">Active</option>');
    expect(select).toContain('<option value="inactive">Inactive</option>');
    expect(select).toContain('<option value="suspended">Suspended</option>');
    expect(select).toContain('<option value="non_member">Non-Member</option>');
    const optionCount = (select.match(/<option value=/g) ?? []).length;
    // 4 real options + possibly 1 placeholder "—" option when unset.
    expect(optionCount).toBeLessThanOrEqual(5);
    expect(optionCount).toBeGreaterThanOrEqual(4);
  });
});

describe("21. type options are active types plus the current type only (if inactive)", () => {
  it("membershipTypeOptions is built from the active-only membershipTypes prop plus, conditionally, the one currently-assigned inactive type", () => {
    const s = readSource(DETAIL_CLIENT_PATH);
    const start = s.indexOf("const membershipTypeOptions: (MembershipTypeOption & { inactive?: boolean })[] = [");
    expect(start).toBeGreaterThan(-1);
    const body = s.slice(start, s.indexOf("];", start));
    expect(body).toContain("...membershipTypes,");
    expect(body).toMatch(/membershipTypeId && !membershipTypes\.some\(\(t\) => t\.id === membershipTypeId\)/);
  });

  it("page.tsx fetches active membership types only, Admin-gated, matching the roster editor's own pool", () => {
    const s = readSource(DETAIL_PAGE_PATH);
    expect(s).toContain('const isAdmin = profile.role === "admin";');
    const queryIdx = s.indexOf('.from("membership_types")');
    expect(queryIdx).toBeGreaterThan(-1);
    // The ternary's condition sits 1-2 lines above the query itself
    // (matching this file's existing multi-line ternary style for the
    // other Admin-gated/clubId-gated queries above it) — search a
    // generous surrounding window rather than assuming a single line.
    const queryBlock = s.slice(Math.max(0, queryIdx - 120), s.indexOf("\n", s.indexOf(".order(", queryIdx)));
    expect(queryBlock).toContain("isAdmin && clubId");
    expect(queryBlock).toContain('.eq("is_active", true)');
  });

  it("Staff's read-only display needs no membership_types read at all — 0191 already returns membership_type_name directly", () => {
    const s = readSource(DETAIL_PAGE_PATH);
    // The membership_types query itself is the ONLY one gated on isAdmin;
    // get_admin_member_detail (0191) is called unconditionally for
    // everyone the page already lets in (admin+staff), and its own
    // response already carries membership_type_name.
    expect(s).toContain('supabase.rpc("get_admin_member_detail", { p_member_id: id }),');
  });
});

describe("22. mutations use the correct 0188 RPCs (Member Detail path)", () => {
  it("Member Detail's handlers route through the SAME shared actions verified in item 13, not a duplicate copy", () => {
    const s = readSource(DETAIL_CLIENT_PATH);
    expect(s).not.toMatch(/supabase\.rpc\("set_roster_member_membership_(status|type)"/);
    const detailActions = readSource(DETAIL_ACTIONS_PATH);
    expect(detailActions).not.toMatch(/set_roster_member_membership_(status|type)/);
  });
});

describe("23. roster lifecycle status is not modified by any of this", () => {
  it("Member Detail never writes roster_members.status — only membership_status/membership_type_id, via the two 0188 RPCs, both scoped to those columns only", () => {
    const s = readSource(DETAIL_CLIENT_PATH);
    // No direct table mutation against roster_members at all — the file's
    // own explanatory comment legitimately mentions "roster_members.status"
    // in prose (contrasting it with Membership Status); the actual
    // invariant is that no .update(...) call targets that table/column.
    expect(s).not.toMatch(/\.from\("roster_members"\)/);
  });

  it("MembersClient's roster editor never calls set_member_status/remove_roster_member/restore_roster_member from within the Membership block", () => {
    const s = readSource(MEMBERS_CLIENT_PATH);
    const rosterCardStart = s.indexOf("function RosterCard(");
    const editorBlockStart = s.indexOf("{membershipsEnabled && isAdmin && editorOpen && (", rosterCardStart);
    const editorBlockEnd = s.indexOf("\n      )}", editorBlockStart);
    const editorBlock = s.slice(editorBlockStart, editorBlockEnd);
    expect(editorBlock).not.toMatch(/onStatusAction|remove_roster_member|restore_roster_member|set_member_status/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// NON-SCOPE
// ═══════════════════════════════════════════════════════════════════════════

describe("24. AddMemberSheet is untouched", () => {
  it("no membership_status/membership_type_id/membership_type_name field or 0188 RPC reference exists in AddMemberSheet.tsx", () => {
    const s = readSource(ADD_MEMBER_SHEET_PATH);
    expect(s).not.toMatch(/membership_status|membership_type_id|membership_type_name/);
    expect(s).not.toMatch(/create_membership_type|update_membership_type|set_membership_type_active|set_roster_member_membership_status|set_roster_member_membership_type/);
  });
});

describe("25. no new migration", () => {
  it("no 0192+ migration file exists — this checkpoint is frontend-only, building on immutable 0188-0191", () => {
    const files = readdirSync(join(process.cwd(), "supabase/migrations"));
    const laterMigrations = files.filter((f) => {
      const match = f.match(/^(\d{4})_/);
      return match !== null && Number(match[1]) > 191;
    });
    expect(laterMigrations).toEqual([]);
  });
});

describe("26. no authorization change", () => {
  it("members/page.tsx and [id]/page.tsx still gate on isOperator, unchanged", () => {
    const listPage = readSource(MEMBERS_PAGE_PATH);
    const detailPage = readSource(DETAIL_PAGE_PATH);
    expect(listPage).toContain('if (!isOperator(profile?.role)) redirect("/calendar");');
    expect(detailPage).toContain('if (!profile || !isOperator(profile.role)) redirect("/calendar");');
  });

  it("no new role-check helper or bypass was introduced — Admin-vs-Staff is a pure display decision (userRole prop), never a substitute for the 0188 RPCs' own server-side admin-only enforcement", () => {
    // Checks actual usage (a function call) rather than bare-word
    // matching — MemberDetailClient.tsx's own pre-existing comments
    // legitimately mention "isOperator" in prose (describing the page-
    // level gate these client components don't duplicate); neither
    // client component actually imports or calls it.
    const clientFiles = [MEMBERS_CLIENT_PATH, DETAIL_CLIENT_PATH];
    for (const path of clientFiles) {
      const s = readSource(path);
      expect(s).not.toMatch(/isOperator\(|hasAdminAuthority\(/);
      expect(s).not.toMatch(/from ["']@\/lib\/auth\/roles["']/);
    }
  });

  it("the two shared Server Actions add no authorization of their own beyond the not_authenticated guard — the 0188 RPCs remain the sole admin-only enforcement", () => {
    const s = readSource(MEMBERS_ACTIONS_PATH);
    const statusBody = functionBody(s, "setRosterMemberMembershipStatusAction");
    const typeBody = functionBody(s, "setRosterMemberMembershipTypeAction");
    for (const body of [statusBody, typeBody]) {
      expect(body).toContain("if (!user) return { error: ERROR_MESSAGES.not_authenticated };");
      expect(body).not.toMatch(/profile\?\.\s*role|\.eq\("role"/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// UX polish pass — Member Detail Membership visual hierarchy + "inactive
// type" wording clarification. Section 1 (badges/pills) is scoped to
// Member Detail only, per the locked correction spec ("Improve ONLY the
// presentation of the Membership block", compared explicitly against the
// nearby Lesson Pro block, which exists only on this page). Section 2
// (wording) applies everywhere "(inactive)" used to appear — Member
// Detail's select AND the unclaimed-roster editor's select, both already
// covered by the updated assertions above; this block adds the NEW
// invariants this pass specifically introduced.
// ═══════════════════════════════════════════════════════════════════════════

function memberDetailSource(): string {
  return readSource(DETAIL_CLIENT_PATH);
}

describe("UX polish: Membership Status uses the intended semantic badge presentation", () => {
  it("defines a subtle (not aggressive) per-status color map: active->green, suspended->amber, inactive->gray, non_member->slate — all soft/bordered, none saturated fills", () => {
    const s = memberDetailSource();
    const start = s.indexOf("const MEMBERSHIP_STATUS_BADGE_CLASSES: Record<string, string> = {");
    expect(start).toBeGreaterThan(-1);
    const body = s.slice(start, s.indexOf("};", start));
    expect(body).toMatch(/active:\s*"text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-900\/20 border-green-200 dark:border-green-800"/);
    expect(body).toMatch(/suspended:\s*"text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900\/20 border-amber-200 dark:border-amber-800"/);
    expect(body).toMatch(/inactive:\s*"text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700"/);
    expect(body).toMatch(/non_member:\s*"text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-slate-800\/40 border-slate-200 dark:border-slate-700"/);
    // Soft/bordered (50-weight bg + border), never the more saturated
    // 100-weight fill used elsewhere for lifecycle status (bg-*-100) —
    // "do not use aggressive colors" is a deliberate visual DISTINCTION
    // from ProfileCard/statusBadge's bolder lifecycle pills.
    expect(body).not.toMatch(/bg-(green|amber|gray|slate)-100/);
  });

  it("the Status badge renders for BOTH roles, driven by the same MEMBERSHIP_STATUS_BADGE_CLASSES map, with a safe fallback for an unrecognized value", () => {
    const s = memberDetailSource();
    expect(s).toContain("MEMBERSHIP_STATUS_BADGE_CLASSES[membershipStatus] ?? MEMBERSHIP_STATUS_BADGE_CLASSES.inactive");
    expect(s).toContain('className={`inline-block px-2 py-0.5 rounded-full border text-[11px] font-semibold ${MEMBERSHIP_STATUS_BADGE_CLASSES[membershipStatus]');
  });

  it("an unset Status (null) shows a plain muted em-dash, never a fabricated badge", () => {
    // UX polish pass (round 2): this is now the 2nd/3rd arm of a
    // three-way ternary (admin-select ? : status-pill ? : empty-state),
    // not a standalone `{membershipStatus ? (...) : (...)}` expression.
    const s = memberDetailSource();
    expect(s).toMatch(/\) : membershipStatus \? \(\s*<span className=\{`inline-block[^`]*MEMBERSHIP_STATUS_BADGE_CLASSES[\s\S]{0,20}\}\`\}>\s*\{MEMBERSHIP_STATUS_LABELS\[membershipStatus\] \?\? membershipStatus\}\s*<\/span>\s*\) : \(\s*<span className="text-sm text-gray-400 dark:text-gray-500">—<\/span>/);
  });
});

describe("UX polish: Membership Type uses a non-semantic, neutral presentation", () => {
  it("MEMBERSHIP_TYPE_BADGE_CLASSES is a single constant (not a per-value map) — the same neutral treatment regardless of type name or state", () => {
    const s = memberDetailSource();
    expect(s).toContain("const MEMBERSHIP_TYPE_BADGE_CLASSES =");
    expect(s).toContain('"text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-600"');
  });

  it("the Type badge never uses a status color (no green/amber/slate) — only neutral gray/white/border tones", () => {
    const s = memberDetailSource();
    const start = s.indexOf("const MEMBERSHIP_TYPE_BADGE_CLASSES =");
    const end = s.indexOf(";", start);
    const body = s.slice(start, end);
    expect(body).not.toMatch(/green|amber|slate/);
  });

  it("an unset Type (None) shows a plain muted \"None\" label, never a fabricated pill", () => {
    // UX polish pass (round 2): same three-way ternary restructure as Status.
    const s = memberDetailSource();
    expect(s).toMatch(/\) : membershipTypeName \? \(\s*<span className=\{`inline-block[^`]*MEMBERSHIP_TYPE_BADGE_CLASSES\}`\}>[\s\S]{0,120}<\/span>\s*\) : \(\s*<span className="text-sm text-gray-400 dark:text-gray-500">None<\/span>/);
  });
});

describe("UX polish: active membership status + an inactive assigned Membership Type remains fully supported", () => {
  it("isCurrentTypeInactive is derived ONLY from the Admin-only active-types pool, and is false (never annotated) for Staff even though membershipTypes is empty for them", () => {
    const s = memberDetailSource();
    const start = s.indexOf("const isCurrentTypeInactive =");
    expect(start).toBeGreaterThan(-1);
    const line = s.slice(start, s.indexOf(";", start) + 1);
    expect(line).toContain("isMembershipAdmin && membershipTypeId !== null && !membershipTypes.some((t) => t.id === membershipTypeId)");
  });

  it("membershipStatus and isCurrentTypeInactive are fully independent — an active-status member can still show an inactive-type badge, and vice versa", () => {
    const s = memberDetailSource();
    // The Type badge's inactive annotation reads isCurrentTypeInactive,
    // never membershipStatus — the two axes are never conflated.
    const typeBadgeIdx = s.indexOf("isCurrentTypeInactive ? \" (inactive type)\" : \"\"");
    expect(typeBadgeIdx).toBeGreaterThan(-1);
    const nearbyText = s.slice(Math.max(0, typeBadgeIdx - 200), typeBadgeIdx);
    expect(nearbyText).not.toContain("membershipStatus ===");
  });
});

describe("UX polish: copy explicitly says \"inactive type\", never bare \"(inactive)\"", () => {
  it("Member Detail's Type badge and its <select> options both use the explicit phrase", () => {
    const s = memberDetailSource();
    expect(s).toContain('{membershipTypeName}{isCurrentTypeInactive ? " (inactive type)" : ""}');
    expect(s).toContain('{t.name}{t.inactive ? " (inactive type)" : ""}');
    expect(s).not.toMatch(/\(inactive\)(?! type)/);
  });

  it("the unclaimed-roster editor's <select> option uses the same explicit phrase", () => {
    const s = readSource(MEMBERS_CLIENT_PATH);
    expect(s).toContain('{t.name}{t.inactive ? " (inactive type)" : ""}');
    expect(s).not.toMatch(/\(inactive\)(?! type)/);
  });

  it("no file in this feature retains the old ambiguous \"(inactive)\" wording anywhere", () => {
    for (const path of [DETAIL_CLIENT_PATH, MEMBERS_CLIENT_PATH, "src/app/(app)/admin/settings/MembershipTypesSection.tsx"]) {
      const s = readSource(path);
      expect(s).not.toMatch(/["'`] \(inactive\)["'`]/);
    }
  });
});

describe("UX polish: inactive types remain unavailable for new assignment (unchanged behavior)", () => {
  it("membershipTypeOptions/typeOptions still source new assignability from the active-only pool plus, at most, the ONE currently-assigned type — the wording change touched no selection logic", () => {
    const detail = memberDetailSource();
    const list = readSource(MEMBERS_CLIENT_PATH);
    for (const s of [detail, list]) {
      expect(s).toMatch(/\.some\(\(t\) => t\.id === (membershipTypeId|rm\.membership_type_id)\)/);
    }
  });

  it("no new RPC or bulk-assignment action was introduced by this polish pass — still exactly the two existing single-target membership actions", () => {
    const s = readSource(MEMBERS_ACTIONS_PATH);
    const statusExports = (s.match(/export async function setRosterMemberMembershipStatusAction/g) ?? []).length;
    const typeExports = (s.match(/export async function setRosterMemberMembershipTypeAction/g) ?? []).length;
    expect(statusExports).toBe(1);
    expect(typeExports).toBe(1);
    // Neither membership action's own body mentions a bulk/plural target
    // (e.g. p_roster_member_ids) — each still takes exactly one id.
    const statusBody = functionBody(s, "setRosterMemberMembershipStatusAction");
    const typeBody = functionBody(s, "setRosterMemberMembershipTypeAction");
    expect(statusBody).not.toMatch(/bulk|Bulk|_ids\b/);
    expect(typeBody).not.toMatch(/bulk|Bulk|_ids\b/);
  });
});

describe("UX polish: Admin edit controls still function; Staff remains fully read-only", () => {
  it("Admin's <select> onChange handlers are unchanged — still call the two shared roster actions with the resolved rosterMemberId", () => {
    const s = memberDetailSource();
    expect(s).toContain("onChange={(e) => handleMembershipStatusChange(e.target.value as \"active\" | \"inactive\" | \"suspended\" | \"non_member\")}");
    expect(s).toContain("await setRosterMemberMembershipStatusAction(rosterMemberId, status);");
    expect(s).toContain("await setRosterMemberMembershipTypeAction(rosterMemberId, typeId || null);");
  });

  it("no modal was introduced — the working <select> controls are preserved, not replaced", () => {
    const s = memberDetailSource();
    expect(s).not.toMatch(/Modal|role="dialog"/);
  });

  it("Staff's absence of a <select> is the only difference from Admin — both roles see the identical badge markup", () => {
    const s = memberDetailSource();
    const statusBadgeSpan = '<span className={`inline-block px-2 py-0.5 rounded-full border text-[11px] font-semibold ${MEMBERSHIP_STATUS_BADGE_CLASSES[membershipStatus] ?? MEMBERSHIP_STATUS_BADGE_CLASSES.inactive}`}>';
    const typeBadgeSpan = '<span className={`inline-block px-2 py-0.5 rounded-full border text-[11px] font-semibold ${MEMBERSHIP_TYPE_BADGE_CLASSES}`}>';
    expect(s).toContain(statusBadgeSpan);
    expect(s).toContain(typeBadgeSpan);
    // Each badge <span> appears exactly once — it is not duplicated per
    // role (i.e. there is no separate Admin-only vs Staff-only copy).
    expect((s.match(new RegExp(statusBadgeSpan.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length).toBe(1);
    expect((s.match(new RegExp(typeBadgeSpan.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length).toBe(1);
  });
});

describe("UX polish: mobile/responsive layout is preserved", () => {
  it("each field renders exactly ONE element at a time (no pill+select side-by-side row to wrap) — the plain block-level container needs no flex-wrap any more", () => {
    // UX polish pass (round 2): removed the pill+select redundancy, so
    // there is no longer a two-item row that could need to wrap — each
    // field's container holds a single select OR a single pill OR a
    // single empty-state span, never two siblings competing for width.
    const s = memberDetailSource();
    const wrapperRows = (s.match(/className="mt-0\.5">/g) ?? []).length;
    expect(wrapperRows).toBe(2);
    // No forced-nowrap that could cause horizontal overflow on narrow
    // viewports for either field's container.
    const start = s.indexOf('<p className="text-xs font-medium text-gray-700 dark:text-gray-300">Membership</p>');
    const end = s.indexOf("</div>\n            )}\n          </div>", start);
    const block = s.slice(start, end);
    expect(block).not.toMatch(/whitespace-nowrap/);
  });

  it("[superseded by the Section 3 mobile-hierarchy pass — Admin selects now intentionally use the full available width on mobile] the Admin <select> is a full-width control on mobile, compact at sm+", () => {
    // Locked correction: "on mobile, Admin Membership selects may use the
    // available width rather than being tiny compact controls... desktop
    // may retain compact controls." The prior fixed style={{width:"auto"}}
    // (always compact, every breakpoint) is gone — replaced with
    // Tailwind's own responsive width utility so mobile and desktop can
    // differ, with no JS/inline-style involved.
    const s = memberDetailSource();
    const responsiveWidthOccurrences = (s.match(/className=\{`w-full sm:w-auto px-2\.5 py-1 rounded-full border/g) ?? []).length;
    expect(responsiveWidthOccurrences).toBe(2);
    expect(s).not.toMatch(/style=\{\{ width: "auto" \}\}/);
  });

  it("[superseded by the Section 3 grouping pass] the Membership block is its own clearly-separated group (border-t + pt-3), not merely mt-2 inside the identity column", () => {
    // Locked correction: "clearer vertical separation between Member
    // identity, Lesson Pro, and Membership." The block is no longer a
    // bare `mt-2` sibling nested inside the identity <div> — it's a
    // sibling GROUP of the whole header, with a border-t divider.
    const s = memberDetailSource();
    const blockStart = s.indexOf('<p className="text-xs font-medium text-gray-700 dark:text-gray-300">Membership</p>');
    expect(blockStart).toBeGreaterThan(-1);
    const groupOpenTag = s.slice(Math.max(0, blockStart - 200), blockStart);
    expect(groupOpenTag).toContain('<div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-800">');
    const blockEnd = s.indexOf("\n        )}\n\n        {/* Stats */}", blockStart);
    expect(blockEnd).toBeGreaterThan(blockStart);
    const block = s.slice(blockStart, blockEnd);
    expect(block).not.toMatch(/grid-cols|flex-row(?!-)/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// UX polish pass (round 2) — remove pill+select redundancy on Member
// Detail; disambiguate the lifecycle "Club status" badge from Membership
// Status; consolidate claimed-member card actions into View + Actions ▾.
// ═══════════════════════════════════════════════════════════════════════════

function membersClientSource(): string {
  return readSource(MEMBERS_CLIENT_PATH);
}

describe("1. Admin Member Detail no longer renders a duplicate pill + select for Status", () => {
  it("the admin branch renders ONLY a <select> — no sibling <span> badge alongside it", () => {
    const s = memberDetailSource();
    const startMatch = /\{isMembershipAdmin && rosterMemberId \? \(\s*<select\s*\n\s*value=\{membershipStatus/.exec(s);
    expect(startMatch).not.toBeNull();
    const adminBranchStart = startMatch!.index;
    const adminBranchEnd = s.indexOf(") : membershipStatus ? (", adminBranchStart);
    const adminBranch = s.slice(adminBranchStart, adminBranchEnd);
    expect(adminBranch).toContain("<select");
    expect(adminBranch).not.toContain("<span");
  });
});

describe("2. Admin Member Detail no longer renders a duplicate pill + select for Type", () => {
  it("the admin branch renders ONLY a <select> — no sibling <span> badge alongside it", () => {
    const s = memberDetailSource();
    const startMatch = /\{isMembershipAdmin && rosterMemberId \? \(\s*<select\s*\n\s*value=\{membershipTypeId/.exec(s);
    expect(startMatch).not.toBeNull();
    const adminBranchStart = startMatch!.index;
    const adminBranchEnd = s.indexOf(") : membershipTypeName ? (", adminBranchStart);
    const adminBranch = s.slice(adminBranchStart, adminBranchEnd);
    expect(adminBranch).toContain("<select");
    expect(adminBranch).not.toContain("<span");
  });
});

describe("3. Admin Status select retains semantic visual treatment", () => {
  it("the Status <select>'s own className is driven by MEMBERSHIP_STATUS_BADGE_CLASSES — the select itself carries the color, not a separate element", () => {
    const s = memberDetailSource();
    expect(s).toContain(
      "className={`w-full sm:w-auto px-2.5 py-1 rounded-full border text-[11px] font-semibold disabled:opacity-50 disabled:cursor-not-allowed ${MEMBERSHIP_STATUS_BADGE_CLASSES[membershipStatus ?? \"inactive\"] ?? MEMBERSHIP_STATUS_BADGE_CLASSES.inactive}`}"
    );
  });

  it("the semantic color map itself is unchanged: active green, suspended amber, inactive gray, non_member slate", () => {
    const s = memberDetailSource();
    const start = s.indexOf("const MEMBERSHIP_STATUS_BADGE_CLASSES: Record<string, string> = {");
    const body = s.slice(start, s.indexOf("};", start));
    expect(body).toContain("green");
    expect(body).toContain("amber");
    expect(body).toMatch(/inactive:\s*"text-gray/);
    expect(body).toContain("slate");
  });
});

describe("4. Admin Type select remains neutral", () => {
  it("the Type <select>'s className is driven by the single, non-semantic MEMBERSHIP_TYPE_BADGE_CLASSES constant — never a per-value color map", () => {
    const s = memberDetailSource();
    expect(s).toContain(
      "className={`w-full sm:w-auto px-2.5 py-1 rounded-full border text-[11px] font-semibold disabled:opacity-50 disabled:cursor-not-allowed ${MEMBERSHIP_TYPE_BADGE_CLASSES}`}"
    );
  });

  it("preserves the \"(inactive type)\" wording for a currently-assigned inactive type inside the select's own option text", () => {
    const s = memberDetailSource();
    expect(s).toContain('{t.name}{t.inactive ? " (inactive type)" : ""}');
  });
});

describe("5. Staff still gets semantic Status pill + neutral Type pill, no selects (re-confirmed after the redundancy removal)", () => {
  it("the non-admin ternary arms render exactly the pill markup, never a <select>", () => {
    const s = memberDetailSource();
    const statusPillStart = s.indexOf(") : membershipStatus ? (");
    const statusPillEnd = s.indexOf(") : (", statusPillStart);
    const statusPill = s.slice(statusPillStart, statusPillEnd);
    expect(statusPill).toContain("<span");
    expect(statusPill).not.toContain("<select");

    const typePillStart = s.indexOf(") : membershipTypeName ? (");
    const typePillEnd = s.indexOf(") : (", typePillStart);
    const typePill = s.slice(typePillStart, typePillEnd);
    expect(typePill).toContain("<span");
    expect(typePill).not.toContain("<select");
  });
});

describe("6. lifecycle status display is explicitly labeled \"Club status\"", () => {
  // Correction pass: the earlier "Club status: " prefix BAKED INTO the
  // pill (round 2) made the pill too wide on mobile. Replaced with a
  // separate small muted "Club status" label beside the existing compact
  // (unprefixed) semantic badge — matching the exact locked layout
  // "Club status  [ Active ]". statusBadge() itself reverted to its
  // original single-argument signature; the removed prefix param had
  // exactly one caller, so there is nothing left to keep it for.

  it("Member Detail pairs a muted \"Club status\" label with the existing (unprefixed) statusBadge() call", () => {
    // Not checking for the absence of the string "Club status: " globally
    // — this file's own explanatory comment legitimately names the OLD,
    // now-removed prefix in prose. The real invariant is the call site
    // itself: statusBadge(member.status) with no second argument.
    const s = memberDetailSource();
    expect(s).toContain('<span className="text-[11px] text-gray-400 dark:text-gray-500">Club status</span>');
    expect(s).toContain("{statusBadge(member.status)}");
    expect(s).not.toContain('{statusBadge(member.status, "Club status: ")}');
  });

  it("statusBadge() reverted to its original single-argument signature — no unused prefix param left behind", () => {
    const s = memberDetailSource();
    expect(s).toContain("function statusBadge(status: string) {");
    const callSites = [...s.matchAll(/\{statusBadge\(([^)]*)\)\}/g)].map((m) => m[1]);
    // 3 total call sites: member.status + 2 activity-item statuses
    // (item.status) — all unprefixed, all single-argument.
    expect(callSites.length).toBe(3);
    expect(callSites.filter((args) => args === "item.status").length).toBe(2);
    expect(callSites.filter((args) => args === "member.status").length).toBe(1);
  });

  it("the /admin/members claimed-card lifecycle badge uses the same muted-label + compact-badge split, colors unchanged", () => {
    const s = membersClientSource();
    expect(s).toContain('<span className="text-[10px] text-gray-400 dark:text-gray-500">Club status</span>');
    expect(s).toContain(">\n                Active\n              </span>");
    expect(s).toContain(">\n                Suspended\n              </span>");
    expect(s).toContain(">\n                Inactive\n              </span>");
    // Not checking for the global absence of "Club status: Active" — this
    // file's own explanatory comment legitimately names the OLD, now-
    // removed pattern in prose (contrasting it with the new one). The
    // real invariant is the JSX call sites above: label and badge are
    // two separate elements, never one string concatenated together.
    expect(s).not.toMatch(/>\s*Club status: (Active|Suspended|Inactive)\s*</);
    expect(s).toContain("bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400");
    expect(s).toContain("bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400");
    expect(s).toContain("bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400");
  });
});

describe("7. Membership Status remains independently labeled (distinct from Club status)", () => {
  it("the Membership block's own \"Membership Status\" field label is unchanged", () => {
    const s = memberDetailSource();
    expect(s).toContain('<p className="text-[11px] text-gray-400 dark:text-gray-500">Membership Status</p>');
  });

  it("\"Club status\" and \"Membership Status\" are two textually distinct labels, never merged into one", () => {
    const s = memberDetailSource();
    expect(s).toContain("Club status: ");
    expect(s).toContain("Membership Status</p>");
    expect(s).not.toMatch(/Club status: Membership/);
  });
});

describe("8. claimed-member card shows View + exactly one Actions control", () => {
  it("the action row renders a View link and a single 'Actions ▾' trigger button — no standalone Deactivate/Suspend/Remove buttons outside the menu", () => {
    // Correction pass: Role/View/Actions were consolidated into ONE
    // compact row ("[ Role ▼ ] [ View ] [ Actions ▾ ]") — the prior
    // dedicated "justify-end" wrapper around just View+Actions is gone;
    // View and Actions are now flex siblings of the role <select> itself.
    const s = membersClientSource();
    const rowStart = s.indexOf('<div className="flex items-center flex-wrap gap-1.5">');
    expect(rowStart).toBeGreaterThan(-1);
    const rowEnd = s.indexOf("// ── Roster card", rowStart);
    const row = s.slice(rowStart, rowEnd);
    expect(row).toContain(">\n            View\n          </Link>");
    // The actual rendered button text (not just any mention of the phrase
    // — this file's own explanatory comments legitimately say "Actions ▾"
    // in prose too).
    expect(row).toContain(">\n            Actions ▾\n          </button>");
    const renderedButtonOccurrences = (row.match(/>\s*Actions ▾\s*<\/button>/g) ?? []).length;
    expect(renderedButtonOccurrences).toBe(1);
  });

  it("the trigger button uses correct ARIA menu semantics and is keyboard/screen-reader identifiable", () => {
    const s = membersClientSource();
    expect(s).toContain('aria-haspopup="menu"');
    expect(s).toContain("aria-expanded={menuOpen}");
    expect(s).toContain("aria-label={`Actions for ${fullName}`}");
    expect(s).toContain('role="menu"');
    expect(s).toContain('role="menuitem"');
  });
});

describe("9. Deactivate/Suspend/Remove remain wired to their existing handlers", () => {
  it("each menu item still calls onStatusAction(m, ...) with the exact same action strings as before", () => {
    const s = membersClientSource();
    expect(s).toContain('selectMenuAction(() => onStatusAction(m, isActive ? "deactivate" : "reactivate"))');
    expect(s).toContain('selectMenuAction(() => onStatusAction(m, "suspend"))');
    expect(s).toContain('selectMenuAction(() => onStatusAction(m, "remove"))');
  });

  it("Suspend is still offered only when isActive (unchanged inactive->suspended->inactive guard)", () => {
    const s = membersClientSource();
    const suspendIdx = s.indexOf('selectMenuAction(() => onStatusAction(m, "suspend"))');
    const precedingGate = s.slice(Math.max(0, suspendIdx - 300), suspendIdx);
    expect(precedingGate).toContain("{isActive && (");
  });

  it("selecting a menu item closes the menu via the same onCloseMenu the backdrop/Escape use, then invokes the action — mutation call shape is unchanged", () => {
    const s = membersClientSource();
    const start = s.indexOf("function selectMenuAction(action: () => void) {");
    const body = s.slice(start, s.indexOf("}", start) + 1);
    expect(body).toContain("onCloseMenu();");
    expect(body).toContain("action();");
  });
});

describe("10. Remove remains visually destructive", () => {
  it("the Remove menu item keeps red text coloring, matching its prior destructive-styled button", () => {
    const s = membersClientSource();
    const removeIdx = s.indexOf('selectMenuAction(() => onStatusAction(m, "remove"))');
    const buttonStart = s.lastIndexOf("<button", removeIdx);
    const buttonEnd = s.indexOf("</button>", removeIdx);
    const button = s.slice(buttonStart, buttonEnd);
    expect(button).toContain("text-red-600 dark:text-red-400");
  });

  it("Suspend keeps amber/warning coloring, Deactivate keeps red, Reactivate keeps neutral — no lifecycle concepts were combined", () => {
    const s = membersClientSource();
    expect(s).toContain("text-amber-700 dark:text-amber-400"); // Suspend
    expect(s).toMatch(/isActive\s*\n\s*\? "text-red-600 dark:text-red-400"\s*\n\s*: "text-gray-700 dark:text-gray-200"/); // Deactivate (red) / Reactivate (neutral)
  });
});

describe("11. unclaimed roster-card workflow remains unchanged", () => {
  it("RosterCard's own props/actions are untouched by this pass — Edit/Remove/Send Invite and the Membership editor are unaffected", () => {
    const s = membersClientSource();
    const rosterCardStart = s.indexOf("function RosterCard(");
    const rosterCardEnd = s.indexOf("\n// ", rosterCardStart + 10);
    const rosterCardBody = s.slice(rosterCardStart, rosterCardEnd > -1 ? rosterCardEnd : undefined);
    // No "Actions ▾" menu, no "Club status" prefix, no menuOpen/onToggleMenu
    // — none of this pass's claimed-card-only changes leaked into RosterCard.
    expect(rosterCardBody).not.toContain("Actions ▾");
    expect(rosterCardBody).not.toContain("Club status");
    expect(rosterCardBody).not.toContain("menuOpen");
    expect(rosterCardBody).not.toContain("onToggleMenu");
    // Its own existing actions remain present and unchanged.
    expect(rosterCardBody).toContain("onClick={() => onEdit(rm)}");
    expect(rosterCardBody).toContain("onClick={() => onDelete(rm)}");
    expect(rosterCardBody).toContain("onClick={() => onInvite(rm)}");
  });
});

describe("12. mobile layout does not overflow", () => {
  // Correction pass superseded the round-2 absolute/relative positioning
  // entirely — see the dedicated ACTION MENU describe block below for
  // full coverage of the portal fix. These three checks now prove the
  // NEW no-overflow properties this pass specifically introduced.

  it("the claimed-card row (Role + View + Actions) allows wrapping and has no fixed max-width that could force horizontal overflow", () => {
    const s = membersClientSource();
    expect(s).not.toContain('className="flex flex-wrap items-center justify-end gap-1.5 shrink-0 max-w-[9rem]"');
    expect(s).not.toMatch(/max-w-\[9rem\]/);
    expect(s).toContain('<div className="flex items-center flex-wrap gap-1.5">');
  });

  it("the role <select> has a min-width floor but flexes rather than forcing a fixed width that could overflow a narrow card", () => {
    const s = membersClientSource();
    expect(s).toContain("flex-1 min-w-[6rem] md:flex-initial md:w-auto");
  });

  it("Member Detail's Admin selects use responsive width (full on mobile, auto at sm+) via Tailwind classes, not a fixed inline style that could overflow narrow viewports", () => {
    const s = memberDetailSource();
    const responsiveWidthOccurrences = (s.match(/w-full sm:w-auto/g) ?? []).length;
    expect(responsiveWidthOccurrences).toBe(2);
  });
});

describe("13. no DB/RPC/business-logic change in this polish pass", () => {
  it("no migration file beyond 0191 exists", () => {
    const files = readdirSync(join(process.cwd(), "supabase/migrations"));
    const laterMigrations = files.filter((f) => {
      const match = f.match(/^(\d{4})_/);
      return match !== null && Number(match[1]) > 191;
    });
    expect(laterMigrations).toEqual([]);
  });

  it("MemberDetailClient.tsx and MembersClient.tsx still call only the same RPCs as before this pass — no new .rpc( surface introduced by presentation changes", () => {
    // Both mutation actions this page/list already used remain the only
    // ones referenced; no bulk-assignment action, no new RPC name.
    const detail = memberDetailSource();
    const list = membersClientSource();
    expect(detail).not.toMatch(/\.rpc\(/); // client components never call .rpc() directly — actions.ts does
    expect(list).not.toMatch(/\.rpc\(/);
  });

  it("setRosterMemberMembershipStatusAction/setRosterMemberMembershipTypeAction in admin/members/actions.ts are byte-unchanged in RPC wiring", () => {
    const s = readSource(MEMBERS_ACTIONS_PATH);
    const statusBody = functionBody(s, "setRosterMemberMembershipStatusAction");
    const typeBody = functionBody(s, "setRosterMemberMembershipTypeAction");
    expect(statusBody).toContain('supabase.rpc("set_roster_member_membership_status", {');
    expect(typeBody).toContain('supabase.rpc("set_roster_member_membership_type", {');
  });

  it("member lifecycle RPCs (set_member_status/remove_club_member/restore_club_member) are unchanged and still the only ones the Actions menu reaches", () => {
    const s = readSource(MEMBERS_ACTIONS_PATH);
    expect(s).toContain('supabase.rpc("set_member_status", {');
    expect(s).toContain('supabase.rpc("remove_club_member", {');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CORRECTION PASS — fix the Actions menu clipping bug (portal + viewport-
// aware fixed positioning) and polish mobile visual hierarchy on both
// /admin/members and Member Detail.
// ═══════════════════════════════════════════════════════════════════════════

describe("ACTION MENU 1. opening the menu cannot affect card normal-flow height/layout", () => {
  it("the menu's JSX is inside a createPortal(...) call — it is not a normal-flow DOM child of the card at all once rendered", () => {
    const s = membersClientSource();
    const menuOpenIdx = s.indexOf("{menuOpen && createPortal(");
    expect(menuOpenIdx).toBeGreaterThan(-1);
  });

  it("the trigger button itself is a plain, non-relative sibling of View — no wrapping element was added around it that could change the row's box size when the menu opens", () => {
    const s = membersClientSource();
    // The prior round's `<div className="relative">` wrapper around the
    // trigger is gone — position is computed in JS via
    // getBoundingClientRect(), not CSS relative-to-ancestor, so no
    // wrapper is needed and none remains.
    const rowStart = s.indexOf('<div className="flex items-center flex-wrap gap-1.5">');
    const rowEnd = s.indexOf("{menuOpen && createPortal(", rowStart);
    const row = s.slice(rowStart, rowEnd);
    expect(row).not.toContain('<div className="relative">');
  });

  it("the portal target is document.body — entirely outside the card's own DOM subtree, so the card's box model (height, padding, position of later siblings) cannot be affected by the menu's content", () => {
    const s = membersClientSource();
    expect(s).toContain("document.body\n          )}");
  });
});

describe("ACTION MENU 2. menu is rendered in a floating/portal layer", () => {
  it("imports createPortal from react-dom", () => {
    const s = membersClientSource();
    expect(s).toContain('import { createPortal } from "react-dom";');
  });

  it("the menu uses position: fixed (viewport-relative), not position: absolute (ancestor-relative) — fixed is what a portal needs to place content anywhere on screen independent of DOM position", () => {
    const s = membersClientSource();
    const styleBlockIdx = s.indexOf("style={{\n                  position: \"fixed\",");
    expect(styleBlockIdx).toBeGreaterThan(-1);
    expect(s).not.toMatch(/className="ct-popover-enter absolute/);
  });

  it("root cause documented: the card's overflow-hidden clipped the OLD position:absolute menu because absolute is clipped by its containing block; a portaled position:fixed element is immune to that regardless of the card's own styling, now or in the future", () => {
    const s = membersClientSource();
    expect(s).toMatch(/the prior clipping bug/);
    expect(s).toMatch(/overflow-hidden/);
  });
});

describe("ACTION MENU 3. full lifecycle menu remains present", () => {
  it("Deactivate/Reactivate, conditional Suspend, and Remove are all still rendered inside the portaled menu", () => {
    const s = membersClientSource();
    const portalStart = s.indexOf("{menuOpen && createPortal(");
    const portalEnd = s.indexOf("document.body\n          )}", portalStart);
    const portalContent = s.slice(portalStart, portalEnd);
    expect(portalContent).toContain('{isActive ? "Deactivate" : "Reactivate"}');
    expect(portalContent).toContain("{isActive && (");
    expect(portalContent).toContain(">\n                    Suspend\n                  </button>");
    expect(portalContent).toContain(">\n                  Remove\n                </button>");
  });
});

describe("ACTION MENU 4. viewport-aware positioning exists", () => {
  it("computes position from the trigger's getBoundingClientRect(), clamped to stay inside the viewport horizontally", () => {
    const s = membersClientSource();
    expect(s).toContain("trigger!.getBoundingClientRect()");
    expect(s).toContain("Math.max(\n        ACTIONS_MENU_VIEWPORT_MARGIN,\n        Math.min(left, viewportWidth - ACTIONS_MENU_WIDTH - ACTIONS_MENU_VIEWPORT_MARGIN)\n      )");
  });

  it("flips above the trigger when there isn't room below, and stays clamped to the top viewport edge when flipped", () => {
    const s = membersClientSource();
    expect(s).toContain("const fitsBelow = rect.bottom + ACTIONS_MENU_GAP + estimatedHeight <= viewportHeight - ACTIONS_MENU_VIEWPORT_MARGIN;");
    expect(s).toContain("? rect.bottom + ACTIONS_MENU_GAP");
    expect(s).toContain("Math.max(ACTIONS_MENU_VIEWPORT_MARGIN, rect.top - ACTIONS_MENU_GAP - estimatedHeight)");
  });

  it("recomputes once more via requestAnimationFrame after the menu has actually mounted, so a real measured height (not just the estimate) determines final placement for menus of different item counts", () => {
    const s = membersClientSource();
    expect(s).toContain("const raf = requestAnimationFrame(computePosition);");
    expect(s).toContain("menuRef.current?.offsetHeight");
  });

  it("this positioning logic is JS-driven (useLayoutEffect), not CSS — it runs identically on desktop and mobile, satisfying \"works on desktop and mobile\" without separate breakpoint-specific code paths", () => {
    const s = membersClientSource();
    expect(s).toContain("useLayoutEffect(() => {");
  });
});

describe("ACTION MENU 5. click-away / Escape / focus behavior preserved", () => {
  it("a fixed full-screen backdrop still closes the menu on click", () => {
    const s = membersClientSource();
    expect(s).toContain('<div className="fixed inset-0 z-40" onClick={onCloseMenu} />');
  });

  it("Escape still closes the menu and returns focus to the trigger", () => {
    const s = membersClientSource();
    expect(s).toContain("function closeMenuAndRefocus() {");
    expect(s).toContain("onCloseMenu();\n    menuTriggerRef.current?.focus();");
    expect(s).toMatch(/onKeyDown=\{\(e\) => \{\s*if \(e\.key === "Escape"\) \{\s*e\.preventDefault\(\);\s*closeMenuAndRefocus\(\);/);
  });

  it("the first menu item still autofocuses on open", () => {
    const s = membersClientSource();
    expect(s).toContain("if (menuOpen) firstMenuItemRef.current?.focus();");
  });

  it("scrolling now also closes the menu (new — prevents a fixed-position portal menu from visually detaching from its trigger as the page/card list scrolls)", () => {
    const s = membersClientSource();
    expect(s).toContain('window.addEventListener("scroll", handleScroll, true);');
  });
});

describe("ACTION MENU 6. existing handlers unchanged", () => {
  it("selecting an action still closes the menu via selectMenuAction before invoking the identical onStatusAction(m, ...) call", () => {
    const s = membersClientSource();
    expect(s).toContain('selectMenuAction(() => onStatusAction(m, isActive ? "deactivate" : "reactivate"))');
    expect(s).toContain('selectMenuAction(() => onStatusAction(m, "suspend"))');
    expect(s).toContain('selectMenuAction(() => onStatusAction(m, "remove"))');
    const start = s.indexOf("function selectMenuAction(action: () => void) {");
    const body = s.slice(start, s.indexOf("}", start) + 1);
    expect(body).toContain("onCloseMenu();");
    expect(body).toContain("action();");
  });

  it("role=\"menu\"/\"menuitem\" semantics are preserved on the portaled elements", () => {
    const s = membersClientSource();
    expect(s).toContain('role="menu"');
    const menuitemOccurrences = (s.match(/role="menuitem"/g) ?? []).length;
    expect(menuitemOccurrences).toBe(3); // Deactivate/Reactivate, Suspend, Remove
  });

  it("colors are unchanged: Deactivate/red, Reactivate/neutral, Suspend/amber, Remove/red", () => {
    const s = membersClientSource();
    expect(s).toMatch(/isActive\s*\n\s*\? "text-red-600 dark:text-red-400"\s*\n\s*: "text-gray-700 dark:text-gray-200"/);
    expect(s).toContain("text-amber-700 dark:text-amber-400");
    const removeIdx = s.indexOf('selectMenuAction(() => onStatusAction(m, "remove"))');
    const buttonEnd = s.indexOf("</button>", removeIdx);
    expect(s.slice(removeIdx, buttonEnd)).toContain("text-red-600 dark:text-red-400");
  });
});

describe("MOBILE CARDS 7. member name has stronger mobile hierarchy than metadata", () => {
  it("the member name is text-base (mobile) / text-sm (sm+) and font-semibold — larger on mobile than the prior fixed text-sm", () => {
    const s = membersClientSource();
    expect(s).toContain('className="text-base md:text-sm font-semibold text-gray-900 dark:text-gray-100 truncate hover:text-accent motion-safe:transition-colors"');
  });

  it("email/phone/joined metadata remain the existing small muted treatment (text-xs, gray-400/500) — unchanged, still visually subordinate to the name", () => {
    const s = membersClientSource();
    expect(s).toContain('<p className="text-xs text-gray-500 dark:text-gray-400 mt-1">\n          {m.email ?? "—"}');
    expect(s).toContain('<p className="text-xs text-gray-400 mt-0.5">\n          {m.phone ?? "—"}');
  });

  it("the Membership summary line remains its existing small/muted treatment", () => {
    const s = membersClientSource();
    expect(s).toContain('<p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">\n            {membershipLine(m.membership_status, m.membership_type_name)}');
  });

  it("the role <select> keeps its existing iOS-safe mobile font size (text-base) — never shrunk below that merely to look smaller; its RELATIVE prominence is reduced by the name growing instead", () => {
    const s = membersClientSource();
    expect(s).toContain("text-base md:text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed flex-1 min-w-[6rem]");
  });
});

describe("MOBILE CARDS 8. Club status label is outside the semantic badge", () => {
  it("\"Club status\" is its own <span>, never concatenated into the colored badge's own text content", () => {
    const s = membersClientSource();
    const labelIdx = s.indexOf('<span className="text-[10px] text-gray-400 dark:text-gray-500">Club status</span>');
    expect(labelIdx).toBeGreaterThan(-1);
    // The very next rendered element is the ternary producing the
    // colored badge — label and badge are siblings, not one element.
    const afterLabel = s.slice(labelIdx, labelIdx + 200);
    expect(afterLabel).toContain("{isActive ? (");
  });

  it("the badge itself carries ONLY the value word — no residual \"Club status:\" text inside any of the three colored <span> variants", () => {
    const s = membersClientSource();
    expect(s).not.toMatch(/<span className="inline-block px-2 py-0\.5 rounded text-xs font-medium bg-(green|amber|gray)-100[^>]*>\s*Club status/);
  });
});

describe("MOBILE CARDS 9. role/View/Actions layout remains responsive", () => {
  it("Role, View, and Actions are flex siblings in one row that allows wrapping (flex-wrap), never a fixed 3-column grid", () => {
    const s = membersClientSource();
    const rowStart = s.indexOf('<div className="flex items-center flex-wrap gap-1.5">');
    const rowEnd = s.indexOf("{menuOpen && createPortal(", rowStart);
    const row = s.slice(rowStart, rowEnd);
    expect(row).toContain("<select");
    expect(row).toContain("<Link");
    expect(row).toContain("<button");
    expect(row).not.toMatch(/grid-cols/);
  });

  it("View and Actions keep their compact natural size (no flex-1) while the role select is the one flexible element — matches \"[ Role ▼ ] [ View ] [ Actions ▾ ]\" with Role absorbing the extra space", () => {
    const s = membersClientSource();
    expect(s).toContain("flex-1 min-w-[6rem] md:flex-initial md:w-auto");
  });
});

describe("MOBILE CARDS 10. no horizontal overflow", () => {
  it("the row wrapper itself has no fixed max-width/nowrap that could force overflow", () => {
    const s = membersClientSource();
    const rowStart = s.indexOf('<div className="flex items-center flex-wrap gap-1.5">');
    expect(rowStart).toBeGreaterThan(-1);
    expect(s).not.toMatch(/max-w-\[9rem\]/);
  });

  it("the portaled menu is width-constrained (ACTIONS_MENU_WIDTH) and horizontally clamped to the viewport — it can never itself cause page-level horizontal overflow even though it's fixed-positioned", () => {
    const s = membersClientSource();
    expect(s).toContain("const ACTIONS_MENU_WIDTH = 160;");
    expect(s).toContain("width: ACTIONS_MENU_WIDTH,");
  });
});

describe("MEMBER DETAIL 11. Club status uses label + compact badge", () => {
  it("Member Detail's Identity group pairs the same muted \"Club status\" label with the unprefixed statusBadge() badge", () => {
    const s = memberDetailSource();
    expect(s).toContain('<div className="mt-1.5 flex items-center gap-1.5">\n            <span className="text-[11px] text-gray-400 dark:text-gray-500">Club status</span>\n            {statusBadge(member.status)}\n          </div>');
  });
});

describe("MEMBER DETAIL 12. identity/Lesson Pro/Membership groups have explicit spacing hierarchy", () => {
  it("Lesson Pro and Membership are each introduced by their own mt-3 pt-3 border-t group divider — clearer separation than the prior flat mt-2 stack", () => {
    const s = memberDetailSource();
    const dividerOccurrences = (s.match(/className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-800"/g) ?? []).length;
    expect(dividerOccurrences).toBe(2); // Lesson Pro group + Membership group
  });

  it("the group order is Identity, then Lesson Pro, then Membership, then Stats — matching the locked hierarchy exactly", () => {
    const s = memberDetailSource();
    const identityIdx = s.indexOf("{/* ── Identity group ── */}");
    const lessonProIdx = s.indexOf("{/* ── Lesson Pro group");
    const membershipIdx = s.indexOf("{/* ── Membership group");
    const statsIdx = s.indexOf("{/* Stats */}");
    expect(identityIdx).toBeGreaterThan(-1);
    expect(lessonProIdx).toBeGreaterThan(identityIdx);
    expect(membershipIdx).toBeGreaterThan(lessonProIdx);
    expect(statsIdx).toBeGreaterThan(membershipIdx);
  });

  it("Lesson Pro's own heading is now the single group title — the redundant inline \"Lesson Pro\" label that used to sit next to the Enabled/Not enabled pill is gone", () => {
    const s = memberDetailSource();
    expect(s).toContain('<p className="text-xs font-medium text-gray-700 dark:text-gray-300">Lesson Pro</p>');
    // The old duplicate label inside the toggle row itself is removed —
    // exactly one "Lesson Pro" text node in the whole group now.
    const groupStart = s.indexOf("{/* ── Lesson Pro group");
    const groupEnd = s.indexOf("{/* ── Membership group", groupStart);
    const group = s.slice(groupStart, groupEnd);
    const lessonProTextOccurrences = (group.match(/>Lesson Pro</g) ?? []).length;
    expect(lessonProTextOccurrences).toBe(1);
  });
});

describe("MEMBER DETAIL 13. Admin controls remain editable", () => {
  it("Admin's Status and Type <select> elements still call the same handlers on change", () => {
    const s = memberDetailSource();
    expect(s).toContain('onChange={(e) => handleMembershipStatusChange(e.target.value as "active" | "inactive" | "suspended" | "non_member")}');
    expect(s).toContain("handleMembershipTypeChange(e.target.value, opt?.name ?? null);");
  });
});

describe("MEMBER DETAIL 14. Staff remains read-only", () => {
  it("the non-admin ternary arms still render a <span> pill, never a <select>, for both fields", () => {
    const s = memberDetailSource();
    const statusPillStart = s.indexOf(") : membershipStatus ? (");
    const statusPillEnd = s.indexOf(") : (", statusPillStart);
    expect(s.slice(statusPillStart, statusPillEnd)).not.toContain("<select");

    const typePillStart = s.indexOf(") : membershipTypeName ? (");
    const typePillEnd = s.indexOf(") : (", typePillStart);
    expect(s.slice(typePillStart, typePillEnd)).not.toContain("<select");
  });
});

describe("MEMBER DETAIL 15. Membership Type remains neutral", () => {
  it("MEMBERSHIP_TYPE_BADGE_CLASSES is still the single non-semantic constant driving both the select and the pill", () => {
    const s = memberDetailSource();
    expect(s).toContain("const MEMBERSHIP_TYPE_BADGE_CLASSES =");
    expect(s).toContain("${MEMBERSHIP_TYPE_BADGE_CLASSES}");
  });
});

describe("MEMBER DETAIL 16. no Book Lesson change", () => {
  it("AdminRequestLessonSheet wiring (Book Lesson) is byte-unchanged by this pass", () => {
    const s = memberDetailSource();
    expect(s).toContain('import AdminRequestLessonSheet from "@/app/(app)/admin/lessons/AdminRequestLessonSheet";');
    expect(s).toContain("{requestSheetOpen && rosterMemberId && (");
    expect(s).toContain("<AdminRequestLessonSheet");
    expect(s).toContain('viewerRole="admin"');
  });
});

describe("MEMBER DETAIL 17. no business/data/RPC changes", () => {
  it("no migration beyond 0191 exists", () => {
    const files = readdirSync(join(process.cwd(), "supabase/migrations"));
    const laterMigrations = files.filter((f) => {
      const match = f.match(/^(\d{4})_/);
      return match !== null && Number(match[1]) > 191;
    });
    expect(laterMigrations).toEqual([]);
  });

  it("the two shared roster membership actions are byte-unchanged in RPC wiring by this presentation-only pass", () => {
    const s = readSource(MEMBERS_ACTIONS_PATH);
    const statusBody = functionBody(s, "setRosterMemberMembershipStatusAction");
    const typeBody = functionBody(s, "setRosterMemberMembershipTypeAction");
    expect(statusBody).toContain('supabase.rpc("set_roster_member_membership_status", {');
    expect(typeBody).toContain('supabase.rpc("set_roster_member_membership_type", {');
  });

  it("neither client component calls .rpc( directly — presentation changes only, server access unchanged", () => {
    expect(memberDetailSource()).not.toMatch(/\.rpc\(/);
    expect(membersClientSource()).not.toMatch(/\.rpc\(/);
  });
});
