"use server";

// Phase 34F-B — Event Checkout (direct charge, Stripe-hosted).
// Member-only — enforced with defense in depth, mirroring
// lessonCheckoutActions.ts's own established pattern exactly: this Server
// Action independently resolves the caller's CURRENT role via
// getAuthProfile() and requires role === "member" before any Stripe/
// payment-attempt mutation, and get_event_payment_for_checkout (0161)
// independently re-enforces the identical role/ownership requirement
// itself (raises insufficient_role/returns no eligible row otherwise) — an
// Admin/Staff/Pro who also happens to hold a roster identity in this club
// must not reach the checkout path through either layer, and Event Guest
// (no roster identity to match) is structurally unreachable regardless of
// input. Independently re-derives the caller's own identity and ownership
// at every step — never trusts a client-supplied payment_id, club_id,
// amount, currency, connected Stripe account id, or livemode as authority.
// The ONLY client input is eventId; every financial fact beyond it comes
// from the authenticated caller's own session plus the database.
//
// Reuses the SAME domain-agnostic Checkout machinery reservations/lessons
// use (record_checkout_session_created, process_stripe_payment_event) —
// only the ownership/eligibility read (get_event_payment_for_checkout) and
// the pure Stripe param/return-URL builders (buildEventCheckoutSessionPara
// ms/buildEventCheckoutReturnUrls/buildEventCheckoutIdempotencyKey) are
// event-specific; everything else below mirrors lessonCheckoutActions.ts's
// own control flow line-for-line, including the identical must_expire_
// remote Stripe round-trip orchestration for a stale existing attempt.
//
// The actual attempt-opening calls below go through open_event_payment_
// checkout_attempt / supersede_event_checkout_attempt_and_open_fresh
// (0161), NOT the raw open_payment_checkout_attempt / supersede_checkout_
// attempt_and_open_fresh reservations call directly. Those two event-aware
// wrappers lock the events row, re-verify the Event is scheduled/non-
// archived AND the caller's own participant is still confirmed UNDER that
// lock, and only then delegate to the existing, unmodified RPCs — closing
// the TOCTOU race between get_event_payment_for_checkout's own read
// (above) and the money-moving attempt-open step, where a concurrent
// Admin/Pro cancellation, removal, or material edit could otherwise
// interleave. The shared attempt algorithm itself is never duplicated.

import { getAuthUser, getAuthProfile } from "@/lib/supabase/user";
import { createClient } from "@/lib/supabase/server";
import { assertActiveClub } from "@/lib/supabase/staleClub";
import { STALE_CLUB_CONTEXT_ERROR, STALE_CLUB_MESSAGE } from "@/lib/staleClub";
import { createPrivilegedClient } from "@/lib/supabase/privileged";
import { getStripeContext } from "@/lib/stripe/server";
import { SITE_URL } from "@/lib/siteUrl";
import { CONNECT_ACCOUNT_RETRIEVE_PARAMS, extractCardPaymentsStatus } from "@/lib/stripe/connectConfig";
import {
  buildEventCheckoutIdempotencyKey,
  buildEventCheckoutReturnUrls,
  buildEventCheckoutSessionParams,
  computeReservationCheckoutExpiresAt,
  isReservationPaymentEligibleForCheckout,
  remainingCents,
} from "@/lib/stripe/paymentsConfig";

