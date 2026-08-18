"use client";

import { useState, useMemo, useTransition } from "react";
import { useRouter } from "next/navigation";
import ResponsiveSheet from "@/components/ResponsiveSheet";
import { localDateTimeToUTC } from "@/lib/timezone";
import {
  adminCreateMemberLessonAction,
  type ClubPro,
} from "@/app/(app)/lessons/actions";

// Phase 33D1: sourced from roster_members — includes claimed and
// no-account Members, mirroring CalendarShell's admin booking picker.
// Replaces the old profiles-only Member interface, which could never
// include a Member with no Court Time account.
interface RosterMemberOption {
  id:      string;
  name:    string;
  claimed: boolean;
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
  rosterMembers:        RosterMemberOption[];
  courts:               Court[];
  lessonTypes:          LessonType[];
  clubId:               string;
  clubTimezone:         string;
  preselectedMemberId?: string;
  // Phase 33G2: this sheet is now reused for both Admin (any Pro) and Pro
  // (self only) staff booking. A Pro caller never sees the "Choose a Pro"
  // step — the underlying admin_create_member_lesson RPC (0128) requires
  // p_pro_id = auth.uid() for a Pro caller, so proId is fixed to viewerId
  // and viewerName stands in for the pro-list lookup a Pro cannot make
  // (get_admin_club_pros/roster pro list remain admin-only).
  viewerRole:           "admin" | "pro";
  viewerId:             string;
  viewerName?:          string;
  // Phase 33G2: Calendar → Lesson prefill — when staff pick a court/time
  // slot on the Calendar, those values seed the schedule step instead of
  // defaulting to "today, 9:00 AM, first court". Still editable — this is
  // a prefill, not a lock. prefillStartsAt is an ISO instant (Calendar's
  // own slot grid is indexed relative to that day's dynamic operating
  // hours, not this sheet's fixed 5am–10pm TIME_SLOTS — an absolute
  // timestamp is the only representation both sides agree on; see
  // resolvePrefillSlot below for the conversion into this sheet's index).
  prefillCourtId?:      string;
  prefillStartsAt?:     string;
  onClose:              () => void;
}

const DEFAULT_DURATIONS = [30, 45, 60, 90];

type Step = "member" | "pro" | "schedule" | "details" | "review";

const TIME_SLOTS = (() => {
  const slots: { hour: number; minute: number; label: string }[] = [];
  for (let h = 5; h <= 22; h++) {
    for (const m of [0, 30]) {
      if (h === 22 && m === 30) break;
      const h12  = h % 12 || 12;
      const ampm = h < 12 ? "AM" : "PM";
      slots.push({ hour: h, minute: m, label: `${h12}:${m === 0 ? "00" : "30"} ${ampm}` });
    }
  }
  return slots;
})();

function getName(first: string | null, last: string | null, fallback: string) {
  return [first, last].filter(Boolean).join(" ") || fallback;
}

// Converts an absolute Calendar-selected instant into this sheet's own
// date string + TIME_SLOTS index (5:00 AM–10:00 PM, 30-min granularity),
// clamping into range and snapping to the nearer half-hour so an
// off-grid instant still lands on a valid, close TIME_SLOTS entry.
function resolvePrefillSlot(iso: string, timeZone: string): { dateStr: string; slotIdx: number } | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;

  const dateStr = d.toLocaleDateString("en-CA", { timeZone });
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d);
  const rawHour = Number(parts.find(p => p.type === "hour")?.value ?? "0") % 24;
  const minute  = Number(parts.find(p => p.type === "minute")?.value ?? "0");

  const hour       = Math.min(22, Math.max(5, rawHour));
  const snappedMin = hour === 22 ? 0 : (minute < 30 ? 0 : 30);
  const idx        = (hour - 5) * 2 + (snappedMin === 30 ? 1 : 0);

  return { dateStr, slotIdx: Math.max(0, Math.min(TIME_SLOTS.length - 1, idx)) };
}

