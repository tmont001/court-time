"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { assertActiveClub } from "@/lib/supabase/staleClub";
import { STALE_CLUB_CONTEXT_ERROR, STALE_CLUB_MESSAGE } from "@/lib/staleClub";
import { getAuthUser, getAuthProfile } from "@/lib/supabase/user";
import { createPrivilegedClient } from "@/lib/supabase/privileged";
import { getStripeContext } from "@/lib/stripe/server";
import { isAuthorizedToConnectStripe } from "@/lib/stripe/connectConfig";
import {
  CHECKOUT_STILL_PROCESSING_MESSAGE,
  OPEN_CHECKOUT_REQUIRES_RESOLUTION,
  resolveBlockingCheckoutBeforeMutation,
} from "@/lib/stripe/checkoutInvalidation";
import type { PaymentStateRow } from "@/lib/payments";

const ERROR_MESSAGES: Record<string, string> = {
  [STALE_CLUB_CONTEXT_ERROR]: STALE_CLUB_MESSAGE,
  not_authenticated:   "You must be signed in.",
  insufficient_role:   "You don't have permission to do that.",
  invalid_payment_mode: "Invalid payment tracking mode.",
  court_time_payments_not_available: "Court Time Payments isn't available yet.",
  stripe_connect_not_ready: "Connect a Stripe account with an active status before turning on Court Time Payments.",
  // Phase 34G-A2: Court Time Payments is commercially locked to Connected —
  // activate_court_time_payments (0164) raises the same capability_not_
  // available error every other member_self_service gate already raises
  // (0123) when the club is Staff-Managed.
  capability_not_available: "Court Time Payments requires the Connected plan. Contact us to upgrade.",
  club_not_found:       "Something went wrong. Please try again.",
  payment_not_found:    "That payment could not be found.",
  invalid_payment_amount: "Enter a valid amount greater than zero.",
  invalid_payment_method: "Choose a valid payment method.",
  payment_not_open_for_payment: "This balance can't accept a new payment right now — it may already be resolved.",
  // Phase 34E-A: only reachable if a second, concurrent Checkout Session
  // was bound again in the brief window between this action's own
  // resolve-via-Stripe step and its retry — the normal path already
  // returns CHECKOUT_STILL_PROCESSING_MESSAGE directly, never reaching
  // this map.
  open_checkout_requires_resolution: CHECKOUT_STILL_PROCESSING_MESSAGE,
};

// Read-only, batched, sanitized. Callable directly from a Server Component
// (awaited in a page/loader) or from a client sheet via useEffect +
// startTransition — this is the ONLY payment-state read path used anywhere
// in the UI; nothing reads payments/payment_events directly.
export async function fetchPaymentStates(
  domainType: "reservation" | "lesson_request" | "event_participant" | "event_guest" | "program_enrollment",
  domainIds: string[],
): Promise<{ data?: PaymentStateRow[]; error?: string }> {
  if (domainIds.length === 0) return { data: [] };

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const { data, error } = await supabase.rpc("get_payment_states_for_domains", {
    p_domain_type: domainType,
    p_domain_ids: domainIds,
  });
  if (error) {
    const key = error.message.match(/not_authenticated|insufficient_role/)?.[0] ?? "";
    return { error: ERROR_MESSAGES[key] ?? "Failed to load payment state." };
  }

  return { data: (data ?? []) as PaymentStateRow[] };
}

