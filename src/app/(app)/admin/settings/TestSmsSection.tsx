"use client";

import { useState, useTransition } from "react";
import { sendTestSms } from "./actions";

interface Props {
  twilioConfigured: boolean;
}

export default function TestSmsSection({ twilioConfigured }: Props) {
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
      <p className="text-sm font-semibold text-gray-900">Test SMS</p>
      <p className="text-xs text-gray-500">
        Sends a test message to your own phone number. Requires SMS enabled in your profile.
      </p>

      {!twilioConfigured ? (
        <p className="text-xs text-gray-400">SMS is not configured yet.</p>
      ) : (
        <>
          <button
            onClick={handleSend}
            disabled={isPending}
            className="px-4 py-2 rounded-lg bg-gray-900 text-white text-sm font-medium disabled:opacity-40"
          >
            {isPending ? "Sending…" : "Send test message to my phone"}
          </button>

          {result?.sid && (
            <p className="text-xs font-medium text-green-600">
              Sent — SID: {result.sid}
            </p>
          )}
          {result?.error && (
            <p className="text-xs font-medium text-red-500">{result.error}</p>
          )}
        </>
      )}
    </div>
  );
}
