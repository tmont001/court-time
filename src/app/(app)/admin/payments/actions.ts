"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { assertActiveClub } from "@/lib/supabase/staleClub";
import { STALE_CLUB_CONTEXT_ERROR, STALE_CLUB_MESSAGE } from "@/lib/staleClub";
import type { PaymentStateRow } from "@/lib/payments";

const ERROR_MESSAGES: Record<string, string> = {
  [STALE_CLUB_CONTEXT_ERROR]: STALE_CLUB_MESSAGE,
  not_authenticated:   "You must be signed in.",
  insufficient_role:   "You don't have permission to do that.",
  invalid_payment_mode: "Invalid payment tracking mode.",
  court_time_payments_not_available: "Court Time Payments isn't available yet.",
  payment_not_found:    "That payment could not be found.",
  invalid_payment_amount: "Enter a valid amount greater than zero.",
  invalid_payment_method: "Choose a valid payment method.",
  payment_not_open_for_payment: "This balance can't accept a new payment right now — it may already be resolved.",
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

export async function updateClubPaymentModeAction(
  mode: "none" | "manual" | "court_time_payments",
  expectedClubId: string,
): Promise<{ error?: string }> {
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: ERROR_MESSAGES[guard.error] };

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

  const { error } = await supabase.rpc("record_manual_payment", {
    p_payment_id: params.paymentId,
    p_amount_cents: params.amountCents,
    p_method: params.method as "cash" | "check" | "card_terminal" | "bank_transfer" | "digital_wallet" | "other",
    p_external_reference: params.externalReference || null,
    p_notes: params.notes || null,
  });
  if (error) {
    const key = error.message.match(/not_authenticated|insufficient_role|payment_not_found|invalid_payment_amount|invalid_payment_method|payment_not_open_for_payment/)?.[0] ?? "";
    return { error: ERROR_MESSAGES[key] ?? "Failed to record payment." };
  }

  // Broad revalidation: a payment can be recorded from several different
  // surfaces (reservation/lesson sheets, event/program rosters, member
  // detail) and this checkpoint intentionally does not thread a single
  // precise path through every call site.
  revalidatePath("/calendar");
  revalidatePath("/admin/lessons");
  revalidatePath("/admin/members");
  revalidatePath("/events");
  revalidatePath("/my-schedule");
  return {};
}
