"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

interface Props {
  userInitials: string;
  userName:    string;
  userEmail:   string;
}

export default function AccountMenu({ userInitials, userName, userEmail }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close]);

  async function handleSignOut() {
    close();
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/sign-in");
  }

  return (
    // Visible on all screen sizes. BottomNav "Account" tab also navigates to /profile.
    <div className="relative">
      {/* Trigger — initials avatar */}
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="Account menu"
        aria-expanded={open}
        className="ct-icon-button w-8 h-8 rounded-full bg-gray-100 dark:bg-gray-800 text-xs font-semibold text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 motion-safe:transition-colors motion-safe:duration-100"
      >
        {userInitials}
      </button>

      {open && (
        <>
          {/* Transparent click-away backdrop */}
          <div className="fixed inset-0 z-40" onClick={close} />

          {/* Dropdown panel */}
          <div
            className="ct-popover-enter fixed top-14 right-4 z-50 w-56 bg-white dark:bg-gray-800 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* User identity */}
            <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-700">
              {userName && (
                <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
                  {userName}
                </p>
              )}
              <p className="text-xs text-gray-500 dark:text-gray-400 truncate mt-0.5">
                {userEmail}
              </p>
            </div>

            {/* Nav links */}
            <nav className="py-1">
              <Link
                href="/profile"
                onClick={close}
                className="flex items-center px-4 py-2.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/60 hover:text-gray-900 dark:hover:text-gray-100 motion-safe:transition-colors motion-safe:duration-100"
              >
                Account
              </Link>
              <Link
                href="/profile/notifications"
                onClick={close}
                className="flex items-center px-4 py-2.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/60 hover:text-gray-900 dark:hover:text-gray-100 motion-safe:transition-colors motion-safe:duration-100"
              >
                Notifications
              </Link>
              <Link
                href="/profile/security"
                onClick={close}
                className="flex items-center px-4 py-2.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/60 hover:text-gray-900 dark:hover:text-gray-100 motion-safe:transition-colors motion-safe:duration-100"
              >
                Change Password
              </Link>
            </nav>

            <div className="border-t border-gray-100 dark:border-gray-700 py-1">
              <button
                onClick={handleSignOut}
                className="w-full text-left flex items-center px-4 py-2.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/60 hover:text-gray-900 dark:hover:text-gray-100 motion-safe:transition-colors motion-safe:duration-100"
              >
                Sign out
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
