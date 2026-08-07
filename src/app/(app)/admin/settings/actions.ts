"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { sendSms } from "@/lib/sms";
import { sendEmailNotification } from "@/lib/email";
import { announcementTemplate } from "@/lib/email-templates";

const ERROR_MESSAGES: Record<string, string> = {
  not_authenticated:           "You must be signed in.",
  insufficient_role:           "Admin access required.",
  invalid_booking_window:      "Booking window must be between 1 and 365 days.",
  invalid_cancellation_window: "Cancellation window must be between 0 and 168 hours.",
  invalid_grace_period:        "Grace period must be between 0 and 60 minutes.",
  invalid_offer_window:        "Waitlist offer window must be between 1 and 72 hours.",
  invalid_club_name:           "Club name cannot be blank.",
  invalid_announcement:        "Title and message are required (title ≤ 100 chars, message ≤ 500 chars).",
  invalid_timezone:            "Invalid timezone selection.",
  invalid_label:               "Label cannot be blank.",
  invalid_color:               "Color must be a valid hex color (e.g. #3B7DD8).",
  not_found:                   "Event type not found.",
  invalid_event_type:          "Event type not found.",
  protected_event_type:        "Built-in event types cannot be deleted.",
  event_type_active:           "Deactivate this type before deleting it.",
  event_type_in_use:           "This type has been used by existing events, including cancelled or archived events, so it cannot be permanently deleted. Keep it inactive instead.",
};

export async function updateClubTimezone(
  timezone: string
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const { error } = await supabase.rpc("update_club_timezone", { p_timezone: timezone });
  if (error) {
    const key = error.message.match(/invalid_timezone|not_authenticated|insufficient_role/)?.[0] ?? "";
    return { error: ERROR_MESSAGES[key] ?? "Failed to save timezone." };
  }

  revalidatePath("/", "layout");
  return {};
}

export async function createEventType(
  label: string,
  color: string
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const { error } = await supabase.rpc("create_event_type", {
    p_label: label,
    p_color: color,
  });
  if (error) {
    const key = error.message.match(/invalid_label|invalid_color|not_authenticated|insufficient_role/)?.[0] ?? "";
    return { error: ERROR_MESSAGES[key] ?? "Failed to create event type." };
  }

  revalidatePath("/", "layout");
  return {};
}

export async function updateEventType(
  id: string,
  label: string,
  color: string
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const { error } = await supabase.rpc("update_event_type", {
    p_id:    id,
    p_label: label,
    p_color: color,
  });
  if (error) {
    const key = error.message.match(/invalid_label|invalid_color|not_found|not_authenticated|insufficient_role/)?.[0] ?? "";
    return { error: ERROR_MESSAGES[key] ?? "Failed to update event type." };
  }

  revalidatePath("/", "layout");
  return {};
}

export async function setEventTypeActive(
  id: string,
  isActive: boolean
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const { error } = await supabase.rpc("set_event_type_active", {
    p_id:        id,
    p_is_active: isActive,
  });
  if (error) {
    const key = error.message.match(/not_found|not_authenticated|insufficient_role/)?.[0] ?? "";
    return { error: ERROR_MESSAGES[key] ?? "Failed to update event type." };
  }

  revalidatePath("/", "layout");
  return {};
}

export async function deleteEventType(
  id: string,
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const { error } = await supabase.rpc("delete_event_type", { p_id: id });
  if (error) {
    const key = error.message.match(
      /invalid_event_type|not_found|insufficient_role|protected_event_type|event_type_active|event_type_in_use|not_authenticated/
    )?.[0] ?? "";
    return { error: ERROR_MESSAGES[key] ?? "Failed to delete event type." };
  }

  revalidatePath("/", "layout");
  return {};
}

export async function updateClubName(
  formData: FormData
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const clubName = (formData.get("club_name") as string | null)?.trim() ?? "";
  if (!clubName) return { error: ERROR_MESSAGES.invalid_club_name };

  const { error } = await supabase.rpc("update_club_name", { p_name: clubName });
  if (error) {
    const key = error.message.match(/invalid_club_name|not_authenticated|insufficient_role/)?.[0] ?? "";
    return { error: ERROR_MESSAGES[key] ?? "Failed to save club name." };
  }

  revalidatePath("/", "layout");
  return {};
}

export async function updateBookingRules(
  formData: FormData
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const bookingDays      = Number(formData.get("booking_window_days"));
  const cancelHours      = Number(formData.get("cancellation_window_hours"));
  const graceMins        = Number(formData.get("cancellation_grace_minutes"));
  const offerWindowHours = Number(formData.get("waitlist_offer_window_hours"));  // Phase 18C

  const { error } = await supabase.rpc("update_club_settings", {
    p_booking_window_days:         bookingDays,
    p_cancellation_window_hours:   cancelHours,
    p_cancellation_grace_minutes:  graceMins,
    p_waitlist_offer_window_hours: offerWindowHours,  // Phase 18C
  });

  if (error) {
    const key = error.message.match(/invalid_\w+|not_authenticated|insufficient_role/)?.[0] ?? "";
    return { error: ERROR_MESSAGES[key] ?? "Failed to save settings." };
  }

  revalidatePath("/", "layout");
  return {};
}

