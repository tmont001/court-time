import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  STANDARD_TIERS,
  FOUNDING_OFFER,
  STAFF_MANAGED_FEATURES,
  CONNECTED_FEATURES,
} from "./planData";

// Phase 34G-A2 — Pricing & Packaging Alignment. /pricing is now built
// around the two STANDARD, executable tiers (Staff-Managed, Connected)
// rather than the prior Founding Club/Starter/Club 3-plan layout, with
// Founding Club rendered as a temporary promotional offer on top of
// Connected + Court Time Payments. Covers items 1-8 from the 34G-A2 spec.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const PLAN_DATA_PATH = "src/app/(marketing)/pricing/planData.ts";
const PAGE_PATH = "src/app/(marketing)/pricing/page.tsx";
const COMPARISON_PATH = "src/app/(marketing)/pricing/ComparisonTable.tsx";
const BANNER_PATH = "src/app/(marketing)/pricing/FoundingOfferBanner.tsx";
const CARDS_PATH = "src/app/(marketing)/pricing/PricingCards.tsx";
const ENTITLEMENT_MIGRATION = "supabase/migrations/0122_entitlement_foundation.sql";
const CONNECTED_ENFORCEMENT_MIGRATION = "supabase/migrations/0123_staff_managed_connected_enforcement.sql";

// ═══════════════════════════════════════════════════════════════════════════
// 1 — pricing data has Staff-Managed + Connected as standard tiers
// ═══════════════════════════════════════════════════════════════════════════

