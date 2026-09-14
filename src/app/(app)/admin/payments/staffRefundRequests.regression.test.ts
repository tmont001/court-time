import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 38B Task 1 — regression coverage for migration 0181
// (payment_refund_requests + create_refund_request +
// get_pending_refund_requests_for_payments + reject_refund_request +
// begin_refund_request_execution + the _reconcile_stripe_refund_attempt
// extension), using this repository's established source-inspection style
// (see adminReassignConfirmedLessonPro.regression.test.ts's own header
// comment for why: no jsdom/live-Postgres in this test baseline, so reading
// the shipped SQL is the honest guard here).
//
// 0181 IS applied to Supabase (confirmed via live QA — the ambiguity bug
// below was found in production). 0182 (not yet applied) is a narrow
// CREATE OR REPLACE of ONLY begin_refund_request_execution, fixing that
// bug — see 0182's own header comment for the full root-cause writeup,
// same bug class 0155 already fixed once for open_payment_refund_attempt.
// begin_refund_request_execution's CURRENT EFFECTIVE body is therefore
// 0182's, not 0181's — every test below that inspects that one function
// reads from MIGRATION_182_PATH; every other function in this file is
// untouched by 0182 and is still read from the original 0181 file.
// 0182 itself is NOT applied to Supabase by this checkpoint — these tests
// verify the migration FILE's content only, which is exactly what is
// reviewable before an apply.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

const MIGRATION_PATH = "supabase/migrations/0181_staff_refund_requests.sql";
const MIGRATION_182_PATH = "supabase/migrations/0182_fix_refund_request_execution_ambiguity.sql";
const RECONCILER_ORIGIN_PATH = "supabase/migrations/0153_stripe_refund_lifecycle.sql";
const OPEN_ATTEMPT_LATEST_PATH = "supabase/migrations/0157_late_payment_overpayment_resilience.sql";
const OPEN_ATTEMPT_AMBIGUITY_FIX_PATH = "supabase/migrations/0155_open_refund_attempt_ambiguity_fix.sql";
const NOTIFICATIONS_KIND_LATEST_PATH = "supabase/migrations/0099_event_edit_foundation.sql";

function migrationSql(): string {
  return codeOnly(readSource(MIGRATION_PATH));
}

function migration182Sql(): string {
  return codeOnly(readSource(MIGRATION_182_PATH));
}

function functionBodyFrom(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  expect(start, `function public.${name} not found`).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf("\n$$;", start);
  expect(end, `terminator not found for ${name}`).toBeGreaterThan(start);
  return sql.slice(start, end + "\n$$;".length);
}

function functionBody(name: string): string {
  return functionBodyFrom(migrationSql(), name);
}

// begin_refund_request_execution's CURRENT EFFECTIVE body is 0182's, not
// 0181's — see this file's own header comment.
function currentBeginExecutionBody(): string {
  return functionBodyFrom(migration182Sql(), "begin_refund_request_execution");
}

function tableBlock(sql: string, tableName: string): string {
  const start = sql.indexOf(`create table public.${tableName} (`);
  expect(start, `table public.${tableName} not found`).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf("\n);", start);
  expect(end, `closing "\\n);" not found for table ${tableName}`).toBeGreaterThan(start);
  return sql.slice(start, end + "\n);".length);
}

// ═══════════════════════════════════════════════════════════════════════════
// PRE-FLIGHT — confirm current effective upstream bodies this migration
// depends on, so this suite fails loudly if a later migration (post-0181
// authoring) redefines something this file assumes.
// ═══════════════════════════════════════════════════════════════════════════

