"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

function normalizePhone(raw: string | null): { e164: string | null; error?: string } {
  if (!raw || raw.trim() === "") return { e164: null };
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return { e164: `+1${digits}` };
  if (digits.length === 11 && digits[0] === "1") return { e164: `+${digits}` };
  return { e164: null, error: "Enter a valid 10-digit US phone number." };
}

export async function updateProfile(formData: FormData): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "You must be signed in." };

  const firstName = (formData.get("first_name") as string | null)?.trim() || null;
  const lastName  = (formData.get("last_name")  as string | null)?.trim() || null;
  const rawPhone  = (formData.get("phone")      as string | null)?.trim() || null;

  const { e164, error: phoneError } = normalizePhone(rawPhone);
  if (phoneError) return { error: phoneError };

  const { error } = await supabase
    .from("profiles")
    .update({ first_name: firstName, last_name: lastName, phone: e164 })
    .eq("id", user.id);

  if (error) return { error: "Failed to save changes. Please try again." };

  // Phase 31D: /profile/notifications now displays this same phone number
  // (SmsPreferenceSection), so a phone edit here must revalidate that page
  // too — otherwise it could keep showing a stale number until an
  // unrelated navigation happened to refetch it.
  revalidatePath("/profile");
  revalidatePath("/profile/notifications");
  return {};
}

export async function updateSmsPreference(optIn: boolean): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "You must be signed in." };

  if (optIn) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("phone")
      .eq("id", user.id)
      .single();

    if (!profile?.phone) return { error: "Add a phone number first." };
  }

  const headersList = await headers();
  const forwarded = headersList.get("x-forwarded-for");
  const realIp    = headersList.get("x-real-ip");
  const ip = forwarded ? forwarded.split(",")[0].trim() : (realIp ?? null);

  const { error } = await supabase.rpc("update_sms_preference", {
    p_sms_opt_in: optIn,
    p_ip:         ip,
  });

  if (error) return { error: "Failed to update SMS preference. Please try again." };

  revalidatePath("/profile");
  revalidatePath("/profile/notifications");
  return {};
}
