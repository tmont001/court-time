"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { acceptInviteAction } from "./actions";

// Stable error string from actions.ts ERROR_MESSAGES.email_mismatch.
const EMAIL_MISMATCH_MSG = "This invite was sent to a different email address.";

interface Props {
  code:      string;
  userEmail: string;
}

export default function AcceptButton({ code, userEmail }: Props) {
  const router = useRouter();
  const [error,      setError]      = useState<string | null>(null);
  const [loading,    setLoading]    = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const isEmailMismatch = error === EMAIL_MISMATCH_MSG;

  async function handleAccept() {
    setError(null);
    setLoading(true);
    const result = await acceptInviteAction(code);
    if (result?.error) {
      setError(result.error);
      setLoading(false);
    }
    // On success the server action calls redirect(), which navigates away.
  }

  async function handleSignOut() {
    setSigningOut(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push(`/sign-in?redirect=/join/${code}`);
  }

  return (
    <div className="mt-6 space-y-3">
      {/* General error (not email_mismatch) */}
      {error && !isEmailMismatch && (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      )}

      {/* Email mismatch: contextual explanation with sign-out path */}
      {isEmailMismatch && (
        <div
          className="rounded-md bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 px-3 py-3 space-y-1"
          role="alert"
        >
          <p className="text-sm text-amber-800 dark:text-amber-300 font-medium">
            This invitation belongs to a different account.
          </p>
          {userEmail && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              You are signed in as{" "}
              <span className="font-medium">{userEmail}</span>.
            </p>
          )}
          <p className="text-xs text-amber-700 dark:text-amber-400">
            Sign out and sign in with the account that received this invitation.
          </p>
        </div>
      )}

      {/* Accept button — hidden when mismatch is confirmed */}
      {!isEmailMismatch && (
        <button
          onClick={handleAccept}
          disabled={loading}
          className="w-full bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 rounded-md px-3 py-2 text-sm font-medium disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100"
          aria-label="Accept invitation"
        >
          {loading ? "Accepting…" : "Accept Invitation"}
        </button>
      )}

      {/* Sign-out action — shown only on email mismatch */}
      {isEmailMismatch && (
        <button
          onClick={handleSignOut}
          disabled={signingOut}
          className="w-full border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-md px-3 py-2 text-sm font-medium disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 dark:focus-visible:ring-gray-500"
        >
          {signingOut ? "Signing out…" : "Sign out and use a different account"}
        </button>
      )}
    </div>
  );
}
