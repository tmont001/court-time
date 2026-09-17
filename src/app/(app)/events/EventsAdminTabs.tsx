"use client";

// EventsAdminTabs — renders an Upcoming / Manage control for admin and pro
// users. Both panels are rendered into the DOM; only one is visible at a
// time. This preserves client state in AdminEventsClient (e.g. pagination)
// when switching between tabs — deliberately NOT converted to Link/
// searchParams navigation (that would remount AdminEventsClient on every
// switch, losing that state), only its visual chrome changed.
// An optional `headerAction` (e.g. "+ Create Event" button) appears to the right
// of the tab selector, visible on both tabs.
//
// Phase 43B-3E2 — restyled onto the shared PageTabs component (src/
// components/PageTabs.tsx), Court Time's one canonical page-level
// tab-strip treatment (previously only matched on /admin/courts,
// /admin/communications, /admin/lessons). Still onClick-based (PageTabs
// supports either href or onClick per item) — the underlying client
// tab-switch mechanism, and everything it preserves above, is unchanged.

import { useState } from "react";
import PageTabs from "@/components/PageTabs";

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
        <PageTabs
          className="flex-1"
          items={[
            { key: "upcoming", label: "Upcoming", active: tab === "upcoming", onClick: () => setTab("upcoming") },
            { key: "manage", label: "Manage", active: tab === "manage", onClick: () => setTab("manage") },
          ]}
        />
        {/* e.g. "+ Create Event" — visible on both tabs */}
        {headerAction}
      </div>

      {/* Both panels rendered; CSS hides the inactive one to preserve component state */}
      <div className={tab === "upcoming" ? undefined : "hidden"}>{upcoming}</div>
      <div className={tab === "manage"   ? undefined : "hidden"}>{manage}</div>
    </>
  );
}
