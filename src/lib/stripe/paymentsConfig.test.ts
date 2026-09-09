import { describe, expect, it } from "vitest";
import {
  buildEventCheckoutIdempotencyKey,
  buildEventCheckoutReturnUrls,
  buildEventCheckoutSessionParams,
  buildLessonCheckoutIdempotencyKey,
  buildLessonCheckoutReturnUrls,
  buildLessonCheckoutSessionParams,
  buildReservationCheckoutIdempotencyKey,
  buildReservationCheckoutReturnUrls,
  buildReservationCheckoutSessionParams,
  computeReservationCheckoutExpiresAt,
  isReservationPaymentEligibleForCheckout,
  isSupportedPaymentWebhookEventType,
  remainingCents,
  RESERVATION_CHECKOUT_SESSION_LIFETIME_SECONDS,
  SUPPORTED_PAYMENT_WEBHOOK_EVENT_TYPE,
} from "./paymentsConfig";

// Phase 34D-D1 — regression coverage for the real, production-used pure
// helpers every reservation-Checkout code path is built from (not a
// parallel reimplementation).

describe("RESERVATION_CHECKOUT_SESSION_LIFETIME_SECONDS — deliberately short, explicit interactive-checkout lifetime", () => {
  it("is exactly 30 minutes — the minimum Stripe allows (Stripe's own default, absent this, is 24 hours)", () => {
    expect(RESERVATION_CHECKOUT_SESSION_LIFETIME_SECONDS).toBe(30 * 60);
  });
});

describe("computeReservationCheckoutExpiresAt — deterministic across concurrent requests for the same attempt", () => {
  it("is a pure function of its input — the SAME created_at always yields the SAME output, which is what makes two concurrent requests for the same attempt send byte-identical expires_at values to Stripe", () => {
    const createdAt = new Date().toISOString();
    const a = computeReservationCheckoutExpiresAt(createdAt);
    const b = computeReservationCheckoutExpiresAt(createdAt);
    expect(a).toBe(b);
  });

  it("for a genuinely fresh created_at, the result equals created_at + the full lifetime (the max() staleness floor does not kick in)", () => {
    const createdAt = new Date().toISOString();
    const result = computeReservationCheckoutExpiresAt(createdAt);
    const fromCreation = Math.floor(new Date(createdAt).getTime() / 1000) + RESERVATION_CHECKOUT_SESSION_LIFETIME_SECONDS;
    expect(result).toBe(fromCreation);
  });

  it("floors to at least the full lifetime from right now for a long-stale created_at — never returns an expires_at Stripe would reject as already in the past", () => {
    const longAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(); // 3 hours ago
    const result = computeReservationCheckoutExpiresAt(longAgo);
    const minimumFromNow = Math.floor(Date.now() / 1000) + RESERVATION_CHECKOUT_SESSION_LIFETIME_SECONDS;
    expect(result).toBeGreaterThanOrEqual(minimumFromNow);
  });

});

describe("buildReservationCheckoutIdempotencyKey — stable server-derived key, never browser-supplied", () => {
  it("is deterministic for the same attempt id", () => {
    const a = buildReservationCheckoutIdempotencyKey("attempt-1");
    const b = buildReservationCheckoutIdempotencyKey("attempt-1");
    expect(a).toBe(b);
  });

  it("differs between attempts", () => {
    const a = buildReservationCheckoutIdempotencyKey("attempt-1");
    const b = buildReservationCheckoutIdempotencyKey("attempt-2");
    expect(a).not.toBe(b);
  });
});

