import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 38B Task 2 — regression coverage for the Server Action layer:
// executeOnlineRefund (the extracted shared Stripe execution helper) and
// the four new Staff-refund-request actions (createRefundRequestAction,
// fetchPendingRefundRequests, rejectRefundRequestAction,
// approveRefundRequestAction), all in src/app/(app)/admin/payments/
// refundActions.ts. Source-inspection style, matching this repository's
// established convention for "use server" files with no jsdom/Supabase
// mocking baseline (see stripeRefund.regression.test.ts's identical
// approach for the pre-existing direct Admin Refund path).

const REFUND_ACTIONS_PATH = "src/app/(app)/admin/payments/refundActions.ts";

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

function actionSrc(): string {
  return readSource(REFUND_ACTIONS_PATH);
}

function getFn(name: string, nextFnMarker: string): string {
  const src = actionSrc();
  const start = src.indexOf(name);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const end = src.indexOf(nextFnMarker, start);
  expect(end, `${nextFnMarker} not found after ${name}`).toBeGreaterThan(start);
  return src.slice(start, end);
}

// approveRefundRequestAction is the LAST function in the file, so there is
// no "next function" marker to bound it — slice to end of file instead.
function getLastFn(name: string): string {
  const src = actionSrc();
  const start = src.indexOf(name);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  return src.slice(start);
}

// ═══════════════════════════════════════════════════════════════════════════
// 1/12 — ONE shared Stripe execution helper, no duplicated implementation
// ═══════════════════════════════════════════════════════════════════════════

