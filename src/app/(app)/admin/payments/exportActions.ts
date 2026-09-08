"use server";

// Phase 34G-C2 — Payments CSV Exports. Two authenticated Server Actions
// (Outstanding Balances, Payment Activity) returning completed CSV text +
// filename; the client only ever triggers the Blob download (§22 —
// preferred mechanism per the accepted delta audit). Admin/Staff only,
// never Member/Pro, and the actual queried club_id ALWAYS comes from the
// caller's own server-derived active-profile context
// (getAuthProfile().club_id) — expectedClubId is used ONLY for the
// assertActiveClub staleness preflight, never trusted as tenant identity.
//
// Correction pass (Issues 1-6) — see exportLogic.ts/exportDomainHydration.ts
// module comments for the full rationale of each fix; this file wires them
// together: true-latest-cycle-then-outstanding ordering (Issue 1),
// lifecycle-collectibility filtering (Issue 2), chunked+exhaustive bulk
// reads with deterministic ordering everywhere (Issue 3), fail-closed date
// validation (Issue 4), and fail-closed club-timezone resolution (Issue 5).

import { createClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db/types";
import { assertActiveClub } from "@/lib/supabase/staleClub";
import { STALE_CLUB_CONTEXT_ERROR, STALE_CLUB_MESSAGE } from "@/lib/staleClub";
import { getAuthProfile } from "@/lib/supabase/user";
import { isOperator } from "@/lib/auth/roles";
import { fetchAllRowsExhaustively, fetchRowsByIdsExhaustively } from "@/lib/supabase/exhaustiveRange";
import { deriveEffectiveCollectionSummary, deriveLastEffectiveCollectionDate, type ProvenanceLedgerEvent } from "@/lib/paymentProvenance";
import { serializeCsv, sanitizeFilenameSegment } from "@/lib/csv";
import {
  OUTSTANDING_BALANCE_COLUMNS,
  PAYMENT_ACTIVITY_COLUMNS,
  PAYMENT_ACTIVITY_EVENT_TYPES,
  buildOutstandingBalanceRow,
  buildPaymentActivityRow,
  selectLatestGenuinelyOutstandingPayments,
  signedAmountCentsForEvent,
  resolveActivityDateRangeUTC,
  outstandingBalancesFilename,
  paymentActivityFilename,
} from "./exportLogic";
import { hydrateExportDomainContext, isHydrationFailure, type DomainHydrationInput, type ExportDomainType } from "./exportDomainHydration";

const ERROR_MESSAGES: Record<string, string> = {
  [STALE_CLUB_CONTEXT_ERROR]: STALE_CLUB_MESSAGE,
  not_authenticated: "You must be signed in.",
  insufficient_role: "You don't have permission to do that.",
  no_active_club: "No active club.",
  load_failed: "Failed to generate the export. Please try again.",
};

interface ExportContext {
  supabase: SupabaseClient<Database>;
  clubId: string;
  clubTimezone: string;
  clubSlug: string;
}

async function resolveExportContext(expectedClubId: string): Promise<{ error: string } | ExportContext> {
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: ERROR_MESSAGES[guard.error] };

  const profile = await getAuthProfile();
  if (!profile) return { error: ERROR_MESSAGES.not_authenticated };
  if (!isOperator(profile.role)) return { error: ERROR_MESSAGES.insufficient_role };
  // The ACTUAL query club always comes from the server-derived active
  // profile — expectedClubId (checked above) is a staleness preflight
  // only, never the authoritative tenant identity.
  const clubId = profile.club_id;
  if (!clubId) return { error: ERROR_MESSAGES.no_active_club };

  const supabase = await createClient();
  // Issue 5 — FAILS CLOSED. A financial export's date/time boundaries are
  // computed in the club's own timezone; if the club's metadata (including
  // timezone) cannot be loaded, this must return an export failure, NEVER
  // silently substitute a fallback timezone (the previous "America/
  // New_York" fallback could misattribute every occurred_at boundary and
  // every formatted date in the export for a club actually in a different
  // zone).
  const { data: clubRow, error: clubError } = await supabase
    .from("clubs")
    .select("timezone, slug")
    .eq("id", clubId)
    .single();
  if (clubError || !clubRow || !clubRow.timezone) {
    console.error("[export] club metadata read failed", { club_id: clubId, message: clubError?.message ?? "missing row or timezone" });
    return { error: ERROR_MESSAGES.load_failed };
  }
  // Slug is non-financial, cosmetic filename metadata only — a defensive
  // fallback here (never for timezone) is acceptable per Issue 5's own
  // carve-out.
  const clubSlug = clubRow.slug ?? "club";

  return { supabase, clubId, clubTimezone: clubRow.timezone, clubSlug };
}

