"use client";

import { useEffect, useState } from "react";
import ClubMembershipList from "@/components/ClubMembershipList";
import type { ClubMembershipOption } from "@/lib/supabase/user";

// Mobile-only entry point to club switching from the top-left header icon.
// Unlike BottomNav's More -> "Switch club" (a full-width pull-up sheet,
// rendered via ResponsiveSheet), this is a small anchored popover directly
// below the button — a pull-up sheet here would be partially obstructed by
// the fixed bottom navigation and the calendar's floating create button on
// pages like Calendar. Reuses ClubMembershipList (and, through it,
// switchActiveClubAction) unmodified — no second membership-list or
// switching implementation.

function ChevronIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

interface Props {
  clubName:    string;
  icon:        React.ReactNode;
  memberships: ClubMembershipOption[];
}

export default function HeaderClubSwitcherButton({ clubName, icon, memberships }: Props) {
  const [open, setOpen] = useState(false);

  // Escape closes regardless of where focus lands inside the popover (a
  // membership row button, not necessarily the trigger itself).
  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Switch club — currently ${clubName}`}
        className="flex items-center gap-0.5 -m-2 p-2 rounded-lg motion-safe:transition-colors motion-safe:duration-150 hover:bg-gray-100 dark:hover:bg-gray-800 active:bg-gray-200 dark:active:bg-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        {icon}
        <span className="text-gray-400 dark:text-gray-500">
          <ChevronIcon />
        </span>
      </button>

      {open && (
        <>
          {/* Invisible outside-tap catcher — above page content/floating
              controls, below the popover card itself. */}
          <div
            className="fixed inset-0 z-50"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />

          {/* Anchored card, not a full-width sheet. Pinned to the button's
              left edge (matches the header's own left padding, so it never
              extends past the left viewport edge) and capped at 320px or
              viewport-width-minus-margin, whichever is smaller, so it never
              extends past the right edge either. z-[60] renders it above
              Calendar content, the floating "+ Event" button (z-30),
              headers (z-30), and the fixed bottom navigation (z-40). */}
          <div
            className="absolute left-0 top-full mt-2 z-[60] w-[min(320px,calc(100vw-2rem))] max-h-[60vh] overflow-y-auto rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg motion-safe:transition-opacity motion-safe:duration-150"
          >
            <ClubMembershipList memberships={memberships} />
          </div>
        </>
      )}
    </div>
  );
}
