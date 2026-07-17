"use client";

import { useState, useTransition, useCallback, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  createEventType,
  updateEventType,
  setEventTypeActive,
  deleteEventType,
} from "./actions";

// ── Constants ─────────────────────────────────────────────────────────────────

const PRESET_COLORS: { name: string; hex: string }[] = [
  { name: "Blue",   hex: "#3B7DD8" },
  { name: "Green",  hex: "#2E9B5E" },
  { name: "Orange", hex: "#E68433" },
  { name: "Purple", hex: "#7B4FB5" },
  { name: "Red",    hex: "#C44545" },
  { name: "Teal",   hex: "#167D83" },
  { name: "Gold",   hex: "#A96808" },
  { name: "Slate",  hex: "#52657A" },
];

const SEEDED_DEFAULTS: Record<string, { label: string; color: string }> = {
  lesson:     { label: "Private Lesson", color: "#3B7DD8" },
  clinic:     { label: "Group Clinic",   color: "#2E9B5E" },
  social:     { label: "Open Social",    color: "#E68433" },
  league:     { label: "League Match",   color: "#7B4FB5" },
  tournament: { label: "Tournament",     color: "#C44545" },
};

const SEEDED_KEYS = new Set(Object.keys(SEEDED_DEFAULTS));

// ── Types ─────────────────────────────────────────────────────────────────────

interface EventType {
  id:        string;
  key:       string;
  label:     string;
  color:     string;
  is_active: boolean;
}

interface Props {
  clubId:       string;
  initialTypes: EventType[];
}

type EditState   = { id: string; label: string; color: string } | null;
type UndoState   = { id: string; label: string; color: string } | null;
type CreateState = { label: string; color: string };

// ── Sub-components ────────────────────────────────────────────────────────────

function ColorSwatchPicker({
  color,
  onChange,
}: {
  color:    string;
  onChange: (hex: string) => void;
}) {
  const inputRef   = useRef<HTMLInputElement>(null);
  const isPreset   = PRESET_COLORS.some(
    p => p.hex.toLowerCase() === color.toLowerCase()
  );
  return (
    <div className="space-y-1.5">
      {/* Eight preset swatches */}
      <div className="flex flex-wrap gap-1.5">
        {PRESET_COLORS.map(preset => (
          <button
            key={preset.hex}
            type="button"
            title={preset.name}
            aria-label={preset.name}
            onClick={() => onChange(preset.hex)}
            className={`h-7 w-7 shrink-0 rounded-full border-2 motion-safe:transition-transform motion-safe:duration-100 ${
              color.toLowerCase() === preset.hex.toLowerCase()
                ? "border-gray-700 dark:border-gray-100 scale-110 shadow-sm"
                : "border-transparent hover:scale-105"
            }`}
            style={{ background: preset.hex }}
          />
        ))}
      </div>
      {/* Custom color — opens native color picker */}
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          aria-label="Custom color"
          onClick={() => inputRef.current?.click()}
          className={`flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs motion-safe:transition-colors motion-safe:duration-100 ${
            !isPreset
              ? "border-gray-700 dark:border-gray-100 bg-gray-50 dark:bg-gray-600/50 font-medium text-gray-900 dark:text-gray-100"
              : "border-gray-200 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-400"
          }`}
        >
          <span
            className="h-3.5 w-3.5 shrink-0 rounded-full border border-gray-200 dark:border-gray-500"
            style={{
              background: !isPreset
                ? color
                : "conic-gradient(red,yellow,lime,aqua,blue,magenta,red)",
            }}
          />
          Custom color
        </button>
        <input
          ref={inputRef}
          type="color"
          value={color}
          onChange={e => onChange(e.target.value)}
          className="sr-only"
          aria-hidden="true"
          tabIndex={-1}
        />
      </div>
    </div>
  );
}

function BadgePreview({ label, color }: { label: string; color: string }) {
  return (
    <span
      className="inline-block rounded-full px-2.5 py-0.5 text-[10px] font-semibold text-white shrink-0"
      style={{ background: color || "#3B7DD8" }}
    >
      {label.trim() || "Preview"}
    </span>
  );
}

