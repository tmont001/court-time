// Phase 34D-D1 — pure, side-effect-free Stripe Checkout/payment helpers. No
// secrets, no network I/O, no "server-only" guard — deliberately importable
// from tests and Server Actions alike, mirroring connectConfig.ts's own
// separation. Connect account lifecycle (connectConfig.ts,
// src/app/api/stripe/connect/) and reservation Checkout (this file,
// src/app/api/stripe/payments/) are deliberately separate modules with
// separate webhook endpoints, separate Stripe event families (Accounts v2
// thin events vs. classic v1 Checkout/Event objects), and separate
// env-configured webhook secrets — never sharing a signature-verification
// path.
//
// LOCKED Court Time reservation Checkout model:
//   mode: "payment" — one-time, never subscription.
//   payment_method_types: ["card"] — cards only, never Elements/custom
//     form, never async payment methods.
//   Created via the connected club account's own context (RequestOptions.
//     stripeAccount) — a DIRECT charge, never a destination charge.
//   No application_fee_amount anywhere — Court Time takes zero
//     per-transaction percentage in this checkpoint.
//   No customer / saved payment method params — never persisted for reuse.

// Deterministic per-attempt idempotency key. Two calls for the SAME
// attempt id (double click, browser retry, or a deliberate re-open of a
// still-fresh existing attempt — see 0150's open_payment_checkout_attempt)
// resolve to the SAME Checkout Session at Stripe's own idempotency layer,
// rather than creating a duplicate. Never derived from anything a browser
// supplies.
export function buildReservationCheckoutIdempotencyKey(attemptId: string): string {
  return `reservation-checkout:${attemptId}`;
}

// A deliberately short, explicit lifetime for an interactive checkout —
// the minimum Stripe allows (30 minutes to 24 hours; Stripe's own
// default, absent this, is 24 hours). Storing/checking Stripe's own
// authoritative expires_at (0150's payment_checkout_attempts.stripe_
// session_expires_at) is what makes a stale bound Session reliably
// detected, rather than trusting an arbitrary local freshness guess.
export const RESERVATION_CHECKOUT_SESSION_LIFETIME_SECONDS = 30 * 60;

// Deterministic across concurrent requests for the SAME attempt (two
// browser tabs / a double click racing to create a Session for the same
// freshly-opened attempt): derived from the attempt's own already-
// persisted created_at, never from Date.now() computed independently by
// each caller — required so both concurrent Checkout Session create calls
// send a byte-identical expires_at, letting Stripe's own idempotency-key
// replay return the cached original Session rather than rejecting the
// second call for a parameter mismatch. Floored to "at least the full
// lifetime from right now" for the rare case of a much-delayed retry
// against a long-stale unbound attempt, where Stripe would otherwise
// reject an expires_at that's already too close to (or past) now.
export function computeReservationCheckoutExpiresAt(attemptCreatedAtISO: string): number {
  const fromAttemptCreation =
    Math.floor(new Date(attemptCreatedAtISO).getTime() / 1000) + RESERVATION_CHECKOUT_SESSION_LIFETIME_SECONDS;
  const minimumFromNow = Math.floor(Date.now() / 1000) + RESERVATION_CHECKOUT_SESSION_LIFETIME_SECONDS;
  return Math.max(fromAttemptCreation, minimumFromNow);
}

export interface ReservationCheckoutSessionInput {
  amountCents: number;
  // ISO 4217, uppercase (matches payments.currency's own CHECK, 0143).
  currency: string;
  successUrl: string;
  cancelUrl: string;
  reservationId: string;
  paymentId: string;
  attemptId: string;
  // Epoch seconds — see computeReservationCheckoutExpiresAt above.
  expiresAt: number;
}

// Pure parameter construction — no Stripe API call. The caller passes the
// returned object as the first argument to stripe.checkout.sessions.create,
// together with { stripeAccount, idempotencyKey } as the second
// (RequestOptions) argument — never merged into this object, so a direct-
// charge connected-account call can never be mistaken for a platform-
// account call at the call site.
export function buildReservationCheckoutSessionParams(input: ReservationCheckoutSessionInput) {
  return {
    mode: "payment" as const,
    payment_method_types: ["card"] as Array<"card">,
    line_items: [
      {
        price_data: {
          currency: input.currency.toLowerCase(),
          product_data: { name: "Court reservation payment" },
          unit_amount: input.amountCents,
        },
        quantity: 1,
      },
    ],
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    expires_at: input.expiresAt,
    client_reference_id: input.reservationId,
    // Observability only, never authorization — the webhook RPC
    // (0150's process_stripe_payment_event) never reads metadata; it
    // matches purely on the verified Session id against the stored
    // attempt row.
    metadata: {
      payment_id: input.paymentId,
      reservation_id: input.reservationId,
      attempt_id: input.attemptId,
    },
  };
}

