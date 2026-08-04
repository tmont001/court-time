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
  reservationRescheduledTemplate,
  eventJoinedTemplate,
  eventCancelledTemplate,
  waitlistOfferTemplate,
  waitlistPromotedTemplate,
} from "@/lib/email-templates";

// ---------------------------------------------------------------------------
// Shared result shape for update_member_reservation / cancel_member_reservation
// — both RPCs return jsonb of this shape (see supabase/migrations/0097).
// Only the fields actually consumed here are typed; the reservation payload
// itself is passed straight through to callers as an unknown-shaped record.
// ---------------------------------------------------------------------------
interface ReservationMutationResult {
  reservation: Record<string, unknown> & { owner_user_id: string };
  notification_id: string | null;
}

interface UpdateMemberReservationResult extends ReservationMutationResult {
  changed_fields: string[];
}

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
// updateMaintenanceBlock
// Phase 30D: Admin-only edit of a single, still-future, confirmed
// maintenance reservation row (court/time/notes/visibility). There is no
// durable multi-court group identity in this schema (see the Phase 30D
// audit) — this always edits exactly the one reservation row the admin
// clicked, never a reconstructed "group." Calls update_maintenance_block,
// which performs one in-place UPDATE and returns which fields actually
// changed. No notification is ever dispatched — maintenance blocks have no
// participant/customer to notify.
// ---------------------------------------------------------------------------
interface UpdateMaintenanceBlockResult {
  reservation:      Record<string, unknown>;
  changed_fields:   string[];
}

export async function updateMaintenanceBlock(params: {
  p_reservation_id:        string;
  p_expected_updated_at:   string;
  p_court_id:              string;
  p_starts_at:             string;
  p_ends_at:               string;
  p_notes?:                string | null;
  p_show_notes_to_members: boolean;
  expectedClubId:          string;
}): Promise<{ data?: { changedFields: string[] }; error?: { code?: string; message: string } }> {
  const { expectedClubId, ...rpcParams } = params;
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: { message: guard.error } };

  const supabase = await createClient();

  const { data, error } = await supabase.rpc("update_maintenance_block", {
    ...rpcParams,
    p_expected_club_id: expectedClubId,
  });
  if (error) return { error: { code: error.code, message: error.message } };

  const result = data as unknown as UpdateMaintenanceBlockResult | null;
  const changedFields = result?.changed_fields ?? [];

  revalidatePath("/calendar");

  return { data: { changedFields } };
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
// updateMemberReservationAdmin
// Phase 30B1: admin-only edit of a single confirmed member_booking
// reservation. Calls update_member_reservation, which performs one genuine
// UPDATE (never cancel-and-recreate) and returns the updated reservation
// plus which fields actually changed and the id of any material
// (court/date/time) notification it inserted. Best-effort email/SMS
// dispatch runs only after the DB transaction has already committed, and
// only when the RPC reports a material notification was created — never
// for notes/format/player_count/guest_names-only edits.
// ---------------------------------------------------------------------------
export async function updateMemberReservationAdmin(params: {
  p_reservation_id:      string;
  p_expected_updated_at: string;
  p_court_id:            string;
  p_starts_at:           string;
  p_ends_at:             string;
  p_format?:             string | null;
  p_player_count?:       number | null;
  p_guest_names?:        string[] | null;
  p_notes?:              string | null;
  expectedClubId:        string;
}): Promise<{ data?: { changedFields: string[] }; error?: { code?: string; message: string } }> {
  const { expectedClubId, ...rpcParams } = params;
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: { message: guard.error } };

  const supabase = await createClient();

  const { data, error } = await supabase.rpc("update_member_reservation", {
    ...rpcParams,
    p_expected_club_id: expectedClubId,
  });
  if (error) return { error: { code: error.code, message: error.message } };

  const result = data as unknown as UpdateMemberReservationResult | null;
  const changedFields   = result?.changed_fields ?? [];
  const notificationId  = result?.notification_id ?? null;
  const ownerUserId     = result?.reservation.owner_user_id;

  if (notificationId && ownerUserId) {
    try {
      await dispatchReservationRescheduledSms(notificationId, ownerUserId);
    } catch {
      // SMS dispatch must never block edit success or surface to the user.
    }

    try {
      await dispatchReservationRescheduledEmail(notificationId, ownerUserId);
    } catch {
      // Email dispatch must never block edit success or surface to the user.
    }
  }

  revalidatePath("/calendar");
  revalidatePath("/my-schedule");

  return { data: { changedFields } };
}

