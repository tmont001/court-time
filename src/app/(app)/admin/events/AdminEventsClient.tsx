"use client";

import { useState, useTransition } from "react";
import EventRosterButton from "@/app/(app)/events/EventRosterButton";
import { fetchMoreAdminEvents } from "./actions";
import type { AdminEventRow } from "./actions";

function formatDate(iso: string, tz: string): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone:    tz,
    weekday:     "short",
    month:       "short",
    day:         "numeric",
    hour:        "numeric",
    minute:      "2-digit",
    hour12:      true,
  });
}

interface Props {
  initialEvents: AdminEventRow[];
  hasMore:       boolean;
  clubTimezone:  string;
  userRole:      string;
}

export default function AdminEventsClient({ initialEvents, hasMore: initialHasMore, clubTimezone, userRole }: Props) {
  const [events, setEvents]             = useState<AdminEventRow[]>(initialEvents);
  const [hasMore, setHasMore]           = useState(initialHasMore);
  const [fetchError, setFetchError]     = useState<string | null>(null);
  const [isPending, startTransition]    = useTransition();

  function handleLoadMore() {
    setFetchError(null);
    startTransition(async () => {
      const result = await fetchMoreAdminEvents(events.length);
      if (result.error) {
        setFetchError(result.error);
      } else {
        setEvents(prev => [...prev, ...result.events]);
        setHasMore(result.events.length === 25);
      }
    });
  }

  if (events.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-gray-400 dark:text-gray-500 text-sm">
        No events yet.
      </div>
    );
  }

  return (
    <div className="pb-6 pt-3">
      {events.map(ev => {
        const type          = ev.event_types;
        const guestCount    = ev.event_guests.length;
        const confirmedCount = ev.event_participants.filter(
          p => p.role === "participant" && p.status === "confirmed"
        ).length;
        const offeredCount  = ev.event_participants.filter(
          p => p.status === "offered"
        ).length;
        const waitlistCount = ev.event_participants.filter(
          p => p.status === "waitlisted"
        ).length;
        const occupiedCount = confirmedCount + offeredCount + guestCount;
        const rosterCount   = occupiedCount + waitlistCount;
        const isCancelled   = ev.status === "cancelled";

        return (
          <div
            key={ev.id}
            className={`mx-4 mb-3 px-4 py-3 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 ${
              isCancelled ? "opacity-50" : ""
            }`}
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
                />
              </div>
            )}
          </div>
        );
      })}

      {fetchError && (
        <p className="mx-4 mb-3 text-xs text-red-500">{fetchError}</p>
      )}

      {hasMore && (
        <div className="flex justify-center py-2">
          <button
            onClick={handleLoadMore}
            disabled={isPending}
            className="px-4 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-700 dark:text-gray-300 font-medium disabled:opacity-40"
          >
            {isPending ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}
