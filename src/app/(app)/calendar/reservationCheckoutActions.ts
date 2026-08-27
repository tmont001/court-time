"use server";

// Phase 34D-D1 — Reservation Checkout (direct charge, Stripe-hosted).
// Member-only — enforced with defense in depth: this Server Action
// independently resolves the caller's CURRENT role via getAuthProfile()
// and requires role === "member" before any Stripe/payment-attempt
// mutation, and get_reservation_payment_for_checkout (0150) independently
// re-enforces the identical role requirement itself (raises
// insufficient_role otherwise) — an Admin/Staff/Pro who also happens to
// hold a roster identity in this club must not reach the checkout path
// through either layer. Independently re-derives the caller's own
// identity and ownership at every step — never trusts a client-supplied
// payment_id, club_id, amount, currency, connected Stripe account id, or
// livemode as authority. The ONLY client input is reservationId; every
// financial fact beyond it comes from the authenticated caller's own
// session plus the database.
//
// Mirrors the 34D-C-established pattern for livemode-sensitive operations:
// this Server Action independently authenticates the caller via the
// normal SSR client, derives livemode itself via getStripeContext(), and
// only then reaches through the privileged/service-role Supabase client
// for the parts of 0150's RPC surface that require it. No authenticated
// browser session can reach open_payment_checkout_attempt /
// record_checkout_session_created directly — both are service_role-only.

import { getAuthUser, getAuthProfile } from "@/lib/supabase/user";
import { createClient } from "@/lib/supabase/server";
import { assertActiveClub } from "@/lib/supabase/staleClub";
import { STALE_CLUB_CONTEXT_ERROR, STALE_CLUB_MESSAGE } from "@/lib/staleClub";
import { createPrivilegedClient } from "@/lib/supabase/privileged";
import { getStripeContext } from "@/lib/stripe/server";
import { SITE_URL } from "@/lib/siteUrl";
import { CONNECT_ACCOUNT_RETRIEVE_PARAMS, extractCardPaymentsStatus } from "@/lib/stripe/connectConfig";
import {
  buildReservationCheckoutIdempotencyKey,
  buildReservationCheckoutReturnUrls,
  buildReservationCheckoutSessionParams,
  computeReservationCheckoutExpiresAt,
  isReservationPaymentEligibleForCheckout,
  remainingCents,
} from "@/lib/stripe/paymentsConfig";

const ERROR_MESSAGES: Record<string, string> = {
  [STALE_CLUB_CONTEXT_ERROR]: STALE_CLUB_MESSAGE,
  not_authenticated: "You must be signed in.",
  insufficient_role: "Online payment is only available to Members paying their own booking.",
  reservation_not_found: "This booking's payment could not be found.",
  not_online_payable: "Online payment isn't available for this booking.",
  payment_not_open_for_checkout: "This balance can't be paid online right now — it may already be resolved.",
  no_balance_due: "This booking has no balance due.",
  court_time_payments_not_available: "Online payments aren't available right now. Please try again later.",
  stripe_connect_not_ready: "Online payments aren't available right now. Please try again later.",
  stale_attempt_environment_mismatch: "Online payments aren't available right now. Please try again later.",
  db_not_configured: "Something went wrong. Please try again.",
  stripe_error: "Stripe couldn't complete that request. Please try again.",
  checkout_attempt_not_found: "Something went wrong starting your payment. Please try again.",
  checkout_attempt_not_open: "This payment attempt is no longer open. Please try again.",
  checkout_session_mismatch: "Something went wrong starting your payment. Please try again.",
  invalid_arguments: "Something went wrong starting your payment. Please try again.",
  // A prior Checkout attempt for this booking already succeeded (or is in
  // the process of being confirmed) at Stripe — never create a second,
  // competing Session; webhook reconciliation will finish shortly.
  payment_processing: "Your payment is already being processed. Please check back in a moment.",
};

