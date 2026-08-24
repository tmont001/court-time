// Phase 34D-A — Stripe redirects the Admin's browser here when their
// previous Account Link expired, was already visited, or is otherwise
// invalid. Account Links are single-use/short-lived by design, so the
// only correct response is to mint a fresh one for the SAME existing
// Stripe account (never create a second account) and send the Admin
// straight back into Connect Onboarding.
//
// Never trusts anything from the URL/query string — the caller's own
// authenticated session is the only input, resolved server-side.

import { NextResponse } from "next/server";
import { resolveAdminStripeAccount } from "@/app/(app)/admin/settings/stripeConnectShared";
import { getStripeContext } from "@/lib/stripe/server";
import { buildAccountOnboardingLinkParams } from "@/lib/stripe/connectConfig";
import { SITE_URL } from "@/lib/siteUrl";

export async function GET() {
  const resolved = await resolveAdminStripeAccount();
  if ("redirectTo" in resolved) {
    return NextResponse.redirect(new URL(resolved.redirectTo, SITE_URL));
  }

  // resolveAdminStripeAccount() already scoped its account lookup to the
  // server's current Stripe mode — this account id is guaranteed to
  // belong to that mode, so no separate mode check is needed here.
  const context = getStripeContext();
  if (!context) return NextResponse.redirect(new URL("/admin/settings", SITE_URL));

  try {
    const accountLink = await context.client.v2.core.accountLinks.create(
      buildAccountOnboardingLinkParams(
        resolved.stripeAccountId,
        `${SITE_URL}/api/stripe/connect/refresh`,
        `${SITE_URL}/api/stripe/connect/return`,
      ),
    );
    return NextResponse.redirect(accountLink.url);
  } catch {
    return NextResponse.redirect(new URL("/admin/settings", SITE_URL));
  }
}
