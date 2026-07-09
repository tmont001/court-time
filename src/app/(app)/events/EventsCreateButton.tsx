"use client";

// EventsCreateButton — shown above the Upcoming/Manage tabs on /events for admin/pro.
// Opens CreateEventSheet on click. On success, calls the onCreated callback so the
// parent shell can handle tab-switching and RSC refresh together.

import { useState } from "react";
import { useRouter } from "next/navigation";
import CreateEventSheet from "@/app/(app)/calendar/CreateEventSheet";

type Court = { id: string; name: string; display_order: number };

interface Props {
  courts:       Court[];
  clubId:       string;
  clubTimezone: string;
  // When provided, the parent owns refresh + tab-switch logic.
  // When absent, falls back to router.refresh() (e.g. standalone usage).
  onCreated?:   () => void;
}

export default function EventsCreateButton({ courts, clubId, clubTimezone, onCreated }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  function handleCreated() {
    setOpen(false);
    if (onCreated) {
      onCreated();
    } else {
      router.refresh();
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 hover:bg-gray-700 dark:hover:bg-gray-300 motion-safe:transition-colors motion-safe:duration-150"
      >
        + Create Event
      </button>
      {open && (
        <CreateEventSheet
          courts={courts}
          clubId={clubId}
          clubTimezone={clubTimezone}
          onClose={() => setOpen(false)}
          onCreated={handleCreated}
        />
      )}
    </>
  );
}
