"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getAuthProfile } from "@/lib/supabase/user";
import { sendSms } from "@/lib/sms";
import { sendEmailNotification } from "@/lib/email";
import { announcementTemplate } from "@/lib/email-templates";

const ERROR_MESSAGES: Record<string, string> = {
  not_authenticated:    "You must be signed in.",
  insufficient_role:    "Admin access required.",
  invalid_announcement: "Title and message are required (title ≤ 100 chars, message ≤ 500 chars).",
};

// Phase 44C: sendAnnouncementAction now also needs invalid_audience/
// no_eligible_recipients (its own audience-mode validation and the RPC's
// send-time revalidation failure) — the same mapping the Phase 44B prep
// actions further below already needed. Defined once, here, so
// sendAnnouncementAction and those two actions share one mapping rather
// than each maintaining their own copy.
const AUDIENCE_ERROR_MESSAGES: Record<string, string> = {
  ...ERROR_MESSAGES,
  no_club:                "No active club membership found.",
  invalid_audience:       "Invalid audience selection.",
  no_eligible_recipients: "None of the selected people can currently receive this announcement.",
};

function mapAudienceError(message: string): string {
  const key = message.match(
    /not_authenticated|insufficient_role|invalid_announcement|no_club|invalid_audience|no_eligible_recipients/
  )?.[0] ?? "";
  return AUDIENCE_ERROR_MESSAGES[key] ?? "Something went wrong. Please try again.";
}

// Admin IA Checkpoint 4 — Communications. Moved verbatim from
// admin/settings/actions.ts (Phase 31C comment preserved below) except:
// revalidatePath now targets /admin/communications instead of
// /admin/settings, matching this action's new page.
//
// Phase 31C: calls send_announcement_v2 (migration 0102) instead of
// send_announcement. send_announcement_v2 shares the identical
// preference-filtered bulk-insert body (including excluding the sending
// Admin from recipients at the database level — so no app-level actor
// check is needed here) and additionally returns a durable batch_id plus
// the exact {notification_id, user_id} pair for every recipient actually
// inserted, replacing the previous 5-second created_at-window re-query
// (which was both racy across concurrent announcements and — since it
// queried by kind only, with no club_id filter — a latent cross-club
// disclosure risk had it ever executed against real cross-user rows).
// send_announcement's original bare-integer return is still used nowhere
// else, so cutting the Server Action over to the v2 in-place is safe.
//
// Phase 44B: migration 0209 makes send_announcement_v2(text, text, text,
// uuid[]) — audience_mode + recipient ids — the sole canonical
// implementation, keeping the original two-argument form alive ONLY as a
// temporary compatibility wrapper for the deployment window (retired in
// Phase 44D). This action calls the four-argument form explicitly, so
// ordinary announcements already go through the canonical RPC rather than
// the temporary wrapper.
//
// Phase 44C: audienceMode/recipientUserIds are now read from the SAME
// FormData contract rather than hardcoded — AnnouncementsSection.tsx sets
// "audienceMode" and, for Specific mode, appends one "recipientUserIds"
// entry per selected id. audienceMode is OPTIONAL for backward
// compatibility: an absent value defaults to "all" (byte-identical to
// pre-44C behavior for any caller that never sets it). An EXPLICITLY
// supplied value must be exactly "all" or "specific" — never silently
// coerced to "all" — so a caller bug can never accidentally broadcast to
// everyone. Preview is never trusted as authorization here: this action
// always calls the RPC, which independently re-evaluates eligibility at
// send time regardless of what any prior preview said.
export async function sendAnnouncementAction(
  formData: FormData
): Promise<{ success?: boolean; message?: string; recipientCount?: number; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const title = (formData.get("title") as string | null)?.trim() ?? "";
  const body  = (formData.get("body")  as string | null)?.trim() ?? "";

  const rawAudienceMode = formData.get("audienceMode") as string | null;
  const audienceMode    = rawAudienceMode === null ? "all" : rawAudienceMode;
  if (audienceMode !== "all" && audienceMode !== "specific") {
    return { error: AUDIENCE_ERROR_MESSAGES.invalid_audience };
  }

  const recipientUserIds = audienceMode === "specific" ? formData.getAll("recipientUserIds").map(String) : null;
  const selectedCount    = recipientUserIds?.length ?? 0;

  const { data, error } = await supabase.rpc("send_announcement_v2", {
    p_title:              title,
    p_body:                body,
    p_audience_mode:       audienceMode,
    p_recipient_user_ids:  recipientUserIds,
  });

  if (error) return { error: mapAudienceError(error.message) };

  const result = data as unknown as {
    batch_id:        string;
    recipient_count: number;
    notifications:   Array<{ notification_id: string; user_id: string }>;
  } | null;
  const recipientCount = result?.recipient_count ?? 0;
  const notifications  = result?.notifications ?? [];

  // The announcement body text is already known locally — the same `body`
  // that was just inserted verbatim as each notification's body by
  // send_announcement_v2 — so no re-fetch of notification content is
  // needed for the template.
  for (const { notification_id, user_id } of notifications) {
    try {
      await sendEmailNotification(
        supabase,
        notification_id,
        user_id,
        "announcement",
        (clubName) => announcementTemplate(clubName, title, body),
      );
    } catch {
      // Email dispatch must never block announcement success or surface to
      // the user, and one recipient's failure must never stop the rest.
    }
  }

  revalidatePath("/admin/communications");

  // Phase 44C: a Specific-mode selection can partly outlive its own
  // eligibility between preview and send (removed/deactivated/opted-out
  // since preview last ran) — the RPC already silently excludes those and
  // sends to whoever survives. recipientCount is always the truth; never
  // claim the full originally-selected count was reached when it wasn't.
  const message =
    audienceMode === "specific" && selectedCount > 0 && recipientCount < selectedCount
      ? `Announcement sent to ${recipientCount} of ${selectedCount} selected people.`
      : `Announcement sent to ${recipientCount} recipient${recipientCount === 1 ? "" : "s"}.`;

  return { success: true, message, recipientCount };
}

