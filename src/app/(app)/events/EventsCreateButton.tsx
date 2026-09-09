"use client";

// EventsCreateButton — shown above the Upcoming/Manage tabs on /events for admin/pro.
// Opens CreateEventSheet on click. On success, calls the onCreated callback so the
// parent shell can handle tab-switching and RSC refresh together.

import { useState } from "react";
import { useRouter } from "next/navigation";
import CreateEventSheet from "@/app/(app)/calendar/CreateEventSheet";
import { ACTION_BUTTON_PRIMARY } from "./actionButtonStyles";

type Court = { id: string; name: string; display_order: number };

interface Props {
  courts:       Court[];
  clubId:       string;
  clubTimezone: string;
  currency:     string;
  // Phase 34F-B polish — threaded through to CreateEventSheet so the
  // per-event price override field only renders for Admin.
  isAdmin:      boolean;
  // When provided, the parent owns refresh + tab-switch logic.
  // When absent, falls back to router.refresh() (e.g. standalone usage).
  onCreated?:   () => void;
}

export default function EventsCreateButton({ courts, clubId, clubTimezone, currency, isAdmin, onCreated }: Props) {
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
        className={`shrink-0 ${ACTION_BUTTON_PRIMARY}`}
      >
        + Create Event
      </button>
      {open && (
        <CreateEventSheet
          courts={courts}
          clubId={clubId}
          clubTimezone={clubTimezone}
          currency={currency}
          isAdmin={isAdmin}
          onClose={() => setOpen(false)}
          onCreated={handleCreated}
        />
      )}
    </>
  );
}
