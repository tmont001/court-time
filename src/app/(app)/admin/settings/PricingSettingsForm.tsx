"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateClubPricing } from "./actions";

interface Props {
  currency:                             string;
  defaultCourtHourlyRateCents:          number | null;
  membershipsEnabled:                   boolean;
  defaultCourtHourlyRateNonMemberCents: number | null;
}

// Phase 34B: club-wide currency + OPTIONAL default court hourly rate.
// Court pricing is opt-in — leaving the rate blank means court booking
// stays completely unpriced, with zero behavioral change for the club.
//
// Phase 42C-2: extended with an OPTIONAL Non-Member court hourly rate,
// shown only while Memberships are on. The Non-Member field's value is
// kept in its own component state (not re-derived from FormData on
// submit) so hiding it when Memberships are off never clears what the
// club already had stored — the same value that seeded this state on
// mount is exactly what gets sent back on every submit, whether or not
// the field itself was rendered this time.
//
// Correction pass: this client-side preservation is a UX convenience, NOT
// the source of truth — updateClubPricing itself re-reads current
// club_settings server-side and overrides whatever is sent here whenever
// memberships_enabled is currently false (see its own comment), so a
// stale/unsaved value sitting in this component's state can never
// actually reach the database while Memberships are off.
//
// UX polish pass: on success, updateClubPricing's returned
// nonMemberRatePreserved/effectiveNonMemberRateCents tell this stale-tab
// case apart from a normal save. When preserved, the visible "Saved"
// message would otherwise misleadingly suggest this tab's own typed
// Non-Member value took effect — instead this resyncs the local state to
// the authoritative stored value and shows an explicit message. Either
// way, router.refresh() re-fetches this route's Server Component props
// (membershipsEnabled included) so a stale tab stops looking stale.
export default function PricingSettingsForm({
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
    const currencyValue = (formData.get("currency") as string).trim().toUpperCase();
    const rateValue = (formData.get("default_court_hourly_rate_cents") as string).trim();
    const rateCents = rateValue === "" ? null : Math.round(parseFloat(rateValue) * 100);

    // Read from state, not FormData — this input may not be mounted right
    // now (Memberships off), and its state still holds the club's actual
    // stored value in that case.
    const nonMemberRateTrimmed = nonMemberRateDollars.trim();
    const nonMemberRateCents = nonMemberRateTrimmed === "" ? null : Math.round(parseFloat(nonMemberRateTrimmed) * 100);

    setStatus(null);
    startTransition(async () => {
      const result = await updateClubPricing(currencyValue, rateCents, nonMemberRateCents);
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
            ? "Default hourly rate charged to Members for a court reservation. Individual courts may still set their own rate on the Courts page."
            : "Default hourly rate charged for a court reservation. Leave the default rate blank if your club does not charge for court reservations — individual courts may still set their own rate on the Courts page regardless."}
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
            Default hourly rate charged to Non-Members. Leave blank to use the standard/Member rate for everyone.
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
