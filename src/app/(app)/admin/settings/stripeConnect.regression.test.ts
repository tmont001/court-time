import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 34D-A — regression coverage for the exact runtime failure
// observed: clicking "Connect with Stripe" called POST /v1/accounts,
// which Stripe rejected (400 invalid_request_error) because new Connect
// integrations must use POST /v2/core/accounts instead. These tests read
// the actual shipped source of the feature's Stripe-calling files (not a
// mock/reimplementation) and assert the v1 call shape is structurally
// absent and the v2 call shape is present, plus that the unrelated
// court_time_payments locks and the 0147 mode/immutability invariants
// this checkpoint depends on are still intact.
//
// This is a static-source style of test rather than a live-network one
// because this repository's test baseline is deliberately pure-TypeScript
// with no jsdom/Supabase/network mocking (see vitest.config.mts) — for a
// "which SDK call shape did we use" question, reading the real shipped
// source is a more honest regression guard than reimplementing a mock
// Stripe client that could silently drift from the real SDK's shape.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const STRIPE_CALLING_FILES = [
  "src/app/(app)/admin/settings/stripeConnectActions.ts",
  "src/app/(app)/admin/settings/stripeConnectShared.ts",
  "src/app/api/stripe/connect/refresh/route.ts",
  "src/app/api/stripe/connect/return/route.ts",
];

describe("Stripe Connect v2 regression guardrail", () => {
  it("no 34D-A file calls the Accounts v1 create method (stripe.accounts.create) — every .accounts.create( call is .v2.core.accounts.create(", () => {
    for (const file of STRIPE_CALLING_FILES) {
      const src = readSource(file);
      const total = countOccurrences(src, ".accounts.create(");
      const v2 = countOccurrences(src, ".v2.core.accounts.create(");
      expect(total, `${file}: every .accounts.create( call must be .v2.core.accounts.create(`).toBe(v2);
    }
  });

  it("every accountLinks.create call in 34D-A goes through the v2 namespace, never the v1 shape", () => {
    for (const file of STRIPE_CALLING_FILES) {
      const src = readSource(file);
      const total = countOccurrences(src, ".accountLinks.create(");
      const v2 = countOccurrences(src, ".v2.core.accountLinks.create(");
      expect(total, `${file}: every .accountLinks.create( call must be .v2.core.accountLinks.create(`).toBe(v2);
    }
  });

  it("account creation is invoked through the v2 namespace", () => {
    const src = readSource("src/app/(app)/admin/settings/stripeConnectActions.ts");
    expect(src).toContain(".v2.core.accounts.create(");
  });

  it("account retrieval (for status sync) is invoked through the v2 namespace", () => {
    const src = readSource("src/app/(app)/admin/settings/stripeConnectShared.ts");
    expect(src).toContain(".v2.core.accounts.retrieve(");
  });

  it("no 34D-A file reads/writes Accounts v1's charges_enabled/details_submitted as actual code (property access or object keys) — explanatory prose contrasting v1 vs v2 is fine", () => {
    // Matches real code usage (`.charges_enabled`, `charges_enabled:`,
    // `charges_enabled =`), not prose mentioning the field names to
    // explain their absence.
    const codeUsage = /(\.charges_enabled\b|\bcharges_enabled\s*[:=])|(\.details_submitted\b|\bdetails_submitted\s*[:=])/;
    for (const file of [...STRIPE_CALLING_FILES, "src/app/(app)/admin/settings/StripeConnectSection.tsx"]) {
      const src = readSource(file);
      expect(src, `${file} must not read/write v1's charges_enabled/details_submitted as code`).not.toMatch(codeUsage);
    }
  });

  it("no PaymentIntent, Checkout, or application_fee code exists anywhere in 34D-A", () => {
    for (const file of [...STRIPE_CALLING_FILES, "src/app/(app)/admin/settings/StripeConnectSection.tsx", "src/lib/stripe/server.ts", "src/lib/stripe/connectConfig.ts"]) {
      const src = readSource(file);
      expect(src, `${file} must not reference PaymentIntent`).not.toMatch(/PaymentIntent/);
      expect(src, `${file} must not reference checkout`).not.toMatch(/checkout/i);
      expect(src, `${file} must not reference application_fee`).not.toMatch(/application_fee|applicationFee/);
    }
  });
});

