"use client";

// EventsAdminShell — unified admin/pro shell for /events.
// Owns tab state, renders the Upcoming/Manage segmented control, and renders
// exactly one "+ Create Event" button. Courts, clubId, and clubTimezone are
// passed as primitive props so EventsCreateButton can be instantiated
// internally — avoiding the React key warning that occurs when a ReactNode
// containing client components is passed across the RSC/client boundary as
// a generic headerAction prop.

import { useState } from "react";
import { useRouter } from "next/navigation";
import EventsCreateButton from "./EventsCreateButton";

type Tab = "upcoming" | "manage";
type Court = { id: string; name: string; display_order: number };

interface Props {
  upcoming:     React.ReactNode;
  manage:       React.ReactNode;
  courts:       Court[];
  clubId:       string;
  clubTimezone: string;
}

export default function EventsAdminShell({ upcoming, manage, courts, clubId, clubTimezone }: Props) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("upcoming");

  // After a successful create: switch to Manage (so the new event is visible)
  // then refresh RSC data so AdminEventsClient receives updated initialEvents.
  function handleCreated() {
    setTab("manage");
    router.refresh();
  }

  return (
    <>
      {/* Tab selector + single Create Event button */}
      <div className="mx-4 mt-3 mb-1 flex items-center gap-2">
        <div className="flex-1 flex p-1 gap-1 bg-gray-100 dark:bg-gray-800 rounded-xl">
          <button
            onClick={() => setTab("upcoming")}
            className={`flex-1 py-1.5 rounded-lg text-xs font-medium motion-safe:transition-colors motion-safe:duration-100 ${
              tab === "upcoming"
                ? "bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm"
                : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
            }`}
          >
            Upcoming
          </button>
          <button
            onClick={() => setTab("manage")}
            className={`flex-1 py-1.5 rounded-lg text-xs font-medium motion-safe:transition-colors motion-safe:duration-100 ${
              tab === "manage"
                ? "bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm"
                : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
            }`}
          >
            Manage
          </button>
        </div>

        {/* Owned internally — not passed as a ReactNode prop */}
        <EventsCreateButton courts={courts} clubId={clubId} clubTimezone={clubTimezone} onCreated={handleCreated} />
      </div>

      {/* Tab panels — both rendered; CSS hides the inactive one */}
      <div className={tab === "upcoming" ? undefined : "hidden"}>{upcoming}</div>
      <div className={tab === "manage"   ? undefined : "hidden"}>{manage}</div>
    </>
  );
}
