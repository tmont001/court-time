// Phase 34G-C1 — pure payment-provenance derivation helpers. Canonical
// provenance is payment_events.event_type + payment_events.method — NEVER
// payments.payment_mode_at_creation, which is only a frozen snapshot of
// the club's configured mode at obligation-creation time and says nothing
// about how money was actually, eventually collected (a payment created
// while Court Time Payments was enabled can still be resolved manually,
// and vice versa is structurally impossible but the reverse assumption —
// "mode at creation proves collection method" — is exactly the false
// inference this module exists to prevent). Deliberately zero imports
// beyond the shared method-label list (mirrors src/lib/paymentModeToggle.ts's
// own "pure, no side effects, independently testable" convention) so this
// stays trivially reusable by 34G-C2's CSV exports without pulling in any
// Supabase/React dependency.

import { PAYMENT_METHOD_OPTIONS } from "@/lib/payments";

const METHOD_LABEL = new Map(PAYMENT_METHOD_OPTIONS.map(o => [o.value, o.label]));

function methodLabel(method: string): string {
  return METHOD_LABEL.get(method) ?? method;
}

// The only two event_types that represent money actually being collected
// from a Member — the set required for BOTH the per-event Financial
// History label (below) and the reversal-aware list summary. Refunds
// (refund_recorded/online_refund_recorded) are deliberately excluded: a
// refund never rewrites what channel originally collected the money (see
// deriveEffectiveCollectionSummary's own example G).
export const COLLECTION_EVENT_TYPES = new Set(["manual_payment_recorded", "online_payment_recorded"]);

// ─────────────────────────────────────────────────────────────────────────
// 1 — per-event Financial History label
// ─────────────────────────────────────────────────────────────────────────
// Returns null for every event_type that is not itself a money-collection
// or money-refund fact (obligation_created, obligation_amount_adjusted,
// waived, void_payment_obligation, reverse_payment_event) — these are
// never labeled Stripe or Manual, per the locked requirement. Refund
// events DO get a label (their own event-type label already says
// "refund" — this only adds the channel).
export function formatEventProvenanceLabel(eventType: string, method: string | null): string | null {
  switch (eventType) {
    case "online_payment_recorded":
    case "online_refund_recorded":
      return "Online · Stripe";
    case "manual_payment_recorded":
    case "refund_recorded":
      // refund_recorded's own CHECK constraint (0143/0153) does NOT
      // require method to be non-null (an offline refund can be recorded
      // without specifying how the cash was returned) — fall back to the
      // bare "Recorded manually" rather than fabricating a method.
      return method ? `Recorded manually · ${methodLabel(method)}` : "Recorded manually";
    default:
      return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 2 — reversal-aware list-row source summary
// ─────────────────────────────────────────────────────────────────────────
export interface ProvenanceLedgerEvent {
  id: string;
  eventType: string;
  method: string | null;
  reversesEventId: string | null;
  // Phase 34G-C2 — optional: only needed by callers that also want the
  // most recent effective collection event's own timestamp (Outstanding
  // Balances' "Last Payment Date" column, via
  // deriveLastEffectiveCollectionDate below). 34G-C1's own list-summary
  // caller never sets this — omitting it entirely is valid and harmless.
  occurredAt?: string;
}

// Takes ALL relevant ledger events for ONE payment (at minimum, every
// manual_payment_recorded/online_payment_recorded/reverse_payment_event
// row — extra event types are harmless to include, since only collection-
// type rows are ever inspected) and returns the reversal-aware "effective"
// collection-event subset — factored out of deriveEffectiveCollectionSummary
// (34G-C1) so any caller that needs more than the compact label (e.g.
// 34G-C2's Outstanding Balances export, which also needs the most recent
// effective event's own occurred_at) reuses the EXACT same reversal-
// exclusion logic rather than reimplementing it.
//
// A collection event (manual_payment_recorded/online_payment_recorded)
// that has been targeted by a valid reverse_payment_event (i.e. some OTHER
// event's reversesEventId points at it) is excluded entirely — it never
// contributes, exactly like a correction that undid a data-entry mistake.
// Refund events are not collection events at all and never appear in this
// set — a refund never rewrites what channel originally collected the
// money.
export function deriveEffectiveCollectionEvents(events: ProvenanceLedgerEvent[]): ProvenanceLedgerEvent[] {
  const reversedIds = new Set(
    events.map(e => e.reversesEventId).filter((id): id is string => id !== null),
  );
  return events.filter(e => COLLECTION_EVENT_TYPES.has(e.eventType) && !reversedIds.has(e.id));
}

// Returns null when there is no effective collection event at all — the
// caller must render no source badge rather than inventing provenance
// (e.g. from amount_paid_cents alone).
export function deriveEffectiveCollectionSummary(events: ProvenanceLedgerEvent[]): string | null {
  const effective = deriveEffectiveCollectionEvents(events);
  if (effective.length === 0) return null;

  const hasOnline = effective.some(e => e.eventType === "online_payment_recorded");
  const manualMethods = new Set(
    effective
      .filter(e => e.eventType === "manual_payment_recorded" && e.method)
      .map(e => e.method as string),
  );
  const hasManual = manualMethods.size > 0;

  if (hasOnline && hasManual) return "Mixed";
  if (hasOnline) return "Stripe";
  if (manualMethods.size === 1) return `Manual · ${methodLabel([...manualMethods][0])}`;
  return "Manual · Multiple";
}

// Phase 34G-C2 — the occurred_at of the most recent EFFECTIVE (non-
// reversed) collection event, for Outstanding Balances' "Last Payment
// Date" column. Reuses deriveEffectiveCollectionEvents exactly — never
// "latest event" naively. A refunded Stripe payment's original collection
// event is still effective (a refund doesn't reverse the collection event
// itself), so its date still counts here; a reversed collection event does
// not. Returns null when there is no effective collection event, or when
// none of them carry an occurredAt (caller omitted it) — never fabricated.
export function deriveLastEffectiveCollectionDate(events: ProvenanceLedgerEvent[]): string | null {
  const effective = deriveEffectiveCollectionEvents(events);
  const dates = effective.map(e => e.occurredAt).filter((d): d is string => !!d);
  if (dates.length === 0) return null;
  return dates.reduce((latest, d) => (d > latest ? d : latest));
}
