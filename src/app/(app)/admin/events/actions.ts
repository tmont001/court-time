"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { assertActiveClub } from "@/lib/supabase/staleClub";
import { dispatchEventNotification, dispatchWaitlistNotification } from "@/lib/notification-dispatch";
import { STALE_CLUB_CONTEXT_ERROR, STALE_CLUB_MESSAGE } from "@/lib/staleClub";
import { ADMIN_EVENT_SELECT, mapAdminEventRow } from "./adminEventRow";
import type { RawAdminEventRow, AdminEventRow } from "./adminEventRow";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ArchiveView = "active" | "archived" | "all";

// Re-exported so existing "@/app/(app)/admin/events/actions" consumers
// (e.g. AdminEventsClient.tsx) don't need to change their import path.
// Type-only re-exports are erased at compile time, so they don't run afoul
// of "use server"'s async-function-only export constraint the way a
// re-exported value or function (mapAdminEventRow, ADMIN_EVENT_SELECT)
// would — those stay in ./adminEventRow and are imported from there
// directly by any caller that needs them (see events/page.tsx).
export type { RawAdminEventRow, AdminEventRow };

// ─── fetchMoreAdminEvents ─────────────────────────────────────────────────────

export async function fetchMoreAdminEvents(
  offset: number,
  archiveView: ArchiveView = "active",
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

  const baseQuery = supabase
    .from("events")
    .select(ADMIN_EVENT_SELECT)
    .eq("club_id", profile.club_id)
    .order("starts_at", { ascending: false });

  const filteredQuery =
    archiveView === "archived" ? baseQuery.not("archived_at", "is", null) :
    archiveView === "all"      ? baseQuery :
    /* active (default) */       baseQuery.is("archived_at", null);
  const { data, error } = await filteredQuery.range(offset, offset + 24);

  if (error) return { events: [], error: error.message };

  const rows = (data ?? []) as unknown as RawAdminEventRow[];
  const events: AdminEventRow[] = rows.map(mapAdminEventRow);

  return { events };
}

// ---------------------------------------------------------------------------
// Error code → user-facing message maps.
// Each RPC family has its own map so error wording stays context-appropriate.
// ---------------------------------------------------------------------------

const ARCHIVE_ERROR_MESSAGES: Record<string, string> = {
  [STALE_CLUB_CONTEXT_ERROR]: STALE_CLUB_MESSAGE,
  not_authenticated: "You must be signed in.",
  account_inactive:  "Your account is inactive.",
  insufficient_role: "You do not have permission to archive this event.",
  event_not_found:   "Event not found.",
  already_archived:  "This event is already archived.",
  event_not_past:    "Future scheduled events must be cancelled before they can be archived.",
};

const UNARCHIVE_ERROR_MESSAGES: Record<string, string> = {
  [STALE_CLUB_CONTEXT_ERROR]: STALE_CLUB_MESSAGE,
  not_authenticated: "You must be signed in.",
  account_inactive:  "Your account is inactive.",
  insufficient_role: "You do not have permission to unarchive this event.",
  event_not_found:   "Event not found.",
  not_archived:      "This event is not archived.",
};

// These codes are raised as exceptions by the admin_* RPCs in 0051.
const ERROR_MESSAGES: Record<string, string> = {
  [STALE_CLUB_CONTEXT_ERROR]:     STALE_CLUB_MESSAGE,
  not_authenticated:              "You must be signed in.",
  admin_required:                 "Only admins and pros can manage event rosters.",
  insufficient_role:              "Only admins and pros can manage event rosters.",
  event_not_found:                "Event not found.",
  event_cancelled:                "This event has been cancelled.",
  event_archived:                 "This event is archived and its roster is read-only.",
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
  expectedClubId: string,
): Promise<{ error?: string }> {
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: ERROR_MESSAGES[guard.error] };

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
  expectedClubId: string,
): Promise<{ error?: string }> {
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: ERROR_MESSAGES[guard.error] };

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
// Phase 31C: admin_force_confirm (migration 0102) now returns the exact
// notification_id it created (stamped with metadata.triggered_by =
// auth.uid(), authorizing this specific Admin or Pro actor — this RPC has
// always allowed role in ('admin','pro')) instead of the bare participant
// row. Dispatch runs through dispatchWaitlistNotification, which resolves
// body/authorization via get_waitlist_delivery_context — no raw
// notifications SELECT.
// ---------------------------------------------------------------------------
export async function adminForceConfirm(
  eventId:   string,
  profileId: string,
  expectedClubId: string,
): Promise<{ error?: string }> {
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: ERROR_MESSAGES[guard.error] };

  const supabase = await createClient();

  const { data, error } = await supabase.rpc("admin_force_confirm", {
    p_event_id:   eventId,
    p_profile_id: profileId,
  });

  if (error) return { error: rpcError(error) };

  const result = data as unknown as { participant: Record<string, unknown>; notification_id: string } | null;

  try {
    await dispatchWaitlistNotification(supabase, result?.notification_id ?? null);
  } catch {
    // Email/SMS dispatch must never surface as a user-facing error.
  }

  return {};
}

