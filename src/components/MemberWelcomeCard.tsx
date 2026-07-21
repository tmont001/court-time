"use client";

import { useState, useEffect } from "react";

interface Props {
  userId: string;
  clubId: string;
}

function CourtIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <line x1="12" y1="4" x2="12" y2="20" />
      <line x1="2" y1="12" x2="22" y2="12" />
    </svg>
  );
}

export default function MemberWelcomeCard({ userId, clubId }: Props) {
  // Default true prevents flash on SSR/hydration; real value set in effect.
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    const key = `ct_welcome_${userId}_${clubId}`;
    setDismissed(localStorage.getItem(key) === "1");
  }, [userId, clubId]);

  function dismiss() {
    localStorage.setItem(`ct_welcome_${userId}_${clubId}`, "1");
    setDismissed(true);
  }

  if (dismissed) return null;

  return (
    <div className="mx-4 mt-4 rounded-xl border border-accent/30 bg-accent/5 dark:bg-accent/10 px-4 py-3">
      {/* Header row */}
      <div className="flex items-start justify-between gap-3 mb-2.5">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="shrink-0 w-7 h-7 rounded-full bg-accent/15 dark:bg-accent/20 flex items-center justify-center text-accent">
            <CourtIcon />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 leading-snug">
              Welcome to Court Time
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 leading-snug">
              Everything you need to book courts, join events, and manage your schedule.
            </p>
          </div>
        </div>
        <button
          onClick={dismiss}
          className="shrink-0 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-xl leading-none mt-0.5 motion-safe:transition-colors motion-safe:duration-100"
          aria-label="Dismiss welcome card"
        >
          ×
        </button>
      </div>

      {/* Two-column info grid: stacks on mobile, side-by-side on sm+ */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
        <p className="text-xs text-gray-600 dark:text-gray-400">
          <span className="font-medium text-gray-800 dark:text-gray-200">Calendar</span>
          {" "}— Find and reserve courts
        </p>
        <p className="text-xs text-gray-600 dark:text-gray-400">
          <span className="font-medium text-gray-800 dark:text-gray-200">Events</span>
          {" "}— Join club activities and scheduled sessions
        </p>
        <p className="text-xs text-gray-600 dark:text-gray-400">
          <span className="font-medium text-gray-800 dark:text-gray-200">Bookings</span>
          {" "}— View your reservations and event history
        </p>
        <p className="text-xs text-gray-600 dark:text-gray-400">
          <span className="font-medium text-gray-800 dark:text-gray-200">Account</span>
          {" "}— Update your profile, notifications, and get help
        </p>
      </div>
    </div>
  );
}
