"use client";

import { useState, useTransition } from "react";
import { updateClubSettings } from "./actions";

interface Props {
  bookingWindowDays:        number;
  cancellationWindowHours:  number;
  cancellationGraceMinutes: number;
  clubName:                 string;
  userRole:                 string;
}

export default function SettingsForm({
  bookingWindowDays,
  cancellationWindowHours,
  cancellationGraceMinutes,
  clubName,
  userRole,
}: Props) {
  const [isPending, startTransition] = useTransition();
  const [status, setStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    setStatus(null);
    startTransition(async () => {
      const result = await updateClubSettings(formData);
      if (result.error) {
        setStatus({ type: "error", message: result.error });
      } else {
        setStatus({ type: "success", message: "Saved" });
        setTimeout(() => setStatus(null), 2000);
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      {userRole === "admin" && (
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">
            Club name
          </label>
          <input
            type="text"
            name="club_name"
            defaultValue={clubName}
            required
            maxLength={100}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-400"
          />
          <p className="text-xs text-gray-400 mt-1">
            Shown in the app header for all members.
          </p>
        </div>
      )}

      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">
          Booking window (days)
        </label>
        <input
          type="number"
          name="booking_window_days"
          defaultValue={bookingWindowDays}
          min={1}
          max={365}
          required
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-400"
        />
        <p className="text-xs text-gray-400 mt-1">
          How many days ahead members can book (1–365).
        </p>
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">
          Cancellation window (hours)
        </label>
        <input
          type="number"
          name="cancellation_window_hours"
          defaultValue={cancellationWindowHours}
          min={0}
          max={168}
          required
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-400"
        />
        <p className="text-xs text-gray-400 mt-1">
          Minimum hours before a reservation that members can cancel (0–168).
        </p>
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">
          Cancellation grace period (minutes)
        </label>
        <input
          type="number"
          name="cancellation_grace_minutes"
          defaultValue={cancellationGraceMinutes}
          min={0}
          max={60}
          required
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-400"
        />
        <p className="text-xs text-gray-400 mt-1">
          Allows members to cancel accidental bookings shortly after creation, even inside the cancellation window (0–60 min). Set to 0 to disable.
        </p>
      </div>

      <div className="flex items-center gap-3 pt-1">
        <button
          type="submit"
          disabled={isPending}
          className="px-4 py-2 rounded-lg bg-gray-900 text-white text-sm font-medium disabled:opacity-40"
        >
          {isPending ? "Saving…" : "Save"}
        </button>
        {status && (
          <p
            className={`text-xs font-medium ${
              status.type === "success" ? "text-green-600" : "text-red-500"
            }`}
          >
            {status.message}
          </p>
        )}
      </div>
    </form>
  );
}
