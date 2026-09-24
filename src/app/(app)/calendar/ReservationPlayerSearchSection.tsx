"use client";

import { useEffect, useState } from "react";
import {
  getReservationPlayerSearch,
  setReservationPlayerSearch,
  clearReservationPlayerSearch,
  type ReservationPlayerSearchState,
} from "./actions";
import { STALE_CLUB_CONTEXT_ERROR, STALE_CLUB_MESSAGE } from "@/lib/staleClub";
import {
  ACTION_BUTTON_SECONDARY_COMPACT,
  ACTION_BUTTON_PRIMARY_COMPACT,
} from "@/components/styles/actionButtonStyles";

// Phase 39C-1 — Admin/Staff/owner "Looking for Players" controls, rendered
// as a sibling section to ReservationRosterSection (same render gate:
// reason='member_booking' AND (canManageMemberReservation OR
// canManageOwnReservationRoster)), never inside it — this section never
// reads or mutates reservation_participants/reservation_guests directly or
// indirectly. Every read/write goes exclusively through the Phase 39B-2
// (0204/0205) SECURITY DEFINER RPCs, which independently re-derive and
// enforce authorization, capacity, and eligibility server-side — this
// component never recomputes occupied/remaining seats, never infers
// discoverability from is_open alone, and never duplicates a capability
// check the backend already owns.
//
// ACTION-BASED, NOT A BOOLEAN TOGGLE: stored is_open=true can coexist with
// effective_is_open=false (stale host / inactive host / legacy
// guest_names), so a conventional on/off switch would misrepresent the
// state. Instead: explicit "Turn on" / "Update" / "Reopen for current
// booking owner" / "Stop" actions, plus a status line and — whenever
// is_open && !effective_is_open — a separate, always-rendered notice that
// is never conflated with the on/off state itself.

// ─── Types ───────────────────────────────────────────────────────────────

interface Props {
  reservationId: string;
  clubId:        string;
  isCancelled:   boolean;
  // Phase 39C-1 correction — bumped by the parent (ReservationDetailSheet)
  // whenever the sibling ReservationRosterSection reports a successful
  // participant/guest mutation via its own onRosterChanged callback. This
  // component never receives or reads any participant/guest data itself —
  // the revision is a pure "something changed, re-fetch your own canonical
  // state" signal, consumed only as a load-effect dependency below.
  refreshRevision?: number;
}

const CAPACITY_OPTIONS = [2, 3, 4, 5, 6, 7, 8];
const DEFAULT_CAPACITY = 4;

// ─── Helpers ─────────────────────────────────────────────────────────────

function mapPlayerSearchError(code: string): string {
  if (code === STALE_CLUB_CONTEXT_ERROR) return STALE_CLUB_MESSAGE;
  switch (code) {
    case "reservation_not_found":
      return "This booking could not be found.";
    case "reservation_not_confirmed":
      return "This booking is no longer confirmed.";
    case "reservation_already_started":
      return "This booking has already started.";
    case "roster_member_inactive":
      return "The booking owner's membership isn't currently eligible for Looking for Players.";
    case "reservation_has_legacy_guest_names":
      return "This reservation uses the older guest-name field. Remove those guest names before using Looking for Players.";
    case "reservation_player_capacity_out_of_range":
      return "Choose a total player count between 2 and 8.";
    case "reservation_player_capacity_too_small":
      return "Capacity can't be lower than the number of players already on this reservation.";
    case "capability_not_available":
      return "Looking for Players isn't available for this club.";
    case "reservation_player_search_not_found":
      return "This search could not be found.";
    default:
      return "Something went wrong. Please try again.";
  }
}

// Deliberately narrow — mirrors the backend's own narrow taxonomy
// (_reservation_player_search_block_reason, 0204). Any reason not
// explicitly known (including a genuinely unrecognized future value) gets
// the generic line rather than a raw code ever reaching the DOM.
function blockReasonMessage(reason: string | null): string {
  switch (reason) {
    case "stale_host":
      return "This search was opened for a previous booking owner.";
    case "host_inactive":
      return "The current booking owner isn't active, so this search isn't discoverable right now.";
    case "legacy_guest_names":
      return "This reservation uses the older guest-name field. Remove those guest names before using Looking for Players.";
    default:
      return "This search is currently not discoverable.";
  }
}

// ─── Component ───────────────────────────────────────────────────────────

