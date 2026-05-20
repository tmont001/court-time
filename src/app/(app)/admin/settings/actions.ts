"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { sendSms } from "@/lib/sms";

const ERROR_MESSAGES: Record<string, string> = {
  not_authenticated:        "You must be signed in.",
  insufficient_role:        "Admin access required.",
  invalid_booking_window:   "Booking window must be between 1 and 365 days.",
  invalid_cancellation_window: "Cancellation window must be between 0 and 168 hours.",
};

export async function updateClubSettings(
  formData: FormData
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

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

  revalidatePath("/admin/settings");
  return {};
}

export async function sendTestSms(): Promise<{ sid?: string; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "You must be signed in." };

  const { data: profile } = await supabase
    .from("profiles")
    .select("phone, sms_opt_in")
    .eq("id", user.id)
    .single();

  if (!profile?.phone) return { error: "Add a phone number to your profile first." };
  if (!profile.sms_opt_in) return { error: "Enable SMS in your profile first." };

  const { sid, error } = await sendSms(
    profile.phone,
    "This is a test message from Riverside Tennis Club.\n\nReply STOP to opt out."
  );

  if (error) return { error };
  return { sid: sid ?? undefined };
}
