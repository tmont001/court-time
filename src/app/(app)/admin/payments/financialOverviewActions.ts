"use server";

// Admin Cleanup Checkpoint 6 — Financial Analytics. Payments Overview's
// range switch is a Server Action (not a URL param) deliberately — this
// page's existing Outstanding/Payment Activity tab mechanism is plain
// client `useState`, and re-plumbing the whole Server Component into
// searchParams-driven tabs purely to URL-back one new range selector would
// have been unnecessary scope for this checkpoint. Financial analytics
// remain strictly Admin-only (never Staff, unlike the existing Outstanding/
// Payment Activity tabs Staff already has) — independently re-checked here
// via getAuthProfile(), matching every other Admin-only Server Action in
// this codebase (see refundActions.ts's own identical pattern), even
// though get_financial_range_summary itself also fails closed for a
// non-admin caller.

import { getAuthUser, getAuthProfile } from "@/lib/supabase/user";
import { createClient } from "@/lib/supabase/server";
import { resolveReportRange, type ReportRange } from "../reports/dateRange";
import { getFinancialRangeSummary, getOutstandingSnapshot, type FinancialRangeSummary } from "./financialSummary";

export interface FinancialOverviewResult {
  range: ReportRange;
  startDate: string;
  endDate: string;
  summary: FinancialRangeSummary;
  outstandingCents: number;
}

export async function getFinancialOverviewAction(
  range: string,
  customStart?: string,
  customEnd?: string,
): Promise<{ data?: FinancialOverviewResult; error?: string }> {
  const user = await getAuthUser();
  if (!user) return { error: "You must be signed in." };

  const profile = await getAuthProfile();
  if (profile?.role !== "admin") return { error: "Admin access required." };

  const clubId = profile.club_id ?? "";
  if (!clubId) return { error: "No active club." };

  const supabase = await createClient();

  const { data: club } = await supabase.from("clubs").select("timezone").eq("id", clubId).single();
  const clubTimezone = club?.timezone ?? "America/New_York";
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: clubTimezone });

  const resolved = resolveReportRange(todayStr, range, customStart, customEnd);

  const [summaryResult, outstandingResult] = await Promise.all([
    getFinancialRangeSummary(supabase, resolved.startDate, resolved.endDate),
    getOutstandingSnapshot(supabase, clubId, clubTimezone),
  ]);

  if (summaryResult.error || !summaryResult.data) {
    console.error("[payments/financial-overview] get_financial_range_summary failed", {
      code: summaryResult.error?.code ?? null,
      message: summaryResult.error?.message ?? null,
    });
    return { error: "Financial summary could not be loaded. Please try again." };
  }
  if ("error" in outstandingResult) {
    console.error("[payments/financial-overview] outstanding snapshot failed", { message: outstandingResult.error });
    return { error: "Financial summary could not be loaded. Please try again." };
  }

  return {
    data: {
      range: resolved.range,
      startDate: resolved.startDate,
      endDate: resolved.endDate,
      summary: summaryResult.data,
      outstandingCents: outstandingResult.outstandingCents,
    },
  };
}
