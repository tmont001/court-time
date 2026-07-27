"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { subscribeToActiveClubChanges } from "@/lib/activeClubChannel";
import StaleActiveClubOverlay from "./StaleActiveClubOverlay";

// Mounted once in (app)/layout.tsx. Detects when this tab's rendered
// active-club context (the activeClubId this request was rendered with) no
// longer matches the account's current active club — because another tab
// switched it, or because the active membership itself was deactivated,
// suspended, or removed — and blocks interaction with a non-dismissible
// overlay until the user reloads into the current context.
//
// This component never trusts the *content* of a cross-tab signal or the
// club name it may carry from a prior check; every state transition is
// re-derived from a live get_current_account_context() call. Cross-tab
// pings and focus/visibility/pageshow events are only ever triggers to run
// that check again — never a source of truth themselves.

type CheckState =
  | { kind: "current" }
  | { kind: "stale"; newClubName: string | null }
  | { kind: "no-club" }
  | { kind: "check-failed" };

interface Props {
  /** The active club this request was server-rendered with. */
  activeClubId: string;
}

export default function StaleActiveClubGuard({ activeClubId }: Props) {
  const [state, setState] = useState<CheckState>({ kind: "current" });
  const checkingRef = useRef(false);
  const mountedRef  = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const runCheck = useCallback(async () => {
    // De-dupe: several browser events (focus + visibilitychange, or a
    // cross-tab ping arriving mid-check) can request a check in quick
    // succession. Only one is ever in flight; this is a one-shot
    // verification, not polling — no interval anywhere in this component.
    if (checkingRef.current) return;
    checkingRef.current = true;

    try {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("get_current_account_context").single();

      if (!mountedRef.current) return;

      if (error) {
        if (error.message?.includes("not_authenticated")) {
          // Matches the existing sign-out convention elsewhere in the app:
          // a hard reload is appropriate here too, since this tab's
          // session is exactly what's no longer valid.
          window.location.href = "/sign-in";
          return;
        }
        // Network/unexpected failure: never silently declare the tab
        // current. Only surface the failure state from a known-good
        // baseline — don't downgrade an already-detected stale/no-club
        // state if a later re-check merely times out transiently.
        setState((prev) => (prev.kind === "current" ? { kind: "check-failed" } : prev));
        return;
      }

      if (!data) {
        setState((prev) => (prev.kind === "current" ? { kind: "check-failed" } : prev));
        return;
      }

      if (!data.active_club_id) {
        // Active membership deactivated, suspended, or removed since this
        // tab was rendered.
        setState({ kind: "no-club" });
        return;
      }

      if (data.active_club_id === activeClubId) {
        setState({ kind: "current" });
        return;
      }

      setState({ kind: "stale", newClubName: data.club_name ?? null });
    } catch {
      if (!mountedRef.current) return;
      setState((prev) => (prev.kind === "current" ? { kind: "check-failed" } : prev));
    } finally {
      checkingRef.current = false;
    }
  }, [activeClubId]);

  useEffect(() => {
    const unsubscribe = subscribeToActiveClubChanges(() => {
      void runCheck();
    });

    function handleVisibilityChange() {
      if (document.visibilityState === "visible") void runCheck();
    }
    function handleFocus() {
      void runCheck();
    }
    function handlePageShow() {
      // Always re-check on pageshow — including bfcache restoration
      // (back/forward navigation reusing a suspended page), which is
      // exactly the scenario where rendered state is most likely stale.
      void runCheck();
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleFocus);
    window.addEventListener("pageshow", handlePageShow);

    return () => {
      unsubscribe();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("pageshow", handlePageShow);
    };
  }, [runCheck]);

  if (state.kind === "current") return null;

  return <StaleActiveClubOverlay state={state} onRetry={runCheck} />;
}
