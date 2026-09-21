"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateDefaultCourtRates } from "@/app/(app)/admin/settings/actions";

interface Props {
  currency:                             string;
  defaultCourtHourlyRateCents:          number | null;
  membershipsEnabled:                   boolean;
  defaultCourtHourlyRateNonMemberCents: number | null;
}

// Peak/Off-Peak Pricing IA refinement: relocated from
// /admin/settings/PricingSettingsForm.tsx, which used to combine these
// rate fields with club currency editing on one form. Currency is
// club-wide configuration and stays in Settings (ClubCurrencyForm); these
// default court rate fields now live here, next to the per-court
// overrides (CourtManagementList) and Peak/Off-Peak rate periods
// (CourtRatePeriodsSection) they already conceptually belong with.
// Persists through the SAME update_club_pricing RPC as before, via the
// dedicated updateDefaultCourtRates Server Action (settings/actions.ts,
// which owns all update_club_pricing persistence) — mirrors the existing
// cross-directory Server Action import precedent already established by
// MembershipsSection importing updateClubMembershipsEnabled from this
// same settings/actions module. That action re-reads the CURRENT
// authoritative currency fresh from the server on every save (currency is
// not editable here, and never sent from this form at all), so a stale
// render of this tab can never silently change the club's currency.
//
// Phase 34B/42C-2 behavior preserved verbatim: court pricing remains
// opt-in (blank = unpriced), the Non-Member field is gated behind
// membershipsEnabled, its value is preserved server-side (not cleared)
// while Memberships are off, and NULL vs 0 semantics are unchanged.
export default function DefaultCourtRatesForm({
  currency,
  defaultCourtHourlyRateCents,
  membershipsEnabled,
  defaultCourtHourlyRateNonMemberCents,
}: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [status, setStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [rateDollars, setRateDollars] = useState(
    defaultCourtHourlyRateCents !== null ? (defaultCourtHourlyRateCents / 100).toFixed(2) : ""
  );
  const [nonMemberRateDollars, setNonMemberRateDollars] = useState(
    defaultCourtHourlyRateNonMemberCents !== null ? (defaultCourtHourlyRateNonMemberCents / 100).toFixed(2) : ""
  );

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const rateValue = (formData.get("default_court_hourly_rate_cents") as string).trim();
    const rateCents = rateValue === "" ? null : Math.round(parseFloat(rateValue) * 100);

    // Read from state, not FormData — this input may not be mounted right
    // now (Memberships off), and its state still holds the club's actual
    // stored value in that case.
    const nonMemberRateTrimmed = nonMemberRateDollars.trim();
    const nonMemberRateCents = nonMemberRateTrimmed === "" ? null : Math.round(parseFloat(nonMemberRateTrimmed) * 100);

    setStatus(null);
    startTransition(async () => {
      const result = await updateDefaultCourtRates(rateCents, nonMemberRateCents);
      if (result.error) {
        setStatus({ type: "error", message: result.error });
      } else {
        if (result.nonMemberRatePreserved) {
          setNonMemberRateDollars(
            result.effectiveNonMemberRateCents != null
              ? (result.effectiveNonMemberRateCents / 100).toFixed(2)
              : ""
          );
          setStatus({
            type: "success",
            message: "Saved. Memberships are off, so the Non-Member rate was left unchanged.",
          });
          setTimeout(() => setStatus(null), 4000);
        } else {
          setStatus({ type: "success", message: "Saved" });
          setTimeout(() => setStatus(null), 2000);
        }
        router.refresh();
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <p className="text-xs text-gray-400 dark:text-gray-500">
        Rates shown in {currency}. Club currency is managed in Settings.
      </p>

      <div>
        <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
          {membershipsEnabled
            ? "Standard / Member court hourly rate (optional)"
            : "Court reservation pricing (optional)"}
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
          {membershipsEnabled
            ? "Fallback hourly rate for Members when no court-specific or matching time-based Member rate applies. Individual courts may still set their own rate on the Courts tab."
            : "Fallback hourly rate for court reservations when no court-specific or matching time-based rate applies. Leave blank if your club does not charge for court reservations — individual courts may still set their own rate on the Courts tab regardless."}
        </p>
      </div>

      {membershipsEnabled && (
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
            Non-Member court hourly rate (optional)
          </label>
          <input
            type="number"
            name="default_court_hourly_rate_non_member_cents"
            value={nonMemberRateDollars}
            onChange={e => setNonMemberRateDollars(e.target.value)}
            min={0}
            step={0.01}
            placeholder="0.00"
            className="ct-input"
          />
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
            Fallback hourly rate for Non-Members when no court-specific or matching time-based Non-Member rate
            applies. Leave blank to use your other configured pricing fallbacks.
          </p>
        </div>
      )}

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
