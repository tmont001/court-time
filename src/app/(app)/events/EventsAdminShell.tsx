"use client";

// EventsAdminShell — unified admin/pro shell for /events.
// Owns tab state, renders the Upcoming/Manage/(Event Types) segmented
// control, and renders exactly one "+ Create Event" button. Courts,
// clubId, and clubTimezone are passed as primitive props so
// EventsCreateButton can be instantiated internally — avoiding the React
// key warning that occurs when a ReactNode containing client components
// is passed across the RSC/client boundary as a generic headerAction prop.
//
// Phase 43B-3E2 browser-QA delta — this is the actual visible page-level
// strip on /events (the prior standardization pass only touched the
// separate, smaller EventsAdminTabs.tsx, which this page does not use).
// Restyled onto the shared PageTabs component (src/components/PageTabs.tsx,
// Court Time's one canonical page-level tab-strip treatment) exactly like
// EventsAdminTabs.tsx already was — still onClick/client-tab-state,
// nothing about the underlying mechanism changed. The Lessons tab/panel
// was also removed here (IA cleanup): /admin/lessons is already the
// canonical Lesson Requests + Lesson Types destination, so this was a
// redundant duplicate surface. Sidebar Lessons navigation, /admin/lessons
// itself, and all lesson request/type behavior are untouched — this only
// removes the tab that duplicated them here.

import { useState } from "react";
import { useRouter } from "next/navigation";
import PageTabs from "@/components/PageTabs";
import EventsCreateButton from "./EventsCreateButton";

type Tab = "upcoming" | "manage" | "eventTypes";
type Court = { id: string; name: string; display_order: number };

interface Props {
  upcoming:     React.ReactNode;
  manage:       React.ReactNode;
  // Admin UX Checkpoint 3 — Events IA. Admin-only: the caller (page.tsx)
  // passes this prop ONLY when profile.role === "admin", so Staff/Pro
  // never receive it and this tab literally does not exist in their
  // render tree (not hidden CSS, not an empty panel) — see
  // EventTypesSection's own server-enforced RPC authorization for the
  // actual security boundary this UI gate mirrors.
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

export default function EventsAdminShell({ upcoming, manage, eventTypes, courts, clubId, clubTimezone, currency, isAdmin, initialTab = "upcoming" }: Props) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>(initialTab);

  // After a successful create: switch to Manage (so the new event is visible)
  // then refresh RSC data so AdminEventsClient receives updated initialEvents.
  function handleCreated() {
    setTab("manage");
    router.refresh();
  }

  return (
    <>
      {/* Tab selector + Create Event button. Same responsive row as
          before: tabs get their own full-width row on mobile with Create
          Event below it, and revert to a single inline row (tabs flex-1,
          button shrink-0) at sm+. PageTabs' own flex/flex-1 cells already
          divide available width equally regardless of viewport, so the
          earlier mobile-only grid-cols logic (needed only to avoid a
          blank grid cell across a variable 3/4-tab count) is no longer
          needed now that this strip is always 2 or 3 items — the exact
          shape /admin/courts and /admin/communications already prove out
          with plain flex. */}
      <div className="mx-4 mt-3 mb-1 flex flex-col gap-2 sm:flex-row sm:items-center">
        <PageTabs
          className="flex-1"
          items={[
            { key: "upcoming", label: "Upcoming", active: tab === "upcoming", onClick: () => setTab("upcoming") },
            { key: "manage", label: "Manage", active: tab === "manage", onClick: () => setTab("manage") },
            ...(eventTypes != null
              ? [{ key: "eventTypes", label: "Event Types", active: tab === "eventTypes", onClick: () => setTab("eventTypes") }]
              : []),
          ]}
        />

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
      {eventTypes != null && (
        <div className={tab === "eventTypes" ? undefined : "hidden"}>{eventTypes}</div>
      )}
    </>
  );
}
