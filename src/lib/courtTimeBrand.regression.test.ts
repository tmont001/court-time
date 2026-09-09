import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 34G-C3 — Court Time Visual Identity. Source-inspection regression
// coverage (this project's established convention for CSS/config/JSX
// wiring that isn't a pure function — see paymentProvenanceUX.regression.
// test.ts for precedent) proving the new Court Time brand-green token is
// isolated from the per-club --accent theming system, applied only to the
// intended surfaces, and that every semantic/status color and every club
// theme preset is completely untouched.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const GLOBALS_CSS_PATH = "src/app/globals.css";
const TAILWIND_CONFIG_PATH = "tailwind.config.ts";
const MARKETING_BUTTON_STYLES_PATH = "src/app/(marketing)/marketingButtonStyles.ts";
const HOME_PAGE_PATH = "src/app/(marketing)/page.tsx";
const FEATURES_PAGE_PATH = "src/app/(marketing)/features/page.tsx";
const MARKETING_NAV_PATH = "src/app/(marketing)/components/MarketingNav.tsx";
const CONTACT_FORM_PATH = "src/app/(marketing)/contact/PilotInquiryForm.tsx";
const PRICING_CARDS_PATH = "src/app/(marketing)/pricing/PricingCards.tsx";
const COMPARISON_TABLE_PATH = "src/app/(marketing)/pricing/ComparisonTable.tsx";
const FOUNDING_BANNER_PATH = "src/app/(marketing)/pricing/FoundingOfferBanner.tsx";
const SETTINGS_PAGE_PATH = "src/app/(app)/admin/settings/page.tsx";
const STRIPE_CONNECT_SECTION_PATH = "src/app/(app)/admin/settings/StripeConnectSection.tsx";
const PAYMENTS_LIB_PATH = "src/lib/payments.ts";
// Phase 34G-D1 — relocated off src/lib/ (Tailwind never scanned it) to
// src/components/styles/ — see src/app/(app)/admin/payments/
// productionHardening.regression.test.ts for the dedicated coverage of
// that move itself; this file's own references just need the new path.
const ACTION_BUTTON_STYLES_PATH = "src/components/styles/actionButtonStyles.ts";

const THEME_NAMES = ["graphite", "cobalt", "teal", "sage", "plum", "rose", "terracotta", "gold"];

