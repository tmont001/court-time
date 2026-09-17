import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Phase 43B-3E — Members Information Architecture. Pure route relocation:
// Membership management (toggle, Membership Types, Member Waiver, Guest
// Waiver) moved from /admin/settings into a new Admin Members hub
// (/admin/members, /admin/members/types, /admin/members/waivers) with
// shared route-backed tab navigation. No business logic, no new
// migration. Source-inspection style, matching this repository's
// established convention.
//
// Coverage note: the moved-content/no-duplicate-surface/revalidation
// assertions for Membership Types and Member/Guest Waiver already live in
// the (updated) membershipTypesManagement.regression.test.ts,
// membershipSettingsPricingUI.regression.test.ts, memberWaiverUI.
// regression.test.ts, guestWaiverSettingsUI.regression.test.ts, and
// settingsInformationArchitecture.regression.test.ts — this file covers
// the tab-navigation mechanics, the three routes as a set, and this
// checkpoint's own security/scope guards.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const MEMBERS_PAGE_PATH = "src/app/(app)/admin/members/page.tsx";
const TYPES_PAGE_PATH = "src/app/(app)/admin/members/types/page.tsx";
const WAIVERS_PAGE_PATH = "src/app/(app)/admin/members/waivers/page.tsx";
const TABS_PATH = "src/app/(app)/admin/members/MembersAreaTabs.tsx";
const MEMBERS_CLIENT_PATH = "src/app/(app)/admin/members/MembersClient.tsx";
const SETTINGS_ACTIONS_PATH = "src/app/(app)/admin/settings/actions.ts";
const WAIVER_PDF_ACTIONS_PATH = "src/app/(app)/admin/settings/waiverPdfActions.ts";
const MIGRATION_0196_PATH = "supabase/migrations/0196_waiver_pdf_document_foundation.sql";

describe("1/2. three Members routes exist, each rendering the shared tabs", () => {
  it("all three page files exist", () => {
    expect(() => readSource(MEMBERS_PAGE_PATH)).not.toThrow();
    expect(() => readSource(TYPES_PAGE_PATH)).not.toThrow();
    expect(() => readSource(WAIVERS_PAGE_PATH)).not.toThrow();
  });

  it("all three pages render MembersAreaTabs, passing canManageMemberships derived from the same already-loaded profile — one reusable shared component, not three separate implementations, and no second auth query", () => {
    for (const path of [MEMBERS_PAGE_PATH, TYPES_PAGE_PATH, WAIVERS_PAGE_PATH]) {
      const s = readSource(path);
      expect(s).toMatch(/<MembersAreaTabs/);
      expect(s).toContain('canManageMemberships={profile?.role === "admin"}');
    }
  });

  it("no second tab-navigation component was invented — exactly one MembersAreaTabs.tsx file", () => {
    const dirEntries = readdirSync(join(process.cwd(), "src/app/(app)/admin/members"), { withFileTypes: true });
    const tabFiles = dirEntries.filter((e) => e.isFile() && /tabs?/i.test(e.name));
    expect(tabFiles.map((e) => e.name)).toEqual(["MembersAreaTabs.tsx"]);
  });
});

