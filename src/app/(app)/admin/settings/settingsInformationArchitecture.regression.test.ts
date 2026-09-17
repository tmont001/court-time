import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 34G-B — Settings & Payment Configuration Cleanup, including the
// hierarchy correction (three top-level Payments sections collapsed back
// into ONE "Payments" section with two internal groups: Payment Tracking,
// then Online Payments {Stripe Account, Court Time Payments}). Covers the
// durable product invariants from the 34G-B implementation spec: section
// ordering/grouping, component separation, the ON/OFF gating fix, the new
// copy, Staff-Managed enforcement at the UI layer, Stripe Account
// logic/auth preservation, the continued absence of tier mutation, and
// the continued absence of a Connected gate on Member Announcements.
// Money-safety/server-side invariants (the RPCs themselves) are already
// covered by pricingPackagingProvisioning.regression.test.ts and
// stripeConnect.regression.test.ts — this file is UI/IA-focused and does
// not duplicate those.
//
// "No migration/RPC architecture change in 34G-B" is a checkpoint-
// specific validation fact (git diff / STOP-report scope), not a durable
// application invariant, and is deliberately NOT asserted via a hardcoded
// migration-number ceiling here — the first legitimate future migration
// would make an evergreen regression suite fail for a completely correct
// reason. What IS a durable invariant, and is asserted below, is that
// this checkpoint's changed files never call any RPC beyond the ones this
// feature already used.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const PAGE_PATH = "src/app/(app)/admin/settings/page.tsx";
const PAYMENT_TRACKING_SECTION_PATH = "src/app/(app)/admin/settings/PaymentTrackingSection.tsx";
const STRIPE_CONNECT_SECTION_PATH = "src/app/(app)/admin/settings/StripeConnectSection.tsx";
const COURT_TIME_PAYMENTS_SECTION_PATH = "src/app/(app)/admin/settings/CourtTimePaymentsSection.tsx";
const ANNOUNCEMENTS_SECTION_PATH = "src/app/(app)/admin/communications/AnnouncementsSection.tsx";
const OVERVIEW_PAGE_PATH = "src/app/(app)/admin/overview/page.tsx";

// Admin IA Checkpoint 5 — Final Club Settings Regroup. Every subsection
// label below shares the exact same className string
// ("text-xs font-semibold uppercase tracking-wider text-gray-500
// dark:text-gray-400") at the exact same indentation — this helper locates
// one unambiguously by requiring the label text to be the very next line
// after that class string closes.
function subsectionMarker(label: string): string {
  return `text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">\n              ${label}\n            </p>`;
}

const GROUP_CLUB_PROFILE = '<h2 className="text-base font-bold text-gray-900 dark:text-gray-100">Club Profile</h2>';
const GROUP_MEMBERSHIPS_WAIVERS = '<h2 className="text-base font-bold text-gray-900 dark:text-gray-100">Memberships & Waivers</h2>';
const GROUP_PRICING_PAYMENTS = '<h2 className="text-base font-bold text-gray-900 dark:text-gray-100">Pricing & Payments</h2>';
const GROUP_PLAN_ACCESS = '<h2 className="text-base font-bold text-gray-900 dark:text-gray-100">Plan & Access</h2>';

// ═══════════════════════════════════════════════════════════════════════════
// 1-11 — the final Club Settings IA (Admin IA Checkpoint 5, then Phase
// 42C-3B's Memberships split-out). The original three-group design
// (Club Profile, Pricing & Payments, Plan & Access) gained a fourth group,
// Memberships, between Club Profile and Pricing & Payments — a frontend-
// only reorganization moving the existing MembershipsSection toggle out
// of Pricing & Payments and adding Membership Types management alongside
// it, per the locked 42C-3B product direction.
// ═══════════════════════════════════════════════════════════════════════════

describe("1. /admin/settings remains Admin-only", () => {
  it("the page gate is unchanged: unauthenticated -> /sign-in, non-admin -> /calendar", () => {
    const s = readSource(PAGE_PATH);
    expect(s).toContain('if (!user) redirect("/sign-in");');
    expect(s).toContain('if (profile?.role !== "admin") redirect("/calendar");');
  });
});

describe("2. page title is 'Club Settings'", () => {
  it("Header screenTitle reads 'Club Settings', not bare 'Settings'", () => {
    const s = readSource(PAGE_PATH);
    expect(s).toContain('<Header screenTitle="Club Settings" />');
  });
});

