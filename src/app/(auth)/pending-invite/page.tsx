"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function PendingInvitePage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleSignOut() {
    setLoading(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    // Only navigate after sign-out is complete; the middleware will no longer
    // redirect an unauthenticated user away from /sign-in.
    router.push("/sign-in");
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100 mb-3">
        Account not connected
      </h1>
      <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
        Your account isn&apos;t connected to a club yet.
      </p>
      <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">
        Reopen the invite link your admin sent you, or ask them to generate a
        new one.
      </p>

      <button
        onClick={handleSignOut}
        disabled={loading}
        className="w-full py-2.5 rounded-xl bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-semibold disabled:opacity-40"
      >
        {loading ? "Signing out…" : "Sign out and return to sign in"}
      </button>
    </div>
  );
}
