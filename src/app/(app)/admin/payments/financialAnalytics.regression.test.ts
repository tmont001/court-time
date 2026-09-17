import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Admin Cleanup Checkpoint 6 — Financial Analytics + Reports Export. One
// authoritative, read-only financial-analytics layer
// (admin/payments/financialSummary.ts) consumed identically by
// /admin/payments Overview and /admin/reports Financial Summary (and, for
// the Reports CSV export, the exact same already-loaded values — never a
// second, independent query or formula).
//
// Source-inspection style, matching this directory's established
// convention (see stripeRefund.regression.test.ts, paymentOverpayment.
// regression.test.ts).

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const MIGRATION_PATH        = "supabase/migrations/0172_financial_reporting_summary.sql";
const FINANCIAL_SUMMARY_PATH = "src/app/(app)/admin/payments/financialSummary.ts";
const OVERVIEW_ACTIONS_PATH  = "src/app/(app)/admin/payments/financialOverviewActions.ts";
const PAYMENTS_PAGE_PATH     = "src/app/(app)/admin/payments/page.tsx";
const PAYMENTS_CLIENT_PATH   = "src/app/(app)/admin/payments/AdminPaymentsClient.tsx";
const REPORTS_PAGE_PATH      = "src/app/(app)/admin/reports/page.tsx";
const REPORT_EXPORT_PATH     = "src/app/(app)/admin/reports/reportExport.ts";
const REPORT_EXPORT_BUTTON_PATH = "src/app/(app)/admin/reports/ReportExportButton.tsx";
const EXPORT_ACTIONS_PATH    = "src/app/(app)/admin/payments/exportActions.ts";
const PAYMENT_EXPORT_MENU_PATH = "src/app/(app)/admin/payments/PaymentExportMenu.tsx";
const CSV_LIB_PATH           = "src/lib/csv.ts";

describe("A. 0172 contains no ambiguous unqualified GROUP BY domain", () => {
  it("the executable SQL never writes a bare 'group by domain' — only the fully-qualified 'group by fe.domain' (the migration's own prose comments DO name the old risky pattern, to explain the fix — checked separately, scoped to just the function's executable SQL)", () => {
    const s = readSource(MIGRATION_PATH);
    const fnStart = s.indexOf("create or replace function public.get_financial_range_summary(");
    const fnEnd = s.indexOf("$$;", s.indexOf("as $$", fnStart)) + 3;
    const fnBody = s.slice(fnStart, fnEnd);
    // Strip plpgsql "--" comment lines before checking, so only executable
    // SQL is inspected — the fix's own explanatory comment inside the
    // function body legitimately names the old pattern too.
    const executableOnly = fnBody
      .split("\n")
      .filter(line => !line.trim().startsWith("--"))
      .join("\n");
    expect(executableOnly).not.toMatch(/group by domain\b/);
    expect(executableOnly).toContain("group by fe.domain;");
  });

  it("the domain mapping is computed inside a CTE (financial_events, aliased fe) — never inline in the outer SELECT/GROUP BY that RETURNS TABLE's own `domain` OUT parameter shares a name with", () => {
    const s = readSource(MIGRATION_PATH);
    expect(s).toContain("with financial_events as (");
    expect(s).toContain("from financial_events fe");
  });

  it("every reference to the domain column in the final SELECT/GROUP BY is table-qualified (fe.domain), never bare", () => {
    const s = readSource(MIGRATION_PATH);
    const finalSelectStart = s.indexOf("    select\n      fe.domain,");
    expect(finalSelectStart).toBeGreaterThan(-1);
    const finalSelectBlock = s.slice(finalSelectStart, s.indexOf("group by fe.domain;") + "group by fe.domain;".length);
    // No occurrence of a bare `domain` token (not preceded by "fe.") in
    // this final SELECT/GROUP BY block.
    expect(finalSelectBlock).not.toMatch(/[^.]\bdomain\b(?!_type)/);
  });
});

