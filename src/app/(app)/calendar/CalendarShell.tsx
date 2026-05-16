"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/db/types";

// ─── Constants ───────────────────────────────────────────────────────────────

const START_HOUR = 8;
const END_HOUR   = 19;
const GUTTER_W   = 52;
const COL_W      = 80;
const ROW_H      = 40;
const DAY_NAMES  = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

// ─── Types ───────────────────────────────────────────────────────────────────

type Reservation = Database["public"]["Tables"]["reservations"]["Row"];

interface Court {
  id:            string;
  name:          string;
  display_order: number;
}

interface BookingSlot {
  court:     Court;
  slotStart: Date;
  slotIdx:   number;
}

interface Props {
  courts:       Court[];
  hasError?:    boolean;
  userId:       string;
  clubId:       string;
  clubTimezone: string;
}

// ─── Timezone helpers ─────────────────────────────────────────────────────────

function tzOffsetMs(sampleDate: Date, tz: string): number {
  const toFake = (d: Date, timezone: string) =>
    new Date(d.toLocaleString("en-US", { timeZone: timezone })).getTime();
  return toFake(sampleDate, "UTC") - toFake(sampleDate, tz);
}

function getDayBoundsUTC(date: Date, tz: string): { start: string; end: string } {
  const dateStr = date.toLocaleDateString("en-CA", { timeZone: tz }); // YYYY-MM-DD
  const [y, m, d] = dateStr.split("-").map(Number);
  const utcMidnight = Date.UTC(y, m - 1, d);
  // Sample at noon to avoid DST-at-midnight edge cases
  const offset = tzOffsetMs(new Date(utcMidnight + 12 * 3600_000), tz);
  const start = new Date(utcMidnight + offset);
  return {
    start: start.toISOString(),
    end: new Date(start.getTime() + 24 * 3600_000).toISOString(),
  };
}

// Returns minutes elapsed since START_HOUR for a given UTC date in tz.
function minsFromViewportTop(utcDate: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(utcDate);
  const h = parseInt(parts.find(p => p.type === "hour")?.value   ?? "0", 10);
  const m = parseInt(parts.find(p => p.type === "minute")?.value ?? "0", 10);
  const hour = h === 24 ? 0 : h;
  return hour * 60 + m - START_HOUR * 60;
}

// ─── Time slot list ───────────────────────────────────────────────────────────

interface TimeSlot { label: string; isHour: boolean }

function buildTimeSlots(): TimeSlot[] {
  const slots: TimeSlot[] = [];
  for (let h = START_HOUR; h < END_HOUR; h++) {
    const ampm    = h < 12 ? "AM" : "PM";
    const display = h === 0 ? 12 : h > 12 ? h - 12 : h;
    slots.push({ label: `${display}:00 ${ampm}`, isHour: true });
    slots.push({ label: "",                       isHour: false });
  }
  return slots;
}

const TIME_SLOTS  = buildTimeSlots();
const TOTAL_GRID_H = TIME_SLOTS.length * ROW_H;

// ─── Date strip ───────────────────────────────────────────────────────────────

function buildDateStrip() {
  const today = new Date();
  const pills = [];
  for (let offset = -2; offset <= 10; offset++) {
    const d = new Date(today);
    d.setDate(today.getDate() + offset);
    pills.push({ date: d, day: DAY_NAMES[d.getDay()], dateNum: d.getDate() });
  }
  return pills;
}

const DATE_STRIP = buildDateStrip();

// ─── RPC error message map ────────────────────────────────────────────────────