// ── EventTypesSection ─────────────────────────────────────────────────────────

export default function EventTypesSection({ clubId, initialTypes }: Props) {
  const [types,           setTypes]           = useState<EventType[]>(initialTypes);
  const [edit,            setEdit]            = useState<EditState>(null);
  const [creating,        setCreating]        = useState(false);
  const [newType,         setNewType]         = useState<CreateState>({ label: "", color: "#3B7DD8" });
  const [isPending,       startTransition]    = useTransition();
  const [rowError,        setRowError]        = useState<Record<string, string>>({});
  const [globalError,     setGlobalError]     = useState<string | null>(null);
  const [pendingDeactivate, setPendingDeactivate] = useState<string | null>(null);
  const [undoState,         setUndoState]         = useState<UndoState>(null);
  const [undoError,         setUndoError]         = useState<string | null>(null);
  const [confirmingRestore, setConfirmingRestore] = useState<string | null>(null);
  const [confirmingDelete,  setConfirmingDelete]  = useState<string | null>(null);

  // ── Reload ─────────────────────────────────────────────────────────────────

  const reload = useCallback(async (): Promise<boolean> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("event_types")
      .select("id, key, label, color, is_active")
      .eq("club_id", clubId)
      .order("is_active", { ascending: false })
      .order("label");
    if (error || !data) return false;
    setTypes(data as EventType[]);
    return true;
  }, [clubId]);

  // ── Edit ───────────────────────────────────────────────────────────────────

  function startEdit(et: EventType) {
    setEdit({ id: et.id, label: et.label, color: et.color });
    setPendingDeactivate(null);
    setConfirmingRestore(null);
    setConfirmingDelete(null);
    setRowError({});
    setUndoError(null);
  }

  function cancelEdit() {
    setEdit(null);
    setRowError({});
  }

  function handleSaveEdit() {
    if (!edit) return;
    const label = edit.label.trim();
    if (!label) {
      setRowError(prev => ({ ...prev, [edit.id]: "Label cannot be blank." }));
      return;
    }
    const currentType = types.find(t => t.id === edit.id);
    const prevLabel   = currentType?.label ?? "";
    const prevColor   = currentType?.color ?? "#3B7DD8";

    startTransition(async () => {
      const result = await updateEventType(edit.id, label, edit.color);
      if (result.error) {
        setRowError(prev => ({ ...prev, [edit.id]: result.error! }));
        return;
      }
      const savedId = edit.id;
      setEdit(null);
      setRowError({});
      setUndoState({ id: savedId, label: prevLabel, color: prevColor });
      setUndoError(null);
      const ok = await reload();
      if (!ok) {
        setGlobalError("Saved, but the list could not refresh. Please reload the page.");
      }
    });
  }

  // ── Undo ───────────────────────────────────────────────────────────────────

  function handleUndo(id: string) {
    if (!undoState || undoState.id !== id) return;
    const { label, color } = undoState;
    setUndoError(null);
    startTransition(async () => {
      const result = await updateEventType(id, label, color);
      if (result.error) {
        setUndoError(result.error);
        return;
      }
      setUndoState(null);
      const ok = await reload();
      if (!ok) {
        setGlobalError("Restored, but the list could not refresh. Please reload the page.");
      }
    });
  }

  // ── Restore default ────────────────────────────────────────────────────────

  function requestRestore(id: string) {
    setConfirmingRestore(id);
    setEdit(null);
    setPendingDeactivate(null);
    setConfirmingDelete(null);
    setRowError({});
    setUndoError(null);
  }

  function cancelRestore() { setConfirmingRestore(null); }

  function confirmRestore(et: EventType) {
    const defaults = SEEDED_DEFAULTS[et.key];
    if (!defaults) return;
    const prevLabel = et.label;
    const prevColor = et.color;
    setConfirmingRestore(null);
    startTransition(async () => {
      const result = await updateEventType(et.id, defaults.label, defaults.color);
      if (result.error) {
        setRowError(prev => ({ ...prev, [et.id]: result.error! }));
        return;
      }
      setUndoState({ id: et.id, label: prevLabel, color: prevColor });
      setUndoError(null);
      const ok = await reload();
      if (!ok) {
        setGlobalError("Saved, but the list could not refresh. Please reload the page.");
      }
    });
  }

  // ── Deactivation ───────────────────────────────────────────────────────────

  function requestDeactivate(id: string) {
    setPendingDeactivate(id);
    setEdit(null);
    setConfirmingRestore(null);
    setConfirmingDelete(null);
    setRowError({});
    setUndoError(null);
  }

  function cancelDeactivate() { setPendingDeactivate(null); }

  function confirmDeactivate(id: string) {
    setPendingDeactivate(null);
    startTransition(async () => {
      const result = await setEventTypeActive(id, false);
      if (result.error) {
        setRowError(prev => ({ ...prev, [id]: result.error! }));
        return;
      }
      if (undoState?.id === id) setUndoState(null);
      const ok = await reload();
      if (!ok) {
        setGlobalError("Saved, but the list could not refresh. Please reload the page.");
      }
    });
  }

  // ── Reactivation ───────────────────────────────────────────────────────────

  function handleReactivate(id: string) {
    startTransition(async () => {
      const result = await setEventTypeActive(id, true);
      if (result.error) {
        setRowError(prev => ({ ...prev, [id]: result.error! }));
        return;
      }
      const ok = await reload();
      if (!ok) {
        setGlobalError("Saved, but the list could not refresh. Please reload the page.");
      }
    });
  }

  // ── Delete ─────────────────────────────────────────────────────────────────

  function requestDelete(id: string) {
    setConfirmingDelete(id);
    setEdit(null);
    setPendingDeactivate(null);
    setConfirmingRestore(null);
    setRowError({});
    setUndoError(null);
  }

  function cancelDelete() { setConfirmingDelete(null); }

  function handleDelete(id: string) {
    setConfirmingDelete(null);
    startTransition(async () => {
      const result = await deleteEventType(id);
      if (result.error) {
        setRowError(prev => ({ ...prev, [id]: result.error! }));
        return;
      }
      if (undoState?.id === id) setUndoState(null);
      const ok = await reload();
      if (!ok) {
        setGlobalError("Deleted, but the list could not refresh. Please reload the page.");
      }
    });
  }

  // ── Create ─────────────────────────────────────────────────────────────────

  function handleCreate() {
    const label = newType.label.trim();
    if (!label) { setGlobalError("Label cannot be blank."); return; }
    setGlobalError(null);
    startTransition(async () => {
      const result = await createEventType(label, newType.color);
      if (result.error) { setGlobalError(result.error); return; }
      setCreating(false);
      setNewType({ label: "", color: "#3B7DD8" });
      const ok = await reload();
      if (!ok) {
        setGlobalError("Created, but the list could not refresh. Please reload the page.");
      }
    });
  }

  const active   = types.filter(t => t.is_active);
  const inactive = types.filter(t => !t.is_active);

  return (
    <div className="space-y-3">
      {globalError && (
        <p className="text-xs text-red-500">{globalError}</p>
      )}

      {/* Active types */}
      <div className="space-y-2">
        {active.map(et => (
          <EventTypeRow
            key={et.id}
            et={et}
            edit={edit?.id === et.id ? edit : null}
            error={rowError[et.id]}
            undoState={undoState?.id === et.id ? undoState : null}
            undoError={undoState?.id === et.id ? undoError : null}
            isPendingDeactivate={pendingDeactivate === et.id}
            isConfirmingRestore={confirmingRestore === et.id}
            isConfirmingDelete={false}
            isPending={isPending}
            onStartEdit={() => startEdit(et)}
            onCancelEdit={cancelEdit}
            onSaveEdit={handleSaveEdit}
            onEditChange={patch => setEdit(prev => prev ? { ...prev, ...patch } : null)}
            onUndo={() => handleUndo(et.id)}
            onRequestDeactivate={() => requestDeactivate(et.id)}
            onCancelDeactivate={cancelDeactivate}
            onConfirmDeactivate={() => confirmDeactivate(et.id)}
            onReactivate={() => {}}
            onRequestRestore={() => requestRestore(et.id)}
            onCancelRestore={cancelRestore}
            onConfirmRestore={() => confirmRestore(et)}
            onRequestDelete={() => {}}
            onCancelDelete={cancelDelete}
            onConfirmDelete={() => {}}
          />
        ))}
        {active.length === 0 && (
          <p className="text-xs text-gray-400 dark:text-gray-500">No active event types.</p>
        )}
      </div>

      {/* Inactive types */}
      {inactive.length > 0 && (
        <div className="space-y-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 pt-1">
            Inactive
          </p>
          {inactive.map(et => (
            <EventTypeRow
              key={et.id}
              et={et}
              edit={edit?.id === et.id ? edit : null}
              error={rowError[et.id]}
              undoState={undoState?.id === et.id ? undoState : null}
              undoError={undoState?.id === et.id ? undoError : null}
              isPendingDeactivate={false}
              isConfirmingRestore={confirmingRestore === et.id}
              isConfirmingDelete={confirmingDelete === et.id}
              isPending={isPending}
              onStartEdit={() => startEdit(et)}
              onCancelEdit={cancelEdit}
              onSaveEdit={handleSaveEdit}
              onEditChange={patch => setEdit(prev => prev ? { ...prev, ...patch } : null)}
              onUndo={() => handleUndo(et.id)}
              onRequestDeactivate={() => {}}
              onCancelDeactivate={cancelDeactivate}
              onConfirmDeactivate={() => {}}
              onReactivate={() => handleReactivate(et.id)}
              onRequestRestore={() => requestRestore(et.id)}
              onCancelRestore={cancelRestore}
              onConfirmRestore={() => confirmRestore(et)}
              onRequestDelete={() => requestDelete(et.id)}
              onCancelDelete={cancelDelete}
              onConfirmDelete={() => handleDelete(et.id)}
            />
          ))}
        </div>
      )}

      {/* Create new type */}
      {creating ? (
        <div className="rounded-xl border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 px-4 py-3 space-y-3">
          <div className="flex items-center gap-2">
            <BadgePreview label={newType.label} color={newType.color} />
          </div>
          <p className="text-xs font-semibold text-gray-700 dark:text-gray-200">New event type</p>
          <input
            type="text"
            placeholder="Label (e.g. Round Robin)"
            value={newType.label}
            onChange={e => {
              setNewType(prev => ({ ...prev, label: e.target.value }));
              setGlobalError(null);
            }}
            maxLength={80}
            autoFocus
            className="w-full rounded-xl border border-gray-200 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent motion-safe:transition-all motion-safe:duration-150"
          />
          <ColorSwatchPicker
            color={newType.color}
            onChange={hex => setNewType(prev => ({ ...prev, color: hex }))}
          />
          <div className="flex gap-2 items-center">
            <button
              type="button"
              onClick={handleCreate}
              disabled={isPending}
              className="ct-button-primary text-xs"
            >
              {isPending ? "Creating…" : "Create"}
            </button>
            <button
              type="button"
              onClick={() => { setCreating(false); setGlobalError(null); }}
              className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 motion-safe:transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => {
            setCreating(true);
            setEdit(null);
            setPendingDeactivate(null);
            setConfirmingRestore(null);
            setConfirmingDelete(null);
          }}
          className="text-xs font-medium text-accent hover:underline motion-safe:transition-colors"
        >
          + Add event type
        </button>
      )}
    </div>
  );
}

