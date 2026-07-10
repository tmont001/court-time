"use client";

import { useState, useTransition, useEffect } from "react";
import { useRouter } from "next/navigation";
import EventRosterButton from "@/app/(app)/events/EventRosterButton";
import type { RosterParticipantRow } from "@/app/(app)/calendar/EventRosterSheet";
import CreateEventSheet from "@/app/(app)/calendar/CreateEventSheet";
import { fetchMoreAdminEvents } from "./actions";
import type { AdminEventRow } from "./actions";

type Court        = { id: string; name: string; display_order: number };
type StatusFilter = "scheduled" | "cancelled" | "all";
type DateFilter   = "all" | "upcoming" | "past";
type SortOrder    = "desc" | "asc";

// Split date and time into separate Intl calls to avoid the browser-vs-Node
// "at" connector divergence in en-US toLocaleString when both date and time
// fields are requested together. Each call is deterministic on both runtimes.
function formatDate(iso: string, tz: string): string {
  const d = new Date(iso);
  const datePart = d.toLocaleDateString("en-US", {
    timeZone: tz,
    weekday:  "short",
    month:    "short",
    day:      "numeric",
  });
  const timePart = d.toLocaleTimeString("en-US", {
    timeZone: tz,
    hour:     "numeric",
    minute:   "2-digit",
    hour12:   true,
  });
  return `${datePart} ${timePart}`;
}

interface Props {
  initialEvents:     AdminEventRow[];
  hasMore:           boolean;
  clubTimezone:      string;
  userRole:          string;
  courts:            Court[];
  clubId:            string;
  // When false, the "+ Create Event" button is hidden (used when a parent already shows one).
  showCreateButton?: boolean;
}

