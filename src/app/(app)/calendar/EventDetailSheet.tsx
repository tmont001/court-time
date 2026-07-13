"use client";

import { useState, useEffect, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import EventRosterSheet, { type RosterParticipantRow } from "./EventRosterSheet";
import ResponsiveSheet from "@/components/ResponsiveSheet";
import { cancelEvent, joinEvent, leaveEvent, acceptWaitlistOffer, declineWaitlistOffer } from "./actions";

// ─── Types (same shape as CalendarShell; redefined here to avoid circular import) ─

interface EventParticipant {
  profile_id: string;
  role: string;
  status: string;
  offer_expires_at?: string | null;
}

interface EventWithDetails {
  id: string;
  title: string;
  starts_at: string;
  ends_at: string;
  capacity: number;
  status: string;
  created_by: string;
  event_types: {
    key: string;
    label: string;
    color: string;
    shows_participant_names: boolean;
  };
  event_participants: EventParticipant[];
  event_guests: Array<{ id: string }>;
  court_ids: string[];
}

interface Court {
  id: string;
  name: string;
  display_order: number;
}

interface ParticipantProfile {
  id: string;
  first_name: string | null;
  last_name: string | null;
}

interface Props {
  event: EventWithDetails;
  courts: Court[];
  userId: string;
  userRole: string;
  clubTimezone: string;
  onClose: () => void;
  onRefresh: () => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatParticipantName(profile: ParticipantProfile): string {
  const first      = profile.first_name ?? "?";
  const lastInitial = profile.last_name
    ? profile.last_name[0].toUpperCase() + "."
    : "";
  return lastInitial ? `${first} ${lastInitial}` : first;
}

function mapJoinError(message: string): string {
  if (message === "event_full")             return "This event is now full.";
  if (message === "already_joined")         return "You're already signed up.";
  if (message === "event_already_started")  return "This event has already started.";
  if (message === "event_not_available")    return "This event is no longer available.";
  if (message === "event_not_joinable")     return "This event is admin-managed. Contact the office to be added to the roster.";
  return "Something went wrong. Please try again.";
}

function mapLeaveError(message: string): string {
  if (message === "not_joined")  return "You are not signed up for this event.";
  if (message === "not_authenticated") return "Please sign in to continue.";
  return "Something went wrong. Please try again.";
}

function mapOfferError(message: string): string {
  if (message === "offer_not_found") return "This offer is no longer valid.";
  if (message === "offer_expired")   return "Your offer has expired. You can rejoin the waitlist if you're still interested.";
  if (message === "not_authenticated") return "Please sign in to continue.";
  return "Something went wrong. Please try again.";
}

// ─── Component ───────────────────────────────────────────────────────────────

const MAX_NAMES = 5;

export default function EventDetailSheet({
  event, courts, userId, userRole, clubTimezone, onClose, onRefresh,
}: Props) {
  const supabase = useMemo(() => createClient(), []);

  const [loading, setLoading]                         = useState(false);
  const [error, setError]                             = useState<string | null>(null);
  const [localParticipants, setLocalParticipants]     = useState<EventParticipant[]>(event.event_participants);
  const [localGuestCount, setLocalGuestCount]         = useState(event.event_guests?.length ?? 0);
  const [participantProfiles, setParticipantProfiles] = useState<ParticipantProfile[]>([]);
  const [cancelConfirming, setCancelConfirming]       = useState(false);
  const [cancelLoading, setCancelLoading]             = useState(false);
  const [cancelError, setCancelError]                 = useState<string | null>(null);
  const [rosterOpen, setRosterOpen]                   = useState(false);
  const [rosterRefreshTick, setRosterRefreshTick]     = useState(0);
  const [offerLoading, setOfferLoading]               = useState<"accept" | "pass" | null>(null);
  const [offerError, setOfferError]                   = useState<string | null>(null);

  // ── Derived values ────────────────────────────────────────────────────────

  // Only confirmed participants with role = 'participant' consume capacity.
  // Hosts never count toward capacity — matches the backend join_event logic.
  const confirmedParticipants = localParticipants
    .filter(p => p.status === "confirmed" && p.role === "participant")
    .sort((a, b) => a.profile_id.localeCompare(b.profile_id));

  // Phase 18B: offered rows also hold a spot (capacity guard: confirmed+offered).
  const offeredParticipants = localParticipants
    .filter(p => p.status === "offered");

  // Waitlisted: only truly-waitlisted rows (excludes offered and guests).
  const waitlistedParticipants = localParticipants
    .filter(p => p.status === "waitlisted");

  const confirmedCount  = confirmedParticipants.length;
  const offeredCount    = offeredParticipants.length;
  const guestCount      = localGuestCount;
  const waitlistCount   = waitlistedParticipants.length;
  // Full when confirmed + offered + guests reach capacity (Phase 19A).
  const isFull          = (confirmedCount + offeredCount + guestCount) >= event.capacity;

  // Exclude cancelled rows — a user who left should be treated as not joined.
  const myPart       = localParticipants.find(
    p => p.profile_id === userId && p.status !== "cancelled"
  );
  const isHost       = myPart?.role === "host";
  const isWaitlisted = myPart?.status === "waitlisted";
  const isOffered    = myPart?.status === "offered";

  // Offer expiry (client-side). Evaluated once per render; no polling needed
  // because the sheet closes/re-opens on every action refresh.
  const myOfferExpiresAt  = isOffered ? (myPart?.offer_expires_at ?? null) : null;
  const offerExpired      = myOfferExpiresAt ? new Date(myOfferExpiresAt) <= new Date() : false;

  // 1-based position among waitlisted rows (order matches DB created_at order;
  // CalendarShell fetches participants in insertion order as a proxy).
  const myWaitlistPosition = isWaitlisted
    ? waitlistedParticipants.findIndex(p => p.profile_id === userId) + 1
    : null;

  // Members should not be able to join or waitlist for events that have already started.
  const isPastEvent    = new Date(event.starts_at) < new Date();
  const canCancelEvent = userRole === "admin" || isHost;
  const canViewRoster  = userRole === "admin" || userRole === "pro";

  // Total active participants shown in the roster button label (confirmed + offered + waitlisted + guests).
  const rosterCount = localParticipants.filter(
    p => p.status === "confirmed" || p.status === "offered" || p.status === "waitlisted"
  ).length + guestCount;

  const courtNames = event.court_ids
    .map(id => courts.find(c => c.id === id)?.name ?? "Court")
    .join(", ");

  const dateLabel = new Date(event.starts_at).toLocaleDateString("en-US", {
    timeZone: clubTimezone, weekday: "long", month: "long", day: "numeric",
  });
  const startLabel = new Date(event.starts_at).toLocaleTimeString("en-US", {
    timeZone: clubTimezone, hour: "numeric", minute: "2-digit", hour12: true,
  });
  const endLabel = new Date(event.ends_at).toLocaleTimeString("en-US", {
    timeZone: clubTimezone, hour: "numeric", minute: "2-digit", hour12: true,
  });

  // ── Fetch participant profiles for events that show names ─────────────────

  useEffect(() => {
    if (!event.event_types.shows_participant_names) return;
    const ids = confirmedParticipants.map(p => p.profile_id);
    if (ids.length === 0) return;
    supabase
      .from("profiles")
      .select("id, first_name, last_name")
      .in("id", ids)
      .then(({ data }) => { if (data) setParticipantProfiles(data); });
  }, [event.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Handlers ──────────────────────────────────────────────────────────────

  async function handleJoin() {
    setLoading(true);
    setError(null);
    const { error: rpcError } = await joinEvent(event.id);
    if (rpcError) {
      setError(mapJoinError(rpcError));
      setLoading(false);
      return;
    }
    setRosterRefreshTick(t => t + 1);
    onRefresh();
    onClose();
  }

  async function handleLeave() {
    setLoading(true);
    setError(null);
    const result = await leaveEvent(event.id);
    if (result?.error) {
      setError(mapLeaveError(result.error));
      setLoading(false);
      return;
    }
    setRosterRefreshTick(t => t + 1);
    onRefresh();
    onClose();
  }

  async function handleCancelEvent() {
    setCancelLoading(true);
    setCancelError(null);
    const result = await cancelEvent(event.id);
    if (result?.error) {
      setCancelError(
        result.error === "event_not_found"
          ? "This event has already been cancelled."
          : "Something went wrong. Please try again."
      );
      setCancelLoading(false);
      return;
    }
    onRefresh();
    onClose();
  }

  async function handleAcceptOffer() {
    setOfferLoading("accept");
    setOfferError(null);
    const result = await acceptWaitlistOffer(event.id);
    if (result?.error) {
      setOfferError(mapOfferError(result.error));
      setOfferLoading(null);
      return;
    }
    onRefresh();
    onClose();
  }

  async function handlePassOffer() {
    setOfferLoading("pass");
    setOfferError(null);
    const result = await declineWaitlistOffer(event.id);
    if (result?.error) {
      setOfferError(mapOfferError(result.error));
      setOfferLoading(null);
      return;
    }
    onRefresh();
    onClose();
  }

  // ── Button ────────────────────────────────────────────────────────────────

  // Disable join/waitlist for past events (members cannot join retroactively).
  // Leave actions remain available so members who are already confirmed can leave.
  const joinBlockedByPast = isPastEvent && !myPart && !isHost;
  const buttonDisabled = isHost || loading || joinBlockedByPast;

  const buttonLabel = loading
    ? (isHost ? "You're the Host" : isWaitlisted || (!myPart && isFull) ? "Joining…" : "Leaving…")
    : isHost          ? "You're the Host"
    : joinBlockedByPast ? "Event has passed"
    : isWaitlisted    ? `Leave Waitlist${myWaitlistPosition ? ` (#${myWaitlistPosition})` : ""}`
    : myPart          ? "Leave Event"
    : isFull          ? "Join Waitlist"
    : "Join Event";

  const handleAction = (myPart && !isHost) ? handleLeave : handleJoin;

  const buttonClass = isHost || joinBlockedByPast
    ? "bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400"
    : isWaitlisted
    ? "bg-amber-50 text-amber-700 border border-amber-200"
    : myPart
    ? "bg-red-50 text-red-600 border border-red-200"
    : "bg-accent text-white dark:text-gray-900";

  // ── Participant display ────────────────────────────────────────────────────

  const shownParticipants = confirmedParticipants.slice(0, MAX_NAMES);
  const nameRemainder     = confirmedParticipants.length - MAX_NAMES;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      <ResponsiveSheet onClose={onClose} variant="modal">
        <div className="px-6 pt-5 pb-8 overflow-y-auto flex-1">

        {/* Handle — hidden on desktop (ResponsiveSheet provides close button) */}
        <div className="ct-handlebar mx-auto mb-4 md:hidden" />

        {/* Event type pill */}
        <span
          className="inline-block rounded-full px-2.5 py-1 text-[11px] font-semibold text-white mb-3"
          style={{ background: event.event_types.color }}
        >
          {event.event_types.label}
        </span>

        {/* Title */}
        <p className="text-base font-semibold text-gray-900 dark:text-gray-100">{event.title}</p>

        {/* Date */}
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{dateLabel}</p>

        {/* Time */}
        <p className="text-sm text-gray-700 dark:text-gray-300 mt-0.5 font-medium">
          {startLabel} – {endLabel}
        </p>

        {/* Courts */}
        {courtNames && (
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{courtNames}</p>
        )}

        {/* Capacity — confirmed + offered + guests all consume a spot */}
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
          {confirmedCount + offeredCount + guestCount} of {event.capacity} spots filled
          {waitlistCount > 0 ? ` · ${waitlistCount} on waitlist` : "."}
        </p>

        {/* View Roster — admin/pro only */}
        {canViewRoster && (
          <button
            onClick={() => setRosterOpen(true)}
            className="mt-2 text-xs font-medium text-blue-600 underline-offset-2 underline"
          >
            View Roster ({rosterCount})
          </button>
        )}

        {/* Participant names (only when event type opts in) */}
        {event.event_types.shows_participant_names && confirmedCount > 0 && (
          <div className="mt-3">
            {participantProfiles.length > 0 ? (
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {shownParticipants
                  .map(p => {
                    const prof = participantProfiles.find(pr => pr.id === p.profile_id);
                    return prof ? formatParticipantName(prof) : null;
                  })
                  .filter((name): name is string => name !== null)
                  .join(", ")}
                {nameRemainder > 0 && `, +${nameRemainder} more`}
              </p>
            ) : (
              <p className="text-xs text-gray-400 dark:text-gray-500">Loading participants…</p>
            )}
          </div>
        )}

        {/* ── Offered state — replaces the standard action button ── */}
        {isOffered ? (
          offerExpired ? (
            /* Offer has expired client-side */
            <div className="mt-5">
              <div className="rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 px-4 py-3 text-center">
                <p className="text-sm text-amber-800 dark:text-amber-300">
                  This offer has expired. Rejoin the waitlist if you're still interested.
                </p>
              </div>
              {offerError && <p className="mt-2 text-xs text-red-500">{offerError}</p>}
              <button
                disabled={loading}
                onClick={handleJoin}
                className="mt-3 w-full py-3 rounded-xl text-sm font-semibold bg-accent text-white dark:text-gray-900 disabled:opacity-40"
              >
                {loading ? "Joining…" : isFull ? "Rejoin Waitlist" : "Rejoin Event"}
              </button>
            </div>
          ) : (
            /* Active offer — show deadline + Accept / Pass */
            <div className="mt-5">
              <div className="rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 px-4 py-3">
                <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">
                  Spot offered
                </p>
                {myOfferExpiresAt && (
                  <p className="text-xs text-amber-600 dark:text-amber-400 mt-0.5">
                    Accept by{" "}
                    {new Date(myOfferExpiresAt).toLocaleTimeString("en-US", {
                      timeZone: clubTimezone,
                      hour: "numeric",
                      minute: "2-digit",
                      hour12: true,
                    })}
                  </p>
                )}
              </div>
              {offerError && <p className="mt-2 text-xs text-red-500">{offerError}</p>}
              <div className="flex gap-3 mt-3">
                <button
                  disabled={!!offerLoading}
                  onClick={handlePassOffer}
                  className="flex-1 py-3 rounded-xl text-sm font-semibold border border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-300 disabled:opacity-40"
                >
                  {offerLoading === "pass" ? "Passing…" : "Pass"}
                </button>
                <button
                  disabled={!!offerLoading}
                  onClick={handleAcceptOffer}
                  className="flex-1 py-3 rounded-xl text-sm font-semibold bg-green-600 text-white disabled:opacity-40"
                >
                  {offerLoading === "accept" ? "Accepting…" : "Accept Spot"}
                </button>
              </div>
            </div>
          )
        ) : (
          /* Normal state — Join / Leave / Waitlist / Host */
          <>
            {error && <p className="mt-3 text-xs text-red-500">{error}</p>}
            <button
              disabled={buttonDisabled}
              onClick={handleAction}
              className={`mt-5 w-full py-3 rounded-xl text-sm font-semibold disabled:opacity-40 ${buttonClass}`}
            >
              {buttonLabel}
            </button>
          </>
        )}

        {/* Cancel Event — admin or host only */}
        {canCancelEvent && (
          <div className="mt-4 text-center">
            {!cancelConfirming ? (
              <button
                onClick={() => setCancelConfirming(true)}
                className="text-xs text-red-500 underline"
              >
                Cancel Event
              </button>
            ) : (
              <div>
                <p className="text-xs text-gray-600 dark:text-gray-400 mb-2">Cancel this event?</p>
                <div className="flex gap-2 justify-center">
                  <button
                    onClick={() => { setCancelConfirming(false); setCancelError(null); }}
                    className="px-3 py-1 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300"
                  >
                    Keep
                  </button>
                  <button
                    disabled={cancelLoading}
                    onClick={handleCancelEvent}
                    className="px-3 py-1 rounded-full text-xs font-medium bg-red-600 text-white disabled:opacity-40"
                  >
                    {cancelLoading ? "Cancelling…" : "Yes, cancel"}
                  </button>
                </div>
                {cancelError && <p className="mt-2 text-xs text-red-500">{cancelError}</p>}
              </div>
            )}
          </div>
        )}

        </div>
      </ResponsiveSheet>

      {/* ── Event Roster Sheet — admin/pro only, layers above this sheet ── */}
      {rosterOpen && (
        <EventRosterSheet
          eventId={event.id}
          clubTimezone={clubTimezone}
          userRole={userRole}
          refreshTick={rosterRefreshTick}
          onClose={() => setRosterOpen(false)}
          onRosterChange={(rows: RosterParticipantRow[], gc: number) => {
            setLocalParticipants(rows);
            setLocalGuestCount(gc);
          }}
        />
      )}
    </>
  );
}
