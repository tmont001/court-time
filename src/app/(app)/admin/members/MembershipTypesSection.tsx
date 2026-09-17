"use client";

// Phase 42C-3B — Membership Types management. Interaction vocabulary
// deliberately copied from CourtManagementList (admin/courts) — Add/
// Rename inline-input-then-Save/Cancel, one compact action-button row per
// item — the established precedent for this exact "small list of
// club-configurable named things" shape in this codebase. No reorder, no
// per-item rate, and critically no Delete: 0188's membership_types RPCs
// expose only create/rename/activate-deactivate (soft lifecycle), matching
// the locked domain rule that a Membership Type is never hard-deleted.

import { useState, useTransition, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  createMembershipTypeAction,
  updateMembershipTypeAction,
  setMembershipTypeActiveAction,
} from "@/app/(app)/admin/settings/actions";
import {
  ACTION_BUTTON_SECONDARY_COMPACT,
  ACTION_BUTTON_POSITIVE_COMPACT,
  ACTION_BUTTON_WARNING_COMPACT,
} from "@/components/styles/actionButtonStyles";

export type MembershipType = {
  id:        string;
  name:      string;
  is_active: boolean;
};

type Status = {
  type: "success" | "error";
  message: string;
};

interface Props {
  initialTypes: MembershipType[];
}