// ---------------------------------------------------------------------------
// adminOfferSpot
// Manually offers a spot to a specific waitlisted member, bypassing FIFO order.
// Blocked when another non-expired offer already exists or the event is full.
// Phase 31C: admin_offer_spot (migration 0102) now returns the exact
// notification_id it created (stamped with metadata.triggered_by =
// auth.uid(), authorizing this specific Admin or Pro actor) instead of the
// bare participant row. Dispatch runs through dispatchWaitlistNotification,
// which resolves body/authorization via get_waitlist_delivery_context — no
// raw notifications SELECT. An unrelated Pro cannot resolve or deliver this
// notification, since get_waitlist_delivery_context only authorizes the
// recipient, a same-club Admin, or the exact triggered_by actor.
// ---------------------------------------------------------------------------
export async function adminOfferSpot(
  eventId:   string,
  profileId: string,
  expectedClubId: string,
): Promise<{ error?: string }> {
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: ERROR_MESSAGES[guard.error] };

  const supabase = await createClient();

  const { data, error } = await supabase.rpc("admin_offer_spot", {
    p_event_id:   eventId,
    p_profile_id: profileId,
  });

  if (error) return { error: rpcError(error) };

  const result = data as unknown as { participant: Record<string, unknown>; notification_id: string } | null;

  try {
    await dispatchWaitlistNotification(supabase, result?.notification_id ?? null);
  } catch {
    // Email/SMS dispatch must never surface as a user-facing error.
  }

  return {};
}

// ---------------------------------------------------------------------------
// adminExpireOffer
// Immediately cancels an active offered row. Does not auto-advance the queue.
// ---------------------------------------------------------------------------
export async function adminExpireOffer(
  eventId:   string,
  profileId: string,
  expectedClubId: string,
): Promise<{ error?: string }> {
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: ERROR_MESSAGES[guard.error] };

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
  expectedClubId: string,
): Promise<{ data?: { id: string; display_name: string }; error?: string }> {
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: ERROR_MESSAGES[guard.error] };

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
  expectedClubId: string,
): Promise<{ error?: string }> {
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: ERROR_MESSAGES[guard.error] };

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
  expectedClubId: string,
): Promise<{ error?: string }> {
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: ERROR_MESSAGES[guard.error] };

  const supabase = await createClient();

  const { error } = await supabase.rpc("admin_remove_guest", {
    p_event_id: eventId,
    p_guest_id: guestId,
  });

  if (error) return { error: rpcError(error) };
  return {};
}

// ---------------------------------------------------------------------------
// markAttendance
// Phase 26F1: wraps the mark_attendance RPC in a Server Action (moved off
// the client-side supabase.rpc call in EventRosterSheet.tsx) so the
// stale-club preflight guard can run before the write. Returns the raw
// error code/message rather than a pre-mapped string — EventRosterSheet
// already does its own inline mapping (event_archived -> friendly text) and
// now also maps stale_club_context the same way, so no behavior changes for
// existing error codes.
// ---------------------------------------------------------------------------
export async function markAttendance(
  eventId:          string,
  profileId:        string,
  attendanceStatus: string | null,
  expectedClubId:   string,
): Promise<{ error?: string }> {
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: guard.error };

  const supabase = await createClient();

  const { error } = await supabase.rpc("mark_attendance", {
    p_event_id:          eventId,
    p_profile_id:        profileId,
    p_attendance_status: attendanceStatus,
  });

  if (error) return { error: error.message };
  return {};
}

// ---------------------------------------------------------------------------
// archiveEventAction
// Archives a past or cancelled event. Does not notify members, does not
// modify linked records (participants, guests, reservations).
// ---------------------------------------------------------------------------
export async function archiveEventAction(
  eventId: string,
  expectedClubId: string,
): Promise<{ error?: string }> {
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: ARCHIVE_ERROR_MESSAGES[guard.error] };

  const supabase = await createClient();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase.rpc as any)("archive_event", { p_event_id: eventId });

  if (error) {
    const code = error.message?.trim() ?? "";
    return { error: ARCHIVE_ERROR_MESSAGES[code] ?? "An unexpected error occurred. Please try again." };
  }

  revalidatePath("/events");
  return {};
}

