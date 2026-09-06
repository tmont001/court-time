"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { assertActiveClub } from "@/lib/supabase/staleClub";
import { dispatchEventNotification, dispatchWaitlistNotification } from "@/lib/notification-dispatch";
import { STALE_CLUB_CONTEXT_ERROR, STALE_CLUB_MESSAGE } from "@/lib/staleClub";
import { ADMIN_EVENT_SELECT, mapAdminEventRow } from "./adminEventRow";
import type { RawAdminEventRow, AdminEventRow } from "./adminEventRow";
import { canAccessOperationsWorkspace } from "@/lib/auth/roles";
import { fetchPaymentStates } from "@/app/(app)/admin/payments/actions";
import {
  OPEN_CHECKOUT_REQUIRES_RESOLUTION,
  resolveBlockingCheckoutBeforeMutation,
} from "@/lib/stripe/checkoutInvalidation";
import { createPrivilegedClient } from "@/lib/supabase/privileged";

// Phase 34F-B — bounded batch resolution for Event-level fan-out guards
// (update_event's material-edit path — mirrors calendar/actions.ts's own
// identical helper for cancel_event exactly; not re-exported from there to
// avoid a cross-file "use server" re-export, which Next.js Server Actions
// modules don't support for non-async-function values). Lists every
// currently-blocking (bound + open) Checkout attempt for the Event via the
// service-role-only list_event_blocking_checkout_attempts RPC (0161), then
// resolves each via the SAME generic resolveBlockingCheckoutBeforeMutation
// helper every other guard already uses.
async function resolveAllBlockingEventCheckouts(
  eventId: string,
  clubId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const privileged = createPrivilegedClient();
  if (!privileged) return { ok: false, error: "Something went wrong. Please try again." };

  const { data: blockingRows, error: listError } = await privileged.rpc(
    "list_event_blocking_checkout_attempts",
    { p_event_id: eventId, p_club_id: clubId },
  );
  if (listError) return { ok: false, error: "Something went wrong. Please try again." };

  for (const { payment_id } of blockingRows ?? []) {
    const resolved = await resolveBlockingCheckoutBeforeMutation(payment_id, clubId);
    if (!resolved.ok) return { ok: false, error: resolved.error };
  }

  return { ok: true };
}

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
  // Phase 34A: predates the isOperator/canAccessOperationsWorkspace
  // refactor — this inline check was never widened alongside the RPCs it
  // gates access to (get_admin_club_events-equivalent select below), which
  // is why Staff could archive/unarchive an Event (0136) but couldn't load
  // the Archived view or Load More at all.
  if (!canAccessOperationsWorkspace(profile.role)) {
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
  // Phase 33G1D
  event_capacity_exceeded:        "This session is at capacity.",
  // Phase 33G3: raised by the 0126 Member schedule guard trigger on
  // event_participants — previously unmapped here, so it fell through to
  // the generic "An unexpected error occurred" fallback below.
  member_schedule_conflict:       "That member already has another confirmed commitment at that time.",
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

  // Phase 34F-B — resolve this participant's own current payment (if any)
  // BEFORE attempting the removal, so a subsequent open_checkout_requires_
  // resolution failure (raised by admin_remove_participant's own pre-
  // mutation guard, 0161) can be resolved without a second round-trip to
  // discover which payment was blocking.
  const { data: participantRow } = await supabase
    .from("event_participants")
    .select("id")
    .eq("event_id", eventId)
    .eq("profile_id", profileId)
    .in("status", ["confirmed", "offered", "waitlisted"])
    .maybeSingle();

  let { error } = await supabase.rpc("admin_remove_participant", {
    p_event_id:   eventId,
    p_profile_id: profileId,
  });

  // Phase 34F-B — a bound, potentially still-payable Stripe Checkout
  // Session is open for this participant's payment — resolve it via
  // Stripe before safely retrying exactly once, mirroring
  // recordManualPayment's own established resolve-then-retry pattern.
  if (error?.message.includes(OPEN_CHECKOUT_REQUIRES_RESOLUTION) && participantRow) {
    const { data: states } = await fetchPaymentStates("event_participant", [participantRow.id]);
    const paymentId = states?.[0]?.current_payment_id ?? null;
    if (!paymentId) return { error: rpcError(error) };
    const resolved = await resolveBlockingCheckoutBeforeMutation(paymentId, expectedClubId);
    if (!resolved.ok) return { error: resolved.error };
    ({ error } = await supabase.rpc("admin_remove_participant", {
      p_event_id:   eventId,
      p_profile_id: profileId,
    }));
  }

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
// adminAddRosterParticipant
// Phase 33D2: adds a roster Member — claimed OR no-account — directly to
// event_participants (never event_guests). This is the new, primary
// staff-managed path going forward, alongside (not replacing) adminAddMember
// (profile_id-keyed) and adminAddRosterMemberToEvent (event_guests-keyed,
// unclaimed-only, superseded but left in place unused).
// ---------------------------------------------------------------------------
export async function adminAddRosterParticipant(
  eventId:        string,
  rosterMemberId: string,
  expectedClubId: string,
): Promise<{ error?: string }> {
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: ERROR_MESSAGES[guard.error] };

  const supabase = await createClient();

  const { error } = await supabase.rpc("admin_add_roster_participant", {
    p_event_id:         eventId,
    p_expected_club_id: expectedClubId,
    p_roster_member_id: rosterMemberId,
  });

  if (error) return { error: rpcError(error) };
  return {};
}

