"use client";

import { useState, useTransition, useEffect } from "react";
import { useRouter } from "next/navigation";
import { addCourt, renameCourt, reorderCourts, setCourtActive, deleteCourt, setCourtHourlyRate } from "./actions";
import { formatOperatorPrice } from "@/lib/money";
import {
  ACTION_BUTTON_SECONDARY_COMPACT,
  ACTION_BUTTON_POSITIVE_COMPACT,
  ACTION_BUTTON_WARNING_COMPACT,
  ACTION_BUTTON_DESTRUCTIVE_COMPACT,
} from "@/components/styles/actionButtonStyles";

type Court = {
  id: string;
  name: string;
  display_order: number;
  is_active: boolean;
  hourly_rate_cents: number | null;
  hourly_rate_non_member_cents: number | null;
};

type Status = {
  type: "success" | "error" | "warning";
  message: string;
};

// Phase 42C-2 correction pass: the actual locked 0189 Non-Member rate
// resolution is a 4-level chain — court Non-Member override -> club
// Non-Member default -> court Standard/Member override -> club
// Standard/Member default -> unpriced. A booking never actually goes
// unpriced for a Non-Member merely because no Non-Member-SPECIFIC rate is
// configured; it silently falls back to whatever the Member/base chain
// resolves to. This display must reflect that fallback rather than
// reporting "No price set" while a real effective rate exists.
//
// UX polish pass: split into { text, qualifier } rather than one
// pre-concatenated string, so the normal-row display can render the
// actual rate value more prominently than the "(override)"/"(default)"
// qualifier, without duplicating the resolution logic itself. `qualifier`
// is empty for the two fallback-phrase cases — those are self-explanatory
// and take no parenthetical.
type RateDisplay = {
  text: string;
  qualifier: string;
};

function describeMemberRate(
  court: Court,
  defaultHourlyRateCents: number | null,
  currency: string,
): RateDisplay {
  if (court.hourly_rate_cents !== null) {
    return { text: `${formatOperatorPrice(court.hourly_rate_cents, currency)} /hr`, qualifier: "(override)" };
  }
  if (defaultHourlyRateCents !== null) {
    return { text: `${formatOperatorPrice(defaultHourlyRateCents, currency)} /hr`, qualifier: "(default)" };
  }
  return { text: "No price set", qualifier: "" };
}

function describeNonMemberRate(
  court: Court,
  defaultHourlyRateCents: number | null,
  defaultHourlyRateNonMemberCents: number | null,
  currency: string,
): RateDisplay {
  if (court.hourly_rate_non_member_cents !== null) {
    return { text: `${formatOperatorPrice(court.hourly_rate_non_member_cents, currency)} /hr`, qualifier: "(override)" };
  }
  if (defaultHourlyRateNonMemberCents !== null) {
    return { text: `${formatOperatorPrice(defaultHourlyRateNonMemberCents, currency)} /hr`, qualifier: "(default)" };
  }
  const effectiveMemberRateCents = court.hourly_rate_cents ?? defaultHourlyRateCents;
  if (effectiveMemberRateCents !== null) {
    return { text: "Uses Standard/Member rate", qualifier: "" };
  }
  return { text: "No price set", qualifier: "" };
}

// Renders one rate segment ("Member $50/hr (override)"). The label and
// qualifier share the same secondary color regardless of Member vs
// Non-Member (no semantic color distinction between the two) — only the
// rate value itself is styled more prominently. `label` is empty when
// Memberships are off (a single, unlabeled base rate).
function RateSegment({ label, display }: { label: string; display: RateDisplay }) {
  return (
    <span className="whitespace-nowrap">
      {label && <span className="text-gray-500 dark:text-gray-400">{label} </span>}
      <span className="font-medium text-gray-700 dark:text-gray-300">{display.text}</span>
      {display.qualifier && (
        <span className="text-gray-400 dark:text-gray-500"> {display.qualifier}</span>
      )}
    </span>
  );
}

// Same fallback rule applied to the Non-Member input's placeholder text,
// so the edit UI never implies "unpriced" for a court that would actually
// bill Non-Members at the Standard/Member rate.
function nonMemberRatePlaceholder(
  court: Court,
  defaultHourlyRateCents: number | null,
  defaultHourlyRateNonMemberCents: number | null,
): string {
  if (defaultHourlyRateNonMemberCents !== null) {
    return `${(defaultHourlyRateNonMemberCents / 100).toFixed(2)} (club default)`;
  }
  const effectiveMemberRateCents = court.hourly_rate_cents ?? defaultHourlyRateCents;
  if (effectiveMemberRateCents !== null) {
    return `${(effectiveMemberRateCents / 100).toFixed(2)} (uses Standard/Member rate)`;
  }
  return "0.00 (unpriced)";
}