// Admin IA Checkpoint 4 — authorization hardening. The Communications audit
// found get_my_communication_settings() (migration 0104) is deliberately
// self-service — it legitimately works for any authenticated user on their
// OWN row (Members/Staff/Pros use it via /profile/notifications), so it
// must not be narrowed. But sendTestSms itself had never independently
// confirmed the CALLER is an Admin — it only worked because the sole UI
// entry point (Settings, now Communications) already gated the page to
// Admin. That is a UI-only restriction, not a server-enforced one: any
// direct/manual invocation of this Server Action by a signed-in Staff/Pro/
// Member would have sent a real test SMS to THEIR OWN phone. Locked
// decision: Test SMS is an Admin-only diagnostic tool, not a general
// self-service feature — this explicit profile.role check is the fix,
// added here rather than by narrowing the shared RPC.
export async function sendTestSms(): Promise<{ sid?: string; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "You must be signed in." };

  const profile = await getAuthProfile();
  if (profile?.role !== "admin") return { error: "Admin access required." };

  // Phase 31D: replaces a raw `.from("profiles").select("phone, sms_opt_in,
  // club_id")` that was silently failing — sms_opt_in was never part of the
  // column-level SELECT grant added in migration 0079, so that query was
  // denied in full, and its discarded error was indistinguishable from "no
  // phone on file." get_my_communication_settings() (migration 0104) is a
  // security-definer RPC scoped to the caller's own row; club_id alone
  // remains readable under the existing grant and is fetched separately.
  const { data: commSettingsRaw, error: commSettingsError } = await supabase.rpc("get_my_communication_settings");
  const commSettings = commSettingsRaw as unknown as { phone: string | null; sms_opt_in: boolean } | null;

  if (commSettingsError || !commSettings) {
    return { error: "Communication settings could not be loaded. Please refresh and try again." };
  }

  if (!commSettings.phone) return { error: "Add a phone number to your profile first." };
  if (!commSettings.sms_opt_in) return { error: "Enable SMS in your profile first." };

  const { data: profileRow } = await supabase
    .from("profiles")
    .select("club_id")
    .eq("id", user.id)
    .single();

  let clubName = "Court Time";
  if (profileRow?.club_id) {
    const { data: club } = await supabase
      .from("clubs")
      .select("name")
      .eq("id", profileRow.club_id)
      .single();
    if (club?.name?.trim()) clubName = club.name.trim();
  }

  const { sid, error } = await sendSms(
    commSettings.phone,
    `This is a test message from ${clubName}.\n\nReply STOP to opt out.`
  );

  if (error) return { error };
  return { sid: sid ?? undefined };
}

export interface AnnouncementRecipientDetail {
  userId:      string;
  name:        string;
  emailStatus: "sent" | "failed" | "opted_out" | "no_phone" | "not_applicable";
}