export default function AdminEventsClient({ initialEvents, hasMore: initialHasMore, clubTimezone, userRole, courts, clubId, showCreateButton = true }: Props) {
  const router                            = useRouter();
  const [events, setEvents]               = useState<AdminEventRow[]>(initialEvents);
  const [hasMore, setHasMore]             = useState(initialHasMore);
  const [fetchError, setFetchError]       = useState<string | null>(null);
  const [isPending, startTransition]      = useTransition();
  const [creatingEvent, setCreatingEvent] = useState(false);

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("scheduled");
  const [dateFilter, setDateFilter]     = useState<DateFilter>("all");
  const [sortOrder, setSortOrder]       = useState<SortOrder>("desc");

  // Sync list when the RSC parent refreshes (router.refresh() delivers new
  // initialEvents via prop reconciliation; useState alone won't pick it up).
  // Filter state is intentionally NOT reset here — filters persist across refreshes.
  useEffect(() => {
    setEvents(initialEvents);
    setHasMore(initialHasMore);
  }, [initialEvents, initialHasMore]);

  function handleRosterChange(
    eventId:         string,
    participantRows: RosterParticipantRow[],
    guestCount:      number,
  ) {
    setEvents(prev => prev.map(ev => {
      if (ev.id !== eventId) return ev;
      return {
        ...ev,
        event_participants: participantRows,
        // Preserve only the count; individual ids are not used by this component.
        event_guests: Array.from({ length: guestCount }, () => ({ id: "" })),
      };
    }));
  }

  function handleLoadMore() {
    setFetchError(null);
    startTransition(async () => {
      // Offset uses raw loaded count — not visibleEvents.length — so pagination
      // is always correct regardless of the active filter.
      const result = await fetchMoreAdminEvents(events.length);
      if (result.error) {
        setFetchError(result.error);
      } else {
        setEvents(prev => [...prev, ...result.events]);
        setHasMore(result.events.length === 25);
      }
    });
  }

  // Derived: filter then sort. Original events array is never mutated.
  const nowMs = Date.now();
  const visibleEvents = [...events]
    .filter((ev) => {
      if (statusFilter !== "all" && ev.status !== statusFilter) return false;
      const startsMs = new Date(ev.starts_at).getTime();
      if (dateFilter === "upcoming" && startsMs < nowMs) return false;
      if (dateFilter === "past"     && startsMs >= nowMs) return false;
      return true;
    })
    .sort((a, b) => {
      const aMs = new Date(a.starts_at).getTime();
      const bMs = new Date(b.starts_at).getTime();
      return sortOrder === "desc" ? bMs - aMs : aMs - bMs;
    });

  const createEventButton = (
    <button
      onClick={() => setCreatingEvent(true)}
      className="px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 hover:bg-gray-700 dark:hover:bg-gray-300 motion-safe:transition-colors motion-safe:duration-150"
    >
      + Create Event
    </button>
  );

  const filterBar = (
    <div className="px-4 pb-3 flex flex-wrap items-center gap-2">
      {/* Status filter */}
      <div className="flex p-0.5 gap-0.5 bg-gray-100 dark:bg-gray-800 rounded-lg">
        {(["scheduled", "cancelled", "all"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`px-2.5 py-1 rounded-md text-[11px] font-medium motion-safe:transition-colors motion-safe:duration-100 ${
              statusFilter === s
                ? "bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm"
                : "text-gray-500 dark:text-gray-400"
            }`}
          >
            {s === "scheduled" ? "Scheduled" : s === "cancelled" ? "Cancelled" : "All"}
          </button>
        ))}
      </div>

      {/* Date filter */}
      <div className="flex p-0.5 gap-0.5 bg-gray-100 dark:bg-gray-800 rounded-lg">
        {(["all", "upcoming", "past"] as const).map((d) => (
          <button
            key={d}
            onClick={() => setDateFilter(d)}
            className={`px-2.5 py-1 rounded-md text-[11px] font-medium motion-safe:transition-colors motion-safe:duration-100 ${
              dateFilter === d
                ? "bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm"
                : "text-gray-500 dark:text-gray-400"
            }`}
          >
            {d === "all" ? "All dates" : d === "upcoming" ? "Upcoming" : "Past"}
          </button>
        ))}
      </div>

      {/* Sort order */}
      <div className="flex p-0.5 gap-0.5 bg-gray-100 dark:bg-gray-800 rounded-lg">
        {(["desc", "asc"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setSortOrder(s)}
            className={`px-2.5 py-1 rounded-md text-[11px] font-medium motion-safe:transition-colors motion-safe:duration-100 ${
              sortOrder === s
                ? "bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm"
                : "text-gray-500 dark:text-gray-400"
            }`}
          >
            {s === "desc" ? "Newest" : "Oldest"}
          </button>
        ))}
      </div>
    </div>
  );

  // True-empty: no events loaded from the server at all.
  if (events.length === 0) {
    return (
      <>
        {showCreateButton && <div className="px-4 pb-3 flex justify-end">{createEventButton}</div>}
        <div className="flex items-center justify-center h-40 text-gray-400 dark:text-gray-500 text-sm">
          No events yet.
        </div>
        {creatingEvent && (
          <CreateEventSheet
            courts={courts}
            clubId={clubId}
            clubTimezone={clubTimezone}
            onClose={() => setCreatingEvent(false)}
            onCreated={() => { setCreatingEvent(false); router.refresh(); }}
          />
        )}
      </>
    );
  }

  return (
    <>
      <div className="pb-6 pt-3">
        {showCreateButton && <div className="px-4 pb-3 flex justify-end">{createEventButton}</div>}

        {filterBar}

        {visibleEvents.length === 0 ? (
          // Filtered-empty: events exist but none match the active filters.
          <div className="flex items-center justify-center h-40 text-gray-400 dark:text-gray-500 text-sm px-8 text-center">
            {dateFilter === "upcoming"
              ? "No upcoming events in the loaded results. Tap Load more to check for later events."
              : statusFilter === "cancelled"
              ? "No cancelled events in the loaded results."
              : "No events match these filters."}
          </div>
        ) : (
          visibleEvents.map(ev => {
            const type           = ev.event_types;
            const guestCount     = ev.event_guests.length;
            const confirmedCount = ev.event_participants.filter(
              p => p.role === "participant" && p.status === "confirmed"
            ).length;
            const offeredCount   = ev.event_participants.filter(
              p => p.status === "offered"
            ).length;
            const waitlistCount  = ev.event_participants.filter(
              p => p.status === "waitlisted"
            ).length;
            const occupiedCount  = confirmedCount + offeredCount + guestCount;
            const rosterCount    = occupiedCount + waitlistCount;
            const isCancelled    = ev.status === "cancelled";

            return (
              <div
                key={ev.id}
                className={`ct-card mx-4 mb-3 px-4 py-3 ${isCancelled ? "opacity-50" : ""}`}
              >
                {/* Type pill + status badge */}
                <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
                  {type && (
                    <span
                      className="inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold text-white"
                      style={{ background: type.color }}
                    >
                      {type.label}
                    </span>
                  )}
                  {isCancelled ? (
                    <span className="inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold bg-red-100 text-red-600">
                      Cancelled
                    </span>
                  ) : (
                    <span className="inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold bg-green-100 text-green-700">
                      Scheduled
                    </span>
                  )}
                </div>

                {/* Title */}
                <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                  {ev.title}
                </p>

                {/* Date/time */}
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  {formatDate(ev.starts_at, clubTimezone)}
                </p>

                {/* Capacity + waitlist */}
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
                  {occupiedCount} / {ev.capacity} filled
                  {waitlistCount > 0 ? ` · ${waitlistCount} waitlisted` : ""}
                </p>

                {/* Roster button — scheduled events only */}
                {!isCancelled && (
                  <div className="mt-2 pt-2 border-t border-gray-100 dark:border-gray-700">
                    <EventRosterButton
                      eventId={ev.id}
                      count={rosterCount}
                      userRole={userRole}
                      clubTimezone={clubTimezone}
                      onRosterChange={(rows, guests) => handleRosterChange(ev.id, rows, guests)}
                    />
                  </div>
                )}
              </div>
            );
          })
        )}

        {fetchError && (
          <p className="mx-4 mb-3 text-xs text-red-500">{fetchError}</p>
        )}

        {hasMore && (
          <div className="flex justify-center py-2">
            <button
              onClick={handleLoadMore}
              disabled={isPending}
              className="ct-button-secondary px-4 py-2 text-sm disabled:opacity-40"
            >
              {isPending ? "Loading…" : "Load more"}
            </button>
          </div>
        )}
      </div>

      {creatingEvent && (
        <CreateEventSheet
          courts={courts}
          clubId={clubId}
          clubTimezone={clubTimezone}
          onClose={() => setCreatingEvent(false)}
          onCreated={() => { setCreatingEvent(false); router.refresh(); }}
        />
      )}
    </>
  );
}
