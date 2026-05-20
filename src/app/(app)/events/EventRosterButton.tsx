"use client";

import { useState } from "react";
import EventRosterSheet from "@/app/(app)/calendar/EventRosterSheet";

interface Props {
  eventId: string;
  count:   number;
}

export default function EventRosterButton({ eventId, count }: Props) {
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
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
