"use client";

import { useState, useTransition, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { formatLessonUnitPrice } from "@/lib/money";
import {
  ACTION_BUTTON_SECONDARY_COMPACT,
  ACTION_BUTTON_WARNING_COMPACT,
} from "@/lib/actionButtonStyles";
import { upsertLessonType, archiveLessonType } from "./lessonTypesActions";

type PricingBasis = "flat" | "hourly";

interface LessonType {
  id:                       string;
  name:                     string;
  description:              string | null;
  allowed_durations:        number[] | null;
  max_participants:         number;
  pricing_basis:            PricingBasis;
  unit_price_amount_cents:  number | null;
  rate_notes:               string | null;
  is_active:                boolean;
}

interface Props {
  currency:     string;
  initialTypes: LessonType[];
}

type EditState = {
  id:               string;
  name:             string;
  description:      string;
  allowedDurations: string; // comma-separated minutes, "" = unrestricted
  maxParticipants:  string;
  pricingBasis:     PricingBasis;
  amountDollars:    string; // "" = no price configured
  rateNotes:        string;
} | null;

function emptyForm(): NonNullable<EditState> {
  return {
    id: "",
    name: "",
    description: "",
    allowedDurations: "",
    maxParticipants: "1",
    pricingBasis: "flat",
    amountDollars: "",
    rateNotes: "",
  };
}

function toEditState(lt: LessonType): NonNullable<EditState> {
  return {
    id: lt.id,
    name: lt.name,
    description: lt.description ?? "",
    allowedDurations: lt.allowed_durations?.join(", ") ?? "",
    maxParticipants: String(lt.max_participants),
    pricingBasis: lt.pricing_basis,
    amountDollars: lt.unit_price_amount_cents !== null ? (lt.unit_price_amount_cents / 100).toFixed(2) : "",
    rateNotes: lt.rate_notes ?? "",
  };
}

export default function LessonTypesSection({ currency, initialTypes }: Props) {
  const [types, setTypes] = useState<LessonType[]>(initialTypes);
  const [edit, setEdit] = useState<EditState>(null);
  const [creating, setCreating] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [createError, setCreateError] = useState<string | null>(null);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [confirmingArchive, setConfirmingArchive] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<boolean> => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("get_lesson_types");
    if (error || !data) return false;
    setTypes(data as LessonType[]);
    return true;
  }, []);

  function parseDurations(raw: string): number[] | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    return trimmed
      .split(",")
      .map(s => parseInt(s.trim(), 10))
      .filter(n => !isNaN(n));
  }

  function parseAmount(raw: string): number | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    return Math.round(parseFloat(trimmed) * 100);
  }

  function handleSave(state: NonNullable<EditState>, isCreate: boolean) {
    const name = state.name.trim();
    if (!name) {
      if (isCreate) setCreateError("Name cannot be blank.");
      else setRowError(prev => ({ ...prev, [state.id]: "Name cannot be blank." }));
      return;
    }

    startTransition(async () => {
      const result = await upsertLessonType({
        id: isCreate ? null : state.id,
        name,
        description: state.description.trim() || null,
        allowedDurations: parseDurations(state.allowedDurations),
        maxParticipants: parseInt(state.maxParticipants, 10) || 1,
        pricingBasis: state.pricingBasis,
        unitPriceAmountCents: parseAmount(state.amountDollars),
        rateNotes: state.rateNotes.trim() || null,
      });
      if (result.error) {
        if (isCreate) setCreateError(result.error);
        else setRowError(prev => ({ ...prev, [state.id]: result.error! }));
        return;
      }
      if (isCreate) {
        setCreating(false);
        setCreateError(null);
      } else {
        setEdit(null);
        setRowError({});
      }
      const ok = await reload();
      if (!ok) {
        setGlobalError("Saved, but the list could not refresh. Please reload the page.");
      }
    });
  }

  function handleArchive(id: string) {
    setConfirmingArchive(null);
    startTransition(async () => {
      const result = await archiveLessonType(id);
      if (result.error) {
        setRowError(prev => ({ ...prev, [id]: result.error! }));
        return;
      }
      const ok = await reload();
      if (!ok) {
        setGlobalError("Archived, but the list could not refresh. Please reload the page.");
      }
    });
  }

  return (
    <div className="space-y-3">
      {globalError && <p className="text-xs text-red-500">{globalError}</p>}

      <div className="space-y-2">
        {types.map(lt => {
          const isEditing = edit?.id === lt.id;
          return (
            <div
              key={lt.id}
              className="rounded-xl border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 px-4 py-3"
            >
              {isEditing ? (
                <LessonTypeForm
                  state={edit!}
                  onChange={patch => setEdit(prev => prev ? { ...prev, ...patch } : null)}
                  onSave={() => handleSave(edit!, false)}
                  onCancel={() => { setEdit(null); setRowError({}); }}
                  isPending={isPending}
                  error={rowError[lt.id]}
                  saveLabel="Save"
                />
              ) : confirmingArchive === lt.id ? (
                <div className="space-y-1">
                  <p className="text-xs font-medium text-gray-700 dark:text-gray-300">
                    Archive &ldquo;{lt.name}&rdquo;?
                  </p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    Hidden from new lesson requests. Existing lesson history is unaffected.
                  </p>
                  <div className="flex items-center gap-3 pt-0.5">
                    <button
                      type="button"
                      onClick={() => setConfirmingArchive(null)}
                      className={ACTION_BUTTON_SECONDARY_COMPACT}
                    >
                      Keep
                    </button>
                    <button
                      type="button"
                      onClick={() => handleArchive(lt.id)}
                      disabled={isPending}
                      className={ACTION_BUTTON_WARNING_COMPACT}
                    >
                      {isPending ? "Archiving…" : "Archive"}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100 min-w-0 truncate">
                      {lt.name}
                    </p>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
                        {formatLessonUnitPrice(lt.pricing_basis, lt.unit_price_amount_cents, currency)}
                      </span>
                      <button
                        type="button"
                        onClick={() => { setEdit(toEditState(lt)); setRowError({}); }}
                        disabled={isPending}
                        className={ACTION_BUTTON_SECONDARY_COMPACT}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmingArchive(lt.id)}
                        disabled={isPending}
                        className={ACTION_BUTTON_WARNING_COMPACT}
                      >
                        Archive
                      </button>
                    </div>
                  </div>
                  {lt.allowed_durations && lt.allowed_durations.length > 0 && (
                    <p className="text-xs text-gray-400 dark:text-gray-500">
                      {lt.allowed_durations.join(", ")} min · up to {lt.max_participants} player{lt.max_participants === 1 ? "" : "s"}
                    </p>
                  )}
                  {rowError[lt.id] && <p className="text-xs text-red-500">{rowError[lt.id]}</p>}
                </div>
              )}
            </div>
          );
        })}
        {types.length === 0 && !creating && (
          <p className="text-xs text-gray-400 dark:text-gray-500">No lesson types yet.</p>
        )}
      </div>

      {creating ? (
        <div className="rounded-xl border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 px-4 py-3">
          <p className="text-xs font-semibold text-gray-700 dark:text-gray-200 mb-2">New lesson type</p>
          <LessonTypeForm
            state={edit ?? emptyForm()}
            onChange={patch => setEdit(prev => ({ ...(prev ?? emptyForm()), ...patch }))}
            onSave={() => handleSave(edit ?? emptyForm(), true)}
            onCancel={() => { setCreating(false); setEdit(null); setCreateError(null); }}
            isPending={isPending}
            error={createError ?? undefined}
            saveLabel="Create"
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => { setCreating(true); setEdit(emptyForm()); setCreateError(null); }}
          className={ACTION_BUTTON_SECONDARY_COMPACT}
        >
          + Add lesson type
        </button>
      )}
    </div>
  );
}

