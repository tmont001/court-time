import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 43B-5A — Member Waiver Compliance Surface. A SMALL UI checkpoint:
// surfaces existing Member waiver compliance (get_club_member_waiver_
// compliance, 0194, already shipped) on the /admin/members roster list.
// No migration, no new RPC, no waiver architecture change. Builds on
// Phase 43B-1B's already-existing wiring (memberWaiverComplianceUI.
// regression.test.ts covers that checkpoint's own contract, updated by
// this checkpoint only where the locked spec changed: outdated's label
// consolidated into "Needs acceptance", and the not_required roster row
// is no longer suppressed). This file covers this checkpoint's own
// specific, narrow deltas and invariants only — not a re-audit of
// 43B-1B's full existing coverage.
//
// Source-inspection style, matching this repository's established
// convention — no live DOM render in this suite.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const MEMBERS_PAGE_PATH = "src/app/(app)/admin/members/page.tsx";
const MEMBERS_CLIENT_PATH = "src/app/(app)/admin/members/MembersClient.tsx";

const pageSrc = readSource(MEMBERS_PAGE_PATH);
const clientSrc = readSource(MEMBERS_CLIENT_PATH);

function extractConfigBlock(source: string, key: string): string {
  const idx = source.indexOf(`${key}:`);
  expect(idx, `${key}: not found`).toBeGreaterThan(-1);
  return source.slice(idx, idx + 200);
}

// ═══════════════════════════════════════════════════════════════════════════
// SCOPE — no migration, no new RPC, no waiver architecture change
// ═══════════════════════════════════════════════════════════════════════════

