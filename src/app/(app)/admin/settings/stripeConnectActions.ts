"use server";

// Phase 34D-A — Stripe Connect account foundation. ONLY connected-account
// creation/onboarding-link. No money movement, no webhook handling, no
// payment_mode widening — all out of scope for this checkpoint (see
// 0147's own header comment).
//
// Accounts v2 throughout (stripe.v2.core.accounts / stripe.v2.core.
// accountLinks) — see src/lib/stripe/connectConfig.ts's header comment
// for the root cause this corrects: POST /v1/accounts is no longer
// accepted for new Connect integrations.
//
// Admin-only. Independently authenticates the caller and resolves their
// real club_id server-side via getAuthProfile() (the authenticated,
// cookie-based SSR client) — never trusts a client-supplied club_id for
// the actual Stripe/DB operation. expectedClubId is accepted only for the
// same staleness-preflight UX assertActiveClub already provides elsewhere
// in this app; it is never the value actually used to create or look up a
// Stripe account.

import { getAuthUser, getAuthProfile } from "@/lib/supabase/user";
import { createClient } from "@/lib/supabase/server";
import { assertActiveClub } from "@/lib/supabase/staleClub";
import { STALE_CLUB_CONTEXT_ERROR, STALE_CLUB_MESSAGE } from "@/lib/staleClub";
import { createPrivilegedClient } from "@/lib/supabase/privileged";
import { getStripeContext } from "@/lib/stripe/server";
import { SITE_URL } from "@/lib/siteUrl";
import {
  CONNECT_ACCOUNT_CREATE_PARAMS,
  buildConnectIdempotencyKey,
  buildAccountOnboardingLinkParams,
  extractCardPaymentsStatus,
  isAuthorizedToConnectStripe,
} from "@/lib/stripe/connectConfig";

const ERROR_MESSAGES: Record<string, string> = {
  [STALE_CLUB_CONTEXT_ERROR]: STALE_CLUB_MESSAGE,
  not_authenticated: "You must be signed in.",
  insufficient_role: "You don't have permission to do that.",
  stripe_not_configured: "Court Time Payments isn't available yet. Contact support.",
  db_not_configured: "Something went wrong. Please try again.",
  stripe_error: "Stripe couldn't complete that request. Please try again.",
};

// "Connect with Stripe" / "Continue setup" — same action either way: reuse
// the club's existing Stripe account if one exists (never create a
// second), otherwise create one. Always ends by minting a fresh
// Account Link, since Account Links are single-use/short-lived and must
// never be reused across clicks.
export async function startStripeOnboardingAction(
  expectedClubId: string,
): Promise<{ url?: string; error?: string }> {
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: ERROR_MESSAGES[guard.error] };

  const user = await getAuthUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const profile = await getAuthProfile();
  if (!profile || !isAuthorizedToConnectStripe(profile.role) || !profile.club_id) {
    return { error: ERROR_MESSAGES.insufficient_role };
  }
  const clubId = profile.club_id;

  const context = getStripeContext();
  if (!context) return { error: ERROR_MESSAGES.stripe_not_configured };
  const { client: stripe, livemode } = context;

  const privileged = createPrivilegedClient();
  if (!privileged) return { error: ERROR_MESSAGES.db_not_configured };

  const { data: existingAccountId, error: refError } = await privileged.rpc(
    "get_club_stripe_account_ref",
    { p_club_id: clubId, p_livemode: livemode },
  );
  if (refError) return { error: ERROR_MESSAGES.db_not_configured };

  let stripeAccountId = existingAccountId ?? null;

  if (!stripeAccountId) {
    // Minimum genuinely-trusted Court Time data — never invented business/
    // legal data. Stripe-hosted onboarding collects everything else
    // (business details, KYC, representative info) itself.
    const supabase = await createClient();
    const { data: club } = await supabase.from("clubs").select("name").eq("id", clubId).single();

    let account;
    try {
      account = await stripe.v2.core.accounts.create(
        {
          ...CONNECT_ACCOUNT_CREATE_PARAMS,
          display_name: club?.name || undefined,
          contact_email: user.email || undefined,
        },
        // Deterministic per-club, PER-MODE idempotency key: two concurrent
        // "Connect with Stripe" clicks for the same never-before-connected
        // (club, mode) pair resolve to the SAME Stripe account instead of
        // creating two — this is the actual concurrency guard (the
        // get_club_stripe_account_ref lookup above narrows the window but
        // can't close a true race spanning two separate Node invocations
        // on its own). Keying by mode too means creating this club's
        // live-mode account (a separate, later click, under a live key)
        // can never collide with or reuse its existing test-mode account.
        { idempotencyKey: buildConnectIdempotencyKey(clubId, livemode) },
      );
    } catch {
      return { error: ERROR_MESSAGES.stripe_error };
    }

    const { error: upsertError } = await privileged.rpc("upsert_club_stripe_account", {
      p_club_id: clubId,
      p_stripe_account_id: account.id,
      p_card_payments_status: extractCardPaymentsStatus(account),
      p_actor_id: user.id,
      p_livemode: livemode,
    });
    if (upsertError) return { error: ERROR_MESSAGES.db_not_configured };

    stripeAccountId = account.id;
  }

  let accountLink;
  try {
    accountLink = await stripe.v2.core.accountLinks.create(
      buildAccountOnboardingLinkParams(
        stripeAccountId,
        `${SITE_URL}/api/stripe/connect/refresh`,
        `${SITE_URL}/api/stripe/connect/return`,
      ),
    );
  } catch {
    return { error: ERROR_MESSAGES.stripe_error };
  }

  return { url: accountLink.url };
}
