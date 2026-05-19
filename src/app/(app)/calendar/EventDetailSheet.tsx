"use client";

import { useState, useEffect, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";

// ─── Types (same shape as CalendarShell; redefined here to avoid circular import) ─

interface EventParticipant {
  profile_id: string;
  role: string;
  status: string;
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
  if (message === "event_full")          return "This event is now full.";
  if (message === "already_joined")      return "You're already signed up.";
  if (message === "event_not_available") return "This event is no longer available.";
  return "Something went wrong. Please try again.";
}

function mapLeaveError(message: string): string {
  if (message === "not_joined")  return "You are not signed up for this event.";
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
  const [participantProfiles, setParticipantProfiles] = useState<ParticipantProfile[]>([]);
  const [cancelConfirming, setCancelConfirming]       = useState(false);
  const [cancelLoading, setCancelLoading]             = useState(false);
  const [cancelError, setCancelError]                 = useState<string | null>(null);

  // ── Derived values ────────────────────────────────────────────────────────

  // Only confirmed participants with role = 'participant' consume capacity.
  // Hosts never count toward capacity — matches the backend join_event logic.
  const confirmedParticipants = event.event_participants
    .filter(p => p.status === "confirmed" && p.role === "participant")
    .sort((a, b) => a.profile_id.localeCompare(b.profile_id));

  const waitlistedParticipants = event.event_participants
    .filter(p => p.status === "waitlisted");

  const confirmedCount  = confirmedParticipants.length;
  const waitlistCount   = waitlistedParticipants.length;
  const isFull          = confirmedCount >= event.capacity;

  // Exclude cancelled rows — a user who left should be treated as not joined.
  const myPart       = event.event_participants.find(
    p => p.profile_id === userId && p.status !== "cancelled"
  );
  const isHost       = myPart?.role === "host";
  const isWaitlisted = myPart?.status === "waitlisted";

  // 1-based position among waitlisted rows (order matches DB created_at order;
  // CalendarShell fetches participants in insertion order as a proxy).
  const myWaitlistPosition = isWaitlisted
    ? waitlistedParticipants.findIndex(p => p.profile_id === userId) + 1
    : null;

  const canCancelEvent = userRole === "admin" || isHost;

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
    const { error: rpcError } = await supabase.rpc("join_event", { p_event_id: event.id });
    if (rpcError) {
      setError(mapJoinError(rpcError.message));
      setLoading(false);
      return;
    }
    onRefresh();
    onClose();
  }

  async function handleLeave() {
    setLoading(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc("leave_event", { p_event_id: event.id });
    if (rpcError) {
      setError(mapLeaveError(rpcError.message));
      setLoading(false);
      return;
    }
    onRefresh();
    onClose();
  }

  async function handleCancelEvent() {
    setCancelLoading(true);
    setCancelError(null);
    const { error: rpcError } = await supabase.rpc("cancel_event", { p_event_id: event.id });
    if (rpcError) {
      setCancelError(
        rpcError.message === "event_not_found"
          ? "This event has already been cancelled."
          : "Something went wrong. Please try again."
      );
      setCancelLoading(false);
      return;
    }
    onRefresh();
    onClose();
  }

  // ── Button ────────────────────────────────────────────────────────────────

  const buttonDisabled = isHost || loading;

  const buttonLabel = loading
    ? (isHost ? "You're the Host" : isWaitlisted || (!myPart && isFull) ? "Joining…" : "Leaving…")
    : isHost        ? "You're the Host"
    : isWaitlisted  ? `Leave Waitlist${myWaitlistPosition ? ` (#${myWaitlistPosition})` : ""}`
    : myPart        ? "Leave Event"
    : isFull        ? "Join Waitlist"
    : "Join Event";

  const handleAction = (myPart && !isHost) ? handleLeave : handleJoin;

  const buttonClass = isHost
    ? "bg-gray-100 text-gray-500"
    : isWaitlisted
    ? "bg-amber-50 text-amber-700 border border-amber-200"
    : myPart
    ? "bg-red-50 text-red-600 border border-red-200"
    : "bg-gray-900 text-white";

  // ── Participant display ────────────────────────────────────────────────────

  const shownParticipants = confirmedParticipants.slice(0, MAX_NAMES);
  const nameRemainder     = confirmedParticipants.length - MAX_NAMES;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />
      <div className="fixed bottom-0 left-0 right-0 bg-white rounded-t-2xl z-50 px-6 pt-5 pb-8 shadow-xl">

        {/* Handle */}
        <div className="w-10 h-1 bg-gray-200 rounded-full mx-auto mb-4" />

        {/* Event type pill */}
        <span
          className="inline-block rounded-full px-2.5 py-1 text-[11px] font-semibold text-white mb-3"
          style={{ background: event.event_types.color }}
        >
          {event.event_types.label}
        </span>

        {/* Title */}
        <p className="text-base font-semibold text-gray-900">{event.title}</p>

        {/* Date */}
        <p className="text-sm text-gray-500 mt-0.5">{dateLabel}</p>

        {/* Time */}
        <p className="text-sm text-gray-700 mt-0.5 font-medium">
          {startLabel} – {endLabel}
        </p>

        {/* Courts */}
        {courtNames && (
          <p className="text-sm text-gray-500 mt-0.5">{courtNames}</p>
        )}

        {/* Capacity */}
        <p className="text-sm text-gray-500 mt-0.5">
          {confirmedCount} of {event.capacity} spots filled
          {waitlistCount > 0 ? ` · ${waitlistCount} on waitlist` : "."}
        </p>

        {/* Participant names (only when event type opts in) */}
        {event.event_types.shows_participant_names && confirmedCount > 0 && (
          <div className="mt-3">
            {participantProfiles.length > 0 ? (
              <p className="text-xs text-gray-500">
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
              <p className="text-xs text-gray-400">Loading participants…</p>
            )}
          </div>
        )}

        {/* Error */}
        {error && <p className="mt-3 text-xs text-red-500">{error}</p>}

        {/* Action button */}
        <button
          disabled={buttonDisabled}
          onClick={handleAction}
          className={`mt-5 w-full py-3 rounded-xl text-sm font-semibold disabled:opacity-40 ${buttonClass}`}
        >
          {buttonLabel}
        </button>

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
                <p className="text-xs text-gray-600 mb-2">Cancel this event?</p>
                <div className="flex gap-2 justify-center">
                  <button
                    onClick={() => { setCancelConfirming(false); setCancelError(null); }}
                    className="px-3 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-600"
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
    </>
  );
}