// ---------------------------------------------------------------------------
// adminRemoveRosterParticipant
// Phase 33D2: removes a roster Member's event_participants row — matched by
// roster_member_id, so this works regardless of claim status.
// ---------------------------------------------------------------------------
export async function adminRemoveRosterParticipant(
  eventId:        string,
  rosterMemberId: string,
  expectedClubId: string,
): Promise<{ error?: string }> {
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: ERROR_MESSAGES[guard.error] };

  const supabase = await createClient();

  // Phase 34F-B — resolve this participant's own current payment (if any)
  // BEFORE attempting the removal, mirroring adminRemoveParticipant's own
  // identical resolve-then-retry pattern exactly.
  const { data: participantRow } = await supabase
    .from("event_participants")
    .select("id")
    .eq("event_id", eventId)
    .eq("roster_member_id", rosterMemberId)
    .in("status", ["confirmed", "offered", "waitlisted"])
    .maybeSingle();

  let { error } = await supabase.rpc("admin_remove_roster_participant", {
    p_event_id:         eventId,
    p_expected_club_id: expectedClubId,
    p_roster_member_id: rosterMemberId,
  });

  if (error?.message.includes(OPEN_CHECKOUT_REQUIRES_RESOLUTION) && participantRow) {
    const { data: states } = await fetchPaymentStates("event_participant", [participantRow.id]);
    const paymentId = states?.[0]?.current_payment_id ?? null;
    if (!paymentId) return { error: rpcError(error) };
    const resolved = await resolveBlockingCheckoutBeforeMutation(paymentId, expectedClubId);
    if (!resolved.ok) return { error: resolved.error };
    ({ error } = await supabase.rpc("admin_remove_roster_participant", {
      p_event_id:         eventId,
      p_expected_club_id: expectedClubId,
      p_roster_member_id: rosterMemberId,
    }));
  }

  if (error) return { error: rpcError(error) };
  return {};
}

// ---------------------------------------------------------------------------
// adminForceConfirmRosterParticipant / adminOfferSpotRosterParticipant /
// adminExpireOfferRosterParticipant / markAttendanceRosterParticipant
// Phase 33D2a: roster-aware equivalents of adminForceConfirm / adminOfferSpot
// / adminExpireOffer / markAttendance — same rules (capacity, FIFO
// skip-list, offer window, role permissions), keyed by roster_member_id so a
// no-account participant supports the same operations as a claimed one. The
// profile_id-keyed originals above are unchanged, kept for deployed
// compatibility with a still-claimed participant's roster row.
// ---------------------------------------------------------------------------
export async function adminForceConfirmRosterParticipant(
  eventId:        string,
  rosterMemberId: string,
  expectedClubId: string,
): Promise<{ error?: string }> {
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: ERROR_MESSAGES[guard.error] };

  const supabase = await createClient();

  const { data, error } = await supabase.rpc("admin_force_confirm_roster_participant", {
    p_event_id:         eventId,
    p_expected_club_id: expectedClubId,
    p_roster_member_id: rosterMemberId,
  });

  if (error) return { error: rpcError(error) };

  const result = data as unknown as { participant: Record<string, unknown>; notification_id: string | null } | null;

  try {
    await dispatchWaitlistNotification(supabase, result?.notification_id ?? null);
  } catch {
    // Email/SMS dispatch must never surface as a user-facing error.
  }

  return {};
}

