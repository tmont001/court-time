import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getAuthUser, getAuthProfile } from "@/lib/supabase/user";
import { isOperator, isAdmin } from "@/lib/auth/roles";
import Header from "@/components/Header";
import AdminPaymentsClient, { type AdminPaymentRow } from "./AdminPaymentsClient";
import type { PaymentStateRow } from "@/lib/payments";
import {
  dateTimeRangeLabel,
  reservationLifecycleLabel,
  lessonRequestLifecycleLabel,
  eventParticipantLifecycleLabel,
  eventGuestLifecycleLabel,
  programEnrollmentLifecycleLabel,
  isReservationCollectible,
  isLessonRequestCollectible,
  isEventParticipantCollectible,
  isEventGuestCollectible,
  isProgramEnrollmentCollectible,
} from "./paymentContext";
import { deriveEffectiveCollectionSummary, type ProvenanceLedgerEvent } from "@/lib/paymentProvenance";
import { fetchAllRowsExhaustively } from "@/lib/supabase/exhaustiveRange";

// Phase 34C consolidation — the canonical Admin/Staff operational surface
// for "who owes money, for what, how much, and can I record a payment" —
// spanning all 5 payable domains. Deliberately NOT accounting/reporting:
// no revenue totals, no payment_events ledger viewer, current `payments`
// state only (the same rollup shape get_payment_states_for_domains reads
// from — this page just reads the table directly, which payments_select_
// admin_staff (0143) already permits for Admin/Staff, so no new RPC or
// migration is needed). Admin+Staff only, never Pro.

const MAX_ROWS = 500;

type DomainType = AdminPaymentRow["domainType"];