// Server-side success/cancel destinations — never client-influenced. Both
// return the browser to the existing /calendar surface (the only place a
// Member sees this reservation's live payment state today); a reservation
// id in the query string is not sensitive (it grants no access on its own
// — RLS/ownership checks still gate all real data) and only exists so
// /calendar can re-open that reservation's detail sheet, which shows
// authoritative, freshly-fetched DB state — the redirect itself never
// marks anything paid.
//
// reservationDateISO (YYYY-MM-DD, club-local) is embedded as the SAME
// `date=` query parameter /calendar already reads (page.tsx's existing
// `initialDateISO` mechanism) — reusing that existing calendar/date-
// navigation pattern is what lands the returning Member on the
// reservation's own day rather than /calendar's default (today), with no
// new client-side date-jump logic required. The caller derives this value
// server-side from the reservation's own starts_at + the club's timezone
// — never from anything client-supplied. Omitted (no `date=` param) when
// unavailable, so a lookup failure degrades to today's date rather than
// blocking the redirect.
export function buildReservationCheckoutReturnUrls(
  siteUrl: string,
  reservationId: string,
  reservationDateISO: string | null,
): { successUrl: string; cancelUrl: string } {
  const dateParam = reservationDateISO ? `date=${reservationDateISO}&` : "";
  return {
    successUrl: `${siteUrl}/calendar?${dateParam}checkout=success&reservation=${reservationId}`,
    cancelUrl: `${siteUrl}/calendar?${dateParam}checkout=cancel&reservation=${reservationId}`,
  };
}

// Phase 34F-A — Lesson Online Payment Expansion. The reservation Checkout
// machinery above (open_payment_checkout_attempt, process_stripe_payment_
// event, and this file's own computeReservationCheckoutExpiresAt/
// remainingCents/isReservationPaymentEligibleForCheckout) is domain-
// agnostic already and reused UNCHANGED for lessons — see
// lessonCheckoutActions.ts. Only the pure string-building below (Stripe
// line-item product name, metadata keys, return-URL destination) is
// genuinely domain-specific and gets its own small lesson sibling here,
// exactly mirroring the reservation functions' own shape.

export function buildLessonCheckoutIdempotencyKey(attemptId: string): string {
  return `lesson-checkout:${attemptId}`;
}

export interface LessonCheckoutSessionInput {
  amountCents: number;
  // ISO 4217, uppercase (matches payments.currency's own CHECK, 0143).
  currency: string;
  successUrl: string;
  cancelUrl: string;
  lessonRequestId: string;
  paymentId: string;
  attemptId: string;
  // Epoch seconds — see computeReservationCheckoutExpiresAt above (reused
  // unchanged for lessons; the expiry math has no domain-specific input).
  expiresAt: number;
}

// Pure parameter construction — no Stripe API call. Mirrors
// buildReservationCheckoutSessionParams exactly, differing only in the
// Stripe-hosted product name and the metadata/client_reference_id identity
// key (lesson_request_id instead of reservation_id).
export function buildLessonCheckoutSessionParams(input: LessonCheckoutSessionInput) {
  return {
    mode: "payment" as const,
    payment_method_types: ["card"] as Array<"card">,
    line_items: [
      {
        price_data: {
          currency: input.currency.toLowerCase(),
          product_data: { name: "Tennis lesson payment" },
          unit_amount: input.amountCents,
        },
        quantity: 1,
      },
    ],
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    expires_at: input.expiresAt,
    client_reference_id: input.lessonRequestId,
    // Observability only, never authorization — the webhook RPC
    // (process_stripe_payment_event) never reads metadata; it matches
    // purely on the verified Session id against the stored attempt row.
    metadata: {
      payment_id: input.paymentId,
      lesson_request_id: input.lessonRequestId,
      attempt_id: input.attemptId,
    },
  };
}

// Server-side success/cancel destinations — never client-influenced. Both
// return the browser to /my-schedule?tab=lessons (the only place a Member
// sees their own lesson payment state today), mirroring
// buildReservationCheckoutReturnUrls's own reasoning exactly. No date-jump
// parameter is needed here (unlike /calendar): the lessons tab is a flat
// request list, not date-navigated.
export function buildLessonCheckoutReturnUrls(
  siteUrl: string,
  lessonRequestId: string,
): { successUrl: string; cancelUrl: string } {
  return {
    successUrl: `${siteUrl}/my-schedule?tab=lessons&checkout=success&lesson=${lessonRequestId}`,
    cancelUrl: `${siteUrl}/my-schedule?tab=lessons&checkout=cancel&lesson=${lessonRequestId}`,
  };
}

