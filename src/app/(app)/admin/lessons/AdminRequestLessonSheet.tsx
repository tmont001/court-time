"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import ResponsiveSheet from "@/components/ResponsiveSheet";
import {
  adminCreateLessonRequestAction,
  type ClubPro,
} from "@/app/(app)/lessons/actions";

interface Member {
  id:         string;
  first_name: string | null;
  last_name:  string | null;
  email:      string | null;
}

interface Court {
  id:   string;
  name: string;
}

interface LessonType {
  id:                string;
  name:              string;
  allowed_durations: number[] | null;
}

interface Props {
  pros:                 ClubPro[];
  members:              Member[];
  courts:               Court[];
  lessonTypes:          LessonType[];
  clubId:               string;
  preselectedMemberId?: string;
  onClose:              () => void;
}

const DEFAULT_DURATIONS = [30, 45, 60, 90];

type Step = "member" | "pro" | "duration" | "details" | "review";

function getName(first: string | null, last: string | null, fallback: string) {
  return [first, last].filter(Boolean).join(" ") || fallback;
}

export default function AdminRequestLessonSheet({
  pros,
  members,
  courts,
  lessonTypes,
  clubId,
  preselectedMemberId,
  onClose,
}: Props) {
  const router = useRouter();

  const [memberId, setMemberId]           = useState(preselectedMemberId ?? "");
  const [proId, setProId]                 = useState("");
  const [lessonTypeId, setLessonTypeId]   = useState("");
  const [duration, setDuration]           = useState(60);
  const [preferredCourtId, setPreferredCourtId] = useState("");
  const [windows, setWindows]             = useState("");
  const [memberNote, setMemberNote]       = useState("");
  const [error, setError]                 = useState("");
  const [step, setStep]                   = useState<Step>(preselectedMemberId ? "pro" : "member");
  const [isPending, startTransition]      = useTransition();

  const skipMemberSelect = !!preselectedMemberId;

  const selectedMember = members.find(m => m.id === memberId);
  const selectedPro    = pros.find(p => p.id === proId);
  const selectedType   = lessonTypes.find(lt => lt.id === lessonTypeId);
  const selectedCourt  = courts.find(c => c.id === preferredCourtId);

  const memberName = selectedMember ? getName(selectedMember.first_name, selectedMember.last_name, "Member") : "";
  const proName    = selectedPro    ? getName(selectedPro.first_name, selectedPro.last_name, "Provider")       : "";

  // Durations for selected lesson type, or defaults
  const availableDurations: number[] =
    selectedType?.allowed_durations?.length
      ? selectedType.allowed_durations
      : DEFAULT_DURATIONS;

  // Reset duration when the available set changes and current value is not in it
  function handleTypeChange(id: string) {
    setLessonTypeId(id);
    const lt = lessonTypes.find(l => l.id === id);
    const allowed = lt?.allowed_durations?.length ? lt.allowed_durations : DEFAULT_DURATIONS;
    if (!allowed.includes(duration)) setDuration(allowed[0] ?? 60);
  }

  function handleBack() {
    setError("");
    if (step === "pro")      { if (!skipMemberSelect) setStep("member"); }
    else if (step === "duration") setStep("pro");
    else if (step === "details")  setStep("duration");
    else if (step === "review")   setStep("details");
  }

  function handleSubmit() {
    setError("");
    startTransition(async () => {
      const res = await adminCreateLessonRequestAction({
        memberId,
        proId,
        durationMinutes:  duration,
        lessonTypeId:     lessonTypeId || null,
        preferredCourtId: preferredCourtId || null,
        memberNote:       memberNote.trim() || null,
        preferredWindows: windows.trim()
          ? { freeform: windows.trim() } as Record<string, unknown>
          : null,
        expectedClubId: clubId,
      });
      if (res.error) { setError(res.error); return; }
      router.refresh();
      onClose();
    });
  }

  const showBack = !(step === "member" && !skipMemberSelect) && !(step === "pro" && skipMemberSelect);

  return (
    <ResponsiveSheet
      onClose={onClose}
      variant="modal"
      size="wide"
      mobileInteraction="draggable"
      label="Create Lesson Request"
      header={
        <div className="relative flex items-center justify-center">
          {showBack && (
            <button
              onClick={handleBack}
              className="absolute left-0 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              ← Back
            </button>
          )}
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            Create Lesson Request
          </h2>
          <button onClick={onClose} className="absolute right-0 text-sm text-gray-400 md:hidden" aria-label="Close">✕</button>
        </div>
      }
    >
      {/* Step: member */}
      {step === "member" && !skipMemberSelect && (
        <div className="space-y-2">
          <p className="text-xs text-gray-500 dark:text-gray-400 uppercase font-semibold tracking-wide mb-3">
            Select member
          </p>
          {members.length === 0 ? (
            <p className="text-sm text-gray-400 py-4 text-center">No active members.</p>
          ) : (
            members.map(m => (
              <button
                key={m.id}
                onClick={() => { setMemberId(m.id); setStep("pro"); }}
                className="w-full text-left ct-card px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700/40 active:bg-gray-100 dark:active:bg-gray-700 motion-safe:transition-colors motion-safe:duration-100"
              >
                <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                  {getName(m.first_name, m.last_name, "Member")}
                </p>
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">{m.email ?? "—"}</p>
              </button>
            ))
          )}
        </div>
      )}

      {/* Step: pro */}
      {step === "pro" && (
        <div className="space-y-2">
          {skipMemberSelect && memberName && (
            <div className="ct-card px-4 py-2.5 mb-3">
              <p className="text-xs text-gray-400 dark:text-gray-500 mb-0.5">Member</p>
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{memberName}</p>
            </div>
          )}
          <p className="text-xs text-gray-500 dark:text-gray-400 uppercase font-semibold tracking-wide mb-3">
            Choose a Pro
          </p>
          {pros.length === 0 ? (
            <p className="text-sm text-gray-400 py-4 text-center">No Pros available.</p>
          ) : (
            pros.map(p => (
              <button
                key={p.id}
                onClick={() => { setProId(p.id); setStep("duration"); }}
                className="w-full text-left ct-card px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700/40 active:bg-gray-100 dark:active:bg-gray-700 motion-safe:transition-colors motion-safe:duration-100"
              >
                <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                  {getName(p.first_name, p.last_name, "Pro")}
                </p>
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5 capitalize">{p.role}</p>
              </button>
            ))
          )}
        </div>
      )}

      {/* Step: duration */}
      {step === "duration" && (
        <div>
          {/* Lesson type (optional) */}
          {lessonTypes.length > 0 && (
            <div className="mb-4">
              <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1.5">
                Lesson type (optional)
              </label>
              <select
                value={lessonTypeId}
                onChange={e => handleTypeChange(e.target.value)}
                className="w-full ct-input text-base md:text-sm"
              >
                <option value="">No specific type</option>
                {lessonTypes.map(lt => (
                  <option key={lt.id} value={lt.id}>{lt.name}</option>
                ))}
              </select>
            </div>
          )}

          <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1.5">
            Duration
          </p>
          <div className="grid grid-cols-4 gap-2 mb-4">
            {availableDurations.map(d => (
              <button
                key={d}
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
          {courts.length > 0 && (
            <div>
              <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1.5">
                Preferred court (optional)
              </label>
              <select
                value={preferredCourtId}
                onChange={e => setPreferredCourtId(e.target.value)}
                className="w-full ct-input text-base md:text-sm"
              >
                <option value="">No preference</option>
                {courts.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1.5">
              Preferred times (optional)
            </label>
            <textarea
              value={windows}
              onChange={e => setWindows(e.target.value)}
              placeholder="e.g. Mon/Wed mornings, any weekday before noon"
              rows={2}
              maxLength={500}
              className="w-full ct-input text-base md:text-sm resize-none"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1.5">
              Shared request info for the Pro (optional)
            </label>
            <p className="text-xs text-gray-400 dark:text-gray-500 mb-1.5">
              Visible to the Pro and member. Do not include internal notes here.
            </p>
            <textarea
              value={memberNote}
              onChange={e => setMemberNote(e.target.value)}
              placeholder="e.g. Member is working on their serve, beginner level"
              rows={2}
              maxLength={500}
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
      {step === "review" && selectedMember && selectedPro && (
        <div className="space-y-4">
          <div className="ct-card divide-y divide-gray-100 dark:divide-gray-800 overflow-hidden">
            {!skipMemberSelect && (
              <div className="px-4 py-2.5 flex justify-between text-sm">
                <span className="text-gray-500 dark:text-gray-400">Member</span>
                <span className="font-medium text-gray-900 dark:text-gray-100">{memberName}</span>
              </div>
            )}
            <div className="px-4 py-2.5 flex justify-between text-sm">
              <span className="text-gray-500 dark:text-gray-400">Pro</span>
              <span className="font-medium text-gray-900 dark:text-gray-100">{proName}</span>
            </div>
            {selectedType && (
              <div className="px-4 py-2.5 flex justify-between text-sm">
                <span className="text-gray-500 dark:text-gray-400">Type</span>
                <span className="font-medium text-gray-900 dark:text-gray-100">{selectedType.name}</span>
              </div>
            )}
            <div className="px-4 py-2.5 flex justify-between text-sm">
              <span className="text-gray-500 dark:text-gray-400">Duration</span>
              <span className="font-medium text-gray-900 dark:text-gray-100">{duration} minutes</span>
            </div>
            {selectedCourt && (
              <div className="px-4 py-2.5 flex justify-between text-sm">
                <span className="text-gray-500 dark:text-gray-400">Preferred court</span>
                <span className="font-medium text-gray-900 dark:text-gray-100">{selectedCourt.name}</span>
              </div>
            )}
            {windows.trim() && (
              <div className="px-4 py-2.5 text-sm">
                <p className="text-gray-500 dark:text-gray-400 mb-1">Preferred times</p>
                <p className="text-gray-900 dark:text-gray-100 text-xs">{windows.trim()}</p>
              </div>
            )}
            {memberNote.trim() && (
              <div className="px-4 py-2.5 text-sm">
                <p className="text-gray-500 dark:text-gray-400 mb-1">Shared info for provider</p>
                <p className="text-gray-900 dark:text-gray-100 text-xs">{memberNote.trim()}</p>
              </div>
            )}
          </div>

          <p className="text-xs text-gray-400 dark:text-gray-500">
            This creates a pending request. The provider will propose a time for the member to accept.
          </p>

          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

          <button
            onClick={handleSubmit}
            disabled={isPending}
            className="w-full bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 rounded-xl py-3 text-sm font-semibold disabled:opacity-50 active:scale-[0.98] motion-safe:transition-all motion-safe:duration-150"
          >
            {isPending ? "Creating…" : "Create Request"}
          </button>
          <button
            onClick={onClose}
            className="w-full py-1 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 motion-safe:transition-colors motion-safe:duration-150"
          >
            Cancel
          </button>
        </div>
      )}
    </ResponsiveSheet>
  );
}
