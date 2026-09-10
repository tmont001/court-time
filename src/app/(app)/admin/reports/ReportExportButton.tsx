"use client";

// Admin Cleanup Checkpoint 6 — "Export report (.csv)". Pure client-side
// build: every value here was already fetched authoritatively by page.tsx
// (the same RPC results already rendered on screen) and passed straight
// through as props — never a second, independent query. serializeCsv
// (src/lib/csv.ts) has zero Supabase/Next dependencies, so no Server
// Action round trip is needed at all, unlike the Payments CSV exports
// (which genuinely need a fresh, exhaustive re-query this page's own
// capped/summarized RPC results can't provide).

import { triggerCsvDownload } from "@/lib/downloadBlob";
import { buildReportSummaryCsv, reportSummaryFilename, type ReportSummaryRow } from "./reportExport";

export default function ReportExportButton({
  rows, startDate, endDate,
}: {
  rows: ReportSummaryRow[];
  startDate: string;
  endDate: string;
}) {
  function handleExport() {
    const csv = buildReportSummaryCsv({ rows, startDate, endDate });
    triggerCsvDownload(csv, reportSummaryFilename(startDate, endDate));
  }

  return (
    <button
      type="button"
      onClick={handleExport}
      className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 motion-safe:transition-colors motion-safe:duration-100"
    >
      Export report (.csv)
    </button>
  );
}