export async function adminOfferSpotRosterParticipant(
  eventId:        string,
  rosterMemberId: string,
  expectedClubId: string,
): Promise<{ error?: string }> {
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: ERROR_MESSAGES[guard.error] };

  const supabase = await createClient();

  const { data, error } = await supabase.rpc("admin_offer_spot_roster_participant", {
    p_event_id:         eventId,
    p_expected_club_id: expectedClubId,
    p_roster_member_id: rosterMemberId,
  });

  if (error) return { error: rpcError(error) };

  const result = data as unknown as { participant: Record<string, unknown>; notification_id: string | null } | null;

  try {
    await dispatchWaitlistNotification(supabase, result?.notification_id ?? null);
  } catch {
    // Email/SMS dispatch must never surface as a user-facing error.
  }

  return {};
}

export async function adminExpireOfferRosterParticipant(
  eventId:        string,
  rosterMemberId: string,
  expectedClubId: string,
): Promise<{ error?: string }> {
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: ERROR_MESSAGES[guard.error] };

  const supabase = await createClient();

  const { error } = await supabase.rpc("admin_expire_offer_roster_participant", {
    p_event_id:         eventId,
    p_expected_club_id: expectedClubId,
    p_roster_member_id: rosterMemberId,
  });

  if (error) return { error: rpcError(error) };
  return {};
}

export async function markAttendanceRosterParticipant(
  eventId:          string,
  rosterMemberId:   string,
  attendanceStatus: string | null,
  expectedClubId:   string,
): Promise<{ error?: string }> {
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: guard.error };

  const supabase = await createClient();

  const { error } = await supabase.rpc("mark_attendance_roster_participant", {
    p_event_id:          eventId,
    p_expected_club_id:  expectedClubId,
    p_roster_member_id:  rosterMemberId,
    p_attendance_status: attendanceStatus,
  });

  if (error) return { error: error.message };
  return {};
}

