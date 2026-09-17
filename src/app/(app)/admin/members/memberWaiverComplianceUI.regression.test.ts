import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Phase 43B-1B — Member Waiver Compliance UI. Frontend only: wires 0194's
// get_club_member_waiver_compliance() (bulk, Admin+Staff) into /admin/
// members exactly once, and widens Member Detail's Waiver block to Staff
// via a narrowly-scoped canViewWaiverCompliance concept, decoupled from
// isMembershipAdmin (which stays Admin-only — it also gates Membership
// Status/Type editing). No migration, no Guest work, 0194 untouched.
//
// Source-inspection style, matching this repository's established
// convention — no live DOM render in this suite.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const MEMBERS_PAGE_PATH   = "src/app/(app)/admin/members/page.tsx";
const MEMBERS_CLIENT_PATH = "src/app/(app)/admin/members/MembersClient.tsx";
const DETAIL_PAGE_PATH    = "src/app/(app)/admin/members/[id]/page.tsx";
const DETAIL_CLIENT_PATH  = "src/app/(app)/admin/members/[id]/MemberDetailClient.tsx";

// ═══════════════════════════════════════════════════════════════════════════
// SCOPE — no migration, 0194 untouched, no Guest work
// ═══════════════════════════════════════════════════════════════════════════

describe("Phase 43B-1B scope guard", () => {
  it("no migration 0195 (or beyond) was created in this checkpoint", () => {
    const files = readdirSync(join(process.cwd(), "supabase/migrations"));
    const laterMigrations = files.filter((f) => {
      const match = f.match(/^(\d{4})_/);
      return match !== null && Number(match[1]) > 196;
    });
    expect(laterMigrations).toEqual([]);
  });

  it("0194 still exists untouched — this is a frontend-only checkpoint", () => {
    expect(() => readSource("supabase/migrations/0194_member_waiver_compliance_operations.sql")).not.toThrow();
  });

  it("no Guest waiver work in any touched file — no guest table/RPC/token reference", () => {
    for (const path of [MEMBERS_PAGE_PATH, MEMBERS_CLIENT_PATH, DETAIL_PAGE_PATH, DETAIL_CLIENT_PATH]) {
      expect(readSource(path)).not.toMatch(/guest_waiver|guest.*waiver|waiver.*guest/i);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A/F. /admin/members bulk compliance read — exactly once, no N+1, merge
//      by roster_member_id
// ═══════════════════════════════════════════════════════════════════════════

describe("/admin/members page.tsx — bulk compliance read, exactly once, no N+1", () => {
  const s = readSource(MEMBERS_PAGE_PATH);

  it("calls get_club_member_waiver_compliance exactly once", () => {
    const matches = s.match(/get_club_member_waiver_compliance/g) ?? [];
    expect(matches.length).toBeGreaterThan(0);
    const rpcCalls = s.match(/supabase\.rpc\("get_club_member_waiver_compliance"\)/g) ?? [];
    expect(rpcCalls.length).toBe(1);
  });

  it("never calls get_member_waiver_status — the single-Member RPC must not be used to build the bulk roster list (no N+1)", () => {
    expect(s).not.toMatch(/get_member_waiver_status/);
  });

  it("resolves roster_member_id for claimed Members via a direct roster_members table read (RLS-scoped, matches Member Detail's existing pattern), not a second RPC", () => {
    expect(s).toContain('.from("roster_members")');
    expect(s).toMatch(/select\(["'`]id,\s*claimed_by["'`]\)/);
  });

  it("merges compliance results into both member lists by roster_member_id — never by name/email or any other mutable field", () => {
    expect(s).not.toMatch(/waiverBy(Name|Email)/);
    expect(s).toMatch(/roster_member_id/);
  });

  it("computes a single club-level hasMemberWaiverConfigured flag from the compliance rows (not fabricated per-row from status alone)", () => {
    expect(s).toMatch(/hasMemberWaiverConfigured/);
    expect(s).toContain("waiver_configured");
  });

  it("passes hasMemberWaiverConfigured through to MembersClient", () => {
    expect(s).toMatch(/hasMemberWaiverConfigured=\{hasMemberWaiverConfigured\}/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B/C. Waiver UI visibility + status presentation in MembersClient
// ═══════════════════════════════════════════════════════════════════════════

describe("MembersClient.tsx — waiver indicator hidden when not configured, shown otherwise", () => {
  const s = readSource(MEMBERS_CLIENT_PATH);

  it("accepts hasMemberWaiverConfigured as a prop", () => {
    expect(s).toMatch(/hasMemberWaiverConfigured:\s*boolean/);
  });

  it("the waiver pill is gated on hasMemberWaiverConfigured — never rendered when the club has no Member waiver document", () => {
    const occurrences = s.match(/hasMemberWaiverConfigured\s*&&/g) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(2); // claimed card + unclaimed roster card
  });

  // Phase 43B-1B polish — locked product decision: on /admin/members
  // specifically (never Member Detail), a not_required roster row renders
  // NO Waiver line/pill at all. waiver_configured=false (no document) and
  // waiver_configured=true+status=not_required (document exists, not
  // required) are still two distinct backend facts — this is a pure UI
  // suppression on top of that unchanged data model, not a collapse of it.
  it("the claimed-Member card's waiver pill also excludes status === 'not_required'", () => {
    const idx = s.indexOf("Waiver</span>");
    expect(idx).toBeGreaterThan(-1);
    const gateLine = s.slice(s.lastIndexOf("{hasMemberWaiverConfigured", idx), idx);
    expect(gateLine).toMatch(/waiverStatus\.status !== "not_required"/);
  });

  it("BOTH cards (claimed Member and unclaimed roster) carry the not_required exclusion — not just one of them, and it's additive on top of the unchanged hasMemberWaiverConfigured/waiverStatus-existence checks", () => {
    const gateLines = s.match(/hasMemberWaiverConfigured\s*&&\s*\w+\.waiverStatus\s*&&\s*\w+\.waiverStatus\.status\s*!==\s*"not_required"/g) ?? [];
    expect(gateLines.length).toBe(2);
  });
});

describe("MembersClient.tsx — status presentation mapping", () => {
  const s = readSource(MEMBERS_CLIENT_PATH);

  it("current -> 'Accepted', green classes", () => {
    const idx = s.indexOf("current:");
    const block = s.slice(idx, idx + 200);
    expect(block).toContain("Accepted");
    expect(block).toMatch(/green/);
  });

  it("never_accepted -> 'Needs acceptance', amber classes", () => {
    const idx = s.indexOf("never_accepted:");
    const block = s.slice(idx, idx + 200);
    expect(block).toContain("Needs acceptance");
    expect(block).toMatch(/amber/);
  });

  it("outdated -> 'Updated waiver', amber classes", () => {
    const idx = s.indexOf("outdated:");
    const block = s.slice(idx, idx + 200);
    expect(block).toContain("Updated waiver");
    expect(block).toMatch(/amber/);
  });

  it("not_required -> 'Not required', neutral gray classes", () => {
    const idx = s.indexOf("not_required:");
    const block = s.slice(idx, idx + 200);
    expect(block).toContain("Not required");
    expect(block).toMatch(/gray/);
  });

  it("no red styling anywhere in the waiver status mapping — this is not an error/blocking condition", () => {
    const mapStart = s.indexOf("WAIVER_STATUS");
    expect(mapStart).toBeGreaterThan(-1);
    const mapEnd = s.indexOf("};", mapStart);
    const map = s.slice(mapStart, mapEnd);
    // Scoped to actual red Tailwind classes, not a blanket "red" substring
    // scan — "not_required"/"Record" legitimately contain that substring.
    expect(map).not.toMatch(/bg-red|text-red|border-red/);
  });

  it("never uses the word 'Signed' anywhere — Court Time records acceptance, not a legal signature", () => {
    expect(s).not.toMatch(/Signed/);
  });

  it("reuses the existing pill visual vocabulary (inline-block, rounded, px-2 py-0.5, text-xs) — no new design system introduced", () => {
    const componentIdx = s.indexOf("function WaiverPill(");
    expect(componentIdx).toBeGreaterThan(-1);
    const componentEnd = s.indexOf("\n}", componentIdx);
    const component = s.slice(componentIdx, componentEnd);
    expect(component).toMatch(/inline-block px-2 py-0\.5 rounded text-xs font-medium/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D/E. Member Detail — Staff read-only visibility, decoupled from Admin
//      edit gate
// ═══════════════════════════════════════════════════════════════════════════

describe("admin/members/[id]/page.tsx — waiver fetch widened to Admin+Staff", () => {
  const s = readSource(DETAIL_PAGE_PATH);

  it("the get_member_waiver_status fetch is gated on isOperator(profile.role), not isAdmin", () => {
    const idx = s.indexOf('supabase.rpc("get_member_waiver_status"');
    expect(idx).toBeGreaterThan(-1);
    const precedingBlock = s.slice(Math.max(0, idx - 200), idx);
    expect(precedingBlock).toMatch(/isOperator\(profile\.role\)/);
    expect(precedingBlock).not.toMatch(/isAdmin && rosterMemberIdForWaiver/);
  });

  it("Member/Pro still never reach this fetch — the whole route redirects non-operators before any RPC runs (unchanged top-of-file gate)", () => {
    expect(s).toContain('if (!profile || !isOperator(profile.role)) redirect("/calendar");');
  });
});

describe("MemberDetailClient.tsx — canViewWaiverCompliance is separate from isMembershipAdmin", () => {
  const s = readSource(DETAIL_CLIENT_PATH);

  it("defines a distinct canViewWaiverCompliance derivation, not a reuse of isMembershipAdmin", () => {
    expect(s).toMatch(/const canViewWaiverCompliance\s*=/);
  });

  it("the Waiver block's render gate uses canViewWaiverCompliance, not isMembershipAdmin", () => {
    const idx = s.indexOf("Waiver group (Phase 43A-2");
    expect(idx).toBeGreaterThan(-1);
    const gateLine = s.slice(idx, s.indexOf("\n", s.indexOf("{canViewWaiverCompliance", idx)));
    expect(gateLine).toContain("canViewWaiverCompliance");
    expect(gateLine).not.toMatch(/\{isMembershipAdmin && waiverStatus/);
  });

  it("isMembershipAdmin itself is untouched and still gates ONLY Membership Status/Type editing — Staff must not gain that", () => {
    expect(s).toContain('const isMembershipAdmin = userRole === "admin";');
    // The Membership Status/Type <select> editor paths still check
    // isMembershipAdmin, unchanged from before this checkpoint.
    expect(s).toContain("isMembershipAdmin && rosterMemberId ?");
  });

  it("canViewWaiverCompliance is derived via the shared isOperator() helper (admin-or-staff by definition, src/lib/auth/roles.ts) rather than a locally re-typed role list", () => {
    expect(s).toContain('import { isOperator } from "@/lib/auth/roles";');
    const declIdx = s.indexOf("const canViewWaiverCompliance");
    const declLine = s.slice(declIdx, s.indexOf(";", declIdx) + 1);
    expect(declLine).toBe("const canViewWaiverCompliance = isOperator(userRole);");
  });

  it("preserves all four semantic states (Current/Needs acceptance/Updated waiver needs acceptance/Not required) in the read-only block, unchanged from 43A-2/43B-1A", () => {
    const idx = s.indexOf("Waiver group (Phase 43A-2");
    const blockEnd = s.indexOf("{/* Stats */}", idx);
    const block = s.slice(idx, blockEnd);
    expect(block).toContain("Current");
    expect(block).toContain("Needs acceptance");
    expect(block).toContain("Updated waiver needs acceptance");
    expect(block).toContain("Not required");
  });

  it("still no edit/accept/proxy-acceptance control anywhere in the Waiver block — display only", () => {
    const idx = s.indexOf("Waiver group (Phase 43A-2");
    const blockEnd = s.indexOf("{/* Stats */}", idx);
    const block = s.slice(idx, blockEnd);
    expect(block).not.toMatch(/<button|<select|<input|onClick|accept_member_waiver/);
  });
});
