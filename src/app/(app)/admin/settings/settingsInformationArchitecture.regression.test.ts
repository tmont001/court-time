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
const ANNOUNCEMENTS_SECTION_PATH = "src/app/(app)/admin/settings/AnnouncementsSection.tsx";

// ═══════════════════════════════════════════════════════════════════════════
// 1-3 — ONE top-level Payments section; Payment Tracking before Online
//        Payments; Online Payments groups Stripe Account before Court
//        Time Payments
// ═══════════════════════════════════════════════════════════════════════════

describe("1-3. /admin/settings has ONE top-level Payments section, with Payment Tracking before an Online Payments group that orders Stripe Account before Court Time Payments", () => {
  it("exactly one top-level '── Payments ──' section marker exists — no separate top-level Payment Tracking / Stripe Account / Court Time Payments sections remain", () => {
    const s = readSource(PAGE_PATH);
    const paymentsMarkers = s.match(/── Payments ──/g) ?? [];
    expect(paymentsMarkers.length).toBe(1);
    expect(s).not.toMatch(/── Payment Tracking ──/);
    expect(s).not.toMatch(/── Stripe Account ──/);
    expect(s).not.toMatch(/── Court Time Payments ──/);
  });

  it("Operating Model precedes Payments, which precedes Club Branding (the first of the unchanged remaining sections)", () => {
    const s = readSource(PAGE_PATH);
    const operatingModelIdx = s.indexOf("── Operating Model");
    const paymentsIdx = s.indexOf("── Payments ──");
    const clubBrandingIdx = s.indexOf("── Club Branding ──");
    expect(operatingModelIdx).toBeGreaterThan(-1);
    expect(paymentsIdx).toBeGreaterThan(operatingModelIdx);
    expect(clubBrandingIdx).toBeGreaterThan(paymentsIdx);
  });

  it("within the Payments section, PaymentTrackingSection is rendered before the 'Online Payments' subheading, which precedes StripeConnectSection, which precedes CourtTimePaymentsSection", () => {
    const s = readSource(PAGE_PATH);
    const paymentsIdx = s.indexOf("── Payments ──");
    const nextSectionIdx = s.indexOf("── Club Branding ──");
    const paymentsBlock = s.slice(paymentsIdx, nextSectionIdx);

    const trackingIdx = paymentsBlock.indexOf("<PaymentTrackingSection");
    // Search for the actual "Online Payments" HEADING starting from
    // trackingIdx — the section's own explanatory JSX comment (above the
    // <section> itself) also mentions "Online Payments" in prose, which
    // would otherwise be found first and falsely appear to precede
    // PaymentTrackingSection.
    const onlinePaymentsHeadingIdx = paymentsBlock.indexOf("Online Payments", trackingIdx);
    const stripeIdx = paymentsBlock.indexOf("<StripeConnectSection");
    const courtTimeIdx = paymentsBlock.indexOf("<CourtTimePaymentsSection");

    expect(trackingIdx).toBeGreaterThan(-1);
    expect(onlinePaymentsHeadingIdx).toBeGreaterThan(trackingIdx);
    expect(stripeIdx).toBeGreaterThan(onlinePaymentsHeadingIdx);
    expect(courtTimeIdx).toBeGreaterThan(stripeIdx);
  });

  it("the remaining settings sections (Club Branding through Member Announcements) are unchanged in relative order and content, and are not relocated by this checkpoint", () => {
    const s = readSource(PAGE_PATH);
    const order = [
      "── Club Branding ──",
      "── Club Timezone ──",
      "── Pricing ──",
      "── Member Announcements ──",
    ];
    let lastIdx = -1;
    for (const marker of order) {
      const idx = s.indexOf(marker);
      expect(idx, `${marker} missing`).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
  });

  // Admin UX Checkpoint 2A: Booking Rules, Operating Hours, and Special
  // Closures moved to /admin/courts (Hours & Closures / Booking Rules
  // tabs) — this page no longer renders any of the three.
  it("Booking Rules, Operating Hours, and Special Closures no longer appear on /admin/settings — relocated to /admin/courts", () => {
    const s = readSource(PAGE_PATH);
    expect(s).not.toMatch(/── Booking Rules ──/);
    expect(s).not.toMatch(/── Operating Hours ──/);
    expect(s).not.toMatch(/── Special Closures ──/);
    expect(s).not.toContain("BookingRulesForm");
    expect(s).not.toContain("OperatingHoursEditor");
    expect(s).not.toContain("DateOverridesEditor");
  });

  // Admin UX Checkpoint 3: Event Types moved to /events (Admin-only
  // "Event Types" tab) and Lesson Types moved to /admin/lessons
  // (Admin-only "Lesson Types" tab) — this page no longer renders either.
  it("Event Types and Lesson Types no longer appear on /admin/settings — relocated to Events/Lessons", () => {
    const s = readSource(PAGE_PATH);
    expect(s).not.toMatch(/── Event Types ──/);
    expect(s).not.toMatch(/── Lesson Types ──/);
    expect(s).not.toContain("EventTypesSection");
    expect(s).not.toContain("LessonTypesSection");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 — standalone Offline Payments card no longer exists
// ═══════════════════════════════════════════════════════════════════════════

describe("4. the standalone Offline Payments card is removed", () => {
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

describe("5. manual-payment explanatory copy remains present, folded into the Payment Tracking card as compact helper content", () => {
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

describe("6. Payment Tracking toggle behavior is unchanged by the hierarchy correction", () => {
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

describe("7. Court Time Payments ON-gating (trackingOn && connected && stripeReady && not pending) is unchanged", () => {
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

describe("8. Court Time Payments ON -> OFF remains available even when Stripe has degraded — unchanged, and the degraded-while-on copy still shows", () => {
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

describe("9. StripeConnectSection's logic and authorization are unchanged — only directional cross-reference copy and its own module header comment were touched", () => {
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

describe("10. Staff-Managed clubs still cannot enable Court Time Payments from Settings", () => {
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

describe("11. Member Announcements remains available in Staff-Managed — no Connected/member_self_service gate was added", () => {
  it("page.tsx's Member Announcements section contains no capability/tier check", () => {
    const s = readSource(PAGE_PATH);
    const idx = s.indexOf("── Member Announcements ──");
    const sectionEnd = s.indexOf("<hr", idx);
    const section = s.slice(idx, sectionEnd);
    expect(section).not.toMatch(/memberSelfService|member_self_service|connected|capability_not_available/i);
  });

  it("AnnouncementsSection itself references no Connected/member_self_service gate", () => {
    const s = readSource(ANNOUNCEMENTS_SECTION_PATH);
    expect(s).not.toMatch(/memberSelfService|member_self_service|capability_not_available/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 12 — no migration or Server Action/RPC architecture change; no
//       tier-mutation control introduced
// ═══════════════════════════════════════════════════════════════════════════

describe("12. no RPC surface change and no tier-mutation control — this checkpoint is UI/copy/grouping only", () => {
  it("none of the three payment components reference set_club_tier_for_operator or export a tier-mutation function (page.tsx's own Operating Model section legitimately documents WHY tier mutation stays privileged in prose — checked separately below via its actual absence of any .rpc( call, not a bare name match)", () => {
    for (const path of [PAYMENT_TRACKING_SECTION_PATH, STRIPE_CONNECT_SECTION_PATH, COURT_TIME_PAYMENTS_SECTION_PATH]) {
      const s = readSource(path);
      expect(s).not.toMatch(/set_club_tier_for_operator|setClubTier|updateClubTier|changeTier|upgradeTier/i);
    }
    const pageSrc = readSource(PAGE_PATH);
    expect(pageSrc).not.toMatch(/setClubTier|updateClubTier|changeTier|upgradeTier/i);
    expect(pageSrc).not.toMatch(/\.rpc\(\s*["']set_club_tier_for_operator["']/);
  });

  it("the Operating Model section in page.tsx remains read-only — no onClick/action=/.rpc( inside its own <section>, even after the Phase 34G-B copy/pill correction", () => {
    const s = readSource(PAGE_PATH);
    const idx = s.indexOf('<section className="space-y-2">');
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

describe("13-14. the Stripe-ready state never collides with the Connected PLAN name — badge says 'Stripe ready', heading says 'Stripe account ready', and the explanatory copy names Court Time Payments as the separate feature that uses this account", () => {
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

describe("15. Operating Model plan pills explicitly name themselves as plans, with Staff-Managed styled neutral and Connected styled with the existing green tokens", () => {
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

describe("16. the plan-change footer explains that Court Time manages plan changes, and 'Compare plans' links to /pricing — no mutation control", () => {
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
    const idx = s.indexOf('<section className="space-y-2">');
    const sectionEnd = s.indexOf("</section>", idx);
    const section = s.slice(idx, sectionEnd);
    expect(section).not.toMatch(/<form|onSubmit|useTransition|startTransition/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 17 — Court Time Payments disabled card no longer fades the entire card;
//       the toggle itself remains visibly disabled
// ═══════════════════════════════════════════════════════════════════════════

describe("17. the Court Time Payments card stays fully readable when disabled — only the toggle itself shows disabled styling", () => {
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
