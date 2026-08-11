"use client";

import { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/db/types";
import EventDetailSheet from "./EventDetailSheet";
import CreateEventSheet from "./CreateEventSheet";
import ReservationDetailSheet from "./ReservationDetailSheet";
import CreateMaintenanceSheet from "./CreateMaintenanceSheet";
import CalendarFab from "./CalendarFab";
import { createReservation, adminCreateMemberReservation, cancelMemberReservation } from "./actions";
import ResponsiveSheet from "@/components/ResponsiveSheet";
import { getZonedDayBoundsUTC } from "@/lib/timezone";
import { STALE_CLUB_CONTEXT_ERROR, STALE_CLUB_MESSAGE } from "@/lib/staleClub";

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

// Phase 33C2: one roster identity option for the admin "book for a Member"
// picker — every club Member, whether or not they have an authenticated
// account. Sourced directly from roster_members (admin-only RLS, same-club
// only — see fetchRosterMembers), never from a separate profiles query, so
// there is exactly one identity space to pick from, matching admin_create_
// member_reservation's single p_roster_member_id parameter.
interface RosterMemberOption {
  id:      string;
  name:    string;
  claimed: boolean;
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
  member_joinable: boolean;
  event_type_id: string;
  description: string | null;
  updated_at: string;
  program_id: string | null;
  is_program_exception: boolean;
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
  member_joinable: boolean;
  event_type_id: string;
  description: string | null;
  updated_at: string;
  program_id: string | null;
  is_program_exception: boolean;
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
  // Phase 33C3: the signed-in user's own durable Member identity for this
  // club, if claimed — resolved server-side (0110's current_user_roster_
  // member_id()), never derived client-side from owner_user_id. Null for
  // an account with no claimed roster identity in this club (should not
  // happen in practice after 33B1's backfill, but handled defensively).
  userRosterMemberId:      string | null;
  clubId:                  string;
  clubTimezone:            string;
  userRole:                string;
  todayISO:                string; // YYYY-MM-DD in club timezone, computed server-side
  initialDateISO?:         string | null; // optional ?date= override from URL
  operatingHours:          OperatingHoursRow[];
  operatingHoursOverrides: OperatingHoursOverrideRow[]; // Phase 17C
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
  if (message === STALE_CLUB_CONTEXT_ERROR) return STALE_CLUB_MESSAGE;
  if (code === "23P01")                    return "That slot was just taken — please choose another time.";
  if (message === "outside_booking_window") return "That date is outside the booking window.";
  if (message === "cannot_book_past")       return "You cannot book in the past.";
  if (message === "outside_operating_hours") return "That time is outside operating hours.";
  if (message === "club_closed_this_day")   return "The club is closed on that day.";
  if (message === "invalid_duration")       return "Reservations must be 30, 60, 90, or 120 minutes.";
  return "Something went wrong. Please try again.";
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function CalendarShell({ courts, hasError, userId, userRosterMemberId, clubId, clubTimezone, userRole, todayISO, initialDateISO, operatingHours, operatingHoursOverrides }: Props) {
  const supabase = useMemo(() => createClient(), []);
  const router   = useRouter();

  // ── State ──────────────────────────────────────────────────────────────────
  // Initialize from the server-supplied date string (UTC noon = same calendar date in any timezone).
  const [selectedDate, setSelectedDate]         = useState<Date>(() => {
    const seed = (initialDateISO && /^\d{4}-\d{2}-\d{2}$/.test(initialDateISO))
      ? initialDateISO
      : todayISO;
    return new Date(seed + "T12:00:00Z");
  });
  const [reservations, setReservations]         = useState<Reservation[]>([]);
  const [loadingRes, setLoadingRes]             = useState(false);
  const [refreshTick, setRefreshTick]           = useState(0);
  const [selectedCourtIds, setSelectedCourtIds] = useState<Set<string>>(
    () => new Set(courts.map(c => c.id))
  );

  // selectedCourtIds is otherwise only set on mount and by explicit user
  // interaction (toggleCourt / Select All), so it goes stale when clubId or
  // courts changes on an already-mounted CalendarShell (e.g. switching the
  // active club) — the old IDs then match nothing in the new courts list
  // and the grid renders empty until the user manually reselects.
  // Reconcile whenever clubId or courts changes; user-driven toggles never
  // touch these props, so this never overrides a deliberate in-club
  // selection (including a deliberate "Deselect all").
  const isMountedRef  = useRef(false);
  const prevClubIdRef = useRef(clubId);
  useEffect(() => {
    if (!isMountedRef.current) {
      isMountedRef.current = true;
      return;
    }
    const clubChanged = prevClubIdRef.current !== clubId;
    prevClubIdRef.current = clubId;

    setSelectedCourtIds(prev => {
      const validIds = new Set(courts.map(c => c.id));
      // Club switch — never retain the prior club's selection, regardless
      // of whether any of its IDs happen to still be present in validIds.
      if (clubChanged) return validIds;
      // Same club, nothing selected — a deliberate "Deselect all", not
      // stale state to reconcile.
      if (prev.size === 0) return prev;
      const reconciled = new Set([...prev].filter(id => validIds.has(id)));
      // Every previously selected court is gone (the list was replaced) —
      // fall back to all currently available courts rather than showing none.
      return reconciled.size > 0 ? reconciled : validIds;
    });
  }, [clubId, courts]);
  const [resError, setResError]           = useState(false);
  const [bookingSlot, setBookingSlot]     = useState<BookingSlot | null>(null);
  const [bookingDuration, setBookingDuration] = useState<30 | 60 | 90 | 120>(60);
  const [bookingError, setBookingError]   = useState<string | null>(null);
  const [bookingLoading, setBookingLoading] = useState(false);
  // Phase 33C2: admin-only "book for a Member" state. isAdmin gates every
  // one of these both in the picker/fields' rendering below AND in
  // handleConfirmBooking's branch — a normal member never sees this state
  // populated and createReservation's call shape below is byte-for-byte
  // unchanged from before this checkpoint.
  const isAdmin = userRole === "admin";
  const [rosterMembers, setRosterMembers]             = useState<RosterMemberOption[]>([]);
  const [rosterLoading, setRosterLoading]             = useState(false);
  const [rosterSearch, setRosterSearch]                 = useState("");
  const [selectedRosterMemberId, setSelectedRosterMemberId] = useState<string | null>(null);
  const [bookingFormat, setBookingFormat]             = useState<"singles" | "doubles" | null>(null);
  const [bookingPlayerCount, setBookingPlayerCount]     = useState("");
  const [bookingGuestNames, setBookingGuestNames]       = useState("");
  const [bookingNotes, setBookingNotes]                 = useState("");
  // nowMs is 0 during SSR so all slots render as available (no past-slot check).
  // After hydration, useEffect sets the real timestamp, past slots disable without mismatch.
  const [nowMs, setNowMs]                 = useState(0);
  const [events, setEvents]               = useState<EventWithDetails[]>([]);

  // ── Responsive column width / row height ──────────────────────────────────
  // Starts at MIN_colW / MIN_ROW_H for consistent SSR/hydration.
  // The useLayoutEffect below (placed after filteredCourts) updates these via
  // a ResizeObserver once the grid container is mounted.
  const gridContainerRef                  = useRef<HTMLDivElement>(null);
  const dateInputRef                      = useRef<HTMLInputElement>(null);
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
  // Re-centered on selectedDate: shows 6 days before and 6 after (13 total).
  // selectedDate is stored as UTC noon so its YYYY-MM-DD ISO slice is the
  // correct calendar date regardless of timezone.
  const datePills = useMemo(() => {
    const [sy, sm, sd] = selectedDate.toISOString().slice(0, 10).split("-").map(Number);
    return Array.from({ length: 13 }, (_, i) => {
      const offset = i - 6; // -6 … +6
      const dt = new Date(Date.UTC(sy, sm - 1, sd + offset, 12, 0, 0));
      return {
        dateISO: dt.toISOString().slice(0, 10),
        day:     DAY_NAMES[dt.getUTCDay()],
        dateNum: dt.getUTCDate(),
      };
    });
  }, [selectedDate]);

  // ── Selected date as YYYY-MM-DD in club timezone (used by date strip and picker) ──
  const selectedISO = useMemo(
    () => selectedDate.toLocaleDateString("en-CA", { timeZone: clubTimezone }),
    [selectedDate, clubTimezone]
  );

  // Human-readable label for the navigation bar, e.g. "Wed, Jul 9"
  const formattedNavDate = useMemo(
    () => selectedDate.toLocaleDateString("en-US", {
      timeZone: clubTimezone, weekday: "short", month: "short", day: "numeric",
    }),
    [selectedDate, clubTimezone]
  );

  // Shift selectedDate by N days (prev/next buttons)
  function shiftDate(offset: number) {
    const [sy, sm, sd] = selectedDate.toISOString().slice(0, 10).split("-").map(Number);
    setSelectedDate(new Date(Date.UTC(sy, sm - 1, sd + offset, 12, 0, 0)));
  }

  // ── Derived values ────────────────────────────────────────────────────────
  const dayBounds = useMemo(
    () => getZonedDayBoundsUTC(selectedDate, clubTimezone),
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

  // Phase 29B2 (corrected in source review): horizontal-scroll stabilization.
  // compute() runs both on mount and on every ResizeObserver firing
  // (container resize, mobile Safari address-bar collapse/expand changing
  // --page-fill-height, etc.), which can change colW incidentally without
  // the user having asked to scroll anywhere. We must not let an incidental
  // colW recompute silently move the user's existing horizontal scroll
  // position — but we also must not confuse "same court count" with "same
  // context": two different clubs/dates can happen to have the same number
  // of visible courts, and a naive court-count comparison would wrongly
  // treat that as an incidental resize instead of a genuine reset.
  //
  // calendarContextKey below is the explicit, single source of truth for
  // "is this genuinely a different calendar view": club + club-local date +
  // the ordered list of currently visible court IDs (which already fully
  // captures the court-filter selection — selectedCourtIds only affects
  // scroll positioning through which IDs end up in filteredCourts, so there
  // is nothing further to fold in). Changing the date is deliberately folded
  // into the same key as club/court-filter changes — any change to any of
  // the three inputs is treated identically, as one explicit reset rule,
  // rather than inferring a date-change reset from a court-count side effect.
  //
  // Refs (not state — this is derived/incidental bookkeeping, not UI state):
  //   - hasComputedOnceRef: false only for the very first compute() (mount) —
  //     nothing to preserve yet, so it's skipped entirely.
  //   - prevContextKeyRef: when calendarContextKey changes, the old scroll
  //     ratio has no meaningful correspondence to the new view, so we clear
  //     any pending ratio correction and explicitly reset scrollLeft to 0.
  //   - prevColWRef + pendingScrollRatioRef: when colW changes incidentally
  //     within the *same* context (e.g. a container resize), we capture the
  //     scroll position as a ratio of the old column width, then re-apply it
  //     against the new column width once the new width has actually been
  //     committed to the DOM (via the colW-keyed layout effect below) — so
  //     the visible court stays visible instead of the browser clamping
  //     scrollLeft against the resized content width. Sheets opening/closing
  //     never touch club/date/court-filter state, so they can only ever fall
  //     into this incidental-resize branch (if they affect layout at all),
  //     never the reset branch.
  const calendarContextKey = `${clubId}|${selectedISO}|${filteredCourts.map(c => c.id).join(",")}`;

  const hasComputedOnceRef    = useRef(false);
  const prevContextKeyRef     = useRef<string | null>(null);
  const prevColWRef           = useRef<number | null>(null);
  const pendingScrollRatioRef = useRef<number | null>(null);

  // Placed after filteredCourts/timeSlots to avoid the forward-reference TS error.
  useLayoutEffect(() => {
    const el = gridContainerRef.current;
    if (!el) return;
    const compute = () => {
      const available = el.clientWidth - GUTTER_W;
      const count     = Math.max(filteredCourts.length, 1);
      const newColW   = Math.min(Math.max(Math.floor(available / count), MIN_colW), MAX_colW);

      if (!hasComputedOnceRef.current) {
        // First-ever layout: nothing to preserve, natural scrollLeft (0) is correct.
        hasComputedOnceRef.current = true;
      } else if (calendarContextKey !== prevContextKeyRef.current) {
        // Genuine context reset (club, date, or visible court set changed) —
        // explicit, intentional reset, exactly once per context change.
        pendingScrollRatioRef.current = null;
        el.scrollLeft = 0;
      } else if (newColW !== prevColWRef.current) {
        // Incidental colW change within the same context — preserve the
        // visible position as a ratio, applied once the new width is
        // actually painted.
        const prevColW = prevColWRef.current || newColW;
        pendingScrollRatioRef.current = el.scrollLeft / prevColW;
      }
      prevContextKeyRef.current = calendarContextKey;
      prevColWRef.current = newColW;

      setColW(newColW);
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
  }, [calendarContextKey, timeSlots.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Applies a pending scroll-ratio correction (set above) only after colW has
  // actually been committed to the DOM, so it reads/writes against the real
  // new column widths rather than the stale pre-render ones. No-op otherwise.
  useLayoutEffect(() => {
    const el = gridContainerRef.current;
    if (!el || pendingScrollRatioRef.current === null) return;
    el.scrollLeft = pendingScrollRatioRef.current * colW;
    pendingScrollRatioRef.current = null;
  }, [colW]);

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

  // ── Phase 33C2: admin roster-member picker ────────────────────────────────
  // roster_members has admin-only, same-club RLS (roster_members_select_
  // admin, 0056) — this select is scoped by that policy alone, so it is
  // structurally impossible for it to return another club's roster or to
  // succeed at all for a non-admin caller, independent of the isAdmin gate
  // below (which only controls whether the UI ever calls this).
  const fetchRosterMembers = useCallback(async () => {
    setRosterLoading(true);
    const { data } = await supabase
      .from("roster_members")
      .select("id, first_name, last_name, claimed_by")
      .eq("club_id", clubId)
      .order("last_name", { ascending: true })
      .order("first_name", { ascending: true });
    setRosterMembers(
      (data ?? []).map(r => ({
        id:      r.id,
        name:    [r.first_name, r.last_name].filter(Boolean).join(" ") || "Unknown",
        claimed: r.claimed_by !== null,
      }))
    );
    setRosterLoading(false);
  }, [supabase, clubId]);

  // Fresh fetch + reset every time a NEW slot is opened for booking (admin
  // only) — bookingSlot is a new object reference on every slot click, so
  // this never re-fires for the same open sheet, and always starts a new
  // booking attempt with a clean Member selection and empty optional fields.
  useEffect(() => {
    if (bookingSlot && isAdmin) {
      fetchRosterMembers();
      setSelectedRosterMemberId(null);
      setRosterSearch("");
      setBookingFormat(null);
      setBookingPlayerCount("");
      setBookingGuestNames("");
      setBookingNotes("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookingSlot, isAdmin]);

  const filteredRosterMembers = useMemo(() => {
    const q = rosterSearch.trim().toLowerCase();
    if (!q) return rosterMembers;
    return rosterMembers.filter(m => m.name.toLowerCase().includes(q));
  }, [rosterMembers, rosterSearch]);

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
      .lt("starts_at",  dayBounds.nextDayStart)
      .in("status", ["pending", "confirmed"])
      .order("starts_at");
    if (error) {
      setResError(true);
    } else {
      const rows = data ?? [];

      // Phase 33C2 completion — flicker fix: resolve owner display names
      // BEFORE swapping in the new reservation list, not after. Previously
      // setReservations(rows) ran first, so a newly visible block rendered
      // immediately with the generic "Member" fallback (see the blockLabel
      // lookup below), then a SECOND render moments later replaced it with
      // the real name once this profiles fetch resolved — a visible
      // two-stage flicker on every new/changed booking for admin/pro
      // viewers (no-account bookings were unaffected — they never had an
      // entry in ownerNames to begin with). Reordering so both pieces of
      // state are ready before reservations updates means the grid goes
      // straight from the OLD fully-resolved state to the NEW
      // fully-resolved state in one visible step — the existing list stays
      // on screen unchanged throughout the fetch, exactly as it already
      // did while loadingRes was true, just now also through this second
      // lookup.
      //
      // For admin/pro: fetch display names for other members' court reservations.
      // RLS (profiles_select_same_club) already limits results to the same club.
      if (userRole === "admin" || userRole === "pro") {
        // Phase 33C2: owner_user_id is null for a staff-created no-account-
        // Member booking — excluded here (nothing to look up in profiles),
        // not just filtered by userId/reason as before this checkpoint.
        const otherIds = [...new Set(
          rows
            .filter((r): r is typeof r & { owner_user_id: string } =>
              r.owner_user_id !== null && r.owner_user_id !== userId && r.reason === "member_booking")
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

      setReservations(rows);
    }
    setLoadingRes(false);
  }, [supabase, clubId, dayBounds, refreshTick]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Event fetch ───────────────────────────────────────────────────────────
  const fetchEvents = useCallback(async () => {
    if (!clubId) return;
    const { data, error } = await supabase
      .from("events")
      .select(`
        id, title, starts_at, ends_at, capacity, status, created_by, member_joinable,
        event_type_id, description, updated_at, program_id, is_program_exception,
        event_types(key, label, color, shows_participant_names),
        event_participants(profile_id, role, status, offer_expires_at),
        event_guests(id),
        reservations(court_id, status, reason)
      `)
      .eq("club_id", clubId)
      .gte("starts_at", dayBounds.start)
      .lt("starts_at",  dayBounds.nextDayStart)
      .eq("status", "scheduled")
      .is("archived_at", null)
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
          member_joinable:    r.member_joinable,
          event_type_id:      r.event_type_id,
          description:        r.description,
          updated_at:         r.updated_at,
          program_id:         r.program_id,
          is_program_exception: r.is_program_exception,
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

  // Phase 30G: resolves a pro_lesson reservation's exact linked lesson
  // request (never inferred from notes/names/owner alone — only the
  // reservations.id = lesson_requests.linked_reservation_id join, scoped
  // to this club) and navigates into the existing lesson-management
  // surface. Eligible statuses only — 'confirmed', or a pending-reschedule
  // 'proposed' (which this join can only ever match via a non-null
  // linked_reservation_id, so a first-time proposal can never be reached
  // here). Client-side clickability already restricts who can trigger
  // this; the destination page independently re-derives authorization
  // from its own RPC-scoped request list, not from this navigation alone.
  async function handleManageLesson(reservationId: string) {
    const { data } = await supabase
      .from("lesson_requests")
      .select("id")
      .eq("linked_reservation_id", reservationId)
      .eq("club_id", clubId)
      .in("status", ["confirmed", "proposed"])
      .maybeSingle();

    if (data?.id) {
      router.push(`/events?tab=lessons&lessonId=${data.id}`);
    }
  }

  function openBookingFromSlot() {
    if (!pendingSlotAction) return;
    setBookingSlot({ court: pendingSlotAction.court, slotStart: pendingSlotAction.slotStart, slotIdx: pendingSlotAction.slotIdx });
    setBookingDuration(60);
    setBookingError(null);
    // Keep pendingSlotAction so Back button can return to the slot menu.
  }

  function openEventFromSlot() {
    if (!pendingSlotAction) return;
    setSlotPreFill(pendingSlotAction);
    setCreatingEvent(true);
    // Keep pendingSlotAction so Back button can return to the slot menu.
  }

  function openBlockFromSlot() {
    if (!pendingSlotAction) return;
    setSlotPreFill(pendingSlotAction);
    setCreatingBlock(true);
    // Keep pendingSlotAction so Back button can return to the slot menu.
  }

  function backToSlotMenu() {
    setBookingSlot(null);
    setBookingError(null);
    setCreatingEvent(false);
    setCreatingBlock(false);
    setSlotPreFill(null);
    // pendingSlotAction stays set — the slot menu reappears.
  }

  function closeSlotFlow() {
    setBookingSlot(null);
    setBookingError(null);
    setCreatingEvent(false);
    setCreatingBlock(false);
    setSlotPreFill(null);
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

    // Phase 33C2: admin must pick a Member before confirming. A normal
    // member never reaches this branch — isAdmin is derived from the
    // server-supplied userRole prop, and the picker UI itself only renders
    // for isAdmin, so this can only trigger for an admin who has not yet
    // made a selection.
    if (isAdmin && !selectedRosterMemberId) {
      setBookingError("Select the Member this reservation is for.");
      return;
    }

    setBookingLoading(true);
    setBookingError(null);

    const endsAt = new Date(bookingSlot.slotStart.getTime() + bookingDuration * 60_000);

    // Member self-service path is byte-for-byte unchanged from before this
    // checkpoint: same four params, same createReservation call, no new
    // fields. Only the admin path (isAdmin === true) gains the Member
    // picker and optional format/player-count/guest-names/notes fields.
    const { error } = isAdmin
      ? await adminCreateMemberReservation({
          p_court_id:         bookingSlot.court.id,
          p_starts_at:        bookingSlot.slotStart.toISOString(),
          p_ends_at:          endsAt.toISOString(),
          p_roster_member_id: selectedRosterMemberId!,
          p_format:           bookingFormat,
          p_player_count:     bookingPlayerCount.trim() ? Number(bookingPlayerCount.trim()) : null,
          p_guest_names:      bookingGuestNames.trim()
            ? bookingGuestNames.split(",").map(s => s.trim()).filter(Boolean)
            : null,
          p_notes:            bookingNotes.trim() || null,
          expectedClubId:     clubId,
        })
      : await createReservation({
          p_court_id:  bookingSlot.court.id,
          p_starts_at: bookingSlot.slotStart.toISOString(),
          p_ends_at:   endsAt.toISOString(),
          expectedClubId: clubId,
        });

    if (error) {
      setBookingError(rpcErrorMessage(error.code, error.message));
      setBookingLoading(false);
      return;
    }

    setBookingSlot(null);
    setBookingDuration(60);
    setSelectedRosterMemberId(null);
    setRosterSearch("");
    setBookingFormat(null);
    setBookingPlayerCount("");
    setBookingGuestNames("");
    setBookingNotes("");
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

        {/* ── Date navigation bar ───────────────────────────────────────── */}
        {/* prev | date label button (programmatically opens date picker) | next | Today */}
        <div className="flex items-center gap-1.5 px-3 py-2 border-b border-gray-100 dark:border-gray-800 shrink-0">

          {/* Prev day */}
          <button
            onClick={() => shiftDate(-1)}
            aria-label="Previous day"
            className="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100 motion-safe:transition-colors motion-safe:duration-100 text-base"
          >
            ‹
          </button>

          {/* Coarse-pointer (touch): overlay input — tap lands directly on the
              native <input> so iOS Safari opens the picker without a JS
              intermediary. Hidden on fine-pointer (mouse/trackpad) devices. */}
          <div className="[@media(pointer:fine)]:hidden relative flex-1 min-w-0 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg has-[input:hover]:bg-gray-100 dark:has-[input:hover]:bg-gray-800 motion-safe:transition-colors motion-safe:duration-100">
            <span className="pointer-events-none text-sm font-semibold text-gray-900 dark:text-gray-100 truncate select-none">
              {formattedNavDate}
            </span>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="pointer-events-none shrink-0 text-gray-400 dark:text-gray-500">
              <rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
            </svg>
            <input
              type="date"
              value={selectedISO}
              onChange={e => {
                if (e.target.value) setSelectedDate(new Date(e.target.value + "T12:00:00Z"));
              }}
              aria-label="Jump to date"
              className="absolute inset-0 opacity-0 cursor-pointer text-base"
            />
          </div>

          {/* Fine-pointer (mouse/trackpad): visible button calls showPicker().
              Active at any viewport width when a fine pointer is present —
              including desktop responsive/narrow mode. */}
          <div className="relative hidden [@media(pointer:fine)]:flex flex-1 min-w-0">
            <button
              onClick={() => {
                try { dateInputRef.current?.showPicker(); }
                catch { dateInputRef.current?.click(); }
              }}
              aria-label="Jump to date"
              className="flex flex-1 min-w-0 items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 motion-safe:transition-colors motion-safe:duration-100"
            >
              <span className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate select-none">
                {formattedNavDate}
              </span>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-gray-400 dark:text-gray-500">
                <rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
              </svg>
            </button>
            {/* Not display:none — showPicker() requires a non-hidden input.
                Positioned at horizontal center so the picker opens below the label. */}
            <input
              ref={dateInputRef}
              type="date"
              value={selectedISO}
              onChange={e => {
                if (e.target.value) setSelectedDate(new Date(e.target.value + "T12:00:00Z"));
              }}
              aria-hidden="true"
              tabIndex={-1}
              className="absolute top-0 left-1/2 w-0 h-0 opacity-0 pointer-events-none overflow-hidden border-0 p-0"
            />
          </div>

          {/* Next day */}
          <button
            onClick={() => shiftDate(1)}
            aria-label="Next day"
            className="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100 motion-safe:transition-colors motion-safe:duration-100 text-base"
          >
            ›
          </button>

          {/* Today — only when not viewing today */}
          {selectedISO !== todayISO && (
            <button
              onClick={() => setSelectedDate(new Date(todayISO + "T12:00:00Z"))}
              className="shrink-0 text-xs font-medium text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-200 px-2.5 py-1.5 rounded-lg hover:bg-blue-50 dark:hover:bg-blue-900/20 motion-safe:transition-colors motion-safe:duration-100 whitespace-nowrap"
            >
              Today
            </button>
          )}
        </div>

        {/* ── Date column rail — desktop only, stretches full width ──────── */}
        {/* Hidden on mobile. On desktop: 13 equal-width columns; selected date shown
            as a circular accent badge to avoid a heavy square fill across the column. */}
        <div className="hidden md:flex border-b border-gray-100 dark:border-gray-800 shrink-0">
          {datePills.map((pill) => {
            const isSelected = pill.dateISO === selectedISO;
            const isToday    = pill.dateISO === todayISO;
            return (
              <button
                key={pill.dateISO}
                onClick={() => setSelectedDate(new Date(pill.dateISO + "T12:00:00Z"))}
                className={`flex-1 min-w-0 flex flex-col items-center justify-center py-1.5 text-xs leading-tight motion-safe:transition-colors motion-safe:duration-100 ${
                  isSelected
                    ? "text-accent dark:text-accent"
                    : isToday
                    ? "text-blue-600 dark:text-blue-400 font-medium hover:bg-blue-50 dark:hover:bg-blue-900/20"
                    : "text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800/60"
                }`}
              >
                <span className="mb-0.5">{pill.day}</span>
                {/* Circular badge for selected; plain number otherwise */}
                {isSelected ? (
                  <span className="w-6 h-6 flex items-center justify-center rounded-full bg-accent text-white dark:text-gray-900 font-semibold text-[11px]">
                    {pill.dateNum}
                  </span>
                ) : (
                  <span className={`font-medium ${isToday ? "" : ""}`}>{pill.dateNum}</span>
                )}
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

        {/* ── Calendar legend ───────────────────────────────────────────── */}
        <div className="flex items-center gap-4 px-4 py-1.5 border-b border-gray-100 dark:border-gray-800 shrink-0 overflow-x-auto hide-scrollbar">
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="inline-block w-3 h-3 rounded-sm border-2 border-blue-500 bg-blue-50 dark:bg-blue-900/30" />
            <span className="text-[10px] text-gray-500 dark:text-gray-400">Your booking</span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="inline-block w-3 h-3 rounded-sm border border-violet-300 bg-violet-50 dark:bg-violet-950/40 dark:border-violet-700" />
            <span className="text-[10px] text-gray-500 dark:text-gray-400">Private lesson</span>
          </div>
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
                        // Phase 33C3: also recognize a claimed Member's own
                        // pre-claim, staff-created reservation (owner_user_id
                        // null, roster_member_id set to their own identity).
                        // roster_member_id is only ever populated for
                        // reason='member_booking' rows (0108's identity
                        // guard trigger) — pro_lesson/maintenance blocks
                        // always have it null, so this fallback is inert for
                        // them and cannot change lesson-privacy or admin-
                        // block behavior below.
                        const isOwn     = res.owner_user_id === userId ||
                          (userRosterMemberId !== null && res.roster_member_id === userRosterMemberId);
                        const isLesson  = res.reason === "pro_lesson";
                        const isBlocked = !isLesson && res.reason !== "member_booking";
                        const isAdmin   = userRole === "admin";
                        const blockPos  = { top: top + 1, height, left: 2, right: 2 };

                        // Lesson blocks are managed via /lessons or /events, not the calendar —
                        // except that, for an eligible viewer, clicking navigates into that
                        // existing surface (Phase 30G) rather than opening any in-calendar form.
                        // Render with the same event-card structure: items-start pt-1 px-1.5 font-semibold.
                        // Privacy: the pro who owns the reservation (isOwn) or an admin may see the
                        // note ("Pro lesson with [member name]"). All other viewers see "Private Lesson".
                        if (isLesson) {
                          const note = (res.notes ?? "").trim();
                          const lessonLabel = (isOwn || isAdmin) ? (note || "Private Lesson") : "Private Lesson";
                          // Admin (any), or the assigned Pro (owner) only — never another Pro,
                          // never a Member. Matches only a future, still-confirmed reservation;
                          // the destination page independently re-derives this from its own
                          // RPC-scoped data, this is a UX-only pre-filter.
                          const canManageLesson =
                            (isAdmin || (userRole === "pro" && isOwn)) &&
                            res.status === "confirmed" &&
                            new Date(res.starts_at) > new Date();
                          return (
                            <div
                              key={res.id}
                              role={canManageLesson ? "button" : undefined}
                              tabIndex={canManageLesson ? 0 : undefined}
                              onClick={canManageLesson ? () => handleManageLesson(res.id) : undefined}
                              onKeyDown={canManageLesson ? (e) => {
                                if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleManageLesson(res.id); }
                              } : undefined}
                              className={`absolute rounded text-[10px] font-semibold px-1.5 overflow-hidden flex items-start pt-1 bg-violet-50 border border-violet-300 text-violet-800 dark:bg-violet-950/40 dark:border-violet-700 dark:text-violet-200 ${
                                canManageLesson ? "cursor-pointer" : "pointer-events-none"
                              }`}
                              style={blockPos}
                            >
                              {lessonLabel}
                            </div>
                          );
                        }

                        const isClickable = isAdmin || (isOwn && !isBlocked);
                        const blockCls = `absolute rounded text-[10px] font-medium px-1 overflow-hidden flex items-center ${
                          isClickable ? "cursor-pointer" : "pointer-events-none"
                        } ${
                          isOwn
                            ? "border-2 border-blue-500 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300"
                            : isBlocked
                            ? "text-gray-400"
                            : "bg-gray-400 text-white"
                        }`;
                        const blockStyle = {
                          ...blockPos,
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
                          // Phase 33C2: owner_user_id is null for a
                          // staff-created no-account-Member booking — falls
                          // through to the generic "Member" label below,
                          // same as any other lookup miss.
                          blockLabel = (res.owner_user_id ? ownerNames.get(res.owner_user_id) : undefined) ?? "Member";
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
          <CalendarFab
            userRole={userRole}
            onCreateEvent={() => setCreatingEvent(true)}
            onCreateBlock={() => setCreatingBlock(true)}
          />
        )}
      </div>

      {/* ── Slot action menu — hidden when sub-form is active ──────────── */}
      {pendingSlotAction && !bookingSlot && !creatingEvent && !creatingBlock && (
        <ResponsiveSheet
          onClose={closeSlotFlow}
          variant="modal"
          mobileInteraction="draggable"
          label={pendingSlotAction.court.name}
          header={
            <>
              <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{pendingSlotAction.court.name}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                {pendingSlotAction.slotStart.toLocaleTimeString("en-US", {
                  timeZone: clubTimezone, hour: "numeric", minute: "2-digit", hour12: true,
                })}
              </p>
            </>
          }
        >
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
        </ResponsiveSheet>
      )}

      {/* ── Create event sheet ───────────────────────────────────────────── */}
      {creatingEvent && (
        <CreateEventSheet
          courts={courts}
          clubId={clubId}
          clubTimezone={clubTimezone}
          onClose={closeSlotFlow}
          onCreated={() => { setRefreshTick(t => t + 1); closeSlotFlow(); }}
          onBack={slotPreFill ? backToSlotMenu : undefined}
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
          clubId={clubId}
          onClose={() => setSelectedEvent(null)}
          onRefresh={() => { setRefreshTick(t => t + 1); setSelectedEvent(null); }}
        />
      )}

      {/* ── Create maintenance sheet (admin only) ───────────────────────── */}
      {creatingBlock && (
        <CreateMaintenanceSheet
          courts={courts}
          clubId={clubId}
          clubTimezone={clubTimezone}
          selectedDate={selectedDate}
          onClose={closeSlotFlow}
          onCreated={() => { setRefreshTick(t => t + 1); closeSlotFlow(); }}
          onBack={slotPreFill ? backToSlotMenu : undefined}
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
          clubId={clubId}
          // Phase 30D correction: explicit Admin-role authorization for
          // Edit Block/Edit eligibility — never inferred from whether
          // onMemberCancel happens to be supplied below.
          isAdmin={userRole === "admin"}
          onClose={() => setSelectedReservation(null)}
          onCancelled={() => { setRefreshTick(t => t + 1); setSelectedReservation(null); }}
          onUpdated={() => { setRefreshTick(t => t + 1); setSelectedReservation(null); }}
          onMemberCancel={
            // Phase 30B1: widened from member-only to include Pro — a Pro
            // may already self-cancel their own member_booking reservation
            // via /my-schedule and via the underlying RPC/RLS; this closes
            // the previous /calendar-only UI gap rather than leaving it
            // inconsistent with /my-schedule.
            // Phase 33C3: widened to also recognize a claimed Member's own
            // pre-claim, staff-created reservation via roster_member_id —
            // see the matching isOwn comment above. cancel_member_
            // reservation (0110) independently re-derives and enforces this
            // same ownership match server-side; this is a UI-eligibility
            // mirror, not the authorization boundary itself.
            (selectedReservation.owner_user_id === userId ||
              (userRosterMemberId !== null && selectedReservation.roster_member_id === userRosterMemberId)) &&
            (userRole === "member" || userRole === "pro")
              ? async () => cancelMemberReservation(selectedReservation.id, clubId)
              : undefined
          }
        />
      )}

      {/* ── Booking sheet ────────────────────────────────────────────────── */}
      {bookingSlot && (
        <ResponsiveSheet
          onClose={closeSlotFlow}
          variant="modal"
          mobileInteraction="draggable"
          label={bookingSlot.court.name}
          header={
            <div className="flex items-center gap-3">
              {pendingSlotAction && (
                <button
                  onClick={backToSlotMenu}
                  className="text-sm text-gray-500 dark:text-gray-400 hover:text-accent motion-safe:transition-colors motion-safe:duration-150"
                >
                  ← Back
                </button>
              )}
              <p className="text-base font-semibold text-gray-900 dark:text-gray-100">{bookingSlot.court.name}</p>
            </div>
          }
        >
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{sheetDateLabel}</p>
            <p className="text-sm text-gray-700 dark:text-gray-300 mt-1 font-medium">
              {sheetStartLabel} – {sheetEndLabel}
            </p>

            {/* Phase 33C2: admin-only Member picker. A normal member never
                sees this — the self-service flow below is unaffected. */}
            {isAdmin && (
              <div className="mt-4">
                <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                  Member
                </label>
                <input
                  type="text"
                  value={rosterSearch}
                  onChange={e => setRosterSearch(e.target.value)}
                  placeholder="Search members…"
                  className="mt-1.5 w-full rounded-xl border border-gray-200 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-700 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-accent"
                />
                <div className="mt-2 max-h-48 overflow-y-auto rounded-xl border border-gray-200 dark:border-gray-600 divide-y divide-gray-100 dark:divide-gray-700">
                  {rosterLoading ? (
                    <p className="px-3 py-2 text-xs text-gray-400 dark:text-gray-500">Loading members…</p>
                  ) : filteredRosterMembers.length === 0 ? (
                    <p className="px-3 py-2 text-xs text-gray-400 dark:text-gray-500">No members found.</p>
                  ) : (
                    filteredRosterMembers.map(m => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => setSelectedRosterMemberId(m.id)}
                        className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-sm motion-safe:transition-colors motion-safe:duration-150 ${
                          selectedRosterMemberId === m.id
                            ? "bg-accent/10 text-accent"
                            : "text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/40"
                        }`}
                      >
                        <span className="truncate">{m.name}</span>
                        {!m.claimed && (
                          <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400">
                            No account yet
                          </span>
                        )}
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}

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

            {/* Phase 33C2: admin-only optional fields, matching the existing
                RPC parameters that create_reservation/admin_create_member_
                reservation already both accept — not previously exposed in
                either UI. Self-service booking gains none of these. */}
            {isAdmin && (
              <div className="mt-4 space-y-3">
                <div>
                  <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                    Format <span className="normal-case text-gray-400 dark:text-gray-500">(optional)</span>
                  </label>
                  <div className="mt-1.5 flex gap-2">
                    {(["singles", "doubles"] as const).map(f => (
                      <button
                        key={f}
                        type="button"
                        onClick={() => setBookingFormat(prev => (prev === f ? null : f))}
                        className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                          bookingFormat === f
                            ? "bg-accent text-white dark:text-gray-900"
                            : "bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300"
                        }`}
                      >
                        {f === "singles" ? "Singles" : "Doubles"}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                    Player count <span className="normal-case text-gray-400 dark:text-gray-500">(optional)</span>
                  </label>
                  <input
                    type="number"
                    min={1}
                    value={bookingPlayerCount}
                    onChange={e => setBookingPlayerCount(e.target.value)}
                    className="mt-1.5 w-full rounded-xl border border-gray-200 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-accent"
                  />
                </div>

                <div>
                  <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                    Guest names <span className="normal-case text-gray-400 dark:text-gray-500">(optional, comma-separated)</span>
                  </label>
                  <input
                    type="text"
                    value={bookingGuestNames}
                    onChange={e => setBookingGuestNames(e.target.value)}
                    placeholder="e.g. Jane Doe, John Smith"
                    className="mt-1.5 w-full rounded-xl border border-gray-200 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-700 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-accent"
                  />
                </div>

                <div>
                  <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                    Notes <span className="normal-case text-gray-400 dark:text-gray-500">(optional)</span>
                  </label>
                  <input
                    type="text"
                    value={bookingNotes}
                    onChange={e => setBookingNotes(e.target.value)}
                    className="mt-1.5 w-full rounded-xl border border-gray-200 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-accent"
                  />
                </div>
              </div>
            )}

            {bookingConflict && (
              <p className="mt-3 text-xs text-amber-600">
                Conflicts with an existing booking. Try a shorter duration or a different slot.
              </p>
            )}
            {bookingError && (
              <p className="mt-3 text-xs text-red-500">{bookingError}</p>
            )}

            <button
              disabled={bookingConflict || bookingLoading || (isAdmin && !selectedRosterMemberId)}
              onClick={handleConfirmBooking}
              className="mt-5 w-full py-3 rounded-xl bg-accent text-white dark:text-gray-900 text-sm font-semibold disabled:opacity-40"
            >
              {bookingLoading ? "Booking…" : "Confirm Booking"}
            </button>
        </ResponsiveSheet>
      )}
    </>
  );
}
