"use client";

import { useState, useEffect, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";

// ─── Constants ────────────────────────────────────────────────────────────────

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const DURATION_PRESETS = [30, 45, 60, 90, 120] as const;

// ─── Types ────────────────────────────────────────────────────────────────────

interface EventType {
  id:                       string;
  key:                      string;
  label:                    string;
  color:                    string;
  default_capacity:         number;
  default_duration_minutes: number;
  default_court_count:      number;
  shows_participant_names:  boolean;
}

interface Court {
  id:            string;
  name:          string;
  display_order: number;
}

interface Props {
  courts:          Court[];
  clubId:          string;
  clubTimezone:    string;
  onClose:         () => void;
  onCreated:       () => void;
  // Optional pre-fill from slot click
  initialDate?:    Date;
  initialHour?:    number;
  initialMinute?:  number;
  initialCourtId?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Converts a local date + hour/minute into a UTC timestamptz.
// Mirrors the tzOffsetMs + getDayBoundsUTC approach in CalendarShell.
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

function mapCreateError(code: string | undefined, message: string): string {
  if (code === "23P01")                              return "A court is already booked at that time.";
  if (message === "insufficient_role"
   || message === "not_authorized")                  return "Only pros and admins can create events.";
  if (message === "cannot_create_past")              return "Events cannot be scheduled in the past.";
  if (message === "outside_booking_window")          return "That date is outside the booking window.";
  if (message === "club_closed_this_day")            return "The club is closed on that day.";
  if (message === "outside_operating_hours")         return "That time is outside operating hours.";
  return "Something went wrong. Please try again.";
}

// 30-min time slots from 8:00 AM to 6:30 PM (latest start for a 30-min event before 19:00 close)
const TIME_SLOTS = (() => {
  const slots: { hour: number; minute: number }[] = [];
  for (let h = 8; h <= 18; h++) {
    for (const m of [0, 30]) {
      if (h === 18 && m === 30) break;
      slots.push({ hour: h, minute: m });
    }
  }
  return slots;
})();

// ─── Component ───────────────────────────────────────────────────────────────

export default function CreateEventSheet({
  courts, clubId, clubTimezone, onClose, onCreated,
  initialDate, initialHour, initialMinute, initialCourtId,
}: Props) {
  const supabase = useMemo(() => createClient(), []);

  // ── State ──────────────────────────────────────────────────────────────────

  const [step, setStep]                               = useState<1 | 2 | 3 | 4>(1);
  const [eventTypes, setEventTypes]                   = useState<EventType[]>([]);
  const [loadingTypes, setLoadingTypes]               = useState(true);
  const [selectedType, setSelectedType]               = useState<EventType | null>(null);
  const [title, setTitle]                             = useState("");
  const [selectedDate, setSelectedDate]               = useState<Date>(() => {
    if (initialDate) return initialDate;
    const iso = new Date().toLocaleDateString("en-CA", { timeZone: clubTimezone });
    return new Date(iso + "T12:00:00Z");
  });
  const [startHour, setStartHour]                     = useState(initialHour   ?? 9);
  const [startMinute, setStartMinute]                 = useState(initialMinute ?? 0);
  const [durationMinutes, setDurationMinutes]         = useState(60);
  const [selectedCourtIds, setSelectedCourtIds]       = useState<string[]>([]);
  const [capacity, setCapacity]                       = useState(1);
  const [conflictingCourtIds, setConflictingCourtIds] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting]                   = useState(false);
  const [error, setError]                             = useState<string | null>(null);
  const [typesError, setTypesError]                   = useState<string | null>(null);
  const [isCustomDuration, setIsCustomDuration]       = useState(false);
  const [customDurationText, setCustomDurationText]   = useState("60");

  // ── Fetch event types on mount ─────────────────────────────────────────────

  useEffect(() => {
    supabase
      .from("event_types")
      .select("id, key, label, color, default_capacity, default_duration_minutes, default_court_count, shows_participant_names")
      .eq("club_id", clubId)
      .order("key")
      .then(({ data, error: fetchErr }) => {
        if (fetchErr) {
          setTypesError("Failed to load event types. Please close and try again.");
        } else {
          setEventTypes((data ?? []) as EventType[]);
        }
        setLoadingTypes(false);
      });
  }, [supabase, clubId]);

  // ── Date pills (same pattern as CalendarShell datePills) ───────────────────

  const todayISO = useMemo(
    () => new Date().toLocaleDateString("en-CA", { timeZone: clubTimezone }),
    [clubTimezone]
  );

  const datePills = useMemo(() => {
    const [ty, tm, td] = todayISO.split("-").map(Number);
    return Array.from({ length: 15 }, (_, i) => {
      const dt = new Date(Date.UTC(ty, tm - 1, td + i, 12, 0, 0));
      return {
        dateISO: dt.toISOString().slice(0, 10),
        day:     DAY_NAMES[dt.getUTCDay()],
        dateNum: dt.getUTCDate(),
      };
    });
  }, [todayISO]);

  // ── Computed start/end UTC timestamps ──────────────────────────────────────

  const startsAt = useMemo(
    () => localTimeToUTC(selectedDate, startHour, startMinute, clubTimezone),
    [selectedDate, startHour, startMinute, clubTimezone]
  );

  const endsAt = useMemo(
    () => new Date(startsAt.getTime() + durationMinutes * 60_000),
    [startsAt, durationMinutes]
  );

  const endTimeLabel = endsAt.toLocaleTimeString("en-US", {
    timeZone: clubTimezone, hour: "numeric", minute: "2-digit", hour12: true,
  });

  // ── Conflict check (Step 3) ────────────────────────────────────────────────

  const startsAtStr     = startsAt.toISOString();
  const endsAtStr       = endsAt.toISOString();
  const courtIdsStr     = selectedCourtIds.join(",");

  useEffect(() => {
    if (step !== 3 || selectedCourtIds.length === 0) {
      setConflictingCourtIds(new Set());
      return;
    }
    supabase
      .from("reservations")
      .select("court_id")
      .in("court_id", selectedCourtIds)
      .in("status", ["pending", "confirmed"])
      .lt("starts_at", endsAtStr)
      .gt("ends_at", startsAtStr)
      .then(({ data }) => {
        setConflictingCourtIds(new Set(data?.map(c => c.court_id) ?? []));
      });
  }, [step, courtIdsStr, startsAtStr, endsAtStr]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Handlers ──────────────────────────────────────────────────────────────

  function selectType(type: EventType) {
    const defaultDur = type.default_duration_minutes;
    setSelectedType(type);
    setDurationMinutes(defaultDur);
    setIsCustomDuration(!(DURATION_PRESETS as readonly number[]).includes(defaultDur));
    setCustomDurationText(String(defaultDur));
    setCapacity(type.default_capacity);
    const n = Math.min(type.default_court_count, courts.length);
    let defaults = courts.slice(0, n).map(c => c.id);
    if (initialCourtId && !defaults.includes(initialCourtId)) {
      defaults = [initialCourtId, ...defaults.slice(0, n - 1)];
    }
    setSelectedCourtIds(defaults);
    setTitle("");
    setError(null);
    setStep(2);
  }

  function toggleCourt(courtId: string) {
    setSelectedCourtIds(prev =>
      prev.includes(courtId) ? prev.filter(id => id !== courtId) : [...prev, courtId]
    );
  }

  function handleCustomDuration(text: string) {
    setCustomDurationText(text);
    const val = parseInt(text.trim(), 10);
    if (/^\d+$/.test(text.trim()) && val > 0) {
      setDurationMinutes(val);
    }
  }

  async function handleCreate() {
    if (!selectedType || !title.trim() || selectedCourtIds.length === 0) return;
    setSubmitting(true);
    setError(null);

    const { error: rpcError } = await supabase.rpc("create_event", {
      p_event_type_id: selectedType.id,
      p_title:         title.trim(),
      p_starts_at:     startsAt.toISOString(),
      p_ends_at:       endsAt.toISOString(),
      p_court_ids:     selectedCourtIds,
      p_capacity:      capacity,
    });

    if (rpcError) {
      setError(mapCreateError(rpcError.code, rpcError.message));
      setSubmitting(false);
      return;
    }

    onCreated();
    onClose();
  }

  // ── Display helpers ────────────────────────────────────────────────────────

  const selectedDateISO = selectedDate.toLocaleDateString("en-CA", { timeZone: clubTimezone });

  const summaryDate = selectedDate.toLocaleDateString("en-US", {
    timeZone: clubTimezone, weekday: "short", month: "short", day: "numeric",
  });
  const summaryStart = startsAt.toLocaleTimeString("en-US", {
    timeZone: clubTimezone, hour: "numeric", minute: "2-digit", hour12: true,
  });
  const summaryCourtNames = selectedCourtIds
    .map(id => courts.find(c => c.id === id)?.name ?? "Court")
    .join(", ");

  const customDurationValid = !isCustomDuration || (
    /^\d+$/.test(customDurationText.trim()) && parseInt(customDurationText.trim(), 10) > 0
  );

  const stepTitles: Record<1 | 2 | 3 | 4, string> = {
    1: "Event Type",
    2: "Date & Time",
    3: "Courts",
    4: "Confirm",
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />
      <div className="ct-sheet-enter fixed bottom-0 left-0 right-0 bg-white dark:bg-gray-800 rounded-t-2xl z-50 shadow-xl flex flex-col max-h-[88dvh]">

        {/* Handle + header */}
        <div className="shrink-0 px-6 pt-5 pb-3">
          <div className="ct-handlebar mx-auto mb-4" />
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              {step > 1 && (
                <button
                  onClick={() => { setStep((s) => (s - 1) as 1 | 2 | 3 | 4); setError(null); }}
                  className="text-sm text-gray-500 dark:text-gray-400 hover:text-accent motion-safe:transition-colors motion-safe:duration-150"
                >
                  ← Back
                </button>
              )}
              <p className="text-base font-semibold text-gray-900 dark:text-gray-100">{stepTitles[step]}</p>
            </div>
            <p className="text-xs text-gray-400 dark:text-gray-500">{step} of 4</p>
          </div>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-8">

          {/* ── Step 1: Event type selection ─────────────────────────────── */}
          {step === 1 && (
            <div className="space-y-3 pt-1">
              {loadingTypes ? (
                <p className="text-sm text-gray-400 py-8 text-center">Loading…</p>
              ) : typesError ? (
                <p className="text-sm text-red-500 py-8 text-center">{typesError}</p>
              ) : eventTypes.length === 0 ? (
                <p className="text-sm text-gray-400 py-8 text-center">No event types configured.</p>
              ) : (
                eventTypes.map(type => (
                  <button
                    key={type.id}
                    onClick={() => selectType(type)}
                    className="w-full text-left rounded-xl border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 px-4 py-3 flex items-start gap-3 hover:border-accent hover:bg-gray-50 dark:hover:bg-gray-600/60 active:bg-gray-100 dark:active:bg-gray-600 motion-safe:transition-all motion-safe:duration-150"
                    style={{ borderLeftWidth: 4, borderLeftColor: type.color }}
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{type.label}</p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {type.default_capacity} spots · {type.default_duration_minutes} min · {type.default_court_count} court{type.default_court_count !== 1 ? "s" : ""}
                      </p>
                    </div>
                  </button>
                ))
              )}
            </div>
          )}

          {/* ── Step 2: Title + date/time/duration ───────────────────────── */}
          {step === 2 && selectedType && (
            <div className="pt-1 space-y-5">

              {/* Title */}
              <div>
                <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">Title</label>
                <input
                  type="text"
                  value={title}
                  onChange={e => setTitle(e.target.value)}
                  placeholder={selectedType.label}
                  className="mt-1.5 w-full rounded-xl border border-gray-200 px-4 py-3 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100 motion-safe:transition-all motion-safe:duration-150"
                />
              </div>

              {/* Date strip */}
              <div>
                <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">Date</label>
                <div className="flex gap-1.5 overflow-x-auto pt-2 pb-1 hide-scrollbar">
                  {datePills.map(pill => {
                    const isSelected = pill.dateISO === selectedDateISO;
                    const isToday    = pill.dateISO === todayISO;
                    return (
                      <button
                        key={pill.dateISO}
                        onClick={() => setSelectedDate(new Date(pill.dateISO + "T12:00:00Z"))}
                        className={`flex flex-col items-center justify-center rounded-full shrink-0 w-10 h-10 text-xs leading-tight ${
                          isSelected
                            ? "bg-accent text-white dark:text-gray-900 font-semibold"
                            : isToday
                            ? "text-blue-600 font-medium"
                            : "text-gray-500 dark:text-gray-400 dark:text-gray-500"
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
                <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">Start Time</label>
                <select
                  value={`${startHour}:${startMinute}`}
                  onChange={e => {
                    const [h, m] = e.target.value.split(":").map(Number);
                    setStartHour(h);
                    setStartMinute(m);
                  }}
                  className="mt-1.5 w-full rounded-xl border border-gray-200 px-4 py-3 text-sm text-gray-900 bg-white dark:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent dark:border-gray-600 dark:text-gray-100 motion-safe:transition-all motion-safe:duration-150"
                >
                  {TIME_SLOTS.map(slot => (
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
                <div className="flex flex-wrap gap-2 pt-2">
                  {DURATION_PRESETS.map(mins => (
                    <button
                      key={mins}
                      type="button"
                      onClick={() => { setDurationMinutes(mins); setIsCustomDuration(false); }}
                      className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors active:scale-95 ${
                        !isCustomDuration && durationMinutes === mins
                          ? "bg-accent text-white dark:text-gray-900 border-accent"
                          : "bg-white text-gray-600 border-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:border-gray-600 hover:border-accent hover:text-accent"
                      }`}
                    >
                      {mins} min
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => { setIsCustomDuration(true); setCustomDurationText(String(durationMinutes)); }}
                    className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors active:scale-95 ${
                      isCustomDuration
                        ? "bg-accent text-white dark:text-gray-900 border-accent"
                        : "bg-white text-gray-600 border-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:border-gray-600 hover:border-accent hover:text-accent"
                    }`}
                  >
                    Custom
                  </button>
                </div>
                {isCustomDuration && (
                  <div className="mt-2 flex items-center gap-2">
                    <input
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      value={customDurationText}
                      onChange={e => handleCustomDuration(e.target.value)}
                      placeholder="e.g. 75"
                      className="w-24 rounded-xl border border-gray-200 px-4 py-3 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100 motion-safe:transition-all motion-safe:duration-150"
                    />
                    <span className="text-xs text-gray-500">min</span>
                    {customDurationText.length > 0 && !customDurationValid && (
                      <span className="text-xs text-red-500">Enter a whole number.</span>
                    )}
                  </div>
                )}
              </div>

              {error && <p className="text-xs text-red-500">{error}</p>}

              <button
                disabled={!title.trim() || !customDurationValid}
                onClick={() => {
                  setError(null);
                  if (startsAt <= new Date()) {
                    setError("Events cannot be scheduled in the past.");
                    return;
                  }
                  setStep(3);
                }}
                className="w-full py-3 rounded-xl bg-accent text-white dark:text-gray-900 text-sm font-semibold disabled:opacity-40 hover:brightness-110 motion-safe:hover:-translate-y-0.5 motion-safe:hover:shadow-md active:scale-[0.98] motion-safe:active:translate-y-0 motion-safe:transition-all motion-safe:duration-150"
              >
                Continue
              </button>
            </div>
          )}

          {/* ── Step 3: Court selection ───────────────────────────────────── */}
          {step === 3 && (
            <div className="pt-1 space-y-5">
              <div>
                <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">Select Courts</label>
                <div className="flex flex-wrap gap-2 pt-2">
                  {courts.map(court => {
                    const isSelected   = selectedCourtIds.includes(court.id);
                    const hasConflict  = conflictingCourtIds.has(court.id);
                    return (
                      <button
                        key={court.id}
                        onClick={() => toggleCourt(court.id)}
                        className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors active:scale-95 ${
                          hasConflict
                            ? "border-amber-400 bg-amber-50 text-amber-700"
                            : isSelected
                            ? "bg-accent text-white dark:text-gray-900 border-accent"
                            : "bg-white text-gray-600 border-gray-200 dark:border-gray-700 hover:border-accent hover:text-accent"
                        }`}
                      >
                        {court.name}{hasConflict ? " ⚠" : ""}
                      </button>
                    );
                  })}
                </div>
                {conflictingCourtIds.size > 0 && (
                  <p className="mt-2 text-xs text-amber-600">
                    {[...conflictingCourtIds]
                      .map(id => courts.find(c => c.id === id)?.name ?? id)
                      .join(", ")}{" "}
                    {conflictingCourtIds.size === 1 ? "has" : "have"} an existing booking at this time. You can still continue — the DB will reject real conflicts.
                  </p>
                )}
                {selectedCourtIds.length === 0 && (
                  <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">Select at least one court.</p>
                )}
              </div>

              <button
                disabled={selectedCourtIds.length === 0}
                onClick={() => { setError(null); setStep(4); }}
                className="w-full py-3 rounded-xl bg-accent text-white dark:text-gray-900 text-sm font-semibold disabled:opacity-40 hover:brightness-110 motion-safe:hover:-translate-y-0.5 motion-safe:hover:shadow-md active:scale-[0.98] motion-safe:active:translate-y-0 motion-safe:transition-all motion-safe:duration-150"
              >
                Continue
              </button>
            </div>
          )}

          {/* ── Step 4: Capacity + confirm ────────────────────────────────── */}
          {step === 4 && selectedType && (
            <div className="pt-1 space-y-5">

              {/* Capacity */}
              <div>
                <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">Capacity (spots)</label>
                <select
                  value={capacity}
                  onChange={e => setCapacity(Number(e.target.value))}
                  className="mt-1.5 w-full rounded-xl border border-gray-200 px-4 py-3 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100 bg-white motion-safe:transition-all motion-safe:duration-150"
                >
                  {Array.from({ length: Math.max(50, capacity) }, (_, i) => i + 1).map(n => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </div>

              {/* Summary */}
              <div className="rounded-xl bg-gray-50 dark:bg-gray-700/50 border border-gray-100 dark:border-gray-700 px-4 py-3">
                <p className="text-xs text-gray-500 leading-relaxed">
                  <span
                    className="inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold text-white mr-1.5"
                    style={{ background: selectedType.color }}
                  >
                    {selectedType.label}
                  </span>
                  {title.trim()} · {summaryDate} · {summaryStart} – {endTimeLabel} · {summaryCourtNames} · {capacity} spot{capacity !== 1 ? "s" : ""}
                </p>
              </div>

              {error && <p className="text-xs text-red-500">{error}</p>}

              <button
                disabled={submitting || capacity < 1}
                onClick={handleCreate}
                className="w-full py-3 rounded-xl bg-accent text-white dark:text-gray-900 text-sm font-semibold disabled:opacity-40 hover:brightness-110 motion-safe:hover:-translate-y-0.5 motion-safe:hover:shadow-md active:scale-[0.98] motion-safe:active:translate-y-0 motion-safe:transition-all motion-safe:duration-150"
              >
                {submitting ? "Creating…" : "Create Event"}
              </button>
            </div>
          )}

        </div>
      </div>
    </>
  );
}