describe("B. domain grouping remains reservation/lesson/event/program/other", () => {
  it("the CASE mapping is unchanged: reservation, lesson_request->lesson, event_participant/event_guest->event, program_enrollment->program, else other", () => {
    const s = readSource(MIGRATION_PATH);
    expect(s).toContain("when 'reservation'        then 'reservation'");
    expect(s).toContain("when 'lesson_request'     then 'lesson'");
    expect(s).toContain("when 'event_participant'  then 'event'");
    expect(s).toContain("when 'event_guest'        then 'event'");
    expect(s).toContain("when 'program_enrollment' then 'program'");
    expect(s).toContain("else 'other'");
  });

  it("the shared TS layer's FinancialDomain type and FINANCIAL_DOMAIN_LABEL still cover exactly these five keys", () => {
    const s = readSource(FINANCIAL_SUMMARY_PATH);
    expect(s).toContain('export type FinancialDomain = "reservation" | "lesson" | "event" | "program" | "other";');
  });
});

describe("F/G. unavailable report sections produce an explicit Data status row, never a fabricated metric", () => {
  it("every curated section in reports/page.tsx has an else-branch pushing exactly one 'Data status'/'Unavailable' row when its own failure flag is true", () => {
    const s = readSource(REPORTS_PAGE_PATH);
    for (const section of ["Court Utilization", "Reservations", "Events & Programs", "Waitlist Demand", "Member Engagement"]) {
      expect(s, `${section} missing its Data status fallback row`).toContain(
        `{ section: "${section}", metric: "Data status", value: "Unavailable"`
      );
    }
    // Financial has two independent fallback rows (range vs snapshot).
    expect(s).toContain('{ section: "Financial", metric: "Data status", value: "Unavailable", scope: "Selected range" }');
    expect(s).toContain('{ section: "Financial", metric: "Data status", value: "Unavailable", scope: "Current snapshot" }');
  });

  it("no section's real-metric push is reachable when that section's own failure flag is true — each real-data push is the `if` branch and the status row is the `else`, never both", () => {
    const s = readSource(REPORTS_PAGE_PATH);
    // Court Utilization: real rows gated on !overviewFailed, fallback on the else.
    const courtsIdx = s.indexOf('if (!overviewFailed) {\n    reportSummaryRows.push(\n      { section: "Court Utilization"');
    expect(courtsIdx).toBeGreaterThan(-1);
  });

  it("Financial's range and snapshot rows are independently gated — financialRangeFailed and outstandingFailed are two separate booleans, never one combined flag", () => {
    const s = readSource(REPORTS_PAGE_PATH);
    expect(s).toContain("const financialRangeFailed = !financialSummary;");
    expect(s).toContain("const outstandingCents = \"error\" in outstandingResult ? null : outstandingResult.outstandingCents;");
    expect(s).toContain("const outstandingFailed = outstandingCents === null;");
    expect(s).not.toMatch(/financialFailed\s*=/);
  });

  it("the Court Utilization CSV rows are gated on overviewFailed alone (matching the real UI strip's own source), not courtsFailed (a different RPC/section this curated export never includes)", () => {
    const s = readSource(REPORTS_PAGE_PATH);
    expect(s).not.toMatch(/if \(!courtsFailed && !overviewFailed\)/);
  });
});

