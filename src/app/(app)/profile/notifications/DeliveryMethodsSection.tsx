"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { updateSmsPreference } from "../actions";

interface Props {
  smsConfigured:      boolean;
  // When true, the server-side communication-settings lookup failed (an
  // RPC error, not a genuine null phone) — render a safe error instead of
  // any interactive SMS control built from guessed/default data.
  commSettingsFailed: boolean;
  phone:              string | null;
  smsOptIn:           boolean;
}

// Renders a stored E.164 US number (+15185788556) as (518) 578-8556 for
// display only — never sent back to the server in this form.
function formatPhone(e164: string): string {
  const match = e164.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  if (!match) return e164;
  const [, area, mid, last] = match;
  return `(${area}) ${mid}-${last}`;
}

// Phase 31D (channel-clarity correction): "How you receive notifications" —
// one compact card presenting the three distinct channels this app actually
// has, so a user can tell at a glance which are on, which are optional, and
// how they relate to each other:
//   1. In-app (the notification bell) — always on, no toggle. This is a
//      web-app UI surface, NOT an Apple/Android device push notification —
//      no such capability exists in this codebase, and this component must
//      never imply otherwise.
//   2. Email — enabled by default per category; the individual toggles for
//      each category live below in NotificationPreferencesForm. No global
//      email toggle exists or is added here.
//   3. Text (SMS) — the one interactive control on this page. Optional,
//      requires a saved phone number and explicit opt-in, and is a single
//      global preference — it does not mirror the per-category email list
//      one-to-one, and this component's copy must not imply that it does.
//
// Reuses the existing updateSmsPreference Server Action and
// update_sms_preference RPC (0018) unchanged — no new action or RPC for the
// write path. Reads the caller's own phone/sms_opt_in via
// get_my_communication_settings() (migration 0104), fetched by the parent
// page — this component only renders what it's given and never queries
// profiles directly.
export default function DeliveryMethodsSection({ smsConfigured, commSettingsFailed, phone, smsOptIn }: Props) {
  const [enabled, setEnabled] = useState(smsOptIn);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const hasPhone = Boolean(phone);
  // Only blocks turning SMS ON with no phone on file — opting back out is
  // always allowed, even in the edge case where a phone was removed after
  // opting in.
  const blockedByNoPhone = !hasPhone && !enabled;

  function handleToggle() {
    if (blockedByNoPhone || isPending) return;
    const next = !enabled;
    setError(null);
    setEnabled(next);

    startTransition(async () => {
      const result = await updateSmsPreference(next);
      if (result.error) {
        setEnabled(!next);
        setError(result.error);
      }
    });
  }

  return (
    <div className="space-y-1.5">
      <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide px-1">
        How you receive notifications
      </p>
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-700 overflow-hidden">

        {/* Row 1 — In-app. Always on, no toggle: the Court Time notification
            bell, not a device push notification (no such feature exists). */}
        <div className="px-4 py-3.5 bg-white dark:bg-gray-800">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
              In-app notifications
            </p>
            <span className="text-xs font-medium text-gray-500 dark:text-gray-400 shrink-0">
              Always on
            </span>
          </div>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
            Important booking, event, waitlist, and lesson updates appear in
            your notification bell.
          </p>
        </div>

        {/* Row 2 — Email. No global toggle; individual categories are
            managed in the section below. */}
        <div className="px-4 py-3.5 bg-white dark:bg-gray-800">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
              Email notifications
            </p>
            <span className="text-xs font-medium text-gray-500 dark:text-gray-400 shrink-0">
              Manage below
            </span>
          </div>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
            Email alerts are enabled by default. Choose which categories you
            want below.
          </p>
        </div>

        {/* Row 3 — Text (SMS). The one interactive control on this page. */}
        {smsConfigured && commSettingsFailed && (
          <div className="px-4 py-3.5 bg-white dark:bg-gray-800">
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Text notifications</p>
            <p role="alert" className="text-xs font-medium text-red-500 mt-1">
              Communication settings could not be loaded. Please refresh and try again.
            </p>
          </div>
        )}

        {smsConfigured && !commSettingsFailed && (
          <>
            <label className="flex items-center justify-between gap-4 px-4 py-3.5 bg-white dark:bg-gray-800 cursor-pointer">
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  Text notifications
                </p>
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
                  Optional text alerts for supported transactional updates.
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={enabled}
                aria-label="Text notifications"
                aria-describedby={blockedByNoPhone ? "sms-no-phone-hint" : undefined}
                disabled={isPending || blockedByNoPhone}
                onClick={handleToggle}
                className={`relative shrink-0 inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-gray-400 ${
                  isPending || blockedByNoPhone ? "opacity-40" : ""
                } ${enabled ? "bg-accent" : "bg-gray-200 dark:bg-gray-700"}`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                    enabled ? "translate-x-6" : "translate-x-1"
                  }`}
                />
              </button>
            </label>

            <div className="px-4 py-3 flex items-center justify-between gap-3 bg-white dark:bg-gray-800">
              <span className="text-xs font-medium text-gray-500 dark:text-gray-400 shrink-0">
                Phone number
              </span>
              {hasPhone ? (
                <span className="flex items-center gap-2 text-right min-w-0">
                  <span className="text-sm text-gray-900 dark:text-gray-100 truncate">
                    {formatPhone(phone as string)}
                  </span>
                  <Link href="/profile" className="text-xs text-accent hover:underline shrink-0">
                    Update
                  </Link>
                </span>
              ) : (
                <span className="flex items-center gap-2 text-right">
                  <span className="text-sm text-gray-400 dark:text-gray-500">No phone number added</span>
                  <Link href="/profile" className="text-xs text-accent hover:underline shrink-0">
                    Add phone number
                  </Link>
                </span>
              )}
            </div>
          </>
        )}
      </div>

      {smsConfigured && !commSettingsFailed && blockedByNoPhone && (
        <p id="sms-no-phone-hint" role="status" className="text-xs text-amber-600 dark:text-amber-400 px-1">
          Add a phone number before enabling text notifications.
        </p>
      )}
      {smsConfigured && !commSettingsFailed && error && (
        <p role="alert" className="text-xs font-medium text-red-500 px-1">
          {error}
        </p>
      )}
      {smsConfigured && !commSettingsFailed && (
        <p className="text-xs text-gray-400 dark:text-gray-500 px-1">
          By enabling text notifications, you agree to receive transactional
          messages from your club. Message and data rates may apply. You can
          opt out at any time.
        </p>
      )}
    </div>
  );
}
