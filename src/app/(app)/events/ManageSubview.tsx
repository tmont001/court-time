"use client";

// ManageSubview — compact Events / Programs sub-toggle rendered inside the
// existing Manage tab (see EventsAdminShell.tsx for the parent
// Upcoming/Manage/Lessons tab this nests inside). Deliberately smaller/
// lighter than the main tab control so it reads as a nested sub-view, not a
// new top-level section — no new route, no new top-level nav item, and
// (since this whole component only ever renders inside EventsAdminShell's
// `manage` slot, which page.tsx only passes for isAdminOrPro) members never
// see it.

import { useState, useEffect } from "react";

type SubTab = "events" | "programs";

interface Props {
  eventsPanel:   React.ReactNode;
  programsPanel: React.ReactNode;
  // URL-backed (?manageView=events|programs) so links like Programs'
  // "View sessions" can force this subview open from outside — page.tsx
  // reads the search param and passes it down as this prop.
  initialSub?: SubTab;
}

export default function ManageSubview({ eventsPanel, programsPanel, initialSub = "events" }: Props) {
  const [sub, setSub] = useState<SubTab>(initialSub);

  // ManageSubview stays mounted across a same-route navigation (only
  // search params change), so its own useState initializer only runs once
  // on first mount — without this effect, a later "View sessions" click
  // (new manageView=events in the URL) would never actually switch the
  // already-mounted subview back to Events.
  useEffect(() => {
    setSub(initialSub);
  }, [initialSub]);

  return (
    <>
      <div className="mx-4 mt-2 mb-1 inline-flex p-0.5 gap-0.5 bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-lg">
        <button
          onClick={() => setSub("events")}
          aria-pressed={sub === "events"}
          className={`px-3 py-1 rounded-md text-xs font-medium motion-safe:transition-colors motion-safe:duration-100 ${
            sub === "events"
              ? "bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm"
              : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
          }`}
        >
          Events
        </button>
        <button
          onClick={() => setSub("programs")}
          aria-pressed={sub === "programs"}
          className={`px-3 py-1 rounded-md text-xs font-medium motion-safe:transition-colors motion-safe:duration-100 ${
            sub === "programs"
              ? "bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm"
              : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
          }`}
        >
          Programs
        </button>
      </div>

      {/* Both panels rendered; CSS hides the inactive one to preserve state
          (e.g. AdminEventsClient's filters, ProgramsManageClient's sheets). */}
      <div className={sub === "events"   ? undefined : "hidden"}>{eventsPanel}</div>
      <div className={sub === "programs" ? undefined : "hidden"}>{programsPanel}</div>
    </>
  );
}
