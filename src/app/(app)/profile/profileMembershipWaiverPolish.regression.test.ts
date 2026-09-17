import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Phase 43B-3C — Member Profile waiver-card attention state + Club
// Membership domain-read polish. Source-inspection style, matching this
// repository's established convention. No migration in this checkpoint —
// the Phase 42 domain-membership read (roster_members.membership_status/
// membership_type_id) is a narrow, server-only createPrivilegedClient()
// read scoped entirely by already-verified server-side values, mirroring
// the 43B-3B Settings data-loading precedent.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const WAIVER_CARD_PATH = "src/app/(app)/profile/WaiverStatusCard.tsx";
const PROFILE_PAGE_PATH = "src/app/(app)/profile/page.tsx";
const MIGRATION_0196_PATH = "supabase/migrations/0196_waiver_pdf_document_foundation.sql";

describe("WaiverStatusCard — amber attention state (Phase 43B-3C)", () => {
  const s = readSource(WAIVER_CARD_PATH);

  it("1. never_accepted uses amber treatment", () => {
    const block = s.slice(
      s.indexOf('status === "never_accepted" || status === "outdated"'),
      s.indexOf("<Link")
    );
    expect(block).toMatch(/amber/);
  });

  it("2. outdated uses amber treatment (same shared block as never_accepted)", () => {
    const block = s.slice(
      s.indexOf('status === "never_accepted" || status === "outdated"'),
      s.indexOf("<Link")
    );
    expect(block).toContain('status === "never_accepted" ? "Needs acceptance" : "Updated waiver needs acceptance"');
    expect(block).toMatch(/amber/);
  });

  it("3. accepted/current remains green, unchanged", () => {
    const block = s.slice(s.indexOf('status === "current" &&'), s.indexOf('never_accepted" || status === "outdated"'));
    expect(block).toContain("bg-green-50 dark:bg-green-950 text-green-700 dark:text-green-400");
    expect(block).not.toMatch(/amber/);
  });

  it("4. no red is used for the ordinary never_accepted/outdated required-action state", () => {
    const block = s.slice(
      s.indexOf('status === "never_accepted" || status === "outdated"'),
      s.indexOf("<Link")
    );
    expect(block).not.toMatch(/\bred-/);
  });

  it("the amber action row itself stays readable/tappable (still uses ct-row-interactive, just amber-tinted)", () => {
    const linkBlock = s.slice(s.indexOf("<Link"), s.indexOf("</Link>") + 8);
    expect(linkBlock).toContain("ct-row-interactive");
    expect(linkBlock).toMatch(/amber/);
  });

  it("5. no Version N terminology anywhere on the card", () => {
    const codeOnly = s.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
    expect(codeOnly).not.toContain("versionNumber");
    expect(codeOnly).not.toMatch(/\(Version/);
  });

  it("preserves exact copy: Needs acceptance / Updated waiver needs acceptance", () => {
    expect(s).toContain("Needs acceptance");
    expect(s).toContain("Updated waiver needs acceptance");
  });
});

describe("Profile page.tsx — Club Membership domain-read polish (Phase 43B-3C)", () => {
  const s = readSource(PROFILE_PAGE_PATH);
  const codeOnly = s.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");

  it("6. normal Member profile no longer renders 'Role: Member' — the operational role row is gated on isOperationalRole, which excludes role === 'member'", () => {
    expect(codeOnly).not.toMatch(/>Role<\/span>/);
    expect(s).toContain('const isOperationalRole = hasActiveMembership && profile?.role !== "member" && profile?.role != null;');
  });

  it("7. Membership Type uses the actual Phase 42 membership-domain read model (roster_members.membership_type_id -> membership_types.name), not club_memberships", () => {
    expect(s).toContain('.from("roster_members")');
    expect(s).toContain('.select("membership_status, membership_type_id")');
    expect(s).toContain('.from("membership_types")');
    expect(s).toContain('membershipTypeName = typeRow?.name ?? null;');
  });

  it("8. Membership Status uses the actual roster_members.membership_status domain field, not club_memberships.status", () => {
    expect(s).toContain("membershipStatus = rosterRow?.membership_status ?? null;");
    expect(s).toContain("MEMBERSHIP_STATUS_LABELS[membershipStatus]");
  });

  it("9. auth club role/status (STATUS_CONFIG, club_memberships-derived) and membership-domain status (MEMBERSHIP_STATUS_LABELS, roster_members-derived) are two distinct maps, never conflated", () => {
    expect(s).toContain("const STATUS_CONFIG: Record<string, { label: string; className: string }> = {");
    expect(s).toContain("const MEMBERSHIP_STATUS_LABELS: Record<string, string> = {");
    // STATUS_CONFIG (auth/access) only ever renders inside the operational-role branch.
    const statusConfigUsageIdx = s.indexOf("statusConfig.className");
    const operationalBranchIdx = s.indexOf("isOperationalRole && (");
    expect(statusConfigUsageIdx).toBeGreaterThan(operationalBranchIdx);
  });

  it("roster_members read uses the privileged client — that table has admin(+staff)-only RLS, a Member cannot read even their own row through the normal client", () => {
    const rosterReadIdx = s.indexOf('.from("roster_members")');
    const precedingBlock = s.slice(Math.max(0, rosterReadIdx - 300), rosterReadIdx);
    expect(precedingBlock).toContain("createPrivilegedClient()");
  });

  it("the roster_members read is scoped by already-verified server-side values only — the caller's own auth user id and active club id, never a client-supplied id", () => {
    const rosterReadIdx = s.indexOf('.from("roster_members")');
    const queryBlock = s.slice(rosterReadIdx, s.indexOf(".maybeSingle()", rosterReadIdx) + 20);
    expect(queryBlock).toContain('.eq("club_id", profile.activeClubId)');
    expect(queryBlock).toContain('.eq("claimed_by", user.id)');
  });

  it("10. non-Member operational roles (Admin/Staff/Pro) display 'Club Role', not bare 'Role'", () => {
    expect(s).toContain(">Club Role</span>");
    expect(s).not.toMatch(/>Role<\/span>/);
    expect(s).toContain("OPERATIONAL_ROLE_LABELS");
  });

  it("11. memberships-disabled is handled gracefully — no membership type/status rows render, and a quiet explanatory note is shown instead", () => {
    expect(s).toContain("membershipsEnabled &&");
    expect(s).toContain("Your club doesn't currently use membership types.");
  });

  it("11. an unassigned membership type never fabricates a value — shows 'Not assigned' instead", () => {
    const typeRowIdx = s.indexOf("Membership Type</span>");
    const typeRowBlock = s.slice(typeRowIdx, typeRowIdx + 600);
    expect(typeRowBlock).toContain("membershipTypeName ? (");
    expect(typeRowBlock).toContain("Not assigned");
  });

  it("12. no membership edit controls were added — no <select>/<input>/onClick mutation handler inside the Club Membership card", () => {
    const cardStart = s.indexOf("{/* ── Club Membership");
    const cardEnd = s.indexOf("{waiverStatus &&", cardStart);
    const card = s.slice(cardStart, cardEnd);
    expect(card).not.toMatch(/<select|<input|onClick=/);
  });

  it("13. mobile-safe classes are retained — same row/pill/spacing patterns already used elsewhere on this page (px-4 py-3, rounded-full border pills, truncate)", () => {
    const cardStart = s.indexOf("{/* ── Club Membership");
    const cardEnd = s.indexOf("{waiverStatus &&", cardStart);
    const card = s.slice(cardStart, cardEnd);
    expect(card).toMatch(/px-4 py-3/);
    expect(card).toMatch(/rounded-full border/);
  });

  it("14. no migration was created for this checkpoint", () => {
    const files = readdirSync(join(process.cwd(), "supabase/migrations"));
    const beyond = files.filter((f) => {
      const match = f.match(/^(\d+)_/);
      return match !== null && Number(match[1]) > 196;
    });
    expect(beyond).toEqual([]);
  });

  it("15. 0196 remains untouched", () => {
    const migrationSql = readSource(MIGRATION_0196_PATH);
    expect(migrationSql).toContain("create table public.waiver_document_files");
    expect(migrationSql).toContain("create or replace function public.publish_waiver_pdf_version(");
  });
});
