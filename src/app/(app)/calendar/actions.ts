"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { assertActiveClub } from "@/lib/supabase/staleClub";
import { sendSms } from "@/lib/sms";
import { sendEmailNotification } from "@/lib/email";
import {
  reservationConfirmedTemplate,
  reservationCancelledByMemberTemplate,
  reservationCancelledByAdminTemplate,
  eventJoinedTemplate,
  eventCancelledTemplate,
  waitlistOfferTemplate,
  waitlistPromotedTemplate,
} from "@/lib/email-templates";

// ---------------------------------------------------------------------------
// createReservation
// Wraps the create_reservation RPC so that SMS dispatch can run server-side.
// Returns the same { error: { code, message } } shape CalendarShell already
// passes to rpcErrorMessage(), keeping the call-site change minimal.
// ---------------------------------------------------------------------------
export async function createReservation(params: {
  p_court_id:    string;
  p_starts_at:   string;
  p_ends_at:     string;
  p_format?:     string | null;
  p_player_count?: number | null;
  p_guest_names?:  string[] | null;
  p_notes?:      string | null;
  expectedClubId: string;
}): Promise<{ error?: { code?: string; message: string } }> {
  const { expectedClubId, ...rpcParams } = params;
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: { message: guard.error } };

  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: { message: "not_authenticated" } };

  const { error } = await supabase.rpc("create_reservation", rpcParams);
  if (error) return { error: { code: error.code, message: error.message } };

  try {
    await dispatchBookingConfirmSms(user.id);
  } catch {
    // SMS dispatch must never block booking success or surface to the user.
  }

  try {
    await dispatchBookingConfirmEmail(user.id);
  } catch {
    // Email dispatch must never block booking success or surface to the user.
  }

  return {};
}

// ---------------------------------------------------------------------------
// createEvent
// Phase 26F1: wraps the create_event RPC in a Server Action (moved off the
// client-side supabase.rpc call in CreateEventSheet.tsx) so the stale-club
// preflight guard can run before the write. Validation, the RPC itself, and
// success/error shape are otherwise unchanged.
// ---------------------------------------------------------------------------
export async function createEvent(params: {
  p_event_type_id:   string;
  p_title:           string;
  p_starts_at:        string;
  p_ends_at:          string;
  p_court_ids:        string[];
  p_capacity:         number;
  p_member_joinable:  boolean;
  expectedClubId:     string;
}): Promise<{ error?: { code?: string; message: string } }> {
  const { expectedClubId, ...rpcParams } = params;
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: { message: guard.error } };

  const supabase = await createClient();

  const { error } = await supabase.rpc("create_event", rpcParams);
  if (error) return { error: { code: error.code, message: error.message } };

  return {};
}

// ---------------------------------------------------------------------------
// createMaintenanceBlocks
// Phase 26F1: wraps the create_maintenance_blocks RPC in a Server Action
// (moved off the client-side supabase.rpc call in CreateMaintenanceSheet.tsx)
// so the stale-club preflight guard can run before the write. Validation,
// the RPC itself, and success/error shape are otherwise unchanged.
// ---------------------------------------------------------------------------
export async function createMaintenanceBlocks(params: {
  p_court_ids:             string[];
  p_starts_at:             string;
  p_ends_at:               string;
  p_notes:                 string | null;
  p_show_notes_to_members: boolean;
  expectedClubId:          string;
}): Promise<{ error?: { code?: string; message: string } }> {
  const { expectedClubId, ...rpcParams } = params;
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: { message: guard.error } };

  const supabase = await createClient();

  const { error } = await supabase.rpc("create_maintenance_blocks", rpcParams);
  if (error) return { error: { code: error.code, message: error.message } };

  return {};
}

