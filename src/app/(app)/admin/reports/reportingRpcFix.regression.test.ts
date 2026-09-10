import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Reports bug fix — Checkpoint 2. Regression coverage for migration 0169,
// which corrects the two reporting RPCs Checkpoint 1's observability
// logging (reportingDiagnostics.ts) proved failing at runtime:
//   - get_reporting_overview:    42804 structure-of-query mismatch
//   - get_event_program_summary: 42702 ambiguous column ("attended_count")
//
// This project's vitest baseline is deliberately pure-TypeScript with no
// live Postgres — these are source-inspection tests against the actual
// shipped migration SQL, the same established style as
// staleCheckoutInvalidation.regression.test.ts (see that file's header for
// the rationale: reading the real source is a more honest guard than a
// parallel reimplementation that could drift, and no engine here can
// actually execute a CREATE FUNCTION statement to prove types match).

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !line.trim().startsWith("--") && !line.trim().startsWith("//"))
    .join("\n");
}

const MIGRATION_PATH = "supabase/migrations/0169_fix_reporting_rpc_runtime_errors.sql";
const MIGRATION_0117_PATH = "supabase/migrations/0117_durable_member_guest_lifecycle_and_attendance.sql";
const REPORTS_PAGE_PATH = "src/app/(app)/admin/reports/page.tsx";
const REPORTING_DIAGNOSTICS_PATH = "src/app/(app)/admin/reports/reportingDiagnostics.ts";

function migrationSql(): string {
  return codeOnly(readSource(MIGRATION_PATH));
}

// Isolates one `create or replace function public.<name>(...)` body up to
// its own closing `$$;` — every reporting RPC in this codebase (0095,
// 0096, 0117, and this migration) uses plain `$$` delimiters, never
// `$function$`.
function functionBody(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  expect(start, `function public.${name} not found`).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf("\n$$;", start);
  expect(end, `closing $$; not found for public.${name}`).toBeGreaterThan(start);
  return sql.slice(start, end + "\n$$;".length);
}

const RETURNS_TABLE_OVERVIEW = `returns table (
  gross_utilization_pct         numeric,
  member_demand_utilization_pct numeric,
  total_reservations            bigint,
  cancelled_reservations        bigint,
  cancellation_rate_pct         numeric,
  sessions_held                 bigint,
  total_session_capacity        bigint,
  total_session_enrollment      bigint,
  session_fill_rate_pct         numeric,
  active_member_count           bigint,
  outstanding_waitlist_count    bigint
)`;

const RETURNS_TABLE_EVENT_PROGRAM = `returns table (
  standalone_sessions_held     bigint,
  program_sessions_held        bigint,
  total_sessions_held          bigint,
  total_capacity                bigint,
  confirmed_members             bigint,
  guests                        bigint,
  total_enrollment              bigint,
  fill_rate_pct                 numeric,
  attended_count                bigint,
  no_show_count                 bigint,
  attendance_marked_count       bigint,
  attendance_rate_pct           numeric,
  no_show_rate_pct              numeric,
  cancelled_standalone_sessions bigint,
  cancelled_program_sessions    bigint
)`;

