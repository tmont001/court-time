"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateClubCurrency } from "./actions";

interface Props {
  currency: string;
}

// The exact operator-facing copy updateClubCurrency (./actions) maps
// currency_locked_by_pricing to. Server Actions ("use server" files) may
// only export async functions, so this string can't be imported directly
// from actions.ts — it's duplicated here ONLY so this form can detect
// that one specific failure (to reset the visible field, below) without
// widening updateClubCurrency's return contract with a new error-code
// field. If this copy ever changes, update both places.
const CURRENCY_LOCKED_MESSAGE = "Currency can’t be changed after paid pricing has been configured or recorded.";

// Peak/Off-Peak Pricing IA refinement: split out of the former
// PricingSettingsForm, which used to combine club currency with the
// default court rate fields on one form. Currency is club-wide
// configuration and stays here in Settings; the rate fields moved to
// Admin -> Courts -> Court Rates (DefaultCourtRatesForm) — see that
// component and updateClubCurrency/updateDefaultCourtRates (./actions)
// for the full split. This form never touches a rate value at all;
// updateClubCurrency re-reads the current default rates fresh server-side
// so a save here can never accidentally clear or change them.
//
// The currency lock itself (currency_locked_by_pricing, raised by
// update_club_pricing once any positive pricing exists) is NOT
// re-implemented or previewed here — the database remains the sole
// authority on when currency may change. This form only explains the
// rule in the helper copy below, and on that specific failure resets the
// visible field back to the persisted value (never a locally-guessed
// scan of whether pricing exists).
export default function ClubCurrencyForm({ currency }: Props) {
  const router = useRouter();
  const [currencyValue, setCurrencyValue] = useState(currency);
  const [isPending, startTransition] = useTransition();
  const [status, setStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = currencyValue.trim().toUpperCase();

    setStatus(null);
    startTransition(async () => {
      const result = await updateClubCurrency(trimmed);
      if (result.error) {
        // The lock means nothing typed here will be accepted right now —
        // reset the visible field back to what's actually persisted so
        // it's unambiguous the attempted change did NOT take effect.
        // Other validation errors (e.g. an invalid format) intentionally
        // leave the typed value in place so the Admin can see and correct
        // their own mistake.
        if (result.error === CURRENCY_LOCKED_MESSAGE) {
          setCurrencyValue(currency);
        }
        setStatus({ type: "error", message: result.error });
      } else {
        setStatus({ type: "success", message: "Saved" });
        setTimeout(() => setStatus(null), 2000);
        router.refresh();
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
          value={currencyValue}
          onChange={e => setCurrencyValue(e.target.value)}
          maxLength={3}
          required
          className="ct-input uppercase"
          style={{ width: "6rem" }}
        />
        <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
          3-letter currency code (e.g. USD). Applies to every price in the club.
        </p>
        <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
          Currency is locked once paid pricing has been configured or recorded, so existing amounts
          keep their original denomination.
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