// Admin IA Checkpoint 4 — Activity drill-down. Backs the inline detail
// expansion for one announcement batch card. get_announcement_batch_
// delivery_context (migration 0102) is the real authorization boundary —
// it already returns zero rows for a non-admin or cross-club caller, so
// this action adds no further role check, matching send_announcement_v2's
// own Server Action, which likewise relies on its RPC's authorization
// rather than re-checking role in application code.
//
// notification_deliveries has no 'email' row at all for a recipient whose
// announcement email preference was on but who had no matching in-app
// notification issue — that can't happen here (every returned notification_
// id came from a real insert) — so "no matching notification_deliveries
// row for the email channel" is only possible when sendAnnouncementAction's
// per-recipient sendEmailNotification call never resolved to a definite
// outcome (e.g., RESEND_API_KEY absent in this environment); rendered as
// "not_applicable" rather than a false "failed".
export async function getAnnouncementBatchDetailAction(
  batchId: string
): Promise<{ recipients: AnnouncementRecipientDetail[]; error?: string }> {
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("get_announcement_batch_delivery_context", {
    p_batch_id: batchId,
  });
  if (error) return { recipients: [], error: "Could not load recipient details." };

  const rows = (data ?? []) as Array<{ notification_id: string; recipient_user_id: string; body: string }>;
  if (rows.length === 0) return { recipients: [] };

  const notificationIds = rows.map(r => r.notification_id);
  const userIds         = rows.map(r => r.recipient_user_id);

  const [{ data: profiles }, { data: deliveries }] = await Promise.all([
    supabase.from("profiles").select("id, first_name, last_name").in("id", userIds),
    supabase.from("notification_deliveries").select("notification_id, channel, status").in("notification_id", notificationIds),
  ]);

  const nameByUserId = new Map(
    (profiles ?? []).map(p => [p.id, [p.first_name, p.last_name].filter(Boolean).join(" ") || "Unknown"])
  );
  const emailStatusByNotificationId = new Map(
    (deliveries ?? [])
      .filter(d => d.channel === "email")
      .map(d => [d.notification_id, d.status as "sent" | "failed" | "opted_out"])
  );

  const recipients: AnnouncementRecipientDetail[] = rows.map(r => ({
    userId:      r.recipient_user_id,
    name:        nameByUserId.get(r.recipient_user_id) ?? "Unknown",
    emailStatus: emailStatusByNotificationId.get(r.notification_id) ?? "not_applicable",
  }));

  return { recipients };
}

// ─── Phase 44B/44C — audience backend ──────────────────────────────────────
//
// Both actions below are now wired into AnnouncementsSection.tsx's
// Specific-people picker (Phase 44C). Both RPCs are Admin-only and
// club-scoped via current_user_club_id()/current_user_role() — no
// additional role check is added here, identical reasoning to
// getAnnouncementBatchDetailAction above. AUDIENCE_ERROR_MESSAGES/
// mapAudienceError, shared with sendAnnouncementAction, are defined near
// the top of this file.

export interface AnnouncementRecipientCandidate {
  id:                   string;
  firstName:            string | null;
  lastName:             string | null;
  role:                 string;
  announcementEnabled:  boolean;
}

// Backs the Specific People selector. Returns every currently-eligible
// (active, non-removed, same-club, not-self) candidate, INCLUDING those
// with announcementEnabled: false — the selector shows an opted-out
// person transparently ("Announcements off") rather than silently
// omitting them.
export async function getAnnouncementRecipientCandidatesAction(): Promise<{
  candidates?: AnnouncementRecipientCandidate[];
  error?:      string;
}> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_announcement_recipient_candidates");
  if (error) return { error: mapAudienceError(error.message) };

  const rows = (data ?? []) as Array<{
    id: string; first_name: string | null; last_name: string | null;
    role: string; announcement_enabled: boolean;
  }>;

  return {
    candidates: rows.map(r => ({
      id:                  r.id,
      firstName:           r.first_name,
      lastName:            r.last_name,
      role:                r.role,
      announcementEnabled: r.announcement_enabled,
    })),
  };
}

export interface AnnouncementPreviewResult {
  eligibleCount:    number;
  eligibleUserIds:  string[];
}

// Backs the "This will send to N people" preview line. Informational
// only — send_announcement_v2 independently re-evaluates eligibility at
// send time and never trusts this result (see 0209's own header comment).
export async function previewAnnouncementRecipientsAction(
  audienceMode:      "all" | "specific",
  recipientUserIds:  string[] | null,
): Promise<{ result?: AnnouncementPreviewResult; error?: string }> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("preview_announcement_recipients", {
    p_audience_mode:      audienceMode,
    p_recipient_user_ids: recipientUserIds,
  });
  if (error) return { error: mapAudienceError(error.message) };

  const row = (Array.isArray(data) ? data[0] : data) as
    { eligible_count: number; eligible_user_ids: string[] | null } | undefined;

  return {
    result: {
      eligibleCount:   row?.eligible_count ?? 0,
      eligibleUserIds: row?.eligible_user_ids ?? [],
    },
  };
}