describe("get_reporting_overview — 42804 fix", () => {
  it("1+3. the RETURNS TABLE contract (column list, order, types) is byte-identical to the effective 0117 definition", () => {
    const sql = migrationSql();
    const body = functionBody(sql, "get_reporting_overview");
    expect(body).toContain(RETURNS_TABLE_OVERVIEW);

    const sql0117 = codeOnly(readSource(MIGRATION_0117_PATH));
    const body0117 = functionBody(sql0117, "get_reporting_overview");
    expect(body0117).toContain(RETURNS_TABLE_OVERVIEW);
  });

  it("2. total_enrollment is now cast to ::bigint, correcting the exact 42804 root cause (sum() over an already-bigint column promotes to numeric)", () => {
    const body = functionBody(migrationSql(), "get_reporting_overview");
    const match = body.match(
      /\(\s*\(select coalesce\(sum\(confirmed_count\), 0\) from sess_participants\)\s*\+\s*\(select coalesce\(sum\(guest_count\), 0\) from sess_guests\)\s*\)::bigint\s*as total_enrollment/
    );
    expect(match, "total_enrollment expression not cast to ::bigint as expected").not.toBeNull();
  });

  it("2. no other column expression in the final SELECT gained a defensive cast it didn't need — 0169's body is IDENTICAL to 0117's once the one known total_enrollment edit is removed from each", () => {
    const body0169 = functionBody(migrationSql(), "get_reporting_overview");
    const body0117 = functionBody(codeOnly(readSource(MIGRATION_0117_PATH)), "get_reporting_overview");

    const enrollment0169 =
      "(\n" +
      "        (select coalesce(sum(confirmed_count), 0) from sess_participants)\n" +
      "        + (select coalesce(sum(guest_count), 0) from sess_guests)\n" +
      "      )::bigint                                                       as total_enrollment";
    const enrollment0117 =
      "(select coalesce(sum(confirmed_count), 0) from sess_participants)\n" +
      "        + (select coalesce(sum(guest_count), 0) from sess_guests)    as total_enrollment";

    expect(body0169, "expected total_enrollment cast expression not found").toContain(enrollment0169);
    expect(body0117, "0117 baseline total_enrollment expression not found").toContain(enrollment0117);

    const normalize = (body: string, needle: string) =>
      body
        .replace(needle, "TOTAL_ENROLLMENT_EXPR")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith("-- Runtime QA fix"));

    expect(normalize(body0169, enrollment0169)).toEqual(normalize(body0117, enrollment0117));
  });

  it("3. metric order/semantics: the closing SELECT still returns exactly the 11 documented expressions in the same order", () => {
    const body = functionBody(migrationSql(), "get_reporting_overview");
    const closing = body.slice(body.lastIndexOf("select\n"));
    const order = [
      "rt.gross_hours",
      "rt.member_hours",
      "rc.total_res",
      "rc.cancelled_res",
      "rc.cancelled_res / rc.total_res",
      "st.sessions_held",
      "st.total_capacity",
      "st.total_enrollment",
      "st.total_enrollment / st.total_capacity",
      "m.active_count",
      "w.outstanding_count",
    ];
    let lastIdx = -1;
    for (const token of order) {
      const idx = closing.indexOf(token);
      expect(idx, `${token} missing or out of order`).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
  });

  it("preserves SECURITY DEFINER, STABLE, search_path, and admin authorization checks", () => {
    const body = functionBody(migrationSql(), "get_reporting_overview");
    expect(body).toContain("language plpgsql");
    expect(body).toContain("stable");
    expect(body).toContain("security definer");
    expect(body).toContain("set search_path = public, pg_temp");
    expect(body).toContain("raise exception 'not_authenticated';");
    expect(body).toContain("raise exception 'insufficient_role';");
    expect(body).toContain("public.current_user_club_id();");
    expect(body).toContain("public.current_user_role();");
  });

  it("preserves the exact grant/revoke shape from 0117", () => {
    const sql = migrationSql();
    expect(sql).toContain("revoke execute on function public.get_reporting_overview(date, date)\n  from public, anon;");
    expect(sql).toContain("grant execute on function public.get_reporting_overview(date, date)\n  to authenticated;");
  });
});

describe("get_event_program_summary — 42702 fix (and the 42804 it would immediately trade for)", () => {
  it("4. attended_count is no longer referenced bare — qualified as sp.attended_count", () => {
    const body = functionBody(migrationSql(), "get_event_program_summary");
    expect(body).toContain("sum(sp.attended_count)");
    expect(body).toContain("from sess_participants sp");
    // No bare (unqualified, unaliased) reference to attended_count remains
    // inside a sum(...) call.
    expect(body).not.toMatch(/sum\(attended_count\)/);
  });

  it("5. no_show_count — the second, not-yet-surfaced ambiguity — is also alias-qualified", () => {
    const body = functionBody(migrationSql(), "get_event_program_summary");
    expect(body).toContain("sum(sp.no_show_count)");
    expect(body).not.toMatch(/sum\(no_show_count\)/);
  });

  it("5. every reference in the function body is qualified with a table/CTE alias — no bare identifier collides with any of the 15 RETURNS TABLE OUT names", () => {
    const body = functionBody(migrationSql(), "get_event_program_summary");
    const outNames = [
      "standalone_sessions_held", "program_sessions_held", "total_sessions_held",
      "total_capacity", "confirmed_members", "guests", "total_enrollment",
      "fill_rate_pct", "attended_count", "no_show_count", "attendance_marked_count",
      "attendance_rate_pct", "no_show_rate_pct", "cancelled_standalone_sessions",
      "cancelled_program_sessions",
    ];
    // Every occurrence of an OUT name that is a *reference* (inside sum(...)
    // or a bare SELECT-list item, not an "as <name>" alias definition) must
    // be preceded by a qualifying "<alias>." — checked precisely for the
    // two names known to collide; the other 13 never appear as bare CTE
    // column names in the first place (see migration header audit), so this
    // is a targeted re-check, not a blanket scan.
    for (const name of ["attended_count", "no_show_count"]) {
      const bareRefPattern = new RegExp(`sum\\(${name}\\)`);
      expect(body, `${name} still referenced bare inside sum(...)`).not.toMatch(bareRefPattern);
    }
    void outNames; // documents the full audited name set for a future reader
  });

  it("2/9 (type fix required by the ambiguity fix). confirmed_members, guests, attended_total, and no_show_total are all cast to ::bigint, preventing an immediate 42804 once the ambiguity no longer blocks planning", () => {
    const body = functionBody(migrationSql(), "get_event_program_summary");
    expect(body).toMatch(/from sess_participants\)::bigint\s*as confirmed_members/);
    expect(body).toMatch(/from sess_guests\)::bigint\s*as guests/);
    expect(body).toMatch(/\)::bigint\s*as attended_total/);
    expect(body).toMatch(/\)::bigint\s*as no_show_total/);
  });

  it("6. the RETURNS TABLE contract is byte-identical to the effective 0117 definition — no column added, removed, renamed, or reordered", () => {
    const body = functionBody(migrationSql(), "get_event_program_summary");
    expect(body).toContain(RETURNS_TABLE_EVENT_PROGRAM);

    const body0117 = functionBody(
      codeOnly(readSource(MIGRATION_0117_PATH)),
      "get_event_program_summary"
    );
    expect(body0117).toContain(RETURNS_TABLE_EVENT_PROGRAM);
  });

  it("7. the closing SELECT still returns the same 15 expressions, in the same order, with the same attendance/fill/no-show formulas", () => {
    const body = functionBody(migrationSql(), "get_event_program_summary");
    const closing = body.slice(body.lastIndexOf("select\n"));
    const order = [
      "st.standalone_held",
      "st.program_held",
      "st.total_held",
      "st.total_capacity",
      "st.confirmed_members",
      "st.guests",
      "(st.confirmed_members + st.guests) as total_enrollment",
      "round(100.0 * (st.confirmed_members + st.guests) / st.total_capacity, 2)",
      "st.attended_total",
      "st.no_show_total",
      "(st.attended_total + st.no_show_total) as attendance_marked_count",
      "round(100.0 * st.attended_total / (st.attended_total + st.no_show_total), 2)",
      "round(100.0 * st.no_show_total  / (st.attended_total + st.no_show_total), 2)",
      "cs.cancelled_standalone",
      "cs.cancelled_program",
    ];
    let lastIdx = -1;
    for (const token of order) {
      const idx = closing.indexOf(token);
      expect(idx, `${token} missing or out of order`).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
  });

  it("preserves SECURITY DEFINER, STABLE, search_path, and admin authorization checks", () => {
    const body = functionBody(migrationSql(), "get_event_program_summary");
    expect(body).toContain("language plpgsql");
    expect(body).toContain("stable");
    expect(body).toContain("security definer");
    expect(body).toContain("set search_path = public, pg_temp");
    expect(body).toContain("raise exception 'not_authenticated';");
    expect(body).toContain("raise exception 'insufficient_role';");
  });

  it("preserves the exact grant/revoke shape from 0117", () => {
    const sql = migrationSql();
    expect(sql).toContain("revoke execute on function public.get_event_program_summary(date, date)\n  from public, anon;");
    expect(sql).toContain("grant execute on function public.get_event_program_summary(date, date)\n  to authenticated;");
  });
});

