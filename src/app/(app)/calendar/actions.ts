"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { assertActiveClub } from "@/lib/supabase/staleClub";
import { sendSms } from "@/lib/sms";
import { sendEmailNotification, sendRosterOperationalEmail } from "@/lib/email";
import {
  reservationConfirmedTemplate,
  reservationCancelledByMemberTemplate,
  eventJoinedTemplate,
  waitlistPromotedTemplate,
  rosterOperationalEmailTemplate,
} from "@/lib/email-templates";
import {
  dispatchReservationNotification,
  dispatchEventNotification,
  dispatchWaitlistNotification,
} from "@/lib/notification-dispatch";

// ---------------------------------------------------------------------------
// Shared result shape for update_member_reservation / cancel_member_reservation
// — both RPCs return jsonb of this shape (see supabase/migrations/0097).
// Only the fields actually consumed here are typed; the reservation payload
// itself is passed straight through to callers as an unknown-shaped record.
// ---------------------------------------------------------------------------
interface ReservationMutationResult {
  reservation: Record<string, unknown> & {
    owner_user_id:     string | null;
    roster_member_id:  string | null;
    starts_at:         string;
  };
  notification_id: string | null;
}

interface UpdateMemberReservationResult extends ReservationMutationResult {
  changed_fields: string[];
}

