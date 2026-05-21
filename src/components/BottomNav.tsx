"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

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

function ScheduleIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function ProfileIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
    </svg>
  );
}

type Tab = {
  label: string;
  href: string;
  Icon: () => React.ReactElement;
  smallLabel?: boolean;
};

const tabs: Tab[] = [
  { label: "Calendar",    href: "/calendar",    Icon: CalendarIcon },
  { label: "Events",      href: "/events",       Icon: EventsIcon },
  { label: "My Schedule", href: "/my-schedule",  Icon: ScheduleIcon, smallLabel: true },
  { label: "Profile",     href: "/profile",      Icon: ProfileIcon },
];

export default function BottomNav() {
  const pathname = usePathname();

  return (
    <nav className="fixed bottom-0 left-0 right-0 h-16 border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 flex z-40">
      {tabs.map((tab) => {
        const isActive = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`flex-1 flex flex-col items-center justify-center gap-1 ${
              isActive
                ? "text-gray-900 dark:text-gray-100 border-t-2 border-gray-900 dark:border-gray-100"
                : "text-gray-400 dark:text-gray-500"
            }`}
          >
            <tab.Icon />
            <span className={`font-medium leading-none ${tab.smallLabel ? "text-[10px]" : "text-xs"}`}>
              {tab.label}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
