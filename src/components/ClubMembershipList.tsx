"use client";

import { useState, useTransition } from "react";
import type { ClubMembershipOption } from "@/lib/supabase/user";
import { switchActiveClubAction } from "./switchClubAction";
import { publishActiveClubChanged } from "@/lib/activeClubChannel";

// Shared switching UI — rendered inside a desktop dropdown panel (SideNav),
// a mobile header popover, a mobile bottom sheet (BottomNav), and the
// /profile Clubs section. The container chrome differs per surface, but the
// list, selection, loading, and error behavior live here exactly once. No
// membership-management controls (no leave/remove/reactivate) — selecting a
// row only ever calls switchActiveClubAction.

const ROLE_LABELS: Record<string, string> = {
  member: "Member",
  pro:    "Pro",
  admin:  "Admin",
};

interface Props {
  memberships: ClubMembershipOption[];
}

export default function ClubMembershipList({ memberships }: Props) {
  const [isPending, startTransition] = useTransition();
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function handleSelect(clubId: string) {
    if (isPending) return; // prevent repeated clicks while switching
    setError(null);
    setSwitchingId(clubId);
    startTransition(async () => {
      const result = await switchActiveClubAction(clubId);
      if ("error" in result) {
        setError(result.error);
        setSwitchingId(null);
        return; // a failed switch never publishes a cross-tab change
      }

      // Confirmed success — notify other tabs, then perform a full browser
      // navigation (not router.push/refresh) so this tab lands on a
      // completely fresh /calendar load. router.push to a route the app
      // may already be on can preserve mounted client component state
      // (this row's own "Switching…" state never clears, and CalendarShell
      // can render a beat before its new courts/clubId props land) — a hard
      // navigation discards the whole tree and reloads it from scratch, so
      // neither can happen. Publishing happens before navigation so the
      // signal isn't lost if navigation is instant.
      publishActiveClubChanged();
      window.location.assign("/calendar");
    });
  }

  return (
    <div>
      {error && (
        <p
          className="px-3 py-2 text-xs text-red-600 dark:text-red-400"
          role="alert"
        >
          {error}
        </p>
      )}
      <ul role="listbox" aria-label="Switch club" className="divide-y divide-gray-100 dark:divide-gray-700">
        {memberships.map((m) => {
          const isSwitchingThis = switchingId === m.clubId;
          return (
            <li key={m.clubId} role="presentation">
              <button
                type="button"
                role="option"
                aria-selected={m.isActiveClub}
                disabled={isPending || m.isActiveClub}
                onClick={() => handleSelect(m.clubId)}
                className={`w-full flex items-center justify-between gap-3 px-3 py-2.5 text-left text-sm motion-safe:transition-colors motion-safe:duration-150 disabled:cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset ${
                  m.isActiveClub
                    ? "text-accent font-semibold"
                    : "text-gray-700 dark:text-gray-200 hover:bg-accent/10 dark:hover:bg-accent/15 active:bg-accent/20"
                }`}
              >
                <span className="flex flex-col min-w-0">
                  <span className="truncate">{m.clubName}</span>
                  <span className="text-xs font-normal text-gray-500 dark:text-gray-400">
                    {ROLE_LABELS[m.role] ?? m.role}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-gray-400 dark:text-gray-500">
                  {isSwitchingThis ? "Switching…" : m.isActiveClub ? "✓ Current" : null}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
