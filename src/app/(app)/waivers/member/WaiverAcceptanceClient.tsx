"use client";

// Phase 43A-2 — the only interactive piece of the waiver review/acceptance
// page: the "I Accept" action. The page itself (server component) already
// renders the exact current version's title/body from get_my_member_
// waiver_status() — this component never invents or receives any other
// version id, so it can never accept a client-guessed/stale version; the
// backend's own stale_waiver_version rejection is the authoritative
// backstop if a concurrent publish lands while this page is open.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { acceptMemberWaiverAction } from "./actions";
import { ACTION_BUTTON_PRIMARY, ACTION_BUTTON_SECONDARY } from "@/components/styles/actionButtonStyles";

interface Props {
  currentVersionId: string;
  initialStatus: "current" | "never_accepted" | "outdated";
  initialAcceptedAt: string | null;
}

export default function WaiverAcceptanceClient({ currentVersionId, initialStatus, initialAcceptedAt }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [status, setStatus] = useState(initialStatus);
  const [acceptedAt, setAcceptedAt] = useState(initialAcceptedAt);
  const [error, setError] = useState<string | null>(null);
  const [isStale, setIsStale] = useState(false);

  function handleAccept() {
    setError(null);
    setIsStale(false);
    startTransition(async () => {
      const result = await acceptMemberWaiverAction(currentVersionId);
      if (result.error) {
        setError(result.error);
        setIsStale(Boolean(result.stale));
        return;
      }
      setStatus("current");
      setAcceptedAt(result.acceptedAt ?? new Date().toISOString());
      router.refresh();
    });
  }

  if (status === "current") {
    return (
      <div className="rounded-xl border border-green-200 dark:border-green-900 bg-green-50 dark:bg-green-950/40 px-4 py-3">
        <p className="text-sm font-medium text-green-800 dark:text-green-400">Accepted</p>
        <p className="text-xs text-green-700 dark:text-green-500 mt-0.5">
          {acceptedAt ? `Accepted ${new Date(acceptedAt).toLocaleDateString()}` : "Accepted"}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {error && (
        <div className="px-3 py-2 rounded-lg text-xs font-medium bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400">
          {error}
        </div>
      )}
      <div className="flex items-center gap-3">
        {isStale ? (
          <button
            type="button"
            onClick={() => router.refresh()}
            className={ACTION_BUTTON_SECONDARY}
          >
            Refresh
          </button>
        ) : (
          <button
            type="button"
            onClick={handleAccept}
            disabled={isPending}
            className={ACTION_BUTTON_PRIMARY}
          >
            {isPending ? "Accepting…" : "I Accept"}
          </button>
        )}
      </div>
    </div>
  );
}
