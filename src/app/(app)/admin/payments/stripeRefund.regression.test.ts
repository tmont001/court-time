import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 34E-B — regression coverage for Stripe refunds/partial refunds,
// using this repository's established source-inspection style (see
// reservationCheckout.regression.test.ts's own header comment for why:
// this test baseline is deliberately pure-TypeScript with no jsdom/
// Supabase/network mocking, so for "does the shipped code actually take
// this shape" questions, reading the real source is a more honest guard
// than reimplementing a parallel mock that could drift).

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !line.trim().startsWith("--") && !line.trim().startsWith("//"))
    .join("\n");
}

const MIGRATION_PATH = "supabase/migrations/0153_stripe_refund_lifecycle.sql";
const MIGRATION_0150_PATH = "supabase/migrations/0150_reservation_checkout_foundation.sql";
const MIGRATION_0154_PATH = "supabase/migrations/0154_online_refundable_amount_ambiguity_fix.sql";
const MIGRATION_0155_PATH = "supabase/migrations/0155_open_refund_attempt_ambiguity_fix.sql";
const REFUND_CONFIG_PATH = "src/lib/stripe/refundConfig.ts";
const PAYMENTS_CONFIG_PATH = "src/lib/stripe/paymentsConfig.ts";
const PAYMENTS_LIB_PATH = "src/lib/payments.ts";
const REFUND_ACTIONS_PATH = "src/app/(app)/admin/payments/refundActions.ts";
const WEBHOOK_ROUTE_PATH = "src/app/api/stripe/payments/events/route.ts";
const REFUND_SHEET_PATH = "src/components/RefundPaymentSheet.tsx";
const ADMIN_CLIENT_PATH = "src/app/(app)/admin/payments/AdminPaymentsClient.tsx";

function migrationSql(): string {
  return codeOnly(readSource(MIGRATION_PATH));
}

function migration0154Sql(): string {
  return codeOnly(readSource(MIGRATION_0154_PATH));
}

function migration0155Sql(): string {
  return codeOnly(readSource(MIGRATION_0155_PATH));
}

// Isolates a single `create or replace function public.<name>(...)` body
// up to its own closing `$$;` — scoping every function-specific assertion
// below to exactly that function's own body.
function functionBody(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  expect(start, `function public.${name} not found`).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf("\n$$;", start);
  expect(end, `terminator not found for ${name}`).toBeGreaterThan(start);
  return sql.slice(start, end + "\n$$;".length);
}

// ═══════════════════════════════════════════════════════════════════════════
// CRITICAL AUDIT QUESTION — refund does NOT resurrect Pay Now / Record
// Payment eligibility (scenario 23)
// ═══════════════════════════════════════════════════════════════════════════

