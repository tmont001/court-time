import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 43B-3E2 — standardize Court Time's PAGE/ROUTE-LEVEL navigation tab
// strips onto one shared component (src/components/PageTabs.tsx), sourced
// from the visual pattern already established identically on
// /admin/courts, /admin/communications, and /admin/lessons. Source-
// inspection style, matching this repository's established convention.
//
// IMPORTANT DISTINCTION (locked): only page/route-level navigation was
// migrated. Local filters/segmented controls (Active/Past/All, role
// filters, status filters, date-range pickers) are a different UI
// concept and were deliberately left untouched, even where they happen
// to already share a superficially similar visual style.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const PAGE_TABS_PATH = "src/components/PageTabs.tsx";
const COURTS_PAGE_PATH = "src/app/(app)/admin/courts/page.tsx";
const COMMUNICATIONS_PAGE_PATH = "src/app/(app)/admin/communications/page.tsx";
const LESSONS_PAGE_PATH = "src/app/(app)/admin/lessons/page.tsx";
const REPORTS_PAGE_PATH = "src/app/(app)/admin/reports/page.tsx";
const EVENTS_TABS_PATH = "src/app/(app)/events/EventsAdminTabs.tsx";
const EVENTS_UPCOMING_PATH = "src/app/(app)/events/EventsUpcomingClient.tsx";
const MY_SCHEDULE_PAGE_PATH = "src/app/(app)/my-schedule/page.tsx";
const LESSONS_REDIRECT_PATH = "src/app/(app)/lessons/page.tsx";
const PAYMENTS_CLIENT_PATH = "src/app/(app)/admin/payments/AdminPaymentsClient.tsx";
const MEMBERS_TABS_PATH = "src/app/(app)/admin/members/MembersAreaTabs.tsx";
const MEMBERS_CLIENT_PATH = "src/app/(app)/admin/members/MembersClient.tsx";

