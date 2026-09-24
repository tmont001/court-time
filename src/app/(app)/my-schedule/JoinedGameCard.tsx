"use client";

import { useState } from "react";
import {
  leaveReservationPlayerParticipation,
  type MyReservationPlayerParticipation,
} from "@/app/(app)/calendar/actions";
import { STALE_CLUB_CONTEXT_ERROR, STALE_CLUB_MESSAGE } from "@/lib/staleClub";
import {
  ACTION_BUTTON_SECONDARY_COMPACT,
  ACTION_BUTTON_DESTRUCTIVE_COMPACT,
} from "@/components/styles/actionButtonStyles";

// Phase 39C-2C — My Schedule joined-game card. Self-contained: reads only
// the seven privacy-safe fields get_my_reservation_player_participations
// (0206) already returns — no second reservation/member query, no
// ReservationDetailSheet import, no click-through to the host's own
// booking. Visually distinct from an owned-reservation card ("You
// joined · Hosted by <name>", never the owner's own price/payment/
// cancellation-window UI — the participant is not the payer).
//
// Leave is deliberately NOT gated by member_self_service or roster
// eligibility here — leave_reservation_participation (0204) intentionally
// has no such gate, and this component must not silently reintroduce one:
// an existing participation must remain leaveable even after the club
// later disables self-service or the player's own roster membership
// becomes inactive/removed (0206's own claim-continuity-only read already
// guarantees the card itself keeps showing in that case).

// ─── Helpers ─────────────────────────────────────────────────────────────

function mapLeaveError(code: string): string {
  if (code === STALE_CLUB_CONTEXT_ERROR) return STALE_CLUB_MESSAGE;
  switch (code) {
    case "reservation_participant_not_found":
      return "You're no longer listed as a player on this game.";
    case "reservation_not_found":
      return "This game is no longer available.";
    case "reservation_not_confirmed":
      return "This game is no longer confirmed.";
    case "reservation_already_started":
      return "This game has already started.";
    // leave_reservation_participation (0204) reuses the existing
    // _lock_and_validate_reservation_roster_mutable helper, which raises
    // this when the reservation has been cancelled — a real, reachable
    // case if the booking is cancelled after My Schedule rendered but
    // before the tap (a stale card), not a hypothetical.
    case "reservation_roster_locked":
      return "This game is no longer available.";
    // Structurally unreachable from this card (0206 already excludes the
    // current host from ever appearing as a joined game), but fail
    // friendly rather than surface a raw code if it is somehow ever hit.
    case "reservation_player_search_host_cannot_leave":
      return "Something went wrong. Please try again.";
    default:
      return "Something went wrong. Please try again.";
  }
}

function formatTime(iso: string, tz: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true,
  });
}

// ─── Component ───────────────────────────────────────────────────────────

interface Props {
  participation: MyReservationPlayerParticipation;
  clubId:        string;
  clubTimezone:  string;
}

export default function JoinedGameCard({ participation, clubId, clubTimezone }: Props) {
  const [confirming, setConfirming] = useState(false);
  const [leaving, setLeaving]       = useState(false);
  const [error, setError]           = useState<string | null>(null);

  const start = formatTime(participation.starts_at, clubTimezone);
  const end   = formatTime(participation.ends_at,   clubTimezone);
  const formatLabel = participation.format
    ? participation.format.charAt(0).toUpperCase() + participation.format.slice(1)
    : null;

  async function handleConfirmLeave() {
    setLeaving(true);
    setError(null);

    const result = await leaveReservationPlayerParticipation(participation.reservation_id, clubId);

    if (result.error) {
      setLeaving(false);
      setError(mapLeaveError(result.error));
      return;
    }
    // Success: deliberately do NOT reset leaving/confirming here. The
    // server action already revalidated /my-schedule (and /calendar) —
    // the page's own Server Component re-renders with this participation
    // no longer present, so the card disappears entirely on its own. If
    // we reset the local UI state now, the card would briefly flash back
    // to its normal "Leave" button for the moment between this resolving
    // and that canonical refresh actually landing — so it stays in its
    // disabled "Leaving…" state the whole way through instead. No
    // optimistic local removal is introduced either way.
  }

  return (
    <div className="ct-card mx-4 mb-3 px-4 py-3">
      <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
        You joined · Hosted by {participation.host_display_name}
      </p>
      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
        {participation.court_name}
      </p>
      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
        {start} – {end}
        {formatLabel ? ` · ${formatLabel}` : ""}
      </p>

      {!confirming && (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className={`mt-2 ${ACTION_BUTTON_DESTRUCTIVE_COMPACT}`}
        >
          Leave
        </button>
      )}

      {confirming && (
        <div className="mt-2 space-y-1.5">
          <p className="text-xs font-medium text-gray-900 dark:text-gray-100">Leave this game?</p>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            You&apos;ll be removed from the player list. This does not cancel the booking.
          </p>
          <div className="flex gap-2 pt-0.5">
            <button
              type="button"
              disabled={leaving}
              onClick={() => { setConfirming(false); setError(null); }}
              className={ACTION_BUTTON_SECONDARY_COMPACT}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={leaving}
              onClick={handleConfirmLeave}
              className={ACTION_BUTTON_DESTRUCTIVE_COMPACT}
            >
              {leaving ? "Leaving…" : "Leave Game"}
            </button>
          </div>
          {error && <p className="text-xs text-red-500">{error}</p>}
        </div>
      )}
    </div>
  );
}
