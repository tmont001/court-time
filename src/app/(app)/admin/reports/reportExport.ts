// Admin Cleanup Checkpoint 6 — Reports summary CSV export. Pure, zero
// Supabase/Next imports (mirrors admin/payments/exportLogic.ts's own
// "pure lib" convention) — every value here is already-loaded, already-
// rendered report data passed in by the caller; this module only shapes
// and serializes it. This is the SUMMARY report, not a detailed
// transaction export — detailed payment transaction exports remain owned
// entirely by /admin/payments (PaymentExportMenu/exportActions.ts),
// untouched by this file.

import { type CsvColumn, serializeCsv } from "@/lib/csv";

export type ReportSummaryScope = "Selected range" | "Current snapshot";

export interface ReportSummaryRow {
  section: string;
  metric: string;
  value: string;
  scope: ReportSummaryScope;
}

export interface ReportSummaryCsvInput {
  rows: ReportSummaryRow[];
  startDate: string; // YYYY-MM-DD, club-local, inclusive
  endDate: string;   // YYYY-MM-DD, club-local, inclusive
}

interface ReportSummaryCsvRow extends ReportSummaryRow {
  startDate: string;
  endDate: string;
}

// section,metric,value,scope,start_date,end_date — the locked column
// order. All six are plain code-controlled or already-formatted text, so
// every column is protect: false (never formula-neutralized) — matching
// centsToDecimalString-style Amount columns elsewhere in this codebase:
// these are values this app itself generates and fully controls the
// content of, not free-text user input.
const REPORT_SUMMARY_COLUMNS: CsvColumn<ReportSummaryCsvRow>[] = [
  { header: "section",    value: r => r.section,    protect: false },
  { header: "metric",     value: r => r.metric,     protect: false },
  { header: "value",      value: r => r.value,      protect: false },
  { header: "scope",      value: r => r.scope,      protect: false },
  { header: "start_date", value: r => r.startDate,  protect: false },
  { header: "end_date",   value: r => r.endDate,    protect: false },
];

// Correction — a "Current snapshot" row (Outstanding, Waitlist Demand's
// Total outstanding entries, etc.) is evaluated NOW, not as of the
// selected range's end date. Stamping the selected start_date/end_date
// onto such a row would misleadingly imply it was computed as of that
// historical range. Only "Selected range" rows carry the real selected
// dates; every "Current snapshot" row gets blank ("") start_date/end_date
// — the column contract (section,metric,value,scope,start_date,end_date)
// is unchanged, only the VALUE in those two cells differs by scope.
export function buildReportSummaryCsv(input: ReportSummaryCsvInput): string {
  const rows: ReportSummaryCsvRow[] = input.rows.map(r => ({
    ...r,
    startDate: r.scope === "Current snapshot" ? "" : input.startDate,
    endDate:   r.scope === "Current snapshot" ? "" : input.endDate,
  }));
  return serializeCsv(REPORT_SUMMARY_COLUMNS, rows);
}

// "court-time-report-2026-03-01.csv" for a single day, or
// "court-time-report-2026-03-01-to-2026-03-07.csv" for a range — mirrors
// outstandingBalancesFilename/paymentActivityFilename's own
// court-time-<kind>-<...>.csv convention (exportLogic.ts), sensible and
// stable without needing a club slug (this export carries no per-club
// identifying data beyond what the Admin already sees on screen).
export function reportSummaryFilename(startDate: string, endDate: string): string {
  return startDate === endDate
    ? `court-time-report-${startDate}.csv`
    : `court-time-report-${startDate}-to-${endDate}.csv`;
}
