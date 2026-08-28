import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 34D-D1 — regression coverage for reservation Checkout + webhook
// reconciliation, using this repository's established source-inspection
// style (see stripeConnect.regression.test.ts's own header comment for
// why: this test baseline is deliberately pure-TypeScript with no jsdom/
// Supabase/network mocking, so for "does the shipped code actually take
// this shape" questions, reading the real source is a more honest guard
// than reimplementing a parallel mock that could drift).

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// Strips `--`/`//` comment-only lines — used whenever a regex/substring
// search must not be fooled by this migration's own commented-out
// rollback section (which deliberately contains genuinely executable-
// looking SQL, including a second "create or replace function
// public._recompute_payment_rollup" and a second "select * into
// v_attempt", as exact-restoration documentation) or by a file's own
// explanatory prose.
function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !line.trim().startsWith("--") && !line.trim().startsWith("//"))
    .join("\n");
}

const ACTION_PATH  = "src/app/(app)/calendar/reservationCheckoutActions.ts";
const WEBHOOK_PATH = "src/app/api/stripe/payments/events/route.ts";
const MIGRATION_PATH = "supabase/migrations/0150_reservation_checkout_foundation.sql";

// ═══════════════════════════════════════════════════════════════════════════
// Checkout creation
// ═══════════════════════════════════════════════════════════════════════════

