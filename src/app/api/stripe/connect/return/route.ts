// Phase 34D-A — Stripe redirects the Admin's browser here after they
// finish (or abandon) the Connect Onboarding flow. Returning here is NOT
// itself proof onboarding completed — this always re-retrieves the
// account from Stripe (Accounts v2) and syncs the real
// configuration.merchant.capabilities.card_payments.status before
// sending the Admin back to Settings, so the UI only ever shows "Ready"
// once Stripe has actually confirmed it.
//
// Never trusts anything from the URL/query string — the caller's own
// authenticated session is the only input, resolved server-side.

import { NextResponse } from "next/server";
import { resolveAdminStripeAccount, syncAccountStatus } from "@/app/(app)/admin/settings/stripeConnectShared";
import { SITE_URL } from "@/lib/siteUrl";

export async function GET() {
  const resolved = await resolveAdminStripeAccount();
  if ("redirectTo" in resolved) {
    return NextResponse.redirect(new URL(resolved.redirectTo, SITE_URL));
  }

  await syncAccountStatus(resolved.stripeAccountId, resolved.clubId, resolved.userId);
  return NextResponse.redirect(new URL("/admin/settings", SITE_URL));
}
