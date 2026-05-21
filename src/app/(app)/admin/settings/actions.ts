"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { sendSms } from "@/lib/sms";

const ERROR_MESSAGES: Record<string, string> = {
  not_authenticated:           "You must be signed in.",
  insufficient_role:           "Admin access required.",
  invalid_booking_window:      "Booking window must be between 1 and 365 days.",
  invalid_cancellation_window: "Cancellation window must be between 0 and 168 hours.",
  invalid_grace_period:        "Grace period must be between 0 and 60 minutes.",
  invalid_club_name:           "Club name cannot be blank.",
};

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

  const bookingDays  = Number(formData.get("booking_window_days"));
  const cancelHours  = Number(formData.get("cancellation_window_hours"));
  const graceMins    = Number(formData.get("cancellation_grace_minutes"));

  const { error } = await supabase.rpc("update_club_settings", {
    p_booking_window_days:        bookingDays,
    p_cancellation_window_hours:  cancelHours,
    p_cancellation_grace_minutes: graceMins,
  });

  if (error) {
    const key = error.message.match(/invalid_\w+|not_authenticated|insufficient_role/)?.[0] ?? "";
    return { error: ERROR_MESSAGES[key] ?? "Failed to save settings." };
  }

  revalidatePath("/", "layout");
  return {};
}

const VALID_THEMES = new Set([
  "classic-gray", "forest-green", "clay-court", "ocean-blue", "royal-purple",
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

  const { data: profile } = await supabase
    .from("profiles")
    .select("phone, sms_opt_in, club_id")
    .eq("id", user.id)
    .single();

  if (!profile?.phone) return { error: "Add a phone number to your profile first." };
  if (!profile.sms_opt_in) return { error: "Enable SMS in your profile first." };

  let clubName = "Court Time";
  if (profile.club_id) {
    const { data: club } = await supabase
      .from("clubs")
      .select("name")
      .eq("id", profile.club_id)
      .single();
    if (club?.name?.trim()) clubName = club.name.trim();
  }

  const { sid, error } = await sendSms(
    profile.phone,
    `This is a test message from ${clubName}.\n\nReply STOP to opt out.`
  );

  if (error) return { error };
  return { sid: sid ?? undefined };
}
