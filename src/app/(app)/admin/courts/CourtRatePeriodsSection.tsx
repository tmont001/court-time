"use client";

import { useState, useTransition, useEffect, type Dispatch, type SetStateAction } from "react";
import { useRouter } from "next/navigation";
import { upsertCourtRatePeriod, setCourtRatePeriodActive } from "@/app/(app)/admin/settings/actions";
import { formatOperatorPrice } from "@/lib/money";
import {
  ACTION_BUTTON_SECONDARY_COMPACT,
  ACTION_BUTTON_POSITIVE_COMPACT,
  ACTION_BUTTON_WARNING_COMPACT,
} from "@/components/styles/actionButtonStyles";

// Peak/Off-Peak Pricing — originally Checkpoint B (as
// admin/settings/CourtRatePeriodsSection.tsx); relocated by a later IA
// refinement to live alongside court management and default court rates
// on /admin/courts (Court Rates tab), consolidating the operator's
// court-pricing mental model into one page. Behavior is unchanged — only
// this file's location and its import of upsertCourtRatePeriod/
// setCourtRatePeriodActive moved to a cross-directory import (those RPC
// wrappers still live in settings/actions.ts, unmoved), mirroring the
// same cross-directory Server Action import precedent already
// established by MembershipsSection (admin/members) importing
// updateClubMembershipsEnabled from this same settings/actions module.
//
// Talks ONLY to the two existing lifecycle RPCs (upsert_court_rate_period
// / set_court_rate_period_active, 0200) — never a direct table write. No
// pricing precedence is computed here: this component only displays each
// period's OWN configured rates as entered; it never resolves "what rate
// would apply," which stays exclusively server-side
// (_resolve_court_reservation_rate / the preview RPC).
//
// Locked v1 shape, mirrored from CourtManagementList's own list/edit-row
// pattern: club-wide periods only (no court selector), no priority/order
// field, no overnight periods (enforced server-side), Add/Edit/Deactivate/
// Reactivate only — no hard Delete.

const DAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type RatePeriod = {
  id: string;
  name: string;
  days_of_week: number[];
  starts_at_local: string; // "HH:MM:SS" from Postgres `time`
  ends_at_local: string;
  hourly_rate_cents: number | null;
  hourly_rate_non_member_cents: number | null;
  is_active: boolean;
};

type Status = { type: "success" | "error"; message: string };

type FormState = {
  name: string;
  days: Set<number>;
  startsAt: string; // "HH:MM" — <input type="time"> shape
  endsAt: string;
  memberRate: string; // dollars, as typed
  nonMemberRate: string;
};

const EMPTY_FORM: FormState = {
  name: "",
  days: new Set(),
  startsAt: "",
  endsAt: "",
  memberRate: "",
  nonMemberRate: "",
};

function toTimeInput(t: string): string {
  return t.slice(0, 5);
}