export default function MembershipTypesSection({ initialTypes }: Props) {
  const router = useRouter();
  const [types, setTypes] = useState<MembershipType[]>(initialTypes);
  const [isPending, startTransition] = useTransition();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [isAddingType, setIsAddingType] = useState(false);
  const [addValue, setAddValue] = useState("");
  const [status, setStatus] = useState<Status | null>(null);

  // Sync local list when the server component re-renders after router.refresh().
  useEffect(() => {
    setTypes(initialTypes);
  }, [initialTypes]);

  function showStatus(s: Status) {
    setStatus(s);
    if (s.type === "success") {
      setTimeout(() => setStatus(null), 2500);
    }
  }

  // ── Rename ──────────────────────────────────────────────────────────────

  function handleRenameStart(type: MembershipType) {
    setStatus(null);
    setRenamingId(type.id);
    setRenameValue(type.name);
  }

  function handleRenameCancel() {
    setRenamingId(null);
    setRenameValue("");
  }

  function handleRenameSubmit(id: string) {
    const trimmed = renameValue.trim();
    if (!trimmed) return;
    setStatus(null);
    setPendingId(id);
    startTransition(async () => {
      const result = await updateMembershipTypeAction(id, trimmed);
      setPendingId(null);
      if (result.error) {
        showStatus({ type: "error", message: result.error });
      } else {
        setRenamingId(null);
        showStatus({ type: "success", message: "Membership Type renamed." });
        router.refresh();
      }
    });
  }

  // ── Activate / Deactivate ─────────────────────────────────────────────────

  function handleSetActive(type: MembershipType, isActive: boolean) {
    setStatus(null);
    setPendingId(type.id);
    startTransition(async () => {
      const result = await setMembershipTypeActiveAction(type.id, isActive);
      setPendingId(null);
      if (result.error) {
        showStatus({ type: "error", message: result.error });
      } else {
        showStatus({
          type: "success",
          message: isActive ? "Membership Type reactivated." : "Membership Type deactivated.",
        });
        router.refresh();
      }
    });
  }

  // ── Add ─────────────────────────────────────────────────────────────────

  function handleAddSubmit() {
    const trimmed = addValue.trim();
    if (!trimmed) return;
    setStatus(null);
    setPendingId("__new__");
    startTransition(async () => {
      const result = await createMembershipTypeAction(trimmed);
      setPendingId(null);
      if (result.error) {
        showStatus({ type: "error", message: result.error });
      } else {
        setIsAddingType(false);
        setAddValue("");
        showStatus({ type: "success", message: "Membership Type added." });
        router.refresh();
      }
    });
  }

  function handleAddCancel() {
    setIsAddingType(false);
    setAddValue("");
    setStatus(null);
  }

  const anyPending = isPending && pendingId !== null;

  return (
    <div className="space-y-3">
      {status && (
        <div className={`px-3 py-2 rounded-lg text-xs font-medium ${
          status.type === "success"
            ? "bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-400"
            : "bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400"
        }`}>
          {status.message}
        </div>
      )}

      {types.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          No Membership Types yet. Add one below.
        </p>
      ) : (
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-700 overflow-hidden">
          {types.map((type) => (
            <div key={type.id} className="bg-white dark:bg-gray-800">
              {renamingId === type.id ? (
                /* ── Rename row ── */
                <div className="flex items-center gap-2 px-4 py-3">
                  <input
                    autoFocus
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleRenameSubmit(type.id);
                      if (e.key === "Escape") handleRenameCancel();
                    }}
                    maxLength={100}
                    className="flex-1 min-w-0 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-1.5 text-base md:text-sm text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent motion-safe:transition-all motion-safe:duration-150"
                  />
                  <button
                    onClick={() => handleRenameSubmit(type.id)}
                    disabled={isPending && pendingId === type.id}
                    className={ACTION_BUTTON_POSITIVE_COMPACT}
                  >
                    {isPending && pendingId === type.id ? "Saving…" : "Save"}
                  </button>
                  <button
                    onClick={handleRenameCancel}
                    className={ACTION_BUTTON_SECONDARY_COMPACT}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                /* ── Normal row ── same mobile-first stacking as
                    CourtManagementList's normal row: name+badge and action
                    buttons each get their own full-width row below sm,
                    single row at sm+. */
                <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-2 min-w-0 flex-wrap">
                    <span className="text-sm text-gray-900 dark:text-gray-100 truncate">
                      {type.name}
                    </span>
                    <span className={`flex-shrink-0 inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${
                      type.is_active
                        ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400"
                        : "bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400"
                    }`}>
                      {type.is_active ? "Active" : "Inactive"}
                    </span>
                  </div>

                  <div className="flex items-center gap-1.5 flex-wrap sm:flex-nowrap sm:flex-shrink-0">
                    <button
                      onClick={() => handleRenameStart(type)}
                      disabled={anyPending}
                      className={ACTION_BUTTON_SECONDARY_COMPACT}
                    >
                      Rename
                    </button>
                    <button
                      onClick={() => handleSetActive(type, !type.is_active)}
                      disabled={isPending && pendingId === type.id}
                      className={type.is_active ? ACTION_BUTTON_WARNING_COMPACT : ACTION_BUTTON_POSITIVE_COMPACT}
                    >
                      {isPending && pendingId === type.id
                        ? "…"
                        : type.is_active
                        ? "Deactivate"
                        : "Reactivate"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Add Membership Type */}
      {isAddingType ? (
        <div className="flex items-center gap-2">
          <input
            autoFocus
            value={addValue}
            onChange={(e) => setAddValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAddSubmit();
              if (e.key === "Escape") handleAddCancel();
            }}
            placeholder="Membership Type name"
            maxLength={100}
            className="flex-1 min-w-0 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 text-base md:text-sm text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-800 focus:outline-none focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-500"
          />
          <button
            onClick={handleAddSubmit}
            disabled={isPending && pendingId === "__new__"}
            className="px-4 py-2 rounded-lg bg-accent text-white dark:text-gray-900 text-sm font-medium disabled:opacity-40"
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
          onClick={() => { setIsAddingType(true); setStatus(null); }}
          disabled={anyPending}
          className="w-full px-4 py-3 rounded-xl border border-dashed border-gray-300 dark:border-gray-600 text-sm text-gray-500 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-500 hover:text-gray-700 dark:hover:text-gray-300 disabled:opacity-40 transition-colors"
        >
          + Add Membership Type
        </button>
      )}
    </div>
  );
}
