"use client";

// CreateProgramSheet — Phase 27C create-program flow, extended in 27C.1 to
// also serve as the edit-draft flow (mode="edit"). Mirrors
// calendar/CreateEventSheet.tsx's multi-step ResponsiveSheet pattern
// (step header, back button, step titles, accent buttons, dark-mode
// classes) so Programs feels like a natural extension of the existing
// event-management surface rather than a new design language.
//
// Client-side validation (26-week range, capacity_override disabled for
// whole-program enrollment, each rule needs a court, no duplicate court in
// a rule, overlapping same-court rules) mirrors the server's own guards
// (0089/0090) for fast feedback — the server remains the final authority;
// every one of these is re-validated by create_program/update_program
// regardless of what passes here.
//
// Edit mode (27C.1): all fields and rules are prefilled from the program
// being edited (courts.map(c => c.id) reconstructs each rule's court
// selection from the getPrograms embed). Only reachable for a draft
// program with zero generated events — ProgramsManageClient/
// ProgramPreviewSheet are responsible for only ever offering "Edit Draft"
// in that state; update_program independently re-enforces it server-side
// (program_not_editable / program_already_generated).

import { useState, useEffect, useMemo } from "react";
import ResponsiveSheet from "@/components/ResponsiveSheet";
import { createClient } from "@/lib/supabase/client";
import { createProgram, updateProgram, type ProgramRow, type ProgramRulePayload, type ProgramListRow } from "./programsActions";
import { mapProgramError } from "./programErrors";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MAX_RANGE_DAYS = 182; // 26 weeks — mirrors create_program's own server-side ceiling.

// ─── Types ────────────────────────────────────────────────────────────────────

interface EventType {
  id:                       string;
  key:                      string;
  label:                    string;
  color:                    string;
  default_capacity:         number;
  default_duration_minutes: number;
}

interface Court {
  id:            string;
  name:          string;
  display_order: number;
}

type EnrollmentModel = "program" | "per_session" | "admin_managed";

interface RuleDraft {
  key:               string; // client-only id for React keys / removal, not sent to the server
  dayOfWeek:         number;
  startTime:         string; // "HH:MM"
  durationMinutes:   string; // raw input text while editing; coerced to a number at submit
  capacityOverride:  string; // raw input text; "" = no override
  courtIds:          string[];
}

