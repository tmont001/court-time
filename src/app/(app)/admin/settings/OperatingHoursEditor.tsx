"use client";

import { useState, useEffect, useTransition } from "react";
import { createClient } from "@/lib/supabase/client";

const DAY_NAMES = [
  "Sunday", "Monday", "Tuesday", "Wednesday",
  "Thursday", "Friday", "Saturday",
];

type DayHours = {
  day_of_week: number;
  opens_at:    string; // "HH:MM"
  closes_at:   string; // "HH:MM"
  is_closed:   boolean;
};

type AffectedDay = {
  day_of_week:       number;
  reservation_count: number;
};

type RpcResult = {
  dry_run:  boolean;
  affected: AffectedDay[];
};

const DEFAULT_HOURS: DayHours[] = Array.from({ length: 7 }, (_, i) => ({
  day_of_week: i,
  opens_at:    "08:00",
  closes_at:   "20:00",
  is_closed:   false,
}));

function toTimeInput(t: string): string {
  // DB returns "HH:MM:SS"; <input type="time"> expects "HH:MM"
  return t.slice(0, 5);
}

function mapRpcError(message: string): string {
  if (message.includes("not_authenticated"))   return "You must be signed in.";
  if (message.includes("insufficient_role"))   return "Admin access required.";
  if (message.includes("invalid_hours_payload")) return "Invalid hours data. Please refresh and try again.";
  if (message.includes("invalid_time_range"))  return "Closing time must be after opening time for all open days.";
  return "Failed to save operating hours. Please try again.";
}

interface Props {
  clubId: string;
}

