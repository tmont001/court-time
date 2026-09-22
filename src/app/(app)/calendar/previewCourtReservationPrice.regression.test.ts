import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Peak / Off-Peak Pricing — Checkpoint B, Part 1 regression coverage: the
// canonical authenticated reservation-price preview RPC
// (preview_court_reservation_price, migration 0201). 0200
// (court_rate_periods, _resolve_court_reservation_rate, the lifecycle
// RPCs, and the write-path integration) is applied/immutable and is
// consulted here only as a reuse target, never modified.
//
// Same source-inspection style as courtRatePeriods.regression.test.ts —
// no live Postgres in this repo, so the shipped migration text is the
// honest thing to assert against. Migration 0201 is NOT applied to any
// database by this checkpoint.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !line.trim().startsWith("--") && !line.trim().startsWith("//"))
    .join("\n");
}

const MIGRATION_PATH = "supabase/migrations/0201_peak_off_peak_price_preview.sql";

// 0202 — Checkpoint B, Part 1 hotfix: 0201 is applied/immutable (a live
// runtime bug — an ambiguous `currency` column reference — was found
// after this test file's own 0201 coverage above was written). 0202
// republishes preview_court_reservation_price via CREATE OR REPLACE
// (identical signature, no DROP) with exactly one corrected line. See
// the "0202 — currency ambiguity hotfix" suite below.
const HOTFIX_MIGRATION_PATH = "supabase/migrations/0202_peak_off_peak_price_preview_currency_fix.sql";

function migrationSql(): string {
  return codeOnly(readSource(MIGRATION_PATH));
}

function hotfixMigrationSql(): string {
  return codeOnly(readSource(HOTFIX_MIGRATION_PATH));
}