export default function AdminRequestLessonSheet({
  pros,
  rosterMembers,
  courts,
  lessonTypes,
  clubId,
  clubTimezone,
  preselectedMemberId,
  viewerRole,
  viewerId,
  viewerName,
  prefillCourtId,
  prefillStartsAt,
  onClose,
}: Props) {
  const router = useRouter();

  const skipMemberSelect = !!preselectedMemberId;
  // A Pro always books themselves — the "Choose a Pro" step never applies.
  const skipProSelect    = viewerRole === "pro";
  const firstStep: Step  = skipMemberSelect ? (skipProSelect ? "schedule" : "pro") : "member";
  const prefillSlot      = prefillStartsAt ? resolvePrefillSlot(prefillStartsAt, clubTimezone) : null;

  const [rosterMemberId, setRosterMemberId] = useState(preselectedMemberId ?? "");
  const [memberSearch, setMemberSearch]   = useState("");
  const [proId, setProId]                 = useState(skipProSelect ? viewerId : "");
  const [lessonTypeId, setLessonTypeId]   = useState("");
  const [duration, setDuration]           = useState(60);
  const [courtId, setCourtId]             = useState<string>(prefillCourtId ?? courts[0]?.id ?? "");
  const [dateStr, setDateStr]             = useState<string>(() =>
    prefillSlot?.dateStr ?? new Date().toLocaleDateString("en-CA", { timeZone: clubTimezone })
  );
  const [slotIdx, setSlotIdx]             = useState(prefillSlot?.slotIdx ?? 8); // default 9:00 AM
  const [memberNote, setMemberNote]       = useState("");
  const [error, setError]                 = useState("");
  const [step, setStep]                   = useState<Step>(firstStep);
  const [isPending, startTransition]      = useTransition();

  const selectedMember = rosterMembers.find(m => m.id === rosterMemberId);
  const selectedPro    = pros.find(p => p.id === proId);
  const selectedType   = lessonTypes.find(lt => lt.id === lessonTypeId);
  const selectedCourt  = courts.find(c => c.id === courtId);

  const memberName = selectedMember ? selectedMember.name : "";
  const proName    = skipProSelect
    ? (viewerName ?? "You")
    : (selectedPro ? getName(selectedPro.first_name, selectedPro.last_name, "Provider") : "");

  const filteredMembers = memberSearch.trim()
    ? rosterMembers.filter(m => m.name.toLowerCase().includes(memberSearch.trim().toLowerCase()))
    : rosterMembers;

  // Durations for selected lesson type, or defaults
  const availableDurations: number[] =
    selectedType?.allowed_durations?.length
      ? selectedType.allowed_durations
      : DEFAULT_DURATIONS;

  const startsAt = useMemo(() => {
    const slot = TIME_SLOTS[slotIdx];
    return localDateTimeToUTC(dateStr, slot.hour, slot.minute, clubTimezone);
  }, [dateStr, slotIdx, clubTimezone]);

  const endsAt = useMemo(
    () => new Date(startsAt.getTime() + duration * 60_000),
    [startsAt, duration]
  );

  const endLabel = endsAt.toLocaleTimeString("en-US", {
    timeZone: clubTimezone, hour: "numeric", minute: "2-digit", hour12: true,
  });

  // Reset duration when the available set changes and current value is not in it
  function handleTypeChange(id: string) {
    setLessonTypeId(id);
    const lt = lessonTypes.find(l => l.id === id);
    const allowed = lt?.allowed_durations?.length ? lt.allowed_durations : DEFAULT_DURATIONS;
    if (!allowed.includes(duration)) setDuration(allowed[0] ?? 60);
  }

  function handleBack() {
    setError("");
    if (step === "pro")           { if (!skipMemberSelect) setStep("member"); }
    else if (step === "schedule") { if (!skipProSelect) setStep("pro"); else if (!skipMemberSelect) setStep("member"); }
    else if (step === "details")  setStep("schedule");
    else if (step === "review")   setStep("details");
  }

  function handleSubmit() {
    setError("");
    startTransition(async () => {
      const res = await adminCreateMemberLessonAction({
        rosterMemberId,
        proId,
        courtId,
        startsAt:      startsAt.toISOString(),
        endsAt:        endsAt.toISOString(),
        lessonTypeId:  lessonTypeId || null,
        memberNote:    memberNote.trim() || null,
        expectedClubId: clubId,
      });
      if (res.error) { setError(res.error); return; }
      router.refresh();
      onClose();
    });
  }

  const showBack = step !== firstStep;

  return (
    <ResponsiveSheet
      onClose={onClose}
      variant="modal"
      size="wide"
      mobileInteraction="draggable"
      label="Book Lesson"
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
            Book Lesson
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
          <input
            type="text"
            value={memberSearch}
            onChange={e => setMemberSearch(e.target.value)}
            placeholder="Search members…"
            className="w-full ct-input text-base md:text-sm mb-2"
          />
          {filteredMembers.length === 0 ? (
            <p className="text-sm text-gray-400 py-4 text-center">No members found.</p>
          ) : (
            filteredMembers.map(m => (
              <button
                key={m.id}
                onClick={() => { setRosterMemberId(m.id); setStep(skipProSelect ? "schedule" : "pro"); }}
                className="w-full text-left ct-card px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700/40 active:bg-gray-100 dark:active:bg-gray-700 motion-safe:transition-colors motion-safe:duration-100 flex items-center justify-between gap-2"
              >
                <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{m.name}</p>
                {!m.claimed && (
                  <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400">
                    No account yet
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      )}

      {/* Step: pro */}
      {step === "pro" && !skipProSelect && (
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
                onClick={() => { setProId(p.id); setStep("schedule"); }}
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

      {/* Step: schedule — date, time, duration, court */}
      {step === "schedule" && (
        <div className="space-y-4">
          {lessonTypes.length > 0 && (
            <div>
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

          <div>
            <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1.5">
              Duration
            </label>
            <div className="grid grid-cols-4 gap-2">
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
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1.5">
              Date
            </label>
            <input
              type="date"
              value={dateStr}
              onChange={e => setDateStr(e.target.value)}
              min={new Date().toLocaleDateString("en-CA", { timeZone: clubTimezone })}
              className="w-full ct-input text-base md:text-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1.5">
              Start time
            </label>
            <select
              value={slotIdx}
              onChange={e => setSlotIdx(Number(e.target.value))}
              className="w-full ct-input text-base md:text-sm"
            >
              {TIME_SLOTS.map((s, i) => (
                <option key={i} value={i}>{s.label}</option>
              ))}
            </select>
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
              Ends at {endLabel} ({duration} min)
            </p>
          </div>

          {courts.length > 0 && (
            <div>
              <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1.5">
                Court
              </label>
              <select
                value={courtId}
                onChange={e => setCourtId(e.target.value)}
                className="w-full ct-input text-base md:text-sm"
              >
                {courts.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
          )}

          <p className="text-xs text-gray-400 dark:text-gray-500">
            Check the court schedule before booking.{" "}
            <a
              href={`/calendar?date=${dateStr}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 dark:text-blue-400 underline"
            >
              View court availability ↗
            </a>
          </p>

          <button
            onClick={() => setStep("details")}
            disabled={!courtId}
            className="w-full bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 rounded-xl py-3 text-sm font-semibold disabled:opacity-50"
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
              Note (optional)
            </label>
            <p className="text-xs text-gray-400 dark:text-gray-500 mb-1.5">
              Visible to the Pro{selectedMember?.claimed ? " and member" : ""}.
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
      {step === "review" && selectedMember && (selectedPro || skipProSelect) && (
        <div className="space-y-4">
          <div className="ct-card divide-y divide-gray-100 dark:divide-gray-800 overflow-hidden">
            <div className="px-4 py-2.5 flex justify-between items-center text-sm">
              <span className="text-gray-500 dark:text-gray-400">Member</span>
              <span className="flex items-center gap-1.5 font-medium text-gray-900 dark:text-gray-100">
                {memberName}
                {!selectedMember.claimed && (
                  <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400">
                    No account yet
                  </span>
                )}
              </span>
            </div>
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
              <span className="text-gray-500 dark:text-gray-400">When</span>
              <span className="font-medium text-gray-900 dark:text-gray-100">
                {startsAt.toLocaleString("en-US", {
                  timeZone: clubTimezone, month: "short", day: "numeric",
                  hour: "numeric", minute: "2-digit", hour12: true,
                })} – {endLabel}
              </span>
            </div>
            {selectedCourt && (
              <div className="px-4 py-2.5 flex justify-between text-sm">
                <span className="text-gray-500 dark:text-gray-400">Court</span>
                <span className="font-medium text-gray-900 dark:text-gray-100">{selectedCourt.name}</span>
              </div>
            )}
            {memberNote.trim() && (
              <div className="px-4 py-2.5 text-sm">
                <p className="text-gray-500 dark:text-gray-400 mb-1">Note</p>
                <p className="text-gray-900 dark:text-gray-100 text-xs">{memberNote.trim()}</p>
              </div>
            )}
          </div>

          <p className="text-xs text-gray-400 dark:text-gray-500">
            This books a confirmed lesson immediately — no negotiation step.
          </p>

          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

          <button
            onClick={handleSubmit}
            disabled={isPending}
            className="w-full bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 rounded-xl py-3 text-sm font-semibold disabled:opacity-50 active:scale-[0.98] motion-safe:transition-all motion-safe:duration-150"
          >
            {isPending ? "Booking…" : "Book Lesson"}
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
