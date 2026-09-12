import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Admin UX shell fix — runtime QA found the desktop sidebar appearing at
// Tailwind `md` (768px) left the actual page workspace cramped at tablet
// widths (a real tablet, or a narrow laptop window, between 768-1024px).
// The compact bottom-nav shell already exists and already provides full
// destination parity with the sidebar (see BottomNav's admin moreLinks) —
// so the fix is a pure breakpoint move, not a new navigation surface: the
// sidebar/bottom-nav boundary shifts from `md` (768px) to `lg` (1024px)
// across exactly five places that must stay in lockstep:
//   1. SideNav.tsx       — hidden lg:flex (was hidden md:flex)
//   2. BottomNav.tsx     — lg:hidden (was md:hidden)
//   3. layout.tsx        — lg:pl-60 (was md:pl-60)
//   4. globals.css       — --page-fill-height's desktop override, 1024px (was 768px)
//   5. globals.css       — .app-main-content's bottom-padding override, 1024px (was 768px)
// No manual sidebar-collapse control was added, and ResponsiveSheet's own
// (coincidentally identical) 768px mobile/desktop presentation breakpoint
// is explicitly UNCHANGED — a separate, non-blocking concern (see the
// checkpoint's own audit).
//
// Source-inspection style, matching this repository's established
// convention for framework-coupled files with no jsdom (see
// ResponsiveSheet.regression.test.ts's own header for the same rationale).
//
// Follow-up production hotfix (fix/responsive-club-switcher, 3 days later):
// the five places above were the sidebar/bottom-nav shell boundary, but
// Header.tsx's OWN direct club-switch trigger (HeaderClubSwitcherButton)
// was a SIXTH place using the same md->lg logic that this checkpoint never
// touched — it was still md, leaving a real 768-1023px gap where no direct
// switcher was visible at all. See describe block 9 below for that fix.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const SIDE_NAV_PATH = "src/components/SideNav.tsx";
const BOTTOM_NAV_PATH = "src/components/BottomNav.tsx";
const APP_LAYOUT_PATH = "src/app/(app)/layout.tsx";
const CSS_PATH = "src/app/globals.css";

describe("1. SideNav begins at lg, not md", () => {
  it("the sidebar's visibility class is hidden lg:flex", () => {
    const s = readSource(SIDE_NAV_PATH);
    expect(s).toContain("hidden lg:flex flex-col fixed left-0 top-0 bottom-0 w-60");
    expect(s).not.toMatch(/hidden md:flex/);
  });

  it("the sidebar's own width (w-60) is unchanged", () => {
    const s = readSource(SIDE_NAV_PATH);
    expect(s).toContain("w-60");
  });
});

describe("2. BottomNav remains visible until lg", () => {
  it("the bottom nav's visibility class is lg:hidden", () => {
    const s = readSource(BOTTOM_NAV_PATH);
    expect(s).toContain('className="lg:hidden fixed bottom-0 left-0 right-0');
    expect(s).not.toMatch(/md:hidden fixed bottom-0/);
  });
});

describe("3. app layout pl-60 begins at lg", () => {
  it("the content-offset class is lg:pl-60", () => {
    const s = readSource(APP_LAYOUT_PATH);
    expect(s).toContain('className="flex flex-col min-h-screen lg:pl-60"');
    expect(s).not.toMatch(/md:pl-60/);
  });
});

describe("4. --page-fill-height shell override begins at 1024px", () => {
  it("the mobile/tablet formula (header + bottom nav + safe area) is unchanged", () => {
    const s = readSource(CSS_PATH);
    expect(s).toContain(
      "--page-fill-height: calc(100dvh - 3.5rem - 4rem - env(safe-area-inset-bottom, 0px));"
    );
  });

  it("the desktop override (header only) now activates at 1024px, not 768px", () => {
    const s = readSource(CSS_PATH);
    const varStart = s.indexOf("--page-fill-height: calc(100dvh - 3.5rem - 4rem");
    // Stop right after this variable's own override block closes (its
    // closing "}\n}" pair) — not at some later, unrelated section heading —
    // so an unrelated 768px rule further down in the file can never leak
    // into this slice.
    const overrideStart = s.indexOf("@media (min-width: 1024px)", varStart);
    const overrideEnd = s.indexOf("}\n}", overrideStart) + "}\n}".length;
    const section = s.slice(varStart, overrideEnd);
    expect(section).toContain("@media (min-width: 1024px)");
    expect(section).not.toMatch(/@media \(min-width: 768px\)/);
    expect(section).toContain("--page-fill-height: calc(100dvh - 3.5rem);");
  });
});