describe("Tab visibility correction — Staff sees no redirect-only tabs (runtime UX fix, same checkpoint)", () => {
  const tabsSource = readSource(TABS_PATH);

  it("1. Admin (canManageMemberships=true) renders the full tab strip — the early-return guard only fires on false", () => {
    expect(tabsSource).toContain("if (!canManageMemberships) return null;");
    // The guard is the ONLY conditional return before the tablist JSX —
    // canManageMemberships=true always falls through to it.
    const guardIdx = tabsSource.indexOf("if (!canManageMemberships) return null;");
    const tablistIdx = tabsSource.indexOf('role="tablist"');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(tablistIdx).toBeGreaterThan(guardIdx);
  });

  it("2/3. Staff (canManageMemberships=false) never renders any tab, including Membership Types and Waivers — the whole component returns null, not a filtered one-tab strip", () => {
    expect(tabsSource).toContain("interface Props {\n  canManageMemberships: boolean;\n}");
    // No conditional per-tab filtering exists — the TABS array is static
    // and unconditional; visibility is gated once, at the component root.
    expect(tabsSource).not.toMatch(/TABS\.filter\(/);
  });

  it("4. the shared component itself (not each caller) owns the null-for-Staff behavior — a single return null guard before any JSX", () => {
    const propsIdx = tabsSource.indexOf("export default function MembersAreaTabs(");
    const guardIdx = tabsSource.indexOf("if (!canManageMemberships) return null;", propsIdx);
    const divIdx = tabsSource.indexOf("<div", propsIdx);
    expect(guardIdx).toBeGreaterThan(propsIdx);
    expect(guardIdx).toBeLessThan(divIdx);
  });

  it("5. Admin-only route redirects are completely unchanged by this visibility correction", () => {
    expect(readSource(TYPES_PAGE_PATH)).toContain('if (profile?.role !== "admin") redirect("/calendar");');
    expect(readSource(WAIVERS_PAGE_PATH)).toContain('if (profile?.role !== "admin") redirect("/calendar");');
  });

  it("6. no authorization/RPC change accompanies this fix — canManageMemberships is derived from the SAME getAuthProfile() read every page already performed, never a new query", () => {
    for (const path of [MEMBERS_PAGE_PATH, TYPES_PAGE_PATH, WAIVERS_PAGE_PATH]) {
      const s = readSource(path);
      const getAuthProfileCalls = s.match(/getAuthProfile\(\)/g) ?? [];
      expect(getAuthProfileCalls.length).toBe(1);
    }
    expect(tabsSource).not.toMatch(/getAuthProfile|supabase\.rpc|createClient/);
  });

  it("7. mobile behavior for the Admin-visible tab strip is unchanged (overflow-x-auto / whitespace-nowrap still present)", () => {
    expect(tabsSource).toContain("overflow-x-auto");
    expect(tabsSource).toContain("whitespace-nowrap");
  });

  it("8. no additional component was created for the Staff (no-tabs) case — MembersAreaTabs.tsx remains the only file, now simply returning null for that one prop value", () => {
    const dirEntries = readdirSync(join(process.cwd(), "src/app/(app)/admin/members"), { withFileTypes: true });
    const tabFiles = dirEntries.filter((e) => e.isFile() && /tabs?/i.test(e.name));
    expect(tabFiles.map((e) => e.name)).toEqual(["MembersAreaTabs.tsx"]);
  });

  it("9. no migration was created for this fix", () => {
    const files = readdirSync(join(process.cwd(), "supabase/migrations"));
    const beyond = files.filter((f) => {
      const match = f.match(/^(\d+)_/);
      return match !== null && Number(match[1]) > 196;
    });
    expect(beyond).toEqual([]);
  });

  it("10. 0196 remains untouched", () => {
    const migrationSql = readSource(MIGRATION_0196_PATH);
    expect(migrationSql).toContain("create table public.waiver_document_files");
    expect(migrationSql).toContain("create or replace function public.publish_waiver_pdf_version(");
  });

  it("does not expose role names or client-side authorization logic beyond the narrow boolean prop", () => {
    expect(tabsSource).not.toMatch(/["']admin["']|["']staff["']|profile\.role|userRole/);
  });
});

describe("2/3. shared tabs — route-backed, active-state derives from pathname, keyboard/mobile safe", () => {
  const s = readSource(TABS_PATH);

  it('"use client" — usePathname requires the browser router context', () => {
    expect(s.trimStart().startsWith('"use client"')).toBe(true);
    expect(s).toContain('import { usePathname } from "next/navigation";');
  });

  it("route-backed: real <Link> elements to the three real routes, not a client-only useState tab switch", () => {
    expect(s).toContain('import Link from "next/link";');
    expect(s).toContain('href: "/admin/members"');
    expect(s).toContain('href: "/admin/members/types"');
    expect(s).toContain('href: "/admin/members/waivers"');
    expect(s).not.toMatch(/useState<Tab>|useState\(["'](members|types|waivers)["']\)/);
  });

  it("3. active tab derives from the current pathname (exact match), not any local component state", () => {
    expect(s).toContain("const isActive = pathname === tab.href;");
  });

  it("keyboard accessible — real <Link> (natively focusable/activatable), explicit tab/tablist roles, visible focus ring", () => {
    expect(s).toContain('role="tablist"');
    expect(s).toContain('role="tab"');
    expect(s).toContain("aria-selected={isActive}");
    expect(s).toContain("focus-visible:ring");
  });

  it("20. mobile-safe: horizontal scroll container, no-wrap labels — never forces page-level horizontal overflow", () => {
    expect(s).toContain("overflow-x-auto");
    expect(s).toContain("whitespace-nowrap");
  });

  it("reuses the existing segmented-control visual language rather than inventing a new framework", () => {
    expect(s).toContain("bg-gray-100 dark:bg-gray-800 rounded-xl");
    expect(s).toContain("bg-white dark:bg-gray-700");
  });

  it("never renders on the Member Detail drill-down page — [id]/page.tsx does not import it", () => {
    const detailPage = readSource("src/app/(app)/admin/members/[id]/page.tsx");
    expect(detailPage).not.toMatch(/MembersAreaTabs/);
  });
});

describe("4. direct route refresh works structurally — each tab is a real Server Component page, not a client-only route", () => {
  for (const [label, path] of [
    ["Members", MEMBERS_PAGE_PATH],
    ["Membership Types", TYPES_PAGE_PATH],
    ["Waivers", WAIVERS_PAGE_PATH],
  ] as const) {
    it(`${label} page is an async Server Component default export (no "use client" at the top) — Next.js serves it fully on a direct/refresh request`, () => {
      const s = readSource(path);
      expect(s.trimStart().startsWith('"use client"')).toBe(false);
      expect(s).toMatch(/export default async function/);
    });
  }
});

describe("5/19. Members tab roster behavior and Staff authorization are unchanged", () => {
  it("admin/members/page.tsx still gates on isOperator (Admin+Staff) exactly as before — not narrowed or widened by this move", () => {
    const s = readSource(MEMBERS_PAGE_PATH);
    expect(s).toContain('if (!isOperator(profile?.role)) redirect("/calendar");');
  });

  it("still renders MembersClient with the same established props — roster/search/Add Member/import/invite behavior is untouched by this checkpoint", () => {
    const s = readSource(MEMBERS_PAGE_PATH);
    expect(s).toContain("<MembersClient");
    expect(s).toContain("members={membersWithWaiver}");
    expect(s).toContain("rosterMembers={rosterMembersWithWaiver}");
    expect(s).toContain("pendingInvites={pendingInvites}");
    expect(s).toContain("membershipsEnabled={membershipsEnabled}");
    expect(s).toContain("membershipTypes={membershipTypes}");
    expect(s).toContain("hasMemberWaiverConfigured={hasMemberWaiverConfigured}");
  });

  it("MembersClient.tsx itself was not touched by this checkpoint (only the page wrapping it gained a tab strip)", () => {
    const s = readSource(MEMBERS_CLIENT_PATH);
    expect(s).not.toMatch(/MembersAreaTabs/);
  });
});

describe("13/14. existing PDF upload/finalize/view architecture is reused verbatim, not rewritten", () => {
  const s = readSource(WAIVER_PDF_ACTIONS_PATH);

  it("the same four Server Actions still exist with the same names/signatures", () => {
    expect(s).toContain("export async function authorizeWaiverPdfUploadAction(");
    expect(s).toContain("export async function finalizeWaiverPdfUploadAction(");
    expect(s).toContain("export async function discardWaiverDraftAction(");
    expect(s).toContain("export async function getAdminWaiverPdfViewUrlAction(");
  });

  it("private Storage / signed upload / guarded orphan cleanup / immutable publish are untouched", () => {
    expect(s).toContain(".createSignedUploadUrl(path,");
    expect(s).toContain("{ upsert: false }");
    expect(s).toContain("async function removeUploadIfUnpublished(");
    expect(s).toContain('privileged.rpc("publish_waiver_pdf_version", {');
    expect(s).toContain('%PDF-');
    expect(s).toContain("createHash(\"sha256\")");
    expect(s).toContain("WAIVER_PDF_MAX_BYTES");
  });

  it("the moved MemberWaiverSection/GuestWaiverSection still import these exact Server Actions (by absolute path, since the actions themselves stayed in admin/settings/)", () => {
    const memberSection = readSource("src/app/(app)/admin/members/MemberWaiverSection.tsx");
    const guestSection = readSource("src/app/(app)/admin/members/GuestWaiverSection.tsx");
    expect(memberSection).toContain('from "@/app/(app)/admin/settings/waiverPdfActions"');
    expect(guestSection).toContain('from "@/app/(app)/admin/settings/waiverPdfActions"');
  });
});

describe("12. Member and Guest waiver management remain completely independent after the move", () => {
  it("MemberWaiverSection and GuestWaiverSection are still two separate, duplicated files (not merged into one shared component)", () => {
    expect(() => readSource("src/app/(app)/admin/members/MemberWaiverSection.tsx")).not.toThrow();
    expect(() => readSource("src/app/(app)/admin/members/GuestWaiverSection.tsx")).not.toThrow();
  });

  it("the Waivers page passes independently-resolved props to each — never a shared/reused variable between them", () => {
    const s = readSource(WAIVERS_PAGE_PATH);
    const memberPropsIdx = s.indexOf("<MemberWaiverSection");
    const memberPropsBlock = s.slice(memberPropsIdx, s.indexOf("/>", memberPropsIdx));
    expect(memberPropsBlock).not.toMatch(/guestWaiverRow|currentGuestDocument|legacyGuestDraft/);
    const guestPropsIdx = s.indexOf("<GuestWaiverSection");
    const guestPropsBlock = s.slice(guestPropsIdx, s.indexOf("/>", guestPropsIdx));
    expect(guestPropsBlock).not.toMatch(/waiverRow\?|currentMemberDocument|legacyMemberDraft/);
  });
});

describe("15/16. revalidation targets the new route, and still refreshes /profile + /waivers/member", () => {
  it("the settings-actions.ts waiver actions revalidate /admin/members/waivers, never a stale /admin/settings target", () => {
    const s = readSource(SETTINGS_ACTIONS_PATH);
    for (const name of [
      "createMemberWaiverDraftAction", "updateMemberWaiverDraftAction",
      "publishMemberWaiverVersionAction", "setMemberWaiverRequiredAction",
      "createGuestWaiverDraftAction", "updateGuestWaiverDraftAction",
      "publishGuestWaiverVersionAction", "setGuestWaiverRequiredAction",
    ]) {
      const start = s.indexOf(`export async function ${name}(`);
      expect(start, `${name} not found`).toBeGreaterThan(-1);
      const nextIdx = s.indexOf("\nexport async function", start + 1);
      const fn = s.slice(start, nextIdx > -1 ? nextIdx : undefined);
      expect(fn).toContain('revalidatePath("/admin/members/waivers");');
      expect(fn).not.toContain('revalidatePath("/admin/settings");');
    }
  });

  it("the membership-types actions revalidate /admin/members/types", () => {
    const s = readSource(SETTINGS_ACTIONS_PATH);
    for (const name of ["createMembershipTypeAction", "updateMembershipTypeAction", "setMembershipTypeActiveAction"]) {
      const start = s.indexOf(`export async function ${name}(`);
      const nextIdx = s.indexOf("\nexport async function", start + 1);
      const fn = s.slice(start, nextIdx > -1 ? nextIdx : undefined);
      expect(fn).toContain('revalidatePath("/admin/members/types");');
    }
  });

  it("finalizeWaiverPdfUploadAction and discardWaiverDraftAction revalidate /admin/members/waivers, and finalize still preserves /waivers/member + /profile", () => {
    const s = readSource(WAIVER_PDF_ACTIONS_PATH);
    const finalizeStart = s.indexOf("export async function finalizeWaiverPdfUploadAction(");
    const finalizeEnd = s.indexOf("\nasync function removeUploadIfUnpublished(");
    const finalizeFn = s.slice(finalizeStart, finalizeEnd);
    expect(finalizeFn).toContain('revalidatePath("/admin/members/waivers");');
    expect(finalizeFn).toContain('revalidatePath("/waivers/member");');
    expect(finalizeFn).toContain('revalidatePath("/profile");');
    expect(finalizeFn).not.toContain('revalidatePath("/admin/settings");');

    const discardStart = s.indexOf("export async function discardWaiverDraftAction(");
    const discardFn = s.slice(discardStart);
    expect(discardFn).toContain('revalidatePath("/admin/members/waivers");');
  });

  it("updateClubMembershipsEnabled still revalidates the whole layout (unaffected by this move — layout-level revalidation already cascades to /admin/members/types)", () => {
    const s = readSource(SETTINGS_ACTIONS_PATH);
    const start = s.indexOf("export async function updateClubMembershipsEnabled(");
    const nextIdx = s.indexOf("\nexport async function", start + 1);
    const fn = s.slice(start, nextIdx > -1 ? nextIdx : undefined);
    expect(fn).toContain('revalidatePath("/", "layout");');
  });
});

describe("17/18. Admin-only authorization is preserved for Membership Types and Waiver authoring", () => {
  it("Membership Types page redirects any non-admin via the existing product pattern", () => {
    const s = readSource(TYPES_PAGE_PATH);
    expect(s).toContain('if (profile?.role !== "admin") redirect("/calendar");');
  });

  it("Waivers page redirects any non-admin via the same existing product pattern — Staff does not gain waiver authoring through this move", () => {
    const s = readSource(WAIVERS_PAGE_PATH);
    expect(s).toContain('if (profile?.role !== "admin") redirect("/calendar");');
  });

  it("neither new Admin-only page references isOperator/Staff at all — Staff's existing read-only compliance visibility lives elsewhere (Member Detail, roster pills) and is untouched", () => {
    for (const path of [TYPES_PAGE_PATH, WAIVERS_PAGE_PATH]) {
      const s = readSource(path);
      expect(s).not.toMatch(/isOperator|isStaff/);
    }
  });
});

describe("21/22/23. scope guards — no migration, 0196 untouched, no 0197", () => {
  it("no new migration was created for this checkpoint", () => {
    const files = readdirSync(join(process.cwd(), "supabase/migrations"));
    const beyond = files.filter((f) => {
      const match = f.match(/^(\d+)_/);
      return match !== null && Number(match[1]) > 196;
    });
    expect(beyond).toEqual([]);
  });

  it("0196 remains untouched", () => {
    const migrationSql = readSource(MIGRATION_0196_PATH);
    expect(migrationSql).toContain("create table public.waiver_document_files");
    expect(migrationSql).toContain("create or replace function public.publish_waiver_pdf_version(");
  });

  it("no Guest invitation/acceptance/notification/public-route implementation exists in any touched file", () => {
    for (const path of [MEMBERS_PAGE_PATH, TYPES_PAGE_PATH, WAIVERS_PAGE_PATH, TABS_PATH]) {
      const s = readSource(path);
      expect(s).not.toMatch(/guest_waiver_invitation|guest_waiver_acceptance|resolve_guest_waiver_invitation|accept_guest_waiver/i);
    }
  });
});

describe("24. Guest != Non-Member taxonomy — documented, not implemented (locked for a later checkpoint)", () => {
  it("the Waivers page's Guest Waiver copy never conflates Guest with membership_status='non_member', and never claims Guest acceptance/invitations exist yet", () => {
    const s = readSource(WAIVERS_PAGE_PATH);
    expect(s).not.toMatch(/non_member/i);
    expect(s).not.toMatch(/review and accept|required to accept/i);
  });

  // Locked taxonomy (documentation only — no code enforces this here):
  //   roster_member.membership_status: active | inactive | suspended | non_member
  //   Guest: a participation-scoped reservation/event Guest (reservation_
  //   guests/event_guests) — a structurally different identity slot, NEVER
  //   automatically created or implied by a roster_member's membership_
  //   status changing to 'non_member'. Guest-to-Member conversion and
  //   Guest waiver invitations remain out of scope (Phase 43B-4A+).
  it("no file in this checkpoint implements Guest-to-Member conversion or treats non_member as a Guest identity", () => {
    for (const path of [MEMBERS_PAGE_PATH, TYPES_PAGE_PATH, WAIVERS_PAGE_PATH]) {
      const s = readSource(path);
      expect(s).not.toMatch(/convertToMember|guestToMember|non_member.*[Gg]uest|[Gg]uest.*non_member/);
    }
  });
});
