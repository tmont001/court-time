"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

interface Props {
  email: string;
}

export default function PendingInviteClient({ email }: Props) {
  const [loading, setLoading] = useState(false);

  async function handleSignOut() {
    setLoading(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    // Hard navigation, not router.push — see SignOutButton.tsx for why an
    // identity change must be a hard application boundary.
    window.location.replace("/sign-in");
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100 mb-3">
        Not connected to a club
      </h1>

      <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
        Your account is not connected to a club yet.
      </p>

      {email && (
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-2">
          Signed in as{" "}
          <span className="font-medium text-gray-900 dark:text-gray-100">
            {email}
          </span>
          .
        </p>
      )}

      <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">
        Open the invitation link your club sent you to join. If you don&apos;t
        have a link, ask your club administrator to send you a new invitation.
      </p>

      <button
        onClick={handleSignOut}
        disabled={loading}
        className="w-full py-2.5 rounded-xl bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-semibold disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100"
      >
        {loading ? "Signing out…" : "Sign out and use a different account"}
      </button>
    </div>
  );
}
