"use client";

import { useState, useTransition } from "react";
import ResponsiveSheet from "@/components/ResponsiveSheet";
import PriceSummary from "@/components/PriceSummary";
import { formatLessonUnitPrice, calculateLessonTotalCents } from "@/lib/money";
import { submitLessonRequest } from "./actions";

interface Pro {
  id:         string;
  first_name: string | null;
  last_name:  string | null;
  role:       string;
}

interface Court {
  id:   string;
  name: string;
}

interface LessonType {
  id:                       string;
  name:                     string;
  allowed_durations:        number[] | null;
  pricing_basis:            "flat" | "hourly";
  unit_price_amount_cents:  number | null;
}

interface Props {
  pros:        Pro[];
  courts:      Court[];
  lessonTypes: LessonType[];
  currency:    string;
  clubId:      string;
  onClose:     () => void;
  onDone:      () => void;
}

const DURATIONS = [30, 45, 60, 90];

type Step = "pro" | "duration" | "details" | "review";

function proName(p: Pro): string {
  return [p.first_name, p.last_name].filter(Boolean).join(" ") || "Unnamed Pro";
}

export default function RequestLessonSheet({ pros, courts, lessonTypes, currency, clubId, onClose, onDone }: Props) {
  const [step, setStep] = useState<Step>("pro");
  const [selectedPro, setSelectedPro] = useState<Pro | null>(null);
  // Phase 34C consolidation: submit_lesson_request (0146) now requires a
  // Member self-service request to always name a priced Lesson Type — a
  // blank "No specific type" choice is no longer valid, so the default
  // selection is the first priced one available, never blank.
  const [lessonTypeId, setLessonTypeId] = useState<string>(() => {
    const firstPriced = lessonTypes.find(lt => lt.unit_price_amount_cents !== null);
    return firstPriced?.id ?? lessonTypes[0]?.id ?? "";
  });
  const [duration, setDuration] = useState<number>(60);
  const [preferredCourt, setPreferredCourt] = useState<string>("");
  const [note, setNote] = useState<string>("");
  const [windows, setWindows] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [isPending, startTransition] = useTransition();

  const selectedType = lessonTypes.find(lt => lt.id === lessonTypeId) ?? null;

  // Available durations narrow to the selected Lesson Type's own
  // allowed_durations when it has one — same domain rule enforced
  // everywhere else a Lesson Type restricts duration.
  const availableDurations: number[] =
    selectedType?.allowed_durations?.length ? selectedType.allowed_durations : DURATIONS;

  // A Lesson Type with unit_price_amount_cents = NULL means "not configured
  // yet" (distinct from a genuinely $0 Free type) — the Admin/Pro proposal
  // flow has no way to establish a price for it after the fact, so letting
  // a Member self-serve one would silently create a free lesson. Not
  // selectable as a normal online request.
  const selectedTypeUnpriced = selectedType !== null && selectedType.unit_price_amount_cents === null;
  // A Lesson Type is now mandatory for Member self-service (0146) — no
  // valid choice means either the club has none configured at all, or
  // (shouldn't happen given the default above) none is selected yet.
  const noLessonTypeAvailable = lessonTypes.length === 0;
  const canContinueFromDuration = !noLessonTypeAvailable && lessonTypeId !== "" && !selectedTypeUnpriced;

  function handleTypeChange(id: string) {
    setLessonTypeId(id);
    const lt = lessonTypes.find(l => l.id === id);
    const allowed = lt?.allowed_durations?.length ? lt.allowed_durations : DURATIONS;
    if (!allowed.includes(duration)) setDuration(allowed[0] ?? 60);
  }

  function handleBack() {
    setError("");
    if (step === "duration") setStep("pro");
    else if (step === "details") setStep("duration");
    else if (step === "review") setStep("details");
  }

  function handleSubmit() {
    if (!selectedPro) return;
    // Fail-safe: a Lesson Type is mandatory and must be priced, even if
    // stale UI state somehow reached this point.
    if (!lessonTypeId) {
      setError("Please choose a lesson type.");
      return;
    }
    if (selectedTypeUnpriced) {
      setError("This lesson type isn't priced online yet — contact the club directly to book it.");
      return;
    }
    setError("");
    startTransition(async () => {
      const result = await submitLessonRequest({
        p_pro_id:            selectedPro.id,
        p_duration_minutes:  duration,
        p_preferred_court_id: preferredCourt || null,
        p_member_note:       note.trim() || null,
        p_preferred_windows: windows.trim()
          ? { freeform: windows.trim() } as Record<string, unknown>
          : null,
        p_lesson_type_id: lessonTypeId || null,
        expectedClubId: clubId,
      });
      if (result.error) {
        setError(result.error);
        return;
      }
      onDone();
    });
  }

  return (
    <ResponsiveSheet
      onClose={onClose}
      variant="modal"
      mobileInteraction="draggable"
      label="Request a Lesson"
      header={
        <div className="relative flex items-center justify-center">
          {step !== "pro" && (
            <button
              onClick={handleBack}
              className="absolute left-0 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              ← Back
            </button>
          )}
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            Request a Lesson
          </h2>
          <button
            onClick={onClose}
            className="absolute right-0 text-sm text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 md:hidden"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
      }
    >
      {/* Step: choose pro */}
      {step === "pro" && (
        <div className="ct-content-settle space-y-2">
          <p className="text-xs text-gray-500 dark:text-gray-400 uppercase font-semibold tracking-wide mb-3">
            Choose a pro
          </p>
          {pros.length === 0 ? (
            <p className="text-sm text-gray-400 py-4 text-center">No pros available.</p>
          ) : (
            pros.map(p => (
              <button
                key={p.id}
                onClick={() => { setSelectedPro(p); setStep("duration"); }}
                className="w-full text-left ct-card px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700/40 active:bg-gray-100 dark:active:bg-gray-700 motion-safe:transition-colors motion-safe:duration-100"
              >
                <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                  {proName(p)}
                </p>
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5 capitalize">
                  {p.role}
                </p>
              </button>
            ))
          )}
        </div>
      )}

      {/* Step: choose duration */}
      {step === "duration" && (
        <div className="ct-content-settle">
          {noLessonTypeAvailable ? (
            <p className="text-xs text-amber-600 dark:text-amber-400 mb-4">
              No lesson types are available for online booking right now — contact the club directly.
            </p>
          ) : (
            <div className="mb-4">
              <p className="text-xs text-gray-500 dark:text-gray-400 uppercase font-semibold tracking-wide mb-3">
                Lesson type
              </p>
              <select
                value={lessonTypeId}
                onChange={e => handleTypeChange(e.target.value)}
                className="w-full ct-input text-base md:text-sm"
              >
                {lessonTypes.map(lt => (
                  <option key={lt.id} value={lt.id} disabled={lt.unit_price_amount_cents === null}>
                    {lt.unit_price_amount_cents === null
                      ? `${lt.name} — Contact the club for pricing`
                      : `${lt.name} — ${formatLessonUnitPrice(lt.pricing_basis, lt.unit_price_amount_cents, currency)}`}
                  </option>
                ))}
              </select>
            </div>
          )}

          {selectedTypeUnpriced && (
            <p className="text-xs text-amber-600 dark:text-amber-400 mb-4">
              This lesson type isn&apos;t priced online yet — contact the club directly to book it.
            </p>
          )}

          <p className="text-xs text-gray-500 dark:text-gray-400 uppercase font-semibold tracking-wide mb-3">
            Duration
          </p>
          <div className="grid grid-cols-4 gap-2 mb-4" role="radiogroup" aria-label="Duration">
            {availableDurations.map(d => (
              <button
                key={d}
                role="radio"
                aria-checked={duration === d}
                onClick={() => setDuration(d)}
                className={`py-3 rounded-xl text-sm font-semibold border-2 motion-safe:transition-all motion-safe:duration-100 ${
                  duration === d
                    ? "border-accent bg-accent/10 text-accent"
                    : "border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:border-accent/50"
                }`}
              >
                {d}m
              </button>
            ))}
          </div>

          {selectedType && (
            <PriceSummary
              label="Lesson price"
              amountCents={calculateLessonTotalCents(selectedType.pricing_basis, selectedType.unit_price_amount_cents, duration)}
              currency={currency}
              viewer="member"
              breakdown={
                selectedType.pricing_basis === "hourly"
                  ? `${formatLessonUnitPrice("hourly", selectedType.unit_price_amount_cents, currency)} × ${duration} min`
                  : selectedType.unit_price_amount_cents !== null ? "Flat lesson rate" : null
              }
              className="mb-4"
            />
          )}

          <button
            onClick={() => setStep("details")}
            disabled={!canContinueFromDuration}
            className="w-full bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 rounded-xl py-3 text-sm font-semibold disabled:opacity-50"
          >
            Continue
          </button>
        </div>
      )}

      {/* Step: details */}
      {step === "details" && (
        <div className="ct-content-settle space-y-4">
          <div>
            <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1.5">
              Preferred court (optional)
            </label>
            <select
              value={preferredCourt}
              onChange={e => setPreferredCourt(e.target.value)}
              className="w-full ct-input text-base md:text-sm"
            >
              <option value="">No preference</option>
              {courts.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1.5">
              Preferred times
            </label>
            <textarea
              value={windows}
              onChange={e => setWindows(e.target.value)}
              placeholder={"e.g. Mon/Wed mornings, or any weekday before noon"}
              rows={3}
              maxLength={500}
              className="w-full ct-input text-base md:text-sm resize-none"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1.5">
              Note / lesson goal (optional)
            </label>
            <textarea
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder="e.g. Working on my serve, beginner level"
              rows={2}
              maxLength={300}
              className="w-full ct-input text-base md:text-sm resize-none"
            />
          </div>

          <button
            onClick={() => setStep("review")}
            className="w-full bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 rounded-xl py-3 text-sm font-semibold"
          >
            Review
          </button>
        </div>
      )}

      {/* Step: review */}
      {step === "review" && selectedPro && (
        <div className="ct-content-settle space-y-4">
          <div className="ct-card divide-y divide-gray-100 dark:divide-gray-800 overflow-hidden">
            <div className="px-4 py-2.5 flex justify-between text-sm">
              <span className="text-gray-500 dark:text-gray-400">Pro</span>
              <span className="font-medium text-gray-900 dark:text-gray-100">{proName(selectedPro)}</span>
            </div>
            <div className="px-4 py-2.5 flex justify-between text-sm">
              <span className="text-gray-500 dark:text-gray-400">Duration</span>
              <span className="font-medium text-gray-900 dark:text-gray-100">{duration} minutes</span>
            </div>
            {selectedType && (
              <div className="px-4 py-2.5 flex justify-between text-sm">
                <span className="text-gray-500 dark:text-gray-400">Lesson type</span>
                <span className="font-medium text-gray-900 dark:text-gray-100">{selectedType.name}</span>
              </div>
            )}
            {preferredCourt && (
              <div className="px-4 py-2.5 flex justify-between text-sm">
                <span className="text-gray-500 dark:text-gray-400">Preferred court</span>
                <span className="font-medium text-gray-900 dark:text-gray-100">
                  {courts.find(c => c.id === preferredCourt)?.name ?? "—"}
                </span>
              </div>
            )}
            {windows.trim() && (
              <div className="px-4 py-2.5 text-sm">
                <p className="text-gray-500 dark:text-gray-400 mb-1">Preferred times</p>
                <p className="text-gray-900 dark:text-gray-100 text-xs">{windows.trim()}</p>
              </div>
            )}
            {note.trim() && (
              <div className="px-4 py-2.5 text-sm">
                <p className="text-gray-500 dark:text-gray-400 mb-1">Note</p>
                <p className="text-gray-900 dark:text-gray-100 text-xs">{note.trim()}</p>
              </div>
            )}
          </div>

          {selectedType && (
            <PriceSummary
              label="Lesson price"
              amountCents={calculateLessonTotalCents(selectedType.pricing_basis, selectedType.unit_price_amount_cents, duration)}
              currency={currency}
              viewer="member"
              breakdown={
                selectedType.pricing_basis === "hourly"
                  ? `${formatLessonUnitPrice("hourly", selectedType.unit_price_amount_cents, currency)} × ${duration} min`
                  : selectedType.unit_price_amount_cents !== null ? "Flat lesson rate" : null
              }
            />
          )}

          <p className="text-xs text-gray-400 dark:text-gray-500">
            This is a request, not a confirmed booking. The pro will review and confirm or propose a time.
          </p>

          {error && (
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          )}

          <button
            onClick={handleSubmit}
            disabled={isPending}
            className="w-full bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 rounded-xl py-3 text-sm font-semibold disabled:opacity-50"
          >
            {isPending ? "Submitting…" : "Submit Request"}
          </button>
        </div>
      )}
    </ResponsiveSheet>
  );
}