// ─────────────────────────────────────────────────────────────────────────
// Outstanding Balances export (§2-§7, corrected per Issues 1-3)
// ─────────────────────────────────────────────────────────────────────────

interface RawOutstandingPaymentRow {
  id: string;
  domain_type: ExportDomainType;
  domain_id: string;
  obligation_cycle: number;
  roster_member_id: string | null;
  amount_due_cents: number;
  amount_paid_cents: number;
  currency: string;
  status: string;
  updated_at: string;
}

export async function exportOutstandingBalancesCsv(
  expectedClubId: string,
): Promise<{ csv?: string; filename?: string; error?: string }> {
  const ctx = await resolveExportContext(expectedClubId);
  if ("error" in ctx) return { error: ctx.error };
  const { supabase, clubId, clubTimezone, clubSlug } = ctx;

  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: clubTimezone });
  const filename = outstandingBalancesFilename(sanitizeFilenameSegment(clubSlug), todayStr);

  // Issue 1 — LOCKED ORDER: fetch EVERY payment row for the club
  // (deliberately NOT status-filtered — the true latest obligation_cycle
  // per domain can only be determined from the full set; filtering by
  // status first can let a superseded, non-latest cycle masquerade as
  // outstanding, e.g. cycle 1 unpaid + cycle 2 paid must exclude the
  // domain entirely). Exhaustively paginated, deterministically ordered by
  // id (a stable tie-breaker independent of updated_at, which is not
  // guaranteed unique) — independent of page.tsx's own MAX_ROWS=500 cap,
  // which is a UI-only limit that must never leak into this export (§2).
  const { rows: rawPayments, error: paymentsError } = await fetchAllRowsExhaustively<RawOutstandingPaymentRow>(
    async (offset, limit) => {
      const result = await supabase
        .from("payments")
        .select("id, domain_type, domain_id, obligation_cycle, roster_member_id, amount_due_cents, amount_paid_cents, currency, status, updated_at")
        .eq("club_id", clubId)
        .order("id", { ascending: true })
        .range(offset, offset + limit - 1);
      return { data: result.data as RawOutstandingPaymentRow[] | null, error: result.error };
    },
  );
  if (paymentsError) {
    console.error("[export] outstanding balances payments read failed", { club_id: clubId, message: paymentsError });
    return { error: ERROR_MESSAGES.load_failed };
  }

  // Issue 1 — true latest cycle per domain FIRST, outstanding-ness
  // evaluated ONLY on that latest cycle (never a superseded one).
  const latestPayments = selectLatestGenuinelyOutstandingPayments(
    rawPayments.map(p => ({
      domainType: p.domain_type,
      domainId: p.domain_id,
      obligationCycle: p.obligation_cycle,
      status: p.status,
      amountDueCents: p.amount_due_cents,
      amountPaidCents: p.amount_paid_cents,
      // Carry the full raw row through so it's available after filtering.
      raw: p,
    })),
  ).map(x => x.raw);

  // A zero-row export is still a valid CSV containing only the header row
  // (§23) — never an error, never skipped.
  if (latestPayments.length === 0) {
    return { csv: serializeCsv(OUTSTANDING_BALANCE_COLUMNS, []), filename };
  }

  const domainInputs: DomainHydrationInput[] = latestPayments.map(p => ({
    paymentId: p.id, domainType: p.domain_type, domainId: p.domain_id, rosterMemberId: p.roster_member_id,
  }));
  const domainContextResult = await hydrateExportDomainContext(supabase, domainInputs, clubTimezone);
  if (isHydrationFailure(domainContextResult)) {
    console.error("[export] outstanding balances domain hydration failed", { club_id: clubId, message: domainContextResult.error });
    return { error: ERROR_MESSAGES.load_failed };
  }
  const domainContextByPaymentId = domainContextResult;

  // Reversal-aware Payment Source + Last Payment Date — bulk, tenant-
  // scoped, chunked + exhaustively-paginated payment_events query (Issue
  // 3), mirroring page.tsx's own 34G-C1 bulk source-summary query,
  // extended to also select occurred_at for Last Payment Date (§5/§6 —
  // never "latest event" naively; reuses deriveEffectiveCollectionSummary/
  // deriveLastEffectiveCollectionDate from src/lib/paymentProvenance.ts).
  const paymentIds = latestPayments.map(p => p.id);
  const { rows: provenanceEventRows, error: provenanceError } = await fetchRowsByIdsExhaustively<{
    id: string; payment_id: string; event_type: string; method: string | null;
    reverses_event_id: string | null; occurred_at: string;
  }>(paymentIds, async (chunkIds, offset, limit) => {
    const result = await supabase
      .from("payment_events")
      .select("id, payment_id, event_type, method, reverses_event_id, occurred_at")
      .eq("club_id", clubId)
      .in("payment_id", chunkIds)
      // Narrow, pre-existing-pattern workaround for db/types.ts's stale
      // event_type union (mirrors page.tsx's own identical cast).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .in("event_type", ["manual_payment_recorded", "online_payment_recorded", "reverse_payment_event"] as any)
      .order("id", { ascending: true })
      .range(offset, offset + limit - 1);
    return { data: result.data, error: result.error };
  });

  const sourceSummaryByPaymentId = new Map<string, string>();
  const lastPaymentDateByPaymentId = new Map<string, string>();
  if (provenanceError) {
    // Financial export data must never ship from a partially-failed read
    // (Issue 3) — abort the whole export rather than silently omit
    // Source/Last Payment Date for an unknown subset of rows.
    console.error("[export] outstanding balances provenance read failed", { club_id: clubId, message: provenanceError });
    return { error: ERROR_MESSAGES.load_failed };
  }
  const eventsByPayment = new Map<string, ProvenanceLedgerEvent[]>();
  for (const r of provenanceEventRows) {
    const list = eventsByPayment.get(r.payment_id) ?? [];
    list.push({ id: r.id, eventType: r.event_type, method: r.method, reversesEventId: r.reverses_event_id, occurredAt: r.occurred_at });
    eventsByPayment.set(r.payment_id, list);
  }
  for (const [paymentId, events] of eventsByPayment) {
    const summary = deriveEffectiveCollectionSummary(events);
    if (summary) sourceSummaryByPaymentId.set(paymentId, summary);
    const lastDate = deriveLastEffectiveCollectionDate(events);
    if (lastDate) lastPaymentDateByPaymentId.set(paymentId, lastDate);
  }

  const rows = [];
  for (const p of latestPayments) {
    const domainContext = domainContextByPaymentId.get(p.id);
    // Completeness pass (Issue, prior correction round) — a financial
    // export must never silently drop a genuinely outstanding debt because
    // its required domain context couldn't be hydrated. This should be
    // structurally unreachable (hydrateExportDomainContext already fails
    // the WHOLE batch above if any required parent object is missing for
    // ANY input it was given, and domainInputs was built directly from
    // latestPayments) — kept as an explicit, non-`continue` fail-closed
    // check rather than relying solely on that batch-level guarantee.
    if (!domainContext) {
      console.error("[export] outstanding balances: required domain context missing for a genuinely outstanding payment", { club_id: clubId, payment_id: p.id, domain_type: p.domain_type, domain_id: p.domain_id });
      return { error: ERROR_MESSAGES.load_failed };
    }
    // Issue 2 (prior correction round) — Outstanding Balances means
    // CURRENTLY COLLECTIBLE debt: a cancelled-family lifecycle (the same
    // gate that withholds Record Payment) INTENTIONALLY excludes the row,
    // even though it remains a historically true unpaid/partially_paid
    // financial fact. This is a deliberate exclusion, never a hydration
    // failure — the two are structurally distinct code paths above.
    if (!domainContext.collectible) continue;
    rows.push(buildOutstandingBalanceRow({
      identityName: domainContext.identityName,
      title: domainContext.title,
      domainTypeLabel: domainContext.domainTypeLabel,
      serviceDateTime: domainContext.serviceDateTime,
      lifecycleLabel: domainContext.lifecycleLabel,
      status: p.status,
      amountDueCents: p.amount_due_cents,
      amountPaidCents: p.amount_paid_cents,
      currency: p.currency,
      sourceSummary: sourceSummaryByPaymentId.get(p.id) ?? null,
      lastPaymentDateISO: lastPaymentDateByPaymentId.get(p.id) ?? null,
      clubTimezone,
      paymentId: p.id,
    }));
  }

  return { csv: serializeCsv(OUTSTANDING_BALANCE_COLUMNS, rows), filename };
}

