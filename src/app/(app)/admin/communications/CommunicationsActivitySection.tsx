"use client";

import { useState } from "react";
import { getAnnouncementBatchDetailAction, type AnnouncementRecipientDetail } from "./communicationsActions";

// Admin IA Checkpoint 4 (C) — Activity v1 is ANNOUNCEMENTS ONLY, one card
// per announcement batch (not a generic per-notification feed — see the
// checkpoint report for why reservation/event/waitlist/lesson notifications
// are intentionally excluded: they are inherently 1:1, never a batch send).
//
// batchId is null for an announcement sent before durable batch tracking
// existed (migration 0102) — its title/sentAt/recipientCount still come
// from the real audit_log row, but per-recipient/channel delivery counts
// cannot be reconstructed reliably, so this UI never guesses: it shows a
// clearly labeled "not available" note instead of a false "0" count, and
// disables the drill-down affordance entirely for that row (see C2).
export interface AnnouncementBatch {
  batchId:          string | null;
  title:            string;
  sentAt:           string;
  recipientCount:   number;
  emailSentCount:   number;
  emailFailedCount: number;
}

interface Props {
  batches: AnnouncementBatch[];
}

function formatSentAt(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  });
}

function recipientStatusLabel(status: AnnouncementRecipientDetail["emailStatus"]): string {
  if (status === "sent")       return "Email sent";
  if (status === "failed")     return "Email failed";
  if (status === "opted_out")  return "Email opted out";
  return "In-app only";
}

function recipientStatusColor(status: AnnouncementRecipientDetail["emailStatus"]): string {
  if (status === "sent")   return "text-green-600 dark:text-green-400";
  if (status === "failed") return "text-red-500 dark:text-red-400";
  return "text-gray-400 dark:text-gray-500";
}

export default function CommunicationsActivitySection({ batches }: Props) {
  const [expandedBatchId, setExpandedBatchId] = useState<string | null>(null);
  const [detailByBatch, setDetailByBatch]     = useState<Record<string, AnnouncementRecipientDetail[]>>({});
  const [loadingBatchId, setLoadingBatchId]   = useState<string | null>(null);
  const [errorByBatch, setErrorByBatch]       = useState<Record<string, string>>({});

  function toggleExpand(batchId: string) {
    if (expandedBatchId === batchId) {
      setExpandedBatchId(null);
      return;
    }
    setExpandedBatchId(batchId);
    if (detailByBatch[batchId]) return;

    setLoadingBatchId(batchId);
    void (async () => {
      const result = await getAnnouncementBatchDetailAction(batchId);
      setLoadingBatchId(null);
      if (result.error) {
        setErrorByBatch(prev => ({ ...prev, [batchId]: result.error! }));
      } else {
        setDetailByBatch(prev => ({ ...prev, [batchId]: result.recipients }));
      }
    })();
  }

  if (batches.length === 0) {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400 px-1">
        No announcements sent yet.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {batches.map(b => {
        const key = b.batchId ?? `legacy-${b.sentAt}`;
        const isExpanded = b.batchId != null && expandedBatchId === b.batchId;

        return (
          <div key={key} className="ct-card overflow-hidden">
            <button
              type="button"
              onClick={() => b.batchId && toggleExpand(b.batchId)}
              disabled={!b.batchId}
              className="w-full text-left px-4 py-3 space-y-2 disabled:cursor-default"
            >
              <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
                <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 min-w-0 break-words">
                  {b.title}
                </p>
                <span className="text-xs text-gray-400 dark:text-gray-500 shrink-0 whitespace-nowrap">
                  {formatSentAt(b.sentAt)}
                </span>
              </div>

              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
                <span>Recipients: {b.recipientCount}</span>
                {b.batchId ? (
                  <>
                    <span>Email sent: {b.emailSentCount}</span>
                    {b.emailFailedCount > 0 && (
                      <span className="text-red-500 dark:text-red-400 font-medium">Email failed: {b.emailFailedCount}</span>
                    )}
                  </>
                ) : (
                  <span className="italic">
                    Delivery detail not available — sent before delivery tracking was added
                  </span>
                )}
              </div>
            </button>

            {isExpanded && b.batchId && (
              <div className="border-t border-gray-100 dark:border-gray-800 px-4 py-3">
                {loadingBatchId === b.batchId ? (
                  <p className="text-xs text-gray-400 dark:text-gray-500">Loading recipients…</p>
                ) : errorByBatch[b.batchId] ? (
                  <p className="text-xs text-red-500 dark:text-red-400">{errorByBatch[b.batchId]}</p>
                ) : (
                  <div className="space-y-1">
                    {(detailByBatch[b.batchId] ?? []).map(r => (
                      <div key={r.userId} className="flex items-center justify-between gap-3 text-xs py-1">
                        <span className="text-gray-700 dark:text-gray-300 truncate min-w-0">{r.name}</span>
                        <span className={`shrink-0 ${recipientStatusColor(r.emailStatus)}`}>
                          {recipientStatusLabel(r.emailStatus)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