describe("buildReservationCheckoutSessionParams — locked direct-charge Checkout model", () => {
  const params = buildReservationCheckoutSessionParams({
    amountCents: 4500,
    currency: "USD",
    successUrl: "https://example.com/calendar?checkout=success&reservation=r1",
    cancelUrl: "https://example.com/calendar?checkout=cancel&reservation=r1",
    reservationId: "r1",
    paymentId: "p1",
    attemptId: "a1",
    expiresAt: 1700003600,
  });

  it("uses mode=payment — never subscription/setup", () => {
    expect(params.mode).toBe("payment");
  });

  it("restricts payment_method_types to cards only — no Elements, no async payment methods", () => {
    expect(params.payment_method_types).toEqual(["card"]);
  });

  it("never sets application_fee_amount, on_behalf_of, or a customer — no destination charge, no per-transaction fee, no saved payment method", () => {
    expect(params).not.toHaveProperty("application_fee_amount");
    expect(params).not.toHaveProperty("on_behalf_of");
    expect(params).not.toHaveProperty("customer");
    expect(params).not.toHaveProperty("payment_intent_data");
  });

  it("passes the exact amount/currency through as the line item's price_data — never re-derives or rounds", () => {
    expect(params.line_items[0].price_data.unit_amount).toBe(4500);
    expect(params.line_items[0].price_data.currency).toBe("usd");
    expect(params.line_items[0].quantity).toBe(1);
  });

  it("carries only internal identifiers in metadata — never PII, never treated as authorization by this module", () => {
    expect(params.metadata).toEqual({ payment_id: "p1", reservation_id: "r1", attempt_id: "a1" });
  });

  it("uses the exact success/cancel URLs passed in — never invents its own", () => {
    expect(params.success_url).toBe("https://example.com/calendar?checkout=success&reservation=r1");
    expect(params.cancel_url).toBe("https://example.com/calendar?checkout=cancel&reservation=r1");
  });
});

describe("buildReservationCheckoutReturnUrls — server-derived from a trusted base URL", () => {
  it("builds /calendar destinations carrying the reservation id, distinct success vs cancel, with no date param when none is supplied", () => {
    const { successUrl, cancelUrl } = buildReservationCheckoutReturnUrls("https://court-time.app", "res-123", null);
    expect(successUrl).toBe("https://court-time.app/calendar?checkout=success&reservation=res-123");
    expect(cancelUrl).toBe("https://court-time.app/calendar?checkout=cancel&reservation=res-123");
    expect(successUrl).not.toBe(cancelUrl);
  });

  // Fix 3 (34D-D1 correction round 3): a future-date reservation must
  // return the Member to /calendar on THAT reservation's own day, via the
  // existing ?date= navigation parameter — not /calendar's default
  // (today). This is the exact mechanism: the server-derived club-local
  // date is embedded directly in the URL page.tsx already reads into
  // initialDateISO, unchanged.
  it("embeds a supplied club-local reservation date using the SAME `date=` query parameter /calendar's page.tsx already reads (initialDateISO) — lands a future-date reservation on its own day, not today's default", () => {
    const { successUrl, cancelUrl } = buildReservationCheckoutReturnUrls(
      "https://court-time.app",
      "res-123",
      "2026-09-01",
    );
    expect(successUrl).toBe("https://court-time.app/calendar?date=2026-09-01&checkout=success&reservation=res-123");
    expect(cancelUrl).toBe("https://court-time.app/calendar?date=2026-09-01&checkout=cancel&reservation=res-123");
  });
});

describe("remainingCents — the authoritative outstanding-balance computation", () => {
  it("is due minus paid", () => {
    expect(remainingCents(5000, 2000)).toBe(3000);
  });

  it("is zero or negative when fully paid/overpaid — never treated as chargeable", () => {
    expect(remainingCents(5000, 5000)).toBe(0);
    expect(remainingCents(5000, 6000)).toBe(-1000);
  });
});

describe("isReservationPaymentEligibleForCheckout — the UI Pay Now gate (never the money-moving authority)", () => {
  const base = {
    paymentModeAtCreation: "court_time_payments",
    status: "unpaid",
    amountDueCents: 5000,
    amountPaidCents: 0,
  };

  it("eligible: court_time_payments, open status, positive remaining balance", () => {
    expect(isReservationPaymentEligibleForCheckout(base)).toBe(true);
    expect(isReservationPaymentEligibleForCheckout({ ...base, status: "partially_paid", amountPaidCents: 2000 })).toBe(true);
  });

  it("ineligible: obligation created under manual mode, even if the club currently has court_time_payments on", () => {
    expect(isReservationPaymentEligibleForCheckout({ ...base, paymentModeAtCreation: "manual" })).toBe(false);
  });

  it("ineligible: no balance due (zero/paid/overpaid/refunded/waived/void all fail the status or remaining-balance gate)", () => {
    expect(isReservationPaymentEligibleForCheckout({ ...base, amountDueCents: 0, amountPaidCents: 0 })).toBe(false);
    expect(isReservationPaymentEligibleForCheckout({ ...base, status: "paid", amountPaidCents: 5000 })).toBe(false);
    expect(isReservationPaymentEligibleForCheckout({ ...base, status: "overpaid", amountPaidCents: 6000 })).toBe(false);
    expect(isReservationPaymentEligibleForCheckout({ ...base, status: "refunded", amountPaidCents: 0 })).toBe(false);
    expect(isReservationPaymentEligibleForCheckout({ ...base, status: "waived", amountPaidCents: 0 })).toBe(false);
    expect(isReservationPaymentEligibleForCheckout({ ...base, status: "void", amountPaidCents: 0 })).toBe(false);
  });

  it("fails closed for a missing row (no obligation exists at all)", () => {
    expect(isReservationPaymentEligibleForCheckout(null)).toBe(false);
    expect(isReservationPaymentEligibleForCheckout(undefined)).toBe(false);
  });
});

