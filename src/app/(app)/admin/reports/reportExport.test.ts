import { describe, expect, it } from "vitest";
import { buildReportSummaryCsv, reportSummaryFilename, type ReportSummaryRow } from "./reportExport";

// Admin Cleanup Checkpoint 6 (correction pass) — real behavioral tests
// against the actual exported pure functions, matching this codebase's
// established convention for pure libs (see admin/payments/exportLogic.
// test.ts) rather than source-inspection mimicry.

describe("buildReportSummaryCsv — current-snapshot rows never inherit the selected-range dates", () => {
  const baseRows: ReportSummaryRow[] = [
    { section: "Financial", metric: "Collected", value: "$1250.00", scope: "Selected range" },
    { section: "Financial", metric: "Outstanding", value: "$300.00", scope: "Current snapshot" },
  ];

  it("a Selected range row retains the selected start/end dates", () => {
    const csv = buildReportSummaryCsv({ rows: baseRows, startDate: "2026-03-01", endDate: "2026-03-07" });
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe("section,metric,value,scope,start_date,end_date");
    const collectedLine = lines.find(l => l.startsWith("Financial,Collected,"));
    expect(collectedLine).toBe("Financial,Collected,$1250.00,Selected range,2026-03-01,2026-03-07");
  });

  it("a Current snapshot row has BLANK start_date/end_date, never the selected range's dates", () => {
    const csv = buildReportSummaryCsv({ rows: baseRows, startDate: "2026-03-01", endDate: "2026-03-07" });
    const lines = csv.trim().split("\r\n");
    const outstandingLine = lines.find(l => l.startsWith("Financial,Outstanding,"));
    expect(outstandingLine).toBe("Financial,Outstanding,$300.00,Current snapshot,,");
    expect(outstandingLine).not.toMatch(/2026-03-01|2026-03-07/);
  });

  it("a single-day range (startDate === endDate) still leaves Current snapshot rows blank", () => {
    const csv = buildReportSummaryCsv({ rows: baseRows, startDate: "2026-03-01", endDate: "2026-03-01" });
    const lines = csv.trim().split("\r\n");
    expect(lines.find(l => l.startsWith("Financial,Collected,"))).toBe("Financial,Collected,$1250.00,Selected range,2026-03-01,2026-03-01");

    expect(lines.find(l => l.startsWith("Financial,Outstanding,"))).toBe("Financial,Outstanding,$300.00,Current snapshot,,");
  });

  it("header row is stable and matches the locked column contract", () => {
    const csv = buildReportSummaryCsv({ rows: [], startDate: "2026-03-01", endDate: "2026-03-07" });
    expect(csv).toBe("section,metric,value,scope,start_date,end_date\r\n");
  });

  it("CSV values containing commas/quotes are still correctly RFC-4180 escaped regardless of scope", () => {
    const rows: ReportSummaryRow[] = [
      { section: "Financial", metric: "Note, with comma", value: 'Say "hi"', scope: "Selected range" },
    ];
    const csv = buildReportSummaryCsv({ rows, startDate: "2026-03-01", endDate: "2026-03-07" });
    expect(csv).toContain('"Note, with comma"');
    expect(csv).toContain('"Say ""hi"""');
  });
});

describe("reportSummaryFilename", () => {
  it("uses a single date when start === end", () => {
    expect(reportSummaryFilename("2026-03-01", "2026-03-01")).toBe("court-time-report-2026-03-01.csv");
  });

  it("uses a range when start !== end", () => {
    expect(reportSummaryFilename("2026-03-01", "2026-03-07")).toBe("court-time-report-2026-03-01-to-2026-03-07.csv");
  });
});
