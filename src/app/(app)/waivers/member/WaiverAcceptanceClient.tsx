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
// component instead offers a PDF-open action (a short-lived signed URL,
// minted fresh server-side on each click — never a permanent Storage URL)
// and requires an explicit agreement checkbox before Accept is enabled.
// accept_member_waiver itself (0192/0193, applied/immutable) is completely
// unchanged — still called against the exact same currentVersionId either
// way; this component only adds a UI gate in front of the identical call.
// Legacy text acceptance is unchanged: no checkbox, same one-click Accept
// as before.
//
// Phase 43B-3D — the agreement checkbox for a PDF-backed waiver now stays
// disabled until the Member has successfully opened the current PDF at
// least once in this browser session. This is a UX interaction
// requirement only — NOT legal proof of reading. No new evidence table,
// no DB/audit write, no change to waiver_acceptances or accept_member_
// waiver: acceptance evidence remains exactly waiver_version_id + accepting
// user + accepted_at, unchanged. "Reviewed" is tracked client-side only
// (sessionStorage, never localStorage, never sent to the server), keyed
// by the exact currentVersionId so a replacement version can never inherit
// an older version's reviewed state. Marked reviewed ONLY after
// getMemberWaiverPdfViewUrlAction() actually succeeds — never merely
// because the button was clicked — and copy is deliberately restrained
// ("Waiver opened", never "read"/"reviewed completely"/"reading
// confirmed") since PDF rendering/read completion can never be proven.
//
// Runtime correction (same checkpoint): `reviewed` is never read from
// sessionStorage during the initial render — a Client Component can be
// server-pre-rendered, and sessionStorage doesn't exist there, so a lazy
// useState initializer reading it would make the server render always
// resolve false while the browser's first paint could resolve true,
// producing a hydration mismatch. `reviewed` now always STARTS false and
// is only ever set from the post-mount effect below (a brief locked
// state until that effect runs is expected and acceptable). Separately,
// handleViewPdf now opens a blank window SYNCHRONOUSLY, before the
// `await` for the signed URL, so the browser's own user-activation
// window is preserved for the popup — awaiting first and calling
// window.open() only after would let most browsers silently block it. A
// null return from that synchronous open (already blocked) or the
// placeholder having been closed by the user before the URL arrives both
// fail closed: reviewed is never set and sessionStorage is never
// written, matching the "Waiver opened" claim's own honesty requirement
// — that claim can only be made once a real, still-open window was
// actually navigated to the real signed URL.

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { acceptMemberWaiverAction, getMemberWaiverPdfViewUrlAction } from "./actions";
import { ACTION_BUTTON_PRIMARY, ACTION_BUTTON_SECONDARY } from "@/components/styles/actionButtonStyles";

interface Props {
  currentVersionId: string;
  initialStatus: "current" | "never_accepted" | "outdated";
  initialAcceptedAt: string | null;
  isPdfBacked: boolean;
}

function reviewedSessionKey(versionId: string): string {
  return `court-time:waiver-reviewed:${versionId}`;
}

// sessionStorage (never localStorage — a new browser session/tab-restore
// must be able to require review again) can throw or be unavailable
// (private browsing, storage disabled) — both read and write fail
// silently to the in-memory `reviewed` state, which still correctly
// unlocks the checkbox for the remainder of this component's live
// session; only cross-refresh persistence is lost, never functionality.
function readReviewedFromSession(versionId: string): boolean {
  try {
    return sessionStorage.getItem(reviewedSessionKey(versionId)) === "1";
  } catch {
    return false;
  }
}

