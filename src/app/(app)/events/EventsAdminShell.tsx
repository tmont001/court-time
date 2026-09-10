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

type Tab = "upcoming" | "manage" | "lessons" | "eventTypes";
type Court = { id: string; name: string; display_order: number };

interface Props {
  upcoming:     React.ReactNode;
  manage:       React.ReactNode;
  lessons?:     React.ReactNode;
  // Admin UX Checkpoint 3 — Events IA. Admin-only, exactly like `lessons`
  // is isAdminOrPro-only: the caller (page.tsx) passes this prop ONLY when
  // profile.role === "admin", so Staff/Pro never receive it and this tab
  // literally does not exist in their render tree (not hidden CSS, not an
  // empty panel) — see EventTypesSection's own server-enforced RPC
  // authorization for the actual security boundary this UI gate mirrors.
  eventTypes?:  React.ReactNode;
  courts:       Court[];
  clubId:       string;
  clubTimezone: string;
  currency:     string;
  // Phase 34F-B polish — threaded down to EventsCreateButton/CreateEventSheet
  // so the per-event price override field only renders for Admin, matching
  // EditEventSheet's own identical price-authority gate.
  isAdmin:      boolean;
  initialTab?:  Tab;
}

export default function EventsAdminShell({ upcoming, manage, lessons, eventTypes, courts, clubId, clubTimezone, currency, isAdmin, initialTab = "upcoming" }: Props) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>(initialTab);

  // After a successful create: switch to Manage (so the new event is visible)
  // then refresh RSC data so AdminEventsClient receives updated initialEvents.
  function handleCreated() {
    setTab("manage");
    router.refresh();
  }

  // Runtime QA (~320px): the tab count is either 3 (Upcoming/Manage/Lessons
  // — every isAdminOrPro caller, the only audience of this shell) or 4
  // (Admin, who also gets Event Types) — never any other value. A fixed
  // grid-cols matching the ACTUAL visible tab count keeps every cell equal
  // width on mobile without ever leaving a blank cell for the 3-tab case.
  const tabCount = 2 + (lessons != null ? 1 : 0) + (eventTypes != null ? 1 : 0);

  // Shared per-tab classes: a grid/flex ITEM that is itself a flex
  // container centering its own (possibly two-line) label — mirrors
  // /admin/courts' approved tab-strip treatment exactly (flex items-center
  // justify-center text-center leading-tight), so "Event Types" wrapping
  // to two lines on mobile stays centered and no taller than its grid row
  // requires, matching its siblings automatically via the row's own
  // stretch behavior — no fixed min-height needed.
  function tabClass(active: boolean): string {
    return `flex items-center justify-center text-center leading-tight py-1.5 rounded-lg text-xs font-medium motion-safe:transition-colors motion-safe:duration-100 ${
      active
        ? "bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm"
        : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
    }`;
  }

  return (
    <>
      {/* Tab selector + Create Event button. Mobile (<sm): tabs get their
          own full-width row (a grid, so all cells stay equal width — a
          flex-wrap row could wrap unevenly depending on label length), and
          Create Event drops to a second full-width row below. sm+: reverts
          to the original single-row layout (tabs flex-1 inline, button
          shrink-0 alongside), unchanged from before this checkpoint. */}
      <div className="mx-4 mt-3 mb-1 flex flex-col gap-2 sm:flex-row sm:items-center">
        <div
          className={`grid ${tabCount === 4 ? "grid-cols-4" : "grid-cols-3"} gap-1 p-1 bg-gray-100 dark:bg-gray-800 rounded-xl sm:flex sm:flex-1`}
        >
          <button onClick={() => setTab("upcoming")} className={`${tabClass(tab === "upcoming")} sm:flex-1`}>
            Upcoming
          </button>
          <button onClick={() => setTab("manage")} className={`${tabClass(tab === "manage")} sm:flex-1`}>
            Manage
          </button>
          {lessons != null && (
            <button onClick={() => setTab("lessons")} className={`${tabClass(tab === "lessons")} sm:flex-1`}>
              Lessons
            </button>
          )}
          {eventTypes != null && (
            <button onClick={() => setTab("eventTypes")} className={`${tabClass(tab === "eventTypes")} sm:flex-1`}>
              Event Types
            </button>
          )}
        </div>

        {/* Owned internally — not passed as a ReactNode prop. Full-width on
            mobile for a comfortable tap target; reverts to its own natural
            (shrink-0) width at sm+ — EventsCreateButton's own className is
            never touched, only this wrapping element's width. */}
        <div className="w-full sm:w-auto [&>button]:w-full sm:[&>button]:w-auto">
          <EventsCreateButton courts={courts} clubId={clubId} clubTimezone={clubTimezone} currency={currency} isAdmin={isAdmin} onCreated={handleCreated} />
        </div>
      </div>

      {/* Tab panels — all rendered; CSS hides the inactive ones */}
      <div className={tab === "upcoming" ? undefined : "hidden"}>{upcoming}</div>
      <div className={tab === "manage"   ? undefined : "hidden"}>{manage}</div>
      {lessons != null && (
        <div className={tab === "lessons" ? undefined : "hidden"}>{lessons}</div>
      )}
      {eventTypes != null && (
        <div className={tab === "eventTypes" ? undefined : "hidden"}>{eventTypes}</div>
      )}
    </>
  );
}
