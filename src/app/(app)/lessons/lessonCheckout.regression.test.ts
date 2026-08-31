import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 34F-A — regression coverage for lesson_request Checkout, mirroring
// reservationCheckout.regression.test.ts's own established source-
// inspection style (this repository's vitest baseline is deliberately
// pure-TypeScript, no jsdom/Supabase/network mocking — for "does the
// shipped code actually take this shape" questions, reading the real
// source is a more honest guard than reimplementing a parallel mock).
//
// This is domain EXPANSION, not a parallel Stripe implementation: nearly
// every assertion below confirms lessonCheckoutActions.ts reuses the SAME
// service-role RPCs (open_payment_checkout_attempt, supersede_checkout_
// attempt_and_open_fresh, record_checkout_session_created) and the SAME
// pure eligibility/expiry/remaining-balance helpers reservations use — the
// only genuinely new surface is get_lesson_payment_for_checkout (0159, the
// ownership+eligibility read) and the lesson-flavored Stripe param/return-
// URL builders (paymentsConfig.test.ts covers those directly).

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

// Strips `--`/`//` comment-only lines — used whenever a search must not be
// fooled by this migration's own explanatory prose (e.g. a comment
// mentioning "never inserts a payment_events row" would otherwise satisfy
// a naive substring match for "payment_events").
function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !line.trim().startsWith("--") && !line.trim().startsWith("//"))
    .join("\n");
}

const ACTION_PATH        = "src/app/(app)/lessons/lessonCheckoutActions.ts";
const RESERVATION_ACTION_PATH = "src/app/(app)/calendar/reservationCheckoutActions.ts";
const MIGRATION_PATH     = "supabase/migrations/0159_lesson_online_payment_checkout.sql";
const FIX_MIGRATION_PATH = "supabase/migrations/0160_fix_lesson_checkout_wrapper_column_ambiguity.sql";

// ═══════════════════════════════════════════════════════════════════════════
// Checkout creation — server-authoritative, no client-trusted financial value
// ═══════════════════════════════════════════════════════════════════════════

