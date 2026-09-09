import { describe, expect, it } from "vitest";
import Stripe from "stripe";

// Phase 34D-B — real signature-verification tests, not mocks: uses the
// installed Stripe SDK's own stripe.webhooks.generateTestHeaderString
// ("Useful for signing payloads in unit tests" — the SDK's own docs) to
// construct a genuinely HMAC-signed webhook request, then verifies it
// with the exact same stripe.parseEventNotification call route.ts uses.
// Zero network calls (HMAC signing/verification is local crypto) and zero
// mocking of the Stripe SDK.
//
// This file deliberately does NOT import route.ts itself: route.ts's
// import chain includes src/lib/stripe/server.ts, which does `import
// "server-only"` — a bare specifier Next.js's own bundler resolves
// specially and which has no real package in node_modules, so it cannot
// be imported under plain Vite/Vitest (this repository's test baseline;
// see vitest.config.mts) without either installing a new dependency or
// adding a synthetic alias/stub, neither of which this checkpoint's scope
// justifies. Instead: the signature-verification mechanism itself (what
// actually decides "invalid signature" / "missing signature" cases 1-2)
// is tested directly here against the raw SDK, and the route's own
// orchestration around it (which env var gates which failure, which
// event types short-circuit to a 200 no-op, which SDK/RPC calls happen in
// which order) is covered by source-inspection in
// stripeConnect.regression.test.ts, matching the same strategy already
// established there for 34D-A's Stripe-calling files.

const TEST_WEBHOOK_SECRET = "whsec_test_secret_for_unit_tests_only";
const TEST_STRIPE_KEY = "sk_test_unit_test_fake_key";
const signingStripe = new Stripe(TEST_STRIPE_KEY, { apiVersion: "2026-07-29.dahlia" });

function thinEventPayload(overrides: Partial<{ id: string; type: string; livemode: boolean }> = {}): string {
  return JSON.stringify({
    id: overrides.id ?? "evt_test_123",
    object: "v2.core.event",
    type: overrides.type ?? "v2.core.account[requirements].updated",
    livemode: overrides.livemode ?? false,
    created: "2026-01-01T00:00:00Z",
    related_object: {
      id: "acct_test_123",
      type: "v2.core.account",
      url: "/v2/core/accounts/acct_test_123",
    },
  });
}

describe("Stripe Connect account-events webhook — signature verification (real SDK, no network)", () => {
  it("accepts a genuinely signed thin-event payload and parses its type/livemode/related_object correctly", () => {
    const payload = thinEventPayload({ type: "v2.core.account[requirements].updated", livemode: false });
    const header = signingStripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET });

    const notification = signingStripe.parseEventNotification(payload, header, TEST_WEBHOOK_SECRET);

    expect(notification.type).toBe("v2.core.account[requirements].updated");
    expect(notification.livemode).toBe(false);
    expect(notification.id).toBe("evt_test_123");
  });

  it("preserves livemode=true from a genuinely signed live-mode event — never defaulted or guessed", () => {
    const payload = thinEventPayload({ livemode: true });
    const header = signingStripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET });

    const notification = signingStripe.parseEventNotification(payload, header, TEST_WEBHOOK_SECRET);

    expect(notification.livemode).toBe(true);
  });

  it("rejects a payload signed with the wrong secret", () => {
    const payload = thinEventPayload();
    const header = signingStripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_a_completely_different_secret" });

    expect(() => signingStripe.parseEventNotification(payload, header, TEST_WEBHOOK_SECRET)).toThrow();
  });

  it("rejects a body that doesn't match what was signed (tampered after signing)", () => {
    const originalPayload = thinEventPayload();
    const header = signingStripe.webhooks.generateTestHeaderString({ payload: originalPayload, secret: TEST_WEBHOOK_SECRET });
    const tamperedPayload = thinEventPayload({ id: "evt_attacker_injected" });

    expect(() => signingStripe.parseEventNotification(tamperedPayload, header, TEST_WEBHOOK_SECRET)).toThrow();
  });

  it("rejects a garbage/missing signature header outright", () => {
    const payload = thinEventPayload();
    expect(() => signingStripe.parseEventNotification(payload, "not-a-real-signature-header", TEST_WEBHOOK_SECRET)).toThrow();
  });
});
