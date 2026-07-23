"use client";

import { useState, useMemo, useTransition } from "react";
import { useRouter } from "next/navigation";
import ResponsiveSheet from "@/components/ResponsiveSheet";
import { localDateTimeToUTC } from "@/lib/timezone";
import {
  proposeLessonTime,
  declineLessonRequest,
  cancelLesson,
  reassignLessonProviderAction,
  type ProLessonRequestRow,
  type ClubPro,
} from "@/app/(app)/lessons/actions";

interface Court {
  id:   string;
  name: string;
}

interface Props {
  request:      ProLessonRequestRow;
  courts:       Court[];
  userId:       string;
  clubTimezone: string;
  userRole?:    string;
  pros?:        ClubPro[];
  initialMode?: "propose";
  onClose:      () => void;
}

type ActionMode = "propose" | "decline" | "cancel" | "reassign" | null;

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

function statusBadge(status: string) {
  const map: Record<string, string> = {
    pending:   "bg-amber-100 text-amber-700",
    proposed:  "bg-blue-100 text-blue-700",
    confirmed: "bg-green-100 text-green-700",
    declined:  "bg-red-100 text-red-700",
    withdrawn: "bg-gray-100 text-gray-500",
    cancelled: "bg-gray-100 text-gray-500",
  };
  const cls   = map[status] ?? "bg-gray-100 text-gray-500";
  const label = status.charAt(0).toUpperCase() + status.slice(1);
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold ${cls}`}>
      {label}
    </span>
  );
}

function fmt(iso: string, tz: string): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: tz,
    month:    "short",
    day:      "numeric",
    hour:     "numeric",
    minute:   "2-digit",
    hour12:   true,
  });
}

// ─── TimePicker ───────────────────────────────────────────────────────────────
// Lifted outside LessonProSheet so React treats it as a stable component and
// never unmounts it during state updates in the parent.

interface TimePickerProps {
  dateStr:      string;
  setDateStr:   (d: string) => void;
  slotIdx:      number;
  setSlotIdx:   (i: number) => void;
  courtId:      string;
  setCourtId:   (id: string) => void;
  courts:       Court[];
  endLabel:     string;
  durationMins: number;
  clubTimezone: string;
  error:        string;
  isPending:    boolean;
  submitLabel:  string;
  onSubmit:     () => void;
  onCancel:     () => void;
}

function TimePicker({
  dateStr, setDateStr, slotIdx, setSlotIdx, courtId, setCourtId,
  courts, endLabel, durationMins, clubTimezone, error, isPending,
  submitLabel, onSubmit, onCancel,
}: TimePickerProps) {
  return (
    <div className="space-y-4">
      <div>
        <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1.5">
          Date
        </label>
        <input
          type="date"
          value={dateStr}
          onChange={e => setDateStr(e.target.value)}
          min={new Date().toLocaleDateString("en-CA", { timeZone: clubTimezone })}
          className="w-full ct-input text-sm"
        />
      </div>

      <div>
        <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1.5">
          Start time
        </label>
        <select
          value={slotIdx}
          onChange={e => setSlotIdx(Number(e.target.value))}
          className="w-full ct-input text-sm"
        >
          {TIME_SLOTS.map((s, i) => (
            <option key={i} value={i}>{s.label}</option>
          ))}
        </select>
        <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
          Ends at {endLabel} ({durationMins} min)
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
            className="w-full ct-input text-sm"
          >
            {courts.map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
      )}

      <p className="text-xs text-gray-400 dark:text-gray-500">
        Check the court schedule before proposing a time.{" "}
        <a
          href={`/calendar?date=${dateStr || new Date().toLocaleDateString("en-CA", { timeZone: clubTimezone })}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-600 dark:text-blue-400 underline"
        >
          View court availability ↗
        </a>
      </p>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      <button
        onClick={onSubmit}
        disabled={isPending || !courtId}
        className="w-full bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 rounded-xl py-3 text-sm font-semibold hover:brightness-110 active:scale-[0.98] motion-safe:transition-all motion-safe:duration-150 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100"
      >
        {isPending ? "Saving…" : submitLabel}
      </button>
      <button
        onClick={onCancel}
        className="w-full py-1 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 motion-safe:transition-colors motion-safe:duration-150"
      >
        Cancel
      </button>
    </div>
  );
}

// ─── ReasonForm ───────────────────────────────────────────────────────────────
// Also lifted outside LessonProSheet for the same reason: function-inside-
// component causes remount on every keystroke, losing textarea focus.

