"use client";

// Phase 42C-2 — Admin-only Memberships on/off toggle. Same ON/OFF toggle
// shape as PaymentTrackingSection (this file's own precedent), mutating a
// single boolean (club_settings.memberships_enabled, 0190) via a dedicated
// Server Action that calls the dedicated update_club_memberships_enabled
// RPC. No confirm modal: unlike disabling Payment Tracking (which stops
// new balances from being created), turning Memberships off is fully
// non-destructive — it never deletes or clears membership_types, roster
// membership_status/membership_type_id, or configured Member/Non-Member
// rates; it only changes which rate-resolution chain new reservations use
// (Approach B, Phase 42C audit). That distinction is the compelling reason
// the locked UX spec allows skipping the destructive-confirmation pattern
// here.

import { useEffect, useState, useTransition } from "react";
import { updateClubMembershipsEnabled } from "@/app/(app)/admin/settings/actions";

function ToggleSwitch({
  checked,
  disabled,
  label,
  onClick,
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`relative shrink-0 inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-gray-400 dark:focus-visible:ring-offset-gray-800 ${
        disabled ? "opacity-40 cursor-not-allowed" : ""
      } ${checked ? "bg-accent" : "bg-gray-200 dark:bg-gray-700"}`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
          checked ? "translate-x-6" : "translate-x-1"
        }`}
      />
    </button>
  );
}

export default function MembershipsSection({
  enabled,
}: {
  enabled: boolean;
}) {
  // Resynced from the server-confirmed prop whenever it changes — the same
  // pattern PaymentTrackingSection's own `mode` state uses, and for the
  // same reason: revalidatePath("/", "layout") re-renders this Server
  // Component tree and pushes a fresh `enabled` prop after a successful
  // mutation.
  const [membershipsEnabled, setMembershipsEnabled] = useState(enabled);
  const [isPending, startTransition] = useTransition();
  const [status, setStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);

  useEffect(() => {
    setMembershipsEnabled(enabled);
  }, [enabled]);

  function handleToggle() {
    if (isPending) return;
    const next = !membershipsEnabled;
    setStatus(null);
    startTransition(async () => {
      const result = await updateClubMembershipsEnabled(next);
      if (result.error) {
        // Never optimistically flips — stays exactly where it was.
        setStatus({ type: "error", message: result.error });
      } else {
        setMembershipsEnabled(next);
        setStatus({ type: "success", message: "Saved" });
        setTimeout(() => setStatus(null), 2000);
      }
    });
  }

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 px-4 py-3.5">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">Memberships</p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              {membershipsEnabled
                ? "The club can distinguish Members and Non-Members, manage membership status/types, and configure different court rates for each."
                : "Everyone uses the standard/base court rate. Stored membership records, types, and rates are preserved — roles and application access are unaffected."}
            </p>
          </div>
          <ToggleSwitch
            checked={membershipsEnabled}
            disabled={isPending}
            label="Memberships"
            onClick={handleToggle}
          />
        </div>
      </div>

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
  );
}