function functionBody(sql: string, name: string): string {
  const pattern = new RegExp(`create or replace function public\\.${name}\\(`, "i");
  const match = pattern.exec(sql);
  expect(match, `function public.${name} not found`).not.toBeNull();
  const start = match!.index;
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
// A. Migration ordering — must build on immutable 0200
// ═══════════════════════════════════════════════════════════════════════════

describe("0201 — migration numbering", () => {
  it("is the next migration after immutable, applied 0200", () => {
    expect(() => readSource("supabase/migrations/0200_court_rate_periods.sql")).not.toThrow();
    expect(() => readSource(MIGRATION_PATH)).not.toThrow();
  });

  it("does not modify 0200 in any way (no ALTER/DROP/CREATE OR REPLACE targeting a 0200 object)", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/alter table public\.court_rate_periods/);
    expect(sql).not.toMatch(/create or replace function public\._resolve_court_reservation_rate/i);
    expect(sql).not.toMatch(/create or replace function public\.upsert_court_rate_period/i);
    expect(sql).not.toMatch(/create or replace function public\.set_court_rate_period_active/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. Signature, authorization shape, and no-duplication of pricing logic
// ═══════════════════════════════════════════════════════════════════════════

describe("0201 — preview_court_reservation_price: signature and reuse", () => {
  const sql = migrationSql();
  const body = functionBody(sql, "preview_court_reservation_price");

  it("has the documented signature: court/time inputs, optional roster target, optional expected club", () => {
    expect(sql).toMatch(
      /create or replace function public\.preview_court_reservation_price\(\s*\n\s*p_court_id\s+uuid,\s*\n\s*p_starts_at\s+timestamptz,\s*\n\s*p_ends_at\s+timestamptz,\s*\n\s*p_roster_member_id\s+uuid default null,\s*\n\s*p_expected_club_id\s+uuid default null\s*\n\)/,
    );
  });

  it("returns exactly the fields a booking preview needs, nothing else", () => {
    expect(sql).toMatch(
      /returns table \(\s*\n\s*membership_pricing_class text,\s*\n\s*hourly_rate_cents\s+integer,\s*\n\s*price_amount_cents\s+integer,\s*\n\s*currency\s+text,\s*\n\s*applied_rate_source\s+text,\s*\n\s*applied_rate_period_id\s+uuid,\s*\n\s*applied_rate_period_name text\s*\n\)/,
    );
  });

  it("calls the SAME shared resolver every write path uses — never reimplements the precedence chain", () => {
    expect(body).toMatch(
      /select \* into v_rate_resolution\s*\n\s*from public\._resolve_court_reservation_rate\(\s*\n\s*v_club_id, p_court_id, v_membership_pricing_class, p_starts_at\s*\n\s*\);/,
    );
  });

  it("does not reproduce the coalesce precedence chain anywhere in its own body", () => {
    expect(body).not.toMatch(/coalesce\(\s*\n?\s*v_court\.hourly_rate/);
    expect(body).not.toMatch(/hourly_rate_non_member_cents,\s*\n\s*v_settings\.default_court_hourly_rate_non_member_cents/);
  });

  it("does not query court_rate_periods directly — all rate-period matching stays inside the resolver", () => {
    expect(body).not.toMatch(/from public\.court_rate_periods/);
    expect(body).not.toMatch(/from court_rate_periods/);
  });

  it("resolves membership_pricing_class via the canonical is_active_club_member predicate — identical formula to every write path", () => {
    expect(body).toMatch(
      /v_membership_pricing_class := case\s*\n\s*when public\.is_active_club_member\(v_target_roster_member_id, v_club_id\) then 'member'\s*\n\s*else 'non_member'\s*\n\s*end;/,
    );
  });

  it("uses the identical round(...) price formula every write path already uses", () => {
    expect(body).toMatch(
      /v_price_amount_cents := round\(v_rate_resolution\.hourly_rate_cents \* extract\(epoch from \(p_ends_at - p_starts_at\)\) \/ 3600\.0\)::integer;/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. Authorization — self-service vs. Admin/Staff explicit-target
// ═══════════════════════════════════════════════════════════════════════════

describe("0201 — preview_court_reservation_price: authorization", () => {
  const sql = migrationSql();
  const body = functionBody(sql, "preview_court_reservation_price");

  it("requires authentication and a resolvable club", () => {
    expect(body).toMatch(/if auth\.uid\(\) is null then\s*\n\s*raise exception 'not_authenticated';/);
    expect(body).toMatch(/if v_club_id is null then\s*\n\s*raise exception 'not_authenticated';/);
  });

  it("fails closed on ANY supplied p_expected_club_id that does not match the caller's own club", () => {
    expect(body).toMatch(
      /if p_expected_club_id is not null and p_expected_club_id is distinct from v_club_id then\s*\n\s*raise exception 'stale_club_context';/,
    );
  });

  it("explicit-target branch (p_roster_member_id not null) requires admin/staff — never widened to pro or member", () => {
    const branchStart = body.indexOf("if p_roster_member_id is not null then");
    const branchEnd = body.indexOf("else", branchStart);
    const branch = body.slice(branchStart, branchEnd);
    expect(branch).toMatch(/if v_role not in \('admin', 'staff'\) then\s*\n\s*raise exception 'insufficient_role';/);
  });

  it("explicit-target branch REQUIRES p_expected_club_id (mirrors admin_create_member_reservation's own required stale-context param)", () => {
    const branchStart = body.indexOf("if p_roster_member_id is not null then");
    const branchEnd = body.indexOf("else", branchStart);
    const branch = body.slice(branchStart, branchEnd);
    expect(branch).toMatch(/if p_expected_club_id is null then\s*\n\s*raise exception 'stale_club_context';/);
  });

  it("explicit-target branch resolves the roster row SAME-CLUB scoped and fails closed if not found (blocks cross-club probing)", () => {
    const branchStart = body.indexOf("if p_roster_member_id is not null then");
    const branchEnd = body.indexOf("else", branchStart);
    const branch = body.slice(branchStart, branchEnd);
    expect(branch).toMatch(
      /select \* into v_roster\s*\n\s*from public\.roster_members\s*\n\s*where id = p_roster_member_id\s*\n\s*and club_id = v_club_id;/,
    );
    expect(branch).toMatch(/if not found then\s*\n\s*raise exception 'roster_member_not_found';/);
  });

  it("self-service branch (p_roster_member_id null) has NO parameter through which a Member could name another identity", () => {
    // Structural guarantee: the self-service branch resolves the target
    // exclusively via the existing canonical helper — there is no
    // client-suppliable roster id anywhere in this branch's own text.
    const elseStart = body.indexOf("else\n    select * into v_profile");
    expect(elseStart).toBeGreaterThan(-1);
    const elseBlock = body.slice(elseStart, body.indexOf("select * into v_court", elseStart));
    expect(elseBlock).toMatch(/v_target_roster_member_id := public\.current_user_roster_member_id\(\);/);
    expect(elseBlock).not.toMatch(/p_roster_member_id/);
  });

  it("self-service branch reproduces create_reservation's own member_self_service capability gate verbatim", () => {
    expect(body).toMatch(
      /if v_role not in \('admin', 'pro'\) and not public\.current_club_has_capability\('member_self_service'\) then\s*\n\s*raise exception 'capability_not_available';/,
    );
  });

  it("self-service branch fails closed if the caller has no roster identity at all", () => {
    expect(body).toMatch(
      /if v_target_roster_member_id is null then\s*\n\s*raise exception 'no_roster_identity';/,
    );
  });

  it("self-service branch reproduces create_reservation's own active-profile invariant: an inactive caller gets 'account_inactive'", () => {
    const elseStart = body.indexOf("else\n    select * into v_profile");
    expect(elseStart).toBeGreaterThan(-1);
    const capabilityGatePos = body.indexOf("if v_role not in ('admin', 'pro')", elseStart);
    const elseBlock = body.slice(elseStart, capabilityGatePos);
    expect(elseBlock).toMatch(
      /select \* into v_profile from public\.profiles where id = auth\.uid\(\);\s*\n\s*if not found then\s*\n\s*raise exception 'not_authenticated';\s*\n\s*end if;\s*\n\s*if v_profile\.status <> 'active' then\s*\n\s*raise exception 'account_inactive';/,
    );
    // The profile/active-status check runs BEFORE the capability gate,
    // matching create_reservation's own ordering exactly.
    const statusCheckPos = body.indexOf("account_inactive", elseStart);
    expect(statusCheckPos).toBeGreaterThan(-1);
    expect(capabilityGatePos).toBeGreaterThan(statusCheckPos);
  });

  it("the active-profile invariant is scoped to the self-service branch ONLY — the explicit-target (Admin/Staff) branch has no profiles lookup or account_inactive check, matching admin_create_member_reservation's own lack of one", () => {
    const branchStart = body.indexOf("if p_roster_member_id is not null then");
    const branchEnd = body.indexOf("else", branchStart);
    const branch = body.slice(branchStart, branchEnd);
    expect(branch).not.toMatch(/account_inactive/);
    expect(branch).not.toMatch(/v_profile/);
    expect(branch).not.toMatch(/from public\.profiles/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D. Input validation — narrow, not a duplicated availability engine
// ═══════════════════════════════════════════════════════════════════════════

describe("0201 — preview_court_reservation_price: narrow input validation", () => {
  const sql = migrationSql();
  const body = functionBody(sql, "preview_court_reservation_price");

  it("validates the court belongs to the club AND is active", () => {
    expect(body).toMatch(
      /select \* into v_court\s*\n\s*from public\.courts\s*\n\s*where id\s+= p_court_id\s*\n\s*and club_id\s+= v_club_id\s*\n\s*and is_active = true;/,
    );
    expect(body).toMatch(/if not found then\s*\n\s*raise exception 'court_not_found';/);
  });

  it("rejects a missing or non-positive duration", () => {
    expect(body).toMatch(
      /if p_starts_at is null or p_ends_at is null or p_ends_at <= p_starts_at then\s*\n\s*raise exception 'invalid_duration';/,
    );
  });

  it("enforces the exact 30/60/90/120-minute supported-duration set, matching every write path", () => {
    expect(body).toMatch(
      /if extract\(epoch from \(p_ends_at - p_starts_at\)\) \/ 60 not in \(30, 60, 90, 120\) then\s*\n\s*raise exception 'invalid_duration';/,
    );
  });

  it("does NOT duplicate the past-date guard, booking-window guard, operating-hours check, or any conflict/overlap check — a preview is not an availability guarantee", () => {
    expect(body).not.toMatch(/cannot_book_past/);
    expect(body).not.toMatch(/outside_booking_window/);
    expect(body).not.toMatch(/outside_operating_hours/);
    expect(body).not.toMatch(/club_closed_this_day/);
    expect(body).not.toMatch(/operating_hours_override/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// E. Truthful applied-rate-source metadata
// ═══════════════════════════════════════════════════════════════════════════

describe("0201 — preview_court_reservation_price: truthful rate-source metadata", () => {
  const sql = migrationSql();
  const body = functionBody(sql, "preview_court_reservation_price");

  it("passes through the resolver's own applied_rate_source/period id/name verbatim — never recomputes or overrides them", () => {
    expect(body).toMatch(/applied_rate_source\s+:= v_rate_resolution\.applied_rate_source;/);
    expect(body).toMatch(/applied_rate_period_id\s+:= v_rate_resolution\.applied_rate_period_id;/);
    expect(body).toMatch(/applied_rate_period_name := v_rate_resolution\.applied_rate_period_name;/);
  });

  it("reads currency from club_settings — the resolver itself returns only a rate, never a currency", () => {
    expect(body).toMatch(/select currency into v_currency from public\.club_settings where club_id = v_club_id;/);
  });
});
// Note: the resolver's OWN guarantee — that applied_rate_period_id/name
// are populated ONLY on the rate_period_* branches, never on a
// court_override_* or club_default_* branch (so a court-override-sourced
// rate can never falsely report a period id/name) — is already covered by
// courtRatePeriods.regression.test.ts's own "0200 — _resolve_court_
// reservation_rate" suite. This RPC adds no second place that metadata
// could diverge, since it passes the resolver's row through unmodified
// (proven above) rather than reconstructing it.

// ═══════════════════════════════════════════════════════════════════════════
// F. Security posture — DEFINER-required, hardened, no client-callable
//    surface for the private resolver, no writes
// ═══════════════════════════════════════════════════════════════════════════

describe("0201 — preview_court_reservation_price: security posture", () => {
  const sql = migrationSql();
  const body = functionBody(sql, "preview_court_reservation_price");

  it("is SECURITY DEFINER (required to reach _resolve_court_reservation_rate, whose EXECUTE is revoked from authenticated), STABLE, with a hardened search_path", () => {
    const sigStart = sql.indexOf("create or replace function public.preview_court_reservation_price(");
    const bodyStart = sql.indexOf("as $$", sigStart);
    const signatureBlock = sql.slice(sigStart, bodyStart);
    expect(signatureBlock).toMatch(/security definer/);
    expect(signatureBlock).toMatch(/\bstable\b/);
    expect(signatureBlock).toMatch(/set search_path to 'public', 'pg_temp'/);
  });

  it("EXECUTE is revoked from public/anon and granted to authenticated only", () => {
    expect(sql).toMatch(
      /revoke execute on function public\.preview_court_reservation_price\(uuid, timestamptz, timestamptz, uuid, uuid\) from public, anon;/,
    );
    expect(sql).toMatch(
      /grant\s+execute on function public\.preview_court_reservation_price\(uuid, timestamptz, timestamptz, uuid, uuid\) to authenticated;/,
    );
  });

  it("performs no writes — no INSERT/UPDATE/DELETE anywhere in the function body", () => {
    expect(body).not.toMatch(/\binsert into\b/i);
    expect(body).not.toMatch(/\bupdate\s+(public\.)?\w+\s+set\b/i);
    expect(body).not.toMatch(/\bdelete from\b/i);
  });

  it("creates no reservation, payment obligation, or checkout attempt — no call to any of those RPCs", () => {
    expect(body).not.toMatch(/_create_payment_obligation/);
    expect(body).not.toMatch(/_adjust_payment_obligation/);
    expect(body).not.toMatch(/open_payment_checkout_attempt/);
    expect(body).not.toMatch(/record_checkout_session_created/);
    expect(body).not.toMatch(/insert into (public\.)?reservations/i);
  });

  it("mutates no pricing configuration — never calls the rate-period lifecycle RPCs or the pricing-settings RPCs", () => {
    expect(body).not.toMatch(/upsert_court_rate_period/);
    expect(body).not.toMatch(/set_court_rate_period_active/);
    expect(body).not.toMatch(/update_club_pricing/);
    expect(body).not.toMatch(/set_court_hourly_rate/);
  });

  it("writes no audit_log entry — this is a pure preview, not an auditable admin action", () => {
    expect(body).not.toMatch(/insert into (public\.)?audit_log/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// G. Non-regression — scope discipline for Checkpoint B Part 1
// ═══════════════════════════════════════════════════════════════════════════

describe("0201 — non-regression: Checkpoint B Part 1 scope discipline", () => {
  const sql = migrationSql();

  it("adds exactly one new function and touches nothing else", () => {
    const createMatches = sql.match(/create or replace function public\.\w+\(/gi) ?? [];
    expect(createMatches).toHaveLength(1);
    expect(sql).not.toMatch(/create table/i);
    expect(sql).not.toMatch(/alter table/i);
    expect(sql).not.toMatch(/create policy/i);
    expect(sql).not.toMatch(/drop function/i);
  });

  it("does not touch Stripe/payment/refund/cancellation-policy functions", () => {
    for (const name of [
      "_create_payment_obligation",
      "_adjust_payment_obligation",
      "_check_member_reassignment_allowed",
      "_invalidate_or_flag_open_checkout_attempt",
      "open_payment_checkout_attempt",
      "record_checkout_session_created",
    ]) {
      expect(sql).not.toMatch(new RegExp(`create or replace function public\\.${name}\\(`, "i"));
    }
  });

  it("does not touch lessons/events/programs pricing", () => {
    for (const name of ["submit_lesson_request", "set_program_price", "create_event", "update_event"]) {
      expect(sql).not.toMatch(new RegExp(`create or replace function public\\.${name}\\(`, "i"));
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// H. 0202 — currency ambiguity hotfix
// ═══════════════════════════════════════════════════════════════════════════
// Live QA on the applied, immutable 0201 found a runtime failure: `select
// currency into v_currency from public.club_settings where club_id =
// v_club_id;` is ambiguous, because `currency` is simultaneously this
// function's own RETURNS TABLE output column (an implicit PL/pgSQL
// variable) and a column of club_settings. 0202 republishes the same
// function (CREATE OR REPLACE, identical signature) with that one
// statement explicitly aliased/qualified. 0201's own file is untouched.

describe("0202 — 0201 remains untouched", () => {
  it("0201's file still contains its original (buggy) unqualified currency SELECT, unmodified", () => {
    const originalSql = readSource(MIGRATION_PATH);
    expect(originalSql).toMatch(
      /select currency into v_currency from public\.club_settings where club_id = v_club_id;/,
    );
  });

  it("0201's file was not edited with the hotfix's own aliased form or any hotfix-specific wording", () => {
    // Note: 0201's own closing boilerplate already said "Do not create
    // 0202" before 0202 ever existed (this repo's standard forward-
    // looking migration-numbering convention) — that pre-existing mention
    // is not evidence of an edit, so this checks for the FIX's own
    // content instead of the bare string "0202".
    const originalSql = readSource(MIGRATION_PATH);
    expect(originalSql).not.toMatch(/cs\.currency/);
    expect(originalSql).not.toMatch(/ambiguity hotfix/i);
    expect(originalSql).not.toMatch(/currency_fix/i);
  });
});

describe("0202 — redefines ONLY preview_court_reservation_price, nothing else", () => {
  const sql = hotfixMigrationSql();

  it("is the next migration after the applied, immutable 0200/0201", () => {
    expect(() => readSource("supabase/migrations/0200_court_rate_periods.sql")).not.toThrow();
    expect(() => readSource(MIGRATION_PATH)).not.toThrow();
    expect(() => readSource(HOTFIX_MIGRATION_PATH)).not.toThrow();
  });

  it("contains exactly one CREATE OR REPLACE FUNCTION statement, targeting preview_court_reservation_price", () => {
    const createMatches = sql.match(/create or replace function public\.\w+\(/gi) ?? [];
    expect(createMatches).toHaveLength(1);
    expect(createMatches[0]).toMatch(/preview_court_reservation_price/i);
  });

  it("does not create/alter any table, policy, or DROP anything (a pure CREATE OR REPLACE republish — no signature change, no DROP needed)", () => {
    expect(sql).not.toMatch(/create table/i);
    expect(sql).not.toMatch(/alter table/i);
    expect(sql).not.toMatch(/create policy/i);
    expect(sql).not.toMatch(/drop function/i);
  });

  it("does not touch 0200's own objects (court_rate_periods, _resolve_court_reservation_rate, the lifecycle RPCs)", () => {
    expect(sql).not.toMatch(/alter table public\.court_rate_periods/);
    expect(sql).not.toMatch(/create or replace function public\._resolve_court_reservation_rate/i);
    expect(sql).not.toMatch(/create or replace function public\.upsert_court_rate_period/i);
    expect(sql).not.toMatch(/create or replace function public\.set_court_rate_period_active/i);
  });
});

describe("0202 — the currency fix itself", () => {
  const sql = hotfixMigrationSql();
  const body = functionBody(sql, "preview_court_reservation_price");

  it("reads currency via an explicitly-aliased, qualified reference: cs.currency from public.club_settings cs where cs.club_id", () => {
    expect(body).toMatch(
      /select cs\.currency into v_currency\s*\n\s*from public\.club_settings cs\s*\n\s*where cs\.club_id = v_club_id;/,
    );
  });

  it("does NOT contain the ambiguous unqualified form anywhere in the function body", () => {
    expect(body).not.toMatch(/select currency into v_currency\s*\n\s*from public\.club_settings\s*\n\s*where club_id = v_club_id;/);
    expect(body).not.toMatch(/select currency into v_currency\s*\n\s*from club_settings/);
  });

  it("still assigns the resolved value to the currency OUT column exactly once, downstream of the fixed SELECT", () => {
    const fixPos = body.indexOf("select cs.currency into v_currency");
    const assignPos = body.indexOf("currency                 := v_currency;");
    expect(fixPos).toBeGreaterThan(-1);
    expect(assignPos).toBeGreaterThan(fixPos);
  });
});

describe("0202 — every other 0201 behavior preserved byte-for-byte", () => {
  const sql = hotfixMigrationSql();
  const body = functionBody(sql, "preview_court_reservation_price");

  it("signature is unchanged: (uuid, timestamptz, timestamptz, uuid default null, uuid default null)", () => {
    expect(sql).toMatch(
      /create or replace function public\.preview_court_reservation_price\(\s*\n\s*p_court_id\s+uuid,\s*\n\s*p_starts_at\s+timestamptz,\s*\n\s*p_ends_at\s+timestamptz,\s*\n\s*p_roster_member_id\s+uuid default null,\s*\n\s*p_expected_club_id\s+uuid default null\s*\n\)/,
    );
  });

  it("is SECURITY DEFINER, STABLE, with the hardened search_path", () => {
    const sigStart = sql.indexOf("create or replace function public.preview_court_reservation_price(");
    const bodyStart = sql.indexOf("as $$", sigStart);
    const signatureBlock = sql.slice(sigStart, bodyStart);
    expect(signatureBlock).toMatch(/security definer/);
    expect(signatureBlock).toMatch(/\bstable\b/);
    expect(signatureBlock).toMatch(/set search_path to 'public', 'pg_temp'/);
  });

  it("EXECUTE remains revoked from public/anon and granted to authenticated only", () => {
    expect(sql).toMatch(
      /revoke execute on function public\.preview_court_reservation_price\(uuid, timestamptz, timestamptz, uuid, uuid\) from public, anon;/,
    );
    expect(sql).toMatch(
      /grant\s+execute on function public\.preview_court_reservation_price\(uuid, timestamptz, timestamptz, uuid, uuid\) to authenticated;/,
    );
  });

  it("preserves the self-service active-profile invariant (account_inactive) ahead of the capability gate", () => {
    expect(body).toMatch(
      /select \* into v_profile from public\.profiles where id = auth\.uid\(\);\s*\n\s*if not found then\s*\n\s*raise exception 'not_authenticated';\s*\n\s*end if;\s*\n\s*if v_profile\.status <> 'active' then\s*\n\s*raise exception 'account_inactive';/,
    );
    expect(body).toMatch(
      /if v_role not in \('admin', 'pro'\) and not public\.current_club_has_capability\('member_self_service'\) then\s*\n\s*raise exception 'capability_not_available';/,
    );
  });

  it("preserves caller-owned roster identity resolution for self-service (current_user_roster_member_id, no client-suppliable id)", () => {
    expect(body).toMatch(/v_target_roster_member_id := public\.current_user_roster_member_id\(\);/);
  });

  it("preserves Admin/Staff explicit-target authorization: role gate, required p_expected_club_id, same-club roster lookup", () => {
    const branchStart = body.indexOf("if p_roster_member_id is not null then");
    const branchEnd = body.indexOf("else", branchStart);
    const branch = body.slice(branchStart, branchEnd);
    expect(branch).toMatch(/if v_role not in \('admin', 'staff'\) then\s*\n\s*raise exception 'insufficient_role';/);
    expect(branch).toMatch(/if p_expected_club_id is null then\s*\n\s*raise exception 'stale_club_context';/);
    expect(branch).toMatch(
      /select \* into v_roster\s*\n\s*from public\.roster_members\s*\n\s*where id = p_roster_member_id\s*\n\s*and club_id = v_club_id;/,
    );
  });

  it("preserves the universal stale-club guard", () => {
    expect(body).toMatch(
      /if p_expected_club_id is not null and p_expected_club_id is distinct from v_club_id then\s*\n\s*raise exception 'stale_club_context';/,
    );
  });

  it("preserves active-court validation and the 30/60/90/120 supported-duration check", () => {
    expect(body).toMatch(
      /select \* into v_court\s*\n\s*from public\.courts\s*\n\s*where id\s+= p_court_id\s*\n\s*and club_id\s+= v_club_id\s*\n\s*and is_active = true;/,
    );
    expect(body).toMatch(
      /if extract\(epoch from \(p_ends_at - p_starts_at\)\) \/ 60 not in \(30, 60, 90, 120\) then\s*\n\s*raise exception 'invalid_duration';/,
    );
  });

  it("preserves canonical is_active_club_member classification", () => {
    expect(body).toMatch(
      /v_membership_pricing_class := case\s*\n\s*when public\.is_active_club_member\(v_target_roster_member_id, v_club_id\) then 'member'\s*\n\s*else 'non_member'\s*\n\s*end;/,
    );
  });

  it("preserves verbatim reuse of the shared _resolve_court_reservation_rate resolver — never reimplements precedence", () => {
    expect(body).toMatch(
      /select \* into v_rate_resolution\s*\n\s*from public\._resolve_court_reservation_rate\(\s*\n\s*v_club_id, p_court_id, v_membership_pricing_class, p_starts_at\s*\n\s*\);/,
    );
    expect(body).not.toMatch(/coalesce\(\s*\n?\s*v_court\.hourly_rate/);
  });

  it("preserves the exact price_amount_cents formula", () => {
    expect(body).toMatch(
      /v_price_amount_cents := round\(v_rate_resolution\.hourly_rate_cents \* extract\(epoch from \(p_ends_at - p_starts_at\)\) \/ 3600\.0\)::integer;/,
    );
  });

  it("still performs zero writes — no INSERT/UPDATE/DELETE, no reservation/payment/checkout mutation", () => {
    expect(body).not.toMatch(/\binsert into\b/i);
    expect(body).not.toMatch(/\bupdate\s+(public\.)?\w+\s+set\b/i);
    expect(body).not.toMatch(/\bdelete from\b/i);
    expect(body).not.toMatch(/_create_payment_obligation/);
    expect(body).not.toMatch(/open_payment_checkout_attempt/);
    expect(body).not.toMatch(/insert into (public\.)?reservations/i);
  });
});
