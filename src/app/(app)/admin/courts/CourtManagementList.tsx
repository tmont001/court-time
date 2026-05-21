"use client";

import { useState, useTransition, useEffect } from "react";
import { useRouter } from "next/navigation";
import { addCourt, renameCourt, reorderCourts, setCourtActive } from "./actions";

type Court = {
  id: string;
  name: string;
  display_order: number;
  is_active: boolean;
};

type Status = {
  type: "success" | "error" | "warning";
  message: string;
};

interface Props {
  initialCourts: Court[];
}

export default function CourtManagementList({ initialCourts }: Props) {
  const router = useRouter();
  const [courts, setCourts] = useState<Court[]>(initialCourts);
  const [isPending, startTransition] = useTransition();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [isAddingCourt, setIsAddingCourt] = useState(false);
  const [addValue, setAddValue] = useState("");
  const [status, setStatus] = useState<Status | null>(null);

  // Sync local list when the server component re-renders after router.refresh().
  useEffect(() => {
    setCourts(initialCourts);
  }, [initialCourts]);

  function showStatus(s: Status) {
    setStatus(s);
    if (s.type === "success") {
      setTimeout(() => setStatus(null), 2500);
    }
    // errors and warnings persist until the next action clears them
  }

  // ── Reorder ──────────────────────────────────────────────────────────────

  function handleMove(idx: number, direction: "up" | "down") {
    const swapIdx = direction === "up" ? idx - 1 : idx + 1;
    const updated = [...courts];
    [updated[idx], updated[swapIdx]] = [updated[swapIdx], updated[idx]];
    const prev = courts;
    setCourts(updated); // optimistic
    startTransition(async () => {
      const result = await reorderCourts(updated.map((c) => c.id));
      if (result.error) {
        setCourts(prev); // revert
        showStatus({ type: "error", message: result.error });
      } else {
        router.refresh();
      }
    });
  }

  // ── Rename ────────────────────────────────────────────────────────────────

  function handleRenameStart(court: Court) {
    setStatus(null);
    setRenamingId(court.id);
    setRenameValue(court.name);
  }

  function handleRenameCancel() {
    setRenamingId(null);
    setRenameValue("");
  }

  function handleRenameSubmit(courtId: string) {
    const trimmed = renameValue.trim();
    if (!trimmed) return;
    setStatus(null);
    setPendingId(courtId);
    startTransition(async () => {
      const result = await renameCourt(courtId, trimmed);
      setPendingId(null);
      if (result.error) {
        showStatus({ type: "error", message: result.error });
      } else {
        setRenamingId(null);
        showStatus({ type: "success", message: "Court renamed." });
        router.refresh();
      }
    });
  }

  // ── Activate / Deactivate ─────────────────────────────────────────────────

  function handleSetActive(court: Court, isActive: boolean) {
    setStatus(null);
    setPendingId(court.id);
    startTransition(async () => {
      const result = await setCourtActive(court.id, isActive);
      setPendingId(null);
      if (result.error === "court_has_future_reservations") {
        const n = result.futureCount ?? 0;
        showStatus({
          type: "warning",
          message: `${court.name} has ${n} upcoming reservation${n === 1 ? "" : "s"}. Cancel them before deactivating.`,
        });
      } else if (result.error) {
        showStatus({ type: "error", message: result.error });
      } else {
        showStatus({
          type: "success",
          message: isActive ? "Court activated." : "Court deactivated.",
        });
        router.refresh();
      }
    });
  }

  // ── Add Court ─────────────────────────────────────────────────────────────

  function handleAddSubmit() {
    const trimmed = addValue.trim();
    if (!trimmed) return;
    setStatus(null);
    setPendingId("__new__");
    startTransition(async () => {
      const result = await addCourt(trimmed);
      setPendingId(null);
      if (result.error) {
        showStatus({ type: "error", message: result.error });
      } else {
        setIsAddingCourt(false);
        setAddValue("");
        showStatus({ type: "success", message: "Court added." });
        router.refresh();
      }
    });
  }

  function handleAddCancel() {
    setIsAddingCourt(false);
    setAddValue("");
    setStatus(null);
  }

  const anyPending = isPending && pendingId !== null;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">

      {/* Status banner */}
      {status && (
        <div className={`px-3 py-2 rounded-lg text-xs font-medium ${
          status.type === "success"
            ? "bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-400"
            : status.type === "warning"
            ? "bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
            : "bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400"
        }`}>
          {status.message}
        </div>
      )}

      {/* Court list */}
      {courts.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">No courts yet. Add one below.</p>
      ) : (
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-700 overflow-hidden">
          {courts.map((court, idx) => (
            <div key={court.id} className="bg-white dark:bg-gray-800">

              {renamingId === court.id ? (
                /* ── Rename row ── */
                <div className="flex items-center gap-2 px-4 py-3">
                  <input
                    autoFocus
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleRenameSubmit(court.id);
                      if (e.key === "Escape") handleRenameCancel();
                    }}
                    maxLength={60}
                    className="flex-1 min-w-0 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-1.5 text-sm text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-700 focus:outline-none focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-500"
                  />
                  <button
                    onClick={() => handleRenameSubmit(court.id)}
                    disabled={isPending && pendingId === court.id}
                    className="text-xs font-medium text-green-600 dark:text-green-400 disabled:opacity-40"
                  >
                    {isPending && pendingId === court.id ? "Saving…" : "Save"}
                  </button>
                  <button
                    onClick={handleRenameCancel}
                    className="text-xs font-medium text-gray-500 dark:text-gray-400"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                /* ── Normal row ── */
                <div className="flex items-center justify-between gap-2 px-4 py-3">
                  {/* Left: name + badge */}
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm text-gray-900 dark:text-gray-100 truncate">
                      {court.name}
                    </span>
                    <span className={`flex-shrink-0 inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${
                      court.is_active
                        ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400"
                        : "bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400"
                    }`}>
                      {court.is_active ? "Active" : "Inactive"}
                    </span>
                  </div>

                  {/* Right: action buttons */}
                  <div className="flex items-center gap-1 flex-shrink-0 text-xs font-medium">
                    <button
                      onClick={() => handleMove(idx, "up")}
                      disabled={idx === 0 || anyPending}
                      className="p-1 text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 disabled:opacity-30"
                      aria-label="Move up"
                    >
                      ↑
                    </button>
                    <button
                      onClick={() => handleMove(idx, "down")}
                      disabled={idx === courts.length - 1 || anyPending}
                      className="p-1 text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 disabled:opacity-30"
                      aria-label="Move down"
                    >
                      ↓
                    </button>

                    <span className="mx-0.5 text-gray-200 dark:text-gray-700 select-none">|</span>

                    <button
                      onClick={() => handleRenameStart(court)}
                      disabled={anyPending}
                      className="px-1 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 disabled:opacity-30"
                    >
                      Rename
                    </button>

                    <span className="mx-0.5 text-gray-200 dark:text-gray-700 select-none">|</span>

                    <button
                      onClick={() => handleSetActive(court, !court.is_active)}
                      disabled={isPending && pendingId === court.id}
                      className={`px-1 disabled:opacity-40 ${
                        court.is_active
                          ? "text-red-500 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300"
                          : "text-green-600 dark:text-green-400 hover:text-green-800 dark:hover:text-green-300"
                      }`}
                    >
                      {isPending && pendingId === court.id
                        ? "…"
                        : court.is_active
                        ? "Deactivate"
                        : "Activate"}
                    </button>
                  </div>
                </div>
              )}

            </div>
          ))}
        </div>
      )}

      {/* Add Court */}
      {isAddingCourt ? (
        <div className="flex items-center gap-2">
          <input
            autoFocus
            value={addValue}
            onChange={(e) => setAddValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAddSubmit();
              if (e.key === "Escape") handleAddCancel();
            }}
            placeholder="Court name"
            maxLength={60}
            className="flex-1 min-w-0 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-800 focus:outline-none focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-500"
          />
          <button
            onClick={handleAddSubmit}
            disabled={isPending && pendingId === "__new__"}
            className="px-4 py-2 rounded-lg bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900 text-sm font-medium disabled:opacity-40"
          >
            {isPending && pendingId === "__new__" ? "Adding…" : "Add"}
          </button>
          <button
            onClick={handleAddCancel}
            className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          onClick={() => { setIsAddingCourt(true); setStatus(null); }}
          disabled={anyPending}
          className="w-full px-4 py-3 rounded-xl border border-dashed border-gray-300 dark:border-gray-600 text-sm text-gray-500 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-500 hover:text-gray-700 dark:hover:text-gray-300 disabled:opacity-40 transition-colors"
        >
          + Add Court
        </button>
      )}

    </div>
  );
}
