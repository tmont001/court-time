"use client";

import { useState, useEffect } from "react";

interface Props {
  userId: string;
  clubId: string;
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
    <div className="mx-4 mt-4 rounded-xl border border-accent/30 bg-accent/5 dark:bg-accent/10 px-4 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">
            Welcome to the club!
          </p>
          <ul className="text-xs text-gray-600 dark:text-gray-400 space-y-1">
            <li>
              <span className="font-medium text-gray-800 dark:text-gray-200">Calendar</span>
              {" "}— Find and reserve courts
            </li>
            <li>
              <span className="font-medium text-gray-800 dark:text-gray-200">Events</span>
              {" "}— Join club activities and scheduled sessions
            </li>
            <li>
              <span className="font-medium text-gray-800 dark:text-gray-200">Bookings</span>
              {" "}— View your reservations and event history
            </li>
            <li>
              <span className="font-medium text-gray-800 dark:text-gray-200">Account</span>
              {" "}— Update your profile, notifications, and get help
            </li>
          </ul>
        </div>
        <button
          onClick={dismiss}
          className="shrink-0 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-xl leading-none mt-0.5"
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>
    </div>
  );
}
