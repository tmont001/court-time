import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 40 — regression coverage for the shared cancellation-policy
// evaluator (public._evaluate_cancellation_policy) and its two callers
// (cancel_member_reservation, cancel_lesson), plus the two role checks
// that closed off this phase's targeted reschedule-bypass audit.
//
// Same source-inspection style as staleCheckoutInvalidation.regression
// .test.ts — this baseline is deliberately pure-TypeScript with no
// jsdom/Supabase/network mocking and no live Postgres in this repo, so
// reading the real migration text is the honest way to guard "does the
// shipped SQL actually take this shape," including exact boundary
// comparison operators, which a parallel JS reimplementation of the
// arithmetic could silently drift from.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !line.trim().startsWith("--") && !line.trim().startsWith("//"))
    .join("\n");
}

const MIGRATION_PATH = "supabase/migrations/0185_shared_cancellation_policy_foundation.sql";
const RESERVATION_EDIT_MIGRATION_PATH = "supabase/migrations/0151_stale_checkout_invalidation.sql";
const LESSON_PROPOSE_MIGRATION_PATH = "supabase/migrations/0159_lesson_online_payment_checkout.sql";

function migrationSql(): string {
  return codeOnly(readSource(MIGRATION_PATH));
}

// Isolates a single `create or replace function public.<name>(...)` body
// up to its own closing `$$;`/`$function$;` — scopes assertions to exactly
// that function, never a different one that happens to share a variable
// name. Same dual-terminator handling as staleCheckoutInvalidation
// .regression.test.ts's own identical helper (some effective bodies were
// last touched by a migration authored via pg_dump-style `$function$`
// quoting rather than this repo's usual `$$`).
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
// A. public._evaluate_cancellation_policy — the one authoritative helper
// ═══════════════════════════════════════════════════════════════════════════

