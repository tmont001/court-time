"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import ResponsiveSheet from "@/components/ResponsiveSheet";
import {
  withdrawLessonRequest,
  acceptLessonProposal,
  declineLessonProposal,
  cancelLesson,
  type LessonRequestRow,
} from "./actions";

interface Props {
  request:    LessonRequestRow;
  userId:     string;
  clubTimezone: string;
  onClose:    () => void;
}

function statusBadge(status: string) {
  const map: Record<string, string> = {
    pending:   "bg-amber-100 text-amber-700",
    proposed:  "bg-blue-100 text-blue-700",
    confirmed: "bg-green-100 text-green-700",
    declined:  "bg-red-100 text-red-700",
    withdrawn: "bg-gray-100 text-gray-500",
    cancelled: "bg-gray-100 text-gray-500",
  };
  const cls = map[status] ?? "bg-gray-100 text-gray-500";
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

export default function LessonRequestDetail({ request, userId: _userId, clubTimezone, onClose }: Props) {
  const router = useRouter();
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const [confirmCancel,   setConfirmCancel]   = useState(false);
  const [cancelReason,    setCancelReason]    = useState("");
  const [error, setError] = useState("");
  const [isPending, startTransition] = useTransition();

  const proName = [request.pro_first_name, request.pro_last_name].filter(Boolean).join(" ") || "Pro";

  function action(fn: () => Promise<{ error?: string }>) {
    setError("");
    startTransition(async () => {
      const res = await fn();
      if (res.error) { setError(res.error); return; }
      router.refresh();
      onClose();
    });
  }

  return (
    <ResponsiveSheet onClose={onClose} variant="modal">
      <div className="px-4 pt-5 pb-8 overflow-y-auto flex-1">
      <div className="relative flex items-center justify-center mb-4">
        <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Lesson Request</h2>
        <button onClick={onClose} className="absolute right-0 text-sm text-gray-400 md:hidden" aria-label="Close">✕</button>
      </div>

      {/* Status + summary */}
      <div className="ct-card divide-y divide-gray-100 dark:divide-gray-800 overflow-hidden mb-4">
        <div className="px-4 py-2.5 flex items-center justify-between text-sm">
          <span className="text-gray-500 dark:text-gray-400">Status</span>
          {statusBadge(request.status)}
        </div>
        <div className="px-4 py-2.5 flex justify-between text-sm">
          <span className="text-gray-500 dark:text-gray-400">Pro</span>
          <span className="font-medium text-gray-900 dark:text-gray-100">{proName}</span>
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

      {/* Proposed time (if status = proposed) */}
      {request.status === "proposed" && request.proposed_starts_at && (
        <div className="ct-card px-4 py-3 mb-4 border-2 border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/30">
          <p className="text-xs font-semibold text-blue-700 dark:text-blue-300 mb-1">
            Time proposed by {proName}
          </p>
          <p className="text-sm font-medium text-blue-900 dark:text-blue-100">
            {fmt(request.proposed_starts_at, clubTimezone)}
            {request.proposed_ends_at
              ? ` – ${new Date(request.proposed_ends_at).toLocaleTimeString("en-US", {
                  timeZone: clubTimezone, hour: "numeric", minute: "2-digit", hour12: true,
                })}`
              : ""}
          </p>
          {request.proposed_court_name && (
            <p className="text-xs text-blue-700 dark:text-blue-400 mt-0.5">
              Court: {request.proposed_court_name}
            </p>
          )}
        </div>
      )}

      {/* Confirmed time */}
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
            <p className="text-xs text-green-700 dark:text-green-400 mt-0.5">
              Court: {request.proposed_court_name}
            </p>
          )}
        </div>
      )}

      {/* Decline reason */}
      {request.status === "declined" && request.decline_reason && (
        <div className="ct-card px-4 py-3 mb-4 border border-red-200 dark:border-red-800">
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-0.5">Decline reason</p>
          <p className="text-sm text-gray-700 dark:text-gray-300">{request.decline_reason}</p>
        </div>
      )}

      {/* Cancellation reason */}
      {request.status === "cancelled" && request.cancellation_reason && (
        <div className="ct-card px-4 py-3 mb-4 border border-gray-200 dark:border-gray-700">
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-0.5">Cancellation reason</p>
          <p className="text-sm text-gray-700 dark:text-gray-300">{request.cancellation_reason}</p>
        </div>
      )}

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400 mb-3">{error}</p>
      )}

      {/* Actions */}
      <div className="space-y-2">
        {/* Proposed: accept or decline proposal */}
        {request.status === "proposed" && (
          <>
            {!confirmWithdraw && (
              <>
                <button
                  onClick={() => action(() => acceptLessonProposal(request.id, request.pro_id))}
                  disabled={isPending}
                  className="w-full bg-green-600 hover:bg-green-700 text-white rounded-xl py-3 text-sm font-semibold disabled:opacity-50"
                >
                  {isPending ? "Accepting…" : "Accept Proposed Time"}
                </button>
                <button
                  onClick={() => action(() => declineLessonProposal(request.id))}
                  disabled={isPending}
                  className="w-full border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 rounded-xl py-3 text-sm font-medium disabled:opacity-50"
                >
                  Decline Proposal
                </button>
              </>
            )}
          </>
        )}

        {/* Pending: withdraw */}
        {request.status === "pending" && !confirmWithdraw && (
          <button
            onClick={() => setConfirmWithdraw(true)}
            className="w-full border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 rounded-xl py-3 text-sm font-medium"
          >
            Withdraw Request
          </button>
        )}

        {/* Withdraw confirmation */}
        {confirmWithdraw && (
          <div className="space-y-2">
            <p className="text-sm text-gray-600 dark:text-gray-300 text-center">
              Withdraw this request?
            </p>
            <button
              onClick={() => action(() => withdrawLessonRequest(request.id))}
              disabled={isPending}
              className="w-full bg-red-600 hover:bg-red-700 text-white rounded-xl py-3 text-sm font-semibold disabled:opacity-50"
            >
              {isPending ? "Withdrawing…" : "Yes, Withdraw"}
            </button>
            <button
              onClick={() => setConfirmWithdraw(false)}
              className="w-full text-sm text-gray-500"
            >
              Keep Request
            </button>
          </div>
        )}

        {/* Confirmed: cancel */}
        {request.status === "confirmed" && !confirmCancel && (
          <button
            onClick={() => setConfirmCancel(true)}
            className="w-full border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 rounded-xl py-3 text-sm font-medium"
          >
            Cancel Lesson
          </button>
        )}

        {confirmCancel && (
          <div className="space-y-2">
            <p className="text-sm text-gray-600 dark:text-gray-300">
              Cancel this confirmed lesson? This will remove it from the calendar.
            </p>
            <textarea
              value={cancelReason}
              onChange={e => setCancelReason(e.target.value)}
              placeholder="Reason (optional)"
              rows={2}
              maxLength={300}
              className="w-full ct-input text-sm resize-none"
            />
            <button
              onClick={() => action(() => cancelLesson({
                requestId: request.id,
                memberId:  _userId,
                proId:     request.pro_id,
                actorId:   _userId,
                reason:    cancelReason.trim() || null,
              }))}
              disabled={isPending}
              className="w-full bg-red-600 hover:bg-red-700 text-white rounded-xl py-3 text-sm font-semibold disabled:opacity-50"
            >
              {isPending ? "Cancelling…" : "Confirm Cancellation"}
            </button>
            <button
              onClick={() => setConfirmCancel(false)}
              className="w-full text-sm text-gray-500"
            >
              Keep Lesson
            </button>
          </div>
        )}
      </div>
      </div>
    </ResponsiveSheet>
  );
}
