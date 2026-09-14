"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

const ERROR_MESSAGES: Record<string, string> = {
  not_authenticated:           "You must be signed in.",
  insufficient_role:           "Admin access required.",
  invalid_club_name:           "Club name cannot be blank.",
  invalid_timezone:            "Invalid timezone selection.",
  // Phase 34B
  currency_required:           "Currency is required.",
  invalid_currency:            "Currency must be a 3-letter code (e.g. USD).",
  invalid_rate:                "Rate must be zero or a positive amount.",
  // 0184
  rules_and_policies_too_long: "Club Rules & Policies must be 10,000 characters or fewer.",
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

// Phase 34B: club-wide currency + optional default court hourly rate.
// Court pricing is opt-in — p_default_court_hourly_rate_cents may be null.
export async function updateClubPricing(
  currency: string,
  defaultCourtHourlyRateCents: number | null,
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const { error } = await supabase.rpc("update_club_pricing", {
    p_currency: currency,
    p_default_court_hourly_rate_cents: defaultCourtHourlyRateCents,
  });
  if (error) {
    const key = error.message.match(/currency_required|invalid_currency|invalid_rate|not_authenticated|insufficient_role/)?.[0] ?? "";
    return { error: ERROR_MESSAGES[key] ?? "Failed to save pricing settings." };
  }

  revalidatePath("/", "layout");
  return {};
}

// Phase 34B: Admin-only default price for an Event Type. New Events copy
// this value at creation; changing it later never rewrites existing Events.
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

// 0184 — informational-only "Club Rules & Policies" document (court
// etiquette, dress code, cleanup, ball machine rules, general facility
// expectations, guest/check-in guidance). NEVER used for cancellation
// windows, refund rules, booking restrictions, fees, eligibility, or
// waiver acceptance — those remain structured product policy handled
// elsewhere. Trim/empty->null and the 10,000-character cap are enforced
// server-side by the RPC itself; this action only maps its error codes.
export async function updateClubRulesAndPolicies(
  rulesAndPolicies: string
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const { error } = await supabase.rpc("update_club_rules_and_policies", {
    p_rules_and_policies: rulesAndPolicies,
  });
  if (error) {
    const key = error.message.match(/rules_and_policies_too_long|not_authenticated|insufficient_role/)?.[0] ?? "";
    return { error: ERROR_MESSAGES[key] ?? "Failed to save Club Rules & Policies." };
  }

  // Invalidates the whole layout cache, same as every other club_settings/
  // clubs mutation in this file — covers /admin/settings AND /help (a
  // separate route under the same root layout) with the one call.
  revalidatePath("/", "layout");
  return {};
}
