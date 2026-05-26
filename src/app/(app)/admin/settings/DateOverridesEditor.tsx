"use client";

import { useState, useEffect, useTransition, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";

// ─── Types ────────────────────────────────────────────────────────────────────

type OverrideRow = {
  id:            string;
  override_date: string;        // YYYY-MM-DD
  is_closed:     boolean;
  opens_at:      string | null; // "HH:MM:SS" from DB (nullable)
  closes_at:     string | null; // "HH:MM:SS" from DB (nullable)
  note:          string | null;
};

type SavePayload = {
  p_override_date: string;
  p_is_closed:     boolean;
  p_opens_at:      string | null;
  p_closes_at:     string | null;
  p_note:          string | null;
};

type UpsertResult = { dry_run: boolean; affected_count: number };

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Slice "HH:MM:SS" → "HH:MM" for <input type="time">
function toTimeInput(t: string | null): string {
  return t ? t.slice(0, 5) : "";
}

// Format YYYY-MM-DD as a readable date string, treating it as a local date
// (no time zone shift) to avoid off-by-one day at UTC boundaries.
function formatDate(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    weekday: "short",
    month:   "short",
    day:     "numeric",
    year:    "numeric",
  });
}

function mapRpcError(message: string): string {
  if (message.includes("not_authenticated"))        return "You must be signed in.";
  if (message.includes("insufficient_role"))        return "Admin access required.";
  if (message.includes("invalid_override_payload")) return "Invalid data — check the times and try again.";
  if (message.includes("override_not_found"))       return "Override not found. It may have already been deleted.";
  return "Something went wrong. Please try again.";
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  clubId:       string;
  clubTimezone: string;
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function DateOverridesEditor({ clubId, clubTimezone }: Props) {
  // Today in the club's timezone (YYYY-MM-DD) — used as the list filter lower
  // bound and the minimum selectable date in the date input.
  const todayISO = useMemo(
    () => new Date().toLocaleDateString("en-CA", { timeZone: clubTimezone }),
    [clubTimezone]
  );

  // ── Overrides list ────────────────────────────────────────────────────────
  const [overrides, setOverrides]   = useState<OverrideRow[]>([]);
  const [loaded, setLoaded]         = useState(false);
  const [loadError, setLoadError]   = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    if (!clubId) return;
    setLoaded(false);
    setLoadError(null);
    const supabase = createClient();
    supabase
      .from("operating_hours_override")
      .select("id, override_date, is_closed, opens_at, closes_at, note")
      .eq("club_id", clubId)
      .gte("override_date", todayISO)
      .order("override_date", { ascending: true })
      .then(({ data, error }) => {
        if (error) setLoadError("Failed to load special closures.");
        else       setOverrides(data ?? []);
        setLoaded(true);
      });
  }, [clubId, todayISO, refreshTick]);

  // ── Form state ────────────────────────────────────────────────────────────
  const [showForm, setShowForm]         = useState(false);
  // null = adding a new override; YYYY-MM-DD = editing this date's override.
  const [editingDate, setEditingDate]   = useState<string | null>(null);
  const [formDate, setFormDate]         = useState("");
  const [formIsClosed, setFormIsClosed] = useState(true);
  const [formOpensAt, setFormOpensAt]   = useState("08:00");
  const [formClosesAt, setFormClosesAt] = useState("20:00");
  const [formNote, setFormNote]         = useState("");

  // ── Save flow ─────────────────────────────────────────────────────────────
  const [isPending, startTransition]           = useTransition();
  const [validationError, setValidationError]  = useState<string | null>(null);
  const [rpcError, setRpcError]                = useState<string | null>(null);
  const [saved, setSaved]                      = useState(false);
  // Set when dry-run returns affected_count > 0; cleared on cancel or commit.
  const [confirmAffected, setConfirmAffected]  = useState<number | null>(null);
  const [pendingPayload, setPendingPayload]     = useState<SavePayload | null>(null);

  // ── Delete flow ───────────────────────────────────────────────────────────
  const [confirmDeleteDate, setConfirmDeleteDate] = useState<string | null>(null);
  const [deleteError, setDeleteError]             = useState<string | null>(null);

  // ── Helpers ───────────────────────────────────────────────────────────────

  function resetForm() {
    setShowForm(false);
    setEditingDate(null);
    setFormDate("");
    setFormIsClosed(true);
    setFormOpensAt("08:00");
    setFormClosesAt("20:00");
    setFormNote("");
    setValidationError(null);
    setRpcError(null);
  }

  function handleAddClick() {
    resetForm();
    setShowForm(true);
  }

  function handleEdit(row: OverrideRow) {
    setEditingDate(row.override_date);
    setFormDate(row.override_date);
    setFormIsClosed(row.is_closed);
    setFormOpensAt(toTimeInput(row.opens_at) || "08:00");
    setFormClosesAt(toTimeInput(row.closes_at) || "20:00");
    setFormNote(row.note ?? "");
    setValidationError(null);
    setRpcError(null);
    setShowForm(true);
  }

  function validate(): boolean {
    if (!formDate) {
      setValidationError("Please select a date.");
      return false;
    }
    if (!formIsClosed) {
      if (!formOpensAt || !formClosesAt) {
        setValidationError("Opening and closing times are required for special hours.");
        return false;
      }
      if (formOpensAt >= formClosesAt) {
        setValidationError("Closing time must be after opening time.");
        return false;
      }
    }
    return true;
  }

  // Sends p_dry_run = false and updates state on success.
  async function commitSave(payload: SavePayload): Promise<void> {
    const supabase = createClient();
    const { error } = await supabase.rpc("upsert_operating_hours_override", {
      ...payload,
      p_dry_run: false,
    });
    if (error) {
      setRpcError(mapRpcError(error.message));
      return;
    }
    setConfirmAffected(null);
    setPendingPayload(null);
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
    resetForm();
    setRefreshTick(t => t + 1);
  }

  function handleSave() {
    setValidationError(null);
    setRpcError(null);
    setSaved(false);
    if (!validate()) return;

    const payload: SavePayload = {
      p_override_date: formDate,
      p_is_closed:     formIsClosed,
      p_opens_at:      formIsClosed ? null : formOpensAt,
      p_closes_at:     formIsClosed ? null : formClosesAt,
      p_note:          formNote.trim() || null,
    };

    startTransition(async () => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("upsert_operating_hours_override", {
        ...payload,
        p_dry_run: true,
      });
      if (error) {
        setRpcError(mapRpcError(error.message));
        return;
      }
      const result = data as UpsertResult;
      if (result.affected_count > 0) {
        // Show conflict confirmation before committing.
        setPendingPayload(payload);
        setConfirmAffected(result.affected_count);
      } else {
        // No conflicts — commit immediately.
        await commitSave(payload);
      }
    });
  }

  function handleConfirmSave() {
    if (!pendingPayload) return;
    startTransition(async () => {
      await commitSave(pendingPayload);
    });
  }

  function handleDeleteClick(overrideDate: string) {
    setDeleteError(null);
    setConfirmDeleteDate(overrideDate);
  }

  function handleDeleteConfirm() {
    if (!confirmDeleteDate) return;
    startTransition(async () => {
      const supabase = createClient();
      const { error } = await supabase.rpc("delete_operating_hours_override", {
        p_override_date: confirmDeleteDate,
        p_dry_run:       false,
      });
      if (error) {
        setDeleteError(mapRpcError(error.message));
        return;
      }
      setConfirmDeleteDate(null);
      setDeleteError(null);
      setRefreshTick(t => t + 1);
    });
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      {/* ── Overrides list ─────────────────────────────────────────────── */}
      <div className="space-y-0">
        {!loaded && (
          <p className="text-sm text-gray-400 dark:text-gray-500 py-2">Loading…</p>
        )}
        {loadError && (
          <p className="text-sm text-red-500 dark:text-red-400 py-2">{loadError}</p>
        )}
        {loaded && overrides.length === 0 && (
          <p className="text-sm text-gray-400 dark:text-gray-500 py-1">
            No upcoming special closures.
          </p>
        )}

        {overrides.map((row) => {
          const hoursLabel = row.is_closed
            ? "Closed"
            : `${toTimeInput(row.opens_at)} – ${toTimeInput(row.closes_at)}`;

          return (
            <div
              key={row.id}
              className="flex items-center gap-3 py-2.5 border-b border-gray-100 dark:border-gray-800 last:border-b-0"
            >
              {/* Date + summary */}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">
                  {formatDate(row.override_date)}
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
                  {hoursLabel}
                  {row.note ? ` · ${row.note}` : ""}
                </p>
              </div>

              {/* Edit */}
              <button
                onClick={() => handleEdit(row)}
                className="shrink-0 text-xs font-medium text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 px-2 py-1 rounded"
              >
                Edit
              </button>

              {/* Delete */}
              <button
                onClick={() => handleDeleteClick(row.override_date)}
                className="shrink-0 text-xs font-medium text-red-500 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 px-2 py-1 rounded"
              >
                Delete
              </button>
            </div>
          );
        })}
      </div>

      {/* ── Add button ─────────────────────────────────────────────────── */}
      {!showForm && loaded && (
        <div className="pt-3">
          <button
            onClick={handleAddClick}
            className="px-4 py-2 rounded-lg border border-gray-200 dark:border-gray-600 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
          >
            + Add date override
          </button>
        </div>
      )}

      {/* ── Add / Edit form ─────────────────────────────────────────────── */}
      {showForm && (
        <div className="mt-4 space-y-3 border-t border-gray-100 dark:border-gray-800 pt-4">
          <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {editingDate ? "Edit override" : "Add date override"}
          </p>

          {/* Date */}
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500 dark:text-gray-400">Date</label>
            <input
              type="date"
              value={formDate}
              min={todayISO}
              disabled={!!editingDate} // date is immutable when editing
              onChange={(e) => setFormDate(e.target.value)}
              className="border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-1.5 text-sm text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-800 focus:outline-none focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-500 disabled:opacity-50 disabled:cursor-not-allowed w-full max-w-xs"
            />
            {editingDate && (
              <p className="text-xs text-gray-400 dark:text-gray-500">
                To use a different date, delete this override and add a new one.
              </p>
            )}
          </div>

          {/* Closed all day toggle */}
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={formIsClosed}
              onChange={(e) => setFormIsClosed(e.target.checked)}
              className="accent-gray-700 dark:accent-gray-300"
            />
            <span className="text-sm text-gray-700 dark:text-gray-300">
              Closed all day
            </span>
          </label>

          {/* Special hours — shown only when not closed */}
          <div
            className={`flex items-center gap-2 transition-opacity${
              formIsClosed ? " opacity-40 pointer-events-none" : ""
            }`}
          >
            <input
              type="time"
              value={formOpensAt}
              disabled={formIsClosed}
              onChange={(e) => setFormOpensAt(e.target.value)}
              className="border border-gray-200 dark:border-gray-600 rounded-lg px-2 py-1.5 text-sm text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-800 focus:outline-none focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-500"
            />
            <span className="text-xs text-gray-400 dark:text-gray-500 select-none">to</span>
            <input
              type="time"
              value={formClosesAt}
              disabled={formIsClosed}
              onChange={(e) => setFormClosesAt(e.target.value)}
              className="border border-gray-200 dark:border-gray-600 rounded-lg px-2 py-1.5 text-sm text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-800 focus:outline-none focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-500"
            />
          </div>

          {/* Note */}
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500 dark:text-gray-400">
              Note <span className="font-normal">(optional)</span>
            </label>
            <input
              type="text"
              value={formNote}
              maxLength={80}
              placeholder="e.g. Thanksgiving, Private event"
              onChange={(e) => setFormNote(e.target.value)}
              className="border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-1.5 text-sm text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-800 focus:outline-none focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-500 w-full max-w-sm"
            />
          </div>

          {/* Inline errors */}
          {validationError && (
            <p className="text-xs text-red-600 dark:text-red-400">{validationError}</p>
          )}
          {rpcError && (
            <p className="text-xs text-red-600 dark:text-red-400">{rpcError}</p>
          )}

          {/* Form actions */}
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <button
              type="button"
              disabled={isPending}
              onClick={handleSave}
              className="px-4 py-2 rounded-lg bg-accent text-white dark:text-gray-900 text-sm font-medium disabled:opacity-40"
            >
              {isPending ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              disabled={isPending}
              onClick={resetForm}
              className="px-4 py-2 rounded-lg border border-gray-200 dark:border-gray-600 text-sm font-medium text-gray-700 dark:text-gray-300 disabled:opacity-40"
            >
              Cancel
            </button>
            {saved && (
              <p className="text-xs font-medium text-green-600 dark:text-green-400">Saved</p>
            )}
          </div>
        </div>
      )}

      {/* ── Conflict confirmation dialog ──────────────────────────────── */}
      {confirmAffected !== null && (
        <>
          <div
            className="fixed inset-0 bg-black/30 z-40"
            onClick={() => { if (!isPending) setConfirmAffected(null); }}
          />
          <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
            <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl w-full max-w-sm px-6 py-6">
              <p className="text-base font-semibold text-gray-900 dark:text-gray-100">
                Save date override?
              </p>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">
                This override affects{" "}
                <span className="font-medium text-gray-800 dark:text-gray-200">
                  {confirmAffected}{" "}
                  {confirmAffected === 1 ? "reservation" : "reservations"}
                </span>{" "}
                on this date.
              </p>
              <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                Existing reservations will not be cancelled or modified.
                You may want to contact affected members.
              </p>
              {rpcError && (
                <p className="mt-2 text-sm text-red-600 dark:text-red-400">{rpcError}</p>
              )}
              <div className="mt-5 flex gap-3">
                <button
                  disabled={isPending}
                  onClick={() => { if (!isPending) setConfirmAffected(null); }}
                  className="flex-1 py-2.5 rounded-xl border border-gray-200 dark:border-gray-600 text-sm font-medium text-gray-700 dark:text-gray-300 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  disabled={isPending}
                  onClick={handleConfirmSave}
                  className="flex-1 py-2.5 rounded-xl bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-medium disabled:opacity-50"
                >
                  {isPending ? "Saving…" : "Save anyway"}
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* ── Delete confirmation dialog ────────────────────────────────── */}
      {confirmDeleteDate !== null && (
        <>
          <div
            className="fixed inset-0 bg-black/30 z-40"
            onClick={() => { if (!isPending) { setConfirmDeleteDate(null); setDeleteError(null); } }}
          />
          <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
            <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl w-full max-w-sm px-6 py-6">
              <p className="text-base font-semibold text-gray-900 dark:text-gray-100">
                Delete override?
              </p>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">
                <span className="font-medium text-gray-800 dark:text-gray-200">
                  {formatDate(confirmDeleteDate)}
                </span>{" "}
                will revert to normal weekly operating hours.
              </p>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Existing reservations on this date will not be affected.
              </p>
              {deleteError && (
                <p className="mt-2 text-sm text-red-600 dark:text-red-400">{deleteError}</p>
              )}
              <div className="mt-5 flex gap-3">
                <button
                  disabled={isPending}
                  onClick={() => { if (!isPending) { setConfirmDeleteDate(null); setDeleteError(null); } }}
                  className="flex-1 py-2.5 rounded-xl border border-gray-200 dark:border-gray-600 text-sm font-medium text-gray-700 dark:text-gray-300 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  disabled={isPending}
                  onClick={handleDeleteConfirm}
                  className="flex-1 py-2.5 rounded-xl bg-red-600 text-white text-sm font-medium disabled:opacity-50"
                >
                  {isPending ? "Deleting…" : "Delete"}
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}
