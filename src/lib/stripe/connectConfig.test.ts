import { describe, expect, it } from "vitest";
import {
  CONNECT_ACCOUNT_CREATE_PARAMS,
  buildConnectIdempotencyKey,
  buildAccountOnboardingLinkParams,
  extractCardPaymentsStatus,
  deriveLivemode,
  deriveConnectUIState,
  isAuthorizedToConnectStripe,
  SUPPORTED_ACCOUNT_LIFECYCLE_EVENT_TYPES,
  isSupportedAccountLifecycleEventType,
  isCourtTimePaymentsSelectable,
} from "./connectConfig";

// Phase 34D-A regression coverage for the concrete runtime failure: Stripe
// rejected POST /v1/accounts for this integration and requires Accounts
// v2. These tests exercise the real, production-used pure helpers (not a
// parallel reimplementation) that every Stripe-calling code path in this
// feature is built from.

describe("CONNECT_ACCOUNT_CREATE_PARAMS — locked Court Time Connect account model", () => {
  it("matches the exact locked configuration", () => {
    expect(CONNECT_ACCOUNT_CREATE_PARAMS.dashboard).toBe("full");
    expect(CONNECT_ACCOUNT_CREATE_PARAMS.configuration.merchant.capabilities.card_payments.requested).toBe(true);
    expect(CONNECT_ACCOUNT_CREATE_PARAMS.defaults.responsibilities.fees_collector).toBe("stripe");
    expect(CONNECT_ACCOUNT_CREATE_PARAMS.defaults.responsibilities.losses_collector).toBe("stripe");
  });

  it("requests configuration.merchant back so no separate retrieve is needed for the initial status", () => {
    expect(CONNECT_ACCOUNT_CREATE_PARAMS.include).toEqual(["configuration.merchant"]);
  });

  it("never sets requirements_collector — Stripe derives it in Accounts v2", () => {
    expect(CONNECT_ACCOUNT_CREATE_PARAMS.defaults).not.toHaveProperty("requirements_collector");
    expect(CONNECT_ACCOUNT_CREATE_PARAMS).not.toHaveProperty("requirements_collector");
  });

  // Regression coverage for the concrete runtime failure this correction
  // fixes: Stripe returned 400 identity_country_required — configuration.
  // merchant cannot be set without identity.country. Phase 34D supports
  // US-based clubs only.
  it("sets identity.country to us — required by Stripe before configuration.merchant can be set", () => {
    expect(CONNECT_ACCOUNT_CREATE_PARAMS.identity).toEqual({ country: "us" });
  });

  it("sets no other identity field — entity_type is not hard-coded", () => {
    expect(CONNECT_ACCOUNT_CREATE_PARAMS.identity).not.toHaveProperty("entity_type");
  });

  it("sets no business_details — Stripe-hosted onboarding collects legal/business info", () => {
    expect(CONNECT_ACCOUNT_CREATE_PARAMS.identity).not.toHaveProperty("business_details");
    expect(CONNECT_ACCOUNT_CREATE_PARAMS).not.toHaveProperty("business_details");
  });

  it("sets no address, tax, representative, or banking information", () => {
    const identityKeys = Object.keys(CONNECT_ACCOUNT_CREATE_PARAMS.identity);
    expect(identityKeys).toEqual(["country"]);
    expect(CONNECT_ACCOUNT_CREATE_PARAMS).not.toHaveProperty("external_account");
  });
});

describe("buildConnectIdempotencyKey — test/live separation", () => {
  it("is deterministic for the same club and mode", () => {
    const a = buildConnectIdempotencyKey("club-1", false);
    const b = buildConnectIdempotencyKey("club-1", false);
    expect(a).toBe(b);
  });

  it("differs between test and live for the same club — a club's future live account can never collide with its test account", () => {
    const test = buildConnectIdempotencyKey("club-1", false);
    const live = buildConnectIdempotencyKey("club-1", true);
    expect(test).not.toBe(live);
    expect(test).toContain("test");
    expect(live).toContain("live");
  });

  it("differs between clubs in the same mode", () => {
    const club1 = buildConnectIdempotencyKey("club-1", false);
    const club2 = buildConnectIdempotencyKey("club-2", false);
    expect(club1).not.toBe(club2);
  });
});

