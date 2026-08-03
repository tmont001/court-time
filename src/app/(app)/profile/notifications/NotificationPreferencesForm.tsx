"use client";

import { useState, useTransition } from "react";
import { updateNotificationPreference } from "./actions";

// ─── Types ────────────────────────────────────────────────────────────────────

type ConfigurableKind =
  | "reservation_confirmed"
  | "reservation_cancelled_by_member"
  | "reservation_cancelled_by_admin"
  | "reservation_rescheduled"
  | "event_joined"
  | "event_cancelled"
  | "event_updated"
  | "waitlist_offer"
  | "waitlist_promoted"
  | "announcement"
  | "lesson_request_received"
  | "lesson_request_proposed"
  | "lesson_request_confirmed"
  | "lesson_request_declined"
  | "lesson_cancelled";

interface PreferenceRow {
  kind:    string;
  enabled: boolean;
}

interface Props {
  preferences: PreferenceRow[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CONFIGURABLE_KINDS: { kind: ConfigurableKind; label: string; description: string }[] = [
  {
    kind:        "reservation_confirmed",
    label:       "Booking confirmations",
    description: "When you successfully book a court.",
  },
  {
    kind:        "reservation_cancelled_by_member",
    label:       "Booking self-cancellations",
    description: "When you cancel one of your own reservations.",
  },
  {
    kind:        "reservation_cancelled_by_admin",
    label:       "Booking cancelled by club",
    description: "When your club cancels one of your court reservations.",
  },
  {
    kind:        "reservation_rescheduled",
    label:       "Booking rescheduled",
    description: "When the club edits the court, date, or time of one of your bookings. This only controls email — the in-app notification always appears.",
  },
  {
    kind:        "event_joined",
    label:       "Event join confirmations",
    description: "When you join a confirmed spot in an event.",
  },
  {
    kind:        "event_cancelled",
    label:       "Event cancellations",
    description: "When an event you joined is cancelled.",
  },
  {
    kind:        "event_updated",
    label:       "Event updated",
    description: "When the club edits the date, time, courts, or capacity of an event you're on. This only controls email — the in-app notification always appears.",
  },
  {
    kind:        "waitlist_offer",
    label:       "Waitlist spot offers",
    description: "When a spot opens up in an event you're waitlisted for.",
  },
  {
    kind:        "waitlist_promoted",
    label:       "Waitlist confirmations",
    description: "When you accept a waitlist offer and are confirmed.",
  },
  {
    kind:        "announcement",
    label:       "Club announcements",
    description: "Broadcast messages sent by your club admin.",
  },
  {
    kind:        "lesson_request_received",
    label:       "Lesson request received",
    description: "When a member submits a lesson request to you (pros only).",
  },
  {
    kind:        "lesson_request_proposed",
    label:       "Lesson time proposed",
    description: "When a pro proposes a time for your lesson request.",
  },
  {
    kind:        "lesson_request_confirmed",
    label:       "Lesson confirmed",
    description: "When a lesson is confirmed for both parties.",
  },
  {
    kind:        "lesson_request_declined",
    label:       "Lesson request declined",
    description: "When a pro declines your lesson request.",
  },
  {
    kind:        "lesson_cancelled",
    label:       "Lesson cancelled",
    description: "When a confirmed lesson is cancelled.",
  },
];

// ─── Component ────────────────────────────────────────────────────────────────

export default function NotificationPreferencesForm({ preferences }: Props) {
  // Build initial state: find the stored row or default to enabled.
  const initialState = Object.fromEntries(
    CONFIGURABLE_KINDS.map(({ kind }) => {
      const row = preferences.find(p => p.kind === kind);
      return [kind, row?.enabled ?? true];
    })
  ) as Record<ConfigurableKind, boolean>;

  const [state, setState] = useState(initialState);
  // Track which kind has a transition in flight, if any.
  const [pending, setPending] = useState<ConfigurableKind | null>(null);
  const [, startTransition] = useTransition();

  function handleToggle(kind: ConfigurableKind) {
    const next = !state[kind];

    // Optimistic update
    setState(prev => ({ ...prev, [kind]: next }));
    setPending(kind);

    startTransition(async () => {
      const result = await updateNotificationPreference(kind, next);
      if (result.error) {
        // Revert on failure
        setState(prev => ({ ...prev, [kind]: !next }));
      }
      setPending(null);
    });
  }

  return (
    <div className="space-y-6">

      {/* ── Configurable kinds ────────────────────────────────────────── */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-700 overflow-hidden">
        {CONFIGURABLE_KINDS.map(({ kind, label, description }) => {
          const isEnabled  = state[kind];
          const isPending  = pending === kind;

          return (
            <label
              key={kind}
              className="flex items-center justify-between gap-4 px-4 py-3.5 bg-white dark:bg-gray-800 cursor-pointer"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  {label}
                </p>
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
                  {description}
                </p>
              </div>

              {/* Toggle switch */}
              <button
                type="button"
                role="switch"
                aria-checked={isEnabled}
                aria-label={label}
                disabled={isPending}
                onClick={() => handleToggle(kind)}
                className={`relative shrink-0 inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-gray-400 ${
                  isPending ? "opacity-40" : ""
                } ${
                  isEnabled
                    ? "bg-accent"
                    : "bg-gray-200 dark:bg-gray-700"
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                    isEnabled ? "translate-x-6" : "translate-x-1"
                  }`}
                />
              </button>
            </label>
          );
        })}
      </div>

      {/* ── Footer note ───────────────────────────────────────────────── */}
      <p className="text-xs text-gray-400 dark:text-gray-500 px-1">
        These settings control email delivery. Important in-app updates, such as
        cancellations by your club, may still appear in your notification bell.
      </p>

    </div>
  );
}
