// Phase 34E-C — pure, side-effect-free Stripe dispute helpers. No secrets,
// no network I/O, no "server-only" guard — deliberately importable from
// tests and the webhook route alike, mirroring refundConfig.ts's own
// separation.
//
// INFORMATIONAL ONLY (locked scope): these helpers only decide what to
// DISPLAY on /admin/payments and whether the existing 34E-B Refund action
// should stay hidden when Stripe itself reports the underlying charge is
// no longer refundable. Nothing here submits evidence, accepts/closes a
// dispute, or changes payment/refund state.

// The five connected-account dispute lifecycle events relevant to Direct
// Charges (installed SDK, Events.d.ts Event.Type union). A club's Full
// Stripe Dashboard access means Court Time never needs to handle
// evidence/response events — it only ever observes state.
export const SUPPORTED_DISPUTE_WEBHOOK_EVENT_TYPES = [
  "charge.dispute.created",
  "charge.dispute.updated",
  "charge.dispute.closed",
  "charge.dispute.funds_withdrawn",
  "charge.dispute.funds_reinstated",
] as const;

export type SupportedDisputeWebhookEventType = (typeof SUPPORTED_DISPUTE_WEBHOOK_EVENT_TYPES)[number];

export function isSupportedDisputeWebhookEventType(type: string): type is SupportedDisputeWebhookEventType {
  return (SUPPORTED_DISPUTE_WEBHOOK_EVENT_TYPES as readonly string[]).includes(type);
}

export type DisputeTone = "urgent" | "in_progress" | "positive" | "negative" | "warning" | "generic";

export interface DisputeStatusPresentation {
  label: string;
  tone: DisputeTone;
}

// Stripe's own currently-documented Dispute.status values (installed SDK,
// Disputes.d.ts: `... | OtherString`) mapped to a friendly label + tone.
// Deliberately NOT exhaustive-by-construction — any value outside this
// map (a status Stripe adds in the future) falls through to a safe
// generic "Disputed" label rather than breaking rendering, mirroring why
// 0156's own `status` column carries no CHECK constraint either.
const KNOWN_DISPUTE_STATUS_PRESENTATION: Record<string, DisputeStatusPresentation> = {
  needs_response: { label: "Needs Response", tone: "urgent" },
  under_review: { label: "Under Review", tone: "in_progress" },
  won: { label: "Won", tone: "positive" },
  lost: { label: "Lost", tone: "negative" },
  warning_needs_response: { label: "Early Warning · Needs Response", tone: "warning" },
  warning_under_review: { label: "Early Warning · Under Review", tone: "warning" },
  warning_closed: { label: "Early Warning · Closed", tone: "warning" },
  prevented: { label: "Prevented", tone: "positive" },
};

export function presentDisputeStatus(status: string): DisputeStatusPresentation {
  return KNOWN_DISPUTE_STATUS_PRESENTATION[status] ?? { label: "Disputed", tone: "generic" };
}

// Deliberately reuses this codebase's existing red/amber/blue/green/gray
// palette (see PaymentStateBadge's own toneClassName in src/lib/
// payments.ts) rather than extending that shared, Member-visible type —
// this stays entirely local to the Admin-only dispute surface. No new
// visual system; broad payment-status polish is 34G-C.
export function disputeToneClassName(tone: DisputeTone): string {
  switch (tone) {
    case "urgent":
    case "negative":
      return "text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800";
    case "in_progress":
      return "text-blue-700 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800";
    case "positive":
      return "text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800";
    case "warning":
      return "text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800";
    case "generic":
    default:
      return "text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700";
  }
}

// A raw Stripe dispute `reason` value, lightly humanized for display —
// safe for any current or future value (underscore -> space +
// capitalization only, never a lookup table that could go stale the way
// a status/reason enum would).
export function formatDisputeReason(reason: string): string {
  return reason
    .split("_")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

// Mirrors 0156's own is_charge_refundable passthrough — used ONLY to
// decide whether the Admin-facing Refund action (34E-B) should render at
// all. The actual money-relevant step (refund creation) never trusts this
// as authority; Stripe's own refunds.create() call remains authoritative
// for any race after page render, exactly like isOnlineRefundEligible's
// own established discipline (refundConfig.ts).
export function isRefundBlockedByDispute(
  disputes: { isChargeRefundable: boolean }[] | null | undefined,
): boolean {
  if (!disputes || disputes.length === 0) return false;
  return disputes.some((d) => !d.isChargeRefundable);
}