// ---------------------------------------------------------------------------
// markAttendanceGuest
// Phase 33E2: Guest-attendance parity action, mirrors
// markAttendanceRosterParticipant's shape exactly, keyed by guest id.
// ---------------------------------------------------------------------------
export async function markAttendanceGuest(
  eventId:          string,
  guestId:          string,
  attendanceStatus: string | null,
  expectedClubId:   string,
): Promise<{ error?: string }> {
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: guard.error };

  const supabase = await createClient();

  const { error } = await supabase.rpc("mark_attendance_guest", {
    p_event_id:          eventId,
    p_expected_club_id:  expectedClubId,
    p_guest_id:          guestId,
    p_attendance_status: attendanceStatus,
  });

  if (error) return { error: error.message };
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

  let { data, error } = await supabase.rpc("update_event", {
    ...rpcParams,
    p_expected_club_id: expectedClubId,
  });

  // Phase 34F-B — material-edit fan-out guard: update_event's own
  // pre-mutation loop (0161) raises open_checkout_requires_resolution if
  // the edit is material (starts_at/ends_at/court set/event_type_id) AND
  // ANY currently-confirmed participant has a bound, possibly-still-
  // payable Stripe Checkout Session, rolling back the WHOLE edit before it
  // touches anything. Same bounded batch-resolve-then-retry shape as
  // cancelEvent (calendar/actions.ts) — never an unbounded loop; a
  // resolution failure leaves the Event exactly as it was.
  for (let attempt = 0; attempt < 2 && error?.message.includes(OPEN_CHECKOUT_REQUIRES_RESOLUTION); attempt++) {
    const resolved = await resolveAllBlockingEventCheckouts(params.p_event_id, expectedClubId);
    if (!resolved.ok) return { error: { message: resolved.error } };
    ({ data, error } = await supabase.rpc("update_event", {
      ...rpcParams,
      p_expected_club_id: expectedClubId,
    }));
  }

  if (error) return { error: { code: error.code, message: error.message } };

  const result = data as unknown as UpdateEventResult | null;
  const changedFields = result?.changed_fields ?? [];
  const notifications = result?.notifications ?? [];

  // Phase 31C: dispatch runs through dispatchEventNotification for each
  // exact {notification_id, user_id} pair, resolving body/authorization via
  // get_event_delivery_context — never a raw notifications SELECT, which
  // matters even more here than for a single-recipient dispatch since a
  // material edit can notify many participants in one call.
  //
  // Phase 34F-D (performance) — dispatched in PARALLEL, not sequentially
  // awaited one at a time. Root cause of the reported "editing one
  // generated Program session's court/time is noticeably slow": a
  // whole-program session's own event_participants includes every
  // currently enrolled Member (materialized by _materialize_program_
  // member_into_future_events, 0113), so a court/time edit's own
  // update_event notification loop (0161) can produce one notification per
  // enrolled Member — tens of recipients for a real class/clinic roster,
  // versus the handful an ordinary Event edit usually notifies. Each
  // dispatchEventNotification call does its own network-bound SMS/email
  // send; awaited one at a time, this Server Action's total latency scaled
  // linearly with roster size and blocked the Save action the whole time.
  // Each dispatch is fully independent (its own DB read + its own SMS/
  // email attempt, no shared state, no ordering dependency between
  // recipients) and already isolates its own failure — parallelizing
  // changes nothing about error handling or which notifications are sent,
  // only how long the Admin waits for Save to resolve. Never touches the
  // Program-level Checkout invariant: this loop only ever sends
  // notifications, no payment/domain mutation happens here at all.
  await Promise.all(
    notifications.map(async ({ notification_id }) => {
      try {
        await dispatchEventNotification(supabase, notification_id);
      } catch {
        // Email/SMS dispatch must never block edit success or surface to the user.
      }
    }),
  );

  revalidatePath("/calendar");
  revalidatePath("/events");

  return { data: { changedFields } };
}

// ---------------------------------------------------------------------------
// setEventPriceOverrideAction
// Phase 34B: Admin-only. Changes only this Event's own price snapshot —
// never rewrites already-created event_participants/event_guests price
// snapshots. New participants/guests added after this call use the new
// price. Deliberately a separate, post-creation-only action from
// create_event, which stays price-blind for its shared Staff/Pro/Admin
// signature.
// ---------------------------------------------------------------------------
const PRICE_OVERRIDE_ERROR_MESSAGES: Record<string, string> = {
  [STALE_CLUB_CONTEXT_ERROR]: STALE_CLUB_MESSAGE,
  not_authenticated: "You must be signed in.",
  insufficient_role: "Admin access required.",
  event_not_found:   "Event not found.",
  invalid_price:     "Price must be zero or a positive amount.",
};

export async function setEventPriceOverrideAction(
  eventId: string,
  priceAmountCents: number | null,
  expectedClubId: string,
): Promise<{ error?: string }> {
  const guard = await assertActiveClub(expectedClubId);
  if (!guard.ok) return { error: PRICE_OVERRIDE_ERROR_MESSAGES[guard.error] };

  const supabase = await createClient();

  const { error } = await supabase.rpc("set_event_price_override", {
    p_event_id: eventId,
    p_price_amount_cents: priceAmountCents,
  });

  if (error) {
    const code = error.message?.trim() ?? "";
    return { error: PRICE_OVERRIDE_ERROR_MESSAGES[code] ?? "Failed to save event price." };
  }

  revalidatePath("/calendar");
  revalidatePath("/events");
  return {};
}