// ---------------------------------------------------------------------------
// dispatchReservationRescheduledSms / dispatchReservationRescheduledEmail
// — internal, not exported.
// Driven by the exact notification_id returned by update_member_reservation
// — never re-queries "newest matching kind", since a fast second edit could
// otherwise pick up the wrong row.
// ---------------------------------------------------------------------------
async function dispatchReservationRescheduledSms(
  notificationId: string,
  ownerUserId:    string,
): Promise<void> {
  const supabase = await createClient();

  const { data: notification } = await supabase
    .from("notifications")
    .select("id, body")
    .eq("id", notificationId)
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

async function dispatchReservationRescheduledEmail(
  notificationId: string,
  ownerUserId:    string,
): Promise<void> {
  const supabase = await createClient();

  const { data: notification } = await supabase
    .from("notifications")
    .select("id, body")
    .eq("id", notificationId)
    .single();

  if (!notification) return;

  await sendEmailNotification(
    supabase,
    notification.id,
    ownerUserId,
    "reservation_rescheduled",
    (clubName) => reservationRescheduledTemplate(clubName, notification.body),
  );
}

// ---------------------------------------------------------------------------
// notifyMemberReservationCancelled
// Superseded by cancel_member_reservation (Phase 30B1), which now performs
// the notification insert inline as part of the same transaction as the
// cancellation. The underlying notify_reservation_cancelled_by_member RPC
// remains in the database for compatibility, but nothing in this codebase
// calls this wrapper anymore — kept for compatibility, not deleted.
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

  // This compatibility-only path has no notification_id to work with (the
  // RPC it calls returns void) — it preserves its own original "newest
  // matching kind" lookup, decoupled from the notification_id-driven
  // dispatch helpers the new cancel_member_reservation path uses.
  const { data: notification } = await supabase
    .from("notifications")
    .select("id")
    .eq("user_id", userId)
    .eq("kind", "reservation_cancelled_by_member")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (!notification) return;

  try {
    await dispatchMemberCancelSms(userId, notification.id);
  } catch {
    // SMS dispatch must never block or surface errors.
  }

  try {
    await dispatchMemberCancelEmail(userId, notification.id);
  } catch {
    // Email dispatch must never block or surface errors.
  }
}

// ---------------------------------------------------------------------------
// dispatchMemberCancelSms — internal, not exported
// Phase 30B1: driven by the exact notification_id returned by
// cancel_member_reservation (never a "newest matching kind" re-query — a
// fast second cancellation elsewhere could otherwise pick up the wrong
// row). Checks the member's SMS eligibility, sends if opted in, and
// records the delivery attempt. Mirrors dispatchAdminCancelSms exactly.
// ---------------------------------------------------------------------------
async function dispatchMemberCancelSms(ownerUserId: string, notificationId: string): Promise<void> {
  const supabase = await createClient();

  const { data: notification } = await supabase
    .from("notifications")
    .select("id, body")
    .eq("id", notificationId)
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

async function dispatchMemberCancelEmail(ownerUserId: string, notificationId: string): Promise<void> {
  const supabase = await createClient();

  const { data: notification } = await supabase
    .from("notifications")
    .select("id, body")
    .eq("id", notificationId)
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
// Phase 30B1: Member or Pro self-cancel for a confirmed member_booking
// reservation, via the cancel_member_reservation RPC. All cancellation-
// window/grace-period enforcement now happens server-side inside Postgres
// (see supabase/migrations/0097) — this action no longer computes it in
// TypeScript, and no longer performs a raw `reservations` table UPDATE.
// Admin cancellation is unaffected and continues through
// adminCancelReservation / admin_cancel_reservation.
// Revalidates both /calendar and /my-schedule to keep both views fresh.
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

  const { data, error: rpcError } = await supabase.rpc("cancel_member_reservation", {
    p_reservation_id:   reservationId,
    p_expected_club_id: expectedClubId,
  });

  if (rpcError) return { error: rpcError.message };

  const result = data as unknown as ReservationMutationResult | null;
  const notificationId = result?.notification_id ?? null;

  if (notificationId) {
    try {
      await dispatchMemberCancelSms(user.id, notificationId);
    } catch {
      // SMS dispatch must never block or surface errors.
    }

    try {
      await dispatchMemberCancelEmail(user.id, notificationId);
    } catch {
      // Email dispatch must never block or surface errors.
    }
  }

  revalidatePath("/calendar");
  revalidatePath("/my-schedule");
  return {};
}