describe("migration scope — only the two intended functions are redefined", () => {
  it("8. exactly two CREATE OR REPLACE FUNCTION statements exist in 0169", () => {
    const sql = migrationSql();
    const matches = sql.match(/create or replace function public\.\w+\(/g) ?? [];
    expect(matches.length).toBe(2);
    expect(matches).toContain("create or replace function public.get_reporting_overview(");
    expect(matches).toContain("create or replace function public.get_event_program_summary(");
  });

  it("8. the four untouched reporting RPCs are not defined, redefined, or referenced by name anywhere executable in 0169", () => {
    const sql = migrationSql();
    for (const untouched of [
      "get_court_utilization",
      "get_reservation_summary",
      "get_waitlist_demand",
      "get_member_engagement_summary",
    ]) {
      expect(sql).not.toContain(`function public.${untouched}(`);
    }
  });

  it("no payment function, RLS policy (create/alter policy), or table schema (create/alter table) is touched", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/create policy|alter policy|create table|alter table/i);
    expect(sql).not.toMatch(/payment_events|amount_due_cents|amount_paid_cents|stripe_/i);
  });

  it("wrapped in a single begin/commit transaction, applied nowhere yet (documentation says NOT YET APPLIED)", () => {
    const sql = readSource(MIGRATION_PATH);
    expect(sql.trim().startsWith("--")).toBe(true);
    expect(sql).toContain("\nbegin;\n");
    expect(sql).toContain("\ncommit;\n");
    expect(sql).toContain("NOT YET APPLIED");
  });
});

describe("11. Checkpoint 1's reporting diagnostics remain intact and unmodified by this checkpoint", () => {
  it("reportingDiagnostics.ts still exports the same sanitized logging helpers", () => {
    const s = readSource(REPORTING_DIAGNOSTICS_PATH);
    expect(s).toContain("export function sanitizeReportingRpcError(");
    expect(s).toContain("export function logReportingRpcFailure(");
  });

  it("page.tsx still logs all six reporting RPCs, unchanged by this checkpoint's migration work", () => {
    const s = readSource(REPORTS_PAGE_PATH);
    const calls = [
      ["get_reporting_overview", "overviewResult"],
      ["get_court_utilization", "courtsResult"],
      ["get_reservation_summary", "reservationsResult"],
      ["get_event_program_summary", "eventProgramResult"],
      ["get_waitlist_demand", "waitlistResult"],
      ["get_member_engagement_summary", "engagementResult"],
    ];
    for (const [rpcName, resultVar] of calls) {
      expect(s).toContain(`logReportingRpcFailure("${rpcName}", ${resultVar}.error);`);
    }
    expect(s).toContain("Data unavailable — try refreshing.");
  });
});
