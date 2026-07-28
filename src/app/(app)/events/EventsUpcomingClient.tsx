"use client";

import { useState } from "react";
import EventCardClient from "./EventCardClient";
import { ACTION_BUTTON_PRIMARY, ACTION_BUTTON_DESTRUCTIVE } from "./actionButtonStyles";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function dateKey(iso: string, tz: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: tz });
}

function formatDateHeader(iso: string, tz: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    timeZone: tz, weekday: "long", month: "long", day: "numeric",
  });
}

function formatTime(iso: string, tz: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true,
  });
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UpcomingEventData {
  id:                 string;
  title:              string;
  starts_at:          string;
  ends_at:            string;
  capacity:           number;
  event_types:        { key: string; label: string; color: string } | null;
  event_participants: Array<{ profile_id: string; role: string; status: string; offer_expires_at: string | null }>;
  event_guests:       Array<{ id: string }>;
  reservations:       Array<{ court_id: string; reason: string; status: string }>;
}

interface Props {
  events:                      UpcomingEventData[];
  userId:                      string;
  userRole:                    string | null | undefined;
  clubId:                      string;
  clubTimezone:                string;
  courtNames:                  Array<{ id: string; name: string }>;
  joinEventAction:             (formData: FormData) => Promise<void>;
  leaveEventAction:            (formData: FormData) => Promise<void>;
  acceptWaitlistOfferAction:   (formData: FormData) => Promise<void>;
  declineWaitlistOfferAction:  (formData: FormData) => Promise<void>;
}