// Phase 34F-B — Event Online Payment Expansion. Mirrors the Lesson sibling
// above exactly (own product name + metadata/client_reference_id identity
// key, event_id instead of lesson_request_id) — reservation Checkout's own
// domain-agnostic machinery (open_payment_checkout_attempt, process_stripe_
// payment_event, computeReservationCheckoutExpiresAt/remainingCents/
// isReservationPaymentEligibleForCheckout below) is reused unchanged.
//
// Stripe display evidence (34F-B audit): "Event payment" is a fixed,
// generic product name — never the Event's own title, date/time, or court
// — exactly matching "Court reservation payment"/"Tennis lesson payment"
// above. This is why title changes do not invalidate an open Event
// Checkout attempt (0161's own header comment): the Member never sees the
// title on the Stripe-hosted page regardless of whether it changed.

export function buildEventCheckoutIdempotencyKey(attemptId: string): string {
  return `event-checkout:${attemptId}`;
}

export interface EventCheckoutSessionInput {
  amountCents: number;
  // ISO 4217, uppercase (matches payments.currency's own CHECK, 0143).
  currency: string;
  successUrl: string;
  cancelUrl: string;
  eventId: string;
  paymentId: string;
  attemptId: string;
  // Epoch seconds — see computeReservationCheckoutExpiresAt above (reused
  // unchanged for events; the expiry math has no domain-specific input).
  expiresAt: number;
}

// Pure parameter construction — no Stripe API call. Mirrors
// buildReservationCheckoutSessionParams/buildLessonCheckoutSessionParams
// exactly, differing only in the Stripe-hosted product name and the
// metadata/client_reference_id identity key (event_id instead of
// reservation_id/lesson_request_id).
export function buildEventCheckoutSessionParams(input: EventCheckoutSessionInput) {
  return {
    mode: "payment" as const,
    payment_method_types: ["card"] as Array<"card">,
    line_items: [
      {
        price_data: {
          currency: input.currency.toLowerCase(),
          product_data: { name: "Event payment" },
          unit_amount: input.amountCents,
        },
        quantity: 1,
      },
    ],
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    expires_at: input.expiresAt,
    client_reference_id: input.eventId,
    // Observability only, never authorization — the webhook RPC
    // (process_stripe_payment_event) never reads metadata; it matches
    // purely on the verified Session id against the stored attempt row.
    metadata: {
      payment_id: input.paymentId,
      event_id: input.eventId,
      attempt_id: input.attemptId,
    },
  };
}

// Server-side success/cancel destinations — never client-influenced. Both
// return the browser to /calendar (the only place a Member sees Event
// detail/payment state today, per the 34F-B audit's own canonical-surface
// finding), mirroring buildReservationCheckoutReturnUrls's own reasoning
// exactly, including the same optional `date=` jump parameter — /calendar
// is date-navigated like Reservation's own surface (unlike /my-schedule's
// flat lesson list). eventDateISO is derived server-side by the caller from
// the Event's own starts_at + the club's timezone — never client-supplied.
export function buildEventCheckoutReturnUrls(
  siteUrl: string,
  eventId: string,
  eventDateISO: string | null,
): { successUrl: string; cancelUrl: string } {
  const dateParam = eventDateISO ? `date=${eventDateISO}&` : "";
  return {
    successUrl: `${siteUrl}/calendar?${dateParam}checkout=success&event=${eventId}`,
    cancelUrl: `${siteUrl}/calendar?${dateParam}checkout=cancel&event=${eventId}`,
  };
}

// Phase 34F-C — Programs Online Payment Expansion. Mirrors the Lesson/
// Event siblings above exactly (own product name + metadata/client_
// reference_id identity key). LOCKED domain semantics: whole-program
// enrollment is ONE purchase for the entire Program (payment domain_type =
// 'program_enrollment', domain_id = program_enrollments.id). The identity
// key here is programId, not the enrollment id: get_program_payment_for_
// checkout (0163) deliberately returns only the fields required by
// Checkout, and the enrollment id is not one of them (the return route,
// /events, is keyed by program, not by enrollment — mirroring buildEventChe
// ckoutReturnUrls's own use of eventId, not the participant row id).
// payment_id (below, in metadata) already fully and uniquely identifies
// the specific payments row/domain_id server-side; program_id here is
// purely a human-observability aid, exactly like event_id's own role in
// the Event sibling.
//
// Stripe display evidence (34F-C audit, same reasoning as Event/Lesson
// above): "Program payment" is a fixed, generic product name — never the
// Program's own title — so a Program title/description edit can never be
// payment-material regardless of edit path.