// ---------------------------------------------------------------------------
// dispatchBookingConfirmSms — internal, not exported
// Finds the reservation_confirmed notification just inserted by the RPC,
// checks the member's SMS eligibility, sends if opted in, and records the
// delivery attempt. Mirrors dispatchAdminCancelSms exactly.
// ---------------------------------------------------------------------------
async function dispatchBookingConfirmSms(ownerUserId: string): Promise<void> {
  const supabase = await createClient();

  const { data: notification } = await supabase
    .from("notifications")
    .select("id, body")
    .eq("user_id", ownerUserId)
    .eq("kind", "reservation_confirmed")
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

async function dispatchBookingConfirmEmail(ownerUserId: string): Promise<void> {
  const supabase = await createClient();

  const { data: notification } = await supabase
    .from("notifications")
    .select("id, body")
    .eq("user_id", ownerUserId)
    .eq("kind", "reservation_confirmed")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (!notification) return;

  await sendEmailNotification(
    supabase,
    notification.id,
    ownerUserId,
    "reservation_confirmed",
    (clubName) => reservationConfirmedTemplate(clubName, notification.body),
  );
}

// ---------------------------------------------------------------------------
// joinEvent
// Wraps the join_event RPC so that SMS dispatch can run server-side.
// Returns { error?: string } matching the leaveEvent pattern so callers
// can map the error string to a UI message with mapJoinError(error).
// SMS is dispatched only when the result status is 'confirmed'; waitlisted
// joins emit no notification (matches in-app behavior).
// ---------------------------------------------------------------------------
export async function joinEvent(
  eventId: string,
  expectedClubId: string,
): Promise<{ data?: { status: string } | null; error?: string }> {
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: guard.error };

  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "not_authenticated" };

  const { data, error } = await supabase.rpc("join_event", { p_event_id: eventId });
  if (error) return { error: error.message };

  if ((data as { status?: string } | null)?.status === "confirmed") {
    try {
      await dispatchEventJoinSms(user.id, eventId);
    } catch {
      // SMS dispatch must never block join success or surface to the user.
    }

    try {
      await dispatchEventJoinEmail(user.id, eventId);
    } catch {
      // Email dispatch must never block join success or surface to the user.
    }
  }

  return { data: data as { status: string } | null };
}