export default function EventsUpcomingClient({
  events,
  userId,
  userRole,
  clubId,
  clubTimezone,
  courtNames,
  joinEventAction,
  leaveEventAction,
  acceptWaitlistOfferAction,
  declineWaitlistOfferAction,
}: Props) {
  const [searchQuery,      setSearchQuery]      = useState("");
  const [eventTypeFilter,  setEventTypeFilter]  = useState<string | null>(null);

  const courtName = new Map(courtNames.map(c => [c.id, c.name]));

  // Unique event types present in the loaded events, sorted by label.
  const eventTypeOptions = (() => {
    const seen  = new Set<string>();
    const types: Array<{ key: string; label: string; color: string }> = [];
    for (const ev of events) {
      if (ev.event_types && !seen.has(ev.event_types.key)) {
        seen.add(ev.event_types.key);
        types.push(ev.event_types);
      }
    }
    return types.sort((a, b) => a.label.localeCompare(b.label));
  })();

  // Client-side filtering: type then search. Order matches member UX (type is a broad
  // category filter; search narrows within it).
  const filteredEvents = events.filter(ev => {
    if (eventTypeFilter && ev.event_types?.key !== eventTypeFilter) return false;
    if (searchQuery.trim()) {
      if (!ev.title.toLowerCase().includes(searchQuery.trim().toLowerCase())) return false;
    }
    return true;
  });

  // Group filtered events by local calendar date.
  const grouped = new Map<string, UpcomingEventData[]>();
  for (const ev of filteredEvents) {
    const key = dateKey(ev.starts_at, clubTimezone);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(ev);
  }
  const sortedDateKeys = [...grouped.keys()].sort();

  const hasActiveFilters = searchQuery.trim() !== "" || eventTypeFilter !== null;

  function clearFilters() {
    setSearchQuery("");
    setEventTypeFilter(null);
  }

  return (
    <div>
      {/* Header */}
      <div className="px-4 pt-5 pb-1">
        <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">Upcoming Events</p>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
          Browse clinics, socials, leagues, and other scheduled events.
        </p>
      </div>

      {events.length === 0 ? (
        <div className="flex items-center justify-center h-40 text-gray-400 dark:text-gray-500 text-sm">
          No upcoming events yet.
        </div>
      ) : (
        <>
          {/* Filter bar */}
          <div className="px-4 pt-2 pb-3 space-y-2">
            {/* Search input */}
            <div className="relative">
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Search events…"
                className="w-full pl-3 pr-8 py-2 rounded-xl text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 border border-gray-200 dark:border-gray-700 shadow-sm focus:outline-none focus:ring-1 focus:ring-gray-300 dark:focus:ring-gray-600"
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

            {/* Event type pills — hidden when no typed events exist */}
            {eventTypeOptions.length > 0 && (
              <div className="flex items-center gap-1.5 flex-wrap">
                <button
                  onClick={() => setEventTypeFilter(null)}
                  className={`px-2.5 py-1 rounded-full text-xs font-medium motion-safe:transition-colors motion-safe:duration-100 ${
                    !eventTypeFilter
                      ? "bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900"
                      : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300"
                  }`}
                >
                  All
                </button>
                {eventTypeOptions.map(t => (
                  <button
                    key={t.key}
                    onClick={() => setEventTypeFilter(eventTypeFilter === t.key ? null : t.key)}
                    className={`px-2.5 py-1 rounded-full text-xs font-medium motion-safe:transition-colors motion-safe:duration-100 ${
                      eventTypeFilter === t.key
                        ? "text-white"
                        : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300"
                    }`}
                    style={eventTypeFilter === t.key ? { background: t.color } : undefined}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Events list or filtered-empty state */}
          {filteredEvents.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 gap-2 text-gray-400 dark:text-gray-500 text-sm px-8 text-center">
              <span>No events match your search.</span>
              {hasActiveFilters && (
                <button
                  onClick={clearFilters}
                  className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 underline"
                >
                  Clear filters
                </button>
              )}
            </div>
          ) : (
            <div className="pb-6">
              {sortedDateKeys.map(key => {
                const dayEvents = grouped.get(key)!;
                const header    = formatDateHeader(dayEvents[0].starts_at, clubTimezone);

                return (
                  <div key={key}>
                    <p className="px-4 pt-5 pb-2 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                      {header}
                    </p>

                    <div className="px-4 space-y-3">
                      {dayEvents.map(ev => {
                        const type = ev.event_types;

                        const confirmedCount = ev.event_participants.filter(
                          p => p.role === "participant" && p.status === "confirmed"
                        ).length;
                        const offeredCount = ev.event_participants.filter(
                          p => p.status === "offered"
                        ).length;
                        const guestCount    = ev.event_guests?.length ?? 0;
                        const waitlistCount = ev.event_participants.filter(
                          p => p.status === "waitlisted"
                        ).length;
                        const isFull = (confirmedCount + offeredCount + guestCount) >= ev.capacity;

                        const myEntry  = ev.event_participants.find(p => p.profile_id === userId);
                        const myRole   = myEntry?.role   ?? null;
                        const myStatus = myEntry?.status ?? null;

                        const isHost       = myRole === "host";
                        const isConfirmed  = myStatus === "confirmed" && myRole === "participant";
                        const isWaitlisted = myStatus === "waitlisted";
                        const isOffered    = myStatus === "offered";
                        const isJoined     = isHost || isConfirmed;

                        const offerExpiresAt        = isOffered ? (myEntry?.offer_expires_at ?? null) : null;
                        const offerExpiredServerSide = offerExpiresAt ? new Date(offerExpiresAt) <= new Date() : false;

                        const evCourtNames = ev.reservations
                          .filter(r => r.reason === "event" && r.status === "confirmed")
                          .map(r => courtName.get(r.court_id) ?? "Court")
                          .join(", ");

                        const startLabel = formatTime(ev.starts_at, clubTimezone);
                        const endLabel   = formatTime(ev.ends_at,   clubTimezone);

                        return (
                          <EventCardClient
                            key={ev.id}
                            eventId={ev.id}
                            userRole={userRole}
                            clubId={clubId}
                            clubTimezone={clubTimezone}
                            rosterCount={confirmedCount + offeredCount + waitlistCount}
                            actionArea={
                              isHost ? null : isOffered ? (
                                offerExpiredServerSide ? (
                                  <form action={joinEventAction}>
                                    <input type="hidden" name="event_id" value={ev.id} />
                                    <button type="submit" className={ACTION_BUTTON_PRIMARY}>
                                      Rejoin
                                    </button>
                                  </form>
                                ) : (
                                  <div className="flex items-center gap-2">
                                    <form action={declineWaitlistOfferAction}>
                                      <input type="hidden" name="event_id" value={ev.id} />
                                      <button type="submit" className={ACTION_BUTTON_DESTRUCTIVE}>
                                        Pass
                                      </button>
                                    </form>
                                    <form action={acceptWaitlistOfferAction}>
                                      <input type="hidden" name="event_id" value={ev.id} />
                                      <button type="submit" className={ACTION_BUTTON_PRIMARY}>
                                        Accept
                                      </button>
                                    </form>
                                  </div>
                                )
                              ) : isJoined || isWaitlisted ? (
                                <form action={leaveEventAction}>
                                  <input type="hidden" name="event_id" value={ev.id} />
                                  <button
                                    type="submit"
                                    className={ACTION_BUTTON_DESTRUCTIVE}
                                  >
                                    {isWaitlisted ? "Leave Waitlist" : "Leave"}
                                  </button>
                                </form>
                              ) : (
                                <form action={joinEventAction}>
                                  <input type="hidden" name="event_id" value={ev.id} />
                                  <button
                                    type="submit"
                                    className={ACTION_BUTTON_PRIMARY}
                                  >
                                    {isFull ? "Join Waitlist" : "Join Event"}
                                  </button>
                                </form>
                              )
                            }
                          >
                            {/* Type pill + status badges */}
                            <div className="flex items-center gap-1.5 mb-2 flex-wrap">
                              {type && (
                                <span
                                  className="inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold text-white"
                                  style={{ background: type.color }}
                                >
                                  {type.label}
                                </span>
                              )}
                              {isHost && (
                                <span className="inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
                                  Host
                                </span>
                              )}
                              {isConfirmed && (
                                <span className="inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold bg-green-100 text-green-700">
                                  Joined
                                </span>
                              )}
                              {isWaitlisted && (
                                <span className="inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold bg-amber-100 text-amber-700">
                                  Waitlisted
                                </span>
                              )}
                              {isOffered && !offerExpiredServerSide && (
                                <span className="inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold bg-amber-100 text-amber-700">
                                  Spot offered
                                </span>
                              )}
                              {isOffered && offerExpiredServerSide && (
                                <span className="inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400">
                                  Offer expired
                                </span>
                              )}
                            </div>

                            {/* Title */}
                            <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{ev.title}</p>

                            {/* Time range + courts */}
                            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                              {startLabel} – {endLabel}
                              {evCourtNames ? ` · ${evCourtNames}` : ""}
                            </p>

                            {/* Offer deadline */}
                            {isOffered && !offerExpiredServerSide && offerExpiresAt && (
                              <p className="text-xs text-amber-600 dark:text-amber-400 mt-0.5 font-medium">
                                Accept by {formatTime(offerExpiresAt, clubTimezone)}
                              </p>
                            )}

                            {/* Joined/waitlist counts — own line, above the roster+action footer */}
                            <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                              {confirmedCount + offeredCount + guestCount} / {ev.capacity} joined
                              {waitlistCount > 0 ? ` · ${waitlistCount} waitlisted` : ""}
                            </p>
                          </EventCardClient>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
