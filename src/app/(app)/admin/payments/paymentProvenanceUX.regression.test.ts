import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 34G-C1 — Payment Provenance & Financial History UX. Source-
// inspection coverage for the wiring/read-model/rendering pieces that
// aren't pure functions (those are covered by genuine unit tests in
// src/lib/paymentProvenance.test.ts and src/lib/supabase/exhaustiveRange.test.ts).
// This is presentation/read-model work only — no migration, no RPC, no
// change to payment lifecycle architecture, which this file explicitly
// verifies rather than assumes.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

const PAGE_PATH = "src/app/(app)/admin/payments/page.tsx";
const ACTIONS_PATH = "src/app/(app)/admin/payments/actions.ts";
const CLIENT_PATH = "src/app/(app)/admin/payments/AdminPaymentsClient.tsx";
const DETAIL_SHEET_PATH = "src/components/PaymentDetailSheet.tsx";
const PROVENANCE_LIB_PATH = "src/lib/paymentProvenance.ts";

// ═══════════════════════════════════════════════════════════════════════════
// I — list source query is batched, not N+1
// ═══════════════════════════════════════════════════════════════════════════

describe("I. the list-row source-summary query is one batched, exhaustively-paginated read — never per-row", () => {
  it("page.tsx issues exactly one payment_events query for the whole page, using .in(\"payment_id\", paymentIds) against the SAME batched paymentIds array every other bulk query on this page already uses", () => {
    const s = readSource(PAGE_PATH);
    expect(s).toContain('.in("payment_id", paymentIds)');
    expect(s).toContain("fetchAllRowsExhaustively");
    // Only ONE call site for the payment_events source-summary read.
    const matches = s.match(/from\("payment_events"\)/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("the query is scoped by club_id, matching every other bulk read on this page — never a raw cross-club query", () => {
    const s = readSource(PAGE_PATH);
    const fnStart = s.indexOf("fetchAllRowsExhaustively<{");
    const fnEnd = s.indexOf(");", s.indexOf(".range(offset, offset + limit - 1);", fnStart));
    const block = s.slice(fnStart, fnEnd);
    expect(block).toContain('.eq("club_id", clubId)');
  });

  it("no per-row loop calls a Supabase query for payment_events — the bulk query happens ONCE, before the row-assembly loop, and the loop only ever does Map.get() lookups", () => {
    const s = readSource(PAGE_PATH);
    const bulkQueryIdx = s.indexOf('from("payment_events")');
    const rowLoopIdx = s.indexOf("const rows: AdminPaymentRow[] = [];");
    expect(bulkQueryIdx).toBeGreaterThan(-1);
    expect(rowLoopIdx).toBeGreaterThan(bulkQueryIdx);
    // The row-assembly loop itself must not contain a second Supabase call.
    const loopBody = s.slice(rowLoopIdx, s.indexOf("rows.sort("));
    expect(loopBody).not.toMatch(/supabase\.(from|rpc)\(/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// J — source query paginates exhaustively rather than silently truncating
// ═══════════════════════════════════════════════════════════════════════════

describe("J. the source-summary query never relies on a single unbounded .select() — it uses the shared exhaustive-pagination helper", () => {
  it("imports and calls fetchAllRowsExhaustively rather than a bare .select()/.limit() on payment_events", () => {
    const s = readSource(PAGE_PATH);
    expect(s).toContain('import { fetchAllRowsExhaustively } from "@/lib/supabase/exhaustiveRange";');
    const fnStart = s.indexOf("fetchAllRowsExhaustively<{");
    const rangeIdx = s.indexOf(".range(offset, offset + limit - 1);", fnStart);
    expect(rangeIdx).toBeGreaterThan(fnStart);
    const block = s.slice(fnStart, rangeIdx + ".range(offset, offset + limit - 1);".length);
    expect(block).toContain(".range(offset, offset + limit - 1);");
    expect(block).not.toMatch(/\.limit\(/);
  });

  it("the pagination helper itself is generic and reusable (no payment_events-specific logic baked into the actual code — the header comment is free to explain its motivating use case in prose), per the explicit 34G-C2-reuse requirement", () => {
    const s = codeOnly(readSource("src/lib/supabase/exhaustiveRange.ts"));
    expect(s).not.toMatch(/payment_events|payments\b/);
    expect(s).toContain("export async function fetchAllRowsExhaustively<T>");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// K/L — actor_id/external_reference reach the Payment History read model,
//       resolved via one batched profiles lookup
// ═══════════════════════════════════════════════════════════════════════════

describe("K. actor_id, external_reference, and reversesEventId now reach PaymentEventHistoryItem", () => {
  it("the select statement fetches external_reference and actor_id (both previously omitted)", () => {
    const s = readSource(ACTIONS_PATH);
    expect(s).toContain(
      '.select("id, event_type, amount_cents, method, external_reference, notes, actor_id, occurred_at, reverses_event_id")',
    );
  });

  it("PaymentEventHistoryItem exposes reversesEventId, externalReference, actorId, and actorName", () => {
    const s = readSource(ACTIONS_PATH);
    const ifaceStart = s.indexOf("export interface PaymentEventHistoryItem {");
    const ifaceEnd = s.indexOf("}", ifaceStart);
    const iface = s.slice(ifaceStart, ifaceEnd);
    expect(iface).toContain("reversesEventId: string | null;");
    expect(iface).toContain("externalReference: string | null;");
    expect(iface).toContain("actorId: string | null;");
    expect(iface).toContain("actorName: string | null;");
  });
});

describe("L. actor profiles are resolved in exactly one batched lookup — never per-event", () => {
  it("fetchPaymentEventHistory issues exactly one profiles query, using .in(\"id\", actorIds) over the distinct actor ids collected from the already-fetched rows", () => {
    const s = readSource(ACTIONS_PATH);
    const fnStart = s.indexOf("export async function fetchPaymentEventHistory(");
    const fnEnd = s.indexOf("\nexport async function updateClubPaymentModeAction");
    const fn = s.slice(fnStart, fnEnd);
    const profileQueryMatches = fn.match(/from\("profiles"\)/g) ?? [];
    expect(profileQueryMatches.length).toBe(1);
    expect(fn).toContain('const actorIds = [...new Set(rows.map(r => r.actor_id).filter((id): id is string => id !== null))];');
    expect(fn).toContain('.select("id, first_name, last_name")\n      .in("id", actorIds);');
  });

  it("the profiles query is guarded behind actorIds.length > 0 — never issued when there is nothing to resolve", () => {
    const s = readSource(ACTIONS_PATH);
    expect(s).toContain("if (actorIds.length > 0) {");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// M/N — manual actor/reference/notes render only when present
// ═══════════════════════════════════════════════════════════════════════════

describe("M. manual-event classification uses event_type, never presence/absence of method (correction pass — Issue 1)", () => {
  it("1/2. isManualEvent is defined by event_type (manual_payment_recorded OR refund_recorded) — the stale item.method !== null definition is gone", () => {
    const s = readSource(DETAIL_SHEET_PATH);
    expect(s).toContain(
      'const isManualEvent = item.eventType === "manual_payment_recorded" || item.eventType === "refund_recorded";',
    );
    expect(s).not.toMatch(/isManualEvent\s*=\s*item\.method/);
  });

  it("3/4. the manual-reference render condition depends only on isManualEvent + externalReference — never on item.method — so a refund_recorded row with method=NULL still renders its Reference line, and a null method can never misclassify a manual refund as online/non-manual", () => {
    const s = readSource(DETAIL_SHEET_PATH);
    expect(s).toContain("{isManualEvent && item.externalReference && (");
    expect(s).toContain("Reference: {item.externalReference}");
    // The render condition itself — not merely the variable definition
    // above — must not reference item.method at all.
    const renderConditionIdx = s.indexOf("{isManualEvent && item.externalReference && (");
    const renderConditionLine = s.slice(renderConditionIdx, s.indexOf("\n", renderConditionIdx));
    expect(renderConditionLine).not.toMatch(/item\.method/);
  });

  it("8. 'Recorded by {name}' appears only for manual_payment_recorded/refund_recorded when actorName exists — never for any other event type, even when actorName happens to be present", () => {
    const s = readSource(DETAIL_SHEET_PATH);
    expect(s).toContain(
      'item.actorName && (item.eventType === "manual_payment_recorded" || item.eventType === "refund_recorded")\n                    ? `Recorded by ${item.actorName}`',
    );
  });

  it("9. 'Corrected by {name}' appears for reverse_payment_event when actorName exists", () => {
    const s = readSource(DETAIL_SHEET_PATH);
    expect(s).toContain(
      'item.actorName && item.eventType === "reverse_payment_event"\n                    ? `Corrected by ${item.actorName}`',
    );
  });

  it("10. obligation_created/obligation_amount_adjusted/waived/void_payment_obligation never receive actor attribution — actorAttributionLabel's own ternary chain has no branch for any of them, so it falls through to null even when actorName is present", () => {
    const s = readSource(DETAIL_SHEET_PATH);
    const startIdx = s.indexOf("const actorAttributionLabel =");
    const endIdx = s.indexOf(";", s.indexOf(": null", startIdx)) + 1;
    const block = s.slice(startIdx, endIdx);
    expect(block).not.toMatch(/obligation_created|obligation_amount_adjusted|waived|void_payment_obligation/);
    // Exactly two positive branches (manual money-movement, then
    // reversal) terminating in a bare `: null` fallback — no third
    // event-type branch was added.
    expect(block).toMatch(/:\s*null;\s*$/);
  });

  it("online events never receive actor attribution — actorAttributionLabel's branches never mention online_payment_recorded/online_refund_recorded (actorName is structurally null for them anyway, from the read model itself)", () => {
    const s = readSource(DETAIL_SHEET_PATH);
    const startIdx = s.indexOf("const actorAttributionLabel =");
    const endIdx = s.indexOf(";", s.indexOf(": null", startIdx)) + 1;
    const block = s.slice(startIdx, endIdx);
    expect(block).not.toMatch(/online_payment_recorded|online_refund_recorded/);
  });

  it("actor attribution is rendered behind a single actorAttributionLabel guard, never a raw item.actorName check — this is what makes the per-event-type gating actually apply at render time, not just in a derived variable nobody reads", () => {
    const s = readSource(DETAIL_SHEET_PATH);
    expect(s).toContain("{actorAttributionLabel && (");
    expect(s).not.toMatch(/\{item\.actorName && \(/);
  });

  it("no actor is ever fabricated for a webhook-driven Stripe event or defaulted with a fallback string — actorAttributionLabel is only ever a real resolved name or null", () => {
    const s = readSource(DETAIL_SHEET_PATH);
    expect(s).not.toMatch(/actorName\s*(\?\?|\|\|)\s*["'`]/);
  });
});

describe("N. notes render when present, kept visually secondary, and are never rendered when empty/null", () => {
  it("notes are rendered behind an `item.notes &&` guard with a muted/italic treatment", () => {
    const s = readSource(DETAIL_SHEET_PATH);
    expect(s).toContain("{item.notes && (");
    expect(s).toMatch(/text-gray-400 dark:text-gray-500 mt-0\.5 italic">\{item\.notes\}/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// O — raw Stripe reference absent from the primary row, present only
//     inside a collapsed Transaction details disclosure
// ═══════════════════════════════════════════════════════════════════════════

describe("O. raw Stripe reference never appears in the primary Financial History row — only inside a collapsed Transaction details disclosure, for online events only", () => {
  it("the primary row never prints item.externalReference outside of the manual-reference or Transaction-details branches", () => {
    const s = readSource(DETAIL_SHEET_PATH);
    // Exactly four references to externalReference in the whole file: the
    // isOnlineEventWithReference guard's own !!item.externalReference
    // check, the isManualEvent guard condition, the manual "Reference:
    // ..." render, and the Transaction-details "Stripe reference: ..."
    // render — no fifth, unguarded render site anywhere else.
    const matches = s.match(/item\.externalReference/g) ?? [];
    expect(matches.length).toBe(4);
  });

  it("the disclosure is a native, collapsed-by-default <details>/<summary> labeled 'Transaction details', gated to online events with a reference only", () => {
    const s = readSource(DETAIL_SHEET_PATH);
    expect(s).toContain(
      'const isOnlineEventWithReference =\n                  (item.eventType === "online_payment_recorded" || item.eventType === "online_refund_recorded") &&\n                  !!item.externalReference;',
    );
    expect(s).toContain("{isOnlineEventWithReference && (");
    expect(s).toContain("<details className=\"mt-1\">");
    expect(s).toContain("Transaction details");
    expect(s).toContain("Stripe reference: <span className=\"font-mono\">{item.externalReference}</span>");
  });

  it("no Stripe API call, PaymentIntent/Charge lookup, or new schema field is introduced — the disclosure only ever renders the already-fetched externalReference string", () => {
    const s = readSource(DETAIL_SHEET_PATH);
    expect(s).not.toMatch(/stripe\.|paymentIntents\.|charges\.retrieve|\.rpc\(/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// P — payment_mode_at_creation is never used as provenance anywhere in
//     this checkpoint's changed/new files
// ═══════════════════════════════════════════════════════════════════════════

describe("P. payment_mode_at_creation is never referenced by any 34G-C1 file — canonical provenance is payment_events.event_type/method only", () => {
  it("none of the provenance helper, the bulk list query, the widened read model, or the rendering components use payment_mode_at_creation in actual code — paymentProvenance.ts's own header comment legitimately NAMES it only to document why it is deliberately never used, which is not a usage", () => {
    for (const path of [PROVENANCE_LIB_PATH, PAGE_PATH, ACTIONS_PATH, CLIENT_PATH, DETAIL_SHEET_PATH]) {
      const s = codeOnly(readSource(path));
      expect(s).not.toMatch(/payment_mode_at_creation|paymentModeAtCreation/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Q — existing Admin/Staff authorization remains intact
// ═══════════════════════════════════════════════════════════════════════════

describe("Q. Admin/Staff-only authorization is unchanged — Members and non-staff Pros remain blocked", () => {
  it("page.tsx still redirects any non-operator (non-Admin/Staff) role before reading anything", () => {
    const s = readSource(PAGE_PATH);
    expect(s).toContain("if (!profile || !isOperator(profile.role)) redirect(\"/calendar\");");
  });

  it("fetchPaymentEventHistory still uses assertActiveClub + an authenticated-session check", () => {
    const s = readSource(ACTIONS_PATH);
    const fnStart = s.indexOf("export async function fetchPaymentEventHistory(");
    const fnEnd = s.indexOf("\nexport async function updateClubPaymentModeAction");
    const fn = s.slice(fnStart, fnEnd);
    expect(fn).toContain("const guard = await assertActiveClub(expectedClubId);");
    expect(fn).toContain("if (!guard.ok) return { error: ERROR_MESSAGES[guard.error] };");
    // Phase 34G-D1 correction — authentication is now checked via
    // getAuthProfile() (which itself resolves null for an unauthenticated
    // caller) as part of the new explicit Admin/Staff role gate, rather
    // than a separate bare supabase.auth.getUser() check — see
    // productionHardening.regression.test.ts's own D/E/F coverage.
    expect(fn).toContain("if (!profile) return { error: ERROR_MESSAGES.not_authenticated };");
  });

  it("the bulk source-summary query in page.tsx never trusts a client-supplied club id — clubId is the same server-resolved profile.club_id every other query on this page already uses", () => {
    const s = readSource(PAGE_PATH);
    expect(s).toContain("const clubId = profile.club_id ?? \"\";");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// R — no migration/RPC/payment lifecycle architecture change
// ═══════════════════════════════════════════════════════════════════════════

describe("R. no migration, no new RPC, no payment lifecycle architecture change", () => {
  it("none of the changed/new files call any RPC beyond the ones already in use before this checkpoint", () => {
    const s = readSource(PAGE_PATH);
    const rpcCalls = [...s.matchAll(/\.rpc\(\s*["']([^"']+)["']/g)].map(m => m[1]);
    // Unchanged from before 34G-C1 — get_online_refundable_amount_for_payments
    // is the ONLY RPC this page has ever called.
    expect(new Set(rpcCalls)).toEqual(new Set(["get_online_refundable_amount_for_payments"]));
  });

  it("actions.ts introduces no new RPC call — record_manual_payment/update_club_payment_mode/activate_court_time_payments remain the only ones", () => {
    const s = readSource(ACTIONS_PATH);
    const rpcCalls = [...s.matchAll(/\.rpc\(\s*["']([^"']+)["']/g)].map(m => m[1]);
    expect(new Set(rpcCalls)).toEqual(
      new Set(["get_payment_states_for_domains", "activate_court_time_payments", "update_club_payment_mode", "record_manual_payment"]),
    );
  });

  it("no createPrivilegedClient/service-role usage was introduced in page.tsx or the widened fetchPaymentEventHistory — same RLS-scoped authenticated client as before", () => {
    const s = readSource(PAGE_PATH);
    expect(s).not.toMatch(/createPrivilegedClient/);
    const actionsSrc = readSource(ACTIONS_PATH);
    const fnStart = actionsSrc.indexOf("export async function fetchPaymentEventHistory(");
    const fnEnd = actionsSrc.indexOf("\nexport async function updateClubPaymentModeAction");
    expect(actionsSrc.slice(fnStart, fnEnd)).not.toMatch(/createPrivilegedClient/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D/G — wiring-level reinforcement: the list summary is actually attached
//       to each row and rendered neutrally (pure logic itself is covered
//       in paymentProvenance.test.ts)
// ═══════════════════════════════════════════════════════════════════════════

describe("D. the reversal-aware source summary is wired from the bulk query onto every AdminPaymentRow", () => {
  it("page.tsx attaches sourceSummary using the SAME sourceSummaryByPaymentId map the bulk query populates", () => {
    const s = readSource(PAGE_PATH);
    expect(s).toContain("sourceSummary: sourceSummaryByPaymentId.get(p.id) ?? null,");
  });

  it("AdminPaymentRow's own type declares sourceSummary: string | null", () => {
    const s = readSource(CLIENT_PATH);
    expect(s).toContain("sourceSummary: string | null;");
  });

  it("the list-row pill renders only when sourceSummary is present, using the existing NEUTRAL tone — never Court Time brand green, never Stripe-readiness green", () => {
    const s = readSource(CLIENT_PATH);
    expect(s).toContain("{row.sourceSummary && (");
    expect(s).toMatch(/toneClassName\("neutral"\)/);
    expect(s).not.toMatch(/bg-green|text-green|border-green/);
  });

  it("11. the correction pass touched only PaymentDetailSheet's per-event actor/manual classification — the reversal-aware list summary's own source query, pagination, and pure derivation are untouched (unchanged wiring here; full pure-function behavior is proven by the unmodified src/lib/paymentProvenance.test.ts suite)", () => {
    const pageSrc = readSource(PAGE_PATH);
    expect(pageSrc).toContain("fetchAllRowsExhaustively");
    expect(pageSrc).toContain('.in("event_type", ["manual_payment_recorded", "online_payment_recorded", "reverse_payment_event"] as any)');
    const provenanceLib = readSource("src/lib/paymentProvenance.ts");
    expect(provenanceLib).toContain("export function deriveEffectiveCollectionSummary(events: ProvenanceLedgerEvent[]): string | null {");
    expect(provenanceLib).toContain("export function formatEventProvenanceLabel(eventType: string, method: string | null): string | null {");
  });
});
