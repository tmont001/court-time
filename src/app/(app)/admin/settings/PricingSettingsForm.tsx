"use client";

import { useState, useTransition } from "react";
import { updateClubPricing } from "./actions";

interface Props {
  currency:                    string;
  defaultCourtHourlyRateCents: number | null;
}

// Phase 34B: club-wide currency + OPTIONAL default court hourly rate.
// Court pricing is opt-in — leaving the rate blank means court booking
// stays completely unpriced, with zero behavioral change for the club.
export default function PricingSettingsForm({ currency, defaultCourtHourlyRateCents }: Props) {
  const [isPending, startTransition] = useTransition();
  const [status, setStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [rateDollars, setRateDollars] = useState(
    defaultCourtHourlyRateCents !== null ? (defaultCourtHourlyRateCents / 100).toFixed(2) : ""
  );

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const currencyValue = (formData.get("currency") as string).trim().toUpperCase();
    const rateValue = (formData.get("default_court_hourly_rate_cents") as string).trim();
    const rateCents = rateValue === "" ? null : Math.round(parseFloat(rateValue) * 100);

    setStatus(null);
    startTransition(async () => {
      const result = await updateClubPricing(currencyValue, rateCents);
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
          Currency
        </label>
        <input
          type="text"
          name="currency"
          defaultValue={currency}
          maxLength={3}
          required
          className="ct-input uppercase"
          style={{ width: "6rem" }}
        />
        <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
          3-letter currency code (e.g. USD). Applies to every price in the club.
        </p>
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
          Court reservation pricing (optional)
        </label>
        <input
          type="number"
          name="default_court_hourly_rate_cents"
          value={rateDollars}
          onChange={e => setRateDollars(e.target.value)}
          min={0}
          step={0.01}
          placeholder="0.00"
          className="ct-input"
        />
        <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
          Default hourly rate charged for a court reservation. Leave the default rate blank if
          your club does not charge for court reservations — individual courts may still set
          their own rate below regardless.
        </p>
      </div>

      <div className="flex items-center gap-3 pt-1">
        <button type="submit" disabled={isPending} className="ct-button-primary">
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