export function buildProgramCheckoutIdempotencyKey(attemptId: string): string {
  return `program-checkout:${attemptId}`;
}

export interface ProgramCheckoutSessionInput {
  amountCents: number;
  // ISO 4217, uppercase (matches payments.currency's own CHECK, 0143).
  currency: string;
  successUrl: string;
  cancelUrl: string;
  programId: string;
  paymentId: string;
  attemptId: string;
  // Epoch seconds — see computeReservationCheckoutExpiresAt above (reused
  // unchanged for programs; the expiry math has no domain-specific input).
  expiresAt: number;
}

// Pure parameter construction — no Stripe API call. Mirrors
// buildEventCheckoutSessionParams exactly, differing only in the
// Stripe-hosted product name and the metadata/client_reference_id identity
// key (program_id instead of event_id).
export function buildProgramCheckoutSessionParams(input: ProgramCheckoutSessionInput) {
  return {
    mode: "payment" as const,
    payment_method_types: ["card"] as Array<"card">,
    line_items: [
      {
        price_data: {
          currency: input.currency.toLowerCase(),
          product_data: { name: "Program payment" },
          unit_amount: input.amountCents,
        },
        quantity: 1,
      },
    ],
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    expires_at: input.expiresAt,
    client_reference_id: input.programId,
    // Observability only, never authorization — the webhook RPC
    // (process_stripe_payment_event) never reads metadata; it matches
    // purely on the verified Session id against the stored attempt row.
    metadata: {
      payment_id: input.paymentId,
      program_id: input.programId,
      attempt_id: input.attemptId,
    },
  };
}

// Server-side success/cancel destinations — never client-influenced. Both
// return the browser to /events (the ONE canonical Member Program surface,
// per this checkpoint's own locked UI decision — never /calendar, never
// /my-schedule), mirroring buildEventCheckoutReturnUrls's own reasoning.
// No date-jump parameter is needed here (unlike /calendar): /events is a
// flat upcoming-programs list, not date-navigated. programId is embedded
// so the return page can re-locate the correct ProgramEnrollmentCard.
export function buildProgramCheckoutReturnUrls(
  siteUrl: string,
  programId: string,
): { successUrl: string; cancelUrl: string } {
  return {
    successUrl: `${siteUrl}/events?checkout=success&program=${programId}`,
    cancelUrl: `${siteUrl}/events?checkout=cancel&program=${programId}`,
  };
}

export interface ReservationPaymentEligibility {
  paymentModeAtCreation: string;
  status: string;
  amountDueCents: number;
  amountPaidCents: number;
}

// Mirrors 0150's own open_payment_checkout_attempt gate exactly
// (payment_mode_at_creation = 'court_time_payments', status open, a
// genuinely positive remaining balance). Used ONLY to decide whether the
// Member-facing Pay Now UI should render at all — the actual
// money-relevant step (checkout creation) always re-derives this fresh
// server-side via get_reservation_payment_for_checkout + the RPC above,
// never trusts this function's result as authority.
export function isReservationPaymentEligibleForCheckout(
  row: ReservationPaymentEligibility | null | undefined,
): boolean {
  if (!row) return false;
  return (
    row.paymentModeAtCreation === "court_time_payments" &&
    (row.status === "unpaid" || row.status === "partially_paid") &&
    row.amountDueCents > row.amountPaidCents
  );
}

export function remainingCents(amountDueCents: number, amountPaidCents: number): number {
  return amountDueCents - amountPaidCents;
}

// The single Stripe event type this checkpoint's payment webhook acts on —
// checkout.session.completed, and ONLY when the Session's own
// payment_status indicates paid (checked separately by the route from the
// verified Session object itself, never assumed from the event type
// alone). No refund/dispute/failure lifecycle event is handled here.
export const SUPPORTED_PAYMENT_WEBHOOK_EVENT_TYPE = "checkout.session.completed" as const;

export function isSupportedPaymentWebhookEventType(
  type: string,
): type is typeof SUPPORTED_PAYMENT_WEBHOOK_EVENT_TYPE {
  return type === SUPPORTED_PAYMENT_WEBHOOK_EVENT_TYPE;
}
