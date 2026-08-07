// Server-only. Do not import from client components.
//
// Phase 31C shared dispatch orchestration for the reservation, event, and
// waitlist domains. Each function here takes the EXACT notification_id
// already returned by a Phase 31B mutation RPC (admin_cancel_reservation_v2,
// update_member_reservation, cancel_event, update_event, leave_event_v2,
// admin_force_confirm, admin_offer_spot) and resolves delivery context
// through the matching domain-scoped SECURITY DEFINER RPC from migration
// 0102 — never a raw `supabase.from("notifications").select(...)`, never a
// "newest matching kind" or created_at-window re-query.
//
// This intentionally stays THREE narrow, domain-specific functions rather
// than one generalized "dispatch any notification" helper: each function
// calls exactly one Phase 31B delivery-context RPC
// (get_reservation_delivery_context / get_event_delivery_context /
// get_waitlist_delivery_context), preserving the domain-specific
// authorization boundaries those RPCs establish rather than bypassing them
// behind a single, broader entry point.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/db/types";
import { sendEmailNotification } from "@/lib/email";
import { dispatchSmsNotification } from "@/lib/sms";
import {
  reservationCancelledByAdminTemplate,
  reservationRescheduledTemplate,
  eventCancelledTemplate,
  eventUpdatedTemplate,
  waitlistOfferTemplate,
  waitlistPromotedTemplate,
} from "@/lib/email-templates";

interface DeliveryContext {
  notification_id:   string;
  recipient_user_id: string;
  club_id:            string;
  kind:                string;
  body:                string;
  metadata:              Json | null;
}

// ---------------------------------------------------------------------------
// dispatchReservationNotification
// Domains: reservation_cancelled_by_admin (adminCancelReservation),
// reservation_rescheduled (updateMemberReservationAdmin).
// Fetches body/authorization via get_reservation_delivery_context. SMS
// contact resolution now goes through get_reservation_recipient_sms_contact
// (migration 0103) — a narrowly-scoped, exact-identity, SECURITY DEFINER
// RPC authorized identically to get_reservation_delivery_context — never a
// raw profiles read (removed in the Phase 31C SMS-reliability correction,
// which confirmed that path was not pilot-reliable). Email resolution stays
// get_user_email_for_notification (safe: the caller was already authorized
// by get_reservation_delivery_context before this point, and that RPC
// independently re-confirms recipient/admin standing).
// ---------------------------------------------------------------------------
export async function dispatchReservationNotification(
  supabase:       SupabaseClient<Database>,
  notificationId: string,
): Promise<void> {
  const { data } = await supabase.rpc("get_reservation_delivery_context", {
    p_notification_id: notificationId,
  });
  const context = data as unknown as DeliveryContext | null;
  if (!context) return;

  const template =
    context.kind === "reservation_cancelled_by_admin" ? reservationCancelledByAdminTemplate :
    context.kind === "reservation_rescheduled"         ? reservationRescheduledTemplate :
    null;
  if (!template) return; // defensive — the context RPC already restricts kind to this domain

  try {
    await dispatchSmsNotification(supabase, context.notification_id, context.body, "reservation");
  } catch {
    // SMS dispatch must never surface as a user-facing error.
  }

  try {
    await sendEmailNotification(
      supabase,
      context.notification_id,
      context.recipient_user_id,
      context.kind,
      (clubName) => template(clubName, context.body),
    );
  } catch {
    // Email dispatch must never surface as a user-facing error.
  }
}

// ---------------------------------------------------------------------------
// dispatchEventNotification
// Domains: event_cancelled (cancelEvent, per notified participant),
// event_updated (updateEventAdmin, per notified participant).
// Fetches body/authorization via get_event_delivery_context, which
// authorizes the recipient, any same-club Admin, or — for a Pro actor —
// only the creator-Pro of the specific event referenced in the
// notification's own metadata.event_id. SMS contact resolution goes through
// get_event_recipient_sms_contact (migration 0103), authorized identically
// — never a raw profiles read; see dispatchReservationNotification's note
// above for why.
// ---------------------------------------------------------------------------
export async function dispatchEventNotification(
  supabase:       SupabaseClient<Database>,
  notificationId: string,
): Promise<void> {
  const { data } = await supabase.rpc("get_event_delivery_context", {
    p_notification_id: notificationId,
  });
  const context = data as unknown as DeliveryContext | null;
  if (!context) return;

  const template =
    context.kind === "event_cancelled" ? eventCancelledTemplate :
    context.kind === "event_updated"   ? eventUpdatedTemplate :
    null;
  if (!template) return; // defensive — the context RPC already restricts kind to this domain

  try {
    await dispatchSmsNotification(supabase, context.notification_id, context.body, "event");
  } catch {
    // SMS dispatch must never surface as a user-facing error.
  }

  try {
    await sendEmailNotification(
      supabase,
      context.notification_id,
      context.recipient_user_id,
      context.kind,
      (clubName) => template(clubName, context.body),
    );
  } catch {
    // Email dispatch must never surface as a user-facing error.
  }
}

// ---------------------------------------------------------------------------
// dispatchWaitlistNotification
// Domains: waitlist_offer (leave_event_v2's peer-triggered offer,
// admin_offer_spot), waitlist_promoted (admin_force_confirm; the
// self-triggered accept_waitlist_offer path is unchanged and out of scope
// for this checkpoint — see report).
//
// notificationId is nullable because leave_event_v2 legitimately returns
// null when the leaving Member's departure created no offer (they were
// waitlisted, not confirmed/offered, or no one was waiting) — in that case
// no delivery attempt of any kind should occur, which this function's
// early return guarantees.
//
// Fetches body/authorization via get_waitlist_delivery_context, which
// authorizes the recipient, any same-club Admin, or the exact actor
// recorded in metadata.triggered_by (the Member who called leave_event, or
// the Admin/Pro who called admin_offer_spot / admin_force_confirm) — never
// any other same-club Member or unrelated Pro. Contact resolution for BOTH
// channels uses the narrow waitlist-specific RPCs
// (get_waitlist_recipient_email / get_waitlist_recipient_sms_contact), never
// get_user_email_for_notification or a raw profiles read — a Member
// triggering a peer's waitlist offer must never resolve that peer's contact
// info through broader same-club access.
// ---------------------------------------------------------------------------
export async function dispatchWaitlistNotification(
  supabase:       SupabaseClient<Database>,
  notificationId: string | null,
): Promise<void> {
  if (!notificationId) return; // no offer/promotion was created — no delivery attempt

  const { data } = await supabase.rpc("get_waitlist_delivery_context", {
    p_notification_id: notificationId,
  });
  const context = data as unknown as DeliveryContext | null;
  if (!context) return; // unauthorized or not found

  const template =
    context.kind === "waitlist_offer"    ? waitlistOfferTemplate :
    context.kind === "waitlist_promoted" ? waitlistPromotedTemplate :
    null;
  if (!template) return; // defensive — the context RPC already restricts kind to this domain

  try {
    await dispatchSmsNotification(supabase, context.notification_id, context.body, "waitlist");
  } catch {
    // SMS dispatch must never surface as a user-facing error.
  }

  try {
    await sendEmailNotification(
      supabase,
      context.notification_id,
      context.recipient_user_id,
      context.kind,
      (clubName) => template(clubName, context.body),
      "get_waitlist_recipient_email",
    );
  } catch {
    // Email dispatch must never surface as a user-facing error.
  }
}
