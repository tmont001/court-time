"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import EventCardClient from "./EventCardClient";
import ProgramEnrollmentCard from "./ProgramEnrollmentCard";
import type { MemberProgramCard } from "./programEnrollmentActions";
import { ACTION_BUTTON_PRIMARY, ACTION_BUTTON_DESTRUCTIVE } from "./actionButtonStyles";
import PriceSummary from "@/components/PriceSummary";
import EventJoinConfirmModal from "@/components/EventJoinConfirmModal";
import { isOperator } from "@/lib/auth/roles";

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
  // Phase 33E2: status distinguishes an active guest (occupies capacity)
  // from a soft-cancelled one (does not).
  event_guests:       Array<{ id: string; status: string }>;
  reservations:       Array<{ court_id: string; reason: string; status: string }>;
  price_amount_cents: number | null;
  // Phase 27D2: present only for generated program sessions (null for
  // standalone/per_session/admin_managed events without a parent program).
  // Used solely to suppress per-session Join/Leave controls for
  // enrollment_model='program' — see the "Enrollment through program"
  // branch below.
  programs:           { enrollment_model: "program" | "per_session" | "admin_managed" } | null;
}

interface Props {
  events:                      UpcomingEventData[];
  // Phase 27D2 correction: whole-program enrollment is member-only — page.tsx
  // only fetches `programs` when the caller's active-club role is 'member'
  // (empty otherwise), and this flag additionally gates rendering the
  // Programs section directly, rather than relying only on `programs` being
  // empty for admins/pros.
  isMember:                    boolean;
  /** Phase 33F3B: false at a Staff-Managed club — a Member may still see
   * (and exit/resolve) an Event or Program they already have history with,
   * but must never be offered a NEW-entry or RE-entry control (Join,
   * Rejoin, Join Waitlist). Ignored for admin/pro, who never render this
   * member-only Programs section or these member action branches at all. */
  memberSelfService:           boolean;
  programs:                    MemberProgramCard[];
  programsError?:              string;
  userId:                      string;
  userRole:                    string | null | undefined;
  clubId:                      string;
  clubTimezone:                string;
  currency:                    string;
  courtNames:                  Array<{ id: string; name: string }>;
  joinEventAction:             (formData: FormData) => Promise<void>;
  leaveEventAction:            (formData: FormData) => Promise<void>;
  acceptWaitlistOfferAction:   (formData: FormData) => Promise<void>;
  declineWaitlistOfferAction:  (formData: FormData) => Promise<void>;
  // Phase 34F-C: optional ?checkout=success&program=<uuid> return from
  // Stripe Checkout. Never mutates any financial state on its own —
  // ProgramEnrollmentCard's own fetchPaymentStates/eligibility effects
  // already show authoritative, freshly-fetched state on this hard-
  // navigation page load regardless; this is used only to strip the
  // one-time query string from the URL bar below.
  initialCheckoutProgramId?:   string | null;
}