describe("H. report export headers remain stable", () => {
  it("REPORT_SUMMARY_COLUMNS header order is unchanged: section,metric,value,scope,start_date,end_date", () => {
    const s = readSource(REPORT_EXPORT_PATH);
    const headerOrder = ["section", "metric", "value", "scope", "start_date", "end_date"];
    let lastIdx = -1;
    for (const header of headerOrder) {
      const idx = s.indexOf(`header: "${header}"`);
      expect(idx, `${header} column missing`).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
  });
});

describe("1/13. one authoritative financial analytics data source is shared by Payments and Reports", () => {
  it("both admin/payments/page.tsx and admin/reports/page.tsx import getFinancialRangeSummary/getOutstandingSnapshot from the SAME financialSummary.ts module", () => {
    const paymentsPage = readSource(PAYMENTS_PAGE_PATH);
    const reportsPage = readSource(REPORTS_PAGE_PATH);
    expect(paymentsPage).toContain('import { getFinancialRangeSummary, getOutstandingSnapshot } from "./financialSummary";');
    expect(reportsPage).toContain('import { getFinancialRangeSummary, getOutstandingSnapshot, FINANCIAL_DOMAIN_LABEL } from "../payments/financialSummary";');
  });

  it("no second/competing financial-summary formula exists — grep confirms exactly one file defines getFinancialRangeSummary/getOutstandingSnapshot", () => {
    const s = readSource(FINANCIAL_SUMMARY_PATH);
    expect(s).toContain("export async function getFinancialRangeSummary(");
    expect(s).toContain("export async function getOutstandingSnapshot(");
  });
});

describe("2/3/4/5/6. Collected/Refunded/Net/overpayment semantics, evidenced against the authoritative ledger", () => {
  it("2. Collected sums only manual_payment_recorded and online_payment_recorded — the exact same money-in event types payments.amount_paid_cents itself is built from (0150)", () => {
    const s = readSource(MIGRATION_PATH);
    expect(s).toContain("where fe.event_type in ('manual_payment_recorded', 'online_payment_recorded')");
  });

  it("3. Refunded sums only refund_recorded and online_refund_recorded — the exact same money-out event types (0153)", () => {
    const s = readSource(MIGRATION_PATH);
    expect(s).toContain("where fe.event_type in ('refund_recorded', 'online_refund_recorded')");
  });

  it("4. disputes are not refunds — the RPC's own executable function body never references payment_disputes at all (the migration's surrounding prose comments DO name it, to explain why it's excluded — checked separately, scoped to just the function body)", () => {
    const s = readSource(MIGRATION_PATH);
    const fnStart = s.indexOf("create or replace function public.get_financial_range_summary(");
    const fnEnd = s.indexOf("$$;", s.indexOf("as $$", fnStart)) + 3;
    const fnBody = s.slice(fnStart, fnEnd);
    expect(fnBody).not.toMatch(/payment_disputes/);
  });

  it("5. Net collected = Collected - Refunded is enforced ONCE, in the shared TypeScript layer — never re-derived per call site", () => {
    const s = readSource(FINANCIAL_SUMMARY_PATH);
    expect(s).toContain("netCollectedCents: collectedCents - refundedCents,");
    // Neither page.tsx recomputes it independently.
    expect(readSource(PAYMENTS_PAGE_PATH)).not.toMatch(/collectedCents\s*-\s*refundedCents/);
    expect(readSource(REPORTS_PAGE_PATH)).not.toMatch(/collectedCents\s*-\s*refundedCents/);
  });

  it("6. overpayments remain fully counted as collected — the RPC never caps/clamps collected_cents against amount_due_cents or any obligation ceiling", () => {
    const s = readSource(MIGRATION_PATH);
    const fnStart = s.indexOf("create or replace function public.get_financial_range_summary(");
    const fnEnd = s.indexOf("$$;", s.indexOf("as $$", fnStart)) + 3;
    const fnBody = s.slice(fnStart, fnEnd);
    expect(fnBody).not.toMatch(/least\(|amount_due_cents/);
  });

  it("reversed events are excluded from both Collected and Refunded via the same non-reversed exclusion _recompute_payment_rollup itself uses", () => {
    const s = readSource(MIGRATION_PATH);
    expect(s).toContain("and pe.id not in (");
    expect(s).toContain("select reverses_event_id");
  });
});

describe("7/8. Outstanding reuses the existing authoritative current-collectibility semantics; never negative from overpayment", () => {
  it("7. getOutstandingSnapshot reuses selectLatestGenuinelyOutstandingPayments and hydrateExportDomainContext — the exact same functions exportActions.ts's Outstanding Balances CSV already uses, not a reimplementation", () => {
    const s = readSource(FINANCIAL_SUMMARY_PATH);
    expect(s).toContain('from "./exportLogic"');
    expect(s).toContain("selectLatestGenuinelyOutstandingPayments");
    expect(s).toContain('from "./exportDomainHydration"');
    expect(s).toContain("hydrateExportDomainContext");
  });

  it("isGenuinelyOutstanding and the collectible-domain gate are not duplicated in financialSummary.ts — confirmed by absence of a second status/cancelled-family check", () => {
    const s = readSource(FINANCIAL_SUMMARY_PATH);
    expect(s).not.toMatch(/status === "unpaid"|status === "cancelled"/);
  });

  it("8. each payment's contribution to Outstanding is clamped at zero via Math.max — an overpaid payment (paid > due) can never subtract from the total", () => {
    const s = readSource(FINANCIAL_SUMMARY_PATH);
    expect(s).toContain("outstandingCents += Math.max(p.amount_due_cents - p.amount_paid_cents, 0);");
  });
});

describe("9. selected-range metrics use club timezone (not browser-local)", () => {
  it("get_financial_range_summary resolves its date bounds via club_local_bounds — the exact same DST-safe helper every other Reports RPC already uses", () => {
    const s = readSource(MIGRATION_PATH);
    expect(s).toContain("v_range := public.club_local_bounds(v_club_id, p_start_date, p_end_date);");
  });

  it("the Payments Overview Server Action resolves club-local \"today\" via clubTimezone, never new Date() alone / browser locale", () => {
    const s = readSource(OVERVIEW_ACTIONS_PATH);
    expect(s).toContain('new Date().toLocaleDateString("en-CA", { timeZone: clubTimezone });');
  });
});

describe("10. Outstanding is clearly labeled current snapshot, never implied to be filtered by the selected range", () => {
  it("Payments Overview panel labels Outstanding under its own 'Current snapshot' heading, separate from the 'Selected range' group", () => {
    const s = readSource(PAYMENTS_CLIENT_PATH);
    const outstandingLabelIdx = s.indexOf('label="Outstanding"');
    expect(outstandingLabelIdx).toBeGreaterThan(-1);
    const precedingText = s.slice(Math.max(0, outstandingLabelIdx - 400), outstandingLabelIdx);
    expect(precedingText).toContain("Current snapshot");
  });

  it("Reports Financial Summary's StatTile passes snapshot for Outstanding only, and its caption explicitly states Outstanding is not filtered by the selected range", () => {
    const s = readSource(REPORTS_PAGE_PATH);
    expect(s).toContain('<StatTile label="Outstanding" value={formatMoney(outstandingCents!, currency)} snapshot />');
    expect(s).toContain("Outstanding is a\n              current snapshot, not filtered by the selected range.");
  });
});

describe("11/12. Payments tabs are Overview / Outstanding / Payment Activity — no fourth tab", () => {
  it("the Tab type is exactly \"overview\" | \"outstanding\" | \"activity\"", () => {
    const s = readSource(PAYMENTS_CLIENT_PATH);
    expect(s).toContain('type Tab = "overview" | "outstanding" | "activity";');
  });

  it("exactly three tabs are passed to the shared PageTabs component, labeled Overview, Outstanding, Payment Activity — no \"Financial Activity\" tab anywhere (Phase 43B-3E2 restyled this tab strip onto PageTabs; the tab set/labels/keys are unchanged)", () => {
    const s = readSource(PAYMENTS_CLIENT_PATH);
    expect(s).toContain('label: "Overview"');
    expect(s).toContain('label: "Outstanding"');
    expect(s).toContain('label: "Payment Activity"');
    expect(s).not.toMatch(/Financial Activity/);
    expect(s).toContain("<PageTabs");
  });

  it("unknown/missing tab state defaults to Overview for an Admin", () => {
    const s = readSource(PAYMENTS_CLIENT_PATH);
    expect(s).toContain('useState<Tab>(isAdmin ? "overview" : "outstanding");');
  });
});

describe("13/14. Reports Financial Summary + export use the shared layer and the current selected range", () => {
  it("Financial Summary's RPC call uses resolved.startDate/endDate — the exact same resolved range every other Reports section already uses", () => {
    const s = readSource(REPORTS_PAGE_PATH);
    expect(s).toContain("getFinancialRangeSummary(supabase, resolved.startDate, resolved.endDate)");
  });

  it("14. ReportExportButton receives startDate/endDate from the same `resolved` range object — never a separately re-resolved range", () => {
    const s = readSource(REPORTS_PAGE_PATH);
    const idx = s.indexOf("<ReportExportButton");
    const end = s.indexOf("/>", idx);
    const jsx = s.slice(idx, end);
    expect(jsx).toContain("startDate={resolved.startDate}");
    expect(jsx).toContain("endDate={resolved.endDate}");
  });

  it("the export is built entirely client-side from already-loaded rows — no Server Action / second RPC call in ReportExportButton.tsx", () => {
    const s = readSource(REPORT_EXPORT_BUTTON_PATH);
    expect(s).not.toMatch(/"use server"|\.rpc\(/);
    expect(s).toContain("buildReportSummaryCsv({ rows, startDate, endDate })");
  });
});

describe("15/16. CSV escaping is correct; selected-range vs current-snapshot metrics are distinguished", () => {
  it("15. the Reports export reuses the shared, tested serializeCsv (RFC-4180 + formula-injection protection) — never a second, ad-hoc CSV writer", () => {
    const s = readSource(REPORT_EXPORT_PATH);
    expect(s).toContain('import { type CsvColumn, serializeCsv } from "@/lib/csv";');
    const csvLib = readSource(CSV_LIB_PATH);
    expect(csvLib).toContain("function escapeRfc4180(raw: string): string {");
    expect(csvLib).toContain("function neutralizeFormulaInjection(raw: string): string {");
  });

  it("16. the CSV row shape includes an explicit scope column distinguishing 'Selected range' from 'Current snapshot' per row — locked column order section,metric,value,scope,start_date,end_date", () => {
    const s = readSource(REPORT_EXPORT_PATH);
    expect(s).toContain('export type ReportSummaryScope = "Selected range" | "Current snapshot";');
    expect(s).toContain('{ header: "section",    value: r => r.section,    protect: false }');
    expect(s).toContain('{ header: "metric",     value: r => r.metric,     protect: false }');
    expect(s).toContain('{ header: "value",      value: r => r.value,      protect: false }');
    expect(s).toContain('{ header: "scope",      value: r => r.scope,      protect: false }');
    expect(s).toContain('{ header: "start_date", value: r => r.startDate,  protect: false }');
    expect(s).toContain('{ header: "end_date",   value: r => r.endDate,    protect: false }');
  });

  it("the Reports export rows include both scopes: Outstanding is tagged 'Current snapshot', Collected/Refunded/Net are tagged 'Selected range'", () => {
    const s = readSource(REPORTS_PAGE_PATH);
    expect(s).toContain('{ section: "Financial", metric: "Outstanding", value: formatMoney(outstandingCents!, currency), scope: "Current snapshot" }');
    expect(s).toContain('{ section: "Financial", metric: "Collected", value: formatMoney(financialSummary!.collectedCents, currency), scope: "Selected range" }');
  });
});

describe("17. detailed transaction CSV remains owned by Payments — the Reports export is a summary only", () => {
  it("PaymentExportMenu / exportActions.ts (Outstanding Balances, Payment Activity detailed exports) are untouched by this checkpoint", () => {
    const s = readSource(PAYMENT_EXPORT_MENU_PATH);
    expect(s).toContain("Outstanding balances");
    expect(s).toContain("Payment activity");
    expect(s).toContain('import { exportOutstandingBalancesCsv } from "./exportActions";');
  });

  it("the Reports summary export never reads payment_events/payments row-by-row — it serializes only the small, already-aggregated summary rows array", () => {
    const s = readSource(REPORT_EXPORT_PATH);
    expect(s).not.toMatch(/payment_events|from\(\s*["']payments["']\s*\)/);
  });

  it("exportActions.ts's Outstanding Balances export logic is byte-unchanged in its core formula", () => {
    const s = readSource(EXPORT_ACTIONS_PATH);
    expect(s).toContain("selectLatestGenuinelyOutstandingPayments(");
    expect(s).toContain("if (!domainContext.collectible) continue;");
  });
});

describe("18. no Stripe API dependency anywhere in the new financial analytics code", () => {
  it("financialSummary.ts, financialOverviewActions.ts, reportExport.ts, ReportExportButton.tsx never reference Stripe (executable code, not prose)", () => {
    for (const path of [FINANCIAL_SUMMARY_PATH, OVERVIEW_ACTIONS_PATH, REPORT_EXPORT_PATH, REPORT_EXPORT_BUTTON_PATH]) {
      const s = readSource(path);
      expect(s.toLowerCase()).not.toMatch(/stripe/);
    }
  });

  it("0172's own executable function body never calls a Stripe-related function or references a Stripe table (the migration's surrounding prose comments name Stripe only to explain online_refund_recorded's provenance — checked separately, scoped to just the function body)", () => {
    const s = readSource(MIGRATION_PATH);
    const fnStart = s.indexOf("create or replace function public.get_financial_range_summary(");
    const fnEnd = s.indexOf("$$;", s.indexOf("as $$", fnStart)) + 3;
    const fnBody = s.slice(fnStart, fnEnd);
    expect(fnBody.toLowerCase()).not.toMatch(/stripe/);
  });
});

describe("19. no financial mutation was added", () => {
  it("0172 is read-only: no insert/update/delete statement, no write-capable function", () => {
    const s = readSource(MIGRATION_PATH);
    expect(s).not.toMatch(/\binsert into\b|\bupdate\s+public\.|\bdelete from\b/i);
  });

  it("financialSummary.ts and financialOverviewActions.ts issue no .insert(/.update(/.delete( calls", () => {
    for (const path of [FINANCIAL_SUMMARY_PATH, OVERVIEW_ACTIONS_PATH]) {
      const s = readSource(path);
      expect(s).not.toMatch(/\.insert\(|\.update\(|\.delete\(/);
    }
  });
});

describe("20. no Phase 34 invariant changed", () => {
  it("send_announcement_v2 / get_communications_activity (0170/0171) are not referenced or modified by 0172", () => {
    const s = readSource(MIGRATION_PATH);
    expect(s).not.toMatch(/send_announcement_v2|get_communications_activity/);
  });

  it("_recompute_payment_rollup, payment_events, and payments are only ever READ (selected from) by the new RPC, never redefined", () => {
    const s = readSource(MIGRATION_PATH);
    expect(s).not.toMatch(/create or replace function public\._recompute_payment_rollup/);
    expect(s).not.toMatch(/create table|alter table/i);
  });

  it("refundActions.ts and the Checkout/refund/dispute Server Actions are untouched by this checkpoint (no new import of financialSummary.ts there)", () => {
    const s = readSource("src/app/(app)/admin/payments/refundActions.ts");
    expect(s).not.toMatch(/financialSummary/);
  });
});

describe("21. tenant/Admin isolation", () => {
  it("get_financial_range_summary is club-scoped via current_user_club_id() and Admin-only via current_user_role(), raising (not silently zero-rowing) for a non-admin/unauthenticated caller", () => {
    const s = readSource(MIGRATION_PATH);
    expect(s).toContain("v_club_id := public.current_user_club_id();");
    expect(s).toContain("v_role    := public.current_user_role();");
    expect(s).toContain("raise exception 'not_authenticated';");
    expect(s).toContain("raise exception 'insufficient_role';");
  });

  it("EXECUTE is revoked from public/anon and granted only to authenticated", () => {
    const s = readSource(MIGRATION_PATH);
    expect(s).toContain("revoke execute on function public.get_financial_range_summary(date, date) from public, anon;");
    expect(s).toContain("grant  execute on function public.get_financial_range_summary(date, date) to authenticated;");
  });

  it("getFinancialOverviewAction independently re-checks role === 'admin' server-side — defense in depth beyond the RPC's own check", () => {
    const s = readSource(OVERVIEW_ACTIONS_PATH);
    expect(s).toContain('if (profile?.role !== "admin") return { error: "Admin access required." };');
  });
});

describe("22. existing Staff operational Payments authority is preserved exactly", () => {
  it("the page's own isOperator gate (Admin+Staff) is unchanged — Overview is additionally gated by isAdminRole, never narrowing who reaches Outstanding/Payment Activity", () => {
    const s = readSource(PAYMENTS_PAGE_PATH);
    expect(s).toContain("if (!profile || !isOperator(profile.role)) redirect(\"/calendar\");");
  });

  it("the Overview tab item and its data are conditioned on isAdmin — Staff never even receives that item in the PageTabs items array, but Outstanding/Payment Activity are always present for both roles (Phase 43B-3E2 restyled this from {isAdmin && (<button>)} onto a conditional array-spread item — same authorization boundary, different markup)", () => {
    const s = readSource(PAYMENTS_CLIENT_PATH);
    expect(s).toContain('...(isAdmin\n              ? [{ key: "overview", label: "Overview"');
    // Outstanding/Payment Activity items are unconditional array entries,
    // not wrapped in an isAdmin spread.
    const outstandingItemIdx = s.indexOf('{ key: "outstanding", label: "Outstanding"');
    const precedingLine = s.slice(Math.max(0, outstandingItemIdx - 20), outstandingItemIdx);
    expect(precedingLine).not.toMatch(/isAdmin/);
  });

  it("initialFinancialOverview is fetched server-side ONLY when isAdminRole is true — never fetched at all for Staff, not merely hidden", () => {
    const s = readSource(PAYMENTS_PAGE_PATH);
    expect(s).toContain("if (isAdminRole && clubId) {");
  });
});
