"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { assertActiveClub } from "@/lib/supabase/staleClub";
import { STALE_CLUB_CONTEXT_ERROR, STALE_CLUB_MESSAGE } from "@/lib/staleClub";
import { getAuthUser, getAuthProfile } from "@/lib/supabase/user";
import { createPrivilegedClient } from "@/lib/supabase/privileged";
import { getStripeContext } from "@/lib/stripe/server";
import { isAuthorizedToConnectStripe } from "@/lib/stripe/connectConfig";
import type { PaymentStateRow } from "@/lib/payments";

const ERROR_MESSAGES: Record<string, string> = {
  [STALE_CLUB_CONTEXT_ERROR]: STALE_CLUB_MESSAGE,
  not_authenticated:   "You must be signed in.",
  insufficient_role:   "You don't have permission to do that.",
  invalid_payment_mode: "Invalid payment tracking mode.",
  court_time_payments_not_available: "Court Time Payments isn't available yet.",
  stripe_connect_not_ready: "Connect a Stripe account with an active status before turning on Court Time Payments.",
  club_not_found:       "Something went wrong. Please try again.",
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
      const key = error.message.match(/stripe_connect_not_ready|invalid_arguments|club_not_found/)?.[0] ?? "";
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
  revalidatePath("/admin/payments");
  revalidatePath("/events");
  revalidatePath("/my-schedule");
  return {};
}