export interface PaymentEventHistoryItem {
  id: string;
  eventType: string;
  amountCents: number | null;
  method: string | null;
  notes: string | null;
  occurredAt: string;
  isReversed: boolean;
  // Phase 34G-C1 additions — every field already existed on payment_events
  // (0143/0150/0153); this widens the read model to expose them, never a
  // schema/RPC/migration change.
  //
  // What THIS event itself reverses (null unless eventType is
  // 'reverse_payment_event') — distinct from isReversed above, which
  // means "some OTHER event reverses this one."
  reversesEventId: string | null;
  // Manual reference (check #/terminal receipt #) for manual events; the
  // raw Stripe Checkout Session/Refund id for online events. The UI layer
  // — never this read model — is responsible for only ever rendering the
  // online case inside a collapsed "Transaction details" disclosure
  // (locked scope: raw Stripe ids must not appear prominently).
  externalReference: string | null;
  actorId: string | null;
  // Resolved via ONE batched profiles lookup below (never per-event) —
  // null for every event with a null actorId (structurally always true
  // for online_payment_recorded/online_refund_recorded, since there is no
  // human actor for a Stripe webhook — never fabricated here).
  actorName: string | null;
}

// Phase 34E-E — read-only chronological ledger for the payment-detail
// surface. payment_events already carries an Admin/Staff club-scoped
// SELECT policy (payment_events_select_admin_staff, 0143) — a plain
// authenticated read, no privileged client, no new RPC, no migration.
// Never mutates anything; historical events are never rewritten.
//
// Phase 34G-C1 — now also fetches external_reference/actor_id (previously
// deliberately excluded) and resolves actor_id to a display name via ONE
// additional batched profiles query (never per-event) — the same
// `select("id, first_name, last_name").in("id", ids)` join
// page.tsx already uses for pro names, confirming profiles already grants
// Admin/Staff same-club read access; no new RLS/migration required.
// Raw Stripe ids (external_reference on an online event) still never
// appear in a "primary" surface — that rule now lives at the DISPLAY
// layer (PaymentDetailSheet's own Transaction-details disclosure), not by
// omitting the field from this read model.
export async function fetchPaymentEventHistory(
  paymentId: string,
  expectedClubId: string,
): Promise<{ data?: PaymentEventHistoryItem[]; error?: string }> {
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: ERROR_MESSAGES[guard.error] };

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const { data, error } = await supabase
    .from("payment_events")
    .select("id, event_type, amount_cents, method, external_reference, notes, actor_id, occurred_at, reverses_event_id")
    .eq("payment_id", paymentId)
    .eq("club_id", expectedClubId)
    .order("occurred_at", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) return { error: "Failed to load payment history." };

  const rows = data ?? [];
  // A row is "reversed" when some OTHER row in this same result set names
  // it via reverses_event_id — read-only annotation for display, never a
  // rewrite of the historical event itself.
  const reversedIds = new Set(rows.map(r => r.reverses_event_id).filter((id): id is string => id !== null));

  // Batched actor-name resolution — ONE query for every distinct actor_id
  // on this single payment's own history (at most a handful of rows),
  // never a per-event lookup.
  const actorIds = [...new Set(rows.map(r => r.actor_id).filter((id): id is string => id !== null))];
  const actorNameById = new Map<string, string>();
  if (actorIds.length > 0) {
    const { data: actors } = await supabase
      .from("profiles")
      .select("id, first_name, last_name")
      .in("id", actorIds);
    for (const a of actors ?? []) {
      actorNameById.set(a.id, [a.first_name, a.last_name].filter(Boolean).join(" ") || "Staff");
    }
  }

  return {
    data: rows.map(r => ({
      id: r.id,
      eventType: r.event_type,
      amountCents: r.amount_cents,
      method: r.method,
      notes: r.notes,
      occurredAt: r.occurred_at,
      isReversed: reversedIds.has(r.id),
      reversesEventId: r.reverses_event_id,
      externalReference: r.external_reference,
      actorId: r.actor_id,
      actorName: r.actor_id ? actorNameById.get(r.actor_id) ?? null : null,
    })),
  };
}

