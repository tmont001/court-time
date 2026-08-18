"use client";

// ProgramsManageClient — Phase 27C Programs list, rendered inside
// ManageSubview's "Programs" sub-tab. Generated sessions are ordinary
// events rows (viewed via the existing Events/Calendar surfaces, not a new
// roster/session UI here) — this component only ever lists program
// definitions and opens the create/preview-generate sheets.

import { useState, useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import CreateProgramSheet from "./CreateProgramSheet";
import ProgramPreviewSheet from "./ProgramPreviewSheet";
import ProgramRosterSheet from "./ProgramRosterSheet";
import {
  getPrograms,
  cancelProgram,
  completeProgram,
  archiveProgram,
  unarchiveProgram,
  type ProgramListRow,
  type ProgramRow,
  type ProgramArchiveView,
} from "./programsActions";
import { mapProgramError } from "./programErrors";
import {
  ACTION_BUTTON_PRIMARY,
  ACTION_BUTTON_SECONDARY,
  ACTION_BUTTON_DESTRUCTIVE,
  ACTION_BUTTON_DESTRUCTIVE_COMPACT,
} from "./actionButtonStyles";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Court {
  id:            string;
  name:          string;
  display_order: number;
}

interface Props {
  initialPrograms: ProgramListRow[];
  initialError?:   string;
  courts:          Court[];
  clubId:          string;
  clubTimezone:    string;
  userRole:        string;
  userId:          string;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTimeOfDay(time: string): string {
  const [hStr, mStr] = time.split(":");
  const h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  const h12 = h % 12 || 12;
  const ampm = h < 12 ? "AM" : "PM";
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

function formatDateOnly(dateISO: string): string {
  // starts_on/ends_on are plain dates (YYYY-MM-DD) — format without any
  // timezone conversion, since there is no time-of-day component to shift.
  const [y, m, d] = dateISO.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    timeZone: "UTC", month: "short", day: "numeric", year: "numeric",
  });
}

function formatNextSession(iso: string, tz: string): string {
  const datePart = new Date(iso).toLocaleDateString("en-US", { timeZone: tz, month: "short", day: "numeric" });
  const timePart = new Date(iso).toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true });
  return `${datePart} ${timePart}`;
}

function recurrenceSummary(rules: ProgramListRow["rules"]): string {
  if (rules.length === 0) return "No schedule rules";
  return rules.map(r => `${DAY_NAMES[r.day_of_week]} ${formatTimeOfDay(r.start_time)} (${r.duration_minutes}m)`).join(", ");
}

function enrollmentModelLabel(model: ProgramListRow["enrollment_model"]): string {
  return model === "program" ? "Whole program" : model === "per_session" ? "Per session" : "Admin managed";
}