interface Props {
  initialCourts:                    Court[];
  clubId:                           string;
  currency:                         string;
  defaultHourlyRateCents:           number | null;
  membershipsEnabled:               boolean;
  defaultHourlyRateNonMemberCents:  number | null;
}

export default function CourtManagementList({
  initialCourts,
  clubId,
  currency,
  defaultHourlyRateCents,
  membershipsEnabled,
  defaultHourlyRateNonMemberCents,
}: Props) {
  const router = useRouter();
  const [courts, setCourts] = useState<Court[]>(initialCourts);
  const [isPending, startTransition] = useTransition();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [editingRateId, setEditingRateId] = useState<string | null>(null);
  const [rateValue, setRateValue] = useState("");
  // Phase 42C-2: kept in its own state (not re-derived from FormData) so
  // it survives being hidden when Memberships are off — see the same
  // preservation strategy in PricingSettingsForm. Correction pass: this is
  // a UX convenience only — setCourtHourlyRate itself re-reads the
  // court's CURRENT stored override server-side and overrides whatever is
  // sent here whenever memberships_enabled is currently false, so a
  // stale/unsaved value sitting in this state can never actually reach
  // the database while Memberships are off.
  const [nonMemberRateValue, setNonMemberRateValue] = useState("");
  const [isAddingCourt, setIsAddingCourt] = useState(false);
  const [addValue, setAddValue] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);
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
      const result = await reorderCourts(updated.map((c) => c.id), clubId);
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
    setDeletingId(null);
    setEditingRateId(null);
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
      const result = await renameCourt(courtId, trimmed, clubId);
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

  // ── Hourly rate override ──────────────────────────────────────────────────
  // Phase 34B: optional per-court override. Blank clears it, falling back
  // to the club default rate (or unpriced, if that's also blank).

  function handleRateStart(court: Court) {
    setStatus(null);
    setDeletingId(null);
    setRenamingId(null);
    setEditingRateId(court.id);
    setRateValue(court.hourly_rate_cents !== null ? (court.hourly_rate_cents / 100).toFixed(2) : "");
    setNonMemberRateValue(
      court.hourly_rate_non_member_cents !== null ? (court.hourly_rate_non_member_cents / 100).toFixed(2) : ""
    );
  }

  function handleRateCancel() {
    setEditingRateId(null);
    setRateValue("");
    setNonMemberRateValue("");
  }

  function handleRateSubmit(courtId: string) {
    const trimmed = rateValue.trim();
    const cents = trimmed === "" ? null : Math.round(parseFloat(trimmed) * 100);
    const nonMemberTrimmed = nonMemberRateValue.trim();
    const nonMemberCents = nonMemberTrimmed === "" ? null : Math.round(parseFloat(nonMemberTrimmed) * 100);
    setStatus(null);
    setPendingId(courtId);
    startTransition(async () => {
      const result = await setCourtHourlyRate(courtId, cents, nonMemberCents, clubId);
      setPendingId(null);
      if (result.error) {
        showStatus({ type: "error", message: result.error });
      } else {
        setEditingRateId(null);
        if (result.nonMemberRatePreserved) {
          // A stale tab: this browser's Non-Member value was ignored
          // server-side because Memberships are currently off. Resync
          // local state to the authoritative stored value the server
          // actually kept, rather than leaving the misleading unsaved
          // input value sitting in state, and say so explicitly instead
          // of a plain "Court rate saved." that would wrongly imply the
          // typed Non-Member value took effect.
          setNonMemberRateValue(
            result.effectiveNonMemberRateCents != null
              ? (result.effectiveNonMemberRateCents / 100).toFixed(2)
              : ""
          );
          showStatus({
            type: "success",
            message: "Court rate saved. Memberships are off, so the Non-Member rate was left unchanged.",
          });
        } else {
          showStatus({ type: "success", message: "Court rate saved." });
        }
        router.refresh();
      }
    });
  }

  // ── Activate / Deactivate ─────────────────────────────────────────────────

  function handleSetActive(court: Court, isActive: boolean) {
    setStatus(null);
    setPendingId(court.id);
    startTransition(async () => {
      const result = await setCourtActive(court.id, isActive, clubId);
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

  // ── Delete ────────────────────────────────────────────────────────────────

  function handleDeleteStart(courtId: string) {
    setStatus(null);
    setRenamingId(null);
    setRenameValue("");
    setDeletingId(courtId);
  }

  function handleDeleteCancel() {
    setDeletingId(null);
  }

  function handleDeleteConfirm(court: Court) {
    setStatus(null);
    setPendingId(court.id);
    startTransition(async () => {
      const result = await deleteCourt(court.id, clubId);
      setPendingId(null);
      setDeletingId(null);
      if (result.error === "court_has_history") {
        showStatus({
          type: "error",
          message: `${court.name} has booking history and cannot be deleted. Deactivate it instead.`,
        });
      } else if (result.error) {
        showStatus({ type: "error", message: result.error });
      } else {
        showStatus({ type: "success", message: "Court deleted." });
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
      const result = await addCourt(trimmed, clubId);
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

              {deletingId === court.id ? (
                /* ── Delete confirmation row ── */
                <div className="flex items-center justify-between gap-2 px-4 py-3">
                  <div className="min-w-0">
                    <span className="text-sm text-gray-900 dark:text-gray-100 truncate block">
                      {court.name}
                    </span>
                    <span className="text-[10px] text-gray-400 dark:text-gray-500">
                      Only courts with no history can be deleted.
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <button
                      onClick={() => handleDeleteConfirm(court)}
                      disabled={isPending && pendingId === court.id}
                      className={ACTION_BUTTON_DESTRUCTIVE_COMPACT}
                    >
                      {isPending && pendingId === court.id ? "Deleting…" : "Delete"}
                    </button>
                    <button
                      onClick={handleDeleteCancel}
                      className={ACTION_BUTTON_SECONDARY_COMPACT}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : renamingId === court.id ? (
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
                    className="flex-1 min-w-0 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-1.5 text-base md:text-sm text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent motion-safe:transition-all motion-safe:duration-150"
                  />
                  <button
                    onClick={() => handleRenameSubmit(court.id)}
                    disabled={isPending && pendingId === court.id}
                    className={ACTION_BUTTON_POSITIVE_COMPACT}
                  >
                    {isPending && pendingId === court.id ? "Saving…" : "Save"}
                  </button>
                  <button
                    onClick={handleRenameCancel}
                    className={ACTION_BUTTON_SECONDARY_COMPACT}
                  >
                    Cancel
                  </button>
                </div>
              ) : editingRateId === court.id ? (
                /* ── Rate edit row ──
                    Phase 42C-2: gains an optional second (Non-Member) rate
                    input, shown only while Memberships are on. Stacked
                    (name on its own line, then the input row) rather than
                    the prior single flex row — two number inputs plus two
                    buttons no longer fit one line at narrow widths. */
                <div className="flex flex-col gap-2 px-4 py-3">
                  <span className="text-sm text-gray-900 dark:text-gray-100 truncate min-w-0">
                    {court.name}
                  </span>
                  <div className="flex items-end gap-2 flex-wrap">
                    <div className="flex flex-col gap-1 min-w-0">
                      {membershipsEnabled && (
                        <label className="text-[10px] text-gray-400 dark:text-gray-500">
                          Standard / Member
                        </label>
                      )}
                      <input
                        autoFocus
                        type="number"
                        min={0}
                        step={0.01}
                        placeholder={
                          defaultHourlyRateCents !== null
                            ? `${(defaultHourlyRateCents / 100).toFixed(2)} (club default)`
                            : "0.00 (unpriced)"
                        }
                        value={rateValue}
                        onChange={(e) => setRateValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleRateSubmit(court.id);
                          if (e.key === "Escape") handleRateCancel();
                        }}
                        className="w-full min-w-0 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-1.5 text-base md:text-sm text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent motion-safe:transition-all motion-safe:duration-150"
                      />
                    </div>
                    {membershipsEnabled && (
                      <div className="flex flex-col gap-1 min-w-0">
                        <label className="text-[10px] text-gray-400 dark:text-gray-500">
                          Non-Member
                        </label>
                        <input
                          type="number"
                          min={0}
                          step={0.01}
                          placeholder={nonMemberRatePlaceholder(court, defaultHourlyRateCents, defaultHourlyRateNonMemberCents)}
                          value={nonMemberRateValue}
                          onChange={(e) => setNonMemberRateValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") handleRateSubmit(court.id);
                            if (e.key === "Escape") handleRateCancel();
                          }}
                          className="w-full min-w-0 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-1.5 text-base md:text-sm text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent motion-safe:transition-all motion-safe:duration-150"
                        />
                      </div>
                    )}
                    <button
                      onClick={() => handleRateSubmit(court.id)}
                      disabled={isPending && pendingId === court.id}
                      className={ACTION_BUTTON_POSITIVE_COMPACT}
                    >
                      {isPending && pendingId === court.id ? "Saving…" : "Save"}
                    </button>
                    <button
                      onClick={handleRateCancel}
                      className={ACTION_BUTTON_SECONDARY_COMPACT}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                /* ── Normal row ──
                    Mobile (below sm): the name/status/rate block and the
                    action-button block each get their own full-width row —
                    the name never has to compete with 6 action buttons for
                    horizontal space, and the buttons wrap across as many
                    lines as they need instead of squeezing the name/badge
                    down to a sliver. sm+: reverts to the original single-row
                    layout (name/badge/rate on the left, actions on the
                    right, never wrapping) — unchanged from before. */
                <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  {/* Name + status, then pricing on its own compact row.
                      UX polish pass: pricing previously sat inline with the
                      name/badge at 10px gray-400 — easy to misread as
                      secondary metadata. It now gets its own row directly
                      beneath the name, with the actual rate values styled
                      more prominently (font-medium, darker) than the
                      "(override)"/"(default)" qualifiers, which stay
                      secondary. Member and Non-Member intentionally share
                      the exact same styling — no semantic color
                      distinction between them. flex-wrap lets this row
                      wrap naturally on narrow viewports without
                      overflowing; on desktop it sits on one line. */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
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
                    <div className="mt-1 flex items-center gap-x-1.5 gap-y-0.5 flex-wrap text-xs">
                      <RateSegment
                        label={membershipsEnabled ? "Member" : ""}
                        display={describeMemberRate(court, defaultHourlyRateCents, currency)}
                      />
                      {membershipsEnabled && (
                        <>
                          <span className="text-gray-300 dark:text-gray-600" aria-hidden="true">·</span>
                          <RateSegment
                            label="Non-Member"
                            display={describeNonMemberRate(court, defaultHourlyRateCents, defaultHourlyRateNonMemberCents, currency)}
                          />
                        </>
                      )}
                    </div>
                  </div>

                  {/* Action buttons — one shared compact-button vocabulary
                      (src/lib/actionButtonStyles.ts), same heights/spacing/
                      focus/disabled treatment throughout. No plain-text
                      actions and no pipe separators — each button's own
                      border already separates it. Wraps freely on mobile
                      (its own full-width row); never wraps and never
                      shrinks at sm+ (original desktop behavior). */}
                  <div className="flex items-center gap-1.5 flex-wrap sm:flex-nowrap sm:flex-shrink-0">
                    <button
                      onClick={() => handleMove(idx, "up")}
                      disabled={idx === 0 || anyPending}
                      className={ACTION_BUTTON_SECONDARY_COMPACT}
                      aria-label="Move up"
                    >
                      ↑
                    </button>
                    <button
                      onClick={() => handleMove(idx, "down")}
                      disabled={idx === courts.length - 1 || anyPending}
                      className={ACTION_BUTTON_SECONDARY_COMPACT}
                      aria-label="Move down"
                    >
                      ↓
                    </button>
                    <button
                      onClick={() => handleRenameStart(court)}
                      disabled={anyPending}
                      className={ACTION_BUTTON_SECONDARY_COMPACT}
                    >
                      Rename
                    </button>
                    <button
                      onClick={() => handleRateStart(court)}
                      disabled={anyPending}
                      className={ACTION_BUTTON_SECONDARY_COMPACT}
                    >
                      Rate
                    </button>
                    <button
                      onClick={() => handleSetActive(court, !court.is_active)}
                      disabled={isPending && pendingId === court.id}
                      className={court.is_active ? ACTION_BUTTON_WARNING_COMPACT : ACTION_BUTTON_POSITIVE_COMPACT}
                    >
                      {isPending && pendingId === court.id
                        ? "…"
                        : court.is_active
                        ? "Deactivate"
                        : "Activate"}
                    </button>
                    <button
                      onClick={() => handleDeleteStart(court.id)}
                      disabled={anyPending}
                      className={ACTION_BUTTON_DESTRUCTIVE_COMPACT}
                    >
                      Delete
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