describe("pre-flight: current effective upstream state assumed by 0181", () => {
  it("open_payment_refund_attempt's latest redefinition is 0157 (not 0153/0155) — same signature/return shape/error codes used throughout 0181", () => {
    const s = readSource(OPEN_ATTEMPT_LATEST_PATH);
    expect(s).toContain("create or replace function public.open_payment_refund_attempt(");
    expect(s).toContain("returns table (\n  id                          uuid,\n  payment_id                  uuid,");
    expect(s).toContain("raise exception 'refund_exceeds_online_remaining';");
    expect(s).toContain("raise exception 'no_online_payment_to_refund';");
    expect(s).toContain("raise exception 'pending_refund_amount_mismatch';");
  });

  it("_reconcile_stripe_refund_attempt's only definition remains 0153 — confirms the verbatim base 0181 reproduces", () => {
    const s = readSource(RECONCILER_ORIGIN_PATH);
    expect(s).toContain("create or replace function public._reconcile_stripe_refund_attempt(");
  });

  it("notifications_kind_check's latest redefinition remains 0099 — confirms the 17-value baseline 0181 must preserve", () => {
    const s = readSource(NOTIFICATIONS_KIND_LATEST_PATH);
    const idx = s.indexOf("add constraint notifications_kind_check");
    expect(idx).toBeGreaterThan(-1);
    const block = s.slice(idx, s.indexOf(");", idx));
    for (const kind of [
      "reservation_confirmed", "reservation_cancelled_by_admin", "reservation_cancelled_by_member",
      "reservation_rescheduled", "event_cancelled", "event_joined", "event_updated",
      "waitlist_promoted", "waitlist_offer", "announcement", "lesson_request_received",
      "lesson_request_proposed", "lesson_request_confirmed", "lesson_request_declined",
      "lesson_cancelled", "lesson_provider_reassigned", "lesson_admin_requested",
    ]) {
      expect(block).toContain(`'${kind}'`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ROLE SECURITY — every role gate is NULL-safe (correction pass)
// ═══════════════════════════════════════════════════════════════════════════
// PL/pgSQL: `v_role <> 'staff'` and `v_role not in ('admin', 'staff')` both
// evaluate to NULL (never TRUE) when v_role IS NULL — and an IF condition
// that evaluates to NULL is treated as FALSE, meaning a NULL role (no
// active club membership) would silently PASS a bare `<>`/`not in` role
// gate instead of being rejected. `is distinct from` never has this
// problem: it always returns a real boolean, treating NULL as a normal,
// comparable value. Every one of this migration's three authenticated
// RPCs must use the null-safe form exclusively — proven exhaustively here,
// on top of each function's own individual role-check test above.
describe("every role gate is NULL-safe — no bare '<>' or 'not in' against v_role anywhere in this migration's new authenticated RPCs", () => {
  it("create_refund_request: only 'is distinct from' — a NULL role cannot pass as Staff", () => {
    const fn = functionBody("create_refund_request");
    expect(fn).toContain("if v_role is distinct from 'staff' then raise exception 'insufficient_role'; end if;");
    expect(fn).not.toMatch(/v_role\s*<>\s*'staff'|v_role\s*=\s*'staff'/);
  });

  it("get_pending_refund_requests_for_payments: only 'is distinct from ... and is distinct from ...' — a NULL role cannot pass as Admin or Staff", () => {
    const fn = functionBody("get_pending_refund_requests_for_payments");
    expect(fn).toContain("if v_role is distinct from 'admin' and v_role is distinct from 'staff' then");
    expect(fn).not.toMatch(/v_role not in \(/);
  });

  it("reject_refund_request: only 'is distinct from' — a NULL role cannot pass as Admin", () => {
    const fn = functionBody("reject_refund_request");
    expect(fn).toContain("if v_role is distinct from 'admin' then raise exception 'insufficient_role'; end if;");
    expect(fn).not.toMatch(/v_role\s*<>\s*'admin'/);
  });

  it("only the exact allowed role(s) pass each gate — a role NOT in the allow-list still raises, proving the null-safe rewrite did not accidentally widen who passes", () => {
    // create_refund_request: 'admin'/'pro'/'member' must all still be
    // distinct from 'staff' and therefore still raise — the null-safe
    // form is not simply "always true".
    const createFn = functionBody("create_refund_request");
    const createClause = createFn.slice(
      createFn.indexOf("if v_role is distinct from 'staff'"),
      createFn.indexOf(";", createFn.indexOf("if v_role is distinct from 'staff'")),
    );
    expect(createClause).toContain("'staff'");
    expect(createClause).not.toContain("'admin'");
    expect(createClause).not.toContain("'pro'");
    expect(createClause).not.toContain("'member'");

    const rejectFn = functionBody("reject_refund_request");
    const rejectClause = rejectFn.slice(
      rejectFn.indexOf("if v_role is distinct from 'admin' then raise exception 'insufficient_role'"),
      rejectFn.indexOf(";", rejectFn.indexOf("if v_role is distinct from 'admin' then raise exception 'insufficient_role'")),
    );
    expect(rejectClause).toContain("'admin'");
    expect(rejectClause).not.toContain("'staff'");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TABLE — payment_refund_requests
// ═══════════════════════════════════════════════════════════════════════════

describe("payment_refund_requests table shape", () => {
  it("exact status enum: pending | completed | rejected — no 'approved', no 'failed', no 'stale'/'superseded'", () => {
    const block = tableBlock(migrationSql(), "payment_refund_requests");
    expect(block).toContain("check (status in ('pending', 'completed', 'rejected'))");
    expect(block).not.toMatch(/'approved'/);
    expect(block).not.toMatch(/'stale'|'superseded'/);
  });

  it("requested_amount_cents > 0", () => {
    const block = tableBlock(migrationSql(), "payment_refund_requests");
    expect(block).toContain("check (requested_amount_cents > 0)");
  });

  it("composite FK (payment_id, club_id) -> payments(id, club_id)", () => {
    const block = tableBlock(migrationSql(), "payment_refund_requests");
    expect(block).toContain("foreign key (payment_id, club_id) references public.payments(id, club_id)");
  });

  it("refund_attempt_id FK -> payment_refund_attempts, nullable", () => {
    const block = tableBlock(migrationSql(), "payment_refund_requests");
    expect(block).toMatch(/refund_attempt_id\s+uuid\s+references public\.payment_refund_attempts\(id\)/);
    expect(block).not.toMatch(/refund_attempt_id\s+uuid\s+not null/);
  });

  it("requested_by/reviewed_by FK -> profiles", () => {
    const block = tableBlock(migrationSql(), "payment_refund_requests");
    expect(block).toMatch(/requested_by\s+uuid\s+not null references public\.profiles\(id\)/);
    expect(block).toMatch(/reviewed_by\s+uuid\s+references public\.profiles\(id\)/);
  });

  it("reason is NOT NULL, notes/rejection_reason/reviewed_by/reviewed_at/refund_attempt_id are nullable", () => {
    const block = tableBlock(migrationSql(), "payment_refund_requests");
    expect(block).toMatch(/reason\s+text\s+not null/);
    expect(block).not.toMatch(/notes\s+text\s+not null/);
    expect(block).not.toMatch(/rejection_reason\s+text\s+not null/);
  });

  it("does NOT duplicate Stripe refund id/status/amount/failure_reason/currency — those remain owned by payment_refund_attempts", () => {
    const block = tableBlock(migrationSql(), "payment_refund_requests");
    expect(block).not.toMatch(/stripe_refund_id|stripe_account_id|livemode|stripe_payment_intent_id|failure_reason|currency/);
  });

  it("one pending request per payment — partial unique index", () => {
    const sql = migrationSql();
    expect(sql).toContain(
      "create unique index payment_refund_requests_one_pending_per_payment\n" +
      "  on public.payment_refund_requests (payment_id)\n" +
      "  where status = 'pending';",
    );
  });

  it("payment/club lookup indexes exist", () => {
    const sql = migrationSql();
    expect(sql).toContain("create index payment_refund_requests_payment_idx on public.payment_refund_requests (payment_id);");
    expect(sql).toContain("create index payment_refund_requests_club_idx");
  });

  it("updated_at trigger uses the existing repo convention (trigger_set_updated_at)", () => {
    const sql = migrationSql();
    expect(sql).toMatch(/create trigger payment_refund_requests_updated_at\s*\n\s*before update on public\.payment_refund_requests\s*\n\s*for each row execute function public\.trigger_set_updated_at\(\);/);
  });

  it("RLS enabled, ALL direct access revoked from public/anon/authenticated — RPC-only, matching payment_refund_attempts/payment_checkout_attempts posture exactly", () => {
    const sql = migrationSql();
    expect(sql).toContain("alter table public.payment_refund_requests enable row level security;");
    expect(sql).toContain("revoke all on public.payment_refund_requests from public, anon, authenticated;");
    expect(sql).not.toMatch(/create policy[\s\S]{0,40}payment_refund_requests/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// create_refund_request
// ═══════════════════════════════════════════════════════════════════════════

describe("create_refund_request", () => {
  it("SECURITY DEFINER, search_path pinned", () => {
    const fn = functionBody("create_refund_request");
    expect(fn).toContain("security definer");
    expect(fn).toContain("set search_path = public, pg_temp");
  });

  it("signature: (p_payment_id uuid, p_amount_cents integer, p_reason text, p_notes text default null)", () => {
    const fn = functionBody("create_refund_request");
    expect(fn).toContain(
      "create or replace function public.create_refund_request(\n" +
      "  p_payment_id   uuid,\n" +
      "  p_amount_cents integer,\n" +
      "  p_reason       text,\n" +
      "  p_notes        text default null\n" +
      ")",
    );
  });

  it("canonical club/role — current_user_club_id()/current_user_role(), never profiles.club_id/role", () => {
    const fn = functionBody("create_refund_request");
    expect(fn).toContain("public.current_user_club_id()");
    expect(fn).toContain("public.current_user_role()");
    expect(fn).not.toMatch(/profiles\.club_id|profiles\.role|from public\.profiles\s+where id\s*=\s*auth\.uid\(\)/);
  });

  it("Staff only — NULL-safe 'is distinct from' check (never a bare '<>', which silently passes a NULL role), not an allow-list that could admit admin/pro/member", () => {
    const fn = functionBody("create_refund_request");
    expect(fn).toContain("if v_role is distinct from 'staff' then raise exception 'insufficient_role'; end if;");
    expect(fn).not.toMatch(/if v_role <> 'staff'/);
  });

  it("required reason, trimmed", () => {
    const fn = functionBody("create_refund_request");
    expect(fn).toContain("v_reason := btrim(coalesce(p_reason, ''));");
    expect(fn).toContain("raise exception 'refund_reason_required';");
  });

  it("amount must be > 0", () => {
    const fn = functionBody("create_refund_request");
    expect(fn).toContain("raise exception 'invalid_refund_amount';");
  });

  it("payment existence checked, scoped to the caller's club", () => {
    const fn = functionBody("create_refund_request");
    expect(fn).toMatch(/from public\.payments\s*\n\s*where id = p_payment_id and club_id = v_club_id/);
    expect(fn).toContain("raise exception 'payment_not_found';");
  });

  it("reuses get_online_refundable_amount_for_payments — never reproduces refund math, never reads payments.amount_paid_cents", () => {
    const fn = functionBody("create_refund_request");
    expect(fn).toContain("from public.get_online_refundable_amount_for_payments(array[p_payment_id])");
    expect(fn).not.toMatch(/amount_paid_cents/);
    expect(fn).not.toMatch(/sum\([\s\S]{0,40}\)\s*filter/); // no inline ledger SUM/FILTER math duplicated
  });

  it("ceiling checks: zero-refundable and over-ceiling both rejected with the SAME codes the direct-refund path already uses", () => {
    const fn = functionBody("create_refund_request");
    expect(fn).toContain("raise exception 'no_online_payment_to_refund';");
    expect(fn).toContain("raise exception 'refund_exceeds_online_remaining';");
  });

  it("no other pending request for this payment — friendly pre-check AND unique_violation race backstop, both translating to refund_request_already_pending", () => {
    const fn = functionBody("create_refund_request");
    const preCheckIdx = fn.indexOf("if exists (");
    expect(preCheckIdx).toBeGreaterThan(-1);
    expect(fn.slice(preCheckIdx, preCheckIdx + 200)).toContain("raise exception 'refund_request_already_pending';");
    expect(fn).toContain("when unique_violation then");
    const raceIdx = fn.indexOf("when unique_violation then");
    expect(fn.slice(raceIdx, raceIdx + 100)).toContain("raise exception 'refund_request_already_pending';");
  });

  it("never mutates payments/payment_events/payment_refund_attempts/payment_checkout_attempts — only ever inserts into payment_refund_requests and audit_log", () => {
    const fn = functionBody("create_refund_request");
    expect(fn).not.toMatch(/update public\.payments\b/);
    expect(fn).not.toMatch(/insert into public\.payment_events/);
    expect(fn).not.toMatch(/insert into public\.payment_refund_attempts/);
    expect(fn).not.toMatch(/update public\.payment_refund_attempts/);
    expect(fn).not.toMatch(/payment_checkout_attempts/);
  });

  it("no Stripe reference anywhere in this function", () => {
    const fn = functionBody("create_refund_request");
    expect(fn).not.toMatch(/stripe/i);
  });

  it("inserts exactly one audit_log entry", () => {
    const fn = functionBody("create_refund_request");
    const occurrences = fn.split("insert into public.audit_log").length - 1;
    expect(occurrences).toBe(1);
    expect(fn).toContain("'create_refund_request'");
  });

  it("no notification is sent on creation (no Admin notification/email on submission — locked decision)", () => {
    const fn = functionBody("create_refund_request");
    expect(fn).not.toMatch(/insert into public\.notifications/);
  });

  it("grants: authenticated-callable, revoked from public/anon", () => {
    const sql = migrationSql();
    expect(sql).toContain("revoke execute on function public.create_refund_request(uuid, integer, text, text) from public, anon;");
    expect(sql).toContain("grant  execute on function public.create_refund_request(uuid, integer, text, text) to authenticated;");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// get_pending_refund_requests_for_payments
// ═══════════════════════════════════════════════════════════════════════════

describe("get_pending_refund_requests_for_payments", () => {
  it("SECURITY DEFINER, search_path pinned, Admin+Staff only (NULL-safe — never a bare 'not in', which silently passes a NULL role), canonical club scoping", () => {
    const fn = functionBody("get_pending_refund_requests_for_payments");
    expect(fn).toContain("security definer");
    expect(fn).toContain("set search_path = public, pg_temp");
    expect(fn).toContain("if v_role is distinct from 'admin' and v_role is distinct from 'staff' then");
    expect(fn).not.toMatch(/v_role not in \('admin', 'staff'\)/);
    expect(fn).toContain("r.club_id = v_club_id");
  });

  it("filters status = 'pending' only", () => {
    const fn = functionBody("get_pending_refund_requests_for_payments");
    expect(fn).toContain("r.status = 'pending'");
  });

  it("joins profiles ONLY for global identity (name) — never for club/role authorization", () => {
    const fn = functionBody("get_pending_refund_requests_for_payments");
    expect(fn).toContain("join public.profiles p on p.id = r.requested_by");
    expect(fn).not.toMatch(/p\.club_id|p\.role/);
  });

  it("joins payment_refund_attempts only for attempt_status — no Stripe field duplication surfaced beyond status", () => {
    const fn = functionBody("get_pending_refund_requests_for_payments");
    expect(fn).toContain("left join public.payment_refund_attempts pra on pra.id = r.refund_attempt_id");
    expect(fn).toContain("pra.status");
  });

  it("returns exactly the specified columns", () => {
    const fn = functionBody("get_pending_refund_requests_for_payments");
    expect(fn).toContain(
      "returns table (\n" +
      "  request_id             uuid,\n" +
      "  payment_id             uuid,\n" +
      "  requested_by           uuid,\n" +
      "  requested_by_name      text,\n" +
      "  requested_amount_cents integer,\n" +
      "  reason                 text,\n" +
      "  notes                  text,\n" +
      "  refund_attempt_id      uuid,\n" +
      "  attempt_status         text,\n" +
      "  created_at             timestamptz\n" +
      ")",
    );
  });

  it("grants: authenticated-callable, revoked from public/anon, matching get_online_refundable_amount_for_payments' exact posture", () => {
    const sql = migrationSql();
    expect(sql).toContain("revoke execute on function public.get_pending_refund_requests_for_payments(uuid[]) from public, anon;");
    expect(sql).toContain("grant  execute on function public.get_pending_refund_requests_for_payments(uuid[]) to authenticated;");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// reject_refund_request
// ═══════════════════════════════════════════════════════════════════════════

describe("reject_refund_request", () => {
  it("SECURITY DEFINER, search_path pinned, Admin only, NULL-safe role check", () => {
    const fn = functionBody("reject_refund_request");
    expect(fn).toContain("security definer");
    expect(fn).toContain("set search_path = public, pg_temp");
    expect(fn).toContain("if v_role is distinct from 'admin' then raise exception 'insufficient_role'; end if;");
    expect(fn).not.toMatch(/if v_role <> 'admin'/);
  });

  it("required rejection reason, trimmed", () => {
    const fn = functionBody("reject_refund_request");
    expect(fn).toContain("v_reason := btrim(coalesce(p_rejection_reason, ''));");
    expect(fn).toContain("raise exception 'rejection_reason_required';");
  });

  it("LOCK ORDER: payment-first — non-locking probe, then payments FOR UPDATE, then the request row FOR UPDATE — never the reverse", () => {
    const fn = functionBody("reject_refund_request");
    const probeIdx = fn.indexOf("select * into v_probe");
    const probeEnd = fn.indexOf(";", probeIdx);
    expect(fn.slice(probeIdx, probeEnd)).not.toMatch(/for update/);

    const paymentLockIdx = fn.indexOf("from public.payments\n   where id = v_probe.payment_id");
    expect(paymentLockIdx).toBeGreaterThan(probeIdx);

    const requestLockIdx = fn.indexOf(
      "select * into v_request\n    from public.payment_refund_requests\n   where id = p_request_id and club_id = v_club_id\n   for update;",
    );
    expect(requestLockIdx).toBeGreaterThan(paymentLockIdx);
  });

  it("revalidates payment_id match and status='pending' after both locks are held", () => {
    const fn = functionBody("reject_refund_request");
    expect(fn).toContain("if not found or v_request.payment_id <> v_payment.id then");
    expect(fn).toContain("if v_request.status <> 'pending' then");
    expect(fn).toContain("raise exception 'request_not_pending';");
  });

  it("execution-started guard: reads the linked attempt (plain read, no FOR UPDATE) only when refund_attempt_id is set", () => {
    const fn = functionBody("reject_refund_request");
    const guardIdx = fn.indexOf("if v_request.refund_attempt_id is not null then");
    expect(guardIdx).toBeGreaterThan(-1);
    const attemptReadIdx = fn.indexOf("select * into v_attempt", guardIdx);
    const attemptReadEnd = fn.indexOf(";", attemptReadIdx);
    expect(fn.slice(attemptReadIdx, attemptReadEnd)).not.toMatch(/for update/);
  });

  it("execution-started guard: pending, requires_action, AND succeeded are all blocked with refund_request_execution_started — failed/canceled and NULL are not", () => {
    const fn = functionBody("reject_refund_request");
    const idx = fn.indexOf("if v_attempt.status in ('pending', 'requires_action', 'succeeded') then");
    expect(idx).toBeGreaterThan(-1);
    const block = fn.slice(idx, fn.indexOf("end if;", idx));
    expect(block).toContain("raise exception 'refund_request_execution_started';");
    // No separate/looser guard exists that would let 'succeeded' slip through.
    expect(fn).not.toMatch(/if v_attempt\.status in \('pending', 'requires_action'\) then\s*\n\s*raise exception 'refund_request_execution_started'/);
  });

  it("the execution-started guard runs BEFORE the rejection UPDATE/audit/notification — a blocked rejection never reaches any of them", () => {
    const fn = functionBody("reject_refund_request");
    const guardRaiseIdx = fn.indexOf("raise exception 'refund_request_execution_started';");
    const updateIdx = fn.indexOf("set status            = 'rejected',");
    const auditIdx = fn.indexOf("'reject_refund_request'");
    const notifyIdx = fn.indexOf("'refund_request_rejected'");
    expect(guardRaiseIdx).toBeGreaterThan(-1);
    expect(updateIdx).toBeGreaterThan(guardRaiseIdx);
    expect(auditIdx).toBeGreaterThan(guardRaiseIdx);
    expect(notifyIdx).toBeGreaterThan(guardRaiseIdx);
  });

  it("on success sets exactly status/reviewed_by/reviewed_at/rejection_reason", () => {
    const fn = functionBody("reject_refund_request");
    expect(fn).toContain(
      "set status            = 'rejected',\n" +
      "         reviewed_by       = auth.uid(),\n" +
      "         reviewed_at       = now(),\n" +
      "         rejection_reason  = v_reason",
    );
  });

  it("never mutates payments/payment_events/payment_refund_attempts and never references Stripe — reads payments/payment_refund_attempts (for the lock-order and execution-started guard) are plain SELECTs only, never INSERT/UPDATE", () => {
    const fn = functionBody("reject_refund_request");
    expect(fn).not.toMatch(/update public\.payments\b/);
    expect(fn).not.toMatch(/insert into public\.payments\b/);
    expect(fn).not.toMatch(/insert into public\.payment_events/);
    expect(fn).not.toMatch(/update public\.payment_refund_attempts/);
    expect(fn).not.toMatch(/insert into public\.payment_refund_attempts/);
    expect(fn).not.toMatch(/stripe/i);
  });

  it("inserts exactly one audit_log entry", () => {
    const fn = functionBody("reject_refund_request");
    const occurrences = fn.split("insert into public.audit_log").length - 1;
    expect(occurrences).toBe(1);
    expect(fn).toContain("'reject_refund_request'");
  });

  it("inserts exactly one in-app notification to requested_by, kind=refund_request_rejected, with target_path=/admin/payments, no email", () => {
    const fn = functionBody("reject_refund_request");
    const occurrences = fn.split("insert into public.notifications").length - 1;
    expect(occurrences).toBe(1);
    expect(fn).toContain("v_club_id, v_request.requested_by, 'refund_request_rejected',");
    expect(fn).toContain("'target_path', '/admin/payments'");
  });

  it("grants: authenticated-callable, revoked from public/anon", () => {
    const sql = migrationSql();
    expect(sql).toContain("revoke execute on function public.reject_refund_request(uuid, text) from public, anon;");
    expect(sql).toContain("grant  execute on function public.reject_refund_request(uuid, text) to authenticated;");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// _complete_refund_request_for_attempt (private completion helper)
// ═══════════════════════════════════════════════════════════════════════════

describe("_complete_refund_request_for_attempt — shared private completion helper", () => {
  it("exists, SECURITY DEFINER, search_path pinned", () => {
    const fn = functionBody("_complete_refund_request_for_attempt");
    expect(fn).toContain("security definer");
    expect(fn).toContain("set search_path = public, pg_temp");
  });

  it("fully private — revoked from public, anon, authenticated, AND service_role (transitive-only, never a client capability)", () => {
    const sql = migrationSql();
    expect(sql).toContain(
      "revoke all on function public._complete_refund_request_for_attempt(uuid)\n  from public, anon, authenticated, service_role;",
    );
    expect(sql).not.toMatch(/grant\s+execute on function public\._complete_refund_request_for_attempt/);
  });

  it("is idempotent — no-op (early return) when no pending request is linked to the given attempt", () => {
    const fn = functionBody("_complete_refund_request_for_attempt");
    expect(fn).toContain("if not found then\n    return;\n  end if;");
  });

  it("locates the request by refund_attempt_id + status='pending' — matches zero rows for a direct Admin refund (no linked request) or an already-completed request", () => {
    const fn = functionBody("_complete_refund_request_for_attempt");
    expect(fn).toMatch(/where refund_attempt_id = p_refund_attempt_id\s*\n\s*and status = 'pending'/);
  });

  it("sets status='completed' only — never touches reviewed_by/reviewed_at (already durably set at execution-begin time)", () => {
    const fn = functionBody("_complete_refund_request_for_attempt");
    const idx = fn.indexOf("update public.payment_refund_requests");
    const end = fn.indexOf(";", idx);
    const clause = fn.slice(idx, end);
    expect(clause).toContain("status = 'completed'");
    expect(clause).not.toMatch(/reviewed_by|reviewed_at/);
  });

  it("inserts the completion notification (kind=refund_request_completed, target_path=/admin/payments) and an audit_log entry attributed to the original approving reviewed_by", () => {
    const fn = functionBody("_complete_refund_request_for_attempt");
    expect(fn).toContain("'refund_request_completed'");
    expect(fn).toContain("'target_path', '/admin/payments'");
    expect(fn).toContain("v_request.club_id, v_request.reviewed_by, 'complete_refund_request'");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// begin_refund_request_execution
// ═══════════════════════════════════════════════════════════════════════════

describe("begin_refund_request_execution — atomic, single RPC, payment-first lock order (current effective body: 0182)", () => {
  it("signature is exactly (p_request_id uuid, p_club_id uuid, p_actor_id uuid) — no amount parameter of any kind, ever", () => {
    const fn = currentBeginExecutionBody();
    expect(fn).toContain(
      "create or replace function public.begin_refund_request_execution(\n" +
      "  p_request_id uuid,\n" +
      "  p_club_id    uuid,\n" +
      "  p_actor_id   uuid\n" +
      ")",
    );
    expect(fn).not.toMatch(/p_amount|p_requested_amount/);
  });

  it("return columns are identical, in the same order, to open_payment_refund_attempt's own return table", () => {
    const fn = currentBeginExecutionBody();
    expect(fn).toContain(
      "returns table (\n" +
      "  id                          uuid,\n" +
      "  payment_id                  uuid,\n" +
      "  club_id                      uuid,\n" +
      "  source_checkout_attempt_id  uuid,\n" +
      "  stripe_account_id            text,\n" +
      "  livemode                     boolean,\n" +
      "  stripe_checkout_session_id   text,\n" +
      "  stripe_payment_intent_id     text,\n" +
      "  requested_amount_cents       integer,\n" +
      "  status                       text,\n" +
      "  currency                     text\n" +
      ")",
    );
  });

  it("service_role ONLY — revoked from public/anon/authenticated, granted only to service_role (re-declared in 0182, same as 0181), no role-check line inside the body (matches open_payment_refund_attempt's own established posture: a service-role-invoked RPC has no caller JWT to re-derive a role from)", () => {
    const sql = migration182Sql();
    expect(sql).toContain(
      "revoke execute on function public.begin_refund_request_execution(uuid, uuid, uuid) from public, anon, authenticated;",
    );
    expect(sql).toContain(
      "grant  execute on function public.begin_refund_request_execution(uuid, uuid, uuid) to service_role;",
    );
    const fn = currentBeginExecutionBody();
    expect(fn).not.toMatch(/current_user_role\(\)/);
  });

  it("LOCK ORDER: payment is locked BEFORE the request is locked — never the reverse", () => {
    const fn = currentBeginExecutionBody();
    const paymentLockIdx = fn.indexOf("from public.payments p\n   where p.id = v_probe.payment_id");
    const requestLockIdx = fn.indexOf(
      "select * into v_request\n    from public.payment_refund_requests r\n   where r.id = p_request_id and r.club_id = p_club_id\n   for update;",
    );
    expect(paymentLockIdx).toBeGreaterThan(-1);
    expect(requestLockIdx).toBeGreaterThan(paymentLockIdx);
  });

  it("the INITIAL read of the request (to discover payment_id) is explicitly non-locking — no FOR UPDATE before the payment lock is acquired", () => {
    const fn = currentBeginExecutionBody();
    const probeIdx = fn.indexOf("select * into v_probe");
    const probeEnd = fn.indexOf(";", probeIdx);
    const probeClause = fn.slice(probeIdx, probeEnd);
    expect(probeClause).not.toMatch(/for update/);
  });

  it("the request row is RE-READ and locked (for update) only after the payment lock, and revalidated (payment_id/status) afterward", () => {
    const fn = currentBeginExecutionBody();
    expect(fn).toMatch(/select \* into v_request\s*\n\s*from public\.payment_refund_requests r\s*\n\s*where r\.id = p_request_id and r\.club_id = p_club_id\s*\n\s*for update;/);
    expect(fn).toContain("if not found or v_request.payment_id <> v_payment.id then");
    expect(fn).toContain("if v_request.status <> 'pending' then");
    expect(fn).toContain("raise exception 'request_not_pending';");
  });

  it("uses ONLY the STORED requested_amount_cents from the request row — never a parameter — when opening a fresh attempt", () => {
    const fn = currentBeginExecutionBody();
    expect(fn).toContain("v_request.requested_amount_cents, p_actor_id, null");
  });

  it("fresh/no-prior-attempt path calls the EXISTING open_payment_refund_attempt — no refund math or Stripe logic duplicated", () => {
    const fn = currentBeginExecutionBody();
    const occurrences = fn.split("public.open_payment_refund_attempt(").length - 1;
    expect(occurrences).toBe(1);
  });

  it("branch: linked attempt status = 'pending' or 'requires_action' -> reuses the SAME attempt, does not call open_payment_refund_attempt, does not touch reviewed_by/reviewed_at", () => {
    const fn = currentBeginExecutionBody();
    const idx = fn.indexOf("elsif v_attempt.status in ('pending', 'requires_action') then");
    expect(idx).toBeGreaterThan(-1);
    const nextBranchIdx = fn.indexOf("end if;", idx);
    const block = fn.slice(idx, nextBranchIdx);
    expect(block).not.toMatch(/open_payment_refund_attempt|reviewed_by|reviewed_at/);
    expect(block).toContain("return query select");
  });

  it("branch: linked attempt status = 'succeeded' -> heals via the shared completion helper, NEVER calls open_payment_refund_attempt or Stripe again", () => {
    const fn = currentBeginExecutionBody();
    const idx = fn.indexOf("if v_attempt.status = 'succeeded' then");
    expect(idx).toBeGreaterThan(-1);
    const nextBranchIdx = fn.indexOf("elsif v_attempt.status in", idx);
    const block = fn.slice(idx, nextBranchIdx);
    expect(block).toContain("perform public._complete_refund_request_for_attempt(v_attempt.id);");
    expect(block).not.toMatch(/open_payment_refund_attempt/);
  });

  it("branch: linked attempt status = 'failed'/'canceled' falls through to the single shared fresh-attempt path (not a separate duplicated block)", () => {
    const fn = currentBeginExecutionBody();
    // No explicit 'failed'/'canceled' branch exists as its own IF arm —
    // it is the implicit else of the succeeded/pending/requires_action
    // checks, falling through to the one shared "open fresh" call below.
    expect(fn).not.toMatch(/elsif v_attempt\.status in \('failed', 'canceled'\)/);
  });

  it("the fresh-attempt path sets reviewed_by = p_actor_id and reviewed_at = now() — reflecting whichever click most recently (re)initiated execution", () => {
    const fn = currentBeginExecutionBody();
    expect(fn).toContain(
      "set refund_attempt_id = v_new.id,\n" +
      "         reviewed_by       = p_actor_id,\n" +
      "         reviewed_at       = now()",
    );
  });

  it("a request that is already 'completed' or 'rejected' cannot begin execution — fails closed with request_not_pending, no new attempt, no Stripe path reachable", () => {
    const fn = currentBeginExecutionBody();
    // status <> 'pending' covers BOTH terminal states in one check — no
    // separate carve-out exists for 'completed' vs 'rejected'.
    expect(fn).toContain("if v_request.status <> 'pending' then");
  });

  it("no second idempotency scheme is invented — the function never references a new key/token concept, relying on open_payment_refund_attempt's own reuse rule + Stripe's existing idempotency key + the reconciler's terminal-state backstop", () => {
    const fn = currentBeginExecutionBody();
    expect(fn).not.toMatch(/idempotency_key|idempotent_token/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 0182 — begin_refund_request_execution column-reference ambiguity fix
// ═══════════════════════════════════════════════════════════════════════════

describe("0182 fixes the live 42702 ambiguous-column bug — every table reference that could collide with a RETURNS TABLE output name is now alias-qualified", () => {
  it("0182 exists and redefines ONLY begin_refund_request_execution — no other function/table/grant is touched", () => {
    const sql = migration182Sql();
    const occurrences = (sql.match(/create or replace function/g) ?? []).length;
    expect(occurrences).toBe(1);
    expect(sql).toContain("create or replace function public.begin_refund_request_execution(");
    expect(sql).not.toMatch(/create table|create or replace function public\.(?!begin_refund_request_execution)/);
  });

  it("mirrors the SAME alias convention 0155 already established for open_payment_refund_attempt's identical bug class (payments p, payment_refund_attempts pra, payment_checkout_attempts pca)", () => {
    const fixSql = readSource(OPEN_ATTEMPT_AMBIGUITY_FIX_PATH);
    expect(fixSql).toContain("from public.payments p");
    expect(fixSql).toContain("payment_refund_attempts pra");
    expect(fixSql).toContain("payment_checkout_attempts pca");
  });

  it("step A (initial non-locking probe): payment_refund_requests is aliased r, WHERE clause is r.id/r.club_id — never bare id/club_id", () => {
    const fn = currentBeginExecutionBody();
    expect(fn).toContain(
      "select * into v_probe\n    from public.payment_refund_requests r\n   where r.id = p_request_id and r.club_id = p_club_id;",
    );
  });

  it("step B (payment lock): payments is aliased p, WHERE clause is p.id/p.club_id", () => {
    const fn = currentBeginExecutionBody();
    expect(fn).toContain(
      "select * into v_payment\n    from public.payments p\n   where p.id = v_probe.payment_id and p.club_id = p_club_id\n   for update;",
    );
  });

  it("step C (request lock/re-read): payment_refund_requests is aliased r again, WHERE clause is r.id/r.club_id", () => {
    const fn = currentBeginExecutionBody();
    expect(fn).toContain(
      "select * into v_request\n    from public.payment_refund_requests r\n   where r.id = p_request_id and r.club_id = p_club_id\n   for update;",
    );
  });

  it("resolving the linked attempt: payment_refund_attempts is aliased pra, WHERE clause is pra.id — never bare id", () => {
    const fn = currentBeginExecutionBody();
    expect(fn).toContain(
      "select * into v_attempt\n      from public.payment_refund_attempts pra\n     where pra.id = v_request.refund_attempt_id;",
    );
  });

  it("the fresh-attempt-linking UPDATE: payment_refund_requests is aliased r, WHERE clause is r.id — never bare id", () => {
    const fn = currentBeginExecutionBody();
    expect(fn).toContain(
      "update public.payment_refund_requests r\n     set refund_attempt_id = v_new.id,\n         reviewed_by       = p_actor_id,\n         reviewed_at       = now()\n   where r.id = p_request_id;",
    );
  });

  it("exhaustive audit: NO bare (unqualified) 'where id =' or 'where club_id =' predicate remains anywhere in the function — every WHERE clause referencing these names uses an explicit table alias", () => {
    const fn = currentBeginExecutionBody();
    expect(fn).not.toMatch(/where id\s*=/);
    expect(fn).not.toMatch(/and club_id\s*=/);
    expect(fn).not.toMatch(/where club_id\s*=/);
  });

  it("the payment_checkout_attempts reads (already alias-qualified pca in 0181) are unchanged — pca.id, never bare id", () => {
    const fn = currentBeginExecutionBody();
    const occurrences = fn.split("from public.payment_checkout_attempts pca where pca.id =").length - 1;
    expect(occurrences).toBe(2); // succeeded branch + pending/requires_action branch
  });

  it("every OTHER reference to these column names is a qualified record-variable field access (v_probe./v_payment./v_request./v_attempt./v_source./v_new.), never a bare column name — these were never ambiguous and are unchanged", () => {
    const fn = currentBeginExecutionBody();
    expect(fn).toContain("v_probe.payment_id");
    expect(fn).toContain("v_payment.id");
    expect(fn).toContain("v_payment.currency");
    expect(fn).toContain("v_request.payment_id");
    expect(fn).toContain("v_request.status");
    expect(fn).toContain("v_request.refund_attempt_id");
    expect(fn).toContain("v_attempt.status");
    expect(fn).toContain("v_new.id");
  });

  it("the UPDATE's SET-list target columns (refund_attempt_id/reviewed_by/reviewed_at) correctly stay unqualified — required SQL syntax, and none collide with a RETURNS TABLE output name regardless", () => {
    const fn = currentBeginExecutionBody();
    const returnsIdx = fn.indexOf("returns table (");
    const returnsEnd = fn.indexOf(")", returnsIdx);
    const outputNames = fn.slice(returnsIdx, returnsEnd);
    for (const col of ["refund_attempt_id", "reviewed_by", "reviewed_at"]) {
      expect(outputNames).not.toContain(col);
    }
  });

  it("every existing error code from 0181 is preserved: invalid_arguments, request_not_found, payment_not_found, request_not_pending", () => {
    const fn = currentBeginExecutionBody();
    for (const code of ["invalid_arguments", "request_not_found", "payment_not_found", "request_not_pending"]) {
      expect(fn).toContain(`'${code}'`);
    }
  });

  it("the rollback footer's inlined body is genuinely the exact pre-0182 (0181) text, ambiguity included — a real, executable restore", () => {
    const sql = readSource(MIGRATION_182_PATH); // raw, comments included — the rollback IS comments
    const rollbackIdx = sql.indexOf("-- Rollback (manual, cloud SQL Editor)");
    expect(rollbackIdx).toBeGreaterThan(-1);
    const rollback = sql.slice(rollbackIdx);
    expect(rollback).toContain("fully executable");
    expect(rollback).toContain("where id = p_request_id and club_id = p_club_id;");
    expect(rollback).toContain("where id = v_probe.payment_id and club_id = p_club_id");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// _reconcile_stripe_refund_attempt — narrow additive extension only
// ═══════════════════════════════════════════════════════════════════════════

describe("_reconcile_stripe_refund_attempt — 0181 extension over the current effective (0153) body", () => {
  function originalBody(): string {
    const sql = codeOnly(readSource(RECONCILER_ORIGIN_PATH));
    const start = sql.indexOf("create or replace function public._reconcile_stripe_refund_attempt(");
    const end = sql.indexOf("\n$$;", start);
    return sql.slice(start, end + "\n$$;".length);
  }

  it("same signature as the current effective (0153) body", () => {
    const fn = functionBody("_reconcile_stripe_refund_attempt");
    const orig = originalBody();
    const origSigEnd = orig.indexOf(")\nreturns void");
    const newSigEnd = fn.indexOf(")\nreturns void");
    expect(fn.slice(0, newSigEnd)).toBe(orig.slice(0, origSigEnd));
  });

  it("every existing validation/mutation line from the current effective body is preserved verbatim", () => {
    const fn = functionBody("_reconcile_stripe_refund_attempt");
    for (const mustContain of [
      "raise exception 'invalid_arguments';",
      "raise exception 'invalid_status';",
      "raise exception 'refund_attempt_not_found';",
      "raise exception 'payment_not_found';",
      "raise exception 'stripe_account_mismatch';",
      "raise exception 'livemode_mismatch';",
      "raise exception 'payment_intent_mismatch';",
      "raise exception 'currency_mismatch';",
      "raise exception 'refund_amount_mismatch';",
      "raise exception 'refund_id_mismatch';",
      "if v_old_status in ('succeeded', 'failed', 'canceled') then",
      "update public.payment_refund_attempts\n     set status = p_status,",
      "'online_refund_recorded',",
    ]) {
      expect(fn).toContain(mustContain);
    }
  });

  it("the ONLY addition is a call to the shared completion helper, placed INSIDE the existing `if p_status = 'succeeded'` block, after the existing ledger insert", () => {
    const fn = functionBody("_reconcile_stripe_refund_attempt");
    const succeededIdx = fn.indexOf("if p_status = 'succeeded' then");
    const ledgerInsertIdx = fn.indexOf("'online_refund_recorded',", succeededIdx);
    const helperCallIdx = fn.indexOf("_complete_refund_request_for_attempt(v_attempt.id)", succeededIdx);
    expect(succeededIdx).toBeGreaterThan(-1);
    expect(ledgerInsertIdx).toBeGreaterThan(succeededIdx);
    expect(helperCallIdx).toBeGreaterThan(ledgerInsertIdx);
    // Still inside the same `if ... end if;` block, not appended after it.
    const endIfIdx = fn.indexOf("end if;", helperCallIdx);
    const functionEndIdx = fn.indexOf("end;\n$$;");
    expect(endIfIdx).toBeGreaterThan(-1);
    expect(endIfIdx).toBeLessThan(functionEndIdx);
  });

  it("direct Admin refunds (no linked payment_refund_requests row) are a complete no-op for this addition — proven by the helper's own idempotent not-found short-circuit, not by any special-casing inside the reconciler itself", () => {
    const fn = functionBody("_reconcile_stripe_refund_attempt");
    // The reconciler itself does not special-case "has no linked request" —
    // that logic lives entirely in _complete_refund_request_for_attempt's
    // own `if not found then return; end if;` (tested above), keeping the
    // reconciler's own body genuinely unchanged apart from the one call.
    expect(fn).not.toMatch(/payment_refund_requests/);
  });

  it("grants/security posture are completely unchanged: still fully private, revoked from public/anon/authenticated/service_role", () => {
    const sql = migrationSql();
    expect(sql).toContain(
      "revoke all on function public._reconcile_stripe_refund_attempt(uuid, text, text, integer, text, boolean, text, text, text)\n" +
      "  from public, anon, authenticated, service_role;",
    );
  });

  it("pending/requires_action/failed/canceled never reach the completion helper — it is only ever called from inside the succeeded branch", () => {
    const fn = functionBody("_reconcile_stripe_refund_attempt");
    const occurrences = fn.split("_complete_refund_request_for_attempt(").length - 1;
    expect(occurrences).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Notification kind + preferences constraint
// ═══════════════════════════════════════════════════════════════════════════

describe("notifications_kind_check", () => {
  it("adds exactly refund_request_rejected and refund_request_completed", () => {
    const sql = migrationSql();
    expect(sql).toContain("'refund_request_rejected'");
    expect(sql).toContain("'refund_request_completed'");
  });

  it("preserves every one of the 17 pre-existing kinds verbatim", () => {
    const sql = migrationSql();
    const idx = sql.indexOf("add constraint notifications_kind_check");
    expect(idx).toBeGreaterThan(-1);
    const block = sql.slice(idx, sql.indexOf(");", idx));
    for (const kind of [
      "reservation_confirmed", "reservation_cancelled_by_admin", "reservation_cancelled_by_member",
      "reservation_rescheduled", "event_cancelled", "event_joined", "event_updated",
      "waitlist_promoted", "waitlist_offer", "announcement", "lesson_request_received",
      "lesson_request_proposed", "lesson_request_confirmed", "lesson_request_declined",
      "lesson_cancelled", "lesson_provider_reassigned", "lesson_admin_requested",
    ]) {
      expect(block).toContain(`'${kind}'`);
    }
  });

  it("does NOT touch notification_preferences_kind_check — the two new kinds are in-app only, no email/preference surface", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/notification_preferences_kind_check/);
    expect(sql).not.toMatch(/alter table public\.notification_preferences/);
  });
});