interface ReasonFormProps {
  title:        string;
  submitLabel:  string;
  destructive:  boolean;
  reason:       string;
  setReason:    (r: string) => void;
  error:        string;
  isPending:    boolean;
  onSubmit:     () => void;
  onCancel:     () => void;
}

function ReasonForm({
  title, submitLabel, destructive, reason, setReason,
  error, isPending, onSubmit, onCancel,
}: ReasonFormProps) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-600 dark:text-gray-300">{title}</p>
      <textarea
        value={reason}
        onChange={e => setReason(e.target.value)}
        placeholder="Reason (optional)"
        rows={3}
        maxLength={300}
        className="w-full ct-input text-sm resize-none"
      />
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      <button
        onClick={onSubmit}
        disabled={isPending}
        className={`w-full rounded-xl py-3 text-sm font-semibold text-white active:scale-[0.98] motion-safe:transition-all motion-safe:duration-150 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 ${
          destructive
            ? "bg-red-600 hover:bg-red-700 dark:bg-red-700 dark:hover:bg-red-600 focus-visible:ring-red-500"
            : "bg-gray-900 dark:bg-gray-100 dark:text-gray-900 hover:brightness-110 focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100"
        }`}
      >
        {isPending ? "Saving…" : submitLabel}
      </button>
      <button
        onClick={onCancel}
        className="w-full py-1 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 motion-safe:transition-colors motion-safe:duration-150"
      >
        Cancel
      </button>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function LessonProSheet({ request, courts, userId, clubTimezone, userRole, pros, initialMode, onClose }: Props) {
  const router                    = useRouter();
  const [mode, setMode]           = useState<ActionMode>(initialMode ?? null);
  const [dateStr, setDateStr]     = useState<string>(() =>
    new Date().toLocaleDateString("en-CA", { timeZone: clubTimezone })
  );
  const [slotIdx, setSlotIdx]     = useState(8); // default 9:00 AM (index 8 = 5:00+4*2)
  const [courtId, setCourtId]     = useState<string>(courts[0]?.id ?? "");
  const [reason, setReason]       = useState("");
  const [newProId, setNewProId]   = useState<string>("");
  const [error, setError]         = useState("");
  const [isPending, startTransition] = useTransition();

  const memberName = [request.member_first_name, request.member_last_name].filter(Boolean).join(" ") || "Member";

  const startsAt = useMemo(() => {
    const slot = TIME_SLOTS[slotIdx];
    return localDateTimeToUTC(dateStr, slot.hour, slot.minute, clubTimezone);
  }, [dateStr, slotIdx, clubTimezone]);

  const endsAt = useMemo(
    () => new Date(startsAt.getTime() + request.duration_minutes * 60_000),
    [startsAt, request.duration_minutes]
  );

  const endLabel = endsAt.toLocaleTimeString("en-US", {
    timeZone: clubTimezone, hour: "numeric", minute: "2-digit", hour12: true,
  });

  const preferredWindows = request.preferred_windows as { freeform?: string } | null;

  function doAction(fn: () => Promise<{ error?: string }>) {
    setError("");
    startTransition(async () => {
      const res = await fn();
      if (res.error) { setError(res.error); return; }
      router.refresh();
      onClose();
    });
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <ResponsiveSheet onClose={onClose} variant="modal">
      <div className="px-4 pt-5 pb-8 overflow-y-auto flex-1">
      <div className="relative flex items-center justify-center mb-4">
        <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Lesson Request</h2>
        <button onClick={onClose} className="absolute right-0 text-sm text-gray-400 md:hidden" aria-label="Close">✕</button>
      </div>

      {/* Request summary */}
      <div className="ct-card divide-y divide-gray-100 dark:divide-gray-800 overflow-hidden mb-4">
        <div className="px-4 py-2.5 flex items-center justify-between text-sm">
          <span className="text-gray-500 dark:text-gray-400">Status</span>
          {statusBadge(request.status)}
        </div>
        <div className="px-4 py-2.5 flex justify-between text-sm">
          <span className="text-gray-500 dark:text-gray-400">Member</span>
          <span className="font-medium text-gray-900 dark:text-gray-100">{memberName}</span>
        </div>
        <div className="px-4 py-2.5 flex justify-between text-sm">
          <span className="text-gray-500 dark:text-gray-400">Duration</span>
          <span className="font-medium text-gray-900 dark:text-gray-100">{request.duration_minutes} min</span>
        </div>
        {request.preferred_court_name && (
          <div className="px-4 py-2.5 flex justify-between text-sm">
            <span className="text-gray-500 dark:text-gray-400">Preferred court</span>
            <span className="font-medium text-gray-900 dark:text-gray-100">{request.preferred_court_name}</span>
          </div>
        )}
        {preferredWindows?.freeform && (
          <div className="px-4 py-2.5 text-sm">
            <p className="text-gray-500 dark:text-gray-400 mb-0.5">Preferred times</p>
            <p className="text-gray-700 dark:text-gray-300 text-xs">{preferredWindows.freeform}</p>
          </div>
        )}
        {request.member_note && (
          <div className="px-4 py-2.5 text-sm">
            <p className="text-gray-500 dark:text-gray-400 mb-0.5">Note</p>
            <p className="text-gray-700 dark:text-gray-300">{request.member_note}</p>
          </div>
        )}
        <div className="px-4 py-2.5 flex justify-between text-xs text-gray-400">
          <span>Submitted</span>
          <span>{fmt(request.created_at, clubTimezone)}</span>
        </div>
      </div>

      {/* Proposed time block */}
      {request.status === "proposed" && request.proposed_starts_at && (
        <div className="ct-card px-4 py-3 mb-4 border-2 border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/30">
          <p className="text-xs font-semibold text-blue-700 dark:text-blue-300 mb-1">Awaiting member response</p>
          <p className="text-sm font-medium text-blue-900 dark:text-blue-100">
            {fmt(request.proposed_starts_at, clubTimezone)}
            {request.proposed_ends_at
              ? ` – ${new Date(request.proposed_ends_at).toLocaleTimeString("en-US", {
                  timeZone: clubTimezone, hour: "numeric", minute: "2-digit", hour12: true,
                })}`
              : ""}
          </p>
          {request.proposed_court_name && (
            <p className="text-xs text-blue-600 dark:text-blue-400 mt-0.5">
              Court: {request.proposed_court_name}
            </p>
          )}
        </div>
      )}

      {/* Confirmed time block */}
      {request.status === "confirmed" && request.proposed_starts_at && (
        <div className="ct-card px-4 py-3 mb-4 border-2 border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950/30">
          <p className="text-xs font-semibold text-green-700 dark:text-green-300 mb-1">Confirmed lesson</p>
          <p className="text-sm font-medium text-green-900 dark:text-green-100">
            {fmt(request.proposed_starts_at, clubTimezone)}
            {request.proposed_ends_at
              ? ` – ${new Date(request.proposed_ends_at).toLocaleTimeString("en-US", {
                  timeZone: clubTimezone, hour: "numeric", minute: "2-digit", hour12: true,
                })}`
              : ""}
          </p>
          {request.proposed_court_name && (
            <p className="text-xs text-green-600 dark:text-green-400 mt-0.5">
              Court: {request.proposed_court_name}
            </p>
          )}
        </div>
      )}

      {/* Decline/cancellation reason */}
      {request.status === "declined" && request.decline_reason && (
        <div className="ct-card px-4 py-3 mb-4 border border-red-200 dark:border-red-800">
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-0.5">Decline reason</p>
          <p className="text-sm text-gray-700 dark:text-gray-300">{request.decline_reason}</p>
        </div>
      )}
      {request.status === "cancelled" && request.cancellation_reason && (
        <div className="ct-card px-4 py-3 mb-4 border border-gray-200 dark:border-gray-700">
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-0.5">Cancellation reason</p>
          <p className="text-sm text-gray-700 dark:text-gray-300">{request.cancellation_reason}</p>
        </div>
      )}

      {/* ── Action area ──────────────────────────────────────────────────────── */}

      {mode === "propose" && (
        <TimePicker
          dateStr={dateStr}
          setDateStr={setDateStr}
          slotIdx={slotIdx}
          setSlotIdx={setSlotIdx}
          courtId={courtId}
          setCourtId={setCourtId}
          courts={courts}
          endLabel={endLabel}
          durationMins={request.duration_minutes}
          clubTimezone={clubTimezone}
          error={error}
          isPending={isPending}
          submitLabel="Send Proposal"
          onSubmit={() => doAction(() => proposeLessonTime({
            p_request_id: request.id,
            p_starts_at:  startsAt.toISOString(),
            p_ends_at:    endsAt.toISOString(),
            p_court_id:   courtId || null,
            member_id:    request.member_id,
          }))}
          onCancel={() => { setMode(null); setError(""); }}
        />
      )}

      {mode === "decline" && (
        <ReasonForm
          title="Decline this request? The member will be notified."
          submitLabel="Decline Request"
          destructive
          reason={reason}
          setReason={setReason}
          error={error}
          isPending={isPending}
          onSubmit={() => doAction(() => declineLessonRequest(request.id, request.member_id, reason.trim() || null))}
          onCancel={() => { setMode(null); setReason(""); setError(""); }}
        />
      )}

      {mode === "cancel" && (
        <ReasonForm
          title="Cancel this confirmed lesson? It will be removed from the calendar."
          submitLabel="Cancel Lesson"
          destructive
          reason={reason}
          setReason={setReason}
          error={error}
          isPending={isPending}
          onSubmit={() => doAction(() => cancelLesson({
            requestId: request.id,
            memberId:  request.member_id,
            proId:     request.pro_id,
            actorId:   userId,
            reason:    reason.trim() || null,
          }))}
          onCancel={() => { setMode(null); setReason(""); setError(""); }}
        />
      )}

      {mode === "reassign" && (
        <div className="space-y-3">
          <p className="text-sm text-gray-600 dark:text-gray-300">
            Assign this request to a different pro. If proposed, the proposal will be cleared.
          </p>
          <div>
            <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1.5">
              New Pro
            </label>
            <select
              value={newProId}
              onChange={e => setNewProId(e.target.value)}
              className="w-full ct-input text-sm"
            >
              <option value="">Select a pro…</option>
              {(pros ?? [])
                .filter(p => p.id !== request.pro_id)
                .map(p => (
                  <option key={p.id} value={p.id}>
                    {[p.first_name, p.last_name].filter(Boolean).join(" ") || "Pro"}
                  </option>
                ))}
            </select>
          </div>
          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          <button
            onClick={() => doAction(() => reassignLessonProviderAction(
              request.id,
              newProId,
              request.member_id,
              request.pro_id,
            ))}
            disabled={isPending || !newProId}
            className="w-full bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 rounded-xl py-3 text-sm font-semibold hover:brightness-110 active:scale-[0.98] motion-safe:transition-all motion-safe:duration-150 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100"
          >
            {isPending ? "Saving…" : "Reassign Pro"}
</button>
          <button
            onClick={() => { setMode(null); setNewProId(""); setError(""); }}
            className="w-full py-1 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 motion-safe:transition-colors motion-safe:duration-150"
          >
            Cancel
          </button>
        </div>
      )}

      {/* ── Default action buttons ─────────────────────────────────────────── */}

      {mode === null && (
        <div className="space-y-2">
          {/* Admin: reassign provider on pending/proposed */}
          {userRole === "admin" && (pros?.length ?? 0) > 0 &&
            (request.status === "pending" || request.status === "proposed") && (
            <button
              onClick={() => { setNewProId(""); setError(""); setMode("reassign"); }}
              className="w-full border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 rounded-xl py-3 text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-700/40 active:scale-[0.98] motion-safe:transition-all motion-safe:duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-300"
            >
              Reassign Pro
            </button>
          )}

          {/* Pending: propose a time or decline */}
          {request.status === "pending" && (
            <>
              <button
                onClick={() => setMode("propose")}
                className="w-full bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 rounded-xl py-3 text-sm font-semibold hover:brightness-110 active:scale-[0.98] motion-safe:transition-all motion-safe:duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100"
              >
                Propose a Time
              </button>
              <button
                onClick={() => setMode("decline")}
                className="w-full border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 rounded-xl py-3 text-sm font-medium hover:bg-red-50 dark:hover:bg-red-950/30 active:scale-[0.98] motion-safe:transition-all motion-safe:duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300"
              >
                Decline Request
              </button>
            </>
          )}

          {/* Proposed (awaiting member): pro can still decline the whole request */}
          {request.status === "proposed" && (
            <button
              onClick={() => setMode("decline")}
              className="w-full border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 rounded-xl py-3 text-sm font-medium hover:bg-red-50 dark:hover:bg-red-950/30 active:scale-[0.98] motion-safe:transition-all motion-safe:duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300"
            >
              Decline Request
            </button>
          )}

          {/* Confirmed: cancel lesson */}
          {request.status === "confirmed" && (
            <button
              onClick={() => setMode("cancel")}
              className="w-full border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 rounded-xl py-3 text-sm font-medium hover:bg-red-50 dark:hover:bg-red-950/30 active:scale-[0.98] motion-safe:transition-all motion-safe:duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300"
            >
              Cancel Lesson
            </button>
          )}
        </div>
      )}
      </div>
    </ResponsiveSheet>
  );
}
