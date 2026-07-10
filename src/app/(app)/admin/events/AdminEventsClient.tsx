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
type EventTypeOption = { key: string; label: string; color: string };

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

  const [statusFilter,    setStatusFilter]    = useState<StatusFilter>("scheduled");
  const [dateFilter,      setDateFilter]      = useState<DateFilter>("all");
  const [sortOrder,       setSortOrder]       = useState<SortOrder>("desc");
  const [eventTypeFilter, setEventTypeFilter] = useState<string | null>(null);
  const [searchQuery,     setSearchQuery]     = useState("");

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

  // Unique event types present in ALL loaded events (not just visible). As Load More
  // appends events, new types become available in the select immediately.
  const eventTypeOptions: EventTypeOption[] = (() => {
    const seen  = new Set<string>();
    const types: EventTypeOption[] = [];
    for (const ev of events) {
      if (ev.event_types && !seen.has(ev.event_types.key)) {
        seen.add(ev.event_types.key);
        types.push(ev.event_types);
      }
    }
    return types.sort((a, b) => a.label.localeCompare(b.label));
  })();

  // Derived: filter in spec order (status → date → event type → search), then sort.
  // Original events array is never mutated.
  const nowMs = Date.now();
  const visibleEvents = [...events]
    .filter((ev) => {
      if (statusFilter !== "all" && ev.status !== statusFilter) return false;
      const startsMs = new Date(ev.starts_at).getTime();
      if (dateFilter === "upcoming" && startsMs < nowMs) return false;
      if (dateFilter === "past"     && startsMs >= nowMs) return false;
      if (eventTypeFilter && ev.event_types?.key !== eventTypeFilter) return false;
      if (searchQuery.trim() && !ev.title.toLowerCase().includes(searchQuery.trim().toLowerCase())) return false;
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

  // Shared class for all four dropdown controls so they stay visually consistent.
  const selectClass =
    "appearance-none pl-3 pr-7 py-1.5 rounded-lg text-xs font-medium " +
    "bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 " +
    "border border-gray-200 dark:border-gray-700 shadow-sm " +
    "cursor-pointer focus:outline-none focus:ring-1 focus:ring-gray-300 dark:focus:ring-gray-600";

  const filterBar = (
    <div className="px-4 pb-3 space-y-2">
      {/* Search input — top row, full width */}
      <div className="relative">
        <input
          type="text"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder="Search events…"
          className="w-full pl-3 pr-8 py-1.5 rounded-lg text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 border border-gray-200 dark:border-gray-700 shadow-sm focus:outline-none focus:ring-1 focus:ring-gray-300 dark:focus:ring-gray-600"
        />
        {searchQuery && (
          <button
            onClick={() => setSearchQuery("")}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-base leading-none"
            aria-label="Clear search"
          >
            ×
          </button>
        )}
      </div>

      {/* Dropdown row — Status / When / Sort / Type */}
      <div className="flex flex-wrap gap-2">
        {/* Status */}
        <div className="relative">
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value as StatusFilter)}
            className={selectClass}
          >
            <option value="scheduled">Scheduled</option>
            <option value="cancelled">Cancelled</option>
            <option value="all">All statuses</option>
          </select>
          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500 text-[10px]">▾</span>
        </div>

        {/* When */}
        <div className="relative">
          <select
            value={dateFilter}
            onChange={e => setDateFilter(e.target.value as DateFilter)}
            className={selectClass}
          >
            <option value="all">All dates</option>
            <option value="upcoming">Upcoming</option>
            <option value="past">Past</option>
          </select>
          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500 text-[10px]">▾</span>
        </div>

        {/* Sort */}
        <div className="relative">
          <select
            value={sortOrder}
            onChange={e => setSortOrder(e.target.value as SortOrder)}
            className={selectClass}
          >
            <option value="desc">Newest</option>
            <option value="asc">Oldest</option>
          </select>
          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500 text-[10px]">▾</span>
        </div>

        {/* Type — hidden until typed events are loaded */}
        {eventTypeOptions.length > 0 && (
          <div className="relative">
            <select
              value={eventTypeFilter ?? ""}
              onChange={e => setEventTypeFilter(e.target.value || null)}
              className={selectClass}
            >
              <option value="">All types</option>
              {eventTypeOptions.map(t => (
                <option key={t.key} value={t.key}>{t.label}</option>
              ))}
            </select>
            <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500 text-[10px]">▾</span>
          </div>
        )}
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
          // Filtered-empty: events exist but none match the active filters / search.
          <div className="flex flex-col items-center justify-center h-40 gap-2 text-gray-400 dark:text-gray-500 text-sm px-8 text-center">
            <span>
              {searchQuery.trim()
                ? `No events match "${searchQuery.trim()}".`
                : eventTypeFilter
                ? "No events of this type in the loaded results."
                : dateFilter === "upcoming"
                ? "No upcoming events in the loaded results. Tap Load more to check for later events."
                : statusFilter === "cancelled"
                ? "No cancelled events match the current filters."
                : "No events match these filters."}
            </span>
            {(searchQuery.trim() || eventTypeFilter) && (
              <button
                onClick={() => { setSearchQuery(""); setEventTypeFilter(null); }}
                className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 underline"
              >
                Clear search &amp; type filter
              </button>
            )}
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
