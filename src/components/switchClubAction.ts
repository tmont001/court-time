"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

// Shared by every switcher entry point (desktop dropdown, mobile "Switch
// club" sheet, /profile Clubs section) — see ClubMembershipList.tsx. There
// is intentionally only one place in the application that calls
// set_active_club(); no switching logic is duplicated per UI surface.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ERROR_MESSAGES: Record<string, string> = {
  not_authenticated:   "You must be signed in to switch clubs.",
  invalid_active_club: "You don't have access to that club right now.",
};

export async function switchActiveClubAction(
  clubId: string
): Promise<{ error: string } | undefined> {
  if (!UUID_RE.test(clubId)) {
    return { error: ERROR_MESSAGES.invalid_active_club };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("set_active_club", { p_club_id: clubId });

  if (error) {
    const key = Object.keys(ERROR_MESSAGES).find((k) => error.message.includes(k));
    return {
      error: key ? ERROR_MESSAGES[key] : "Failed to switch clubs. Please try again.",
    };
  }

  // Invalidate the whole app-shell layout subtree so every active-club-
  // scoped read (nav, theme, Calendar/Events/Bookings, Profile) is fresh
  // on the very next request rather than served from Next's route cache.
  // getAuthProfile()/getMyClubMemberships() are also React.cache()'d only
  // per-request, so the redirect below — a brand new request — already
  // guarantees a fresh call to get_current_account_context()/
  // get_my_club_memberships() on top of this revalidation.
  revalidatePath("/", "layout");

  // Phase 26E1: always redirect to /calendar. Preserving the exact prior
  // route across a role change (e.g. an admin-only page that the new
  // club's role can't access) is not attempted in this checkpoint.
  redirect("/calendar");
}