export default function EventsUpcomingClient({
  events,
  isMember,
  memberSelfService,
  programs,
  programsError,
  userId,
  userRole,
  clubId,
  clubTimezone,
  currency,
  courtNames,
  joinEventAction,
  leaveEventAction,
  acceptWaitlistOfferAction,
  declineWaitlistOfferAction,
  initialCheckoutProgramId,
}: Props) {
  const router = useRouter();
  const [searchQuery,      setSearchQuery]      = useState("");
  const [eventTypeFilter,  setEventTypeFilter]  = useState<string | null>(null);

  // Phase 34F-C (flicker regression precedent — LessonsClient.tsx /
  // CalendarShell.tsx) — strip ?checkout=&program= from the URL once this
  // client component has mounted, so a later browser refresh never re-runs
  // any success/cancel-specific behavior. Deliberately uses the raw
  // History API (window.history.replaceState), NOT next/navigation's
  // router.replace: /events's own page.tsx reads searchParams directly
  // (tab/checkout/program), so router.replace with a changed search-param
  // set would force Next.js to re-render/re-fetch the entire Server
  // Component tree for this route immediately after Stripe's hard-
  // navigation redirect already rendered the page once — the exact
  // double-flash regression LessonsClient.tsx's own identical comment
  // documents. No detail sheet exists to auto-open here (unlike /calendar
  // /my-schedule): ProgramEnrollmentCard is already inline on this page
  // for every program the caller has a stake in, so nothing else is
  // needed beyond cleaning the URL bar.
  useEffect(() => {
    if (!initialCheckoutProgramId) return;
    window.history.replaceState(null, "", "/events");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Phase 34C — positive-price Join confirmation. Only ever set when
  // price_amount_cents > 0; Free/unpriced events keep the existing
  // frictionless direct-submit flow untouched.
  const [joinConfirm, setJoinConfirm] = useState<{
    eventId: string; title: string; priceCents: number; willWaitlist: boolean;
  } | null>(null);
  const [joinSubmitting, setJoinSubmitting] = useState(false);

  function requestJoin(eventId: string, title: string, priceCents: number | null, willWaitlist: boolean) {
    if (priceCents !== null && priceCents > 0) {
      setJoinConfirm({ eventId, title, priceCents, willWaitlist });
      return;
    }
    void submitJoin(eventId);
  }

  async function submitJoin(eventId: string) {
    setJoinSubmitting(true);
    const formData = new FormData();
    formData.set("event_id", eventId);
    try {
      await joinEventAction(formData);
    } finally {
      setJoinSubmitting(false);
      setJoinConfirm(null);
    }
  }

  const courtName = new Map(courtNames.map(c => [c.id, c.name]));

  // Unique event types present in the loaded events and programs, sorted
  // by label — a program's event type is included even if no per-session
  // event of that type happens to be loaded right now.
  const eventTypeOptions = (() => {
    const seen  = new Set<string>();
    const types: Array<{ key: string; label: string; color: string }> = [];
    for (const ev of events) {
      if (ev.event_types && !seen.has(ev.event_types.key)) {
        seen.add(ev.event_types.key);
        types.push(ev.event_types);
      }
    }
    for (const p of programs) {
      if (p.event_type && !seen.has(p.event_type.key)) {
        seen.add(p.event_type.key);
        types.push(p.event_type);
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

  // Same filter bar, applied to programs — reuses the existing search/type
  // state rather than adding a second filter UI (Phase 27D2: "respect the
  // Upcoming search and event-type filter where practical").
  const filteredPrograms = programs.filter(p => {
    if (eventTypeFilter && p.event_type?.key !== eventTypeFilter) return false;
    if (searchQuery.trim()) {
      if (!p.title.toLowerCase().includes(searchQuery.trim().toLowerCase())) return false;
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

      {events.length === 0 && programs.length === 0 ? (
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
                className="w-full pl-3 pr-8 py-2 rounded-xl text-base md:text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 border border-gray-200 dark:border-gray-700 shadow-sm focus:outline-none focus:ring-1 focus:ring-gray-300 dark:focus:ring-gray-600"
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

          {/* Programs section — member-only whole-program offerings, one
              card per program (never per generated session). Rendered
              before the chronological event list per Phase 27D2. Gated
              explicitly on isMember (not only on `programs` being empty)
              so admins/pros never see this section or its Join/Leave/
              Accept controls, matching their existing Upcoming experience. */}
          {isMember && programsError && programs.length === 0 && (
            <div className="px-4 pb-3 flex items-center justify-between gap-2">
              <span className="text-xs text-red-500">{programsError}</span>
              <button
                onClick={() => router.refresh()}
                className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 underline shrink-0"
              >
                Try again
              </button>
            </div>
          )}
          {isMember && filteredPrograms.length > 0 && (
            <div className="pb-2">
              <p className="px-4 pb-2 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                Programs
              </p>
              <div className="px-4 space-y-3">
                {filteredPrograms.map(p => (
                  <ProgramEnrollmentCard
                    key={p.id}
                    program={p}
                    clubId={clubId}
                    clubTimezone={clubTimezone}
                    currency={currency}
                    memberSelfService={memberSelfService}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Events list or filtered-empty state */}
          {filteredEvents.length === 0 && filteredPrograms.length === 0 ? (
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
          ) : filteredEvents.length === 0 ? null : (
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
                        const guestCount    = ev.event_guests?.filter(g => g.status === "active").length ?? 0;
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

                        // Phase 27D2: generated sessions under a whole-program
                        // (enrollment_model='program') offering have no
                        // per-session join/leave/waitlist — enrollment lives at
                        // the program level (see the Programs section above).
                        // member_joinable=false already blocks the RPC path for
                        // these events; this only controls what the card shows.
                        const isProgramManaged = ev.programs?.enrollment_model === "program";

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
                              isProgramManaged ? (
                                <span className="text-xs text-gray-400 dark:text-gray-500 italic">
                                  Enrollment through program
                                </span>
                              ) : isHost ? null : isOffered ? (
                                offerExpiredServerSide ? (
                                  // Phase 33F3B: rejoining after an expired
                                  // offer is a re-entry action — hidden at a
                                  // Staff-Managed club, same as a fresh Join.
                                  memberSelfService ? (
                                    <button
                                      type="button"
                                      onClick={() => requestJoin(ev.id, ev.title, ev.price_amount_cents, isFull)}
                                      className={ACTION_BUTTON_PRIMARY}
                                    >
                                      Rejoin
                                    </button>
                                  ) : null
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
                                // Phase 33F3B: a brand-new Join is the
                                // clearest new-entry action — hidden at a
                                // Staff-Managed club.
                                memberSelfService ? (
                                  <button
                                    type="button"
                                    onClick={() => requestJoin(ev.id, ev.title, ev.price_amount_cents, isFull)}
                                    className={ACTION_BUTTON_PRIMARY}
                                  >
                                    {isFull ? "Join Waitlist" : "Join Event"}
                                  </button>
                                ) : null
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

                            {/* Phase 34B: price — operators see the resolved
                                price always; Members only when configured. */}
                            <PriceSummary
                              label="Event price"
                              amountCents={ev.price_amount_cents}
                              currency={currency}
                              viewer={isOperator(userRole) ? "operator" : "member"}
                              breakdown={ev.price_amount_cents !== null ? "per participant" : null}
                              className="mt-0.5"
                            />

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

      {joinConfirm && (
        <EventJoinConfirmModal
          eventTitle={joinConfirm.title}
          priceCents={joinConfirm.priceCents}
          currency={currency}
          willWaitlist={joinConfirm.willWaitlist}
          submitting={joinSubmitting}
          onConfirm={() => submitJoin(joinConfirm.eventId)}
          onCancel={() => setJoinConfirm(null)}
        />
      )}
    </div>
  );
}