// ── EventTypeRow ──────────────────────────────────────────────────────────────

interface RowProps {
  et:                   EventType;
  edit:                 EditState;
  error:                string | undefined;
  undoState:            { label: string; color: string } | null;
  undoError:            string | null;
  isPendingDeactivate:  boolean;
  isConfirmingRestore:  boolean;
  isConfirmingDelete:   boolean;
  isPending:            boolean;
  onStartEdit:          () => void;
  onCancelEdit:         () => void;
  onSaveEdit:           () => void;
  onEditChange:         (patch: Partial<{ label: string; color: string }>) => void;
  onUndo:               () => void;
  onRequestDeactivate:  () => void;
  onCancelDeactivate:   () => void;
  onConfirmDeactivate:  () => void;
  onReactivate:         () => void;
  onRequestRestore:     () => void;
  onCancelRestore:      () => void;
  onConfirmRestore:     () => void;
  onRequestDelete:      () => void;
  onCancelDelete:       () => void;
  onConfirmDelete:      () => void;
}

function EventTypeRow({
  et, edit, error, undoState, undoError,
  isPendingDeactivate, isConfirmingRestore, isConfirmingDelete,
  isPending,
  onStartEdit, onCancelEdit, onSaveEdit, onEditChange, onUndo,
  onRequestDeactivate, onCancelDeactivate, onConfirmDeactivate, onReactivate,
  onRequestRestore, onCancelRestore, onConfirmRestore,
  onRequestDelete, onCancelDelete, onConfirmDelete,
}: RowProps) {
  const isEditing   = !!edit;
  const defaults    = SEEDED_DEFAULTS[et.key];
  const isSeeded    = SEEDED_KEYS.has(et.key);
  const matchesDef  = defaults
    ? et.label === defaults.label &&
      et.color.toLowerCase() === defaults.color.toLowerCase()
    : true;
  const canRestore  = isSeeded && !matchesDef;
  const canDelete   = !et.is_active && !isSeeded;

  return (
    <div
      className={`rounded-xl border px-4 py-3 ${
        et.is_active
          ? "border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700"
          : "border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 opacity-60"
      }`}
      style={{ borderLeftWidth: 4, borderLeftColor: isEditing ? edit!.color : et.color }}
    >
      {isEditing ? (
        /* ── Edit mode ── */
        <div className="space-y-2.5">
          <div className="flex items-center gap-2">
            <BadgePreview label={edit!.label} color={edit!.color} />
          </div>
          <input
            type="text"
            value={edit!.label}
            onChange={e => onEditChange({ label: e.target.value })}
            maxLength={80}
            autoFocus
            className="w-full rounded-xl border border-gray-200 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent motion-safe:transition-all motion-safe:duration-150"
          />
          <ColorSwatchPicker
            color={edit!.color}
            onChange={hex => onEditChange({ color: hex })}
          />
          {error && <p className="text-xs text-red-500">{error}</p>}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onSaveEdit}
              disabled={isPending}
              className="ct-button-primary text-xs"
            >
              {isPending ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={onCancelEdit}
              className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 motion-safe:transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : isPendingDeactivate ? (
        /* ── Deactivation confirmation ── */
        <div className="space-y-1">
          <p className="text-xs font-medium text-gray-700 dark:text-gray-300">
            Deactivate &ldquo;{et.label}&rdquo;?
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            This type will be hidden from Create Event. Existing events are unaffected.
          </p>
          <div className="flex items-center gap-3 pt-0.5">
            <button
              type="button"
              onClick={onCancelDeactivate}
              className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 motion-safe:transition-colors motion-safe:duration-100"
            >
              Keep active
            </button>
            <button
              type="button"
              onClick={onConfirmDeactivate}
              disabled={isPending}
              className="text-xs font-semibold text-amber-700 dark:text-amber-400 hover:text-amber-900 dark:hover:text-amber-300 disabled:opacity-40 motion-safe:transition-colors motion-safe:duration-100"
            >
              {isPending ? "Deactivating…" : "Deactivate"}
            </button>
          </div>
        </div>
      ) : isConfirmingRestore ? (
        /* ── Restore default confirmation ── */
        <div className="space-y-1">
          <p className="text-xs font-medium text-gray-700 dark:text-gray-300">
            Restore &ldquo;{et.label}&rdquo; to defaults?
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Label will change to{" "}
            <span className="font-medium">{defaults?.label}</span>{" "}
            and color will reset to{" "}
            <span
              className="inline-block h-3 w-3 rounded-full align-middle"
              style={{ background: defaults?.color }}
            />.
          </p>
          <div className="flex items-center gap-3 pt-0.5">
            <button
              type="button"
              onClick={onCancelRestore}
              className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 motion-safe:transition-colors motion-safe:duration-100"
            >
              Keep current
            </button>
            <button
              type="button"
              onClick={onConfirmRestore}
              disabled={isPending}
              className="text-xs font-semibold text-accent hover:underline disabled:opacity-40 motion-safe:transition-colors motion-safe:duration-100"
            >
              {isPending ? "Restoring…" : "Restore default"}
            </button>
          </div>
        </div>
      ) : isConfirmingDelete ? (
        /* ── Delete confirmation ── */
        <div className="space-y-1">
          <p className="text-xs font-medium text-gray-700 dark:text-gray-300">
            Delete &ldquo;{et.label}&rdquo; permanently?
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            This cannot be undone.
          </p>
          <div className="flex items-center gap-3 pt-0.5">
            <button
              type="button"
              onClick={onCancelDelete}
              className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 motion-safe:transition-colors motion-safe:duration-100"
            >
              Keep
            </button>
            <button
              type="button"
              onClick={onConfirmDelete}
              disabled={isPending}
              className="text-xs font-semibold text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300 disabled:opacity-40 motion-safe:transition-colors motion-safe:duration-100"
            >
              {isPending ? "Deleting…" : "Delete permanently"}
            </button>
          </div>
        </div>
      ) : (
        /* ── Default view ── */
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-3">
            <p className={`text-sm font-medium min-w-0 truncate ${
              et.is_active
                ? "text-gray-900 dark:text-gray-100"
                : "text-gray-400 dark:text-gray-500 line-through"
            }`}>
              {et.label}
            </p>
            <div className="flex items-center gap-3 shrink-0 flex-wrap justify-end">
              <button
                type="button"
                onClick={onStartEdit}
                disabled={isPending}
                className="text-xs text-gray-500 dark:text-gray-400 hover:text-accent disabled:opacity-40 motion-safe:transition-colors"
              >
                Edit
              </button>
              {canRestore && (
                <button
                  type="button"
                  onClick={onRequestRestore}
                  disabled={isPending}
                  className="text-xs text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 disabled:opacity-40 motion-safe:transition-colors"
                >
                  Restore default
                </button>
              )}
              {et.is_active ? (
                <button
                  type="button"
                  onClick={onRequestDeactivate}
                  disabled={isPending}
                  className="text-xs text-gray-400 dark:text-gray-500 hover:text-amber-600 dark:hover:text-amber-400 disabled:opacity-40 motion-safe:transition-colors"
                >
                  Deactivate
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={onReactivate}
                    disabled={isPending}
                    className="text-xs text-accent hover:underline disabled:opacity-40 motion-safe:transition-colors"
                  >
                    Reactivate
                  </button>
                  {canDelete && (
                    <button
                      type="button"
                      onClick={onRequestDelete}
                      disabled={isPending}
                      className="text-xs text-red-500 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 disabled:opacity-40 motion-safe:transition-colors"
                    >
                      Delete
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
          {/* Undo row — shown after a successful label/color save */}
          {undoState && (
            <div className="space-y-0.5">
              <div className="flex items-center gap-2">
                <p className="text-xs text-gray-400 dark:text-gray-500">Saved.</p>
                <button
                  type="button"
                  onClick={onUndo}
                  disabled={isPending}
                  className="text-xs font-medium text-accent hover:underline disabled:opacity-40 motion-safe:transition-colors"
                >
                  Undo
                </button>
              </div>
              {undoError && (
                <p className="text-xs text-red-500">{undoError}</p>
              )}
            </div>
          )}
          {error && (
            <p className="text-xs text-red-500">{error}</p>
          )}
        </div>
      )}
    </div>
  );
}