const ERROR_MESSAGES: Record<string, string> = {
  [STALE_CLUB_CONTEXT_ERROR]: STALE_CLUB_MESSAGE,
  not_authenticated: "You must be signed in.",
  insufficient_role: "Online payment is only available to Members paying for their own event registration.",
  event_payment_not_found: "This event's payment could not be found.",
  // The atomic attempt-opening wrapper's own fresh, under-lock re-check
  // found the Event no longer scheduled/archived, or the caller's own
  // participant no longer confirmed, between the eligibility read above and
  // this step — a concurrent cancellation/removal/material edit won the
  // race. Never a client-triggerable condition to distinguish further.
  event_not_found: "This event's payment could not be found.",
  event_not_scheduled: "This event is no longer scheduled, so it can't be paid online right now.",
  event_participant_not_found: "You're not currently registered for this event.",
  event_participant_not_confirmed: "Your registration is no longer confirmed, so it can't be paid online right now.",
  not_online_payable: "Online payment isn't available for this event.",
  payment_not_open_for_checkout: "This balance can't be paid online right now — it may already be resolved.",
  no_balance_due: "This event registration has no balance due.",
  court_time_payments_not_available: "Online payments aren't available right now. Please try again later.",
  stripe_connect_not_ready: "Online payments aren't available right now. Please try again later.",
  stale_attempt_environment_mismatch: "Online payments aren't available right now. Please try again later.",
  db_not_configured: "Something went wrong. Please try again.",
  stripe_error: "Stripe couldn't complete that request. Please try again.",
  checkout_attempt_not_found: "Something went wrong starting your payment. Please try again.",
  checkout_attempt_not_open: "This payment attempt is no longer open. Please try again.",
  checkout_session_mismatch: "Something went wrong starting your payment. Please try again.",
  invalid_arguments: "Something went wrong starting your payment. Please try again.",
  // A prior Checkout attempt for this event registration already succeeded
  // (or is in the process of being confirmed) at Stripe — never create a
  // second, competing Session; webhook reconciliation will finish shortly.
  payment_processing: "Your payment is already being processed. Please check back in a moment.",
};

// Runtime QA (34F-B) — server-side observability only, never user-facing.
// Mirrors lessonCheckoutActions.ts's own established
// logUnexpectedLessonCheckoutError pattern exactly: an infrastructure-level
// failure (a DB/RPC error the ERROR_MESSAGES map doesn't recognize, or a
// Stripe call that threw) must never vanish into an undiagnosable generic
// "Something went wrong" with zero server-side trace. Logs only an event
// id, the failing stage, and a sanitized error code/message — never
// secrets, JWTs, PII, Stripe keys, or full row/error objects. The
// Member-facing message returned alongside this call is unchanged — this
// is additive logging only, never a UX change.
function logUnexpectedEventCheckoutError(
  stage: string,
  eventId: string,
  err: { message?: string; code?: string } | null,
) {
  console.error(`[event-checkout] ${stage}`, {
    event_id: eventId,
    code: err?.code ?? null,
    message: err?.message ?? null,
  });
}