// Cheap, read-only — used only to decide whether the Pay Now button
// renders at all. Never consulted by createReservationCheckoutAction as
// authority for the actual money-relevant step, which always re-derives
// eligibility fresh itself.
export async function getReservationCheckoutEligibilityAction(
  reservationId: string,
  expectedClubId: string,
): Promise<{ eligible: boolean }> {
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { eligible: false };

  const user = await getAuthUser();
  if (!user) return { eligible: false };

  const profile = await getAuthProfile();
  if (!profile || profile.role !== "member") return { eligible: false };

  const supabase = await createClient();
  const { data } = await supabase.rpc("get_reservation_payment_for_checkout", {
    p_reservation_id: reservationId,
  });
  const row = data?.[0];
  if (!row) return { eligible: false };

  return {
    eligible: isReservationPaymentEligibleForCheckout({
      paymentModeAtCreation: row.payment_mode_at_creation,
      status: row.status,
      amountDueCents: row.amount_due_cents,
      amountPaidCents: row.amount_paid_cents,
    }),
  };
}

export async function createReservationCheckoutAction(
  reservationId: string,
  expectedClubId: string,
): Promise<{ url?: string; error?: string }> {
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: ERROR_MESSAGES[guard.error] };

  const user = await getAuthUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  // Defense in depth, layer 1 — the locked "authenticated Member only"
  // invariant. get_reservation_payment_for_checkout (0150) independently
  // re-enforces this same rule itself (layer 2) as a real database-level
  // check, not merely trusting this application-layer gate.
  const profile = await getAuthProfile();
  if (!profile || profile.role !== "member") {
    return { error: ERROR_MESSAGES.insufficient_role };
  }

  // Regular, RLS-respecting client — get_reservation_payment_for_checkout
  // (0150) independently re-derives the caller's own roster identity via
  // current_user_roster_member_id(); a row is only ever returned for the
  // caller's own reservation-backed obligation.
  const supabase = await createClient();
  const { data, error: readError } = await supabase.rpc("get_reservation_payment_for_checkout", {
    p_reservation_id: reservationId,
  });
  if (readError) {
    const key = readError.message.match(/not_authenticated|insufficient_role/)?.[0] ?? "";
    return { error: ERROR_MESSAGES[key] ?? ERROR_MESSAGES.reservation_not_found };
  }
  const row = data?.[0];
  if (!row) return { error: ERROR_MESSAGES.reservation_not_found };

  if (row.payment_mode_at_creation !== "court_time_payments") {
    return { error: ERROR_MESSAGES.not_online_payable };
  }
  if (row.status !== "unpaid" && row.status !== "partially_paid") {
    return { error: ERROR_MESSAGES.payment_not_open_for_checkout };
  }
  if (remainingCents(row.amount_due_cents, row.amount_paid_cents) <= 0) {
    return { error: ERROR_MESSAGES.no_balance_due };
  }

  const context = getStripeContext();
  if (!context) return { error: ERROR_MESSAGES.court_time_payments_not_available };

  const privileged = createPrivilegedClient();
  if (!privileged) return { error: ERROR_MESSAGES.db_not_configured };

  const { data: stripeAccountId } = await privileged.rpc("get_club_stripe_account_ref", {
    p_club_id: row.club_id,
    p_livemode: context.livemode,
  });
  if (!stripeAccountId) return { error: ERROR_MESSAGES.stripe_connect_not_ready };

  // Re-check readiness fresh against Stripe itself — a stale DB 'active'
  // value must never be sufficient to create money movement. Mirrors
  // stripeConnectShared.ts's syncAccountStatus / the account-events
  // webhook's own retrieve-then-sync shape.
  let account;
  try {
    account = await context.client.v2.core.accounts.retrieve(stripeAccountId, CONNECT_ACCOUNT_RETRIEVE_PARAMS);
  } catch {
    return { error: ERROR_MESSAGES.stripe_error };
  }

  const cardPaymentsStatus = extractCardPaymentsStatus(account);
  if (cardPaymentsStatus !== "active") {
    // Best-effort sync so a genuinely-changed status is reflected in
    // club_stripe_accounts even though this request is rejected either
    // way — errors here are ignored.
    await privileged.rpc("upsert_club_stripe_account", {
      p_club_id: row.club_id,
      p_stripe_account_id: stripeAccountId,
      p_card_payments_status: cardPaymentsStatus,
      p_actor_id: user.id,
      p_livemode: context.livemode,
    });
    return { error: ERROR_MESSAGES.stripe_connect_not_ready };
  }

  const { data: resolvedRows, error: resolveError } = await privileged.rpc("open_payment_checkout_attempt", {
    p_payment_id: row.payment_id,
    p_club_id: row.club_id,
    p_stripe_account_id: stripeAccountId,
    p_livemode: context.livemode,
    p_actor_id: user.id,
  });
  if (resolveError || !resolvedRows || resolvedRows.length === 0) {
    const key =
      resolveError?.message.match(
        /not_online_payable|payment_not_open_for_checkout|no_balance_due|payment_not_found|stale_attempt_environment_mismatch|invalid_arguments/,
      )?.[0] ?? "";
    return { error: ERROR_MESSAGES[key] ?? "Something went wrong. Please try again." };
  }
  // Loosely typed (action: string) since this local is reassigned below
  // from supersede_checkout_attempt_and_open_fresh's own result, whose
  // `action` literal union ("ready" | "already_completed") differs from
  // open_payment_checkout_attempt's own ("ready" | "must_expire_remote")
  // — both are otherwise structurally identical rows.
  let attempt: Omit<(typeof resolvedRows)[number], "action"> & { action: string } = resolvedRows[0];

  // Never knowingly expose two simultaneously payable Stripe Checkout
  // Sessions for the same payment. The database itself cannot call
  // Stripe or invalidate a remote Session's own URL — so when
  // open_payment_checkout_attempt reports an existing OPEN attempt needs
  // replacing but already has a bound Session that may still be payable,
  // NOTHING has been mutated locally yet. This orchestrates the required
  // Stripe round-trip before ever superseding it.
  if (attempt.action === "must_expire_remote") {
    if (!attempt.stripe_checkout_session_id) {
      // Structurally impossible (must_expire_remote is only ever
      // returned alongside a bound Session) — fail closed defensively
      // rather than guess.
      return { error: ERROR_MESSAGES.stripe_error };
    }

    let staleSession;
    try {
      staleSession = await context.client.checkout.sessions.retrieve(
        attempt.stripe_checkout_session_id,
        {},
        { stripeAccount: attempt.stripe_account_id },
      );
    } catch {
      // Cannot safely query the old Session — do not create a
      // replacement.
      return { error: ERROR_MESSAGES.stripe_error };
    }

    if (staleSession.status === "complete") {
      // Stripe already collected payment (or completed a no-payment
      // Session, which cannot apply here) on the old Session — never
      // create a competing one. Webhook reconciliation will finish this
      // shortly if it hasn't already.
      return { error: ERROR_MESSAGES.payment_processing };
    }

    if (staleSession.status === "open") {
      try {
        await context.client.checkout.sessions.expire(
          attempt.stripe_checkout_session_id,
          {},
          { stripeAccount: attempt.stripe_account_id },
        );
      } catch {
        // Cannot safely expire the old Session — do not create a
        // replacement.
        return { error: ERROR_MESSAGES.stripe_error };
      }
    }
    // staleSession.status === "expired" needs no Stripe action — already
    // not payable.

    const { data: supersededRows, error: supersedeError } = await privileged.rpc(
      "supersede_checkout_attempt_and_open_fresh",
      {
        p_stale_attempt_id: attempt.id,
        p_payment_id: row.payment_id,
        p_club_id: row.club_id,
        p_stripe_account_id: stripeAccountId,
        p_livemode: context.livemode,
        p_actor_id: user.id,
      },
    );
    if (supersedeError || !supersededRows || supersededRows.length === 0) {
      const key =
        supersedeError?.message.match(
          /not_online_payable|payment_not_open_for_checkout|no_balance_due|payment_not_found|checkout_attempt_not_found|invalid_arguments/,
        )?.[0] ?? "";
      return { error: ERROR_MESSAGES[key] ?? "Something went wrong. Please try again." };
    }
    const superseded = supersededRows[0];
    if (superseded.action === "already_completed") {
      // Resolved (most likely by the webhook) during the Stripe
      // round-trip above — never open a redundant attempt on top.
      return { error: ERROR_MESSAGES.payment_processing };
    }
    attempt = superseded;
  }

  // Server-derived club-local calendar date for the return URLs (Phase
  // 34D-D1 correction) — reuses /calendar's EXISTING ?date= navigation
  // mechanism (page.tsx's own initialDateISO, unchanged) so the returning
  // Member lands on the reservation's own day rather than /calendar's
  // default (today). Derived from the reservation's own starts_at and the
  // club's own timezone — never from anything client-supplied — using the
  // identical toLocaleDateString("en-CA", { timeZone }) idiom
  // calendar/page.tsx already uses for its own todayISO. A lookup failure
  // degrades gracefully (no date param) rather than blocking checkout.
  const [{ data: reservationRow }, { data: club }] = await Promise.all([
    supabase.from("reservations").select("starts_at").eq("id", reservationId).single(),
    supabase.from("clubs").select("timezone").eq("id", row.club_id).single(),
  ]);
  const reservationDateISO = reservationRow?.starts_at
    ? new Date(reservationRow.starts_at).toLocaleDateString("en-CA", {
        timeZone: club?.timezone ?? "America/New_York",
      })
    : null;

  const { successUrl, cancelUrl } = buildReservationCheckoutReturnUrls(SITE_URL, reservationId, reservationDateISO);

  let session;
  if (attempt.stripe_checkout_session_id) {
    // Reuse: retrieve the existing, still-valid remote Session directly —
    // never re-create with a fresh idempotency-key call, which would risk
    // Stripe rejecting it for a parameter mismatch now that expires_at is
    // a moving "now + lifetime" value on every genuinely new create call.
    try {
      session = await context.client.checkout.sessions.retrieve(
        attempt.stripe_checkout_session_id,
        {},
        { stripeAccount: stripeAccountId },
      );
    } catch {
      return { error: ERROR_MESSAGES.stripe_error };
    }
    if (session.status !== "open") {
      // Stripe is the final authority — fail closed rather than serve a
      // dead link, even though open_payment_checkout_attempt's own
      // stripe_session_expires_at check should already prevent reaching
      // here with a non-open Session under normal operation.
      return { error: ERROR_MESSAGES.stripe_error };
    }
  } else {
    // Fresh attempt — no remote Session exists yet, safe to create one.
    try {
      session = await context.client.checkout.sessions.create(
        buildReservationCheckoutSessionParams({
          amountCents: attempt.amount_expected_cents,
          currency: attempt.currency_expected,
          successUrl,
          cancelUrl,
          reservationId,
          paymentId: row.payment_id,
          attemptId: attempt.id,
          expiresAt: computeReservationCheckoutExpiresAt(attempt.created_at),
        }),
        {
          stripeAccount: stripeAccountId,
          idempotencyKey: buildReservationCheckoutIdempotencyKey(attempt.id),
        },
      );
    } catch {
      return { error: ERROR_MESSAGES.stripe_error };
    }

    if (!session.url || session.expires_at == null) return { error: ERROR_MESSAGES.stripe_error };

    // REQUIRED, not best-effort: process_stripe_payment_event (0150) finds
    // an attempt SOLELY by stripe_checkout_session_id — a Member must
    // never be sent to pay a Session Court Time has failed to durably
    // bind to its attempt, or a genuinely successful payment could never
    // be reconciled. record_checkout_session_created fails loudly
    // (raises) rather than silently affecting zero rows, so any failure
    // here is caught and the Member is never redirected to Stripe. A
    // retry of this whole action for the SAME attempt is still safe: the
    // attempt-derived Stripe idempotency key above means Stripe returns
    // the identical Session again, and binding the identical session id
    // again is this RPC's own idempotent success path.
    const { error: bindError } = await privileged.rpc("record_checkout_session_created", {
      p_attempt_id: attempt.id,
      p_stripe_checkout_session_id: session.id,
      p_stripe_session_expires_at: new Date(session.expires_at * 1000).toISOString(),
    });
    if (bindError) {
      const key =
        bindError.message.match(
          /checkout_attempt_not_found|checkout_attempt_not_open|checkout_session_mismatch|invalid_arguments/,
        )?.[0] ?? "";
      return { error: ERROR_MESSAGES[key] ?? "Something went wrong. Please try again." };
    }
  }

  if (!session.url) return { error: ERROR_MESSAGES.stripe_error };

  return { url: session.url };
}