export default function OperatingHoursEditor({ clubId }: Props) {
  const [hours, setHours]     = useState<DayHours[]>(DEFAULT_HOURS);
  const [loaded, setLoaded]   = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [isPending, startTransition] = useTransition();
  const [validationError, setValidationError] = useState<string | null>(null);
  const [rpcError, setRpcError]               = useState<string | null>(null);
  const [saved, setSaved]                     = useState(false);

  // Set when dry-run returns conflicts; cleared on cancel or after commit.
  const [confirmAffected, setConfirmAffected] = useState<AffectedDay[] | null>(null);

  useEffect(() => {
    const supabase = createClient();
    supabase
      .from("operating_hours")
      .select("day_of_week, opens_at, closes_at, is_closed")
      .eq("club_id", clubId)
      .order("day_of_week", { ascending: true })
      .then(({ data, error }) => {
        if (error) {
          setLoadError("Failed to load operating hours.");
        } else if (data && data.length === 7) {
          setHours(
            data.map((row) => ({
              day_of_week: row.day_of_week,
              opens_at:    toTimeInput(row.opens_at),
              closes_at:   toTimeInput(row.closes_at),
              is_closed:   row.is_closed,
            }))
          );
        }
        setLoaded(true);
      });
  }, [clubId]);

  function updateDay(dow: number, patch: Partial<DayHours>) {
    setHours((prev) =>
      prev.map((d) => (d.day_of_week === dow ? { ...d, ...patch } : d))
    );
    setValidationError(null);
    setRpcError(null);
    setSaved(false);
  }

  function validate(): boolean {
    for (const d of hours) {
      if (!d.is_closed && d.closes_at <= d.opens_at) {
        setValidationError(
          `${DAY_NAMES[d.day_of_week]}: closing time must be after opening time.`
        );
        return false;
      }
    }
    return true;
  }

  // Sends dry_run=false and handles the response.
  async function commitSave(): Promise<void> {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("update_operating_hours", {
      p_hours:   JSON.parse(JSON.stringify(hours)),
      p_dry_run: false,
    });
    if (error) {
      setRpcError(mapRpcError(error.message));
      return;
    }
    void (data as RpcResult); // affected info available but not shown after commit
    setConfirmAffected(null);
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  }

  function handleSave() {
    setValidationError(null);
    setRpcError(null);
    setSaved(false);
    if (!validate()) return;

    startTransition(async () => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("update_operating_hours", {
        p_hours:   JSON.parse(JSON.stringify(hours)),
        p_dry_run: true,
      });
      if (error) {
        setRpcError(mapRpcError(error.message));
        return;
      }
      const result = data as RpcResult;
      if (result.affected && result.affected.length > 0) {
        setConfirmAffected(result.affected);
      } else {
        await commitSave();
      }
    });
  }

  function handleConfirmSave() {
    startTransition(async () => {
      await commitSave();
    });
  }

  if (!loaded) {
    return (
      <p className="text-sm text-gray-400 dark:text-gray-500 py-2">Loading…</p>
    );
  }

  if (loadError) {
    return (
      <p className="text-sm text-red-500 dark:text-red-400 py-2">{loadError}</p>
    );
  }

  return (
    <>
      <div className="space-y-0">
        {hours.map((d) => (
          <div
            key={d.day_of_week}
            className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5 border-b border-gray-100 dark:border-gray-800 last:border-b-0"
          >
            {/* Day name */}
            <span className="w-24 shrink-0 text-sm text-gray-700 dark:text-gray-300">
              {DAY_NAMES[d.day_of_week]}
            </span>

            {/* Closed toggle */}
            <label className="flex items-center gap-1.5 shrink-0 text-xs text-gray-500 dark:text-gray-400 cursor-pointer">
              <input
                type="checkbox"
                checked={d.is_closed}
                onChange={(e) => updateDay(d.day_of_week, { is_closed: e.target.checked })}
                className="accent-gray-700 dark:accent-gray-300"
              />
              Closed
            </label>

            {/* Time inputs */}
            <div className={`flex items-center gap-2 transition-opacity${d.is_closed ? " opacity-40 pointer-events-none" : ""}`}>
              <input
                type="time"
                value={d.opens_at}
                disabled={d.is_closed}
                onChange={(e) => updateDay(d.day_of_week, { opens_at: e.target.value })}
                className="border border-gray-200 dark:border-gray-600 rounded-lg px-2 py-1.5 text-base md:text-sm text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent"
              />
              <span className="text-xs text-gray-400 dark:text-gray-500 select-none">to</span>
              <input
                type="time"
                value={d.closes_at}
                disabled={d.is_closed}
                onChange={(e) => updateDay(d.day_of_week, { closes_at: e.target.value })}
                className="border border-gray-200 dark:border-gray-600 rounded-lg px-2 py-1.5 text-base md:text-sm text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent"
              />
            </div>
          </div>
        ))}

        {validationError && (
          <p className="text-xs text-red-600 dark:text-red-400 pt-2">{validationError}</p>
        )}
        {rpcError && (
          <p className="text-xs text-red-600 dark:text-red-400 pt-2">{rpcError}</p>
        )}

        <div className="flex items-center gap-3 pt-3">
          <button
            type="button"
            disabled={isPending}
            onClick={handleSave}
            className="px-4 py-2 rounded-lg bg-accent text-white dark:text-gray-900 text-sm font-medium disabled:opacity-40"
          >
            {isPending ? "Saving…" : "Save"}
          </button>
          {saved && (
            <p className="text-xs font-medium text-green-600 dark:text-green-400">Saved</p>
          )}
        </div>
      </div>

      {/* Conflict confirmation dialog */}
      {confirmAffected && (
        <>
          <div
            className="fixed inset-0 bg-black/30 z-40"
            onClick={() => { if (!isPending) setConfirmAffected(null); }}
          />
          <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
            <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl w-full max-w-sm px-6 py-6">
              <p className="text-base font-semibold text-gray-900 dark:text-gray-100">
                Save Operating Hours?
              </p>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">
                These changes may affect future reservations:
              </p>
              <ul className="mt-2 space-y-1">
                {confirmAffected.map(({ day_of_week, reservation_count }) => (
                  <li key={day_of_week} className="text-sm text-gray-700 dark:text-gray-300">
                    {DAY_NAMES[day_of_week]}:{" "}
                    <span className="font-medium">{reservation_count}</span>{" "}
                    {reservation_count === 1 ? "reservation" : "reservations"}
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
                Existing reservations will not be cancelled or modified.
                You may want to contact affected members.
              </p>
              {rpcError && (
                <p className="mt-2 text-sm text-red-600 dark:text-red-400">{rpcError}</p>
              )}
              <div className="mt-5 flex gap-3">
                <button
                  disabled={isPending}
                  onClick={() => setConfirmAffected(null)}
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
    </>
  );
}