describe("executeOnlineRefund — the ONE shared Stripe execution helper", () => {
  it("exists exactly once, and is the only place stripe.refunds.create is actually invoked", () => {
    const src = actionSrc();
    const fnOccurrences = src.split("async function executeOnlineRefund(").length - 1;
    expect(fnOccurrences).toBe(1);
    const callOccurrences = src.split("context.client.refunds.create(").length - 1;
    expect(callOccurrences).toBe(1);
  });

  it("accepts a TRUSTED attempt row (typed TrustedRefundAttempt), never raw club/actor/role parameters — it only ever acts on the attempt it is handed", () => {
    const fn = getFn("async function executeOnlineRefund(", "\nexport async function createOnlineRefundAction(");
    expect(fn).toContain("attempt: TrustedRefundAttempt,");
    expect(fn).not.toMatch(/p_club_id|p_actor_id|profile\.role/);
  });

  it("is used by BOTH createOnlineRefundAction (direct Admin Refund) and approveRefundRequestAction (Staff-request approval) — proving no second Stripe implementation exists for either path", () => {
    const src = actionSrc();
    const occurrences = src.split("return executeOnlineRefund(").length - 1;
    expect(occurrences).toBe(2);
  });

  it("already-resolved short-circuit is unconditional on attempt.status — reached before any Stripe call, so a non-'pending' attempt (e.g. a healed 'succeeded' one) never triggers a second refunds.create", () => {
    const fn = getFn("async function executeOnlineRefund(", "\nexport async function createOnlineRefundAction(");
    const shortCircuitIdx = fn.indexOf('if (attempt.status !== "pending")');
    const createCallIdx = fn.indexOf("context.client.refunds.create(");
    expect(shortCircuitIdx).toBeGreaterThan(-1);
    expect(createCallIdx).toBeGreaterThan(shortCircuitIdx);
  });

  it("reuses the SAME idempotency key derivation (buildRefundIdempotencyKey(attempt.id)) — no second/new idempotency scheme", () => {
    const fn = getFn("async function executeOnlineRefund(", "\nexport async function createOnlineRefundAction(");
    expect(fn).toContain("idempotencyKey: buildRefundIdempotencyKey(attempt.id),");
  });

  it("reconciles through the existing bind_stripe_refund_result RPC only — no direct payment_refund_requests write from this Server Action file", () => {
    const fn = getFn("async function executeOnlineRefund(", "\nexport async function createOnlineRefundAction(");
    expect(fn).toContain('privileged.rpc("bind_stripe_refund_result"');
    // The function's own doc comment explains it never touches
    // payment_refund_requests directly — that phrase is documentation,
    // not code. Assert no actual table access exists (a real write would
    // go through .from("payment_refund_requests") or a dedicated RPC).
    expect(fn).not.toMatch(/\.from\("payment_refund_requests"\)/);
    expect(fn).not.toMatch(/rpc\("(?!bind_stripe_refund_result|mark_refund_attempt_local_failure|backfill_refund_attempt_payment_intent)\w*refund_request\w*"/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 — direct Admin Refund preserves existing behavior
// ═══════════════════════════════════════════════════════════════════════════

describe("createOnlineRefundAction — direct Admin Refund, functionally unchanged", () => {
  it("still independently resolves role via getAuthProfile() and requires 'admin' before reaching the privileged client (unchanged defense-in-depth layer 1)", () => {
    const fn = getFn("export async function createOnlineRefundAction(", "\nexport async function createRefundRequestAction(");
    expect(fn).toContain('if (!profile || profile.role !== "admin") {');
  });

  it("still opens the attempt via open_payment_refund_attempt, using the client-supplied amountCents (Admin-entered, not a Staff-request amount) — then hands off to executeOnlineRefund instead of inlining the Stripe tail", () => {
    const fn = getFn("export async function createOnlineRefundAction(", "\nexport async function createRefundRequestAction(");
    expect(fn).toContain('privileged.rpc("open_payment_refund_attempt"');
    expect(fn).toContain("p_requested_amount_cents: params.amountCents,");
    expect(fn).toContain("return executeOnlineRefund(attemptRows[0], context, privileged, { paymentId: params.paymentId, clubId });");
  });

  it("no inline Stripe call remains inside createOnlineRefundAction's own body", () => {
    const fn = getFn("export async function createOnlineRefundAction(", "\nexport async function createRefundRequestAction(");
    expect(fn).not.toMatch(/refunds\.create\(/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 — createRefundRequestAction: Staff request creation, no trusted client input
// ═══════════════════════════════════════════════════════════════════════════

describe("createRefundRequestAction — Staff request creation, no trusted club/role/actor from client", () => {
  it("accepts only paymentId/amountCents/reason/notes — no clubId, actorId, userId, or role field anywhere in its params type", () => {
    const fn = getFn("export async function createRefundRequestAction(", "\nexport async function fetchPendingRefundRequests(");
    const sigStart = fn.indexOf("params: {");
    const sigEnd = fn.indexOf("},", sigStart);
    const paramsShape = fn.slice(sigStart, sigEnd);
    expect(paramsShape).toContain("paymentId: string;");
    expect(paramsShape).toContain("amountCents: number;");
    expect(paramsShape).toContain("reason: string;");
    expect(paramsShape).not.toMatch(/clubId|actorId|userId|role/i);
  });

  it("never reaches the privileged/service-role client or Stripe — calls the plain authenticated create_refund_request RPC only, which derives club/role/actor itself", () => {
    const fn = getFn("export async function createRefundRequestAction(", "\nexport async function fetchPendingRefundRequests(");
    expect(fn).toContain('supabase.rpc("create_refund_request"');
    expect(fn).not.toMatch(/createPrivilegedClient|getStripeContext|context\.client/);
  });

  it("uses createClient() (the caller's own real session) — never a privileged client that could bypass the RPC's own current_user_role() = 'staff' check", () => {
    const fn = getFn("export async function createRefundRequestAction(", "\nexport async function fetchPendingRefundRequests(");
    expect(fn).toContain("const supabase = await createClient();");
  });

  it("expectedClubId is only ever used for the stale-context preflight (assertActiveClub) — never passed to the RPC as a trusted club id", () => {
    const fn = getFn("export async function createRefundRequestAction(", "\nexport async function fetchPendingRefundRequests(");
    expect(fn).toContain("assertActiveClub(expectedClubId)");
    const rpcCallIdx = fn.indexOf('supabase.rpc("create_refund_request"');
    const rpcCallEnd = fn.indexOf(");", rpcCallIdx);
    expect(fn.slice(rpcCallIdx, rpcCallEnd)).not.toContain("expectedClubId");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// fetchPendingRefundRequests — read model
// ═══════════════════════════════════════════════════════════════════════════

describe("fetchPendingRefundRequests — Admin+Staff read, mirrors fetchOnlineRefundableAmounts' own shape", () => {
  it("calls get_pending_refund_requests_for_payments, never a privileged client", () => {
    const fn = getFn("export async function fetchPendingRefundRequests(", "\nexport async function rejectRefundRequestAction(");
    expect(fn).toContain('supabase.rpc("get_pending_refund_requests_for_payments"');
    expect(fn).not.toMatch(/createPrivilegedClient/);
  });

  it("maps the RPC's snake_case row shape to StaffRefundRequestSummary's camelCase fields without inventing new identity fields", () => {
    const fn = getFn("export async function fetchPendingRefundRequests(", "\nexport async function rejectRefundRequestAction(");
    expect(fn).toContain("requestedBy: row.requested_by,");
    expect(fn).toContain("requestedByName: row.requested_by_name,");
    expect(fn).toContain("attemptStatus: row.attempt_status,");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9/10/11 — rejectRefundRequestAction: Admin only, never touches Stripe
// ═══════════════════════════════════════════════════════════════════════════

describe("rejectRefundRequestAction — Admin only, never calls Stripe", () => {
  it("never imports/reaches the privileged client, Stripe context, or any Stripe SDK call — authority is entirely the plain authenticated reject_refund_request RPC's own current_user_role() check", () => {
    const fn = getFn("export async function rejectRefundRequestAction(", "\nexport async function approveRefundRequestAction(");
    expect(fn).not.toMatch(/createPrivilegedClient|getStripeContext|context\.client|refunds\.create|stripe/i);
    expect(fn).toContain('supabase.rpc("reject_refund_request"');
  });

  it("uses createClient() (the caller's own real session), never a privileged client that could let a non-Admin bypass reject_refund_request's own role check", () => {
    const fn = getFn("export async function rejectRefundRequestAction(", "\nexport async function approveRefundRequestAction(");
    expect(fn).toContain("const supabase = await createClient();");
  });

  it("accepts only requestId and rejectionReason — no role/actor override of any kind", () => {
    const fn = getFn("export async function rejectRefundRequestAction(", "\nexport async function approveRefundRequestAction(");
    const sigStart = fn.indexOf("params: {");
    const sigEnd = fn.indexOf("},", sigStart);
    const paramsShape = fn.slice(sigStart, sigEnd);
    expect(paramsShape).toContain("requestId: string;");
    expect(paramsShape).toContain("rejectionReason: string;");
    expect(paramsShape).not.toMatch(/role|actorId|adminId/i);
  });

  it("never creates a refund attempt or touches payment_refund_attempts/payment_events", () => {
    // Bound tightly to rejectRefundRequestAction's own body only — the
    // next function's leading doc comment (which legitimately mentions
    // begin_refund_request_execution) starts at this marker.
    const fn = getFn("export async function rejectRefundRequestAction(", "\n// ─── approveRefundRequestAction");
    expect(fn).not.toMatch(/payment_refund_attempts|payment_events|open_payment_refund_attempt|begin_refund_request_execution/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4/5/6/7 — approveRefundRequestAction
// ═══════════════════════════════════════════════════════════════════════════

describe("approveRefundRequestAction — Admin only, executes immediately, no client-supplied amount", () => {
  it("accepts ONLY requestId from the client — no amount field anywhere in its params type, so a client cannot supply one even accidentally", () => {
    const fn = getLastFn("export async function approveRefundRequestAction(");
    const sigStart = fn.indexOf("params: {");
    const sigEnd = fn.indexOf("},", sigStart);
    const paramsShape = fn.slice(sigStart, sigEnd);
    expect(paramsShape).toContain("requestId: string");
    expect(paramsShape).not.toMatch(/amount/i);
  });

  it("independently resolves role via getAuthProfile() and requires 'admin' BEFORE ever reaching the privileged client — the same defense-in-depth layer createOnlineRefundAction uses, required here because begin_refund_request_execution is service-role-only and has no independent authorization of its own", () => {
    const fn = getLastFn("export async function approveRefundRequestAction(");
    const profileCheckIdx = fn.indexOf('if (!profile || profile.role !== "admin") {');
    const privilegedIdx = fn.indexOf("createPrivilegedClient()");
    expect(profileCheckIdx).toBeGreaterThan(-1);
    expect(privilegedIdx).toBeGreaterThan(profileCheckIdx);
  });

  it("derives clubId from profile.club_id and actorId from user.id — both server-derived, never client input — and passes them to begin_refund_request_execution", () => {
    const fn = getLastFn("export async function approveRefundRequestAction(");
    expect(fn).toContain("const clubId = profile.club_id;");
    expect(fn).toContain(
      'privileged.rpc("begin_refund_request_execution", {\n' +
      "    p_request_id: params.requestId,\n" +
      "    p_club_id: clubId,\n" +
      "    p_actor_id: user.id,\n" +
      "  });",
    );
  });

  it("calls begin_refund_request_execution — never open_payment_refund_attempt directly (that would bypass the request's own lock/heal/reuse semantics)", () => {
    const fn = getLastFn("export async function approveRefundRequestAction(");
    expect(fn).toContain('privileged.rpc("begin_refund_request_execution"');
    // The function's own doc comment references open_payment_refund_attempt
    // descriptively (explaining the shared return shape) — that's
    // documentation, not a call. Assert no actual RPC invocation of it.
    expect(fn).not.toMatch(/rpc\("open_payment_refund_attempt"/);
  });

  it("sends the trusted returned attempt row to the SAME shared executeOnlineRefund helper — never a second/parallel Stripe execution path", () => {
    const fn = getLastFn("export async function approveRefundRequestAction(");
    expect(fn).toContain(
      "return executeOnlineRefund(attemptRows[0], context, privileged, {\n" +
      "    paymentId: attemptRows[0].payment_id,\n" +
      "    clubId,\n" +
      "  });",
    );
  });

  it("if begin_refund_request_execution returns an already-succeeded (healed) attempt, no second Stripe refund is created — proven by executeOnlineRefund's own status !== 'pending' short-circuit, reused unchanged for this call site too", () => {
    // Structural proof: approveRefundRequestAction has no status check or
    // branching of its own around the returned attempt — it delegates
    // 100% of that decision to executeOnlineRefund, so the SAME
    // short-circuit already proven in the "executeOnlineRefund" describe
    // block above applies identically here, with no special-casing.
    const fn = getLastFn("export async function approveRefundRequestAction(");
    expect(fn).not.toMatch(/attemptRows\[0\]\.status/);
  });

  it("error-code mapping covers begin_refund_request_execution's own documented codes (request_not_found, request_not_pending) alongside the shared open_payment_refund_attempt-family codes it can also surface via the fresh-attempt branch", () => {
    const fn = getLastFn("export async function approveRefundRequestAction(");
    expect(fn).toMatch(/request_not_found\|payment_not_found\|request_not_pending/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Error-mapping reuse — no forked/duplicated message map
// ═══════════════════════════════════════════════════════════════════════════

describe("mapRefundRequestError reuses the existing ERROR_MESSAGES map — no second copy", () => {
  it("mapRefundRequestError reads from the SAME ERROR_MESSAGES object every other action in this file already uses", () => {
    const src = actionSrc();
    const fnIdx = src.indexOf("function mapRefundRequestError(");
    const fnEnd = src.indexOf("\n}", fnIdx);
    const fn = src.slice(fnIdx, fnEnd);
    expect(fn).toContain("ERROR_MESSAGES[key]");
    expect(fn).not.toMatch(/const \w*_MESSAGES\s*[:=]\s*\{/); // no second map literal defined inline here
  });

  it("new Phase 38B error codes are present exactly once each in ERROR_MESSAGES — no duplicate keys", () => {
    const src = actionSrc();
    for (const code of [
      "refund_reason_required",
      "refund_request_already_pending",
      "request_not_found",
      "request_not_pending",
      "rejection_reason_required",
      "refund_request_execution_started",
    ]) {
      const occurrences = src.split(`${code}:`).length - 1;
      expect(occurrences).toBe(1);
    }
  });
});
