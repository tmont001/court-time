"use client";

// ManageSubview — compact Events / Programs sub-toggle rendered inside the
// existing Manage tab (see EventsAdminShell.tsx for the parent
// Upcoming/Manage/Lessons tab this nests inside). Deliberately smaller/
// lighter than the main tab control so it reads as a nested sub-view, not a
// new top-level section — no new route, no new top-level nav item, and
// (since this whole component only ever renders inside EventsAdminShell's
// `manage` slot, which page.tsx only passes for isAdminOrPro) members never
// see it.
//
// Phase 27C.2: reads ?manageView=events|programs directly via
// useSearchParams() instead of a server-passed `initialSub` prop synced by
// a useEffect. The prior prop-drilling approach relied on a fresh RSC
// render (triggered by ProgramsManageClient's router.push to a new
// ?manageView=... URL) reliably propagating new props down through two
// already-mounted client-component layers (EventsAdminShell, then this
// component) on a same-route, search-params-only navigation — a path this
// app has no other proven case of relying on for reactivity (the existing
// router.refresh()-based patterns elsewhere always target the SAME URL, not
// a new one). useSearchParams() is the canonical, purpose-built hook for a
// client component to read the *current* URL's search params reactively —
// it subscribes directly to client-side navigation and does not depend on
// prop delivery through intermediate components at all, removing that
// entire class of uncertainty.

import { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";

type SubTab = "events" | "programs";

interface Props {
  eventsPanel:   React.ReactNode;
  programsPanel: React.ReactNode;
}

export default function ManageSubview({ eventsPanel, programsPanel }: Props) {
  const searchParams = useSearchParams();
  const manageView = searchParams.get("manageView") === "programs" ? "programs" : "events";

  const [sub, setSub] = useState<SubTab>(manageView);

  // Reacts only to the URL's manageView param changing (e.g. Programs'
  // "View Sessions" link) — does not fire on, and is never overwritten by,
  // a manual click on the toggle buttons below, since those only call
  // setSub locally and never touch the URL.
  useEffect(() => {
    setSub(manageView);
  }, [manageView]);

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
