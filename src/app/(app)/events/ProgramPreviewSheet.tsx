"use client";

// ProgramPreviewSheet — Phase 27C preview + generate flow. Calls
// preview_program_sessions directly from the client (read-only/STABLE,
// same convention as CreateEventSheet's direct client-side reads), groups
// rows by program_schedule_rule_id + occurrence_date (one generated event
// per group, regardless of court count), and requires an explicit inline
// confirmation before calling generate_program_sessions through the
// programsActions Server Action (which runs the stale-club preflight guard
// before writing, same as every other mutation in this app).

import { useState, useEffect, useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import ResponsiveSheet from "@/components/ResponsiveSheet";
import { createClient } from "@/lib/supabase/client";
import { generateProgramSessions, type GenerateResult } from "./programsActions";
import { mapProgramError } from "./programErrors";
import { isOperator } from "@/lib/auth/roles";

// ─── Types ────────────────────────────────────────────────────────────────────

interface PreviewRow {
  program_schedule_rule_id:    string;
  occurrence_date:              string;
  starts_at:                    string;
  ends_at:                      string;
  court_id:                     string;
  court_name:                   string;
  already_generated:            boolean;
  has_conflict:                 boolean;
  conflicting_reservation_id:   string | null;
  conflicting_event_id:         string | null;
  conflict_reason:              string | null;
}

interface OccurrenceGroup {
  key:               string;
  occurrenceDate:    string;
  startsAt:          string;
  endsAt:            string;
  courts:            { id: string; name: string; hasConflict: boolean }[];
  alreadyGenerated:  boolean;
  hasConflict:       boolean;
}

interface Props {
  programId:         string;
  programTitle:      string;
  // Phase 27C.1: scalar fields (not the full ProgramListRow) so this sheet
  // can be opened equally from the list (which has the enriched row) or
  // immediately after create/update (which only has the plain ProgramRow
  // the RPC returns) without waiting on a list refresh to complete first.
  programStatus:     "draft" | "active" | "cancelled" | "completed";
  programCreatedBy:  string;
  clubId:            string;
  clubTimezone:      string;
  userRole:          string;
  userId:            string;
  onClose:           () => void;
  onGenerated:       () => void;
  // Closes this sheet and opens the prefilled edit form for this program.
  // Only ever rendered (see Edit Draft button below) when the program is a
  // draft the current user may manage.
  onEdit:            () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function groupPreviewRows(rows: PreviewRow[]): OccurrenceGroup[] {
  const map = new Map<string, OccurrenceGroup>();
  for (const row of rows) {
    const key = `${row.program_schedule_rule_id}__${row.occurrence_date}`;
    let group = map.get(key);
    if (!group) {
      group = {
        key,
        occurrenceDate:   row.occurrence_date,
        startsAt:         row.starts_at,
        endsAt:           row.ends_at,
        courts:           [],
        alreadyGenerated: row.already_generated,
        hasConflict:      false,
      };
      map.set(key, group);
    }
    group.courts.push({ id: row.court_id, name: row.court_name, hasConflict: row.has_conflict });
    if (row.has_conflict) group.hasConflict = true;
  }
  return [...map.values()].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function ProgramPreviewSheet({
  programId, programTitle, programStatus, programCreatedBy,
  clubId, clubTimezone, userRole, userId, onClose, onGenerated, onEdit,
}: Props) {
  const supabase = useMemo(() => createClient(), []);
  const router   = useRouter();

  // Phase 34A: widened admin -> isOperator (admin+staff); Pro's existing
  // owner-scoped access is unchanged.
  const canManage = isOperator(userRole) || (userRole === "pro" && programCreatedBy === userId);
  const isDraft   = programStatus === "draft";
  const showEditDraft = isDraft && canManage;
  // Phase 33G4: this sheet only ever previews schedule-rule occurrences and
  // (optionally) generates new ones — it never lets staff cancel/edit/
  // operate on an individual already-generated session (that's Manage →
  // Events). "Preview & Generate" stays accurate for a draft program (nothing
  // generated yet, this IS the initial generation step); for a non-draft
  // program calling this "Manage Sessions" overstated what it does, so it's
  // labeled "Session Schedule" instead — a program-schedule surface, not an
  // individual-session management one.
  const sheetTitle = isDraft ? "Preview & Generate" : "Session Schedule";

  const [loading, setLoading]   = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rows, setRows]         = useState<PreviewRow[]>([]);

  const [confirming, setConfirming]   = useState(false);
  const [generating, setGenerating]   = useState(false);
  const [genError, setGenError]       = useState<string | null>(null);
  const [result, setResult]           = useState<GenerateResult | null>(null);

  const loadPreview = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const { data, error } = await supabase.rpc("preview_program_sessions", { p_program_id: programId });
    if (error) {
      setLoadError(mapProgramError(error.code, error.message));
    } else {
      setRows((data ?? []) as PreviewRow[]);
    }
    setLoading(false);
  }, [supabase, programId]);

  useEffect(() => {
    void loadPreview();
  }, [loadPreview]);

  const groups = useMemo(() => groupPreviewRows(rows), [rows]);

  const totalCandidates      = groups.length;
  const alreadyGeneratedCount = groups.filter(g => g.alreadyGenerated).length;
  const conflictCount        = groups.filter(g => !g.alreadyGenerated && g.hasConflict).length;
  const newlyGeneratableCount = groups.filter(g => !g.alreadyGenerated && !g.hasConflict).length;

  const allAlreadyGenerated = totalCandidates > 0 && alreadyGeneratedCount === totalCandidates;
  const canGenerate = !loading && !result && conflictCount === 0 && newlyGeneratableCount > 0;

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString("en-US", {
      timeZone: clubTimezone, weekday: "short", month: "short", day: "numeric",
    });
  }
  function formatTime(iso: string): string {
    return new Date(iso).toLocaleTimeString("en-US", {
      timeZone: clubTimezone, hour: "numeric", minute: "2-digit", hour12: true,
    });
  }

  async function handleGenerate() {
    setGenerating(true);
    setGenError(null);

    const { data, error } = await generateProgramSessions({
      p_program_id:   programId,
      expectedClubId: clubId,
    });

    if (error || !data) {
      setGenError(mapProgramError(error?.code, error?.message ?? ""));
      setGenerating(false);
      setConfirming(false);
      return;
    }

    setResult(data);
    setConfirming(false);
    setGenerating(false);
    onGenerated();
    // The Server Action already called revalidatePath("/events") and
    // revalidatePath("/calendar") — router.refresh() re-fetches this
    // route's RSC data so the already-mounted Events panel (AdminEventsClient,
    // via its initialEvents prop) actually receives the newly generated
    // events, not just a stale cache marked dirty for the next full load.
    router.refresh();
    // Refresh the preview so already_generated reflects the new state —
    // useful if the admin keeps this sheet open after generating.
    void loadPreview();
  }

  return (
    <ResponsiveSheet
      onClose={onClose}
      variant="modal"
      size="wide"
      mobileInteraction="draggable"
      label={`${sheetTitle} — ${programTitle}`}
      header={
        <>
          <div className="flex items-center justify-between gap-3">
            <button
              onClick={onClose}
              className="shrink-0 text-sm text-gray-500 dark:text-gray-400 hover:text-accent motion-safe:transition-colors motion-safe:duration-150"
            >
              ← Back to Programs
            </button>
            {showEditDraft && (
              <button
                onClick={onEdit}
                className="shrink-0 text-xs font-medium text-accent hover:brightness-110"
              >
                Edit Draft
              </button>
            )}
          </div>
          <p className="text-base font-semibold text-gray-900 dark:text-gray-100 truncate mt-2">
            {sheetTitle} — {programTitle}
          </p>
        </>
      }
    >
        <div className="space-y-4">

        {loading ? (
          <p className="text-sm text-gray-400 py-8 text-center">Loading preview…</p>
        ) : loadError ? (
          <p className="text-sm text-red-500 py-8 text-center">{loadError}</p>
        ) : (
          <>
            {/* Summary */}
            <div className="rounded-xl bg-gray-50 dark:bg-gray-700/50 border border-gray-100 dark:border-gray-700 px-4 py-3">
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-600 dark:text-gray-300">
                <span><strong className="text-gray-900 dark:text-gray-100">{totalCandidates}</strong> total occurrence{totalCandidates !== 1 ? "s" : ""}</span>
                <span><strong className="text-green-700 dark:text-green-400">{newlyGeneratableCount}</strong> ready to generate</span>
                <span><strong className="text-gray-500 dark:text-gray-400">{alreadyGeneratedCount}</strong> already generated</span>
                {conflictCount > 0 && (
                  <span><strong className="text-red-600 dark:text-red-400">{conflictCount}</strong> conflict{conflictCount !== 1 ? "s" : ""}</span>
                )}
              </div>
            </div>

            {result ? (
              <div className="rounded-xl bg-green-50 dark:bg-green-900/20 border border-green-100 dark:border-green-900/40 px-4 py-3">
                <p className="text-sm font-semibold text-green-800 dark:text-green-300">Sessions generated</p>
                <p className="text-xs text-green-700 dark:text-green-400 mt-0.5">
                  {result.inserted_count} inserted, {result.skipped_count} already existed. Find them in Manage → Events, or on the Calendar.
                </p>
              </div>
            ) : totalCandidates === 0 ? (
              <p className="text-sm text-gray-400 py-8 text-center">No occurrences fall in this program&apos;s date range.</p>
            ) : allAlreadyGenerated ? (
              <div className="rounded-xl bg-gray-50 dark:bg-gray-700/50 border border-gray-100 dark:border-gray-700 px-4 py-3">
                <p className="text-sm text-gray-600 dark:text-gray-300">Every occurrence in this program&apos;s range has already been generated. Nothing to do.</p>
              </div>
            ) : conflictCount > 0 ? (
              <p className="text-xs text-red-500">
                {showEditDraft
                  ? "Court/time conflicts block the entire batch — use Edit Draft above to change the conflicting rule's time or court, then preview again."
                  : "Court/time conflicts below block the entire batch and must be resolved before generating."}
              </p>
            ) : null}

            {/* Occurrence list */}
            {!result && (
              <div className="space-y-2">
                {groups.map(g => (
                  <div
                    key={g.key}
                    className={`rounded-lg border px-3 py-2 ${
                      g.alreadyGenerated
                        ? "border-gray-200 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-800/30"
                        : g.hasConflict
                        ? "border-red-200 dark:border-red-900/50 bg-red-50/50 dark:bg-red-900/10"
                        : "border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-medium text-gray-800 dark:text-gray-200">
                        {formatDate(g.startsAt)} · {formatTime(g.startsAt)}–{formatTime(g.endsAt)}
                      </p>
                      {g.alreadyGenerated ? (
                        <span className="shrink-0 inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400">
                          Already generated
                        </span>
                      ) : g.hasConflict ? (
                        <span className="shrink-0 inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-400">
                          Conflict
                        </span>
                      ) : (
                        <span className="shrink-0 inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">
                          Ready
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                      {g.courts.map(c => c.hasConflict ? `${c.name} ⚠` : c.name).join(", ")}
                    </p>
                  </div>
                ))}
              </div>
            )}

            {genError && <p className="text-xs text-red-500">{genError}</p>}

            {/* Generate / confirm */}
            {!result && !confirming && canGenerate && (
              <button
                onClick={() => setConfirming(true)}
                className="w-full py-3 rounded-xl bg-accent text-white dark:text-gray-900 text-sm font-semibold hover:brightness-110 motion-safe:hover:-translate-y-0.5 motion-safe:hover:shadow-md active:scale-[0.98] motion-safe:active:translate-y-0 motion-safe:transition-all motion-safe:duration-150"
              >
                Generate {newlyGeneratableCount} Session{newlyGeneratableCount !== 1 ? "s" : ""}
              </button>
            )}

            {!result && confirming && (
              <div className="rounded-xl border border-accent/40 bg-accent/5 px-4 py-3 space-y-3">
                <p className="text-sm text-gray-800 dark:text-gray-200">
                  This creates <strong>{newlyGeneratableCount}</strong> new event{newlyGeneratableCount !== 1 ? "s" : ""} (and matching court reservations) for this program. Continue?
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => setConfirming(false)}
                    disabled={generating}
                    className="flex-1 py-2 rounded-lg text-xs font-medium text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-40"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleGenerate}
                    disabled={generating}
                    className="flex-1 py-2 rounded-lg text-xs font-semibold text-white dark:text-gray-900 bg-accent hover:brightness-110 disabled:opacity-40"
                  >
                    {generating ? "Generating…" : "Confirm & Generate"}
                  </button>
                </div>
              </div>
            )}
          </>
        )}

      </div>
    </ResponsiveSheet>
  );
}
