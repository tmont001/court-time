"use client";

import { useState } from "react";
import { acceptInviteAction } from "./actions";

export default function AcceptButton({ code }: { code: string }) {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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

  return (
    <div className="mt-6 space-y-3">
      {error && (
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
      )}
      <button
        onClick={handleAccept}
        disabled={loading}
        className="w-full bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 rounded-md px-3 py-2 text-sm font-medium disabled:opacity-50"
      >
        {loading ? "Accepting…" : "Accept Invitation"}
      </button>
    </div>
  );
}
