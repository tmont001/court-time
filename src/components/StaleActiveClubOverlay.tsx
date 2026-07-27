"use client";

import { useEffect, useRef } from "react";

// Non-dismissible blocking modal shown by StaleActiveClubGuard. No close
// button, no backdrop-click dismissal, Escape does not dismiss — the only
// way out is the primary action, which always ends in a full page reload.

export type StaleOverlayState =
  | { kind: "stale"; newClubName: string | null }
  | { kind: "no-club" }
  | { kind: "check-failed" };

interface Props {
  state:   StaleOverlayState;
  onRetry: () => void;
}

const HEADING_ID     = "stale-active-club-heading";
const DESCRIPTION_ID = "stale-active-club-description";

export default function StaleActiveClubOverlay({ state, onRetry }: Props) {
  const primaryButtonRef = useRef<HTMLButtonElement>(null);

  // Move focus into the dialog as soon as it appears (or its state
  // changes, e.g. stale -> check-failed on a subsequent failed retry).
  useEffect(() => {
    primaryButtonRef.current?.focus();
  }, [state.kind]);

  // Trap keyboard focus inside the dialog and block Escape from dismissing
  // it. Only one focusable control exists in any state, so "trapping" is
  // simply: Tab never leaves it, Escape does nothing.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        primaryButtonRef.current?.focus();
      }
    }
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, []);

  function handleLoadCurrentClub() {
    // Full hard reload, not a soft client navigation: this tab's in-memory
    // state is exactly what's untrustworthy here, so the fix is a
    // completely fresh document, not a client-side transition layered on
    // top of the same stale runtime.
    window.location.href = "/calendar";
  }

  let heading: string;
  let description: string;
  let primaryLabel: string;
  let onPrimary: () => void;

  if (state.kind === "stale") {
    heading = "Your active club changed";
    description = state.newClubName
      ? `Your active club changed in another tab or device. ${state.newClubName} is now your active club.`
      : "Your active club changed in another tab or device.";
    primaryLabel = "Load current club";
    onPrimary = handleLoadCurrentClub;
  } else if (state.kind === "no-club") {
    heading = "Your club access changed";
    description =
      "Your active club membership is no longer active. Load your current account to continue.";
    primaryLabel = "Load current club";
    onPrimary = handleLoadCurrentClub;
  } else {
    heading = "Couldn't confirm your active club";
    description =
      "We couldn't verify your active club due to a connection issue. Please try again.";
    primaryLabel = "Retry";
    onPrimary = onRetry;
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/50">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={HEADING_ID}
        aria-describedby={DESCRIPTION_ID}
        className="w-full max-w-sm rounded-xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 shadow-xl p-5"
      >
        <h2 id={HEADING_ID} className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">
          {heading}
        </h2>
        <p id={DESCRIPTION_ID} className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          {description}
        </p>
        <button
          ref={primaryButtonRef}
          type="button"
          onClick={onPrimary}
          className="w-full bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 rounded-md px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {primaryLabel}
        </button>
      </div>
    </div>
  );
}