describe("Critical audit question — refunded/partially_refunded payments remain non-collectible", () => {
  it("isReservationPaymentEligibleForCheckout (Pay Now gate) excludes refunded/partially_refunded — status allowlist is unpaid/partially_paid only", () => {
    const src = readSource(PAYMENTS_CONFIG_PATH);
    const fnStart = src.indexOf("export function isReservationPaymentEligibleForCheckout(");
    const fnBody = src.slice(fnStart, src.indexOf("\n}", fnStart));
    expect(fnBody).toContain('row.status === "unpaid"');
    expect(fnBody).toContain('row.status === "partially_paid"');
    expect(fnBody).not.toMatch(/"refunded"/);
    expect(fnBody).not.toMatch(/"partially_refunded"/);
  });

  it("isPaymentOpenForRecording (Admin Record Payment gate) excludes refunded/partially_refunded — same status allowlist", () => {
    const src = readSource(PAYMENTS_LIB_PATH);
    const fnStart = src.indexOf("export function isPaymentOpenForRecording(");
    const fnBody = src.slice(fnStart, src.indexOf("\n}", fnStart));
    expect(fnBody).toContain('"unpaid"');
    expect(fnBody).toContain('"partially_paid"');
    expect(fnBody).not.toMatch(/"refunded"/);
    expect(fnBody).not.toMatch(/"partially_refunded"/);
  });

  it("0153 does not touch the status-precedence state machine in _recompute_payment_rollup — only widens its two SUM/EXISTS inputs", () => {
    const body = functionBody(migrationSql(), "_recompute_payment_rollup");
    // The exact precedence chain, byte-identical to 0150's own text.
    expect(body).toContain("if v_void and v_net <= 0 then");
    expect(body).toContain("v_status := 'void';");
    expect(body).toContain("elsif v_waived then");
    expect(body).toContain("elsif v_net > v_due then");
    expect(body).toContain("v_status := 'overpaid';");
    expect(body).toContain("elsif v_has_refund then");
    expect(body).toContain("v_status := 'refunded';");
    expect(body).toContain("v_status := 'partially_refunded';");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Locked decision 1/2 — Stripe-refundable money is the ONLINE transaction
// only, never manual money, never a generic record_refund reuse
// (scenarios 4, 5)
// ═══════════════════════════════════════════════════════════════════════════

describe("Refundable amount is derived from the completed online attempt, never payments.amount_paid_cents or manual money", () => {
  it("open_payment_refund_attempt computes the ceiling from the source attempt's own amount_expected_cents, never payments.amount_paid_cents", () => {
    const body = functionBody(migrationSql(), "open_payment_refund_attempt");
    expect(body).toContain("v_refundable := v_source.amount_expected_cents - v_reserved_total;");
    expect(body).not.toMatch(/v_payment\.amount_paid_cents/);
  });

  it("open_payment_refund_attempt never reads manual_payment_recorded or refund_recorded (legacy offline events)", () => {
    const body = functionBody(migrationSql(), "open_payment_refund_attempt");
    expect(body).not.toMatch(/manual_payment_recorded/);
    expect(body).not.toMatch(/'refund_recorded'/);
  });

  it("record_refund (0143/0151, legacy manual/offline refund RPC) IS redefined by 0153 (correction pass) — its ceiling is no longer the aggregate amount_paid_cents", () => {
    const body = functionBody(migrationSql(), "record_refund");
    expect(body).not.toMatch(/p_amount_cents > v_payment\.amount_paid_cents/);
    expect(body).toContain("v_manual_refundable");
  });

  it("the new online_refund_recorded event type is structurally distinct from refund_recorded — never overloads the legacy type", () => {
    const sql = migrationSql();
    expect(sql).toContain("'online_refund_recorded'");
    // The shape CHECK requires external_reference (Stripe Refund id) —
    // unlike refund_recorded's own unconstrained external_reference.
    const shapeIdx = sql.indexOf("when 'online_refund_recorded' then");
    const shapeBranch = sql.slice(shapeIdx, sql.indexOf("when 'reverse_payment_event'", shapeIdx));
    expect(shapeBranch).toContain("external_reference is not null");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Fix 2 (correction pass, required test) — record_refund's manual/offline-
// only refundable ceiling, proven against the exact worked examples from
// the review instructions.
// ═══════════════════════════════════════════════════════════════════════════

describe("record_refund's refundable ceiling is derived EXCLUSIVELY from manual/offline ledger events (fix 2)", () => {
  it("the ceiling SUM is scoped to exactly manual_payment_recorded minus refund_recorded — online_payment_recorded/online_refund_recorded never contribute", () => {
    const body = functionBody(migrationSql(), "record_refund");
    const sumIdx = body.indexOf("select\n");
    expect(sumIdx).toBeGreaterThan(0);
    const sumBlock = body.slice(sumIdx, body.indexOf("into v_manual_refundable", sumIdx));

    expect(sumBlock).toContain("filter (where event_type = 'manual_payment_recorded')");
    expect(sumBlock).toContain("filter (where event_type = 'refund_recorded')");
    expect(sumBlock).not.toMatch(/online_payment_recorded/);
    expect(sumBlock).not.toMatch(/online_refund_recorded/);
  });

  it("reversed events (reverses_event_id) are excluded from the ceiling computation, exactly as elsewhere in this migration", () => {
    const body = functionBody(migrationSql(), "record_refund");
    expect(body).toContain("select reverses_event_id from public.payment_events where reverses_event_id is not null");
  });

  it("the ceiling is enforced with a dedicated error distinct from the Stripe-side refund_exceeds_online_remaining", () => {
    const body = functionBody(migrationSql(), "record_refund");
    expect(body).toContain("if p_amount_cents > v_manual_refundable then");
    expect(body).toContain("raise exception 'refund_exceeds_manual_amount_paid';");
  });

  // The SQL ceiling is a straightforward filtered SUM/subtraction — the
  // translation below evaluates that exact formula (manual_payment_recorded
  // minus refund_recorded, non-reversed only) against the three worked
  // examples given in the review instructions, so a regression in the
  // arithmetic itself — not just its shape — would be caught here.
  function manualRefundableCeiling(
    events: { type: "manual_payment_recorded" | "refund_recorded" | "online_payment_recorded" | "online_refund_recorded"; amountCents: number }[],
  ): number {
    const manual = events
      .filter((e) => e.type === "manual_payment_recorded")
      .reduce((sum, e) => sum + e.amountCents, 0);
    const refunded = events
      .filter((e) => e.type === "refund_recorded")
      .reduce((sum, e) => sum + e.amountCents, 0);
    return manual - refunded;
  }

  it("worked example: $100 Stripe only — record_refund must reject any amount (ceiling is 0)", () => {
    const ceiling = manualRefundableCeiling([{ type: "online_payment_recorded", amountCents: 10000 }]);
    expect(ceiling).toBe(0);
  });

  it("worked example: $20 cash + $80 Stripe — record_refund may refund at most $20", () => {
    const ceiling = manualRefundableCeiling([
      { type: "manual_payment_recorded", amountCents: 2000 },
      { type: "online_payment_recorded", amountCents: 8000 },
    ]);
    expect(ceiling).toBe(2000);
  });

  it("worked example: $20 cash, $5 prior manual refund — at most $15 remains manually refundable", () => {
    const ceiling = manualRefundableCeiling([
      { type: "manual_payment_recorded", amountCents: 2000 },
      { type: "refund_recorded", amountCents: 500 },
    ]);
    expect(ceiling).toBe(1500);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Locked decision 3/5 — trusted provenance: account/livemode/PaymentIntent
// come from the ORIGINAL transaction (scenarios 9, 10, 11)
// ═══════════════════════════════════════════════════════════════════════════

describe("Trusted provenance — connected account and livemode come from the original transaction, never the club's current connection", () => {
  it("open_payment_refund_attempt resolves stripe_account_id/livemode/PaymentIntent from the source completed attempt, not from any club-connection lookup", () => {
    const body = functionBody(migrationSql(), "open_payment_refund_attempt");
    expect(body).toContain("v_source.stripe_account_id, v_source.livemode,");
    expect(body).not.toMatch(/get_club_stripe_account_ref/);
    expect(body).not.toMatch(/club_stripe_accounts/);
  });

  it("refundActions.ts never calls get_club_stripe_account_ref for the refund flow", () => {
    const src = codeOnly(readSource(REFUND_ACTIONS_PATH));
    expect(src).not.toMatch(/get_club_stripe_account_ref/);
  });

  it("refundActions.ts checks the source attempt's own livemode against the server's current environment BEFORE any Stripe call, and fails closed on mismatch (scenario 11)", () => {
    const src = readSource(REFUND_ACTIONS_PATH);
    const checkIdx = src.indexOf("attempt.livemode !== context.livemode");
    expect(checkIdx).toBeGreaterThan(0);
    const refundsCreateIdx = src.indexOf("context.client.refunds.create(");
    expect(checkIdx).toBeLessThan(refundsCreateIdx);
    const branch = src.slice(checkIdx, src.indexOf("}", src.indexOf("{", checkIdx)));
    expect(branch).toMatch(/environment_mismatch/);
  });

  it("Stripe refund calls always use {stripeAccount: attempt.stripe_account_id} — the ORIGINAL transaction's account, never a caller-derived one", () => {
    const src = readSource(REFUND_ACTIONS_PATH);
    expect(src).toMatch(/stripeAccount: attempt\.stripe_account_id/);
  });

  it("_reconcile_stripe_refund_attempt re-validates stripe_account_id/livemode/currency against the attempt's own stored values — fails closed on any mismatch (scenario 11)", () => {
    const body = functionBody(migrationSql(), "_reconcile_stripe_refund_attempt");
    expect(body).toContain("if v_attempt.stripe_account_id <> p_stripe_account_id then");
    expect(body).toContain("raise exception 'stripe_account_mismatch';");
    expect(body).toContain("if v_attempt.livemode <> p_livemode then");
    expect(body).toContain("raise exception 'livemode_mismatch';");
    expect(body).toContain("if upper(p_currency) <> v_payment.currency then");
    expect(body).toContain("raise exception 'currency_mismatch';");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Locked decision 5 — concurrency / over-refund protection (scenarios 6, 7)
// ═══════════════════════════════════════════════════════════════════════════

describe("Concurrency / over-refund protection", () => {
  it("open_payment_refund_attempt locks payments FIRST (canonical order) before computing the refundable ceiling", () => {
    const body = functionBody(migrationSql(), "open_payment_refund_attempt");
    const lockIdx = body.indexOf("for update;");
    const ceilingIdx = body.indexOf("v_refundable := v_source.amount_expected_cents");
    expect(lockIdx).toBeGreaterThan(0);
    expect(ceilingIdx).toBeGreaterThan(lockIdx);
  });

  it("the reserved-amount computation counts succeeded AND in-flight (pending/requires_action) refund attempts — never only succeeded ones (scenario 7)", () => {
    const body = functionBody(migrationSql(), "open_payment_refund_attempt");
    expect(body).toMatch(/status in \('succeeded', 'pending', 'requires_action'\)/);
  });

  it("over-refund is rejected inside open_payment_refund_attempt, BEFORE any row is inserted (scenario 6)", () => {
    const body = functionBody(migrationSql(), "open_payment_refund_attempt");
    const raiseIdx = body.indexOf("raise exception 'refund_exceeds_online_remaining';");
    const insertIdx = body.indexOf("insert into public.payment_refund_attempts");
    expect(raiseIdx).toBeGreaterThan(0);
    expect(raiseIdx).toBeLessThan(insertIdx);
  });

  it("over-refund is rejected in the RPC layer BEFORE refundActions.ts ever calls stripe.refunds.create (scenario 6, remote creation)", () => {
    const src = readSource(REFUND_ACTIONS_PATH);
    const openCallIdx = src.indexOf('privileged.rpc("open_payment_refund_attempt"');
    const createCallIdx = src.indexOf("context.client.refunds.create(");
    expect(openCallIdx).toBeGreaterThan(0);
    expect(openCallIdx).toBeLessThan(createCallIdx);
  });

  it("a DB backstop enforces at most one unresolved refund attempt per payment, mirroring payment_checkout_attempts_one_open_per_payment", () => {
    const sql = migrationSql();
    expect(sql).toMatch(
      /create unique index payment_refund_attempts_one_pending_per_payment\s+on public\.payment_refund_attempts \(payment_id\)\s+where stripe_refund_id is null and status = 'pending';/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Locked decision 6/7 — idempotent Stripe creation + failure recovery
// (scenarios 1, 2, 8)
// ═══════════════════════════════════════════════════════════════════════════

describe("Idempotent Stripe creation and reuse-before-create (scenarios 1, 2, 8)", () => {
  it("buildRefundIdempotencyKey is deterministic per refund attempt id — payment-refund:<id>", () => {
    const src = readSource(REFUND_CONFIG_PATH);
    expect(src).toMatch(/return `payment-refund:\$\{refundAttemptId\}`;/);
  });

  it("refundActions.ts derives the idempotency key from the RPC-returned attempt id, never a fresh Date.now()/random value", () => {
    const src = readSource(REFUND_ACTIONS_PATH);
    expect(src).toMatch(/idempotencyKey: buildRefundIdempotencyKey\(attempt\.id\)/);
    expect(src).not.toMatch(/Date\.now\(\)/);
  });

  it("open_payment_refund_attempt reuses an existing unresolved attempt BEFORE validating/inserting a new one — never mints a second key for an in-flight request (scenario D/E)", () => {
    const body = functionBody(migrationSql(), "open_payment_refund_attempt");
    const reuseSelectIdx = body.indexOf("where payment_id = p_payment_id and stripe_refund_id is null and status = 'pending'");
    const reuseReturnIdx = body.indexOf("return;", reuseSelectIdx);
    const insertIdx = body.indexOf("insert into public.payment_refund_attempts");
    expect(reuseSelectIdx).toBeGreaterThan(0);
    expect(reuseReturnIdx).toBeGreaterThan(reuseSelectIdx);
    expect(reuseReturnIdx).toBeLessThan(insertIdx);
  });

  it("same-amount retry reuses the existing pending attempt — no mismatch check blocks it (correction pass, item 1)", () => {
    const body = functionBody(migrationSql(), "open_payment_refund_attempt");
    const foundIdx = body.indexOf("if found then", body.indexOf("select * into v_existing_pending"));
    const mismatchCheckIdx = body.indexOf("if v_existing_pending.requested_amount_cents <> p_requested_amount_cents then", foundIdx);
    const reuseReturnIdx = body.indexOf("return query select\n      v_existing_pending.id", mismatchCheckIdx);
    expect(foundIdx).toBeGreaterThan(0);
    expect(mismatchCheckIdx).toBeGreaterThan(foundIdx);
    expect(reuseReturnIdx).toBeGreaterThan(mismatchCheckIdx);
  });

  it("different-amount retry against an existing pending attempt raises pending_refund_amount_mismatch BEFORE the reuse row is ever returned — never reaches refundActions.ts's Stripe call (correction pass, item 1)", () => {
    const body = functionBody(migrationSql(), "open_payment_refund_attempt");
    const mismatchIdx = body.indexOf("raise exception 'pending_refund_amount_mismatch';");
    const reuseReturnIdx = body.indexOf("return query select\n      v_existing_pending.id");
    expect(mismatchIdx).toBeGreaterThan(0);
    expect(mismatchIdx).toBeLessThan(reuseReturnIdx);
    // refundActions.ts only ever reaches stripe.refunds.create() using
    // the RPC's RETURNED attempt row — a raised exception here means the
    // Server Action's own openError branch returns before any Stripe
    // call, verified separately (see "over-refund is rejected in the RPC
    // layer BEFORE refundActions.ts ever calls stripe.refunds.create").
    const src = readSource(REFUND_ACTIONS_PATH);
    expect(src).toMatch(/pending_refund_amount_mismatch/);
  });

  it("different-amount retry never mutates the existing pending attempt's own financial identity — no UPDATE statement runs on the mismatch path, only a raise (correction pass, item 1)", () => {
    const body = functionBody(migrationSql(), "open_payment_refund_attempt");
    const foundIdx = body.indexOf("if found then", body.indexOf("select * into v_existing_pending"));
    const endOfReuseBranchIdx = body.indexOf("if p_requested_amount_cents is null or p_requested_amount_cents <= 0 then\n    raise exception 'invalid_refund_amount';\n  end if;\n\n  -- Trusted provenance", 0);
    // Fallback: locate the reuse branch precisely via its own return, and
    // assert nothing between `if found then` and that return ever
    // UPDATEs payment_refund_attempts — the mismatch path only ever
    // raises, and the match path only ever SELECTs/returns.
    const reuseReturnIdx = body.indexOf("return;\n  end if;\n\n  -- Trusted provenance");
    const reuseBranch = body.slice(foundIdx, reuseReturnIdx > 0 ? reuseReturnIdx : endOfReuseBranchIdx);
    expect(reuseBranch).not.toMatch(/update public\.payment_refund_attempts/);
  });

  it("refundActions.ts surfaces a clear, non-substituting error for pending_refund_amount_mismatch — never silently proceeds with the old amount", () => {
    const src = readSource(REFUND_ACTIONS_PATH);
    expect(src).toMatch(
      /pending_refund_amount_mismatch:\s*\n\s*"A refund for a different amount is already in progress/,
    );
  });

  it("a full refund request (amount == refundable ceiling) and a partial refund request (amount < ceiling) go through the identical validation path — no special-casing (scenarios 1, 2)", () => {
    const body = functionBody(migrationSql(), "open_payment_refund_attempt");
    // The only amount check is a single `>` comparison against the
    // computed ceiling — the same code path for any positive amount up
    // to and including the full ceiling.
    expect(body).toContain("if p_requested_amount_cents > v_refundable then");
    expect((body.match(/raise exception 'refund_exceeds_online_remaining'/g) ?? []).length).toBe(1);
  });

  it("refundActions.ts never marks a refund attempt 'failed' after an ambiguous stripe.refunds.create() call — only before it (payment_intent unresolvable)", () => {
    const src = readSource(REFUND_ACTIONS_PATH);
    const createTryIdx = src.indexOf("refund = await context.client.refunds.create(");
    const catchIdx = src.indexOf("} catch (err) {", createTryIdx);
    expect(catchIdx).toBeGreaterThan(0);
    // The catch block's own closing brace is at 2-space indent — distinct
    // from the nested logUnexpectedRefundError(...) object literal's own
    // (4-space-indented) closing brace, which a naive first-"}" search
    // would land on instead.
    const catchBody = src.slice(catchIdx, src.indexOf("\n  }\n", catchIdx));
    expect(catchBody).not.toMatch(/mark_refund_attempt_local_failure/);
    // The only call site for mark_refund_attempt_local_failure is BEFORE
    // the refunds.create() try block (the PaymentIntent-unresolvable
    // branch).
    const failureCallIdx = src.indexOf("mark_refund_attempt_local_failure");
    expect(failureCallIdx).toBeGreaterThan(0);
    expect(failureCallIdx).toBeLessThan(createTryIdx);
  });

  it("pre-Stripe failure (PaymentIntent unresolvable) uses the normal 'no changes made' failure message — genuinely accurate since Stripe was never called (correction pass, item 3)", () => {
    const src = readSource(REFUND_ACTIONS_PATH);
    const noIntentIdx = src.indexOf("if (!paymentIntentId) {");
    expect(noIntentIdx).toBeGreaterThan(0);
    const branch = src.slice(noIntentIdx, src.indexOf("}", src.indexOf("return", noIntentIdx)));
    expect(branch).toMatch(/mark_refund_attempt_local_failure/);
    expect(branch).toMatch(/ERROR_MESSAGES\.stripe_error/);
    expect(branch).not.toMatch(/refund_uncertain/);
  });

  it("post-call network uncertainty (refunds.create() throws AFTER the API may have received the request) uses refund_uncertain, never the 'no changes made' message (correction pass, item 3)", () => {
    const src = readSource(REFUND_ACTIONS_PATH);
    const createTryIdx = src.indexOf("refund = await context.client.refunds.create(");
    const catchIdx = src.indexOf("} catch (err) {", createTryIdx);
    expect(catchIdx).toBeGreaterThan(0);
    // The catch block's own closing brace is at 2-space indent — distinct
    // from the nested logUnexpectedRefundError(...) object literal's own
    // (4-space-indented) closing brace, which a naive first-"}" search
    // would land on instead.
    const catchBody = src.slice(catchIdx, src.indexOf("\n  }\n", catchIdx));
    expect(catchBody).toMatch(/ERROR_MESSAGES\.refund_uncertain/);
    expect(catchBody).not.toMatch(/ERROR_MESSAGES\.stripe_error/);
  });

  it("an unrecognized post-create Refund.status also uses refund_uncertain, never 'no changes made' — a real Refund object was returned by Stripe", () => {
    const src = readSource(REFUND_ACTIONS_PATH);
    const statusCheckIdx = src.indexOf("if (!isRefundStatus(refund.status)) {");
    expect(statusCheckIdx).toBeGreaterThan(0);
    const branch = src.slice(statusCheckIdx, src.indexOf("\n  }\n", statusCheckIdx));
    expect(branch).toMatch(/refund_uncertain/);
  });

  it("the two failure-copy classes are lexically distinct strings — 'No changes were made' never appears in the same message as 'was submitted'", () => {
    const src = readSource(REFUND_ACTIONS_PATH);
    expect(src).toMatch(/RESOLUTION_FAILED_MESSAGE/); // "...No changes were made..." (imported, defined in checkoutInvalidation.ts)
    expect(src).toMatch(/refund_uncertain: "The refund was submitted/);
  });

  it("mark_refund_attempt_local_failure refuses once a Stripe Refund id is already bound — never overwrites a real Stripe outcome", () => {
    const body = functionBody(migrationSql(), "mark_refund_attempt_local_failure");
    expect(body).toContain("if v_attempt.stripe_refund_id is not null then");
    expect(body).toContain("raise exception 'refund_already_submitted_to_stripe';");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Locked decision 8/9 — webhook state machine, reconcile from CURRENT
// state, exactly-once (scenarios 12-20)
// ═══════════════════════════════════════════════════════════════════════════

describe("_reconcile_stripe_refund_attempt — the one shared reconciliation path, idempotent regardless of caller/ordering", () => {
  it("is revoked from ALL FOUR roles including service_role — the 0152 lesson applied from the start (scenario: explicit function grants)", () => {
    const sql = migrationSql();
    expect(sql).toMatch(
      /revoke all on function public\._reconcile_stripe_refund_attempt\(uuid, text, text, integer, text, boolean, text, text, text\)\s+from public, anon, authenticated, service_role;/,
    );
  });

  it("_resolve_or_import_refund_attempt_by_provenance is ALSO revoked from all four roles — the second internal helper, now the SOLE webhook-path resolver (correction pass)", () => {
    const sql = migrationSql();
    expect(sql).toMatch(
      /revoke all on function public\._resolve_or_import_refund_attempt_by_provenance\(text, text, text, boolean, integer\)\s+from public, anon, authenticated, service_role;/,
    );
  });

  it("accepts and validates p_stripe_payment_intent_id — a known non-null stored PaymentIntent that DIFFERS from the reported one fails closed (correction pass, fix 1)", () => {
    const body = functionBody(migrationSql(), "_reconcile_stripe_refund_attempt");
    const idx = body.indexOf(
      "if v_attempt.stripe_payment_intent_id is not null\n     and p_stripe_payment_intent_id is not null\n     and v_attempt.stripe_payment_intent_id <> p_stripe_payment_intent_id then",
    );
    expect(idx).toBeGreaterThan(0);
    const branch = body.slice(idx, body.indexOf("end if;", idx));
    expect(branch).toContain("raise exception 'payment_intent_mismatch';");
  });

  it("the PaymentIntent mismatch check runs BEFORE any status/ledger mutation (fix 1, PI mismatch fails closed before ledger mutation)", () => {
    const body = functionBody(migrationSql(), "_reconcile_stripe_refund_attempt");
    const piCheckIdx = body.indexOf("raise exception 'payment_intent_mismatch';");
    const statusUpdateIdx = body.indexOf("update public.payment_refund_attempts\n     set status = p_status");
    const ledgerInsertIdx = body.indexOf("insert into public.payment_events");
    expect(piCheckIdx).toBeGreaterThan(0);
    expect(piCheckIdx).toBeLessThan(statusUpdateIdx);
    expect(piCheckIdx).toBeLessThan(ledgerInsertIdx);
  });

  it("backfills a previously-unknown PaymentIntent (null-to-non-null) without ever overwriting a known value — mirrors process_stripe_payment_event's own discipline", () => {
    const body = functionBody(migrationSql(), "_reconcile_stripe_refund_attempt");
    expect(body).toContain("if v_attempt.stripe_payment_intent_id is null and p_stripe_payment_intent_id is not null then");
  });

  it("does not assume p_status by event type — status is a plain parameter driving generic branch logic, never gated on which caller/event supplied it (scenarios 12, 13)", () => {
    const body = functionBody(migrationSql(), "_reconcile_stripe_refund_attempt");
    // No branching on an event_type/event_id parameter at all inside the
    // shared helper — it only ever sees p_status, p_stripe_refund_id,
    // p_amount_cents, and identity fields.
    expect(body).not.toMatch(/p_event_type/);
  });

  it("ledger event is inserted ONLY on a genuine transition into 'succeeded' from a non-terminal old status — the terminal-state guard runs first and returns before any status/ledger mutation for succeeded/failed/canceled (scenarios 14, 15)", () => {
    const body = functionBody(migrationSql(), "_reconcile_stripe_refund_attempt");
    const oldStatusIdx = body.indexOf("v_old_status := v_attempt.status;");
    const terminalGuardIdx = body.indexOf("if v_old_status in ('succeeded', 'failed', 'canceled') then", oldStatusIdx);
    const terminalReturnIdx = body.indexOf("return;", terminalGuardIdx);
    const updateIdx = body.indexOf("update public.payment_refund_attempts\n     set status = p_status", terminalReturnIdx);
    const insertGuardIdx = body.indexOf("if p_status = 'succeeded' then", updateIdx);
    const insertIdx = body.indexOf("insert into public.payment_events", insertGuardIdx);
    expect(oldStatusIdx).toBeGreaterThan(0);
    expect(terminalGuardIdx).toBeGreaterThan(oldStatusIdx);
    expect(terminalReturnIdx).toBeGreaterThan(terminalGuardIdx);
    expect(updateIdx).toBeGreaterThan(terminalReturnIdx);
    expect(insertGuardIdx).toBeGreaterThan(updateIdx);
    expect(insertIdx).toBeGreaterThan(insertGuardIdx);
  });

  it("terminal-state guard (correction pass): 'succeeded'/'failed'/'canceled' are never regressed by a later call — the function returns WITHOUT touching status at all once any of the three is already recorded (scenarios 16, 17, 18)", () => {
    const body = functionBody(migrationSql(), "_reconcile_stripe_refund_attempt");
    const guardIdx = body.indexOf("if v_old_status in ('succeeded', 'failed', 'canceled') then");
    expect(guardIdx).toBeGreaterThan(0);
    // Widened window to reach past the nested failure_reason if-block's
    // own inner `end if;` to the outer branch's real closing `end if;`
    // and its `return;`.
    const guardBranch = body.slice(guardIdx, guardIdx + 400);
    // The unconditional `return;` inside this branch (after the optional
    // failure_reason backfill) is what makes a stale/out-of-order event
    // (e.g. 'pending' delivered after 'succeeded') a true no-op — status
    // itself is never written inside this branch.
    expect(guardBranch).toContain("return;");
    expect(guardBranch).not.toMatch(/set status = p_status/);
  });

  it("a 'succeeded' attempt already at the terminal guard is structurally unreachable to a second ledger insert — the insert statement lives entirely below the guard's own return (scenario 18)", () => {
    const body = functionBody(migrationSql(), "_reconcile_stripe_refund_attempt");
    const guardReturnIdx = body.indexOf("if v_old_status in ('succeeded', 'failed', 'canceled') then");
    const guardEndIdx = body.indexOf("end if;", guardReturnIdx) + "end if;".length;
    const insertIdx = body.indexOf("insert into public.payment_events", guardEndIdx);
    expect(insertIdx).toBeGreaterThan(guardEndIdx);
  });

  it("lookup falls back from stripe_refund_id to p_refund_attempt_id — recovers even when the webhook arrives before the Server Action's own synchronous bind (scenario 19, race C)", () => {
    const body = functionBody(migrationSql(), "_reconcile_stripe_refund_attempt");
    const lookupIdx = body.indexOf("select payment_id into v_lookup_payment_id");
    const lookupBlock = body.slice(lookupIdx, body.indexOf(";", lookupIdx + 400));
    expect(lookupBlock).toContain("stripe_refund_id = p_stripe_refund_id");
    expect(lookupBlock).toContain("p_refund_attempt_id is not null and id = p_refund_attempt_id");
  });

  it("binds stripe_refund_id exactly once — a later mismatched id raises rather than silently reattributing (defense in depth)", () => {
    const body = functionBody(migrationSql(), "_reconcile_stripe_refund_attempt");
    expect(body).toContain("if v_attempt.stripe_refund_id is null then");
    expect(body).toContain("elsif p_stripe_refund_id is not null and v_attempt.stripe_refund_id <> p_stripe_refund_id then");
    expect(body).toContain("raise exception 'refund_id_mismatch';");
  });

  it("payment_events_online_refund_session_uniq gives a DB-level backstop: one Stripe Refund id can create at most one ledger row (scenario 18)", () => {
    const sql = migrationSql();
    expect(sql).toMatch(
      /create unique index payment_events_online_refund_session_uniq\s+on public\.payment_events \(club_id, external_reference\)\s+where event_type = 'online_refund_recorded';/,
    );
  });
});

describe("process_stripe_refund_webhook_event — dedupe + foreign-refund tolerance", () => {
  it("dedupes on Stripe's own event id via stripe_event_receipts before ever reconciling (scenario 16, duplicate delivery)", () => {
    const body = functionBody(migrationSql(), "process_stripe_refund_webhook_event");
    const insertIdx = body.indexOf("insert into public.stripe_event_receipts");
    const notNewIdx = body.indexOf("if not v_new_receipt then");
    const reconcileIdx = body.indexOf("perform public._reconcile_stripe_refund_attempt(");
    expect(insertIdx).toBeGreaterThan(0);
    expect(notNewIdx).toBeGreaterThan(insertIdx);
    expect(reconcileIdx).toBeGreaterThan(notNewIdx);
  });

  it("only accepts the three documented refund event types", () => {
    const body = functionBody(migrationSql(), "process_stripe_refund_webhook_event");
    expect(body).toContain(
      "if p_event_type not in ('refund.created', 'refund.updated', 'refund.failed') then",
    );
  });

  it("is service_role only — never authenticated/anon/public", () => {
    const sql = migrationSql();
    expect(sql).toMatch(
      /revoke execute on function public\.process_stripe_refund_webhook_event\([^)]*\) from public, anon, authenticated;/,
    );
    expect(sql).toMatch(
      /grant {2}execute on function public\.process_stripe_refund_webhook_event\([^)]*\) to service_role;/,
    );
  });

  it("the webhook route never pre-filters on metadata presence — a metadata-less Refund is still passed through for PaymentIntent-based matching (correction pass, scenario 5)", () => {
    const src = codeOnly(readSource(WEBHOOK_ROUTE_PATH));
    // The old pre-filter ("if no metadata, return 200 immediately before
    // ever calling the RPC") must be gone — refundAttemptId is resolved
    // but never used to short-circuit before the RPC call.
    expect(src).not.toMatch(/if \(!refundAttemptId\)/);
    expect(src).toMatch(/const refundAttemptId = refund\.metadata\?\.court_time_refund_attempt_id \?\? null;/);
  });

  it("the webhook route RETRIEVES the Refund fresh by id, in the event's own verified connected-account context, before reconciling (correction pass, scenario 2)", () => {
    const src = readSource(WEBHOOK_ROUTE_PATH);
    const retrieveIdx = src.indexOf("context.client.refunds.retrieve(");
    expect(retrieveIdx).toBeGreaterThan(0);
    const retrieveCall = src.slice(retrieveIdx, src.indexOf(");", retrieveIdx));
    expect(retrieveCall).toContain("stripeAccount: stripeAccountId");
    // The retrieve happens BEFORE the RPC call — current state, not the
    // event payload snapshot, drives reconciliation.
    const rpcCallIdx = src.indexOf('privileged.rpc("process_stripe_refund_webhook_event"');
    expect(retrieveIdx).toBeLessThan(rpcCallIdx);
  });

  it("the webhook route extracts payment_intent from the RETRIEVED Refund and passes it through for Dashboard-refund matching (scenario 5)", () => {
    const src = readSource(WEBHOOK_ROUTE_PATH);
    const rpcCallIdx = src.indexOf('privileged.rpc("process_stripe_refund_webhook_event"');
    const rpcArgs = src.slice(rpcCallIdx, src.indexOf("});", rpcCallIdx));
    expect(rpcArgs).toContain("p_stripe_payment_intent_id: paymentIntentId");
    expect(src).toMatch(/typeof refund\.payment_intent === "string" \? refund\.payment_intent : refund\.payment_intent\?\.id \?\? null/);
  });

  it("a metadata-less Dashboard refund matching a Court Time PaymentIntent/account/livemode is imported and reconciled exactly once (scenario 5)", () => {
    const body = functionBody(migrationSql(), "_resolve_or_import_refund_attempt_by_provenance");
    expect(body).toContain("stripe_payment_intent_id = p_stripe_payment_intent_id");
    expect(body).toContain("and stripe_account_id = p_stripe_account_id");
    expect(body).toContain("and livemode = p_livemode");
    expect(body).toContain("and status = 'completed'");
    // A second call for the SAME stripe_refund_id finds the already-
    // imported row rather than inserting a duplicate — exactly-once
    // import, serialized by the payments row lock taken just above.
    const existingCheckIdx = body.indexOf("select id into v_existing_id");
    const insertIdx = body.indexOf("insert into public.payment_refund_attempts");
    expect(existingCheckIdx).toBeGreaterThan(0);
    expect(existingCheckIdx).toBeLessThan(insertIdx);
    expect(body).toContain("'stripe_dashboard'");
  });

  it("a genuinely UNRELATED Stripe transaction (no PaymentIntent match) is ignored — matched: false, never raised on", () => {
    const body = functionBody(migrationSql(), "process_stripe_refund_webhook_event");
    const resolveIdx = body.indexOf("v_resolved_attempt_id := public._resolve_or_import_refund_attempt_by_provenance(");
    const nullCheckIdx = body.indexOf("if v_resolved_attempt_id is null then", resolveIdx);
    expect(resolveIdx).toBeGreaterThan(0);
    expect(nullCheckIdx).toBeGreaterThan(resolveIdx);
    const branch = body.slice(nullCheckIdx, body.indexOf("end if;", nullCheckIdx));
    expect(branch).toContain("select false, false;");
    expect(branch).not.toMatch(/raise exception/);
  });

  it("correction pass (fix 1): resolution is ALWAYS by provenance — process_stripe_refund_webhook_event calls _resolve_or_import_refund_attempt_by_provenance UNCONDITIONALLY, never gated on whether p_refund_attempt_id is present", () => {
    const body = functionBody(migrationSql(), "process_stripe_refund_webhook_event");
    expect(body).not.toMatch(/if p_refund_attempt_id is not null then/);
    const resolveIdx = body.indexOf("v_resolved_attempt_id := public._resolve_or_import_refund_attempt_by_provenance(");
    const receiptCheckIdx = body.indexOf("if not v_new_receipt then");
    expect(resolveIdx).toBeGreaterThan(receiptCheckIdx);
  });

  it("forged/wrong metadata attempt id cannot reconcile a refund for another PI — a mismatch between the candidate and the provenance-resolved truth raises BEFORE reconciliation (fix 1, required test)", () => {
    const body = functionBody(migrationSql(), "process_stripe_refund_webhook_event");
    const resolveIdx = body.indexOf("v_resolved_attempt_id := public._resolve_or_import_refund_attempt_by_provenance(");
    const mismatchIdx = body.indexOf(
      "if p_refund_attempt_id is not null and p_refund_attempt_id <> v_resolved_attempt_id then",
    );
    const reconcileIdx = body.indexOf("perform public._reconcile_stripe_refund_attempt(");
    expect(resolveIdx).toBeGreaterThan(0);
    expect(mismatchIdx).toBeGreaterThan(resolveIdx);
    expect(mismatchIdx).toBeLessThan(reconcileIdx);
    const branch = body.slice(mismatchIdx, body.indexOf("end if;", mismatchIdx));
    expect(branch).toContain("raise exception 'refund_attempt_provenance_mismatch';");
  });

  it("matching metadata + matching PI/account/livemode succeeds — the candidate check is a no-op when it agrees with the resolved truth (fix 1, required test)", () => {
    const body = functionBody(migrationSql(), "process_stripe_refund_webhook_event");
    // The mismatch condition is a strict inequality — an EQUAL candidate
    // never triggers the raise, and execution falls through to
    // reconciliation exactly as if no candidate had been supplied.
    expect(body).toContain("p_refund_attempt_id <> v_resolved_attempt_id");
  });

  it("_resolve_or_import_refund_attempt_by_provenance never trusts a client-supplied amount as a ceiling for an IMPORT — it uses Stripe's own reported amount directly, no refund_exceeds_online_remaining check", () => {
    const body = functionBody(migrationSql(), "_resolve_or_import_refund_attempt_by_provenance");
    expect(body).not.toMatch(/refund_exceeds_online_remaining/);
    expect(body).toContain("p_amount_cents, 'pending', 'stripe_dashboard'");
  });

  it("nullable source PI safely backfills from the trusted Session before refund creation (fix 1, required test)", () => {
    const src = readSource(REFUND_ACTIONS_PATH);
    const backfillCallIdx = src.indexOf('privileged.rpc("backfill_refund_attempt_payment_intent"');
    const createCallIdx = src.indexOf("context.client.refunds.create(");
    expect(backfillCallIdx).toBeGreaterThan(0);
    expect(backfillCallIdx).toBeLessThan(createCallIdx);
    // Only runs when the PI was genuinely resolved fresh this call (never
    // for an already-known PI, and never silently skipped when it WAS
    // freshly resolved).
    expect(src).toContain("if (resolvedFreshly) {");
  });

  it("backfill_refund_attempt_payment_intent persists onto BOTH the refund attempt and its source Checkout attempt, never overwriting a known value", () => {
    const body = functionBody(migrationSql(), "backfill_refund_attempt_payment_intent");
    expect(body).toContain("update public.payment_refund_attempts");
    expect(body).toContain("update public.payment_checkout_attempts");
    expect(body).toContain("raise exception 'payment_intent_mismatch';");
    expect(body).toMatch(/and stripe_payment_intent_id is null/);
  });

  it("backfill_refund_attempt_payment_intent is service_role only", () => {
    const sql = migrationSql();
    expect(sql).toMatch(
      /revoke execute on function public\.backfill_refund_attempt_payment_intent\(uuid, text\) from public, anon, authenticated;/,
    );
    expect(sql).toMatch(
      /grant {2}execute on function public\.backfill_refund_attempt_payment_intent\(uuid, text\) to service_role;/,
    );
  });

  it("the webhook route subscribes to all three refund event types via isSupportedRefundWebhookEventType", () => {
    const src = readSource(WEBHOOK_ROUTE_PATH);
    expect(src).toContain("isSupportedRefundWebhookEventType(event.type)");
  });

  it("the webhook route passes refund.status/refund.amount/refund.currency straight from the verified Refund object — never re-derives them", () => {
    const src = readSource(WEBHOOK_ROUTE_PATH);
    const rpcCallIdx = src.indexOf('privileged.rpc("process_stripe_refund_webhook_event"');
    const rpcArgs = src.slice(rpcCallIdx, src.indexOf("});", rpcCallIdx));
    expect(rpcArgs).toContain("p_status: refund.status");
    expect(rpcArgs).toContain("p_amount_cents: refund.amount");
    expect(rpcArgs).toContain("p_currency: refund.currency");
    expect(rpcArgs).toContain("p_stripe_refund_id: refund.id");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Locked decision 7 B/C — Stripe success + local bind failure still
// reconciles through the webhook (scenario 20)
// ═══════════════════════════════════════════════════════════════════════════

describe("Failure recovery — Stripe success survives a local binding failure (scenario 20)", () => {
  it("refundActions.ts never throws/crashes when bind_stripe_refund_result errors — returns a non-alarming 'uncertain' message, the money is not lost", () => {
    const src = readSource(REFUND_ACTIONS_PATH);
    const bindCallIdx = src.indexOf('privileged.rpc("bind_stripe_refund_result"');
    const bindErrorCheckIdx = src.indexOf("if (bindError) {", bindCallIdx);
    expect(bindErrorCheckIdx).toBeGreaterThan(bindCallIdx);
    const branch = src.slice(bindErrorCheckIdx, src.indexOf("}", bindErrorCheckIdx));
    expect(branch).toMatch(/refund_uncertain/);
  });

  it("the refund_uncertain message never claims the refund failed — it acknowledges submission and defers to reconciliation", () => {
    const src = readSource(REFUND_ACTIONS_PATH);
    expect(src).toMatch(/refund_uncertain: "The refund was submitted\./);
  });

  it("metadata embeds the refund attempt id, payment id, and club id — exactly what the webhook needs to recover the local attempt independent of the Server Action's own outcome (locked decision 7)", () => {
    const src = readSource(REFUND_CONFIG_PATH);
    const fnStart = src.indexOf("export function buildRefundMetadata(");
    expect(fnStart).toBeGreaterThan(0);
    const fnBody = src.slice(fnStart, fnStart + 500);
    expect(fnBody).toContain("court_time_refund_attempt_id: input.refundAttemptId");
    expect(fnBody).toContain("court_time_payment_id: input.paymentId");
    expect(fnBody).toContain("court_time_club_id: input.clubId");
  });

  it("refundActions.ts embeds this metadata on every stripe.refunds.create() call", () => {
    const src = readSource(REFUND_ACTIONS_PATH);
    const createIdx = src.indexOf("context.client.refunds.create(");
    const createCall = src.slice(createIdx, src.indexOf(");", createIdx));
    expect(createCall).toMatch(/metadata: buildRefundMetadata\(/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Correction pass item 4 — RefundPaymentSheet handles every Refund.status
// distinctly; only 'succeeded' looks like success
// ═══════════════════════════════════════════════════════════════════════════

describe("RefundPaymentSheet — explicit per-status UI, never treats failed/canceled as success", () => {
  it("switches explicitly on every one of Stripe's five documented statuses", () => {
    const src = readSource(REFUND_SHEET_PATH);
    const switchIdx = src.indexOf("switch (result.status) {");
    expect(switchIdx).toBeGreaterThan(0);
    const switchBody = src.slice(switchIdx, src.indexOf("\n    }", switchIdx));
    for (const status of ["succeeded", "pending", "requires_action", "failed", "canceled"]) {
      expect(switchBody).toContain(`case "${status}":`);
    }
  });

  it("only the 'succeeded' case calls onRefunded — every other case returns without it", () => {
    const src = readSource(REFUND_SHEET_PATH);
    const switchIdx = src.indexOf("switch (result.status) {");
    const succeededIdx = src.indexOf('case "succeeded":', switchIdx);
    const pendingIdx = src.indexOf('case "pending":', switchIdx);
    const succeededBranch = src.slice(succeededIdx, pendingIdx);
    expect(succeededBranch).toContain("onRefunded();");

    const switchEndIdx = src.indexOf("\n    }", switchIdx);
    const restOfSwitch = src.slice(pendingIdx, switchEndIdx);
    expect(restOfSwitch).not.toMatch(/onRefunded\(\);/);
  });

  it("'failed' sets a clear failure message via setError — never setStatusNotice, never onRefunded", () => {
    const src = readSource(REFUND_SHEET_PATH);
    const idx = src.indexOf('case "failed":');
    expect(idx).toBeGreaterThan(0);
    const branch = src.slice(idx, src.indexOf('case "canceled":', idx));
    expect(branch).toMatch(/setError\("The refund failed\./);
    expect(branch).not.toMatch(/onRefunded\(\);/);
  });

  it("'canceled' sets a clear canceled message via setError — never implies money was refunded, never onRefunded", () => {
    const src = readSource(REFUND_SHEET_PATH);
    const idx = src.indexOf('case "canceled":');
    expect(idx).toBeGreaterThan(0);
    const branch = src.slice(idx, src.indexOf("default:", idx));
    expect(branch).toMatch(/setError\("The refund was canceled\./);
    expect(branch).not.toMatch(/onRefunded\(\);/);
  });

  it("'requires_action' shows a distinct non-success notice — never treated as pending's own copy, never onRefunded", () => {
    const src = readSource(REFUND_SHEET_PATH);
    const idx = src.indexOf('case "requires_action":');
    expect(idx).toBeGreaterThan(0);
    const branch = src.slice(idx, src.indexOf('case "failed":', idx));
    expect(branch).toMatch(/setStatusNotice\("This refund needs further action/);
    expect(branch).not.toMatch(/onRefunded\(\);/);
  });

  it("an unrecognized/default status fails closed with an error, never silently succeeds", () => {
    const src = readSource(REFUND_SHEET_PATH);
    const idx = src.indexOf("default:");
    expect(idx).toBeGreaterThan(0);
    const branch = src.slice(idx, src.indexOf("}\n  }", idx));
    expect(branch).toMatch(/setError\(/);
    expect(branch).not.toMatch(/onRefunded\(\);/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Correction pass item 6 — Stripe's real failure_reason is threaded
// through and persisted, not merely claimed in a comment
// ═══════════════════════════════════════════════════════════════════════════

describe("failure_reason is genuinely threaded through reconciliation, not just claimed", () => {
  it("_reconcile_stripe_refund_attempt accepts p_failure_reason and persists it on the non-terminal transition update", () => {
    const body = functionBody(migrationSql(), "_reconcile_stripe_refund_attempt");
    expect(body).toMatch(/p_failure_reason\s+text\s+default null/);
    expect(body).toMatch(/failure_reason = coalesce\(p_failure_reason, failure_reason\)/);
  });

  it("_reconcile_stripe_refund_attempt backfills failure_reason on a repeated 'failed' report even though status itself is terminal-guarded", () => {
    const body = functionBody(migrationSql(), "_reconcile_stripe_refund_attempt");
    expect(body).toMatch(
      /if v_old_status = 'failed' and p_status = 'failed'\s*\n\s*and p_failure_reason is not null and v_attempt\.failure_reason is null then/,
    );
  });

  it("bind_stripe_refund_result accepts and forwards p_failure_reason to the shared helper", () => {
    const body = functionBody(migrationSql(), "bind_stripe_refund_result");
    expect(body).toMatch(/p_failure_reason\s+text\s+default null/);
    expect(body).toContain("p_stripe_account_id, p_livemode, p_currency, p_failure_reason");
  });

  it("process_stripe_refund_webhook_event accepts and forwards p_failure_reason to the shared helper", () => {
    const body = functionBody(migrationSql(), "process_stripe_refund_webhook_event");
    expect(body).toMatch(/p_failure_reason\s+text\s+default null/);
    expect(body).toContain("p_stripe_account_id, p_livemode, p_currency, p_failure_reason");
  });

  it("refundActions.ts passes the REAL Stripe refund.failure_reason (never a locally-invented string) to bind_stripe_refund_result", () => {
    const src = readSource(REFUND_ACTIONS_PATH);
    expect(src).toContain("p_failure_reason: refund.failure_reason ?? null");
  });

  it("the webhook route passes the REAL Stripe refund.failure_reason from the retrieved (current-state) Refund object", () => {
    const src = readSource(WEBHOOK_ROUTE_PATH);
    expect(src).toContain("p_failure_reason: refund.failure_reason ?? null");
  });

  it("payment_refund_attempts.failure_reason column comment matches actual behavior — no longer an unfulfilled claim", () => {
    const sql = migrationSql();
    const columnIdx = sql.indexOf("failure_reason               text,");
    expect(columnIdx).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Locked decision 12 — authorization (scenario 3)
// ═══════════════════════════════════════════════════════════════════════════

describe("Authorization — Admin only, browser never reaches privileged refund RPCs directly", () => {
  it("refundActions.ts requires role === 'admin' before ever calling the privileged client — Staff/Member/Pro are rejected", () => {
    const src = readSource(REFUND_ACTIONS_PATH);
    const idx = src.indexOf('profile.role !== "admin"');
    expect(idx).toBeGreaterThan(0);
    const privilegedIdx = src.indexOf("createPrivilegedClient()");
    expect(idx).toBeLessThan(privilegedIdx);
  });

  it.each([
    ["open_payment_refund_attempt(uuid, uuid, integer, uuid, text)"],
    ["mark_refund_attempt_local_failure(uuid, text)"],
    ["bind_stripe_refund_result(uuid, text, text, integer, text, boolean, text, text)"],
    ["process_stripe_refund_webhook_event(text, text, boolean, text, text, uuid, text, text, integer, text, text)"],
  ])("%s is revoked from public/anon/authenticated and granted only to service_role", (signature) => {
    const sql = migrationSql();
    const name = signature.split("(")[0];
    expect(sql).toMatch(
      new RegExp(`revoke execute on function public\\.${name}\\([^)]*\\) from public, anon, authenticated;`),
    );
    expect(sql).toMatch(
      new RegExp(`grant {2}execute on function public\\.${name}\\([^)]*\\) to service_role;`),
    );
  });

  it("get_online_refundable_amount_for_payments is a pure read, Admin/Staff-role-checked internally, granted to authenticated (not service_role-only)", () => {
    const body = functionBody(migrationSql(), "get_online_refundable_amount_for_payments");
    expect(body).toContain("if v_role not in ('admin', 'staff') then raise exception 'insufficient_role'; end if;");
    const sql = migrationSql();
    expect(sql).toMatch(
      /grant {2}execute on function public\.get_online_refundable_amount_for_payments\(uuid\[\]\) to authenticated;/,
    );
  });

  it("no client-facing component ever imports createPrivilegedClient or calls a service-role refund RPC directly", () => {
    const sheetSrc = readSource(REFUND_SHEET_PATH);
    const clientSrc = readSource(ADMIN_CLIENT_PATH);
    expect(sheetSrc).not.toMatch(/createPrivilegedClient/);
    expect(sheetSrc).not.toMatch(/open_payment_refund_attempt/);
    expect(clientSrc).not.toMatch(/createPrivilegedClient/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Locked semantics (runtime QA correction) — Outstanding = balances the
// member still owes (unpaid/partially_paid only). A fully paid, Stripe-
// refundable transaction belongs on All, never Outstanding; Refund remains
// reachable from All via the row's own, separate render condition.
// ═══════════════════════════════════════════════════════════════════════════

describe("AdminPaymentsClient — Outstanding is unpaid/partially_paid only; refund-eligible paid rows live on All (locked semantics)", () => {
  function outstandingFilterExpression(): string {
    const src = readSource(ADMIN_CLIENT_PATH);
    const idx = src.indexOf('filter === "outstanding"');
    expect(idx).toBeGreaterThan(0);
    return src.slice(idx, src.indexOf(";", idx) + 1);
  }

  it("the Outstanding tab predicate is isPaymentOpenForRecording(r.state) ONLY — never widened by refundableCents", () => {
    const expr = outstandingFilterExpression();
    expect(expr).toMatch(/rows\.filter\(r => isPaymentOpenForRecording\(r\.state\)\)/);
    expect(expr).not.toMatch(/isOnlineRefundEligible/);
  });

  // Mirrors the exact predicate now shipped, so a regression in the
  // boolean logic itself (not just its shape) is caught here.
  function isOutstanding(state: { openForRecording: boolean }): boolean {
    const isPaymentOpenForRecording = (s: { openForRecording: boolean }) => s.openForRecording;
    return isPaymentOpenForRecording(state);
  }

  it("a PAID, refund-eligible payment ($60, refundableCents=6000) is NOT included in Outstanding", () => {
    expect(isOutstanding({ openForRecording: false })).toBe(false);
  });

  it("unpaid/partially_paid balances remain in Outstanding regardless of refundableCents (Record Payment path unchanged)", () => {
    expect(isOutstanding({ openForRecording: true })).toBe(true);
  });

  it("a paid, refund-eligible row still renders Refund on the \"All\" tab — the button's own condition is independent of the tab filter", () => {
    const src = readSource(ADMIN_CLIENT_PATH);
    const btnIdx = src.indexOf("{isOnlineRefundEligible(row.refundableCents) && (");
    expect(btnIdx).toBeGreaterThan(0);
    const btnBlock = src.slice(btnIdx, src.indexOf("Refund\n", btnIdx));
    expect(btnBlock).not.toMatch(/isPaymentOpenForRecording/);
  });

  it("the Record Payment button's own render condition is untouched — still gated solely on isPaymentOpenForRecording(row.state)", () => {
    const src = readSource(ADMIN_CLIENT_PATH);
    const btnIdx = src.indexOf("{isPaymentOpenForRecording(row.state) && (");
    expect(btnIdx).toBeGreaterThan(0);
  });

  it("the \"All\" tab is untouched — still shows every row with no filter predicate", () => {
    const src = readSource(ADMIN_CLIENT_PATH);
    const idx = src.indexOf('filter === "outstanding"');
    const ternaryEnd = src.indexOf(";", idx);
    const expr = src.slice(idx, ternaryEnd + 1);
    expect(expr).toMatch(/:\s*rows;/);
  });

  it("page.tsx passes ALL latest payments (not just unpaid ones) into the refundable-amount RPC — a paid payment is never excluded upstream", () => {
    const src = readSource("src/app/(app)/admin/payments/page.tsx");
    const idx = src.indexOf("const paymentIds = latestPayments.map(p => p.id);");
    expect(idx).toBeGreaterThan(0);
    // No status filter applied before building paymentIds.
    const priorLine = src.slice(0, idx);
    const lastLines = priorLine.split("\n").slice(-3).join("\n");
    expect(lastLines).not.toMatch(/\.filter\(/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Rollback completeness (matches 34E-A's own established convention)
// ═══════════════════════════════════════════════════════════════════════════

describe("0153 rollback — real restoration SQL, not placeholder instructions", () => {
  it("drops every new function and the new table/index, and restores the exact pre-0153 _recompute_payment_rollup body", () => {
    const raw = readSource(MIGRATION_PATH);
    const rollbackIdx = raw.indexOf("-- Rollback (manual, cloud SQL Editor)");
    expect(rollbackIdx).toBeGreaterThan(0);
    const rollback = raw.slice(rollbackIdx);

    expect(rollback).toContain("-- drop function if exists public.get_online_refundable_amount_for_payments(uuid[]);");
    expect(rollback).toContain("-- drop function if exists public.process_stripe_refund_webhook_event(text, text, boolean, text, text, uuid, text, text, integer, text, text);");
    expect(rollback).toContain("-- drop function if exists public._resolve_or_import_refund_attempt_by_provenance(text, text, text, boolean, integer);");
    expect(rollback).toContain("-- drop function if exists public.bind_stripe_refund_result(uuid, text, text, integer, text, boolean, text, text, text);");
    expect(rollback).toContain("-- drop function if exists public._reconcile_stripe_refund_attempt(uuid, text, text, integer, text, boolean, text, text, text);");
    expect(rollback).toContain("-- drop function if exists public.mark_refund_attempt_local_failure(uuid, text);");
    expect(rollback).toContain("-- drop function if exists public.backfill_refund_attempt_payment_intent(uuid, text);");
    expect(rollback).toContain("-- drop function if exists public.open_payment_refund_attempt(uuid, uuid, integer, uuid, text);");
    expect(rollback).toContain("-- drop table if exists public.payment_refund_attempts;");
    expect(rollback).toContain("-- drop index if exists public.payment_events_online_refund_session_uniq;");

    // The restored _recompute_payment_rollup body must be the exact
    // pre-0153 (0150) text — recognizable by its single-event-type
    // refund_recorded filter (not the widened online_refund_recorded
    // pair) inside the rollback section specifically.
    const rollupIdx = rollback.indexOf("-- create or replace function public._recompute_payment_rollup(");
    expect(rollupIdx).toBeGreaterThan(0);
    const rollupEnd = rollback.indexOf("-- $$;", rollupIdx);
    const rollupBody = rollback.slice(rollupIdx, rollupEnd);
    expect(rollupBody).toMatch(/coalesce\(sum\(amount_cents\) filter \(where event_type = 'refund_recorded'\), 0\)/);
    expect(rollupBody).not.toMatch(/online_refund_recorded/);
  });

  it("restores record_refund's EXACT currently-applied 0151 body (aggregate amount_paid_cents ceiling, refund_exceeds_amount_paid) — NOT the older 0143 body (fix 2 requirement)", () => {
    const raw = readSource(MIGRATION_PATH);
    const rollbackIdx = raw.indexOf("-- Rollback (manual, cloud SQL Editor)");
    const rollback = raw.slice(rollbackIdx);

    const restoreIdx = rollback.indexOf("-- create or replace function public.record_refund(");
    expect(restoreIdx).toBeGreaterThan(0);
    const restoreEnd = rollback.indexOf("-- $$;", restoreIdx);
    const restoredBody = rollback.slice(restoreIdx, restoreEnd);

    // The 0151 (currently-applied) shape: aggregate ceiling AND the
    // 34E-A Checkout-invalidation guard placed after amount validation —
    // both must be present, proving this restores 0151, not the older
    // pre-34E-A 0143 text.
    expect(restoredBody).toContain("p_amount_cents > v_payment.amount_paid_cents");
    expect(restoredBody).toContain("raise exception 'refund_exceeds_amount_paid';");
    expect(restoredBody).toMatch(/_invalidate_or_flag_open_checkout_attempt\(p_payment_id\)/);
    // The correction pass's own manual-only ceiling must NOT appear in
    // the restored (rollback) text.
    expect(restoredBody).not.toMatch(/v_manual_refundable/);
    expect(restoredBody).not.toMatch(/refund_exceeds_manual_amount_paid/);
  });

  it("restores the exact pre-0153 payment_events shape/event_type CHECK constraints (no online_refund_recorded)", () => {
    const raw = readSource(MIGRATION_PATH);
    const rollbackIdx = raw.indexOf("-- Rollback (manual, cloud SQL Editor)");
    const rollback = raw.slice(rollbackIdx);
    expect(rollback).toMatch(/when 'refund_recorded' then/);
    expect(rollback).not.toMatch(/when 'online_refund_recorded' then/);
    expect(rollback.trim().endsWith("-- commit;")).toBe(true);
  });

  it("never contains a prose placeholder telling someone to copy SQL from elsewhere", () => {
    const raw = readSource(MIGRATION_PATH);
    const rollbackIdx = raw.indexOf("-- Rollback (manual, cloud SQL Editor)");
    const rollback = codeOnly(raw.slice(rollbackIdx));
    // codeOnly strips every `-- ` prefixed line, so only genuinely
    // uncommented (i.e. non-rollback, structurally impossible here)
    // content would remain — asserting emptiness proves every rollback
    // line is real, executable-when-uncommented SQL, not live code.
    expect(rollback.trim()).toBe("");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 34E-A interaction / scope discipline
// ═══════════════════════════════════════════════════════════════════════════

describe("34E-A is not reopened or refactored", () => {
  it("0153 does not redefine any 34E-A/34D-D1 function", () => {
    const sql = migrationSql();
    for (const fn of [
      "_invalidate_or_flag_open_checkout_attempt",
      "get_blocking_checkout_attempt_for_payment",
      "expire_blocking_checkout_attempt",
      "record_manual_payment",
      "waive_payment",
      "void_payment_obligation",
      "reverse_payment_event",
      "update_member_reservation",
      "admin_update_member_lesson",
      "open_payment_checkout_attempt",
      "supersede_checkout_attempt_and_open_fresh",
      "record_checkout_session_created",
      "process_stripe_payment_event",
    ]) {
      expect(sql).not.toMatch(new RegExp(`create or replace function public\\.${fn}\\(`));
    }
  });

  it("src/lib/stripe/checkoutInvalidation.ts is not modified by this phase (only imported for its shared RESOLUTION_FAILED_MESSAGE constant)", () => {
    const src = readSource(REFUND_ACTIONS_PATH);
    expect(src).toContain('import { RESOLUTION_FAILED_MESSAGE } from "@/lib/stripe/checkoutInvalidation";');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 0150 core payment reconciliation remains untouched (scenario 24)
// ═══════════════════════════════════════════════════════════════════════════

describe("0150 payment reconciliation core remains untouched by 0153", () => {
  it("process_stripe_payment_event (0150) is not redefined", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/create or replace function public\.process_stripe_payment_event/);
  });

  it("process_stripe_payment_event still recognizes exactly checkout.session.completed, unchanged", () => {
    const body0150 = functionBody(codeOnly(readSource(MIGRATION_0150_PATH)), "process_stripe_payment_event");
    expect(body0150).toContain("if p_event_type <> 'checkout.session.completed' then");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 0154 — get_online_refundable_amount_for_payments column-reference
// ambiguity fix (runtime QA: 42702 "column reference ... is ambiguous",
// caused by the RETURNS TABLE output vars payment_id/currency colliding
// with the `latest` CTE's own unqualified references of the same name).
// ═══════════════════════════════════════════════════════════════════════════

describe("0154 fixes get_online_refundable_amount_for_payments' column-reference ambiguity (42702)", () => {
  it("0154 touches ONLY get_online_refundable_amount_for_payments — no other function/table/grant", () => {
    const sql = migration0154Sql();
    const createCount = (sql.match(/create or replace function public\./g) ?? []).length;
    expect(createCount).toBe(1);
    expect(sql).toContain("create or replace function public.get_online_refundable_amount_for_payments(");
    expect(sql).not.toMatch(/create table|alter table|create index|drop function|drop table/);
  });

  it("the `latest` CTE now selects from `sources s` and qualifies every column with `s.` — no bare payment_id/currency reference remains", () => {
    const body = functionBody(migration0154Sql(), "get_online_refundable_amount_for_payments");
    const latestIdx = body.indexOf("latest as (");
    expect(latestIdx).toBeGreaterThan(0);
    const latestEnd = body.indexOf("reserved as (");
    const latestBlock = body.slice(latestIdx, latestEnd);

    expect(latestBlock).toContain("from sources s");
    expect(latestBlock).toContain("select distinct on (s.payment_id)");
    expect(latestBlock).toContain("s.attempt_id");
    expect(latestBlock).toContain("s.payment_id");
    expect(latestBlock).toContain("s.amount_expected_cents");
    expect(latestBlock).toContain("s.currency");
    expect(latestBlock).toContain("order by s.payment_id, s.created_at desc");

    // The exact bug pattern from 0153's originally shipped body must be
    // gone: unqualified `payment_id`/`currency` tokens (not preceded by
    // `s.`, `l.`, `a.`, or `r.`) inside this CTE specifically.
    const bareRefs = latestBlock.match(/(?<![sla]\.|r\.)\bpayment_id\b|(?<![sla]\.|r\.)\bcurrency\b/g) ?? [];
    expect(bareRefs).toEqual([]);
  });

  it("the final select remains fully qualified via latest l / reserved r — untouched by this fix", () => {
    const body = functionBody(migration0154Sql(), "get_online_refundable_amount_for_payments");
    expect(body).toContain(
      "select l.payment_id, greatest(l.amount_expected_cents - coalesce(r.reserved_cents, 0), 0)::integer, l.currency",
    );
    expect(body).toContain("from latest l");
    expect(body).toContain("left join reserved r on r.attempt_id = l.attempt_id;");
  });

  it("preserves Admin/staff-only authorization, latest-completed-attempt semantics, and the reservation subtraction — unchanged from 0153", () => {
    const body = functionBody(migration0154Sql(), "get_online_refundable_amount_for_payments");
    expect(body).toContain("if v_club_id is null then raise exception 'not_authenticated'; end if;");
    expect(body).toContain("if v_role not in ('admin', 'staff') then raise exception 'insufficient_role'; end if;");
    expect(body).toContain("and a.status = 'completed'");
    expect(body).toContain("status in ('succeeded', 'pending', 'requires_action')");
    expect(body).toContain("greatest(l.amount_expected_cents - coalesce(r.reserved_cents, 0), 0)::integer");
  });

  it("preserves the exact same signature and grants (authenticated only, not public/anon)", () => {
    const sql = migration0154Sql();
    expect(sql).toMatch(
      /revoke execute on function public\.get_online_refundable_amount_for_payments\(uuid\[\]\) from public, anon;/,
    );
    expect(sql).toMatch(
      /grant {2}execute on function public\.get_online_refundable_amount_for_payments\(uuid\[\]\) to authenticated;/,
    );
  });

  it("0154's rollback restores the exact pre-0154 (originally shipped 0153) ambiguous body — a real executable statement, not a placeholder", () => {
    const raw = readSource(MIGRATION_0154_PATH);
    const rollbackIdx = raw.indexOf("-- Rollback (manual, cloud SQL Editor)");
    expect(rollbackIdx).toBeGreaterThan(0);
    const rollback = raw.slice(rollbackIdx);
    expect(rollback).toContain("-- create or replace function public.get_online_refundable_amount_for_payments(");
    expect(rollback).toContain("--       select distinct on (payment_id) attempt_id, payment_id, amount_expected_cents, currency");
    expect(rollback).toContain("--         from sources");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Temporary runtime diagnostic (added to page.tsx during this QA pass) was
// fully removed — page.tsx must contain no leftover debug logging.
// ═══════════════════════════════════════════════════════════════════════════

describe("no leftover temporary refund diagnostic in page.tsx or refundActions.ts", () => {
  it("page.tsx contains no refund-diag console logging or file writes", () => {
    const src = readSource("src/app/(app)/admin/payments/page.tsx");
    expect(src).not.toMatch(/refund-diag/);
    expect(src).not.toMatch(/court-time-refund-diag/);
    expect(src).not.toMatch(/appendFileSync/);
    expect(src).not.toMatch(/TEMPORARY DIAGNOSTIC/);
  });

  it("refundActions.ts contains no [open-refund-diag] temporary logging", () => {
    const src = readSource(REFUND_ACTIONS_PATH);
    expect(src).not.toMatch(/open-refund-diag/);
    expect(src).not.toMatch(/TEMPORARY DIAGNOSTIC/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Permanent safeguard (0154/0155 follow-up) — infrastructure-level refund
// errors are logged server-side with safe fields only, never silently
// hidden, while user-facing behavior/messaging is unchanged.
// ═══════════════════════════════════════════════════════════════════════════

describe("unexpected refund RPC/Stripe errors are logged server-side with safe fields only (not redesigned UX)", () => {
  it("refundActions.ts logs open_payment_refund_attempt failures that are NOT one of its own documented application errors", () => {
    const src = readSource(REFUND_ACTIONS_PATH);
    expect(src).toContain('logUnexpectedRefundError("open_payment_refund_attempt", params.paymentId, openError)');
    // Only for the unexpected-error branch — gated on `!key`, close by
    // (not just present anywhere earlier in the file).
    const idx = src.indexOf('logUnexpectedRefundError("open_payment_refund_attempt"');
    const guardIdx = src.lastIndexOf("if (openError && !key)", idx);
    expect(guardIdx).toBeGreaterThan(0);
    expect(idx - guardIdx).toBeLessThan(200);
  });

  it("the logger logs only payment_id/code/message — never the full error object, secrets, or JWTs", () => {
    const src = readSource(REFUND_ACTIONS_PATH);
    const fnIdx = src.indexOf("function logUnexpectedRefundError(");
    expect(fnIdx).toBeGreaterThan(0);
    const fnBody = src.slice(fnIdx, src.indexOf("\n}", fnIdx));
    expect(fnBody).toContain("payment_id: paymentId");
    expect(fnBody).toContain("code: err?.code");
    expect(fnBody).toContain("message: err?.message");
    expect(fnBody).not.toMatch(/details|hint|JSON\.stringify\(err\)/);
  });

  it("backfill_refund_attempt_payment_intent, refunds.create, an unrecognized status, and bind_stripe_refund_result failures are all logged", () => {
    const src = readSource(REFUND_ACTIONS_PATH);
    expect(src).toContain('logUnexpectedRefundError("backfill_refund_attempt_payment_intent"');
    expect(src).toContain('logUnexpectedRefundError("refunds.create"');
    expect(src).toContain('logUnexpectedRefundError("bind_stripe_refund_result"');
  });

  it("user-facing ERROR_MESSAGES and return values are unchanged by adding this logging (no UX redesign)", () => {
    const src = readSource(REFUND_ACTIONS_PATH);
    expect(src).toContain('return { error: ERROR_MESSAGES[key] ?? "Failed to start refund." };');
    expect(src).toContain("return { error: ERROR_MESSAGES.stripe_error };");
    expect(src).toContain("return { error: ERROR_MESSAGES.refund_uncertain };");
  });

  it("page.tsx logs get_online_refundable_amount_for_payments RPC errors server-side, but still safely defaults refundableCents to 0 per row (fail-safe, not fail-hidden)", () => {
    const src = readSource("src/app/(app)/admin/payments/page.tsx");
    expect(src).toContain("get_online_refundable_amount_for_payments failed");
    expect(src).toContain("payment_ids: paymentIds");
    expect(src).toContain("code: refundableError.code ?? null");
    expect(src).toContain("message: refundableError.message ?? null");
    // Still the same fail-safe fallback shape as before — not redesigned.
    expect(src).toContain("(refundableResult.data ?? []).map(r => [r.payment_id, r.refundable_cents])");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 0155 — open_payment_refund_attempt column-reference ambiguity fix
// (runtime QA: "Failed to start refund." / 42702 "column reference
// \"payment_id\" is ambiguous", the same OUT-variable-shadowing class as
// 0154, now confirmed via temporary diagnostic and fixed here).
// ═══════════════════════════════════════════════════════════════════════════

describe("0155 fixes open_payment_refund_attempt's column-reference ambiguity (42702)", () => {
  const OUT_VAR_NAMES = [
    "id", "payment_id", "club_id", "source_checkout_attempt_id", "stripe_account_id",
    "livemode", "stripe_checkout_session_id", "stripe_payment_intent_id",
    "requested_amount_cents", "status", "currency",
  ];

  function executableBody(): string {
    const full = functionBody(migration0155Sql(), "open_payment_refund_attempt");
    const beginIdx = full.indexOf("\nbegin\n");
    expect(beginIdx).toBeGreaterThan(0);
    return full.slice(beginIdx);
  }

  // An INSERT's own target column list names table columns directly and
  // is never (and cannot legally be) alias-qualified — `insert into t
  // (t.col)` is invalid SQL — so it is not subject to the OUT-variable-
  // shadowing ambiguity class this migration fixes. Excluded from the
  // bare-reference scan only; the VALUES/RETURNING clauses of the same
  // statement remain fully in scope and are covered by dedicated tests
  // below (site 5).
  function bareRefScanTarget(): string {
    return executableBody().replace(
      /insert into public\.payment_refund_attempts as pra \([^)]*\)/,
      "insert into public.payment_refund_attempts as pra (/* target column list, not qualifiable */)",
    );
  }

  it("0155 touches ONLY open_payment_refund_attempt — no other function/table/grant", () => {
    const sql = migration0155Sql();
    const createCount = (sql.match(/create or replace function public\./g) ?? []).length;
    expect(createCount).toBe(1);
    expect(sql).toContain("create or replace function public.open_payment_refund_attempt(");
    expect(sql).not.toMatch(/create table|alter table|create index|drop function|drop table/);
  });

  it("every OUT-variable-colliding column name in the executable body is alias-qualified — no bare reference remains anywhere in the function, not just the four confirmed sites", () => {
    const body = bareRefScanTarget();
    for (const name of OUT_VAR_NAMES) {
      const bareRegex = new RegExp(`(?<!\\.)\\b${name}\\b`, "g");
      const matches = body.match(bareRegex) ?? [];
      expect(matches, `bare reference(s) to "${name}" found in open_payment_refund_attempt: ${JSON.stringify(matches)}`).toEqual([]);
    }
  });

  it.each([
    ["site 1 — pending-reuse lookup", "where pra.payment_id = p_payment_id and pra.stripe_refund_id is null and pra.status = 'pending'"],
    ["site 2 — source checkout attempt lookup on reuse", "where pca.id = v_existing_pending.source_checkout_attempt_id"],
    ["site 3 — latest completed checkout provenance lookup", "where pca.payment_id = p_payment_id and pca.status = 'completed'"],
    ["site 4 — reservation SUM", "where pra.source_checkout_attempt_id = v_source.id"],
  ])("%s is qualified exactly as specified", (_label, expected) => {
    const body = executableBody();
    expect(body).toContain(expected);
  });

  it("site 5 (latent, found while qualifying everything) — the INSERT...RETURNING id is also qualified via an aliased insert target", () => {
    const body = executableBody();
    expect(body).toContain("insert into public.payment_refund_attempts as pra (");
    expect(body).toContain("returning pra.id into v_result_id;");
  });

  it("preserves the exact same signature, return shape, and service-role-only grants", () => {
    const sql = migration0155Sql();
    expect(sql).toMatch(
      /revoke execute on function public\.open_payment_refund_attempt\(uuid, uuid, integer, uuid, text\) from public, anon, authenticated;/,
    );
    expect(sql).toMatch(
      /grant {2}execute on function public\.open_payment_refund_attempt\(uuid, uuid, integer, uuid, text\) to service_role;/,
    );
  });

  it("preserves same-amount pending-retry reuse and different-amount fail-closed behavior", () => {
    const body = executableBody();
    expect(body).toContain("if v_existing_pending.requested_amount_cents <> p_requested_amount_cents then");
    expect(body).toContain("raise exception 'pending_refund_amount_mismatch';");
  });

  it("preserves the online-refundable ceiling and every existing exception", () => {
    const body = executableBody();
    expect(body).toContain("v_refundable := v_source.amount_expected_cents - v_reserved_total;");
    expect(body).toContain("raise exception 'refund_exceeds_online_remaining';");
    expect(body).toContain("raise exception 'payment_not_found';");
    expect(body).toContain("raise exception 'no_online_payment_to_refund';");
    expect(body).toContain("raise exception 'invalid_arguments';");
    expect(body).toContain("raise exception 'invalid_refund_amount';");
  });

  it("0155's rollback restores the exact pre-0155 (originally shipped 0153) ambiguous body — a real executable statement, not a placeholder", () => {
    const raw = readSource(MIGRATION_0155_PATH);
    const rollbackIdx = raw.indexOf("-- Rollback (manual, cloud SQL Editor)");
    expect(rollbackIdx).toBeGreaterThan(0);
    const rollback = raw.slice(rollbackIdx);
    expect(rollback).toContain("-- create or replace function public.open_payment_refund_attempt(");
    expect(rollback).toContain("--    where payment_id = p_payment_id and stripe_refund_id is null and status = 'pending'");
    expect(rollback).toContain("--     select * into v_source from public.payment_checkout_attempts where id = v_existing_pending.source_checkout_attempt_id;");
    expect(rollback).toContain("--   ) returning id into v_result_id;");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Reconfirmed complete RETURNS TABLE audit across 0153/0154/0155.
// ═══════════════════════════════════════════════════════════════════════════

describe("complete RETURNS TABLE audit — every function in 0153/0154/0155 accounted for", () => {
  it("exactly three RETURNS TABLE functions exist across 0153/0154; a fourth is not introduced by 0155's own CREATE OR REPLACE (0155 redefines an existing one)", () => {
    const sql153 = migrationSql();
    const returnsTableCount = (sql153.match(/returns table \(/g) ?? []).length;
    // open_payment_refund_attempt, process_stripe_refund_webhook_event,
    // get_online_refundable_amount_for_payments (the last superseded by
    // 0154's own CREATE OR REPLACE, not removed from 0153's own text).
    expect(returnsTableCount).toBe(3);
  });

  it("process_stripe_refund_webhook_event's OUT vars (already_processed, matched) are never referenced as column names anywhere in its OWN body (outside the RETURNS TABLE declaration itself) — confirmed structurally safe", () => {
    const full = functionBody(migrationSql(), "process_stripe_refund_webhook_event");
    const declEndIdx = full.indexOf(")", full.indexOf("returns table ("));
    const afterDecl = full.slice(declEndIdx + 1);
    expect(afterDecl).not.toMatch(/\balready_processed\b/);
    expect(afterDecl).not.toMatch(/\bmatched\b/);
  });

  it("get_online_refundable_amount_for_payments is fixed by 0154 (already covered by its own describe block above) and is NOT touched again by 0155", () => {
    const sql155 = migration0155Sql();
    expect(sql155).not.toMatch(/get_online_refundable_amount_for_payments/);
  });
});