describe("buildAccountOnboardingLinkParams — Accounts v2 Account Link shape", () => {
  it("uses the nested use_case.account_onboarding shape, not a flat v1-style payload", () => {
    const params = buildAccountOnboardingLinkParams("acct_123", "https://example.com/refresh", "https://example.com/return");
    expect(params.account).toBe("acct_123");
    expect(params.use_case.type).toBe("account_onboarding");
    expect(params.use_case.account_onboarding.refresh_url).toBe("https://example.com/refresh");
    expect(params.use_case.account_onboarding.return_url).toBe("https://example.com/return");
  });

  it("requests the merchant configuration only", () => {
    const params = buildAccountOnboardingLinkParams("acct_123", "https://example.com/refresh", "https://example.com/return");
    expect(params.use_case.account_onboarding.configurations).toEqual(["merchant"]);
  });
});

describe("extractCardPaymentsStatus — Accounts v2 readiness, never v1 vocabulary", () => {
  it("passes through each documented Stripe status", () => {
    for (const status of ["active", "pending", "restricted", "unsupported"] as const) {
      expect(extractCardPaymentsStatus({ configuration: { merchant: { capabilities: { card_payments: { status } } } } })).toBe(status);
    }
  });

  it("falls back to pending (never fabricates active) when the field is entirely absent", () => {
    expect(extractCardPaymentsStatus({})).toBe("pending");
    expect(extractCardPaymentsStatus({ configuration: {} })).toBe("pending");
    expect(extractCardPaymentsStatus({ configuration: { merchant: {} } })).toBe("pending");
    expect(extractCardPaymentsStatus({ configuration: { merchant: { capabilities: {} } } })).toBe("pending");
  });

  it("falls back to pending for an unrecognized status value rather than trusting it blindly", () => {
    expect(
      extractCardPaymentsStatus({ configuration: { merchant: { capabilities: { card_payments: { status: "something_new" } } } } }),
    ).toBe("pending");
  });
});

describe("deriveLivemode — server-derived Stripe mode, fails closed on unrecognized keys", () => {
  it("recognizes live secret and restricted keys", () => {
    expect(deriveLivemode("sk_live_abc123")).toBe(true);
    expect(deriveLivemode("rk_live_abc123")).toBe(true);
  });

  it("recognizes test secret and restricted keys", () => {
    expect(deriveLivemode("sk_test_abc123")).toBe(false);
    expect(deriveLivemode("rk_test_abc123")).toBe(false);
  });

  it("fails closed (null) for an unrecognized or empty prefix — never guesses a mode", () => {
    expect(deriveLivemode("garbage")).toBeNull();
    expect(deriveLivemode("")).toBeNull();
    expect(deriveLivemode("pk_live_abc123")).toBeNull();
  });
});

describe("deriveConnectUIState — Accounts v2 readiness mapping", () => {
  it("no row -> not_connected regardless of any stale status value", () => {
    expect(deriveConnectUIState(false, "active")).toBe("not_connected");
    expect(deriveConnectUIState(false, null)).toBe("not_connected");
  });

  it("connected + active -> ready", () => {
    expect(deriveConnectUIState(true, "active")).toBe("ready");
  });

  it("connected + pending -> pending", () => {
    expect(deriveConnectUIState(true, "pending")).toBe("pending");
  });

  it("connected + restricted -> action_required", () => {
    expect(deriveConnectUIState(true, "restricted")).toBe("action_required");
  });

  it("connected + unsupported -> unsupported", () => {
    expect(deriveConnectUIState(true, "unsupported")).toBe("unsupported");
  });

  it("connected + an unrecognized/null status defensively requires action rather than claiming ready", () => {
    expect(deriveConnectUIState(true, null)).toBe("action_required");
  });
});

