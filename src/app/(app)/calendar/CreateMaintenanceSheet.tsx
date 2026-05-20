"use client";

import { useState, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";

// ─── Constants ────────────────────────────────────────────────────────────────

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// 30-min slots from 8:00 to 19:00 inclusive.
// Start options exclude 19:00; end options exclude 8:00.
const ALL_SLOTS = (() => {
  const slots: { hour: number; minute: number }[] = [];
  for (let h = 8; h <= 19; h++) {
    for (const m of [0, 30]) {
      if (h === 19 && m === 30) break;
      slots.push({ hour: h, minute: m });
    }
  }
  return slots;
})();

// ─── Types ────────────────────────────────────────────────────────────────────

interface Court {
  id:            string;
  name:          string;
  display_order: number;
}

interface Props {
  courts:       Court[];
  clubTimezone: string;
  selectedDate: Date;
  onClose:      () => void;
  onCreated:    () => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Mirrors the localTimeToUTC approach in CreateEventSheet.
function localTimeToUTC(date: Date, hour: number, minute: number, tz: string): Date {
  const dateStr    = date.toLocaleDateString("en-CA", { timeZone: tz });
  const [y, m, d]  = dateStr.split("-").map(Number);
  const utcMidnight = Date.UTC(y, m - 1, d);
  const sampleNoon  = new Date(utcMidnight + 12 * 3600_000);
  const toFake     = (dt: Date, timezone: string) =>
    new Date(dt.toLocaleString("en-US", { timeZone: timezone })).getTime();
  const offsetMs   = toFake(sampleNoon, "UTC") - toFake(sampleNoon, tz);
  return new Date(utcMidnight + offsetMs + (hour * 60 + minute) * 60_000);
}

function formatSlotLabel(hour: number, minute: number): string {
  const h12  = hour % 12 || 12;
  const ampm = hour < 12 ? "AM" : "PM";
  return `${h12}:${minute === 0 ? "00" : "30"} ${ampm}`;
}

function toMins(hour: number, minute: number): number {
  return hour * 60 + minute;
}

function mapBlockError(code: string | undefined, message: string): string {
  if (code === "23P01")                  return "That time overlaps an existing booking — choose a different time.";
  if (message === "invalid_duration")    return "End time must be after start time.";
  if (message === "cannot_create_past")  return "Maintenance blocks cannot be scheduled in the past.";
  if (message === "court_not_found")     return "Court not found. Please try again.";
  if (message === "insufficient_role")   return "Only admins can create maintenance blocks.";
  return "Something went wrong. Please try again.";
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function CreateMaintenanceSheet({
  courts, clubTimezone, selectedDate, onClose, onCreated,
}: Props) {
  const supabase = useMemo(() => createClient(), []);

  const [courtId,     setCourtId]     = useState(courts[0]?.id ?? "");
  const [date,        setDate]        = useState<Date>(selectedDate);
  const [startHour,   setStartHour]   = useState(9);
  const [startMinute, setStartMinute] = useState(0);
  const [endHour,     setEndHour]     = useState(10);
  const [endMinute,   setEndMinute]   = useState(0);
  const [notes,       setNotes]       = useState("");
  const [submitting,  setSubmitting]  = useState(false);
  const [error,       setError]       = useState<string | null>(null);

  // ── Date pills ────────────────────────────────────────────────────────────

  const todayISO = useMemo(
    () => new Date().toLocaleDateString("en-CA", { timeZone: clubTimezone }),
    [clubTimezone]
  );

  const datePills = useMemo(() => {
    const [ty, tm, td] = todayISO.split("-").map(Number);
    return Array.from({ length: 14 }, (_, i) => {
      const dt = new Date(Date.UTC(ty, tm - 1, td + i, 12, 0, 0));
      return {
        dateISO: dt.toISOString().slice(0, 10),
        day:     DAY_NAMES[dt.getUTCDay()],
        dateNum: dt.getUTCDate(),
      };
    });
  }, [todayISO]);

  const selectedDateISO = date.toLocaleDateString("en-CA", { timeZone: clubTimezone });

  // ── Slot lists ────────────────────────────────────────────────────────────

  const startSlots = ALL_SLOTS.filter(s => !(s.hour === 19 && s.minute === 0));
  const startMins  = toMins(startHour, startMinute);
  const endSlots   = ALL_SLOTS.filter(s => toMins(s.hour, s.minute) > startMins);

  // ── Handlers ──────────────────────────────────────────────────────────────

  function handleStartChange(value: string) {
    const [h, m] = value.split(":").map(Number);
    setStartHour(h);
    setStartMinute(m);
    // Auto-advance end if it's no longer strictly after the new start.
    const newStartMins = toMins(h, m);
    if (toMins(endHour, endMinute) <= newStartMins) {
      const next = ALL_SLOTS.find(s => toMins(s.hour, s.minute) > newStartMins);
      if (next) { setEndHour(next.hour); setEndMinute(next.minute); }
    }
  }

  async function handleSubmit() {
    if (!courtId || endSlots.length === 0) return;
    setSubmitting(true);
    setError(null);

    const startsAt = localTimeToUTC(date, startHour, startMinute, clubTimezone);
    const endsAt   = localTimeToUTC(date, endHour,   endMinute,   clubTimezone);

    if (startsAt <= new Date()) {
      setError("Maintenance blocks cannot be scheduled in the past.");
      setSubmitting(false);
      return;
    }

    const { error: rpcError } = await supabase.rpc("create_maintenance_block", {
      p_court_id:  courtId,
      p_starts_at: startsAt.toISOString(),
      p_ends_at:   endsAt.toISOString(),
      p_notes:     notes.trim() || null,
    });

    if (rpcError) {
      setError(mapBlockError(rpcError.code, rpcError.message));
      setSubmitting(false);
      return;
    }

    onCreated();
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />
      <div className="fixed bottom-0 left-0 right-0 bg-white rounded-t-2xl z-50 shadow-xl flex flex-col max-h-[88dvh]">

        {/* Handle + header */}
        <div className="shrink-0 px-6 pt-5 pb-3">
          <div className="w-10 h-1 bg-gray-200 rounded-full mx-auto mb-4" />
          <p className="text-base font-semibold text-gray-900">Block Court</p>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-8 space-y-5 pt-1">

          {/* Court */}
          <div>
            <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">Court</label>
            <select
              value={courtId}
              onChange={e => setCourtId(e.target.value)}
              className="mt-1.5 w-full rounded-xl border border-gray-200 px-4 py-3 text-sm text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-gray-900"
            >
              {courts.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>

          {/* Date */}
          <div>
            <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">Date</label>
            <div className="flex gap-1.5 overflow-x-auto pt-2 pb-1 hide-scrollbar">
              {datePills.map(pill => {
                const isSelected = pill.dateISO === selectedDateISO;
                const isToday    = pill.dateISO === todayISO;
                return (
                  <button
                    key={pill.dateISO}
                    onClick={() => setDate(new Date(pill.dateISO + "T12:00:00Z"))}
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
          </div>

          {/* Start time */}
          <div>
            <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">Start Time</label>
            <select
              value={`${startHour}:${startMinute}`}
              onChange={e => handleStartChange(e.target.value)}
              className="mt-1.5 w-full rounded-xl border border-gray-200 px-4 py-3 text-sm text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-gray-900"
            >
              {startSlots.map(slot => (
                <option key={`${slot.hour}:${slot.minute}`} value={`${slot.hour}:${slot.minute}`}>
                  {formatSlotLabel(slot.hour, slot.minute)}
                </option>
              ))}
            </select>
          </div>

          {/* End time */}
          <div>
            <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">End Time</label>
            <select
              value={`${endHour}:${endMinute}`}
              onChange={e => {
                const [h, m] = e.target.value.split(":").map(Number);
                setEndHour(h);
                setEndMinute(m);
              }}
              className="mt-1.5 w-full rounded-xl border border-gray-200 px-4 py-3 text-sm text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-gray-900"
            >
              {endSlots.map(slot => (
                <option key={`${slot.hour}:${slot.minute}`} value={`${slot.hour}:${slot.minute}`}>
                  {formatSlotLabel(slot.hour, slot.minute)}
                </option>
              ))}
            </select>
          </div>

          {/* Notes */}
          <div>
            <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">Reason (optional)</label>
            <input
              type="text"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="e.g. Resurfacing, Equipment repair"
              className="mt-1.5 w-full rounded-xl border border-gray-200 px-4 py-3 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-900"
            />
          </div>

          {error && <p className="text-xs text-red-500">{error}</p>}

          <button
            disabled={submitting || !courtId || endSlots.length === 0}
            onClick={handleSubmit}
            className="w-full py-3 rounded-xl bg-gray-900 text-white text-sm font-semibold disabled:opacity-40"
          >
            {submitting ? "Blocking…" : "Block Court"}
          </button>

        </div>
      </div>
    </>
  );
}