describe("5. app-main-content shell override begins at 1024px", () => {
  it("the mobile/tablet bottom padding (4rem + safe area, for the visible bottom nav) is unchanged", () => {
    const s = readSource(CSS_PATH);
    expect(s).toContain(
      "padding-bottom: calc(4rem + env(safe-area-inset-bottom, 0px));"
    );
  });

  it("the desktop override (padding-bottom: 0) now activates at 1024px, not 768px", () => {
    const s = readSource(CSS_PATH);
    const blockStart = s.indexOf(".app-main-content {\n  padding-bottom: calc(4rem");
    // Stop right after this rule's own override block closes — not at some
    // later, unrelated section heading — so an unrelated 768px rule further
    // down in the file can never leak into this slice.
    const overrideStart = s.indexOf("@media (min-width: 1024px)", blockStart);
    const overrideEnd = s.indexOf("}\n}", overrideStart) + "}\n}".length;
    const block = s.slice(blockStart, overrideEnd);
    expect(block).toContain("@media (min-width: 1024px)");
    expect(block).not.toMatch(/@media \(min-width: 768px\)/);
    expect(block).toContain("padding-bottom: 0;");
  });
});

describe("6. unrelated ResponsiveSheet/.ct-input 768px breakpoints remain unchanged", () => {
  it("all five other 768px media queries in globals.css (.ct-input x1, ResponsiveSheet x4) are still exactly 768px", () => {
    const s = readSource(CSS_PATH);
    const occurrences = s.match(/@media \(min-width: 768px\)/g) ?? [];
    // Exactly 5 remain: .ct-input desktop density, plus ResponsiveSheet's
    // sheet-modal-enter, sheet-panel-enter, sheet-modal-max-h, and
    // sheet-panel-max-h variants.
    expect(occurrences.length).toBe(5);
  });

  it("ResponsiveSheet.tsx's own md: classes were not touched by this checkpoint", () => {
    const s = readSource("src/components/ResponsiveSheet.tsx");
    expect(s).toContain("md:hidden shrink-0 flex justify-center py-3");
    expect(s).toMatch(/hidden md:flex absolute top-4 right-4/);
  });

  it("ProgramOfferModal and WaitlistOfferModal's md:hidden close controls are untouched", () => {
    const programSrc = readSource("src/components/ProgramOfferModal.tsx");
    const waitlistSrc = readSource("src/components/WaitlistOfferModal.tsx");
    expect(programSrc).toContain('className="absolute right-0 text-sm text-gray-400 md:hidden"');
    expect(waitlistSrc).toContain('className="absolute right-0 text-sm text-gray-400 md:hidden"');
  });
});

// ─── Production hotfix (fix/responsive-club-switcher) ──────────────────────
//
// Header.tsx's OWN direct club-switch trigger (HeaderClubSwitcherButton)
// was left at its original `md` (768px) split when the checkpoint above
// moved SideNav/BottomNav's boundary to `lg` (1024px). That left a live
// 768-1023px gap: SideNav's dropdown hidden (< lg), Header's direct
// trigger also hidden (>= md renders the static, non-interactive icon
// instead) — only the buried BottomNav More -> "Switch club" path
// remained reachable. Fix: Header.tsx's club-icon-switcher split moves
// from md to lg, matching SideNav/BottomNav's boundary exactly, so there
// is no viewport width where every DIRECT switcher is hidden. No
// switching mechanism, RPC, membership query, or active-club logic
// changed — ClubMembershipList/switchActiveClubAction are reused
// unmodified, exactly as before.

const HEADER_PATH = "src/components/Header.tsx";

