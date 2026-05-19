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

  const [rows, setRows]       = useState<RosterRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

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
        className="fixed bottom-0 left-0 right-0 bg-white rounded-t-2xl shadow-xl flex flex-col"
        style={{ zIndex: 70, maxHeight: "80dvh" }}
      >
        {/* Header */}
        <div className="shrink-0 px-6 pt-5 pb-3">
          <div className="w-10 h-1 bg-gray-200 rounded-full mx-auto mb-4" />
          <div className="flex items-center justify-between">
            <p className="text-base font-semibold text-gray-900">Roster</p>
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
                  {confirmed.map(row => (
                    <div
                      key={row.profile_id}
                      className="flex items-center py-2.5 border-b border-gray-100 last:border-0"
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">
                          {row.display_name}
                        </p>
                        {row.role === "host" && (
                          <p className="text-xs text-gray-400 mt-0.5">Host</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* ── Waitlist section ────────────────────────────────────── */}
              {waitlisted.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                    Waitlist ({waitlisted.length})
                  </p>
                  {waitlisted.map(row => (
                    <div
                      key={row.profile_id}
                      className="flex items-center py-2.5 border-b border-gray-100 last:border-0"
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">
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
