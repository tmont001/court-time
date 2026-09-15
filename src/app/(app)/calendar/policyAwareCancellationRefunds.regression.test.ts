import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 41A — regression coverage for policy-aware cancellation & refund
// requests, including the correction-pass fixes: the private (non-role-
// gated) online-refundable calculation, uncollected-balance release on a
// refund-eligible cancellation, the beneficiary-aware outcome
// notification split, and the pending-request amount-mismatch guard.
// Same source-inspection style as cancellationPolicy.regression.test.ts
// (Phase 40) and staleCheckoutInvalidation.regression.test.ts — no live
// Postgres in this repo, so the shipped migration text is the honest
// thing to assert against.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !line.trim().startsWith("--") && !line.trim().startsWith("//"))
    .join("\n");
}

const MIGRATION_PATH = "supabase/migrations/0186_policy_aware_cancellation_refunds.sql";
const CALENDAR_ACTIONS_PATH = "src/app/(app)/calendar/actions.ts";
const LESSONS_ACTIONS_PATH = "src/app/(app)/lessons/actions.ts";

function migrationSql(): string {
  return codeOnly(readSource(MIGRATION_PATH));
}

function functionBody(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  expect(start, `function public.${name} not found`).toBeGreaterThanOrEqual(0);
  const dollarDollarEnd = sql.indexOf("\n$$;", start);
  const dollarFnEnd = sql.indexOf("\n$function$;", start);
  const end =
    dollarFnEnd >= 0 && (dollarDollarEnd < 0 || dollarFnEnd < dollarDollarEnd)
      ? dollarFnEnd + "\n$function$;".length
      : dollarDollarEnd + "\n$$;".length;
  expect(end, `closing terminator for public.${name} not found`).toBeGreaterThan(start);
  return sql.slice(start, end);
}

// ═══════════════════════════════════════════════════════════════════════════
// A. Schema
// ═══════════════════════════════════════════════════════════════════════════

