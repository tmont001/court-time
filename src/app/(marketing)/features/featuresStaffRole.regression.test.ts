import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Admin UX — /features product-polish checkpoint. Adds a fourth "Staff"
// role card alongside the existing Admins/Pros/Members cards, reflecting
// that Staff is a real, distinct role in this app (see
// canAccessOperationsWorkspace / isOperator in src/lib/roles) that the
// marketing page previously omitted. Copy is scoped to day-to-day
// operational support and deliberately does not claim Admin-only
// configuration authority (Staff never gets hasAdminAuthority). Grid moves
// from a fixed 3-column layout to a responsive 1/2/4-column layout. No
// marketing pricing/tiering claims are touched — see
// pricingPackaging.regression.test.ts for that coverage.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const FEATURES_PAGE_PATH = "src/app/(marketing)/features/page.tsx";
const GLOBALS_CSS_PATH = "src/app/globals.css";

describe("6. /features includes a Staff role card", () => {
  it("ROLES contains a Staff entry", () => {
    const s = readSource(FEATURES_PAGE_PATH);
    expect(s).toMatch(/name:\s*"Staff"/);
  });

  it("the Staff card copy is the specified operational-support summary", () => {
    const s = readSource(FEATURES_PAGE_PATH);
    expect(s).toContain(
      "Support day-to-day club operations, including members, bookings, events, and payment tracking."
    );
  });
});

describe("7. /features now represents Admins, Staff, Pros, and Members", () => {
  it("ROLES has exactly four entries in that order", () => {
    const s = readSource(FEATURES_PAGE_PATH);
    const rolesStart = s.indexOf("const ROLES = [");
    const rolesEnd = s.indexOf("];", rolesStart);
    const rolesBlock = s.slice(rolesStart, rolesEnd);
    const names = [...rolesBlock.matchAll(/name:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(names).toEqual(["Admins", "Staff", "Pros", "Members"]);
  });

  it("pre-existing Admins/Pros/Members summaries are preserved (not rewritten)", () => {
    const s = readSource(FEATURES_PAGE_PATH);
    expect(s).toContain("Oversee courts, programs, members, settings, and reporting.");
    expect(s).toContain("Respond to lesson requests and manage permitted scheduling and event work.");
    expect(s).toContain("Reserve courts, join events, manage waitlists, and request lessons — with Connected.");
  });
});

describe("8. Staff copy does not claim Admin-only configuration authority", () => {
  it("the Staff summary never mentions settings/configuration", () => {
    const s = readSource(FEATURES_PAGE_PATH);
    const rolesStart = s.indexOf("const ROLES = [");
    const rolesEnd = s.indexOf("];", rolesStart);
    const rolesBlock = s.slice(rolesStart, rolesEnd);
    const staffStart = rolesBlock.indexOf('name: "Staff"');
    const staffEntryEnd = rolesBlock.indexOf("},", staffStart);
    const staffEntry = rolesBlock.slice(staffStart, staffEntryEnd);
    expect(staffEntry.toLowerCase()).not.toMatch(/settings|configur/);
  });
});

describe("Responsive role-card grid: mobile 1 col, intermediate 2 col, wide desktop 4 col", () => {
  it("grid classes are grid-cols-1 sm:grid-cols-2 lg:grid-cols-4", () => {
    const s = readSource(FEATURES_PAGE_PATH);
    expect(s).toContain('className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5"');
  });

  it("the reveal delay covers a fourth stagger step, backed by a matching CSS rule", () => {
    const s = readSource(FEATURES_PAGE_PATH);
    expect(s).toContain('"delay-1" | "delay-2" | "delay-3" | "delay-4"');
    const css = readSource(GLOBALS_CSS_PATH);
    expect(css).toContain(".mkt-reveal.delay-4 { transition-delay: 320ms; }");
  });
});

describe("9. no authorization/RPC changes — this is a marketing copy/layout page only", () => {
  it("page.tsx has no Supabase/RPC/auth imports", () => {
    const s = readSource(FEATURES_PAGE_PATH);
    expect(s).not.toMatch(/supabase|\.rpc\(|createServerClient|createBrowserClient/i);
  });
});
