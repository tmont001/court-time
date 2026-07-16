"use client";

import { useState } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PastEventItem {
  id:           string;
  title:        string;
  starts_at:    string;
  ends_at:      string;
  event_types:  { label: string; color: string };
  reservations: Array<{ court_id: string; reason: string; status: string }>;
  myRole:       string;
  myStatus:     string;
  myAttendance: string | null;
}

interface Props {
  items:        PastEventItem[];
  courtNames:   Array<{ id: string; name: string }>;
  clubTimezone: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(iso: string, tz: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true,
  });
}

function formatDateShort(iso: string, tz: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    timeZone: tz, weekday: "short", month: "short", day: "numeric",
  });
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function PastEventsSection({ items, courtNames, clubTimezone }: Props) {
  const [open, setOpen] = useState(false);

  if (items.length === 0) return null;

  const courtName = new Map(courtNames.map(c => [c.id, c.name]));

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls="past-events-list"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 pt-5 pb-2 text-left"
      >
        <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
          Past events ({items.length})
        </p>
        <span className="text-xs text-gray-400 dark:text-gray-500 pr-0.5">
          {open ? "▲" : "▼"}
        </span>
      </button>

      <div id="past-events-list">
        {open && (
          <>
          <p className="px-4 pb-2 text-xs text-gray-400 dark:text-gray-500">
            Your event history. Past events are read-only.
          </p>
          {items.map(({ id, title, starts_at, ends_at, event_types, reservations, myRole, myStatus, myAttendance }) => {
            const date  = formatDateShort(starts_at, clubTimezone);
            const start = formatTime(starts_at, clubTimezone);
            const end   = formatTime(ends_at,   clubTimezone);
            const evCourtNames = reservations
              .filter(r => r.reason === "event" && r.status === "confirmed")
              .map(r => courtName.get(r.court_id) ?? "Court")
              .join(", ");

            return (
              <div
                key={id}
                className="ct-card mx-4 mb-3 px-4 py-3 flex items-start justify-between opacity-75"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
                    <span
                      className="inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold text-white"
                      style={{ background: event_types.color }}
                    >
                      {event_types.label}
                    </span>
                    {myStatus === "waitlisted" && (
                      <span className="inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold bg-amber-100 text-amber-700">
                        Waitlisted
                      </span>
                    )}
                  </div>
                  <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    {date} · {start} – {end}
                    {evCourtNames ? ` · ${evCourtNames}` : ""}
                  </p>
                </div>
                {myRole === "host" ? (
                  <span className="text-xs text-gray-400 ml-4 shrink-0">Host</span>
                ) : myAttendance === "attended" ? (
                  <span className="text-xs font-medium text-green-600 ml-4 shrink-0">Attended</span>
                ) : myAttendance === "no_show" ? (
                  <span className="text-xs font-medium text-red-500 ml-4 shrink-0">No-show</span>
                ) : (
                  <span className="text-xs text-gray-400 dark:text-gray-500 ml-4 shrink-0">Past</span>
                )}
              </div>
            );
          })}
          </>
        )}
      </div>
    </div>
  );
}