function statusBadgeClass(status: ProgramListRow["status"]): string {
  switch (status) {
    case "active":    return "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400";
    case "cancelled": return "bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400";
    case "completed": return "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400";
    default:          return "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400"; // draft
  }
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function ProgramsManageClient({
  initialPrograms, initialError, courts, clubId, clubTimezone, userRole, userId,
}: Props) {
  const router = useRouter();
  const [programs, setPrograms] = useState<ProgramListRow[]>(initialPrograms);
  const [fetchError, setFetchError] = useState<string | null>(initialError ?? null);
  const [isPending, startTransition] = useTransition();

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ProgramListRow | null>(null);
  const [previewing, setPreviewing] = useState<{
    id: string; title: string; status: ProgramListRow["status"]; createdBy: string;
  } | null>(null);
  const [viewingRoster, setViewingRoster] = useState<ProgramListRow | null>(null);

  // Phase 27E: Active / Archived / All — mirrors fetchMoreAdminEvents'
  // ArchiveView shape (admin/events/actions.ts) exactly. Changing this
  // re-fetches via the same client-side refresh() path already used after
  // create/generate, rather than requiring a page.tsx round trip.
  const [archiveView, setArchiveView] = useState<ProgramArchiveView>("active");

  // Phase 27E: lifecycle action state (cancel/complete/archive/unarchive) —
  // same per-row updating/error map shape already established in
  // ProgramRosterSheet, and the same inline expand-in-place confirmation
  // pattern for the two destructive actions (cancel, archive).
  const [lifecycleUpdating, setLifecycleUpdating] = useState<Set<string>>(new Set());
  const [lifecycleErrors, setLifecycleErrors]     = useState<Map<string, string>>(new Map());
  const [confirmingAction, setConfirmingAction]   = useState<{ programId: string; action: "cancel" | "archive" } | null>(null);

  // Sync when the RSC parent refreshes (router.refresh() after a create).
  useEffect(() => {
    setPrograms(initialPrograms);
    if (initialError) setFetchError(initialError);
  }, [initialPrograms, initialError]);

  function refresh() {
    startTransition(async () => {
      const result = await getPrograms(clubId, archiveView);
      if ("error" in result) {
        setFetchError(result.error);
      } else {
        setFetchError(null);
        setPrograms(result.programs);
      }
    });
  }

  function handleArchiveViewChange(next: ProgramArchiveView) {
    setArchiveView(next);
    startTransition(async () => {
      const result = await getPrograms(clubId, next);
      if ("error" in result) {
        setFetchError(result.error);
      } else {
        setFetchError(null);
        setPrograms(result.programs);
      }
    });
  }

  async function runLifecycleAction(
    programId: string,
    action: () => Promise<{ data?: ProgramRow; error?: { code?: string; message: string } }>,
  ) {
    setLifecycleUpdating(prev => new Set(prev).add(programId));
    setLifecycleErrors(prev => { const next = new Map(prev); next.delete(programId); return next; });

    const result = await action();

    setLifecycleUpdating(prev => { const next = new Set(prev); next.delete(programId); return next; });
    setConfirmingAction(null);

    if (result.error) {
      setLifecycleErrors(prev => new Map(prev).set(programId, mapProgramError(result.error!.code, result.error!.message)));
      return;
    }
    refresh();
    router.refresh();
  }

  const handleCancel     = (id: string) => runLifecycleAction(id, () => cancelProgram({ p_program_id: id, expectedClubId: clubId }));
  const handleComplete   = (id: string) => runLifecycleAction(id, () => completeProgram({ p_program_id: id, expectedClubId: clubId }));
  const handleArchive    = (id: string) => runLifecycleAction(id, () => archiveProgram({ p_program_id: id, expectedClubId: clubId }));
  const handleUnarchive  = (id: string) => runLifecycleAction(id, () => unarchiveProgram({ p_program_id: id, expectedClubId: clubId }));

  // Client-side hint only — the RPC itself is authoritative and re-checks
  // this same rule (window ended in the club's own timezone, or no future
  // scheduled session remains) before honoring complete_program. Computed
  // once per render rather than per card.
  const todayInClub = new Date().toLocaleDateString("en-CA", { timeZone: clubTimezone });

  // Shared by both create and edit-draft saves: refresh the list, then
  // (re)open Preview for the saved program — the user still has to
  // explicitly confirm generation inside that sheet either way. Only the
  // plain ProgramRow the RPC returns is needed here (id/title/status/
  // created_by), not the enriched ProgramListRow the list refresh will
  // eventually produce.
  function handleProgramSaved(program: ProgramRow) {
    setCreating(false);
    setEditing(null);
    refresh();
    setPreviewing({ id: program.id, title: program.title, status: program.status, createdBy: program.created_by });
  }

  // Preview's Edit Draft button has no program reference of its own — look
  // it up from current list state by the id already being previewed.
  function handleEditFromPreview() {
    if (!previewing) return;
    const program = programs.find(p => p.id === previewing.id);
    if (!program) return;
    setPreviewing(null);
    setEditing(program);
  }

  const createButton = (
    <button
      onClick={() => setCreating(true)}
      className={ACTION_BUTTON_PRIMARY}
    >
      + Create Program
    </button>
  );

  return (
    <div className="pb-6 pt-3">
      <div className="px-4 pb-3 flex items-center justify-between gap-2">
        <p className="text-xs text-gray-400 dark:text-gray-500 shrink-0">{isPending ? "Refreshing…" : `${programs.length} program${programs.length !== 1 ? "s" : ""}`}</p>
        <div className="flex items-center gap-2">
          {/* Phase 27E: Active / Archived / All — only meaningful once
              programs can actually be archived; matches the equivalent
              control already on the sibling Events manage surface. */}
          <div className="relative">
            <select
              value={archiveView}
              onChange={e => handleArchiveViewChange(e.target.value as ProgramArchiveView)}
              className="appearance-none pl-3 pr-7 py-1.5 rounded-lg text-base md:text-xs font-medium bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border border-gray-200 dark:border-gray-700 shadow-sm cursor-pointer focus:outline-none focus:ring-1 focus:ring-gray-300 dark:focus:ring-gray-600"
            >
              <option value="active">Active</option>
              <option value="archived">Archived</option>
              <option value="all">All</option>
            </select>
            <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500 text-[10px]">▾</span>
          </div>
          {createButton}
        </div>
      </div>

      {fetchError ? (
        <div className="flex flex-col items-center justify-center h-40 gap-2 text-gray-400 dark:text-gray-500 text-sm px-8 text-center">
          <span className="text-red-500">{fetchError}</span>
          <button onClick={refresh} className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 underline">
            Try again
          </button>
        </div>
      ) : programs.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-40 gap-1 text-gray-400 dark:text-gray-500 text-sm px-8 text-center">
          <span>{archiveView === "archived" ? "No archived programs." : "No programs yet."}</span>
          {archiveView === "active" && (
            <span className="text-xs">Create a recurring clinic, camp, or league to get started.</span>
          )}
        </div>
      ) : (
        programs.map(p => {
          const canManage = userRole === "admin" || (userRole === "pro" && p.created_by === userId);
          const isDraft    = p.status === "draft";
          const isArchived = p.archived_at !== null;

          // Client-side eligibility hint only — see todayInClub above.
          // complete_program itself re-validates this same rule.
          const canComplete = p.status === "active" && !isArchived &&
            (p.ends_on < todayInClub || p.next_session_starts_at === null);

          const isUpdating       = lifecycleUpdating.has(p.id);
          const lifecycleError   = lifecycleErrors.get(p.id);
          const isConfirmingThis = confirmingAction?.programId === p.id;
          const confirmingCancel = isConfirmingThis && confirmingAction?.action === "cancel";
          const confirmingArchive = isConfirmingThis && confirmingAction?.action === "archive";

          return (
            <div key={p.id} className="ct-card mx-4 mb-3 px-4 py-3">
              {/* Badges */}
              <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
                {p.event_type && (
                  <span
                    className="inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold text-white"
                    style={{ background: p.event_type.color }}
                  >
                    {p.event_type.label}
                  </span>
                )}
                <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold capitalize ${statusBadgeClass(p.status)}`}>
                  {p.status}
                </span>
                <span className="inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400">
                  {enrollmentModelLabel(p.enrollment_model)}
                </span>
              </div>

              {/* Title */}
              <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{p.title}</p>

              {/* Date range + capacity + recurrence */}
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                {formatDateOnly(p.starts_on)} – {formatDateOnly(p.ends_on)} · {p.default_capacity} spot{p.default_capacity !== 1 ? "s" : ""}
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                {recurrenceSummary(p.rules)}
              </p>

              {/* Creator + generated count + next session */}
              <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                By {p.creator_name} · {p.generated_count} session{p.generated_count !== 1 ? "s" : ""} generated
                {p.next_session_starts_at && ` · next ${formatNextSession(p.next_session_starts_at, clubTimezone)}`}
              </p>

              {/* Actions */}
              {canManage && (
                <>
                  <div className="flex flex-wrap gap-2 mt-2.5 pt-2.5 border-t border-gray-100 dark:border-gray-700">
                    {isArchived ? (
                      <>
                        <button
                          disabled={isUpdating}
                          onClick={() => handleUnarchive(p.id)}
                          className={ACTION_BUTTON_PRIMARY}
                        >
                          {isUpdating ? "Unarchiving…" : "Unarchive"}
                        </button>
                      </>
                    ) : isDraft ? (
                      <>
                        {!confirmingCancel && (
                          <button
                            disabled={isUpdating}
                            onClick={() => setConfirmingAction({ programId: p.id, action: "cancel" })}
                            className={ACTION_BUTTON_DESTRUCTIVE}
                          >
                            Cancel
                          </button>
                        )}
                        <button
                          onClick={() => setPreviewing({ id: p.id, title: p.title, status: p.status, createdBy: p.created_by })}
                          className={ACTION_BUTTON_PRIMARY}
                        >
                          Preview &amp; Generate
                        </button>
                      </>
                    ) : p.status === "active" ? (
                      <>
                        {/* Phase 27D3B: whole-program roster management —
                            per_session/admin_managed have no
                            program_enrollments rows to manage here. */}
                        {p.enrollment_model === "program" && (
                          <button onClick={() => setViewingRoster(p)} className={ACTION_BUTTON_SECONDARY}>
                            Roster
                          </button>
                        )}
                        {canComplete && (
                          <button
                            disabled={isUpdating}
                            onClick={() => handleComplete(p.id)}
                            className={ACTION_BUTTON_SECONDARY}
                          >
                            {isUpdating ? "Completing…" : "Complete"}
                          </button>
                        )}
                        {!confirmingCancel && (
                          <button
                            disabled={isUpdating}
                            onClick={() => setConfirmingAction({ programId: p.id, action: "cancel" })}
                            className={ACTION_BUTTON_DESTRUCTIVE}
                          >
                            Cancel
                          </button>
                        )}
                        <button
                          onClick={() => setPreviewing({ id: p.id, title: p.title, status: p.status, createdBy: p.created_by })}
                          className={ACTION_BUTTON_PRIMARY}
                        >
                          Manage Sessions
                        </button>
                      </>
                    ) : (
                      // status is 'cancelled' or 'completed', not yet archived
                      <>
                        {!confirmingArchive && (
                          <button
                            disabled={isUpdating}
                            onClick={() => setConfirmingAction({ programId: p.id, action: "archive" })}
                            className={ACTION_BUTTON_DESTRUCTIVE}
                          >
                            Archive
                          </button>
                        )}
                      </>
                    )}
                  </div>

                  {/* Inline destructive confirmation — Cancel and Archive
                      both require an explicit second click naming the
                      action, matching ProgramRosterSheet's Remove flow. */}
                  {(confirmingCancel || confirmingArchive) && (
                    <div className="mt-2 flex items-center gap-2 flex-wrap bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/60 rounded-lg px-3 py-2">
                      <p className="text-xs text-red-700 dark:text-red-400 flex-1 min-w-0">
                        {confirmingCancel
                          ? `Cancel "${p.title}"? This cancels all future generated sessions and releases their court reservations.`
                          : `Archive "${p.title}"? It will move out of the active Programs list.`}
                      </p>
                      <button
                        disabled={isUpdating}
                        onClick={() => confirmingCancel ? handleCancel(p.id) : handleArchive(p.id)}
                        className={ACTION_BUTTON_DESTRUCTIVE_COMPACT}
                      >
                        {isUpdating ? "Working…" : confirmingCancel ? "Confirm Cancel" : "Confirm Archive"}
                      </button>
                      <button
                        disabled={isUpdating}
                        onClick={() => setConfirmingAction(null)}
                        className="text-xs text-gray-500 dark:text-gray-400"
                      >
                        Never mind
                      </button>
                    </div>
                  )}

                  {lifecycleError && (
                    <p className="text-xs text-red-500 mt-1.5">{lifecycleError}</p>
                  )}
                </>
              )}
            </div>
          );
        })
      )}

      {creating && (
        <CreateProgramSheet
          courts={courts}
          clubId={clubId}
          clubTimezone={clubTimezone}
          onClose={() => setCreating(false)}
          onSaved={handleProgramSaved}
        />
      )}

      {editing && (
        <CreateProgramSheet
          mode="edit"
          editingProgram={editing}
          courts={courts}
          clubId={clubId}
          clubTimezone={clubTimezone}
          onClose={() => setEditing(null)}
          onSaved={handleProgramSaved}
        />
      )}

      {previewing && (
        <ProgramPreviewSheet
          programId={previewing.id}
          programTitle={previewing.title}
          programStatus={previewing.status}
          programCreatedBy={previewing.createdBy}
          clubId={clubId}
          clubTimezone={clubTimezone}
          userRole={userRole}
          userId={userId}
          onClose={() => setPreviewing(null)}
          onGenerated={refresh}
          onEdit={handleEditFromPreview}
        />
      )}

      {viewingRoster && (
        <ProgramRosterSheet
          programId={viewingRoster.id}
          programTitle={viewingRoster.title}
          clubId={clubId}
          clubTimezone={clubTimezone}
          onClose={() => setViewingRoster(null)}
        />
      )}
    </div>
  );
}