// ---------------------------------------------------------------------------
// unarchiveEventAction
// Removes the archive mark from an event, making it visible in default views.
// Does not notify members, does not modify linked records.
// ---------------------------------------------------------------------------
export async function unarchiveEventAction(
  eventId: string,
  expectedClubId: string,
): Promise<{ error?: string }> {
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: UNARCHIVE_ERROR_MESSAGES[guard.error] };

  const supabase = await createClient();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase.rpc as any)("unarchive_event", { p_event_id: eventId });

  if (error) {
    const code = error.message?.trim() ?? "";
    return { error: UNARCHIVE_ERROR_MESSAGES[code] ?? "An unexpected error occurred. Please try again." };
  }

  revalidatePath("/events");
  return {};
}

const MEMBER_JOINABLE_ERROR_MESSAGES: Record<string, string> = {
  [STALE_CLUB_CONTEXT_ERROR]: STALE_CLUB_MESSAGE,
  not_authenticated: "You must be signed in.",
  insufficient_role: "You do not have permission to change this event.",
  event_not_found:   "Event not found.",
  event_cancelled:   "Cancelled events cannot be changed.",
  event_archived:    "Archived events cannot be changed.",
  event_started:     "This event has already started and can no longer be changed.",
  invalid_value:     "Invalid value.",
};

// ---------------------------------------------------------------------------
// setEventMemberJoinableAction
// Toggles whether members can self-join an event. Eligible on future scheduled
// non-archived events. Pros may only change their own events.
// ---------------------------------------------------------------------------
export async function setEventMemberJoinableAction(
  eventId:        string,
  memberJoinable: boolean,
  expectedClubId: string,
): Promise<{ error?: string }> {
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: MEMBER_JOINABLE_ERROR_MESSAGES[guard.error] };

  const supabase = await createClient();

  const { error } = await supabase.rpc("set_event_member_joinable", {
    p_event_id:        eventId,
    p_member_joinable: memberJoinable,
  });

  if (error) {
    const code = error.message?.trim() ?? "";
    return { error: MEMBER_JOINABLE_ERROR_MESSAGES[code] ?? "An unexpected error occurred. Please try again." };
  }

  // Revalidate the canonical member-facing surfaces where member_joinable
  // affects event visibility or the ability to self-join.
  revalidatePath("/events");
  revalidatePath("/calendar");
  return {};
}

// ---------------------------------------------------------------------------
// updateEventAdmin
// Phase 30C2: Admin-only edit of a single eligible future event (standalone
// or one individual program-generated session). Calls update_event, which
// performs one genuine UPDATE on `events` plus a transactional court-set
// diff against its linked reservations (never cancel-and-recreate), and
// returns the updated event, which fields actually changed, and the exact
// {notification_id, user_id} pairs for every participant notified. Errors
// are returned raw (code/message) — EditEventSheet owns the friendly
// mapping, matching the updateMemberReservationAdmin precedent.
// ---------------------------------------------------------------------------

interface UpdateEventResult {
  event:           Record<string, unknown>;
  changed_fields:  string[];
  notifications:   Array<{ notification_id: string; user_id: string }>;
}

export async function updateEventAdmin(params: {
  p_event_id:             string;
  p_expected_updated_at:  string;
  p_title:                string;
  p_event_type_id:        string;
  p_starts_at:            string;
  p_ends_at:              string;
  p_court_ids:            string[];
  p_capacity:             number;
  p_description?:         string | null;
  expectedClubId:         string;
}): Promise<{ data?: { changedFields: string[] }; error?: { code?: string; message: string } }> {
  const { expectedClubId, ...rpcParams } = params;
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: { message: guard.error } };

  const supabase = await createClient();

  const { data, error } = await supabase.rpc("update_event", {
    ...rpcParams,
    p_expected_club_id: expectedClubId,
  });
  if (error) return { error: { code: error.code, message: error.message } };

  const result = data as unknown as UpdateEventResult | null;
  const changedFields = result?.changed_fields ?? [];
  const notifications = result?.notifications ?? [];

  // Phase 31C: dispatch runs through dispatchEventNotification for each
  // exact {notification_id, user_id} pair, resolving body/authorization via
  // get_event_delivery_context — never a raw notifications SELECT, which
  // matters even more here than for a single-recipient dispatch since a
  // material edit can notify many participants in one call.
  for (const { notification_id } of notifications) {
    try {
      await dispatchEventNotification(supabase, notification_id);
    } catch {
      // Email/SMS dispatch must never block edit success or surface to the user.
    }
  }

  revalidatePath("/calendar");
  revalidatePath("/events");

  return { data: { changedFields } };
}