// Phase 34F-A — lesson_request checkout builders. isReservationPaymentEligible
// ForCheckout, computeReservationCheckoutExpiresAt, and remainingCents are
// reused UNCHANGED for lessons (already fully domain-agnostic, see their own
// describe blocks above) — only the genuinely domain-specific string-
// building below gets its own lesson sibling.

describe("buildLessonCheckoutIdempotencyKey — stable server-derived key, distinct namespace from reservations", () => {
  it("is deterministic for the same attempt id", () => {
    const a = buildLessonCheckoutIdempotencyKey("attempt-1");
    const b = buildLessonCheckoutIdempotencyKey("attempt-1");
    expect(a).toBe(b);
  });

  it("differs between attempts", () => {
    const a = buildLessonCheckoutIdempotencyKey("attempt-1");
    const b = buildLessonCheckoutIdempotencyKey("attempt-2");
    expect(a).not.toBe(b);
  });

  it("never collides with a reservation attempt's own key for the same attempt id — distinct Stripe idempotency namespace", () => {
    const lessonKey = buildLessonCheckoutIdempotencyKey("shared-id");
    const reservationKey = buildReservationCheckoutIdempotencyKey("shared-id");
    expect(lessonKey).not.toBe(reservationKey);
  });
});

describe("buildLessonCheckoutSessionParams — same locked direct-charge Checkout model as reservations, lesson-flavored identity", () => {
  const params = buildLessonCheckoutSessionParams({
    amountCents: 8000,
    currency: "USD",
    successUrl: "https://example.com/my-schedule?tab=lessons&checkout=success&lesson=l1",
    cancelUrl: "https://example.com/my-schedule?tab=lessons&checkout=cancel&lesson=l1",
    lessonRequestId: "l1",
    paymentId: "p1",
    attemptId: "a1",
    expiresAt: 1700003600,
  });

  it("uses mode=payment — never subscription/setup", () => {
    expect(params.mode).toBe("payment");
  });

  it("restricts payment_method_types to cards only — no Elements, no async payment methods", () => {
    expect(params.payment_method_types).toEqual(["card"]);
  });

  it("never sets application_fee_amount, on_behalf_of, or a customer — no destination charge, no per-transaction fee, no saved payment method", () => {
    expect(params).not.toHaveProperty("application_fee_amount");
    expect(params).not.toHaveProperty("on_behalf_of");
    expect(params).not.toHaveProperty("customer");
    expect(params).not.toHaveProperty("payment_intent_data");
  });

  it("passes the exact amount/currency through as the line item's price_data — never re-derives or rounds", () => {
    expect(params.line_items[0].price_data.unit_amount).toBe(8000);
    expect(params.line_items[0].price_data.currency).toBe("usd");
    expect(params.line_items[0].quantity).toBe(1);
  });

  it("uses a lesson-specific product name, distinct from the reservation line item's own wording", () => {
    expect(params.line_items[0].price_data.product_data.name).toBe("Tennis lesson payment");
    const reservationParams = buildReservationCheckoutSessionParams({
      amountCents: 8000,
      currency: "USD",
      successUrl: "x",
      cancelUrl: "x",
      reservationId: "r1",
      paymentId: "p1",
      attemptId: "a1",
      expiresAt: 1700003600,
    });
    expect(params.line_items[0].price_data.product_data.name).not.toBe(
      reservationParams.line_items[0].price_data.product_data.name,
    );
  });

  it("carries only internal identifiers in metadata, keyed lesson_request_id (never reservation_id) — never PII, never treated as authorization", () => {
    expect(params.metadata).toEqual({ payment_id: "p1", lesson_request_id: "l1", attempt_id: "a1" });
  });

  it("uses client_reference_id = lessonRequestId", () => {
    expect(params.client_reference_id).toBe("l1");
  });

  it("uses the exact success/cancel URLs passed in — never invents its own", () => {
    expect(params.success_url).toBe("https://example.com/my-schedule?tab=lessons&checkout=success&lesson=l1");
    expect(params.cancel_url).toBe("https://example.com/my-schedule?tab=lessons&checkout=cancel&lesson=l1");
  });
});

