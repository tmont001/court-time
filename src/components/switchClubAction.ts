"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

// Shared by every switcher entry point (desktop dropdown, mobile header
// popover, mobile "Switch club" sheet, /profile Clubs section) — see
// ClubMembershipList.tsx. There is intentionally only one place in the
// application that calls set_active_club(); no switching logic is
// duplicated per UI surface.
//
// Phase 26E2: no longer calls redirect() itself. Cross-tab notification
// (publishActiveClubChanged) must only ever fire after a *confirmed*
// success, and only the client knows the exact moment that happened —
// redirect() inside a Server Action unwinds control back to the browser
// without returning a value, so there was no point at which client code
// could reliably run between "switch confirmed" and "navigation happens."
// The caller (ClubMembershipList) now performs the publish, then the same
// "land on /calendar with a fresh server-rendered context" navigation this
// action used to do itself, via router.push + router.refresh().

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ERROR_MESSAGES: Record<string, string> = {
  not_authenticated:   "You must be signed in to switch clubs.",
  invalid_active_club: "You don't have access to that club right now.",
};

export type SwitchActiveClubResult =
  | { error: string }
  | { success: true; clubId: string };

export async function switchActiveClubAction(
  clubId: string
): Promise<SwitchActiveClubResult> {
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
  // on the next request rather than served from Next's route cache.
  revalidatePath("/", "layout");

  return { success: true, clubId };
}
