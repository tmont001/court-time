"use client";

import { useState, useTransition } from "react";
import { fetchMoreAuditLog } from "./actions";
import type { AuditLogRow } from "./actions";

const ACTION_LABELS: Record<string, string> = {
  admin_cancel_reservation:  "Cancelled reservation",
  cancel_event:              "Cancelled event",
  create_maintenance_block:  "Created maintenance block",
  update_club_settings:      "Updated settings",
  admin_add_member:          "Added member to event",
  admin_remove_participant:  "Removed participant from event",
  admin_force_confirm:       "Force confirmed participant",
  admin_offer_spot:          "Manually offered spot",
  admin_expire_offer:        "Expired offer",
  admin_add_guest:           "Added guest to event",
  admin_remove_guest:        "Removed guest from event",
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month:   "short",
    day:     "numeric",
    year:    "numeric",
    hour:    "numeric",
    minute:  "2-digit",
    hour12:  true,
  });
}

interface Props {
  initialRows: AuditLogRow[];
}

export default function AuditLogTable({ initialRows }: Props) {
  const [rows, setRows]           = useState<AuditLogRow[]>(initialRows);
  const [hasMore, setHasMore]     = useState(initialRows.length === 50);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleLoadMore() {
    setFetchError(null);
    startTransition(async () => {
      const result = await fetchMoreAuditLog(rows.length);
      if (result.error) {
        setFetchError(result.error);
      } else {
        setRows(prev => [...prev, ...result.rows]);
        setHasMore(result.rows.length === 50);
      }
    });
  }

  if (rows.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-gray-400 text-sm">
        No activity recorded yet.
      </div>
    );
  }

  return (
    <div className="pb-6 pt-3">
      {rows.map((row) => {
        const label = ACTION_LABELS[row.action] ?? row.action;
        return (
          <div
            key={row.id}
            className="mx-4 mb-3 px-4 py-3 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{label}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  {row.actor_name ?? "Unknown"}
                </p>
              </div>
              <p className="text-xs text-gray-400 dark:text-gray-500 shrink-0 text-right">
                {formatDate(row.created_at)}
              </p>
            </div>

            <div className="mt-2">
              <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300">
                {row.target_type}
              </span>
            </div>

            {row.metadata != null && (
              <details className="mt-2">
                <summary className="text-xs text-gray-400 dark:text-gray-500 cursor-pointer select-none">
                  Details
                </summary>
                <pre className="mt-1 text-xs text-gray-500 dark:text-gray-400 whitespace-pre-wrap break-all bg-gray-50 dark:bg-gray-700 rounded p-2">
                  {JSON.stringify(row.metadata, null, 2)}
                </pre>
              </details>
            )}
          </div>
        );
      })}

      {fetchError && (
        <p className="mx-4 mb-3 text-xs text-red-500">{fetchError}</p>
      )}

      {hasMore && (
        <div className="flex justify-center py-2">
          <button
            onClick={handleLoadMore}
            disabled={isPending}
            className="px-4 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-700 dark:text-gray-300 font-medium disabled:opacity-40"
          >
            {isPending ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}
