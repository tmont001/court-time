"use client";

import { useState } from "react";
import ResponsiveSheet from "@/components/ResponsiveSheet";
import { ACTION_BUTTON_PRIMARY_COMPACT_TOUCH } from "@/components/styles/actionButtonStyles";
import { triggerCsvDownload } from "@/lib/downloadBlob";
import { defaultCurrentMonthRange } from "./exportLogic";
import { exportPaymentActivityCsv } from "./exportActions";

// Phase 34G-C2 — §8/§9/§23. Small date-range configuration surface for
// the Payment Activity export. Defaults to the current month in club-local
// time; "All activity" bypasses the date filter entirely. Duplicate-click
// prevention, a useful failure message, and preserved selections on
// failure are all handled locally — a failed export never navigates away
// and never produces an empty file (the Server Action itself never
// returns a "success" with no csv).

export default function PaymentActivityExportSheet({
  clubId, clubTimezone, onClose,
}: {
  clubId: string;
  clubTimezone: string;
  onClose: () => void;
}) {
  const defaults = defaultCurrentMonthRange(clubTimezone);
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);
  const [all, setAll] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleExport() {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const result = await exportPaymentActivityCsv({ all, from: all ? null : from, to: all ? null : to }, clubId);
      if (result.error || !result.csv || !result.filename) {
        setError(result.error ?? "Failed to generate the export. Please try again.");
        return;
      }
      triggerCsvDownload(result.csv, result.filename);
      onClose();
    } catch {
      setError("Failed to generate the export. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <ResponsiveSheet
      onClose={onClose}
      variant="modal"
      mobileInteraction="draggable"
      label="Export Payment Activity"
      header={<p className="text-base font-semibold text-gray-900 dark:text-gray-100">Export Payment Activity</p>}
    >
      <div className="space-y-5 pt-1">
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Exports collected payments, refunds, and corrections — one row per money-movement event.
        </p>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">From</span>
            <input
              type="date"
              value={from}
              onChange={e => setFrom(e.target.value)}
              disabled={all}
              className="w-full ct-input text-base md:text-sm disabled:opacity-50"
            />
          </label>
          <label className="block">
            <span className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">To</span>
            <input
              type="date"
              value={to}
              onChange={e => setTo(e.target.value)}
              disabled={all}
              className="w-full ct-input text-base md:text-sm disabled:opacity-50"
            />
          </label>
        </div>

        <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
          <input
            type="checkbox"
            checked={all}
            onChange={e => setAll(e.target.checked)}
            className="rounded border-gray-300 dark:border-gray-600"
          />
          All activity
        </label>

        {error && (
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm font-semibold text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 motion-safe:transition-colors motion-safe:duration-100"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleExport}
            disabled={loading || (!all && (!from || !to))}
            className={`${ACTION_BUTTON_PRIMARY_COMPACT_TOUCH} disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            {loading ? "Exporting…" : "Export CSV"}
          </button>
        </div>
      </div>
    </ResponsiveSheet>
  );
}
