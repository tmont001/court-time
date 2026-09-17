import Link from "next/link";

// Phase 43B-3E2 — Court Time's ONE canonical page/route-level navigation
// tab strip. Extracted from the visual pattern already established
// identically on /admin/courts, /admin/communications, and /admin/lessons
// (ct-card, divide-x, flex-1 cells, active = accent fill, inactive =
// quiet gray with a hover tint) — the "approved tab-strip treatment"
// several of those pages' own comments already referenced by name before
// a shared component existed to back that claim.
//
// Deliberately a PLAIN component (no "use client"): it renders only
// <Link> (given `href`) or a bare <button onClick> (given `onClick`) per
// item, so it is safe to import directly into a Server Component page
// (courts/communications/lessons — which pass only serializable `href`
// strings, never functions, so no client boundary is introduced there)
// AND into an already-"use client" component (EventsAdminTabs,
// AdminPaymentsClient, MembersAreaTabs — which pass `onClick` handlers,
// safe because those call sites are already client). This preserves
// every surface's existing server/client boundary and navigation
// mechanism exactly — Link-backed pages stay Link-backed (URL/searchParams
// navigation, direct-link/refresh/Back-Forward all keep working), and
// client-state pages stay client-state (no route/query mechanism was
// introduced where one didn't already exist) — only the VISUAL chrome is
// now shared.
//
// This is intentionally narrow: page/route-level navigation only. Local
// filters/segmented controls (Active/Past/All, role filters, date-range
// pickers, etc.) are a different UI concept and must never be routed
// through this component merely because they happen to look similar.

export interface PageTabItem {
  key: string;
  label: string;
  active: boolean;
  href?: string;
  onClick?: () => void;
}

interface PageTabsProps {
  items: PageTabItem[];
  ariaLabel?: string;
  className?: string;
}

export default function PageTabs({ items, ariaLabel, className }: PageTabsProps) {
  return (
    <div
      className={`ct-card flex divide-x divide-gray-100 dark:divide-gray-800 overflow-hidden${className ? ` ${className}` : ""}`}
      aria-label={ariaLabel}
    >
      {items.map((item) => {
        const cellClassName = `flex-1 flex items-center justify-center text-center leading-tight px-2 py-2 text-xs font-medium motion-safe:transition-colors motion-safe:duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset ${
          item.active
            ? "bg-accent text-white"
            : "text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800/50"
        }`;

        if (item.href) {
          return (
            <Link
              key={item.key}
              href={item.href}
              aria-current={item.active ? "page" : undefined}
              className={cellClassName}
            >
              {item.label}
            </Link>
          );
        }

        return (
          <button
            key={item.key}
            type="button"
            onClick={item.onClick}
            aria-current={item.active ? "page" : undefined}
            className={cellClassName}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
