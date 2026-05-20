"use server";

import { createClient } from "@/lib/supabase/server";
import { sendSms } from "@/lib/sms";

// ---------------------------------------------------------------------------
// adminCancelReservation
// Calls the admin_cancel_reservation RPC, then attempts to send an SMS to
// the reservation owner. SMS failures are non-blocking — the cancellation
// is already committed by the time SMS dispatch runs.
// ---------------------------------------------------------------------------
export async function adminCancelReservation(
  reservationId: string
): Promise<{ error?: string }> {
  const supabase = await createClient();

  const { data: reservation, error: rpcError } = await supabase.rpc(
    "admin_cancel_reservation",
    { p_reservation_id: reservationId }
  );

  if (rpcError) return { error: rpcError.message };
  if (!reservation) return { error: "reservation_not_found" };

  try {
    await dispatchAdminCancelSms(reservation.owner_user_id);
  } catch {
    // SMS dispatch must never surface as a user-facing error.
  }

  return {};
}

// ---------------------------------------------------------------------------
// dispatchAdminCancelSms — internal, not exported
// Finds the in-app notification just created by the RPC, checks the owner's
// SMS eligibility, calls sendSms if opted in, and records the delivery attempt.
// ---------------------------------------------------------------------------
async function dispatchAdminCancelSms(ownerUserId: string): Promise<void> {
  const supabase = await createClient();

  // The notification was just inserted by admin_cancel_reservation; the most
  // recent reservation_cancelled_by_admin row for this user is the right one.
  const { data: notification } = await supabase
    .from("notifications")
    .select("id, body")
    .eq("user_id", ownerUserId)
    .eq("kind", "reservation_cancelled_by_admin")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (!notification) return;

  const { data: profile } = await supabase
    .from("profiles")
    .select("sms_opt_in, phone")
    .eq("id", ownerUserId)
    .single();

  if (!profile) return;

  if (!profile.sms_opt_in) {
    await supabase.rpc("record_delivery_attempt", {
      p_notification_id: notification.id,
      p_channel:         "sms",
      p_status:          "opted_out",
    });
    return;
  }

  if (!profile.phone) {
    await supabase.rpc("record_delivery_attempt", {
      p_notification_id: notification.id,
      p_channel:         "sms",
      p_status:          "no_phone",
    });
    return;
  }

  const body = `${notification.body}\n\nReply STOP to opt out.`;
  const { sid, error: smsError } = await sendSms(profile.phone, body);

  if (sid) {
    await supabase.rpc("record_delivery_attempt", {
      p_notification_id:     notification.id,
      p_channel:             "sms",
      p_status:              "sent",
      p_provider:            "twilio",
      p_provider_message_id: sid,
      p_sent_at:             new Date().toISOString(),
    });
  } else {
    await supabase.rpc("record_delivery_attempt", {
      p_notification_id: notification.id,
      p_channel:         "sms",
      p_status:          "failed",
      p_provider:        "twilio",
      p_error:           smsError ?? "Unknown error",
    });
  }
}