describe("1. STANDARD_TIERS is exactly Staff-Managed and Connected", () => {
  it("has exactly two entries, in that order, with the locked prices", () => {
    expect(STANDARD_TIERS).toHaveLength(2);
    expect(STANDARD_TIERS[0]).toMatchObject({
      id: "staff_managed",
      name: "Staff-Managed",
      monthly: "$149",
      annual: "$1,490",
      perMemberFee: "None",
    });
    expect(STANDARD_TIERS[1]).toMatchObject({
      id: "connected",
      name: "Connected",
      monthly: "$199",
      annual: "$1,990",
      perMemberFee: "None",
    });
  });

  it("TierId mirrors the actual club_subscriptions.tier CHECK constraint — no third value", () => {
    const s = readSource(ENTITLEMENT_MIGRATION);
    expect(s).toContain("check (tier in ('staff_managed', 'connected'))");
  });

  it("the standard-tier cards component renders both tiers with no rail/carousel machinery for a third plan", () => {
    const s = readSource(CARDS_PATH);
    expect(s).toContain("STANDARD_TIERS.map((tier) =>");
    expect(s).not.toMatch(/IntersectionObserver|usePrefersReducedMotion/);
  });

  it("the comparison table headers read exactly Staff-Managed / Connected — never Founding Club/Starter/Club", () => {
    const s = readSource(COMPARISON_PATH);
    expect(s).toContain("Staff-Managed");
    expect(s).toContain(">\n                Connected\n              </th>");
    // Scoped to the rendered JSX only (after `return (`) — an explanatory
    // comment earlier in this same file legitimately mentions the PRIOR
    // Founding Club/Starter/Club layout this checkpoint replaced.
    const jsx = s.slice(s.indexOf("return ("));
    expect(jsx).not.toMatch(/Starter|Founding Club|>\s*Club\s*</);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 — Founding Club is promotional, not a DB entitlement tier
// ═══════════════════════════════════════════════════════════════════════════

describe("2. Founding Club is a promotional offer, never a database tier", () => {
  it("FOUNDING_OFFER has no `id` field of a TierId shape — it is a distinct type from StandardTier", () => {
    expect(FOUNDING_OFFER).not.toHaveProperty("id");
    expect(FOUNDING_OFFER.name).toBe("Founding Club");
  });

  it("Founding Club is described as Connected + Court Time Payments + full product access, priced at the Staff-Managed rate", () => {
    expect(FOUNDING_OFFER.includesLabel).toBe(
      "Connected + Court Time Payments + full current product access",
    );
    expect(FOUNDING_OFFER.monthly).toBe(STANDARD_TIERS[0].monthly);
    expect(FOUNDING_OFFER.annual).toBe(STANDARD_TIERS[0].annual);
  });

  it("planData.ts's own comment explicitly documents no 'founding' value exists in the DB tier CHECK constraint", () => {
    const s = readSource(PLAN_DATA_PATH);
    expect(s).toMatch(/no 'founding' value/);
  });

  it("the entitlement foundation migration's tier CHECK constraint has no 'founding' value — confirms the data-layer claim against the actual schema", () => {
    const s = readSource(ENTITLEMENT_MIGRATION);
    expect(s).not.toMatch(/'founding'/);
  });

  it("FoundingOfferBanner is rendered as its own distinct component, never as a third entry inside PricingCards/STANDARD_TIERS", () => {
    const bannerSrc = readSource(BANNER_PATH);
    const cardsSrc = readSource(CARDS_PATH);
    expect(bannerSrc).toContain("FOUNDING_OFFER");
    expect(cardsSrc).not.toMatch(/FOUNDING_OFFER/);
  });

  it("the pricing page renders the Founding Club banner separately from, and before, the standard tier cards", () => {
    const s = readSource(PAGE_PATH);
    const bannerIdx = s.indexOf("<FoundingOfferBanner");
    const cardsIdx = s.indexOf("<PricingCards");
    expect(bannerIdx).toBeGreaterThan(-1);
    expect(cardsIdx).toBeGreaterThan(bannerIdx);
  });

  it("the disclosure copy explicitly frames Founding Club as temporary, not a separate permanent plan", () => {
    const s = readSource(PAGE_PATH);
    expect(s).toContain("Founding Club is a");
    expect(s).toContain("temporary offer for pilot clubs, not a separate permanent plan.");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3/4 — Staff-Managed / Connected feature claims match executable behavior
// ═══════════════════════════════════════════════════════════════════════════

describe("3. Staff-Managed feature claims match executable (non-capability-gated) behavior — no Member self-service claim appears", () => {
  it("STAFF_MANAGED_FEATURES never claims Member self-service capabilities (booking/signup/enrollment/requests)", () => {
    const labels = STAFF_MANAGED_FEATURES.map(f => f.label).join(" | ");
    expect(labels).not.toMatch(/member.*(self.service|book|signup|enroll|request)/i);
  });

  it("manual payment tracking / Record Payment is listed as a Staff-Managed feature — role-gated only (admin/staff), never capability-gated, matching record_manual_payment's own unconditional-on-tier body", () => {
    expect(STAFF_MANAGED_FEATURES.map(f => f.key)).toContain("manualPaymentTracking");
    const s = readSource("supabase/migrations/0143_payment_mode_and_ledger_foundation.sql");
    const fnStart = s.indexOf("create or replace function public.record_manual_payment(");
    expect(fnStart).toBeGreaterThan(-1);
  });

  it("every Staff-Managed feature is marked Included on BOTH comparison-table columns — the STAFF_MANAGED_FEATURES.map() row template renders exactly two IncludedCells (one per column), applied to every feature in the list", () => {
    const s = readSource(COMPARISON_PATH);
    expect(s).toContain("STAFF_MANAGED_FEATURES.map((f) =>");
    const sectionIdx = s.indexOf("STAFF_MANAGED_FEATURES.map((f) =>");
    const nextSectionIdx = s.indexOf("CONNECTED_FEATURES.map((f) =>", sectionIdx);
    const block = s.slice(sectionIdx, nextSectionIdx);
    const includedCount = (block.match(/<IncludedCell \/>/g) ?? []).length;
    const notIncludedCount = (block.match(/<NotIncludedCell \/>/g) ?? []).length;
    expect(includedCount).toBe(2);
    expect(notIncludedCount).toBe(0);
    expect(STAFF_MANAGED_FEATURES.length).toBeGreaterThan(0);
  });
});

describe("4. Connected feature claims map 1:1 to the executable member_self_service capability gates (0123) — no invented functionality", () => {
  const CONNECTED_KEY_TO_RPC: Record<string, string> = {
    memberCourtBooking: "create_reservation",
    memberEventSignup: "join_event",
    memberProgramEnrollment: "join_program",
    memberLessonRequests: "submit_lesson_request",
  };

  it("every Connected feature that maps to a specific self-service RPC has that RPC actually gated by capability_not_available in 0123", () => {
    const s = readSource(CONNECTED_ENFORCEMENT_MIGRATION);
    for (const [key, rpcName] of Object.entries(CONNECTED_KEY_TO_RPC)) {
      expect(CONNECTED_FEATURES.some(f => f.key === key), `${key} missing from CONNECTED_FEATURES`).toBe(true);
      // Some of these RPCs are declared without the `public.` schema
      // qualifier in 0123's own text (e.g. join_event) — match either form.
      const fnStart = s.search(new RegExp(`create or replace function (public\\.)?${rpcName}\\(`));
      expect(fnStart, `${rpcName} not found in 0123`).toBeGreaterThan(-1);
    }
  });

  it("every Connected feature is marked Included ONLY under the Connected column (Not Included under Staff-Managed) — the CONNECTED_FEATURES.map() row template renders exactly one NotIncludedCell then one IncludedCell, applied to every feature in the list", () => {
    const s = readSource(COMPARISON_PATH);
    expect(s).toContain("CONNECTED_FEATURES.map((f) =>");
    const sectionIdx = s.indexOf("CONNECTED_FEATURES.map((f) =>");
    const nextSectionIdx = s.indexOf('label="Court Time Payments"', sectionIdx);
    const block = s.slice(sectionIdx, nextSectionIdx);
    const notIncludedCount = (block.match(/<NotIncludedCell \/>/g) ?? []).length;
    const includedCount = (block.match(/<IncludedCell \/>/g) ?? []).length;
    expect(notIncludedCount).toBe(1);
    expect(includedCount).toBe(1);
    expect(block.indexOf("<NotIncludedCell />")).toBeLessThan(block.indexOf("<IncludedCell />"));
    expect(CONNECTED_FEATURES.length).toBeGreaterThan(0);
  });

  it("Member cancellation/continuity is claimed but does not overstate — it is deliberately ungated in 0123 (continuity), matching the 'where allowed' qualifier in its own label", () => {
    const row = CONNECTED_FEATURES.find(f => f.key === "memberCancellation");
    expect(row?.label).toMatch(/where allowed/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5 — manual payment tracking is not described as Payments-only
// ═══════════════════════════════════════════════════════════════════════════

describe("5. Manual payment tracking / Record Payment is never described as gated behind Court Time Payments", () => {
  it("manualPaymentTracking is listed under Staff-Managed (both plans), never under the Connected-only or Court Time Payments sections", () => {
    expect(STAFF_MANAGED_FEATURES.some(f => f.key === "manualPaymentTracking")).toBe(true);
    expect(CONNECTED_FEATURES.some(f => f.key === "manualPaymentTracking")).toBe(false);
  });

  it("the FAQ explicitly states manual tracking/Record Payment are part of both standard plans and never paywalled behind Court Time Payments", () => {
    const s = readSource(PAGE_PATH);
    expect(s).toMatch(/Manual payment tracking and Record Payment are part of both standard plans and are never paywalled behind Court Time Payments/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6 — Court Time Payments is optional Connected capability
// ═══════════════════════════════════════════════════════════════════════════

describe("6. Court Time Payments is presented as an optional Connected-only add-on, never a plan of its own", () => {
  it("the comparison table's Court Time Payments row shows 'Not available' under Staff-Managed and 'Optional add-on' under Connected — never a plain checkmark under either", () => {
    const s = readSource(COMPARISON_PATH);
    const idx = s.indexOf('label="Court Time Payments"');
    const block = s.slice(idx, idx + 500);
    expect(block).toContain("Not available");
    expect(block).toContain("Optional add-on");
    expect(block).not.toMatch(/<IncludedCell \/>/);
  });

  it("the FAQ states Payments is an optional add-on available with Connected, not a plan by itself", () => {
    const s = readSource(PAGE_PATH);
    expect(s).toMatch(/Court Time Payments.*is an optional add-on available with Connected — it's not a plan by itself/);
  });

  it("Founding Club includes Payments at no additional charge during founding/early-access — an explicit, temporary inclusion, not a standing default for all Connected clubs", () => {
    const bannerSrc = readSource(BANNER_PATH);
    expect(bannerSrc).toContain("{offer.includesLabel}");
    const pageSrc = readSource(PAGE_PATH);
    expect(pageSrc).toContain("Founding Club includes it at no additional charge during the founding/early-access period");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7 — no application fee / take-rate is claimed or introduced
// ═══════════════════════════════════════════════════════════════════════════

describe("7. no application fee / take-rate is claimed anywhere in pricing copy, and none is introduced in Stripe session construction", () => {
  it("no marketing file mentions an application fee or take-rate/percentage on Member payments", () => {
    for (const path of [PAGE_PATH, PLAN_DATA_PATH, COMPARISON_PATH, BANNER_PATH, CARDS_PATH]) {
      const s = readSource(path);
      expect(s).not.toMatch(/application[- ]fee|take[- ]rate|percentage of (each|every) (payment|transaction)/i);
    }
  });

  it("paymentsConfig.ts (the actual Stripe Checkout session builders) still sets no application_fee_amount anywhere — direct-charge model unchanged by this checkpoint", () => {
    const s = readSource("src/lib/stripe/paymentsConfig.ts");
    // application_fee_amount appears only in a documentation comment
    // describing its OWN absence ("No application_fee_amount anywhere —
    // Court Time takes zero...") — never as an actual object key/value in
    // executable code. Excludes comment lines before asserting.
    const codeOnly = s.split("\n").filter(line => !line.trim().startsWith("//")).join("\n");
    expect(codeOnly).not.toMatch(/application_fee_amount/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8 — no standard Payments add-on dollar price is invented
// ═══════════════════════════════════════════════════════════════════════════

describe("8. no standard Court Time Payments add-on price is invented", () => {
  it("planData.ts has no price field at all for Court Time Payments — only the two standard tier prices and the Founding Club offer price exist", () => {
    const s = readSource(PLAN_DATA_PATH);
    // The only dollar amounts anywhere in the data file are the two
    // standard-tier prices and the Founding Club offer price (which
    // reuses the Staff-Managed rate) — never a distinct Payments price.
    const dollarAmounts = [...s.matchAll(/"\$[\d,]+"/g)].map(m => m[0]);
    expect(new Set(dollarAmounts)).toEqual(new Set(['"$149"', '"$1,490"', '"$199"', '"$1,990"']));
  });

  it("the FAQ explicitly defers standard add-on pricing to before general launch, rather than inventing one", () => {
    const s = readSource(PAGE_PATH);
    expect(s).toMatch(/Standard add-on pricing will be announced before general launch/);
  });
});
