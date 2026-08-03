"use client";

import { useState, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import ResponsiveSheet from "@/components/ResponsiveSheet";
import { updateMemberReservationAdmin } from "./actions";
import { localDateTimeToUTC } from "@/lib/timezone";
import { STALE_CLUB_CONTEXT_ERROR, STALE_CLUB_MESSAGE } from "@/lib/staleClub";

// ─── Constants ────────────────────────────────────────────────────────────────

const DURATIONS = [30, 60, 90, 120] as const;

// 30-min slots, 8:00 AM–7:00 PM start times. The server is the authority on
// real operating hours/overrides — this list is only a reasonable selectable
// range, matching the convention already used by CreateMaintenanceSheet and
// CreateEventSheet.
const START_SLOTS = (() => {
  const slots: { hour: number; minute: number }[] = [];
  for (let h = 6; h <= 21; h++) {
    for (const m of [0, 30]) slots.push({ hour: h, minute: m });
  }
  return slots;
})();

// ─── Types ────────────────────────────────────────────────────────────────────

// Phase 30B1 scope correction: this form edits scheduling fields only
// (court/date/start time/duration). format/player_count/guest_names/notes
// are not collected by the current booking flow and are not exposed as
// editable fields here — but the reservation row may already carry values
// in those columns (set by other paths, e.g. admin tooling), and this form
// must never clear or overwrite them. They stay on this type purely so
// their existing values can be read once and passed straight through to
// updateMemberReservationAdmin unchanged.
interface EditableReservation {
  id:            string;
  court_id:      string;
  starts_at:     string;
  ends_at:       string;
  format:        string | null;
  player_count:  number | null;
  guest_names:   string[] | null;
  notes:         string | null;
  updated_at:    string;
}

interface Court {
  id:            string;
  name:          string;
  display_order: number;
}

interface Props {
  reservation:  EditableReservation;
  courts:       Court[];
  clubId:       string;
  clubTimezone: string;
  onClose:      () => void;
  onSaved:      () => void;
}

// Non-editable metadata this form must pass through unchanged.
interface HiddenFields {
  format:       string | null;
  player_count: number | null;
  guest_names:  string[] | null;
  notes:        string | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Extracts the club-local hour/minute of an ISO timestamp, using the same
// Intl.DateTimeFormat.formatToParts technique as src/lib/timezone.ts (never
// the runtime-timezone-dependent toLocaleString+Date trick).
function getLocalHourMinute(iso: string, tz: string): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(iso));
  const h = parseInt(parts.find(p => p.type === "hour")?.value   ?? "0", 10);
  const m = parseInt(parts.find(p => p.type === "minute")?.value ?? "0", 10);
  return { hour: h === 24 ? 0 : h, minute: m };
}

function formatSlotLabel(hour: number, minute: number): string {
  const h12  = hour % 12 || 12;
  const ampm = hour < 12 ? "AM" : "PM";
  return `${h12}:${minute === 0 ? "00" : "30"} ${ampm}`;
}

function durationOf(res: EditableReservation): 30 | 60 | 90 | 120 {
  const mins = Math.round((new Date(res.ends_at).getTime() - new Date(res.starts_at).getTime()) / 60_000);
  return (DURATIONS as readonly number[]).includes(mins) ? (mins as 30 | 60 | 90 | 120) : 60;
}

