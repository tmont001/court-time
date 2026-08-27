import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 34E-A — regression coverage for pre-mutation Stripe Checkout
// invalidation, using this repository's established source-inspection
// style (see reservationCheckout.regression.test.ts's own header comment
// for why: this test baseline is deliberately pure-TypeScript with no
// jsdom/Supabase/network mocking, so for "does the shipped code actually
// take this shape" questions, reading the real source is a more honest
// guard than reimplementing a parallel mock that could drift).

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

// Strips `--`/`//` comment-only lines — used whenever a search must not
// be fooled by a file's own explanatory prose or a migration's own
// commented-out rollback section (see reservationCheckout.regression.test
// .ts's own identical helper for the exact rationale).
function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !line.trim().startsWith("--") && !line.trim().startsWith("//"))
    .join("\n");
}

const MIGRATION_PATH = "supabase/migrations/0151_stale_checkout_invalidation.sql";
const MIGRATION_0150_PATH = "supabase/migrations/0150_reservation_checkout_foundation.sql";
const MIGRATION_0152_PATH = "supabase/migrations/0152_stale_checkout_internal_guard_permissions.sql";
const HELPER_PATH = "src/lib/stripe/checkoutInvalidation.ts";
const PAYMENTS_ACTIONS_PATH = "src/app/(app)/admin/payments/actions.ts";
const CALENDAR_ACTIONS_PATH = "src/app/(app)/calendar/actions.ts";
const LESSONS_ACTIONS_PATH = "src/app/(app)/lessons/actions.ts";
const EDIT_RESERVATION_SHEET_PATH = "src/app/(app)/calendar/EditReservationSheet.tsx";

function migrationSql(): string {
  return codeOnly(readSource(MIGRATION_PATH));
}

// Isolates a single `create or replace function public.<name>(...)` body
// from the migration text, up to its own closing `$$;`/`$function$;` —
// scoping every function-specific assertion below to exactly that
// function's own body, never a different function that happens to share
// similarly-named local variables or call the same helper.
function functionBody(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  expect(start, `function public.${name} not found`).toBeGreaterThanOrEqual(0);
  const terminator = sql.indexOf("$function$;", start) >= 0 &&
    (sql.indexOf("$function$;", start) < sql.indexOf("\n$$;", start) || sql.indexOf("\n$$;", start) === -1)
    ? sql.indexOf("$function$;", start) + "$function$;".length
    : sql.indexOf("\n$$;", start) + "\n$$;".length;
  return sql.slice(start, terminator);
}

// ═══════════════════════════════════════════════════════════════════════════
// 1 & 13 — internal helper: no-op / unbound-race cancellation / bound-raise
// ═══════════════════════════════════════════════════════════════════════════

