"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { sendSms } from "@/lib/sms";

const ERROR_MESSAGES: Record<string, string> = {
  not_authenticated:           "You must be signed in.",
  insufficient_role:           "Admin access required.",
  invalid_booking_window:      "Booking window must be between 1 and 365 days.",
  invalid_cancellation_window: "Cancellation window must be between 0 and 168 hours.",
  invalid_club_name:           "Club name cannot be blank.",
};

export async function updateClubSettings(
  formData: FormData
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const clubName = (formData.get("club_name") as string | null)?.trim() ?? "";

  // Update club name when the field is present (admin-only field; RPC enforces role).
  if (clubName) {
    const { error: nameError } = await supabase.rpc("update_club_name", {
      p_name: clubName,
    });
    if (nameError) {
      const key = nameError.message.match(/invalid_club_name|not_authenticated|insufficient_role/)?.[0] ?? "";
      return { error: ERROR_MESSAGES[key] ?? "Failed to save club name." };
    }
  }

  const bookingDays  = Number(formData.get("booking_window_days"));
  const cancelHours  = Number(formData.get("cancellation_window_hours"));

  const { error } = await supabase.rpc("update_club_settings", {
    p_booking_window_days:       bookingDays,
    p_cancellation_window_hours: cancelHours,
  });

  if (error) {
    const key = error.message.match(/invalid_\w+|not_authenticated|insufficient_role/)?.[0] ?? "";
    return { error: ERROR_MESSAGES[key] ?? "Failed to save settings." };
  }

  // Revalidate the entire layout so the header picks up a new club name on all pages.
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