describe("17-19. existing Settings actions/RPC behavior is unchanged; no migration; no payment-domain mutation", () => {
  it("17. actions.ts still exports the original six functions, calling the same RPCs with the same argument shapes (0184 correction pass — a genuinely new seventh function/RPC, updateClubRulesAndPolicies, was added on top; see its own dedicated regression coverage in clubRulesAndPolicies.regression.test.ts)", () => {
    const s = readSource("src/app/(app)/admin/settings/actions.ts");
    expect(s).toContain('supabase.rpc("update_club_timezone", { p_timezone: timezone });');
    expect(s).toContain('supabase.rpc("update_club_name", { p_name: clubName });');
    expect(s).toContain("supabase.rpc(\"update_club_pricing\", {");
    expect(s).toContain('supabase.rpc("update_club_theme", { p_theme_key: themeKey });');
    expect(s).toContain('.from("club-logos")');
  });

  it("18. no UNEXPECTED RPC surface was introduced — actions.ts calls exactly the seventeen now-current RPCs (the thirteen pre-43B-2B ones plus 43B-2B's own four Guest Waiver authoring RPCs), nothing beyond that (indirect, non-migration-ceiling evidence this checkpoint's IA change carries no OTHER RPC surface change)", () => {
    // Deliberately not a "highest migration === N" check — see this file's
    // own header comment on why that pattern is invalid across checkpoints.
    // This count is intentionally NOT frozen forever: it tracks the actual,
    // current RPC surface of this file, and is bumped deliberately (with a
    // comment) whenever a real, reviewed RPC is added — exactly as it was
    // bumped here (Phase 42C-3B added createMembershipTypeAction/
    // updateMembershipTypeAction/setMembershipTypeActiveAction), again
    // for Phase 43A-2 (createMemberWaiverDraftAction/
    // updateMemberWaiverDraftAction/publishMemberWaiverVersionAction/
    // setMemberWaiverRequiredAction — no Admin-proxy acceptance action
    // exists in this file or anywhere else), and again here (Phase 43B-2B
    // added createGuestWaiverDraftAction/updateGuestWaiverDraftAction/
    // publishGuestWaiverVersionAction/setGuestWaiverRequiredAction —
    // likewise no Guest acceptance action anywhere in this file).
    const s = readSource("src/app/(app)/admin/settings/actions.ts");
    expect((s.match(/\.rpc\(/g) ?? []).length).toBe(17);
    expect(s).toContain('supabase.rpc("update_club_rules_and_policies", {');
    expect(s).toContain('supabase.rpc("update_club_memberships_enabled", {');
    expect(s).toContain('supabase.rpc("create_membership_type", {');
    expect(s).toContain('supabase.rpc("update_membership_type", {');
    expect(s).toContain('supabase.rpc("set_membership_type_active", {');
    expect(s).toContain('supabase.rpc("create_member_waiver_draft", {');
    expect(s).toContain('supabase.rpc("update_member_waiver_draft", {');
    expect(s).toContain('supabase.rpc("publish_member_waiver_version", {');
    expect(s).toContain('supabase.rpc("set_member_waiver_required", {');
    expect(s).toContain('supabase.rpc("create_guest_waiver_draft", {');
    expect(s).toContain('supabase.rpc("update_guest_waiver_draft", {');
    expect(s).toContain('supabase.rpc("publish_guest_waiver_version", {');
    expect(s).toContain('supabase.rpc("set_guest_waiver_required", {');
    expect(s).not.toMatch(/accept_member_waiver|accept_guest_waiver/);
  });

  it("19. no payment-domain mutation was introduced — page.tsx itself performs no .rpc( or mutation, only reads plus prop-passing to unchanged child components", () => {
    const s = readSource(PAGE_PATH);
    expect(s).not.toMatch(/\.rpc\(/);
    expect(s).not.toMatch(/\.update\(|\.insert\(|\.delete\(/);
  });
});

describe("3-4. exactly four top-level visual groups exist, in the locked order: Club Profile, Memberships & Waivers, Pricing & Payments, Plan & Access (Phase 43B-3E2 restyled the Phase 43B-3E discoverability link as a normal group, matching the surrounding page's own visual rhythm — it still carries zero live Memberships/Waiver controls, only a heading, copy, and a link)", () => {
  it("all four group headings exist exactly once each", () => {
    const s = readSource(PAGE_PATH);
    expect((s.match(/<h2 className="text-base font-bold text-gray-900 dark:text-gray-100">/g) ?? []).length).toBe(4);
    expect(s).toContain(GROUP_CLUB_PROFILE);
    expect(s).toContain(GROUP_MEMBERSHIPS_WAIVERS);
    expect(s).toContain(GROUP_PRICING_PAYMENTS);
    expect(s).toContain(GROUP_PLAN_ACCESS);
  });

  it("group order is Club Profile, then Memberships & Waivers, then Pricing & Payments, then Plan & Access", () => {
    const s = readSource(PAGE_PATH);
    const clubProfileIdx = s.indexOf(GROUP_CLUB_PROFILE);
    const membershipsWaiversIdx = s.indexOf(GROUP_MEMBERSHIPS_WAIVERS);
    const pricingPaymentsIdx = s.indexOf(GROUP_PRICING_PAYMENTS);
    const planAccessIdx = s.indexOf(GROUP_PLAN_ACCESS);
    expect(clubProfileIdx).toBeGreaterThan(-1);
    expect(membershipsWaiversIdx).toBeGreaterThan(clubProfileIdx);
    expect(pricingPaymentsIdx).toBeGreaterThan(membershipsWaiversIdx);
    expect(planAccessIdx).toBeGreaterThan(pricingPaymentsIdx);
  });

  it("no tabs, accordions (<details>), or subroutes were introduced — one flat page", () => {
    const s = readSource(PAGE_PATH);
    expect(s).not.toMatch(/searchParams/);
    expect(s).not.toMatch(/<details/);
    expect(s).not.toMatch(/\?tab=/);
  });
});

describe("4a. Memberships & Waivers (Phase 43B-3E, restyled 43B-3E2) — relocated to /admin/members/*, only a lightweight discoverability GROUP remains on Settings", () => {
  it("no Memberships control (toggle, Membership Types, Member Waiver, Guest Waiver) renders on /admin/settings — no duplicate live management surface", () => {
    const s = readSource(PAGE_PATH);
    expect(s).not.toMatch(/<MembershipsSection|<MembershipTypesSection|<MemberWaiverSection|<GuestWaiverSection/);
    expect(s).not.toMatch(/import MembershipsSection|import MembershipTypesSection|import MemberWaiverSection|import GuestWaiverSection/);
  });

  it("the 'Memberships & Waivers' group (heading + copy + a normal secondary link button to /admin/members) sits between Club Profile and Pricing & Payments", () => {
    const s = readSource(PAGE_PATH);
    const clubProfileIdx = s.indexOf(GROUP_CLUB_PROFILE);
    const pricingIdx = s.indexOf(GROUP_PRICING_PAYMENTS);
    const groupIdx = s.indexOf(GROUP_MEMBERSHIPS_WAIVERS);
    expect(groupIdx).toBeGreaterThan(clubProfileIdx);
    expect(groupIdx).toBeLessThan(pricingIdx);
    expect(s).toContain('href="/admin/members"');
    expect(s).toContain("Manage members, membership types, and waivers.");
  });

  it("the link renders as a normal Court Time secondary button (ACTION_BUTTON_SECONDARY), not a special bordered card or a bare text link", () => {
    const s = readSource(PAGE_PATH);
    expect(s).toContain('import { ACTION_BUTTON_SECONDARY } from "@/components/styles/actionButtonStyles";');
    const groupIdx = s.indexOf(GROUP_MEMBERSHIPS_WAIVERS);
    const nextGroupIdx = s.indexOf(GROUP_PRICING_PAYMENTS);
    const group = s.slice(groupIdx, nextGroupIdx);
    expect(group).toContain('<Link href="/admin/members" className={ACTION_BUTTON_SECONDARY}>');
    expect(group).not.toMatch(/rounded-xl border border-gray-200 dark:border-gray-700 px-4 py-3\.5 flex items-center justify-between/);
  });

  it("membership_types is read only on its new home (/admin/members/types), not duplicated on /admin/settings", () => {
    const settingsSource = readSource(PAGE_PATH);
    expect(settingsSource).not.toMatch(/\.from\("membership_types"\)/);
    const typesPageSource = readSource("src/app/(app)/admin/members/types/page.tsx");
    expect(typesPageSource).toContain('.from("membership_types")');
    expect(typesPageSource).not.toMatch(/\.rpc\(\s*"[a-z_]*membership_type/i);
  });

  it("/admin/settings still reads club_settings exactly once — memberships_enabled is still needed there for PricingSettingsForm's own non-member-pricing display", () => {
    const s = readSource(PAGE_PATH);
    const clubSettingsMatches = s.match(/\.from\("club_settings"\)/g) ?? [];
    expect(clubSettingsMatches.length).toBe(1);
    expect(s).toContain("const membershipsEnabled = settings?.memberships_enabled ?? true;");
  });
});

describe("5-6. Branding and Timezone are under Club Profile", () => {
  it("Branding and Timezone subsection labels both appear between the Club Profile heading and the Pricing & Payments heading", () => {
    const s = readSource(PAGE_PATH);
    const groupStart = s.indexOf(GROUP_CLUB_PROFILE);
    const groupEnd = s.indexOf(GROUP_PRICING_PAYMENTS);
    const group = s.slice(groupStart, groupEnd);
    expect(group).toContain(subsectionMarker("Branding"));
    expect(group).toContain(subsectionMarker("Timezone"));
    expect(group).toContain("<ClubBrandingSection");
    expect(group).toContain("<ClubTimezoneSection");
  });

  it("Branding precedes Timezone within Club Profile", () => {
    const s = readSource(PAGE_PATH);
    const brandingIdx = s.indexOf(subsectionMarker("Branding"));
    const timezoneIdx = s.indexOf(subsectionMarker("Timezone"));
    expect(brandingIdx).toBeGreaterThan(-1);
    expect(timezoneIdx).toBeGreaterThan(brandingIdx);
  });
});

describe("7-10. Pricing, Payment Tracking, Stripe Account, and Court Time Payments are all under Pricing & Payments", () => {
  function pricingPaymentsGroup(): string {
    const s = readSource(PAGE_PATH);
    const groupStart = s.indexOf(GROUP_PRICING_PAYMENTS);
    const groupEnd = s.indexOf(GROUP_PLAN_ACCESS);
    return s.slice(groupStart, groupEnd);
  }

  it("the Pricing subsection (PricingSettingsForm) is inside the Pricing & Payments group", () => {
    const group = pricingPaymentsGroup();
    expect(group).toContain(subsectionMarker("Pricing"));
    expect(group).toContain("<PricingSettingsForm");
  });

  it("the Payments subsection (Payment Tracking, Stripe Account, Court Time Payments) is inside the Pricing & Payments group, with Pricing preceding it", () => {
    const group = pricingPaymentsGroup();
    expect(group).toContain(subsectionMarker("Payments"));
    expect(group).toContain("<PaymentTrackingSection");
    expect(group).toContain("<StripeConnectSection");
    expect(group).toContain("<CourtTimePaymentsSection");

    const pricingLabelIdx = group.indexOf(subsectionMarker("Pricing"));
    const paymentsLabelIdx = group.indexOf(subsectionMarker("Payments"));
    expect(paymentsLabelIdx).toBeGreaterThan(pricingLabelIdx);
  });

  it("within Payments, Payment Tracking precedes the Online Payments subgroup, which orders Stripe Account before Court Time Payments (unchanged internal ordering)", () => {
    const group = pricingPaymentsGroup();
    const trackingIdx = group.indexOf("<PaymentTrackingSection");
    // The section's own explanatory JSX comment also mentions "Online
    // Payments" in prose above the marker itself — search from trackingIdx
    // onward so the actual heading, not the comment, is what's found.
    const onlinePaymentsHeadingIdx = group.indexOf("Online Payments", trackingIdx);
    const stripeIdx = group.indexOf("<StripeConnectSection");
    const courtTimeIdx = group.indexOf("<CourtTimePaymentsSection");

    expect(trackingIdx).toBeGreaterThan(-1);
    expect(onlinePaymentsHeadingIdx).toBeGreaterThan(trackingIdx);
    expect(stripeIdx).toBeGreaterThan(onlinePaymentsHeadingIdx);
    expect(courtTimeIdx).toBeGreaterThan(stripeIdx);
  });

  it("no separate top-level Pricing/Payment Tracking/Stripe Account/Court Time Payments group headings exist — each is a Pricing & Payments SUBSECTION, not its own group", () => {
    const s = readSource(PAGE_PATH);
    expect(s).not.toMatch(/<h2[^>]*>Pricing<\/h2>/);
    expect(s).not.toMatch(/<h2[^>]*>Payments<\/h2>/);
    expect(s).not.toMatch(/<h2[^>]*>Payment Tracking<\/h2>/);
    expect(s).not.toMatch(/<h2[^>]*>Stripe Account<\/h2>/);
    expect(s).not.toMatch(/<h2[^>]*>Court Time Payments<\/h2>/);
  });
});

describe("11. Operating Model is under Plan & Access", () => {
  it("the Operating Model subsection label and its read-only card are inside the Plan & Access group, which is the last group on the page", () => {
    const s = readSource(PAGE_PATH);
    const groupStart = s.indexOf(GROUP_PLAN_ACCESS);
    expect(groupStart).toBeGreaterThan(-1);
    const group = s.slice(groupStart);
    expect(group).toContain(subsectionMarker("Operating Model"));
    expect(group).toContain("memberSelfService");
    // Plan & Access is the final group — no fourth h2 heading follows it.
    expect(group.indexOf(GROUP_CLUB_PROFILE)).toBe(-1);
    expect(group.indexOf(GROUP_PRICING_PAYMENTS)).toBe(-1);
  });
});

describe("12-16. Courts, Event Types, Lesson Types, Announcements, and Delivery Diagnostics are not reintroduced", () => {
  it("Booking Rules, Operating Hours, and Special Closures (Courts) remain absent", () => {
    const s = readSource(PAGE_PATH);
    expect(s).not.toMatch(/── Booking Rules ──/);
    expect(s).not.toMatch(/── Operating Hours ──/);
    expect(s).not.toMatch(/── Special Closures ──/);
    expect(s).not.toContain("BookingRulesForm");
    expect(s).not.toContain("OperatingHoursEditor");
    expect(s).not.toContain("DateOverridesEditor");
  });

  it("Event Types and Lesson Types remain absent", () => {
    const s = readSource(PAGE_PATH);
    expect(s).not.toMatch(/── Event Types ──/);
    expect(s).not.toMatch(/── Lesson Types ──/);
    expect(s).not.toContain("EventTypesSection");
    expect(s).not.toContain("LessonTypesSection");
  });

  it("Member Announcements and Delivery Diagnostics remain absent", () => {
    const s = readSource(PAGE_PATH);
    expect(s).not.toMatch(/── Member Announcements ──/);
    expect(s).not.toMatch(/── Delivery diagnostics ──/i);
    expect(s).not.toContain("AnnouncementsSection");
    expect(s).not.toContain("DeliveryDiagnosticsSection");
  });

  it("exactly the four locked group headings exist — no fifth/sixth group for any relocated domain re-emerged (Memberships & Waivers, restyled as a real group in Phase 43B-3E2, is the one legitimate fourth group — carrying zero live Memberships/Waiver controls, only a discoverability link)", () => {
    const s = readSource(PAGE_PATH);
    expect((s.match(/<h2 className="text-base font-bold text-gray-900 dark:text-gray-100">/g) ?? []).length).toBe(4);
  });
});

describe("stale-link cleanup: Overview's Email/SMS delivery setup rows point at Communications Diagnostics, not Settings", () => {
  it("the Email delivery and SMS delivery setup-checklist rows link to /admin/communications?tab=diagnostics — that data no longer lives on /admin/settings", () => {
    const s = readSource(OVERVIEW_PAGE_PATH);
    expect(s).toContain('<SetupRow label="Email delivery"      done={emailConfigured}            href="/admin/communications?tab=diagnostics" optional />');
    expect(s).toContain('<SetupRow label="SMS delivery"        done={smsConfigured}              href="/admin/communications?tab=diagnostics" optional />');
  });

  it("the Overview quick-links row now reads 'Club Settings', matching the page's new title and SideNav's existing label", () => {
    const s = readSource(OVERVIEW_PAGE_PATH);
    expect(s).toContain('<Link href="/admin/settings" className="ct-row-interactive">\n                    Club Settings');
  });
});

describe("stale-copy cleanup: Pricing no longer references a 'below' court-rate override that moved to /admin/courts", () => {
  it("PricingSettingsForm's helper copy names the Courts page instead of a stale 'below' reference", () => {
    const s = readSource("src/app/(app)/admin/settings/PricingSettingsForm.tsx");
    expect(s).toContain("their own rate on the Courts page regardless.");
    expect(s).not.toMatch(/their own rate below regardless/);
  });
});

describe("20. responsive grouping stacks vertically at every width — no horizontal-only layout at narrow widths", () => {
  it("the page's outer container and every group are plain vertical flex/space-y stacks — no grid/flex-row wrapping the groups themselves", () => {
    const s = readSource(PAGE_PATH);
    expect(s).toContain('<div className="px-4 py-6 space-y-8 md:max-w-2xl md:mx-auto dark:text-gray-100">');
    // Each of the four <section> groups (Club Profile, Memberships &
    // Waivers, Pricing & Payments, Plan & Access) uses the SAME space-y-4
    // vertical stack — Phase 43B-3E2 removed the earlier one-off
    // space-y-2 bordered-card treatment so all four groups share one
    // consistent rhythm, never a grid or flex-row at the group level.
    expect((s.match(/<section className="space-y-4">/g) ?? []).length).toBe(4);
    expect(s).not.toMatch(/<section className="space-y-2">/);
  });

  it("no group or subsection wraps its content in a multi-column grid at any breakpoint", () => {
    const s = readSource(PAGE_PATH);
    expect(s).not.toMatch(/grid-cols-[2-9]/);
    expect(s).not.toMatch(/md:grid-cols|lg:grid-cols|sm:grid-cols/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 — standalone Offline Payments card no longer exists
// ═══════════════════════════════════════════════════════════════════════════

describe("34G-B/4. the standalone Offline Payments card is removed", () => {
  it("PaymentTrackingSection no longer renders an 'Offline payments' heading or its own bordered card", () => {
    const s = readSource(PAYMENT_TRACKING_SECTION_PATH);
    expect(s).not.toMatch(/Offline payments<\/p>/);
    expect(s).not.toMatch(/bg-gray-50 dark:bg-gray-800\/40/);
  });

  it("PaymentTrackingSection's render returns exactly ONE bordered toggle card (the Payment Tracking card itself) plus status/modal — not two sibling cards", () => {
    const s = readSource(PAYMENT_TRACKING_SECTION_PATH);
    const cardMarkers = s.match(/rounded-xl border border-gray-200 dark:border-gray-700 px-4 py-3\.5/g) ?? [];
    expect(cardMarkers.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5 — manual-payment explanatory copy remains present
// ═══════════════════════════════════════════════════════════════════════════

describe("34G-B/5. manual-payment explanatory copy remains present, folded into the Payment Tracking card as compact helper content", () => {
  it("the manual-payments-supported helper line exists, unconditional on trackingOn, and never implies manual payment history disappears", () => {
    const s = readSource(PAYMENT_TRACKING_SECTION_PATH);
    expect(s).toMatch(/Manual payments supported: Cash, check, card terminal, bank transfer, digital wallet,\s*\n\s*and other payments can be recorded by Admins\/Staff\./);
    // Unconditional: not gated behind a `trackingOn ?` ternary the way the
    // old standalone card's own text was.
    const helperIdx = s.indexOf("Manual payments supported");
    const precedingTernaryIdx = s.lastIndexOf("trackingOn\n            ?", helperIdx);
    expect(precedingTernaryIdx).toBe(-1);
  });

  it("the OFF-state Payment Tracking description still states existing balances and payment history remain available", () => {
    const s = readSource(PAYMENT_TRACKING_SECTION_PATH);
    expect(s).toMatch(/New bookings will not create payment balances\. Existing balances and payment history remain available\./);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6 — Payment Tracking toggle behavior unchanged
// ═══════════════════════════════════════════════════════════════════════════

describe("34G-B/6. Payment Tracking toggle behavior is unchanged by the hierarchy correction", () => {
  it("handleTrackingToggle still requires confirmation to turn OFF and submits immediately to turn ON", () => {
    const s = readSource(PAYMENT_TRACKING_SECTION_PATH);
    expect(s).toContain("setConfirmingDisableTracking(true);");
    expect(s).toContain("submitMode(nextModeForTrackingToggle(mode, true));");
    expect(s).toContain("submitMode(nextModeForTrackingToggle(mode, false));");
  });

  it("still resyncs local mode from the currentMode prop, and still mutates via the same shared Server Action", () => {
    const s = readSource(PAYMENT_TRACKING_SECTION_PATH);
    expect(s).toContain("setMode(currentMode);");
    expect(s).toContain("await updateClubPaymentModeAction(next, clubId)");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7 — Court Time Payments ON-gating unchanged
// ═══════════════════════════════════════════════════════════════════════════

describe("34G-B/7. Court Time Payments ON-gating (trackingOn && connected && stripeReady && not pending) is unchanged", () => {
  it("OFF -> ON (currently off) is blocked unless trackingOn && connected && stripeReady", () => {
    const s = readSource(COURT_TIME_PAYMENTS_SECTION_PATH);
    expect(s).toContain("if (isPending) return;");
    expect(s).toContain("if (!trackingOn || !connected || !stripeReady) return;");
    expect(s).toContain("submitMode(nextModeForOnlineToggle(mode, true));");
  });

  it("the ToggleSwitch disabled prop still reduces to isPending alone whenever onlineOn is true, and still folds the full ON-direction gate in whenever it's false", () => {
    const s = readSource(COURT_TIME_PAYMENTS_SECTION_PATH);
    expect(s).toContain("const onlineDisabled = isPending || (!onlineOn && (!trackingOn || !connected || !stripeReady));");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8 — Court Time Payments degraded-Stripe OFF behavior unchanged
// ═══════════════════════════════════════════════════════════════════════════

describe("34G-B/8. Court Time Payments ON -> OFF remains available even when Stripe has degraded — unchanged, and the degraded-while-on copy still shows", () => {
  it("ON -> OFF (currently on) is never blocked by trackingOn/connected/stripeReady — only isPending can block it", () => {
    const s = readSource(COURT_TIME_PAYMENTS_SECTION_PATH);
    const fnStart = s.indexOf("function handleOnlineToggle() {");
    const onlineOnBranchStart = s.indexOf("if (onlineOn) {", fnStart);
    const onlineOnBranchEnd = s.indexOf("if (!trackingOn || !connected || !stripeReady) return;", onlineOnBranchStart);
    const offBranch = s.slice(onlineOnBranchStart, onlineOnBranchEnd);
    expect(offBranch).not.toMatch(/if\s*\(.*(trackingOn|connected|stripeReady)/);
    expect(offBranch).toContain("submitMode(nextModeForOnlineToggle(mode, false));");
  });

  it("STRIPE_DEGRADED_WHILE_ON_COPY still exists, still computed only when onlineOn && !stripeReady, and no longer uses directional 'above' language now that Stripe Account and Court Time Payments are visually grouped", () => {
    const s = readSource(COURT_TIME_PAYMENTS_SECTION_PATH);
    expect(s).toContain("const degradedWhileOnReason = onlineOn && !stripeReady ? STRIPE_DEGRADED_WHILE_ON_COPY : null;");
    expect(s).toMatch(/Stripe reported an issue with this account\. Members can't start new online payments right now\. Resolve the Stripe issue, or turn Court Time Payments off\./);
    expect(s).not.toMatch(/Resolve the Stripe issue above/);
    expect(s).not.toMatch(/Resolve the Stripe issue below/);
  });

  it("the OFF-state copy still scopes to new charges and acknowledges pre-existing online-payable balances may remain, and no longer repeats the manual-payments explainer (that now lives once, under Payment Tracking)", () => {
    const s = readSource(COURT_TIME_PAYMENTS_SECTION_PATH);
    expect(s).toMatch(/Online payments are off for new charges\./);
    expect(s).toMatch(/Existing balances created while Court Time Payments was enabled may still be payable online\./);
    expect(s).not.toMatch(/Staff can continue recording payments received outside Court Time\./);
    expect(s).not.toMatch(/Members cannot pay balances online\./);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9 — Stripe Account auth/state machine unchanged
// ═══════════════════════════════════════════════════════════════════════════

describe("34G-B/9. StripeConnectSection's logic and authorization are unchanged — only directional cross-reference copy and its own module header comment were touched", () => {
  it("canConnect/handleConnect/deriveConnectUIState-based state machine are unchanged", () => {
    const s = readSource(STRIPE_CONNECT_SECTION_PATH);
    expect(s).toContain("const state = deriveConnectUIState(initialStatus.connected, initialStatus.cardPaymentsStatus);");
    expect(s).toContain('const canConnect = state === "not_connected" || state === "action_required";');
    expect(s).toContain("startStripeOnboardingAction(clubId)");
  });

  it("the five ConnectUIState display states still render their own distinct heading (Phase 34G-B readability correction: 'ready' is now 'Stripe account ready', never 'Ready for payments')", () => {
    const s = readSource(STRIPE_CONNECT_SECTION_PATH);
    for (const heading of ["Stripe account ready", "Pending review", "Onboarding incomplete", "Needs attention", "Not connected"]) {
      expect(s).toContain(heading);
    }
  });

  it("no Stripe API call shape, idempotency key, or account-creation param changed — this file makes no direct Stripe SDK call at all", () => {
    const s = readSource(STRIPE_CONNECT_SECTION_PATH);
    expect(s).not.toMatch(/stripe\.|\.v2\.core\.accounts/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10 — Staff-Managed still cannot enable Court Time Payments
// ═══════════════════════════════════════════════════════════════════════════

describe("34G-B/10. Staff-Managed clubs still cannot enable Court Time Payments from Settings", () => {
  it("the ON-direction gate includes !connected, and the disabled-reason copy names the Connected requirement", () => {
    const s = readSource(COURT_TIME_PAYMENTS_SECTION_PATH);
    expect(s).toContain('"Court Time Payments requires the Connected plan. Contact us to upgrade."');
  });

  it("`connected` is sourced from the same profile.memberSelfService value passed from page.tsx — never a client-supplied or independently-derived value", () => {
    const pageSrc = readSource(PAGE_PATH);
    expect(pageSrc).toMatch(/<CourtTimePaymentsSection[\s\S]{0,300}connected=\{memberSelfService\}/);
  });

  it("this component never calls activate_court_time_payments directly — the server-side capability check remains the sole authorization boundary", () => {
    const s = readSource(COURT_TIME_PAYMENTS_SECTION_PATH);
    expect(s).not.toMatch(/\.rpc\(\s*["']activate_court_time_payments["']/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 11 — Member Announcements has NOT gained a Connected entitlement gate
// ═══════════════════════════════════════════════════════════════════════════

// Admin IA Checkpoint 4: Member Announcements moved to
// /admin/communications (Compose tab) — see
// communicationsInformationArchitecture.regression.test.ts for that
// checkpoint's full coverage. This block only re-confirms the one durable
// invariant that originally lived here: no Connected/member_self_service
// gate was introduced by the move. The former describe(23-25) block that
// lived here (asserting the five-section Settings page from Checkpoint 4)
// is superseded by Admin IA Checkpoint 5's own describe(3-4)/(12-16) blocks
// above, which assert the current three-GROUP page instead.
describe("34G-B/11. Member Announcements (now Compose, at /admin/communications) still has no Connected/member_self_service gate", () => {
  it("AnnouncementsSection references no Connected/member_self_service gate", () => {
    const s = readSource(ANNOUNCEMENTS_SECTION_PATH);
    expect(s).not.toMatch(/memberSelfService|member_self_service|capability_not_available/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 12 — no migration or Server Action/RPC architecture change; no
//       tier-mutation control introduced
// ═══════════════════════════════════════════════════════════════════════════

describe("34G-B/12. no RPC surface change and no tier-mutation control — this checkpoint is UI/copy/grouping only", () => {
  it("none of the three payment components reference set_club_tier_for_operator or export a tier-mutation function (page.tsx's own Operating Model section legitimately documents WHY tier mutation stays privileged in prose — checked separately below via its actual absence of any .rpc( call, not a bare name match)", () => {
    for (const path of [PAYMENT_TRACKING_SECTION_PATH, STRIPE_CONNECT_SECTION_PATH, COURT_TIME_PAYMENTS_SECTION_PATH]) {
      const s = readSource(path);
      expect(s).not.toMatch(/set_club_tier_for_operator|setClubTier|updateClubTier|changeTier|upgradeTier/i);
    }
    const pageSrc = readSource(PAGE_PATH);
    expect(pageSrc).not.toMatch(/setClubTier|updateClubTier|changeTier|upgradeTier/i);
    expect(pageSrc).not.toMatch(/\.rpc\(\s*["']set_club_tier_for_operator["']/);
  });

  it("the Operating Model section in page.tsx remains read-only — no onClick/action=/.rpc( inside its own group, even after the Phase 34G-B copy/pill correction", () => {
    const s = readSource(PAGE_PATH);
    const idx = s.indexOf(GROUP_PLAN_ACCESS);
    expect(idx).toBeGreaterThan(-1);
    const sectionEnd = s.indexOf("</section>", idx);
    const section = s.slice(idx, sectionEnd);
    expect(section).not.toMatch(/onClick|action=|Server Action|\.rpc\(|set_club_tier_for_operator/);
    expect(section).toContain("memberSelfService");
    // Phase 34G-B (readability correction): the generic "Contact us to
    // change your plan." copy is replaced — see describe 15 below for the
    // full assertion on the new copy and its links. Two plain <Link>
    // elements (navigation) are not a mutation control.
    expect(section).toContain("Plan changes are managed by Court Time.");
    expect(section).not.toMatch(/Contact us to change your plan\./);
  });

  it("PaymentTrackingSection and CourtTimePaymentsSection call no RPC beyond updateClubPaymentModeAction (via the Server Action) — no new .rpc( call was introduced in either client component", () => {
    for (const path of [PAYMENT_TRACKING_SECTION_PATH, COURT_TIME_PAYMENTS_SECTION_PATH]) {
      const s = readSource(path);
      expect(s).not.toMatch(/\.rpc\(/);
      expect(s).toContain("await updateClubPaymentModeAction(next, clubId)");
    }
  });

  it("StripeConnectSection calls no RPC beyond startStripeOnboardingAction (via the Server Action)", () => {
    const s = readSource(STRIPE_CONNECT_SECTION_PATH);
    expect(s).not.toMatch(/\.rpc\(/);
    expect(s).toContain("startStripeOnboardingAction(clubId)");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 13-14 — Stripe ready state never says "Connected"; uses "Stripe ready";
//         distinguishes Stripe infrastructure from Court Time Payments
// ═══════════════════════════════════════════════════════════════════════════

describe("34G-B/13-14. the Stripe-ready state never collides with the Connected PLAN name — badge says 'Stripe ready', heading says 'Stripe account ready', and the explanatory copy names Court Time Payments as the separate feature that uses this account", () => {
  it("the ready-state badge is 'Stripe ready', never 'Connected'", () => {
    const s = readSource(STRIPE_CONNECT_SECTION_PATH);
    const readyBranchStart = s.indexOf('{state === "ready" && (');
    const readyBranchEnd = s.indexOf(")}", readyBranchStart);
    const readyBranch = s.slice(readyBranchStart, readyBranchEnd);
    expect(readyBranch).toContain("Stripe ready");
    expect(readyBranch).not.toMatch(/>\s*Connected\s*</);
  });

  it("the ready-state heading is 'Stripe account ready'", () => {
    const s = readSource(STRIPE_CONNECT_SECTION_PATH);
    expect(s).toContain('state === "ready" ? "Stripe account ready"');
  });

  it("the ready-state explanatory copy distinguishes Stripe infrastructure readiness from the separate Court Time Payments feature, and uses none of 'Connected'/'Connected plan'/'upgrade'", () => {
    const s = readSource(STRIPE_CONNECT_SECTION_PATH);
    expect(s).toContain(
      "Stripe has confirmed this account can accept card payments. Court Time Payments uses this Stripe account for online Member payments when enabled.",
    );
    const readyCopyStart = s.indexOf('{state === "ready"');
    const readyCopyEnd = s.indexOf(": state === \"pending\"", readyCopyStart);
    const readyCopy = s.slice(readyCopyStart, readyCopyEnd);
    expect(readyCopy).not.toMatch(/Connected|upgrade/i);
  });

  it("no other Stripe state (pending/action_required/unsupported/not_connected) was given a materially different meaning — only the ready state's heading/badge/copy changed", () => {
    const s = readSource(STRIPE_CONNECT_SECTION_PATH);
    expect(s).toContain("Stripe is reviewing this account. This can take a little while — no action is needed right now.");
    expect(s).toContain("Stripe needs a bit more information before this club can accept payments.");
    expect(s).toContain("This Stripe account needs attention. Contact support for help resolving it.");
    expect(s).toContain("Connect a Stripe account to prepare this club for Court Time Payments.");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 15 — Operating Model plan pills: explicit "Plan" naming, distinct styling
// ═══════════════════════════════════════════════════════════════════════════

describe("34G-B/15. Operating Model plan pills explicitly name themselves as plans, with Staff-Managed styled neutral and Connected styled with the existing green tokens", () => {
  it("the Staff-Managed pill reads 'Staff-Managed Plan'", () => {
    const s = readSource(PAGE_PATH);
    expect(s).toContain('{memberSelfService ? "Connected Plan" : "Staff-Managed Plan"}');
  });

  it("the Staff-Managed pill uses neutral gray/slate styling — never a warning/error/disabled treatment (amber/red/opacity)", () => {
    const s = readSource(PAGE_PATH);
    const pillStart = s.indexOf("rounded-full text-[10px] font-semibold uppercase tracking-wide border");
    expect(pillStart).toBeGreaterThan(-1);
    const pillBlock = s.slice(pillStart, pillStart + 400);
    expect(pillBlock).toMatch(/bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-600/);
    expect(pillBlock).not.toMatch(/amber|red|opacity-/);
  });

  it("Phase 34G-C3 supersedes this pill's original color choice — the Connected pill now applies the shared, token-backed .ct-brand-pill CSS class (globals.css, sourced from --ct-brand/--ct-brand-tint) rather than the generic Tailwind green scale, since this pill represents a Court Time commercial PRODUCT identity, not a status/readiness signal. StripeConnectSection's own 'Stripe ready' badge (a genuine readiness signal) is untouched and still uses the plain Tailwind green scale — see src/lib/courtTimeBrand.regression.test.ts for that distinction's own dedicated coverage, including proof that no #2F6B4F/#5EBA92 literal remains in this file (a correction pass moved the color values out of this JSX call site and into the centralized .ct-brand-pill definition).", () => {
    const s = readSource(PAGE_PATH);
    const pillStart = s.indexOf("rounded-full text-[10px] font-semibold uppercase tracking-wide border");
    const pillBlock = s.slice(pillStart, pillStart + 400);
    expect(pillBlock).toMatch(/"ct-brand-pill"/);
    expect(pillBlock).not.toMatch(/bg-green-50 dark:bg-green-900\/20 text-green-800 dark:text-green-400 border-green-200 dark:border-green-800/);
    expect(pillBlock).not.toMatch(/#2F6B4F|#5EBA92/);
  });

  it("Staff-Managed is never described with inferior/incomplete language — its own description remains the neutral, complete-feature-set statement", () => {
    const s = readSource(PAGE_PATH);
    expect(s).toContain("Full staff/operational functionality. Member self-service is not included on this plan.");
  });

  it("the Connected description is the locked, tightened copy naming the four self-service areas", () => {
    const s = readSource(PAGE_PATH);
    expect(s).toContain(
      "Everything in Staff-Managed, plus Member self-service for accounts, court booking, signup, and lesson requests.",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 16 — plan-change copy explains Court Time manages plan changes; Compare
//       plans links to /pricing; no tier-mutation control introduced
// ═══════════════════════════════════════════════════════════════════════════

describe("34G-B/16. the plan-change footer explains that Court Time manages plan changes, and 'Compare plans' links to /pricing — no mutation control", () => {
  it("the footer copy reads the locked sentence", () => {
    const s = readSource(PAGE_PATH);
    expect(s).toContain("Plan changes are managed by Court Time.");
    expect(s).toMatch(/to switch\.\s*<\/p>/);
  });

  it("'Compare plans' is a Link to /pricing", () => {
    const s = readSource(PAGE_PATH);
    expect(s).toMatch(/<Link href="\/pricing" className="text-accent hover:underline">\s*Compare plans\s*<\/Link>/);
  });

  it("'contact us' links to the existing /contact route — no new contact flow or support system was introduced", () => {
    const s = readSource(PAGE_PATH);
    expect(s).toMatch(/<Link href="\/contact" className="text-accent hover:underline">\s*contact us\s*<\/Link>/);
  });

  it("both links are plain navigation (<Link>) — neither is a form, onClick handler, or Server Action, so no tier-mutation control was introduced", () => {
    const s = readSource(PAGE_PATH);
    const idx = s.indexOf(GROUP_PLAN_ACCESS);
    const sectionEnd = s.indexOf("</section>", idx);
    const section = s.slice(idx, sectionEnd);
    expect(section).not.toMatch(/<form|onSubmit|useTransition|startTransition/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 17 — Court Time Payments disabled card no longer fades the entire card;
//       the toggle itself remains visibly disabled
// ═══════════════════════════════════════════════════════════════════════════

describe("34G-B/17. the Court Time Payments card stays fully readable when disabled — only the toggle itself shows disabled styling", () => {
  it("the outer card's className is a plain string with no conditional opacity expression", () => {
    const s = readSource(COURT_TIME_PAYMENTS_SECTION_PATH);
    expect(s).toContain('<div className="rounded-xl border border-gray-200 dark:border-gray-700 px-4 py-3.5">');
    expect(s).not.toMatch(/rounded-xl border border-gray-200 dark:border-gray-700 px-4 py-3\.5 \$\{/);
    expect(s).not.toMatch(/onlineDisabled[^`]*opacity-60/);
  });

  it("the ToggleSwitch itself still applies its own disabled styling (opacity-40 + cursor-not-allowed) and is still passed the unchanged onlineDisabled value", () => {
    const s = readSource(COURT_TIME_PAYMENTS_SECTION_PATH);
    expect(s).toContain('disabled ? "opacity-40 cursor-not-allowed" : ""');
    expect(s).toContain("disabled={onlineDisabled}");
  });

  it("the explanatory reason text elements (turnOnBlockedReason / degradedWhileOnReason) are unconditionally rendered at full readability — their own text color classes were not changed by this correction", () => {
    const s = readSource(COURT_TIME_PAYMENTS_SECTION_PATH);
    expect(s).toContain('className="mt-2 text-[11px] text-amber-600 dark:text-amber-400"');
    expect(s).toContain('className="mt-2 text-[11px] text-gray-400 dark:text-gray-500"');
  });

  it("this is presentation-only — onlineDisabled's own gating formula and the click handler's guards are byte-identical to before this correction", () => {
    const s = readSource(COURT_TIME_PAYMENTS_SECTION_PATH);
    expect(s).toContain("const onlineDisabled = isPending || (!onlineOn && (!trackingOn || !connected || !stripeReady));");
    expect(s).toContain("if (!trackingOn || !connected || !stripeReady) return;");
  });
});
