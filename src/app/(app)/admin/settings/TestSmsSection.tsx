"use client";

import { useState, useTransition } from "react";
import { sendTestSms } from "./actions";

// Phase 31D: no longer takes a `twilioConfigured` prop — the parent
// (DeliveryDiagnosticsSection) only renders this component at all when SMS
// is configured, so there is no "not configured" branch to render here
// anymore. sendTestSms itself, and its existing success/error feedback, are
// unchanged.
export default function TestSmsSection() {
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<{ sid?: string; error?: string } | null>(null);

  function handleSend() {
    setResult(null);
    startTransition(async () => {
      const res = await sendTestSms();
      setResult(res);
    });
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Sends a test message to your own phone number. Requires SMS enabled in your profile.
      </p>

      <button
        onClick={handleSend}
        disabled={isPending}
        className="px-3 py-1.5 rounded-lg bg-accent text-white dark:text-gray-900 text-xs font-medium disabled:opacity-40"
      >
        {isPending ? "Sending…" : "Send test message to my phone"}
      </button>

      {result?.sid && (
        <p role="status" className="text-xs font-medium text-green-600 dark:text-green-400">
          Sent — SID: {result.sid}
        </p>
      )}
      {result?.error && (
        <p role="alert" className="text-xs font-medium text-red-500 dark:text-red-400">{result.error}</p>
      )}
    </div>
  );
}
