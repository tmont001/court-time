"use client";

// Phase 43B-4B — the interactive Guest waiver review/agree/accept flow.
// Mirrors src/app/(app)/waivers/member/WaiverAcceptanceClient.tsx's own
// review-before-agree gate as closely as practical (see that file's own
// header for the full reasoning this borrows): review is UX gating only —
// NOT legal proof of reading, no durable "viewed" evidence is ever
// written server-side, and copy stays restrained ("Waiver opened", never
// "read"/"reviewed completely").
//
// Differences from the Member version, required by the public,
// account-less nature of this flow:
//   1. Every server call carries the raw bearer token (never a client-
//      supplied reservation_guest_id/event_guest_id/waiver_version_id
//      treated as authority) — the token IS this Guest's entire identity
//      here. `rawToken` is held ONLY in-memory component state for these
//      two Server Action calls — it is NEVER written to sessionStorage,
//      localStorage, a cookie, a log line, or any persistent browser
//      storage. See invitationId below for why.
//   2. PRE-APPLY CORRECTION: the sessionStorage "reviewed" key is scoped
//      by the non-secret `invitationId` (resolve_guest_waiver_
//      invitation's own invitation_id, 0198) plus the exact
//      currentVersionId — NOT the raw token. The raw token is a bearer
//      CREDENTIAL; writing it into sessionStorage (even as part of a key
//      name) would persist that credential in browser storage, which the
//      locked raw-token handling rule forbids ("must NOT be written to
//      localStorage/sessionStorage/cookies/logs/analytics/database/audit
//      metadata"). invitationId is not a credential — it identifies WHICH
//      invitation row this is, but on its own grants no authority (the
//      service_role-only RPCs never accept an invitation_id directly, only
//      a token hash) — so using it as a local-only scoping key carries no
//      such risk, while still correctly preventing two different Guests/
//      invitations that happen to share an identical current
//      waiver_version_id from sharing reviewed state, and correctly
//      resetting on a version change (V1 -> V2 never inherits V1's
//      review).
//   3. Legacy-text-Guest-waiver support (pre-apply correction): the
//      PDF-only pivot (43B-3B) did not retroactively invalidate a Guest
//      waiver version published before it — GuestWaiverSection.tsx
//      (admin UI) still renders a `!isPdfBacked` branch for exactly this
//      case. When `isPdfBacked` is false, this component renders the
//      already-visible `legacyBody` text passed down from the server
//      component instead of a PDF-open button — matching /waivers/
//      member/page.tsx's own posture for the identical case ("Legacy text
//      acceptance is unchanged: no checkbox, same one-click Accept as
//      before") exactly: the Guest has already seen the body simply by
//      loading the page, so no separate "open" click is needed or
//      possible, and Accept is available immediately (isPdfBacked is the
//      ONLY thing gating the checkbox/agreed requirement, exactly as in
//      the Member component).

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { acceptGuestWaiverAction, getGuestWaiverPdfViewUrlAction } from "./actions";
import { ACTION_BUTTON_PRIMARY, ACTION_BUTTON_SECONDARY } from "@/components/styles/actionButtonStyles";

interface Props {
  rawToken: string;
  invitationId: string;
  currentVersionId: string;
  versionTitle: string | null;
  isPdfBacked: boolean;
  legacyBody: string | null;
  initialAccepted: boolean;
  initialAcceptedAt: string | null;
}

// invitationId + currentVersionId ONLY — never rawToken. See file header.
function reviewedSessionKey(invitationId: string, versionId: string): string {
  return `court-time:guest-waiver-reviewed:${invitationId}:${versionId}`;
}

// Same fail-silent posture as the Member component's own session-storage
// helpers — private browsing / storage-disabled environments degrade to
// "not yet reviewed" rather than throwing.
function readReviewedFromSession(invitationId: string, versionId: string): boolean {
  try {
    return sessionStorage.getItem(reviewedSessionKey(invitationId, versionId)) === "1";
  } catch {
    return false;
  }
}

function writeReviewedToSession(invitationId: string, versionId: string): void {
  try {
    sessionStorage.setItem(reviewedSessionKey(invitationId, versionId), "1");
  } catch {
    // No functional impact — see function-level note above.
  }
}