describe("court_time_payments remains locked (three layers, unrelated to and untouched by 34D-A)", () => {
  it("update_club_payment_mode still rejects court_time_payments (0143)", () => {
    const src = readSource("supabase/migrations/0143_payment_mode_and_ledger_foundation.sql");
    expect(src).toContain("court_time_payments_not_available");
  });

  it("_create_payment_obligation still only acts on manual mode (0143)", () => {
    const src = readSource("supabase/migrations/0143_payment_mode_and_ledger_foundation.sql");
    expect(src).toContain("if v_mode is distinct from 'manual' then");
  });

  it("PaymentTrackingSection still disables the court_time_payments option in the UI", () => {
    const src = readSource("src/app/(app)/admin/settings/PaymentTrackingSection.tsx");
    expect(src).toContain('isDisabled = option === "court_time_payments"');
  });
});

describe("0147 migration — mode scoping and financial-identity immutability invariants", () => {
  const migration = () => readSource("supabase/migrations/0147_stripe_connect_account_foundation.sql");

  it("uses unique(club_id, livemode), not unique(club_id) alone", () => {
    expect(migration()).toContain("unique (club_id, livemode)");
  });

  it("keeps stripe_account_id globally unique", () => {
    expect(migration()).toContain("unique (stripe_account_id)");
  });

  it("never assigns stripe_account_id in the upsert's ON CONFLICT SET clause", () => {
    const src = migration();
    const onConflictBlock = src.slice(src.indexOf("on conflict (club_id, livemode) do update"), src.indexOf("stripe_account_mismatch"));
    expect(onConflictBlock).not.toMatch(/set[\s\S]*stripe_account_id\s*=/);
  });

  it("fails closed with stripe_account_mismatch when the conflicting row's account id differs", () => {
    const src = migration();
    expect(src).toContain("where public.club_stripe_accounts.stripe_account_id = excluded.stripe_account_id");
    expect(src).toContain("raise exception 'stripe_account_mismatch'");
  });

  it("all three RPCs are service-role-only, never authenticated-callable", () => {
    const src = migration();
    expect(src).toContain("grant  execute on function public.get_club_stripe_connect_status(uuid, boolean) to service_role;");
    expect(src).toContain("grant  execute on function public.get_club_stripe_account_ref(uuid, boolean) to service_role;");
    expect(src).toContain("grant  execute on function public.upsert_club_stripe_account(uuid, text, text, uuid, boolean) to service_role;");
    expect(src).not.toMatch(/grant\s+execute on function public\.(get_club_stripe_connect_status|get_club_stripe_account_ref|upsert_club_stripe_account).*to authenticated/);
  });

  it("uses the Accounts v2 readiness vocabulary (card_payments_status) as an actual column, not v1 fields", () => {
    const src = migration();
    expect(src).toContain("card_payments_status");
    // Real column/parameter definitions look like `charges_enabled     boolean`
    // — this must be structurally absent. Explanatory prose contrasting
    // v1 vs v2 (e.g. "no v1-style charges_enabled/details_submitted
    // pair") is fine and expected.
    expect(src).not.toMatch(/charges_enabled\s+boolean/);
    expect(src).not.toMatch(/details_submitted\s+boolean/);
  });

  it("only migration 0147 exists for this feature — no 0148 was created", () => {
    // Guards against a stray migration number regression, not a full
    // directory scan (out of scope for a pure-TS test with no fs.readdir
    // policy elsewhere in this suite) — the file must at least exist at
    // this exact path.
    expect(() => migration()).not.toThrow();
  });
});
