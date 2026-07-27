"use client";

// Phase 26E2: lightweight cross-tab "something changed, go re-verify" signal
// for the active-club switch. Deliberately carries no club data of its own
// — every recipient re-derives the truth from get_current_account_context()
// (see StaleActiveClubGuard.tsx). This is a trigger, not a source of truth.

const CHANNEL_NAME = "court-time-active-club";
const STORAGE_KEY   = "ct_active_club_ping";

interface ActiveClubPing {
  tabId: string;
  at:    number;
}

// Stable per browsing-context (tab/window) id. A BroadcastChannel object is
// never delivered its own postMessage, but a *different* BroadcastChannel
// object of the same name in the *same* document does receive it — so the
// tab that just switched (ClubMembershipList) and this tab's own mounted
// StaleActiveClubGuard, using separate channel objects, would otherwise see
// each other. Tagging every ping with the originating tab's id lets
// subscribers ignore their own tab's pings without relying on timing.
const TAB_ID =
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export function getActiveClubTabId(): string {
  return TAB_ID;
}

/** Call once, after set_active_club has been confirmed successful. */
export function publishActiveClubChanged(): void {
  const payload: ActiveClubPing = { tabId: TAB_ID, at: Date.now() };

  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channel.postMessage(payload);
    channel.close();
  }

  // Always also write localStorage: the fallback for browsers without
  // BroadcastChannel, and a second, independent signal path otherwise.
  // Same-document `storage` events never fire for the tab that wrote the
  // value, so no tabId filtering is needed on that path specifically —
  // the filter below still applies uniformly for simplicity.
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Private-browsing/quota-exceeded — BroadcastChannel (if available)
    // already carried the signal; nothing further to do.
  }
}

/**
 * Subscribe to other tabs' active-club changes. `onPing` fires at most once
 * per genuinely cross-tab event; pings originating from this same tab are
 * filtered out. Returns a cleanup function.
 */
export function subscribeToActiveClubChanges(onPing: () => void): () => void {
  const cleanups: Array<() => void> = [];

  function handlePing(tabId: string | undefined) {
    if (!tabId || tabId === TAB_ID) return;
    onPing();
  }

  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel(CHANNEL_NAME);
    const handleMessage = (event: MessageEvent<Partial<ActiveClubPing>>) => {
      handlePing(event.data?.tabId);
    };
    channel.addEventListener("message", handleMessage);
    cleanups.push(() => {
      channel.removeEventListener("message", handleMessage);
      channel.close();
    });
  }

  function handleStorage(event: StorageEvent) {
    if (event.key !== STORAGE_KEY || !event.newValue) return;
    try {
      const payload = JSON.parse(event.newValue) as Partial<ActiveClubPing>;
      handlePing(payload.tabId);
    } catch {
      // Malformed payload — ignore rather than false-triggering a check.
    }
  }
  window.addEventListener("storage", handleStorage);
  cleanups.push(() => window.removeEventListener("storage", handleStorage));

  return () => cleanups.forEach((cleanup) => cleanup());
}