describe("PageTabs — the one shared page/route-level tab-strip component", () => {
  const s = readSource(PAGE_TABS_PATH);

  it("plain component (no 'use client') — safe to import into a Server Component page with only href items, and into an already-client component with onClick items, introducing no new client boundary either way", () => {
    expect(s.trimStart().startsWith('"use client"')).toBe(false);
  });

  it("supports both href (Link-backed, route navigation) and onClick (button-backed, client tab state) per item — the underlying navigation mechanism is the caller's choice, never dictated by this component", () => {
    expect(s).toContain("href?: string;");
    expect(s).toContain("onClick?: () => void;");
    expect(s).toContain("if (item.href) {");
  });

  it("canonical visual treatment: ct-card, divide-x cells, active = accent fill, inactive = quiet gray with hover tint", () => {
    expect(s).toContain("ct-card flex divide-x divide-gray-100 dark:divide-gray-800 overflow-hidden");
    expect(s).toContain("bg-accent text-white");
    expect(s).toContain("text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800/50");
  });

  it("mobile-safe via equal-width flex-1 cells with compact label wrapping (leading-tight), not a scrolling container — matches the proven Courts 'Hours & Closures' precedent", () => {
    expect(s).toContain("flex-1");
    expect(s).toContain("leading-tight");
  });

  it("keyboard accessible — visible focus ring on every cell", () => {
    expect(s).toContain("focus-visible:ring");
  });

  it("no brand-color system was introduced — active state reuses the existing --accent token via the established bg-accent/text-accent Tailwind classes, nothing new", () => {
    expect(s).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(s).not.toMatch(/rgb\(|hsl\(/);
  });
});

describe("Surfaces already matching the canonical style were deduplicated onto PageTabs, not rewritten", () => {
  it("/admin/courts, /admin/communications, /admin/lessons all render via the shared component now", () => {
    for (const path of [COURTS_PAGE_PATH, COMMUNICATIONS_PAGE_PATH, LESSONS_PAGE_PATH]) {
      const s = readSource(path);
      expect(s).toContain('import PageTabs from "@/components/PageTabs";');
      expect(s).toMatch(/<PageTabs/);
      // No duplicate inline ct-card tab markup remains on the page itself.
      expect(s).not.toMatch(/className="ct-card flex divide-x/);
    }
  });

  it("routes, labels, and ordering are preserved exactly on all three", () => {
    const courts = readSource(COURTS_PAGE_PATH);
    expect(courts).toContain('{ key: "courts", label: "Courts", href: "/admin/courts" }');
    expect(courts).toContain('{ key: "hours", label: "Hours & Closures", href: "/admin/courts?tab=hours" }');
    expect(courts).toContain('{ key: "rules", label: "Booking Rules", href: "/admin/courts?tab=rules" }');

    const communications = readSource(COMMUNICATIONS_PAGE_PATH);
    expect(communications).toContain('{ key: "compose",     label: "Compose",     href: "/admin/communications" }');
    expect(communications).toContain('{ key: "activity",    label: "Activity",    href: "/admin/communications?tab=activity" }');
    expect(communications).toContain('{ key: "diagnostics", label: "Diagnostics", href: "/admin/communications?tab=diagnostics" }');

    const lessons = readSource(LESSONS_PAGE_PATH);
    expect(lessons).toContain('{ key: "requests", label: "Lesson Requests", href: "/admin/lessons"');
    expect(lessons).toContain('{ key: "types", label: "Lesson Types", href: "/admin/lessons?tab=types"');
  });

  it("Admin-only visibility on /admin/lessons' tab strip is preserved (Pro/Staff never see it)", () => {
    const s = readSource(LESSONS_PAGE_PATH);
    expect(s).toContain('{userRole === "admin" && (');
  });
});

describe("Surfaces restyled onto PageTabs kept their exact navigation mechanism and route/label set", () => {
  it("/events (EventsAdminTabs) stays onClick/client-state (never converted to Link/searchParams — that would remount AdminEventsClient and lose pagination state)", () => {
    const s = readSource(EVENTS_TABS_PATH);
    expect(s).toContain('import PageTabs from "@/components/PageTabs";');
    expect(s).toContain('onClick: () => setTab("upcoming")');
    expect(s).toContain('onClick: () => setTab("manage")');
    expect(s).toContain("const [tab, setTab] = useState<Tab>(\"upcoming\");");
    expect(s).not.toMatch(/href:\s*["'`]\/events/);
  });

  it("/my-schedule (and /lessons, which only ever redirects into it) stays Link/searchParams-backed, with the exact same routes/labels/Member-only gating as before", () => {
    const s = readSource(MY_SCHEDULE_PAGE_PATH);
    expect(s).toContain('import PageTabs from "@/components/PageTabs";');
    expect(s).toContain('{ key: "upcoming", label: "Upcoming", href: "/my-schedule", active: tab === "upcoming" }');
    expect(s).toContain('{ key: "lessons", label: "Lessons", href: "/my-schedule?tab=lessons", active: tab === "lessons" }');
    expect(s).toContain('{ key: "payments", label: "Payments", href: "/my-schedule?tab=payments", active: tab === "payments" }');
    expect(s).toContain('{ key: "past", label: "Past", href: "/my-schedule?tab=past", active: tab === "past" }');
    expect(s).toContain('userRole === "member"');

    const redirectSource = readSource(LESSONS_REDIRECT_PATH);
    expect(redirectSource).toContain('redirect(`/my-schedule?tab=lessons');
  });

  it("/admin/payments (AdminPaymentsClient) stays onClick/client-state — Overview remains Admin-only, Outstanding/Payment Activity remain unconditional for both roles", () => {
    const s = readSource(PAYMENTS_CLIENT_PATH);
    expect(s).toContain('import PageTabs from "@/components/PageTabs";');
    expect(s).toContain('onClick: () => setTab("overview")');
    expect(s).toContain('onClick: () => setTab("outstanding")');
    expect(s).toContain('onClick: () => setTab("activity")');
    expect(s).not.toMatch(/href:\s*["'`]\/admin\/payments/);
  });

  it("/admin/members (MembersAreaTabs) stays Link/usePathname-backed, three exact routes preserved", () => {
    const s = readSource(MEMBERS_TABS_PATH);
    expect(s).toContain('import PageTabs from "@/components/PageTabs";');
    expect(s).toContain('href: "/admin/members"');
    expect(s).toContain('href: "/admin/members/types"');
    expect(s).toContain('href: "/admin/members/waivers"');
    expect(s).toContain("usePathname");
  });
});

describe("/admin/reports has no page-level navigation tabs to migrate — its ct-card-styled control is a date-range FILTER, correctly left untouched", () => {
  it("reports/page.tsx was not modified by this checkpoint", () => {
    // No PageTabs import/usage was introduced — the existing ct-card
    // range-selector markup is a local filter, not page navigation, and
    // stays exactly as it was.
    const s = readSource(REPORTS_PAGE_PATH);
    expect(s).not.toMatch(/PageTabs/);
    expect(s).toContain("resolveReportRange");
  });
});

describe("No local filters/segmented controls were accidentally converted", () => {
  it("Events' Active-filter row (event type / search) is untouched — no PageTabs import, no relation to the Upcoming/Manage admin tab strip", () => {
    const s = readSource(EVENTS_UPCOMING_PATH);
    expect(s).not.toMatch(/PageTabs/);
    expect(s).toContain("hasActiveFilters");
  });

  it("MembersClient.tsx's own status/search filtering (a local filter, not page navigation) was not touched or routed through PageTabs", () => {
    const s = readSource(MEMBERS_CLIENT_PATH);
    expect(s).not.toMatch(/PageTabs/);
  });
});
