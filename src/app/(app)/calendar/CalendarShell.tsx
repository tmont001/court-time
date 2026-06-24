"use client";

import { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/db/types";
import EventDetailSheet from "./EventDetailSheet";
import CreateEventSheet from "./CreateEventSheet";
import ReservationDetailSheet from "./ReservationDetailSheet";
import CreateMaintenanceSheet from "./CreateMaintenanceSheet";
import { createReservation, cancelMemberReservation } from "./actions";

// ─── Constants ───────────────────────────────────────────────────────────────

// Fallback hours used when no operating_hours row exists for the selected day.
const DEFAULT_START_HOUR = 8;
const DEFAULT_END_HOUR   = 19;
const GUTTER_W   = 52;
const MIN_colW  = 80;
const MAX_colW  = 320;
// Row height is responsive: starts at MIN_ROW_H (mobile tap-target size) and
// grows to fill available vertical space on taller viewports, up to MAX_ROW_H.
const MIN_ROW_H  = 40;
const MAX_ROW_H  = 64;
// Approximate height of the sticky court-name header row (py-2 + text-xs + border).
const COURT_HEADER_H = 33;
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

// Raw shape returned by the events query (reservations nested for court_id derivation)
interface RawEventRow {
  id: string;
  title: string;
  starts_at: string;
  ends_at: string;
  capacity: number;
  status: string;
  created_by: string;
  event_types: {
    key: string;
    label: string;
    color: string;
    shows_participant_names: boolean;
  };
  event_participants: Array<{ profile_id: string; role: string; status: string; offer_expires_at: string | null }>;
  event_guests: Array<{ id: string }>;
  reservations: Array<{ court_id: string; status: string; reason: string }>;
}

interface EventWithDetails {
  id: string;
  title: string;
  starts_at: string;
  ends_at: string;
  capacity: number;
  status: string;
  created_by: string;
  event_types: {
    key: string;
    label: string;
    color: string;
    shows_participant_names: boolean;
  };
  event_participants: Array<{ profile_id: string; role: string; status: string; offer_expires_at: string | null }>;
  event_guests: Array<{ id: string }>;
  court_ids: string[];
}

interface SlotAction {
  court:     Court;
  slotStart: Date;
  slotIdx:   number;
}

interface OperatingHoursRow {
  day_of_week: number;
  opens_at:    string; // "HH:MM:SS" from DB
  closes_at:   string;
  is_closed:   boolean;
}

// Phase 17C: date-specific override row (subset of operating_hours_override).
interface OperatingHoursOverrideRow {
  override_date: string;        // YYYY-MM-DD
  is_closed:     boolean;
  opens_at:      string | null; // "HH:MM:SS" or null
  closes_at:     string | null; // "HH:MM:SS" or null
  note:          string | null;
}

interface Props {
  courts:                  Court[];
  hasError?:               boolean;
  userId:                  string;
  clubId:                  string;
  clubTimezone:            string;
  userRole:                string;
  todayISO:                string; // YYYY-MM-DD in club timezone, computed server-side
  operatingHours:          OperatingHoursRow[];
  operatingHoursOverrides: OperatingHoursOverrideRow[]; // Phase 17C
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

// Returns minutes elapsed since viewStartHour for a given UTC date in tz.
function minsFromViewportTop(utcDate: Date, tz: string, viewStartHour: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(utcDate);
  const h = parseInt(parts.find(p => p.type === "hour")?.value   ?? "0", 10);
  const m = parseInt(parts.find(p => p.type === "minute")?.value ?? "0", 10);
  const hour = h === 24 ? 0 : h;
  return hour * 60 + m - viewStartHour * 60;
}

// ─── Time slot list ───────────────────────────────────────────────────────────

interface TimeSlot { label: string; isHour: boolean }

function buildTimeSlots(startHour: number, endHour: number): TimeSlot[] {
  const slots: TimeSlot[] = [];
  for (let h = startHour; h < endHour; h++) {
    const ampm    = h < 12 ? "AM" : "PM";
    const display = h === 0 ? 12 : h > 12 ? h - 12 : h;
    slots.push({ label: `${display}:00 ${ampm}`, isHour: true });
    slots.push({ label: "",                       isHour: false });
  }
  return slots;
}

// ─── Override time formatter ─────────────────────────────────────────────────
// Converts "HH:MM" or "HH:MM:SS" to a 12-hour display string, e.g. "8:00 AM".

function formatTimeStr(t: string): string {
  const [h, m] = t.slice(0, 5).split(":").map(Number);
  const ampm    = h < 12 ? "AM" : "PM";
  const display = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return m === 0
    ? `${display} ${ampm}`
    : `${display}:${String(m).padStart(2, "0")} ${ampm}`;
}

// ─── RPC error message map ────────────────────────────────────────────────────

function rpcErrorMessage(code: string | undefined, message: string): string {
  if (code === "23P01")                    return "That slot was just taken — please choose another time.";
  if (message === "outside_booking_window") return "That date is outside the booking window.";
  if (message === "cannot_book_past")       return "You cannot book in the past.";
  if (message === "outside_operating_hours") return "That time is outside operating hours.";
  if (message === "club_closed_this_day")   return "The club is closed on that day.";
  if (message === "invalid_duration")       return "Reservations must be 30, 60, 90, or 120 minutes.";
  return "Something went wrong. Please try again.";
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function CalendarShell({ courts, hasError, userId, clubId, clubTimezone, userRole, todayISO, operatingHours, operatingHoursOverrides }: Props) {
  const supabase = useMemo(() => createClient(), []);

  // ── State ──────────────────────────────────────────────────────────────────
  // Initialize from the server-supplied date string (UTC noon = same calendar date in any timezone).
  const [selectedDate, setSelectedDate]         = useState<Date>(() => new Date(todayISO + "T12:00:00Z"));
  const [reservations, setReservations]         = useState<Reservation[]>([]);
  const [loadingRes, setLoadingRes]             = useState(false);
  const [refreshTick, setRefreshTick]           = useState(0);
  const [selectedCourtIds, setSelectedCourtIds] = useState<Set<string>>(
    () => new Set(courts.map(c => c.id))
  );
  const [resError, setResError]           = useState(false);
  const [bookingSlot, setBookingSlot]     = useState<BookingSlot | null>(null);
  const [bookingDuration, setBookingDuration] = useState<30 | 60 | 90 | 120>(60);
  const [bookingError, setBookingError]   = useState<string | null>(null);
  const [bookingLoading, setBookingLoading] = useState(false);
  // nowMs is 0 during SSR so all slots render as available (no past-slot check).
  // After hydration, useEffect sets the real timestamp, past slots disable without mismatch.
  const [nowMs, setNowMs]                 = useState(0);
  const [events, setEvents]               = useState<EventWithDetails[]>([]);

  // ── Responsive column width / row height ──────────────────────────────────
  // Starts at MIN_colW / MIN_ROW_H for consistent SSR/hydration.
  // The useLayoutEffect below (placed after filteredCourts) updates these via
  // a ResizeObserver once the grid container is mounted.
  const gridContainerRef                  = useRef<HTMLDivElement>(null);
  const [colW, setColW]                   = useState(MIN_colW);
  const [rowH, setRowH]                   = useState(MIN_ROW_H);
  const [containerW, setContainerW]       = useState(0);
  const [selectedEvent, setSelectedEvent] = useState<EventWithDetails | null>(null);
  const [creatingEvent, setCreatingEvent] = useState(false);
  const [selectedReservation, setSelectedReservation] = useState<Reservation | null>(null);
  const [creatingBlock, setCreatingBlock]             = useState(false);
  const [pendingSlotAction, setPendingSlotAction]     = useState<SlotAction | null>(null);
  const [slotPreFill, setSlotPreFill]                 = useState<SlotAction | null>(null);
  // Admin/pro only: maps owner_user_id → display name for non-own member bookings.
  const [ownerNames, setOwnerNames]                   = useState<Map<string, string>>(new Map());

  // ── Date pills ────────────────────────────────────────────────────────────
  // Built from todayISO (not new Date()) so server and client produce identical output.
  // UTC noon is used so toLocaleDateString in any tz still returns the correct calendar date.
  const datePills = useMemo(() => {
    const [ty, tm, td] = todayISO.split("-").map(Number);
    return Array.from({ length: 13 }, (_, i) => {
      const offset = i - 2; // -2 … +10
      const dt = new Date(Date.UTC(ty, tm - 1, td + offset, 12, 0, 0));
      return {
        dateISO: dt.toISOString().slice(0, 10),
        day:     DAY_NAMES[dt.getUTCDay()],
        dateNum: dt.getUTCDate(),
      };
    });
  }, [todayISO]);

  // ── Derived values ────────────────────────────────────────────────────────
  const dayBounds = useMemo(
    () => getDayBoundsUTC(selectedDate, clubTimezone),
    [selectedDate, clubTimezone]
  );
  const dayStartMs = useMemo(() => new Date(dayBounds.start).getTime(), [dayBounds]);

  // selectedDate is stored as UTC noon, so getUTCDay() correctly returns the
  // club-local day-of-week (the date pills encode local dates as UTC noon).
  const selectedDayHours = useMemo(() => {
    const dow = selectedDate.getUTCDay();
    return operatingHours.find(h => h.day_of_week === dow) ?? null;
  }, [selectedDate, operatingHours]);

  // Phase 17C: find any date-specific override for the selected day.
  // Uses the club-local YYYY-MM-DD string so the lookup is timezone-safe.
  const selectedDateOverride = useMemo(() => {
    const iso = selectedDate.toLocaleDateString("en-CA", { timeZone: clubTimezone });
    return operatingHoursOverrides.find(o => o.override_date === iso) ?? null;
  }, [selectedDate, clubTimezone, operatingHoursOverrides]);

  // isSpecialHours: override present, not fully closed, and both hours set.
  const isSpecialHours = !!(
    selectedDateOverride &&
    !selectedDateOverride.is_closed &&
    selectedDateOverride.opens_at &&
    selectedDateOverride.closes_at
  );

  // isClosed: date-specific override (if any) takes priority over weekly hours.
  const isClosed = selectedDateOverride
    ? selectedDateOverride.is_closed
    : (selectedDayHours?.is_closed ?? false);

  // startHour / endHour priority:
  //   1. Special-hours override — use override opens_at / closes_at.
  //   2. Normal weekly hours (no override or override without hours, not closed).
  //   3. Closed-override day — show weekly hours so existing bookings stay visible;
  //      fall through to DEFAULT only when weekly is also closed or absent.
  const startHour = isSpecialHours && selectedDateOverride?.opens_at
    ? parseInt(selectedDateOverride.opens_at.slice(0, 2), 10)
    : !isClosed && selectedDayHours
    ? parseInt(selectedDayHours.opens_at.slice(0, 2), 10)
    : selectedDateOverride?.is_closed && selectedDayHours && !selectedDayHours.is_closed
    ? parseInt(selectedDayHours.opens_at.slice(0, 2), 10)
    : DEFAULT_START_HOUR;

  const endHour = isSpecialHours && selectedDateOverride?.closes_at
    ? parseInt(selectedDateOverride.closes_at.slice(0, 2), 10)
    : !isClosed && selectedDayHours
    ? parseInt(selectedDayHours.closes_at.slice(0, 2), 10)
    : selectedDateOverride?.is_closed && selectedDayHours && !selectedDayHours.is_closed
    ? parseInt(selectedDayHours.closes_at.slice(0, 2), 10)
    : DEFAULT_END_HOUR;

  const timeSlots  = useMemo(() => buildTimeSlots(startHour, endHour), [startHour, endHour]);
  const totalGridH = timeSlots.length * rowH;

  const filteredCourts = useMemo(
    () => courts.filter(c => selectedCourtIds.has(c.id)),
    [courts, selectedCourtIds]
  );

  // Pre-index events by court so the render loop does a Map lookup instead of
  // scanning the full events array for every court column on every render.
  const eventsByCourtId = useMemo(() => {
    const map = new Map<string, EventWithDetails[]>();
    for (const ev of events) {
      for (const cid of ev.court_ids) {
        if (!map.has(cid)) map.set(cid, []);
        map.get(cid)!.push(ev);
      }
    }
    return map;
  }, [events]);

  // Placed after filteredCourts/timeSlots to avoid the forward-reference TS error.
  useLayoutEffect(() => {
    const el = gridContainerRef.current;
    if (!el) return;
    const compute = () => {
      const available = el.clientWidth - GUTTER_W;
      const count     = Math.max(filteredCourts.length, 1);
      setColW(Math.min(Math.max(Math.floor(available / count), MIN_colW), MAX_colW));
      setContainerW(el.clientWidth);

      // Stretch row height to fill available vertical space (desktop), capped
      // so rows never shrink below tap-target size or grow absurdly tall.
      const availableH = el.clientHeight - COURT_HEADER_H;
      const slotCount  = Math.max(timeSlots.length, 1);
      setRowH(Math.min(Math.max(Math.floor(availableH / slotCount), MIN_ROW_H), MAX_ROW_H));
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [filteredCourts.length, timeSlots.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const innerWidth = GUTTER_W + Math.max(filteredCourts.length * colW, colW);

  // When the selected courts don't fill the available width (low court counts
  // on desktop), center the grid instead of left-aligning it with a large
  // blank region to the right. Once content overflows, fall back to the
  // default left-aligned + horizontal-scroll behavior.
  const fitsContainer = containerW > 0 && innerWidth <= containerW;

  // Map of courtId → set of occupied slot indices
  const occupiedSlots = useMemo(() => {
    const map = new Map<string, Set<number>>();
    for (const res of reservations) {
      const startMins = minsFromViewportTop(new Date(res.starts_at), clubTimezone, startHour);
      const endMins   = minsFromViewportTop(new Date(res.ends_at),   clubTimezone, startHour);
      const startSlot = Math.floor(startMins / 30);
      const endSlot   = Math.ceil(endMins   / 30);
      if (!map.has(res.court_id)) map.set(res.court_id, new Set());
      for (let s = startSlot; s < endSlot; s++) map.get(res.court_id)!.add(s);
    }
    return map;
  }, [reservations, clubTimezone, startHour]);

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
    setResError(false);
    const { data, error } = await supabase
      .from("reservations")
      .select("*")
      .eq("club_id", clubId)
      .gte("starts_at", dayBounds.start)
      .lt("starts_at",  dayBounds.end)
      .in("status", ["pending", "confirmed"])
      .order("starts_at");
    if (error) {
      setResError(true);
    } else {
      const rows = data ?? [];
      setReservations(rows);

      // For admin/pro: fetch display names for other members' court reservations.
      // RLS (profiles_select_same_club) already limits results to the same club.
      if (userRole === "admin" || userRole === "pro") {
        const otherIds = [...new Set(
          rows
            .filter(r => r.owner_user_id !== userId && r.reason === "member_booking")
            .map(r => r.owner_user_id)
        )];
        if (otherIds.length > 0) {
          const { data: profiles } = await supabase
            .from("profiles")
            .select("id, first_name, last_name")
            .in("id", otherIds);
          const map = new Map<string, string>();
          for (const p of profiles ?? []) {
            const f = p.first_name ?? "";
            const l = p.last_name  ?? "";
            map.set(p.id, l ? `${f} ${l[0]}.` : f || "Member");
          }
          setOwnerNames(map);
        } else {
          setOwnerNames(new Map());
        }
      }
    }
    setLoadingRes(false);
  }, [supabase, clubId, dayBounds, refreshTick]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Event fetch ───────────────────────────────────────────────────────────
  const fetchEvents = useCallback(async () => {
    if (!clubId) return;
    const { data, error } = await supabase
      .from("events")
      .select(`
        id, title, starts_at, ends_at, capacity, status, created_by,
        event_types(key, label, color, shows_participant_names),
        event_participants(profile_id, role, status, offer_expires_at),
        event_guests(id),
        reservations(court_id, status, reason)
      `)
      .eq("club_id", clubId)
      .gte("starts_at", dayBounds.start)
      .lt("starts_at",  dayBounds.end)
      .eq("status", "scheduled")
      .order("starts_at");
    if (!error) {
      const mapped = (data ?? []).map((row: unknown) => {
        const r = row as RawEventRow;
        return {
          id:                 r.id,
          title:              r.title,
          starts_at:          r.starts_at,
          ends_at:            r.ends_at,
          capacity:           r.capacity,
          status:             r.status,
          created_by:         r.created_by,
          event_types:        r.event_types,
          event_participants: r.event_participants,
          event_guests:       r.event_guests,
          court_ids: r.reservations
            .filter(res => res.reason === "event" && res.status === "confirmed")
            .map(res => res.court_id),
        };
      });
      setEvents(mapped);
    }
  }, [supabase, clubId, dayBounds, refreshTick]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetchReservations();
    fetchEvents();
  }, [fetchReservations, fetchEvents]);
  useEffect(() => { setNowMs(Date.now()); }, []);

  // ── Handlers ──────────────────────────────────────────────────────────────
  function handleSlotTap(court: Court, slotIdx: number) {
    const slotStart = new Date(dayStartMs + (startHour * 60 + slotIdx * 30) * 60_000);
    if (userRole === "pro" || userRole === "admin") {
      // Show the role-based action menu.
      setPendingSlotAction({ court, slotStart, slotIdx });
    } else {
      // Members go straight to the booking modal.
      setBookingSlot({ court, slotStart, slotIdx });
      setBookingDuration(60);
      setBookingError(null);
    }
  }

  function openBookingFromSlot() {
    if (!pendingSlotAction) return;
    setBookingSlot({ court: pendingSlotAction.court, slotStart: pendingSlotAction.slotStart, slotIdx: pendingSlotAction.slotIdx });
    setBookingDuration(60);
    setBookingError(null);
    setPendingSlotAction(null);
  }

  function openEventFromSlot() {
    if (!pendingSlotAction) return;
    setSlotPreFill(pendingSlotAction);
    setCreatingEvent(true);
    setPendingSlotAction(null);
  }

  function openBlockFromSlot() {
    if (!pendingSlotAction) return;
    setSlotPreFill(pendingSlotAction);
    setCreatingBlock(true);
    setPendingSlotAction(null);
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

    const { error } = await createReservation({
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
        className="relative flex flex-col overflow-hidden bg-white dark:bg-gray-900"
        data-role={userRole}
        style={{ height: "var(--page-fill-height)" }}
      >

        {/* ── Date strip ────────────────────────────────────────────────── */}
        <div className="flex gap-1.5 overflow-x-auto px-3 py-2 border-b border-gray-100 dark:border-gray-800 shrink-0 hide-scrollbar">
          {datePills.map((pill) => {
            const selectedISO = selectedDate.toLocaleDateString("en-CA", { timeZone: clubTimezone });
            const isSelected  = pill.dateISO === selectedISO;
            const isToday     = pill.dateISO === todayISO;
            return (
              <button
                key={pill.dateISO}
                onClick={() => setSelectedDate(new Date(pill.dateISO + "T12:00:00Z"))}
                className={`flex flex-col items-center justify-center rounded-full shrink-0 w-10 h-10 text-xs leading-tight ${
                  isSelected
                    ? "bg-accent text-white dark:text-gray-900 font-semibold"
                    : isToday
                    ? "text-blue-600 dark:text-blue-400 font-medium"
                    : "text-gray-500 dark:text-gray-400"
                }`}
              >
                <span>{pill.day}</span>
                <span>{pill.dateNum}</span>
              </button>
            );
          })}
        </div>


        {/* ── Court filter chips ────────────────────────────────────────── */}
        <div className="flex gap-2 px-3 py-2 border-b border-gray-100 dark:border-gray-800 overflow-x-auto shrink-0 hide-scrollbar">
          <button
            onClick={() => {
              const allSelected = courts.length > 0 && selectedCourtIds.size === courts.length;
              setSelectedCourtIds(allSelected ? new Set() : new Set(courts.map(c => c.id)));
            }}
            className={`shrink-0 px-3 py-1 rounded-full text-xs font-medium ${
              courts.length > 0 && selectedCourtIds.size === courts.length
                ? "bg-accent text-white dark:text-gray-900"
                : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400"
            }`}
          >
            {courts.length > 0 && selectedCourtIds.size === courts.length ? "Deselect all" : "Select all"}
          </button>
          {courts.map(court => (
            <button
              key={court.id}
              onClick={() => toggleCourt(court.id)}
              className={`shrink-0 px-3 py-1 rounded-full text-xs font-medium ${
                selectedCourtIds.has(court.id)
                  ? "bg-accent text-white dark:text-gray-900"
                  : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400"
              }`}
            >
              {court.name}
            </button>
          ))}
        </div>

        {/* ── Closed-day banner ────────────────────────────────────────── */}
        {isClosed && (
          <div className="px-4 py-2 bg-amber-50 dark:bg-amber-900/20 border-b border-amber-200 dark:border-amber-700 shrink-0">
            <p className="text-xs font-medium text-amber-700 dark:text-amber-400 text-center">
              {selectedDateOverride?.is_closed && selectedDateOverride.note
                ? `Club closed — no bookings available on this day. ${selectedDateOverride.note}`
                : "Club closed — no bookings available on this day"}
            </p>
          </div>
        )}

        {/* ── Special-hours banner (Phase 17C) ─────────────────────────── */}
        {!isClosed && isSpecialHours && selectedDateOverride && (
          <div className="px-4 py-2 bg-blue-50 dark:bg-blue-900/20 border-b border-blue-200 dark:border-blue-700 shrink-0">
            <p className="text-xs font-medium text-blue-700 dark:text-blue-400 text-center">
              {`Special hours today: ${formatTimeStr(selectedDateOverride.opens_at!)} – ${formatTimeStr(selectedDateOverride.closes_at!)}`}
              {selectedDateOverride.note ? ` · ${selectedDateOverride.note}` : ""}
            </p>
          </div>
        )}

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
        <div className="flex-1 min-h-0 overflow-auto" ref={gridContainerRef}>
          <div style={{ width: innerWidth, margin: fitsContainer ? "0 auto" : undefined }}>

            {/* Sticky court-name header */}
            <div
              className="flex bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 sticky top-0 z-20"
              style={{ width: innerWidth }}
            >
              <div
                className="shrink-0 sticky left-0 z-30 bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-700"
                style={{ width: GUTTER_W }}
              />
              {filteredCourts.length > 0 ? (
                filteredCourts.map(court => (
                  <div
                    key={court.id}
                    className="shrink-0 text-center text-xs font-medium text-gray-700 dark:text-gray-300 py-2 border-l border-gray-200 dark:border-gray-700"
                    style={{ width: colW }}
                  >
                    {court.name}
                  </div>
                ))
              ) : (
                <div className="shrink-0 border-l border-gray-200 dark:border-gray-700" style={{ width: colW }} />
              )}
            </div>

            {/* Grid body: gutter + court columns */}
            <div className="flex" style={{ height: totalGridH }}>

              {/* Time gutter — sticky on horizontal scroll */}
              <div
                className="shrink-0 sticky left-0 z-10 bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-700"
                style={{ width: GUTTER_W, height: totalGridH }}
              >
                {timeSlots.map((slot: TimeSlot, i: number) => (
                  <div
                    key={i}
                    className="absolute flex justify-end pr-1.5"
                    style={{ top: i * rowH, height: rowH, width: GUTTER_W, paddingTop: 3 }}
                  >
                    {slot.isHour && (
                      <span className="text-[10px] leading-none text-gray-400 dark:text-gray-600">{slot.label}</span>
                    )}
                  </div>
                ))}
              </div>

              {/* Court columns */}
              {filteredCourts.length > 0 ? (
                filteredCourts.map(court => {
                  const courtRes  = reservations.filter(r => r.court_id === court.id && r.reason !== "event");
                  const occupied  = occupiedSlots.get(court.id) ?? new Set<number>();

                  return (
                    <div
                      key={court.id}
                      className="relative shrink-0 border-l border-gray-200 dark:border-gray-700"
                      style={{ width: colW, height: totalGridH }}
                    >
                      {/* 30-min slot tap targets */}
                      {timeSlots.map((slot: TimeSlot, slotIdx: number) => {
                        const isOccupied  = occupied.has(slotIdx);
                        const slotStartMs = dayStartMs + (startHour * 60 + slotIdx * 30) * 60_000;
                        const isPast      = nowMs > 0 && slotStartMs < nowMs;
                        // Slots are also disabled on closed days
                        const isDisabled  = isOccupied || isPast || isClosed;

                        return (
                          <button
                            key={slotIdx}
                            disabled={isDisabled}
                            onClick={() => handleSlotTap(court, slotIdx)}
                            className={`absolute border-t ${
                              slot.isHour ? "border-gray-200 dark:border-gray-700/60" : "border-gray-100 dark:border-gray-800"
                            } ${!isDisabled ? "cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700/25 active:bg-gray-200 dark:active:bg-gray-700/40" : "cursor-default"}`}
                            style={{
                              top: slotIdx * rowH,
                              height: rowH,
                              left: 0,
                              right: 0,
                              touchAction: "manipulation",
                            }}
                          >
                            {!isDisabled && (
                              <div className="mx-1 my-0.5 h-[calc(100%-4px)] border border-dashed border-gray-200 dark:border-gray-700 rounded-sm" />
                            )}
                          </button>
                        );
                      })}

                      {/* Reservation blocks — absolutely positioned over the slot buttons */}
                      {courtRes.map(res => {
                        const startMins = minsFromViewportTop(new Date(res.starts_at), clubTimezone, startHour);
                        const endMins   = minsFromViewportTop(new Date(res.ends_at),   clubTimezone, startHour);
                        const top       = (startMins / 30) * rowH;
                        const height    = Math.max(((endMins - startMins) / 30) * rowH - 2, 4);
                        const isOwn     = res.owner_user_id === userId;
                        const isBlocked = res.reason !== "member_booking";
                        const isAdmin   = userRole === "admin";

                        // Members can tap their own court reservations to manage/cancel them.
                        const isClickable = isAdmin || (isOwn && !isBlocked);
                        const blockCls = `absolute rounded text-[10px] font-medium px-1 overflow-hidden flex items-center ${
                          isClickable ? "cursor-pointer" : "pointer-events-none"
                        } ${
                          isOwn
                            ? "border-2 border-blue-500 bg-blue-50 text-blue-700"
                            : isBlocked
                            ? "text-gray-400"
                            : "bg-gray-400 text-white"
                        }`;
                        const blockStyle = {
                          top: top + 1,
                          height,
                          left: 2,
                          right: 2,
                          ...(isBlocked ? {
                            background: "repeating-linear-gradient(-45deg,#e5e7eb 0px,#e5e7eb 4px,#f9fafb 4px,#f9fafb 8px)",
                          } : {}),
                        };
                        const note = (res.notes ?? "").trim();
                        let blockLabel: string;
                        if (isBlocked) {
                          // Maintenance/admin blocks: check visibility before isOwn so an admin
                          // who created the block never sees "You" instead of the reason.
                          if (userRole === "admin" || userRole === "pro") {
                            blockLabel = note || "Blocked";
                          } else {
                            blockLabel = (res.show_notes_to_members && note) ? note : "Blocked";
                          }
                        } else if (isOwn) {
                          blockLabel = "You";
                        } else if (userRole === "admin" || userRole === "pro") {
                          blockLabel = ownerNames.get(res.owner_user_id) ?? "Member";
                        } else {
                          blockLabel = "";
                        }

                        return isClickable ? (
                          <button
                            key={res.id}
                            onClick={() => setSelectedReservation(res)}
                            className={blockCls}
                            style={blockStyle}
                          >
                            {blockLabel}
                          </button>
                        ) : (
                          <div
                            key={res.id}
                            className={blockCls}
                            style={blockStyle}
                          >
                            {blockLabel}
                          </div>
                        );
                      })}

                      {/* Event blocks — colored, tappable, span the full column */}
                      {(eventsByCourtId.get(court.id) ?? []).map(ev => {
                          const startMins = minsFromViewportTop(new Date(ev.starts_at), clubTimezone, startHour);
                          const endMins   = minsFromViewportTop(new Date(ev.ends_at),   clubTimezone, startHour);
                          const top       = (startMins / 30) * rowH;
                          const height    = Math.max(((endMins - startMins) / 30) * rowH - 2, rowH);
                          return (
                            <button
                              key={ev.id}
                              onClick={() => setSelectedEvent(ev)}
                              className="absolute rounded text-[10px] font-semibold px-1.5 overflow-hidden flex items-start pt-1 text-white"
                              style={{
                                top: top + 1,
                                height,
                                left: 2,
                                right: 2,
                                background: ev.event_types.color,
                                touchAction: "manipulation",
                              }}
                            >
                              {ev.title}
                            </button>
                          );
                        })
                      }
                    </div>
                  );
                })
              ) : (
                /* Placeholder column so grid rows still draw when all filtered out */
                <div
                  className="flex-1 border-l border-gray-200 dark:border-gray-700"
                  style={{ height: totalGridH }}
                />
              )}

            </div>
            {/* Loading / error indicator */}
            {loadingRes && (
              <div className="text-center py-2 text-xs text-gray-400">Loading…</div>
            )}
            {resError && !loadingRes && (
              <div className="text-center py-2 text-xs text-red-400">
                Failed to load reservations. Please refresh.
              </div>
            )}
          </div>
        </div>

        {/* ── FAB — pro/admin only, anchored to the calendar content area ─ */}
        {(userRole === "pro" || userRole === "admin") && (
          <div className="absolute bottom-4 right-4 z-30 flex flex-col items-end gap-2">
            {userRole === "admin" && (
              <button
                onClick={() => setCreatingBlock(true)}
                className="px-4 py-2 rounded-full bg-accent text-white dark:text-gray-900 text-sm font-semibold shadow-md hover:shadow-lg active:scale-[0.97] motion-safe:hover:-translate-y-0.5 motion-safe:transition-all motion-safe:duration-150"
              >
                + Block
              </button>
            )}
            <button
              onClick={() => setCreatingEvent(true)}
              className="px-4 py-2 rounded-full bg-accent text-white dark:text-gray-900 text-sm font-semibold shadow-md hover:shadow-lg active:scale-[0.97] motion-safe:hover:-translate-y-0.5 motion-safe:transition-all motion-safe:duration-150"
            >
              + Event
            </button>
          </div>
        )}
      </div>

      {/* ── Slot action menu — pro/admin only ───────────────────────────── */}
      {pendingSlotAction && (
        <>
          <div
            className="fixed inset-0 bg-black/30 z-40"
            onClick={() => setPendingSlotAction(null)}
          />
          <div className="ct-sheet-enter fixed bottom-0 left-0 right-0 bg-white dark:bg-gray-800 rounded-t-2xl z-50 px-6 pt-5 pb-8 shadow-xl">
            <div className="ct-handlebar mx-auto mb-4" />
            <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{pendingSlotAction.court.name}</p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 mb-5">
              {pendingSlotAction.slotStart.toLocaleTimeString("en-US", {
                timeZone: clubTimezone, hour: "numeric", minute: "2-digit", hour12: true,
              })}
            </p>
            <div className="space-y-2">
              <button
                onClick={openBookingFromSlot}
                className="w-full py-3 rounded-xl bg-accent text-white dark:text-gray-900 text-sm font-semibold hover:brightness-110 active:scale-[0.98] motion-safe:transition-all motion-safe:duration-150"
              >
                Book Court
              </button>
              <button
                onClick={openEventFromSlot}
                className="w-full py-3 rounded-xl border border-gray-200 dark:border-gray-600 text-gray-900 dark:text-gray-100 text-sm font-medium hover:border-accent hover:text-accent active:scale-[0.98] motion-safe:transition-all motion-safe:duration-150"
              >
                Create Event
              </button>
              {userRole === "admin" && (
                <button
                  onClick={openBlockFromSlot}
                  className="w-full py-3 rounded-xl border border-gray-200 dark:border-gray-600 text-gray-900 dark:text-gray-100 text-sm font-medium hover:border-accent hover:text-accent active:scale-[0.98] motion-safe:transition-all motion-safe:duration-150"
                >
                  Maintenance Block
                </button>
              )}
            </div>
          </div>
        </>
      )}

      {/* ── Create event sheet ───────────────────────────────────────────── */}
      {creatingEvent && (
        <CreateEventSheet
          courts={courts}
          clubId={clubId}
          clubTimezone={clubTimezone}
          onClose={() => { setCreatingEvent(false); setSlotPreFill(null); }}
          onCreated={() => { setRefreshTick(t => t + 1); setCreatingEvent(false); setSlotPreFill(null); }}
          initialDate={slotPreFill ? selectedDate : undefined}
          initialHour={slotPreFill ? Math.floor((startHour * 60 + slotPreFill.slotIdx * 30) / 60) : undefined}
          initialMinute={slotPreFill ? (startHour * 60 + slotPreFill.slotIdx * 30) % 60 : undefined}
          initialCourtId={slotPreFill?.court.id}
        />
      )}

      {/* ── Event detail sheet ───────────────────────────────────────────── */}
      {selectedEvent && (
        <EventDetailSheet
          event={selectedEvent}
          courts={courts}
          userId={userId}
          userRole={userRole}
          clubTimezone={clubTimezone}
          onClose={() => setSelectedEvent(null)}
          onRefresh={() => { setRefreshTick(t => t + 1); setSelectedEvent(null); }}
        />
      )}

      {/* ── Create maintenance sheet (admin only) ───────────────────────── */}
      {creatingBlock && (
        <CreateMaintenanceSheet
          courts={courts}
          clubTimezone={clubTimezone}
          selectedDate={selectedDate}
          onClose={() => { setCreatingBlock(false); setSlotPreFill(null); }}
          onCreated={() => { setRefreshTick(t => t + 1); setCreatingBlock(false); setSlotPreFill(null); }}
          defaultCourtId={slotPreFill?.court.id}
          defaultStartHour={slotPreFill ? Math.floor((startHour * 60 + slotPreFill.slotIdx * 30) / 60) : undefined}
          defaultStartMinute={slotPreFill ? (startHour * 60 + slotPreFill.slotIdx * 30) % 60 : undefined}
        />
      )}

      {/* ── Reservation detail sheet ─────────────────────────────────────── */}
      {selectedReservation && (
        <ReservationDetailSheet
          reservation={selectedReservation}
          courts={courts}
          clubTimezone={clubTimezone}
          onClose={() => setSelectedReservation(null)}
          onCancelled={() => { setRefreshTick(t => t + 1); setSelectedReservation(null); }}
          onMemberCancel={
            selectedReservation.owner_user_id === userId && userRole === "member"
              ? async () => cancelMemberReservation(selectedReservation.id)
              : undefined
          }
        />
      )}

      {/* ── Booking sheet ────────────────────────────────────────────────── */}
      {bookingSlot && (
        <>
          <div
            className="fixed inset-0 bg-black/30 z-40"
            onClick={() => { setBookingSlot(null); setBookingError(null); }}
          />
          <div className="ct-sheet-enter fixed bottom-0 left-0 right-0 bg-white dark:bg-gray-800 rounded-t-2xl z-50 px-6 pt-5 pb-8 shadow-xl">
            <div className="ct-handlebar mx-auto mb-4" />

            <p className="text-base font-semibold text-gray-900 dark:text-gray-100">{bookingSlot.court.name}</p>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{sheetDateLabel}</p>
            <p className="text-sm text-gray-700 dark:text-gray-300 mt-1 font-medium">
              {sheetStartLabel} – {sheetEndLabel}
            </p>

            <div className="flex items-center gap-3 mt-4">
              <span className="text-sm text-gray-600 dark:text-gray-400">Duration</span>
              {([30, 60, 90, 120] as const).map(d => (
                <button
                  key={d}
                  onClick={() => setBookingDuration(d)}
                  className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                    bookingDuration === d
                      ? "bg-accent text-white dark:text-gray-900"
                      : "bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300"
                  }`}
                >
                  {d} min
                </button>
              ))}
            </div>

            {bookingConflict && (
              <p className="mt-3 text-xs text-amber-600">
                Conflicts with an existing booking. Try a shorter duration or a different slot.
              </p>
            )}
            {bookingError && (
              <p className="mt-3 text-xs text-red-500">{bookingError}</p>
            )}

            <button
              disabled={bookingConflict || bookingLoading}
              onClick={handleConfirmBooking}
              className="mt-5 w-full py-3 rounded-xl bg-accent text-white dark:text-gray-900 text-sm font-semibold disabled:opacity-40"
            >
              {bookingLoading ? "Booking…" : "Confirm Booking"}
            </button>
          </div>
        </>
      )}
    </>
  );
}
