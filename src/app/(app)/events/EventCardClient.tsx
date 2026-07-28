"use client";

import { useState } from "react";
import EventRosterSheet from "@/app/(app)/calendar/EventRosterSheet";

interface Props {
  eventId:      string;
  userRole:     string | null | undefined;
  clubId:       string;
  clubTimezone: string;
  rosterCount:  number;
  // Card body (non-interactive: pills, title, time, offer deadline)
  children:     React.ReactNode;
  // Action area (forms/buttons) — rendered inside a stopPropagation wrapper
  actionArea:   React.ReactNode;
}

export default function EventCardClient({
  eventId,
  userRole,
  clubId,
  clubTimezone,
  rosterCount,
  children,
  actionArea,
}: Props) {
  const [rosterOpen, setRosterOpen] = useState(false);
  const isAdminOrPro = userRole === "admin" || userRole === "pro";

  return (
    <>
      <div
        className={`ct-card px-4 py-3 hover:border-accent hover:shadow-md motion-safe:transition-[border-color,box-shadow] motion-safe:duration-150${
          isAdminOrPro ? " cursor-pointer" : ""
        }`}
        onClick={isAdminOrPro ? () => setRosterOpen(true) : undefined}
      >
        {/* Non-interactive card body — pills, title, time, offer deadline */}
        {children}

        {/* Action area — stopPropagation prevents Join/Leave from triggering card click */}
        {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
        <div onClick={e => e.stopPropagation()}>
          {actionArea}
        </div>

        {/* Roster entry point — visible hint for admin/pro */}
        {isAdminOrPro && (
          // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
          <div
            className="mt-2 pt-2 border-t border-gray-100 dark:border-gray-700"
            onClick={e => e.stopPropagation()}
          >
            <button
              onClick={() => setRosterOpen(true)}
              className="text-xs font-medium text-gray-500 dark:text-gray-400 hover:text-accent motion-safe:transition-colors motion-safe:duration-100"
            >
              View Roster ({rosterCount})
            </button>
          </div>
        )}
      </div>

      {rosterOpen && (
        <EventRosterSheet
          eventId={eventId}
          clubId={clubId}
          userRole={userRole ?? undefined}
          clubTimezone={clubTimezone}
          onClose={() => setRosterOpen(false)}
        />
      )}
    </>
  );
}
