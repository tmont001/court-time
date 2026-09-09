"use client";

import { useCallback, useEffect, useState } from "react";
import { triggerCsvDownload } from "@/lib/downloadBlob";
import { exportOutstandingBalancesCsv } from "./exportActions";
import PaymentActivityExportSheet from "./PaymentActivityExportSheet";

// Phase 34G-C2 — §1. One toolbar-level "Export" control offering exactly
// "Outstanding balances" (fires immediately) and "Payment activity" (opens
// a small date-range configuration sheet). Mirrors AccountMenu.tsx's own
// anchored dropdown pattern (relative trigger + fixed backdrop + floating
// panel, dismiss on outside click/Escape) — the closest existing
// precedent for a compact action menu in this codebase.
//
// Final runtime-QA polish — moved out of its own header row (where it sat
// isolated on the far right) into the SAME toolbar row as the Outstanding/
// All tabs and the search input, matching that row's own visual weight
// (px-4 py-2, text-sm font-semibold) and neutral gray outlined styling —
// deliberately never Court Time brand green or semantic status green,
// since this is a plain utility action, not a success/commercial state.

function DownloadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

export default function PaymentExportMenu({
  clubId, clubTimezone,
}: {
  clubId: string;
  clubTimezone: string;
}) {
  const [open, setOpen] = useState(false);
  const [showActivitySheet, setShowActivitySheet] = useState(false);
  const [exportingOutstanding, setExportingOutstanding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close]);

  async function handleOutstandingBalances() {
    if (exportingOutstanding) return;
    close();
    setExportingOutstanding(true);
    setError(null);
    try {
      const result = await exportOutstandingBalancesCsv(clubId);
      if (result.error || !result.csv || !result.filename) {
        setError(result.error ?? "Failed to generate the export. Please try again.");
        return;
      }
      triggerCsvDownload(result.csv, result.filename);
    } catch {
      setError("Failed to generate the export. Please try again.");
    } finally {
      setExportingOutstanding(false);
    }
  }

  return (
    <div className="relative w-full sm:w-auto">
      <button
        onClick={() => setOpen(v => !v)}
        aria-label="Export payments"
        aria-expanded={open}
        disabled={exportingOutstanding}
        className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 motion-safe:transition-colors motion-safe:duration-100 disabled:opacity-50"
      >
        <DownloadIcon />
        {exportingOutstanding ? "Exporting…" : "Export"}
        <ChevronIcon />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={close} />
          <div
            className="ct-popover-enter fixed sm:absolute top-auto sm:top-full right-4 sm:right-0 mt-2 z-50 w-56 bg-white dark:bg-gray-800 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            <nav className="py-1">
              <button
                onClick={handleOutstandingBalances}
                className="w-full text-left flex items-center px-4 py-2.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/60 hover:text-gray-900 dark:hover:text-gray-100 motion-safe:transition-colors motion-safe:duration-100"
              >
                Outstanding balances
              </button>
              <button
                onClick={() => { close(); setShowActivitySheet(true); }}
                className="w-full text-left flex items-center px-4 py-2.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/60 hover:text-gray-900 dark:hover:text-gray-100 motion-safe:transition-colors motion-safe:duration-100"
              >
                Payment activity
              </button>
            </nav>
          </div>
        </>
      )}

      {error && (
        <p className="absolute top-full right-0 mt-2 z-50 w-64 text-xs text-red-600 dark:text-red-400 bg-white dark:bg-gray-800 border border-red-200 dark:border-red-900 rounded-lg px-3 py-2 shadow-lg">
          {error}
        </p>
      )}

      {showActivitySheet && (
        <PaymentActivityExportSheet
          clubId={clubId}
          clubTimezone={clubTimezone}
          onClose={() => setShowActivitySheet(false)}
        />
      )}
    </div>
  );
}
