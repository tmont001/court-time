"use client";

import { useState, useEffect, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";

// ─── Types ────────────────────────────────────────────────────────────────────

interface RosterRow {
  profile_id:        string;
  display_name:      string;
  role:              string;
  status:            string;
  attendance_status: string | null;
  waitlist_position: number | null;
}

interface Props {
  eventId: string;
  onClose: () => void;
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function EventRosterSheet({ eventId, onClose }: Props) {
  const supabase = useMemo(() => createClient(), []);

  const [rows, setRows]           = useState<RosterRow[]>([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState<string | null>(null);
  const [rowUpdating, setRowUpdating] = useState<Set<string>>(new Set());
  const [rowErrors, setRowErrors]     = useState<Map<string, string>>(new Map());

  useEffect(() => {
    setLoading(true);
    setError(null);
    supabase
      .rpc("get_event_roster", { p_event_id: eventId })
      .then(({ data, error: rpcError }) => {
        if (rpcError) {
          setError("Unable to load roster. Please try again.");
        } else {
          setRows((data as RosterRow[]) ?? []);
        }
        setLoading(false);
      });
  }, [eventId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Attendance handler ────────────────────────────────────────────────────

  async function handleMark(profileId: string, newStatus: string | null) {
    const prevRows = rows;

    // Optimistic update
    setRows(prev => prev.map(r =>
      r.profile_id === profileId ? { ...r, attendance_status: newStatus } : r
    ));
    setRowUpdating(prev => new Set(prev).add(profileId));
    setRowErrors(prev => { const next = new Map(prev); next.delete(profileId); return next; });

    const { error: rpcError } = await supabase.rpc("mark_attendance", {
      p_event_id:          eventId,
      p_profile_id:        profileId,
      p_attendance_status: newStatus,
    });

    setRowUpdating(prev => { const next = new Set(prev); next.delete(profileId); return next; });

    if (rpcError) {
      setRows(prevRows);
      setRowErrors(prev => new Map(prev).set(profileId, "Failed to update. Please try again."));
    }
  }

  // ── Derived ────────────────────────────────────────────────────────────────

  const confirmed  = rows.filter(r => r.status === "confirmed");
  const waitlisted = rows.filter(r => r.status === "waitlisted");

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      {/* Backdrop — above EventDetailSheet (z-50) */}
      <div
        className="fixed inset-0 bg-black/50"
        style={{ zIndex: 60 }}
        onClick={onClose}
      />

      {/* Sheet */}
      <div
        className="fixed bottom-0 left-0 right-0 bg-white dark:bg-gray-800 rounded-t-2xl shadow-xl flex flex-col"
        style={{ zIndex: 70, maxHeight: "80dvh" }}
      >
        {/* Header */}
        <div className="shrink-0 px-6 pt-5 pb-3">
          <div className="w-10 h-1 bg-gray-200 dark:bg-gray-600 rounded-full mx-auto mb-4" />
          <div className="flex items-center justify-between">
            <p className="text-base font-semibold text-gray-900 dark:text-gray-100">Roster</p>
            <button
              onClick={onClose}
              className="text-sm text-gray-400 font-medium"
            >
              Close
            </button>
          </div>
        </div>

        {/* Scrollable body */}
        <div className="overflow-y-auto px-6 pb-8">

          {loading && (
            <p className="text-sm text-gray-400 py-8 text-center">Loading roster…</p>
          )}

          {!loading && error && (
            <p className="text-sm text-red-500 py-8 text-center">{error}</p>
          )}

          {!loading && !error && rows.length === 0 && (
            <p className="text-sm text-gray-400 py-8 text-center">No participants yet.</p>
          )}

          {!loading && !error && rows.length > 0 && (
            <>
              {/* ── Confirmed section ───────────────────────────────────── */}
              {confirmed.length > 0 && (
                <div className="mb-5">
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                    Confirmed ({confirmed.length})
                  </p>
                  {confirmed.map(row => {
                    const isUpdating = rowUpdating.has(row.profile_id);
                    const rowError   = rowErrors.get(row.profile_id);
                    return (
                      <div
                        key={row.profile_id}
                        className="py-2.5 border-b border-gray-100 dark:border-gray-700 last:border-0"
                      >
                        <div className="flex items-center">
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                              {row.display_name}
                            </p>
                            {row.role === "host" && (
                              <p className="text-xs text-gray-400 mt-0.5">Host</p>
                            )}
                          </div>
                        </div>

                        {/* Attendance controls */}
                        <div className="flex gap-1.5 mt-1.5 flex-wrap">
                          <button
                            disabled={isUpdating}
                            onClick={() => handleMark(row.profile_id, "attended")}
                            className={`px-2 py-0.5 rounded-full text-[10px] font-semibold disabled:opacity-40 ${
                              row.attendance_status === "attended"
                                ? "bg-green-100 text-green-700"
                                : "bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 dark:text-gray-400 dark:text-gray-500"
                            }`}
                          >
                            Attended
                          </button>
                          <button
                            disabled={isUpdating}
                            onClick={() => handleMark(row.profile_id, "no_show")}
                            className={`px-2 py-0.5 rounded-full text-[10px] font-semibold disabled:opacity-40 ${
                              row.attendance_status === "no_show"
                                ? "bg-red-100 text-red-600"
                                : "bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 dark:text-gray-400 dark:text-gray-500"
                            }`}
                          >
                            No-show
                          </button>
                          {row.attendance_status && (
                            <button
                              disabled={isUpdating}
                              onClick={() => handleMark(row.profile_id, null)}
                              className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-500 disabled:opacity-40"
                            >
                              Clear
                            </button>
                          )}
                        </div>

                        {rowError && (
                          <p className="text-xs text-red-500 mt-1">{rowError}</p>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* ── Waitlist section — display only, no attendance controls ── */}
              {waitlisted.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                    Waitlist ({waitlisted.length})
                  </p>
                  {waitlisted.map(row => (
                    <div
                      key={row.profile_id}
                      className="flex items-center py-2.5 border-b border-gray-100 dark:border-gray-700 last:border-0"
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                          {row.display_name}
                        </p>
                      </div>
                      {row.waitlist_position !== null && (
                        <span className="text-xs font-semibold text-amber-600 ml-3 shrink-0">
                          #{row.waitlist_position}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

        </div>
      </div>
    </>
  );
}
