"use client";

import { useState, useTransition } from "react";
import ResponsiveSheet from "@/components/ResponsiveSheet";
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

interface Props {
  pros:    Pro[];
  courts:  Court[];
  clubId:  string;
  onClose: () => void;
  onDone:  () => void;
}

const DURATIONS = [30, 45, 60, 90];

type Step = "pro" | "duration" | "details" | "review";

function proName(p: Pro): string {
  return [p.first_name, p.last_name].filter(Boolean).join(" ") || "Unnamed Pro";
}

export default function RequestLessonSheet({ pros, courts, clubId, onClose, onDone }: Props) {
  const [step, setStep] = useState<Step>("pro");
  const [selectedPro, setSelectedPro] = useState<Pro | null>(null);
  const [duration, setDuration] = useState<number>(60);
  const [preferredCourt, setPreferredCourt] = useState<string>("");
  const [note, setNote] = useState<string>("");
  const [windows, setWindows] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [isPending, startTransition] = useTransition();

  function handleBack() {
    setError("");
    if (step === "duration") setStep("pro");
    else if (step === "details") setStep("duration");
    else if (step === "review") setStep("details");
  }

  function handleSubmit() {
    if (!selectedPro) return;
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
    <ResponsiveSheet onClose={onClose} variant="modal">
      <div className="px-4 pt-5 pb-8 overflow-y-auto flex-1">
      {/* Header */}
      <div className="relative flex items-center justify-center mb-4">
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

      {/* Step: choose pro */}
      {step === "pro" && (
        <div className="space-y-2">
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
        <div>
          <p className="text-xs text-gray-500 dark:text-gray-400 uppercase font-semibold tracking-wide mb-3">
            Duration
          </p>
          <div className="grid grid-cols-4 gap-2 mb-4" role="radiogroup" aria-label="Duration">
            {DURATIONS.map(d => (
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
          <button
            onClick={() => setStep("details")}
            className="w-full bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 rounded-xl py-3 text-sm font-semibold"
          >
            Continue
          </button>
        </div>
      )}

      {/* Step: details */}
      {step === "details" && (
        <div className="space-y-4">
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
        <div className="space-y-4">
          <div className="ct-card divide-y divide-gray-100 dark:divide-gray-800 overflow-hidden">
            <div className="px-4 py-2.5 flex justify-between text-sm">
              <span className="text-gray-500 dark:text-gray-400">Pro</span>
              <span className="font-medium text-gray-900 dark:text-gray-100">{proName(selectedPro)}</span>
            </div>
            <div className="px-4 py-2.5 flex justify-between text-sm">
              <span className="text-gray-500 dark:text-gray-400">Duration</span>
              <span className="font-medium text-gray-900 dark:text-gray-100">{duration} minutes</span>
            </div>
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
      </div>
    </ResponsiveSheet>
  );
}
