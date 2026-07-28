"use client";

import { useState } from "react";
import EventRosterSheet from "@/app/(app)/calendar/EventRosterSheet";
import { ACTION_BUTTON_SECONDARY } from "./actionButtonStyles";

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
        {/* Non-interactive card body — pills, title, time, offer deadline,
            joined/waitlist counts (all supplied via children) */}
        {children}

        {/* Merged footer: roster (left) + primary membership action (right)
            on the same row when space permits, wrapping on narrow widths.
            stopPropagation prevents either from triggering the card's own
            roster-open click. */}
        {(isAdminOrPro || actionArea) && (
          // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
          <div
            className="mt-2 pt-2 border-t border-gray-100 dark:border-gray-700 flex items-center gap-2 flex-wrap"
            onClick={e => e.stopPropagation()}
          >
            {isAdminOrPro && (
              <button
                onClick={() => setRosterOpen(true)}
                className={ACTION_BUTTON_SECONDARY}
              >
                View Roster ({rosterCount})
              </button>
            )}
            {actionArea && <div className="ml-auto">{actionArea}</div>}
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
