// Phase 34D-A — plain server-only module (deliberately NOT "use server").
// Shared by stripeConnectActions.ts's Server Action (invoked from the
// Admin's browser via a button click), the Admin Settings page's status
// read, and the two Route Handlers under src/app/api/stripe/connect/
// (invoked by Stripe redirecting the browser back after onboarding).
// Kept out of the "use server" file so these internal helpers never get
// wrapped as client-invokable Server Actions — they're only ever called
// from other server code.
//
// Every function here that touches club_stripe_accounts derives livemode
// from getStripeContext() (the currently configured STRIPE_SECRET_KEY)
// itself — never accepts it as a parameter from a caller, so there is no
// path by which a client/query value could ever select test vs live.
//
// Accounts v2 throughout — see src/lib/stripe/connectConfig.ts's own
// header comment for why (POST /v1/accounts is no longer accepted for new
// Connect integrations).

import "server-only";
import { getAuthUser, getAuthProfile } from "@/lib/supabase/user";
import { createPrivilegedClient } from "@/lib/supabase/privileged";
import { getStripeContext } from "@/lib/stripe/server";
import {
  CONNECT_ACCOUNT_RETRIEVE_PARAMS,
  extractCardPaymentsStatus,
  isAuthorizedToConnectStripe,
  type CardPaymentsStatus,
} from "@/lib/stripe/connectConfig";

export interface ConnectStatus {
  connected: boolean;
  cardPaymentsStatus: CardPaymentsStatus | null;
  lastSyncedAt: string | null;
}

const NOT_CONNECTED_STATUS: ConnectStatus = {
  connected: false, cardPaymentsStatus: null, lastSyncedAt: null,
};

// Status read for the Admin Settings page. Resolves the caller as an
// Admin/Staff of a real club via the normal authenticated SSR client,
// derives livemode from the server's own Stripe configuration, and reads
// through the service-role RPC — the Stripe-linkage table itself has no
// authenticated-client grant at all (see 0147), so this is the only path
// by which the UI ever learns the connection status.
export async function getStripeConnectStatusForAdmin(): Promise<{
  configured: boolean;
  status: ConnectStatus;
}> {
  const profile = await getAuthProfile();
  if (!profile || (profile.role !== "admin" && profile.role !== "staff") || !profile.club_id) {
    return { configured: false, status: NOT_CONNECTED_STATUS };
  }

  const context = getStripeContext();
  if (!context) return { configured: false, status: NOT_CONNECTED_STATUS };

  const privileged = createPrivilegedClient();
  if (!privileged) return { configured: false, status: NOT_CONNECTED_STATUS };

  const { data } = await privileged.rpc("get_club_stripe_connect_status", {
    p_club_id: profile.club_id,
    p_livemode: context.livemode,
  });
  const row = data?.[0];
  if (!row) return { configured: true, status: NOT_CONNECTED_STATUS };

  return {
    configured: true,
    status: {
      connected: row.connected,
      cardPaymentsStatus: row.connected ? row.card_payments_status : null,
      lastSyncedAt: row.last_synced_at,
    },
  };
}

// Retrieves the account fresh from Stripe (Accounts v2) and syncs
// card_payments_status into club_stripe_accounts, scoped to the server's
// current Stripe mode. Never trusts "returned from Stripe" as proof of
// anything on its own — this is the only place that ever writes that
// field, always from a live Stripe read.
export async function syncAccountStatus(
  stripeAccountId: string,
  clubId: string,
  actorId: string,
): Promise<{ error?: string }> {
  const context = getStripeContext();
  if (!context) return { error: "stripe_not_configured" };

  const privileged = createPrivilegedClient();
  if (!privileged) return { error: "db_not_configured" };

  let account;
  try {
    account = await context.client.v2.core.accounts.retrieve(stripeAccountId, CONNECT_ACCOUNT_RETRIEVE_PARAMS);
  } catch {
    return { error: "stripe_error" };
  }

  const { error } = await privileged.rpc("upsert_club_stripe_account", {
    p_club_id: clubId,
    p_stripe_account_id: stripeAccountId,
    p_card_payments_status: extractCardPaymentsStatus(account),
    p_actor_id: actorId,
    p_livemode: context.livemode,
  });
  if (error) return { error: "db_not_configured" };

  return {};
}

// Resolves the caller as an authenticated Admin with an already-started
// Stripe connection IN THE SERVER'S CURRENT MODE, for the two Route
// Handlers below — never trusts anything from the URL/query string, only
// the caller's own authenticated session plus the server's own configured
// Stripe key. Returns a redirect destination instead of throwing/
// redirecting itself, so each Route Handler stays in charge of issuing
// its own NextResponse.redirect (plain server helpers and Next.js's
// Route-Handler-vs-Server-Action redirect() semantics don't compose
// cleanly, so this deliberately never calls next/navigation's redirect()).
export async function resolveAdminStripeAccount(): Promise<
  { clubId: string; userId: string; stripeAccountId: string } | { redirectTo: string }
> {
  const user = await getAuthUser();
  if (!user) return { redirectTo: "/sign-in" };

  const profile = await getAuthProfile();
  if (!profile || !isAuthorizedToConnectStripe(profile.role) || !profile.club_id) {
    return { redirectTo: "/calendar" };
  }

  const context = getStripeContext();
  if (!context) return { redirectTo: "/admin/settings" };

  const privileged = createPrivilegedClient();
  if (!privileged) return { redirectTo: "/admin/settings" };

  const { data: stripeAccountId } = await privileged.rpc("get_club_stripe_account_ref", {
    p_club_id: profile.club_id,
    p_livemode: context.livemode,
  });
  if (!stripeAccountId) return { redirectTo: "/admin/settings" };

  return { clubId: profile.club_id, userId: user.id, stripeAccountId };
}