interface Props {
  courts:          Court[];
  clubId:          string;
  clubTimezone:    string;
  onClose:         () => void;
  onSaved:         (program: ProgramRow) => void;
  // Omit (or "create") for the create flow. Pass "edit" + the program being
  // edited to prefill every field/rule and submit through update_program
  // instead of create_program.
  mode?:           "create" | "edit";
  editingProgram?: ProgramListRow;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

let ruleKeySeq = 0;
function newRuleKey(): string {
  ruleKeySeq += 1;
  return `rule-${ruleKeySeq}`;
}

function makeRule(): RuleDraft {
  return {
    key: newRuleKey(),
    dayOfWeek: 1,
    startTime: "09:00",
    durationMinutes: "60",
    capacityOverride: "",
    courtIds: [],
  };
}

function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

function rulesExactDuplicate(a: RuleDraft, b: RuleDraft): boolean {
  return a.dayOfWeek === b.dayOfWeek && a.startTime === b.startTime;
}

function rulesOverlap(a: RuleDraft, b: RuleDraft): boolean {
  if (a.dayOfWeek !== b.dayOfWeek) return false;
  if (!a.courtIds.some(id => b.courtIds.includes(id))) return false;
  const aStart = timeToMinutes(a.startTime);
  const aEnd   = aStart + Number(a.durationMinutes);
  const bStart = timeToMinutes(b.startTime);
  const bEnd   = bStart + Number(b.durationMinutes);
  return aStart < bEnd && bStart < aEnd; // half-open — adjacent windows never overlap
}

function daysBetween(startISO: string, endISO: string): number {
  const start = new Date(startISO + "T00:00:00Z").getTime();
  const end   = new Date(endISO + "T00:00:00Z").getTime();
  return Math.round((end - start) / 86_400_000);
}

// Rebuilds editable RuleDraft state from getPrograms' embedded shape
// (program_schedule_rules + their program_rule_courts, already joined
// server-side into ProgramListRow.rules[].courts).
function rulesFromProgram(program: ProgramListRow): RuleDraft[] {
  return program.rules.map(r => ({
    key: newRuleKey(),
    dayOfWeek: r.day_of_week,
    startTime: r.start_time.slice(0, 5), // "HH:MM:SS" -> "HH:MM" for <input type="time">
    durationMinutes: String(r.duration_minutes),
    capacityOverride: r.capacity_override != null ? String(r.capacity_override) : "",
    courtIds: r.courts.map(c => c.id),
  }));
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function CreateProgramSheet({
  courts, clubId, clubTimezone, onClose, onSaved, mode = "create", editingProgram,
}: Props) {
  const supabase = useMemo(() => createClient(), []);
  const isEdit = mode === "edit" && !!editingProgram;

  const [step, setStep]                 = useState<1 | 2 | 3>(1);
  const [eventTypes, setEventTypes]     = useState<EventType[]>([]);
  const [loadingTypes, setLoadingTypes] = useState(true);
  const [typesError, setTypesError]     = useState<string | null>(null);

  const todayISO = useMemo(
    () => new Date().toLocaleDateString("en-CA", { timeZone: clubTimezone }),
    [clubTimezone]
  );

  // Prefilled from editingProgram in edit mode; sensible create-mode
  // defaults otherwise. Function initializers so this only runs once per
  // mount — CreateProgramSheet is always freshly instantiated per open
  // (conditionally rendered by its parent), never kept mounted across a
  // create/edit target change.
  const [selectedTypeId, setSelectedTypeId]   = useState(() => editingProgram?.event_type?.id ?? "");
  const [title, setTitle]                     = useState(() => editingProgram?.title ?? "");
  const [description, setDescription]         = useState(() => editingProgram?.description ?? "");
  const [enrollmentModel, setEnrollmentModel] = useState<EnrollmentModel>(() => editingProgram?.enrollment_model ?? "per_session");
  const [startsOn, setStartsOn]               = useState(() => editingProgram?.starts_on ?? todayISO);
  const [endsOn, setEndsOn]                   = useState(() => editingProgram?.ends_on ?? todayISO);
  // Raw input text while editing (permits a temporarily empty field); coerced
  // to a number via defaultCapacityNum below, and clamped to >=1 at blur/submit.
  const [defaultCapacity, setDefaultCapacity] = useState(() => String(editingProgram?.default_capacity ?? 8));
  const [rules, setRules] = useState<RuleDraft[]>(() => editingProgram ? rulesFromProgram(editingProgram) : [makeRule()]);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError]           = useState<string | null>(null);

  useEffect(() => {
    supabase
      .from("event_types")
      .select("id, key, label, color, default_capacity, default_duration_minutes")
      .eq("club_id", clubId)
      .eq("is_active", true)
      .order("label")
      .then(({ data, error: fetchErr }) => {
        if (fetchErr) {
          setTypesError("Failed to load event types. Please close and try again.");
        } else {
          setEventTypes((data ?? []) as EventType[]);
        }
        setLoadingTypes(false);
      });
  }, [supabase, clubId]);

  // Capacity override is unavailable for whole-program enrollment — clear
  // any values already entered so a stale value can't sneak into the
  // payload if the model is switched back and forth.
  useEffect(() => {
    if (enrollmentModel === "program") {
      setRules(prev => prev.map(r => ({ ...r, capacityOverride: "" })));
    }
  }, [enrollmentModel]);

  // ── Derived validation ──────────────────────────────────────────────────

  const rangeDays  = daysBetween(startsOn, endsOn);
  const rangeValid = rangeDays >= 0 && rangeDays <= MAX_RANGE_DAYS;

  const defaultCapacityNum = Number(defaultCapacity);

  const ruleErrors = useMemo(() => {
    const errs: string[] = [];
    for (const r of rules) {
      if (r.courtIds.length === 0) {
        errs.push(`${DAY_NAMES[r.dayOfWeek]} ${r.startTime}: select at least one court.`);
      }
      const durationNum = Number(r.durationMinutes);
      if (r.durationMinutes.trim() === "" || !Number.isFinite(durationNum) || durationNum < 1) {
        errs.push(`${DAY_NAMES[r.dayOfWeek]} ${r.startTime}: enter a duration of at least 1 minute.`);
      }
    }
    for (let i = 0; i < rules.length; i++) {
      for (let j = i + 1; j < rules.length; j++) {
        if (rulesExactDuplicate(rules[i], rules[j])) {
          errs.push(`Two rules share the exact same day and start time (${DAY_NAMES[rules[i].dayOfWeek]} ${rules[i].startTime}).`);
        } else if (rulesOverlap(rules[i], rules[j])) {
          errs.push(`Two rules overlap on a shared court (${DAY_NAMES[rules[i].dayOfWeek]} ${rules[i].startTime} and ${rules[j].startTime}). Adjacent times are fine — overlapping ones aren't.`);
        }
      }
    }
    return errs;
  }, [rules]);

  const basicsValid = selectedTypeId !== "" && title.trim().length > 0 && rangeValid &&
    Number.isFinite(defaultCapacityNum) && defaultCapacityNum > 0;
  const rulesValid   = rules.length > 0 && ruleErrors.length === 0;

  // ── Rule editing ────────────────────────────────────────────────────────

  function addRule() {
    setRules(prev => [...prev, makeRule()]);
  }

  function removeRule(key: string) {
    setRules(prev => prev.filter(r => r.key !== key));
  }

  function updateRule(key: string, patch: Partial<RuleDraft>) {
    setRules(prev => prev.map(r => (r.key === key ? { ...r, ...patch } : r)));
  }

  function toggleCourtInRule(key: string, courtId: string) {
    setRules(prev => prev.map(r => {
      if (r.key !== key) return r;
      const has = r.courtIds.includes(courtId);
      return { ...r, courtIds: has ? r.courtIds.filter(id => id !== courtId) : [...r.courtIds, courtId] };
    }));
  }

  // ── Submit ──────────────────────────────────────────────────────────────

  async function handleSubmit() {
    if (!basicsValid || !rulesValid) return;
    setSubmitting(true);
    setError(null);

    const rulesPayload: ProgramRulePayload[] = rules.map(r => ({
      day_of_week:        r.dayOfWeek,
      start_time:         r.startTime,
      duration_minutes:   Math.max(1, Number(r.durationMinutes) || 1),
      capacity_override:  enrollmentModel === "program" || r.capacityOverride.trim() === ""
        ? null
        : Number(r.capacityOverride),
      court_ids: r.courtIds,
    }));

    const commonParams = {
      p_event_type_id:    selectedTypeId,
      p_title:             title.trim(),
      p_enrollment_model:  enrollmentModel,
      p_starts_on:         startsOn,
      p_ends_on:           endsOn,
      p_default_capacity:  Math.max(1, defaultCapacityNum || 1),
      p_rules:             rulesPayload,
      p_description:       description.trim() || null,
      expectedClubId:      clubId,
    };

    const { data, error: rpcError } = isEdit
      ? await updateProgram({ p_program_id: editingProgram!.id, ...commonParams })
      : await createProgram(commonParams);

    if (rpcError || !data) {
      setError(mapProgramError(rpcError?.code, rpcError?.message ?? ""));
      setSubmitting(false);
      return;
    }

    onSaved(data);
    onClose();
  }

  const stepTitles: Record<1 | 2 | 3, string> = {
    1: isEdit ? "Edit Program Details" : "Program Details",
    2: "Schedule Rules",
    3: isEdit ? "Confirm Changes" : "Confirm",
  };

  const inputClass =
    "mt-1.5 w-full rounded-xl border border-gray-200 px-4 py-3 text-base md:text-sm text-gray-900 placeholder-gray-400 " +
    "focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent bg-white dark:bg-gray-700 " +
    "dark:border-gray-600 dark:text-gray-100 motion-safe:transition-all motion-safe:duration-150";
  const labelClass = "text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide";

  return (
    <ResponsiveSheet onClose={onClose} variant="modal" size="wide">
      {/* Handle + header */}
      <div className="shrink-0 px-6 pt-5 pb-3">
        <div className="ct-handlebar mx-auto mb-4 md:hidden" />
        <div className="flex items-center justify-between md:pr-10">
          <div className="flex items-center gap-3">
            {step > 1 && (
              <button
                onClick={() => { setStep(s => (s - 1) as 1 | 2 | 3); setError(null); }}
                className="text-sm text-gray-500 dark:text-gray-400 hover:text-accent motion-safe:transition-colors motion-safe:duration-150"
              >
                ← Back
              </button>
            )}
            <p className="text-base font-semibold text-gray-900 dark:text-gray-100">{stepTitles[step]}</p>
          </div>
          <p className="text-xs text-gray-400 dark:text-gray-500">{step} of 3</p>
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-8">

        {/* ── Step 1: basics ─────────────────────────────────────────────── */}
        {step === 1 && (
          <div className="pt-1 space-y-5">
            <div>
              <label className={labelClass}>Event Type</label>
              {loadingTypes ? (
                <p className="text-sm text-gray-400 py-3">Loading…</p>
              ) : typesError ? (
                <p className="text-sm text-red-500 py-3">{typesError}</p>
              ) : eventTypes.length === 0 ? (
                <p className="text-sm text-gray-400 py-3">No active event types configured.</p>
              ) : (
                <div className="flex flex-wrap gap-2 pt-2" role="radiogroup" aria-label="Event Type">
                  {eventTypes.map(t => (
                    <button
                      key={t.id}
                      type="button"
                      role="radio"
                      aria-checked={selectedTypeId === t.id}
                      onClick={() => setSelectedTypeId(t.id)}
                      className={`px-3 py-1.5 rounded-full text-xs font-medium border motion-safe:transition-colors active:scale-95 ${
                        selectedTypeId === t.id
                          ? "text-white border-transparent"
                          : "bg-white text-gray-600 border-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:border-gray-600 hover:border-accent hover:text-accent"
                      }`}
                      style={selectedTypeId === t.id ? { background: t.color } : undefined}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div>
              <label className={labelClass}>Title</label>
              <input
                type="text"
                value={title}
                onChange={e => setTitle(e.target.value)}
                placeholder="e.g. Tuesday Night Clinic"
                className={inputClass}
              />
            </div>

            <div>
              <label className={labelClass}>Description (optional)</label>
              <textarea
                value={description}
                onChange={e => setDescription(e.target.value)}
                rows={2}
                className={inputClass}
              />
            </div>

            <div>
              <label className={labelClass}>Enrollment Model</label>
              <div className="flex flex-wrap gap-2 pt-2" role="radiogroup" aria-label="Enrollment Model">
                {([
                  { value: "program",        label: "Whole program" },
                  { value: "per_session",    label: "Per session" },
                  { value: "admin_managed",  label: "Admin managed" },
                ] as { value: EnrollmentModel; label: string }[]).map(opt => (
                  <button
                    key={opt.value}
                    type="button"
                    role="radio"
                    aria-checked={enrollmentModel === opt.value}
                    onClick={() => setEnrollmentModel(opt.value)}
                    className={`px-3 py-1.5 rounded-full text-xs font-medium border motion-safe:transition-colors active:scale-95 ${
                      enrollmentModel === opt.value
                        ? "bg-accent text-white dark:text-gray-900 border-accent"
                        : "bg-white text-gray-600 border-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:border-gray-600 hover:border-accent hover:text-accent"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                {enrollmentModel === "program" && "Members enroll once for the whole series (Phase 27D)."}
                {enrollmentModel === "per_session" && "Members join each generated session individually, same as a normal event."}
                {enrollmentModel === "admin_managed" && "Members cannot self-join — staff manage the roster for every session."}
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelClass}>Starts On</label>
                <input
                  type="date"
                  value={startsOn}
                  onChange={e => setStartsOn(e.target.value)}
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClass}>Ends On</label>
                <input
                  type="date"
                  value={endsOn}
                  onChange={e => setEndsOn(e.target.value)}
                  className={inputClass}
                />
              </div>
            </div>
            {!rangeValid && (
              <p className="text-xs text-red-500">
                {rangeDays < 0 ? "End date must be on or after the start date." : "Programs can span at most 26 weeks."}
              </p>
            )}

            <div>
              <label className={labelClass}>Default Capacity (spots per session)</label>
              <input
                type="number"
                min={1}
                value={defaultCapacity}
                onChange={e => setDefaultCapacity(e.target.value)}
                onBlur={() => {
                  const n = Number(defaultCapacity);
                  if (defaultCapacity.trim() === "" || !Number.isFinite(n) || n < 1) {
                    setDefaultCapacity("8");
                  }
                }}
                className={inputClass}
              />
            </div>

            <button
              disabled={!basicsValid}
              onClick={() => setStep(2)}
              className="w-full py-3 rounded-xl bg-accent text-white dark:text-gray-900 text-sm font-semibold disabled:opacity-40 hover:brightness-110 motion-safe:hover:-translate-y-0.5 motion-safe:hover:shadow-md active:scale-[0.98] motion-safe:active:translate-y-0 motion-safe:transition-all motion-safe:duration-150"
            >
              Continue
            </button>
          </div>
        )}

        {/* ── Step 2: schedule rules ─────────────────────────────────────── */}
        {step === 2 && (
          <div className="pt-1 space-y-4">
            {rules.map((r, idx) => (
              <div key={r.key} className="rounded-xl border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700/50 p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold text-gray-700 dark:text-gray-300">Rule {idx + 1}</p>
                  {rules.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeRule(r.key)}
                      className="text-xs text-red-500 hover:text-red-700 dark:hover:text-red-400"
                    >
                      Remove
                    </button>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={labelClass}>Day</label>
                    <select
                      value={r.dayOfWeek}
                      onChange={e => updateRule(r.key, { dayOfWeek: Number(e.target.value) })}
                      className={inputClass}
                    >
                      {DAY_NAMES.map((name, i) => (
                        <option key={i} value={i}>{name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className={labelClass}>Start Time</label>
                    <input
                      type="time"
                      value={r.startTime}
                      onChange={e => updateRule(r.key, { startTime: e.target.value })}
                      className={inputClass}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={labelClass}>Duration (min)</label>
                    <input
                      type="number"
                      min={1}
                      value={r.durationMinutes}
                      onChange={e => updateRule(r.key, { durationMinutes: e.target.value })}
                      onBlur={() => {
                        const n = Number(r.durationMinutes);
                        if (r.durationMinutes.trim() === "" || !Number.isFinite(n) || n < 1) {
                          updateRule(r.key, { durationMinutes: "60" });
                        }
                      }}
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>
                      Capacity Override {enrollmentModel === "program" && <span className="normal-case font-normal">(unavailable)</span>}
                    </label>
                    <input
                      type="number"
                      min={1}
                      disabled={enrollmentModel === "program"}
                      value={r.capacityOverride}
                      onChange={e => updateRule(r.key, { capacityOverride: e.target.value })}
                      placeholder={defaultCapacity || "8"}
                      className={`${inputClass} disabled:opacity-40 disabled:cursor-not-allowed`}
                    />
                  </div>
                </div>

                <div>
                  <label className={labelClass}>Courts</label>
                  <div className="flex flex-wrap gap-2 pt-2" role="group" aria-label="Courts">
                    {courts.map(court => {
                      const isSelected = r.courtIds.includes(court.id);
                      return (
                        <button
                          key={court.id}
                          type="button"
                          aria-pressed={isSelected}
                          onClick={() => toggleCourtInRule(r.key, court.id)}
                          className={`px-3 py-1.5 rounded-full text-xs font-medium border motion-safe:transition-colors active:scale-95 ${
                            isSelected
                              ? "bg-accent text-white dark:text-gray-900 border-accent"
                              : "bg-white text-gray-600 border-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-600 hover:border-accent hover:text-accent"
                          }`}
                        >
                          {court.name}
                        </button>
                      );
                    })}
                  </div>
                  {r.courtIds.length === 0 && (
                    <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">Select at least one court.</p>
                  )}
                </div>
              </div>
            ))}

            <button
              type="button"
              onClick={addRule}
              className="w-full py-2.5 rounded-xl border border-dashed border-gray-300 dark:border-gray-600 text-xs font-medium text-gray-500 dark:text-gray-400 hover:border-accent hover:text-accent motion-safe:transition-colors"
            >
              + Add another rule
            </button>

            {ruleErrors.length > 0 && (
              <div className="rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-900/40 px-4 py-3 space-y-1">
                {ruleErrors.map((e, i) => (
                  <p key={i} className="text-xs text-red-600 dark:text-red-400">{e}</p>
                ))}
              </div>
            )}

            <button
              disabled={!rulesValid}
              onClick={() => { setError(null); setStep(3); }}
              className="w-full py-3 rounded-xl bg-accent text-white dark:text-gray-900 text-sm font-semibold disabled:opacity-40 hover:brightness-110 motion-safe:hover:-translate-y-0.5 motion-safe:hover:shadow-md active:scale-[0.98] motion-safe:active:translate-y-0 motion-safe:transition-all motion-safe:duration-150"
            >
              Continue
            </button>
          </div>
        )}

        {/* ── Step 3: confirm ────────────────────────────────────────────── */}
        {step === 3 && (
          <div className="pt-1 space-y-5">
            <div className="rounded-xl bg-gray-50 dark:bg-gray-700/50 border border-gray-100 dark:border-gray-700 px-4 py-3 space-y-2">
              <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{title.trim()}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {startsOn} – {endsOn} · {defaultCapacity} spot{defaultCapacityNum !== 1 ? "s" : ""} ·{" "}
                {enrollmentModel === "program" ? "Whole program" : enrollmentModel === "per_session" ? "Per session" : "Admin managed"}
              </p>
              <div className="pt-1 space-y-1">
                {rules.map(r => (
                  <p key={r.key} className="text-xs text-gray-600 dark:text-gray-300">
                    {DAY_NAMES[r.dayOfWeek]} {r.startTime} · {r.durationMinutes} min ·{" "}
                    {r.courtIds.map(id => courts.find(c => c.id === id)?.name ?? "Court").join(", ")}
                    {r.capacityOverride.trim() && ` · cap ${r.capacityOverride.trim()}`}
                  </p>
                ))}
              </div>
            </div>

            <p className="text-xs text-gray-500 dark:text-gray-400">
              {isEdit
                ? "This replaces the program's schedule rules and court assignments. It's only possible while the draft has no generated sessions."
                : "This creates the program as a draft. No sessions are generated yet — you’ll review and confirm a preview next."}
            </p>

            {error && <p className="text-xs text-red-500">{error}</p>}

            <button
              disabled={submitting || !basicsValid || !rulesValid}
              onClick={handleSubmit}
              className="w-full py-3 rounded-xl bg-accent text-white dark:text-gray-900 text-sm font-semibold disabled:opacity-40 hover:brightness-110 motion-safe:hover:-translate-y-0.5 motion-safe:hover:shadow-md active:scale-[0.98] motion-safe:active:translate-y-0 motion-safe:transition-all motion-safe:duration-150"
            >
              {submitting ? (isEdit ? "Saving…" : "Creating…") : (isEdit ? "Save Changes" : "Create Program")}
            </button>
          </div>
        )}

      </div>
    </ResponsiveSheet>
  );
}