export default async function AdminPaymentsPage() {
  const user = await getAuthUser();
  if (!user) redirect("/sign-in");

  const profile = await getAuthProfile();
  if (!profile || !isOperator(profile.role)) redirect("/calendar");

  // G-D1 QA correction — Refund is intentionally Admin-only (the server-
  // side guard in refundActions.ts is unchanged and remains the real
  // authorization boundary); this is UI-only visibility so Staff, who
  // pass the isOperator gate above but are not Admin, are never shown an
  // action they cannot perform. Reuses the SAME isAdmin(role) predicate
  // the rest of the app already uses for Admin-only authority — never a
  // duplicate/parallel authorization mechanism.
  const isAdminRole = isAdmin(profile.role);

  const clubId = profile.club_id ?? "";
  const supabase = await createClient();

  const [clubResult, settingsResult, paymentsResult] = await Promise.all([
    clubId ? supabase.from("clubs").select("timezone").eq("id", clubId).single() : Promise.resolve({ data: null }),
    clubId ? supabase.from("club_settings").select("currency").eq("club_id", clubId).single() : Promise.resolve({ data: null }),
    clubId
      ? supabase
          .from("payments")
          .select("id, domain_type, domain_id, obligation_cycle, roster_member_id, amount_due_cents, amount_paid_cents, currency, status, updated_at")
          .eq("club_id", clubId)
          .order("updated_at", { ascending: false })
          .limit(MAX_ROWS)
      : Promise.resolve({ data: [] }),
  ]);

  const clubTimezone = (clubResult as { data: { timezone: string } | null })?.data?.timezone ?? "America/New_York";
  const currency     = (settingsResult as { data: { currency: string } | null })?.data?.currency ?? "USD";

  // Latest obligation cycle per (domain_type, domain_id) only — a domain
  // with multiple historical cycles must never show a superseded one as
  // if it were current. The most recently updated_at row for a given
  // domain is, in practice, always its highest cycle (a new cycle is only
  // ever created after the prior one resolved), so this bounded,
  // recency-ordered fetch never silently drops a domain's true latest row.
  type RawPaymentRow = {
    id: string;
    domain_type: DomainType;
    domain_id: string;
    obligation_cycle: number;
    roster_member_id: string | null;
    amount_due_cents: number;
    amount_paid_cents: number;
    currency: string;
    status: PaymentStateRow["current_status"];
    updated_at: string;
  };
  const rawPayments = (paymentsResult.data ?? []) as RawPaymentRow[];
  // G-D1 — a full page (exactly MAX_ROWS rows returned) means the query
  // may have truncated older payments; a short page means it definitely
  // did not. This is the same "full page implies maybe more" heuristic
  // fetchAllRowsExhaustively already uses, applied here only to decide
  // whether to show an informational notice — this page's own cap is
  // intentionally unchanged (§9 of the correction spec), and the CSV
  // exports remain the exhaustive, uncapped source of complete data.
  const truncated = rawPayments.length === MAX_ROWS;
  const latestByDomain = new Map<string, RawPaymentRow>();
  for (const p of rawPayments) {
    const key = `${p.domain_type}:${p.domain_id}`;
    const existing = latestByDomain.get(key);
    if (!existing || p.obligation_cycle > existing.obligation_cycle) {
      latestByDomain.set(key, p);
    }
  }
  const latestPayments = [...latestByDomain.values()];

  const idsByDomain: Record<DomainType, string[]> = {
    reservation: [], lesson_request: [], event_participant: [], event_guest: [], program_enrollment: [],
  };
  const rosterMemberIds = new Set<string>();
  for (const p of latestPayments) {
    idsByDomain[p.domain_type].push(p.domain_id);
    if (p.roster_member_id) rosterMemberIds.add(p.roster_member_id);
  }

  const [
    reservationsResult,
    lessonRequestsResult,
    eventParticipantsResult,
    eventGuestsResult,
    programEnrollmentsResult,
    rosterMembersResult,
  ] = await Promise.all([
    idsByDomain.reservation.length > 0
      ? supabase.from("reservations").select("id, court_id, starts_at, ends_at, status").in("id", idsByDomain.reservation)
      : Promise.resolve({ data: [] }),
    idsByDomain.lesson_request.length > 0
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ? (supabase.from as any)("lesson_requests").select("id, pro_id, proposed_starts_at, proposed_ends_at, status").in("id", idsByDomain.lesson_request)
      : Promise.resolve({ data: [] }),
    idsByDomain.event_participant.length > 0
      ? supabase.from("event_participants").select("id, event_id, status").in("id", idsByDomain.event_participant)
      : Promise.resolve({ data: [] }),
    idsByDomain.event_guest.length > 0
      ? supabase.from("event_guests").select("id, event_id, display_name").in("id", idsByDomain.event_guest)
      : Promise.resolve({ data: [] }),
    idsByDomain.program_enrollment.length > 0
      ? supabase.from("program_enrollments").select("id, program_id, status").in("id", idsByDomain.program_enrollment)
      : Promise.resolve({ data: [] }),
    rosterMemberIds.size > 0
      ? supabase.from("roster_members").select("id, first_name, last_name").in("id", [...rosterMemberIds])
      : Promise.resolve({ data: [] }),
  ]);

  const reservations = (reservationsResult.data ?? []) as { id: string; court_id: string; starts_at: string; ends_at: string; status: string }[];
  const lessonRequests = (lessonRequestsResult.data ?? []) as { id: string; pro_id: string; proposed_starts_at: string | null; proposed_ends_at: string | null; status: string }[];
  const eventParticipants = (eventParticipantsResult.data ?? []) as { id: string; event_id: string; status: string }[];
  const eventGuests = (eventGuestsResult.data ?? []) as { id: string; event_id: string; display_name: string }[];
  const programEnrollments = (programEnrollmentsResult.data ?? []) as { id: string; program_id: string; status: string }[];
  const rosterMembers = (rosterMembersResult.data ?? []) as { id: string; first_name: string; last_name: string }[];

  const courtIds  = [...new Set(reservations.map(r => r.court_id))];
  const proIds    = [...new Set(lessonRequests.map(r => r.pro_id))];
  const eventIds  = [...new Set([...eventParticipants.map(p => p.event_id), ...eventGuests.map(g => g.event_id)])];
  const programIds = [...new Set(programEnrollments.map(e => e.program_id))];

  const [courtsResult, prosResult, eventsResult, programsResult] = await Promise.all([
    courtIds.length > 0 ? supabase.from("courts").select("id, name").in("id", courtIds) : Promise.resolve({ data: [] }),
    proIds.length > 0 ? supabase.from("profiles").select("id, first_name, last_name").in("id", proIds) : Promise.resolve({ data: [] }),
    eventIds.length > 0 ? supabase.from("events").select("id, title, starts_at, ends_at, status").in("id", eventIds) : Promise.resolve({ data: [] }),
    programIds.length > 0 ? supabase.from("programs").select("id, title, starts_on, status").in("id", programIds) : Promise.resolve({ data: [] }),
  ]);

  const courtName    = new Map((courtsResult.data ?? []).map((c: { id: string; name: string }) => [c.id, c.name]));
  const proName       = new Map((prosResult.data ?? []).map((p: { id: string; first_name: string | null; last_name: string | null }) =>
    [p.id, [p.first_name, p.last_name].filter(Boolean).join(" ") || "Pro"]));
  const eventById     = new Map((eventsResult.data ?? []).map((e: { id: string; title: string; starts_at: string; ends_at: string; status: string }) => [e.id, e]));
  const programById   = new Map((programsResult.data ?? []).map((p: { id: string; title: string; starts_on: string; status: string }) => [p.id, p]));
  const rosterName    = new Map(rosterMembers.map(m => [m.id, [m.first_name, m.last_name].filter(Boolean).join(" ") || "Unknown"]));
  const reservationById       = new Map(reservations.map(r => [r.id, r]));
  const lessonRequestById     = new Map(lessonRequests.map(r => [r.id, r]));
  const eventParticipantById  = new Map(eventParticipants.map(p => [p.id, p]));
  const eventGuestById        = new Map(eventGuests.map(g => [g.id, g]));
  const programEnrollmentById = new Map(programEnrollments.map(e => [e.id, e]));

  // Phase 34E-B — the one sanctioned read path for "how much online
  // money is still Stripe-refundable" (payment_checkout_attempts and
  // payment_refund_attempts are both deny-all RLS; this batched RPC is
  // the only way to learn this without a raw table read this page could
  // never actually perform).
  const paymentIds = latestPayments.map(p => p.id);
  const refundableResult = paymentIds.length > 0
    ? await supabase.rpc("get_online_refundable_amount_for_payments", { p_payment_ids: paymentIds })
    : { data: [] as { payment_id: string; refundable_cents: number; currency: string }[] };
  // Runtime QA (0154) — a failure here must never vanish without a trace
  // the way it did before: falling back to "0 refundable everywhere" is
  // still the correct, fail-safe Admin-facing behavior (never show a
  // Refund button when eligibility can't be confirmed), but it must be
  // logged server-side so a real infrastructure failure stays observable.
  // Safe fields only — payment ids (internal UUIDs, not PII) plus error
  // code/message, never secrets/JWTs.
  const refundableError = (refundableResult as { error?: { code?: string; message?: string } }).error;
  if (refundableError) {
    console.error("[refund] get_online_refundable_amount_for_payments failed", {
      payment_ids: paymentIds,
      code: refundableError.code ?? null,
      message: refundableError.message ?? null,
    });
  }
  const refundableByPaymentId = new Map(
    (refundableResult.data ?? []).map(r => [r.payment_id, r.refundable_cents]),
  );

  // Phase 34E-C — informational Stripe dispute state. Unlike payment_
  // checkout_attempts/payment_refund_attempts, payment_disputes has a
  // normal club-scoped Admin/Staff SELECT policy (mirrors payments' own
  // payments_select_admin_staff, 0143) — a plain read, no RPC needed.
  const disputesResult = paymentIds.length > 0
    ? await supabase
        .from("payment_disputes")
        .select("payment_id, status, reason, amount_cents, currency, evidence_due_by, is_charge_refundable, stripe_created_at")
        .eq("club_id", clubId)
        .in("payment_id", paymentIds)
    : {
        data: [] as {
          payment_id: string; status: string; reason: string; amount_cents: number; currency: string;
          evidence_due_by: string | null; is_charge_refundable: boolean; stripe_created_at: string;
        }[],
      };
  const disputesError = (disputesResult as { error?: { code?: string; message?: string } }).error;
  if (disputesError) {
    console.error("[dispute] payment_disputes read failed", {
      payment_ids: paymentIds,
      code: disputesError.code ?? null,
      message: disputesError.message ?? null,
    });
  }
  // A payment can in principle carry more than one dispute row over time
  // (a charge disputed, resolved, then disputed again) — the UI shows
  // only the most recently created one; refund eligibility is blocked by
  // ANY of them still reporting is_charge_refundable = false.
  const disputesByPaymentId = new Map<string, NonNullable<typeof disputesResult.data>>();
  for (const d of disputesResult.data ?? []) {
    const existing = disputesByPaymentId.get(d.payment_id) ?? [];
    existing.push(d);
    disputesByPaymentId.set(d.payment_id, existing);
  }

  // Phase 34G-C1 — reversal-aware compact source summary ("Stripe" /
  // "Manual · Cash" / "Manual · Multiple" / "Mixed" / no badge). Bulk-
  // fetched for every displayed payment in ONE tenant-scoped query,
  // exhaustively paginated (never a single unbounded .select() — up to
  // 500 payments can collectively carry well over 1000 relevant events).
  // Filtered to ONLY the three event_types that can affect this
  // computation (the two collection types plus reverse_payment_event,
  // which is the only event_type that can invalidate a collection event) —
  // refund events are irrelevant here by design (deriveEffectiveCollection
  // Summary's own example G: a refund never rewrites the original
  // collection channel), which also keeps this query's row volume down.
  // Same club_id-scoped, Admin/Staff-only read as every other query on
  // this page (payment_events_select_admin_staff, 0143) — no service-role
  // client, no new RPC, no migration.
  const sourceSummaryByPaymentId = new Map<string, string>();
  if (paymentIds.length > 0) {
    const { rows: provenanceEventRows, error: provenanceError } = await fetchAllRowsExhaustively<{
      id: string;
      payment_id: string;
      event_type: string;
      method: string | null;
      reverses_event_id: string | null;
    }>(async (offset, limit) => {
      const result = await supabase
        .from("payment_events")
        .select("id, payment_id, event_type, method, reverses_event_id")
        .eq("club_id", clubId)
        .in("payment_id", paymentIds)
        // Written as literal strings (not spread from COLLECTION_EVENT_TYPES)
        // so this stays a plain, readable filter list — COLLECTION_EVENT_TYPES
        // stays a plain Set<string> for the pure helper's own membership
        // checks, never reused here. The `as any` is a narrow, pre-existing-
        // pattern workaround (mirrors this same file's own lesson_requests
        // cast above): src/lib/db/types.ts's hand-maintained event_type
        // union predates migrations 0150/0153 and is missing
        // online_payment_recorded/online_refund_recorded, even though both
        // are valid values under payment_events' own CHECK constraint —
        // a generated-types staleness issue, not a runtime concern, and out
        // of scope to regenerate in this checkpoint.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .in("event_type", ["manual_payment_recorded", "online_payment_recorded", "reverse_payment_event"] as any)
        .range(offset, offset + limit - 1);
      return { data: result.data, error: result.error };
    });
    if (provenanceError) {
      // Fail-safe, matching the refundable/dispute queries' own pattern
      // immediately above — a failure here must never fabricate a source
      // label; it must simply leave the badge absent, logged server-side.
      console.error("[payment-provenance] bulk source-summary read failed", { message: provenanceError });
    } else {
      const eventsByPayment = new Map<string, ProvenanceLedgerEvent[]>();
      for (const r of provenanceEventRows) {
        const list = eventsByPayment.get(r.payment_id) ?? [];
        list.push({ id: r.id, eventType: r.event_type, method: r.method, reversesEventId: r.reverses_event_id });
        eventsByPayment.set(r.payment_id, list);
      }
      for (const [paymentId, events] of eventsByPayment) {
        const summary = deriveEffectiveCollectionSummary(events);
        if (summary) sourceSummaryByPaymentId.set(paymentId, summary);
      }
    }
  }

  const rows: AdminPaymentRow[] = [];
  for (const p of latestPayments) {
    let title: string | null = null;
    let identityName = "Unknown";
    let dateLabel: string | null = null;
    let href = "/calendar";
    // Phase 34E-E — the underlying domain's OWN lifecycle state, entirely
    // independent from the payment's financial status (locked invariant:
    // cancellation never mutates amount_paid_cents/status). Null when the
    // domain row is active or has no cancellation concept at all.
    let lifecycleLabel: string | null = null;
    // Runtime QA polish (34F-B), extended to Reservation/Lesson/Program
    // (34F-D) — true for a cancelled Reservation, a cancelled Lesson, a
    // cancelled parent Event (event_participant/event_guest below), or a
    // cancelled parent Program (program_enrollment below); withholds the
    // Record Payment action without touching any financial data (locked
    // cross-domain principle: domain cancellation suppresses NEW
    // collection actions, it never fabricates a refund/waiver/void or
    // mutates amount_due_cents/amount_paid_cents). Program is the one
    // domain where completion is explicitly NOT treated like cancellation:
    // a completed Program's debt remains legitimately collectible (the
    // service was delivered), so recordPaymentBlocked stays false there —
    // only status === 'cancelled' sets it true.
    let recordPaymentBlocked = false;

    if (p.domain_type === "reservation") {
      const r = reservationById.get(p.domain_id);
      if (!r) continue;
      title = courtName.get(r.court_id) as string | undefined ?? "Court Reservation";
      dateLabel = dateTimeRangeLabel(r.starts_at, r.ends_at, clubTimezone);
      identityName = p.roster_member_id ? rosterName.get(p.roster_member_id) ?? "Unknown" : "Unknown";
      href = "/calendar";
      lifecycleLabel = reservationLifecycleLabel(r.status);
      // 34F-D — a cancelled Reservation may still show a historical Unpaid/
      // Paid financial state, but must not invite a NEW collection action.
      // Refund (independent, gated elsewhere on refundableCents/dispute
      // state only) is entirely unaffected by this flag.
      recordPaymentBlocked = !isReservationCollectible(r.status);
    } else if (p.domain_type === "lesson_request") {
      const r = lessonRequestById.get(p.domain_id);
      if (!r) continue;
      title = `Lesson with ${proName.get(r.pro_id) as string | undefined ?? "Pro"}`;
      dateLabel = dateTimeRangeLabel(r.proposed_starts_at, r.proposed_ends_at, clubTimezone);
      identityName = p.roster_member_id ? rosterName.get(p.roster_member_id) ?? "Unknown" : "Unknown";
      href = "/admin/lessons";
      lifecycleLabel = lessonRequestLifecycleLabel(r.status);
      // 34F-D — same reasoning as Reservation above. declined/withdrawn
      // are pre-confirmation terminal states that can never have a payment
      // obligation in the first place (obligations are only ever created
      // once a lesson reaches 'confirmed') — cancelled is the only
      // post-obligation terminal status, so it is the only one checked
      // here.
      recordPaymentBlocked = !isLessonRequestCollectible(r.status);
    } else if (p.domain_type === "event_participant") {
      const r = eventParticipantById.get(p.domain_id);
      if (!r) continue;
      const ev = eventById.get(r.event_id) as { id: string; title: string; starts_at: string; ends_at: string; status: string } | undefined;
      title = ev?.title ?? "Event";
      // Runtime QA polish — full start/end time range (club timezone),
      // matching Reservation/Lesson's own dateTimeRangeLabel convention,
      // not just a bare date. A cancelled Event still shows its originally
      // scheduled time here — this is historical context, not a live
      // schedule, and starts_at/ends_at are never mutated by cancellation.
      dateLabel = ev ? dateTimeRangeLabel(ev.starts_at, ev.ends_at, clubTimezone) : null;
      identityName = p.roster_member_id ? rosterName.get(p.roster_member_id) ?? "Unknown" : "Unknown";
      href = "/calendar";
      // External review correction — the PARENT event's own status takes
      // precedence: cancel_event cancels the event without cancelling
      // individual (confirmed/waitlisted) participant rows, which are
      // intentionally preserved as historical.
      lifecycleLabel = eventParticipantLifecycleLabel(ev?.status, r.status);
      // Runtime QA polish — a cancelled parent Event must not encourage
      // staff to collect the original Event fee: Unpaid/Partially Paid
      // stays visible as historical financial truth (never waived/voided/
      // mutated merely because the Event was cancelled), but Record
      // Payment is withheld. Paid stays Paid and the existing Refund
      // action is untouched by this flag — it only ever gates Record
      // Payment eligibility, computed here (not via string-matching
      // lifecycleLabel) so it stays correct even if that label's copy
      // changes later.
      recordPaymentBlocked = !isEventParticipantCollectible(ev?.status, r.status);
    } else if (p.domain_type === "event_guest") {
      const r = eventGuestById.get(p.domain_id);
      if (!r) continue;
      const ev = eventById.get(r.event_id) as { id: string; title: string; starts_at: string; ends_at: string; status: string } | undefined;
      title = ev?.title ?? "Event";
      dateLabel = ev ? dateTimeRangeLabel(ev.starts_at, ev.ends_at, clubTimezone) : null;
      // Guest payer identity is intentionally unresolved to a roster
      // Member (see EventRosterSheet's own comment) — the guest's own
      // display_name is the correct identity here, not "Unknown".
      identityName = `${r.display_name} (Guest)`;
      href = "/calendar";
      // event_guests has no status/cancellation column of its own at all
      // (audited) — the ONLY lifecycle signal available is the parent
      // event's own status. Never invents a guest-specific status.
      lifecycleLabel = eventGuestLifecycleLabel(ev?.status);
      // Same reasoning as event_participant immediately above — a guest's
      // manual-mode payment (the only mode a guest can ever have, 0149)
      // must not encourage fee collection for a cancelled Event either.
      recordPaymentBlocked = !isEventGuestCollectible(ev?.status);
    } else {
      const r = programEnrollmentById.get(p.domain_id);
      if (!r) continue;
      const prog = programById.get(r.program_id) as { id: string; title: string; starts_on: string; status: string } | undefined;
      title = prog?.title ?? "Program";
      dateLabel = null;
      identityName = p.roster_member_id ? rosterName.get(p.roster_member_id) ?? "Unknown" : "Unknown";
      href = "/events?tab=manage";
      // External review correction — the PARENT program's own status
      // takes precedence: cancel_program cancels the program without
      // cancelling individual enrollment rows, which are intentionally
      // preserved (may remain enrolled/waitlisted/offered).
      lifecycleLabel = programEnrollmentLifecycleLabel(prog?.status, r.status);
      // 34F-D correction — Program cancellation must suppress NEW
      // collection actions exactly like Reservation/Lesson/Event above;
      // completion must NOT (the service was delivered and the debt
      // remains legitimately collectible — the same reason complete_
      // program itself carries no stale-Checkout guard, 34F-C). Keyed off
      // the PARENT Program's own status, never the enrollment child row's
      // own status (which is intentionally preserved through cancellation)
      // and never the payment's own financial status.
      recordPaymentBlocked = !isProgramEnrollmentCollectible(prog?.status, r.status);
    }

    const disputesForPayment = disputesByPaymentId.get(p.id) ?? [];
    const currentDispute = disputesForPayment.length > 0
      ? [...disputesForPayment].sort((a, b) => b.stripe_created_at.localeCompare(a.stripe_created_at))[0]
      : null;

    rows.push({
      key: p.id,
      domainType: p.domain_type,
      title,
      identityName,
      dateLabel,
      href,
      lifecycleLabel,
      recordPaymentBlocked,
      refundableCents: refundableByPaymentId.get(p.id) ?? 0,
      // Phase 34E-C — informational only; never derived from or fed back
      // into payments.amount_paid_cents/status.
      dispute: currentDispute && {
        status: currentDispute.status,
        reason: currentDispute.reason,
        amountCents: currentDispute.amount_cents,
        currency: currentDispute.currency,
        evidenceDueBy: currentDispute.evidence_due_by,
      },
      disputeBlocksRefund: disputesForPayment.some(d => !d.is_charge_refundable),
      // Phase 34G-C1 — see the bulk query above. Null when no effective
      // (non-reversed) collection event exists yet for this payment —
      // rendered as no badge, never a fabricated default.
      sourceSummary: sourceSummaryByPaymentId.get(p.id) ?? null,
      state: {
        domain_id: p.domain_id,
        current_payment_id: p.id,
        current_obligation_cycle: p.obligation_cycle,
        current_amount_due_cents: p.amount_due_cents,
        current_amount_paid_cents: p.amount_paid_cents,
        current_status: p.status,
        current_currency: p.currency,
        unresolved_prior: [],
      },
      sortKey: p.updated_at,
    });
  }
  rows.sort((a, b) => b.sortKey.localeCompare(a.sortKey));

  return (
    <>
      <Header screenTitle="Payments" />
      <div className="overflow-y-auto" style={{ height: "var(--page-fill-height)" }}>
        <div className="md:max-w-3xl md:mx-auto">
          <AdminPaymentsClient rows={rows} clubId={clubId} currency={currency} clubTimezone={clubTimezone} truncated={truncated} isAdmin={isAdminRole} />
        </div>
      </div>
    </>
  );
}