function LessonTypeForm({
  state, onChange, onSave, onCancel, isPending, error, saveLabel,
}: {
  state:     NonNullable<EditState>;
  onChange:  (patch: Partial<NonNullable<EditState>>) => void;
  onSave:    () => void;
  onCancel:  () => void;
  isPending: boolean;
  error:     string | undefined;
  saveLabel: string;
}) {
  return (
    <div className="space-y-2.5">
      <input
        type="text"
        placeholder="Name (e.g. Private Lesson)"
        value={state.name}
        onChange={e => onChange({ name: e.target.value })}
        maxLength={100}
        autoFocus
        className="ct-input"
      />
      <input
        type="text"
        placeholder="Description (optional)"
        value={state.description}
        onChange={e => onChange({ description: e.target.value })}
        className="ct-input"
      />
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-[11px] text-gray-400 dark:text-gray-500 mb-0.5">
            Durations (min, comma-separated)
          </label>
          <input
            type="text"
            placeholder="30, 60"
            value={state.allowedDurations}
            onChange={e => onChange({ allowedDurations: e.target.value })}
            className="ct-input"
          />
        </div>
        <div>
          <label className="block text-[11px] text-gray-400 dark:text-gray-500 mb-0.5">
            Maximum players
          </label>
          <input
            type="number"
            min={1}
            value={state.maxParticipants}
            onChange={e => onChange({ maxParticipants: e.target.value })}
            className="ct-input"
          />
          <p className="mt-1 text-[11px] text-gray-400 dark:text-gray-500">
            1 = Private, 2 = Semi-private, 3+ = Group
          </p>
        </div>
      </div>

      <div>
        <label className="block text-[11px] text-gray-400 dark:text-gray-500 mb-0.5">
          Pricing
        </label>
        <div className="flex gap-2">
          {(["flat", "hourly"] as const).map(basis => (
            <button
              key={basis}
              type="button"
              onClick={() => onChange({ pricingBasis: basis })}
              className={`px-3 py-1.5 rounded-full text-xs font-medium border motion-safe:transition-colors ${
                state.pricingBasis === basis
                  ? "bg-accent text-white dark:text-gray-900 border-accent"
                  : "bg-white text-gray-600 border-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-600 hover:border-accent hover:text-accent"
              }`}
            >
              {basis === "flat" ? "Total price per lesson" : "Total hourly lesson rate"}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="block text-[11px] text-gray-400 dark:text-gray-500 mb-0.5">
          Amount (blank = no price set)
        </label>
        <input
          type="number"
          min={0}
          step={0.01}
          placeholder="0.00"
          value={state.amountDollars}
          onChange={e => onChange({ amountDollars: e.target.value })}
          className="ct-input"
          style={{ width: "8rem" }}
        />
        <p className="mt-1 text-[11px] text-gray-400 dark:text-gray-500">
          Price is for the entire lesson, not per player. For semi-private or group Lessons, use
          Pricing Notes to explain any per-player breakdown.
        </p>
      </div>

      <input
        type="text"
        placeholder="Pricing notes (optional)"
        value={state.rateNotes}
        onChange={e => onChange({ rateNotes: e.target.value })}
        className="ct-input"
      />
      {error && <p className="text-xs text-red-500">{error}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onSave}
          disabled={isPending}
          className="ct-button-primary text-xs"
        >
          {isPending ? "Saving…" : saveLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className={ACTION_BUTTON_SECONDARY_COMPACT}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