export async function updateClubPaymentModeAction(
  mode: "none" | "manual" | "court_time_payments",
  expectedClubId: string,
): Promise<{ error?: string }> {
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: ERROR_MESSAGES[guard.error] };

  // Phase 34D-C: court_time_payments is the ONE mode that never goes
  // through update_club_payment_mode (which stays authenticated-callable,
  // unchanged, and still unconditionally rejects this value directly —
  // see 0149's own header comment for why). Activation instead goes
  // through the service-role-only activate_court_time_payments RPC, with
  // this Server Action independently resolving Admin identity and the
  // server's own current Stripe environment (never a client-supplied
  // value) before ever touching the privileged client.
  if (mode === "court_time_payments") {
    const user = await getAuthUser();
    if (!user) return { error: ERROR_MESSAGES.not_authenticated };

    const profile = await getAuthProfile();
    if (!profile || !isAuthorizedToConnectStripe(profile.role) || !profile.club_id) {
      return { error: ERROR_MESSAGES.insufficient_role };
    }

    const context = getStripeContext();
    if (!context) return { error: ERROR_MESSAGES.court_time_payments_not_available };

    const privileged = createPrivilegedClient();
    if (!privileged) return { error: ERROR_MESSAGES.club_not_found };

    const { error } = await privileged.rpc("activate_court_time_payments", {
      p_club_id: profile.club_id,
      p_livemode: context.livemode,
      p_actor_id: user.id,
    });
    if (error) {
      const key = error.message.match(/capability_not_available|stripe_connect_not_ready|invalid_arguments|club_not_found/)?.[0] ?? "";
      return { error: ERROR_MESSAGES[key] ?? "Failed to update payment tracking mode." };
    }

    revalidatePath("/admin/settings");
    return {};
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const { error } = await supabase.rpc("update_club_payment_mode", { p_payment_mode: mode });
  if (error) {
    const key = error.message.match(/not_authenticated|insufficient_role|invalid_payment_mode|court_time_payments_not_available/)?.[0] ?? "";
    return { error: ERROR_MESSAGES[key] ?? "Failed to update payment tracking mode." };
  }

  revalidatePath("/admin/settings");
  return {};
}

export async function recordManualPaymentAction(
  params: {
    paymentId: string;
    amountCents: number;
    method: string;
    externalReference?: string | null;
    notes?: string | null;
  },
  expectedClubId: string,
): Promise<{ error?: string }> {
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: ERROR_MESSAGES[guard.error] };

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const rpcParams = {
    p_payment_id: params.paymentId,
    p_amount_cents: params.amountCents,
    p_method: params.method as "cash" | "check" | "card_terminal" | "bank_transfer" | "digital_wallet" | "other",
    p_external_reference: params.externalReference || null,
    p_notes: params.notes || null,
  };

  let { error } = await supabase.rpc("record_manual_payment", rpcParams);

  // Phase 34E-A: a bound, potentially still-payable Stripe Checkout
  // Session is open for this payment — resolve it via Stripe (never a
  // silent local override) before safely retrying exactly once.
  if (error?.message.includes(OPEN_CHECKOUT_REQUIRES_RESOLUTION)) {
    const resolved = await resolveBlockingCheckoutBeforeMutation(params.paymentId, expectedClubId);
    if (!resolved.ok) return { error: resolved.error };
    ({ error } = await supabase.rpc("record_manual_payment", rpcParams));
  }

  if (error) {
    const key = error.message.match(/not_authenticated|insufficient_role|payment_not_found|invalid_payment_amount|invalid_payment_method|payment_not_open_for_payment|open_checkout_requires_resolution/)?.[0] ?? "";
    return { error: ERROR_MESSAGES[key] ?? "Failed to record payment." };
  }

  // Broad revalidation: a payment can be recorded from several different
  // surfaces (reservation/lesson sheets, event/program rosters, member
  // detail) and this checkpoint intentionally does not thread a single
  // precise path through every call site.
  revalidatePath("/calendar");
  revalidatePath("/admin/lessons");
  revalidatePath("/admin/members");
  revalidatePath("/admin/payments");
  revalidatePath("/events");
  revalidatePath("/my-schedule");
  return {};
}
