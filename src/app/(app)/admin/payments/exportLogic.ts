// Phase 34G-C2 — pure, side-effect-free business logic for the Payments
// CSV exports (Outstanding Balances + Payment Activity). Deliberately zero
// Supabase/Next imports so every rule here (club-local date-range
// conversion, signed money-movement amounts, per-event provenance/
// attribution, row/column assembly) is unit-testable with real function
// calls — mirrors src/lib/paymentProvenance.ts's own "pure lib, Server
// Action orchestrates the fetching" split.

import { localDateTimeToUTC, nextCalendarDay } from "@/lib/timezone";
import { formatEventProvenanceLabel } from "@/lib/paymentProvenance";
import { formatPaymentEventLabel } from "@/lib/payments";
import { centsToDecimalString, type CsvColumn } from "@/lib/csv";

// ─────────────────────────────────────────────────────────────────────────
// §9/§12 — club-local date range -> half-open UTC occurred_at bounds
// ─────────────────────────────────────────────────────────────────────────

export type ActivityDateRangeResult =
  | { ok: true; startUTC: string | null; endUTC: string | null }
  | { ok: false; error: string };

const DATE_STR_RE = /^\d{4}-\d{2}-\d{2}$/;

// Rejects malformed strings AND calendar-impossible dates (e.g. "2026-02-30")
// — Date.UTC silently normalizes overflow (Feb 30 -> Mar 2), so this checks
// the round-trip explicitly rather than trusting Date.UTC's own leniency.
function isValidCalendarDateStr(s: string): boolean {
  if (!DATE_STR_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1) return false;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= daysInMonth;
}

// §9/Issue 4 — FAILS CLOSED. "All activity" applies no date filter at all
// ONLY when the caller explicitly set all === true. Any other request
// (all === false) REQUIRES both from and to to be present, well-formed
// "YYYY-MM-DD" strings, calendar-valid, and from <= to — a missing or
// malformed value is never silently reinterpreted as "All activity" or as
// some other default window. String comparison is valid here since both
// are "YYYY-MM-DD" (lexicographic order matches calendar order).
export function resolveActivityDateRangeUTC(
  params: { all: boolean; from: string | null; to: string | null },
  clubTimezone: string,
): ActivityDateRangeResult {
  if (params.all) return { ok: true, startUTC: null, endUTC: null };

  if (!params.from || !params.to) {
    return { ok: false, error: "Choose both a From and To date, or check All activity." };
  }
  if (!isValidCalendarDateStr(params.from) || !isValidCalendarDateStr(params.to)) {
    return { ok: false, error: "Enter valid calendar dates." };
  }
  if (params.from > params.to) {
    return { ok: false, error: "The From date must be on or before the To date." };
  }

  const startUTC = localDateTimeToUTC(params.from, 0, 0, clubTimezone).toISOString();
  const endUTC = localDateTimeToUTC(nextCalendarDay(params.to), 0, 0, clubTimezone).toISOString();
  return { ok: true, startUTC, endUTC };
}

// Current-month default, in club-local time — "YYYY-MM-01" through today's
// own club-local calendar date (inclusive). `nowUTC` is injectable for
// deterministic tests; defaults to the real current instant.
export function defaultCurrentMonthRange(
  clubTimezone: string,
  nowUTC: Date = new Date(),
): { from: string; to: string } {
  const todayStr = nowUTC.toLocaleDateString("en-CA", { timeZone: clubTimezone }); // "YYYY-MM-DD"
  const [y, m] = todayStr.split("-");
  return { from: `${y}-${m}-01`, to: todayStr };
}

// ─────────────────────────────────────────────────────────────────────────
// §10 — Payment Activity event inclusion set
// ─────────────────────────────────────────────────────────────────────────

// Money-movement event types only — obligation_created/obligation_amount_
// adjusted/waived/void_payment_obligation are deliberately excluded (they
// remain visible in-app via full Financial History, never exported here).
export const PAYMENT_ACTIVITY_EVENT_TYPES = [
  "manual_payment_recorded",
  "online_payment_recorded",
  "refund_recorded",
  "online_refund_recorded",
  "reverse_payment_event",
] as const;