// Wall-clock formatting only — constructing a local Date from a bare
// HH:MM and reading it back with toLocaleTimeString never crosses a
// timezone boundary (both the construction and the read happen in the
// same local reference), so this is safe despite using Date internally.
function formatLocalTime(hhmmss: string): string {
  const [h, m] = hhmmss.split(":").map(Number);
  const d = new Date(1970, 0, 1, h, m);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// Compresses a day-of-week set into "Mon–Fri" / "Sat, Sun" style ranges.
// Cosmetic only — never consulted for pricing.
function formatDayRange(days: number[]): string {
  const sorted = [...days].sort((a, b) => a - b);
  const groups: number[][] = [];
  for (const d of sorted) {
    const last = groups[groups.length - 1];
    if (last && last[last.length - 1] === d - 1) {
      last.push(d);
    } else {
      groups.push([d]);
    }
  }
  return groups
    .map((g) => (g.length === 1 ? DAY_ABBR[g[0]] : `${DAY_ABBR[g[0]]}–${DAY_ABBR[g[g.length - 1]]}`))
    .join(", ");
}

interface FormProps {
  form: FormState;
  setForm: Dispatch<SetStateAction<FormState>>;
  membershipsEnabled: boolean;
  onSave: () => void;
  onCancel: () => void;
  isSaving: boolean;
}

function RatePeriodForm({ form, setForm, membershipsEnabled, onSave, onCancel, isSaving }: FormProps) {
  function toggleDay(d: number) {
    setForm((prev) => {
      const next = new Set(prev.days);
      if (next.has(d)) next.delete(d);
      else next.add(d);
      return { ...prev, days: next };
    });
  }

  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <input
        autoFocus
        value={form.name}
        onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
        placeholder="Name (e.g. Peak)"
        maxLength={60}
        className="w-full border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-1.5 text-base md:text-sm text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent"
      />

      <div className="flex flex-wrap gap-1.5">
        {DAY_ABBR.map((label, idx) => (
          <button
            key={idx}
            type="button"
            onClick={() => toggleDay(idx)}
            aria-pressed={form.days.has(idx)}
            className={`px-2.5 py-1 rounded-md text-xs font-medium border motion-safe:transition-colors ${
              form.days.has(idx)
                ? "bg-accent text-white dark:text-gray-900 border-accent"
                : "bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-600"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex items-end gap-2 flex-wrap">
        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-gray-400 dark:text-gray-500">Start</label>
          <input
            type="time"
            value={form.startsAt}
            onChange={(e) => setForm((prev) => ({ ...prev, startsAt: e.target.value }))}
            className="border border-gray-200 dark:border-gray-600 rounded-lg px-2 py-1.5 text-base md:text-sm text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent"
          />
        </div>
        <span className="text-xs text-gray-400 dark:text-gray-500 select-none pb-2">to</span>
        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-gray-400 dark:text-gray-500">End</label>
          <input
            type="time"
            value={form.endsAt}
            onChange={(e) => setForm((prev) => ({ ...prev, endsAt: e.target.value }))}
            className="border border-gray-200 dark:border-gray-600 rounded-lg px-2 py-1.5 text-base md:text-sm text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent"
          />
        </div>
      </div>

      <div className="flex items-end gap-2 flex-wrap">
        <div className="flex flex-col gap-1 min-w-0">
          <label className="text-[10px] text-gray-400 dark:text-gray-500">
            {membershipsEnabled ? "Member / Standard" : "Standard"}
          </label>
          <input
            type="number"
            min={0}
            step={0.01}
            placeholder="0.00"
            value={form.memberRate}
            onChange={(e) => setForm((prev) => ({ ...prev, memberRate: e.target.value }))}
            className="w-full min-w-0 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-1.5 text-base md:text-sm text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent"
          />
        </div>
        {membershipsEnabled && (
          <div className="flex flex-col gap-1 min-w-0">
            <label className="text-[10px] text-gray-400 dark:text-gray-500">Non-Member</label>
            <input
              type="number"
              min={0}
              step={0.01}
              placeholder="Use fallback rate"
              value={form.nonMemberRate}
              onChange={(e) => setForm((prev) => ({ ...prev, nonMemberRate: e.target.value }))}
              className="w-full min-w-0 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-1.5 text-base md:text-sm text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent"
            />
          </div>
        )}
        <button onClick={onSave} disabled={isSaving} className={ACTION_BUTTON_POSITIVE_COMPACT}>
          {isSaving ? "Saving…" : "Save"}
        </button>
        <button onClick={onCancel} className={ACTION_BUTTON_SECONDARY_COMPACT}>
          Cancel
        </button>
      </div>
    </div>
  );
}

interface Props {
  initialPeriods: RatePeriod[];
  currency: string;
  membershipsEnabled: boolean;
}

export default function CourtRatePeriodsSection({ initialPeriods, currency, membershipsEnabled }: Props) {
  const router = useRouter();
  const [periods, setPeriods] = useState<RatePeriod[]>(initialPeriods);
  const [isPending, startTransition] = useTransition();
  const [pendingId, setPendingId] = useState<string | null>(null);
  // null = nothing being edited; "__new__" = the Add form; otherwise the
  // id of the period currently being edited.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [status, setStatus] = useState<Status | null>(null);

  // Sync local list when the server component re-renders after router.refresh().
  useEffect(() => {
    setPeriods(initialPeriods);
  }, [initialPeriods]);

  function showStatus(s: Status) {
    setStatus(s);
    if (s.type === "success") {
      setTimeout(() => setStatus(null), 2500);
    }
    // errors persist until the next action clears them
  }

  function startAdd() {
    setStatus(null);
    setForm(EMPTY_FORM);
    setEditingId("__new__");
  }

  function startEdit(p: RatePeriod) {
    setStatus(null);
    setForm({
      name: p.name,
      days: new Set(p.days_of_week),
      startsAt: toTimeInput(p.starts_at_local),
      endsAt: toTimeInput(p.ends_at_local),
      memberRate: p.hourly_rate_cents !== null ? (p.hourly_rate_cents / 100).toFixed(2) : "",
      nonMemberRate: p.hourly_rate_non_member_cents !== null ? (p.hourly_rate_non_member_cents / 100).toFixed(2) : "",
    });
    setEditingId(p.id);
  }

  function cancelForm() {
    setEditingId(null);
    setForm(EMPTY_FORM);
  }

  // Client-side checks here are plain required-field UX guards (matching
  // CourtManagementList's own "if (!trimmed) return;" idiom) — never a
  // reimplementation of overlap/rate validation, which stays exclusively
  // server-side in upsert_court_rate_period.
  function handleSubmit() {
    const trimmedName = form.name.trim();
    if (!trimmedName || form.days.size === 0 || !form.startsAt || !form.endsAt) return;

    const memberTrimmed = form.memberRate.trim();
    const memberCents = memberTrimmed === "" ? null : Math.round(parseFloat(memberTrimmed) * 100);
    const nonMemberTrimmed = form.nonMemberRate.trim();
    const nonMemberCents = nonMemberTrimmed === "" ? null : Math.round(parseFloat(nonMemberTrimmed) * 100);

    const targetId = editingId === "__new__" ? null : editingId;
    setStatus(null);
    setPendingId(editingId);
    startTransition(async () => {
      const result = await upsertCourtRatePeriod(
        targetId,
        trimmedName,
        Array.from(form.days).sort((a, b) => a - b),
        form.startsAt,
        form.endsAt,
        memberCents,
        nonMemberCents,
      );
      setPendingId(null);
      if (result.error) {
        showStatus({ type: "error", message: result.error });
      } else {
        setEditingId(null);
        setForm(EMPTY_FORM);
        showStatus({ type: "success", message: targetId ? "Rate period saved." : "Rate period added." });
        router.refresh();
      }
    });
  }

  function handleSetActive(p: RatePeriod, active: boolean) {
    setStatus(null);
    setPendingId(p.id);
    startTransition(async () => {
      const result = await setCourtRatePeriodActive(p.id, active);
      setPendingId(null);
      if (result.error) {
        // Reactivation conflicting with an active period surfaces the
        // same operator-facing overlap message as Add/Edit — the period
        // simply stays inactive, per the locked UX.
        showStatus({ type: "error", message: result.error });
      } else {
        showStatus({ type: "success", message: active ? "Rate period reactivated." : "Rate period deactivated." });
        router.refresh();
      }
    });
  }

  const anyPending = isPending && pendingId !== null;

  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Set different court rates for busy and quieter times. A court-specific rate (set on the Courts
        tab) for the same pricing type takes priority over a matching time-based rate. Court Time
        otherwise follows your existing pricing fallbacks.
      </p>

      {status && (
        <div
          className={`px-3 py-2 rounded-lg text-xs font-medium ${
            status.type === "success"
              ? "bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-400"
              : "bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400"
          }`}
        >
          {status.message}
        </div>
      )}

      {periods.length === 0 && editingId !== "__new__" ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">No rate periods yet. Add one below.</p>
      ) : (
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-700 overflow-hidden">
          {periods.map((p) => (
            <div key={p.id} className="bg-white dark:bg-gray-800">
              {editingId === p.id ? (
                <RatePeriodForm
                  form={form}
                  setForm={setForm}
                  membershipsEnabled={membershipsEnabled}
                  onSave={handleSubmit}
                  onCancel={cancelForm}
                  isSaving={isPending && pendingId === p.id}
                />
              ) : (
                <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  {/* Inactive periods remain visible, with a clear status
                      pill — never hidden or filtered out of this list. */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                        {p.name}
                      </span>
                      <span
                        className={`flex-shrink-0 inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${
                          p.is_active
                            ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400"
                            : "bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400"
                        }`}
                      >
                        {p.is_active ? "Active" : "Inactive"}
                      </span>
                    </div>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                      {formatDayRange(p.days_of_week)} · {formatLocalTime(p.starts_at_local)}–
                      {formatLocalTime(p.ends_at_local)}
                    </p>
                    <div className="mt-1 flex items-center gap-x-1.5 gap-y-0.5 flex-wrap text-xs">
                      <span className="whitespace-nowrap">
                        {membershipsEnabled && <span className="text-gray-500 dark:text-gray-400">Member </span>}
                        <span className="font-medium text-gray-700 dark:text-gray-300">
                          {p.hourly_rate_cents !== null
                            ? `${formatOperatorPrice(p.hourly_rate_cents, currency)} /hr`
                            : "Use fallback rate"}
                        </span>
                      </span>
                      {membershipsEnabled && (
                        <>
                          <span className="text-gray-300 dark:text-gray-600" aria-hidden="true">
                            ·
                          </span>
                          <span className="whitespace-nowrap">
                            <span className="text-gray-500 dark:text-gray-400">Non-Member </span>
                            <span className="font-medium text-gray-700 dark:text-gray-300">
                              {p.hourly_rate_non_member_cents !== null
                                ? `${formatOperatorPrice(p.hourly_rate_non_member_cents, currency)} /hr`
                                : "Use fallback rate"}
                            </span>
                          </span>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 flex-wrap sm:flex-nowrap sm:flex-shrink-0">
                    <button
                      onClick={() => startEdit(p)}
                      disabled={anyPending}
                      className={ACTION_BUTTON_SECONDARY_COMPACT}
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => handleSetActive(p, !p.is_active)}
                      disabled={isPending && pendingId === p.id}
                      className={p.is_active ? ACTION_BUTTON_WARNING_COMPACT : ACTION_BUTTON_POSITIVE_COMPACT}
                    >
                      {isPending && pendingId === p.id ? "…" : p.is_active ? "Deactivate" : "Reactivate"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {editingId === "__new__" ? (
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
          <RatePeriodForm
            form={form}
            setForm={setForm}
            membershipsEnabled={membershipsEnabled}
            onSave={handleSubmit}
            onCancel={cancelForm}
            isSaving={isPending && pendingId === "__new__"}
          />
        </div>
      ) : (
        <button
          onClick={startAdd}
          disabled={anyPending}
          className="w-full px-4 py-3 rounded-xl border border-dashed border-gray-300 dark:border-gray-600 text-sm text-gray-500 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-500 hover:text-gray-700 dark:hover:text-gray-300 disabled:opacity-40 transition-colors"
        >
          + Add Rate Period
        </button>
      )}
    </div>
  );
}