describe("createLessonCheckoutAction — server-authoritative, no client-trusted financial value", () => {
  const src = () => readSource(ACTION_PATH);

  it("rejects an unauthenticated caller before touching any financial data", () => {
    const s = src();
    expect(s).toMatch(/const user = await getAuthUser\(\);\s*\n\s*if \(!user\) return \{ error: ERROR_MESSAGES\.not_authenticated \};/);
  });

  it("resolves the payment via the ownership-scoped RPC, never a client-supplied payment_id/club_id", () => {
    const s = src();
    expect(s).toContain('.rpc("get_lesson_payment_for_checkout", {');
    expect(s).toContain("p_request_id: requestId");
    // The ONLY client input is requestId — payment_id/club_id/amount/
    // currency are read back FROM the RPC's own result (row.*), never
    // accepted as a parameter to this exported action.
    expect(s).not.toMatch(/createLessonCheckoutAction\(\s*[\s\S]{0,80}p_payment_id/);
  });

  it("rejects an obligation not created under court_time_payments — even if the club currently has it enabled (an obligation created while a lesson club was in manual mode stays manual-only forever)", () => {
    const s = src();
    expect(s).toContain('row.payment_mode_at_creation !== "court_time_payments"');
  });

  it("rejects a zero/already-resolved balance via the same status+remaining gate reservations use — paid/overpaid/refunded/waived/void never reopen collection", () => {
    const s = src();
    expect(s).toMatch(/row\.status !== "unpaid" && row\.status !== "partially_paid"/);
    expect(s).toContain("remainingCents(row.amount_due_cents, row.amount_paid_cents) <= 0");
  });

  it("derives livemode server-side via getStripeContext — never from a request/query value", () => {
    const s = src();
    expect(s).toContain("const context = getStripeContext();");
    expect(s).not.toMatch(/searchParams/);
    expect(s).not.toMatch(/req\.query/);
    expect(s).not.toMatch(/p_livemode:\s*(true|false)\b/);
  });

  it("re-checks Stripe readiness fresh at checkout time — retrieves the Account and re-derives status, never trusting a stale DB value", () => {
    const s = src();
    expect(s).toContain(".v2.core.accounts.retrieve(stripeAccountId, CONNECT_ACCOUNT_RETRIEVE_PARAMS)");
    expect(s).toContain("extractCardPaymentsStatus(account)");
    expect(s).toMatch(/if \(cardPaymentsStatus !== "active"\)/);
  });

  it("fails closed (rejects) when the re-checked status is not active — restricted/pending/unsupported are never treated as ready", () => {
    const s = src();
    const startIdx = s.indexOf('if (cardPaymentsStatus !== "active")');
    const block = s.slice(startIdx, startIdx + 600);
    expect(block).toContain("return { error: ERROR_MESSAGES.stripe_connect_not_ready");
  });

  it("amount/currency for the Checkout Session come from the attempt row the server itself opened — never from the client", () => {
    const s = src();
    expect(s).toContain("amountCents: attempt.amount_expected_cents");
    expect(s).toContain("currency: attempt.currency_expected");
  });

  it("creates the Checkout Session in the connected account's own context via the stripeAccount request option — a direct charge, not the platform account", () => {
    const s = src();
    expect(s).toContain("stripeAccount: stripeAccountId,");
  });

  it("never sets application_fee_amount or on_behalf_of anywhere in this file", () => {
    const s = src();
    expect(s).not.toMatch(/application_fee_amount|applicationFeeAmount/);
    expect(s).not.toMatch(/on_behalf_of/);
  });

  it("uses a stable, server-derived Stripe idempotency key built from the attempt id, via the LESSON-specific builder — never the reservation one, never a browser-supplied key", () => {
    const s = src();
    expect(s).toContain("idempotencyKey: buildLessonCheckoutIdempotencyKey(attempt.id)");
    expect(s).not.toContain("buildReservationCheckoutIdempotencyKey");
  });

  it("passes requestId (never a reservation identity) into the lesson-specific session-param and return-URL builders", () => {
    const s = src();
    expect(s).toContain("buildLessonCheckoutReturnUrls(SITE_URL, requestId)");
    expect(s).toContain("lessonRequestId: requestId");
    expect(s).not.toMatch(/reservationId/);
  });

  it("opens the checkout attempt through the atomic LESSON-aware wrapper (never the raw reservation-shaped RPC directly), via the privileged client, never a direct table write", () => {
    const s = src();
    expect(s).toContain('privileged.rpc("open_lesson_payment_checkout_attempt"');
    expect(s).not.toContain('privileged.rpc("open_payment_checkout_attempt"');
    expect(s).not.toMatch(/\.from\(["']payment_checkout_attempts["']\)/);
  });

  it("passes requestId (not row.payment_id) to the atomic wrapper — the wrapper itself resolves payment_id fresh, under the lesson_request row lock, never trusting an earlier caller-side read", () => {
    const s = src();
    expect(s).toMatch(/open_lesson_payment_checkout_attempt",\s*\{\s*\n\s*p_request_id: requestId,/);
  });

  it("REQUIRED, not best-effort: binds the Stripe Session before ever returning a checkout URL", () => {
    const s = src();
    expect(s).not.toMatch(/Best-effort store/i);
    expect(s).toMatch(/REQUIRED, not best-effort/);
    const bindIdx = s.indexOf('const { error: bindError } = await privileged.rpc("record_checkout_session_created"');
    const urlReturnIdx = s.indexOf("return { url: session.url };");
    expect(bindIdx).toBeGreaterThan(-1);
    expect(urlReturnIdx).toBeGreaterThan(bindIdx);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Member-only enforcement (defense in depth) — mirrors reservations exactly
// ═══════════════════════════════════════════════════════════════════════════

describe("Member-only checkout enforcement (defense in depth) — owning Member yes, another Member/Pro/Admin/Staff no", () => {
  const actionSrc = () => readSource(ACTION_PATH);
  const migration = () => readSource(MIGRATION_PATH);

  it("createLessonCheckoutAction requires the caller's current role to be exactly 'member' before any Stripe/payment-attempt mutation", () => {
    const s = actionSrc();
    const profileCheckIdx = s.indexOf('if (!profile || profile.role !== "member")');
    const stripeContextIdx = s.indexOf("const context = getStripeContext();");
    const attemptRpcIdx = s.indexOf('open_lesson_payment_checkout_attempt"');
    expect(profileCheckIdx).toBeGreaterThan(-1);
    expect(stripeContextIdx).toBeGreaterThan(profileCheckIdx);
    expect(attemptRpcIdx).toBeGreaterThan(profileCheckIdx);
  });

  it("getLessonCheckoutEligibilityAction (the Pay Now button's own visibility gate) applies the identical role check, so the button never renders for a Pro/Admin/Staff account — a Pro must never gain a Member's Checkout ownership", () => {
    const s = actionSrc();
    const eligibilityFnIdx = s.indexOf("export async function getLessonCheckoutEligibilityAction");
    const createFnIdx = s.indexOf("export async function createLessonCheckoutAction");
    const eligibilityBody = s.slice(eligibilityFnIdx, createFnIdx);
    expect(eligibilityBody).toContain('if (!profile || profile.role !== "member") return { eligible: false };');
  });

  it("0159's get_lesson_payment_for_checkout independently re-enforces role='member' at the database layer — not merely trusted from the Server Action, so an Admin/Staff/Pro who also holds a roster identity cannot pass either layer", () => {
    const m = migration();
    const fnStart = m.indexOf("create or replace function public.get_lesson_payment_for_checkout(");
    const fnEnd = m.indexOf("revoke execute on function public.get_lesson_payment_for_checkout(");
    const fn = m.slice(fnStart, fnEnd);
    expect(fn).toContain("v_role := public.current_user_role();");
    expect(fn).toMatch(/if v_role <> 'member' then\s*\n\s*raise exception 'insufficient_role';/);
  });

  it("the database-layer role check runs BEFORE the roster-identity ownership check, so a non-owning Member OR a non-Member is rejected regardless of what identity they hold", () => {
    const m = migration();
    const fnStart = m.indexOf("create or replace function public.get_lesson_payment_for_checkout(");
    const fn = m.slice(fnStart);
    const roleCheckIdx = fn.indexOf("raise exception 'insufficient_role';");
    const rosterCheckIdx = fn.indexOf("current_user_roster_member_id();");
    expect(roleCheckIdx).toBeGreaterThan(-1);
    expect(rosterCheckIdx).toBeGreaterThan(roleCheckIdx);
  });

  it("the read is scoped to p.roster_member_id = the CALLER's own current roster identity — another Member's lesson_request payment is structurally unreachable, never merely filtered client-side", () => {
    const m = migration();
    const fnStart = m.indexOf("create or replace function public.get_lesson_payment_for_checkout(");
    const fnEnd = m.indexOf("revoke execute on function public.get_lesson_payment_for_checkout(");
    const fn = m.slice(fnStart, fnEnd);
    expect(fn).toContain("p.roster_member_id = v_roster_member_id");
  });

  it("hardcoded to domain_type = 'lesson_request' — a reservation id passed as p_request_id can never resolve to a row through this function", () => {
    const m = migration();
    const fnStart = m.indexOf("create or replace function public.get_lesson_payment_for_checkout(");
    const fnEnd = m.indexOf("revoke execute on function public.get_lesson_payment_for_checkout(");
    const fn = m.slice(fnStart, fnEnd);
    expect(fn).toContain("p.domain_type = 'lesson_request'");
  });

  it("club scoping is structural via the payments row's own club_id (returned to the caller for assertActiveClub to verify), never a client-supplied club filter inside the RPC itself — a wrong-club attempt fails because assertActiveClub rejects it before the RPC is even reachable with a mismatched session", () => {
    const s = actionSrc();
    expect(s).toContain("assertActiveClub(expectedClubId)");
    const guardIdx = s.indexOf("const guard = await assertActiveClub(expectedClubId);");
    const rpcIdx = s.indexOf('.rpc("get_lesson_payment_for_checkout"');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(rpcIdx).toBeGreaterThan(guardIdx);
  });

  it("grants execute only to authenticated — never public/anon", () => {
    const m = migration();
    expect(m).toContain("revoke execute on function public.get_lesson_payment_for_checkout(uuid) from public, anon;");
    expect(m).toContain("grant  execute on function public.get_lesson_payment_for_checkout(uuid) to authenticated;");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BLOCKER 1 (external review) — a cancelled lesson must not remain
// Member-Checkout-payable, even though its obligation is preserved.
// ═══════════════════════════════════════════════════════════════════════════

describe("get_lesson_payment_for_checkout requires the lesson_request's CURRENT status = 'confirmed' — a cancelled/declined/withdrawn/pending/proposed lesson is structurally unreachable", () => {
  const getFn = () => {
    const m = readSource(MIGRATION_PATH);
    const fnStart = m.indexOf("create or replace function public.get_lesson_payment_for_checkout(");
    const fnEnd = m.indexOf("revoke execute on function public.get_lesson_payment_for_checkout(");
    return m.slice(fnStart, fnEnd);
  };

  it("1. joins lesson_requests and requires status = 'confirmed' before ever reading payments — a confirmed lesson resolves, everything else returns zero rows (not an error)", () => {
    const fn = getFn();
    expect(fn).toContain("from public.lesson_requests lr");
    expect(fn).toContain("if not found or v_request_status <> 'confirmed' then");
    expect(fn).toContain("return;");
  });

  it("2/3. the status check runs BEFORE the payments query — cancelled/declined/withdrawn/pending/proposed all fail identically, via the SAME single gate, never a per-status branch that could be individually forgotten", () => {
    const fn = getFn();
    const statusCheckIdx = fn.indexOf("if not found or v_request_status <> 'confirmed' then");
    const paymentsQueryIdx = fn.indexOf("from public.payments p");
    expect(statusCheckIdx).toBeGreaterThan(-1);
    expect(paymentsQueryIdx).toBeGreaterThan(statusCheckIdx);
    // No per-status carve-out exists — 'cancelled'/'declined'/'withdrawn'/
    // 'pending'/'proposed' are never individually named; the single <>
    // 'confirmed' comparison rejects all of them uniformly.
    expect(fn).not.toMatch(/'cancelled'|'declined'|'withdrawn'|'pending'/);
  });

  it("4. lifecycle ineligibility is a silent empty result (RETURN with no rows), never a raised exception — matches the caller's own not-found handling (lesson_payment_not_found), not a distinct error path", () => {
    const fn = getFn();
    const returnIdx = fn.indexOf("if not found or v_request_status <> 'confirmed' then\n    return;\n  end if;");
    expect(returnIdx).toBeGreaterThan(-1);
  });

  it("5. another Member's lesson remains unreachable — the payments query still filters on p.roster_member_id = the CALLER's own current roster identity, unchanged by this correction", () => {
    const fn = getFn();
    expect(fn).toContain("p.roster_member_id = v_roster_member_id");
  });

  it("6. Pro/Admin/Staff remain unreachable — the role check (role must be exactly 'member') still runs, unchanged, before the new lifecycle check", () => {
    const fn = getFn();
    const roleCheckIdx = fn.indexOf("if v_role <> 'member' then");
    const lifecycleCheckIdx = fn.indexOf("if not found or v_request_status <> 'confirmed' then");
    expect(roleCheckIdx).toBeGreaterThan(-1);
    expect(lifecycleCheckIdx).toBeGreaterThan(roleCheckIdx);
  });

  it("verifies lesson_request.club_id corresponds to the resolved payment's club_id — defense in depth against a cross-club id", () => {
    const fn = getFn();
    expect(fn).toContain("and lr.club_id = v_club_id");
    expect(fn).toContain("p.club_id = v_request_club_id");
  });

  it("never trusts client-supplied lifecycle information — the function's only parameter is p_request_id; status/club_id are both read fresh from the database inside this SECURITY DEFINER function, never accepted as a parameter", () => {
    const fn = getFn();
    expect(fn).toMatch(/create or replace function public\.get_lesson_payment_for_checkout\(\s*\n\s*p_request_id uuid\s*\n\)/);
    expect(fn).not.toMatch(/p_status|p_lesson_status/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BLOCKER 2 (external review) — cancelling a confirmed lesson must
// invalidate an already-open Checkout attempt, not merely block NEW ones.
// ═══════════════════════════════════════════════════════════════════════════

describe("cancel_lesson invalidates/flags an open Checkout attempt BEFORE its own domain mutation — reuses the established 0151 pattern, never a second stale-checkout system", () => {
  const getFn = () => {
    const m = readSource(MIGRATION_PATH);
    const fnStart = m.indexOf(
      "create or replace function public.cancel_lesson(\n  p_request_id uuid,\n  p_reason     text default null\n)",
    );
    const fnEnd = m.indexOf("revoke execute on function public.cancel_lesson(uuid, text) from public, anon;");
    return m.slice(fnStart, fnEnd);
  };

  it("5/6. resolves the current payment obligation and calls the SAME _invalidate_or_flag_open_checkout_attempt helper 0151 already wires into update_member_reservation/admin_update_member_lesson — never a bespoke lesson-cancellation-specific invalidation routine", () => {
    const fn = getFn();
    expect(fn).toContain("select id into v_payment_id_for_checkout_guard");
    expect(fn).toContain("domain_type = 'lesson_request' and domain_id = p_request_id");
    expect(fn).toContain("perform public._invalidate_or_flag_open_checkout_attempt(v_payment_id_for_checkout_guard)");
  });

  it("the guard runs AFTER every existing status/window validation but BEFORE the first mutating UPDATE — an invalid cancel request never expires a legitimate Stripe Checkout Session before Court Time even knows the action would fail", () => {
    const fn = getFn();
    const windowCheckIdx = fn.indexOf("raise exception 'within_cancellation_window';");
    const guardIdx = fn.indexOf("perform public._invalidate_or_flag_open_checkout_attempt(v_payment_id_for_checkout_guard)");
    const firstUpdateIdx = fn.indexOf("update public.reservations");
    const secondUpdateIdx = fn.indexOf("update public.lesson_requests");
    expect(windowCheckIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(windowCheckIdx);
    expect(guardIdx).toBeLessThan(firstUpdateIdx);
    expect(guardIdx).toBeLessThan(secondUpdateIdx);
  });

  it("the guard covers BOTH of cancel_lesson's admitted entry statuses ('confirmed', and 'proposed' with a linked reservation — a reschedule proposal on an already-confirmed lesson) via a single lookup keyed only on domain_id, not duplicated per entry branch", () => {
    const fn = getFn();
    const statusGateIdx = fn.indexOf("v_request.status = 'confirmed'");
    const guardIdx = fn.indexOf("select id into v_payment_id_for_checkout_guard");
    expect(statusGateIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(statusGateIdx);
    // One guard call site only — not duplicated inside the `if
    // v_request.linked_reservation_id is not null` branch and again
    // outside it.
    const occurrences = fn.split("_invalidate_or_flag_open_checkout_attempt(").length - 1;
    expect(occurrences).toBe(1);
  });

  it("7. cancellation never INSERTs into payment_events and never references amount_due_cents/amount_paid_cents/refund/waive/void in actual code (comments aside) — remains a pure DOMAIN mutation, exactly like the pre-existing (unguarded) reservation cancellation precedent", () => {
    const fn = codeOnly(getFn());
    expect(fn).not.toMatch(/insert into public\.payment_events/);
    expect(fn).not.toMatch(/amount_due_cents|amount_paid_cents/);
    expect(fn).not.toMatch(/perform public\.(record_refund|waive_payment|void_payment_obligation)/);
  });

  it("8. the domain mutation (lesson_requests.status = 'cancelled') is untouched by this correction — real collected Stripe money is never discarded or reduced by cancellation", () => {
    const fn = getFn();
    expect(fn).toContain("status            = 'cancelled'");
    expect(fn).toContain("lesson_outcome    = 'cancelled'");
  });

  it("locks the payments row (for update) before calling the guard, matching the canonical payments -> payment_checkout_attempts lock order used everywhere else in this architecture (0150/0151)", () => {
    const fn = getFn();
    expect(fn).toMatch(/select id into v_payment_id_for_checkout_guard[\s\S]{0,200}for update/);
  });
});

describe("cancelLesson Server Action resolves a blocking bound Session via the established handshake before retrying — mirrors adminUpdateMemberLessonAction's own identical pattern", () => {
  const ACTIONS_PATH = "src/app/(app)/lessons/actions.ts";

  it("6/9. catches OPEN_CHECKOUT_REQUIRES_RESOLUTION from cancel_lesson's own error, resolves via resolveBlockingCheckoutBeforeMutation (the SAME shared handshake — Stripe retrieve/expire, never a bespoke lesson routine), then retries cancel_lesson exactly once", () => {
    const s = readSource(ACTIONS_PATH);
    const cancelFnIdx = s.indexOf("export async function cancelLesson(");
    const nextFnIdx = s.indexOf("export async function getClubProsAction(");
    const fn = s.slice(cancelFnIdx, nextFnIdx);
    expect(fn).toContain("error?.message.includes(OPEN_CHECKOUT_REQUIRES_RESOLUTION)");
    expect(fn).toContain("resolveBlockingCheckoutBeforeMutation(paymentId, params.expectedClubId)");
    // Exactly two RPC call sites for cancel_lesson: the original attempt
    // and the single retry — never an unbounded/looping retry.
    const occurrences = fn.split('supabase.rpc("cancel_lesson"').length - 1;
    expect(occurrences).toBe(2);
  });

  it("resolves the blocking payment id via the SAME sanitized batched read boundary (fetchPaymentStates) every other lesson-payment surface uses — never a raw table query for the payment id", () => {
    const s = readSource(ACTIONS_PATH);
    const cancelFnIdx = s.indexOf("export async function cancelLesson(");
    const nextFnIdx = s.indexOf("export async function getClubProsAction(");
    const fn = s.slice(cancelFnIdx, nextFnIdx);
    expect(fn).toContain('fetchPaymentStates("lesson_request", [params.requestId])');
  });

  it("9. if resolution fails (Stripe/network/livemode-mismatch), the Admin refund architecture for any ALREADY-collected money is untouched — this path only ever blocks/retries the CANCELLATION, never touches refund/waive/void RPCs", () => {
    const s = readSource(ACTIONS_PATH);
    const cancelFnIdx = s.indexOf("export async function cancelLesson(");
    const nextFnIdx = s.indexOf("export async function getClubProsAction(");
    const fn = s.slice(cancelFnIdx, nextFnIdx);
    expect(fn).not.toMatch(/record_refund|waive_payment|void_payment_obligation/);
  });
});

describe("10. late/concurrent genuine Stripe success during a cancellation race is preserved exactly once — via the SAME unchanged webhook reconciliation, not a new path", () => {
  it("_invalidate_or_flag_open_checkout_attempt's own already-completed handling is untouched by this migration — an attempt already marked 'completed' (webhook won the race) is never touched by cancel_lesson's new guard, since the helper only ever acts on a currently-'open' attempt", () => {
    const s = readSource("supabase/migrations/0151_stale_checkout_invalidation.sql");
    const fnStart = s.indexOf("create or replace function public._invalidate_or_flag_open_checkout_attempt(");
    const fnEnd = s.indexOf("revoke all on function public._invalidate_or_flag_open_checkout_attempt(");
    const fn = s.slice(fnStart, fnEnd);
    expect(fn).toContain("and status = 'open'");
  });

  it("cancel_lesson never calls process_stripe_payment_event or any refund/webhook RPC itself — reconciliation of a genuinely-completed Session remains entirely the unchanged webhook's own job", () => {
    const m = readSource(MIGRATION_PATH);
    const fnStart = m.indexOf(
      "create or replace function public.cancel_lesson(\n  p_request_id uuid,\n  p_reason     text default null\n)",
    );
    const fnEnd = m.indexOf("revoke execute on function public.cancel_lesson(uuid, text) from public, anon;");
    const fn = m.slice(fnStart, fnEnd);
    expect(fn).not.toMatch(/process_stripe_payment_event/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Stale/competing attempt handling — reused verbatim from reservations
// ═══════════════════════════════════════════════════════════════════════════

describe("stale/competing Checkout attempt handling — identical must_expire_remote orchestration to reservations", () => {
  const src = () => readSource(ACTION_PATH);

  it("never knowingly exposes two simultaneously payable Sessions for the same payment — retrieves and, if still open, expires the stale bound Session via Stripe before superseding", () => {
    const s = src();
    expect(s).toContain('if (attempt.action === "must_expire_remote")');
    expect(s).toContain("context.client.checkout.sessions.retrieve(");
    expect(s).toContain('if (staleSession.status === "complete")');
    expect(s).toContain('return { error: ERROR_MESSAGES.payment_processing };');
    expect(s).toContain('if (staleSession.status === "open")');
    expect(s).toContain("context.client.checkout.sessions.expire(");
  });

  it("supersedes through the atomic LESSON-aware wrapper (never the raw reservation-shaped RPC directly), passing requestId so the wrapper can re-lock/re-verify the lesson fresh", () => {
    const s = src();
    expect(s).toContain('privileged.rpc(\n      "supersede_lesson_checkout_attempt_and_open_fresh"');
    expect(s).not.toContain('privileged.rpc(\n      "supersede_checkout_attempt_and_open_fresh"');
    expect(s).toMatch(/supersede_lesson_checkout_attempt_and_open_fresh",\s*\n\s*\{\s*\n\s*p_request_id: requestId,/);
  });

  it("a Stripe-confirmed already-complete stale Session is never superseded — the caller stops and lets webhook reconciliation (unchanged, domain-agnostic) finish", () => {
    const s = src();
    const completeIdx = s.indexOf('if (staleSession.status === "complete")');
    const supersedeIdx = s.indexOf('privileged.rpc(\n      "supersede_lesson_checkout_attempt_and_open_fresh"');
    expect(completeIdx).toBeGreaterThan(-1);
    // The complete-branch's own early return is textually before the
    // supersede call, and reachable independently of it (an early return
    // inside the must_expire_remote block).
    expect(supersedeIdx).toBeGreaterThan(completeIdx);
  });

  it("a fresh attempt reuses an existing still-open, still-matching attempt's bound Session by RETRIEVING it — never re-creates with a fresh idempotency-key call that could mismatch on a moving expires_at", () => {
    const s = src();
    expect(s).toMatch(/if \(attempt\.stripe_checkout_session_id\) \{[\s\S]{0,500}session = await context\.client\.checkout\.sessions\.retrieve\(/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Reused, domain-agnostic machinery — the actual 34F-A "generalize, don't
// duplicate" claim, verified directly against the shared, UNCHANGED files.
// ═══════════════════════════════════════════════════════════════════════════

describe("reused domain-agnostic machinery — process_stripe_payment_event, open_payment_checkout_attempt, and the stale-edit invalidation guard are untouched and already lesson-aware", () => {
  it("process_stripe_payment_event is never CALLED from lessonCheckoutActions.ts (only mentioned in its own explanatory comments) — reconciliation is entirely webhook-driven and shared, not duplicated per domain", () => {
    const s = readSource(ACTION_PATH);
    expect(s).not.toMatch(/\.rpc\(\s*["']process_stripe_payment_event["']/);
  });

  it("0151's admin_update_member_lesson already calls the SAME pre-mutation stale-Checkout guard reservations' update_member_reservation uses, before this phase's own migration ever ran — confirms Section 4 (stale Checkout invalidation on a lesson price/reassignment edit) was already live, not newly added here", () => {
    const s = readSource("supabase/migrations/0151_stale_checkout_invalidation.sql");
    const fnStart = s.indexOf("create or replace function public.admin_update_member_lesson(");
    const fnEnd = s.indexOf("-- ═", fnStart + 100);
    const fn = s.slice(fnStart, fnEnd);
    expect(fn).toContain("public._invalidate_or_flag_open_checkout_attempt(v_payment_id_for_checkout_guard)");
  });

  it("lessonCheckoutActions.ts never redefines/duplicates open_payment_checkout_attempt, supersede_checkout_attempt_and_open_fresh, or record_checkout_session_created — it only calls the atomic lesson wrappers and the existing RPCs by name", () => {
    const s = readSource(ACTION_PATH);
    expect(s).not.toMatch(/create (or replace )?function/i);
    expect(s).toContain('privileged.rpc("open_lesson_payment_checkout_attempt"');
    expect(s).toContain('privileged.rpc("record_checkout_session_created"');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BLOCKER 1 (second review round) — eliminate the lifecycle eligibility
// TOCTOU race between get_lesson_payment_for_checkout's own read and the
// domain-agnostic, intentionally lesson-unaware attempt-open step.
// ═══════════════════════════════════════════════════════════════════════════

describe("open_lesson_payment_checkout_attempt — atomic lock-then-delegate wrapper closes the TOCTOU race", () => {
  const getFn = () => {
    const m = readSource(MIGRATION_PATH);
    const fnStart = m.indexOf("create or replace function public.open_lesson_payment_checkout_attempt(");
    const fnEnd = m.indexOf(
      "revoke execute on function public.open_lesson_payment_checkout_attempt(uuid, uuid, text, boolean, uuid) from public, anon, authenticated;",
    );
    return m.slice(fnStart, fnEnd);
  };

  it("1. locks the lesson_requests row FIRST (for update) and requires status = 'confirmed' before ever resolving a payment id — a confirmed lesson can atomically proceed", () => {
    const fn = getFn();
    const lockIdx = fn.indexOf("select status into v_request_status");
    const lockClauseIdx = fn.indexOf("for update;", lockIdx);
    const statusCheckIdx = fn.indexOf("if v_request_status <> 'confirmed' then");
    const paymentLookupIdx = fn.indexOf("select id into v_payment_id");
    expect(lockIdx).toBeGreaterThan(-1);
    expect(lockClauseIdx).toBeGreaterThan(lockIdx);
    expect(statusCheckIdx).toBeGreaterThan(lockClauseIdx);
    expect(paymentLookupIdx).toBeGreaterThan(statusCheckIdx);
  });

  it("2. a pending/proposed/cancelled lesson raises lesson_not_confirmed and never reaches the payment lookup or the delegated open_payment_checkout_attempt call", () => {
    const fn = getFn();
    const statusCheckIdx = fn.indexOf("raise exception 'lesson_not_confirmed';");
    const delegateIdx = fn.indexOf("select * from public.open_payment_checkout_attempt(");
    expect(statusCheckIdx).toBeGreaterThan(-1);
    expect(delegateIdx).toBeGreaterThan(statusCheckIdx);
  });

  it("a nonexistent/wrong-club lesson_request id raises lesson_not_found — never silently falls through", () => {
    const fn = getFn();
    expect(fn).toContain("if not found then");
    expect(fn).toContain("raise exception 'lesson_not_found';");
  });

  it("never trusts a client-supplied payment id — payment_id is resolved HERE, fresh, from the payments table, never accepted as a parameter", () => {
    const fn = getFn();
    expect(fn).not.toMatch(/p_payment_id/);
    expect(fn).toContain("select id into v_payment_id");
    expect(fn).toContain("domain_type = 'lesson_request' and domain_id = p_request_id");
  });

  it("delegates the ENTIRE remaining algorithm to the existing, unmodified open_payment_checkout_attempt via a single call — never duplicates its eligibility/amount/reuse logic", () => {
    const fn = getFn();
    expect(fn).toContain(
      "select * from public.open_payment_checkout_attempt(\n      v_payment_id, p_club_id, p_stripe_account_id, p_livemode, p_actor_id\n    );",
    );
    // No independent re-implementation of amount/currency snapshotting or
    // attempt-status branching exists in this wrapper.
    expect(fn).not.toMatch(/amount_expected_cents\s*:=|currency_expected\s*:=/);
  });

  it("service_role-only — never callable from an authenticated browser session, matching the underlying open_payment_checkout_attempt's own grant", () => {
    const m = readSource(MIGRATION_PATH);
    expect(m).toContain(
      "revoke execute on function public.open_lesson_payment_checkout_attempt(uuid, uuid, text, boolean, uuid) from public, anon, authenticated;",
    );
    expect(m).toContain(
      "grant  execute on function public.open_lesson_payment_checkout_attempt(uuid, uuid, text, boolean, uuid) to service_role;",
    );
  });
});

describe("supersede_lesson_checkout_attempt_and_open_fresh — the identical atomic pattern applied to the secondary (stale-attempt) attempt-opening call site", () => {
  const getFn = () => {
    const m = readSource(MIGRATION_PATH);
    const fnStart = m.indexOf(
      "create or replace function public.supersede_lesson_checkout_attempt_and_open_fresh(",
    );
    const fnEnd = m.indexOf(
      "revoke execute on function public.supersede_lesson_checkout_attempt_and_open_fresh(uuid, uuid, uuid, text, boolean, uuid) from public, anon, authenticated;",
    );
    return m.slice(fnStart, fnEnd);
  };

  it("locks the lesson_requests row and requires status = 'confirmed', mirroring open_lesson_payment_checkout_attempt exactly — closes the SAME race for the out-of-process Stripe round-trip window (retrieve/expire the stale Session) that cannot hold a DB lock", () => {
    const fn = getFn();
    expect(fn).toContain("for update;");
    expect(fn).toContain("raise exception 'lesson_not_confirmed';");
  });

  it("delegates to the existing, unmodified supersede_checkout_attempt_and_open_fresh — never duplicates its own already_completed/expired-then-fresh algorithm", () => {
    const fn = getFn();
    expect(fn).toContain(
      "select * from public.supersede_checkout_attempt_and_open_fresh(\n      p_stale_attempt_id, v_payment_id, p_club_id, p_stripe_account_id, p_livemode, p_actor_id\n    );",
    );
  });

  it("service_role-only, matching the underlying function's own grant", () => {
    const m = readSource(MIGRATION_PATH);
    expect(m).toContain(
      "grant  execute on function public.supersede_lesson_checkout_attempt_and_open_fresh(uuid, uuid, uuid, text, boolean, uuid) to service_role;",
    );
  });
});

describe("3. race-ordering invariant — whichever side wins the lesson_requests row lock first, the other correctly serializes against post-commit truth", () => {
  it("if Checkout wins the lock first: it opens/reuses the attempt inside the SAME transaction as the lock, then commits (releasing the lock) — a concurrent cancel_lesson/propose_lesson_time blocked on that same lock then proceeds and its OWN guard (querying payments fresh, post-commit) correctly sees and invalidates the just-opened attempt", () => {
    const m = readSource(MIGRATION_PATH);
    const openFnStart = m.indexOf("create or replace function public.open_lesson_payment_checkout_attempt(");
    const openFnEnd = m.indexOf(
      "revoke execute on function public.open_lesson_payment_checkout_attempt(uuid, uuid, text, boolean, uuid) from public, anon, authenticated;",
    );
    const openFn = m.slice(openFnStart, openFnEnd);
    // The lesson_requests lock and the delegated attempt-open call are in
    // the SAME function body — i.e. the same transaction — with no
    // intervening commit.
    const lockIdx = openFn.indexOf("for update;");
    const delegateIdx = openFn.indexOf("select * from public.open_payment_checkout_attempt(");
    expect(lockIdx).toBeGreaterThan(-1);
    expect(delegateIdx).toBeGreaterThan(lockIdx);

    // cancel_lesson's own guard resolves payment_id fresh (a plain SELECT,
    // not a cached/stale value) immediately before invalidating — so a
    // post-commit re-read by a blocked concurrent caller sees the new
    // attempt.
    const cancelFnStart = m.indexOf(
      "create or replace function public.cancel_lesson(\n  p_request_id uuid,\n  p_reason     text default null\n)",
    );
    const cancelFnEnd = m.indexOf("revoke execute on function public.cancel_lesson(uuid, text) from public, anon;");
    const cancelFn = m.slice(cancelFnStart, cancelFnEnd);
    expect(cancelFn).toContain("select id into v_payment_id_for_checkout_guard");
  });

  it("if cancellation/reschedule wins the lock first: it mutates status and commits (releasing the lock) — Checkout, blocked on the SAME lesson_requests lock, then proceeds, re-reads status under its OWN fresh lock, finds it no longer 'confirmed', and fails closed with lesson_not_confirmed BEFORE ever resolving a payment id or opening an attempt", () => {
    const m = readSource(MIGRATION_PATH);
    const openFnStart = m.indexOf("create or replace function public.open_lesson_payment_checkout_attempt(");
    const openFnEnd = m.indexOf(
      "revoke execute on function public.open_lesson_payment_checkout_attempt(uuid, uuid, text, boolean, uuid) from public, anon, authenticated;",
    );
    const openFn = m.slice(openFnStart, openFnEnd);
    const lockIdx = openFn.indexOf("for update;");
    const statusCheckIdx = openFn.indexOf("raise exception 'lesson_not_confirmed';");
    const paymentLookupIdx = openFn.indexOf("select id into v_payment_id");
    expect(lockIdx).toBeGreaterThan(-1);
    expect(statusCheckIdx).toBeGreaterThan(lockIdx);
    // The status check (and its raise) is textually BEFORE the payment
    // lookup — no payment is ever resolved for an ineligible lesson.
    expect(paymentLookupIdx).toBeGreaterThan(statusCheckIdx);
  });

  it("both open_lesson_payment_checkout_attempt and every lesson-mutating RPC (cancel_lesson, propose_lesson_time, admin_update_member_lesson) lock lesson_requests via the SAME `for update` idiom as their first substantive step — establishing one consistent lock ordering, never a competing/ad-hoc one", () => {
    const m = readSource(MIGRATION_PATH);
    for (const marker of [
      "create or replace function public.open_lesson_payment_checkout_attempt(",
      "create or replace function public.cancel_lesson(\n  p_request_id uuid,\n  p_reason     text default null\n)",
      "create or replace function public.propose_lesson_time(\n  p_request_id            uuid,",
      "create or replace function public.admin_update_member_lesson(p_request_id uuid, p_expected_club_id uuid,",
    ]) {
      const start = m.indexOf(marker);
      expect(start).toBeGreaterThan(-1);
      const nextForUpdate = m.indexOf("for update", start);
      expect(nextForUpdate).toBeGreaterThan(start);
      expect(nextForUpdate - start).toBeLessThan(2000);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BLOCKER 2 (second review round) — confirmed -> proposed reschedule must
// invalidate an already-open Checkout; provider reassignment audited.
// ═══════════════════════════════════════════════════════════════════════════

describe("5. propose_lesson_time invalidates/flags an open Checkout attempt BEFORE its own domain mutation (confirmed -> proposed)", () => {
  const getFn = () => {
    const m = readSource(MIGRATION_PATH);
    const fnStart = m.indexOf("create or replace function public.propose_lesson_time(\n  p_request_id            uuid,");
    const fnEnd = m.indexOf(
      "revoke execute on function public.propose_lesson_time(uuid, timestamptz, timestamptz, timestamptz, uuid) from public, anon;",
    );
    return m.slice(fnStart, fnEnd);
  };

  it("resolves the current payment obligation and calls the SAME _invalidate_or_flag_open_checkout_attempt helper cancel_lesson/admin_update_member_lesson use — never a bespoke resolver", () => {
    const fn = getFn();
    expect(fn).toContain("select id into v_payment_id_for_checkout_guard");
    expect(fn).toContain("domain_type = 'lesson_request' and domain_id = p_request_id");
    expect(fn).toContain("perform public._invalidate_or_flag_open_checkout_attempt(v_payment_id_for_checkout_guard)");
  });

  it("6. the guard runs AFTER every existing status/optimistic-concurrency/scheduling/availability validation but BEFORE the mutating UPDATE that flips status to 'proposed'", () => {
    const fn = getFn();
    const availabilityCheckIdx = fn.indexOf("perform public._lesson_check_member_availability(");
    const guardIdx = fn.indexOf("perform public._invalidate_or_flag_open_checkout_attempt(v_payment_id_for_checkout_guard)");
    const mutationIdx = fn.indexOf("set status             = 'proposed'");
    expect(availabilityCheckIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(availabilityCheckIdx);
    expect(guardIdx).toBeLessThan(mutationIdx);
  });

  it("a single guard call site (not duplicated per entry status) — a no-op for the 'pending'/first-time-'proposed' entry cases that have no obligation yet, and effective for the 'confirmed' entry case (a genuine reschedule)", () => {
    const fn = getFn();
    const occurrences = fn.split("_invalidate_or_flag_open_checkout_attempt(").length - 1;
    expect(occurrences).toBe(1);
  });

  it("7. remains a pure DOMAIN mutation — never inserts a payment_events row, never references amount_due_cents/amount_paid_cents, never calls record_refund/waive_payment/void_payment_obligation", () => {
    const fn = codeOnly(getFn());
    expect(fn).not.toMatch(/insert into public\.payment_events/);
    expect(fn).not.toMatch(/amount_due_cents|amount_paid_cents/);
    expect(fn).not.toMatch(/perform public\.(record_refund|waive_payment|void_payment_obligation)/);
  });
});

describe("proposeLessonTime Server Action resolves a blocking bound Session via the established handshake before retrying — mirrors cancelLesson/adminUpdateMemberLessonAction's own identical pattern", () => {
  const ACTIONS_PATH = "src/app/(app)/lessons/actions.ts";

  it("6. catches OPEN_CHECKOUT_REQUIRES_RESOLUTION from propose_lesson_time's own error, resolves via resolveBlockingCheckoutBeforeMutation, then retries exactly once", () => {
    const s = readSource(ACTIONS_PATH);
    const fnIdx = s.indexOf("export async function proposeLessonTime(");
    const nextFnIdx = s.indexOf("export async function declineLessonRequest(");
    const fn = s.slice(fnIdx, nextFnIdx);
    expect(fn).toContain("error?.message.includes(OPEN_CHECKOUT_REQUIRES_RESOLUTION)");
    expect(fn).toContain("resolveBlockingCheckoutBeforeMutation(paymentId, params.expectedClubId)");
    const occurrences = fn.split('supabase.rpc("propose_lesson_time"').length - 1;
    expect(occurrences).toBe(2);
  });

  it("takes expectedClubId and gates on assertActiveClub, matching every other lesson-mutating action in this file", () => {
    const s = readSource(ACTIONS_PATH);
    const fnIdx = s.indexOf("export async function proposeLessonTime(");
    const nextFnIdx = s.indexOf("export async function declineLessonRequest(");
    const fn = s.slice(fnIdx, nextFnIdx);
    expect(fn).toContain("assertActiveClub(params.expectedClubId)");
  });

  it("9. resolution failures never touch refund/waive/void RPCs — this path only ever blocks/retries the PROPOSAL", () => {
    const s = readSource(ACTIONS_PATH);
    const fnIdx = s.indexOf("export async function proposeLessonTime(");
    const nextFnIdx = s.indexOf("export async function declineLessonRequest(");
    const fn = s.slice(fnIdx, nextFnIdx);
    expect(fn).not.toMatch(/record_refund|waive_payment|void_payment_obligation/);
  });
});

describe("8. decline_lesson_proposal reverts a reschedule back to 'confirmed' — never cancels, so Checkout eligibility naturally resumes and a fresh attempt can be opened afterward through the unchanged atomic wrapper", () => {
  it("its reschedule branch (linked_reservation_id is not null) sets status back to 'confirmed', restored from the still-active linked reservation — never 'cancelled', never any other terminal status", () => {
    const s = readSource("supabase/migrations/0111_staff_managed_lessons_identity.sql");
    const fnStart = s.indexOf("create or replace function public.decline_lesson_proposal(");
    const fnEnd = s.indexOf("revoke execute on function public.decline_lesson_proposal(uuid) from public, anon;");
    const fn = s.slice(fnStart, fnEnd);
    expect(fn).toMatch(/if v_is_reschedule then[\s\S]{0,900}set status\s+= 'confirmed'/);
  });

  it("decline_lesson_proposal needs no Checkout-invalidation guard of its own — it never leaves a confirmed lesson non-payable (the reschedule branch reverts TO confirmed; the non-reschedule branch only ever applies to a pre-obligation first-time proposal)", () => {
    const s = readSource("supabase/migrations/0111_staff_managed_lessons_identity.sql");
    const fnStart = s.indexOf("create or replace function public.decline_lesson_proposal(");
    const fnEnd = s.indexOf("revoke execute on function public.decline_lesson_proposal(uuid) from public, anon;");
    const fn = s.slice(fnStart, fnEnd);
    expect(fn).not.toMatch(/_invalidate_or_flag_open_checkout_attempt/);
  });
});

describe("9. provider reassignment — reassign_lesson_provider is structurally unreachable for any obligation-bearing lesson (proven, not merely assumed)", () => {
  it("its own status gate rejects BOTH 'confirmed' and the reschedule-flavored 'proposed' (linked_reservation_id not null) — the only two statuses that can ever carry a payment obligation", () => {
    const s = readSource("supabase/migrations/0132_staff_operational_authorization.sql");
    const fnStart = s.indexOf("create or replace function public.reassign_lesson_provider(");
    const fnEnd = s.indexOf("revoke execute on function public.reassign_lesson_provider(uuid, uuid) from public, anon;");
    const fn = s.slice(fnStart, fnEnd);
    expect(fn).toContain("if v_request.status not in ('pending', 'proposed')");
    expect(fn).toContain("or (v_request.status = 'proposed' and v_request.linked_reservation_id is not null)");
    expect(fn).toContain("raise exception 'invalid_status_for_reassign';");
  });

  it("consequently needs no Checkout-invalidation guard — not added, and this migration does not redefine reassign_lesson_provider at all", () => {
    const m = readSource(MIGRATION_PATH);
    expect(m).not.toMatch(/create or replace function public\.reassign_lesson_provider/);
  });

  it("the ONLY RPC that can change the Pro on an already-'confirmed' lesson while it stays 'confirmed' is admin_update_member_lesson — its own guard is what BLOCKER 2 fixes below, not reassign_lesson_provider", () => {
    const s = readSource("supabase/migrations/0132_staff_operational_authorization.sql");
    const fnStart = s.indexOf("create or replace function public.reassign_lesson_provider(");
    const fnEnd = s.indexOf("revoke execute on function public.reassign_lesson_provider(uuid, uuid) from public, anon;");
    const fn = s.slice(fnStart, fnEnd);
    // The mutation always resets status to 'pending' — never leaves the
    // lesson 'confirmed' after reassignment, confirming it can never be
    // the mechanism that changes a Pro on a still-confirmed lesson.
    expect(fn).toContain("status             = 'pending'");
  });
});

describe("9b. admin_update_member_lesson's pre-mutation Checkout guard now covers scheduling, member, AND provider changes — the final delta from the 0151 body", () => {
  const GUARD_CONDITION =
    "if v_scheduling_changed\n     or v_member_changed\n     or v_pro_changed\n     or v_price_amount_cents is distinct from v_before.price_amount_cents\n  then";

  const getFn = () => {
    const m = readSource(MIGRATION_PATH);
    const fnStart = m.indexOf("create or replace function public.admin_update_member_lesson(p_request_id uuid, p_expected_club_id uuid,");
    const fnEnd = m.indexOf("$function$;", fnStart) + "$function$;".length;
    return m.slice(fnStart, fnEnd);
  };

  it("1/2/3/4/5. the guard condition includes v_scheduling_changed, v_member_changed, v_pro_changed, AND the price-change check — a pure start/end-time change, a pure court change, a pure Pro change, a Member reassignment, and a price change each independently trigger it", () => {
    const fn = getFn();
    expect(fn).toContain(GUARD_CONDITION);
    // v_scheduling_changed is itself already computed as `(p_court_id,
    // p_starts_at, p_ends_at) is distinct from (...)` — a pure start/end
    // time change and a pure court change both set it true identically;
    // there is no separate court-only vs time-only branch to test
    // independently of this single boolean.
    expect(fn).toContain(
      "v_scheduling_changed := (p_court_id, p_starts_at, p_ends_at)\n    is distinct from (v_old_reservation.court_id, v_old_reservation.starts_at, v_old_reservation.ends_at);",
    );
  });

  it("6. a note-only edit (member_note changes, nothing material) leaves v_scheduling_changed/v_member_changed/v_pro_changed/price all false — the guard condition structurally cannot fire, since p_member_note is not one of its four disjuncts", () => {
    const fn = getFn();
    expect(GUARD_CONDITION).not.toMatch(/member_note/);
    expect(fn).toContain(GUARD_CONDITION);
  });

  it("7. the guard runs AFTER every existing validation (status/optimistic-concurrency/pro/lesson-type/court-conflict/operating-hours/availability) and BEFORE the first mutating UPDATE — an invalid scheduling edit that fails validation never reaches the guard, so it can never expire a valid Checkout Session", () => {
    const fn = getFn();
    const conflictCheckIdx = fn.indexOf("perform public._lesson_check_member_availability(");
    const guardIdx = fn.indexOf(GUARD_CONDITION);
    const reservationUpdateIdx = fn.indexOf("if v_scheduling_changed then");
    expect(conflictCheckIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(conflictCheckIdx);
    expect(guardIdx).toBeLessThan(reservationUpdateIdx);
    // Every raise exception in the validation chain (court_conflict,
    // invalid_duration, court_not_found, etc.) is textually BEFORE the
    // guard — a raised exception aborts the transaction before the guard
    // is ever reached.
    const courtConflictIdx = fn.indexOf("raise exception 'court_conflict';");
    expect(courtConflictIdx).toBeGreaterThan(-1);
    expect(courtConflictIdx).toBeLessThan(guardIdx);
  });

  it("8/9. the guard resolves the payment and calls the SAME _invalidate_or_flag_open_checkout_attempt helper as every other guard in this migration — a bound Session routes through that helper's own existing open_checkout_requires_resolution/remote-resolution path; an unbound attempt is canceled locally by that SAME helper, never a bespoke lesson mechanism", () => {
    const fn = getFn();
    const guardIdx = fn.indexOf(GUARD_CONDITION);
    const guardBlock = fn.slice(guardIdx, fn.indexOf("end if;", guardIdx) + "end if;".length);
    expect(guardBlock).toContain("select id into v_payment_id_for_checkout_guard");
    expect(guardBlock).toContain("perform public._invalidate_or_flag_open_checkout_attempt(v_payment_id_for_checkout_guard)");
  });

  it("the guard still runs in the exact same place — after every existing validation, before the reservation/lesson_requests UPDATEs — unchanged from 0151's own placement", () => {
    const fn = getFn();
    const conflictCheckIdx = fn.indexOf("perform public._lesson_check_member_availability(");
    const guardIdx = fn.indexOf(GUARD_CONDITION);
    const reservationUpdateIdx = fn.indexOf("if v_scheduling_changed then");
    expect(conflictCheckIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(conflictCheckIdx);
    expect(guardIdx).toBeLessThan(reservationUpdateIdx);
  });

  it("every other check, computation, mutation, notification, and audit_log entry is untouched — the pricing invariants (A/B/C rule) are completely separate from and unaffected by this guard: this is NOT a pricing change", () => {
    const fn = getFn();
    // Locked pricing invariants (A/B/C rule) still fully intact — a
    // scheduling-only edit still never reprices.
    expect(fn).toContain("FINAL LESSON PRICING REFINEMENT");
    expect(fn).toContain(
      "--  * lesson_type_id UNCHANGED, duration UNCHANGED (time/court/provider/\n  --    member-only edits): preserve pricing_basis, unit price, and total\n  --    exactly.",
    );
    // Member-reassignment-obligation-abandonment guard still intact.
    expect(fn).toContain("_check_member_reassignment_allowed(v_club_id, 'lesson_request', p_request_id)");
    // Payment wiring after mutation still intact, unchanged.
    expect(fn).toContain("_create_payment_obligation(\n      v_club_id, 'lesson_request', p_request_id, p_roster_member_id,\n      v_price_amount_cents, auth.uid(), true\n    );");
  });

  it("10. remains a pure DOMAIN-plus-obligation-wiring mutation for this guard specifically — the guard call itself never inserts payment_events/refund/waive/void; only the pre-existing (unrelated, unchanged) payment-wiring block below it touches the obligation via the existing _create_payment_obligation/_adjust_payment_obligation helpers", () => {
    const fn = getFn();
    const guardIdx = fn.indexOf(GUARD_CONDITION);
    const guardEndIdx = fn.indexOf("end if;", guardIdx) + "end if;".length;
    const guardBlock = fn.slice(guardIdx, guardEndIdx);
    expect(guardBlock).not.toMatch(/refund|waive|void_payment/i);
    expect(guardBlock).toContain("_invalidate_or_flag_open_checkout_attempt");
  });

  it("11. reservation Checkout remains untouched by this widened guard — update_member_reservation (0151, reservation domain) is a SEPARATE function, not modified by 0159 at all", () => {
    const m = readSource(MIGRATION_PATH);
    expect(m).not.toMatch(/create or replace function public\.update_member_reservation/);
  });

  it("B. adminUpdateMemberLessonAction's EXISTING retry handshake (lessons/actions.ts) already handles this widened guard with ZERO code changes — it matches on the error MESSAGE (open_checkout_requires_resolution) alone, never inspecting WHICH boolean disjunct (scheduling/member/pro/price) caused the RPC to raise it, since _invalidate_or_flag_open_checkout_attempt raises the identical message regardless of cause", () => {
    const s = readSource("src/app/(app)/lessons/actions.ts");
    const fnIdx = s.indexOf("export async function adminUpdateMemberLessonAction(");
    const nextFnIdx = s.indexOf("export async function ", fnIdx + 10);
    const fn = s.slice(fnIdx, nextFnIdx);
    expect(fn).toContain("error?.message.includes(OPEN_CHECKOUT_REQUIRES_RESOLUTION)");
    expect(fn).toContain("resolveBlockingCheckoutBeforeMutation(paymentId, params.expectedClubId)");
    const occurrences = fn.split('supabase.rpc("admin_update_member_lesson"').length - 1;
    expect(occurrences).toBe(2);
    // No new "reason" parameter or scheduling-specific branch was added —
    // this file (actions.ts) is not part of this round's diff at all for
    // this function.
    expect(fn).not.toMatch(/v_scheduling_changed|scheduling_changed_reason/);
  });
});

describe("11. genuine concurrent Stripe success remains represented exactly once across every new/modified RPC in this migration", () => {
  it("none of the new/modified functions in 0159 call process_stripe_payment_event — reconciliation of a real Stripe receipt remains entirely the unchanged webhook's own job, regardless of which side won a lesson_requests row-lock race", () => {
    const m = codeOnly(readSource(MIGRATION_PATH));
    expect(m).not.toMatch(/perform public\.process_stripe_payment_event|select .*process_stripe_payment_event/);
  });

  it("_invalidate_or_flag_open_checkout_attempt (reused unchanged, 0151) only ever acts on a currently-'open' attempt — an attempt the webhook already marked 'completed' during a race is left untouched by every guard in this migration", () => {
    const s = readSource("supabase/migrations/0151_stale_checkout_invalidation.sql");
    const fnStart = s.indexOf("create or replace function public._invalidate_or_flag_open_checkout_attempt(");
    const fnEnd = s.indexOf("revoke all on function public._invalidate_or_flag_open_checkout_attempt(");
    const fn = s.slice(fnStart, fnEnd);
    expect(fn).toContain("and status = 'open'");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Runtime QA (BLOCKER 1) — Pay Now failed at runtime with a generic,
// undiagnosable "Something went wrong". Exhaustive line-by-line comparison
// against the proven reservation implementation found no logic divergence
// (see the extensive coverage above) — the fix this round is targeted,
// sanitized, PRODUCTION-WORTHY server-side observability (mirroring the
// already-established admin/payments/refundActions.ts pattern exactly) so
// the exact failing stage is provable on the next reproduction, rather
// than silently collapsing into an uninformative fallback forever.
// ═══════════════════════════════════════════════════════════════════════════

describe("logUnexpectedLessonCheckoutError — sanitized, production-worthy diagnostic logging mirroring the established refundActions.ts pattern", () => {
  const src = () => readSource(ACTION_PATH);

  it("logs only a request id plus a sanitized code/message — never the full error object, never Stripe/service-role secrets, JWTs, or PII", () => {
    const s = src();
    const fnStart = s.indexOf("function logUnexpectedLessonCheckoutError(");
    const fnEnd = s.indexOf("\n}", fnStart) + 2;
    const fn = s.slice(fnStart, fnEnd);
    // Scope the "never logs the raw error object" check to the actual
    // console.error(...) call body only — the function's own parameter
    // declaration (`err: {...}`) legitimately contains the token "err"
    // and must not trip this check.
    const bodyStart = fn.indexOf("console.error(");
    const body = fn.slice(bodyStart);
    expect(body).toContain("console.error(`[lesson-checkout] ${stage}`");
    expect(body).toContain("request_id: requestId");
    expect(body).toContain("code: err?.code ?? null");
    expect(body).toContain("message: err?.message ?? null");
    // Never the raw error object itself (e.g. `err,` or `...err`) — only
    // its two sanitized fields, individually extracted.
    expect(body).not.toMatch(/[^.?]\berr\b(?!\?\.(?:code|message))/);
    expect(fn).not.toMatch(/STRIPE_SECRET_KEY|SUPABASE_SERVICE_ROLE_KEY|webhook.?secret|access_token|refresh_token/i);
  });

  it("is called at every stage that can otherwise fall through to the unmapped/generic fallback: the atomic opener, the supersede wrapper, the Stripe Session create/retrieve calls, the connected-account retrieve, and the session-binding RPC", () => {
    const s = src();
    expect(s).toMatch(/logUnexpectedLessonCheckoutError\("open_lesson_payment_checkout_attempt"/);
    expect(s).toMatch(/logUnexpectedLessonCheckoutError\("supersede_lesson_checkout_attempt_and_open_fresh"/);
    expect(s).toMatch(/logUnexpectedLessonCheckoutError\("connected_account_retrieve"/);
    expect(s).toMatch(/logUnexpectedLessonCheckoutError\("stale_session_retrieve"/);
    expect(s).toMatch(/logUnexpectedLessonCheckoutError\("stale_session_expire"/);
    expect(s).toMatch(/logUnexpectedLessonCheckoutError\("checkout_session_reuse_retrieve"/);
    expect(s).toMatch(/logUnexpectedLessonCheckoutError\("checkout_session_create"/);
    expect(s).toMatch(/logUnexpectedLessonCheckoutError\("record_checkout_session_created"/);
  });

  it("only logs the open_lesson_payment_checkout_attempt/supersede/record_checkout_session_created results when the error is genuinely UNRECOGNIZED (ERROR_MESSAGES has no entry for the extracted key) — a normal, already-mapped business error (e.g. lesson_not_confirmed) is never logged as if it were unexpected", () => {
    const s = src();
    const openIdx = s.indexOf('const { data: resolvedRows, error: resolveError } = await privileged.rpc("open_lesson_payment_checkout_attempt"');
    const logIdx = s.indexOf('logUnexpectedLessonCheckoutError("open_lesson_payment_checkout_attempt"', openIdx);
    const guardIdx = s.lastIndexOf("if (!ERROR_MESSAGES[key])", logIdx);
    expect(openIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(openIdx);
    expect(guardIdx).toBeLessThan(logIdx);
  });

  it("never changes the Member-facing error message or the underlying RPC/Stripe call sequence — purely additive server-side observability, byte-identical control flow otherwise", () => {
    const s = src();
    // The exact same atomic wrappers and RPC names from the prior round
    // are still used, unchanged.
    expect(s).toContain('privileged.rpc("open_lesson_payment_checkout_attempt"');
    expect(s).toContain('"supersede_lesson_checkout_attempt_and_open_fresh"');
    expect(s).toContain('privileged.rpc("record_checkout_session_created"');
    expect(s).toContain('lesson_not_confirmed: "This lesson is no longer confirmed');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Runtime QA — CONFIRMED root cause: PL/pgSQL column ambiguity (42702,
// "column reference \"status\" is ambiguous") inside the two atomic
// wrappers. Both are RETURNS TABLE functions whose output column names
// (status, id, club_id, ...) collide with bare, unqualified table-column
// references inside their own bodies. Fixed in migration 0160 — a
// targeted CREATE OR REPLACE of exactly these two functions, 0159 itself
// left untouched.
// ═══════════════════════════════════════════════════════════════════════════

describe("0160 — defensive column qualification fix for the confirmed 42702 ambiguity", () => {
  const getFn = (name: string) => {
    const m = readSource(FIX_MIGRATION_PATH);
    const fnStart = m.indexOf(`create or replace function public.${name}(`);
    const fnEnd = m.indexOf(`revoke execute on function public.${name}(`, fnStart);
    expect(fnStart).toBeGreaterThan(-1);
    expect(fnEnd).toBeGreaterThan(fnStart);
    return m.slice(fnStart, fnEnd);
  };

  describe.each([
    ["open_lesson_payment_checkout_attempt"],
    ["supersede_lesson_checkout_attempt_and_open_fresh"],
  ])("%s", (name) => {
    it("1. uses qualified lr.status, never bare status, when reading the lesson_requests row", () => {
      const fn = getFn(name);
      expect(fn).toContain("select lr.status into v_request_status");
      expect(fn).toContain("from public.lesson_requests lr");
      // No bare `select status into` anywhere in this function.
      expect(fn).not.toMatch(/select status into/);
    });

    it("2. uses qualified lr.id / lr.club_id in the lesson_requests WHERE clause, never bare id/club_id", () => {
      const fn = getFn(name);
      expect(fn).toContain("where lr.id = p_request_id and lr.club_id = p_club_id");
      expect(fn).not.toMatch(/where id = p_request_id/);
    });

    it("3. uses qualified p.id, p.club_id, p.domain_type, p.domain_id, p.obligation_cycle when reading the payments row", () => {
      const fn = getFn(name);
      expect(fn).toContain("select p.id into v_payment_id");
      expect(fn).toContain("from public.payments p");
      expect(fn).toContain("where p.club_id = p_club_id and p.domain_type = 'lesson_request' and p.domain_id = p_request_id");
      expect(fn).toContain("order by p.obligation_cycle desc");
      expect(fn).not.toMatch(/select id into v_payment_id/);
    });

    it("4. contains no unsafe bare table-column reference colliding with any RETURNS TABLE output name (action/id/payment_id/club_id/stripe_account_id/livemode/status/created_by/created_at/updated_at) — every from-clause in this function uses a table alias", () => {
      const fn = getFn(name);
      // Both queries against real tables use an alias (lr/p) — the only
      // FROM clauses in this function's own body besides the final
      // delegated function call.
      const fromClauses = fn.match(/from public\.\w+(?:\s+\w+)?/g) ?? [];
      const tableFromClauses = fromClauses.filter(c => !c.includes("open_payment_checkout_attempt") && !c.includes("supersede_checkout_attempt_and_open_fresh"));
      expect(tableFromClauses.length).toBeGreaterThanOrEqual(2);
      for (const clause of tableFromClauses) {
        // "from public.<table> <alias>" — must have a trailing alias token.
        expect(clause).toMatch(/from public\.\w+ \w+/);
      }
    });

    it("5. preserves service_role-only grants, unchanged from 0159", () => {
      const m = readSource(FIX_MIGRATION_PATH);
      const argTypes = name === "open_lesson_payment_checkout_attempt"
        ? "uuid, uuid, text, boolean, uuid"
        : "uuid, uuid, uuid, text, boolean, uuid";
      expect(m).toContain(`revoke execute on function public.${name}(${argTypes}) from public, anon, authenticated;`);
      expect(m).toContain(`grant  execute on function public.${name}(${argTypes}) to service_role;`);
    });

    it("6. still delegates entirely to the existing, unmodified shared Checkout RPC — never duplicates its algorithm", () => {
      const fn = getFn(name);
      const delegateTarget = name === "open_lesson_payment_checkout_attempt"
        ? "public.open_payment_checkout_attempt("
        : "public.supersede_checkout_attempt_and_open_fresh(";
      expect(fn).toContain(`select * from ${delegateTarget}`);
      // No SECOND function declaration nested inside this one's own body
      // (the body is everything after its own opening "as $$").
      const bodyStart = fn.indexOf("as $$");
      const body = fn.slice(bodyStart);
      expect(body).not.toMatch(/create (or replace )?function/i);
    });

    it("preserves the exact same signature, RETURNS TABLE shape, SECURITY DEFINER, search_path, lock ordering (lesson_requests locked before payments), confirmed-only lifecycle check, and raised error names as 0159", () => {
      const fn = getFn(name);
      expect(fn).toContain("security definer");
      expect(fn).toContain("set search_path to 'public', 'pg_temp'");
      expect(fn).toContain("for update");
      expect(fn).toContain("raise exception 'lesson_not_found';");
      expect(fn).toContain("raise exception 'lesson_not_confirmed';");
      expect(fn).toContain("raise exception 'payment_not_found';");
      expect(fn).toContain("raise exception 'invalid_arguments';");
      expect(fn).toContain("if v_request_status <> 'confirmed' then");
      const lockIdx = fn.indexOf("for update");
      const paymentQueryIdx = fn.indexOf("from public.payments p");
      expect(lockIdx).toBeGreaterThan(-1);
      expect(paymentQueryIdx).toBeGreaterThan(lockIdx);
    });
  });

  it("0159 itself is not modified by 0160 — this is a targeted CREATE OR REPLACE layered on top of the already-applied migration", () => {
    const m0159 = readSource(MIGRATION_PATH);
    const m0160 = readSource(FIX_MIGRATION_PATH);
    // 0159's own text is untouched (checked independently elsewhere in
    // this file via the byte-identity assertions for cancel_lesson/
    // propose_lesson_time/admin_update_member_lesson, all still present).
    expect(m0159).toContain("create or replace function public.open_lesson_payment_checkout_attempt(");
    // 0160 contains ONLY the two wrapper functions — no other RPC from
    // 0159 (get_lesson_payment_for_checkout, cancel_lesson,
    // propose_lesson_time, admin_update_member_lesson) is redefined here.
    expect(m0160).not.toMatch(/create or replace function public\.get_lesson_payment_for_checkout/);
    expect(m0160).not.toMatch(/create or replace function public\.cancel_lesson\(/);
    expect(m0160).not.toMatch(/create or replace function public\.propose_lesson_time\(/);
    expect(m0160).not.toMatch(/create or replace function public\.admin_update_member_lesson\(/);
  });

  it("rollback documentation restores the EXACT applied (buggy, ambiguous) 0159 bodies — executable if uncommented, never a placeholder instruction", () => {
    const m = readSource(FIX_MIGRATION_PATH);
    const rollbackIdx = m.indexOf("-- Rollback procedure");
    const rollbackBlock = m.slice(rollbackIdx);
    expect(rollbackBlock).toContain("-- create or replace function public.open_lesson_payment_checkout_attempt(");
    expect(rollbackBlock).toContain("select status into v_request_status");
    expect(rollbackBlock).toContain("from public.lesson_requests");
    expect(rollbackBlock).toMatch(/where id = p_request_id and club_id = p_club_id/);
    expect(rollbackBlock).toContain("-- create or replace function public.supersede_lesson_checkout_attempt_and_open_fresh(");
    expect(rollbackBlock).not.toMatch(/Re-run the full.*body/i);
  });

  it("createLessonCheckoutAction (Server Action) is untouched by this fix — the defect was entirely inside the SQL wrapper bodies, not the calling code", () => {
    const s = readSource(ACTION_PATH);
    expect(s).toContain('privileged.rpc("open_lesson_payment_checkout_attempt"');
    expect(s).toMatch(/logUnexpectedLessonCheckoutError\("open_lesson_payment_checkout_attempt"/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Reservation regressions remain fully green — this file never touches the
// reservation action/migrations, only reads them for comparison.
// ═══════════════════════════════════════════════════════════════════════════

describe("reservation Checkout is untouched by this phase", () => {
  it("reservationCheckoutActions.ts still calls get_reservation_payment_for_checkout and the reservation-specific builders, unchanged", () => {
    const s = readSource(RESERVATION_ACTION_PATH);
    expect(s).toContain('.rpc("get_reservation_payment_for_checkout", {');
    expect(s).toContain("buildReservationCheckoutSessionParams(");
    expect(s).toContain("buildReservationCheckoutReturnUrls(");
    expect(s).toContain("buildReservationCheckoutIdempotencyKey(attempt.id)");
  });
});