// ─────────────────────────────────────────────────────────────────────────
// Payment Activity export (§8-§17, corrected per Issues 3-5)
// ─────────────────────────────────────────────────────────────────────────

export interface PaymentActivityExportParams {
  all: boolean;
  from: string | null; // "YYYY-MM-DD", club-local
  to: string | null;   // "YYYY-MM-DD", club-local
}

interface RawActivityEventRow {
  id: string;
  payment_id: string;
  event_type: string;
  amount_cents: number | null;
  method: string | null;
  external_reference: string | null;
  notes: string | null;
  reverses_event_id: string | null;
  actor_id: string | null;
  occurred_at: string;
}

export async function exportPaymentActivityCsv(
  params: PaymentActivityExportParams,
  expectedClubId: string,
): Promise<{ csv?: string; filename?: string; error?: string }> {
  const ctx = await resolveExportContext(expectedClubId);
  if ("error" in ctx) return { error: ctx.error };
  const { supabase, clubId, clubTimezone, clubSlug } = ctx;

  // Issue 4 — FAILS CLOSED. all===false REQUIRES a valid, well-formed,
  // from<=to range; anything else is a rejected export request, never
  // silently reinterpreted as "All activity."
  const range = resolveActivityDateRangeUTC(params, clubTimezone);
  if (!range.ok) return { error: range.error };

  const filename = paymentActivityFilename(sanitizeFilenameSegment(clubSlug), params);

  // §9 — canonical activity timestamp is occurred_at, NEVER created_at.
  // §10 — exactly the 5 money-movement event types. Issue 3 — occurred_at
  // is not itself unique, so ordering also ties off on id for deterministic
  // pagination across .range() calls.
  const { rows: rawEvents, error: eventsError } = await fetchAllRowsExhaustively<RawActivityEventRow>(
    async (offset, limit) => {
      let query = supabase
        .from("payment_events")
        .select("id, payment_id, event_type, amount_cents, method, external_reference, notes, reverses_event_id, actor_id, occurred_at")
        .eq("club_id", clubId)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .in("event_type", PAYMENT_ACTIVITY_EVENT_TYPES as any)
        .order("occurred_at", { ascending: true })
        .order("id", { ascending: true });
      if (range.startUTC) query = query.gte("occurred_at", range.startUTC);
      if (range.endUTC) query = query.lt("occurred_at", range.endUTC);
      const result = await query.range(offset, offset + limit - 1);
      return { data: result.data as RawActivityEventRow[] | null, error: result.error };
    },
  );
  if (eventsError) {
    console.error("[export] payment activity events read failed", { club_id: clubId, message: eventsError });
    return { error: ERROR_MESSAGES.load_failed };
  }

  // A zero-row export is still a valid CSV containing only the header row.
  if (rawEvents.length === 0) {
    return { csv: serializeCsv(PAYMENT_ACTIVITY_COLUMNS, []), filename };
  }

  // §12 — resolve reversal targets that may fall OUTSIDE the requested
  // window, chunked + exhaustively paginated (Issue 3), tenant-scoped,
  // deterministically ordered. reverse_payment_event's own RPC (0151, the
  // latest effective definition — see Issue 6 below) only ever targets
  // manual_payment_recorded/refund_recorded — both already money-movement
  // types — so this lookup only ever needs event_type + amount_cents, not
  // full row context.
  const reversalTargetIds = [...new Set(
    rawEvents
      .filter(e => e.event_type === "reverse_payment_event" && e.reverses_event_id)
      .map(e => e.reverses_event_id as string),
  )];
  const targetEventById = new Map<string, { eventType: string; amountCents: number | null }>();
  if (reversalTargetIds.length > 0) {
    const { rows: targetRows, error: targetError } = await fetchRowsByIdsExhaustively<{
      id: string; event_type: string; amount_cents: number | null;
    }>(reversalTargetIds, async (chunkIds, offset, limit) => {
      const result = await supabase
        .from("payment_events")
        .select("id, event_type, amount_cents")
        .eq("club_id", clubId)
        .in("id", chunkIds)
        .order("id", { ascending: true })
        .range(offset, offset + limit - 1);
      return { data: result.data, error: result.error };
    });
    if (targetError) {
      // Financial export data must never ship a guessed reversal amount
      // from a partially-failed lookup (Issue 3) — abort the whole export.
      console.error("[export] payment activity reversal-target read failed", { club_id: clubId, message: targetError });
      return { error: ERROR_MESSAGES.load_failed };
    }
    for (const t of targetRows) targetEventById.set(t.id, { eventType: t.event_type, amountCents: t.amount_cents });
  }

  // Completeness pass — the latest effective reverse_payment_event
  // definition (migration 0151, see Issue 6 of the prior correction round)
  // guarantees a legal reversal always points to an existing, permitted
  // target event. The lookup above just succeeded (query-error case
  // already returned above), so EVERY reverses_event_id referenced by an
  // exported reverse_payment_event row MUST now be present in
  // targetEventById. If one is absent despite the read having succeeded,
  // that is a genuine export-integrity problem (e.g. the target event
  // fell outside this tenant's own club_id scope, or unexpected data
  // drift) — FAIL the whole export rather than silently ship a reversal
  // with a blank/fabricated Amount.
  for (const event of rawEvents) {
    if (event.event_type === "reverse_payment_event" && event.reverses_event_id
        && !targetEventById.has(event.reverses_event_id)) {
      console.error("[export] payment activity: reversal target unresolved for an exported reversal event", {
        club_id: clubId, event_id: event.id, reverses_event_id: event.reverses_event_id,
      });
      return { error: ERROR_MESSAGES.load_failed };
    }
  }

  // Domain hydration for each event's PARENT payment (§21 — batched,
  // chunked + exhaustive, Issue 3). A reversal's target lives on the SAME
  // payment as the reversal itself, so no separate domain lookup is
  // needed for targets.
  const paymentIds = [...new Set(rawEvents.map(e => e.payment_id))];
  const { rows: paymentRows, error: paymentsLookupError } = await fetchRowsByIdsExhaustively<{
    id: string; domain_type: ExportDomainType; domain_id: string; roster_member_id: string | null; currency: string;
  }>(paymentIds, async (chunkIds, offset, limit) => {
    const result = await supabase
      .from("payments")
      .select("id, domain_type, domain_id, roster_member_id, currency")
      .eq("club_id", clubId)
      .in("id", chunkIds)
      .order("id", { ascending: true })
      .range(offset, offset + limit - 1);
    return { data: result.data, error: result.error };
  });
  if (paymentsLookupError) {
    console.error("[export] payment activity parent-payment read failed", { club_id: clubId, message: paymentsLookupError });
    return { error: ERROR_MESSAGES.load_failed };
  }
  const paymentById = new Map(paymentRows.map(p => [p.id, p]));

  const domainInputs: DomainHydrationInput[] = paymentRows.map(p => ({
    paymentId: p.id, domainType: p.domain_type, domainId: p.domain_id, rosterMemberId: p.roster_member_id,
  }));
  const domainContextResult = await hydrateExportDomainContext(supabase, domainInputs, clubTimezone);
  if (isHydrationFailure(domainContextResult)) {
    console.error("[export] payment activity domain hydration failed", { club_id: clubId, message: domainContextResult.error });
    return { error: ERROR_MESSAGES.load_failed };
  }
  const domainContextByPaymentId = domainContextResult;

  // Batched, chunked + exhaustive actor-name resolution (Issue 3) — an
  // "All activity" export can plausibly reference well over 1000 distinct
  // staff actors across its history.
  const actorIds = [...new Set(rawEvents.map(e => e.actor_id).filter((id): id is string => id !== null))];
  const actorNameById = new Map<string, string>();
  if (actorIds.length > 0) {
    const { rows: actors, error: actorsError } = await fetchRowsByIdsExhaustively<{
      id: string; first_name: string | null; last_name: string | null;
    }>(actorIds, async (chunkIds, offset, limit) => {
      const result = await supabase
        .from("profiles")
        .select("id, first_name, last_name")
        .in("id", chunkIds)
        .order("id", { ascending: true })
        .range(offset, offset + limit - 1);
      return { data: result.data, error: result.error };
    });
    if (actorsError) {
      console.error("[export] payment activity actor lookup failed", { club_id: clubId, message: actorsError });
      return { error: ERROR_MESSAGES.load_failed };
    }
    for (const a of actors) {
      actorNameById.set(a.id, [a.first_name, a.last_name].filter(Boolean).join(" ") || "Staff");
    }
  }

  const rows = [];
  for (const event of rawEvents) {
    const payment = paymentById.get(event.payment_id);
    // Completeness pass — a financial export must never silently drop a
    // row from PAYMENT_ACTIVITY_EVENT_TYPES' canonical query result. Once
    // an event has passed that query, its parent payment and required
    // domain context are NOT optional (unlike an actor/profile display
    // name, which may legitimately stay blank) — either missing is a
    // fail-closed export-integrity failure, never a `continue`.
    if (!payment) {
      console.error("[export] payment activity: parent payment missing for a selected money-movement event", {
        club_id: clubId, event_id: event.id, payment_id: event.payment_id,
      });
      return { error: ERROR_MESSAGES.load_failed };
    }
    const domainContext = domainContextByPaymentId.get(event.payment_id);
    if (!domainContext) {
      console.error("[export] payment activity: required domain context missing for a selected money-movement event", {
        club_id: clubId, event_id: event.id, payment_id: event.payment_id,
      });
      return { error: ERROR_MESSAGES.load_failed };
    }

    const target = event.reverses_event_id ? targetEventById.get(event.reverses_event_id) ?? null : null;
    const signedAmountCents = signedAmountCentsForEvent(event.event_type, event.amount_cents, target);
    // Completeness pass — a canonical money-movement row (one of the 5
    // PAYMENT_ACTIVITY_EVENT_TYPES) must always resolve a signed amount.
    // signedAmountCentsForEvent stays a defensive PURE helper that may
    // return null (e.g. an unresolved reversal target, already caught
    // above for that specific case) — but the Server Action itself must
    // never ship a blank Amount cell for an included row; this is the
    // general safety net against any other unexpected schema/data drift.
    if (signedAmountCents === null) {
      console.error("[export] payment activity: unresolved signed amount for a selected money-movement event", {
        club_id: clubId, event_id: event.id, event_type: event.event_type,
      });
      return { error: ERROR_MESSAGES.load_failed };
    }

    rows.push(buildPaymentActivityRow({
      occurredAtISO: event.occurred_at,
      identityName: domainContext.identityName,
      title: domainContext.title,
      domainTypeLabel: domainContext.domainTypeLabel,
      eventType: event.event_type,
      signedAmountCents,
      currency: payment.currency,
      method: event.method,
      actorName: event.actor_id ? actorNameById.get(event.actor_id) ?? null : null,
      externalReference: event.external_reference,
      notes: event.notes,
      paymentId: event.payment_id,
      clubTimezone,
    }));
  }

  return { csv: serializeCsv(PAYMENT_ACTIVITY_COLUMNS, rows), filename };
}