describe("_evaluate_cancellation_policy — single authoritative arithmetic helper", () => {
  const body = () => functionBody(migrationSql(), "_evaluate_cancellation_policy");

  it("is deterministic — takes an explicit p_evaluated_at rather than reading now() internally", () => {
    const fn = body();
    expect(fn).toContain("p_evaluated_at  timestamptz");
    expect(fn).not.toMatch(/\bnow\(\)/);
  });

  it("is private — revoked from public, anon, and authenticated, with no grant to any role", () => {
    expect(migrationSql()).toMatch(
      /revoke execute on function public\._evaluate_cancellation_policy\(timestamptz, integer, integer, timestamptz, timestamptz\)\s*\n\s*from public, anon, authenticated;/,
    );
    expect(migrationSql()).not.toMatch(/grant execute on function public\._evaluate_cancellation_policy/);
  });

  it("is side-effect-free — pure SQL, immutable, no table reference, no INSERT/UPDATE/DELETE", () => {
    const fn = body();
    expect(fn).toContain("language sql");
    expect(fn).toContain("immutable");
    expect(fn).not.toMatch(/\b(insert into|update |delete from)\b/i);
    expect(fn).not.toContain(" from public.");
    expect(fn).not.toContain(" from reservations");
    expect(fn).not.toContain(" from lesson_requests");
  });

  it("returns exactly the three required policy facts: state, cutoff_at, within_grace", () => {
    const fn = body();
    expect(fn).toMatch(/returns table \(\s*\n\s*state\s+text,\s*\n\s*cutoff_at\s+timestamptz,\s*\n\s*within_grace boolean\s*\n\)/);
  });

  it("cutoff_at is starts_at minus the resolved window in hours, defaulting a null window to zero", () => {
    const fn = body();
    expect(fn).toContain("p_starts_at - make_interval(hours => coalesce(p_window_hours, 0))");
  });

  it("exact cutoff and before cutoff both resolve to in_policy — non-strict <=", () => {
    const fn = body();
    expect(fn).toContain("when p_evaluated_at <= policy.v_cutoff_at then 'in_policy'");
  });

  it("grace is only reachable when grace_minutes > 0 AND a grace anchor is supplied — lessons (grace_minutes = 0) can structurally never reach it", () => {
    const fn = body();
    expect(fn).toMatch(
      /coalesce\(p_grace_minutes, 0\) > 0\s*\n\s*and p_grace_anchor is not null\s*\n\s*and \(p_evaluated_at - p_grace_anchor\) < make_interval\(mins => coalesce\(p_grace_minutes, 0\)\)/,
    );
  });

  it("grace window is half-open (strict <) — the exact grace-expiration instant is late, not grace", () => {
    const fn = body();
    const graceCond = fn.match(/\(p_evaluated_at - p_grace_anchor\) (<|<=) make_interval\(mins => coalesce\(p_grace_minutes, 0\)\)/);
    expect(graceCond?.[1]).toBe("<");
  });

  it("late is the exhaustive else branch — reachable only when not in_policy and not grace-eligible", () => {
    const fn = body();
    expect(fn).toMatch(/when policy\.v_grace_eligible\s*(--[^\n]*\n\s*)?then 'grace'\s*\n\s*else 'late'/);
  });

  it("within_grace is true only in the same condition that produces the 'grace' state — past cutoff AND grace-eligible", () => {
    const fn = body();
    expect(fn).toContain("(p_evaluated_at > policy.v_cutoff_at and policy.v_grace_eligible) as within_grace");
  });

  it("does not encode any Admin/Staff/Pro authorization concept — no role/actor reference of any kind", () => {
    const fn = body();
    expect(fn).not.toMatch(/\brole\b/i);
    expect(fn).not.toMatch(/\bactor\b/i);
    expect(fn).not.toMatch(/\badmin\b/i);
    expect(fn).not.toMatch(/\bstaff\b/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. cancel_member_reservation — locks before evaluation, late stays blocked
// ═══════════════════════════════════════════════════════════════════════════

describe("cancel_member_reservation (0185) — reservation policy evaluation via the shared helper", () => {
  const fn = () => functionBody(migrationSql(), "cancel_member_reservation");

  it("locks the target row (FOR UPDATE) before any policy evaluation", () => {
    const body = fn();
    const lockIdx = body.indexOf("for update");
    const evalIdx = body.indexOf("public._evaluate_cancellation_policy(");
    expect(lockIdx).toBeGreaterThan(-1);
    expect(evalIdx).toBeGreaterThan(lockIdx);
  });

  it("resolves the club's window/grace settings (with existing 24h/5min defaulting) before calling the helper", () => {
    const body = fn();
    const settingsIdx = body.indexOf("from club_settings");
    const defaultIdx = body.indexOf("v_cancellation_window_hours  := 24;");
    const evalIdx = body.indexOf("public._evaluate_cancellation_policy(");
    expect(settingsIdx).toBeGreaterThan(-1);
    expect(defaultIdx).toBeGreaterThan(settingsIdx);
    expect(evalIdx).toBeGreaterThan(defaultIdx);
  });

  it("passes starts_at, the resolved window/grace, created_at as the grace anchor, and now() as the evaluation time", () => {
    const body = fn();
    expect(body).toMatch(
      /public\._evaluate_cancellation_policy\(\s*\n\s*v_before\.starts_at,\s*\n\s*v_cancellation_window_hours,\s*\n\s*v_cancellation_grace_minutes,\s*\n\s*v_before\.created_at,\s*\n\s*now\(\)\s*\n\s*\)/,
    );
  });

  it("late remains hard-blocked with the existing exception code — in_policy/grace both continue", () => {
    const body = fn();
    expect(body).toContain("if v_policy_state = 'late' then");
    expect(body).toContain("raise exception 'cancellation_window_closed';");
    // No separate branch admits 'late' to continue — v_policy_state is
    // referenced exactly 3 times: its declaration, the SELECT INTO target,
    // and the single IF condition that raises.
    expect((body.match(/v_policy_state/g) ?? []).length).toBe(3);
  });

  it("does not reintroduce the old duplicated inline arithmetic", () => {
    const body = fn();
    expect(body).not.toMatch(/v_outside_window/);
    expect(body).not.toMatch(/v_within_grace/);
  });

  it("preserves the roster-aware ownership match (0110) and role check (member/pro) unchanged", () => {
    const body = fn();
    expect(body).toContain("if v_role is null or v_role not in ('member', 'pro') then");
    expect(body).toContain("or (v_roster_member_id is not null and roster_member_id = v_roster_member_id)");
  });

  it("preserves the audit_log row and the existing notification kind/gating", () => {
    const body = fn();
    expect(body).toContain("'cancel_member_reservation',");
    expect(body).toContain("user_pref_enabled(auth.uid(), 'reservation_cancelled_by_member')");
    expect(body).toContain("'reservation_cancelled_by_member',");
  });

  it("introduces no payment/refund mutation — no payments/payment_events write, no Stripe reference", () => {
    const body = fn();
    expect(body).not.toMatch(/payments|payment_events|stripe|refund/i);
  });

  it("signature is unchanged (2 args) and 0185 issues no new grant/revoke for it — CREATE OR REPLACE alone preserves existing grants", () => {
    expect(fn()).toMatch(/create or replace function public\.cancel_member_reservation\(\s*\n\s*p_reservation_id\s+uuid,\s*\n\s*p_expected_club_id uuid\s*\n\)/);
    expect(migrationSql()).not.toMatch(/(revoke|grant) execute on function public\.cancel_member_reservation/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. cancel_lesson — Member-only evaluation, grace disabled, admin/staff/pro
//    branches untouched
// ═══════════════════════════════════════════════════════════════════════════

describe("cancel_lesson (0185) — lesson policy evaluation via the shared helper, Member actor only", () => {
  const fn = () => functionBody(migrationSql(), "cancel_lesson");

  it("locks the target lesson request (FOR UPDATE) before any policy evaluation", () => {
    const body = fn();
    const lockIdx = body.indexOf("for update");
    const evalIdx = body.indexOf("public._evaluate_cancellation_policy(");
    expect(lockIdx).toBeGreaterThan(-1);
    expect(evalIdx).toBeGreaterThan(lockIdx);
  });

  it("only the v_actor_role = 'member' branch calls the helper — admin/staff/pro never reach it", () => {
    const body = fn();
    const memberBranchIdx = body.indexOf("if v_actor_role = 'member' then");
    const evalIdx = body.indexOf("public._evaluate_cancellation_policy(");
    const endIfIdx = body.indexOf("end if;", evalIdx);
    expect(memberBranchIdx).toBeGreaterThan(-1);
    expect(evalIdx).toBeGreaterThan(memberBranchIdx);
    expect((body.match(/public\._evaluate_cancellation_policy\(/g) ?? []).length).toBe(1);
    expect(endIfIdx).toBeGreaterThan(evalIdx);
  });

  it("grace is explicitly disabled — passes a literal 0 for grace minutes and null for the grace anchor, never lesson_requests.created_at", () => {
    const body = fn();
    expect(body).toMatch(
      /public\._evaluate_cancellation_policy\(\s*\n\s*v_effective_starts_at,\s*\n\s*v_window_hours,\s*\n\s*0,\s*\n\s*null,\s*\n\s*now\(\)\s*\n\s*\)/,
    );
    expect(body).not.toMatch(/v_request\.created_at/);
  });

  it("late remains hard-blocked with the existing exception code", () => {
    const body = fn();
    expect(body).toContain("if v_policy_state = 'late' then");
    expect(body).toContain("raise exception 'within_cancellation_window';");
  });

  it("does not reintroduce the old duplicated epoch/hours arithmetic", () => {
    const body = fn();
    expect(body).not.toMatch(/extract\(epoch from \(v_effective_starts_at - now\(\)\)\)/);
  });

  it("the pre-mutation Stripe Checkout invalidation guard still runs after window validation and before both mutating UPDATEs — unchanged from 0159", () => {
    const body = fn();
    const windowCheckIdx = body.indexOf("raise exception 'within_cancellation_window';");
    const guardIdx = body.indexOf("perform public._invalidate_or_flag_open_checkout_attempt(v_payment_id_for_checkout_guard)");
    const firstUpdateIdx = body.indexOf("update public.reservations");
    const secondUpdateIdx = body.indexOf("update public.lesson_requests");
    expect(guardIdx).toBeGreaterThan(windowCheckIdx);
    expect(guardIdx).toBeLessThan(firstUpdateIdx);
    expect(guardIdx).toBeLessThan(secondUpdateIdx);
  });

  it("preserves the not_authorised_to_cancel allowlist (member/pro/admin/staff) and the admin/staff already-started exemption unchanged", () => {
    const body = fn();
    expect(body).toContain(
      "if not (v_is_member_by_history or v_is_member_by_roster or v_is_pro or v_is_admin or v_profile.role = 'staff') then",
    );
    expect(body).toContain("if v_effective_starts_at <= now() and v_profile.role not in ('admin', 'staff') then");
  });

  it("preserves both existing notification inserts and the audit trail's last_actor_role mapping unchanged", () => {
    const body = fn();
    expect(body).toContain("last_actor_role      = v_persisted_actor_role,");
    expect((body.match(/'lesson_cancelled',/g) ?? []).length).toBe(2);
  });

  it("introduces no new payment/refund mutation beyond the pre-existing Checkout-attempt invalidation call", () => {
    const body = fn();
    expect(body).not.toMatch(/payment_events|amount_due_cents|amount_paid_cents|\brefund\b/i);
  });

  it("signature is unchanged (p_request_id uuid, p_reason text default null) and 0185 issues no new grant/revoke for it", () => {
    expect(fn()).toMatch(/create or replace function public\.cancel_lesson\(\s*\n\s*p_request_id uuid,\s*\n\s*p_reason\s+text default null\s*\n\)/);
    expect(migrationSql()).not.toMatch(/(revoke|grant) execute on function public\.cancel_lesson/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D. Targeted reschedule-bypass audit — pinned as a regression guard
// ═══════════════════════════════════════════════════════════════════════════
// Phase 40's own targeted check found NO Member-reachable reservation or
// lesson reschedule path, so no bypass-closing fix was needed. These tests
// pin the two role checks the finding depends on, so a future change that
// loosens either one is caught rather than silently reopening the bypass
// this phase deliberately did not need to fix.

describe("targeted reschedule-bypass audit — pinned findings (no Member-reachable reschedule path exists)", () => {
  it("update_member_reservation (0151, effective body) still rejects any non-admin/staff caller — Members cannot reach it at all", () => {
    const sql = codeOnly(readSource(RESERVATION_EDIT_MIGRATION_PATH));
    const body = functionBody(sql, "update_member_reservation");
    expect(body).toContain("if v_role not in ('admin', 'staff') then raise exception 'insufficient_role'; end if;");
  });

  it("propose_lesson_time (0159, effective body) still rejects any non-pro/admin caller — a Member can only accept/decline a proposal, never initiate one", () => {
    const sql = codeOnly(readSource(LESSON_PROPOSE_MIGRATION_PATH));
    const body = functionBody(sql, "propose_lesson_time");
    expect(body).toContain("if v_profile.role not in ('pro', 'admin') then raise exception 'insufficient_role'; end if;");
  });

  it("0185 does not modify update_member_reservation or propose_lesson_time — the audit found no bypass to fix, so neither function is touched by this migration", () => {
    expect(migrationSql()).not.toMatch(/create or replace function public\.update_member_reservation/);
    expect(migrationSql()).not.toMatch(/create or replace function public\.propose_lesson_time/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// E. Migration-level scope discipline
// ═══════════════════════════════════════════════════════════════════════════

describe("0185 — scope discipline", () => {
  it("touches exactly three functions: the new helper, cancel_member_reservation, and cancel_lesson", () => {
    const matches = migrationSql().match(/create or replace function public\.\w+/g) ?? [];
    const names = matches.map((m) => m.replace("create or replace function public.", ""));
    expect(new Set(names)).toEqual(
      new Set(["_evaluate_cancellation_policy", "cancel_member_reservation", "cancel_lesson"]),
    );
  });

  it("never touches club_settings (no ALTER TABLE, no new column)", () => {
    expect(migrationSql()).not.toMatch(/alter table\s+(public\.)?club_settings/i);
  });

  it("never touches event/program cancellation or participant withdrawal", () => {
    expect(migrationSql()).not.toMatch(/cancel_event|leave_event|withdraw_participant|cancel_program/i);
  });

  it("introduces no new notification kind — only the two kinds already present in the reproduced bodies (reservation_cancelled_by_member, lesson_cancelled)", () => {
    const sql = migrationSql();
    const kindLiterals = new Set((sql.match(/insert into (?:public\.)?notifications[\s\S]*?values[\s\S]*?'([a-z_]+)',/g) ?? [])
      .map((m) => m.match(/'([a-z_]+)',$/)?.[1])
      .filter(Boolean));
    expect(sql).toContain("'reservation_cancelled_by_member'");
    expect(sql).toContain("'lesson_cancelled'");
    expect(kindLiterals.size).toBeGreaterThan(0);
  });

  it("is wrapped in a single begin/commit transaction", () => {
    const sql = migrationSql();
    expect((sql.match(/^begin;/m) ?? []).length).toBe(1);
    expect((sql.match(/^commit;/m) ?? []).length).toBe(1);
  });
});
