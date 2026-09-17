"use client";

// Phase 43B-3E — Admin Members hub tab navigation. Route-backed (three
// real routes: /admin/members, /admin/members/types, /admin/members/
// waivers — never a client-only tab-switch state), so a direct refresh on
// any of the three and browser Back/Forward both work exactly like any
// other navigation in the app. Visual language reused verbatim from the
// existing segmented-control pattern (EventsAdminTabs.tsx) — a new
// framework was deliberately NOT introduced, only <Link>/usePathname()
// swapped in for state-based tab switching, since these three tabs are
// genuinely separate pages (different data loads, different auth
// posture: Members is Admin+Staff, the other two are Admin-only) rather
// than panels over one shared data set.
//
// Rendered only on these three exact routes — never on /admin/members/
// [id] (the Member Detail drill-down page), which intentionally has no
// tab strip of its own.
//
// Runtime correction (same checkpoint): /admin/members/types and
// /admin/members/waivers are Admin-only routes (server-side redirect to
// /calendar for anyone else) — that authorization was always correct,
// but rendering both links unconditionally to Staff on the Members tab
// let them see two tabs that would immediately redirect them away,
// which is confusing UX even though nothing insecure was happening.
// canManageMemberships is a narrow boolean the caller derives from the
// SAME already-loaded canonical profile role it already has — never a
// second auth query here, never a role name threaded through this
// component. Staff (canManageMemberships=false) renders nothing at all
// rather than a redundant one-tab strip; Admin (true) sees all three.
// The underlying route gates are unchanged either way — this is a
// visibility-only correction, not an authorization change.

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/admin/members", label: "Members" },
  { href: "/admin/members/types", label: "Membership Types" },
  { href: "/admin/members/waivers", label: "Waivers" },
] as const;

interface Props {
  canManageMemberships: boolean;
}

export default function MembersAreaTabs({ canManageMemberships }: Props) {
  const pathname = usePathname();

  if (!canManageMemberships) return null;

  return (
    <div
      role="tablist"
      aria-label="Members area"
      className="mx-4 mt-3 mb-1 flex p-1 gap-1 bg-gray-100 dark:bg-gray-800 rounded-xl overflow-x-auto"
    >
      {TABS.map((tab) => {
        const isActive = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            role="tab"
            aria-selected={isActive}
            className={`flex-1 text-center py-1.5 px-2 rounded-lg text-xs font-medium whitespace-nowrap motion-safe:transition-colors motion-safe:duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
              isActive
                ? "bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm"
                : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
