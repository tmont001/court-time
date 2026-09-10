"use client";

import { useState, useTransition } from "react";
import { updateBookingRules } from "./actions";

interface Props {
  bookingWindowDays:          number;
  cancellationWindowHours:    number;
  cancellationGraceMinutes:   number;
  waitlistOfferWindowHours:   number;  // Phase 18C
}

export default function BookingRulesForm({
  bookingWindowDays,
  cancellationWindowHours,
  cancellationGraceMinutes,
  waitlistOfferWindowHours,
}: Props) {
  const [isPending, startTransition] = useTransition();
  const [status, setStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    setStatus(null);
    startTransition(async () => {
      const result = await updateBookingRules(formData);
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
      <div>
        <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
          Booking window (days)
        </label>
        <input
          type="number"
          name="booking_window_days"
          defaultValue={bookingWindowDays}
          min={1}
          max={365}
          required
          className="ct-input"
        />
        <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
          How many days ahead members can book (1–365).
        </p>
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
          Cancellation window (hours)
        </label>
        <input
          type="number"
          name="cancellation_window_hours"
          defaultValue={cancellationWindowHours}
          min={0}
          max={168}
          required
          className="ct-input"
        />
        <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
          Minimum hours before a reservation that members can cancel (0–168).
        </p>
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
          Cancellation grace period (minutes)
        </label>
        <input
          type="number"
          name="cancellation_grace_minutes"
          defaultValue={cancellationGraceMinutes}
          min={0}
          max={60}
          required
          className="ct-input"
        />
        <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
          Allows members to cancel accidental bookings shortly after creation, even inside the
          cancellation window (0–60 min). Set to 0 to disable.
        </p>
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
          Waitlist offer window (hours)
        </label>
        <input
          type="number"
          name="waitlist_offer_window_hours"
          defaultValue={waitlistOfferWindowHours}
          min={1}
          max={72}
          required
          className="ct-input"
        />
        <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
          How long a waitlisted member has to accept a spot offer (1–72 hours).
        </p>
      </div>

      <div className="flex items-center gap-3 pt-1">
        <button
          type="submit"
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
    </form>
  );
}
