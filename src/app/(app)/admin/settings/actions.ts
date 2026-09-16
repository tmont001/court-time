"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getAuthProfile } from "@/lib/supabase/user";

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
  // Phase 42C-2
  enabled_required:            "Please choose whether Memberships are on or off.",
  settings_unavailable:        "Could not load current club settings. Please try again.",
  // Phase 42C-3B — Membership Types management (0188 RPCs)
  name_required:               "Please enter a name.",
  name_too_long:                "Name must be 100 characters or fewer.",
  membership_type_name_taken:  "A Membership Type with that name already exists.",
  membership_type_not_found:   "Membership Type not found.",
  is_active_required:          "Please choose Active or Inactive.",
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
// Phase 42C-2: widened to 0189's current 3-argument update_club_pricing.
// The third argument is REQUIRED (no TypeScript default) — the caller must
// always make an explicit decision about it, never let an omission
// silently become NULL.
//
// Correction pass: client-side hidden/stale state is not sufficient to
// preserve the Non-Member rate while Memberships are off. Edge case: an
// Admin edits the visible Non-Member field, does NOT save, then toggles
// Memberships off (hiding it) before finally saving Pricing — the client
// would still be holding the unsaved value in memory. Server-side defense
// in depth: when memberships_enabled is currently false, this action
// ignores whatever the client sent for the Non-Member rate and re-reads
// the CURRENT stored value from club_settings itself, passing THAT to the
// RPC instead. When memberships_enabled is true, the explicit client
// value is used as-is, including NULL (an Admin may intentionally clear
// the Non-Member rate while its field is visible). This is a read-only
// preflight, not a new authorization check — the RPC's own admin/same-
// club enforcement is unchanged and unduplicated here.
//
// Second correction pass: the club/settings resolution above must FAIL
// CLOSED, not fail open. There is no longer a third state where an
// unresolved club or a failed/empty settings read causes the client's
// Non-Member value to be trusted — if the active club can't be resolved,
// or the settings read errors or returns no row, this now returns an
// error and never calls update_club_pricing at all. The RPC is only ever
// reached once memberships_enabled has been read with certainty.
//
// UX polish pass: returns nonMemberRatePreserved (true when the OFF
// branch above fired) and effectiveNonMemberRateCents (whatever was
// actually sent to the RPC, and is therefore now the true stored value) —
// so a stale caller (a Settings tab open in another window/tab, unaware
// Memberships were just turned off) can tell its own typed Non-Member
// value was NOT what got saved, resync its own local state to the
// authoritative value, and show accurate feedback instead of a
// misleading plain "Saved".
export async function updateClubPricing(
  currency: string,
  defaultCourtHourlyRateCents: number | null,
  defaultCourtHourlyRateNonMemberCents: number | null,
): Promise<{ error?: string; nonMemberRatePreserved?: boolean; effectiveNonMemberRateCents?: number | null }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const profile = await getAuthProfile();
  const clubId = profile?.club_id;
  if (!clubId) return { error: ERROR_MESSAGES.insufficient_role };

  const { data: currentSettings, error: settingsError } = await supabase
    .from("club_settings")
    .select("memberships_enabled, default_court_hourly_rate_non_member_cents")
    .eq("club_id", clubId)
    .single();

  if (settingsError || !currentSettings) {
    return { error: ERROR_MESSAGES.settings_unavailable };
  }

  const nonMemberRatePreserved = currentSettings.memberships_enabled === false;
  const nonMemberRateCents = nonMemberRatePreserved
    ? currentSettings.default_court_hourly_rate_non_member_cents
    : defaultCourtHourlyRateNonMemberCents;

  const { error } = await supabase.rpc("update_club_pricing", {
    p_currency: currency,
    p_default_court_hourly_rate_cents: defaultCourtHourlyRateCents,
    p_default_court_hourly_rate_non_member_cents: nonMemberRateCents,
  });
  if (error) {
    const key = error.message.match(/currency_required|invalid_currency|invalid_rate|not_authenticated|insufficient_role/)?.[0] ?? "";
    return { error: ERROR_MESSAGES[key] ?? "Failed to save pricing settings." };
  }

  revalidatePath("/", "layout");
  return { nonMemberRatePreserved, effectiveNonMemberRateCents: nonMemberRateCents };
}

// Phase 42C-2: Admin-only Memberships on/off toggle. Deliberately its own
// Server Action calling its own single-purpose RPC (update_club_memberships_
// enabled, 0190) rather than folding into updateClubPricing — same
// separation-of-concerns precedent as updateClubPaymentModeAction living
// apart from updateClubPricing. Turning Memberships off never deletes or
// clears membership_types/roster membership fields/configured rates — it
// only changes which rate-resolution chain new reservations use, entirely
// inside the RPC (Approach B, Phase 42C audit).
export async function updateClubMembershipsEnabled(
  enabled: boolean
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const { error } = await supabase.rpc("update_club_memberships_enabled", {
    p_enabled: enabled,
  });
  if (error) {
    const key = error.message.match(/enabled_required|not_authenticated|insufficient_role/)?.[0] ?? "";
    return { error: ERROR_MESSAGES[key] ?? "Failed to save Memberships setting." };
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

// ── Membership Types management (Phase 42C-3B) ──────────────────────────
// Thin wrappers around 0188's three Admin-only, same-club membership_types
// RPCs — no delete action exists on either side (soft lifecycle only, per
// the locked domain model: inactive types stay visible/renamable/
// reactivatable, never hard deleted).

export async function createMembershipTypeAction(
  name: string
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const { error } = await supabase.rpc("create_membership_type", { p_name: name });
  if (error) {
    const key = error.message.match(/name_required|name_too_long|membership_type_name_taken|not_authenticated|insufficient_role/)?.[0] ?? "";
    return { error: ERROR_MESSAGES[key] ?? "Failed to add Membership Type." };
  }

  revalidatePath("/admin/settings");
  return {};
}

export async function updateMembershipTypeAction(
  id: string,
  name: string
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const { error } = await supabase.rpc("update_membership_type", { p_id: id, p_name: name });
  if (error) {
    const key = error.message.match(/name_required|name_too_long|membership_type_name_taken|membership_type_not_found|not_authenticated|insufficient_role/)?.[0] ?? "";
    return { error: ERROR_MESSAGES[key] ?? "Failed to rename Membership Type." };
  }

  revalidatePath("/admin/settings");
  return {};
}

export async function setMembershipTypeActiveAction(
  id: string,
  isActive: boolean
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: ERROR_MESSAGES.not_authenticated };

  const { error } = await supabase.rpc("set_membership_type_active", { p_id: id, p_is_active: isActive });
  if (error) {
    const key = error.message.match(/is_active_required|membership_type_not_found|not_authenticated|insufficient_role/)?.[0] ?? "";
    return { error: ERROR_MESSAGES[key] ?? "Failed to update Membership Type." };
  }

  revalidatePath("/admin/settings");
  return {};
}
