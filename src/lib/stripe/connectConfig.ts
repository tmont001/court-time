// Phase 34D-A — pure, side-effect-free Stripe Connect helpers. No secrets,
// no network I/O, no "server-only" guard — deliberately importable from
// tests and from Client Components alike (deriveConnectUIState is used by
// StripeConnectSection.tsx). The actual Stripe API calls live in
// src/lib/stripe/server.ts and stripeConnectShared.ts/stripeConnectActions.ts;
// this module exists so those call sites' request/response shapes and the
// UI's status derivation are built from one real, testable source rather
// than duplicated ad hoc at each call site.
//
// LOCKED Court Time Connect account model (Accounts v2):
//   dashboard: "full"
//   identity.country: "us" — Phase 34D supports US-based clubs only;
//     Stripe's own 400 (identity_country_required) confirmed this is
//     required before configuration.merchant can be set at all, not
//     optional. No other identity field is set — entity_type, legal
//     business name, address, tax info, and representative info are all
//     deliberately absent; Stripe-hosted onboarding collects those.
//   configuration.merchant.capabilities.card_payments.requested: true
//   defaults.responsibilities: { fees_collector: "stripe", losses_collector: "stripe" }
// i.e. full Stripe-hosted Dashboard access for the club, Stripe collects
// onboarding requirements (requirements_collector is derived by Stripe
// from these values in Accounts v2 — never set directly), Stripe bears
// fee/negative-balance responsibility, club is merchant of record for
// direct charges. Root-caused Phase 34D-A runtime failure: POST /v1/accounts
// is no longer accepted for new Connect integrations — Stripe requires
// POST /v2/core/accounts (stripe.v2.core.accounts.create in the SDK).
// There is no v1 account creation anywhere in this feature after this
// correction.

// Static half of the Accounts v2 create payload — the caller spreads this
// together with the two per-club dynamic fields (display_name, contact_email).
// `include` requests the capability status back in the same response, so
// the caller doesn't need a second retrieve just to learn the initial status.
export const CONNECT_ACCOUNT_CREATE_PARAMS = {
  dashboard: "full" as const,
  identity: {
    country: "us" as const,
  },
  configuration: {
    merchant: {
      capabilities: {
        card_payments: { requested: true as const },
      },
    },
  },
  defaults: {
    responsibilities: {
      fees_collector: "stripe" as const,
      losses_collector: "stripe" as const,
    },
  },
  // Mutable array (not `as const`) — the Stripe SDK's own param types
  // expect Array<...>, not a readonly tuple.
  include: ["configuration.merchant"] as Array<"configuration.merchant">,
};

// Same `include` value, reused for the retrieve-and-sync path (return
// route, and immediately after create) so both read the identical field.
export const CONNECT_ACCOUNT_RETRIEVE_PARAMS = {
  include: ["configuration.merchant"] as Array<"configuration.merchant">,
};

// Deterministic per-club, per-mode idempotency key for accounts.create.
// Two concurrent "Connect with Stripe" clicks for the same
// never-before-connected (club, mode) resolve to the SAME Stripe account
// instead of creating two. Keying by mode too means creating a club's
// live-mode account can never collide with its existing test-mode
// account's key (or vice versa).
export function buildConnectIdempotencyKey(clubId: string, livemode: boolean): string {
  return `connect-account-create:${clubId}:${livemode ? "live" : "test"}`;
}

// Accounts v2 Account Link create payload. The real (nested) shape per
// the installed SDK's own types — use_case.account_onboarding.configurations,
// not a flat top-level `configurations` — "merchant" only, matching the
// single configuration this integration ever requests.
export function buildAccountOnboardingLinkParams(
  accountId: string,
  refreshUrl: string,
  returnUrl: string,
) {
  return {
    account: accountId,
    use_case: {
      type: "account_onboarding" as const,
      account_onboarding: {
        // Mutable array (not `as const`) — the Stripe SDK's own param
        // types expect Array<...>, not a readonly tuple.
        configurations: ["merchant"],
        refresh_url: refreshUrl,
        return_url: returnUrl,
      },
    },
  };
}

// Stripe's own documented Accounts v2 capability statuses. Accounts v1's
// charges_enabled/details_submitted are NOT native Accounts v2 fields and
// are never used as a stand-in for them anywhere in this feature.
export type CardPaymentsStatus = "active" | "pending" | "restricted" | "unsupported";

const CARD_PAYMENTS_STATUSES: readonly CardPaymentsStatus[] = ["active", "pending", "restricted", "unsupported"];

// Extracts configuration.merchant.capabilities.card_payments.status from a
// v2 Account response (retrieved/created with CONNECT_ACCOUNT_*_PARAMS's
// `include`). Every link in that chain is optional in Stripe's own types
// (a configuration that hasn't been "applied" yet omits it) — falls back
// to "pending" (a real Stripe status, meaning "not yet confirmed active"),
// never fabricates "active" or leaves the caller with an unrecognized value.
export function extractCardPaymentsStatus(account: {
  configuration?: { merchant?: { capabilities?: { card_payments?: { status?: string } } } };
}): CardPaymentsStatus {
  const status = account.configuration?.merchant?.capabilities?.card_payments?.status;
  return (CARD_PAYMENTS_STATUSES as readonly string[]).includes(status ?? "")
    ? (status as CardPaymentsStatus)
    : "pending";
}

// The only role allowed to initiate/manage Stripe Connect onboarding —
// Staff/Pro/Member can never connect or mutate Stripe account
// configuration, matching Admin-only elsewhere in this checkpoint
// (update_club_payment_mode, PaymentTrackingSection). A pure predicate so
// this exact rule is unit-testable independent of any Supabase session.
export function isAuthorizedToConnectStripe(role: string | null | undefined): boolean {
  return role === "admin";
}

// Deterministic secret-key-prefix -> Stripe environment mapping. Fails
// closed (null) for a missing/unrecognized prefix rather than guessing —
// callers treat null identically to "not configured".
export function deriveLivemode(secretKey: string): boolean | null {
  if (secretKey.startsWith("sk_live_") || secretKey.startsWith("rk_live_")) return true;
  if (secretKey.startsWith("sk_test_") || secretKey.startsWith("rk_test_")) return false;
  return null;
}

// The Admin Settings UI's five possible states, derived from the DB row
// (or its absence) — never from raw Stripe fields directly, so the UI
// itself never has to know Accounts v1 vs v2 vocabulary.
export type ConnectUIState = "not_connected" | "pending" | "action_required" | "unsupported" | "ready";

export function deriveConnectUIState(
  connected: boolean,
  cardPaymentsStatus: CardPaymentsStatus | null,
): ConnectUIState {
  if (!connected) return "not_connected";
  switch (cardPaymentsStatus) {
    case "active": return "ready";
    case "pending": return "pending";
    case "restricted": return "action_required";
    case "unsupported": return "unsupported";
    default: return "action_required";
  }
}
