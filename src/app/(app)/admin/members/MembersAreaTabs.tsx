"use client";

// Phase 43B-3E — Admin Members hub tab navigation. Route-backed (three
// real routes: /admin/members, /admin/members/types, /admin/members/
// waivers — never a client-only tab-switch state), so a direct refresh on
// any of the three and browser Back/Forward both work exactly like any
// other navigation in the app.
//
// Phase 43B-3E2 — restyled onto the shared PageTabs component (src/
// components/PageTabs.tsx), Court Time's one canonical page-level
// tab-strip treatment (previously only matched on /admin/courts,
// /admin/communications, /admin/lessons; this file originally used the
// OTHER, segmented-pill visual pattern instead). Only the visual chrome
// changed — still Link-backed (never onClick), still driven by
// usePathname() for active-state, since these three tabs are genuinely
// separate pages (different data loads, different auth posture: Members
// is Admin+Staff, the other two are Admin-only) rather than panels over
// one shared data set.
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

import { usePathname } from "next/navigation";
import PageTabs from "@/components/PageTabs";

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
    <div className="mx-4 mt-3 mb-1">
      <PageTabs
        ariaLabel="Members area"
        items={TABS.map((tab) => ({
          key: tab.href,
          label: tab.label,
          href: tab.href,
          active: pathname === tab.href,
        }))}
      />
    </div>
  );
}
