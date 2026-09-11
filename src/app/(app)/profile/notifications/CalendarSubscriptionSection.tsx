"use client";

// Phase 35C — personal calendar subscription management. Approved 35A/35C
// IA: lives on /profile/notifications, the page that already owns
// notification/delivery preferences.
//
// Because only a SHA-256 hash of the token is ever stored (see
// supabase/migrations/0173_calendar_feed_subscriptions.sql), Court Time
// cannot redisplay an existing raw subscription URL after a page refresh —
// that is EXPECTED and desirable, not a bug to work around. The raw URL is
// shown only in the render right after a successful issue/regenerate, in
// local component state that is never persisted or sent anywhere else.

import { useState, useTransition } from "react";
import {
  issueCalendarFeedToken,
  revokeCalendarFeedToken,
  type CalendarFeedType,
  type CalendarFeedUrls,
} from "./calendarFeedActions";
import { ACTION_BUTTON_PRIMARY, ACTION_BUTTON_SECONDARY, ACTION_BUTTON_DESTRUCTIVE_COMPACT } from "@/components/styles/actionButtonStyles";

interface Props {
  feedType: CalendarFeedType;
  clubId: string;
  title: string;
  description: string;
  initialHasActiveToken: boolean;
  /** Member/Staff-Managed: the capability isn't available — show an
   * explanatory unavailable state instead of any interactive control. */
  unavailable?: boolean;
}

function mapCalendarFeedError(code: string): string {
  if (code === "stale_club_context") return "Your active club changed. Reload this page and try again.";
  if (code === "capability_not_available") return "This feature isn't available at your club right now.";
  if (code === "insufficient_role") return "This feature isn't available for your account.";
  if (code === "no_active_token") return "There is no active subscription to revoke. Reload this page.";
  return "Something went wrong. Please try again.";
}

export default function CalendarSubscriptionSection({
  feedType, clubId, title, description, initialHasActiveToken, unavailable,
}: Props) {
  const [hasActiveToken, setHasActiveToken] = useState(initialHasActiveToken);
  const [urls, setUrls] = useState<CalendarFeedUrls | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleIssue() {
    setError(null);
    startTransition(async () => {
      const result = await issueCalendarFeedToken(feedType, clubId);
      if (result.error) {
        setError(mapCalendarFeedError(result.error));
        return;
      }
      setUrls(result.urls ?? null);
      setHasActiveToken(true);
      setCopied(false);
    });
  }

  function handleRevoke() {
    setError(null);
    startTransition(async () => {
      const result = await revokeCalendarFeedToken(feedType, clubId);
      if (result.error) {
        setError(mapCalendarFeedError(result.error));
        return;
      }
      setHasActiveToken(false);
      setUrls(null);
      setConfirmRevoke(false);
    });
  }

  async function handleCopy() {
    if (!urls) return;
    try {
      await navigator.clipboard.writeText(urls.httpsUrl);
      setCopied(true);
    } catch {
      setError("Couldn't copy automatically — select and copy the link manually.");
    }
  }

  return (
    <div className="space-y-1.5">
      <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide px-1">
        {title}
      </p>
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 px-4 py-3.5 bg-white dark:bg-gray-800 space-y-3">
        {unavailable ? (
          <p className="text-xs text-gray-400 dark:text-gray-500">
            Calendar subscriptions aren&rsquo;t available at your club right now.
          </p>
        ) : (
          <>
            <p className="text-xs text-gray-500 dark:text-gray-400">{description}</p>

            {error && <p role="alert" className="text-xs font-medium text-red-500">{error}</p>}

            {!hasActiveToken && (
              <button
                type="button"
                onClick={handleIssue}
                disabled={isPending}
                className={ACTION_BUTTON_PRIMARY}
              >
                {isPending ? "Creating…" : "Create subscription"}
              </button>
            )}

            {hasActiveToken && !urls && (
              <div className="space-y-2">
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  Calendar subscription active
                </p>
                <p className="text-xs text-gray-400 dark:text-gray-500">
                  For privacy, the link itself isn&rsquo;t shown again after you leave this
                  page. Regenerate to get a new link, or revoke to turn this off.
                </p>
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={handleIssue} disabled={isPending} className={ACTION_BUTTON_SECONDARY}>
                    {isPending ? "Regenerating…" : "Regenerate link"}
                  </button>
                  {!confirmRevoke ? (
                    <button type="button" onClick={() => setConfirmRevoke(true)} disabled={isPending} className={ACTION_BUTTON_DESTRUCTIVE_COMPACT}>
                      Revoke
                    </button>
                  ) : (
                    <>
                      <button type="button" onClick={handleRevoke} disabled={isPending} className={ACTION_BUTTON_DESTRUCTIVE_COMPACT}>
                        {isPending ? "Revoking…" : "Confirm revoke"}
                      </button>
                      <button type="button" onClick={() => setConfirmRevoke(false)} disabled={isPending} className={ACTION_BUTTON_SECONDARY}>
                        Cancel
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}

            {hasActiveToken && urls && (
              <div className="space-y-2">
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  Subscription link ready — copy it now
                </p>
                <p className="text-xs text-gray-400 dark:text-gray-500">
                  This is the only time this link is shown. Paste it into your calendar
                  app&rsquo;s &ldquo;subscribe from URL&rdquo; option.
                </p>
                <div className="rounded-lg bg-gray-50 dark:bg-gray-700/50 px-3 py-2 text-xs font-mono break-all text-gray-700 dark:text-gray-300">
                  {urls.httpsUrl}
                </div>
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={handleCopy} className={ACTION_BUTTON_PRIMARY}>
                    {copied ? "Copied!" : "Copy subscription link"}
                  </button>
                  <a href={urls.webcalUrl} className={ACTION_BUTTON_SECONDARY}>
                    Open in Calendar App
                  </a>
                </div>
                <div className="flex flex-wrap gap-2 pt-1">
                  <button type="button" onClick={handleIssue} disabled={isPending} className={ACTION_BUTTON_SECONDARY}>
                    {isPending ? "Regenerating…" : "Regenerate link"}
                  </button>
                  {!confirmRevoke ? (
                    <button type="button" onClick={() => setConfirmRevoke(true)} disabled={isPending} className={ACTION_BUTTON_DESTRUCTIVE_COMPACT}>
                      Revoke
                    </button>
                  ) : (
                    <>
                      <button type="button" onClick={handleRevoke} disabled={isPending} className={ACTION_BUTTON_DESTRUCTIVE_COMPACT}>
                        {isPending ? "Revoking…" : "Confirm revoke"}
                      </button>
                      <button type="button" onClick={() => setConfirmRevoke(false)} disabled={isPending} className={ACTION_BUTTON_SECONDARY}>
                        Cancel
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
