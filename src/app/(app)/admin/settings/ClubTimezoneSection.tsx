"use client";

import { useState, useTransition } from "react";
import { updateClubTimezone } from "./actions";

const US_TIMEZONES: { value: string; label: string }[] = [
  { value: "America/New_York",    label: "Eastern Time — New York"              },
  { value: "America/Chicago",     label: "Central Time — Chicago"               },
  { value: "America/Denver",      label: "Mountain Time — Denver"               },
  { value: "America/Phoenix",     label: "Arizona Time — Phoenix, no daylight saving" },
  { value: "America/Los_Angeles", label: "Pacific Time — Los Angeles"           },
  { value: "America/Anchorage",   label: "Alaska Time — Anchorage"              },
  { value: "Pacific/Honolulu",    label: "Hawaii Time — Honolulu"               },
];

interface Props {
  currentTimezone: string;
}

export default function ClubTimezoneSection({ currentTimezone }: Props) {
  const [selected, setSelected]   = useState(currentTimezone);
  const [isPending, startTransition] = useTransition();
  const [status, setStatus]       = useState<{ type: "success" | "error"; message: string } | null>(null);

  function handleChange(value: string) {
    setSelected(value);
    setStatus(null);
  }

  function handleSave() {
    setStatus(null);
    startTransition(async () => {
      const result = await updateClubTimezone(selected);
      if (result.error) {
        setStatus({ type: "error", message: result.error });
      } else {
        setStatus({ type: "success", message: "Saved" });
        setTimeout(() => setStatus(null), 2000);
      }
    });
  }

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
          Club timezone
        </label>
        <select
          value={selected}
          onChange={e => handleChange(e.target.value)}
          className="ct-input"
        >
          {US_TIMEZONES.map(tz => (
            <option key={tz.value} value={tz.value}>
              {tz.label}
            </option>
          ))}
        </select>
        <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
          Affects the calendar, events, bookings, and operating hours displayed
          to all members.
        </p>
        <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
          Court Time currently supports United States time zones. The city
          identifies the time-zone region and is not saved as the club&rsquo;s
          physical location.
        </p>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={isPending}
          className="ct-button-primary"
        >
          {isPending ? "Saving…" : "Save"}
        </button>
        {status && (
          <p className={`text-xs font-medium ${
            status.type === "success" ? "text-green-600" : "text-red-500"
          }`}>
            {status.message}
          </p>
        )}
      </div>
    </div>
  );
}
