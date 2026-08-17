"use client";

import { useState, useEffect, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import ResponsiveSheet from "@/components/ResponsiveSheet";
import { updateEventAdmin } from "@/app/(app)/admin/events/actions";
import { localDateTimeToUTC } from "@/lib/timezone";
import { STALE_CLUB_CONTEXT_ERROR, STALE_CLUB_MESSAGE } from "@/lib/staleClub";

// ─── Constants ────────────────────────────────────────────────────────────────

const DURATION_PRESETS = [30, 45, 60, 90, 120] as const;

// 30-min slots, 6:00 AM–9:30 PM start times — the server is the authority on
// real conflicts; this list is only a reasonable selectable range (events
// have no operating-hours restriction, matching create_event's own
// behavior — see the parity note in supabase/migrations/0099).
const START_SLOTS = (() => {
  const slots: { hour: number; minute: number }[] = [];
  for (let h = 6; h <= 21; h++) {
    for (const m of [0, 30]) slots.push({ hour: h, minute: m });
  }
  return slots;
})();

// ─── Types ────────────────────────────────────────────────────────────────────

// Phase 30C2: this form edits a single event in place. For a program-
// generated session (program_id is not null), title/event_type_id/
// description are read once and resubmitted unchanged — never rendered as
// editable controls — matching update_event's own server-side restriction
// (program_session_field_not_editable). Only date/start/duration/courts/
// capacity are editable for a program session.
interface EditableEvent {
  id:             string;
  title:          string;
  event_type_id:  string;
  description:    string | null;
  starts_at:      string;
  ends_at:        string;
  capacity:       number;
  court_ids:      string[];
  program_id:     string | null;
  updated_at:     string;
}

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
  event:        EditableEvent;
  courts:       Court[];
  clubId:       string;
  clubTimezone: string;
  onClose:      () => void;
  onSaved:      () => void;
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

function durationOf(startsAt: string, endsAt: string): number {
  return Math.round((new Date(endsAt).getTime() - new Date(startsAt).getTime()) / 60_000);
}

function mapEditError(code: string | undefined, message: string): string {
  if (message === STALE_CLUB_CONTEXT_ERROR)             return STALE_CLUB_MESSAGE;
  if (message === "stale_edit_conflict")                return "This event was changed by someone else.";
  if (message === "event_not_found")                    return "This event could not be found.";
  if (message === "event_cancelled")                    return "This event has been cancelled.";
  if (message === "event_archived")                      return "This event is archived.";
  if (message === "event_started")                       return "This event has already started and can no longer be edited.";
  if (message === "insufficient_role")                   return "You don't have permission to edit this event.";
  if (message === "program_session_field_not_editable")  return "Title, event type, and description can't be changed for a single program session.";
  if (message === "invalid_title")                       return "Enter a title.";
  if (message === "event_type_not_found")                return "Select an event type.";
  if (message === "inactive_event_type")                 return "That event type is no longer active. Choose another.";
  if (message === "court_required")                      return "Select at least one court.";
  if (message === "duplicate_court_in_event")             return "Each court can only be selected once.";
  if (message === "invalid_duration")                     return "Choose a valid start time and duration.";
  if (message === "invalid_capacity")                     return "Enter a capacity of at least 1.";
  if (message === "capacity_below_participants")          return "Capacity can't be lower than the confirmed, offered, and guest spots already filled.";
  if (message === "invalid_court")                        return "One or more selected courts are inactive or unavailable.";
  if (message === "member_schedule_conflict")             return "One or more confirmed participants already has another commitment at that time.";
  if (code === "23P01")                                   return "One or more selected courts are already booked at that time.";
  return "Something went wrong. Please try again.";
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function EditEventSheet({
  event, courts, clubId, clubTimezone, onClose, onSaved,
}: Props) {
  const supabase = useMemo(() => createClient(), []);

  const isProgramSession = event.program_id != null;

  // Phase 30C2 fix: the caller's declared EditableEvent type promises these
  // fields, but a stale or malformed data path (e.g. a Manage Events query
  // missing a select column) can still hand this component a real object
  // that doesn't actually contain them at runtime. Never trust the static
  // type here — check the runtime value and refuse to allow a save rather
  // than crashing (courtIds.length on undefined) or silently treating
  // missing court data as "zero courts selected."
  const missingFields = useMemo(() => {
    const missing: string[] = [];
    if (!Array.isArray(event.court_ids)) missing.push("courts");
    if (!event.event_type_id)            missing.push("event type");
    if (!event.updated_at)               missing.push("last-updated timestamp");
    return missing;
  }, [event]);
  const hasLoadError = missingFields.length > 0;
  const safeCourtIds = Array.isArray(event.court_ids) ? event.court_ids : [];

  const initialHM = useMemo(
    () => getLocalHourMinute(event.starts_at, clubTimezone),
    [event.starts_at, clubTimezone]
  );
  const initialDuration = useMemo(
    () => durationOf(event.starts_at, event.ends_at),
    [event.starts_at, event.ends_at]
  );

  // Standalone-only fields — for a program session these are never exposed
  // to an editable control and are simply resubmitted unchanged.
  const [title, setTitle]             = useState(event.title);
  const [eventTypeId, setEventTypeId] = useState(event.event_type_id);
  const [description, setDescription] = useState(event.description ?? "");
  const [eventTypes, setEventTypes]   = useState<EventType[]>([]);

  // Fields editable for both standalone events and program sessions.
  const [courtIds, setCourtIds]       = useState<string[]>(safeCourtIds);
  const [dateStr, setDateStr]         = useState(() =>
    new Date(event.starts_at).toLocaleDateString("en-CA", { timeZone: clubTimezone })
  );
  const [startHour, setStartHour]     = useState(initialHM.hour);
  const [startMinute, setStartMinute] = useState(initialHM.minute);
  const [durationMinutes, setDurationMinutes]       = useState(initialDuration);
  const [isCustomDuration, setIsCustomDuration]     = useState(
    !(DURATION_PRESETS as readonly number[]).includes(initialDuration)
  );
  const [customDurationText, setCustomDurationText] = useState(String(initialDuration));
  const [capacityText, setCapacityText] = useState(String(event.capacity));

  const [expectedUpdatedAt, setExpectedUpdatedAt] = useState(event.updated_at);
  const [submitting, setSubmitting]     = useState(false);
  const [error, setError]               = useState<string | null>(null);
  const [staleConflict, setStaleConflict] = useState(false);
  const [reloading, setReloading]       = useState(false);

  // ── Event types (standalone only — fetched regardless for simplicity;
  // the control just never renders for a program session) ────────────────
  useEffect(() => {
    supabase
      .from("event_types")
      .select("id, key, label, color, default_capacity, default_duration_minutes, default_court_count, shows_participant_names")
      .eq("club_id", clubId)
      .eq("is_active", true)
      .order("label")
      .then(({ data }) => { if (data) setEventTypes(data); });
  }, [supabase, clubId]);

  // ── Derived ───────────────────────────────────────────────────────────────

  const startsAt = useMemo(
    () => localDateTimeToUTC(dateStr, startHour, startMinute, clubTimezone),
    [dateStr, startHour, startMinute, clubTimezone]
  );
  const endsAt = useMemo(
    () => new Date(startsAt.getTime() + durationMinutes * 60_000),
    [startsAt, durationMinutes]
  );
  const endTimeLabel = endsAt.toLocaleTimeString("en-US", {
    timeZone: clubTimezone, hour: "numeric", minute: "2-digit", hour12: true,
  });

  const customDurationValid = !isCustomDuration || (
    /^\d+$/.test(customDurationText.trim()) && parseInt(customDurationText.trim(), 10) > 0
  );

  const capacityValid = /^\d+$/.test(capacityText.trim()) && parseInt(capacityText.trim(), 10) > 0;

  const canSave = !submitting && !staleConflict && !hasLoadError && customDurationValid && capacityValid
    && courtIds.length > 0 && (isProgramSession || title.trim().length > 0);

  // ── Handlers ──────────────────────────────────────────────────────────────

  function toggleCourt(courtId: string) {
    setCourtIds(prev =>
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

  async function handleReload() {
    setReloading(true);
    const { data } = await supabase
      .from("events")
      .select(`
        id, title, event_type_id, description, starts_at, ends_at, capacity, updated_at,
        reservations(court_id, status, reason)
      `)
      .eq("id", event.id)
      .single();
    setReloading(false);

    if (!data) {
      setError("This event could not be found.");
      return;
    }

    const freshCourtIds = (data.reservations ?? [])
      .filter((r: { status: string; reason: string }) => r.reason === "event" && r.status === "confirmed")
      .map((r: { court_id: string }) => r.court_id);

    const hm = getLocalHourMinute(data.starts_at, clubTimezone);
    const freshDuration = durationOf(data.starts_at, data.ends_at);

    setTitle(data.title);
    setEventTypeId(data.event_type_id);
    setDescription(data.description ?? "");
    setCourtIds(freshCourtIds);
    setDateStr(new Date(data.starts_at).toLocaleDateString("en-CA", { timeZone: clubTimezone }));
    setStartHour(hm.hour);
    setStartMinute(hm.minute);
    setDurationMinutes(freshDuration);
    setIsCustomDuration(!(DURATION_PRESETS as readonly number[]).includes(freshDuration));
    setCustomDurationText(String(freshDuration));
    setCapacityText(String(data.capacity));
    setExpectedUpdatedAt(data.updated_at);
    setStaleConflict(false);
    setError(null);
  }

  async function handleSave() {
    if (!canSave) return;
    setSubmitting(true);
    setError(null);
    setStaleConflict(false);

    const { error: rpcError } = await updateEventAdmin({
      p_event_id:             event.id,
      p_expected_updated_at:  expectedUpdatedAt,
      p_title:                title,
      p_event_type_id:        eventTypeId,
      p_starts_at:            startsAt.toISOString(),
      p_ends_at:              endsAt.toISOString(),
      p_court_ids:            courtIds,
      p_capacity:             parseInt(capacityText.trim(), 10),
      p_description:          description.trim() || null,
      expectedClubId:         clubId,
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
      size="wide"
      mobileInteraction="draggable"
      mobileBackdropZ={60}
      mobilePanelZ={70}
      label="Edit Event"
      header={
        <div className="flex items-center justify-between">
          <p className="text-base font-semibold text-gray-900 dark:text-gray-100">Edit Event</p>
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

        {hasLoadError && (
          <div className="rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700 px-4 py-3">
            <p className="text-sm font-medium text-red-800 dark:text-red-300">
              This event&rsquo;s data couldn&rsquo;t be loaded completely.
            </p>
            <p className="text-xs text-red-700 dark:text-red-400 mt-0.5">
              Missing: {missingFields.join(", ")}. Close this sheet and try
              again — saving is disabled until the full event loads.
            </p>
          </div>
        )}

        {isProgramSession && (
          <div className="rounded-xl bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-700 px-4 py-3">
            <p className="text-sm font-medium text-blue-800 dark:text-blue-300">
              Editing this session only
            </p>
            <p className="text-xs text-blue-700 dark:text-blue-400 mt-0.5">
              This is one occurrence of a recurring program. Title, event type,
              and description come from the program and can&rsquo;t be changed
              here — only this session&rsquo;s date, time, courts, and capacity.
            </p>
          </div>
        )}

        {staleConflict && (
          <div className="rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 px-4 py-3">
            <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
              This event was changed by someone else.
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

        {/* Event type — standalone only */}
        {!isProgramSession && (
          <div>
            <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">Event Type</label>
            <div className="flex flex-wrap gap-2 pt-2">
              {eventTypes.map(type => (
                <button
                  key={type.id}
                  type="button"
                  onClick={() => setEventTypeId(type.id)}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors active:scale-95 ${
                    eventTypeId === type.id
                      ? "text-white border-transparent"
                      : "bg-white text-gray-600 border-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:border-gray-600 hover:border-accent hover:text-accent"
                  }`}
                  style={eventTypeId === type.id ? { background: type.color } : undefined}
                >
                  {type.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Title — standalone only */}
        {!isProgramSession && (
          <div>
            <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">Title</label>
            <input
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              className="ct-input mt-1.5 w-full rounded-xl border border-gray-200 px-4 py-3 text-base md:text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent bg-white dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100 motion-safe:transition-all motion-safe:duration-150"
            />
          </div>
        )}

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
            {DURATION_PRESETS.map(mins => (
              <button
                key={mins}
                type="button"
                role="radio"
                aria-checked={!isCustomDuration && durationMinutes === mins}
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
              role="radio"
              aria-checked={isCustomDuration}
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
                className="ct-input w-24 rounded-xl border border-gray-200 px-4 py-3 text-base md:text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent bg-white dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100 motion-safe:transition-all motion-safe:duration-150"
              />
              <span className="text-xs text-gray-500">min</span>
              {customDurationText.length > 0 && !customDurationValid && (
                <span className="text-xs text-red-500">Enter a whole number.</span>
              )}
            </div>
          )}
        </div>

        {/* Courts */}
        <div>
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">Courts</label>
          <div className="flex flex-wrap gap-2 pt-2">
            {courts.map(court => {
              const isSelected = courtIds.includes(court.id);
              return (
                <button
                  key={court.id}
                  type="button"
                  onClick={() => toggleCourt(court.id)}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors active:scale-95 ${
                    isSelected
                      ? "bg-accent text-white dark:text-gray-900 border-accent"
                      : "bg-white text-gray-600 border-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:border-gray-600 hover:border-accent hover:text-accent"
                  }`}
                >
                  {court.name}
                </button>
              );
            })}
          </div>
          {courtIds.length === 0 && (
            <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">Select at least one court.</p>
          )}
        </div>

        {/* Capacity */}
        <div>
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">Capacity</label>
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={capacityText}
            onChange={e => setCapacityText(e.target.value)}
            className="ct-input mt-1.5 w-24 rounded-xl border border-gray-200 px-4 py-3 text-base md:text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent bg-white dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100 motion-safe:transition-all motion-safe:duration-150"
          />
          {capacityText.length > 0 && !capacityValid && (
            <p className="mt-1 text-xs text-red-500">Enter a whole number of at least 1.</p>
          )}
        </div>

        {/* Description — standalone only */}
        {!isProgramSession && (
          <div>
            <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">Description (optional)</label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              rows={3}
              className="ct-input mt-1.5 w-full rounded-xl border border-gray-200 px-4 py-3 text-base md:text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent bg-white dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100 motion-safe:transition-all motion-safe:duration-150"
            />
          </div>
        )}

        {error && <p className="text-xs text-red-500">{error}</p>}

        <button
          disabled={!canSave}
          onClick={handleSave}
          className="w-full py-3 rounded-xl bg-accent text-white dark:text-gray-900 text-sm font-semibold disabled:opacity-40 hover:brightness-110 motion-safe:hover:-translate-y-0.5 motion-safe:hover:shadow-md active:scale-[0.98] motion-safe:active:translate-y-0 motion-safe:transition-all motion-safe:duration-150"
        >
          {submitting ? "Saving…" : "Save Changes"}
        </button>

      </div>
    </ResponsiveSheet>
  );
}