// Correction pass — Issue 1: a src/lib-wide Tailwind content glob was
// briefly added to make marketingButtonStyles.ts's class strings compile,
// then reverted because it had an unrelated blast radius (it also
// activated previously-latent classes in src/lib/actionButtonStyles.ts,
// outside this checkpoint's narrow brand-identity scope). The fix instead
// moves marketingButtonStyles.ts under src/app/(marketing)/, an
// ALREADY-scanned path, so Tailwind's pre-C3 content scope needs no
// change at all.
describe("Tailwind content-scan scope is untouched by this checkpoint (correction pass, Issue 1)", () => {
  it("tailwind.config.ts's content array is exactly the original 3 globs — no src/lib entry was added or left behind", () => {
    const config = readSource(TAILWIND_CONFIG_PATH);
    const contentStart = config.indexOf("content: [");
    const contentEnd = config.indexOf("],", contentStart);
    const contentBlock = config.slice(contentStart, contentEnd);
    expect(contentBlock).not.toMatch(/src\/lib/);
    expect(contentBlock).toContain("./src/pages/**/*.{js,ts,jsx,tsx,mdx}");
    expect(contentBlock).toContain("./src/components/**/*.{js,ts,jsx,tsx,mdx}");
    expect(contentBlock).toContain("./src/app/**/*.{js,ts,jsx,tsx,mdx}");
    // Exactly 3 glob string literals — nothing added, nothing removed.
    const globCount = (contentBlock.match(/"\.\/src\//g) ?? []).length;
    expect(globCount).toBe(3);
  });

  it("marketingButtonStyles.ts lives under src/app/(marketing)/ — an already-scanned path — not under src/lib", () => {
    expect(MARKETING_BUTTON_STYLES_PATH).toBe("src/app/(marketing)/marketingButtonStyles.ts");
    expect(MARKETING_BUTTON_STYLES_PATH.startsWith("src/app/")).toBe(true);
    // Confirm it's actually readable at that path (the module genuinely moved).
    expect(() => readSource(MARKETING_BUTTON_STYLES_PATH)).not.toThrow();
    // And confirm it no longer exists at its old src/lib location.
    expect(() => readSource("src/lib/marketingButtonStyles.ts")).toThrow();
  });

  it("MARKETING_CTA_PRIMARY_COLOR's exact class string is unchanged by the move (bg-brand/hover:bg-brand-hover/focus-visible:ring-brand all present)", () => {
    const s = readSource(MARKETING_BUTTON_STYLES_PATH);
    expect(s).toContain(
      "bg-brand text-white hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand",
    );
  });

  it("actionButtonStyles.ts is completely untouched by this checkpoint (byte-for-byte no brand/#2F6B4F reference, confirming C3 never widened its own scope into it)", () => {
    const s = readSource(ACTION_BUTTON_STYLES_PATH);
    expect(s).not.toMatch(/brand|#2F6B4F|ct-brand/);
  });
});

describe("A. canonical Court Time brand token exists with #2F6B4F", () => {
  it("--ct-brand is defined as #2F6B4F in :root", () => {
    const css = readSource(GLOBALS_CSS_PATH);
    const rootBlock = css.slice(css.indexOf(":root"), css.indexOf(":root") + 300);
    expect(rootBlock).toMatch(/--ct-brand:\s*#2F6B4F/);
  });

  it("Tailwind exposes it as a `brand` color mapped to var(--ct-brand)", () => {
    const config = readSource(TAILWIND_CONFIG_PATH);
    expect(config).toContain('brand: "var(--ct-brand)"');
  });

  it("the brand token set stays minimal — exactly ct-brand, ct-brand-hover, ct-brand-tint, no broader palette", () => {
    const css = readSource(GLOBALS_CSS_PATH);
    const ctVarNames = [...new Set([...css.matchAll(/--ct-brand[a-z-]*/g)].map(m => m[0]))];
    expect(ctVarNames.sort()).toEqual(["--ct-brand", "--ct-brand-hover", "--ct-brand-tint"]);
  });
});

describe("B. .theme-* definitions do NOT redefine the Court Time brand token", () => {
  it("no .theme-* rule (any of the 8 club presets, light or dark) ever mentions --ct-brand", () => {
    const css = readSource(GLOBALS_CSS_PATH);
    for (const theme of THEME_NAMES) {
      const lightIdx = css.indexOf(`.theme-${theme} `);
      const lightLine = css.slice(lightIdx, css.indexOf("\n", lightIdx));
      expect(lightLine).not.toMatch(/--ct-brand/);

      const darkIdx = css.indexOf(`.dark .theme-${theme} `);
      const darkLine = css.slice(darkIdx, css.indexOf("\n", darkIdx));
      expect(darkIdx).toBeGreaterThan(-1);
      expect(darkLine).not.toMatch(/--ct-brand/);
    }
  });

  it("all 8 expected club theme presets are still present and unmodified in count", () => {
    const css = readSource(GLOBALS_CSS_PATH);
    for (const theme of THEME_NAMES) {
      expect(css).toContain(`.theme-${theme}`);
    }
    const themeRuleCount = (css.match(/\.theme-[a-z]+ /g) ?? []).length;
    // 8 themes × 2 (light + dark) = 16 rule occurrences.
    expect(themeRuleCount).toBe(16);
  });
});

describe("C. club --accent remains separate from --ct-brand", () => {
  it("--accent and --ct-brand are declared as distinct custom properties in :root and .dark, neither aliasing the other", () => {
    const css = readSource(GLOBALS_CSS_PATH);
    expect(css).toMatch(/--accent:\s*#374151/);
    expect(css).not.toMatch(/--accent:\s*var\(--ct-brand/);
    expect(css).not.toMatch(/--ct-brand:\s*var\(--accent/);
  });

  it("Tailwind's `accent` and `brand` colors point at two different CSS variables", () => {
    const config = readSource(TAILWIND_CONFIG_PATH);
    expect(config).toContain('accent: "var(--accent)"');
    expect(config).toContain('brand: "var(--ct-brand)"');
  });
});

describe("D. marketing primary CTA uses the Court Time brand token", () => {
  it("MARKETING_CTA_PRIMARY_COLOR is bg-brand/hover:bg-brand-hover, never graphite", () => {
    const s = readSource(MARKETING_BUTTON_STYLES_PATH);
    expect(s).toContain("bg-brand");
    expect(s).toContain("hover:bg-brand-hover");
    expect(s).not.toMatch(/bg-gray-900/);
  });

  it("every primary 'Request a pilot' CTA outside the Founding Club promo uses MARKETING_CTA_PRIMARY_COLOR", () => {
    const homeSrc = readSource(HOME_PAGE_PATH);
    const featuresSrc = readSource(FEATURES_PAGE_PATH);
    const navSrc = readSource(MARKETING_NAV_PATH);
    const contactSrc = readSource(CONTACT_FORM_PATH);

    // +1 for each file's own import statement referencing the symbol.
    expect((homeSrc.match(/\$\{MARKETING_CTA_PRIMARY_COLOR\}/g) ?? []).length).toBe(1);
    expect((featuresSrc.match(/\$\{MARKETING_CTA_PRIMARY_COLOR\}/g) ?? []).length).toBe(2);
    expect(navSrc).toContain("${MARKETING_CTA_PRIMARY_COLOR}");
    expect(contactSrc).toContain("${MARKETING_CTA_PRIMARY_COLOR}");
  });

  it("the homepage hero CTA uses the brand treatment, but the Founding-clubs-section CTA does NOT (it stays part of that neutral promo)", () => {
    const s = readSource(HOME_PAGE_PATH);
    const foundingSectionIdx = s.indexOf("Founding clubs");
    expect(foundingSectionIdx).toBeGreaterThan(-1);
    const foundingSectionEnd = s.indexOf("</section>", foundingSectionIdx);
    const foundingSection = s.slice(foundingSectionIdx, foundingSectionEnd);
    expect(foundingSection).not.toMatch(/MARKETING_CTA_PRIMARY_COLOR/);
    expect(foundingSection).toContain("bg-white text-gray-900");
  });
});

describe("E. marketing secondary CTA remains neutral", () => {
  it("secondary marketing links (Explore features, See pricing, Sign in) never reference the brand token", () => {
    const homeSrc = readSource(HOME_PAGE_PATH);
    const featuresSrc = readSource(FEATURES_PAGE_PATH);
    const navSrc = readSource(MARKETING_NAV_PATH);

    const exploreIdx = homeSrc.indexOf("Explore features");
    const exploreBlockStart = homeSrc.lastIndexOf("<Link", exploreIdx);
    expect(homeSrc.slice(exploreBlockStart, exploreIdx)).not.toMatch(/bg-brand|border-brand|text-brand/);

    const seePricingIdx = featuresSrc.indexOf("See pricing");
    const seePricingBlockStart = featuresSrc.lastIndexOf("<Link", seePricingIdx);
    expect(featuresSrc.slice(seePricingBlockStart, seePricingIdx)).not.toMatch(/bg-brand|border-brand|text-brand/);

    const signInIdx = navSrc.indexOf("Sign in");
    const signInBlockStart = navSrc.lastIndexOf("<Link", signInIdx);
    expect(navSrc.slice(signInBlockStart, signInIdx)).not.toMatch(/bg-brand|border-brand|text-brand/);
  });
});

describe("F. Connected pricing treatment uses the Court Time brand token", () => {
  it("PricingCards.tsx: the highlighted (Connected) card border and CTA use brand/brand-hover", () => {
    const s = readSource(PRICING_CARDS_PATH);
    expect(s).toContain("border-2 border-brand shadow-xl");
    expect(s).toContain("bg-brand text-white hover:bg-brand-hover");
  });

  it("ComparisonTable.tsx: the Connected column header border uses border-brand", () => {
    const s = readSource(COMPARISON_TABLE_PATH);
    expect(s).toContain("border-x-2 border-brand");
  });
});

describe("G. Staff-Managed pricing treatment remains neutral", () => {
  it("PricingCards.tsx: the non-highlighted (Staff-Managed) CTA branch never references the brand token", () => {
    const s = readSource(PRICING_CARDS_PATH);
    const staffBranchIdx = s.indexOf('"mt-5 block w-full text-center py-3 rounded-xl text-sm font-semibold border border-gray-300');
    expect(staffBranchIdx).toBeGreaterThan(-1);
    const staffBranchLine = s.slice(staffBranchIdx, s.indexOf("\n", staffBranchIdx));
    expect(staffBranchLine).not.toMatch(/bg-brand|border-brand|text-brand/);
    expect(staffBranchLine).toContain("border-gray-300");
  });

  it("ComparisonTable.tsx: the Staff-Managed column header stays plain neutral text, no brand token", () => {
    const s = readSource(COMPARISON_TABLE_PATH);
    const idx = s.indexOf("Staff-Managed");
    const thStart = s.lastIndexOf("<th", idx);
    expect(s.slice(thStart, idx)).not.toMatch(/brand/);
  });
});

describe("H. Founding Club does not become a brand-green card", () => {
  it("FoundingOfferBanner.tsx never references the brand token anywhere — card, badge, or CTA", () => {
    const s = readSource(FOUNDING_BANNER_PATH);
    expect(s).not.toMatch(/brand/);
    // Still the original neutral graphite treatment.
    expect(s).toContain("bg-gray-900 dark:bg-gray-100");
  });
});

describe("I. authenticated Connected commercial badge uses brand treatment where implemented", () => {
  it("Settings page's Connected Plan pill applies the shared, token-backed .ct-brand-pill class, not the generic Tailwind green scale", () => {
    const s = readSource(SETTINGS_PAGE_PATH);
    const pillIdx = s.indexOf('? "ct-brand-pill"');
    expect(pillIdx).toBeGreaterThan(-1);
    const pillLine = s.slice(pillIdx, s.indexOf("\n", pillIdx));
    expect(pillLine).not.toMatch(/bg-green-50|text-green-800|border-green-200/);
  });

  it(".ct-brand-pill itself is defined once in globals.css, sourced entirely from --ct-brand/--ct-brand-tint — never a hardcoded hex inside the rule", () => {
    const css = readSource(GLOBALS_CSS_PATH);
    const ruleStart = css.indexOf(".ct-brand-pill {");
    expect(ruleStart).toBeGreaterThan(-1);
    const ruleEnd = css.indexOf("}", css.indexOf(".dark .ct-brand-pill {", ruleStart));
    const rule = css.slice(ruleStart, ruleEnd + 1);
    expect(rule).toMatch(/var\(--ct-brand\)/);
    expect(rule).toMatch(/var\(--ct-brand-tint\)/);
    expect(rule).not.toMatch(/#2F6B4F|#5EBA92|#285B43/);
  });
});

// Correction pass — Issue 2: brand color literals must live only in the
// centralized token definition (globals.css's --ct-brand*/​.ct-brand-pill),
// never repeated as literal hex in individual JSX call sites.
describe("Connected Plan pill centralization (correction pass, Issue 2)", () => {
  it("Settings page contains NO #2F6B4F literal anywhere", () => {
    const s = readSource(SETTINGS_PAGE_PATH);
    expect(s).not.toMatch(/#2F6B4F/i);
  });

  it("Settings page contains NO #5EBA92 literal anywhere", () => {
    const s = readSource(SETTINGS_PAGE_PATH);
    expect(s).not.toMatch(/#5EBA92/i);
  });

  it("the ONLY source-of-truth occurrences of #2F6B4F/#5EBA92/#285B43 in the whole app are inside globals.css's own --ct-brand* token definitions", () => {
    // Every other file this checkpoint touches must be free of the literal
    // hex — proves centralization, not just the Settings page specifically.
    const filesToCheck = [
      MARKETING_BUTTON_STYLES_PATH, HOME_PAGE_PATH, FEATURES_PAGE_PATH,
      MARKETING_NAV_PATH, CONTACT_FORM_PATH, PRICING_CARDS_PATH,
      COMPARISON_TABLE_PATH, FOUNDING_BANNER_PATH, SETTINGS_PAGE_PATH,
      TAILWIND_CONFIG_PATH,
    ];
    for (const path of filesToCheck) {
      const s = readSource(path);
      expect(s).not.toMatch(/#2F6B4F|#5EBA92|#285B43/i);
    }
  });
});

describe("J. Staff-Managed badge remains neutral", () => {
  it("the Staff-Managed Plan pill branch stays plain gray, no brand reference", () => {
    const s = readSource(SETTINGS_PAGE_PATH);
    const staffBranchIdx = s.indexOf(': "bg-gray-100 dark:bg-gray-700 text-gray-600');
    expect(staffBranchIdx).toBeGreaterThan(-1);
    const staffBranchLine = s.slice(staffBranchIdx, s.indexOf("\n", staffBranchIdx));
    expect(staffBranchLine).toContain("bg-gray-100");
    expect(staffBranchLine).not.toMatch(/brand|#2F6B4F/);
  });
});

describe("K. Stripe-ready/readiness/payment-status greens are NOT converted to the brand token", () => {
  it("StripeConnectSection.tsx's 'Stripe ready' badge stays on the plain Tailwind green scale, no brand reference", () => {
    const s = readSource(STRIPE_CONNECT_SECTION_PATH);
    const badgeIdx = s.indexOf("Stripe ready");
    const badgeBlockStart = s.lastIndexOf("<span", badgeIdx);
    const badgeBlock = s.slice(badgeBlockStart, badgeIdx);
    expect(badgeBlock).toMatch(/text-green-700/);
    expect(badgeBlock).not.toMatch(/brand|#2F6B4F/);
  });

  it("src/lib/payments.ts's toneClassName (PAID/CONFIRMED/positive status tone) is untouched — plain Tailwind green, no brand reference", () => {
    const s = readSource(PAYMENTS_LIB_PATH);
    const fnStart = s.indexOf("export function toneClassName(");
    const fnEnd = s.indexOf("\n}", fnStart) + 2;
    const fn = s.slice(fnStart, fnEnd);
    expect(fn).toMatch(/text-green-700 dark:text-green-400/);
    expect(fn).not.toMatch(/brand|#2F6B4F/);
  });

  it("src/lib/actionButtonStyles.ts's POSITIVE-toned button style is untouched — plain Tailwind green, no brand reference", () => {
    const s = readSource(ACTION_BUTTON_STYLES_PATH);
    expect(s).not.toMatch(/brand|#2F6B4F/);
  });
});

describe("L. operational Admin/calendar app controls continue to use the existing club-accent system", () => {
  it("Settings page's Compare-plans/contact links (plain navigational text, not commercial badges) still use --accent, unaffected by the brand-badge change", () => {
    const s = readSource(SETTINGS_PAGE_PATH);
    expect(s).toContain('<Link href="/pricing" className="text-accent hover:underline">');
    expect(s).toContain('<Link href="/contact" className="text-accent hover:underline">');
  });

  it("the shared primary action-button style (ACTION_BUTTON_PRIMARY, used across Admin operational surfaces like /admin/payments) still resolves through the club accent token, not the brand token", () => {
    const s = readSource(ACTION_BUTTON_STYLES_PATH);
    expect(s).toMatch(/bg-accent/);
    expect(s).not.toMatch(/bg-brand\b/);
  });
});

describe("M. no theme preset modifies --ct-brand (duplicate of B, kept as its own named item per the spec)", () => {
  it("grepping the full theme block for --ct-brand yields zero matches", () => {
    const css = readSource(GLOBALS_CSS_PATH);
    const themeBlockStart = css.indexOf(".theme-graphite");
    const themeBlockEnd = css.indexOf(".hide-scrollbar");
    const themeBlock = css.slice(themeBlockStart, themeBlockEnd);
    expect(themeBlock).not.toMatch(/--ct-brand/);
  });
});

describe("N. no migration/RPC/payment lifecycle changes", () => {
  it("none of the files touched in this checkpoint reference a Supabase RPC call or a migration file", () => {
    const touchedFiles = [
      GLOBALS_CSS_PATH, TAILWIND_CONFIG_PATH, MARKETING_BUTTON_STYLES_PATH,
      HOME_PAGE_PATH, FEATURES_PAGE_PATH, MARKETING_NAV_PATH, CONTACT_FORM_PATH,
      PRICING_CARDS_PATH, COMPARISON_TABLE_PATH, FOUNDING_BANNER_PATH,
    ];
    for (const path of touchedFiles) {
      const s = readSource(path);
      expect(s).not.toMatch(/\.rpc\(/);
      expect(s).not.toMatch(/supabase\/migrations/);
    }
  });

  it("the Settings page diff-relevant section never calls a payment-lifecycle-mutating action (this is a read-only display pill)", () => {
    const s = readSource(SETTINGS_PAGE_PATH);
    const pillIdx = s.indexOf("Connected Plan");
    const nearby = s.slice(Math.max(0, pillIdx - 1500), pillIdx + 200);
    expect(nearby).not.toMatch(/waive_payment|void_payment_obligation|record_manual_payment|reverse_payment_event|activate_court_time_payments/);
  });
});
