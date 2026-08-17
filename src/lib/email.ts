// Server-only. Do not import from client components.
import { Resend } from "resend";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db/types";

const FROM = "Court Time <no-reply@court-time.app>";

export async function sendEmail(
  to:      string,
  subject: string,
  html:    string,
  text:    string,
): Promise<{ messageId: string | null; error: string | null }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { messageId: null, error: "Email is not configured." };

  try {
    const resend = new Resend(apiKey);
    const { data, error } = await resend.emails.send({ from: FROM, to, subject, html, text });
    if (error) return { messageId: null, error: error.message };
    return { messageId: data?.id ?? null, error: null };
  } catch (err) {
    return { messageId: null, error: err instanceof Error ? err.message : String(err) };
  }
}

// sendEmailNotification — shared delivery helper for every email-eligible
// notification kind, across every domain (reservation, event, waitlist,
// announcement, lesson templates aside — lessons use their own dispatcher).
//
// Guards (in order):
//   1. RESEND_API_KEY absent → return (avoids spurious 'failed' rows in
//      notification_deliveries for unconfigured environments).
//   2. Duplicate-send check via email_already_delivered() (security definer,
//      bypasses admin-only RLS on notification_deliveries) → return if sent.
//   3. Preference check via user_pref_enabled() (security definer, works
//      cross-user) → record opted_out + return if disabled.
//   4. Email fetch via `emailLookupRpc` (security definer) → return if null.
//
// Phase 31C: `emailLookupRpc` selects which security-definer RPC resolves
// the recipient's email address. Both share the identical
// `{ p_notification_id }` argument shape and `string | null` return type:
//   - get_user_email_for_notification (default) — authorizes the caller as
//     the recipient OR admin/pro. Correct for reservation, event, and
//     announcement domains, where the calling Server Action has already
//     been gated by get_reservation_delivery_context / get_event_delivery_
//     context (or is itself the Admin who ran send_announcement_v2) before
//     this function is ever reached — so by the time this resolves, the
//     caller's authorization has already been independently established.
//   - get_waitlist_recipient_email — required for the waitlist domain,
//     where the acting caller triggering a delivery (e.g. a Member calling
//     leave_event) is frequently neither the recipient nor admin/pro, which
//     get_user_email_for_notification would deny (see migration 0102,
//     section 5). Authorizes recipient / same-club Admin / the exact
//     metadata.triggered_by actor instead.
// Never throws.
export async function sendEmailNotification(
  supabase:        SupabaseClient<Database>,
  notificationId:  string,
  recipientUserId: string,
  kind:            string,
  buildTemplate:   (clubName: string) => { subject: string; html: string; text: string },
  emailLookupRpc:  "get_user_email_for_notification" | "get_waitlist_recipient_email" = "get_user_email_for_notification",
): Promise<void> {
  // Guard 1: skip entirely if Resend is not configured.
  if (!process.env.RESEND_API_KEY) return;

  // Guard 2: duplicate-send check — skip if an email was already successfully
  // sent for this notification. email_already_delivered() is security definer
  // and readable by any authenticated role including regular members.
  const { data: alreadySent } = await supabase.rpc("email_already_delivered", {
    p_notification_id: notificationId,
  });
  if (alreadySent) return;

  // Guard 3: preference check — user_pref_enabled() is security definer and
  // works cross-user (e.g. admin cancelling a member's reservation). Default
  // ON: a missing row returns true, so new kinds are enabled without any action.
  const { data: prefEnabled } = await supabase.rpc("user_pref_enabled", {
    p_user_id: recipientUserId,
    p_kind:    kind,
  });
  if (prefEnabled === false) {
    await supabase.rpc("record_delivery_attempt", {
      p_notification_id: notificationId,
      p_channel:         "email",
      p_status:          "opted_out",
    });
    return;
  }

  // Guard 4: fetch recipient email via the selected notification-scoped
  // security-definer RPC (see emailLookupRpc doc above). Returns null on any
  // authorization failure.
  const { data: recipientEmail } = await supabase.rpc(emailLookupRpc, {
    p_notification_id: notificationId,
  });
  if (!recipientEmail) return;

  // Fetch club name for the template (club_id on profiles is safe to read
  // for own profile or admin context).
  let clubName = "Court Time";
  const { data: profile } = await supabase
    .from("profiles")
    .select("club_id")
    .eq("id", recipientUserId)
    .single();
  if (profile?.club_id) {
    const { data: club } = await supabase
      .from("clubs")
      .select("name")
      .eq("id", profile.club_id)
      .single();
    if (club?.name) clubName = club.name;
  }

  const { subject, html, text } = buildTemplate(clubName);
  const { messageId, error: emailError } = await sendEmail(recipientEmail, subject, html, text);

  if (messageId) {
    await supabase.rpc("record_delivery_attempt", {
      p_notification_id:     notificationId,
      p_channel:             "email",
      p_status:              "sent",
      p_provider:            "resend",
      p_provider_message_id: messageId,
      p_sent_at:             new Date().toISOString(),
    });
  } else {
    await supabase.rpc("record_delivery_attempt", {
      p_notification_id: notificationId,
      p_channel:         "email",
      p_status:          "failed",
      p_provider:        "resend",
      p_error:           emailError ?? "Unknown error",
    });
  }
}

// sendRosterOperationalEmail — Phase 33E3. Operational (transactional)
// email for a no-account roster Member (roster_members.claimed_by IS
// NULL). Deliberately NOT a variant of sendEmailNotification: there is no
// notifications row (no user_id exists to attach one to), no
// notification_preferences row can exist for an unclaimed identity either,
// so this is unconditional/always-on — the same posture "mandatory" kinds
// already have for account-backed Members — and must NEVER be used for
// announcement/marketing kinds (those stay account/preferences-based only,
// per product scope). Recipient identity is always roster_member_id, never
// a fabricated or guessed email.
//
// Guards (in order):
//   1. RESEND_API_KEY absent → return.
//   2. Email resolution via get_roster_member_email_for_notification
//      (SECURITY DEFINER, admin/pro same-club, returns null for a claimed
//      identity, a missing email, or any authorization failure) → return if
//      null. Never crashes, never fabricates a recipient.
// Delivery outcome is recorded via record_roster_operational_email
// (audit_log-backed — see migration 0119) rather than notification_
// deliveries, which is notification_id-keyed and cannot represent this
// recipient. Never throws.
export async function sendRosterOperationalEmail(
  supabase:        SupabaseClient<Database>,
  rosterMemberId:  string,
  expectedClubId:  string,
  kind:            string,
  buildTemplate:   (clubName: string) => { subject: string; html: string; text: string },
): Promise<void> {
  if (!process.env.RESEND_API_KEY) return;

  const { data: email } = await supabase.rpc("get_roster_member_email_for_notification", {
    p_roster_member_id: rosterMemberId,
    p_expected_club_id: expectedClubId,
  });
  if (!email) return;

  let clubName = "Court Time";
  const { data: club } = await supabase.from("clubs").select("name").eq("id", expectedClubId).single();
  if (club?.name) clubName = club.name;

  const { subject, html, text } = buildTemplate(clubName);
  const { messageId, error: emailError } = await sendEmail(email, subject, html, text);

  await supabase.rpc("record_roster_operational_email", {
    p_roster_member_id:    rosterMemberId,
    p_expected_club_id:    expectedClubId,
    p_kind:                kind,
    p_status:              messageId ? "sent" : "failed",
    p_provider_message_id: messageId,
    p_error:               messageId ? null : (emailError ?? "Unknown error"),
  });
}
