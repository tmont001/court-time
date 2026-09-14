"use client";

// 0184 — Admin-editable, informational-only "Club Rules & Policies"
// document (court etiquette, dress code, cleanup, ball machine rules,
// general facility expectations, guest/check-in guidance). Mirrors
// ClubTimezoneSection's exact shape (useTransition + inline Save +
// success/error feedback) — the established convention for a single-field
// club_settings section on this page. Never used for cancellation
// windows, refund rules, booking restrictions, fees, eligibility, or
// waiver acceptance — those remain structured product policy handled
// elsewhere.

import { useState, useTransition } from "react";
import { updateClubRulesAndPolicies } from "./actions";

const MAX_LENGTH = 10000;

interface Props {
  currentRulesAndPolicies: string | null;
}

export default function ClubRulesSection({ currentRulesAndPolicies }: Props) {
  const [value, setValue]         = useState(currentRulesAndPolicies ?? "");
  const [isPending, startTransition] = useTransition();
  const [status, setStatus]       = useState<{ type: "success" | "error"; message: string } | null>(null);

  function handleChange(next: string) {
    setValue(next);
    setStatus(null);
  }

  function handleSave() {
    setStatus(null);
    startTransition(async () => {
      const result = await updateClubRulesAndPolicies(value);
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
          Club Rules & Policies
        </label>
        <textarea
          value={value}
          onChange={e => handleChange(e.target.value)}
          maxLength={MAX_LENGTH}
          rows={8}
          placeholder="Court etiquette, dress code, court cleanup, ball machine rules, guest/check-in expectations, general facility rules…"
          className="ct-input resize-y"
        />
        <div className="mt-1 flex items-center justify-between">
          <p className="text-xs text-gray-400 dark:text-gray-500">
            Shown to Members, Staff, and Pros on the Help page. Informational only — this is not
            enforced by the app (cancellation windows, refunds, booking limits, and fees are
            configured elsewhere).
          </p>
          <p className="shrink-0 ml-3 text-[11px] text-gray-400 dark:text-gray-500 tabular-nums">
            {value.length}/{MAX_LENGTH}
          </p>
        </div>
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
