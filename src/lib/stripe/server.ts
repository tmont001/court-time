// Server-only. Never import from a Client Component or any module that
// could end up in the browser bundle.
//
// Phase 34D-A — the only client in the app that talks to the Stripe API.
// Mirrors src/lib/supabase/privileged.ts's own security discipline: a
// plain function (never a module-level singleton), returns null (never
// throws) when STRIPE_SECRET_KEY is unconfigured or unrecognized so
// callers fail closed instead of silently proceeding, and is guarded by
// "server-only" so an accidental client-side import is a build error
// rather than a runtime secret leak.
//
// This is Stripe Connect — a club collecting money from its own Members.
// It is a completely separate Stripe relationship from Court Time's own
// SaaS billing (club_subscriptions.stripe_customer_id/
// stripe_subscription_id, 0122) — this module is never used for that.
//
// API version pinned explicitly to the version bundled with the installed
// stripe SDK (node_modules/stripe's own ApiVersion constant) rather than
// left to the account's Dashboard-configured default, so behavior can't
// silently drift out from under this integration as the account's default
// version changes over time — the same "pin explicit values" discipline
// this codebase already uses for search_path everywhere. Accounts v2
// (stripe.v2.core.accounts / stripe.v2.core.accountLinks) is available on
// this exact pinned version — confirmed against the installed SDK's own
// type definitions, not assumed.
import "server-only";
import Stripe from "stripe";
import { deriveLivemode } from "./connectConfig";

const STRIPE_API_VERSION = "2026-07-29.dahlia";

export interface StripeContext {
  client: Stripe;
  // Derived from the configured secret key's own prefix (sk_live_ vs
  // sk_test_) — never a value any request/browser can influence. This is
  // the ONE source of truth for which Stripe environment this deployment
  // is talking to; every mode-scoped DB read/write in this feature uses
  // exactly this value, never a client-supplied one.
  livemode: boolean;
}

export function getStripeContext(): StripeContext | null {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) return null;

  const livemode = deriveLivemode(secretKey);
  if (livemode === null) return null;

  return {
    client: new Stripe(secretKey, { apiVersion: STRIPE_API_VERSION }),
    livemode,
  };
}