export default function GuestWaiverAcceptanceClient({
  rawToken, invitationId, currentVersionId, versionTitle, isPdfBacked, legacyBody,
  initialAccepted, initialAcceptedAt,
}: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [accepted, setAccepted] = useState(initialAccepted);
  const [acceptedAt, setAcceptedAt] = useState(initialAcceptedAt);
  const [error, setError] = useState<string | null>(null);
  const [isStale, setIsStale] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [viewPending, setViewPending] = useState(false);
  // Always starts false — never read from sessionStorage during render
  // (hydration-unsafe: this component can be server-pre-rendered, and
  // sessionStorage doesn't exist there). The real value is applied by the
  // post-mount effect below. Legacy text has no review gate at all (see
  // file header point 3), so this only ever matters when isPdfBacked.
  const [reviewed, setReviewed] = useState(false);

  // Post-mount only. A replacement version (a new currentVersionId, e.g.
  // after the club publishes an updated Guest waiver) must never inherit
  // an older version's reviewed/agreed state — the parent page keys this
  // component by currentVersionId (forcing a full remount on change), and
  // this effect keeps the same invariant explicit even if that ever
  // changes.
  useEffect(() => {
    setReviewed(isPdfBacked ? readReviewedFromSession(invitationId, currentVersionId) : false);
    setAgreed(false);
  }, [invitationId, currentVersionId, isPdfBacked]);

  function handleAccept() {
    setError(null);
    setIsStale(false);
    startTransition(async () => {
      const result = await acceptGuestWaiverAction(rawToken, currentVersionId);
      if (result.error) {
        setError(result.error);
        setIsStale(Boolean(result.stale));
        return;
      }
      setAccepted(true);
      setAcceptedAt(result.acceptedAt ?? new Date().toISOString());
      router.refresh();
    });
  }

  async function handleViewPdf() {
    setError(null);

    // Opened SYNCHRONOUSLY, before any await — preserves the browser's
    // user-activation window from this click (see the Member component's
    // own header for why awaiting first would let most browsers silently
    // block the popup).
    const pdfWindow = window.open("about:blank", "_blank");
    if (!pdfWindow) {
      setError("Your browser blocked the waiver PDF. Allow pop-ups and try again.");
      return;
    }
    pdfWindow.opener = null;

    setViewPending(true);
    const result = await getGuestWaiverPdfViewUrlAction(rawToken);
    setViewPending(false);

    if (result.error || !result.url) {
      try {
        pdfWindow.close();
      } catch {
        // Some browsers refuse to close a window the page didn't itself
        // navigate away from a real origin — harmless either way.
      }
      setError(result.error ?? "Could not open the PDF. Please try again.");
      return;
    }

    if (pdfWindow.closed) {
      setError("The waiver window was closed before it could open. Please try again.");
      return;
    }

    pdfWindow.location.href = result.url;
    setReviewed(true);
    writeReviewedToSession(invitationId, currentVersionId);
  }

  if (accepted) {
    return (
      <div className="rounded-xl border border-green-200 dark:border-green-900 bg-green-50 dark:bg-green-950/40 px-4 py-3 text-center">
        <p className="text-sm font-medium text-green-800 dark:text-green-400">Waiver accepted</p>
        <p className="text-xs text-green-700 dark:text-green-500 mt-0.5">
          You&apos;ve already accepted the current waiver
          {acceptedAt ? ` — accepted ${new Date(acceptedAt).toLocaleDateString()}` : ""}.
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

      {isPdfBacked ? (
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
              {viewPending ? "Opening…" : `Review ${versionTitle ?? "Waiver"}`}
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
              I have reviewed and agree to the waiver.
            </label>
            {!reviewed && (
              <p className="text-xs text-gray-400 dark:text-gray-500">
                Open the waiver above to enable this.
              </p>
            )}
          </div>
        </div>
      ) : (
        // Legacy text — already rendered above this component by the
        // server component itself, exactly like /waivers/member/page.tsx
        // renders its own legacy body directly. No review gate: the Guest
        // has already seen the body just by loading this page.
        legacyBody && (
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Review the waiver text above, then accept below.
          </p>
        )
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