function rpcErrorMessage(code: string | undefined, message: string): string {
  if (code === "23P01")                    return "That slot was just taken — please choose another time.";
  if (message === "outside_booking_window") return "That date is outside the booking window.";
  if (message === "cannot_book_past")       return "You cannot book in the past.";
  if (message === "outside_operating_hours") return "That time is outside operating hours.";
  if (message === "club_closed_this_day")   return "The club is closed on that day.";
  return "Something went wrong. Please try again.";
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function CalendarShell({ courts, hasError, userId, clubId, clubTimezone }: Props) {
  const supabase = useMemo(() => createClient(), []);

  // ── State ──────────────────────────────────────────────────────────────────
  const [selectedDate, setSelectedDate]         = useState<Date>(() => new Date());
  const [reservations, setReservations]         = useState<Reservation[]>([]);
  const [loadingRes, setLoadingRes]             = useState(false);
  const [refreshTick, setRefreshTick]           = useState(0);
  const [selectedCourtIds, setSelectedCourtIds] = useState<Set<string>>(
    () => new Set(courts.map(c => c.id))
  );
  const [bookingSlot, setBookingSlot]     = useState<BookingSlot | null>(null);
  const [bookingDuration, setBookingDuration] = useState<60 | 90>(60);
  const [bookingError, setBookingError]   = useState<string | null>(null);
  const [bookingLoading, setBookingLoading] = useState(false);
  // nowMs is 0 during SSR so all slots render as available (no past-slot check).
  // After hydration, useEffect sets the real timestamp, past slots disable without mismatch.
  const [nowMs, setNowMs]                 = useState(0);

  // ── Derived values ────────────────────────────────────────────────────────
  const dayBounds = useMemo(
    () => getDayBoundsUTC(selectedDate, clubTimezone),
    [selectedDate, clubTimezone]
  );
  const dayStartMs = useMemo(() => new Date(dayBounds.start).getTime(), [dayBounds]);

  const filteredCourts = useMemo(
    () => courts.filter(c => selectedCourtIds.has(c.id)),
    [courts, selectedCourtIds]
  );

  const innerWidth = GUTTER_W + Math.max(filteredCourts.length * COL_W, COL_W);

  // Map of courtId → set of occupied slot indices
  const occupiedSlots = useMemo(() => {
    const map = new Map<string, Set<number>>();
    for (const res of reservations) {
      const startMins = minsFromViewportTop(new Date(res.starts_at), clubTimezone);
      const endMins   = minsFromViewportTop(new Date(res.ends_at),   clubTimezone);
      const startSlot = Math.floor(startMins / 30);
      const endSlot   = Math.ceil(endMins   / 30);
      if (!map.has(res.court_id)) map.set(res.court_id, new Set());
      for (let s = startSlot; s < endSlot; s++) map.get(res.court_id)!.add(s);
    }
    return map;
  }, [reservations, clubTimezone]);

  // Client-side conflict check for extended duration
  const bookingConflict = useMemo(() => {
    if (!bookingSlot) return false;
    const courtSlots = occupiedSlots.get(bookingSlot.court.id) ?? new Set<number>();
    const numSlots   = bookingDuration / 30;
    // Slot 0 is guaranteed empty (user tapped it); check extension slots only
    for (let i = 1; i < numSlots; i++) {
      if (courtSlots.has(bookingSlot.slotIdx + i)) return true;
    }
    return false;
  }, [bookingSlot, bookingDuration, occupiedSlots]);

  // ── Reservation fetch ─────────────────────────────────────────────────────
  const fetchReservations = useCallback(async () => {
    if (!clubId) return;
    setLoadingRes(true);
    const { data, error } = await supabase
      .from("reservations")
      .select("*")
      .eq("club_id", clubId)
      .gte("starts_at", dayBounds.start)
      .lt("starts_at",  dayBounds.end)
      .in("status", ["pending", "confirmed"])
      .order("starts_at");
    if (!error) setReservations(data ?? []);
    setLoadingRes(false);
  }, [supabase, clubId, dayBounds, refreshTick]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { fetchReservations(); }, [fetchReservations]);
  useEffect(() => { setNowMs(Date.now()); }, []);

  // ── Handlers ──────────────────────────────────────────────────────────────
  function handleSlotTap(court: Court, slotIdx: number) {
    const slotStart = new Date(dayStartMs + (START_HOUR * 60 + slotIdx * 30) * 60_000);
    setBookingSlot({ court, slotStart, slotIdx });
    setBookingDuration(60);
    setBookingError(null);
  }

  function toggleCourt(courtId: string) {
    setSelectedCourtIds(prev => {
      const next = new Set(prev);
      if (next.has(courtId) && next.size > 1) next.delete(courtId);
      else next.add(courtId);
      return next;
    });
  }

  async function handleConfirmBooking() {
    if (!bookingSlot) return;
    setBookingLoading(true);
    setBookingError(null);

    const endsAt = new Date(bookingSlot.slotStart.getTime() + bookingDuration * 60_000);

    const { error } = await supabase.rpc("create_reservation", {
      p_court_id:  bookingSlot.court.id,
      p_starts_at: bookingSlot.slotStart.toISOString(),
      p_ends_at:   endsAt.toISOString(),
    });

    if (error) {
      setBookingError(rpcErrorMessage(error.code, error.message));
      setBookingLoading(false);
      return;
    }

    setBookingSlot(null);
    setBookingDuration(60);
    setRefreshTick(t => t + 1);
    setBookingLoading(false);
  }

  // ── Booking sheet labels ──────────────────────────────────────────────────
  const sheetDateLabel = bookingSlot
    ? bookingSlot.slotStart.toLocaleDateString("en-US", {
        timeZone: clubTimezone,
        weekday: "long", month: "long", day: "numeric",
      })
    : "";
  const sheetStartLabel = bookingSlot
    ? bookingSlot.slotStart.toLocaleTimeString("en-US", {
        timeZone: clubTimezone, hour: "numeric", minute: "2-digit", hour12: true,
      })
    : "";
  const sheetEndLabel = bookingSlot
    ? new Date(bookingSlot.slotStart.getTime() + bookingDuration * 60_000)
        .toLocaleTimeString("en-US", {
          timeZone: clubTimezone, hour: "numeric", minute: "2-digit", hour12: true,
        })
    : "";

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <>
      <div
        className="flex flex-col overflow-hidden bg-white"
        style={{ height: "calc(100dvh - 56px - 64px)" }}
      >

        {/* ── Date strip ────────────────────────────────────────────────── */}
        <div className="flex gap-1.5 overflow-x-auto px-3 py-2 border-b border-gray-100 shrink-0 hide-scrollbar">
          {DATE_STRIP.map((pill, i) => {
            const isSelected = pill.date.toLocaleDateString("en-CA", { timeZone: clubTimezone }) ===
              selectedDate.toLocaleDateString("en-CA", { timeZone: clubTimezone });
            const isToday = pill.date.toLocaleDateString("en-CA", { timeZone: clubTimezone }) ===
              new Date().toLocaleDateString("en-CA", { timeZone: clubTimezone });
            return (
              <button
                key={i}
                onClick={() => setSelectedDate(new Date(pill.date))}
                className={`flex flex-col items-center justify-center rounded-full shrink-0 w-10 h-10 text-xs leading-tight ${
                  isSelected
                    ? "bg-gray-900 text-white font-semibold"
                    : isToday
                    ? "text-blue-600 font-medium"
                    : "text-gray-500"
                }`}
              >
                <span>{pill.day}</span>
                <span>{pill.dateNum}</span>
              </button>
            );
          })}
        </div>

        {/* ── View toggle (Day only for Phase 2) ────────────────────────── */}
        <div className="flex gap-1.5 px-3 py-2 border-b border-gray-100 shrink-0">
          {["Day", "Week", "My Schedule"].map(v => (
            <button
              key={v}
              disabled
              className={`px-3 py-1 rounded-full text-xs font-medium ${
                v === "Day"
                  ? "bg-gray-900 text-white"
                  : "bg-gray-100 text-gray-500"
              }`}
            >
              {v}
            </button>
          ))}
        </div>

        {/* ── Court filter chips ────────────────────────────────────────── */}
        <div className="flex gap-2 px-3 py-2 border-b border-gray-100 overflow-x-auto shrink-0 hide-scrollbar">
          <button
            onClick={() => setSelectedCourtIds(new Set(courts.map(c => c.id)))}
            className={`shrink-0 px-3 py-1 rounded-full text-xs font-medium ${
              selectedCourtIds.size === courts.length
                ? "bg-gray-900 text-white"
                : "bg-gray-100 text-gray-600"
            }`}
          >
            All
          </button>
          {courts.map(court => (
            <button
              key={court.id}
              onClick={() => toggleCourt(court.id)}
              className={`shrink-0 px-3 py-1 rounded-full text-xs font-medium ${
                selectedCourtIds.has(court.id)
                  ? "bg-gray-900 text-white"
                  : "bg-gray-100 text-gray-600"
              }`}
            >
              {court.name}
            </button>
          ))}
        </div>

        {/* ── Error / empty states ──────────────────────────────────────── */}
        {hasError && (
          <p className="mx-4 mt-3 text-xs text-gray-400 shrink-0">
            Unable to load courts. Please try refreshing.
          </p>
        )}
        {!hasError && courts.length === 0 && (
          <p className="mx-4 mt-3 text-xs text-gray-400 shrink-0">
            No courts found. Please check your club setup.
          </p>
        )}

        {/* ── Timeline grid ─────────────────────────────────────────────── */}
        <div className="flex-1 min-h-0 overflow-auto">
          <div style={{ width: innerWidth, minWidth: "100%" }}>

            {/* Sticky court-name header */}
            <div
              className="flex bg-white border-b border-gray-200 sticky top-0 z-20"
              style={{ width: innerWidth }}
            >
              <div
                className="shrink-0 sticky left-0 z-30 bg-white border-r border-gray-200"
                style={{ width: GUTTER_W }}
              />
              {filteredCourts.length > 0 ? (
                filteredCourts.map(court => (
                  <div
                    key={court.id}
                    className="shrink-0 text-center text-xs font-medium text-gray-700 py-2 border-l border-gray-200"
                    style={{ width: COL_W }}
                  >
                    {court.name}
                  </div>
                ))
              ) : (
                <div className="shrink-0 border-l border-gray-200" style={{ width: COL_W }} />
              )}
            </div>

            {/* Grid body: gutter + court columns */}
            <div className="flex" style={{ height: TOTAL_GRID_H }}>

              {/* Time gutter — sticky on horizontal scroll */}
              <div
                className="shrink-0 sticky left-0 z-10 bg-white border-r border-gray-200"
                style={{ width: GUTTER_W, height: TOTAL_GRID_H }}
              >
                {TIME_SLOTS.map((slot, i) => (
                  <div
                    key={i}
                    className="absolute flex justify-end pr-1.5"
                    style={{ top: i * ROW_H, height: ROW_H, width: GUTTER_W, paddingTop: 3 }}
                  >
                    {slot.isHour && (
                      <span className="text-[10px] leading-none text-gray-400">{slot.label}</span>
                    )}
                  </div>
                ))}
              </div>

              {/* Court columns */}
              {filteredCourts.length > 0 ? (
                filteredCourts.map(court => {
                  const courtRes  = reservations.filter(r => r.court_id === court.id);
                  const occupied  = occupiedSlots.get(court.id) ?? new Set<number>();

                  return (
                    <div
                      key={court.id}
                      className="relative shrink-0 border-l border-gray-200"
                      style={{ width: COL_W, height: TOTAL_GRID_H }}
                    >
                      {/* 30-min slot tap targets */}
                      {TIME_SLOTS.map((slot, slotIdx) => {
                        const isOccupied = occupied.has(slotIdx);
                        const slotStartMs = dayStartMs + (START_HOUR * 60 + slotIdx * 30) * 60_000;
                        const isPast      = nowMs > 0 && slotStartMs < nowMs;
                        const isDisabled  = isOccupied || isPast;

                        return (
                          <button
                            key={slotIdx}
                            disabled={isDisabled}
                            onClick={() => handleSlotTap(court, slotIdx)}
                            className={`absolute border-t ${
                              slot.isHour ? "border-gray-200" : "border-gray-100"
                            } ${!isDisabled ? "cursor-pointer hover:bg-blue-50 active:bg-blue-100" : "cursor-default"}`}
                            style={{
                              top: slotIdx * ROW_H,
                              height: ROW_H,
                              left: 0,
                              right: 0,
                              touchAction: "manipulation",
                            }}
                          >
                            {!isDisabled && (
                              <div className="mx-1 my-0.5 h-[calc(100%-4px)] border border-dashed border-gray-200 rounded-sm" />
                            )}
                          </button>
                        );
                      })}

                      {/* Reservation blocks — absolutely positioned over the slot buttons */}
                      {courtRes.map(res => {
                        const startMins = minsFromViewportTop(new Date(res.starts_at), clubTimezone);
                        const endMins   = minsFromViewportTop(new Date(res.ends_at),   clubTimezone);
                        const top       = (startMins / 30) * ROW_H;
                        const height    = Math.max(((endMins - startMins) / 30) * ROW_H - 2, 4);
                        const isOwn     = res.owner_user_id === userId;
                        const isBlocked = res.reason !== "member_booking";

                        return (
                          <div
                            key={res.id}
                            className={`absolute rounded text-[10px] font-medium px-1 overflow-hidden pointer-events-none flex items-center ${
                              isOwn
                                ? "border-2 border-blue-500 bg-blue-50 text-blue-700"
                                : isBlocked
                                ? "text-gray-400"
                                : "bg-gray-400 text-white"
                            }`}
                            style={{
                              top: top + 1,
                              height,
                              left: 2,
                              right: 2,
                              ...(isBlocked ? {
                                background: "repeating-linear-gradient(-45deg,#e5e7eb 0px,#e5e7eb 4px,#f9fafb 4px,#f9fafb 8px)",
                              } : {}),
                            }}
                          >
                            {isOwn ? "You / Booked" : isBlocked ? "Unavailable" : ""}
                          </div>
                        );
                      })}
                    </div>
                  );
                })
              ) : (
                /* Placeholder column so grid rows still draw when all filtered out */
                <div
                  className="flex-1 border-l border-gray-200"
                  style={{ height: TOTAL_GRID_H }}
                />
              )}

            </div>
            {/* Loading indicator */}
            {loadingRes && (
              <div className="text-center py-2 text-xs text-gray-400">Loading…</div>
            )}
          </div>
        </div>
      </div>

      {/* ── Booking sheet ────────────────────────────────────────────────── */}
      {bookingSlot && (
        <>
          <div
            className="fixed inset-0 bg-black/30 z-40"
            onClick={() => { setBookingSlot(null); setBookingError(null); }}
          />
          <div className="fixed bottom-0 left-0 right-0 bg-white rounded-t-2xl z-50 px-6 pt-5 pb-8 shadow-xl">
            <div className="w-10 h-1 bg-gray-200 rounded-full mx-auto mb-4" />

            <p className="text-base font-semibold text-gray-900">{bookingSlot.court.name}</p>
            <p className="text-sm text-gray-500 mt-0.5">{sheetDateLabel}</p>
            <p className="text-sm text-gray-700 mt-1 font-medium">
              {sheetStartLabel} – {sheetEndLabel}
            </p>

            <div className="flex items-center gap-3 mt-4">
              <span className="text-sm text-gray-600">Duration</span>
              {([60, 90] as const).map(d => (
                <button
                  key={d}
                  onClick={() => setBookingDuration(d)}
                  className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                    bookingDuration === d
                      ? "bg-gray-900 text-white"
                      : "bg-gray-100 text-gray-600"
                  }`}
                >
                  {d} min
                </button>
              ))}
            </div>

            {bookingConflict && (
              <p className="mt-3 text-xs text-amber-600">
                Conflicts with an existing booking — try 60 min or a different slot.
              </p>
            )}
            {bookingError && (
              <p className="mt-3 text-xs text-red-500">{bookingError}</p>
            )}

            <button
              disabled={bookingConflict || bookingLoading}
              onClick={handleConfirmBooking}
              className="mt-5 w-full py-3 rounded-xl bg-gray-900 text-white text-sm font-semibold disabled:opacity-40"
            >
              {bookingLoading ? "Booking…" : "Confirm Booking"}
            </button>
          </div>
        </>
      )}
    </>
  );
}