// ─────────────────────────────────────────────────────────────────────────
// §11/§12 — signed amount, summable, reversal-aware
// ─────────────────────────────────────────────────────────────────────────

// reverse_payment_event's own RPC only ever targets manual_payment_recorded
// or refund_recorded — confirmed by direct inspection of the LATEST
// effective definition (Issue 6 audit): originally created in migration
// 0143, then superseded by a `create or replace function` in migration
// 0151 (lines 454-506, adds one stale-Checkout-invalidation line; the
// target-type restriction itself — `if v_target.event_type not in
// ('manual_payment_recorded', 'refund_recorded') then raise exception
// 'event_type_not_reversible'` — is byte-identical to 0143 and unchanged
// by every migration after it, including 0153/0157/0164/0165). If a
// target event type outside this set is ever encountered (should be
// structurally impossible under the current schema), the reversal's
// amount is left unresolved (null) rather than guessed.
export function signedAmountCentsForEvent(
  eventType: string,
  amountCents: number | null,
  targetEvent?: { eventType: string; amountCents: number | null } | null,
): number | null {
  switch (eventType) {
    case "manual_payment_recorded":
    case "online_payment_recorded":
      return amountCents;
    case "refund_recorded":
    case "online_refund_recorded":
      return amountCents === null ? null : -amountCents;
    case "reverse_payment_event": {
      if (!targetEvent) return null; // target unresolved — never fabricate
      const targetSign = signedAmountCentsForEvent(targetEvent.eventType, targetEvent.amountCents);
      return targetSign === null ? null : -targetSign;
    }
    default:
      return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// §14/§15/§16 — per-event Source / Recorded By / External Reference
// ─────────────────────────────────────────────────────────────────────────

// A correction is not itself a new payment source — reverse_payment_event
// always renders a blank Source, never inheriting its target's label.
export function activitySourceLabel(eventType: string, method: string | null): string {
  if (eventType === "reverse_payment_event") return "";
  return formatEventProvenanceLabel(eventType, method) ?? "";
}

// Scoped exactly per event_type (mirrors PaymentDetailSheet's own 34G-C1
// corrected attribution logic) — online events never attribute to a human
// actor, even if actorName happens to be non-null.
export function activityRecordedByLabel(eventType: string, actorName: string | null): string {
  if (!actorName) return "";
  if (
    eventType === "manual_payment_recorded" ||
    eventType === "refund_recorded" ||
    eventType === "reverse_payment_event"
  ) {
    return actorName;
  }
  return "";
}

// Only manual collection/refund events ever surface their human-entered
// external_reference; online events' external_reference holds a raw
// Stripe Checkout Session/Refund id, which must never be exported.
export function activityExternalReference(eventType: string, externalReference: string | null): string {
  if (eventType === "manual_payment_recorded" || eventType === "refund_recorded") {
    return externalReference ?? "";
  }
  return "";
}

// ─────────────────────────────────────────────────────────────────────────
// Shared date formatting for CSV cells
// ─────────────────────────────────────────────────────────────────────────

// Stable, club-timezone-based "YYYY-MM-DD HH:mm" — never browser-locale-
// dependent, never a 23:59:59 hack. Blank for a null timestamp (never
// invented).
export function formatClubLocalDateTime(iso: string | null, timezone: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  const datePart = d.toLocaleDateString("en-CA", { timeZone: timezone }); // YYYY-MM-DD
  const timePart = d.toLocaleTimeString("en-GB", {
    timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  return `${datePart} ${timePart}`;
}

// ─────────────────────────────────────────────────────────────────────────
// §2/§3/§4 — Outstanding Balances row
// ─────────────────────────────────────────────────────────────────────────

const PAYMENT_STATUS_LABEL: Record<string, string> = {
  unpaid: "Unpaid",
  partially_paid: "Partially paid",
};

// Defensive re-check of §2's exact filter, independent of whatever the
// caller's own query filter already applied — never trusts status alone.
export function isGenuinelyOutstanding(status: string, dueCents: number, paidCents: number): boolean {
  return (status === "unpaid" || status === "partially_paid") && Math.max(dueCents - paidCents, 0) > 0;
}

// Issue 1 correction — the LOCKED order: pick the TRUE latest
// obligation_cycle per (domain_type, domain_id) FIRST, from the FULL
// unfiltered set of a domain's payment rows, THEN evaluate whether THAT
// latest cycle is genuinely outstanding. A superseded (non-latest) cycle
// is NEVER individually evaluated — even a cycle 1 that was itself unpaid
// is correctly excluded once a later cycle 2 exists, regardless of cycle
// 2's own status (paid, waived, void, refunded, or still outstanding).
// The caller must pass EVERY payment row for the relevant domains (not
// pre-filtered by status) — filtering by status before this function runs
// is exactly the bug this corrects.
export interface CycleSelectionInput {
  domainType: string;
  domainId: string;
  obligationCycle: number;
  status: string;
  amountDueCents: number;
  amountPaidCents: number;
}

export function selectLatestGenuinelyOutstandingPayments<T extends CycleSelectionInput>(payments: T[]): T[] {
  const latestByDomain = new Map<string, T>();
  for (const p of payments) {
    const key = `${p.domainType}:${p.domainId}`;
    const existing = latestByDomain.get(key);
    if (!existing || p.obligationCycle > existing.obligationCycle) {
      latestByDomain.set(key, p);
    }
  }
  return [...latestByDomain.values()].filter(p =>
    isGenuinelyOutstanding(p.status, p.amountDueCents, p.amountPaidCents),
  );
}

export interface OutstandingBalanceRowInput {
  identityName: string;
  title: string;
  domainTypeLabel: string;
  serviceDateTime: string; // already formatted by the caller (handles the date-only Program case)
  lifecycleLabel: string | null;
  status: string;
  amountDueCents: number;
  amountPaidCents: number;
  currency: string;
  sourceSummary: string | null;
  lastPaymentDateISO: string | null;
  clubTimezone: string;
  paymentId: string;
}

export interface OutstandingBalanceRow {
  memberParticipant: string;
  paymentFor: string;
  domainType: string;
  serviceDateTime: string;
  lifecycleStatus: string;
  paymentStatus: string;
  amountDue: string;
  amountPaid: string;
  remainingBalance: string;
  currency: string;
  paymentSource: string;
  lastPaymentDate: string;
  paymentId: string;
}

export function buildOutstandingBalanceRow(input: OutstandingBalanceRowInput): OutstandingBalanceRow {
  const remaining = Math.max(input.amountDueCents - input.amountPaidCents, 0);
  return {
    memberParticipant: input.identityName,
    paymentFor: input.title,
    domainType: input.domainTypeLabel,
    serviceDateTime: input.serviceDateTime,
    lifecycleStatus: input.lifecycleLabel ?? "",
    paymentStatus: PAYMENT_STATUS_LABEL[input.status] ?? input.status,
    amountDue: centsToDecimalString(input.amountDueCents),
    amountPaid: centsToDecimalString(input.amountPaidCents),
    remainingBalance: centsToDecimalString(remaining),
    currency: input.currency,
    paymentSource: input.sourceSummary ?? "",
    lastPaymentDate: formatClubLocalDateTime(input.lastPaymentDateISO, input.clubTimezone),
    paymentId: input.paymentId,
  };
}

// Locked column order (§3). Money columns + Currency + Last Payment Date +
// Payment ID are trusted/system-generated (protect: false) so a genuine
// negative-looking or system value is never formula-neutralized; every
// other column is free text and stays protected by default.
export const OUTSTANDING_BALANCE_COLUMNS: CsvColumn<OutstandingBalanceRow>[] = [
  { header: "Member/Participant", value: r => r.memberParticipant },
  { header: "Payment For", value: r => r.paymentFor },
  { header: "Domain Type", value: r => r.domainType },
  { header: "Service Date/Time", value: r => r.serviceDateTime, protect: false },
  { header: "Lifecycle Status", value: r => r.lifecycleStatus },
  { header: "Payment Status", value: r => r.paymentStatus },
  { header: "Amount Due", value: r => r.amountDue, protect: false },
  { header: "Amount Paid", value: r => r.amountPaid, protect: false },
  { header: "Remaining Balance", value: r => r.remainingBalance, protect: false },
  { header: "Currency", value: r => r.currency, protect: false },
  { header: "Payment Source", value: r => r.paymentSource },
  { header: "Last Payment Date", value: r => r.lastPaymentDate, protect: false },
  { header: "Payment ID", value: r => r.paymentId, protect: false },
];

// ─────────────────────────────────────────────────────────────────────────
// §11/§13/§14-17 — Payment Activity row
// ─────────────────────────────────────────────────────────────────────────

export interface PaymentActivityRowInput {
  occurredAtISO: string;
  identityName: string;
  title: string;
  domainTypeLabel: string;
  eventType: string;
  signedAmountCents: number | null;
  currency: string;
  method: string | null;
  actorName: string | null;
  externalReference: string | null;
  notes: string | null;
  paymentId: string;
  clubTimezone: string;
}

export interface PaymentActivityRow {
  activityDateTime: string;
  memberParticipant: string;
  paymentFor: string;
  domainType: string;
  activityType: string;
  amount: string;
  currency: string;
  source: string;
  recordedBy: string;
  externalReference: string;
  notes: string;
  paymentId: string;
}

export function buildPaymentActivityRow(input: PaymentActivityRowInput): PaymentActivityRow {
  return {
    activityDateTime: formatClubLocalDateTime(input.occurredAtISO, input.clubTimezone),
    memberParticipant: input.identityName,
    paymentFor: input.title,
    domainType: input.domainTypeLabel,
    activityType: formatPaymentEventLabel(input.eventType),
    amount: centsToDecimalString(input.signedAmountCents),
    currency: input.currency,
    source: activitySourceLabel(input.eventType, input.method),
    recordedBy: activityRecordedByLabel(input.eventType, input.actorName),
    externalReference: activityExternalReference(input.eventType, input.externalReference),
    notes: input.notes ?? "",
    paymentId: input.paymentId,
  };
}

// Locked column order (§13).
export const PAYMENT_ACTIVITY_COLUMNS: CsvColumn<PaymentActivityRow>[] = [
  { header: "Activity Date/Time", value: r => r.activityDateTime, protect: false },
  { header: "Member/Participant", value: r => r.memberParticipant },
  { header: "Payment For", value: r => r.paymentFor },
  { header: "Domain Type", value: r => r.domainType },
  { header: "Activity Type", value: r => r.activityType },
  { header: "Amount", value: r => r.amount, protect: false },
  { header: "Currency", value: r => r.currency, protect: false },
  { header: "Source", value: r => r.source },
  { header: "Recorded By", value: r => r.recordedBy },
  { header: "External Reference", value: r => r.externalReference },
  { header: "Notes", value: r => r.notes },
  { header: "Payment ID", value: r => r.paymentId, protect: false },
];

// ─────────────────────────────────────────────────────────────────────────
// §24 — filenames
// ─────────────────────────────────────────────────────────────────────────

export function outstandingBalancesFilename(clubSlug: string, todayStr: string): string {
  return `court-time-outstanding-balances-${clubSlug}-${todayStr}.csv`;
}

// Issue 4 correction — ONLY all === true ever produces the "-all.csv"
// filename. This must only ever be called with already-VALIDATED params
// (i.e. after resolveActivityDateRangeUTC has returned ok: true) — by that
// point, `all === false` guarantees from/to are both present and valid.
export function paymentActivityFilename(
  clubSlug: string,
  range: { all: boolean; from: string | null; to: string | null },
): string {
  if (range.all) return `court-time-payment-activity-${clubSlug}-all.csv`;
  return `court-time-payment-activity-${clubSlug}-${range.from}-to-${range.to}.csv`;
}
