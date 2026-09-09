import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 34E-D — regression coverage for Late Payment / Overpayment
// Resilience, using this repository's established source-inspection style
// (see stripeRefund.regression.test.ts's own header comment for why:
// deliberately pure-TypeScript with no jsdom/Supabase/network mocking —
// for "does the shipped code actually take this shape" questions, reading
// the real source is a more honest guard than a parallel mock that could
// drift).
//
// This file covers the CORRECTED 0157 (external review pass): the
// collectible-due model for waiver/void (no timestamp/UUID causal
// ordering anywhere), and newest-refundable-attempt-first for BOTH
// get_online_refundable_amount_for_payments and open_payment_refund_
// attempt. 0150/0151/0154/0155's own files are untouched by 0157 and are
// asserted here only to prove they remain untouched — their own dedicated
// test files (stripeRefund.regression.test.ts etc.) continue to test what
// those migrations themselves shipped.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !line.trim().startsWith("--") && !line.trim().startsWith("//"))
    .join("\n");
}

const MIGRATION_0143_PATH = "supabase/migrations/0143_payment_mode_and_ledger_foundation.sql";
const MIGRATION_0150_PATH = "supabase/migrations/0150_reservation_checkout_foundation.sql";
const MIGRATION_0151_PATH = "supabase/migrations/0151_stale_checkout_invalidation.sql";
const MIGRATION_0156_PATH = "supabase/migrations/0156_stripe_dispute_visibility.sql";
const MIGRATION_0157_PATH = "supabase/migrations/0157_late_payment_overpayment_resilience.sql";
const MIGRATION_0158_PATH = "supabase/migrations/0158_payment_internal_helper_privilege_hardening.sql";
const PAYMENTS_LIB_PATH = "src/lib/payments.ts";

function sql0150(): string { return codeOnly(readSource(MIGRATION_0150_PATH)); }
function sql0151(): string { return codeOnly(readSource(MIGRATION_0151_PATH)); }
function sql0156(): string { return codeOnly(readSource(MIGRATION_0156_PATH)); }
function sql0157(): string { return codeOnly(readSource(MIGRATION_0157_PATH)); }
function sql0158(): string { return codeOnly(readSource(MIGRATION_0158_PATH)); }

// Isolates a single `create or replace function public.<name>(...)` body
// up to its own closing `$$;`.
function functionBody(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  expect(start, `function public.${name} not found`).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf("\n$$;", start);
  expect(end, `terminator not found for ${name}`).toBeGreaterThan(start);
  return sql.slice(start, end + "\n$$;".length);
}

function rollupBody(): string { return functionBody(sql0157(), "_recompute_payment_rollup"); }
function refundableBody(): string { return functionBody(sql0157(), "get_online_refundable_amount_for_payments"); }
function openRefundBody(): string { return functionBody(sql0157(), "open_payment_refund_attempt"); }

// Mirrors the exact status-precedence logic shipped in the CORRECTED
// 0157 _recompute_payment_rollup (second external review pass —
// 'overpaid' checked BEFORE 'waived', 'waived' requires EXACT equality),
// so worked examples below prove the actual arithmetic, not just its
// shape.
function computeStatus(input: {
  nominalDue: number; net: number; isVoid: boolean; activeWaiverAmount: number; hasRefund: boolean;
}): { status: string; due: number } {
  const waived = input.activeWaiverAmount > 0;
  const due = input.isVoid ? 0 : Math.max(input.nominalDue - input.activeWaiverAmount, 0);
  let status: string;
  if (input.isVoid && input.net <= 0) status = "void";
  else if (input.net > due) status = "overpaid";
  else if (waived && input.net === due) status = "waived";
  else if (input.hasRefund) {
    status = input.net <= 0 ? "refunded" : input.net < due ? "partially_refunded" : "paid";
  } else {
    status = input.net <= 0 ? "unpaid" : input.net < due ? "partially_paid" : "paid";
  }
  return { status, due };
}

// ═══════════════════════════════════════════════════════════════════════════
// Requirement 21 (checked first, deliberately) — no timestamp/UUID causal
// ordering remains anywhere in 0157.
// ═══════════════════════════════════════════════════════════════════════════