describe("9. Header's direct club-switch trigger now matches SideNav's own lg breakpoint — closes the 768-1023px gap", () => {
  it("the club-icon-switcher split moved from md to lg", () => {
    const s = readSource(HEADER_PATH);
    expect(s).toContain('<div className="hidden lg:block">{clubIcon}</div>');
    expect(s).toContain('<div className="lg:hidden">');
    expect(s).not.toContain('<div className="hidden md:block">{clubIcon}</div>');
    expect(s).not.toContain('<div className="md:hidden">');
  });

  it("lg here is the exact same breakpoint SideNav/BottomNav already use — not a new, independently-chosen value", () => {
    const headerSrc    = readSource(HEADER_PATH);
    const sideNavSrc   = readSource(SIDE_NAV_PATH);
    const bottomNavSrc = readSource(BOTTOM_NAV_PATH);
    expect(headerSrc).toContain("lg:hidden");
    expect(sideNavSrc).toContain("hidden lg:flex");
    expect(bottomNavSrc).toContain("lg:hidden fixed bottom-0");
  });

  it("HeaderClubSwitcherButton is still reused unmodified as the direct trigger — no second switching implementation was introduced", () => {
    const s = readSource(HEADER_PATH);
    expect(s).toContain("<HeaderClubSwitcherButton clubName={clubName} icon={clubIcon} memberships={memberships} />");
  });

  it("the eligibility gate (2+ active memberships) and single-club fallback are unchanged", () => {
    const s = readSource(HEADER_PATH);
    expect(s).toContain("const canSwitchOnMobile = memberships.length > 1;");
    expect(s).toContain("{canSwitchOnMobile ? (");
    expect(s).toMatch(/\) : \(\s*clubIcon\s*\)\}/);
  });

  it("no viewport width leaves every direct switcher hidden: SideNav covers [1024px, ∞), Header's direct trigger covers [0, 1024px) — the two ranges are exhaustive and non-overlapping", () => {
    const sideNavSrc = readSource(SIDE_NAV_PATH);
    const headerSrc  = readSource(HEADER_PATH);
    expect(sideNavSrc).toContain("hidden lg:flex"); // SideNav: visible only >= 1024px
    expect(headerSrc).toContain('<div className="lg:hidden">'); // direct trigger: visible only < 1024px
  });

  it("BottomNav's More -> Switch club fallback is untouched by this fix — remains an additional path, not the only one", () => {
    const s = readSource(BOTTOM_NAV_PATH);
    expect(s).toContain("Switch club");
    expect(s).toContain("setSwitcherOpen(true)");
  });
});

describe("7. Admin BottomNav + More still provides all current destinations — untouched by this checkpoint", () => {
  it("admin mainTabs and moreLinks are byte-identical to before — no destination added, removed, or moved", () => {
    const s = readSource(BOTTOM_NAV_PATH);
    // Main tabs (role-gated, unchanged conditions).
    expect(s).toContain('{ label: "Calendar", href: "/calendar", Icon: CalendarIcon }');
    expect(s).toContain('{ label: "Events",   href: "/events",         Icon: EventsIcon   }');
    expect(s).toContain('{ label: "Lessons", href: "/admin/lessons", Icon: LessonsIcon }');
    expect(s).toContain('{ label: "Bookings", href: "/my-schedule",   Icon: ScheduleIcon },');
    // Admin's More sheet — all 10 entries, unchanged.
    for (const [label, href] of [
      ["Overview", "/admin/overview"],
      ["Members", "/admin/members"],
      ["Payments", "/admin/payments"],
      ["Courts", "/admin/courts"],
      ["Club Settings", "/admin/settings"],
      ["Audit Log", "/admin/audit-log"],
      ["Reports", "/admin/reports"],
      ["Profile", "/profile"],
      ["Notifications", "/profile/notifications"],
      ["Security", "/profile/security"],
    ]) {
      expect(s).toMatch(new RegExp(`label: "${label}",\\s*href: "${href.replace(/\//g, "\\/")}"`));
    }
  });

  it("SideNav's own admin destination set is unchanged (same 12 destinations, same hrefs)", () => {
    const s = readSource(SIDE_NAV_PATH);
    for (const href of [
      "/admin/overview", "/calendar", "/events", "/admin/lessons", "/my-schedule",
      "/admin/members", "/admin/payments", "/admin/courts", "/admin/settings",
      "/admin/audit-log", "/admin/reports", "/profile",
    ]) {
      expect(s).toContain(`href="${href}"`);
    }
  });
});

describe("8. no route/auth/business logic changes", () => {
  it("SideNav/BottomNav accept the exact same props as before — no new prop was introduced by this checkpoint", () => {
    const sideNavSrc = readSource(SIDE_NAV_PATH);
    const bottomNavSrc = readSource(BOTTOM_NAV_PATH);
    expect(sideNavSrc).toContain("userRole = \"member\", clubName, memberships = [], memberSelfService = true");
    expect(bottomNavSrc).toContain("userRole = \"member\", clubName, memberships = [], memberSelfService = true");
  });

  it("layout.tsx's auth/redirect/club-context logic is untouched", () => {
    const s = readSource(APP_LAYOUT_PATH);
    expect(s).toContain('if (!user) redirect("/sign-in");');
    expect(s).toContain('redirect("/pending-invite");');
  });

  it("no new client-side viewport-detection (matchMedia/innerWidth/resize listener) was introduced anywhere in the shell", () => {
    for (const path of [SIDE_NAV_PATH, BOTTOM_NAV_PATH, APP_LAYOUT_PATH]) {
      const s = readSource(path);
      expect(s).not.toMatch(/matchMedia|innerWidth|addEventListener\(.resize/);
    }
  });

  it("no manual sidebar-collapse control (a button toggling sidebar visibility via state) was introduced", () => {
    const s = readSource(SIDE_NAV_PATH);
    expect(s).not.toMatch(/collapse|isCollapsed|toggleSidebar/i);
  });
});
