"use client";

// EventsAdminTabs — renders a segmented Upcoming / Manage control for admin and pro users.
// Both panels are rendered into the DOM; only one is visible at a time.
// This preserves client state in AdminEventsClient (e.g. pagination) when
// switching between tabs.
// An optional `headerAction` (e.g. "+ Create Event" button) appears to the right
// of the tab selector, visible on both tabs.

import { useState } from "react";

type Tab = "upcoming" | "manage";

interface Props {
  upcoming:      React.ReactNode;
  manage:        React.ReactNode;
  headerAction?: React.ReactNode;
}

export default function EventsAdminTabs({ upcoming, manage, headerAction }: Props) {
  const [tab, setTab] = useState<Tab>("upcoming");

  return (
    <>
      {/* Tab selector row + optional header action */}
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
        {/* e.g. "+ Create Event" — visible on both tabs */}
        {headerAction}
      </div>

      {/* Both panels rendered; CSS hides the inactive one to preserve component state */}
      <div className={tab === "upcoming" ? undefined : "hidden"}>{upcoming}</div>
      <div className={tab === "manage"   ? undefined : "hidden"}>{manage}</div>
    </>
  );
}
