// Server-only. Do not import from client components.
import twilio from "twilio";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db/types";

export async function sendSms(
  to: string,
  body: string
): Promise<{ sid: string | null; error: string | null }> {
  const accountSid  = process.env.TWILIO_ACCOUNT_SID;
  const authToken   = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber  = process.env.TWILIO_FROM_NUMBER;

  if (!accountSid || !authToken || !fromNumber) {
    return { sid: null, error: "SMS is not configured." };
  }

  try {
    const message = await twilio(accountSid, authToken).messages.create({
      to,
      from: fromNumber,
      body,
    });
    return { sid: message.sid, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { sid: null, error: message };
  }
}

// CONTACT_RESOLUTION_FAILED — the exact, safe (non-sensitive, no raw
// database error text, no credentials) message recorded when the
// recipient's SMS contact info cannot be resolved for any reason — an RPC
// error or a genuinely unauthorized/missing result. Never expose the
// underlying Postgres/PostgREST error text here; that detail belongs only
// in the server console log written by recordSmsDeliveryAttempt below, and
// even there only as a fixed category, never interpolated raw.
const CONTACT_RESOLUTION_FAILED = "Recipient SMS contact could not be resolved.";

type SmsDeliveryStatus = "sent" | "failed" | "opted_out" | "no_phone";

// recordSmsDeliveryAttempt — every record_delivery_attempt call in this file
// goes through here so its own returned error is always inspected (Phase
// 31C SMS-reliability correction requirement). A failure to WRITE the
// delivery-log row must never surface to the user or roll back the
// business mutation that already succeeded — it is logged server-side only,
// as a fixed safe category plus the notification id, never the raw
// Postgres/PostgREST error text, phone number, credentials, or provider
// payload.
async function recordSmsDeliveryAttempt(
  supabase:       SupabaseClient<Database>,
  notificationId: string,
  status:         SmsDeliveryStatus,
  extra?: {
    provider?:           string;
    providerMessageId?:  string;
    error?:              string;
    sentAt?:             string;
  },
): Promise<void> {
  const { error: recordError } = await supabase.rpc("record_delivery_attempt", {
    p_notification_id:     notificationId,
    p_channel:             "sms",
    p_status:              status,
    p_provider:            extra?.provider,
    p_provider_message_id: extra?.providerMessageId,
    p_error:               extra?.error,
    p_sent_at:             extra?.sentAt,
  });
  if (recordError) {
    console.error(
      `[sms-dispatch] record_delivery_attempt failed (category: delivery_log_write_failed, status: ${status}, notification: ${notificationId})`
    );
  }
}

// dispatchSmsNotification — shared delivery helper consolidating the SMS
// contact-check/duplicate-check/send/log sequence that was previously
// duplicated inline at every SMS call site (~9 near-identical copies across
// calendar/actions.ts and admin/events/actions.ts prior to Phase 31C).
//
// `domain` is explicit and required — reservation/event/waitlist — never a
// generic "profile" fallback. Each domain resolves the recipient's
// phone/sms_opt_in through its own narrowly-scoped, exact-identity,
// SECURITY DEFINER RPC (migrations 0102/0103), authorized identically to
// that domain's delivery-context RPC:
//   - "reservation" → get_reservation_recipient_sms_contact (0103)
//   - "event"       → get_event_recipient_sms_contact (0103)
//   - "waitlist"    → get_waitlist_recipient_sms_contact (0102)
// None of these reads profiles directly from application code — the raw
// `supabase.from("profiles").select(...)` cross-user contact read used
// through Phase 31C's first cutover round is removed entirely. That read
// was authorized only by profiles_select_same_club RLS, whose same-club
// branch resolves via current_user_club_id() (the active-membership helper,
// 0082) — a different mechanism than the one get_user_email_for_notification
// uses to authorize the email side of the exact same dispatch (a direct
// profiles.club_id/role read for the caller, 0055). Two confirmed local
// reproductions showed email succeeding while that raw SMS contact read
// produced no delivery attempt at all; migration 0103 replaces it for
// every domain with the same purpose-built RPC pattern already used for
// waitlist.
//
// Before contacting Twilio, sms_already_delivered() (0103) is checked —
// pilot-level best-effort idempotency mirroring email_already_delivered's
// role for email. If it reports true, this function returns without
// sending another text and without writing another delivery row (an
// existing 'sent' row already makes the operation idempotently complete).
// If the check itself errors, dispatch proceeds rather than blocking a
// legitimate send on a non-critical guard's failure — the eventual
// send/log step still runs and is itself safe to repeat at the schema's
// current best-effort tolerance.
//
// Invariant: once an exact notification ID reaches this function, exactly
// one notification_deliveries row for the 'sms' channel is written for
// this attempt, with status one of sent/failed/opted_out/no_phone — never
// a silent return — unless sms_already_delivered() already confirms the
// operation is idempotently complete, in which case zero further rows are
// written by design.
//
// No configuration guard: if Twilio env vars are absent, sendSms() itself
// returns an error, which this function records as a 'failed' delivery
// attempt — this mirrors the exact pre-Phase-31C behavior for every SMS
// dispatch site (unlike email, SMS dispatch has never short-circuited
// silently on missing configuration). Never throws.
export async function dispatchSmsNotification(
  supabase:        SupabaseClient<Database>,
  notificationId:  string,
  body:            string,
  domain:          "reservation" | "event" | "waitlist",
): Promise<void> {
  const { data: alreadyDelivered } = await supabase.rpc("sms_already_delivered", {
    p_notification_id: notificationId,
  });
  if (alreadyDelivered) return;

  const contactRpc =
    domain === "reservation" ? "get_reservation_recipient_sms_contact" :
    domain === "event"       ? "get_event_recipient_sms_contact" :
    "get_waitlist_recipient_sms_contact";

  const { data, error: contactError } = await supabase.rpc(contactRpc, {
    p_notification_id: notificationId,
  });
  const contact = data as { phone: string | null; sms_opt_in: boolean } | null;
  if (contactError || !contact) {
    await recordSmsDeliveryAttempt(supabase, notificationId, "failed", {
      error: CONTACT_RESOLUTION_FAILED,
    });
    return;
  }
  const { phone, sms_opt_in: smsOptIn } = contact;

  if (!smsOptIn) {
    await recordSmsDeliveryAttempt(supabase, notificationId, "opted_out");
    return;
  }

  if (!phone) {
    await recordSmsDeliveryAttempt(supabase, notificationId, "no_phone");
    return;
  }

  const smsBody = `${body}\n\nReply STOP to opt out.`;
  const { sid, error: smsError } = await sendSms(phone, smsBody);

  if (sid) {
    await recordSmsDeliveryAttempt(supabase, notificationId, "sent", {
      provider:          "twilio",
      providerMessageId: sid,
      sentAt:            new Date().toISOString(),
    });
  } else {
    await recordSmsDeliveryAttempt(supabase, notificationId, "failed", {
      provider: "twilio",
      error:    smsError ?? "Unknown error",
    });
  }
}