function mapEditError(code: string | undefined, message: string): string {
  if (message === STALE_CLUB_CONTEXT_ERROR)       return STALE_CLUB_MESSAGE;
  if (message === "stale_edit_conflict")          return "This booking was changed by someone else.";
  if (message === "reservation_not_found")        return "This booking could not be found.";
  if (message === "reservation_not_editable")     return "Only confirmed member bookings can be edited this way.";
  if (message === "insufficient_role")            return "You don't have permission to edit this booking.";
  if (message === "invalid_court")                return "Select an active court.";
  if (message === "invalid_duration")             return "Bookings must be 30, 60, 90, or 120 minutes.";
  if (message === "cannot_edit_started_reservation") return "This booking has already started and can no longer be edited.";
  if (message === "cannot_book_past")             return "You can't move a booking to a time in the past.";
  if (message === "club_closed_this_day")         return "The club is closed on the selected date.";
  if (message === "outside_operating_hours")      return "That time is outside club operating hours.";
  if (code === "23P01")                           return "That court is already booked for the selected time.";
  return "Something went wrong. Please try again.";
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function EditReservationSheet({
  reservation, courts, clubId, clubTimezone, onClose, onSaved,
}: Props) {
  const supabase = useMemo(() => createClient(), []);

  const initialHM = useMemo(
    () => getLocalHourMinute(reservation.starts_at, clubTimezone),
    [reservation.starts_at, clubTimezone]
  );

  const [courtId, setCourtId]           = useState(reservation.court_id);
  const [dateStr, setDateStr]           = useState(() =>
    new Date(reservation.starts_at).toLocaleDateString("en-CA", { timeZone: clubTimezone })
  );
  const [startHour, setStartHour]       = useState(initialHM.hour);
  const [startMinute, setStartMinute]   = useState(initialHM.minute);
  const [duration, setDuration]         = useState<30 | 60 | 90 | 120>(() => durationOf(reservation));

  // Not rendered or editable in this form — held only so their current
  // values can be resubmitted unchanged (see HiddenFields doc comment).
  const [hiddenFields, setHiddenFields] = useState<HiddenFields>({
    format:       reservation.format,
    player_count: reservation.player_count,
    guest_names:  reservation.guest_names,
    notes:        reservation.notes,
  });

  const [expectedUpdatedAt, setExpectedUpdatedAt] = useState(reservation.updated_at);
  const [submitting, setSubmitting]     = useState(false);
  const [error, setError]               = useState<string | null>(null);
  const [staleConflict, setStaleConflict] = useState(false);
  const [reloading, setReloading]       = useState(false);

  // ── Derived ───────────────────────────────────────────────────────────────

  const startsAt = useMemo(
    () => localDateTimeToUTC(dateStr, startHour, startMinute, clubTimezone),
    [dateStr, startHour, startMinute, clubTimezone]
  );
  const endsAt = useMemo(
    () => new Date(startsAt.getTime() + duration * 60_000),
    [startsAt, duration]
  );
  const endTimeLabel = endsAt.toLocaleTimeString("en-US", {
    timeZone: clubTimezone, hour: "numeric", minute: "2-digit", hour12: true,
  });

  // ── Handlers ──────────────────────────────────────────────────────────────

  async function handleReload() {
    setReloading(true);
    const { data } = await supabase
      .from("reservations")
      .select("id, court_id, starts_at, ends_at, format, player_count, guest_names, notes, updated_at")
      .eq("id", reservation.id)
      .single();
    setReloading(false);

    if (!data) {
      setError("This booking could not be found.");
      return;
    }

    const hm = getLocalHourMinute(data.starts_at, clubTimezone);
    setCourtId(data.court_id);
    setDateStr(new Date(data.starts_at).toLocaleDateString("en-CA", { timeZone: clubTimezone }));
    setStartHour(hm.hour);
    setStartMinute(hm.minute);
    setDuration(durationOf(data as EditableReservation));
    // Refresh the pass-through values too — a stale conflict means someone
    // else changed this row, and we must resubmit whatever is current now,
    // not the values this form was originally opened with.
    setHiddenFields({
      format:       data.format,
      player_count: data.player_count,
      guest_names:  data.guest_names,
      notes:        data.notes,
    });
    setExpectedUpdatedAt(data.updated_at);
    setStaleConflict(false);
    setError(null);
  }

  async function handleSave() {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    setStaleConflict(false);

    const { error: rpcError } = await updateMemberReservationAdmin({
      p_reservation_id:      reservation.id,
      p_expected_updated_at: expectedUpdatedAt,
      p_court_id:            courtId,
      p_starts_at:           startsAt.toISOString(),
      p_ends_at:             endsAt.toISOString(),
      p_format:              hiddenFields.format,
      p_player_count:        hiddenFields.player_count,
      p_guest_names:         hiddenFields.guest_names,
      p_notes:               hiddenFields.notes,
      expectedClubId:        clubId,
    });

    if (rpcError) {
      if (rpcError.message === "stale_edit_conflict") {
        setStaleConflict(true);
      } else {
        setError(mapEditError(rpcError.code, rpcError.message));
      }
      setSubmitting(false);
      return;
    }

    onSaved();
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <ResponsiveSheet
      onClose={submitting ? () => {} : onClose}
      variant="modal"
      mobileInteraction="draggable"
      mobileBackdropZ={60}
      mobilePanelZ={70}
      label="Edit Booking"
      header={
        <div className="flex items-center justify-between">
          <p className="text-base font-semibold text-gray-900 dark:text-gray-100">Edit Booking</p>
          <button
            onClick={onClose}
            disabled={submitting}
            className="text-sm text-gray-400 font-medium disabled:opacity-40"
          >
            Discard
          </button>
        </div>
      }
    >
      <div className="space-y-5 pt-1">

        {staleConflict && (
          <div className="rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 px-4 py-3">
            <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
              This booking was changed by someone else.
            </p>
            <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">
              Reload to see the latest version before saving again.
            </p>
            <button
              onClick={handleReload}
              disabled={reloading}
              className="mt-2 text-xs font-semibold text-amber-800 dark:text-amber-300 underline disabled:opacity-40"
            >
              {reloading ? "Reloading…" : "Reload"}
            </button>
          </div>
        )}

        {/* Court */}
        <div>
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">Court</label>
          <div className="flex flex-wrap gap-2 pt-2">
            {courts.map(court => (
              <button
                key={court.id}
                type="button"
                onClick={() => setCourtId(court.id)}
                className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors active:scale-95 ${
                  courtId === court.id
                    ? "bg-accent text-white dark:text-gray-900 border-accent"
                    : "bg-white text-gray-600 border-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:border-gray-600 hover:border-accent hover:text-accent"
                }`}
              >
                {court.name}
              </button>
            ))}
          </div>
        </div>

        {/* Date */}
        <div>
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">Date</label>
          <input
            type="date"
            value={dateStr}
            onChange={e => { if (e.target.value) setDateStr(e.target.value); }}
            className="ct-input ct-date-input mt-1.5 w-full rounded-xl border border-gray-200 px-4 py-3 text-base md:text-sm text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100 motion-safe:transition-all motion-safe:duration-150"
          />
        </div>

        {/* Start time */}
        <div>
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">Start Time</label>
          <select
            value={`${startHour}:${startMinute}`}
            onChange={e => {
              const [h, m] = e.target.value.split(":").map(Number);
              setStartHour(h);
              setStartMinute(m);
            }}
            className="mt-1.5 w-full rounded-xl border border-gray-200 px-4 py-3 text-base md:text-sm text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100 motion-safe:transition-all motion-safe:duration-150"
          >
            {START_SLOTS.map(slot => (
              <option key={`${slot.hour}:${slot.minute}`} value={`${slot.hour}:${slot.minute}`}>
                {formatSlotLabel(slot.hour, slot.minute)}
              </option>
            ))}
          </select>
        </div>

        {/* Duration */}
        <div>
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
            Duration — ends {endTimeLabel}
          </label>
          <div className="flex flex-wrap gap-2 pt-2" role="radiogroup" aria-label="Duration">
            {DURATIONS.map(mins => (
              <button
                key={mins}
                type="button"
                role="radio"
                aria-checked={duration === mins}
                onClick={() => setDuration(mins)}
                className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors active:scale-95 ${
                  duration === mins
                    ? "bg-accent text-white dark:text-gray-900 border-accent"
                    : "bg-white text-gray-600 border-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:border-gray-600 hover:border-accent hover:text-accent"
                }`}
              >
                {mins} min
              </button>
            ))}
          </div>
        </div>

        {error && <p className="text-xs text-red-500">{error}</p>}

        <button
          disabled={submitting || staleConflict}
          onClick={handleSave}
          className="w-full py-3 rounded-xl bg-accent text-white dark:text-gray-900 text-sm font-semibold disabled:opacity-40 hover:brightness-110 motion-safe:hover:-translate-y-0.5 motion-safe:hover:shadow-md active:scale-[0.98] motion-safe:active:translate-y-0 motion-safe:transition-all motion-safe:duration-150"
        >
          {submitting ? "Saving…" : "Save Changes"}
        </button>

      </div>
    </ResponsiveSheet>
  );
}