describe("buildLessonCheckoutReturnUrls — server-derived from a trusted base URL, distinct destination from reservations", () => {
  it("builds /my-schedule?tab=lessons destinations carrying the lesson request id, distinct success vs cancel", () => {
    const { successUrl, cancelUrl } = buildLessonCheckoutReturnUrls("https://court-time.app", "lesson-123");
    expect(successUrl).toBe("https://court-time.app/my-schedule?tab=lessons&checkout=success&lesson=lesson-123");
    expect(cancelUrl).toBe("https://court-time.app/my-schedule?tab=lessons&checkout=cancel&lesson=lesson-123");
    expect(successUrl).not.toBe(cancelUrl);
  });

  it("never targets /calendar — a lesson payment must never return the Member to the reservation surface", () => {
    const { successUrl, cancelUrl } = buildLessonCheckoutReturnUrls("https://court-time.app", "lesson-123");
    expect(successUrl).not.toContain("/calendar");
    expect(cancelUrl).not.toContain("/calendar");
  });
});

describe("buildEventCheckoutIdempotencyKey — stable server-derived key, distinct namespace from reservations/lessons", () => {
  it("is deterministic for the same attempt id", () => {
    const a = buildEventCheckoutIdempotencyKey("attempt-1");
    const b = buildEventCheckoutIdempotencyKey("attempt-1");
    expect(a).toBe(b);
  });

  it("differs for a different attempt id", () => {
    const a = buildEventCheckoutIdempotencyKey("attempt-1");
    const b = buildEventCheckoutIdempotencyKey("attempt-2");
    expect(a).not.toBe(b);
  });

  it("differs from the reservation/lesson key for the SAME attempt id — no cross-domain idempotency collision", () => {
    const eventKey = buildEventCheckoutIdempotencyKey("shared-id");
    const reservationKey = buildReservationCheckoutIdempotencyKey("shared-id");
    const lessonKey = buildLessonCheckoutIdempotencyKey("shared-id");
    expect(eventKey).not.toBe(reservationKey);
    expect(eventKey).not.toBe(lessonKey);
  });
});