describe("0186 — schema changes", () => {
  const sql = migrationSql();

  it("adds reservations.cancellation_policy_state and lesson_requests.cancellation_policy_state with the four allowed values", () => {
    expect(sql).toMatch(
      /alter table public\.reservations\s*\n\s*add column cancellation_policy_state text\s*\n\s*check \(cancellation_policy_state in \('in_policy', 'grace', 'late', 'not_applicable'\)\);/,
    );
    expect(sql).toMatch(
      /alter table public\.lesson_requests\s*\n\s*add column cancellation_policy_state text\s*\n\s*check \(cancellation_policy_state in \('in_policy', 'grace', 'late', 'not_applicable'\)\);/,
    );
  });

  it("adds payment_refund_requests.source, NOT NULL DEFAULT 'staff_requested'", () => {
    expect(sql).toMatch(
      /alter table public\.payment_refund_requests\s*\n\s*add column source text not null default 'staff_requested'\s*\n\s*check \(source in \('staff_requested', 'cancellation_policy'\)\);/,
    );
  });

  it("adds payment_refund_requests.beneficiary_user_id, nullable, FK profiles", () => {
    expect(sql).toMatch(
      /alter table public\.payment_refund_requests\s*\n\s*add column beneficiary_user_id uuid references public\.profiles\(id\);/,
    );
  });

  it("adds payment_refund_requests.policy_refundable_cents_at_cancellation, nullable integer, non-negative", () => {
    expect(sql).toMatch(
      /alter table public\.payment_refund_requests\s*\n\s*add column policy_refundable_cents_at_cancellation integer\s*\n\s*check \(policy_refundable_cents_at_cancellation is null or policy_refundable_cents_at_cancellation >= 0\);/,
    );
  });

  it("does not touch club_settings — no new club setting of any kind", () => {
    expect(sql).not.toMatch(/alter table\s+(public\.)?club_settings/i);
  });

  it("is wrapped in a single begin/commit transaction", () => {
    expect((sql.match(/^begin;/m) ?? []).length).toBe(1);
    expect((sql.match(/^commit;/m) ?? []).length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. _compute_online_refundable_amounts — the private, non-role-gated
//    calculation (correction 1)
// ═══════════════════════════════════════════════════════════════════════════

describe("_compute_online_refundable_amounts — private refundable calculation", () => {
  const body = () => functionBody(migrationSql(), "_compute_online_refundable_amounts");

  it("is private — revoked from public, anon, authenticated, AND service_role", () => {
    expect(migrationSql()).toMatch(
      /revoke execute on function public\._compute_online_refundable_amounts\(uuid, uuid\[\]\)\s*\n\s*from public, anon, authenticated, service_role;/,
    );
  });

  it("takes club_id as a trusted parameter — no current_user_role()/current_user_club_id() call, no actor-role check at all", () => {
    const fn = body();
    expect(fn).not.toMatch(/current_user_role\(\)|current_user_club_id\(\)/);
    expect(fn).not.toMatch(/insufficient_role|not_authenticated/);
  });

  it("preserves the newest-refundable-completed-attempt-first selection (distinct on payment_id, order by created_at desc, tie-broken by attempt id desc)", () => {
    const fn = body();
    expect(fn).toContain("select distinct on (w.payment_id)");
    expect(fn).toContain("order by w.payment_id, w.created_at desc, w.attempt_id desc");
    expect(fn).toContain("where w.remaining_cents > 0");
  });

  it("scopes every lookup to the trusted p_club_id parameter", () => {
    const fn = body();
    expect(fn).toContain("where a.club_id = p_club_id");
    expect(fn).toContain("where pra.club_id = p_club_id");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. get_online_refundable_amount_for_payments — thin public wrapper
// ═══════════════════════════════════════════════════════════════════════════

describe("get_online_refundable_amount_for_payments — thin wrapper, Admin/Staff-only unchanged", () => {
  const body = () => functionBody(migrationSql(), "get_online_refundable_amount_for_payments");

  it("still resolves the session's own club/role and still rejects any non-admin/staff caller", () => {
    const fn = body();
    expect(fn).toContain("v_club_id := public.current_user_club_id();");
    expect(fn).toContain("v_role    := public.current_user_role();");
    expect(fn).toContain("if v_role not in ('admin', 'staff') then raise exception 'insufficient_role'; end if;");
  });

  it("delegates to the private calculation with the session's own club_id — never the private calc's role check", () => {
    const fn = body();
    expect(fn).toContain("select * from public._compute_online_refundable_amounts(v_club_id, p_payment_ids);");
  });

  it("signature and return shape are unchanged — payment_id, refundable_cents, currency", () => {
    const fn = body();
    expect(fn).toMatch(/returns table \(\s*\n\s*payment_id\s+uuid,\s*\n\s*refundable_cents integer,\s*\n\s*currency\s+text\s*\n\)/);
  });

  it("grants are unchanged — authenticated, revoked from public/anon", () => {
    expect(migrationSql()).toMatch(
      /revoke execute on function public\.get_online_refundable_amount_for_payments\(uuid\[\]\) from public, anon;\s*\n\s*grant\s+execute on function public\.get_online_refundable_amount_for_payments\(uuid\[\]\) to authenticated;/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D. _release_uncollected_cancellation_balance — correction 2
// ═══════════════════════════════════════════════════════════════════════════

describe("_release_uncollected_cancellation_balance — void/waive-equivalent uncollected release", () => {
  const body = () => functionBody(migrationSql(), "_release_uncollected_cancellation_balance");

  it("is private — revoked from public, anon, authenticated, AND service_role", () => {
    expect(migrationSql()).toMatch(
      /revoke execute on function public\._release_uncollected_cancellation_balance\(uuid, uuid, uuid\)\s*\n\s*from public, anon, authenticated, service_role;/,
    );
  });

  it("mirrors void_payment_obligation's exact gate and amount for 'unpaid': amount_paid_cents = 0 and amount_due_cents > 0, amount_cents = amount_due_cents", () => {
    const fn = body();
    expect(fn).toContain("if v_payment.status = 'unpaid' then");
    expect(fn).toContain("if v_payment.amount_paid_cents = 0 and v_payment.amount_due_cents > 0 then");
    expect(fn).toMatch(
      /insert into public\.payment_events \(payment_id, club_id, event_type, amount_cents, notes, actor_id\)\s*\n\s*values \(p_payment_id, p_club_id, 'void_payment_obligation', v_payment\.amount_due_cents,/,
    );
  });

  it("mirrors waive_payment's exact computation for 'partially_paid': amount_cents = due - paid", () => {
    const fn = body();
    expect(fn).toContain("elsif v_payment.status = 'partially_paid' then");
    expect(fn).toContain("v_remaining := v_payment.amount_due_cents - v_payment.amount_paid_cents;");
    expect(fn).toMatch(
      /insert into public\.payment_events \(payment_id, club_id, event_type, amount_cents, notes, actor_id\)\s*\n\s*values \(p_payment_id, p_club_id, 'waived', v_remaining,/,
    );
  });

  it("touches no other status branch — paid/overpaid/partially_refunded/refunded/waived/void never get a fabricated event", () => {
    const fn = body();
    const ifBranches = fn.match(/if v_payment\.status = '\w+' then|elsif v_payment\.status = '\w+' then/g) ?? [];
    expect(ifBranches).toEqual(["if v_payment.status = 'unpaid' then", "elsif v_payment.status = 'partially_paid' then"]);
  });

  it("never writes payments.amount_due_cents/amount_paid_cents/status directly — only payment_events inserts", () => {
    const fn = body();
    expect(fn).not.toMatch(/update\s+public\.payments|update\s+payments\b/i);
  });

  it("has no actor-role check of its own — an internal, trusted-caller-only primitive", () => {
    const fn = body();
    expect(fn).not.toMatch(/current_user_role\(\)|insufficient_role/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// E. _ensure_policy_cancellation_refund_request — corrections 1, 3, 4
// ═══════════════════════════════════════════════════════════════════════════

describe("_ensure_policy_cancellation_refund_request — private policy-refund primitive", () => {
  const body = () => functionBody(migrationSql(), "_ensure_policy_cancellation_refund_request");

  it("is private — revoked from public, anon, authenticated, AND service_role", () => {
    expect(migrationSql()).toMatch(
      /revoke execute on function public\._ensure_policy_cancellation_refund_request\(uuid, uuid, uuid, text\)\s*\n\s*from public, anon, authenticated, service_role;/,
    );
  });

  it("correction 1: calls the PRIVATE calculation, never the public role-gated RPC", () => {
    const fn = body();
    expect(fn).toContain("from public._compute_online_refundable_amounts(p_club_id, array[p_payment_id])");
    expect(fn).not.toContain("from public.get_online_refundable_amount_for_payments(");
  });

  it("defensively rejects 'late' as a policy state", () => {
    const fn = body();
    expect(fn).toContain("if p_policy_state not in ('in_policy', 'grace', 'not_applicable') then");
    expect(fn).toContain("raise exception 'invalid_policy_state_for_refund_request';");
  });

  it("correction 3: resolves the beneficiary ONLY from the payment's own snapshotted roster_member_id -> roster_members.claimed_by — never from a client parameter", () => {
    const fn = body();
    expect(fn).toMatch(
      /if v_payment\.roster_member_id is not null then\s*\n\s*select claimed_by into v_beneficiary_user_id\s*\n\s*from public\.roster_members\s*\n\s*where id = v_payment\.roster_member_id;/,
    );
    // No function parameter carries a client-supplied beneficiary.
    expect(fn).not.toMatch(/p_beneficiary/);
  });

  it("correction 4: when a pending request already exists, recomputes the current amount and NEVER overwrites requested_amount_cents", () => {
    const fn = body();
    const foundBranch = fn.slice(fn.indexOf("if found then"), fn.indexOf("if v_refundable <= 0 then"));
    expect(foundBranch).toContain("if v_existing.requested_amount_cents <> v_refundable then");
    expect(foundBranch).not.toMatch(/requested_amount_cents\s*=/);
    expect(foundBranch).toContain("policy_refundable_cents_at_cancellation  = v_refundable,");
    expect(foundBranch).toContain("return v_existing.id;");
  });

  it("correction 4: appends to existing notes rather than destroying them on a mismatch", () => {
    const fn = body();
    expect(fn).toContain("v_notes := v_existing.notes;");
    expect(fn).toMatch(/v_notes \|\| E'\\n' \|\| 'Policy-computed refundable amount at cancellation:/);
  });

  it("always attaches beneficiary context to an existing pending request via coalesce — never overwrites an already-set beneficiary", () => {
    const fn = body();
    expect((fn.match(/beneficiary_user_id\s*=\s*coalesce\(beneficiary_user_id, v_beneficiary_user_id\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("the race-caught (unique_violation) branch performs the identical attach-to-winner logic — never a duplicate pending request, never an error surfaced to the caller", () => {
    const fn = body();
    const exceptionBlocks = fn.match(/exception\s*\n\s*when [a-z_]+ then/gi) ?? [];
    expect(exceptionBlocks.length).toBe(1);
    expect(exceptionBlocks[0]).toMatch(/when unique_violation then/i);
    const exceptionBranch = fn.slice(fn.indexOf("when unique_violation then"));
    expect(exceptionBranch).toContain("for update;");
    expect(exceptionBranch).toContain("return v_existing.id;");
  });

  it("never fabricates a manual refund — skips when the payment's mode at creation was not court_time_payments", () => {
    const fn = body();
    expect(fn).toContain("if v_payment.payment_mode_at_creation <> 'court_time_payments' then");
  });

  it("the multi-Checkout-attempt finding is preserved on the fresh-insert path", () => {
    const fn = body();
    expect(fn).toMatch(
      /select count\(\*\) into v_completed_attempts_count\s*\n\s*from public\.payment_checkout_attempts\s*\n\s*where payment_id = p_payment_id and status = 'completed';/,
    );
  });

  it("creates fresh requests with source = 'cancellation_policy' and both new provenance columns populated", () => {
    const fn = body();
    expect(fn).toMatch(
      /insert into public\.payment_refund_requests \(\s*\n\s*club_id, payment_id, requested_by, requested_amount_cents, reason, notes, source,\s*\n\s*beneficiary_user_id, policy_refundable_cents_at_cancellation\s*\n\s*\) values \(\s*\n\s*p_club_id, p_payment_id, p_actor_id, v_refundable, v_reason, v_notes, 'cancellation_policy',\s*\n\s*v_beneficiary_user_id, v_refundable\s*\n\s*\)/,
    );
  });

  it("never writes to payments or payment_events — request creation is a pure, isolated insert/update", () => {
    const fn = body();
    expect(fn).not.toMatch(/update\s+public\.payments|insert into public\.payment_events/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F & G. reject_refund_request / _complete_refund_request_for_attempt —
//        correction 3, the beneficiary-aware notification split
// ═══════════════════════════════════════════════════════════════════════════

describe("reject_refund_request — beneficiary-aware notification split", () => {
  const body = () => functionBody(migrationSql(), "reject_refund_request");

  it("case A: the existing requested_by/admin-linked notification is preserved, now gated on source = 'staff_requested'", () => {
    const fn = body();
    expect(fn).toMatch(
      /if v_request\.source = 'staff_requested' then\s*\n\s*insert into public\.notifications[\s\S]*?v_club_id, v_request\.requested_by, 'refund_request_rejected',\s*\n\s*'Your refund request was not approved\.',\s*\n\s*jsonb_build_object\('request_id', v_request\.id, 'payment_id', v_request\.payment_id, 'target_path', '\/admin\/payments'\)/,
    );
  });

  it("case B/C: a separate, member-safe notification is sent to beneficiary_user_id when applicable, with no admin deep link and no new notification kind", () => {
    const fn = body();
    expect(fn).toMatch(
      /if v_request\.beneficiary_user_id is not null\s*\n\s*and \(v_request\.source <> 'staff_requested' or v_request\.beneficiary_user_id <> v_request\.requested_by\)\s*\n\s*then/,
    );
    const beneficiaryBlock = fn.slice(fn.lastIndexOf("if v_request.beneficiary_user_id is not null"));
    expect(beneficiaryBlock).toContain("'refund_request_rejected',");
    expect(beneficiaryBlock).not.toMatch(/target_path/);
  });

  it("preserves the execution-started guard and payment-first lock order unchanged", () => {
    const fn = body();
    expect(fn).toContain("raise exception 'refund_request_execution_started';");
    const paymentLockIdx = fn.indexOf("from public.payments");
    const requestLockIdx = fn.lastIndexOf("from public.payment_refund_requests\n   where id = p_request_id and club_id = v_club_id\n   for update;");
    expect(requestLockIdx).toBeGreaterThan(paymentLockIdx);
  });
});

describe("_complete_refund_request_for_attempt — beneficiary-aware notification split", () => {
  const body = () => functionBody(migrationSql(), "_complete_refund_request_for_attempt");

  it("case A: the existing requested_by/admin-linked completion notification is preserved, now gated on source = 'staff_requested'", () => {
    const fn = body();
    expect(fn).toMatch(
      /if v_request\.source = 'staff_requested' then\s*\n\s*insert into public\.notifications[\s\S]*?v_request\.club_id, v_request\.requested_by, 'refund_request_completed',\s*\n\s*'Your refund request has been approved and the refund is complete\.',\s*\n\s*jsonb_build_object\('request_id', v_request\.id, 'payment_id', v_request\.payment_id, 'target_path', '\/admin\/payments'\)/,
    );
  });

  it("case B/C: a separate, member-safe completion notification is sent to beneficiary_user_id when applicable, with no admin deep link", () => {
    const fn = body();
    expect(fn).toMatch(
      /if v_request\.beneficiary_user_id is not null\s*\n\s*and \(v_request\.source <> 'staff_requested' or v_request\.beneficiary_user_id <> v_request\.requested_by\)\s*\n\s*then/,
    );
    const beneficiaryBlock = fn.slice(fn.lastIndexOf("if v_request.beneficiary_user_id is not null"));
    expect(beneficiaryBlock).toContain("'refund_request_completed',");
    expect(beneficiaryBlock).not.toMatch(/target_path/);
  });

  it("is still fully private and still idempotent (not-found is a silent no-op)", () => {
    expect(migrationSql()).toMatch(
      /revoke all on function public\._complete_refund_request_for_attempt\(uuid\)\s*\n\s*from public, anon, authenticated, service_role;/,
    );
    const fn = body();
    expect(fn).toContain("if not found then");
    expect(fn).toContain("return;");
  });

  it("never touches reviewed_by/reviewed_at and preserves the completion audit_log insert unchanged", () => {
    const fn = body();
    expect(fn).not.toMatch(/reviewed_by\s*=|reviewed_at\s*=/);
    expect(fn).toContain("'complete_refund_request', 'payment_refund_request', v_request.id,");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// H. cancel_member_reservation
// ═══════════════════════════════════════════════════════════════════════════

describe("cancel_member_reservation (0186)", () => {
  const fn = () => functionBody(migrationSql(), "cancel_member_reservation");

  it("late no longer raises cancellation_window_closed", () => {
    const body = fn();
    expect(body).not.toMatch(/if v_policy_state = 'late' then\s*\n\s*raise exception 'cancellation_window_closed';/);
  });

  it("releases the uncollected balance and ensures the policy refund request together, gated on state <> 'late', after the Checkout guard and before the domain mutation", () => {
    const body = fn();
    const guardIdx = body.indexOf("perform public._invalidate_or_flag_open_checkout_attempt(v_payment_id);");
    const releaseIdx = body.indexOf("perform public._release_uncollected_cancellation_balance(v_club_id, v_payment_id, auth.uid());");
    const requestIdx = body.indexOf("v_refund_request_id := public._ensure_policy_cancellation_refund_request(");
    const updateIdx = body.indexOf("update reservations set");
    expect(body).toContain("if v_policy_state <> 'late' then");
    expect(releaseIdx).toBeGreaterThan(guardIdx);
    expect(requestIdx).toBeGreaterThan(releaseIdx);
    expect(requestIdx).toBeLessThan(updateIdx);
  });

  it("persists cancellation_policy_state and records policy_state/refund_request_id in audit_log metadata", () => {
    const body = fn();
    expect(body).toContain("cancellation_policy_state  = v_policy_state,");
    expect(body).toContain("'policy_state',      v_policy_state,");
    expect(body).toContain("'refund_request_id', v_refund_request_id");
  });

  it("return shape is unchanged — only reservation and notification_id", () => {
    const body = fn();
    const ret = body.slice(body.lastIndexOf("return jsonb_build_object"));
    expect(ret).toMatch(/'reservation',\s*to_jsonb\(v_after\),\s*\n\s*'notification_id', v_notification_id/);
  });

  it("makes no direct write to payments.amount_due_cents/amount_paid_cents/status", () => {
    const body = fn();
    expect(body).not.toMatch(/amount_due_cents\s*=|amount_paid_cents\s*=/);
    expect(body).not.toMatch(/update\s+public\.payments|update\s+payments\b/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// I. admin_cancel_reservation_v2
// ═══════════════════════════════════════════════════════════════════════════

describe("admin_cancel_reservation_v2 (0186)", () => {
  const fn = () => functionBody(migrationSql(), "admin_cancel_reservation_v2");

  it("now locks the reservation row (FOR UPDATE)", () => {
    const body = fn();
    expect(body).toMatch(/and status in \('pending', 'confirmed'\)\s*\n\s*for update;/);
  });

  it("ALWAYS releases the uncollected balance and ensures the policy refund request — no policy-state gate", () => {
    const body = fn();
    expect(body).toMatch(
      /if v_payment_id is not null then\s*\n\s*perform public\._invalidate_or_flag_open_checkout_attempt\(v_payment_id\);\s*\n\s*\n\s*perform public\._release_uncollected_cancellation_balance\(v_profile\.club_id, v_payment_id, auth\.uid\(\)\);\s*\n\s*v_refund_request_id := public\._ensure_policy_cancellation_refund_request\(\s*\n\s*v_profile\.club_id, v_payment_id, auth\.uid\(\), 'not_applicable'\s*\n\s*\);\s*\n\s*end if;/,
    );
  });

  it("persists cancellation_policy_state = 'not_applicable' and no window/timing check exists", () => {
    const body = fn();
    expect(body).toContain("cancellation_policy_state = 'not_applicable',");
    expect(body).not.toMatch(/cancellation_window_hours|_evaluate_cancellation_policy/);
  });

  it("no direct payments write", () => {
    const body = fn();
    expect(body).not.toMatch(/amount_due_cents\s*=|amount_paid_cents\s*=/);
    expect(body).not.toMatch(/update\s+public\.payments|update\s+payments\b/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// J. cancel_lesson
// ═══════════════════════════════════════════════════════════════════════════

describe("cancel_lesson (0186)", () => {
  const fn = () => functionBody(migrationSql(), "cancel_lesson");

  it("the Member-only window check no longer raises within_cancellation_window", () => {
    const body = fn();
    expect(body).not.toMatch(/raise exception 'within_cancellation_window';/);
  });

  it("non-member actors get cancellation_policy_state = 'not_applicable'", () => {
    const body = fn();
    expect(body).toMatch(/else\s*\n\s*v_policy_state := 'not_applicable';\s*\n\s*end if;/);
  });

  it("reuses the ALREADY-locked payment id for both the release and the refund-request calls — no second lock acquisition", () => {
    const body = fn();
    const guardIdx = body.indexOf("perform public._invalidate_or_flag_open_checkout_attempt(v_payment_id_for_checkout_guard);");
    const releaseIdx = body.indexOf("perform public._release_uncollected_cancellation_balance(v_profile.club_id, v_payment_id_for_checkout_guard, auth.uid());");
    const requestIdx = body.indexOf("v_refund_request_id := public._ensure_policy_cancellation_refund_request(");
    expect(releaseIdx).toBeGreaterThan(guardIdx);
    expect(requestIdx).toBeGreaterThan(releaseIdx);
    expect((body.match(/from public\.payments\s*\n\s*where club_id = v_profile\.club_id and domain_type = 'lesson_request'/g) ?? []).length).toBe(1);
  });

  it("skips both calls only for a Member's 'late' cancellation", () => {
    const body = fn();
    expect(body).toContain("if v_policy_state <> 'late' then");
  });

  it("persists cancellation_policy_state on the lesson_requests row and still has no audit_log insert", () => {
    const body = fn();
    expect(body).toContain("cancellation_policy_state = v_policy_state,");
    expect(body).not.toMatch(/insert into (public\.)?audit_log/);
  });

  it("preserves the not_authorised_to_cancel allowlist and the admin/staff already-started exemption unchanged", () => {
    const body = fn();
    expect(body).toContain(
      "if not (v_is_member_by_history or v_is_member_by_roster or v_is_pro or v_is_admin or v_profile.role = 'staff') then",
    );
    expect(body).toContain("if v_effective_starts_at <= now() and v_profile.role not in ('admin', 'staff') then");
  });

  it("no direct payments write", () => {
    const body = fn();
    expect(body).not.toMatch(/amount_due_cents\s*=|amount_paid_cents\s*=/);
    expect(body).not.toMatch(/update\s+public\.payments|update\s+payments\b/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// K. AUTH — Member/Pro paths never traverse the Admin/Staff role gate
// ═══════════════════════════════════════════════════════════════════════════

describe("AUTH — policy-refund calculation never traverses the public Admin/Staff role gate", () => {
  it("cancel_member_reservation (Member/Pro-only role check) reaches the refund-request primitive without ever calling the public get_online_refundable_amount_for_payments RPC", () => {
    const sql = migrationSql();
    const fn = functionBody(sql, "cancel_member_reservation");
    expect(fn).toContain("if v_role is null or v_role not in ('member', 'pro') then");
    expect(fn).not.toContain("get_online_refundable_amount_for_payments(");
  });

  it("cancel_lesson's Member branch (which assigned-Pro/Admin/Staff never enter) reaches the same primitive without the public RPC", () => {
    const sql = migrationSql();
    const fn = functionBody(sql, "cancel_lesson");
    expect(fn).not.toContain("get_online_refundable_amount_for_payments(");
  });

  it("_ensure_policy_cancellation_refund_request itself never calls the public, role-gated RPC — only the private calculation", () => {
    const fn = functionBody(migrationSql(), "_ensure_policy_cancellation_refund_request");
    expect(fn).not.toContain("get_online_refundable_amount_for_payments(");
    expect(fn).toContain("_compute_online_refundable_amounts(");
  });

  it("the public RPC remains Admin/Staff only — unreachable directly by Member or Pro", () => {
    const fn = functionBody(migrationSql(), "get_online_refundable_amount_for_payments");
    expect(fn).toContain("if v_role not in ('admin', 'staff') then raise exception 'insufficient_role'; end if;");
  });

  it("the private calculation is granted to no role at all — unreachable directly by any client", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/grant execute on function public\._compute_online_refundable_amounts/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// L. UNCOLLECTED BALANCE behavior matrix
// ═══════════════════════════════════════════════════════════════════════════

describe("UNCOLLECTED BALANCE — behavior matrix", () => {
  it("unpaid -> void_payment_obligation event for the full due amount", () => {
    const fn = functionBody(migrationSql(), "_release_uncollected_cancellation_balance");
    expect(fn).toContain("'void_payment_obligation', v_payment.amount_due_cents,");
  });

  it("partially_paid -> waived event for exactly the uncollected remainder (due - paid)", () => {
    const fn = functionBody(migrationSql(), "_release_uncollected_cancellation_balance");
    expect(fn).toContain("v_remaining := v_payment.amount_due_cents - v_payment.amount_paid_cents;");
    expect(fn).toContain("'waived', v_remaining,");
  });

  it("late Member cancellation calls neither the release helper nor the refund-request helper — gated by the same v_policy_state <> 'late' condition", () => {
    for (const name of ["cancel_member_reservation", "cancel_lesson"]) {
      const fn = functionBody(migrationSql(), name);
      const gateIdx = fn.indexOf("if v_policy_state <> 'late' then");
      const releaseIdx = fn.indexOf("_release_uncollected_cancellation_balance(");
      const requestIdx = fn.indexOf("_ensure_policy_cancellation_refund_request(");
      expect(gateIdx).toBeGreaterThan(-1);
      expect(releaseIdx).toBeGreaterThan(gateIdx);
      expect(requestIdx).toBeGreaterThan(gateIdx);
    }
  });

  it("paid/overpaid/partially_refunded/refunded/waived/void never get a fabricated uncollected-balance event — only 'unpaid' and 'partially_paid' are handled", () => {
    const fn = functionBody(migrationSql(), "_release_uncollected_cancellation_balance");
    expect(fn).not.toMatch(/'paid'|'overpaid'|'partially_refunded'|'refunded'/);
    // 'waived'/'void' appear only as the payment_events event_type this
    // function itself inserts, never as a payments.status branch condition.
    expect(fn).not.toMatch(/v_payment\.status = 'waived'|v_payment\.status = 'void'/);
  });

  it("no direct payments rollup writes anywhere in 0186 — every financial change is an append-only payment_events insert", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/set\s+[\s\S]{0,80}amount_due_cents\s*=/i);
    expect(sql).not.toMatch(/set\s+[\s\S]{0,80}amount_paid_cents\s*=/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// M. BENEFICIARY behavior
// ═══════════════════════════════════════════════════════════════════════════

describe("BENEFICIARY — trusted resolution and notification targeting", () => {
  it("beneficiary is derived exclusively from payments.roster_member_id -> roster_members.claimed_by — never a function parameter", () => {
    const fn = functionBody(migrationSql(), "_ensure_policy_cancellation_refund_request");
    expect(fn).toContain("from public.roster_members\n     where id = v_payment.roster_member_id;");
  });

  it("a no-account (unclaimed) roster member naturally yields a NULL beneficiary — claimed_by is read as-is, never defaulted", () => {
    const fn = functionBody(migrationSql(), "_ensure_policy_cancellation_refund_request");
    expect(fn).not.toMatch(/coalesce\(v_beneficiary_user_id/);
  });

  it("ordinary Staff request behavior is unchanged — reject/complete only send the beneficiary notification when beneficiary_user_id is actually set, which create_refund_request never sets", () => {
    const createRefundRequestTouched = migrationSql().includes("create or replace function public.create_refund_request(");
    expect(createRefundRequestTouched).toBe(false);
  });

  it("beneficiary outcome notifications never carry an /admin/payments target_path", () => {
    for (const name of ["reject_refund_request", "_complete_refund_request_for_attempt"]) {
      const fn = functionBody(migrationSql(), name);
      const beneficiaryBlockStart = fn.lastIndexOf("if v_request.beneficiary_user_id is not null");
      const beneficiaryBlock = fn.slice(beneficiaryBlockStart);
      expect(beneficiaryBlock).not.toMatch(/\/admin\/payments/);
    }
  });

  it("dedup: the beneficiary block is skipped when source is staff_requested AND beneficiary equals requested_by", () => {
    for (const name of ["reject_refund_request", "_complete_refund_request_for_attempt"]) {
      const fn = functionBody(migrationSql(), name);
      expect(fn).toContain("v_request.source <> 'staff_requested' or v_request.beneficiary_user_id <> v_request.requested_by");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// N. PENDING MISMATCH behavior
// ═══════════════════════════════════════════════════════════════════════════

describe("PENDING MISMATCH — existing request amount is never silently overwritten", () => {
  const fn = () => functionBody(migrationSql(), "_ensure_policy_cancellation_refund_request");

  it("a matching pending request is reused without a notes mutation forced on it", () => {
    const body = fn();
    // The notes reassignment is unconditional on v_notes := v_existing.notes
    // (a pure copy) — only the mismatch branch appends anything further.
    expect(body).toContain("v_notes := v_existing.notes;");
  });

  it("a mismatched pending request keeps its own requested_amount_cents and records the policy amount separately", () => {
    const body = fn();
    const foundBranch = body.slice(body.indexOf("if found then"), body.indexOf("if v_refundable <= 0 then"));
    expect(foundBranch).not.toMatch(/set[\s\S]*requested_amount_cents/);
    expect(foundBranch).toContain("policy_refundable_cents_at_cancellation  = v_refundable,");
  });

  it("cancellation still succeeds regardless of a mismatch — the helper always returns a value or NULL, never raises for this case", () => {
    const body = fn();
    const foundBranch = body.slice(body.indexOf("if found then"), body.indexOf("return v_existing.id;\n  end if;") + 40);
    expect(foundBranch).not.toMatch(/raise exception/);
  });

  it("no duplicate pending request is ever created — the found branch always returns before reaching the INSERT", () => {
    const body = fn();
    const foundIdx = body.indexOf("if found then");
    const returnIdx = body.indexOf("return v_existing.id;", foundIdx);
    const insertIdx = body.indexOf("insert into public.payment_refund_requests (");
    expect(returnIdx).toBeGreaterThan(foundIdx);
    expect(returnIdx).toBeLessThan(insertIdx);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// O. Security & scope discipline
// ═══════════════════════════════════════════════════════════════════════════

describe("security — authorization is unchanged and internal primitives are unreachable by clients", () => {
  it("0186 does not redefine create_refund_request, begin_refund_request_execution, or open_payment_refund_attempt — Staff-created refund request behavior and Stripe execution/idempotency are unmodified", () => {
    const sql = migrationSql();
    for (const name of ["create_refund_request", "begin_refund_request_execution", "open_payment_refund_attempt"]) {
      expect(sql).not.toMatch(new RegExp(`create or replace function public\\.${name}\\(`));
    }
  });

  it("get_online_refundable_amount_for_payments and reject_refund_request/_complete_refund_request_for_attempt ARE redefined (deliberately, corrections 1 and 3) but neither gains a new client-facing grant", () => {
    const sql = migrationSql();
    expect(sql).toMatch(/create or replace function public\.get_online_refundable_amount_for_payments\(/);
    expect(sql).toMatch(/create or replace function public\.reject_refund_request\(/);
    expect(sql).toMatch(/create or replace function public\._complete_refund_request_for_attempt\(/);
  });

  it("neither new private primitive is granted to any client-facing role", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/grant execute on function public\._ensure_policy_cancellation_refund_request/);
    expect(sql).not.toMatch(/grant execute on function public\._release_uncollected_cancellation_balance/);
    expect(sql).not.toMatch(/grant execute on function public\._compute_online_refundable_amounts/);
  });

  it("every payment/reservation/lesson lookup this migration adds is scoped by club_id — no cross-club access", () => {
    const sql = migrationSql();
    expect(sql).toContain("where id = p_payment_id and club_id = p_club_id");
    expect(sql).toContain("where club_id = v_club_id and domain_type = 'reservation' and domain_id = p_reservation_id");
    expect(sql).toContain("where club_id = v_profile.club_id and domain_type = 'reservation' and domain_id = p_reservation_id");
  });

  it("touches exactly the expected set of functions — three new private primitives, two redefined shared primitives, two redefined outcome notifiers, three redefined cancel RPCs", () => {
    const matches = migrationSql().match(/create or replace function public\.\w+/g) ?? [];
    const names = new Set(matches.map((m) => m.replace("create or replace function public.", "")));
    expect(names).toEqual(
      new Set([
        "_compute_online_refundable_amounts",
        "get_online_refundable_amount_for_payments",
        "_release_uncollected_cancellation_balance",
        "_ensure_policy_cancellation_refund_request",
        "reject_refund_request",
        "_complete_refund_request_for_attempt",
        "cancel_member_reservation",
        "admin_cancel_reservation_v2",
        "cancel_lesson",
      ]),
    );
  });

  it("does not touch any event/program RPC", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/cancel_event|cancel_program|leave_event|leave_program|admin_remove_participant|admin_remove_guest|remove_program_member/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// P. MONEY / non-regression — Stripe execution stays fully decoupled
// ═══════════════════════════════════════════════════════════════════════════

describe("MONEY — no Stripe call inside cancellation; execution/idempotency/reconciliation unchanged", () => {
  it("0186 contains no Stripe API reference of any kind", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/stripe\.refunds|stripe\.checkout|require\(['"]stripe['"]\)/i);
  });

  it("0186 never inserts an online_refund_recorded/refund_recorded/online_payment_recorded payment_events row — only void_payment_obligation/waived, both append-only and both already-established event types", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/'online_refund_recorded'|'refund_recorded'|'online_payment_recorded'/);
  });

  it("no new club_settings auto-refund/auto-approve setting exists anywhere in 0186", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/auto_approve|auto_refund/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Q. Server Action retry handshake (reservations) — unchanged from the
//    first draft; cancel_lesson's Server Action already had this
// ═══════════════════════════════════════════════════════════════════════════

describe("Server Action Checkout-resolution retry handshake", () => {
  it("adminCancelReservation resolves a blocking Checkout attempt and retries admin_cancel_reservation_v2 exactly once", () => {
    const src = readSource(CALENDAR_ACTIONS_PATH);
    const fnStart = src.indexOf("export async function adminCancelReservation(");
    const fnEnd = src.indexOf("export async function updateMemberReservationAdmin(");
    const fn = src.slice(fnStart, fnEnd);
    expect(fn).toContain("rpcError?.message.includes(OPEN_CHECKOUT_REQUIRES_RESOLUTION)");
    expect(fn).toContain('fetchPaymentStates("reservation", [reservationId])');
    expect(fn).toContain("await resolveBlockingCheckoutBeforeMutation(paymentId, expectedClubId)");
    expect((fn.match(/supabase\.rpc\(\s*\n\s*"admin_cancel_reservation_v2"/g) ?? []).length).toBe(2);
  });

  it("cancelMemberReservation resolves a blocking Checkout attempt and retries cancel_member_reservation exactly once", () => {
    const src = readSource(CALENDAR_ACTIONS_PATH);
    const fnStart = src.indexOf("export async function cancelMemberReservation(");
    const fnEnd = src.indexOf("// ---------------------------------------------------------------------------\n// Phase 37D", fnStart);
    const fn = src.slice(fnStart, fnEnd > 0 ? fnEnd : undefined);
    expect(fn).toContain("rpcError?.message.includes(OPEN_CHECKOUT_REQUIRES_RESOLUTION)");
    expect(fn).toContain('fetchPaymentStates("reservation", [reservationId])');
    expect((fn.match(/supabase\.rpc\("cancel_member_reservation"/g) ?? []).length).toBe(2);
  });

  it("cancelLesson's Server Action already has the identical handshake and is untouched by this phase", () => {
    const src = readSource(LESSONS_ACTIONS_PATH);
    const fnStart = src.indexOf("export async function cancelLesson(params: {");
    const fnEnd = src.indexOf("export async function", fnStart + 1);
    const fn = src.slice(fnStart, fnEnd);
    expect(fn).toContain("error?.message.includes(OPEN_CHECKOUT_REQUIRES_RESOLUTION)");
    expect((fn.match(/supabase\.rpc\("cancel_lesson"/g) ?? []).length).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// R. Non-regression — late cancellation still frees inventory; events/
//    programs untouched
// ═══════════════════════════════════════════════════════════════════════════

describe("non-regression", () => {
  it("late cancellation still transitions the domain row to cancelled (inventory is freed) — only the financial calls are skipped, never the status mutation", () => {
    for (const [name, updateNeedle] of [
      ["cancel_member_reservation", "status                     = 'cancelled',"],
      ["cancel_lesson", "status            = 'cancelled',"],
    ] as const) {
      const fn = functionBody(migrationSql(), name);
      expect(fn).toContain(updateNeedle);
      // The status UPDATE is unconditional — never itself inside the
      // `if v_policy_state <> 'late'` gate.
      const gateEnd = fn.indexOf("end if;", fn.indexOf("if v_policy_state <> 'late' then"));
      const updateIdx = fn.indexOf(updateNeedle);
      expect(updateIdx).toBeGreaterThan(gateEnd);
    }
  });

  it("events/programs remain completely untouched", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/cancel_event|cancel_program|leave_event\b|leave_program\b/);
  });
});
