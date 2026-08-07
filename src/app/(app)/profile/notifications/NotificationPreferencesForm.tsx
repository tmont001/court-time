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
  preferences:      PreferenceRow[];
  // Phase 31D: presentation-only role filter. Does not change which
  // preference rows exist in the database or which notifications are
  // dispatched — only whether the Pro-only "lesson request received" row is
  // rendered for this signed-in user. Sourced from the existing
  // is_lesson_provider account-context field; no new authorization logic.
  isLessonProvider: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────
// Phase 31D: grouped by domain, collapsed by default, with an enabled count
// in each summary so a long flat list reads as four short, closed ones.
// Labels/descriptions and the underlying kind set are unchanged from
// before this checkpoint — this is a presentation reorganization only.

const KIND_INFO: Record<ConfigurableKind, { label: string; description: string }> = {
  reservation_confirmed: {
    label:       "Booking confirmations",
    description: "When you successfully book a court.",
  },
  reservation_cancelled_by_member: {
    label:       "Booking self-cancellations",
    description: "When you cancel one of your own reservations.",
  },
  reservation_cancelled_by_admin: {
    label:       "Booking cancelled by club",
    description: "When your club cancels one of your court reservations.",
  },
  reservation_rescheduled: {
    label:       "Booking rescheduled",
    description: "When the club edits the court, date, or time of one of your bookings.",
  },
  event_joined: {
    label:       "Event join confirmations",
    description: "When you join a confirmed spot in an event.",
  },
  event_cancelled: {
    label:       "Event cancellations",
    description: "When an event you joined is cancelled.",
  },
  event_updated: {
    label:       "Event updated",
    description: "When the club edits the date, time, courts, or capacity of an event you're on.",
  },
  waitlist_offer: {
    label:       "Waitlist spot offers",
    description: "When a spot opens up in an event you're waitlisted for.",
  },
  waitlist_promoted: {
    label:       "Waitlist confirmations",
    description: "When you accept a waitlist offer and are confirmed.",
  },
  announcement: {
    label:       "Club announcements",
    description: "Broadcast messages sent by your club admin.",
  },
  lesson_request_received: {
    label:       "Lesson request received",
    description: "When a member submits a lesson request to you.",
  },
  lesson_request_proposed: {
    label:       "Lesson time proposed",
    description: "When a pro proposes a time for your lesson request.",
  },
  lesson_request_confirmed: {
    label:       "Lesson confirmed",
    description: "When a lesson is confirmed for both parties.",
  },
  lesson_request_declined: {
    label:       "Lesson request declined",
    description: "When a pro declines your lesson request.",
  },
  lesson_cancelled: {
    label:       "Lesson cancelled",
    description: "When a confirmed lesson is cancelled.",
  },
};

interface Group {
  title: string;
  kinds: ConfigurableKind[];
  // Kinds in this list are omitted from `kinds` for a given render when
  // the corresponding predicate is false — presentation-only, see
  // isLessonProvider above.
  roleGated?: Partial<Record<ConfigurableKind, (isLessonProvider: boolean) => boolean>>;
}

const GROUPS: Group[] = [
  {
    title: "Reservations",
    kinds: [
      "reservation_confirmed",
      "reservation_cancelled_by_member",
      "reservation_cancelled_by_admin",
      "reservation_rescheduled",
    ],
  },
  {
    title: "Events & waitlist",
    kinds: ["event_joined", "event_cancelled", "event_updated", "waitlist_offer", "waitlist_promoted"],
  },
  {
    title: "Lessons",
    kinds: [
      "lesson_request_received",
      "lesson_request_proposed",
      "lesson_request_confirmed",
      "lesson_request_declined",
      "lesson_cancelled",
    ],
    roleGated: {
      lesson_request_received: (isLessonProvider) => isLessonProvider,
    },
  },
  {
    title: "Club announcements",
    kinds: ["announcement"],
  },
];

// ─── Component ────────────────────────────────────────────────────────────────

export default function NotificationPreferencesForm({ preferences, isLessonProvider }: Props) {
  // Build initial state: find the stored row or default to enabled.
  const initialState = Object.fromEntries(
    (Object.keys(KIND_INFO) as ConfigurableKind[]).map((kind) => {
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
    <div className="space-y-3">
      {GROUPS.map(({ title, kinds: allKinds, roleGated }) => {
        const kinds = allKinds.filter((kind) => {
          const predicate = roleGated?.[kind];
          return predicate ? predicate(isLessonProvider) : true;
        });
        if (kinds.length === 0) return null;

        const enabledCount = kinds.filter((kind) => state[kind]).length;

        return (
          <details
            key={title}
            className="group rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden"
          >
            <summary className="cursor-pointer select-none list-none px-4 py-3 flex items-center justify-between gap-3 bg-white dark:bg-gray-800">
              <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{title}</span>
              <span className="flex items-center gap-2 text-xs text-gray-400 dark:text-gray-500">
                {enabledCount} of {kinds.length} enabled
                <span aria-hidden="true" className="transition-transform group-open:rotate-180">⌄</span>
              </span>
            </summary>

            <div className="divide-y divide-gray-100 dark:divide-gray-700 border-t border-gray-100 dark:border-gray-800">
              {kinds.map((kind) => {
                const { label, description } = KIND_INFO[kind];
                const isEnabled = state[kind];
                const isPending = pending === kind;

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
          </details>
        );
      })}
    </div>
  );
}