// Cheap, read-only — used only to decide whether the Pay Now button
// renders at all. Never consulted by createEventCheckoutAction as
// authority for the actual money-relevant step, which always re-derives
// eligibility fresh itself.
export async function getEventCheckoutEligibilityAction(
  eventId: string,
  expectedClubId: string,
): Promise<{ eligible: boolean }> {
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { eligible: false };

  const user = await getAuthUser();
  if (!user) return { eligible: false };

  const profile = await getAuthProfile();
  if (!profile || profile.role !== "member") return { eligible: false };

  const supabase = await createClient();
  const { data } = await supabase.rpc("get_event_payment_for_checkout", {
    p_event_id: eventId,
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

export async function createEventCheckoutAction(
  eventId: string,
  expectedClubId: string,
  clubTimezone: string,
): Promise<{ url?: string; error?: string }> {
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: ERROR_MESSAGES[guard.error] };

  const user = await getAuthUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  // Defense in depth, layer 1 — the locked "authenticated Member only"
  // invariant. get_event_payment_for_checkout (0161) independently
  // re-enforces this same rule itself (layer 2) as a real database-level
  // check, not merely trusting this application-layer gate.
  const profile = await getAuthProfile();
  if (!profile || profile.role !== "member") {
    return { error: ERROR_MESSAGES.insufficient_role };
  }

  // Regular, RLS-respecting client — get_event_payment_for_checkout (0161)
  // independently re-derives the caller's own roster identity via
  // current_user_roster_member_id(); a row is only ever returned for the
  // caller's own confirmed event_participants-backed obligation.
  const supabase = await createClient();
  const { data, error: readError } = await supabase.rpc("get_event_payment_for_checkout", {
    p_event_id: eventId,
  });
  if (readError) {
    const key = readError.message.match(/not_authenticated|insufficient_role/)?.[0] ?? "";
    return { error: ERROR_MESSAGES[key] ?? ERROR_MESSAGES.event_payment_not_found };
  }
  const row = data?.[0];
  if (!row) return { error: ERROR_MESSAGES.event_payment_not_found };

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
  // createLessonCheckoutAction's own identical re-check.
  let account;
  try {
    account = await context.client.v2.core.accounts.retrieve(stripeAccountId, CONNECT_ACCOUNT_RETRIEVE_PARAMS);
  } catch (err) {
    logUnexpectedEventCheckoutError("connected_account_retrieve", eventId, err as { message?: string; code?: string });
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

  // Phase 34F-B — the event-aware atomic wrapper, never the raw
  // open_payment_checkout_attempt directly. Locks the events row,
  // re-verifies the Event is scheduled/non-archived AND the caller's own
  // participant is still confirmed UNDER that lock, and only then
  // delegates to open_payment_checkout_attempt — see this file's own
  // header comment for the full race this closes.
  const { data: resolvedRows, error: resolveError } = await privileged.rpc("open_event_payment_checkout_attempt", {
    p_event_id: eventId,
    p_club_id: row.club_id,
    p_stripe_account_id: stripeAccountId,
    p_livemode: context.livemode,
    p_actor_id: user.id,
  });
  if (resolveError || !resolvedRows || resolvedRows.length === 0) {
    const key =
      resolveError?.message.match(
        /event_not_found|event_not_scheduled|event_participant_not_found|event_participant_not_confirmed|not_online_payable|payment_not_open_for_checkout|no_balance_due|payment_not_found|stale_attempt_environment_mismatch|invalid_arguments/,
      )?.[0] ?? "";
    if (!ERROR_MESSAGES[key]) {
      // Unrecognized error (or zero rows with no error at all) — the
      // exact scenario runtime QA needs surfaced. Never silently
      // swallowed into the generic fallback without a server-side trace.
      logUnexpectedEventCheckoutError("open_event_payment_checkout_attempt", eventId, resolveError);
    }
    return { error: ERROR_MESSAGES[key] ?? "Something went wrong. Please try again." };
  }
  // Loosely typed (action: string) since this local is reassigned below
  // from supersede_checkout_attempt_and_open_fresh's own result, whose
  // `action` literal union ("ready" | "already_completed") differs from
  // open_payment_checkout_attempt's own ("ready" | "must_expire_remote")
  // — both are otherwise structurally identical rows. Mirrors
  // createLessonCheckoutAction's own identical handling.
  let attempt: Omit<(typeof resolvedRows)[number], "action"> & { action: string } = resolvedRows[0];

  // Never knowingly expose two simultaneously payable Stripe Checkout
  // Sessions for the same payment — identical orchestration to
  // createLessonCheckoutAction's own must_expire_remote handling.
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
    } catch (err) {
      // Cannot safely query the old Session — do not create a
      // replacement.
      logUnexpectedEventCheckoutError("stale_session_retrieve", eventId, err as { message?: string; code?: string });
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
      } catch (err) {
        // Cannot safely expire the old Session — do not create a
        // replacement.
        logUnexpectedEventCheckoutError("stale_session_expire", eventId, err as { message?: string; code?: string });
        return { error: ERROR_MESSAGES.stripe_error };
      }
    }
    // staleSession.status === "expired" needs no Stripe action — already
    // not payable.

    // Phase 34F-B — the SAME atomic-lock pattern applied to this secondary
    // attempt-opening call site: the Stripe round-trip above (retrieve/
    // expire the stale Session) cannot hold a DB lock, so a concurrent
    // cancellation/removal/material edit could win the events row lock
    // during it. Re-verifies Event scheduled + participant confirmed
    // fresh, under lock, before delegating to supersede_checkout_attempt_
    // and_open_fresh.
    const { data: supersededRows, error: supersedeError } = await privileged.rpc(
      "supersede_event_checkout_attempt_and_open_fresh",
      {
        p_event_id: eventId,
        p_stale_attempt_id: attempt.id,
        p_club_id: row.club_id,
        p_stripe_account_id: stripeAccountId,
        p_livemode: context.livemode,
        p_actor_id: user.id,
      },
    );
    if (supersedeError || !supersededRows || supersededRows.length === 0) {
      const key =
        supersedeError?.message.match(
          /event_not_found|event_not_scheduled|event_participant_not_found|event_participant_not_confirmed|not_online_payable|payment_not_open_for_checkout|no_balance_due|payment_not_found|checkout_attempt_not_found|invalid_arguments/,
        )?.[0] ?? "";
      if (!ERROR_MESSAGES[key]) {
        logUnexpectedEventCheckoutError("supersede_event_checkout_attempt_and_open_fresh", eventId, supersedeError);
      }
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

  // /calendar is date-navigated (unlike /my-schedule's flat lesson list) —
  // eventDateISO is derived here, server-side, from the Event's own
  // starts_at (returned by get_event_payment_for_checkout above) + the
  // caller-supplied club timezone, mirroring buildReservationCheckoutRetur
  // nUrls's own reservationDateISO derivation exactly. Never client-
  // supplied.
  const eventDateISO = row.event_starts_at
    ? new Date(row.event_starts_at).toLocaleDateString("en-CA", { timeZone: clubTimezone })
    : null;
  const { successUrl, cancelUrl } = buildEventCheckoutReturnUrls(SITE_URL, eventId, eventDateISO);

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
    } catch (err) {
      logUnexpectedEventCheckoutError("checkout_session_reuse_retrieve", eventId, err as { message?: string; code?: string });
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
        buildEventCheckoutSessionParams({
          amountCents: attempt.amount_expected_cents,
          currency: attempt.currency_expected,
          successUrl,
          cancelUrl,
          eventId,
          paymentId: row.payment_id,
          attemptId: attempt.id,
          expiresAt: computeReservationCheckoutExpiresAt(attempt.created_at),
        }),
        {
          stripeAccount: stripeAccountId,
          idempotencyKey: buildEventCheckoutIdempotencyKey(attempt.id),
        },
      );
    } catch (err) {
      logUnexpectedEventCheckoutError("checkout_session_create", eventId, err as { message?: string; code?: string });
      return { error: ERROR_MESSAGES.stripe_error };
    }

    if (!session.url || session.expires_at == null) {
      logUnexpectedEventCheckoutError("checkout_session_create", eventId, {
        message: `session missing url/expires_at (url=${!!session.url}, expires_at=${session.expires_at})`,
      });
      return { error: ERROR_MESSAGES.stripe_error };
    }

    // REQUIRED, not best-effort: process_stripe_payment_event finds an
    // attempt SOLELY by stripe_checkout_session_id — a Member must never
    // be sent to pay a Session Court Time has failed to durably bind to
    // its attempt, or a genuinely successful payment could never be
    // reconciled. record_checkout_session_created fails loudly (raises)
    // rather than silently affecting zero rows, so any failure here is
    // caught and the Member is never redirected to Stripe. A retry of
    // this whole action for the SAME attempt is still safe: the attempt-
    // derived Stripe idempotency key above means Stripe returns the
    // identical Session again, and binding the identical session id again
    // is this RPC's own idempotent success path.
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
      if (!ERROR_MESSAGES[key]) {
        logUnexpectedEventCheckoutError("record_checkout_session_created", eventId, bindError);
      }
      return { error: ERROR_MESSAGES[key] ?? "Something went wrong. Please try again." };
    }
  }

  if (!session.url) {
    logUnexpectedEventCheckoutError("final_session_url_check", eventId, null);
    return { error: ERROR_MESSAGES.stripe_error };
  }

  return { url: session.url };
}