const VALID_THEMES = new Set([
  "graphite", "cobalt", "teal", "sage", "plum", "rose", "terracotta", "gold",
]);

export async function updateClubTheme(themeKey: string): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  if (!VALID_THEMES.has(themeKey)) return { error: "Invalid theme selection." };

  const { error } = await supabase.rpc("update_club_theme", { p_theme_key: themeKey });
  if (error) {
    const key = error.message.match(/insufficient_role|invalid_theme|not_authenticated/)?.[0] ?? "";
    return { error:
      key === "insufficient_role" ? ERROR_MESSAGES.insufficient_role :
      key === "invalid_theme"     ? "Invalid theme selection."        :
      key === "not_authenticated" ? ERROR_MESSAGES.not_authenticated  :
      "Failed to save theme."
    };
  }

  revalidatePath("/", "layout");
  return {};
}

const ALLOWED_LOGO_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png":  "png",
  "image/webp": "webp",
};
const MAX_LOGO_BYTES = 2 * 1024 * 1024; // 2 MB

export async function uploadClubLogo(
  formData: FormData
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const { data: profile } = await supabase
    .from("profiles")
    .select("club_id, role")
    .eq("id", user.id)
    .single();
  if (profile?.role !== "admin") return { error: ERROR_MESSAGES.insufficient_role };
  if (!profile.club_id) return { error: ERROR_MESSAGES.not_authenticated };

  const file = formData.get("logo") as File | null;
  if (!file || file.size === 0) return { error: "No file selected." };

  const ext = ALLOWED_LOGO_TYPES[file.type];
  if (!ext) return { error: "Only JPEG, PNG, and WebP images are allowed." };
  if (file.size > MAX_LOGO_BYTES) return { error: "File must be 2 MB or smaller." };

  const clubId = profile.club_id;
  const path   = `${clubId}/logo.${ext}`;

  const { error: uploadError } = await supabase.storage
    .from("club-logos")
    .upload(path, file, { upsert: true, contentType: file.type });
  if (uploadError) return { error: "Upload failed. Please try again." };

  const { data: urlData } = supabase.storage.from("club-logos").getPublicUrl(path);
  const logoUrl = `${urlData.publicUrl}?t=${Date.now()}`;

  const { error: updateError } = await supabase
    .from("clubs")
    .update({ logo_url: logoUrl })
    .eq("id", clubId);
  if (updateError) return { error: "Failed to save logo URL." };

  await supabase.from("audit_log").insert({
    club_id:     clubId,
    actor_id:    user.id,
    action:      "upload_club_logo",
    target_type: "club",
    target_id:   clubId,
    metadata:    { path },
  });

  revalidatePath("/", "layout");
  return {};
}

export async function deleteClubLogo(): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const { data: profile } = await supabase
    .from("profiles")
    .select("club_id, role")
    .eq("id", user.id)
    .single();
  if (profile?.role !== "admin") return { error: ERROR_MESSAGES.insufficient_role };
  if (!profile.club_id) return { error: ERROR_MESSAGES.not_authenticated };

  const clubId = profile.club_id;

  const { data: files } = await supabase.storage
    .from("club-logos")
    .list(clubId);
  if (files && files.length > 0) {
    const paths = files.map((f) => `${clubId}/${f.name}`);
    await supabase.storage.from("club-logos").remove(paths);
  }

  await supabase
    .from("clubs")
    .update({ logo_url: null })
    .eq("id", clubId);

  await supabase.from("audit_log").insert({
    club_id:     clubId,
    actor_id:    user.id,
    action:      "delete_club_logo",
    target_type: "club",
    target_id:   clubId,
    metadata:    {},
  });

  revalidatePath("/", "layout");
  return {};
}

export async function sendTestSms(): Promise<{ sid?: string; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "You must be signed in." };

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

  const { data: profile } = await supabase
    .from("profiles")
    .select("club_id")
    .eq("id", user.id)
    .single();

  let clubName = "Court Time";
  if (profile?.club_id) {
    const { data: club } = await supabase
      .from("clubs")
      .select("name")
      .eq("id", profile.club_id)
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
export async function sendAnnouncementAction(
  formData: FormData
): Promise<{ success?: boolean; message?: string; recipientCount?: number; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const title = (formData.get("title") as string | null)?.trim() ?? "";
  const body  = (formData.get("body")  as string | null)?.trim() ?? "";

  const { data, error } = await supabase.rpc("send_announcement_v2", {
    p_title: title,
    p_body:  body,
  });

  if (error) {
    const key = error.message.match(/not_authenticated|insufficient_role|invalid_announcement/)?.[0] ?? "";
    return { error: ERROR_MESSAGES[key] ?? "Failed to send announcement. Please try again." };
  }

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

  revalidatePath("/admin/settings");
  return {
    success:        true,
    message:        `Announcement sent to ${recipientCount} member${recipientCount === 1 ? "" : "s"}.`,
    recipientCount,
  };
}