describe("Blocker 2 — NO causal ordering by created_at/occurred_at/UUID anywhere in 0157", () => {
  it("0157 contains no (created_at, id) / (created_at, ...) row-comparison pattern", () => {
    const sql = sql0157();
    expect(sql).not.toMatch(/\(\s*\w*\.?created_at\s*,\s*\w*\.?id\s*\)\s*>/);
    expect(sql).not.toMatch(/\(\s*\w*\.?created_at\s*,\s*\w*\.?id\s*\)\s*</);
  });

  it("0157 never references occurred_at at all", () => {
    expect(sql0157()).not.toMatch(/occurred_at/);
  });

  it("the removed variables from the prior draft (v_waived_event_id, v_waived_at, v_late_money_after_waiver) do not exist anywhere in 0157", () => {
    const sql = sql0157();
    expect(sql).not.toMatch(/v_waived_event_id/);
    expect(sql).not.toMatch(/v_waived_at/);
    expect(sql).not.toMatch(/v_late_money_after_waiver/);
  });

  it("_recompute_payment_rollup's ONLY use of created_at is the pre-existing, unrelated v_nominal_due lookup (latest obligation event) — not an economic-precedence comparison", () => {
    const body = rollupBody();
    const occurrences = body.match(/created_at/g) ?? [];
    // Exactly the single `order by created_at desc, id desc` from the
    // pre-existing v_nominal_due query (unchanged from 0153) — the prior
    // draft's SECOND such lookup (for v_waived_at) is gone entirely.
    expect(occurrences.length).toBe(1);
    expect(body).toContain("order by created_at desc, id desc");
  });

  it("waiver economics are derived from a ledger AMOUNT (SUM of non-reversed 'waived' event amounts), never from event ordering", () => {
    const body = rollupBody();
    expect(body).toContain("select coalesce(sum(amount_cents), 0) into v_active_waiver_amount");
    expect(body).toContain("where payment_id = p_payment_id and event_type = 'waived'");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Requirement 1, 2, 3 — amount_paid_cents remains an uncapped net SUM;
// exact and partial payments are unaffected.
// ═══════════════════════════════════════════════════════════════════════════

describe("amount_paid_cents remains an uncapped net ledger SUM; ordinary exact/partial payments unaffected", () => {
  it("the UPDATE sets amount_paid_cents = v_net directly — no clamp of any kind", () => {
    const body = rollupBody();
    expect(body).toContain("amount_paid_cents = v_net,");
    expect(body).not.toMatch(/least\(/);
  });

  it("v_net's own SUM expression is byte-identical to 0153 — untouched by this correction pass", () => {
    const body = rollupBody();
    expect(body).toContain("coalesce(sum(amount_cents) filter (where event_type in ('manual_payment_recorded', 'online_payment_recorded')), 0)\n    - coalesce(sum(amount_cents) filter (where event_type in ('refund_recorded', 'online_refund_recorded')), 0)");
  });

  it("worked example: exact payment ($30 due, $30 net, no waiver/void) is still 'paid'", () => {
    const result = computeStatus({ nominalDue: 3000, net: 3000, isVoid: false, activeWaiverAmount: 0, hasRefund: false });
    expect(result).toEqual({ status: "paid", due: 3000 });
  });

  it("worked example: partial payment ($30 due, $20 net) is still 'partially_paid'", () => {
    const result = computeStatus({ nominalDue: 3000, net: 2000, isVoid: false, activeWaiverAmount: 0, hasRefund: false });
    expect(result).toEqual({ status: "partially_paid", due: 3000 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Blocker 1 — the collectible-due model itself.
// ═══════════════════════════════════════════════════════════════════════════

describe("Blocker 1 — collectible-due model: waiver/void reduce the COLLECTIBLE obligation, never the recorded receipt", () => {
  it("v_due is now derived from v_nominal_due minus v_active_waiver_amount (greatest(...,0)), or 0 outright when voided — not the raw obligation amount", () => {
    const body = rollupBody();
    expect(body).toContain("if v_void then\n    v_due := 0;\n  else\n    v_due := greatest(v_nominal_due - v_active_waiver_amount, 0);\n  end if;");
  });

  it("second external review correction: 'overpaid' is checked BEFORE 'waived', and 'waived' requires EXACT equality (v_net = v_due), not <=", () => {
    const body = rollupBody();
    const voidIdx = body.indexOf("if v_void and v_net <= 0 then");
    const overpaidIdx = body.indexOf("elsif v_net > v_due then\n    v_status := 'overpaid';");
    const waivedIdx = body.indexOf("elsif v_waived and v_net = v_due then\n    v_status := 'waived';");
    expect(voidIdx).toBeGreaterThan(0);
    expect(overpaidIdx).toBeGreaterThan(voidIdx);
    expect(waivedIdx).toBeGreaterThan(overpaidIdx);
    // The old, too-broad `<=` condition must not exist anywhere.
    expect(body).not.toMatch(/v_waived and v_net <= v_due/);
  });

  it("v_active_waiver_amount SUMS every non-reversed 'waived' event — composes correctly across more than one sequential waiver", () => {
    const body = rollupBody();
    const idx = body.indexOf("select coalesce(sum(amount_cents), 0) into v_active_waiver_amount");
    const block = body.slice(idx, body.indexOf(";", idx) + 1);
    expect(block).toContain("event_type = 'waived'");
    expect(block).toContain("select reverses_event_id from public.payment_events where reverses_event_id is not null");
  });

  it("void's own pre-existing v_net <= 0 guard is UNCHANGED (minimal diff) — now equivalent to v_net <= v_due since v_due is forced to 0 when voided", () => {
    const body = rollupBody();
    expect(body).toContain("if v_void and v_net <= 0 then\n    v_status := 'void';");
  });

  // ─────────────────────────────────────────────────────────────────────
  // The nine required worked scenarios (second external review pass),
  // numbered exactly as specified.
  // ─────────────────────────────────────────────────────────────────────

  it("scenario 1: $30 nominal, $20 paid, $10 waived — due=2000, net=2000, status=waived", () => {
    const result = computeStatus({ nominalDue: 3000, net: 2000, isVoid: false, activeWaiverAmount: 1000, hasRefund: false });
    expect(result).toEqual({ status: "waived", due: 2000 });
  });

  it("scenario 2: full $30 waiver — due=0, net=0, status=waived", () => {
    const result = computeStatus({ nominalDue: 3000, net: 0, isVoid: false, activeWaiverAmount: 3000, hasRefund: false });
    expect(result).toEqual({ status: "waived", due: 0 });
  });

  it("scenario 3: $20 paid + $10 waived + late $10 capture — due=2000, net=3000, status=overpaid", () => {
    const result = computeStatus({ nominalDue: 3000, net: 3000, isVoid: false, activeWaiverAmount: 1000, hasRefund: false });
    expect(result).toEqual({ status: "overpaid", due: 2000 });
  });

  it("scenario 4: refund the exact $10 excess afterward — due=2000, net=2000, status returns to waived", () => {
    const result = computeStatus({ nominalDue: 3000, net: 2000, isVoid: false, activeWaiverAmount: 1000, hasRefund: true });
    expect(result).toEqual({ status: "waived", due: 2000 });
  });

  it("scenario 5: refund beyond the excess so net=1500 — due=2000, status=partially_refunded, NOT waived and NOT an open payment state", () => {
    const result = computeStatus({ nominalDue: 3000, net: 1500, isVoid: false, activeWaiverAmount: 1000, hasRefund: true });
    expect(result).toEqual({ status: "partially_refunded", due: 2000 });
    expect(result.status).not.toBe("waived");
    expect(["unpaid", "partially_paid"]).not.toContain(result.status);
  });

  it("scenario 6: full refund so net=0 with a refund event — status=refunded", () => {
    const result = computeStatus({ nominalDue: 3000, net: 0, isVoid: false, activeWaiverAmount: 1000, hasRefund: true });
    expect(result.status).toBe("refunded");
  });

  it("scenario 7 (THE FIX): reverse the original $20 manual payment after the $10 waiver, no refund event — due=2000, net=0, status=unpaid, NOT waived", () => {
    // The reversal excludes the $20 manual_payment_recorded event from
    // v_net (via reverses_event_id) but the 'waived' event itself is
    // untouched, so the waiver amount (and therefore collectible due)
    // is unaffected — only net changes.
    const result = computeStatus({ nominalDue: 3000, net: 0, isVoid: false, activeWaiverAmount: 1000, hasRefund: false });
    expect(result).toEqual({ status: "unpaid", due: 2000 });
    expect(result.status).not.toBe("waived");
  });

  it("scenario 8: partial reversal-equivalent arithmetic leaving net between 0 and due — status=partially_paid", () => {
    const result = computeStatus({ nominalDue: 3000, net: 1000, isVoid: false, activeWaiverAmount: 1000, hasRefund: false });
    expect(result).toEqual({ status: "partially_paid", due: 2000 });
  });

  it("scenario 9a: void + late money remains overpaid", () => {
    const result = computeStatus({ nominalDue: 3000, net: 1500, isVoid: true, activeWaiverAmount: 0, hasRefund: false });
    expect(result).toEqual({ status: "overpaid", due: 0 });
  });

  it("scenario 9b: void + money fully returned to zero returns to void", () => {
    const result = computeStatus({ nominalDue: 3000, net: 0, isVoid: true, activeWaiverAmount: 0, hasRefund: true });
    expect(result.status).toBe("void");
  });

  // Requirement 10 — excess computation (unchanged, still amount_paid -
  // collectible amount_due).
  it("requirement 10: overpaid_cents is still amount_paid - collectible amount_due (formatPaymentStateLabel, unchanged)", () => {
    const src = readSource(PAYMENTS_LIB_PATH);
    const caseIdx = src.indexOf('case "overpaid":');
    const caseBody = src.slice(caseIdx, src.indexOf("case ", caseIdx + 10));
    expect(caseBody).toContain("formatMoney(paid - due, currency)");
  });

  it("worked example: full waiver ($30->$0 collectible) + $10 late capture — excess = 10 - 0 = $10, not $0", () => {
    const result = computeStatus({ nominalDue: 3000, net: 1000, isVoid: false, activeWaiverAmount: 3000, hasRefund: false });
    const netPaid = 1000;
    expect(Math.max(netPaid - result.due, 0)).toBe(1000);
  });

  it("no timestamp/UUID causal ordering was introduced to solve any of these nine scenarios — computeStatus above uses only amounts", () => {
    // Structural cross-check: the SQL itself still contains none.
    const sql = sql0157();
    expect(sql).not.toMatch(/v_waived_at|v_waived_event_id|v_late_money_after_waiver/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Requirement 9 — downstream amount_due audit (waived/void never
// re-enables collection, whether via status gate or amount comparison).
// ═══════════════════════════════════════════════════════════════════════════

describe("requirement 9 — downstream consumers of amount_due_cents never reopen collection for waived/void, confirming the audit", () => {
  it("isPaymentOpenForRecording gates on STATUS first (unpaid/partially_paid only) — 'waived'/'void'/'overpaid' never reach the amount comparison at all", () => {
    const src = readSource(PAYMENTS_LIB_PATH);
    const fnStart = src.indexOf("export function isPaymentOpenForRecording(");
    const fnBody = src.slice(fnStart, src.indexOf("\n}", fnStart));
    expect(fnBody).toContain('row.current_status === "unpaid" || row.current_status === "partially_paid"');
  });

  it("waive_payment and void_payment_obligation both require status in ('unpaid','partially_paid')/('unpaid') respectively BEFORE ever reading amount_due_cents — waived and void are mutually exclusive with each other and with re-entry", () => {
    const waive = functionBody(sql0151(), "waive_payment");
    expect(waive).toContain("if v_payment.status not in ('unpaid', 'partially_paid') then");
    const voidFn = functionBody(sql0151(), "void_payment_obligation");
    expect(voidFn).toContain("if v_payment.status <> 'unpaid' then");
    expect(voidFn).toContain("if v_payment.amount_paid_cents <> 0 then");
  });

  it("0157 touches no table, index, constraint, grant, or RLS policy — the downstream-safe conclusion required no schema change", () => {
    const sql = sql0157();
    const beginIdx = sql.indexOf("begin;");
    const commitIdx = sql.lastIndexOf("commit;");
    const executable = sql.slice(beginIdx, commitIdx);
    expect(executable).not.toMatch(/create table|alter table|create index|create policy/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Requirement 12, 13, 14 — Stripe capture recorded in full; dedupe;
// two genuine captures both count (unchanged 0150 behavior).
// ═══════════════════════════════════════════════════════════════════════════

describe("process_stripe_payment_event (0150) is completely untouched by 0157", () => {
  it("0157 never redefines process_stripe_payment_event, record_manual_payment, waive_payment, or void_payment_obligation", () => {
    const sql = sql0157();
    expect(sql).not.toMatch(/create or replace function public\.process_stripe_payment_event/);
    expect(sql).not.toMatch(/create or replace function public\.record_manual_payment/);
    expect(sql).not.toMatch(/create or replace function public\.waive_payment/);
    expect(sql).not.toMatch(/create or replace function public\.void_payment_obligation/);
  });

  it("the captured amount is still recorded in full, unconditionally, and the unique index is still scoped to (club_id, external_reference) — never payment_id", () => {
    const body = functionBody(sql0150(), "process_stripe_payment_event");
    expect(body).toContain("v_attempt.payment_id, v_attempt.club_id, 'online_payment_recorded',\n    p_amount_total_cents, p_stripe_checkout_session_id, null");
    const sql = sql0150();
    const idxIdx = sql.indexOf("create unique index payment_events_online_payment_session_uniq");
    const idxBlock = sql.slice(idxIdx, sql.indexOf(";", idxIdx) + 1);
    expect(idxBlock).toContain("on public.payment_events (club_id, external_reference)");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Blocker 3 — newest-refundable-attempt-first, both functions.
// ═══════════════════════════════════════════════════════════════════════════

describe("Blocker 3 — get_online_refundable_amount_for_payments selects the newest COMPLETED attempt with remaining refundable > 0", () => {
  it("computes remaining_cents for EVERY completed attempt (not just the latest) before ranking", () => {
    const body = refundableBody();
    expect(body).toContain("attempts_with_remaining as (");
    expect(body).toContain("greatest(s.amount_expected_cents - coalesce(r.reserved_cents, 0), 0)::integer as remaining_cents");
  });

  it("requirement 15/16: the selection is `distinct on (payment_id) ... where remaining_cents > 0 order by payment_id, created_at desc, attempt_id desc` — newest attempt with room wins (deterministic tie-break), an exhausted newest attempt is excluded, letting an older one surface", () => {
    const body = refundableBody();
    const selIdx = body.indexOf("selected as (");
    const selBlock = body.slice(selIdx, body.indexOf(")\n    select sel.payment_id", selIdx));
    expect(selBlock).toContain("select distinct on (w.payment_id)");
    expect(selBlock).toContain("where w.remaining_cents > 0");
    expect(selBlock).toContain("order by w.payment_id, w.created_at desc, w.attempt_id desc");
  });

  it("every table/CTE reference is alias-qualified — no bare payment_id/currency (this function's own OUT vars) anywhere in the executable body", () => {
    const full = refundableBody();
    const beginIdx = full.indexOf("\nbegin\n");
    expect(beginIdx).toBeGreaterThan(0);
    const executable = full.slice(beginIdx);
    for (const name of ["payment_id", "currency"]) {
      const bareRegex = new RegExp(`(?<!\\.)\\b${name}\\b`, "g");
      const matches = executable.match(bareRegex) ?? [];
      expect(matches, `bare reference(s) to "${name}" found: ${JSON.stringify(matches)}`).toEqual([]);
    }
    expect(full).toContain("a.payment_id");
    expect(full).toContain("s.payment_id");
    expect(full).toContain("w.payment_id");
    expect(full).toContain("sel.payment_id");
  });

  it("worked example: due $30, Checkout A captured $30 (older), Checkout B captured $30 (newer) — refund $30 targets B; B then has $0 remaining, so the NEXT query naturally surfaces A", () => {
    type Attempt = { id: string; createdAt: number; amountExpected: number; reserved: number };
    const attempts: Attempt[] = [
      { id: "A", createdAt: 1, amountExpected: 3000, reserved: 0 },
      { id: "B", createdAt: 2, amountExpected: 3000, reserved: 0 },
    ];
    function selectNewestRefundable(attempts: Attempt[]): Attempt | null {
      const withRoom = attempts
        .map((a) => ({ ...a, remaining: Math.max(a.amountExpected - a.reserved, 0) }))
        .filter((a) => a.remaining > 0);
      if (withRoom.length === 0) return null;
      return withRoom.sort((x, y) => y.createdAt - x.createdAt)[0];
    }
    const first = selectNewestRefundable(attempts);
    expect(first?.id).toBe("B");
    // B fully refunded.
    attempts[1].reserved = 3000;
    const second = selectNewestRefundable(attempts);
    expect(second?.id).toBe("A");
  });
});

describe("Blocker 3 — open_payment_refund_attempt selects the SAME newest-refundable attempt, under the SAME canonical lock", () => {
  it("the resolution query filters on a per-attempt remaining-refundable correlated subquery > 0, ordered by created_at desc, id desc (deterministic tie-break), limit 1 — same rule as the display function", () => {
    const body = openRefundBody();
    const idx = body.indexOf("select * into v_source\n    from public.payment_checkout_attempts pca\n   where pca.payment_id = p_payment_id");
    expect(idx).toBeGreaterThan(0);
    const block = body.slice(idx, body.indexOf("for update;", idx) + "for update;".length);
    expect(block).toContain("pca.status = 'completed'");
    expect(block).toContain("pca.amount_expected_cents - coalesce((");
    expect(block).toContain("and pra2.status in ('succeeded', 'pending', 'requires_action')");
    expect(block).toContain(") > 0");
    expect(block).toContain("order by pca.created_at desc, pca.id desc");
    expect(block).toContain("limit 1");
  });

  it("requirement 17: exactly ONE attempt is ever selected (limit 1) — one refund action always maps to one Stripe charge/PaymentIntent, never split or aggregated", () => {
    const body = openRefundBody();
    const idx = body.indexOf("order by pca.created_at desc, pca.id desc\n   limit 1");
    expect(idx).toBeGreaterThan(0);
  });

  it("both refund-selection functions use the IDENTICAL tie-break policy (created_at DESC, id/attempt_id DESC) — they always agree on which single attempt is selected", () => {
    const refBody = refundableBody();
    const openBody = openRefundBody();
    expect(refBody).toContain("order by w.payment_id, w.created_at desc, w.attempt_id desc");
    expect(openBody).toContain("order by pca.created_at desc, pca.id desc");
  });

  it("the id tie-break is documented as a deterministic tie-break only, never a causal/financial ordering mechanism, at BOTH call sites", () => {
    const raw = readSource(MIGRATION_0157_PATH);
    const tieBreakOccurrences = raw.match(/ONLY a tie-break for equal timestamps/g) ?? [];
    const causalOccurrences = raw.match(/never a causal\/financial/g) ?? [];
    expect(tieBreakOccurrences.length).toBe(2);
    expect(causalOccurrences.length).toBe(2);
  });

  it("requirement 18: the payments row is locked FOR UPDATE before the attempt-resolution query — the canonical lock order fully serializes concurrent refund-opening calls for the same payment, so the attempt-selection query can never race a concurrent refund reservation", () => {
    const body = openRefundBody();
    const paymentsLockIdx = body.indexOf("select * into v_payment\n    from public.payments p");
    const resolutionIdx = body.indexOf("select * into v_source\n    from public.payment_checkout_attempts pca\n   where pca.payment_id = p_payment_id");
    expect(paymentsLockIdx).toBeGreaterThan(0);
    expect(resolutionIdx).toBeGreaterThan(paymentsLockIdx);
    expect(body.slice(paymentsLockIdx, paymentsLockIdx + 120)).toContain("for update");
  });

  it("requirement 19: the reuse-before-create pending-attempt branch is byte-identical to 0155 — existing refund idempotency (same-amount retry reuses the same attempt; different amount fails closed) is completely unchanged", () => {
    const body = openRefundBody();
    expect(body).toContain("if v_existing_pending.requested_amount_cents <> p_requested_amount_cents then");
    expect(body).toContain("raise exception 'pending_refund_amount_mismatch';");
  });

  it("every table reference is alias-qualified — pca/pra/pra2 throughout, no bare OUT-parameter-colliding column reference", () => {
    const body = openRefundBody();
    expect(body).toContain("from public.payment_checkout_attempts pca");
    expect(body).toContain("from public.payment_refund_attempts pra");
    expect(body).toContain("from public.payment_refund_attempts pra2");
    expect(body).not.toMatch(/[^.\w]where payment_id = /);
    expect(body).not.toMatch(/[^.\w]where status = /);
  });

  it("the final refundable ceiling check and INSERT are otherwise byte-identical to 0155 — only the attempt-resolution query itself changed", () => {
    const body = openRefundBody();
    expect(body).toContain("v_refundable := v_source.amount_expected_cents - v_reserved_total;");
    expect(body).toContain("raise exception 'refund_exceeds_online_remaining';");
    expect(body).toContain("insert into public.payment_refund_attempts as pra (");
    expect(body).toContain("returning pra.id into v_result_id;");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Requirement 11, 20 — no automatic refund is introduced; dispute
// behavior remains untouched.
// ═══════════════════════════════════════════════════════════════════════════

describe("no automatic refund; dispute behavior completely untouched", () => {
  it("0157 never inserts refund_recorded/online_refund_recorded and never calls Stripe (no such function exists in PL/pgSQL at all)", () => {
    const sql = sql0157();
    expect(sql).not.toMatch(/insert into public\.payment_events/);
    expect(sql).not.toMatch(/insert into public\.payment_refund_attempts \(/); // the corrected version uses `as pra (` for the alias form
  });

  it("0157 never references payment_disputes or process_stripe_dispute_webhook_event", () => {
    const sql = sql0157();
    expect(sql).not.toMatch(/payment_disputes/);
    expect(sql).not.toMatch(/process_stripe_dispute_webhook_event/);
  });

  it("0156's own dispute table/RPC text is unaffected", () => {
    expect(sql0156()).toContain("create table public.payment_disputes (");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Requirement 22, 23 — no new RETURNS TABLE ambiguity; grants unchanged
// except where an existing function replacement inherently preserves
// them (and is explicitly re-declared for the two functions that had
// explicit grants).
// ═══════════════════════════════════════════════════════════════════════════

describe("no new PL/pgSQL ambiguity; authorization/grants preserved exactly", () => {
  it("0157 redefines exactly THREE functions — one returns void, two are pre-existing RETURNS TABLE functions (not newly introduced)", () => {
    const sql = sql0157();
    const createCount = (sql.match(/create or replace function public\./g) ?? []).length;
    expect(createCount).toBe(3);
    const returnsTableCount = (sql.match(/returns table \(/g) ?? []).length;
    expect(returnsTableCount).toBe(2); // get_online_refundable_amount_for_payments, open_payment_refund_attempt
  });

  it("_recompute_payment_rollup still `returns void` — no OUT parameters, no ambiguity risk by construction", () => {
    const sql = sql0157();
    expect(sql).toMatch(/create or replace function public\._recompute_payment_rollup\(p_payment_id uuid\)\nreturns void/);
  });

  it("get_online_refundable_amount_for_payments and open_payment_refund_attempt keep their EXACT pre-0157 signatures and RETURNS TABLE shapes — no column added/removed/renamed", () => {
    const sql = sql0157();
    expect(sql).toContain("create or replace function public.get_online_refundable_amount_for_payments(\n  p_payment_ids uuid[]\n)\nreturns table (\n  payment_id       uuid,\n  refundable_cents integer,\n  currency          text\n)");
    expect(sql).toContain("create or replace function public.open_payment_refund_attempt(\n  p_payment_id             uuid,\n  p_club_id                uuid,\n  p_requested_amount_cents integer,\n  p_actor_id               uuid,\n  p_admin_reason           text default null\n)");
  });

  it("get_online_refundable_amount_for_payments' grants are re-declared identically: revoke from public/anon, grant to authenticated", () => {
    const sql = sql0157();
    expect(sql).toMatch(/revoke execute on function public\.get_online_refundable_amount_for_payments\(uuid\[\]\) from public, anon;/);
    expect(sql).toMatch(/grant {2}execute on function public\.get_online_refundable_amount_for_payments\(uuid\[\]\) to authenticated;/);
  });

  it("open_payment_refund_attempt's grants are re-declared identically: revoke from public/anon/authenticated, grant to service_role", () => {
    const sql = sql0157();
    expect(sql).toMatch(/revoke execute on function public\.open_payment_refund_attempt\(uuid, uuid, integer, uuid, text\) from public, anon, authenticated;/);
    expect(sql).toMatch(/grant {2}execute on function public\.open_payment_refund_attempt\(uuid, uuid, integer, uuid, text\) to service_role;/);
  });

  it("_recompute_payment_rollup has no grant re-declaration in 0157 — consistent with 0143's own established choice (revoke all from public, set once, never repeated by later CREATE OR REPLACE calls)", () => {
    const sql = sql0157();
    expect(sql).not.toMatch(/revoke.*_recompute_payment_rollup/);
    const sql143 = codeOnly(readSource(MIGRATION_0143_PATH));
    expect(sql143).toContain("revoke all on function public._recompute_payment_rollup(uuid) from public;");
  });

  it("0157 contains no grant/revoke/policy/table statement beyond the three functions' own re-declared grants — no widening of any role's access", () => {
    const sql = sql0157();
    const beginIdx = sql.indexOf("begin;");
    const commitIdx = sql.lastIndexOf("commit;");
    const executable = sql.slice(beginIdx, commitIdx);
    const grantLines = executable.match(/^(revoke|grant) .*/gm) ?? [];
    expect(grantLines.length).toBe(4); // 2 for refundable + 2 for open_refund_attempt
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Rollback completeness — all THREE functions, diffed against actual
// applied source, verified via a dedicated byte-comparison harness
// (see the manual `diff` verification described in the final report;
// these tests assert the structural markers that make that diff
// meaningful).
// ═══════════════════════════════════════════════════════════════════════════

describe("0157 rollback restores the exact pre-0157 bodies of all three changed functions", () => {
  it("the rollback section restores _recompute_payment_rollup's unconditional 'elsif v_waived then' (0153's own text, not the corrected condition)", () => {
    const raw = readSource(MIGRATION_0157_PATH);
    const rollbackIdx = raw.indexOf("-- Rollback (manual, cloud SQL Editor)");
    const rollback = raw.slice(rollbackIdx);
    expect(rollback).toContain("--   elsif v_waived then");
    expect(rollback).not.toMatch(/v_active_waiver_amount/);
  });

  it("the rollback section restores get_online_refundable_amount_for_payments' original single-latest-attempt 'latest' CTE (0154's own text, not the newest-refundable-first CTEs)", () => {
    const raw = readSource(MIGRATION_0157_PATH);
    const rollbackIdx = raw.indexOf("-- Rollback (manual, cloud SQL Editor)");
    const rollback = raw.slice(rollbackIdx);
    expect(rollback).toContain("--     latest as (");
    expect(rollback).not.toMatch(/attempts_with_remaining/);
  });

  it("the rollback section restores open_payment_refund_attempt's original unconditional latest-attempt resolution (0155's own text, not the remaining-refundable filter)", () => {
    const raw = readSource(MIGRATION_0157_PATH);
    const rollbackIdx = raw.indexOf("-- Rollback (manual, cloud SQL Editor)");
    const rollback = raw.slice(rollbackIdx);
    expect(rollback).toContain("--    where pca.payment_id = p_payment_id and pca.status = 'completed'");
    expect(rollback).not.toMatch(/pra2/);
  });

  it("the rollback is real executable SQL (three create-or-replace blocks + their grants), not placeholder prose", () => {
    const raw = readSource(MIGRATION_0157_PATH);
    const rollbackIdx = raw.indexOf("-- Rollback (manual, cloud SQL Editor)");
    const rollback = raw.slice(rollbackIdx);
    const createCount = (rollback.match(/-- create or replace function public\./g) ?? []).length;
    expect(createCount).toBe(3);
    expect(rollback).toContain("-- commit;");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 0158 — payment-internal helper privilege hardening. Live PostgreSQL
// evidence (post-0157) proved `revoke ... from public` alone is NOT
// sufficient: Supabase's own default-privileges mechanism grants EXECUTE
// to anon/authenticated/service_role EXPLICITLY at function-creation
// time, independent of any `revoke ... from public` a migration issues.
// These tests require explicit source-level revocation naming anon and
// authenticated by name — never accept a bare `from public` as proof.
// ═══════════════════════════════════════════════════════════════════════════

describe("0158 — the seven payment-internal helpers are explicitly revoked from public, anon, AND authenticated by name", () => {
  const TARGET_FUNCTIONS: { name: string; signature: string }[] = [
    { name: "_adjust_payment_obligation", signature: "uuid, text, uuid, uuid, integer, uuid" },
    { name: "_check_member_reassignment_allowed", signature: "uuid, text, uuid" },
    { name: "_create_payment_obligation", signature: "uuid, text, uuid, uuid, integer, uuid, boolean" },
    { name: "_enforce_currency_lock_on_payment_history", signature: "" },
    { name: "_payment_events_after_insert", signature: "" },
    { name: "_recompute_payment_rollup", signature: "uuid" },
    { name: "_validate_payment_event_reversal", signature: "" },
  ];

  it.each(TARGET_FUNCTIONS)(
    "public.$name($signature) is revoked from public, anon, AND authenticated by explicit name — never a bare 'from public' alone",
    ({ name, signature }) => {
      const sql = sql0158();
      const escapedSig = signature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const revokeRegex = new RegExp(
        `revoke execute on function public\\.${name}\\(${escapedSig}\\)\\s*\\n?\\s*from public, anon, authenticated;`,
      );
      expect(sql, `no matching explicit revoke found for ${name}(${signature})`).toMatch(revokeRegex);
      // The specific bug class this migration fixes: a bare `from public`
      // (no anon/authenticated named) would NOT actually revoke the live,
      // explicit per-role grants — reject that insufficient form outright.
      const bareFromPublicRegex = new RegExp(
        `revoke execute on function public\\.${name}\\(${escapedSig}\\)\\s*\\n?\\s*from public;`,
      );
      expect(sql).not.toMatch(bareFromPublicRegex);
    },
  );

  it("exactly seven revoke statements exist in 0158 — no other underscore helper (e.g. lesson-availability helpers) is touched", () => {
    const sql = sql0158();
    const beginIdx = sql.indexOf("begin;");
    const commitIdx = sql.indexOf("commit;");
    const executable = sql.slice(beginIdx, commitIdx);
    const revokeCount = (executable.match(/revoke execute on function/g) ?? []).length;
    expect(revokeCount).toBe(7);
  });

  it("service_role is NEVER revoked anywhere in 0158 — every revoke statement names only public, anon, authenticated", () => {
    const sql = sql0158();
    expect(sql).not.toMatch(/from public, anon, authenticated, service_role/);
    expect(sql).not.toMatch(/revoke execute on function public\._\w+\([^)]*\)\s*\n?\s*from[^;]*service_role/);
  });

  it("the intended post-0158 matrix (postgres+service_role: execute; anon+authenticated: none) is documented in the migration's own header", () => {
    const raw = readSource(MIGRATION_0158_PATH);
    expect(raw).toContain("service_role is left\n-- completely untouched");
  });

  it("0158 modifies NO function body — zero CREATE OR REPLACE, zero CREATE FUNCTION statements anywhere", () => {
    const sql = sql0158();
    expect(sql).not.toMatch(/create or replace function/);
    expect(sql).not.toMatch(/create function/);
  });

  it("0158 touches NO table, index, trigger, RLS policy, or default-privileges statement", () => {
    const sql = sql0158();
    const beginIdx = sql.indexOf("begin;");
    const commitIdx = sql.indexOf("commit;");
    const executable = sql.slice(beginIdx, commitIdx);
    expect(executable).not.toMatch(/create table|alter table|create index|create trigger|create policy/i);
    expect(executable).not.toMatch(/alter default privileges/i);
  });

  it("0158 grants nothing — it is a pure revocation migration", () => {
    const sql = sql0158();
    const beginIdx = sql.indexOf("begin;");
    const commitIdx = sql.indexOf("commit;");
    const executable = sql.slice(beginIdx, commitIdx);
    expect(executable).not.toMatch(/\bgrant\b/i);
  });

  it("0158 touches no OTHER function's grants — every revoked signature is one of the exact seven target functions", () => {
    const sql = sql0158();
    const revokedNames = [...sql.matchAll(/revoke execute on function public\.([a-zA-Z_]+)\(/g)].map((m) => m[1]);
    const allowedNames = TARGET_FUNCTIONS.map((f) => f.name);
    for (const revokedName of revokedNames) {
      expect(allowedNames, `unexpected function revoked: ${revokedName}`).toContain(revokedName);
    }
    expect(revokedNames.length).toBe(7);
  });

  it("the rollback re-grants exactly anon and authenticated (never service_role, which was never revoked) for all seven functions", () => {
    const raw = readSource(MIGRATION_0158_PATH);
    const rollbackIdx = raw.indexOf("-- Rollback (manual, cloud SQL Editor)");
    expect(rollbackIdx).toBeGreaterThan(0);
    const rollback = raw.slice(rollbackIdx);
    const grantCount = (rollback.match(/-- grant execute on function public\._\w+/g) ?? []).length;
    expect(grantCount).toBe(7);
    // No GRANT statement targets service_role (explanatory prose in the
    // header comment legitimately mentions the word — only the actual
    // `to ...` grant targets matter here).
    expect(rollback).not.toMatch(/to anon, authenticated, service_role/);
    expect(rollback).not.toMatch(/to service_role/);
    for (const { name } of TARGET_FUNCTIONS) {
      expect(rollback).toContain(`grant execute on function public.${name}(`);
      expect(rollback).toContain("to anon, authenticated;");
    }
  });

  it("0158 is a real executable statement (begin/commit), not placeholder prose", () => {
    const raw = readSource(MIGRATION_0158_PATH);
    expect(raw).toMatch(/^begin;$/m);
    expect(raw).toMatch(/^commit;$/m);
  });
});