// ---------------------------------------------------------------------------
// dispatchEventJoinSms — internal, not exported
// Finds the event_joined notification just inserted by join_event (confirmed
// path only), checks SMS eligibility, sends, and records the attempt.
// Mirrors dispatchWaitlistPromotionSms: fetches recent candidates and matches
// event_id via JS because PostgREST JSONB filter syntax is avoided.
// ---------------------------------------------------------------------------
async function dispatchEventJoinSms(
  userId:  string,
  eventId: string,
): Promise<void> {
  const supabase = await createClient();

  const { data: candidates } = await supabase
    .from("notifications")
    .select("id, body, metadata")
    .eq("user_id", userId)
    .eq("kind", "event_joined")
    .order("created_at", { ascending: false })
    .limit(5);

  const notification = candidates?.find(
    n => (n.metadata as Record<string, string> | null)?.event_id === eventId
  ) ?? null;

  if (!notification) return;

  const { data: profile } = await supabase
    .from("profiles")
    .select("sms_opt_in, phone")
    .eq("id", userId)
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

async function dispatchEventJoinEmail(
  userId:  string,
  eventId: string,
): Promise<void> {
  const supabase = await createClient();

  const { data: candidates } = await supabase
    .from("notifications")
    .select("id, body, metadata")
    .eq("user_id", userId)
    .eq("kind", "event_joined")
    .order("created_at", { ascending: false })
    .limit(5);

  const notification = candidates?.find(
    n => (n.metadata as Record<string, string> | null)?.event_id === eventId
  ) ?? null;

  if (!notification) return;

  await sendEmailNotification(
    supabase,
    notification.id,
    userId,
    "event_joined",
    (clubName) => eventJoinedTemplate(clubName, notification.body),
  );
}

// ---------------------------------------------------------------------------
// adminCancelReservation
// Calls the admin_cancel_reservation RPC, then attempts to send an SMS to
// the reservation owner. SMS failures are non-blocking — the cancellation
// is already committed by the time SMS dispatch runs.
// ---------------------------------------------------------------------------
export async function adminCancelReservation(
  reservationId: string,
  expectedClubId: string,
): Promise<{ error?: string }> {
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: guard.error };

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

  try {
    await dispatchAdminCancelEmail(reservation.owner_user_id);
  } catch {
    // Email dispatch must never surface as a user-facing error.
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

async function dispatchAdminCancelEmail(ownerUserId: string): Promise<void> {
  const supabase = await createClient();

  const { data: notification } = await supabase
    .from("notifications")
    .select("id, body")
    .eq("user_id", ownerUserId)
    .eq("kind", "reservation_cancelled_by_admin")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (!notification) return;

  await sendEmailNotification(
    supabase,
    notification.id,
    ownerUserId,
    "reservation_cancelled_by_admin",
    (clubName) => reservationCancelledByAdminTemplate(clubName, notification.body),
  );
}

// ---------------------------------------------------------------------------
// notifyMemberReservationCancelled
// Called from my-schedule/page.tsx after a member self-cancels a reservation.
// Calls the notify_reservation_cancelled_by_member security-definer RPC (which
// inserts the notification — RLS blocks direct inserts from regular sessions),
// then dispatches SMS non-blocking. Any error in dispatch is swallowed so it
// never surfaces to the user.
// ---------------------------------------------------------------------------
export async function notifyMemberReservationCancelled(
  userId:        string,
  reservationId: string,
): Promise<void> {
  const supabase = await createClient();

  const { error: rpcError } = await supabase.rpc(
    "notify_reservation_cancelled_by_member",
    { p_reservation_id: reservationId }
  );
  if (rpcError) return; // notification not created — skip SMS

  try {
    await dispatchMemberCancelSms(userId);
  } catch {
    // SMS dispatch must never block or surface errors.
  }

  try {
    await dispatchMemberCancelEmail(userId);
  } catch {
    // Email dispatch must never block or surface errors.
  }
}

// ---------------------------------------------------------------------------
// dispatchMemberCancelSms — internal, not exported
// Finds the reservation_cancelled_by_member notification just inserted by the
// RPC, checks the member's SMS eligibility, sends if opted in, and records the
// delivery attempt. Mirrors dispatchAdminCancelSms exactly.
// ---------------------------------------------------------------------------
async function dispatchMemberCancelSms(ownerUserId: string): Promise<void> {
  const supabase = await createClient();

  const { data: notification } = await supabase
    .from("notifications")
    .select("id, body")
    .eq("user_id", ownerUserId)
    .eq("kind", "reservation_cancelled_by_member")
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

async function dispatchMemberCancelEmail(ownerUserId: string): Promise<void> {
  const supabase = await createClient();

  const { data: notification } = await supabase
    .from("notifications")
    .select("id, body")
    .eq("user_id", ownerUserId)
    .eq("kind", "reservation_cancelled_by_member")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (!notification) return;

  await sendEmailNotification(
    supabase,
    notification.id,
    ownerUserId,
    "reservation_cancelled_by_member",
    (clubName) => reservationCancelledByMemberTemplate(clubName, notification.body),
  );
}

// ---------------------------------------------------------------------------
// leaveEvent
// Calls leave_event RPC and dispatches SMS to the next offered user (if any).
// Phase 18A: leave_event now creates a waitlist_offer notification (not
// waitlist_promoted) for the user who receives the spot offer.
// Returns the raw RPC error message so callers can map it to UI strings.
// ---------------------------------------------------------------------------
export async function leaveEvent(
  eventId: string,
  expectedClubId: string,
): Promise<{ error?: string }> {
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: guard.error };

  const supabase = await createClient();

  const { data: offeredProfileId, error: rpcError } = await supabase.rpc(
    "leave_event",
    { p_event_id: eventId }
  );

  if (rpcError) return { error: rpcError.message };

  try {
    await dispatchWaitlistOfferSms(eventId, offeredProfileId);
  } catch {
    // SMS dispatch must never surface as a user-facing error.
  }

  try {
    await dispatchWaitlistOfferEmail(eventId, offeredProfileId);
  } catch {
    // Email dispatch must never surface as a user-facing error.
  }

  return {};
}

// ---------------------------------------------------------------------------
// dispatchWaitlistOfferSms — internal, not exported
// Skips immediately when no one was offered (offeredProfileId is null).
// Otherwise finds the waitlist_offer notification just created by the RPC,
// checks the offered user's SMS eligibility, and records the delivery attempt.
// Phase 18A: leave_event now creates waitlist_offer (not waitlist_promoted).
// ---------------------------------------------------------------------------
async function dispatchWaitlistOfferSms(
  eventId:         string,
  offeredProfileId: string | null,
): Promise<void> {
  if (!offeredProfileId) return;

  const supabase = await createClient();

  // Fetch the most recent waitlist_offer notifications for this user and
  // confirm the event_id matches in JS (avoids PostgREST JSONB filter syntax).
  const { data: candidates } = await supabase
    .from("notifications")
    .select("id, body, metadata")
    .eq("user_id", offeredProfileId)
    .eq("kind", "waitlist_offer")
    .order("created_at", { ascending: false })
    .limit(5);

  const notification = candidates?.find(
    n => (n.metadata as Record<string, string> | null)?.event_id === eventId
  ) ?? null;

  if (!notification) return;

  const { data: profile } = await supabase
    .from("profiles")
    .select("sms_opt_in, phone")
    .eq("id", offeredProfileId)
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

async function dispatchWaitlistOfferEmail(
  eventId:          string,
  offeredProfileId: string | null,
): Promise<void> {
  if (!offeredProfileId) return;

  const supabase = await createClient();

  const { data: candidates } = await supabase
    .from("notifications")
    .select("id, body, metadata")
    .eq("user_id", offeredProfileId)
    .eq("kind", "waitlist_offer")
    .order("created_at", { ascending: false })
    .limit(5);

  const notification = candidates?.find(
    n => (n.metadata as Record<string, string> | null)?.event_id === eventId
  ) ?? null;

  if (!notification) return;

  await sendEmailNotification(
    supabase,
    notification.id,
    offeredProfileId,
    "waitlist_offer",
    (clubName) => waitlistOfferTemplate(clubName, notification.body),
  );
}

// ---------------------------------------------------------------------------
// acceptWaitlistOffer
// Calls accept_waitlist_offer RPC, then dispatches SMS for the waitlist_promoted
// notification that the RPC creates (reused for the accept/confirm path).
// Returns { error } on failure so callers can map to a UI message.
// ---------------------------------------------------------------------------
export async function acceptWaitlistOffer(
  eventId: string,
  expectedClubId: string,
): Promise<{ error?: string }> {
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: guard.error };

  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "not_authenticated" };

  const { error: rpcError } = await supabase.rpc("accept_waitlist_offer", {
    p_event_id: eventId,
  });

  if (rpcError) return { error: rpcError.message };

  try {
    await dispatchAcceptOfferSms(user.id, eventId);
  } catch {
    // SMS dispatch must never block accept success or surface to the user.
  }

  try {
    await dispatchAcceptOfferEmail(user.id, eventId);
  } catch {
    // Email dispatch must never block accept success or surface to the user.
  }

  return {};
}

// ---------------------------------------------------------------------------
// dispatchAcceptOfferSms — internal, not exported
// Finds the waitlist_promoted notification created by accept_waitlist_offer
// (the same kind is reused for the "you are now confirmed" path), checks SMS
// eligibility, sends if opted in, and records the delivery attempt.
// ---------------------------------------------------------------------------
async function dispatchAcceptOfferSms(
  userId:  string,
  eventId: string,
): Promise<void> {
  const supabase = await createClient();

  const { data: candidates } = await supabase
    .from("notifications")
    .select("id, body, metadata")
    .eq("user_id", userId)
    .eq("kind", "waitlist_promoted")
    .order("created_at", { ascending: false })
    .limit(5);

  const notification = candidates?.find(
    n => (n.metadata as Record<string, string> | null)?.event_id === eventId
  ) ?? null;

  if (!notification) return;

  const { data: profile } = await supabase
    .from("profiles")
    .select("sms_opt_in, phone")
    .eq("id", userId)
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

async function dispatchAcceptOfferEmail(
  userId:  string,
  eventId: string,
): Promise<void> {
  const supabase = await createClient();

  const { data: candidates } = await supabase
    .from("notifications")
    .select("id, body, metadata")
    .eq("user_id", userId)
    .eq("kind", "waitlist_promoted")
    .order("created_at", { ascending: false })
    .limit(5);

  const notification = candidates?.find(
    n => (n.metadata as Record<string, string> | null)?.event_id === eventId
  ) ?? null;

  if (!notification) return;

  await sendEmailNotification(
    supabase,
    notification.id,
    userId,
    "waitlist_promoted",
    (clubName) => waitlistPromotedTemplate(clubName, notification.body),
  );
}

// ---------------------------------------------------------------------------
// declineWaitlistOffer
// Calls decline_waitlist_offer RPC. No SMS is dispatched on decline.
// Returns { error } on failure so callers can map to a UI message.
// ---------------------------------------------------------------------------
export async function declineWaitlistOffer(
  eventId: string,
  expectedClubId: string,
): Promise<{ error?: string }> {
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: guard.error };

  const supabase = await createClient();

  const { error: rpcError } = await supabase.rpc("decline_waitlist_offer", {
    p_event_id: eventId,
  });

  if (rpcError) return { error: rpcError.message };

  return {};
}

// ---------------------------------------------------------------------------
// cancelEvent
// Calls the cancel_event RPC, then dispatches SMS to all notified participants.
// The actor is excluded from SMS even if they received an in-app notification.
// ---------------------------------------------------------------------------
export async function cancelEvent(
  eventId: string,
  expectedClubId: string,
): Promise<{ error?: string }> {
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: guard.error };

  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  const actorUserId = user?.id ?? null;

  const { error: rpcError } = await supabase.rpc("cancel_event", {
    p_event_id: eventId,
  });

  if (rpcError) return { error: rpcError.message };

  try {
    await dispatchEventCancelSms(eventId, actorUserId);
  } catch {
    // SMS dispatch must never surface as a user-facing error.
  }

  try {
    await dispatchEventCancelEmail(eventId, actorUserId);
  } catch {
    // Email dispatch must never surface as a user-facing error.
  }

  return {};
}

