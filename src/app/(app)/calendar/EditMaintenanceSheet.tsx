"use client";

import { useState, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import ResponsiveSheet from "@/components/ResponsiveSheet";
import { updateMaintenanceBlock } from "./actions";
import { localDateTimeToUTC } from "@/lib/timezone";
import { STALE_CLUB_CONTEXT_ERROR, STALE_CLUB_MESSAGE } from "@/lib/staleClub";

// ─── Constants ────────────────────────────────────────────────────────────────

const DURATION_PRESETS = [30, 60, 90, 120, 240] as const;

// 30-min slots, 6:00 AM–9:30 PM start times — the server enforces no
// operating-hours restriction on maintenance blocks (matching
// create_maintenance_block(s)'s existing off-hours-friendly behavior); this
// list is only a reasonable selectable range, wide enough to always include
// an existing block's current start time.
const START_SLOTS = (() => {
  const slots: { hour: number; minute: number }[] = [];
  for (let h = 6; h <= 21; h++) {
    for (const m of [0, 30]) slots.push({ hour: h, minute: m });
  }
  return slots;
})();

// ─── Types ────────────────────────────────────────────────────────────────────

// Phase 30D: one individual maintenance reservation row. There is no
// durable multi-court group identity in this schema — editing always
// targets exactly this one row (see the Phase 30D audit). Adding another
// court remains Create Maintenance Block; removing a court remains
// cancelling that row.
interface EditableMaintenanceBlock {
  id:                     string;
  court_id:               string;
  starts_at:              string;
  ends_at:                string;
  notes:                  string | null;
  show_notes_to_members:  boolean;
  updated_at:             string;
}

interface Court {
  id:            string;
  name:          string;
  display_order: number;
}

interface Props {
  block:        EditableMaintenanceBlock;
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
  if (message === STALE_CLUB_CONTEXT_ERROR)            return STALE_CLUB_MESSAGE;
  if (message === "stale_edit_conflict")               return "This block was changed by someone else.";
  if (message === "reservation_not_found")             return "This maintenance block could not be found.";
  if (message === "reservation_not_editable")          return "Only confirmed maintenance blocks can be edited this way.";
  if (message === "insufficient_role")                 return "You don't have permission to edit this block.";
  if (message === "cannot_edit_started_reservation")   return "This block has already started and can no longer be edited.";
  if (message === "cannot_edit_to_past")                return "You can't move this block to a time in the past.";
  if (message === "invalid_duration")                  return "Choose a valid start time and end time.";
  if (message === "invalid_court")                     return "Select an active court.";
  if (code === "23P01")                                 return "That court already has a booking at the selected time.";
  return "Something went wrong. Please try again.";
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function EditMaintenanceSheet({
  block, courts, clubId, clubTimezone, onClose, onSaved,
}: Props) {
  const supabase = useMemo(() => createClient(), []);

  const initialHM = useMemo(
    () => getLocalHourMinute(block.starts_at, clubTimezone),
    [block.starts_at, clubTimezone]
  );
  const initialDuration = useMemo(
    () => durationOf(block.starts_at, block.ends_at),
    [block.starts_at, block.ends_at]
  );

  const [courtId, setCourtId]         = useState(block.court_id);
  const [dateStr, setDateStr]         = useState(() =>
    new Date(block.starts_at).toLocaleDateString("en-CA", { timeZone: clubTimezone })
  );
  const [startHour, setStartHour]     = useState(initialHM.hour);
  const [startMinute, setStartMinute] = useState(initialHM.minute);
  const [durationMinutes, setDurationMinutes]   = useState(initialDuration);
  const [isCustomDuration, setIsCustomDuration] = useState(
    !(DURATION_PRESETS as readonly number[]).includes(initialDuration)
  );
  const [customDurationText, setCustomDurationText] = useState(String(initialDuration));

  const [notes, setNotes]                       = useState(block.notes ?? "");
  const [showNotesToMembers, setShowNotesToMembers] = useState(block.show_notes_to_members);

  const [expectedUpdatedAt, setExpectedUpdatedAt] = useState(block.updated_at);
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
    () => new Date(startsAt.getTime() + durationMinutes * 60_000),
    [startsAt, durationMinutes]
  );
  const endTimeLabel = endsAt.toLocaleTimeString("en-US", {
    timeZone: clubTimezone, hour: "numeric", minute: "2-digit", hour12: true,
  });

  const customDurationValid = !isCustomDuration || (
    /^\d+$/.test(customDurationText.trim()) && parseInt(customDurationText.trim(), 10) > 0
  );

  const canSave = !submitting && !staleConflict && customDurationValid;

  // ── Handlers ──────────────────────────────────────────────────────────────

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
      .from("reservations")
      .select("id, court_id, starts_at, ends_at, notes, show_notes_to_members, updated_at")
      .eq("id", block.id)
      .single();
    setReloading(false);

    if (!data) {
      setError("This maintenance block could not be found.");
      return;
    }

    const hm = getLocalHourMinute(data.starts_at, clubTimezone);
    const freshDuration = durationOf(data.starts_at, data.ends_at);

    setCourtId(data.court_id);
    setDateStr(new Date(data.starts_at).toLocaleDateString("en-CA", { timeZone: clubTimezone }));
    setStartHour(hm.hour);
    setStartMinute(hm.minute);
    setDurationMinutes(freshDuration);
    setIsCustomDuration(!(DURATION_PRESETS as readonly number[]).includes(freshDuration));
    setCustomDurationText(String(freshDuration));
    setNotes(data.notes ?? "");
    setShowNotesToMembers(data.show_notes_to_members);
    setExpectedUpdatedAt(data.updated_at);
    setStaleConflict(false);
    setError(null);
  }

  async function handleSave() {
    if (!canSave) return;
    setSubmitting(true);
    setError(null);
    setStaleConflict(false);

    const { error: rpcError } = await updateMaintenanceBlock({
      p_reservation_id:        block.id,
      p_expected_updated_at:   expectedUpdatedAt,
      p_court_id:              courtId,
      p_starts_at:             startsAt.toISOString(),
      p_ends_at:               endsAt.toISOString(),
      p_notes:                 notes.trim() || null,
      p_show_notes_to_members: showNotesToMembers,
      expectedClubId:          clubId,
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
      label="Edit Block"
      header={
        <div className="flex items-center justify-between">
          <p className="text-base font-semibold text-gray-900 dark:text-gray-100">Edit Block</p>
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
              This block was changed by someone else.
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

        {/* Court — single-court identity. There is no group to grow or
            shrink here: adding another court is a new Create Maintenance
            Block; removing this court means cancelling this block. */}
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
                placeholder="e.g. 480"
                className="ct-input w-24 rounded-xl border border-gray-200 px-4 py-3 text-base md:text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent bg-white dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100 motion-safe:transition-all motion-safe:duration-150"
              />
              <span className="text-xs text-gray-500">min</span>
              {customDurationText.length > 0 && !customDurationValid && (
                <span className="text-xs text-red-500">Enter a whole number.</span>
              )}
            </div>
          )}
        </div>

        {/* Reason / notes */}
        <div>
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">Reason (optional)</label>
          <input
            type="text"
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="e.g. Resurfacing, Equipment repair"
            className="ct-input mt-1.5 w-full rounded-xl border border-gray-200 px-4 py-3 text-base md:text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent bg-white dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100 motion-safe:transition-all motion-safe:duration-150"
          />
        </div>

        {/* Show reason to members */}
        <div className="flex items-start gap-3">
          <input
            type="checkbox"
            id="edit-show-notes-to-members"
            checked={showNotesToMembers}
            onChange={e => setShowNotesToMembers(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-gray-300 accent-gray-900"
          />
          <div>
            <label
              htmlFor="edit-show-notes-to-members"
              className="text-xs font-medium text-gray-700 dark:text-gray-300 cursor-pointer"
            >
              Show this message to members
            </label>
            <p className="text-xs text-gray-400 mt-0.5">
              If enabled, members will see the reason on blocked court times.
            </p>
          </div>
        </div>

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