describe("buildEventCheckoutSessionParams — same locked direct-charge Checkout model as reservations/lessons, event-flavored identity, generic (non-title) product name", () => {
  const params = buildEventCheckoutSessionParams({
    amountCents: 5000,
    currency: "USD",
    successUrl: "https://example.com/calendar?checkout=success&event=e1",
    cancelUrl: "https://example.com/calendar?checkout=cancel&event=e1",
    eventId: "e1",
    paymentId: "p1",
    attemptId: "a1",
    expiresAt: 1700003600,
  });

  it("uses mode=payment — never subscription/setup", () => {
    expect(params.mode).toBe("payment");
  });

  it("restricts payment_method_types to cards only", () => {
    expect(params.payment_method_types).toEqual(["card"]);
  });

  it("never sets application_fee_amount, on_behalf_of, or a customer", () => {
    expect(params).not.toHaveProperty("application_fee_amount");
    expect(params).not.toHaveProperty("on_behalf_of");
    expect(params).not.toHaveProperty("customer");
    expect(params).not.toHaveProperty("payment_intent_data");
  });

  it("passes the exact amount/currency through as the line item's price_data", () => {
    expect(params.line_items[0].price_data.unit_amount).toBe(5000);
    expect(params.line_items[0].price_data.currency).toBe("usd");
    expect(params.line_items[0].quantity).toBe(1);
  });

  it("uses a generic, event-specific product name — NEVER the Event's own title. This is the exact evidence 0161's material-vs-non-material-edit decision relies on: since the Member never sees the title on the Stripe-hosted page, a title-only edit is not a payment-material change", () => {
    expect(params.line_items[0].price_data.product_data.name).toBe("Event payment");
    expect(params.line_items[0].price_data.product_data.name).not.toMatch(/Championship|Tournament|Clinic/);
  });

  it("uses a product name distinct from reservation/lesson's own wording", () => {
    const reservationParams = buildReservationCheckoutSessionParams({
      amountCents: 5000, currency: "USD", successUrl: "x", cancelUrl: "x",
      reservationId: "r1", paymentId: "p1", attemptId: "a1", expiresAt: 1700003600,
    });
    const lessonParams = buildLessonCheckoutSessionParams({
      amountCents: 5000, currency: "USD", successUrl: "x", cancelUrl: "x",
      lessonRequestId: "l1", paymentId: "p1", attemptId: "a1", expiresAt: 1700003600,
    });
    expect(params.line_items[0].price_data.product_data.name).not.toBe(reservationParams.line_items[0].price_data.product_data.name);
    expect(params.line_items[0].price_data.product_data.name).not.toBe(lessonParams.line_items[0].price_data.product_data.name);
  });

  it("carries only internal identifiers in metadata, keyed event_id (never reservation_id/lesson_request_id) — never PII, never treated as authorization", () => {
    expect(params.metadata).toEqual({ payment_id: "p1", event_id: "e1", attempt_id: "a1" });
  });

  it("uses client_reference_id = eventId", () => {
    expect(params.client_reference_id).toBe("e1");
  });

  it("uses the exact success/cancel URLs passed in — never invents its own", () => {
    expect(params.success_url).toBe("https://example.com/calendar?checkout=success&event=e1");
    expect(params.cancel_url).toBe("https://example.com/calendar?checkout=cancel&event=e1");
  });
});

describe("buildEventCheckoutReturnUrls — server-derived from a trusted base URL, targets /calendar (the one canonical Event detail surface)", () => {
  it("builds /calendar destinations carrying the event id, distinct success vs cancel", () => {
    const { successUrl, cancelUrl } = buildEventCheckoutReturnUrls("https://court-time.app", "event-123", null);
    expect(successUrl).toBe("https://court-time.app/calendar?checkout=success&event=event-123");
    expect(cancelUrl).toBe("https://court-time.app/calendar?checkout=cancel&event=event-123");
    expect(successUrl).not.toBe(cancelUrl);
  });

  it("includes an optional date= jump parameter when a date is supplied — /calendar is date-navigated, unlike /my-schedule's flat lesson list", () => {
    const { successUrl, cancelUrl } = buildEventCheckoutReturnUrls("https://court-time.app", "event-123", "2026-03-05");
    expect(successUrl).toBe("https://court-time.app/calendar?date=2026-03-05&checkout=success&event=event-123");
    expect(cancelUrl).toBe("https://court-time.app/calendar?date=2026-03-05&checkout=cancel&event=event-123");
  });

  it("never targets /my-schedule or /events — an Event payment must return the Member to the one canonical calendar detail surface", () => {
    const { successUrl, cancelUrl } = buildEventCheckoutReturnUrls("https://court-time.app", "event-123", null);
    expect(successUrl).not.toContain("/my-schedule");
    expect(successUrl).not.toContain("/events?");
    expect(cancelUrl).not.toContain("/my-schedule");
  });
});

describe("SUPPORTED_PAYMENT_WEBHOOK_EVENT_TYPE / isSupportedPaymentWebhookEventType — exactly one event type", () => {
  it("is checkout.session.completed", () => {
    expect(SUPPORTED_PAYMENT_WEBHOOK_EVENT_TYPE).toBe("checkout.session.completed");
  });

  it("recognizes only that event type", () => {
    expect(isSupportedPaymentWebhookEventType("checkout.session.completed")).toBe(true);
    expect(isSupportedPaymentWebhookEventType("checkout.session.expired")).toBe(false);
    expect(isSupportedPaymentWebhookEventType("checkout.session.async_payment_succeeded")).toBe(false);
    expect(isSupportedPaymentWebhookEventType("payment_intent.succeeded")).toBe(false);
    expect(isSupportedPaymentWebhookEventType("charge.refunded")).toBe(false);
    expect(isSupportedPaymentWebhookEventType("charge.dispute.created")).toBe(false);
  });
});
