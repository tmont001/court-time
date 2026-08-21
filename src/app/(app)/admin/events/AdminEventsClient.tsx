"use client";

import { useState, useTransition, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import EventRosterButton from "@/app/(app)/events/EventRosterButton";
import type { RosterParticipantRow } from "@/app/(app)/calendar/EventRosterSheet";
import CreateEventSheet from "@/app/(app)/calendar/CreateEventSheet";
import EditEventSheet from "@/app/(app)/calendar/EditEventSheet";
import { cancelEvent } from "@/app/(app)/calendar/actions";
import { fetchMoreAdminEvents, archiveEventAction, unarchiveEventAction, setEventMemberJoinableAction } from "./actions";
import type { AdminEventRow, ArchiveView } from "./actions";
import { STALE_CLUB_CONTEXT_ERROR, STALE_CLUB_MESSAGE } from "@/lib/staleClub";
import { ACTION_BUTTON_PRIMARY, ACTION_BUTTON_SECONDARY, ACTION_BUTTON_DESTRUCTIVE } from "@/app/(app)/events/actionButtonStyles";
import { isOperator } from "@/lib/auth/roles";

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

function mapCancelError(code: string): string {
  if (code === STALE_CLUB_CONTEXT_ERROR) return STALE_CLUB_MESSAGE;
  if (code === "insufficient_role")   return "You do not have permission to cancel this event.";
  if (code === "event_not_found")     return "This event could not be cancelled. It may already be cancelled.";
  if (code === "event_cancelled")     return "This event could not be cancelled. It may already be cancelled.";
  return "Unable to cancel event. Please try again.";
}

interface Props {
  initialEvents:     AdminEventRow[];
  hasMore:           boolean;
  clubTimezone:      string;
  userRole:          string;
  userId?:           string;
  courts:            Court[];
  clubId:            string;
  currency:          string;
  // When false, the "+ Create Event" button is hidden (used when a parent already shows one).
  showCreateButton?:   boolean;
}

export default function AdminEventsClient({ initialEvents, hasMore: initialHasMore, clubTimezone, userRole, userId = "", courts, clubId, currency, showCreateButton = true }: Props) {
  const router                            = useRouter();
  // Phase 27C.2: read the search box's seed value (?q=<program title>,
  // used by the Programs "View Sessions" link — generated events share
  // their program's title) directly via useSearchParams() rather than a
  // server-passed prop. This is a live client-side subscription to the
  // current URL, so it updates reliably on a same-route navigation
  // regardless of whether a fresh RSC render's props happen to propagate
  // down through this component's already-mounted parent chain — the same
  // reasoning behind ManageSubview's identical switch (see that file).
  const searchParams = useSearchParams();
  const qParam = searchParams.get("q") ?? "";
  const [events, setEvents]               = useState<AdminEventRow[]>(initialEvents);
  const [hasMore, setHasMore]             = useState(initialHasMore);
  const [fetchError, setFetchError]       = useState<string | null>(null);
  const [isPending, startTransition]      = useTransition();
  const [isArchivePending, startArchiveTransition]   = useTransition();
  const [isCancelPending,  startCancelTransition]    = useTransition();
  const [isJoinablePending, startJoinableTransition] = useTransition();
  const [creatingEvent, setCreatingEvent] = useState(false);
  const [editingEvent, setEditingEvent]   = useState<AdminEventRow | null>(null);

  const [statusFilter,          setStatusFilter]          = useState<StatusFilter>("scheduled");
  const [dateFilter,            setDateFilter]            = useState<DateFilter>("all");
  const [sortOrder,             setSortOrder]             = useState<SortOrder>("desc");
  const [eventTypeFilter,       setEventTypeFilter]       = useState<string | null>(null);
  const [searchQuery,           setSearchQuery]           = useState(qParam);
  const [archiveView,           setArchiveView]           = useState<ArchiveView>("active");

  // One confirmation slot shared across the three inline flows; opening one
  // clears the others so only one confirmation is ever visible at a time.
  const [confirmingArchiveId,       setConfirmingArchiveId]       = useState<string | null>(null);
  const [confirmingUnarchiveId,     setConfirmingUnarchiveId]     = useState<string | null>(null);
  const [confirmingCancelId,        setConfirmingCancelId]        = useState<string | null>(null);
  const [confirmingMakeAdminManaged, setConfirmingMakeAdminManaged] = useState<string | null>(null);
  const [archiveError,              setArchiveError]              = useState<string | null>(null);
  const [cancelError,               setCancelError]               = useState<string | null>(null);
  const [joinableError,             setJoinableError]             = useState<{ id: string; message: string } | null>(null);

  // Sync list when the RSC parent refreshes (router.refresh() delivers new
  // initialEvents via prop reconciliation; useState alone won't pick it up).
  // Filter state is intentionally NOT reset here — filters persist across refreshes.
  useEffect(() => {
    setEvents(initialEvents);
    setHasMore(initialHasMore);
  }, [initialEvents, initialHasMore]);

  // Re-sync the search box whenever the URL's q param changes — not just on
  // first mount. This component stays mounted across the same-route
  // navigation Programs' "View Sessions" link performs (only ?q=...
  // changes), so without this effect a later click with a different
  // program title would never actually update the visible search box. Does
  // not fire on, and is never overwritten by, the user manually editing
  // the search box, since typing there never touches the URL.
  useEffect(() => {
    setSearchQuery(qParam);
  }, [qParam]);

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
        // Preserve only the count; individual ids are not used by this
        // component. onRosterChange's guestCount is already active-only
        // (EventRosterSheet's role === "guest" filter over get_event_roster,
        // which itself now returns active guests only), so every
        // placeholder row is marked active to keep the count consistent
        // with the status-filtered .length read above.
        event_guests: Array.from({ length: guestCount }, () => ({ id: "", status: "active" })),
      };
    }));
  }

  function handleLoadMore() {
    setFetchError(null);
    startTransition(async () => {
      // Offset uses raw loaded count — not visibleEvents.length — so pagination
      // is always correct regardless of the active client-side filter.
      const result = await fetchMoreAdminEvents(events.length, archiveView);
      if (result.error) {
        setFetchError(result.error);
      } else {
        setEvents(prev => [...prev, ...result.events]);
        setHasMore(result.events.length === 25);
      }
    });
  }

  // Changing View reloads from offset 0 so pagination stays correct.
  function handleArchiveViewChange(next: ArchiveView) {
    setArchiveView(next);
    setFetchError(null);
    startTransition(async () => {
      const result = await fetchMoreAdminEvents(0, next);
      if (result.error) {
        setFetchError(result.error);
      } else {
        setEvents(result.events);
        setHasMore(result.events.length === 25);
      }
    });
  }

  // After archive/unarchive/cancel, reload from offset 0 preserving the current
  // archiveView so the list reflects the change without resetting the filter.
  async function reloadFromStart() {
    const reloaded = await fetchMoreAdminEvents(0, archiveView);
    if (!reloaded.error) {
      setEvents(reloaded.events);
      setHasMore(reloaded.events.length === 25);
    }
  }

  function handleArchive(eventId: string) {
    setArchiveError(null);
    startArchiveTransition(async () => {
      const result = await archiveEventAction(eventId, clubId);
      if (result.error) {
        setArchiveError(result.error);
      } else {
        setConfirmingArchiveId(null);
        await reloadFromStart();
      }
    });
  }

  function handleUnarchive(eventId: string) {
    setArchiveError(null);
    startArchiveTransition(async () => {
      const result = await unarchiveEventAction(eventId, clubId);
      if (result.error) {
        setArchiveError(result.error);
      } else {
        setConfirmingUnarchiveId(null);
        await reloadFromStart();
      }
    });
  }

  function handleCancel(eventId: string) {
    setCancelError(null);
    startCancelTransition(async () => {
      const result = await cancelEvent(eventId, clubId);
      if (result.error) {
        setCancelError(mapCancelError(result.error.trim()));
      } else {
        setConfirmingCancelId(null);
        await reloadFromStart();
      }
    });
  }

  function handleToggleMemberJoinable(
    eventId:      string,
    currentValue: boolean,
    onSuccess?:   () => void,
  ) {
    setJoinableError(null);
    const nextValue = !currentValue;
    // Optimistic update — immediately reflects the new state.
    setEvents(prev => prev.map(ev => ev.id === eventId ? { ...ev, member_joinable: nextValue } : ev));
    startJoinableTransition(async () => {
      const result = await setEventMemberJoinableAction(eventId, nextValue, clubId);
      if (result.error) {
        // Revert on failure.
        setEvents(prev => prev.map(ev => ev.id === eventId ? { ...ev, member_joinable: currentValue } : ev));
        setJoinableError({ id: eventId, message: result.error });
      } else {
        onSuccess?.();
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
      className={ACTION_BUTTON_PRIMARY}
    >
      + Create Event
    </button>
  );

  // Shared class for all dropdown controls so they stay visually consistent.
  const selectClass =
    "appearance-none pl-3 pr-7 py-1.5 rounded-lg text-base md:text-xs font-medium " +
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
          className="w-full pl-3 pr-8 py-1.5 rounded-lg text-base md:text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 border border-gray-200 dark:border-gray-700 shadow-sm focus:outline-none focus:ring-1 focus:ring-gray-300 dark:focus:ring-gray-600"
        />
        {searchQuery && (
          <button
            onClick={() => setSearchQuery("")}
            className="absolute right-0 top-1/2 -translate-y-1/2 p-2.5 flex items-center justify-center text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-base leading-none"
            aria-label="Clear search"
          >
            ×
          </button>
        )}
      </div>

      {/* Dropdown row — Status / When / Sort / Type / View */}
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

        {/* View — Active / Archived / All; reloads list from offset 0 on change */}
        <div className="relative">
          <select
            value={archiveView}
            onChange={e => handleArchiveViewChange(e.target.value as ArchiveView)}
            className={selectClass}
          >
            <option value="active">Active</option>
            <option value="archived">Archived</option>
            <option value="all">All</option>
          </select>
          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500 text-[10px]">▾</span>
        </div>
      </div>
    </div>
  );

  return (
    <>
      <div className="pb-6 pt-3">
        {showCreateButton && <div className="px-4 pb-3 flex justify-end">{createEventButton}</div>}

        {filterBar}

        {visibleEvents.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 gap-2 text-gray-400 dark:text-gray-500 text-sm px-8 text-center">
            <span>
              {events.length === 0
                // No events from server at all — message reflects the active View.
                ? (archiveView === "archived"
                    ? "No archived events found."
                    : archiveView === "all"
                    ? "No events found."
                    : "No active events found. Switch to Archived to view archived events.")
                // Events loaded but client filters hide them all.
                : searchQuery.trim()
                ? `No events match "${searchQuery.trim()}".`
                : eventTypeFilter
                ? "No events of this type in the loaded results."
                : dateFilter === "upcoming"
                ? "No upcoming events in the loaded results. Tap Load more to check for later events."
                : statusFilter === "cancelled"
                ? "No cancelled events match the current filters."
                : "No events match these filters."}
            </span>
            {(searchQuery.trim() || eventTypeFilter) && events.length > 0 && (
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
            const guestCount     = ev.event_guests.filter(g => g.status === "active").length;
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
            const isArchived     = ev.archived_at !== null;
            const isFuture       = new Date(ev.starts_at).getTime() >= nowMs;

            // Permission: admin/staff (operator) can act on any event; pro
            // only on their own. Phase 34A: widened admin -> isOperator.
            const canActOnEvent = isOperator(userRole) ||
              (userRole === "pro" && !!userId && ev.created_by === userId);

            // Archive eligibility: past scheduled events or any cancelled event.
            // Future scheduled events must be cancelled before archiving (RPC guard: event_not_past).
            const canArchive = !isArchived && canActOnEvent && (
              ev.status === "cancelled" ||
              (ev.status === "scheduled" && !isFuture)
            );

            // Cancel eligibility: future scheduled non-archived events only.
            const canCancel = !isArchived && ev.status === "scheduled" && isFuture && canActOnEvent;

            // Edit eligibility: was Admin-only in Phase 30C — no Pro exception,
            // unlike cancellation. Phase 34A: widened admin -> isOperator; Pro
            // is still never admitted (update_event, 0136, never gained a Pro path).
            const canEdit = isOperator(userRole) && !isArchived && ev.status === "scheduled" && isFuture;

            // Toggle eligibility: future scheduled non-archived events only.
            const canToggleMemberJoinable = !isArchived && !isCancelled && isFuture && canActOnEvent;

            // Count participants with a stake in the event (for Admin-managed warning).
            const activeParticipantCount = ev.event_participants.filter(
              p => p.status === "confirmed" || p.status === "offered" || p.status === "waitlisted"
            ).length;

            // Show the action footer when any action or roster button is available.
            const showActionFooter = !isCancelled || canArchive || canCancel || canEdit || canToggleMemberJoinable || (isArchived && canActOnEvent);

            return (
              <div
                key={ev.id}
                className={`ct-card mx-4 mb-3 px-4 py-3${isArchived ? " ring-1 ring-inset ring-gray-200 dark:ring-gray-600" : ""}`}
              >
                {/* Type pill + status badge + archived badge */}
                <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
                  {type && (
                    <span
                      className="inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold text-white"
                      style={{ background: type.color }}
                    >
                      {type.label}
                    </span>
                  )}

                  {/* Status badge — always shown */}
                  {isCancelled ? (
                    <span className="inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold bg-red-100 text-red-600">
                      Cancelled
                    </span>
                  ) : (
                    <span className="inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold bg-green-100 text-green-700">
                      Scheduled
                    </span>
                  )}

                  {/* Archived badge — shown alongside status badge when archived */}
                  {isArchived && (
                    <span className="inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 ring-1 ring-gray-300 dark:ring-gray-600">
                      Archived
                    </span>
                  )}

                  {/* Admin-managed badge — when members cannot self-join */}
                  {!ev.member_joinable && (
                    <span className="inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400">
                      Admin-managed
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

                {/* ── Unified action footer ───────────────────────────────── */}
                {showActionFooter && (
                  <div className="mt-2 pt-2 border-t border-gray-100 dark:border-gray-700">
                    {confirmingCancelId === ev.id ? (
                      /* ── Cancel confirmation — full width ── */
                      <div className="space-y-1.5">
                        <p className="text-xs font-medium text-gray-700 dark:text-gray-300">Cancel this event?</p>
                        <p className="text-xs text-gray-500 dark:text-gray-400">Members will be notified and linked court reservations will be cancelled.</p>
                        {cancelError && <p className="text-xs text-red-500">{cancelError}</p>}
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => { setConfirmingCancelId(null); setCancelError(null); }}
                            className={ACTION_BUTTON_SECONDARY}
                          >
                            Keep event
                          </button>
                          <button
                            onClick={() => handleCancel(ev.id)}
                            disabled={isCancelPending}
                            className={ACTION_BUTTON_DESTRUCTIVE}
                          >
                            {isCancelPending ? "Cancelling…" : "Cancel Event"}
                          </button>
                        </div>
                      </div>
                    ) : confirmingArchiveId === ev.id ? (
                      /* ── Archive confirmation — full width ── */
                      <div className="space-y-1.5">
                        <p className="text-xs font-medium text-gray-700 dark:text-gray-300">Archive this event?</p>
                        <p className="text-xs text-gray-500 dark:text-gray-400">Past event data and roster history will be preserved.</p>
                        {archiveError && <p className="text-xs text-red-500">{archiveError}</p>}
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => { setConfirmingArchiveId(null); setArchiveError(null); }}
                            className={ACTION_BUTTON_SECONDARY}
                          >
                            Keep
                          </button>
                          <button
                            onClick={() => handleArchive(ev.id)}
                            disabled={isArchivePending}
                            className={ACTION_BUTTON_DESTRUCTIVE}
                          >
                            {isArchivePending ? "Archiving…" : "Archive"}
                          </button>
                        </div>
                      </div>
                    ) : confirmingUnarchiveId === ev.id ? (
                      /* ── Unarchive confirmation — full width ── */
                      <div className="space-y-1.5">
                        <p className="text-xs font-medium text-gray-700 dark:text-gray-300">Unarchive this event?</p>
                        <p className="text-xs text-gray-500 dark:text-gray-400">This event will return to the default Manage view.</p>
                        {archiveError && <p className="text-xs text-red-500">{archiveError}</p>}
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => { setConfirmingUnarchiveId(null); setArchiveError(null); }}
                            className={ACTION_BUTTON_SECONDARY}
                          >
                            Keep archived
                          </button>
                          <button
                            onClick={() => handleUnarchive(ev.id)}
                            disabled={isArchivePending}
                            className={ACTION_BUTTON_PRIMARY}
                          >
                            {isArchivePending ? "Restoring…" : "Unarchive"}
                          </button>
                        </div>
                      </div>
                    ) : confirmingMakeAdminManaged === ev.id ? (
                      /* ── Make Admin-managed confirmation ── */
                      <div className="space-y-1.5">
                        <p className="text-xs font-medium text-gray-700 dark:text-gray-300">
                          Make this event admin-managed?
                        </p>
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                          {activeParticipantCount}{" "}
                          {activeParticipantCount === 1 ? "participant is" : "participants are"}{" "}
                          on this event. They will remain on the roster, but new members
                          won&rsquo;t be able to self-join from the calendar.
                        </p>
                        {joinableError?.id === ev.id && (
                          <p className="text-xs text-red-500">{joinableError.message}</p>
                        )}
                        <div className="flex items-center gap-2 pt-0.5">
                          <button
                            onClick={() => {
                              setConfirmingMakeAdminManaged(null);
                              setJoinableError(null);
                            }}
                            className={ACTION_BUTTON_SECONDARY}
                          >
                            Keep open
                          </button>
                          <button
                            onClick={() => handleToggleMemberJoinable(
                              ev.id,
                              ev.member_joinable,
                              () => setConfirmingMakeAdminManaged(null),
                            )}
                            disabled={isJoinablePending}
                            className={ACTION_BUTTON_DESTRUCTIVE}
                          >
                            {isJoinablePending ? "Saving…" : "Make admin-managed"}
                          </button>
                        </div>
                      </div>
                    ) : (
                      /* ── Normal: Roster left | lifecycle actions right ── */
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between gap-x-4 gap-y-1.5 flex-wrap">
                          {/* Left: Roster / View Roster */}
                          {!isCancelled && (
                            <EventRosterButton
                              eventId={ev.id}
                              clubId={clubId}
                              count={rosterCount}
                              userRole={userRole}
                              clubTimezone={clubTimezone}
                              readOnly={isArchived}
                              onRosterChange={(rows, guests) => handleRosterChange(ev.id, rows, guests)}
                            />
                          )}
                          {/* Right: Toggle member-joinable | Cancel | Archive | Unarchive */}
                          <div className="flex items-center gap-2 ml-auto">
                            {canToggleMemberJoinable && (
                              <button
                                onClick={() => {
                                  if (ev.member_joinable && activeParticipantCount > 0) {
                                    // Open → Admin-managed with active participants: confirm first.
                                    setConfirmingMakeAdminManaged(ev.id);
                                    setConfirmingCancelId(null);
                                    setConfirmingArchiveId(null);
                                    setConfirmingUnarchiveId(null);
                                    setCancelError(null);
                                    setArchiveError(null);
                                    setJoinableError(null);
                                  } else {
                                    // Admin-managed → Open, or Open → Admin-managed with no participants: proceed directly.
                                    handleToggleMemberJoinable(ev.id, ev.member_joinable);
                                  }
                                }}
                                disabled={isJoinablePending}
                                className={ACTION_BUTTON_SECONDARY}
                              >
                                {ev.member_joinable ? "Make admin-managed" : "Open to members"}
                              </button>
                            )}
                            {canEdit && (
                              <button
                                onClick={() => setEditingEvent(ev)}
                                className={ACTION_BUTTON_SECONDARY}
                              >
                                Edit
                              </button>
                            )}
                            {canCancel && (
                              <button
                                onClick={() => {
                                  setConfirmingCancelId(ev.id);
                                  setConfirmingArchiveId(null);
                                  setConfirmingUnarchiveId(null);
                                  setConfirmingMakeAdminManaged(null);
                                  setCancelError(null);
                                  setArchiveError(null);
                                  setJoinableError(null);
                                }}
                                className={ACTION_BUTTON_DESTRUCTIVE}
                              >
                                Cancel Event
                              </button>
                            )}
                            {canArchive && (
                              <button
                                onClick={() => {
                                  setConfirmingArchiveId(ev.id);
                                  setConfirmingUnarchiveId(null);
                                  setConfirmingCancelId(null);
                                  setConfirmingMakeAdminManaged(null);
                                  setArchiveError(null);
                                  setCancelError(null);
                                  setJoinableError(null);
                                }}
                                className={ACTION_BUTTON_DESTRUCTIVE}
                              >
                                Archive
                              </button>
                            )}
                            {isArchived && canActOnEvent && (
                              <button
                                onClick={() => {
                                  setConfirmingUnarchiveId(ev.id);
                                  setConfirmingArchiveId(null);
                                  setConfirmingCancelId(null);
                                  setConfirmingMakeAdminManaged(null);
                                  setArchiveError(null);
                                  setCancelError(null);
                                  setJoinableError(null);
                                }}
                                className={ACTION_BUTTON_PRIMARY}
                              >
                                Unarchive
                              </button>
                            )}
                          </div>
                        </div>
                        {joinableError?.id === ev.id && (
                          <p className="text-xs text-red-500">{joinableError.message}</p>
                        )}
                      </div>
                    )}
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
          currency={currency}
          onClose={() => setCreatingEvent(false)}
          onCreated={() => { setCreatingEvent(false); router.refresh(); }}
        />
      )}

      {editingEvent && (
        <EditEventSheet
          event={editingEvent}
          courts={courts}
          clubId={clubId}
          clubTimezone={clubTimezone}
          currency={currency}
          isAdmin={userRole === "admin"}
          onClose={() => setEditingEvent(null)}
          onSaved={async () => { setEditingEvent(null); await reloadFromStart(); }}
        />
      )}
    </>
  );
}
