"use client";

import { useState } from "react";
import EventRosterSheet, { type RosterParticipantRow } from "@/app/(app)/calendar/EventRosterSheet";
import { ACTION_BUTTON_SECONDARY } from "./actionButtonStyles";

interface Props {
  eventId:          string;
  clubId:           string;
  count:            number;
  userRole?:        string;
  clubTimezone?:    string;
  readOnly?:        boolean;
  label?:           string;
  onRosterChange?:  (participantRows: RosterParticipantRow[], guestCount: number) => void;
}

export default function EventRosterButton({ eventId, clubId, count, userRole, clubTimezone, readOnly = false, label, onRosterChange }: Props) {
  const [open, setOpen] = useState(false);
  const buttonLabel = label ?? (readOnly ? `View Roster (${count})` : `Roster (${count})`);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={ACTION_BUTTON_SECONDARY}
      >
        {buttonLabel}
      </button>
      {open && (
        <EventRosterSheet
          eventId={eventId}
          clubId={clubId}
          userRole={userRole}
          clubTimezone={clubTimezone}
          readOnly={readOnly}
          onClose={() => setOpen(false)}
          onRosterChange={onRosterChange}
        />
      )}
    </>
  );
}
