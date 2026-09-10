// Admin Cleanup Checkpoint 6 — Financial Analytics + Reports Export.
// The ONE shared, authoritative financial-analytics read layer consumed
// identically by /admin/payments Overview, /admin/reports Financial
// Summary, and the Reports CSV export. Deliberately NOT a single RPC for
// both concerns it exposes:
//
//   - getFinancialRangeSummary: a genuinely new, simple aggregate query
//     (payment_events grouped by domain, date-bounded) — backed by the new
//     get_financial_range_summary RPC (0172).
//   - getOutstandingSnapshot: Outstanding is a CURRENT SNAPSHOT, not a
//     range metric, and its authoritative definition already exists —
//     exportActions.ts's "Outstanding Balances" CSV export
//     (selectLatestGenuinelyOutstandingPayments + hydrateExportDomainContext,
//     the same cancelled-family collectibility gate that governs Record
//     Payment). Reusing those exact functions here — rather than
//     reimplementing their multi-table domain-collectibility joins as new
//     SQL — is what "reuse the existing authoritative Outstanding
//     semantics" means in practice: one definition, two callers, zero
//     duplication.
//
// Both functions are called from Server Components/Server Actions only
// (plain authenticated Supabase client — RLS/RPC-level auth is the real
// boundary in both cases, exactly like every other read on this page).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db/types";
import {
  selectLatestGenuinelyOutstandingPayments,
  type CycleSelectionInput,
} from "./exportLogic";
import {
  hydrateExportDomainContext,
  isHydrationFailure,
  type DomainHydrationInput,
} from "./exportDomainHydration";

export type FinancialDomain = "reservation" | "lesson" | "event" | "program" | "other";

export const FINANCIAL_DOMAIN_LABEL: Record<FinancialDomain, string> = {
  reservation: "Court reservations",
  lesson:      "Lessons",
  event:       "Events",
  program:     "Programs",
  other:       "Other / Legacy",
};

export interface FinancialRangeSummary {
  collectedCents: number;
  refundedCents:  number;
  netCollectedCents: number;
  // One entry per domain that had ANY activity in the range — a domain
  // with zero collected/refunded simply never appears (never fabricated
  // as a zero row). Callers wanting a complete, stable 4-domain grid
  // should default any FINANCIAL_DOMAIN_LABEL key missing from this array
  // to zero themselves.
  domainBreakdown: Array<{ domain: FinancialDomain; netCollectedCents: number }>;
}

// LOCKED relationship: Net collected = Collected - Refunded. Enforced here,
// once, rather than re-derived at each call site.
export async function getFinancialRangeSummary(
  supabase: SupabaseClient<Database>,
  startDate: string,
  endDate: string,
): Promise<{ data: FinancialRangeSummary | null; error: { code?: string; message?: string } | null }> {
  const { data, error } = await supabase.rpc("get_financial_range_summary", {
    p_start_date: startDate,
    p_end_date: endDate,
  });
  if (error) return { data: null, error: { code: error.code, message: error.message } };

  const rows = (data ?? []) as Array<{ domain: string; collected_cents: number; refunded_cents: number }>;

  let collectedCents = 0;
  let refundedCents = 0;
  const domainBreakdown: FinancialRangeSummary["domainBreakdown"] = [];
  for (const r of rows) {
    collectedCents += r.collected_cents;
    refundedCents += r.refunded_cents;
    const domain = (["reservation", "lesson", "event", "program"].includes(r.domain) ? r.domain : "other") as FinancialDomain;
    domainBreakdown.push({ domain, netCollectedCents: r.collected_cents - r.refunded_cents });
  }

  return {
    data: {
      collectedCents,
      refundedCents,
      netCollectedCents: collectedCents - refundedCents,
      domainBreakdown,
    },
    error: null,
  };
}

interface RawPaymentRowForOutstanding {
  id: string;
  domain_type: DomainHydrationInput["domainType"];
  domain_id: string;
  obligation_cycle: number;
  roster_member_id: string | null;
  amount_due_cents: number;
  amount_paid_cents: number;
  status: string;
}

// Outstanding = SUM of GREATEST(amount_due_cents - amount_paid_cents, 0)
// across the latest-cycle, genuinely-outstanding, currently-collectible
// payment for each domain row — the EXACT same three-step definition
// exportOutstandingBalancesCsv already computes (selectLatestGenuinely
// OutstandingPayments, then hydrateExportDomainContext's `collectible`
// gate, then the same clamped-at-zero remaining-balance formula
// buildOutstandingBalanceRow already uses). An overpaid payment (paid >
// due) contributes exactly 0 here — never a negative amount that could
// reduce the total below what other, genuinely outstanding payments owe.
export async function getOutstandingSnapshot(
  supabase: SupabaseClient<Database>,
  clubId: string,
  clubTimezone: string,
): Promise<{ outstandingCents: number } | { error: string }> {
  const { data, error } = await supabase
    .from("payments")
    .select("id, domain_type, domain_id, obligation_cycle, roster_member_id, amount_due_cents, amount_paid_cents, status")
    .eq("club_id", clubId);
  if (error) return { error: error.message };

  const rawPayments = (data ?? []) as RawPaymentRowForOutstanding[];

  const genuinelyOutstanding = selectLatestGenuinelyOutstandingPayments(
    rawPayments.map((p): CycleSelectionInput & { raw: RawPaymentRowForOutstanding } => ({
      domainType: p.domain_type,
      domainId: p.domain_id,
      obligationCycle: p.obligation_cycle,
      status: p.status,
      amountDueCents: p.amount_due_cents,
      amountPaidCents: p.amount_paid_cents,
      raw: p,
    })),
  ).map(x => x.raw);

  if (genuinelyOutstanding.length === 0) return { outstandingCents: 0 };

  const domainInputs: DomainHydrationInput[] = genuinelyOutstanding.map(p => ({
    paymentId: p.id,
    domainType: p.domain_type,
    domainId: p.domain_id,
    rosterMemberId: p.roster_member_id,
  }));
  const domainContextResult = await hydrateExportDomainContext(supabase, domainInputs, clubTimezone);
  if (isHydrationFailure(domainContextResult)) return { error: domainContextResult.error };

  let outstandingCents = 0;
  for (const p of genuinelyOutstanding) {
    const context = domainContextResult.get(p.id);
    if (!context || !context.collectible) continue;
    outstandingCents += Math.max(p.amount_due_cents - p.amount_paid_cents, 0);
  }

  return { outstandingCents };
}
