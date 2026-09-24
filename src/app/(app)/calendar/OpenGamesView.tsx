"use client";

import { useEffect, useState } from "react";
import {
  getOpenReservationPlayerSearches,
  joinReservationPlayerSearch,
  type ReservationPlayerSearchOpportunity,
} from "./actions";
import { STALE_CLUB_CONTEXT_ERROR, STALE_CLUB_MESSAGE } from "@/lib/staleClub";
import { ACTION_BUTTON_PRIMARY_COMPACT } from "@/components/styles/actionButtonStyles";

// Phase 39C-2B — Open Games discovery + instant join. A sibling Calendar
// content view (rendered by CalendarShell only when ?view=open-games is
// active), never reservation blocks inside the ordinary calendar grid —
// the grid's own privacy model is completely untouched by this component.
//
// Every read/write goes exclusively through the Phase 39B-2 (0204)
// SECURITY DEFINER RPCs (get_open_reservation_player_searches,
// join_reservation_player_search) — this component never queries
// reservation_player_searches directly (it has zero client-facing RLS
// policies/grants by design), never recomputes occupied/remaining seats,
// and never reproduces the backend's own eligibility/capacity/host/
// already-participating predicates. Cards are display-only: tapping a
// card (outside the Join button) does nothing — a joined participant does
// NOT gain ReservationDetailSheet access to the host's booking, matching
// the locked privacy rule for this phase.

// ─── Types ───────────────────────────────────────────────────────────────

interface Props {
  clubId:       string;
  clubTimezone: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function mapOpenGamesError(code: string): string {
  if (code === STALE_CLUB_CONTEXT_ERROR) return STALE_CLUB_MESSAGE;
  switch (code) {
    case "capability_not_available":
      return "Open Games isn't available for this club.";
    case "roster_identity_required":
      return "Your account doesn't have a player identity for this club.";
    case "roster_member_inactive":
      return "Your club membership isn't currently active.";
    case "reservation_not_found":
      return "This game could not be found.";
    case "reservation_not_confirmed":
      return "This booking is no longer confirmed.";
    case "reservation_already_started":
      return "This game has already started.";
    case "reservation_player_search_full":
      return "That spot is no longer available.";
    case "reservation_player_search_not_open":
      return "This game is no longer open for new players.";
    // Structurally unreachable from this discovery-driven flow (the host
    // is always excluded from the list itself), but fail friendly rather
    // than surface a raw code if it is somehow ever encountered.
    case "reservation_player_search_host_cannot_join":
      return "You can't join your own booking.";
    default:
      return "Something went wrong. Please try again.";
  }
}

function formatDateLabel(iso: string, tz: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    timeZone: tz, weekday: "long", month: "short", day: "numeric",
  });
}

function formatTimeLabel(iso: string, tz: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true,
  });
}

function remainingSpotsLabel(remaining: number): string {
  return remaining === 1 ? "1 spot open" : `${remaining} spots open`;
}

// ─── Component ───────────────────────────────────────────────────────────

export default function OpenGamesView({ clubId, clubTimezone }: Props) {
  const [opportunities, setOpportunities] = useState<ReservationPlayerSearchOpportunity[]>([]);
  const [loading, setLoading]             = useState(true);
  const [loadError, setLoadError]         = useState<string | null>(null);

  const [joiningId, setJoiningId]   = useState<string | null>(null);
  const [joinErrors, setJoinErrors] = useState<Map<string, string>>(new Map());

  function loadOpportunities() {
    setLoading(true);
    setLoadError(null);
    getOpenReservationPlayerSearches(clubId).then(({ data, error }) => {
      if (error) {
        setLoadError(mapOpenGamesError(error));
      } else {
        setOpportunities(data ?? []);
      }
      setLoading(false);
    });
  }

  // Fetches canonical discovery state on every mount — switching to this
  // view (or navigating directly to ?view=open-games) always mounts a
  // fresh instance, so no separate "became active" signal is needed.
  useEffect(() => {
    loadOpportunities();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clubId]);

  async function handleJoin(reservationId: string) {
    setJoiningId(reservationId);
    setJoinErrors(prev => { const next = new Map(prev); next.delete(reservationId); return next; });

    const result = await joinReservationPlayerSearch(reservationId, clubId);

    setJoiningId(null);
    if (result.error) {
      setJoinErrors(prev => new Map(prev).set(reservationId, mapOpenGamesError(result.error!)));
      // A race (last-seat, no-longer-open, etc.) means backend state has
      // moved on — re-fetch canonical state before presenting the final
      // stable list, never leave a now-inaccurate card showing.
      loadOpportunities();
      return;
    }

    // Successful join: never mutate local occupancy/remove the card
    // optimistically — re-fetch canonical state. The joined game
    // disappears naturally because the RPC itself excludes reservations
    // where the caller already has an active participant row.
    loadOpportunities();
  }

  return (
    <div className="flex-1 overflow-y-auto p-3">
      {loading && (
        <p className="text-sm text-gray-400 dark:text-gray-500 text-center py-6">Loading open games…</p>
      )}

      {!loading && loadError && (
        <div className="text-center py-6">
          <p className="text-sm text-red-500">{loadError}</p>
          <button
            type="button"
            onClick={loadOpportunities}
            className={`mt-3 ${ACTION_BUTTON_PRIMARY_COMPACT}`}
          >
            Try again
          </button>
        </div>
      )}

      {!loading && !loadError && opportunities.length === 0 && (
        <p className="text-sm text-gray-400 dark:text-gray-500 text-center py-6">No open games right now.</p>
      )}

      {!loading && !loadError && opportunities.length > 0 && (
        <div className="space-y-3">
          {opportunities.map(game => {
            const isJoining = joiningId === game.reservation_id;
            const joinError = joinErrors.get(game.reservation_id);
            return (
              <div
                key={game.reservation_id}
                className="rounded-xl border border-gray-200 dark:border-gray-600 px-3 py-3"
              >
                <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                  {formatDateLabel(game.starts_at, clubTimezone)} · {formatTimeLabel(game.starts_at, clubTimezone)} – {formatTimeLabel(game.ends_at, clubTimezone)}
                </p>
                <p className="text-sm text-gray-700 dark:text-gray-300 mt-0.5">{game.court_name}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Hosted by {game.host_display_name}</p>
                {game.format && (
                  <p className="text-xs text-gray-500 dark:text-gray-400 capitalize mt-0.5">{game.format}</p>
                )}
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1.5">
                  {game.occupied_seats} of {game.player_capacity} players · {remainingSpotsLabel(game.remaining_spots)}
                </p>

                <button
                  type="button"
                  disabled={isJoining}
                  onClick={() => handleJoin(game.reservation_id)}
                  className={`mt-2.5 w-full ${ACTION_BUTTON_PRIMARY_COMPACT}`}
                >
                  {isJoining ? "Joining…" : "Join"}
                </button>
                {joinError && <p className="text-xs text-red-500 mt-1.5">{joinError}</p>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
