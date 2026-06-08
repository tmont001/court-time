"use client";

import { useState } from "react";
import EventRosterSheet, { type RosterParticipantRow } from "@/app/(app)/calendar/EventRosterSheet";

interface Props {
  eventId:          string;
  count:            number;
  userRole?:        string;
  clubTimezone?:    string;
  onRosterChange?:  (participantRows: RosterParticipantRow[], guestCount: number) => void;
}

export default function EventRosterButton({ eventId, count, userRole, clubTimezone, onRosterChange }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="text-xs font-medium text-gray-500"
      >
        Roster ({count})
      </button>
      {open && (
        <EventRosterSheet
          eventId={eventId}
          userRole={userRole}
          clubTimezone={clubTimezone}
          onClose={() => setOpen(false)}
          onRosterChange={onRosterChange}
        />
      )}
    </>
  );
}