function writeReviewedToSession(versionId: string): void {
  try {
    sessionStorage.setItem(reviewedSessionKey(versionId), "1");
  } catch {
    // See function-level note above — no functional impact.
  }
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
  // Always starts false — never read from sessionStorage during render
  // (hydration-unsafe; see the file header). The real value, if any, is
  // applied by the effect below once this component has actually mounted
  // in the browser.
  const [reviewed, setReviewed] = useState(false);

  // Post-mount only. Also the single source of truth for "a replacement
  // version (a new currentVersionId, e.g. after Replace Waiver) must
  // never inherit an older version's reviewed/agreed state" —
  // waivers/member/page.tsx already keys this component by
  // current_version_id (forcing a full remount on change) — this effect
  // keeps the same invariant explicit and correct even if that key
  // behavior ever changes.
  useEffect(() => {
    setReviewed(isPdfBacked ? readReviewedFromSession(currentVersionId) : false);
    setAgreed(false);
  }, [currentVersionId, isPdfBacked]);

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

    // Opened SYNCHRONOUSLY, before any await — preserves the browser's
    // user-activation window from this click. Awaiting the signed-URL
    // action first and calling window.open() only after would let most
    // browsers silently block the popup, since it would no longer be
    // seen as a direct response to the user's gesture.
    const pdfWindow = window.open("about:blank", "_blank");
    if (!pdfWindow) {
      setError("Your browser blocked the waiver PDF. Allow pop-ups and try again.");
      return;
    }
    // Same effect as rel="noopener" for a direct link click — this
    // window must never be able to reach back into the opener.
    pdfWindow.opener = null;

    setViewPending(true);
    const result = await getMemberWaiverPdfViewUrlAction();
    setViewPending(false);

    if (result.error || !result.url) {
      // Failure: checkbox/Accept must stay locked, and reviewed is never
      // written — a Member cannot progress past a signed-URL failure.
      // Best-effort close of the now-pointless placeholder window.
      try {
        pdfWindow.close();
      } catch {
        // Some browsers refuse to close a window the page didn't itself
        // navigate away from a real origin — harmless either way.
      }
      setError(result.error ?? "Could not open the PDF. Please try again.");
      return;
    }

    // The user may have closed the placeholder tab while the signed URL
    // was being requested — never claim "Waiver opened" for a window
    // that no longer exists to navigate.
    if (pdfWindow.closed) {
      setError("The waiver window was closed before it could open. Please try again.");
      return;
    }

    // Navigates ONLY the exact window opened above — never a second
    // window.open() call after the await.
    pdfWindow.location.href = result.url;
    setReviewed(true);
    writeReviewedToSession(currentVersionId);
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
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 px-4 py-3 space-y-4">
          <div className="space-y-1.5">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
              1. Review the waiver
            </p>
            <button
              type="button"
              onClick={handleViewPdf}
              disabled={viewPending}
              className={ACTION_BUTTON_SECONDARY}
            >
              {viewPending ? "Opening…" : "Review Waiver PDF"}
            </button>
            {/* Restrained language only — this proves the PDF was opened,
                never that it was actually read. */}
            {reviewed ? (
              <p className="text-xs text-green-700 dark:text-green-400">Waiver opened</p>
            ) : (
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Open the waiver before agreeing.
              </p>
            )}
          </div>

          <div className="space-y-1.5 pt-3 border-t border-gray-100 dark:border-gray-800">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
              2. Agree
            </p>
            <label
              className={`flex items-start gap-2 text-sm ${
                reviewed ? "text-gray-700 dark:text-gray-300" : "text-gray-400 dark:text-gray-500"
              }`}
            >
              <input
                type="checkbox"
                checked={agreed}
                disabled={!reviewed}
                onChange={(e) => setAgreed(e.target.checked)}
                className="mt-0.5 disabled:opacity-40 disabled:cursor-not-allowed"
              />
              I have read and agree to the waiver.
            </label>
            {!reviewed && (
              <p className="text-xs text-gray-400 dark:text-gray-500">
                Open the waiver above to enable this.
              </p>
            )}
          </div>
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
            {isPending ? "Accepting…" : isPdfBacked ? "Accept Waiver" : "I Accept"}
          </button>
        )}
      </div>
    </div>
  );
}