export default function ReservationPlayerSearchSection({ reservationId, clubId, isCancelled, refreshRevision }: Props) {
  const [state, setState]         = useState<ReservationPlayerSearchState | null>(null);
  const [loading, setLoading]     = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [capacityInput, setCapacityInput] = useState<number>(DEFAULT_CAPACITY);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError]     = useState<string | null>(null);

  function loadState() {
    setLoading(true);
    setLoadError(null);
    getReservationPlayerSearch(reservationId, clubId).then(({ data, error }) => {
      if (error) {
        setLoadError(mapPlayerSearchError(error));
      } else {
        // get_reservation_player_search legitimately returns no row when
        // this reservation has never had a search — data is null, not an
        // error, and not something to distinguish from "closed" in the UI
        // beyond the capacity default below.
        setState(data ?? null);
        setCapacityInput(data ? data.player_capacity : DEFAULT_CAPACITY);
      }
      setLoading(false);
    });
  }

  useEffect(() => {
    // No LFP mutation controls (or reads) are needed on a cancelled
    // reservation — this section renders nothing at all in that case (see
    // the early return below), so skip the load entirely rather than
    // fetching state that will never be shown.
    if (isCancelled) return;
    loadState();
    // clubId: a club-context change must reload canonical state, exactly
    // like reservationId. refreshRevision: bumped by the parent whenever
    // the sibling ReservationRosterSection reports a successful
    // participant/guest mutation — re-runs this SAME canonical RPC read,
    // never a locally-derived recomputation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reservationId, clubId, isCancelled, refreshRevision]);

  async function runMutation(action: () => Promise<{ error?: string }>) {
    setActionLoading(true);
    setActionError(null);
    const result = await action();
    setActionLoading(false);
    if (result.error) {
      setActionError(mapPlayerSearchError(result.error));
      return;
    }
    // Always re-fetch canonical state after a successful mutation — never
    // hand-derive the new occupied/remaining/effective values locally.
    loadState();
  }

  function handleTurnOnOrUpdate() {
    runMutation(() => setReservationPlayerSearch(reservationId, clubId, capacityInput));
  }

  function handleReopen() {
    // Locked behavior: reopening for the current booking owner reuses the
    // search's own CURRENT player_capacity — never whatever the capacity
    // selector happens to show, and never requires the owner to change
    // capacity or manually stop/start first.
    if (!state) return;
    runMutation(() => setReservationPlayerSearch(reservationId, clubId, state.player_capacity));
  }

  function handleStop() {
    // Sets is_open = false only — never deletes the row, never touches
    // reservation_participants/reservation_guests.
    runMutation(() => clearReservationPlayerSearch(reservationId, clubId));
  }

  // No LFP mutation controls on a cancelled reservation — nothing to show.
  if (isCancelled) return null;

  const isOpen           = state?.is_open ?? false;
  const effectiveIsOpen  = state?.effective_is_open ?? false;
  const showsIneffectiveNotice = isOpen && !effectiveIsOpen;

  return (
    <div className="mt-3 rounded-xl border border-gray-200 dark:border-gray-600 px-3 py-3">
      <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
        Looking for Players
      </span>

      {loading && (
        <p className="text-sm text-gray-400 dark:text-gray-500 mt-2">Loading…</p>
      )}

      {!loading && loadError && (
        <p className="text-sm text-red-500 mt-2">{loadError}</p>
      )}

      {!loading && !loadError && (
        <div className="mt-2">
          {/* Off — either no search row has ever existed, or one exists
              but is currently closed. Both render the same "Turn on"
              flow; the only difference is the capacity default above
              (existing capacity vs. 4). */}
          {!isOpen && (
            <div className="space-y-2">
              <p className="text-sm text-gray-400 dark:text-gray-500">Off</p>
              <CapacitySelect value={capacityInput} onChange={setCapacityInput} disabled={actionLoading} />
              <button
                type="button"
                disabled={actionLoading}
                onClick={handleTurnOnOrUpdate}
                className={`${ACTION_BUTTON_PRIMARY_COMPACT}`}
              >
                {actionLoading ? "…" : "Turn on"}
              </button>
            </div>
          )}

          {/* On — stored is_open = true. effective_is_open decides which
              of the two sub-views below renders; is_open itself is NEVER
              treated as proof of discoverability. */}
          {isOpen && effectiveIsOpen && state && (
            <div className="space-y-2">
              <p className="text-sm text-gray-900 dark:text-gray-100">
                {state.occupied_seats} of {state.player_capacity} spots filled
              </p>
              {state.remaining_spots === 0 && (
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  All spots are filled. If a spot opens, the game can become available again.
                </p>
              )}
              <CapacitySelect value={capacityInput} onChange={setCapacityInput} disabled={actionLoading} />
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={actionLoading}
                  onClick={handleTurnOnOrUpdate}
                  className={ACTION_BUTTON_PRIMARY_COMPACT}
                >
                  {actionLoading ? "…" : "Update"}
                </button>
                <button
                  type="button"
                  disabled={actionLoading}
                  onClick={handleStop}
                  className={ACTION_BUTTON_SECONDARY_COMPACT}
                >
                  {actionLoading ? "…" : "Stop"}
                </button>
              </div>
            </div>
          )}

          {/* On but NOT effectively open — always rendered as a distinct
              notice, never silently shown as though it were discoverable. */}
          {showsIneffectiveNotice && state && (
            <div className="space-y-2">
              <p className="text-sm text-amber-700 dark:text-amber-400">
                {blockReasonMessage(state.effective_open_block_reason)}
              </p>
              <div className="flex gap-2">
                {state.effective_open_block_reason === "stale_host" && (
                  <button
                    type="button"
                    disabled={actionLoading}
                    onClick={handleReopen}
                    className={ACTION_BUTTON_PRIMARY_COMPACT}
                  >
                    {actionLoading ? "…" : "Reopen for current booking owner"}
                  </button>
                )}
                <button
                  type="button"
                  disabled={actionLoading}
                  onClick={handleStop}
                  className={ACTION_BUTTON_SECONDARY_COMPACT}
                >
                  {actionLoading ? "…" : "Stop"}
                </button>
              </div>
            </div>
          )}

          {actionError && <p className="text-xs text-red-500 mt-2">{actionError}</p>}
        </div>
      )}
    </div>
  );
}

// ─── Capacity select ─────────────────────────────────────────────────────

function CapacitySelect({
  value,
  onChange,
  disabled,
}: {
  value:    number;
  onChange: (value: number) => void;
  disabled: boolean;
}) {
  return (
    <div>
      <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
        Total players
      </label>
      <p className="text-[11px] text-gray-400 dark:text-gray-500">Includes the booking owner.</p>
      <select
        aria-label="Total players"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 px-2 py-1.5 text-sm"
      >
        {CAPACITY_OPTIONS.map((n) => (
          <option key={n} value={n}>{n}</option>
        ))}
      </select>
    </div>
  );
}