describe("createReservationCheckoutAction — server-authoritative, no client-trusted financial value", () => {
  const src = () => readSource(ACTION_PATH);

  it("rejects an unauthenticated caller before touching any financial data", () => {
    const s = src();
    expect(s).toMatch(/const user = await getAuthUser\(\);\s*\n\s*if \(!user\) return \{ error: ERROR_MESSAGES\.not_authenticated \};/);
  });

  it("resolves the payment via the ownership-scoped RPC, never a client-supplied payment_id/club_id", () => {
    const s = src();
    expect(s).toContain('.rpc("get_reservation_payment_for_checkout", {');
    expect(s).toContain("p_reservation_id: reservationId");
    // The ONLY client input is reservationId — payment_id/club_id/amount/
    // currency are read back FROM the RPC's own result (row.*), never
    // accepted as a parameter to this exported action.
    expect(s).not.toMatch(/createReservationCheckoutAction\(\s*[\s\S]{0,80}p_payment_id/);
  });

  it("rejects an obligation not created under court_time_payments — even if the club currently has it enabled", () => {
    const s = src();
    expect(s).toContain('row.payment_mode_at_creation !== "court_time_payments"');
  });

  it("rejects a zero/already-resolved balance via the same status+remaining gate as the RPC", () => {
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

  it("syncs the re-checked status back to club_stripe_accounts via the service-role RPC, matching the account-events webhook's own sync path", () => {
    const s = src();
    expect(s).toContain('.rpc("upsert_club_stripe_account", {');
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

  it("uses a stable, server-derived Stripe idempotency key built from the attempt id — never a browser-supplied key", () => {
    const s = src();
    expect(s).toContain("idempotencyKey: buildReservationCheckoutIdempotencyKey(attempt.id)");
  });

  // Fix 3 (correction round 3) — the return URLs must carry the
  // reservation's own club-local date so a future-date reservation lands
  // on its own /calendar day, not today's default. Derived server-side
  // from the reservation's own starts_at + the club's own timezone —
  // never from a client-supplied value — and passed through the SAME
  // existing ?date= mechanism /calendar's page.tsx already reads.
  it("derives the reservation's club-local date server-side (from reservations.starts_at + clubs.timezone, never client input) and passes it into the return-URL builder", () => {
    const s = src();
    expect(s).toContain('supabase.from("reservations").select("starts_at").eq("id", reservationId).single()');
    expect(s).toContain('supabase.from("clubs").select("timezone").eq("id", row.club_id).single()');
    expect(s).toMatch(/toLocaleDateString\("en-CA",\s*\{\s*\n?\s*timeZone: club\?\.timezone \?\? "America\/New_York",?\s*\n?\s*\}\)/);
    expect(s).toContain("buildReservationCheckoutReturnUrls(SITE_URL, reservationId, reservationDateISO)");
  });

  it("the date derivation happens BEFORE the return URLs are built, and the return URLs are built before the Checkout Session create call", () => {
    const s = src();
    const dateIdx = s.indexOf("const reservationDateISO =");
    const urlsIdx = s.indexOf("buildReservationCheckoutReturnUrls(SITE_URL, reservationId, reservationDateISO)");
    const sessionCreateIdx = s.indexOf("checkout.sessions.create(");
    expect(dateIdx).toBeGreaterThan(-1);
    expect(urlsIdx).toBeGreaterThan(dateIdx);
    expect(sessionCreateIdx).toBeGreaterThan(urlsIdx);
  });

  it("opens the checkout attempt through the service-role-only RPC via the privileged client, never a direct table write", () => {
    const s = src();
    expect(s).toContain('privileged.rpc("open_payment_checkout_attempt"');
    expect(s).not.toMatch(/\.from\(["']payment_checkout_attempts["']\)/);
  });
});

// Finding 1 — the locked "authenticated Member only" invariant, enforced
// with defense in depth: the Server Action's own role check (layer 1) AND
// 0150's get_reservation_payment_for_checkout's own role check (layer 2).
// Before this correction, neither layer verified the caller's CURRENT
// role — only ownership via roster identity — so an Admin/Staff/Pro who
// also holds a roster identity in the club could reach the checkout path.
// These tests would have FAILED against that implementation.
describe("Member-only checkout enforcement (defense in depth)", () => {
  const actionSrc = () => readSource(ACTION_PATH);
  const migration = () => readSource(MIGRATION_PATH);

  it("createReservationCheckoutAction requires the caller's current role to be exactly 'member' before any Stripe/payment-attempt mutation", () => {
    const s = actionSrc();
    const profileCheckIdx = s.indexOf('if (!profile || profile.role !== "member")');
    const stripeContextIdx = s.indexOf("const context = getStripeContext();");
    const attemptRpcIdx = s.indexOf('open_payment_checkout_attempt"');
    expect(profileCheckIdx).toBeGreaterThan(-1);
    expect(stripeContextIdx).toBeGreaterThan(profileCheckIdx);
    expect(attemptRpcIdx).toBeGreaterThan(profileCheckIdx);
  });

  it("getReservationCheckoutEligibilityAction (the Pay Now button's own visibility gate) applies the identical role check, so the button never renders for a non-Member account", () => {
    const s = actionSrc();
    const eligibilityFnIdx = s.indexOf("export async function getReservationCheckoutEligibilityAction");
    const createFnIdx = s.indexOf("export async function createReservationCheckoutAction");
    const eligibilityBody = s.slice(eligibilityFnIdx, createFnIdx);
    expect(eligibilityBody).toContain('if (!profile || profile.role !== "member") return { eligible: false };');
  });

  it("0150's get_reservation_payment_for_checkout independently re-enforces role='member' at the database layer — not merely trusted from the Server Action", () => {
    const m = migration();
    const fnStart = m.indexOf("create or replace function public.get_reservation_payment_for_checkout(");
    const fnEnd = m.indexOf("revoke execute on function public.get_reservation_payment_for_checkout(");
    const fn = m.slice(fnStart, fnEnd);
    expect(fn).toContain("v_role := public.current_user_role();");
    expect(fn).toMatch(/if v_role <> 'member' then\s*\n\s*raise exception 'insufficient_role';/);
  });

  it("the database-layer role check runs BEFORE the roster-identity ownership check, so a non-Member is rejected regardless of whether they also hold a roster identity", () => {
    const m = migration();
    const fnStart = m.indexOf("create or replace function public.get_reservation_payment_for_checkout(");
    const fn = m.slice(fnStart);
    const roleCheckIdx = fn.indexOf("raise exception 'insufficient_role';");
    const rosterCheckIdx = fn.indexOf("current_user_roster_member_id();");
    expect(roleCheckIdx).toBeGreaterThan(-1);
    expect(rosterCheckIdx).toBeGreaterThan(roleCheckIdx);
  });
});

// Finding 3 — Checkout Session binding must be durable BEFORE the Member
// is ever redirected to Stripe. Before this correction, this was
// documented as "best-effort" and the Server Action returned session.url
// unconditionally, even if the binding RPC silently affected zero rows.
// These tests would have FAILED against that implementation.
describe("Durable Checkout Session binding before redirect (never best-effort)", () => {
  const actionSrc = () => readSource(ACTION_PATH);
  const migration = () => readSource(MIGRATION_PATH);

  it("the session-binding step itself is never described as an optional/best-effort store — it is documented as REQUIRED", () => {
    const s = actionSrc();
    expect(s).not.toMatch(/Best-effort store/i);
    expect(s).toMatch(/REQUIRED, not best-effort/);
  });

  it("createReservationCheckoutAction inspects record_checkout_session_created's own error and returns an error (never the checkout URL) when binding fails", () => {
    const s = actionSrc();
    expect(s).toMatch(
      /const \{ error: bindError \} = await privileged\.rpc\("record_checkout_session_created"/,
    );
    const bindBlock = s.slice(s.indexOf('const { error: bindError }'), s.indexOf("return { url: session.url };"));
    expect(bindBlock).toContain("if (bindError)");
    expect(bindBlock).toContain("return { error:");
    // The url return must be textually AFTER the bindError check — a
    // failed binding can never fall through to it.
    const bindErrorCheckIdx = s.indexOf("if (bindError)");
    const urlReturnIdx = s.indexOf("return { url: session.url };");
    expect(urlReturnIdx).toBeGreaterThan(bindErrorCheckIdx);
  });

  it("record_checkout_session_created fails loudly (raises) rather than silently affecting zero rows: unknown attempt and a conflicting different Session id both raise", () => {
    const m = migration();
    const fnStart = m.indexOf("create or replace function public.record_checkout_session_created(");
    const fnEnd = m.indexOf("revoke execute on function public.record_checkout_session_created(");
    const fn = m.slice(fnStart, fnEnd);
    expect(fn).toContain("raise exception 'checkout_attempt_not_found';");
    expect(fn).toMatch(
      /if v_attempt\.stripe_checkout_session_id is not null\s*\n\s*and v_attempt\.stripe_checkout_session_id <> p_stripe_checkout_session_id then\s*\n\s*raise exception 'checkout_session_mismatch';/,
    );
  });

  // Correction round 2 — session binding requires the attempt to be
  // 'open'. This test would have FAILED against the round-1-corrected
  // implementation, which only checked not-found and session-id mismatch,
  // never the attempt's own status — allowing a canceled/expired/
  // completed attempt to be (re)bound to a Session.
  it("record_checkout_session_created rejects a canceled, expired, or completed attempt with checkout_attempt_not_open — binding is only ever allowed onto a genuinely OPEN attempt", () => {
    const m = migration();
    const fnStart = m.indexOf("create or replace function public.record_checkout_session_created(");
    const fnEnd = m.indexOf("revoke execute on function public.record_checkout_session_created(");
    const fn = m.slice(fnStart, fnEnd);
    expect(fn).toMatch(/if v_attempt\.status <> 'open' then\s*\n\s*raise exception 'checkout_attempt_not_open';/);
    // status in ('open','completed','expired','canceled') — the check
    // above rejects every value except 'open', not merely 'completed'.
    expect(fn).not.toMatch(/status\s*=\s*'completed'/);
    expect(fn).not.toMatch(/status\s*=\s*'expired'/);
    expect(fn).not.toMatch(/status\s*=\s*'canceled'/);
  });

  it("the status check runs BEFORE the not-found check is satisfied but AFTER it in program order (not-found first, then not-open, then session-id mismatch) — the not-found path never falls through to a status check on a nonexistent row", () => {
    const m = migration();
    const fnStart = m.indexOf("create or replace function public.record_checkout_session_created(");
    const fnEnd = m.indexOf("revoke execute on function public.record_checkout_session_created(");
    const fn = m.slice(fnStart, fnEnd);
    const notFoundIdx = fn.indexOf("raise exception 'checkout_attempt_not_found';");
    const notOpenIdx = fn.indexOf("raise exception 'checkout_attempt_not_open';");
    const mismatchIdx = fn.indexOf("raise exception 'checkout_session_mismatch';");
    expect(notFoundIdx).toBeGreaterThan(-1);
    expect(notOpenIdx).toBeGreaterThan(notFoundIdx);
    expect(mismatchIdx).toBeGreaterThan(notOpenIdx);
  });

  it("record_checkout_session_created's UPDATE has no permissive WHERE clause that could silently affect zero rows without the caller knowing — it runs only after the not-found/not-open/mismatch checks already passed", () => {
    const m = migration();
    const fnStart = m.indexOf("create or replace function public.record_checkout_session_created(");
    const fnEnd = m.indexOf("revoke execute on function public.record_checkout_session_created(");
    const fn = m.slice(fnStart, fnEnd);
    const mismatchCheckIdx = fn.indexOf("raise exception 'checkout_session_mismatch';");
    const updateIdx = fn.indexOf("update public.payment_checkout_attempts");
    expect(mismatchCheckIdx).toBeGreaterThan(-1);
    expect(updateIdx).toBeGreaterThan(mismatchCheckIdx);
    // The old, corrected shape guarded the UPDATE's own WHERE clause with
    // `stripe_checkout_session_id is null or ... = p_stripe_checkout_session_id`
    // instead of raising — that permissive-WHERE shape must be gone.
    expect(fn).not.toMatch(/and \(stripe_checkout_session_id is null or stripe_checkout_session_id = p_stripe_checkout_session_id\)/);
  });

  it("createReservationCheckoutAction maps checkout_attempt_not_open to an error and never returns the checkout URL in that case", () => {
    const s = actionSrc();
    expect(s).toMatch(/checkout_attempt_not_found\|checkout_attempt_not_open\|checkout_session_mismatch/);
    expect(s).toContain("checkout_attempt_not_open:");
  });

  it("re-running the create-Session call for the SAME attempt is still safe: the idempotency key is derived from the attempt id, which record_checkout_session_created's own not-found/mismatch checks do not invalidate for a genuine retry", () => {
    const s = actionSrc();
    expect(s).toContain("idempotencyKey: buildReservationCheckoutIdempotencyKey(attempt.id)");
    // Same attempt id in, same idempotency key out — deterministic by
    // construction (see paymentsConfig.test.ts for the direct unit test
    // of buildReservationCheckoutIdempotencyKey's own determinism).
  });
});

describe("Attempt safety — double-click / retry cannot create unsafe competing sessions", () => {
  const src = () => readSource(ACTION_PATH);
  const migration = () => readSource(MIGRATION_PATH);

  function openAttemptBody(): string {
    const m = migration();
    const start = m.indexOf("create or replace function public.open_payment_checkout_attempt(");
    const end = m.indexOf("revoke execute on function public.open_payment_checkout_attempt(");
    return m.slice(start, end);
  }

  it("the Server Action always calls open_payment_checkout_attempt before creating/reusing a Session — never creates a Session against a payment_id directly", () => {
    const s = src();
    const attemptIdx = s.indexOf('open_payment_checkout_attempt"');
    const sessionCreateIdx = s.indexOf("checkout.sessions.create(");
    const sessionRetrieveIdx = s.indexOf("checkout.sessions.retrieve(");
    expect(attemptIdx).toBeGreaterThan(-1);
    expect(sessionCreateIdx).toBeGreaterThan(attemptIdx);
    expect(sessionRetrieveIdx).toBeGreaterThan(attemptIdx);
  });

  it("0150 enforces at most one OPEN attempt per payment via a hard DB partial unique index", () => {
    const m = migration();
    expect(m).toContain("create unique index payment_checkout_attempts_one_open_per_payment");
    expect(m).toMatch(/on public\.payment_checkout_attempts \(payment_id\)\s*\n\s*where status = 'open';/);
  });

  // Finding 2 (round 3) — reuse must match ALL of amount, currency,
  // connected Stripe account, AND livemode. This regex would have FAILED
  // to match the pre-correction condition (which had no stripe_account_id/
  // livemode comparison at all).
  it("open_payment_checkout_attempt reuses an existing OPEN attempt only when amount, currency, stripe_account_id, AND livemode ALL match — freshness now checked via Stripe's OWN reported expiration, never a local 23h heuristic", () => {
    const fn = openAttemptBody();
    expect(fn).toMatch(
      /if v_existing\.amount_expected_cents = v_remaining\s*\n\s*and v_existing\.currency_expected = v_payment\.currency\s*\n\s*and v_existing\.stripe_account_id = p_stripe_account_id\s*\n\s*and v_existing\.livemode = p_livemode\s*\n\s*and \(v_existing\.stripe_session_expires_at is null or v_existing\.stripe_session_expires_at > now\(\)\) then/,
    );
    // The old arbitrary local freshness heuristic must be gone.
    expect(fn).not.toMatch(/created_at > now\(\) - interval '23 hours'/);
  });

  // Section 3 (round 4) — the database cannot call Stripe, so it must
  // never unilaterally supersede an attempt that already has a bound
  // remote Session (that Session's own URL stays genuinely payable
  // regardless of any LOCAL status change). This is the core of the
  // "never two simultaneously payable Sessions" invariant.
  it("a stale OPEN attempt with NO bound Session is safely superseded locally, in the SAME transaction, action='ready'", () => {
    const fn = openAttemptBody();
    expect(fn).toMatch(
      /if v_existing\.stripe_checkout_session_id is null then[\s\S]{0,300}update public\.payment_checkout_attempts a\s*\n\s*set status = 'canceled', updated_at = now\(\)\s*\n\s*where a\.id = v_existing\.id;/,
    );
  });

  it("a stale OPEN attempt WITH a bound Session is never locally superseded by this function — it returns action='must_expire_remote' and mutates nothing", () => {
    const fn = openAttemptBody();
    const elseIdx = fn.indexOf("else\n      if v_existing.livemode <> p_livemode then");
    const returnIdx = fn.indexOf("return;\n    end if;\n  end if;");
    expect(elseIdx).toBeGreaterThan(-1);
    expect(returnIdx).toBeGreaterThan(elseIdx);
    const elseBlock = fn.slice(elseIdx, returnIdx);
    expect(elseBlock).toContain("'must_expire_remote'::text");
    // No UPDATE/INSERT anywhere in this branch — nothing is mutated.
    expect(elseBlock).not.toMatch(/update public\.payment_checkout_attempts/);
    expect(elseBlock).not.toMatch(/insert into public\.payment_checkout_attempts/);
  });

  it("fails closed (raises, never returns must_expire_remote) when the stale bound attempt's own livemode differs from the current one — that Session cannot be safely addressed by the current Stripe API key at all", () => {
    const fn = openAttemptBody();
    expect(fn).toMatch(
      /if v_existing\.livemode <> p_livemode then\s*\n\s*raise exception 'stale_attempt_environment_mismatch';/,
    );
  });

  it("open_payment_checkout_attempt returns an action discriminator ('ready' | 'must_expire_remote'), never a bare row — the caller cannot mistake a deferred resolution for a usable attempt", () => {
    const fn = openAttemptBody();
    expect(fn).toContain("returns table (\n  action");
    expect(countOccurrences(fn, "'ready'::text")).toBeGreaterThanOrEqual(2);
    expect(fn).toContain("'must_expire_remote'::text");
  });

  it("superseding a stale unbound attempt never mutates its own stored stripe_account_id/livemode/amount/currency — only status/updated_at change", () => {
    const fn = openAttemptBody();
    const supersedeBlock = fn.slice(
      fn.indexOf("update public.payment_checkout_attempts a\n         set status = 'canceled'"),
      fn.indexOf("-- Falls through"),
    );
    expect(supersedeBlock).not.toMatch(/stripe_account_id\s*=/);
    expect(supersedeBlock).not.toMatch(/livemode\s*=/);
    expect(supersedeBlock).not.toMatch(/amount_expected_cents\s*=/);
    expect(supersedeBlock).not.toMatch(/currency_expected\s*=/);
  });

  it("the fresh INSERT always carries the CURRENT p_stripe_account_id/p_livemode parameters, never a stale value — a test-mode-to-live-mode transition always produces a correctly-tagged fresh attempt", () => {
    const fn = openAttemptBody();
    const insertBlock = fn.slice(fn.indexOf("insert into public.payment_checkout_attempts ("), fn.indexOf("returning * into v_result;"));
    expect(insertBlock).toContain("p_payment_id, p_club_id, p_stripe_account_id, p_livemode,");
  });

  it("re-derives amount/eligibility fresh under a row lock inside the RPC, not from a caller-supplied amount parameter (closes the TOCTOU window)", () => {
    const fn = openAttemptBody();
    expect(fn).not.toMatch(/open_payment_checkout_attempt\(\s*\n\s*p_payment_id\s+uuid,[\s\S]{0,80}p_amount/);
    expect(fn).toContain("where p.id = p_payment_id and p.club_id = p_club_id\n   for update;");
  });

  it("createReservationCheckoutAction orchestrates the required Stripe round-trip for must_expire_remote: retrieve in the STALE attempt's own account context, stop if already complete, expire if still open, then supersede", () => {
    const s = src();
    const branchStart = s.indexOf('if (attempt.action === "must_expire_remote")');
    const branchEnd = s.indexOf("Server-derived club-local calendar date");
    const branch = s.slice(branchStart, branchEnd);
    expect(branch).toContain("checkout.sessions.retrieve(\n        attempt.stripe_checkout_session_id,");
    expect(branch).toContain("{ stripeAccount: attempt.stripe_account_id }");
    expect(branch).toMatch(/staleSession\.status === "complete"/);
    expect(branch).toContain("ERROR_MESSAGES.payment_processing");
    expect(branch).toMatch(/staleSession\.status === "open"/);
    expect(branch).toContain("checkout.sessions.expire(");
    expect(branch).toContain('.rpc(\n      "supersede_checkout_attempt_and_open_fresh"');
  });

  it("never creates a replacement Session when the old Session cannot be safely retrieved/expired — both Stripe calls fail closed on error, without ever reaching supersede_checkout_attempt_and_open_fresh", () => {
    const s = src();
    const branchStart = s.indexOf('if (attempt.action === "must_expire_remote")');
    const branchEnd = s.indexOf('.rpc(\n      "supersede_checkout_attempt_and_open_fresh"');
    const preSupersedeBlock = s.slice(branchStart, branchEnd);
    // Both the retrieve and expire calls are wrapped in their own
    // try/catch that returns an error rather than falling through.
    expect(countOccurrences(preSupersedeBlock, "catch {")).toBeGreaterThanOrEqual(2);
    expect(preSupersedeBlock).toContain("return { error: ERROR_MESSAGES.stripe_error };");
  });

  it("never creates a replacement when supersede_checkout_attempt_and_open_fresh reports the stale attempt was already completed (e.g. by the webhook) during the Stripe round-trip", () => {
    const s = src();
    expect(s).toMatch(/superseded\.action === "already_completed"/);
    const idx = s.indexOf('superseded.action === "already_completed"');
    const block = s.slice(idx, idx + 300);
    expect(block).toContain("ERROR_MESSAGES.payment_processing");
  });

  it("reuse of an already-bound attempt goes through Stripe retrieve(), never a fresh create() call — avoids a Stripe idempotency-key parameter mismatch now that expires_at is a moving value", () => {
    const s = src();
    expect(s).toMatch(/if \(attempt\.stripe_checkout_session_id\) \{[\s\S]{0,500}checkout\.sessions\.retrieve\(/);
  });

  it("a reused Session that Stripe no longer reports as open fails closed rather than serving a dead link", () => {
    const s = src();
    expect(s).toMatch(/if \(session\.status !== "open"\) \{\s*\n[\s\S]{0,300}return \{ error: ERROR_MESSAGES\.stripe_error \};/);
  });

  it("a genuinely fresh attempt (no bound Session) uses a deliberately short, explicit Session lifetime derived from the attempt's own created_at — never Stripe's 24h default, never Date.now() alone (which would be non-deterministic across a concurrent double-click)", () => {
    const s = src();
    expect(s).toContain("expiresAt: computeReservationCheckoutExpiresAt(attempt.created_at)");
  });

  it("the Session's own Stripe-reported expiration is stored on the attempt via record_checkout_session_created after every genuine create — never left null for a bound Session", () => {
    const s = src();
    expect(s).toContain("p_stripe_session_expires_at: new Date(session.expires_at * 1000).toISOString()");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Webhook
// ═══════════════════════════════════════════════════════════════════════════

describe("payments/events webhook route — signature verification and shape", () => {
  const src = () => readSource(WEBHOOK_PATH);

  it("requires the Stripe-Signature header before doing anything else", () => {
    const s = src();
    expect(s).toMatch(/headers\.get\(["']stripe-signature["']\)/);
    expect(s).toMatch(/if \(!signature\)/);
  });

  it("returns 400 for a missing signature", () => {
    const s = src();
    const block = s.slice(s.indexOf("if (!signature)"), s.indexOf("if (!signature)") + 80);
    expect(block).toContain("status: 400");
  });

  it("reads the raw body via request.text(), never request.json() first", () => {
    const s = src();
    expect(s).toContain("await request.text()");
    expect(s).not.toMatch(/[^/]\s*await request\.json\(\)|=\s*request\.json\(\)/);
  });

  it("verifies via the classic v1 stripe.webhooks.constructEvent — never the Accounts v2 thin-event parser", () => {
    const s = src();
    expect(s).toContain("context.client.webhooks.constructEvent(rawBody, signature, webhookSecret)");
    // Matches actual code usage (a call), not this file's own header
    // comment contrasting it with the Connect lifecycle route's approach.
    expect(s).not.toMatch(/\.parseEventNotification\(/);
    expect(s).not.toMatch(/\.fetchEvent\(\)/);
  });

  it("returns 400 on a signature-verification failure, never trusting the body", () => {
    const s = src();
    const tryBlock = s.slice(s.indexOf("try {\n    event ="), s.indexOf("try {\n    event =") + 300);
    expect(tryBlock).toContain("catch");
    expect(tryBlock).toContain("status: 400");
  });

  it("uses a SEPARATE env-configured secret (STRIPE_PAYMENTS_WEBHOOK_SECRET), never the Connect account-events secret", () => {
    const s = src();
    expect(s).toContain("process.env.STRIPE_PAYMENTS_WEBHOOK_SECRET");
    expect(s).not.toMatch(/STRIPE_CONNECT_ACCOUNT_WEBHOOK_SECRET/);
  });

  it("safely no-ops (200) on any event type other than checkout.session.completed", () => {
    const s = src();
    expect(s).toContain("isSupportedPaymentWebhookEventType(event.type)");
    const usageIdx = s.indexOf("isSupportedPaymentWebhookEventType(event.type)");
    const block = s.slice(usageIdx, usageIdx + 200);
    expect(block).toContain("status: 200");
  });

  it("only acts when the verified Session's own mode is payment and payment_status is paid — never trusts the event type alone", () => {
    const s = src();
    expect(s).toContain('session.mode !== "payment"');
    expect(s).toContain('session.payment_status !== "paid"');
  });

  it("reads the connected account from the verified event's own `account` field, never from metadata", () => {
    const s = src();
    expect(s).toContain("const stripeAccountId = event.account;");
    expect(s).not.toMatch(/session\.metadata\?\.\s*\[?["']?stripe_account/);
  });

  it("passes event.livemode (from the verified event) into the RPC — never a client/query-supplied value", () => {
    const s = src();
    expect(s).toContain("p_livemode: event.livemode");
    expect(s).not.toMatch(/searchParams/);
  });

  it("persists through the narrow service-role RPC boundary, not a direct table write", () => {
    const s = src();
    expect(s).toContain('.rpc("process_stripe_payment_event"');
    expect(s).not.toMatch(/\.from\(["']payment_checkout_attempts["']\)/);
    expect(s).not.toMatch(/\.from\(["']payment_events["']\)/);
    expect(s).not.toMatch(/\.from\(["']stripe_event_receipts["']\)/);
  });

  it("fails closed (500) when its own webhook secret or Stripe key is unconfigured", () => {
    const s = src();
    expect(s).toMatch(/if \(!webhookSecret\)/);
    expect(s).toMatch(/if \(!context\)/);
  });

  it("never creates a PaymentIntent, Checkout Session, charge, or application fee — this route only ever reads/verifies inbound events", () => {
    const s = src();
    expect(s).not.toMatch(/\.create\(/);
    expect(s).not.toMatch(/application_fee/);
  });

  // Correction round 2 — a null PaymentIntent must NEVER short-circuit
  // reconciliation. This test would have FAILED against the previous
  // implementation, which returned a 200 no-op before ever reaching the
  // RPC when paymentIntentId was null (an incorrect assumption: Stripe
  // documents Checkout Session.payment_intent as nullable even for a paid
  // mode=payment Session).
  it("a null PaymentIntent does NOT short-circuit before the reconciliation RPC — session.id, not payment_intent, is the required reconciliation identity", () => {
    // Scoped to the main POST handler (checkout.session.completed path)
    // only — Phase 34E-C's handleDisputeEvent, further down this same
    // file, legitimately has its own unrelated `if (!paymentIntentId)`
    // (its Charge-retrieve fallback) and must not be scanned here.
    const full = src();
    const handlerEndIdx = full.indexOf("async function handleRefundEvent");
    expect(handlerEndIdx).toBeGreaterThan(0);
    const s = full.slice(0, handlerEndIdx);
    expect(s).not.toMatch(/if \(!paymentIntentId\)/);
    // paymentIntentId (possibly null) is passed straight through — the
    // route itself never gates on its presence.
    const rpcCallIdx = s.indexOf('.rpc("process_stripe_payment_event"');
    const paymentIntentIdDeclIdx = s.indexOf("const paymentIntentId =");
    expect(paymentIntentIdDeclIdx).toBeGreaterThan(-1);
    expect(rpcCallIdx).toBeGreaterThan(paymentIntentIdDeclIdx);
    expect(s).toContain("p_stripe_payment_intent_id: paymentIntentId,");
  });

  // Section 5 (round 4) correction — a verified, supported, connected-
  // account, mode=payment, payment_status=paid event missing its own
  // amount_total/currency must fail RETRYABLY (500), never silently no-op
  // (200), which would tell Stripe delivery succeeded while Court Time
  // recorded nothing for a real payment. This test would have FAILED
  // against the previous implementation (200 for this exact case).
  it("a genuinely paid, connected-account event missing amount_total/currency fails retryably (500), never a silent 200 no-op", () => {
    const s = src();
    const idx = s.indexOf("if (session.amount_total === null || session.currency === null)");
    expect(idx).toBeGreaterThan(-1);
    const block = s.slice(idx, idx + 700);
    expect(block).toContain("status: 500");
    expect(block).not.toContain("status: 200");
  });

  it("every OTHER legitimate-skip check (unsupported type, non-payment mode, unpaid Session, no connected account) still returns 200, unaffected by the Section 5 correction", () => {
    const s = src();
    // isSupportedPaymentWebhookEventType / mode / payment_status / event.account
    // checks all still resolve to 200 — only the missing-financial-data
    // check (already verified above) was changed to 500.
    const twoHundredCount = countOccurrences(s, "status: 200");
    expect(twoHundredCount).toBeGreaterThanOrEqual(4);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Webhook reconciliation invariants (0150's process_stripe_payment_event)
// ═══════════════════════════════════════════════════════════════════════════

describe("0150 migration — atomic, exactly-once payment reconciliation invariants", () => {
  const migration = () => readSource(MIGRATION_PATH);

  // process_stripe_payment_event's OWN function body, isolated from the
  // rest of the file — record_checkout_session_created (section 6a, which
  // appears earlier in the file) also declares a local `v_attempt` and
  // also raises 'checkout_attempt_not_found' for its own, different
  // reason, so an unscoped whole-file search for those strings would
  // false-positive-match the wrong function. Scoping to this function's
  // own body is what makes every ordering assertion below trustworthy.
  function processStripePaymentEventBody(): string {
    const m = migration();
    const start = m.indexOf("create or replace function public.process_stripe_payment_event(");
    const end = m.indexOf(
      "revoke execute on function public.process_stripe_payment_event(",
    );
    return m.slice(start, end);
  }

  it("exists as its own migration and does not redefine update_club_payment_mode or activate_court_time_payments (0149, untouched)", () => {
    const m = migration();
    expect(() => migration()).not.toThrow();
    expect(m).not.toMatch(/create (or replace )?function public\.update_club_payment_mode/);
    expect(m).not.toMatch(/create (or replace )?function public\.activate_court_time_payments/);
  });

  it("dedupes via the SAME stripe_event_receipts table 0148 established — no second/competing receipt table is created", () => {
    const m = migration();
    expect(m).not.toMatch(/create table public\.stripe_event_receipts/);
    expect(m).not.toMatch(/create table public\.\w*event_receipt/i);
    expect(m).toContain("insert into public.stripe_event_receipts (");
    expect(m).toContain("on conflict (stripe_event_id) do nothing;");
  });

  it("a duplicate Stripe event id returns already_processed=true and never re-runs the ledger insert", () => {
    const fn = processStripePaymentEventBody();
    const notNewBlock = fn.slice(fn.indexOf("if not v_new_receipt then"), fn.indexOf("select * into v_attempt"));
    expect(notNewBlock).toContain("return query select true, true;");
    expect(notNewBlock).toContain("return;");
  });

  it("validates the connected account, livemode, currency, and amount against the immutable stored attempt — every mismatch raises (retryable), never silently accepted", () => {
    const fn = processStripePaymentEventBody();
    expect(fn).toContain("if v_attempt.stripe_account_id <> p_stripe_account_id then");
    expect(fn).toContain("raise exception 'stripe_account_mismatch';");
    expect(fn).toContain("if v_attempt.livemode <> p_livemode then");
    expect(fn).toContain("raise exception 'livemode_mismatch';");
    expect(fn).toContain("if v_attempt.currency_expected <> upper(p_currency) then");
    expect(fn).toContain("raise exception 'currency_mismatch';");
    expect(fn).toContain("if v_attempt.amount_expected_cents <> p_amount_total_cents then");
    expect(fn).toContain("raise exception 'amount_mismatch';");
  });

  it("an unknown Checkout Session (no matching attempt) raises retryably rather than silently dropping a valid payment", () => {
    const fn = processStripePaymentEventBody();
    expect(fn).toContain("raise exception 'checkout_attempt_not_found';");
  });

  it("every mismatch/not-found raise happens AFTER the event-receipt INSERT, in the same function call, so Postgres rolls the receipt back too (fail-retryable, never permanently recorded)", () => {
    const fn = processStripePaymentEventBody();
    const insertIndex = fn.indexOf("insert into public.stripe_event_receipts");
    const notFoundIndex = fn.indexOf("raise exception 'checkout_attempt_not_found';");
    const mismatchIndex = fn.indexOf("raise exception 'stripe_account_mismatch';");
    const amountIndex = fn.indexOf("raise exception 'amount_mismatch';");
    expect(insertIndex).toBeGreaterThan(-1);
    expect(notFoundIndex).toBeGreaterThan(insertIndex);
    expect(mismatchIndex).toBeGreaterThan(insertIndex);
    expect(amountIndex).toBeGreaterThan(insertIndex);
  });

  // Finding 4 — the corrected ordering. Before this correction, "if
  // v_attempt.status = 'completed' then ... return" appeared BEFORE the
  // account/livemode/currency/amount mismatch checks, which would let a
  // second, genuinely mismatched event for an already-completed attempt
  // short-circuit as a safe no-op without ever proving it describes the
  // SAME payment. This test would have FAILED against that ordering.
  it("the completed-attempt no-op check runs AFTER immutable identity validation (account/livemode/currency/amount), never before", () => {
    const fn = processStripePaymentEventBody();
    const accountCheckIdx = fn.indexOf("if v_attempt.stripe_account_id <> p_stripe_account_id then");
    const livemodeCheckIdx = fn.indexOf("if v_attempt.livemode <> p_livemode then");
    const currencyCheckIdx = fn.indexOf("if v_attempt.currency_expected <> upper(p_currency) then");
    const amountCheckIdx = fn.indexOf("if v_attempt.amount_expected_cents <> p_amount_total_cents then");
    const completedCheckIdx = fn.indexOf("if v_attempt.status = 'completed' then");
    expect(accountCheckIdx).toBeGreaterThan(-1);
    expect(completedCheckIdx).toBeGreaterThan(accountCheckIdx);
    expect(completedCheckIdx).toBeGreaterThan(livemodeCheckIdx);
    expect(completedCheckIdx).toBeGreaterThan(currencyCheckIdx);
    expect(completedCheckIdx).toBeGreaterThan(amountCheckIdx);
  });

  // Correction round 2 — PaymentIntent must stay nullable. These tests
  // would have FAILED against the previous (round-1-corrected)
  // implementation, which required p_stripe_payment_intent_id non-null
  // and would have rejected a genuinely paid, signed Checkout Session
  // that Stripe simply never attached a PaymentIntent to.

  it("does NOT require a non-null PaymentIntent id — arg validation never checks p_stripe_payment_intent_id for null", () => {
    const fn = processStripePaymentEventBody();
    const argCheck = fn.slice(0, fn.indexOf("raise exception 'invalid_arguments';"));
    expect(argCheck).not.toContain("p_stripe_payment_intent_id is null");
    // Session id remains required — the real reconciliation identity.
    expect(argCheck).toContain("p_stripe_checkout_session_id is null");
  });

  it("a completed attempt only raises payment_intent_mismatch when BOTH the stored and incoming PaymentIntent ids are non-null and differ — a null on either side is never treated as a conflict", () => {
    const fn = processStripePaymentEventBody();
    const completedBlock = fn.slice(
      fn.indexOf("if v_attempt.status = 'completed' then"),
      fn.indexOf("if v_payment.payment_mode_at_creation"),
    );
    expect(completedBlock).toMatch(
      /if v_attempt\.stripe_payment_intent_id is not null\s*\n\s*and p_stripe_payment_intent_id is not null\s*\n\s*and v_attempt\.stripe_payment_intent_id <> p_stripe_payment_intent_id then/,
    );
    expect(completedBlock).toContain("raise exception 'payment_intent_mismatch';");
    expect(completedBlock).toContain("return query select true, true;");
  });

  it("a completed attempt with a previously-null stored PaymentIntent populates it from a later non-null incoming id, without a second ledger insert", () => {
    const fn = processStripePaymentEventBody();
    const completedBlock = fn.slice(
      fn.indexOf("if v_attempt.status = 'completed' then"),
      fn.indexOf("if v_payment.payment_mode_at_creation"),
    );
    expect(completedBlock).toMatch(
      /if v_attempt\.stripe_payment_intent_id is null and p_stripe_payment_intent_id is not null then\s*\n\s*update public\.payment_checkout_attempts/,
    );
    // No payment_events insert anywhere inside the completed-attempt
    // branch — populating the PaymentIntent id never creates a second
    // ledger credit for the same attempt.
    expect(completedBlock).not.toMatch(/insert into public\.payment_events/);
  });

  it("the successful (not-yet-completed) reconciliation path stores external_reference as the Checkout SESSION id, never the PaymentIntent id — the Session id is always non-null, the PaymentIntent id is not", () => {
    const fn = processStripePaymentEventBody();
    const insertIdx = fn.indexOf("insert into public.payment_events (");
    const insertBlock = fn.slice(insertIdx, insertIdx + 300);
    expect(insertBlock).toContain(
      "v_attempt.payment_id, v_attempt.club_id, 'online_payment_recorded',\n    p_amount_total_cents, p_stripe_checkout_session_id, null",
    );
    expect(insertBlock).not.toMatch(/p_amount_total_cents,\s*p_stripe_payment_intent_id/);
  });

  it("a genuinely paid Session with a null PaymentIntent still reaches and completes reconciliation — never rejected merely for lacking one", () => {
    const fn = processStripePaymentEventBody();
    // The only checks against p_stripe_payment_intent_id anywhere in this
    // function are (a) arg validation, which no longer checks it (tested
    // above), and (b) inside the already-completed branch (conflict/
    // populate logic, tested above) — there is no standalone gate on the
    // normal, first-time reconciliation path (after the completed-attempt
    // branch, before the final success return) that rejects a null value.
    const normalPathBlock = fn.slice(
      fn.indexOf("if v_payment.payment_mode_at_creation"),
      fn.indexOf("return query select false, true;"),
    );
    expect(normalPathBlock).not.toMatch(/p_stripe_payment_intent_id is null/);
    // The one raise remaining in this block (not_online_payable, defense
    // in depth on the immutable payment_mode_at_creation) is unrelated to
    // PaymentIntent presence — status is no longer checked at all here
    // (Section 1's own correction, tested separately above).
    expect(countOccurrences(normalPathBlock, "raise exception")).toBe(1);
    expect(normalPathBlock).toContain("raise exception 'not_online_payable';");
  });

  // Section 1 (round 4) correction — Stripe payment is financial truth
  // once paid. Before this correction, reconciliation raised
  // payment_not_open_for_online_payment whenever the local payment's
  // CURRENT status was no longer unpaid/partially_paid — meaning a
  // concurrent manual payment, price change, waiver, or void that
  // happened locally after the Checkout Session was created would cause
  // Court Time to permanently reject (via endless retry) money Stripe had
  // actually collected. This test would have FAILED against that
  // implementation.
  it("does NOT gate reconciliation on the local payment's current status — Stripe's own report of paid money is recorded regardless of what happened locally since the Session was created", () => {
    const fn = processStripePaymentEventBody();
    expect(fn).not.toMatch(/v_payment\.status not in \(/);
    expect(fn).not.toContain("raise exception 'payment_not_open_for_online_payment';");
    expect(fn).toMatch(/Deliberately NOT gated on v_payment\.status/);
  });

  it("still re-validates payment_mode_at_creation (defense in depth) and that the payment row itself still exists, even though status is no longer checked", () => {
    const fn = processStripePaymentEventBody();
    expect(fn).toMatch(
      /if v_payment\.payment_mode_at_creation <> 'court_time_payments' then\s*\n\s*raise exception 'not_online_payable';/,
    );
    expect(fn).toContain("raise exception 'payment_not_found';");
  });

  it("the attempt update and the ledger insert happen in the same function call as the receipt insert — one atomic commit, never partially applied", () => {
    const fn = processStripePaymentEventBody();
    const attemptUpdateIdx = fn.indexOf("set status = 'completed',");
    const ledgerInsertIdx = fn.indexOf("v_attempt.payment_id, v_attempt.club_id, 'online_payment_recorded',");
    expect(attemptUpdateIdx).toBeGreaterThan(-1);
    expect(ledgerInsertIdx).toBeGreaterThan(attemptUpdateIdx);
  });

  // Section 4 (round 4) — canonical lock order. Before this correction,
  // process_stripe_payment_event locked payment_checkout_attempts (via a
  // `for update` lookup by Session id) BEFORE locking payments, while
  // open_payment_checkout_attempt/supersede_checkout_attempt_and_open_
  // fresh both lock payments first — an inverted order between two
  // functions that can both hold one lock while waiting for the other is
  // a real deadlock opportunity under concurrent load. This test would
  // have FAILED against that ordering (payment_checkout_attempts is now
  // only read with `for update` AFTER payments is locked).
  it("locates the attempt's payment_id via a NON-locking lookup, locks payments FIRST, then re-locks the attempt row — never locks payment_checkout_attempts before payments", () => {
    const fn = processStripePaymentEventBody();
    const nonLockingLookupIdx = fn.indexOf("select payment_id into v_lookup_payment_id");
    const paymentsLockIdx = fn.indexOf("where id = v_lookup_payment_id\n   for update;");
    const attemptRelockIdx = fn.indexOf(
      "where stripe_checkout_session_id = p_stripe_checkout_session_id\n   for update;",
    );
    expect(nonLockingLookupIdx).toBeGreaterThan(-1);
    expect(paymentsLockIdx).toBeGreaterThan(nonLockingLookupIdx);
    expect(attemptRelockIdx).toBeGreaterThan(paymentsLockIdx);
    // The non-locking lookup itself must have no `for update` anywhere
    // between it and the payments lock.
    const nonLockingBlock = fn.slice(nonLockingLookupIdx, paymentsLockIdx);
    expect(nonLockingBlock).not.toMatch(/for update/);
  });

  it("revalidates the re-locked attempt row still refers to the SAME payment after acquiring both locks — the canonical lock order's own consistency check", () => {
    const fn = processStripePaymentEventBody();
    expect(fn).toContain("if not found or v_attempt.payment_id <> v_payment.id then");
  });

  it("open_payment_checkout_attempt and supersede_checkout_attempt_and_open_fresh both lock payments before payment_checkout_attempts — the same canonical order process_stripe_payment_event now uses", () => {
    const m = migration();
    const openFn = m.slice(
      m.indexOf("create or replace function public.open_payment_checkout_attempt("),
      m.indexOf("revoke execute on function public.open_payment_checkout_attempt("),
    );
    const supersedeFn = m.slice(
      m.indexOf("create or replace function public.supersede_checkout_attempt_and_open_fresh("),
      m.indexOf("revoke execute on function public.supersede_checkout_attempt_and_open_fresh("),
    );
    for (const fn of [openFn, supersedeFn]) {
      const paymentsLockIdx = fn.indexOf("from public.payments");
      const attemptsLockIdx = fn.indexOf("from public.payment_checkout_attempts");
      expect(paymentsLockIdx).toBeGreaterThan(-1);
      expect(attemptsLockIdx).toBeGreaterThan(paymentsLockIdx);
    }
  });

  it("online_payment_recorded's shape CHECK requires external_reference (the stored Checkout Session id) to be non-null", () => {
    const m = migration();
    expect(m).toMatch(
      /when 'online_payment_recorded' then\s*\n\s*amount_cents is not null and amount_cents > 0\s*\n\s*and method is null and reverses_event_id is null\s*\n\s*and external_reference is not null/,
    );
  });

  it("process_stripe_payment_event and every other new mutating RPC are service-role-only, never authenticated-callable", () => {
    const m = migration();
    expect(m).toContain(
      "grant  execute on function public.process_stripe_payment_event(text, text, boolean, text, text, text, integer, text) to service_role;",
    );
    expect(m).toContain(
      "grant  execute on function public.open_payment_checkout_attempt(uuid, uuid, text, boolean, uuid) to service_role;",
    );
    expect(m).toContain(
      "grant  execute on function public.supersede_checkout_attempt_and_open_fresh(uuid, uuid, uuid, text, boolean, uuid) to service_role;",
    );
    expect(m).toContain(
      "grant  execute on function public.record_checkout_session_created(uuid, text, timestamptz) to service_role;",
    );
    expect(m).not.toMatch(/grant\s+execute on function public\.(process_stripe_payment_event|open_payment_checkout_attempt|supersede_checkout_attempt_and_open_fresh|record_checkout_session_created).*to authenticated/);
  });

  it("get_reservation_payment_for_checkout is the one new authenticated-grant object, and only that one", () => {
    const m = migration();
    expect(m).toContain(
      "grant  execute on function public.get_reservation_payment_for_checkout(uuid) to authenticated;",
    );
    const authenticatedGrantCount = countOccurrences(m, "to authenticated;");
    expect(authenticatedGrantCount).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 2 (round 4) — void/waived may never mean "zero retained money"
// once real money exists, while every existing 34C zero-money result is
// preserved.
// ═══════════════════════════════════════════════════════════════════════════

describe("_recompute_payment_rollup — void/waived status precedence with retained money", () => {
  const migration = () => readSource(MIGRATION_PATH);

  function rollupBody(): string {
    const m = migration();
    const start = m.indexOf("create or replace function public._recompute_payment_rollup(");
    const end = m.indexOf("-- ═", start + 1);
    return m.slice(start, end);
  }

  // Before this correction, void_payment_obligation (0143) could only
  // ever be called with amount_paid_cents = 0 — a void row could
  // structurally never have retained money, so `if v_void then` alone was
  // safe. process_stripe_payment_event's Section 1 correction (no longer
  // gating on payment status) makes "voided, then a late online payment
  // arrives" newly reachable, so a void row must stop claiming zero money
  // once real money has actually landed. This test would have FAILED
  // against the old unconditional `if v_void then`.
  it("'void' only wins status precedence when net retained money is zero — a void row with real retained money falls through to a money-bearing status instead", () => {
    const fn = rollupBody();
    expect(fn).toContain("if v_void and v_net <= 0 then");
    expect(fn).not.toMatch(/^\s*if v_void then\s*$/m);
  });

  // 'waived' is deliberately LEFT unconditional — waive_payment (0143)
  // can legitimately be called on a row that already has retained money
  // (a partial manual payment, then the remainder forgiven), and 0143's
  // own _check_member_reassignment_allowed already handles that exact
  // combination by checking amount_paid_cents = 0 INDEPENDENTLY of
  // status — never inferring "zero retained money" from status='waived'
  // alone. Changing this branch would regress that existing, shipped,
  // already-tested 34C behavior, which 34D-D1 must not touch.
  it("'waived' remains unconditional in the status precedence — existing 34C waived-with-prior-partial-payment behavior is preserved exactly, not regressed", () => {
    const fn = rollupBody();
    expect(fn).toMatch(/elsif v_waived then\s*\n\s*v_status := 'waived';/);
  });

  it("member reassignment safety for a late online payment after a void/waive needs no code change — _check_member_reassignment_allowed (0143, untouched) already independently requires amount_paid_cents = 0, not merely a status label", () => {
    // 0143 is byte-unchanged (verified separately via git diff --stat).
    // This documents WHY that's sufficient: 0150 never redefines
    // _check_member_reassignment_allowed (only mentions it in prose,
    // explaining why no change is needed there) — matching the codeOnly-
    // filtered check used elsewhere in this suite for the same reason.
    const code = codeOnly(readSource(MIGRATION_PATH));
    expect(code).not.toMatch(/_check_member_reassignment_allowed/);
  });

  it("the void/waived correction is the ONLY behavioral change to _recompute_payment_rollup beyond widening the v_net FILTER — every other branch (overpaid/refunded/paid/partially_paid/unpaid) is untouched", () => {
    const fn = rollupBody();
    expect(fn).toContain("elsif v_net > v_due then");
    expect(fn).toContain("v_status := 'overpaid';");
    expect(fn).toMatch(/elsif v_has_refund then/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 6 (round 4) — DB hard backstop against a double credit,
// independent of application logic.
// ═══════════════════════════════════════════════════════════════════════════

describe("payment_events_online_payment_session_uniq — DB-level double-credit backstop", () => {
  const migration = () => readSource(MIGRATION_PATH);

  it("a unique partial index prevents two online_payment_recorded rows sharing the same (club_id, external_reference) — i.e. the same Checkout Session — even if application logic regresses", () => {
    const m = migration();
    expect(m).toMatch(
      /create unique index payment_events_online_payment_session_uniq\s*\n\s*on public\.payment_events \(club_id, external_reference\)\s*\n\s*where event_type = 'online_payment_recorded';/,
    );
  });

  it("does not affect manual_payment_recorded's own unconstrained, frequently-repeated external_reference — the partial WHERE clause scopes the index to online payments only", () => {
    const m = migration();
    const idxStart = m.indexOf("create unique index payment_events_online_payment_session_uniq");
    const idxBlock = m.slice(idxStart, idxStart + 300);
    expect(idxBlock).not.toMatch(/manual_payment_recorded/);
  });

  it("the backstop index is added in 0150 (new, additive DDL) — compatible with 0143's existing payment_events table, included in the rollback section", () => {
    const m = migration();
    expect(m).toContain("-- drop index if exists public.payment_events_online_payment_session_uniq;");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SQL ambiguity fix — RETURNS TABLE output columns vs. unqualified WHERE
// references (final pre-apply correction).
// ═══════════════════════════════════════════════════════════════════════════

describe("open_payment_checkout_attempt / supersede_checkout_attempt_and_open_fresh — no ambiguous unqualified WHERE references against RETURNS TABLE output columns", () => {
  const migration = () => readSource(MIGRATION_PATH);

  function functionBody(name: string): string {
    const m = migration();
    const start = m.indexOf(`create or replace function public.${name}(`);
    const end = m.indexOf(`revoke execute on function public.${name}(`);
    return m.slice(start, end);
  }

  // Both functions declare RETURNS TABLE columns named id, payment_id,
  // club_id, and status — identical to real column names on the
  // public.payments / public.payment_checkout_attempts tables they query.
  // PostgreSQL treats RETURNS TABLE output columns as plpgsql variables in
  // scope for the whole function body, so an unqualified `where id = ...`
  // (etc.) is genuinely ambiguous between the output variable and the
  // table column. Both functions now alias their queried tables (p / a)
  // and qualify every WHERE reference to these four names — this test
  // would have FAILED against the pre-correction, unaliased source.
  it("both functions alias public.payments as p and public.payment_checkout_attempts as a, and never leave id/payment_id/club_id/status unqualified in a WHERE clause", () => {
    for (const name of ["open_payment_checkout_attempt", "supersede_checkout_attempt_and_open_fresh"]) {
      const fn = functionBody(name);
      expect(fn, `${name} must alias public.payments as p`).toMatch(/from public\.payments p\b/);
      expect(fn, `${name} must alias public.payment_checkout_attempts as a`).toMatch(
        /public\.payment_checkout_attempts a\b/,
      );
      for (const column of ["id", "payment_id", "club_id", "status"]) {
        const unqualifiedWhere = new RegExp(`\\bwhere\\s+${column}\\s*=`);
        const unqualifiedAnd = new RegExp(`\\band\\s+${column}\\s*=`);
        expect(fn, `${name} must not reference unqualified "where ${column} ="`).not.toMatch(unqualifiedWhere);
        expect(fn, `${name} must not reference unqualified "and ${column} ="`).not.toMatch(unqualifiedAnd);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Regression
// ═══════════════════════════════════════════════════════════════════════════

describe("Regression — manual payments, 0143-0149, and prior locks are unaffected", () => {
  it("0143-0146 are not referenced as CREATE OR REPLACE targets by 0150's ACTIVE (non-rollback-comment) SQL beyond _recompute_payment_rollup", () => {
    // codeOnly strips the trailing rollback section's `--`-commented text,
    // which deliberately contains a second, non-executed "create or
    // replace function public._recompute_payment_rollup" as exact-
    // restoration documentation (Finding 5's correction) — that
    // documentation is not a second live redefinition.
    const code = codeOnly(readSource(MIGRATION_PATH));
    const replacedFns = [...code.matchAll(/create or replace function public\.(\w+)/g)].map((mm) => mm[1]);
    expect(replacedFns.sort()).toEqual(
      [
        "_recompute_payment_rollup",
        "get_reservation_payment_for_checkout",
        "open_payment_checkout_attempt",
        "supersede_checkout_attempt_and_open_fresh",
        "record_checkout_session_created",
        "process_stripe_payment_event",
      ].sort(),
    );
  });

  it("record_manual_payment (0143) is not touched by 0150", () => {
    const m = readSource(MIGRATION_PATH);
    expect(m).not.toMatch(/record_manual_payment/);
  });

  it("Event Guest remains excluded — get_reservation_payment_for_checkout is hardcoded to domain_type = 'reservation'", () => {
    const m = readSource(MIGRATION_PATH);
    expect(m).toContain("where p.domain_type = 'reservation'");
    expect(m).not.toMatch(/event_guest/);
  });

  it("no lesson/event/program online payment path is introduced — 0150 only ever references domain_type = 'reservation'", () => {
    const m = readSource(MIGRATION_PATH);
    expect(m).not.toMatch(/lesson_request|event_participant|program_enrollment/);
  });

  it("no refund/dispute vocabulary is introduced by 0150's new event_type/shape widening", () => {
    const m = readSource(MIGRATION_PATH);
    const eventTypeCheckBlock = m.slice(
      m.indexOf("add  constraint payment_events_event_type_check"),
      m.indexOf("));", m.indexOf("add  constraint payment_events_event_type_check")),
    );
    expect(eventTypeCheckBlock).not.toMatch(/dispute/);
    expect(eventTypeCheckBlock).toContain("'online_payment_recorded'");
  });

  it("no application_fee, destination charge, or Court Time percentage anywhere in the Server Action, webhook route, or migration", () => {
    for (const file of [ACTION_PATH, WEBHOOK_PATH, MIGRATION_PATH]) {
      const code = codeOnly(readSource(file));
      expect(code, `${file} must not reference application_fee`).not.toMatch(/application_fee|applicationFee/);
      expect(code, `${file} must not reference on_behalf_of (destination charge)`).not.toMatch(/on_behalf_of/);
      expect(code, `${file} must not reference a platform percentage/take-rate concept`).not.toMatch(/take_rate|platform_fee/i);
    }
  });

  it("no subscriptions, Elements, or saved payment methods anywhere in the checkout-creation code path", () => {
    const src = readSource(ACTION_PATH);
    expect(src).not.toMatch(/subscription/i);
    expect(src).not.toMatch(/elements/i);
    expect(src).not.toMatch(/setup_future_usage|save_payment_method/i);
  });
});
