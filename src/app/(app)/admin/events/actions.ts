"use server";

import { createClient } from "@/lib/supabase/server";

// ---------------------------------------------------------------------------
// Error code → user-facing message map.
// These codes are raised as exceptions by the admin_* RPCs in 0051.
// ---------------------------------------------------------------------------
const ERROR_MESSAGES: Record<string, string> = {
  not_authenticated:     "You must be signed in.",
  admin_required:        "Admin or pro access required.",
  event_not_found:       "Event not found.",
  event_cancelled:       "This event has been cancelled.",
  member_not_found:      "Member not found.",
  member_inactive:       "This member's account is inactive.",
  participant_not_found: "Participant not found in this event.",
  already_joined:        "This member is already in the event.",
  offer_already_active:  "Another offer is already active. Expire it before offering a new spot.",
  no_capacity_for_offer: "Event is full. Free a spot before offering.",
  guest_not_found:       "Guest not found in this event.",
  invalid_guest_name:    "Guest name cannot be blank.",
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