// Phase 33E3: shared date formatter for no-account operational email body
// text — mirrors the exact `to_char(x at time zone tz, 'Mon DD "at" HH12:MI
// AM')` format the SQL layer already uses for account-based notification
// bodies, so a no-account Member's email reads identically to a claimed
// Member's. Fetches the club's IANA timezone (clubs.timezone, RLS-readable)
// rather than assuming the server/browser timezone.
async function formatClubDateTime(
  supabase: Awaited<ReturnType<typeof createClient>>,
  clubId:   string,
  iso:      string,
): Promise<string> {
  const { data: club } = await supabase.from("clubs").select("timezone").eq("id", clubId).single();
  const timeZone = club?.timezone || "America/New_York";
  return new Date(iso).toLocaleString("en-US", {
    timeZone,
    month:  "short",
    day:    "2-digit",
    hour:   "numeric",
    minute: "2-digit",
    hour12: true,
  }).replace(",", " at");
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
// adminCreateMemberReservation
// Phase 33C2: staff books a member_booking reservation on behalf of a roster
// Member — claimed (has an account) or unclaimed (no-account). Wraps
// admin_create_member_reservation (0108), which independently re-verifies
// admin authorization and resolves/validates the target roster identity
// server-side — this action never derives or trusts a client-supplied
// owner identity, only forwards p_roster_member_id.
//
// Phase 33E3: sends a no-account operational confirmation email after the
// mutation has already committed. sendRosterOperationalEmail resolves the
// recipient's email itself (get_roster_member_email_for_notification
// returns null for a claimed identity, so this is always a safe no-op for
// an account-backed Member — no dual-send risk, no need to branch on claim
// status here). Never blocks or fails the booking: any error is caught and
// swallowed, matching every other non-blocking dispatch in this file.
// ---------------------------------------------------------------------------
export async function adminCreateMemberReservation(params: {
  p_court_id:         string;
  p_starts_at:        string;
  p_ends_at:          string;
  p_roster_member_id: string;
  p_format?:          string | null;
  p_player_count?:    number | null;
  p_guest_names?:     string[] | null;
  p_notes?:           string | null;
  expectedClubId:     string;
}): Promise<{ error?: { code?: string; message: string } }> {
  const { expectedClubId, ...rpcParams } = params;
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: { message: guard.error } };

  const supabase = await createClient();

  const { error } = await supabase.rpc("admin_create_member_reservation", {
    ...rpcParams,
    p_expected_club_id: expectedClubId,
  });
  if (error) return { error: { code: error.code, message: error.message } };

  try {
    const when = await formatClubDateTime(supabase, expectedClubId, params.p_starts_at);
    await sendRosterOperationalEmail(
      supabase,
      params.p_roster_member_id,
      expectedClubId,
      "reservation_confirmed",
      (clubName) => rosterOperationalEmailTemplate(
        clubName,
        `Court booked — ${clubName}`,
        `Your court reservation was booked for ${when}.`,
      ),
    );
  } catch {
    // Email dispatch must never block booking success or surface to the user.
  }

  revalidatePath("/calendar");

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
// Phase 31C: calls admin_cancel_reservation_v2 (migration 0102, bug-fixed in
// 0119 — see below), which returns the exact notification_id it created
// alongside the reservation — replacing admin_cancel_reservation, whose
// reservation-only return gave the caller no safe way to look up its
// notification (the previous raw `notifications` SELECT by user_id/kind was
// blocked by RLS for this cross-user admin-initiated case; see Phase
// 31A/31B). Dispatch runs through dispatchReservationNotification, which
// resolves body/authorization via get_reservation_delivery_context instead
// of any client-side notifications query.
//
// Phase 33E3: 0119 fixed a latent crash in admin_cancel_reservation_v2 —
// its notification insert was unconditional even though reservations.
// owner_user_id has been nullable since 0108 (a no-account Member's staff-
// created reservation), so cancelling one previously raised a NOT NULL
// violation and rolled back the entire cancellation. Now notification_id is
// null (not a crash) for that case, and the no-account operational email
// path below covers it — no in-app notification exists for a no-account
// Member, matching the reservation-confirmation path above.
// ---------------------------------------------------------------------------
export async function adminCancelReservation(
  reservationId: string,
  expectedClubId: string,
): Promise<{ error?: string }> {
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: guard.error };

  const supabase = await createClient();

  const { data, error: rpcError } = await supabase.rpc(
    "admin_cancel_reservation_v2",
    { p_reservation_id: reservationId }
  );

  if (rpcError) return { error: rpcError.message };

  const result = data as unknown as ReservationMutationResult | null;
  if (!result?.reservation) return { error: "reservation_not_found" };

  if (result.notification_id) {
    try {
      await dispatchReservationNotification(supabase, result.notification_id);
    } catch {
      // Email/SMS dispatch must never surface as a user-facing error.
    }
  } else if (!result.reservation.owner_user_id && result.reservation.roster_member_id) {
    try {
      const when = await formatClubDateTime(supabase, expectedClubId, result.reservation.starts_at);
      await sendRosterOperationalEmail(
        supabase,
        result.reservation.roster_member_id,
        expectedClubId,
        "reservation_cancelled_by_admin",
        (clubName) => rosterOperationalEmailTemplate(
          clubName,
          `Your booking was cancelled — ${clubName}`,
          `Your reservation on ${when} was cancelled by the club.`,
        ),
      );
    } catch {
      // Email dispatch must never surface as a user-facing error.
    }
  }

  return {};
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
  // Phase 33C2 completion (0109): the Member this reservation is for.
  // Always sent — the current value when unchanged, a different roster
  // identity when the admin is reassigning. owner_user_id is derived
  // server-side from this row's own claimed_by; never sent from here.
  p_roster_member_id:    string;
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

  // Phase 31C: dispatch runs through dispatchReservationNotification, which
  // resolves body/authorization via get_reservation_delivery_context using
  // the exact notification_id above — no raw notifications SELECT, never a
  // "newest matching kind" re-query (which could otherwise pick up the
  // wrong row on a fast second edit).
  if (notificationId) {
    try {
      await dispatchReservationNotification(supabase, notificationId);
    } catch {
      // Email/SMS dispatch must never block edit success or surface to the user.
    }
  } else if (
    !result?.reservation.owner_user_id
    && result?.reservation.roster_member_id
    && changedFields.some(f => f === "court_id" || f === "starts_at" || f === "ends_at")
  ) {
    // Phase 33E3: update_member_reservation (0109) only creates a
    // notification when the owner is claimed AND a scheduling field
    // changed — for a no-account owner it silently skips (matching 0109's
    // own documented, deliberate deferral). changed_fields is already
    // returned regardless of claim status, so the material-change signal
    // is detected here purely from existing data — no SQL change needed.
    try {
      const when = await formatClubDateTime(supabase, expectedClubId, result.reservation.starts_at);
      await sendRosterOperationalEmail(
        supabase,
        result.reservation.roster_member_id,
        expectedClubId,
        "reservation_rescheduled",
        (clubName) => rosterOperationalEmailTemplate(
          clubName,
          `Booking rescheduled — ${clubName}`,
          `Your reservation was rescheduled to ${when}.`,
        ),
      );
    } catch {
      // Email dispatch must never block edit success or surface to the user.
    }
  }

  revalidatePath("/calendar");
  revalidatePath("/my-schedule");

  return { data: { changedFields } };
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
// Phase 31C: calls leave_event_v2 (migration 0102) instead of leave_event.
// leave_event_v2 shares leave_event's exact business logic (both delegate to
// the same internal _leave_event_impl — never called directly by the app)
// but additionally returns the exact notification_id of any waitlist_offer
// it created, replacing the previous "5-candidate metadata match" lookup
// (which was also blocked by RLS for this Member-to-Member cross-user case
// — see Phase 31A/31B). Returns the raw RPC error message so callers can
// map it to UI strings; external behavior is otherwise unchanged.
// ---------------------------------------------------------------------------
export async function leaveEvent(
  eventId: string,
  expectedClubId: string,
): Promise<{ error?: string }> {
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: guard.error };

  const supabase = await createClient();

  const { data, error: rpcError } = await supabase.rpc(
    "leave_event_v2",
    { p_event_id: eventId }
  );

  if (rpcError) return { error: rpcError.message };

  const result = data as unknown as { offered_profile_id: string | null; notification_id: string | null } | null;

  try {
    await dispatchWaitlistNotification(supabase, result?.notification_id ?? null);
  } catch {
    // Email/SMS dispatch must never surface as a user-facing error.
  }

  return {};
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
// Phase 31C: cancel_event (migration 0102) now returns the exact
// {notification_id, user_id} pair for every confirmed/waitlisted/offered
// participant it notified, captured before any participant-status mutation
// runs (fixing a bug in 0102's first draft that silently excluded offered
// participants) — replacing the previous 5-second created_at-window
// re-query, which was both racy across concurrent cancellations and blocked
// by RLS for every recipient other than the actor. The actor is still
// excluded from email/SMS (they already received their in-app notification
// as a participant, if applicable) even though they are never excluded from
// the returned array itself.
// ---------------------------------------------------------------------------
interface CancelEventResult {
  event:         Record<string, unknown>;
  notifications: Array<{ notification_id: string; user_id: string }>;
}

export async function cancelEvent(
  eventId: string,
  expectedClubId: string,
): Promise<{ error?: string }> {
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: guard.error };

  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  const actorUserId = user?.id ?? null;

  const { data, error: rpcError } = await supabase.rpc("cancel_event", {
    p_event_id: eventId,
  });

  if (rpcError) return { error: rpcError.message };

  const result = data as unknown as CancelEventResult | null;
  const notifications = result?.notifications ?? [];

  for (const { notification_id, user_id } of notifications) {
    // Do not email/SMS the actor even though they may appear in the
    // returned array (e.g. a host who was also a confirmed participant).
    if (user_id === actorUserId) continue;

    try {
      await dispatchEventNotification(supabase, notification_id);
    } catch {
      // Email/SMS dispatch must never surface as a user-facing error.
    }
  }

  return {};
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