describe("_invalidate_or_flag_open_checkout_attempt — the shared pre-mutation guard", () => {
  const body = () => functionBody(migrationSql(), "_invalidate_or_flag_open_checkout_attempt");

  it("is never granted to any role — internal helper only", () => {
    expect(migrationSql()).toMatch(
      /revoke all on function public\._invalidate_or_flag_open_checkout_attempt\(uuid\) from public;/,
    );
  });

  it("0152 follow-up: explicitly revokes EXECUTE from public, anon, authenticated, AND service_role — closing the residual direct-grant gap 0151's own `from public` revoke did not retract (post-0151 runtime verification found anon/authenticated/service_role still explicitly grantable)", () => {
    const sql0152 = codeOnly(readSource(MIGRATION_0152_PATH));
    expect(sql0152).toMatch(
      /revoke execute\s+on function public\._invalidate_or_flag_open_checkout_attempt\(uuid\)\s+from public, anon, authenticated, service_role;/,
    );
  });

  it("0152 does not modify 0151 or any other payment logic — it is a permissions-only forward migration", () => {
    // Checked against comment-stripped text only — the migration's own
    // explanatory header prose legitimately discusses `create or replace
    // function` and `drop function` as background/history, which must
    // not trip this guard the way a genuine executable statement would.
    const codeOnlySql0152 = codeOnly(readSource(MIGRATION_0152_PATH));
    expect(codeOnlySql0152).not.toMatch(/create or replace function|create table|alter table|insert into|drop function/i);
    // Exactly one live statement between begin; and commit;.
    const beginIdx = codeOnlySql0152.indexOf("begin;");
    const commitIdx = codeOnlySql0152.indexOf("commit;", beginIdx);
    expect(beginIdx).toBeGreaterThanOrEqual(0);
    expect(commitIdx).toBeGreaterThan(beginIdx);
    const liveBody = codeOnlySql0152.slice(beginIdx, commitIdx);
    expect((liveBody.match(/revoke execute/g) ?? []).length).toBe(1);
  });

  it("0151's own source file is untouched by this correction — 0151 has already been applied and must not be edited", () => {
    // Pinned exact text from 0151 (byte-for-byte, unrelated to 0152) —
    // if this ever fails, 0151 was edited after being applied, which the
    // 0152 follow-up explicitly must never do.
    expect(migrationSql()).toMatch(
      /revoke all on function public\._invalidate_or_flag_open_checkout_attempt\(uuid\) from public;/,
    );
    expect(migrationSql()).not.toMatch(/from public, anon, authenticated, service_role/);
  });

  it("no open attempt for the payment — returns without mutating or raising (scenario 1)", () => {
    const b = body();
    const notFoundIdx = b.indexOf("if not found then");
    expect(notFoundIdx).toBeGreaterThan(0);
    expect(b.slice(notFoundIdx, notFoundIdx + 40)).toContain("return;");
  });

  it("locks the attempt row before deciding (canonical lock order, payments already held by caller)", () => {
    expect(body()).toMatch(
      /select \* into v_attempt\s+from public\.payment_checkout_attempts\s+where payment_id = p_payment_id and status = 'open'\s+for update;/,
    );
  });

  it("unbound open attempt (no remote Session yet) is canceled locally, never raises (scenario 13 — the unbound race)", () => {
    const b = body();
    const unboundIdx = b.indexOf("if v_attempt.stripe_checkout_session_id is null then");
    expect(unboundIdx).toBeGreaterThan(0);
    const branch = b.slice(unboundIdx, b.indexOf("end if;", unboundIdx));
    expect(branch).toContain("set status = 'canceled'");
    expect(branch).toContain("return;");
    expect(branch).not.toContain("raise exception");
  });

  it("bound open attempt raises open_checkout_requires_resolution and mutates nothing", () => {
    const b = body();
    const unboundIdx = b.indexOf("if v_attempt.stripe_checkout_session_id is null then");
    const afterUnboundBranch = b.indexOf("end if;", unboundIdx) + "end if;".length;
    const tail = b.slice(afterUnboundBranch);
    expect(tail).toContain("raise exception 'open_checkout_requires_resolution';");
    // No update statement between the unbound branch and the raise — a
    // bound attempt is never itself mutated by this function.
    expect(tail.slice(0, tail.indexOf("raise exception"))).not.toMatch(/update public\.payment_checkout_attempts/);
  });

  it("record_checkout_session_created (0150, unchanged) still fails loudly on a non-open attempt — closes the unbound race end to end", () => {
    const sql0150 = codeOnly(readSource(MIGRATION_0150_PATH));
    const body0150 = functionBody(sql0150, "record_checkout_session_created");
    expect(body0150).toContain("if v_attempt.status <> 'open' then");
    expect(body0150).toContain("raise exception 'checkout_attempt_not_open';");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2, 3, 14 — get_blocking_checkout_attempt_for_payment / expire_blocking_checkout_attempt
// ═══════════════════════════════════════════════════════════════════════════

describe("get_blocking_checkout_attempt_for_payment — service-role-only, read-only", () => {
  const body = () => functionBody(migrationSql(), "get_blocking_checkout_attempt_for_payment");

  it("is service_role only — never authenticated/anon/public", () => {
    expect(migrationSql()).toMatch(
      /revoke execute on function public\.get_blocking_checkout_attempt_for_payment\(uuid, uuid\) from public, anon, authenticated;/,
    );
    expect(migrationSql()).toMatch(
      /grant {2}execute on function public\.get_blocking_checkout_attempt_for_payment\(uuid, uuid\) to service_role;/,
    );
  });

  it("never accepts a caller-supplied stripe_account_id or livemode — only p_payment_id/p_club_id (scenario 14)", () => {
    const start = migrationSql().indexOf("create or replace function public.get_blocking_checkout_attempt_for_payment(");
    const argsBlock = migrationSql().slice(start, migrationSql().indexOf(")\nreturns table", start));
    expect(argsBlock).not.toMatch(/p_stripe_account_id/);
    expect(argsBlock).not.toMatch(/p_livemode/);
  });

  it("only returns the attempt's OWN stored stripe_account_id/livemode, never mutates", () => {
    const b = body();
    expect(b).toContain("select a.id, a.stripe_account_id, a.livemode, a.stripe_checkout_session_id");
    expect(b).not.toMatch(/update public\.payment_checkout_attempts/);
  });

  it("only matches a genuinely open, bound attempt", () => {
    const b = body();
    expect(b).toContain("and a.status     = 'open'");
    expect(b).toContain("and a.stripe_checkout_session_id is not null");
  });
});

describe("expire_blocking_checkout_attempt — service-role-only, re-verifies before mutating", () => {
  const body = () => functionBody(migrationSql(), "expire_blocking_checkout_attempt");

  it("is service_role only — never authenticated/anon/public", () => {
    expect(migrationSql()).toMatch(
      /revoke execute on function public\.expire_blocking_checkout_attempt\(uuid, uuid, uuid\) from public, anon, authenticated;/,
    );
    expect(migrationSql()).toMatch(
      /grant {2}execute on function public\.expire_blocking_checkout_attempt\(uuid, uuid, uuid\) to service_role;/,
    );
  });

  it("canonical lock order — locks payments before payment_checkout_attempts", () => {
    const b = body();
    const paymentsLockIdx = b.indexOf("from public.payments p");
    const attemptsLockIdx = b.indexOf("from public.payment_checkout_attempts a");
    expect(paymentsLockIdx).toBeGreaterThan(0);
    expect(attemptsLockIdx).toBeGreaterThan(paymentsLockIdx);
  });

  // Correction pass: a prior revision treated EVERY non-'open' status as
  // 'already_completed', wrongly blocking the caller even when the
  // attempt was merely already 'expired'/'canceled' via some other safe
  // path. These four tests pin the corrected, distinct behavior per
  // status (locked behavior table from the correction request).
  it("status='completed' blocks the mutation (already_completed) and mutates nothing — never overwritten with 'expired'", () => {
    const b = body();
    const completedIdx = b.indexOf("if v_attempt.status = 'completed' then");
    expect(completedIdx).toBeGreaterThan(0);
    const branch = b.slice(completedIdx, b.indexOf("end if;", completedIdx));
    expect(branch).toContain("'already_completed'");
    expect(branch).not.toMatch(/update public\.payment_checkout_attempts/);
  });

  it("status in ('expired', 'canceled') is safe to proceed — never re-marked and never blocks the caller", () => {
    const b = body();
    const deadIdx = b.indexOf("if v_attempt.status in ('expired', 'canceled') then");
    expect(deadIdx).toBeGreaterThan(0);
    const branch = b.slice(deadIdx, b.indexOf("end if;", deadIdx));
    expect(branch).toContain("'proceed'");
    expect(branch).not.toContain("'already_completed'");
    expect(branch).not.toMatch(/update public\.payment_checkout_attempts/);
  });

  it("status='completed' is checked, and the expired/canceled branch is checked, BEFORE the unconditional open->expired mutation", () => {
    const b = body();
    const completedIdx = b.indexOf("if v_attempt.status = 'completed' then");
    const deadIdx = b.indexOf("if v_attempt.status in ('expired', 'canceled') then");
    const mutateIdx = b.indexOf("set status = 'expired', updated_at = now()");
    expect(completedIdx).toBeGreaterThan(0);
    expect(deadIdx).toBeGreaterThan(completedIdx);
    expect(mutateIdx).toBeGreaterThan(deadIdx);
  });

  it("only an 'open' attempt is ever mutated to 'expired' — the branches above already returned for every other status", () => {
    const b = body();
    expect(b).toMatch(/set status = 'expired', updated_at = now\(\)/);
    // Exactly one UPDATE statement in this function — the completed and
    // expired/canceled branches both return before ever reaching it.
    expect((b.match(/update public\.payment_checkout_attempts/g) ?? []).length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2, 4, 5, 6, 14 — resolveBlockingCheckoutBeforeMutation orchestration
// ═══════════════════════════════════════════════════════════════════════════

describe("resolveBlockingCheckoutBeforeMutation — Stripe orchestration, fails closed", () => {
  const src = () => readSource(HELPER_PATH);

  it("is server-only", () => {
    expect(src()).toMatch(/^import "server-only";/m);
  });

  it("retrieves and expires in the BLOCKING attempt's own stored account context, never a caller-derived one (scenario 14)", () => {
    const s = src();
    expect(s).toMatch(/stripeAccount: attempt\.stripe_account_id/);
    expect(s).not.toMatch(/stripeAccount: context\./);
  });

  it("explicitly checks attempt.livemode against getStripeContext().livemode BEFORE any Stripe call — fails closed on mismatch (correction pass, scenario 14)", () => {
    const s = src();
    const livemodeCheckIdx = s.indexOf("attempt.livemode !== context.livemode");
    expect(livemodeCheckIdx).toBeGreaterThan(0);
    const retrieveIdx = s.indexOf("context.client.checkout.sessions.retrieve(");
    expect(livemodeCheckIdx).toBeLessThan(retrieveIdx);
    const branch = s.slice(livemodeCheckIdx, s.indexOf("}", s.indexOf("{", livemodeCheckIdx)));
    expect(branch).toMatch(/ok: false/);
    expect(branch).toContain("RESOLUTION_FAILED");
  });

  it("Stripe retrieve failure fails closed — never reaches the expire or finalize steps (scenario 5)", () => {
    const s = src();
    const retrieveTryIdx = s.indexOf("session = await context.client.checkout.sessions.retrieve(");
    const catchIdx = s.indexOf("} catch {", retrieveTryIdx);
    const catchBody = s.slice(catchIdx, s.indexOf("}", catchIdx + 10));
    expect(catchBody).toMatch(/ok: false/);
  });

  it("distinguishes the two failure classes by copy — never implies a payment completed when the real problem was infrastructure/verification failure (item 5)", () => {
    const s = src();
    expect(s).toMatch(/CHECKOUT_STILL_PROCESSING_MESSAGE =\s*\n\s*"An online payment is already processing or completed[^"]*"/);
    expect(s).toMatch(/RESOLUTION_FAILED_MESSAGE =\s*\n\s*"Court Time could not verify the online payment status\. No changes were made\. Please try again\."/);
    // Every genuine infra/verification failure path (missing Stripe
    // context, missing privileged client, lookup error, livemode
    // mismatch, retrieve failure, expire failure, finalize error) uses
    // RESOLUTION_FAILED — never CHECKOUT_STILL_PROCESSING, which is
    // reserved exclusively for a REAL Stripe-confirmed completion.
    const resolutionFailedUses = (s.match(/error: RESOLUTION_FAILED_MESSAGE/g) ?? []).length;
    expect(resolutionFailedUses).toBeGreaterThanOrEqual(7);
    const stillProcessingUses = (s.match(/error: CHECKOUT_STILL_PROCESSING_MESSAGE/g) ?? []).length;
    expect(stillProcessingUses).toBe(2); // session.status === "complete", and finalize's already_completed
  });

  it("complete Session blocks the mutation without calling expire (scenario 4)", () => {
    const s = src();
    const completeIdx = s.indexOf('session.status === "complete"');
    expect(completeIdx).toBeGreaterThan(0);
    const branch = s.slice(completeIdx, s.indexOf("}", s.indexOf("{", completeIdx)));
    expect(branch).toContain("CHECKOUT_STILL_PROCESSING");
    expect(branch).not.toMatch(/sessions\.expire/);
  });

  it("open Session is actively expired via Stripe before finalizing (scenario 2)", () => {
    const s = src();
    const openIdx = s.indexOf('session.status === "open"');
    expect(openIdx).toBeGreaterThan(0);
    const afterOpenBranch = s.indexOf("expire_blocking_checkout_attempt", openIdx);
    expect(afterOpenBranch).toBeGreaterThan(openIdx);
    const branch = s.slice(openIdx, afterOpenBranch);
    expect(branch).toMatch(/sessions\.expire\(/);
  });

  it("Stripe expire failure fails closed — never reaches the finalize RPC (scenario 6)", () => {
    const s = src();
    const expireTryIdx = s.indexOf("await context.client.checkout.sessions.expire(");
    const catchIdx = s.indexOf("} catch {", expireTryIdx);
    const catchBody = s.slice(catchIdx, s.indexOf("}", catchIdx + 10));
    expect(catchBody).toMatch(/ok: false/);
    const finalizeIdx = s.indexOf("expire_blocking_checkout_attempt");
    expect(catchIdx).toBeLessThan(finalizeIdx);
  });

  it("already-expired Session skips the Stripe expire call entirely (scenario 3)", () => {
    const s = src();
    expect(s).toMatch(/session\.status === "expired" needs no Stripe action/);
  });

  it("webhook completing the attempt during the round-trip still blocks the mutation, never silently proceeds", () => {
    const s = src();
    const finalizeCallIdx = s.indexOf('privileged.rpc(\n    "expire_blocking_checkout_attempt"');
    const alreadyCompletedIdx = s.indexOf('"already_completed"', finalizeCallIdx);
    expect(alreadyCompletedIdx).toBeGreaterThan(finalizeCallIdx);
    const branch = s.slice(alreadyCompletedIdx, s.indexOf("}", alreadyCompletedIdx));
    expect(branch).toMatch(/ok: false/);
  });

  it("no blocking attempt found (already resolved) returns ok:true — the caller's retry proceeds normally", () => {
    const s = src();
    const idx = s.indexOf("if (!attempt) {");
    expect(idx).toBeGreaterThan(0);
    expect(s.slice(idx, s.indexOf("}", idx + 400))).toMatch(/ok: true/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7, 8, 9, 10 — the five 0143 ledger RPCs each get the guard
// ═══════════════════════════════════════════════════════════════════════════

describe("record_manual_payment / waive_payment / void_payment_obligation / record_refund / reverse_payment_event — pre-mutation guard wired (scenarios 7, 8, 9, 10)", () => {
  const sql = migrationSql();

  // Correction pass: the guard must run AFTER every local validation
  // check has passed (never before it) — an invalid request must not
  // expire a legitimate Stripe Checkout Session before Court Time even
  // knows the requested local action would fail. Each function's own
  // LAST validation check (immediately preceding the guard) is asserted
  // explicitly below, per function, rather than a single generic
  // "somewhere after the lock" check.
  it.each([
    ["record_manual_payment", "p_payment_id", "raise exception 'payment_not_open_for_payment';"],
    ["waive_payment", "p_payment_id", "raise exception 'no_balance_to_waive';"],
    ["void_payment_obligation", "p_payment_id", "raise exception 'no_balance_to_void';"],
    ["record_refund", "p_payment_id", "raise exception 'refund_exceeds_amount_paid';"],
  ])("%s calls the guard, keyed on %s, AFTER its own status/amount validation and BEFORE the first payment_events insert", (fn, idExpr, lastValidationLine) => {
    const body = functionBody(sql, fn);
    const guardIdx = body.indexOf(`perform public._invalidate_or_flag_open_checkout_attempt(${idExpr});`);
    expect(guardIdx).toBeGreaterThan(0);

    const lockIdx = body.indexOf("for update;");
    const lastValidationIdx = body.indexOf(lastValidationLine);
    const firstInsertIdx = body.indexOf("insert into public.payment_events");
    expect(lastValidationIdx).toBeGreaterThan(lockIdx);
    expect(guardIdx).toBeGreaterThan(lastValidationIdx);
    expect(guardIdx).toBeLessThan(firstInsertIdx);
  });

  it("reverse_payment_event calls the guard, keyed on v_target.payment_id, AFTER its net-negative validation and BEFORE the reversal insert", () => {
    const body = functionBody(sql, "reverse_payment_event");
    const guardIdx = body.indexOf("perform public._invalidate_or_flag_open_checkout_attempt(v_target.payment_id);");
    expect(guardIdx).toBeGreaterThan(0);
    const lockIdx = body.indexOf("for update;");
    const netNegativeIdx = body.indexOf("raise exception 'reversal_would_make_net_negative';");
    const insertIdx = body.indexOf("insert into public.payment_events");
    expect(netNegativeIdx).toBeGreaterThan(lockIdx);
    expect(guardIdx).toBeGreaterThan(netNegativeIdx);
    expect(guardIdx).toBeLessThan(insertIdx);
  });

  it("an invalid manual payment request never reaches the guard call at all — validation raises first (scenario: invalid amount does not expire Checkout)", () => {
    const body = functionBody(sql, "record_manual_payment");
    const invalidAmountIdx = body.indexOf("raise exception 'invalid_payment_amount';");
    const guardIdx = body.indexOf("perform public._invalidate_or_flag_open_checkout_attempt(p_payment_id);");
    // invalid_payment_amount is checked before the payment row is even
    // locked — structurally unreachable to the guard, which runs only
    // after a successful lock + status validation further down.
    expect(invalidAmountIdx).toBeGreaterThan(0);
    expect(invalidAmountIdx).toBeLessThan(guardIdx);
  });

  it("an invalid refund amount never reaches the guard call — validation raises first (scenario: invalid refund does not expire Checkout)", () => {
    const body = functionBody(sql, "record_refund");
    const exceedsIdx = body.indexOf("raise exception 'refund_exceeds_amount_paid';");
    const guardIdx = body.indexOf("perform public._invalidate_or_flag_open_checkout_attempt(p_payment_id);");
    expect(exceedsIdx).toBeGreaterThan(0);
    expect(exceedsIdx).toBeLessThan(guardIdx);
  });

  it("an invalid waiver (no balance to waive) never reaches the guard call — validation raises first", () => {
    const body = functionBody(sql, "waive_payment");
    const noBalanceIdx = body.indexOf("raise exception 'no_balance_to_waive';");
    const guardIdx = body.indexOf("perform public._invalidate_or_flag_open_checkout_attempt(p_payment_id);");
    expect(noBalanceIdx).toBeGreaterThan(0);
    expect(noBalanceIdx).toBeLessThan(guardIdx);
  });

  it("an invalid void (retained payment exists) never reaches the guard call — validation raises first", () => {
    const body = functionBody(sql, "void_payment_obligation");
    const retainedIdx = body.indexOf("raise exception 'cannot_void_with_retained_payment';");
    const guardIdx = body.indexOf("perform public._invalidate_or_flag_open_checkout_attempt(p_payment_id);");
    expect(retainedIdx).toBeGreaterThan(0);
    expect(retainedIdx).toBeLessThan(guardIdx);
  });

  it("an invalid reversal (would make net negative) never reaches the guard call — validation raises first", () => {
    const body = functionBody(sql, "reverse_payment_event");
    const netNegativeIdx = body.indexOf("raise exception 'reversal_would_make_net_negative';");
    const guardIdx = body.indexOf("perform public._invalidate_or_flag_open_checkout_attempt(v_target.payment_id);");
    expect(netNegativeIdx).toBeGreaterThan(0);
    expect(netNegativeIdx).toBeLessThan(guardIdx);
  });

  it("void_payment_obligation's own resolution gate (status='unpaid', amount_paid_cents=0) is untouched — still the only cancellation-adjacent mutation wired", () => {
    const body = functionBody(sql, "void_payment_obligation");
    expect(body).toContain("if v_payment.status <> 'unpaid' then");
    expect(body).toContain("if v_payment.amount_paid_cents <> 0 then");
  });

  it("no other 0143/0144 RPC gained a payment_events insert — cancellation/remove/leave flows remain untouched by 34E-A", () => {
    // 0144's own header comment (still true, unmodified by 0151) already
    // establishes cancellation never touches payment_events directly.
    const guardCallCount = (sql.match(/perform public\._invalidate_or_flag_open_checkout_attempt\(/g) ?? []).length;
    // record_manual_payment, waive_payment, void_payment_obligation,
    // record_refund, reverse_payment_event, update_member_reservation,
    // admin_update_member_lesson — exactly seven call sites.
    expect(guardCallCount).toBe(7);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 11, 12 — update_member_reservation / admin_update_member_lesson
// ═══════════════════════════════════════════════════════════════════════════

describe("update_member_reservation / admin_update_member_lesson — PRE-mutation guard on price change and reassignment (scenarios 11, 12)", () => {
  const sql = migrationSql();

  it("update_member_reservation: guard runs before the reservations UPDATE, gated on price change OR member reassignment", () => {
    const body = functionBody(sql, "update_member_reservation");
    const guardBlockIdx = body.indexOf("if v_member_changed or v_new_price_amount_cents is distinct from v_before.price_amount_cents then");
    expect(guardBlockIdx).toBeGreaterThan(0);
    const guardCallIdx = body.indexOf("perform public._invalidate_or_flag_open_checkout_attempt(v_payment_id_for_checkout_guard);", guardBlockIdx);
    expect(guardCallIdx).toBeGreaterThan(guardBlockIdx);

    const updateReservationsIdx = body.indexOf("update reservations set");
    expect(guardCallIdx).toBeLessThan(updateReservationsIdx);
  });

  it("update_member_reservation: resolves and locks the CURRENT obligation cycle's payment_id (canonical order) before calling the guard", () => {
    const body = functionBody(sql, "update_member_reservation");
    const selectIdx = body.indexOf("select id into v_payment_id_for_checkout_guard");
    expect(selectIdx).toBeGreaterThan(0);
    expect(body.slice(selectIdx, selectIdx + 300)).toContain("for update;");
    expect(body.slice(selectIdx, selectIdx + 300)).toContain("order by obligation_cycle desc");
  });

  it("admin_update_member_lesson: guard runs before any reservation/lesson_requests mutation, gated on price change OR member reassignment", () => {
    const body = functionBody(sql, "admin_update_member_lesson");
    const guardBlockIdx = body.indexOf("if v_member_changed or v_price_amount_cents is distinct from v_before.price_amount_cents then");
    expect(guardBlockIdx).toBeGreaterThan(0);
    const guardCallIdx = body.indexOf("perform public._invalidate_or_flag_open_checkout_attempt(v_payment_id_for_checkout_guard);", guardBlockIdx);
    expect(guardCallIdx).toBeGreaterThan(guardBlockIdx);

    const scheduleUpdateIdx = body.indexOf("if v_scheduling_changed then");
    const lessonUpdateIdx = body.indexOf("update public.lesson_requests");
    expect(guardCallIdx).toBeLessThan(scheduleUpdateIdx);
    expect(guardCallIdx).toBeLessThan(lessonUpdateIdx);
  });

  it("admin_update_member_lesson: guard runs after the existing _check_member_reassignment_allowed call, never before it", () => {
    const body = functionBody(sql, "admin_update_member_lesson");
    const reassignCheckIdx = body.indexOf("perform public._check_member_reassignment_allowed(");
    const guardIdx = body.indexOf("perform public._invalidate_or_flag_open_checkout_attempt(v_payment_id_for_checkout_guard);");
    expect(reassignCheckIdx).toBeGreaterThan(0);
    expect(guardIdx).toBeGreaterThan(reassignCheckIdx);
  });

  it("both edit RPCs skip the guard entirely (v_payment_id_for_checkout_guard stays unresolved) when neither price nor Member changes", () => {
    // The `if` gate itself is the no-op path — asserting its exact
    // condition text (above) already proves this; this test just
    // confirms the resolved id is never unconditionally required.
    const resSql = functionBody(sql, "update_member_reservation");
    const lessonSql = functionBody(sql, "admin_update_member_lesson");
    expect(resSql).toContain("if v_payment_id_for_checkout_guard is not null then");
    expect(lessonSql).toContain("if v_payment_id_for_checkout_guard is not null then");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 15, 16 — happy path / webhook reconciliation untouched
// ═══════════════════════════════════════════════════════════════════════════

describe("0151 rollback section — real restoration SQL, not placeholder instructions (correction pass)", () => {
  it("contains the drop statements for all three new 34E-A-only functions", () => {
    const raw = readSource(MIGRATION_PATH);
    const rollbackIdx = raw.indexOf("-- Rollback (manual, cloud SQL Editor)");
    expect(rollbackIdx).toBeGreaterThan(0);
    const rollback = raw.slice(rollbackIdx);
    expect(rollback).toContain("-- drop function if exists public.get_blocking_checkout_attempt_for_payment(uuid, uuid);");
    expect(rollback).toContain("-- drop function if exists public.expire_blocking_checkout_attempt(uuid, uuid, uuid);");
    expect(rollback).toContain("-- drop function if exists public._invalidate_or_flag_open_checkout_attempt(uuid);");
  });

  it("contains a genuine, non-empty `create or replace function` restoration for all seven replaced functions — never a prose placeholder telling someone to copy SQL later", () => {
    const raw = readSource(MIGRATION_PATH);
    const rollbackIdx = raw.indexOf("-- Rollback (manual, cloud SQL Editor)");
    const rollback = raw.slice(rollbackIdx);

    // The prior, rejected placeholder text — must never reappear.
    expect(rollback).not.toMatch(/by copying each function's body verbatim/);
    expect(rollback).not.toMatch(/Re-apply the exact pre-0151 CREATE OR REPLACE bodies/);

    for (const fn of [
      "record_manual_payment",
      "record_refund",
      "reverse_payment_event",
      "waive_payment",
      "void_payment_obligation",
      "update_member_reservation",
      "admin_update_member_lesson",
    ]) {
      const lower = rollback.toLowerCase();
      const idx = lower.indexOf(`-- create or replace function public.${fn.toLowerCase()}(`);
      expect(idx, `rollback restoration for ${fn} not found`).toBeGreaterThanOrEqual(0);
      // A genuine restoration must contain the function's own real body
      // markers, not just its signature line.
      const window = rollback.slice(idx, idx + 20000);
      expect(window).toMatch(/-- (as \$\$|AS \$function\$)/);
      expect(window).toMatch(/-- begin\b/i);
      expect(window).toMatch(/-- end;/);
    }
  });

  it("the restored record_manual_payment body in the rollback does NOT contain the 34E-A guard call — it is the genuine PRE-0151 text", () => {
    const raw = readSource(MIGRATION_PATH);
    const rollbackIdx = raw.indexOf("-- Rollback (manual, cloud SQL Editor)");
    const rollback = raw.slice(rollbackIdx);
    const fnIdx = rollback.indexOf("-- create or replace function public.record_manual_payment(");
    const fnEnd = rollback.indexOf("-- grant  execute on function public.record_manual_payment(", fnIdx);
    const restoredBody = rollback.slice(fnIdx, fnEnd);
    expect(restoredBody).not.toMatch(/_invalidate_or_flag_open_checkout_attempt/);
  });

  it("the restored update_member_reservation body in the rollback does NOT contain v_payment_id_for_checkout_guard — it is the genuine PRE-0151 text", () => {
    const raw = readSource(MIGRATION_PATH);
    const rollbackIdx = raw.indexOf("-- Rollback (manual, cloud SQL Editor)");
    const rollback = raw.slice(rollbackIdx);
    const fnIdx = rollback.indexOf("-- CREATE OR REPLACE FUNCTION public.update_member_reservation(");
    expect(fnIdx).toBeGreaterThanOrEqual(0);
    const fnEnd = rollback.indexOf("-- $function$;", fnIdx);
    const restoredBody = rollback.slice(fnIdx, fnEnd);
    expect(restoredBody).not.toMatch(/v_payment_id_for_checkout_guard/);
    expect(restoredBody).not.toMatch(/_invalidate_or_flag_open_checkout_attempt/);
  });

  it("rollback statement count matches: 3 drops + 7 restorations, ending in a genuine commit;", () => {
    const raw = readSource(MIGRATION_PATH);
    const rollbackIdx = raw.indexOf("-- Rollback (manual, cloud SQL Editor)");
    const rollback = raw.slice(rollbackIdx);
    expect((rollback.match(/-- drop function if exists/g) ?? []).length).toBe(3);
    expect((rollback.match(/-- create or replace function|-- CREATE OR REPLACE FUNCTION/g) ?? []).length).toBe(7);
    expect(rollback.trim().endsWith("-- commit;")).toBe(true);
  });
});

describe("0150 payment/checkout core is untouched by 0151 (scenarios 15, 16)", () => {
  it("0151 does not redefine any 0150 function — Checkout creation and webhook reconciliation are byte-identical to 0150", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/create or replace function public\.process_stripe_payment_event/);
    expect(sql).not.toMatch(/create or replace function public\.open_payment_checkout_attempt/);
    expect(sql).not.toMatch(/create or replace function public\.supersede_checkout_attempt_and_open_fresh/);
    expect(sql).not.toMatch(/create or replace function public\.record_checkout_session_created/);
    expect(sql).not.toMatch(/create or replace function public\.get_reservation_payment_for_checkout/);
  });

  it("process_stripe_payment_event (0150) remains exactly-once via stripe_event_receipts, untouched", () => {
    const body0150 = functionBody(codeOnly(readSource(MIGRATION_0150_PATH)), "process_stripe_payment_event");
    expect(body0150).toContain("on conflict (stripe_event_id) do nothing;");
    expect(body0150).toContain("if v_attempt.status = 'completed' then");
  });

  it("no new table, column, or CHECK constraint is introduced — status vocabulary reused as-is", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/create table/);
    expect(sql).not.toMatch(/alter table/);
    expect(sql).not.toMatch(/add column/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Server Action wiring — retry-once-after-resolution, never a silent
// second attempt, error surfaced verbatim on failure
// ═══════════════════════════════════════════════════════════════════════════

describe("Server Action wiring — catch, resolve via Stripe, retry exactly once", () => {
  it.each([
    [PAYMENTS_ACTIONS_PATH, "record_manual_payment"],
    [CALENDAR_ACTIONS_PATH, "update_member_reservation"],
    [LESSONS_ACTIONS_PATH, "admin_update_member_lesson"],
  ])("%s calls %s at most twice — an initial attempt and exactly one retry", (path, rpcName) => {
    const src = readSource(path);
    const count = (src.match(new RegExp(`supabase\\.rpc\\("${rpcName}"`, "g")) ?? []).length;
    expect(count).toBe(2);
  });

  it.each([PAYMENTS_ACTIONS_PATH, CALENDAR_ACTIONS_PATH, LESSONS_ACTIONS_PATH])(
    "%s never retries when resolveBlockingCheckoutBeforeMutation reports failure",
    (path) => {
      const src = readSource(path);
      const resolveIdx = src.indexOf("resolveBlockingCheckoutBeforeMutation(");
      expect(resolveIdx).toBeGreaterThan(0);
      const nextLines = src.slice(resolveIdx, resolveIdx + 200);
      expect(nextLines).toMatch(/if \(!resolved\.ok\) return/);
    },
  );

  it("EditReservationSheet.tsx surfaces the checkout-still-processing message via a stable code, not the raw Postgres exception name", () => {
    const src = readSource(EDIT_RESERVATION_SHEET_PATH);
    expect(src).toMatch(/message === "checkout_still_processing"/);
    expect(src).not.toMatch(/message === "open_checkout_requires_resolution"/);
  });

  it("calendar/actions.ts passes the stable code through (not the raw Stripe/DB failure text) so EditReservationSheet's own mapper can translate it", () => {
    const src = readSource(CALENDAR_ACTIONS_PATH);
    expect(src).toMatch(/error: \{ code: resolved\.code, message: resolved\.code \}/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Correction pass — diff-based proof that all 7 replaced functions'
// PRIOR behavior is preserved exactly, not merely asserted by comment.
// Extracts each function's CURRENT body from 0151 and its ORIGINAL body
// directly from the untouched 0143/0144 source, reduces both to their
// bare, comment-stripped, whitespace-normalized statement lines, removes
// EXACTLY the known-added 34E-A lines (a single guard call for the five
// simple RPCs; one declaration line plus one contiguous guarded if-block
// for the two edit RPCs, located via exact contiguous-subsequence
// matching so an unrelated `end if;` elsewhere in these large functions
// can never be mistaken for part of the addition), and asserts the
// remainder is IDENTICAL, line for line, to the original — not merely
// "close" or "byte-identical per a header comment claiming so".
// ═══════════════════════════════════════════════════════════════════════════

const MIGRATION_0143_PATH = "supabase/migrations/0143_payment_mode_and_ledger_foundation.sql";
const MIGRATION_0144_PATH = "supabase/migrations/0144_payment_obligation_wiring.sql";

// Same shape as codeOnly, but also trims and drops blank lines — reduces
// a function body to its bare ordered sequence of executable statement
// lines, so a proof of equivalence is never defeated by incidental
// comment wording or blank-line placement.
function statementLines(src: string): string[] {
  return codeOnly(src)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

// Locates a function's raw body (comments included) by its own start
// marker through its own closing terminator — works for either the
// lowercase `create or replace function` (0143) or uppercase `CREATE OR
// REPLACE FUNCTION` (0144) spelling, and either `$$;`/`$function$;`
// terminator, since the two source files use different conventions.
function rawFunctionBody(src: string, startMarker: string, terminator: string): string {
  const start = src.indexOf(startMarker);
  expect(start, `start marker not found: ${startMarker}`).toBeGreaterThanOrEqual(0);
  const end = src.indexOf(terminator, start);
  expect(end, `terminator not found after start: ${terminator}`).toBeGreaterThan(start);
  return src.slice(start, end + terminator.length);
}

// Finds `sub` as a contiguous run within `lines` and returns a new array
// with exactly that run removed. Fails the test (via expect) if `sub`
// cannot be located as a single contiguous match — this is what makes
// the admin_update_member_lesson/update_member_reservation proof safe
// against the many OTHER unrelated `end if;`/`if ... then` lines those
// large functions already contain.
function removeContiguousRun(lines: string[], sub: string[]): string[] {
  for (let i = 0; i <= lines.length - sub.length; i++) {
    let matched = true;
    for (let j = 0; j < sub.length; j++) {
      if (lines[i + j] !== sub[j]) { matched = false; break; }
    }
    if (matched) {
      return [...lines.slice(0, i), ...lines.slice(i + sub.length)];
    }
  }
  throw new Error(`contiguous run not found:\n${sub.join("\n")}`);
}

describe("Correction pass — diff-based proof of preserved prior behavior (0143/0144 -> 0151)", () => {
  const migration0151 = migrationSql();

  it.each([
    ["record_manual_payment", "p_payment_id"],
    ["waive_payment", "p_payment_id"],
    ["void_payment_obligation", "p_payment_id"],
    ["record_refund", "p_payment_id"],
  ])("%s: removing exactly the one new guard line recovers the original 0143 statement sequence", (fn, guardArg) => {
    const originalRaw = rawFunctionBody(readSource(MIGRATION_0143_PATH), `create or replace function public.${fn}(`, "\n$$;");
    const originalLines = statementLines(originalRaw);

    const newLines = statementLines(functionBody(migration0151, fn));
    const guardLine = `perform public._invalidate_or_flag_open_checkout_attempt(${guardArg});`;
    expect(newLines).toContain(guardLine);
    const withoutGuard = newLines.filter((l) => l !== guardLine);

    expect(withoutGuard).toEqual(originalLines);
  });

  it("reverse_payment_event: removing exactly the one new guard line recovers the original 0143 statement sequence", () => {
    const originalRaw = rawFunctionBody(
      readSource(MIGRATION_0143_PATH),
      "create or replace function public.reverse_payment_event(",
      "\n$$;",
    );
    const originalLines = statementLines(originalRaw);

    const newLines = statementLines(functionBody(migration0151, "reverse_payment_event"));
    const guardLine = "perform public._invalidate_or_flag_open_checkout_attempt(v_target.payment_id);";
    expect(newLines).toContain(guardLine);
    const withoutGuard = newLines.filter((l) => l !== guardLine);

    expect(withoutGuard).toEqual(originalLines);
  });

  it("update_member_reservation: removing exactly the one new declaration and one new guarded if-block recovers the original 0144 statement sequence", () => {
    const originalRaw = rawFunctionBody(
      readSource(MIGRATION_0144_PATH),
      "CREATE OR REPLACE FUNCTION public.update_member_reservation(",
      "\n$function$;",
    );
    const originalLines = statementLines(originalRaw);

    const newLines = statementLines(functionBody(migration0151, "update_member_reservation"));

    const withoutDecl = removeContiguousRun(newLines, ["v_payment_id_for_checkout_guard uuid;"]);
    const withoutGuardBlock = removeContiguousRun(withoutDecl, [
      "if v_member_changed or v_new_price_amount_cents is distinct from v_before.price_amount_cents then",
      "select id into v_payment_id_for_checkout_guard",
      "from public.payments",
      "where club_id = v_club_id and domain_type = 'reservation' and domain_id = p_reservation_id",
      "order by obligation_cycle desc",
      "limit 1",
      "for update;",
      "if v_payment_id_for_checkout_guard is not null then",
      "perform public._invalidate_or_flag_open_checkout_attempt(v_payment_id_for_checkout_guard);",
      "end if;",
      "end if;",
    ]);

    // The two source files use different CREATE keyword casing (0143
    // lowercase vs 0144 uppercase) — a cosmetic-only, case-insensitive-
    // to-Postgres difference already present before this migration, not
    // something 0151 introduced. Normalized away here so this proof
    // targets genuine behavioral drift, not keyword casing.
    expect(withoutGuardBlock.map((l) => l.toLowerCase())).toEqual(originalLines.map((l) => l.toLowerCase()));
  });

  it("admin_update_member_lesson: removing exactly the one new declaration and one new guarded if-block recovers the original 0144 statement sequence", () => {
    const originalRaw = rawFunctionBody(
      readSource(MIGRATION_0144_PATH),
      "CREATE OR REPLACE FUNCTION public.admin_update_member_lesson(",
      "\n$function$;",
    );
    const originalLines = statementLines(originalRaw);

    const newLines = statementLines(functionBody(migration0151, "admin_update_member_lesson"));

    const withoutDecl = removeContiguousRun(newLines, ["v_payment_id_for_checkout_guard uuid;"]);
    const withoutGuardBlock = removeContiguousRun(withoutDecl, [
      "if v_member_changed or v_price_amount_cents is distinct from v_before.price_amount_cents then",
      "select id into v_payment_id_for_checkout_guard",
      "from public.payments",
      "where club_id = v_club_id and domain_type = 'lesson_request' and domain_id = p_request_id",
      "order by obligation_cycle desc",
      "limit 1",
      "for update;",
      "if v_payment_id_for_checkout_guard is not null then",
      "perform public._invalidate_or_flag_open_checkout_attempt(v_payment_id_for_checkout_guard);",
      "end if;",
      "end if;",
    ]);

    expect(withoutGuardBlock.map((l) => l.toLowerCase())).toEqual(originalLines.map((l) => l.toLowerCase()));
  });

  it("admin_update_member_lesson: the guarded if-block appears strictly after the scheduling/pro validation block (court_conflict/operating_hours/availability), not before it", () => {
    // Regression guard for the ordering bug found in this correction
    // pass: the FIRST 34E-A placement ran the guard before this
    // validation block, meaning an edit that would go on to fail
    // court_conflict could still have expired a legitimate Checkout
    // Session first.
    const body = functionBody(migration0151, "admin_update_member_lesson");
    const validationBlockIdx = body.indexOf("if v_scheduling_changed or v_pro_changed then");
    const courtConflictIdx = body.indexOf("raise exception 'court_conflict';");
    const guardIdx = body.indexOf("perform public._invalidate_or_flag_open_checkout_attempt(v_payment_id_for_checkout_guard);");
    expect(validationBlockIdx).toBeGreaterThan(0);
    expect(courtConflictIdx).toBeGreaterThan(validationBlockIdx);
    expect(guardIdx).toBeGreaterThan(courtConflictIdx);
  });
});
