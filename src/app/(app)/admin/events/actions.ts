"use server";

import { createClient } from "@/lib/supabase/server";

// ─── Types ────────────────────────────────────────────────────────────────────

export type AdminEventRow = {
  id:                 string;
  title:              string;
  starts_at:          string;
  ends_at:            string;
  capacity:           number;
  status:             string;
  event_types:        { key: string; label: string; color: string } | null;
  event_participants: Array<{ profile_id: string; role: string; status: string }>;
  event_guests:       Array<{ id: string }>;
};

// ─── fetchMoreAdminEvents ─────────────────────────────────────────────────────

export async function fetchMoreAdminEvents(
  offset: number,
): Promise<{ events: AdminEventRow[]; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { events: [], error: "Not authenticated." };

  const { data: profile } = await supabase
    .from("profiles")
    .select("club_id, role")
    .eq("id", user.id)
    .single();

  if (!profile?.club_id) return { events: [], error: "Profile not found." };
  if (profile.role !== "admin" && profile.role !== "pro") {
    return { events: [], error: "Access denied." };
  }

  const { data, error } = await supabase
    .from("events")
    .select(`
      id, title, starts_at, ends_at, capacity, status,
      event_types(key, label, color),
      event_participants(profile_id, role, status),
      event_guests(id)
    `)
    .eq("club_id", profile.club_id)
    .order("starts_at", { ascending: false })
    .range(offset, offset + 24);

  if (error) return { events: [], error: error.message };
  return { events: (data ?? []) as AdminEventRow[] };
}

// ---------------------------------------------------------------------------
// Error code → user-facing message map.
// These codes are raised as exceptions by the admin_* RPCs in 0051.
// ---------------------------------------------------------------------------
const ERROR_MESSAGES: Record<string, string> = {
  not_authenticated:              "You must be signed in.",
  admin_required:                 "Only admins and pros can manage event rosters.",
  insufficient_role:              "Only admins and pros can manage event rosters.",
  event_not_found:                "Event not found.",
  event_cancelled:                "This event has been cancelled.",
  member_not_found:               "That member could not be found.",
  member_inactive:                "That member is inactive.",
  participant_not_found:          "That participant could not be found.",
  already_joined:                 "That member is already on this roster.",
  offer_already_active:           "Another member already has an active offer. Expire that offer first.",
  no_capacity_for_offer:          "There is no open spot to offer.",
  guest_not_found:                "That guest could not be found.",
  invalid_guest_name:             "Enter a guest name.",
  roster_member_not_found:        "That roster member could not be found.",
  roster_member_already_claimed:  "This member already has an account. Add them as a signed-in member instead.",
};

function rpcError(error: { message?: string } | null): string {
  const code = error?.message?.trim() ?? "";
  return ERROR_MESSAGES[code] ?? "An unexpected error occurred. Please try again.";
}

// ---------------------------------------------------------------------------
// adminAddMember
// Adds a club member to an event roster. They are placed as confirmed if a
// slot is available, or waitlisted if the event is full.
// ---------------------------------------------------------------------------
export async function adminAddMember(
  eventId:   string,
  profileId: string,
): Promise<{ error?: string }> {
  const supabase = await createClient();

  const { error } = await supabase.rpc("admin_add_member", {
    p_event_id:   eventId,
    p_profile_id: profileId,
  });

  if (error) return { error: rpcError(error) };
  return {};
}

// ---------------------------------------------------------------------------
// adminRemoveParticipant
// Cancels a member's active participation (confirmed, offered, or waitlisted).
// Triggers waitlist advancement if the removed row held a capacity slot.
// ---------------------------------------------------------------------------
export async function adminRemoveParticipant(
  eventId:   string,
  profileId: string,
): Promise<{ error?: string }> {
  const supabase = await createClient();

  const { error } = await supabase.rpc("admin_remove_participant", {
    p_event_id:   eventId,
    p_profile_id: profileId,
  });

  if (error) return { error: rpcError(error) };
  return {};
}

// ---------------------------------------------------------------------------
// adminForceConfirm
// Moves a waitlisted, offered, or cancelled member directly to confirmed.
// Bypasses capacity; sends a waitlist_promoted notification to the member.
// ---------------------------------------------------------------------------
export async function adminForceConfirm(
  eventId:   string,
  profileId: string,
): Promise<{ error?: string }> {
  const supabase = await createClient();

  const { error } = await supabase.rpc("admin_force_confirm", {
    p_event_id:   eventId,
    p_profile_id: profileId,
  });

  if (error) return { error: rpcError(error) };
  return {};
}

// ---------------------------------------------------------------------------
// adminOfferSpot
// Manually offers a spot to a specific waitlisted member, bypassing FIFO order.
// Blocked when another non-expired offer already exists or the event is full.
// ---------------------------------------------------------------------------
export async function adminOfferSpot(
  eventId:   string,
  profileId: string,
): Promise<{ error?: string }> {
  const supabase = await createClient();

  const { error } = await supabase.rpc("admin_offer_spot", {
    p_event_id:   eventId,
    p_profile_id: profileId,
  });

  if (error) return { error: rpcError(error) };
  return {};
}

// ---------------------------------------------------------------------------
// adminExpireOffer
// Immediately cancels an active offered row. Does not auto-advance the queue.
// ---------------------------------------------------------------------------
export async function adminExpireOffer(
  eventId:   string,
  profileId: string,
): Promise<{ error?: string }> {
  const supabase = await createClient();

  const { error } = await supabase.rpc("admin_expire_offer", {
    p_event_id:   eventId,
    p_profile_id: profileId,
  });

  if (error) return { error: rpcError(error) };
  return {};
}

// ---------------------------------------------------------------------------
// adminAddGuest
// Adds a named non-member guest to an event. Guests occupy a capacity slot.
// Returns the inserted guest row so callers can display the new guest_id.
// ---------------------------------------------------------------------------
export async function adminAddGuest(
  eventId:     string,
  displayName: string,
): Promise<{ data?: { id: string; display_name: string }; error?: string }> {
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("admin_add_guest", {
    p_event_id:     eventId,
    p_display_name: displayName,
  });

  if (error) return { error: rpcError(error) };

  const row = data as { id: string; display_name: string } | null;
  return { data: row ?? undefined };
}

// ---------------------------------------------------------------------------
// adminAddRosterMemberToEvent
// Adds an unclaimed roster member to an event as a linked guest.
// Always occupies a capacity slot. No waitlist behavior.
// ---------------------------------------------------------------------------
export async function adminAddRosterMemberToEvent(
  eventId:        string,
  rosterMemberId: string,
): Promise<{ error?: string }> {
  const supabase = await createClient();

  const { error } = await supabase.rpc("admin_add_roster_member_to_event", {
    p_event_id:         eventId,
    p_roster_member_id: rosterMemberId,
  });

  if (error) {
    const msg = error.message?.trim() ?? "";
    if (msg.includes("event_guests_roster_member_uniq") || msg.includes("duplicate") || msg.includes("unique")) {
      return { error: "This member is already on the event roster." };
    }
    return { error: rpcError(error) };
  }
  return {};
}

// ---------------------------------------------------------------------------
// adminRemoveGuest
// Removes a guest from an event. Triggers waitlist advancement if removal
// frees a slot below capacity.
// ---------------------------------------------------------------------------
export async function adminRemoveGuest(
  eventId: string,
  guestId: string,
): Promise<{ error?: string }> {
  const supabase = await createClient();

  const { error } = await supabase.rpc("admin_remove_guest", {
    p_event_id: eventId,
    p_guest_id: guestId,
  });

  if (error) return { error: rpcError(error) };
  return {};
}
