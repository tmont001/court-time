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
import { getPrograms, type ProgramListRow, type ProgramRow } from "./programsActions";
import { ACTION_BUTTON_PRIMARY, ACTION_BUTTON_SECONDARY } from "./actionButtonStyles";

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

  // Sync when the RSC parent refreshes (router.refresh() after a create).
  useEffect(() => {
    setPrograms(initialPrograms);
    if (initialError) setFetchError(initialError);
  }, [initialPrograms, initialError]);

  function refresh() {
    startTransition(async () => {
      const result = await getPrograms(clubId);
      if ("error" in result) {
        setFetchError(result.error);
      } else {
        setFetchError(null);
        setPrograms(result.programs);
      }
    });
  }

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

  function viewSessions(title: string) {
    // Close any open Programs sheet/state first — View Sessions is a full
    // subview switch (Programs -> Events), so nothing from Programs should
    // still be open underneath it afterwards.
    setCreating(false);
    setEditing(null);
    setPreviewing(null);
    router.push(`/events?tab=manage&manageView=events&q=${encodeURIComponent(title)}`);
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
      <div className="px-4 pb-3 flex items-center justify-between">
        <p className="text-xs text-gray-400 dark:text-gray-500">{isPending ? "Refreshing…" : `${programs.length} program${programs.length !== 1 ? "s" : ""}`}</p>
        {createButton}
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
          <span>No programs yet.</span>
          <span className="text-xs">Create a recurring clinic, camp, or league to get started.</span>
        </div>
      ) : (
        programs.map(p => {
          const canManage = userRole === "admin" || (userRole === "pro" && p.created_by === userId);
          const isDraft   = p.status === "draft";

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
                <div className="flex flex-wrap gap-2 mt-2.5 pt-2.5 border-t border-gray-100 dark:border-gray-700">
                  {isDraft ? (
                    <button
                      onClick={() => setPreviewing({ id: p.id, title: p.title, status: p.status, createdBy: p.created_by })}
                      className={ACTION_BUTTON_PRIMARY}
                    >
                      Preview &amp; Generate
                    </button>
                  ) : (
                    <>
                      <button
                        onClick={() => viewSessions(p.title)}
                        className={ACTION_BUTTON_SECONDARY}
                      >
                        View Sessions
                      </button>
                      <button
                        onClick={() => setPreviewing({ id: p.id, title: p.title, status: p.status, createdBy: p.created_by })}
                        className={ACTION_BUTTON_PRIMARY}
                      >
                        Manage Sessions
                      </button>
                    </>
                  )}
                </div>
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
    </div>
  );
}
