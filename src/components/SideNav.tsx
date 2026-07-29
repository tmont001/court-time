"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ClubMembershipOption } from "@/lib/supabase/user";
import ClubMembershipList from "./ClubMembershipList";

// ─── Icons ───────────────────────────────────────────────────────────────────

function CalendarIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
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
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
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
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
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
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function OverviewIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

function MembersIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function CourtsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06-.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function AuditLogIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </svg>
  );
}

function ReportsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="20" x2="18" y2="10" />
      <line x1="12" y1="20" x2="12" y2="4" />
      <line x1="6" y1="20" x2="6" y2="14" />
    </svg>
  );
}

function ProfileIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

// ─── Shared pieces ────────────────────────────────────────────────────────────

function NavLink({
  href,
  label,
  Icon,
  pathname,
}: {
  href: string;
  label: string;
  Icon: () => React.ReactElement;
  pathname: string;
}) {
  const isActive = pathname === href || pathname.startsWith(href + "/");
  return (
    <Link
      href={href}
      className={`relative flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm motion-safe:transition-all motion-safe:duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset ${
        isActive
          ? "bg-accent/20 dark:bg-accent/25 text-accent font-semibold"
          : "font-medium text-gray-500 dark:text-gray-400 hover:bg-accent/10 dark:hover:bg-accent/15 hover:text-accent active:bg-accent/20 dark:active:bg-accent/25 active:text-accent"
      }`}
    >
      {isActive && (
        <span
          className="absolute left-0 inset-y-1.5 w-0.5 rounded-full bg-accent"
          aria-hidden="true"
        />
      )}
      <Icon />
      {label}
    </Link>
  );
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-3 pt-4 pb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 select-none">
      {children}
    </p>
  );
}

// ─── SideNav ─────────────────────────────────────────────────────────────────

interface Props {
  userRole?: string;
  clubName?: string;
  /** Phase 26E1: the caller's own active memberships. One membership (the
   * common case) preserves the plain static club-name text below. Two or
   * more render it as a switcher trigger instead. */
  memberships?: ClubMembershipOption[];
}

export default function SideNav({ userRole = "member", clubName, memberships = [] }: Props) {
  const pathname = usePathname();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const canSwitch = memberships.length > 1;

  return (
    <nav
      className="hidden md:flex flex-col fixed left-0 top-0 bottom-0 w-60 border-r border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 z-40 motion-safe:transition-colors motion-safe:duration-150"
      aria-label="Main navigation"
    >
      {/* Brand header — same height as the page Header (h-14 = 3.5rem) */}
      <div className="relative h-14 flex flex-col items-start justify-center px-4 border-b border-gray-200 dark:border-gray-700 shrink-0 overflow-visible">
        <span className="text-sm font-semibold leading-none text-gray-900 dark:text-gray-100">Court Time</span>
        {clubName && !canSwitch && (
          <span
            className="mt-0.5 text-xs leading-none text-gray-500 dark:text-gray-400 truncate w-full"
            title={clubName}
          >
            {clubName}
          </span>
        )}
        {clubName && canSwitch && (
          <div className="mt-0.5 w-full">
            <button
              type="button"
              onClick={() => setSwitcherOpen((open) => !open)}
              onKeyDown={(e) => { if (e.key === "Escape") setSwitcherOpen(false); }}
              aria-haspopup="listbox"
              aria-expanded={switcherOpen}
              aria-label={`Switch club — currently ${clubName}`}
              className="flex items-center gap-1 max-w-full text-xs leading-none text-gray-500 dark:text-gray-400 hover:text-accent motion-safe:transition-colors motion-safe:duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
            >
              <span className="truncate">{clubName}</span>
              <ChevronIcon />
            </button>

            {switcherOpen && (
              <>
                {/* Click-outside backdrop */}
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setSwitcherOpen(false)}
                  aria-hidden="true"
                />
                <div className="absolute left-2 right-2 top-full mt-1 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg z-50 overflow-hidden">
                  <ClubMembershipList memberships={memberships} />
                </div>
              </>
            )}
          </div>
        )}
      </div>

      <div className="flex-1 py-2 flex flex-col gap-0.5 px-2 overflow-y-auto">
        {userRole === "admin" ? (
          <>
            <GroupLabel>Main</GroupLabel>
            <NavLink href="/admin/overview" label="Overview"     Icon={OverviewIcon}  pathname={pathname} />
            <NavLink href="/calendar"       label="Calendar"     Icon={CalendarIcon}  pathname={pathname} />
            <NavLink href="/events"         label="Events"       Icon={EventsIcon}    pathname={pathname} />
            <NavLink href="/admin/lessons"  label="Lessons"      Icon={LessonsIcon}   pathname={pathname} />
            <NavLink href="/my-schedule"    label="Bookings"     Icon={ScheduleIcon}  pathname={pathname} />

            <GroupLabel>Club</GroupLabel>
            <NavLink href="/admin/members"    label="Members"      Icon={MembersIcon}    pathname={pathname} />
            <NavLink href="/admin/courts"     label="Courts"       Icon={CourtsIcon}     pathname={pathname} />
            <NavLink href="/admin/settings"   label="Club Settings" Icon={SettingsIcon}  pathname={pathname} />
            <NavLink href="/admin/audit-log"  label="Audit Log"    Icon={AuditLogIcon}   pathname={pathname} />
            <NavLink href="/admin/reports"    label="Reports"      Icon={ReportsIcon}    pathname={pathname} />

            <GroupLabel>Personal</GroupLabel>
            <NavLink href="/profile"        label="Profile"      Icon={ProfileIcon}   pathname={pathname} />
          </>
        ) : userRole === "pro" ? (
          <>
            <NavLink href="/calendar"      label="Calendar" Icon={CalendarIcon} pathname={pathname} />
            <NavLink href="/events"        label="Events"   Icon={EventsIcon}   pathname={pathname} />
            <NavLink href="/admin/lessons" label="Lessons"  Icon={LessonsIcon}  pathname={pathname} />
            <NavLink href="/my-schedule"   label="Bookings" Icon={ScheduleIcon} pathname={pathname} />
            <NavLink href="/profile"       label="Profile"  Icon={ProfileIcon}  pathname={pathname} />
          </>
        ) : (
          <>
            <NavLink href="/calendar"    label="Calendar" Icon={CalendarIcon} pathname={pathname} />
            <NavLink href="/events"      label="Events"   Icon={EventsIcon}   pathname={pathname} />
            <NavLink href="/my-schedule" label="Bookings" Icon={ScheduleIcon} pathname={pathname} />
            <NavLink href="/profile"     label="Profile"  Icon={ProfileIcon}  pathname={pathname} />
          </>
        )}
      </div>
    </nav>
  );
}
