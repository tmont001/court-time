"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import BottomSheet from "@/components/BottomSheet";

// ─── Icons ───────────────────────────────────────────────────────────────────

function CalendarIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  );
}

function EventsIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" />
      <path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" />
      <path d="M4 22h16" />
      <path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22" />
      <path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" />
      <path d="M18 2H6v7a6 6 0 0 0 12 0V2z" />
    </svg>
  );
}

function LessonsIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <rect x="8" y="2" width="8" height="4" rx="1" />
      <line x1="8" y1="13" x2="16" y2="13" />
      <line x1="8" y1="17" x2="13" y2="17" />
    </svg>
  );
}

function ScheduleIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

// ─── BottomNav ────────────────────────────────────────────────────────────────

interface Props {
  userRole?: string;
}

export default function BottomNav({ userRole = "member" }: Props) {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);

  const isAdminOrPro = userRole === "admin" || userRole === "pro";

  const mainTabs: Array<{ label: string; href: string; Icon: () => React.ReactElement }> = [
    { label: "Calendar", href: "/calendar",      Icon: CalendarIcon },
    { label: "Events",   href: "/events",         Icon: EventsIcon   },
    ...(isAdminOrPro ? [{ label: "Lessons", href: "/admin/lessons", Icon: LessonsIcon }] : []),
    { label: "Bookings", href: "/my-schedule",   Icon: ScheduleIcon },
  ];

  const moreLinks = userRole === "admin"
    ? [
        { label: "Overview",      href: "/admin/overview",        exact: false },
        { label: "Members",       href: "/admin/members",         exact: false },
        { label: "Courts",        href: "/admin/courts",          exact: false },
        { label: "Club Settings", href: "/admin/settings",        exact: false },
        { label: "Audit Log",     href: "/admin/audit-log",       exact: false },
        { label: "Profile",       href: "/profile",               exact: true  },
        { label: "Notifications", href: "/profile/notifications", exact: true  },
        { label: "Security",      href: "/profile/security",      exact: true  },
      ]
    : [
        { label: "Profile",       href: "/profile",               exact: true  },
        { label: "Notifications", href: "/profile/notifications", exact: true  },
        { label: "Security",      href: "/profile/security",      exact: true  },
      ];

  function isLinkActive(href: string, exact: boolean) {
    return exact ? pathname === href : (pathname === href || pathname.startsWith(href + "/"));
  }

  const isMoreActive = moreLinks.some(l => isLinkActive(l.href, l.exact));

  return (
    <>
      <nav
        className="md:hidden fixed bottom-0 left-0 right-0 border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 flex z-40 pb-[env(safe-area-inset-bottom)] motion-safe:transition-colors motion-safe:duration-150"
        aria-label="Mobile navigation"
      >
        {mainTabs.map((tab) => {
          const isActive = pathname === tab.href || pathname.startsWith(tab.href + "/");
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={`flex-1 flex flex-col items-center justify-center gap-1 h-16 motion-safe:transition-all motion-safe:duration-100 ${
                isActive
                  ? "text-accent border-t-2 border-accent"
                  : "text-gray-500 dark:text-gray-400 active:text-accent"
              }`}
            >
              <tab.Icon />
              <span className="text-xs font-medium leading-none">{tab.label}</span>
            </Link>
          );
        })}

        {/* More */}
        <button
          onClick={() => setMoreOpen(true)}
          className={`flex-1 flex flex-col items-center justify-center gap-1 h-16 motion-safe:transition-all motion-safe:duration-100 ${
            isMoreActive
              ? "text-accent border-t-2 border-accent"
              : "text-gray-500 dark:text-gray-400 active:text-accent"
          }`}
          aria-label="More"
        >
          <MoreIcon />
          <span className="text-xs font-medium leading-none">More</span>
        </button>
      </nav>

      {moreOpen && (
        <BottomSheet onClose={() => setMoreOpen(false)} className="px-4 pb-8">
          <p className="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wide mb-3">
            More
          </p>
          <div className="rounded-xl border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-700 overflow-hidden">
            {moreLinks.map(link => {
              const isActive = isLinkActive(link.href, link.exact);
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  onClick={() => setMoreOpen(false)}
                  className={`ct-row-interactive ${isActive ? "text-accent font-semibold" : ""}`}
                >
                  {link.label}
                  <span className="text-gray-400 dark:text-gray-500">›</span>
                </Link>
              );
            })}
          </div>
        </BottomSheet>
      )}
    </>
  );
}
