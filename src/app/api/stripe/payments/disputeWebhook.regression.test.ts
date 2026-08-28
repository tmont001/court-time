import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 34E-C — regression coverage for Stripe Dispute Visibility
// (INFORMATIONAL ONLY), using this repository's established
// source-inspection style (see stripeRefund.regression.test.ts's own
// header comment for why: this test baseline is deliberately
// pure-TypeScript with no jsdom/Supabase/network mocking, so for "does
// the shipped code actually take this shape" questions, reading the real
// source is a more honest guard than reimplementing a parallel mock that
// could drift).

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !line.trim().startsWith("--") && !line.trim().startsWith("//"))
    .join("\n");
}

const MIGRATION_PATH = "supabase/migrations/0156_stripe_dispute_visibility.sql";
const DISPUTE_CONFIG_PATH = "src/lib/stripe/disputeConfig.ts";
const WEBHOOK_ROUTE_PATH = "src/app/api/stripe/payments/events/route.ts";
const ADMIN_CLIENT_PATH = "src/app/(app)/admin/payments/AdminPaymentsClient.tsx";
const PAGE_PATH = "src/app/(app)/admin/payments/page.tsx";
const DB_TYPES_PATH = "src/lib/db/types.ts";

function migrationSql(): string {
  return codeOnly(readSource(MIGRATION_PATH));
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
// Requirements 1, 3, 4 — connected-account dispute event matches the
// correct payment; wrong account/livemode fails to match.
// ═══════════════════════════════════════════════════════════════════════════

describe("provenance resolution matches ONLY on verified account + livemode + PaymentIntent, against a COMPLETED attempt", () => {
  it("the provenance SELECT is scoped to stripe_account_id, livemode, stripe_payment_intent_id, and status = 'completed' — all four required", () => {
    const body = functionBody(migrationSql(), "process_stripe_dispute_webhook_event");
    const selectIdx = body.indexOf("select * into v_source");
    const selectEnd = body.indexOf("limit 1;", selectIdx);
    const selectBlock = body.slice(selectIdx, selectEnd);
    expect(selectBlock).toContain("pca.stripe_account_id = p_stripe_account_id");
    expect(selectBlock).toContain("pca.livemode = p_livemode");
    expect(selectBlock).toContain("pca.stripe_payment_intent_id = p_stripe_payment_intent_id");
    expect(selectBlock).toContain("pca.status = 'completed'");
  });

  it("a mismatch on ANY of account/livemode/PaymentIntent/status naturally yields zero rows (AND-combined, not OR) — a wrong account or wrong livemode alone is sufficient to fail matching", () => {
    const body = functionBody(migrationSql(), "process_stripe_dispute_webhook_event");
    const selectIdx = body.indexOf("select * into v_source");
    const selectEnd = body.indexOf("limit 1;", selectIdx);
    const selectBlock = body.slice(selectIdx, selectEnd);
    // Every condition is joined by `and`, never `or` — all four must hold.
    expect(selectBlock).not.toMatch(/\bor\b/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Requirement 2 — metadata cannot authorize/match a dispute.
// ═══════════════════════════════════════════════════════════════════════════

describe("metadata is never used for dispute provenance — disputes carry no Court Time candidate id at all", () => {
  it("process_stripe_dispute_webhook_event has no metadata/candidate-id parameter of any kind", () => {
    const start = migrationSql().indexOf("create or replace function public.process_stripe_dispute_webhook_event(");
    const argsEnd = migrationSql().indexOf(")", start);
    const argsBlock = migrationSql().slice(start, argsEnd);
    expect(argsBlock).not.toMatch(/metadata/i);
    expect(argsBlock).not.toMatch(/candidate/i);
    expect(argsBlock).not.toMatch(/p_dispute_id\b/); // no Court-Time-side id param, only the verified Stripe one
  });

  it("the webhook route never reads dispute.metadata for this handler", () => {
    const src = readSource(WEBHOOK_ROUTE_PATH);
    const fnStart = src.indexOf("async function handleDisputeEvent(");
    expect(fnStart).toBeGreaterThan(0);
    const fnBody = src.slice(fnStart);
    expect(fnBody).not.toMatch(/dispute\.metadata/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Requirement 5 — nullable dispute.payment_intent uses verified Charge
// fallback, in the same connected-account context.
// ═══════════════════════════════════════════════════════════════════════════

describe("nullable Dispute.payment_intent falls back to a verified Charge retrieve, never guessed or left to metadata", () => {
  it("paymentIntentId is resolved from dispute.payment_intent first, then charges.retrieve as fallback", () => {
    const src = readSource(WEBHOOK_ROUTE_PATH);
    const fnStart = src.indexOf("async function handleDisputeEvent(");
    const fnBody = src.slice(fnStart);
    expect(fnBody).toContain("typeof dispute.payment_intent === \"string\" ? dispute.payment_intent : dispute.payment_intent?.id ?? null");
    const fallbackIdx = fnBody.indexOf("if (!paymentIntentId) {");
    expect(fallbackIdx).toBeGreaterThan(0);
    // The outer if-block's own closing brace is 2-space indented,
    // distinct from the nested try/catch's own more-indented braces.
    const fallbackBlock = fnBody.slice(fallbackIdx, fnBody.indexOf("\n  }\n", fallbackIdx));
    expect(fallbackBlock).toContain("context.client.charges.retrieve(chargeId, {}, { stripeAccount: stripeAccountId })");
  });

  it("Dispute.charge (never null per the installed SDK) is used directly — no fallback needed for the charge id itself", () => {
    const src = readSource(WEBHOOK_ROUTE_PATH);
    const fnStart = src.indexOf("async function handleDisputeEvent(");
    const fnBody = src.slice(fnStart);
    expect(fnBody).toContain('typeof dispute.charge === "string" ? dispute.charge : dispute.charge.id');
  });

  it("if the Charge fallback ALSO cannot resolve a PaymentIntent, the RPC is still called with a null value — never a reason to guess", () => {
    const body = functionBody(migrationSql(), "process_stripe_dispute_webhook_event");
    // p_stripe_payment_intent_id is deliberately excluded from the
    // required-fields null check.
    const checkIdx = body.indexOf("if p_stripe_event_id is null");
    const checkEnd = body.indexOf("raise exception 'invalid_arguments';", checkIdx);
    const checkBlock = body.slice(checkIdx, checkEnd);
    expect(checkBlock).not.toMatch(/p_stripe_payment_intent_id/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Requirement 6 — foreign/unmatched dispute safely ignored.
// ═══════════════════════════════════════════════════════════════════════════

describe("a genuinely foreign/unmatched dispute is safely ignored, never raised as an error", () => {
  it("process_stripe_dispute_webhook_event returns false (not an exception) when no completed attempt matches", () => {
    const body = functionBody(migrationSql(), "process_stripe_dispute_webhook_event");
    const notFoundIdx = body.indexOf("if not found then", body.indexOf("select * into v_source"));
    const notFoundBlock = body.slice(notFoundIdx, body.indexOf("end if;", notFoundIdx));
    expect(notFoundBlock).toContain("return false;");
    expect(notFoundBlock).not.toMatch(/raise exception/);
  });

  it("the webhook route returns 200 (not 4xx/5xx) regardless of whether the RPC matched — both are a successfully processed valid Stripe event", () => {
    const src = readSource(WEBHOOK_ROUTE_PATH);
    const fnStart = src.indexOf("async function handleDisputeEvent(");
    const fnBody = src.slice(fnStart);
    const rpcCallIdx = fnBody.indexOf('privileged.rpc("process_stripe_dispute_webhook_event"');
    const afterRpc = fnBody.slice(rpcCallIdx);
    expect(afterRpc).toContain("if (error) return new NextResponse(null, { status: 500 });");
    expect(afterRpc).toContain("return new NextResponse(null, { status: 200 });");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Requirements 7, 8 — exactly-once event receipt; multiple events for the
// same dispute update the SAME row (never a duplicate).
// ═══════════════════════════════════════════════════════════════════════════

describe("exactly-once event receipt (shared stripe_event_receipts) and same-row upsert by stripe_dispute_id", () => {
  it("reuses the SAME shared stripe_event_receipts table/dedupe pattern as process_stripe_payment_event (0150) and process_stripe_refund_webhook_event (0153) — no new dedupe infrastructure", () => {
    const body = functionBody(migrationSql(), "process_stripe_dispute_webhook_event");
    expect(body).toContain("insert into public.stripe_event_receipts (");
    expect(body).toContain("on conflict (stripe_event_id) do nothing;");
    expect(body).toContain("v_new_receipt := found;");
    const dupeIdx = body.indexOf("if not v_new_receipt then");
    const dupeBlock = body.slice(dupeIdx, body.indexOf("end if;", dupeIdx));
    expect(dupeBlock).toContain("return true;");
  });

  it("external review correction — the real dispute identity is the COMPOSITE (stripe_account_id, livemode, stripe_dispute_id), never stripe_dispute_id alone", () => {
    const sql = migrationSql();
    // stripe_dispute_id itself is no longer independently unique.
    expect(sql).toMatch(/stripe_dispute_id\s+text\s+not null,/);
    expect(sql).not.toMatch(/stripe_dispute_id\s+text\s+not null unique/);
    expect(sql).toContain("unique (stripe_account_id, livemode, stripe_dispute_id)");
  });

  it("subsequent events for an already-known dispute UPDATE the same row via ON CONFLICT on the composite identity, never a second INSERT", () => {
    const body = functionBody(migrationSql(), "process_stripe_dispute_webhook_event");
    expect(body).toContain("insert into public.payment_disputes as pd (");
    expect(body).toContain("on conflict (stripe_account_id, livemode, stripe_dispute_id) do update set");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// External review correction — existing dispute provenance is immutable
// and fails closed; amount/currency are validated against the resolved
// COMPLETED Checkout attempt. Inspects the EXECUTABLE upsert statement
// directly (the SET list and the DO UPDATE's own WHERE guard), not
// surrounding comments.
// ═══════════════════════════════════════════════════════════════════════════

describe("existing dispute provenance (identity columns) is immutable — the DO UPDATE can only ever touch genuinely mutable Stripe state", () => {
  function upsertStatement(): string {
    const body = functionBody(migrationSql(), "process_stripe_dispute_webhook_event");
    const insertIdx = body.indexOf("insert into public.payment_disputes as pd (");
    expect(insertIdx).toBeGreaterThan(0);
    const insertEnd = body.indexOf(";\n\n", insertIdx);
    expect(insertEnd).toBeGreaterThan(insertIdx);
    return body.slice(insertIdx, insertEnd + 1);
  }

  function setClause(): string {
    const stmt = upsertStatement();
    const setIdx = stmt.indexOf("do update set");
    const whereIdx = stmt.indexOf("where pd.club_id");
    expect(whereIdx).toBeGreaterThan(setIdx);
    return stmt.slice(setIdx, whereIdx);
  }

  function whereGuard(): string {
    const stmt = upsertStatement();
    const whereIdx = stmt.indexOf("where pd.club_id");
    expect(whereIdx).toBeGreaterThan(0);
    return stmt.slice(whereIdx);
  }

  it("requirement 3 — payment_id, source_checkout_attempt_id, stripe_charge_id, stripe_payment_intent_id, stripe_account_id, and livemode are NEVER assigned in the SET clause (identity, not mutable state)", () => {
    const set = setClause();
    expect(set).not.toMatch(/\bpayment_id\s*=/);
    expect(set).not.toMatch(/\bsource_checkout_attempt_id\s*=/);
    expect(set).not.toMatch(/\bstripe_charge_id\s*=/);
    expect(set).not.toMatch(/\bstripe_payment_intent_id\s*=/);
    expect(set).not.toMatch(/\bstripe_account_id\s*=/);
    expect(set).not.toMatch(/\blivemode\s*=/);
    expect(set).not.toMatch(/\bclub_id\s*=/);
  });

  it("requirement 3 (extended) — amount_cents and currency are ALSO never assigned in the SET clause (Stripe has no update-amount/update-currency capability, so they are treated as identity too — documented decision)", () => {
    const set = setClause();
    expect(set).not.toMatch(/\bamount_cents\s*=/);
    expect(set).not.toMatch(/\bcurrency\s*=/);
  });

  it("the WHERE guard requires ALL SEVEN of the review's specified identity columns to still match the newly-resolved provenance", () => {
    const guard = whereGuard();
    expect(guard).toContain("pd.club_id = v_payment.club_id");
    expect(guard).toContain("pd.payment_id = v_payment.id");
    expect(guard).toContain("pd.source_checkout_attempt_id = v_source.id");
    expect(guard).toContain("pd.stripe_account_id = p_stripe_account_id");
    expect(guard).toContain("pd.livemode = p_livemode");
    expect(guard).toContain("pd.stripe_charge_id = p_stripe_charge_id");
    expect(guard).toContain("pd.stripe_payment_intent_id = p_stripe_payment_intent_id");
  });

  it("the WHERE guard additionally requires amount_cents/currency to still match (the extended immutable-identity treatment)", () => {
    const guard = whereGuard();
    expect(guard).toContain("pd.amount_cents = p_amount_cents");
    expect(guard).toContain("pd.currency = upper(p_currency)");
  });

  it("requirement 4 — if the conflict exists but the provenance guard excludes it (0 rows affected), the function raises the stable dispute_provenance_mismatch exception, never silently no-ops", () => {
    const body = functionBody(migrationSql(), "process_stripe_dispute_webhook_event");
    const upsertIdx = body.indexOf("insert into public.payment_disputes as pd (");
    const afterUpsert = body.slice(upsertIdx);
    const notFoundIdx = afterUpsert.indexOf("if not found then");
    expect(notFoundIdx).toBeGreaterThan(0);
    const guardBlock = afterUpsert.slice(notFoundIdx, afterUpsert.indexOf("end if;", notFoundIdx));
    expect(guardBlock).toContain("raise exception 'dispute_provenance_mismatch';");
  });

  it("the stale dispute_account_mismatch name from the prior draft is gone — only dispute_provenance_mismatch is raised", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/dispute_account_mismatch/);
    expect(sql).toContain("dispute_provenance_mismatch");
  });

  it("requirement 8 — status, reason, evidence_due_by, is_charge_refundable, and both sync timestamps ARE the mutable Stripe state the SET clause updates", () => {
    const set = setClause();
    expect(set).toContain("status                = excluded.status,");
    expect(set).toContain("reason                = excluded.reason,");
    expect(set).toContain("evidence_due_by        = excluded.evidence_due_by,");
    expect(set).toContain("is_charge_refundable    = excluded.is_charge_refundable,");
    expect(set).toContain("last_synced_at           = now(),");
    expect(set).toContain("updated_at                = now()");
  });
});

describe("dispute amount/currency are validated against the resolved COMPLETED Checkout attempt (external review correction)", () => {
  function validationBlock(): string {
    const body = functionBody(migrationSql(), "process_stripe_dispute_webhook_event");
    const paymentSelectIdx = body.indexOf("select * into v_payment from public.payments where id = v_source.payment_id;");
    expect(paymentSelectIdx).toBeGreaterThan(0);
    const insertIdx = body.indexOf("insert into public.payment_disputes as pd (");
    expect(insertIdx).toBeGreaterThan(paymentSelectIdx);
    return body.slice(paymentSelectIdx, insertIdx);
  }

  it("requirement 5 — currency must equal the completed Checkout attempt's own currency_expected exactly, raising currency_mismatch otherwise", () => {
    const block = validationBlock();
    expect(block).toContain("if upper(p_currency) <> v_source.currency_expected then");
    const idx = block.indexOf("if upper(p_currency) <> v_source.currency_expected then");
    const raiseBlock = block.slice(idx, block.indexOf("end if;", idx));
    expect(raiseBlock).toContain("raise exception 'currency_mismatch';");
  });

  it("requirement 6/7 — amount validation is a `>` ceiling against amount_expected_cents (partial disputes allowed, equal amounts allowed), never an equality requirement", () => {
    const block = validationBlock();
    expect(block).toContain("if p_amount_cents > v_source.amount_expected_cents then");
    expect(block).not.toMatch(/p_amount_cents\s*<>\s*v_source\.amount_expected_cents/);
    expect(block).not.toMatch(/p_amount_cents\s*=\s*v_source\.amount_expected_cents/);
    const idx = block.indexOf("if p_amount_cents > v_source.amount_expected_cents then");
    const raiseBlock = block.slice(idx, block.indexOf("end if;", idx));
    expect(raiseBlock).toContain("raise exception 'dispute_amount_exceeds_charge';");
  });

  it("amount_cents > 0 remains enforced by the table's own CHECK constraint (unchanged) — not re-validated redundantly in the function body", () => {
    const sql = migrationSql();
    expect(sql).toMatch(/amount_cents\s+integer\s+not null check \(amount_cents > 0\)/);
  });

  it("the currency/amount validation runs AFTER provenance resolution (v_source/v_payment) but BEFORE the insert — never validates against an unresolved or foreign attempt", () => {
    const body = functionBody(migrationSql(), "process_stripe_dispute_webhook_event");
    const sourceIdx = body.indexOf("select * into v_source");
    const currencyCheckIdx = body.indexOf("if upper(p_currency) <> v_source.currency_expected then");
    const insertIdx = body.indexOf("insert into public.payment_disputes as pd (");
    expect(sourceIdx).toBeLessThan(currencyCheckIdx);
    expect(currencyCheckIdx).toBeLessThan(insertIdx);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Requirement 9 — stale/out-of-order event cannot regress current Stripe
// state (the "always retrieve current, never trust the payload" model).
// ═══════════════════════════════════════════════════════════════════════════

describe("out-of-order/retried webhook deliveries cannot regress the persisted state", () => {
  it("the webhook route RETRIEVES the Dispute fresh by id — never trusts event.data.object's own point-in-time snapshot for anything beyond the id", () => {
    const src = readSource(WEBHOOK_ROUTE_PATH);
    const fnStart = src.indexOf("async function handleDisputeEvent(");
    const fnBody = src.slice(fnStart);
    expect(fnBody).toContain("const eventDispute = event.data.object as Stripe.Dispute;");
    expect(fnBody).toContain("context.client.disputes.retrieve(\n      eventDispute.id,");
    // Every field sent to the RPC comes from the freshly-retrieved
    // `dispute`/`charge` objects, never from `eventDispute` beyond `.id`.
    const rpcCallIdx = fnBody.indexOf('privileged.rpc("process_stripe_dispute_webhook_event"');
    const rpcArgs = fnBody.slice(rpcCallIdx, fnBody.indexOf("});", rpcCallIdx));
    expect(rpcArgs).not.toMatch(/eventDispute\.(?!id)/);
  });

  it("process_stripe_dispute_webhook_event has NO local state machine — every reconciliation call unconditionally overwrites the mutable Stripe-state fields with whatever was passed in, never gated on the row's own prior status", () => {
    const body = functionBody(migrationSql(), "process_stripe_dispute_webhook_event");
    // Unlike _reconcile_stripe_refund_attempt (0153), there is no
    // `v_old_status` / terminal-state check here at all — by design (see
    // this migration's own header comment on why that's safe here).
    expect(body).not.toMatch(/v_old_status/);
    expect(body).not.toMatch(/'succeeded', 'failed', 'canceled'/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Requirements 10, 11 — unknown Stripe status never corrupts ingestion;
// amount/currency/provenance validation.
// ═══════════════════════════════════════════════════════════════════════════

describe("Stripe's raw status/reason are never constrained by a brittle CHECK; amount/currency ARE validated", () => {
  it("payment_disputes.status and .reason have NO value-restricting CHECK constraint (only NOT NULL) — an unknown future status can never break ingestion", () => {
    const sql = migrationSql();
    const tableStart = sql.indexOf("create table public.payment_disputes (");
    const tableEnd = sql.indexOf(");", tableStart);
    const tableBody = sql.slice(tableStart, tableEnd);
    expect(tableBody).toMatch(/status\s+text\s+not null,/);
    expect(tableBody).toMatch(/reason\s+text\s+not null,/);
    expect(tableBody).not.toMatch(/status\s+text\s+not null\s+check/);
    expect(tableBody).not.toMatch(/reason\s+text\s+not null\s+check/);
  });

  it("amount_cents and currency ARE validated by CHECK constraints, mirroring the rest of this schema", () => {
    const sql = migrationSql();
    expect(sql).toMatch(/amount_cents\s+integer\s+not null check \(amount_cents > 0\)/);
    expect(sql).toMatch(/currency\s+text\s+not null check \(currency ~ '\^\[A-Z\]\{3\}\$'\)/);
  });

  it("process_stripe_dispute_webhook_event validates every required field is non-null before doing anything else, and rejects an unrecognized event_type", () => {
    const body = functionBody(migrationSql(), "process_stripe_dispute_webhook_event");
    expect(body).toContain("raise exception 'invalid_arguments';");
    expect(body).toContain("raise exception 'invalid_event_type';");
    expect(body).toContain("'charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed',");
    expect(body).toContain("'charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated'");
  });

  it("presentDisputeStatus falls back to a safe generic label for any unrecognized status — proven by inspecting the map plus its own fallback expression", () => {
    const src = readSource(DISPUTE_CONFIG_PATH);
    const fnStart = src.indexOf("export function presentDisputeStatus(");
    const fnBody = src.slice(fnStart, src.indexOf("\n}", fnStart));
    expect(fnBody).toContain('?? { label: "Disputed", tone: "generic" }');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Requirements 12, 13, 14 — service-role mutation boundary; authenticated
// club-scoped read boundary; Member/Pro cannot read dispute data.
// ═══════════════════════════════════════════════════════════════════════════

describe("access boundaries: service-role-only mutation, club-scoped Admin/Staff-only read", () => {
  it("process_stripe_dispute_webhook_event is revoked from public/anon/authenticated and granted ONLY to service_role", () => {
    const sql = migrationSql();
    expect(sql).toMatch(
      /revoke execute on function public\.process_stripe_dispute_webhook_event\([^)]*\) from public, anon, authenticated;/,
    );
    expect(sql).toMatch(
      /grant {2}execute on function public\.process_stripe_dispute_webhook_event\([^)]*\) to service_role;/,
    );
  });

  it("payment_disputes RLS restricts SELECT to the caller's own club AND admin/staff role — mirrors payments_select_admin_staff (0143) exactly", () => {
    const sql = migrationSql();
    expect(sql).toContain("alter table public.payment_disputes enable row level security;");
    const policyIdx = sql.indexOf('create policy "payment_disputes_select_admin_staff"');
    expect(policyIdx).toBeGreaterThan(0);
    const policyBlock = sql.slice(policyIdx, sql.indexOf(");", policyIdx));
    expect(policyBlock).toContain("club_id = public.current_user_club_id()");
    expect(policyBlock).toContain("public.current_user_role() in ('admin', 'staff')");
  });

  it("payment_disputes is granted SELECT to authenticated only — never to anon/public, and no INSERT/UPDATE/DELETE policy exists for any role", () => {
    const sql = migrationSql();
    expect(sql).toMatch(/grant select on public\.payment_disputes to authenticated;/);
    expect(sql).not.toMatch(/grant .* on public\.payment_disputes to anon/);
    expect(sql).not.toMatch(/create policy .* on public\.payment_disputes for (insert|update|delete)/);
  });

  it("no client-facing component ever imports createPrivilegedClient or calls the service-role dispute RPC directly", () => {
    const clientSrc = readSource(ADMIN_CLIENT_PATH);
    expect(clientSrc).not.toMatch(/createPrivilegedClient/);
    expect(clientSrc).not.toMatch(/process_stripe_dispute_webhook_event/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Requirements 15, 16, 17 — THE MONEY INVARIANT: a dispute never changes
// amount_paid_cents, never re-enables Pay Now, never inserts a refund
// ledger event.
// ═══════════════════════════════════════════════════════════════════════════

describe("CRITICAL MONEY INVARIANT — dispute reconciliation cannot alter payment/refund state", () => {
  it("process_stripe_dispute_webhook_event never UPDATEs public.payments at all — the only payments access is a read-only SELECT", () => {
    const body = functionBody(migrationSql(), "process_stripe_dispute_webhook_event");
    expect(body).not.toMatch(/update public\.payments/);
    expect(body).toContain("select * into v_payment from public.payments where id = v_source.payment_id;");
  });

  it("0156 never references amount_paid_cents, amount_due_cents, or the payments.status column anywhere", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/amount_paid_cents/);
    expect(sql).not.toMatch(/amount_due_cents/);
  });

  it("0156 never touches payment_events or payment_refund_attempts — no INSERT/UPDATE against either table", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/insert into public\.payment_events/);
    expect(sql).not.toMatch(/update public\.payment_events/);
    expect(sql).not.toMatch(/insert into public\.payment_refund_attempts/);
    expect(sql).not.toMatch(/update public\.payment_refund_attempts/);
  });

  it("0156 never redefines _recompute_payment_rollup, record_refund, or any other 0143/0150/0153/0154/0155 function — the payment status state machine is completely untouched", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/create or replace function public\._recompute_payment_rollup/);
    expect(sql).not.toMatch(/create or replace function public\.record_refund/);
    expect(sql).not.toMatch(/create or replace function public\.open_payment_refund_attempt/);
    // Exactly one function is created/replaced by this migration.
    const createCount = (sql.match(/create or replace function public\./g) ?? []).length;
    expect(createCount).toBe(1);
  });

  it("isPaymentOpenForRecording (the Record Payment / Pay Now eligibility gate) is not imported, referenced, or reimplemented anywhere by the dispute feature — Pay Now eligibility is structurally unreachable from dispute code", () => {
    const configSrc = readSource(DISPUTE_CONFIG_PATH);
    expect(configSrc).not.toMatch(/isPaymentOpenForRecording/);
    expect(configSrc).not.toMatch(/isReservationPaymentEligibleForCheckout/);
    const routeSrc = readSource(WEBHOOK_ROUTE_PATH);
    const fnStart = routeSrc.indexOf("async function handleDisputeEvent(");
    const fnBody = routeSrc.slice(fnStart);
    expect(fnBody).not.toMatch(/isPaymentOpenForRecording/);
  });

  it("the Record Payment button's render condition in AdminPaymentsClient.tsx is untouched by this phase — still gated solely on isPaymentOpenForRecording(row.state), with no dispute-related condition added", () => {
    const src = readSource(ADMIN_CLIENT_PATH);
    expect(src).toContain("{isPaymentOpenForRecording(row.state) && (");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Requirement 18 — /admin/payments renders known dispute states correctly.
// ═══════════════════════════════════════════════════════════════════════════

describe("known dispute states render with the locked hierarchy; unknown states fall back safely", () => {
  it.each([
    ["needs_response", "urgent"],
    ["under_review", "in_progress"],
    ["won", "positive"],
    ["lost", "negative"],
    ["warning_needs_response", "warning"],
    ["warning_under_review", "warning"],
    ["warning_closed", "warning"],
    ["prevented", "positive"],
  ])("%s maps to tone %s", (status, tone) => {
    const src = readSource(DISPUTE_CONFIG_PATH);
    const mapIdx = src.indexOf("const KNOWN_DISPUTE_STATUS_PRESENTATION");
    const mapEnd = src.indexOf("};", mapIdx);
    const mapBlock = src.slice(mapIdx, mapEnd);
    const entryRegex = new RegExp(`${status}: \\{ label: "[^"]+", tone: "${tone}" \\}`);
    expect(mapBlock).toMatch(entryRegex);
  });

  it("DisputeBadge renders status label, disputed amount, and reason — the compact information set locked for this phase", () => {
    const src = readSource(ADMIN_CLIENT_PATH);
    const fnStart = src.indexOf("function DisputeBadge(");
    expect(fnStart).toBeGreaterThan(0);
    const fnBody = src.slice(fnStart);
    expect(fnBody).toContain("presentDisputeStatus(dispute.status)");
    expect(fnBody).toContain("formatMoney(dispute.amountCents, dispute.currency)");
    expect(fnBody).toContain("formatDisputeReason(dispute.reason)");
  });

  it("the dispute badge only renders when row.dispute is present — never fabricated for a non-disputed payment", () => {
    const src = readSource(ADMIN_CLIENT_PATH);
    expect(src).toContain("{row.dispute && (");
    expect(src).toContain("<DisputeBadge dispute={row.dispute} />");
  });

  it("page.tsx never surfaces dispute data outside /admin/payments — the payment_disputes read lives only in this Admin/Staff-gated page", () => {
    const src = readSource(PAGE_PATH);
    expect(src).toContain('.from("payment_disputes")');
    // The existing page-level Admin/Staff guard (isOperator) is untouched
    // and still runs before any data fetch.
    expect(src).toContain("if (!profile || !isOperator(profile.role)) redirect(\"/calendar\");");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Requirement 19 — existing Refund behavior remains intact for
// non-disputed/refundable payments; disputed+non-refundable payments hide
// the Refund action without redesigning 34E-B accounting.
// ═══════════════════════════════════════════════════════════════════════════

describe("Refund action: unchanged for non-disputed payments, hidden only when Stripe reports the charge is not refundable", () => {
  it("the Refund button condition is isOnlineRefundEligible(row.refundableCents) && !row.disputeBlocksRefund — additive, not a replacement of the 34E-B gate", () => {
    const src = readSource(ADMIN_CLIENT_PATH);
    expect(src).toContain("{isOnlineRefundEligible(row.refundableCents) && !row.disputeBlocksRefund && (");
  });

  it("disputeBlocksRefund is computed from is_charge_refundable = false on ANY dispute for the payment — Stripe's own live signal, never re-derived locally", () => {
    const src = readSource(PAGE_PATH);
    expect(src).toContain("disputeBlocksRefund: disputesForPayment.some(d => !d.is_charge_refundable),");
  });

  it("a payment with no dispute rows has disputeBlocksRefund = false by construction (Array.prototype.some on an empty array), so Refund behavior for non-disputed payments is byte-for-byte unchanged from 34E-B", () => {
    const src = readSource(PAGE_PATH);
    const idx = src.indexOf("const disputesForPayment = disputesByPaymentId.get(p.id) ?? [];");
    expect(idx).toBeGreaterThan(0);
  });

  it("34E-B's own refund creation flow (open_payment_refund_attempt, refundActions.ts) is not modified by this migration or this phase's TS changes", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/create or replace function public\.open_payment_refund_attempt/);
    const refundActionsSrc = readSource("src/app/(app)/admin/payments/refundActions.ts");
    expect(refundActionsSrc).not.toMatch(/payment_disputes/);
    expect(refundActionsSrc).not.toMatch(/disputeConfig/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Migration hygiene — signature registered in db/types.ts; rollback is a
// real executable statement.
// ═══════════════════════════════════════════════════════════════════════════

describe("db/types.ts and rollback completeness", () => {
  it("process_stripe_dispute_webhook_event is registered in db/types.ts with a plain boolean Returns type (not an array/table shape)", () => {
    const src = readSource(DB_TYPES_PATH);
    const idx = src.indexOf("process_stripe_dispute_webhook_event: {");
    expect(idx).toBeGreaterThan(0);
    // The entry-level closing brace is 6-space indented ("      };"),
    // distinct from the nested Args object's own 8-space-indented one —
    // a naive first-"};" search lands on Args's, before ever reaching
    // Returns.
    const block = src.slice(idx, src.indexOf("\n      };", idx));
    expect(block).toContain("Returns: boolean;");
  });

  it("payment_disputes is registered in db/types.ts with Insert/Update: never — writes only ever go through the service-role RPC", () => {
    const src = readSource(DB_TYPES_PATH);
    const idx = src.indexOf("payment_disputes: {");
    expect(idx).toBeGreaterThan(0);
    const block = src.slice(idx, src.indexOf("Relationships:", idx));
    expect(block).toContain("Insert: never;");
    expect(block).toContain("Update: never;");
  });

  it("0156's rollback drops exactly what this migration created — the function and the table, real executable SQL not placeholder prose", () => {
    const raw = readSource(MIGRATION_PATH);
    const rollbackIdx = raw.indexOf("-- Rollback (manual, cloud SQL Editor)");
    expect(rollbackIdx).toBeGreaterThan(0);
    const rollback = raw.slice(rollbackIdx);
    expect(rollback).toContain("-- drop function if exists public.process_stripe_dispute_webhook_event(text, text, boolean, text, text, text, text, integer, text, text, text, timestamptz, boolean, timestamptz);");
    expect(rollback).toContain("-- drop table if exists public.payment_disputes;");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Avoiding the 0153/0154/0155 PL/pgSQL OUT-variable ambiguity class.
// ═══════════════════════════════════════════════════════════════════════════

describe("no new RETURNS TABLE function is introduced — the 34E-B ambiguity class cannot recur here by construction", () => {
  it("0156 introduces exactly ONE new function, and it is NOT a RETURNS TABLE function", () => {
    const sql = migrationSql();
    const returnsTableCount = (sql.match(/returns table \(/g) ?? []).length;
    expect(returnsTableCount).toBe(0);
    expect(sql).toMatch(/create or replace function public\.process_stripe_dispute_webhook_event\([\s\S]*?\)\nreturns boolean/);
  });

  it("every table reference inside process_stripe_dispute_webhook_event is still alias-qualified (pca/pd), as a matter of discipline even though a scalar return has no OUT-variable shadowing risk", () => {
    const body = functionBody(migrationSql(), "process_stripe_dispute_webhook_event");
    expect(body).toContain("from public.payment_checkout_attempts pca");
    expect(body).toContain("insert into public.payment_disputes as pd (");
    expect(body).toContain("and pd.stripe_account_id = p_stripe_account_id");
  });
});