describe("isAuthorizedToConnectStripe — Admin-only, matching the update_club_payment_mode boundary", () => {
  it("only admin may initiate/manage Stripe Connect onboarding", () => {
    expect(isAuthorizedToConnectStripe("admin")).toBe(true);
  });

  it("staff, pro, and member cannot", () => {
    expect(isAuthorizedToConnectStripe("staff")).toBe(false);
    expect(isAuthorizedToConnectStripe("pro")).toBe(false);
    expect(isAuthorizedToConnectStripe("member")).toBe(false);
  });

  it("fails closed for null, undefined, and unrecognized values", () => {
    expect(isAuthorizedToConnectStripe(null)).toBe(false);
    expect(isAuthorizedToConnectStripe(undefined)).toBe(false);
    expect(isAuthorizedToConnectStripe("")).toBe(false);
    expect(isAuthorizedToConnectStripe("owner")).toBe(false);
  });
});

describe("SUPPORTED_ACCOUNT_LIFECYCLE_EVENT_TYPES / isSupportedAccountLifecycleEventType — Phase 34D-B", () => {
  it("subscribes to exactly the two locked thin-event types, no more", () => {
    expect(SUPPORTED_ACCOUNT_LIFECYCLE_EVENT_TYPES).toEqual([
      "v2.core.account[requirements].updated",
      "v2.core.account[configuration.merchant].capability_status_updated",
    ]);
  });

  it("recognizes both locked event types", () => {
    expect(isSupportedAccountLifecycleEventType("v2.core.account[requirements].updated")).toBe(true);
    expect(isSupportedAccountLifecycleEventType("v2.core.account[configuration.merchant].capability_status_updated")).toBe(true);
  });

  it("rejects the broader v1-style account.updated and other unrelated Account events — no unrelated event type is handled without a concrete reason", () => {
    expect(isSupportedAccountLifecycleEventType("v2.core.account.updated")).toBe(false);
    expect(isSupportedAccountLifecycleEventType("v2.core.account.created")).toBe(false);
    expect(isSupportedAccountLifecycleEventType("v2.core.account_person.created")).toBe(false);
    expect(isSupportedAccountLifecycleEventType("v2.core.account_link.returned")).toBe(false);
  });

  it("rejects a completely unrelated event type", () => {
    expect(isSupportedAccountLifecycleEventType("v2.commerce.product_catalog.imports.failed")).toBe(false);
  });
});

describe("isCourtTimePaymentsSelectable — Phase 34D-C activation-gate UI predicate", () => {
  it("only 'ready' (card_payments_status = active) is selectable", () => {
    expect(isCourtTimePaymentsSelectable("ready")).toBe(true);
  });

  it("every non-ready state is unselectable — not_connected, pending, restricted (action_required), unsupported", () => {
    expect(isCourtTimePaymentsSelectable("not_connected")).toBe(false);
    expect(isCourtTimePaymentsSelectable("pending")).toBe(false);
    expect(isCourtTimePaymentsSelectable("action_required")).toBe(false);
    expect(isCourtTimePaymentsSelectable("unsupported")).toBe(false);
  });

  it("composes correctly with deriveConnectUIState for the current real sandbox state (connected, restricted) — must remain unselectable", () => {
    const readiness = deriveConnectUIState(true, "restricted");
    expect(readiness).toBe("action_required");
    expect(isCourtTimePaymentsSelectable(readiness)).toBe(false);
  });

  it("composes correctly with deriveConnectUIState for a genuinely active account — becomes selectable", () => {
    const readiness = deriveConnectUIState(true, "active");
    expect(readiness).toBe("ready");
    expect(isCourtTimePaymentsSelectable(readiness)).toBe(true);
  });

  it("composes correctly with deriveConnectUIState for no connected account at all — unselectable", () => {
    const readiness = deriveConnectUIState(false, null);
    expect(isCourtTimePaymentsSelectable(readiness)).toBe(false);
  });
});
