import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Navigation-semantics cleanup — Court Time has persistent primary
// navigation (SideNav at desktop, BottomNav + More below lg), so top-level
// destinations should not invent a parent hierarchy with an artificial
// "Back to X" link. Six such links were removed from peer top-level Admin
// destinations (confirmed as SideNav siblings in src/components/SideNav.tsx:
// Overview, Members, Courts, Club Settings, Audit Log, Reports). Genuine
// child/detail Back links (member detail -> Members, account security/
// notifications/help -> Account) are untouched — see describe block 7.
//
// Source-inspection style, matching this directory's established convention.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const OVERVIEW_PAGE_PATH   = "src/app/(app)/admin/overview/page.tsx";
const MEMBERS_PAGE_PATH    = "src/app/(app)/admin/members/page.tsx";
const COURTS_PAGE_PATH     = "src/app/(app)/admin/courts/page.tsx";
const SETTINGS_PAGE_PATH   = "src/app/(app)/admin/settings/page.tsx";
const AUDIT_LOG_PAGE_PATH  = "src/app/(app)/admin/audit-log/page.tsx";
const REPORTS_PAGE_PATH    = "src/app/(app)/admin/reports/page.tsx";
const MEMBER_DETAIL_ERROR_PATH = "src/app/(app)/admin/members/[id]/error.tsx";
const SECURITY_PAGE_PATH       = "src/app/(app)/profile/security/page.tsx";
const NOTIFICATIONS_PAGE_PATH  = "src/app/(app)/profile/notifications/page.tsx";
const HELP_PAGE_PATH           = "src/app/(app)/help/page.tsx";
const SIDE_NAV_PATH            = "src/components/SideNav.tsx";

describe("1. /admin/overview has no artificial Back to Account", () => {
  it("no 'Back to Account' text remains", () => {
    expect(readSource(OVERVIEW_PAGE_PATH)).not.toContain("Back to Account");
  });
});

describe("2. /admin/members has no artificial Back to Account", () => {
  it("no 'Back to Account' text remains, and the now-unused Link import was removed", () => {
    const s = readSource(MEMBERS_PAGE_PATH);
    expect(s).not.toContain("Back to Account");
    expect(s).not.toMatch(/^import Link from "next\/link";$/m);
  });
});

describe("3. /admin/courts has no artificial Back to Account", () => {
  it("no 'Back to Account' text remains (Link import stays — still used by the tab strip)", () => {
    const s = readSource(COURTS_PAGE_PATH);
    expect(s).not.toContain("Back to Account");
    expect(s).toContain('import Link from "next/link";');
    expect(s).toContain('{ key: "courts", label: "Courts", href: "/admin/courts" }');
  });
});

describe("4. /admin/settings has no artificial Back to Account", () => {
  it("no 'Back to Account' text remains", () => {
    expect(readSource(SETTINGS_PAGE_PATH)).not.toContain("Back to Account");
  });
});

describe("5. /admin/audit-log has no artificial Back to Account", () => {
  it("no 'Back to Account' text remains, and the now-unused Link import was removed", () => {
    const s = readSource(AUDIT_LOG_PAGE_PATH);
    expect(s).not.toContain("Back to Account");
    expect(s).not.toMatch(/^import Link from "next\/link";$/m);
  });
});

describe("6. /admin/reports has no artificial Back to Overview", () => {
  it("no 'Back to Overview' text remains in either the unavailable-fallback or main render path", () => {
    const s = readSource(REPORTS_PAGE_PATH);
    expect(s).not.toContain("Back to Overview");
    // Link import remains — still used by the range selector (Today/7d/30d).
    expect(s).toContain('import Link from "next/link";');
    expect(s).toContain('{ key: "today", label: "Today", href: "/admin/reports?range=today" }');
  });
});

describe("7. genuine child/detail Back links remain untouched", () => {
  it("member detail error boundary still links Back to Members", () => {
    const s = readSource(MEMBER_DETAIL_ERROR_PATH);
    expect(s).toContain("← Back to Members");
    expect(s).toContain('href="/admin/members"');
  });

  it("account security page still links Back to Account", () => {
    const s = readSource(SECURITY_PAGE_PATH);
    expect(s).toContain("← Back to Account");
    expect(s).toContain('href="/profile"');
  });

  it("notification preferences page still links Back to Account", () => {
    const s = readSource(NOTIFICATIONS_PAGE_PATH);
    expect(s).toContain("← Back to Account");
    expect(s).toContain('href="/profile"');
  });

  it("Help & Rules (reached only from the Profile/Account page, not primary nav) still links Back to Account", () => {
    const s = readSource(HELP_PAGE_PATH);
    expect(s).toContain("← Back to Account");
    expect(s).toContain('href="/profile"');
  });
});

describe("removed pages are confirmed peer top-level destinations, not a genuine hierarchy", () => {
  it("Overview, Members, Courts, Club Settings, Audit Log, and Reports are all sibling SideNav links", () => {
    const s = readSource(SIDE_NAV_PATH);
    expect(s).toContain('href="/admin/overview" label="Overview"');
    expect(s).toContain('href="/admin/members"    label="Members"');
    expect(s).toContain('href="/admin/courts"     label="Courts"');
    expect(s).toContain('href="/admin/settings"   label="Club Settings"');
    expect(s).toContain('href="/admin/audit-log"  label="Audit Log"');
    expect(s).toContain('href="/admin/reports"    label="Reports"');
  });
});

describe("8. no route/auth/business logic changes", () => {
  it("role redirects and RPC calls on every touched page are byte-identical to before this checkpoint", () => {
    expect(readSource(OVERVIEW_PAGE_PATH)).toContain('redirect("/calendar")');
    expect(readSource(MEMBERS_PAGE_PATH)).toContain("isOperator(profile?.role)");
    expect(readSource(AUDIT_LOG_PAGE_PATH)).toContain('if (profile?.role !== "admin") redirect("/calendar");');
    expect(readSource(AUDIT_LOG_PAGE_PATH)).toContain('supabase.rpc("get_audit_log", {');
    expect(readSource(REPORTS_PAGE_PATH)).toContain('{ key: "7d", label: "Last 7 days", href: "/admin/reports?range=7d" }');
  });
});

// 9. "no migration was added by this checkpoint" was previously asserted
// here as a hardcoded "highest migration === N" ceiling. That pattern is
// invalid for a historical checkpoint's regression suite: this checkpoint
// truthfully added no migration itself, but it cannot prove no LATER,
// unrelated checkpoint ever will (and one already has — 0170, added by the
// Communications checkpoint). Removed rather than kept as a moving target;
// migration-specific claims belong in the test suite of the checkpoint that
// actually owns that migration (see e.g.
// communicationsInformationArchitecture.regression.test.ts for 0170's own
// contract coverage).
