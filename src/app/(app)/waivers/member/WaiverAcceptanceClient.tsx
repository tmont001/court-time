"use client";

// Phase 43A-2 — the only interactive piece of the waiver review/acceptance
// page: the "I Accept" action. The page itself (server component) already
// renders the exact current version's title/body from get_my_member_
// waiver_status() — this component never invents or receives any other
// version id, so it can never accept a client-guessed/stale version; the
// backend's own stale_waiver_version rejection is the authoritative
// backstop if a concurrent publish lands while this page is open.
//
// Phase 43B-3B — PDF-only product pivot. For a PDF-backed current version
// (isPdfBacked=true), no body text is rendered by the page above, so this
// component instead offers a "View waiver PDF" action (a short-lived
// signed URL, minted fresh server-side on each click — never a permanent
// Storage URL) and requires an explicit agreement checkbox before Accept
// is enabled. accept_member_waiver itself (0192/0193, applied/immutable)
// is completely unchanged — still called against the exact same
// currentVersionId either way; this component only adds a UI gate in
// front of the identical call. Legacy text acceptance is unchanged: no
// checkbox, same one-click Accept as before.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { acceptMemberWaiverAction, getMemberWaiverPdfViewUrlAction } from "./actions";
import { ACTION_BUTTON_PRIMARY, ACTION_BUTTON_SECONDARY } from "@/components/styles/actionButtonStyles";

interface Props {
  currentVersionId: string;
  initialStatus: "current" | "never_accepted" | "outdated";
  initialAcceptedAt: string | null;
  isPdfBacked: boolean;
}

export default function WaiverAcceptanceClient({
  currentVersionId, initialStatus, initialAcceptedAt, isPdfBacked,
}: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [status, setStatus] = useState(initialStatus);
  const [acceptedAt, setAcceptedAt] = useState(initialAcceptedAt);
  const [error, setError] = useState<string | null>(null);
  const [isStale, setIsStale] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [viewPending, setViewPending] = useState(false);

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

  async function handleViewPdf() {
    setError(null);
    setViewPending(true);
    const result = await getMemberWaiverPdfViewUrlAction();
    setViewPending(false);
    if (result.error || !result.url) {
      setError(result.error ?? "Could not open the PDF. Please try again.");
      return;
    }
    window.open(result.url, "_blank", "noopener,noreferrer");
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

      {isPdfBacked && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 px-4 py-3 space-y-3">
          <button
            type="button"
            onClick={handleViewPdf}
            disabled={viewPending}
            className={ACTION_BUTTON_SECONDARY}
          >
            {viewPending ? "Opening…" : "View waiver PDF"}
          </button>
          <label className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300">
            <input
              type="checkbox"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
              className="mt-0.5"
            />
            I have read and agree to the waiver.
          </label>
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
            disabled={isPending || (isPdfBacked && !agreed)}
            className={ACTION_BUTTON_PRIMARY}
          >
            {isPending ? "Accepting…" : "I Accept"}
          </button>
        )}
      </div>
    </div>
  );
}
