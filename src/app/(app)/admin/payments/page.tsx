import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getAuthUser, getAuthProfile } from "@/lib/supabase/user";
import { isOperator } from "@/lib/auth/roles";
import Header from "@/components/Header";
import AdminPaymentsClient, { type AdminPaymentRow } from "./AdminPaymentsClient";
import type { PaymentStateRow } from "@/lib/payments";

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
      ? supabase.from("reservations").select("id, court_id, starts_at").in("id", idsByDomain.reservation)
      : Promise.resolve({ data: [] }),
    idsByDomain.lesson_request.length > 0
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ? (supabase.from as any)("lesson_requests").select("id, pro_id, proposed_starts_at").in("id", idsByDomain.lesson_request)
      : Promise.resolve({ data: [] }),
    idsByDomain.event_participant.length > 0
      ? supabase.from("event_participants").select("id, event_id").in("id", idsByDomain.event_participant)
      : Promise.resolve({ data: [] }),
    idsByDomain.event_guest.length > 0
      ? supabase.from("event_guests").select("id, event_id, display_name").in("id", idsByDomain.event_guest)
      : Promise.resolve({ data: [] }),
    idsByDomain.program_enrollment.length > 0
      ? supabase.from("program_enrollments").select("id, program_id").in("id", idsByDomain.program_enrollment)
      : Promise.resolve({ data: [] }),
    rosterMemberIds.size > 0
      ? supabase.from("roster_members").select("id, first_name, last_name").in("id", [...rosterMemberIds])
      : Promise.resolve({ data: [] }),
  ]);

  const reservations = (reservationsResult.data ?? []) as { id: string; court_id: string; starts_at: string }[];
  const lessonRequests = (lessonRequestsResult.data ?? []) as { id: string; pro_id: string; proposed_starts_at: string | null }[];
  const eventParticipants = (eventParticipantsResult.data ?? []) as { id: string; event_id: string }[];
  const eventGuests = (eventGuestsResult.data ?? []) as { id: string; event_id: string; display_name: string }[];
  const programEnrollments = (programEnrollmentsResult.data ?? []) as { id: string; program_id: string }[];
  const rosterMembers = (rosterMembersResult.data ?? []) as { id: string; first_name: string; last_name: string }[];

  const courtIds  = [...new Set(reservations.map(r => r.court_id))];
  const proIds    = [...new Set(lessonRequests.map(r => r.pro_id))];
  const eventIds  = [...new Set([...eventParticipants.map(p => p.event_id), ...eventGuests.map(g => g.event_id)])];
  const programIds = [...new Set(programEnrollments.map(e => e.program_id))];

  const [courtsResult, prosResult, eventsResult, programsResult] = await Promise.all([
    courtIds.length > 0 ? supabase.from("courts").select("id, name").in("id", courtIds) : Promise.resolve({ data: [] }),
    proIds.length > 0 ? supabase.from("profiles").select("id, first_name, last_name").in("id", proIds) : Promise.resolve({ data: [] }),
    eventIds.length > 0 ? supabase.from("events").select("id, title, starts_at").in("id", eventIds) : Promise.resolve({ data: [] }),
    programIds.length > 0 ? supabase.from("programs").select("id, title, starts_on").in("id", programIds) : Promise.resolve({ data: [] }),
  ]);

  const courtName    = new Map((courtsResult.data ?? []).map((c: { id: string; name: string }) => [c.id, c.name]));
  const proName       = new Map((prosResult.data ?? []).map((p: { id: string; first_name: string | null; last_name: string | null }) =>
    [p.id, [p.first_name, p.last_name].filter(Boolean).join(" ") || "Pro"]));
  const eventById     = new Map((eventsResult.data ?? []).map((e: { id: string; title: string; starts_at: string }) => [e.id, e]));
  const programById   = new Map((programsResult.data ?? []).map((p: { id: string; title: string; starts_on: string }) => [p.id, p]));
  const rosterName    = new Map(rosterMembers.map(m => [m.id, [m.first_name, m.last_name].filter(Boolean).join(" ") || "Unknown"]));
  const reservationById       = new Map(reservations.map(r => [r.id, r]));
  const lessonRequestById     = new Map(lessonRequests.map(r => [r.id, r]));
  const eventParticipantById  = new Map(eventParticipants.map(p => [p.id, p]));
  const eventGuestById        = new Map(eventGuests.map(g => [g.id, g]));
  const programEnrollmentById = new Map(programEnrollments.map(e => [e.id, e]));

  function shortDate(iso: string | null): string | null {
    if (!iso) return null;
    return new Date(iso).toLocaleDateString("en-US", { timeZone: clubTimezone, month: "short", day: "numeric" });
  }

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

  const rows: AdminPaymentRow[] = [];
  for (const p of latestPayments) {
    let title: string | null = null;
    let identityName = "Unknown";
    let dateLabel: string | null = null;
    let href = "/calendar";

    if (p.domain_type === "reservation") {
      const r = reservationById.get(p.domain_id);
      if (!r) continue;
      title = courtName.get(r.court_id) as string | undefined ?? "Court Reservation";
      dateLabel = shortDate(r.starts_at);
      identityName = p.roster_member_id ? rosterName.get(p.roster_member_id) ?? "Unknown" : "Unknown";
      href = "/calendar";
    } else if (p.domain_type === "lesson_request") {
      const r = lessonRequestById.get(p.domain_id);
      if (!r) continue;
      title = `Lesson with ${proName.get(r.pro_id) as string | undefined ?? "Pro"}`;
      dateLabel = shortDate(r.proposed_starts_at);
      identityName = p.roster_member_id ? rosterName.get(p.roster_member_id) ?? "Unknown" : "Unknown";
      href = "/admin/lessons";
    } else if (p.domain_type === "event_participant") {
      const r = eventParticipantById.get(p.domain_id);
      if (!r) continue;
      const ev = eventById.get(r.event_id) as { id: string; title: string; starts_at: string } | undefined;
      title = ev?.title ?? "Event";
      dateLabel = ev ? shortDate(ev.starts_at) : null;
      identityName = p.roster_member_id ? rosterName.get(p.roster_member_id) ?? "Unknown" : "Unknown";
      href = "/calendar";
    } else if (p.domain_type === "event_guest") {
      const r = eventGuestById.get(p.domain_id);
      if (!r) continue;
      const ev = eventById.get(r.event_id) as { id: string; title: string; starts_at: string } | undefined;
      title = ev?.title ?? "Event";
      dateLabel = ev ? shortDate(ev.starts_at) : null;
      // Guest payer identity is intentionally unresolved to a roster
      // Member (see EventRosterSheet's own comment) — the guest's own
      // display_name is the correct identity here, not "Unknown".
      identityName = `${r.display_name} (Guest)`;
      href = "/calendar";
    } else {
      const r = programEnrollmentById.get(p.domain_id);
      if (!r) continue;
      const prog = programById.get(r.program_id) as { id: string; title: string; starts_on: string } | undefined;
      title = prog?.title ?? "Program";
      dateLabel = null;
      identityName = p.roster_member_id ? rosterName.get(p.roster_member_id) ?? "Unknown" : "Unknown";
      href = "/events?tab=manage";
    }

    rows.push({
      key: p.id,
      domainType: p.domain_type,
      title,
      identityName,
      dateLabel,
      href,
      refundableCents: refundableByPaymentId.get(p.id) ?? 0,
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
          <AdminPaymentsClient rows={rows} clubId={clubId} currency={currency} />
        </div>
      </div>
    </>
  );
}