// ---------------------------------------------------------------------------
// dispatchEventCancelSms — internal, not exported
// Queries the event_cancelled notifications just created by the RPC (within a
// 5-second window), skips the actor, and dispatches SMS to each recipient.
// ---------------------------------------------------------------------------
async function dispatchEventCancelSms(
  eventId:     string,
  actorUserId: string | null,
): Promise<void> {
  const supabase = await createClient();

  const cutoff = new Date(Date.now() - 5000).toISOString();

  const { data: notifications } = await supabase
    .from("notifications")
    .select("id, body, user_id, metadata")
    .eq("kind", "event_cancelled")
    .gte("created_at", cutoff);

  if (!notifications?.length) return;

  // Filter to notifications for this specific event (JSONB metadata check in JS
  // avoids relying on PostgREST JSONB filter syntax).
  const relevant = notifications.filter(
    n => (n.metadata as Record<string, string> | null)?.event_id === eventId
  );

  for (const notification of relevant) {
    // Do not SMS the actor even if they received an in-app notification.
    if (notification.user_id === actorUserId) continue;

    const { data: profile } = await supabase
      .from("profiles")
      .select("sms_opt_in, phone")
      .eq("id", notification.user_id)
      .single();

    if (!profile) continue;

    if (!profile.sms_opt_in) {
      await supabase.rpc("record_delivery_attempt", {
        p_notification_id: notification.id,
        p_channel:         "sms",
        p_status:          "opted_out",
      });
      continue;
    }

    if (!profile.phone) {
      await supabase.rpc("record_delivery_attempt", {
        p_notification_id: notification.id,
        p_channel:         "sms",
        p_status:          "no_phone",
      });
      continue;
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
}

async function dispatchEventCancelEmail(
  eventId:     string,
  actorUserId: string | null,
): Promise<void> {
  const supabase = await createClient();

  const cutoff = new Date(Date.now() - 5000).toISOString();

  const { data: notifications } = await supabase
    .from("notifications")
    .select("id, body, user_id, metadata")
    .eq("kind", "event_cancelled")
    .gte("created_at", cutoff);

  if (!notifications?.length) return;

  const relevant = notifications.filter(
    n => (n.metadata as Record<string, string> | null)?.event_id === eventId
  );

  for (const notification of relevant) {
    if (notification.user_id === actorUserId) continue;

    await sendEmailNotification(
      supabase,
      notification.id,
      notification.user_id,
      "event_cancelled",
      (clubName) => eventCancelledTemplate(clubName, notification.body),
    );
  }
}

// ---------------------------------------------------------------------------
// cancelMemberReservation
// Member self-cancel for a confirmed court reservation.
// Enforces the same cancellation-window and grace-period rules as the inline
// server action in my-schedule/page.tsx. Returns { error } when cancellation
// is blocked or fails so callers can surface a message to the user.
// Revalidates both /my-schedule and /calendar to keep both views fresh.
// ---------------------------------------------------------------------------
export async function cancelMemberReservation(
  reservationId: string,
  expectedClubId: string,
): Promise<{ error?: string }> {
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: guard.error };

  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "You must be signed in." };

  const { data: actorProfile } = await supabase
    .from("profiles")
    .select("role, club_id")
    .eq("id", user.id)
    .single();

  if (!actorProfile) return { error: "Profile not found." };

  // Members (non-admin) are subject to cancellation-window and grace-period rules.
  if (actorProfile.role !== "admin") {
    const { data: targetRes } = await supabase
      .from("reservations")
      .select("starts_at, created_at")
      .eq("id", reservationId)
      .eq("owner_user_id", user.id)
      .single();

    if (!targetRes) return { error: "Reservation not found." };

    const { data: settings } = await supabase
      .from("club_settings")
      .select("cancellation_window_hours, cancellation_grace_minutes")
      .eq("club_id", actorProfile.club_id ?? "")
      .single();

    const windowMs    = (settings?.cancellation_window_hours  ?? 24) * 60 * 60 * 1000;
    const graceMs     = (settings?.cancellation_grace_minutes ??  5) * 60 * 1000;
    const insideWindow = new Date(targetRes.starts_at).getTime() - Date.now() < windowMs;
    const withinGrace  = graceMs > 0 && Date.now() - new Date(targetRes.created_at).getTime() < graceMs;

    if (insideWindow && !withinGrace) {
      return { error: "This booking can no longer be cancelled — the cancellation window has passed." };
    }
  }

  const { error: updateError } = await supabase
    .from("reservations")
    .update({
      status:            "cancelled",
      cancelled_at:      new Date().toISOString(),
      cancelled_by:      user.id,
      cancellation_kind: "member",
    })
    .eq("id", reservationId)
    .eq("owner_user_id", user.id);

  if (updateError) return { error: "Could not cancel the booking. Please try again." };

  try {
    await notifyMemberReservationCancelled(user.id, reservationId);
  } catch {
    // Notification dispatch must never surface to the user.
  }

  revalidatePath("/my-schedule");
  return {};
}