describe("Phase 43B-5A scope guard", () => {
  it("0194 exists untouched — this is a frontend-only checkpoint", () => {
    expect(() => readSource("supabase/migrations/0194_member_waiver_compliance_operations.sql")).not.toThrow();
  });

  it("no new database table/RPC is referenced anywhere in the touched files", () => {
    for (const s of [pageSrc, clientSrc]) {
      expect(s).not.toMatch(/create table|create or replace function|\.rpc\("(?!get_members|get_club_invites|get_roster_members|get_club_member_waiver_compliance)/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// COMPLIANCE SOURCE — get_club_member_waiver_compliance(), never
// recomputed in TypeScript
// ═══════════════════════════════════════════════════════════════════════════

describe("compliance is sourced from get_club_member_waiver_compliance() only", () => {
  it("page.tsx calls the existing bulk RPC exactly once and never recomputes compliance status itself", () => {
    const rpcCalls = pageSrc.match(/supabase\.rpc\("get_club_member_waiver_compliance"\)/g) ?? [];
    expect(rpcCalls.length).toBe(1);
    // No independent status derivation from waiver_acceptances/waiver_
    // versions/current_version_id anywhere in this file — the RPC's own
    // `status` column is used verbatim.
    expect(pageSrc).not.toMatch(/waiver_acceptances|current_version_id|waiver_versions/);
  });

  it("MembersClient.tsx only ever maps the RPC's own status strings to display config — it never derives a status value of its own", () => {
    expect(clientSrc).toContain("function WaiverPill({ status }: { status: string }) {");
    expect(clientSrc).toContain("const config = WAIVER_STATUS_CONFIG[status];");
    // The four keys are exactly 0194's own status vocabulary — nothing
    // invented, nothing recomputed.
    for (const key of ["current", "never_accepted", "outdated", "not_required"]) {
      expect(clientSrc).toContain(`${key}:`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// STATUS MAPPING — locked three-state spec
// ═══════════════════════════════════════════════════════════════════════════

describe("status mapping matches the locked three-state spec", () => {
  it("Accepted: current -> 'Accepted'", () => {
    const block = extractConfigBlock(clientSrc, "current");
    expect(block).toContain("Accepted");
  });

  it("Needs acceptance: both never_accepted and outdated map to the SAME 'Needs acceptance' label — never accepted and accepted-an-older-version are not distinguished in this pill", () => {
    const neverAcceptedBlock = extractConfigBlock(clientSrc, "never_accepted");
    const outdatedBlock = extractConfigBlock(clientSrc, "outdated");
    expect(neverAcceptedBlock).toContain("Needs acceptance");
    expect(outdatedBlock).toContain("Needs acceptance");
  });

  it("Not required: not_required -> 'Not required'", () => {
    const block = extractConfigBlock(clientSrc, "not_required");
    expect(block).toContain("Not required");
  });

  it("exactly these three labels appear in the config — no fourth/other label, no 'Version N', no internal version id ever rendered", () => {
    const configStart = clientSrc.indexOf("WAIVER_STATUS_CONFIG");
    const configEnd = clientSrc.indexOf("};", configStart);
    const config = clientSrc.slice(configStart, configEnd);
    const labels = [...config.matchAll(/label:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(labels)).toEqual(new Set(["Accepted", "Needs acceptance", "Not required"]));
    expect(config).not.toMatch(/waiver_version_id|Version \d/);
  });

  it("the Not required roster row is now rendered, not suppressed — the pill is gated ONLY on hasMemberWaiverConfigured + waiverStatus existing", () => {
    expect(clientSrc).not.toMatch(/waiverStatus\.status\s*!==\s*"not_required"/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUTHORIZATION — Staff read-only preserved, no Member/Pro widening
// ═══════════════════════════════════════════════════════════════════════════

describe("authorization is unchanged by this checkpoint", () => {
  it("the /admin/members roster page's own top-level gate is still isOperator (admin+staff) — unchanged, untouched by this checkpoint", () => {
    expect(pageSrc).toContain('if (!isOperator(profile?.role)) redirect("/calendar");');
  });

  it("the waiver pill introduces no new role/permission check of its own — it renders identically for every viewer who already reaches this page (Admin and Staff alike), matching the existing Staff read-only posture", () => {
    // The compliance-merge and the pill-render blocks contain no role
    // branching — the gate that decides WHO sees this page at all is the
    // single isOperator check above, unchanged.
    const complianceSection = pageSrc.slice(pageSrc.indexOf("Phase 43B-1B"), pageSrc.indexOf("membersWithWaiver"));
    expect(complianceSection).not.toMatch(/profile\?\.role === "admin"|isAdmin\b/);
  });

  it("no Member/Pro access widening — isOperator's own definition still excludes Member and Pro (admin+staff only)", () => {
    const rolesSrc = readSource("src/lib/auth/roles.ts");
    const idx = rolesSrc.indexOf("export function isOperator(");
    expect(idx).toBeGreaterThan(-1);
    const fn = rolesSrc.slice(idx, rolesSrc.indexOf("\n}", idx) + 2);
    expect(fn).not.toMatch(/'member'|'pro'/);
  });

  it("the waiver pill adds no interactive control (no button/onClick/link) — informational only, viewers cannot act on it from this list", () => {
    const cardBlock1 = clientSrc.slice(
      clientSrc.indexOf('{hasMemberWaiverConfigured && m.waiverStatus && ('),
      clientSrc.indexOf('{hasMemberWaiverConfigured && m.waiverStatus && (') + 300
    );
    const cardBlock2 = clientSrc.slice(
      clientSrc.indexOf('{hasMemberWaiverConfigured && rm.waiverStatus && ('),
      clientSrc.indexOf('{hasMemberWaiverConfigured && rm.waiverStatus && (') + 300
    );
    for (const block of [cardBlock1, cardBlock2]) {
      expect(block).not.toMatch(/onClick|<button|<a\s|href=/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// NO ENFORCEMENT SIDE EFFECTS
// ═══════════════════════════════════════════════════════════════════════════

describe("no enforcement side effects — informational only", () => {
  it("no booking-blocking logic references waiver compliance anywhere in the touched files", () => {
    for (const s of [pageSrc, clientSrc]) {
      expect(s).not.toMatch(/block.*book|disable.*reserv|prevent.*book/i);
    }
  });

  it("no Member disable/suspend action is wired to waiver status", () => {
    for (const s of [pageSrc, clientSrc]) {
      expect(s).not.toMatch(/disable.*member|suspend.*waiver|waiver.*suspend/i);
    }
  });

  it("no email/SMS/notification dispatch references waiver compliance in either touched file", () => {
    for (const s of [pageSrc, clientSrc]) {
      expect(s).not.toMatch(/sendEmail|sendSms|dispatch.*[Nn]otification|notify_.*waiver/);
    }
  });

  it("no proxy-acceptance action exists on this surface — no accept/mark-accepted call anywhere in these files", () => {
    for (const s of [pageSrc, clientSrc]) {
      expect(s).not.toMatch(/accept_member_waiver|acceptMemberWaiver|markAccepted/);
    }
  });

  it("the roster table/card structure itself is unchanged — the waiver pill is an additive line within the existing card, not a redesign", () => {
    // The existing membership-line pattern the waiver pill sits directly
    // beside is untouched — same conditional-line convention, no new
    // grid/table structure introduced.
    expect(clientSrc).toContain("membershipsEnabled && membershipLine(m.membership_status, m.membership_type_name)");
  });
});
