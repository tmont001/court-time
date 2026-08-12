"use client";

import { useState, useTransition } from "react";
import AdminRequestLessonSheet from "@/app/(app)/admin/lessons/AdminRequestLessonSheet";
import {
  addMemberNoteAction,
  updateMemberNoteAction,
  archiveMemberNoteAction,
  loadMoreMemberHistoryAction,
  markAttendanceFromDetailAction,
  recordLessonOutcomeFromDetailAction,
  setLessonProviderStatusAction,
  type AddedNote,
  type HistoryItem,
} from "./actions";
import type { ClubPro } from "@/app/(app)/lessons/actions";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MemberDetail {
  id:                          string;
  first_name:                  string | null;
  last_name:                   string | null;
  phone:                       string | null;
  role:                        string;
  status:                      string;
  created_at:                  string;
  email:                       string | null;
  is_lesson_provider:          boolean;
  attended_event_count:        number;
  event_no_show_count:         number;
  completed_lesson_count:      number;
  member_lesson_no_show_count: number;
}

export interface UpcomingItem {
  activity_id:         string;
  activity_type:       "event" | "lesson" | "reservation";
  sort_ts:             string;
  status:              string;
  title:               string | null;
  starts_at:           string | null;
  ends_at:             string | null;
  court_name:          string | null;
  pro_first_name:      string | null;
  pro_last_name:       string | null;
  duration_minutes:    number | null;
  proposed_starts_at:  string | null;
  proposed_ends_at:    string | null;
  proposed_court_name: string | null;
}

export interface ClientNote {
  id:                   string;
  member_id:            string;
  author_id:            string | null;
  author_name_snapshot: string;
  content:              string;
  created_at:           string;
  updated_at:           string;
  archived_at:          string | null;
}

interface LessonType {
  id:                string;
  name:              string;
  allowed_durations: number[] | null;
}

interface Court {
  id:   string;
  name: string;
}

interface Props {
  member:         MemberDetail;
  upcomingItems:  UpcomingItem[];
  initialHistory: HistoryItem[];
  initialHasMore: boolean;
  initialNotes:   ClientNote[];
  clubId:         string;
  clubTimezone:   string;
  pros:           ClubPro[];
  courts:         Court[];
  lessonTypes:    LessonType[];
  // Phase 33D1: this Member's roster_member_id — looked up server-side by
  // claimed_by, since this page is only reachable for a Member with a
  // profiles row (always claimed). Null only if the roster backfill
  // somehow missed this account — the "Request Lesson" button is hidden
  // in that case rather than opening a sheet with no valid target.
  rosterMemberId: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDateTime(iso: string | null, tz: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    timeZone: tz, month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  });
}

function fmtDate(iso: string | null, tz: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    timeZone: tz, month: "short", day: "numeric", year: "numeric",
  });
}

function statusBadge(status: string) {
  const map: Record<string, string> = {
    active:    "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
    inactive:  "bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400",
    pending:   "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
    proposed:  "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
    confirmed: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
    declined:  "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
    withdrawn: "bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400",
    cancelled: "bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400",
  };
  const cls   = map[status] ?? "bg-gray-100 text-gray-500";
  const label = status.charAt(0).toUpperCase() + status.slice(1);
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold ${cls}`}>
      {label}
    </span>
  );
}

const OUTCOME_LABELS: Record<string, string> = {
  completed:      "Completed",
  member_no_show: "Member No-Show",
  pro_no_show:    "Pro No-Show",
};

const ATTENDANCE_OPTIONS = [
  { value: "attended", label: "Attended" },
  { value: "no_show",  label: "No Show"  },
];

const OUTCOME_OPTIONS = [
  { value: "completed",      label: "Completed"        },
  { value: "member_no_show", label: "Member No-Show"   },
  { value: "pro_no_show",    label: "Pro No-Show"      },
];

// ─── Component ────────────────────────────────────────────────────────────────

export default function MemberDetailClient({
  member,
  upcomingItems,
  initialHistory,
  initialHasMore,
  initialNotes,
  clubId,
  clubTimezone,
  pros,
  courts,
  lessonTypes,
  rosterMemberId,
}: Props) {
  const [tab, setTab] = useState<"upcoming" | "history" | "notes">("upcoming");
  const [requestSheetOpen, setRequestSheetOpen] = useState(false);

  // History state
  const [historyItems, setHistoryItems]   = useState<HistoryItem[]>(initialHistory);
  const [historyHasMore, setHistoryHasMore] = useState(initialHasMore);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyLoadError, setHistoryLoadError] = useState("");

  const lastItem = historyItems[historyItems.length - 1];
  const historyCursor = lastItem
    ? { ts: lastItem.sort_ts, type: lastItem.activity_type, id: lastItem.activity_id }
    : null;

  // Attendance state (keyed by activity_id)
  const [attendanceUpdates, setAttendanceUpdates] =
    useState<Record<string, string | null>>({});
  const [attendanceLoadingId, setAttendanceLoadingId] = useState<string | null>(null);
  const [attendanceErrors, setAttendanceErrors] =
    useState<Record<string, string>>({});

  // Outcome state (keyed by activity_id)
  const [outcomeUpdates, setOutcomeUpdates]   = useState<Record<string, string>>({});
  const [outcomeModeId,  setOutcomeModeId]    = useState<string | null>(null);
  const [outcomeLoadingId, setOutcomeLoadingId] = useState<string | null>(null);
  const [outcomeErrors, setOutcomeErrors]     = useState<Record<string, string>>({});

  // Notes state
  const [notes, setNotes]           = useState<ClientNote[]>(initialNotes);
  const [noteContent, setNoteContent] = useState("");
  const [noteAdding, setNoteAdding]   = useState(false);
  const [noteAddError, setNoteAddError] = useState("");
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editContent, setEditContent]     = useState("");
  const [noteOpLoading, setNoteOpLoading] = useState<string | null>(null);
  const [noteOpError, setNoteOpError]     = useState<Record<string, string>>({});

  // Lesson Pro designation state (admin-role targets only)
  const [lessonProviderStatus, setLessonProviderStatus] =
    useState<boolean>(member.is_lesson_provider);
  const [lessonProviderLoading, setLessonProviderLoading] = useState(false);
  const [lessonProviderError,  setLessonProviderError]  = useState("");

  const [, startTransition] = useTransition();

  const fullName = [member.first_name, member.last_name].filter(Boolean).join(" ") || "Member";

  // ── History: load more ──────────────────────────────────────────────────────

  function handleLoadMore() {
    if (!historyCursor || historyLoading) return;
    setHistoryLoading(true);
    setHistoryLoadError("");
    startTransition(async () => {
      const res = await loadMoreMemberHistoryAction(
        member.id,
        historyCursor.ts,
        historyCursor.type,
        historyCursor.id,
      );
      setHistoryLoading(false);
      if (res.error) { setHistoryLoadError(res.error); return; }
      const newItems = res.items ?? [];
      setHistoryItems(prev => [...prev, ...newItems]);
      setHistoryHasMore(newItems.length === 20);
    });
  }

  // ── Attendance ──────────────────────────────────────────────────────────────

  function handleAttendance(activityId: string, eventId: string, attendance: string | null) {
    setAttendanceErrors(prev => { const n = {...prev}; delete n[activityId]; return n; });
    setAttendanceLoadingId(activityId);
    startTransition(async () => {
      const res = await markAttendanceFromDetailAction(eventId, member.id, attendance);
      setAttendanceLoadingId(null);
      if (res.error) {
        setAttendanceErrors(prev => ({ ...prev, [activityId]: res.error! }));
        return;
      }
      setAttendanceUpdates(prev => ({ ...prev, [activityId]: attendance }));
    });
  }

  // ── Outcome ─────────────────────────────────────────────────────────────────

  function handleOutcome(activityId: string, requestId: string, outcome: string) {
    setOutcomeErrors(prev => { const n = {...prev}; delete n[activityId]; return n; });
    setOutcomeLoadingId(activityId);
    startTransition(async () => {
      const res = await recordLessonOutcomeFromDetailAction(requestId, outcome);
      setOutcomeLoadingId(null);
      if (res.error) {
        setOutcomeErrors(prev => ({ ...prev, [activityId]: res.error! }));
        return;
      }
      setOutcomeUpdates(prev => ({ ...prev, [activityId]: outcome }));
      setOutcomeModeId(null);
    });
  }

  // ── Notes ───────────────────────────────────────────────────────────────────

  function handleAddNote() {
    const trimmed = noteContent.trim();
    if (!trimmed) return;
    setNoteAdding(true);
    setNoteAddError("");
    startTransition(async () => {
      const res = await addMemberNoteAction(member.id, trimmed);
      setNoteAdding(false);
      if (res.error) { setNoteAddError(res.error); return; }
      if (res.note) {
        setNotes(prev => [res.note as AddedNote, ...prev]);
        setNoteContent("");
      }
    });
  }

  function handleEditNote(note: ClientNote) {
    setEditingNoteId(note.id);
    setEditContent(note.content);
    setNoteOpError(prev => { const n = {...prev}; delete n[note.id]; return n; });
  }

  function handleSaveEdit(noteId: string) {
    const trimmed = editContent.trim();
    if (!trimmed) return;
    setNoteOpLoading(noteId);
    startTransition(async () => {
      const res = await updateMemberNoteAction(noteId, trimmed);
      setNoteOpLoading(null);
      if (res.error) {
        setNoteOpError(prev => ({ ...prev, [noteId]: res.error! }));
        return;
      }
      setNotes(prev => prev.map(n =>
        n.id === noteId ? { ...n, content: trimmed, updated_at: new Date().toISOString() } : n
      ));
      setEditingNoteId(null);
    });
  }

  function handleArchiveNote(noteId: string) {
    setNoteOpLoading(noteId);
    startTransition(async () => {
      const res = await archiveMemberNoteAction(noteId);
      setNoteOpLoading(null);
      if (res.error) {
        setNoteOpError(prev => ({ ...prev, [noteId]: res.error! }));
        return;
      }
      setNotes(prev => prev.filter(n => n.id !== noteId));
    });
  }

  // ── Lesson Pro designation ───────────────────────────────────────────────────

  function handleLessonProviderToggle(enabled: boolean) {
    setLessonProviderLoading(true);
    setLessonProviderError("");
    startTransition(async () => {
      const res = await setLessonProviderStatusAction(member.id, enabled);
      setLessonProviderLoading(false);
      if (res.error) {
        setLessonProviderError(res.error);
        return;
      }
      setLessonProviderStatus(enabled);
    });
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="pb-8">
      {/* Profile header */}
      <div className="px-4 pt-4 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-bold text-gray-900 dark:text-gray-100">{fullName}</h1>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              {member.email ?? "—"} · {member.phone ?? "—"}
            </p>
            <p className="text-xs text-gray-400 mt-0.5">
              {member.role.charAt(0).toUpperCase() + member.role.slice(1)}
              {" · Joined "}
              {fmtDate(member.created_at, clubTimezone)}
            </p>

            {/* Lesson Pro designation — contextual per role */}
            {member.role === "member" && (
              <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                Lesson Pro: Not eligible (Member role)
              </p>
            )}
            {member.role === "pro" && (
              <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                Lesson Pro: Enabled automatically (Pro role)
              </p>
            )}
            {member.role === "admin" && (
              <div className="mt-2">
                <div className="flex items-center gap-2 flex-wrap">
                  {lessonProviderStatus ? (
                    <>
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-accent/10 text-accent">
                        Lesson Pro
                      </span>
                      <button
                        disabled={lessonProviderLoading}
                        onClick={() => handleLessonProviderToggle(false)}
                        className="text-xs text-gray-500 dark:text-gray-400 hover:text-red-600 dark:hover:text-red-400 disabled:opacity-50 motion-safe:transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
                        aria-label="Remove Lesson Pro designation"
                      >
                        {lessonProviderLoading ? "Saving…" : "Remove"}
                      </button>
                    </>
                  ) : (
                    <button
                      disabled={lessonProviderLoading}
                      onClick={() => handleLessonProviderToggle(true)}
                      className="inline-flex items-center px-2.5 py-1 rounded-lg border border-accent text-accent text-xs font-medium hover:bg-accent/10 disabled:opacity-50 motion-safe:transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                      aria-label="Enable Lesson Pro designation"
                    >
                      {lessonProviderLoading ? "Saving…" : "Enable Lesson Pro"}
                    </button>
                  )}
                </div>
                {lessonProviderError && (
                  <p className="text-xs text-red-600 dark:text-red-400 mt-1" role="alert">
                    {lessonProviderError}
                  </p>
                )}
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                  Enables this admin to receive and manage lesson assignments.
                </p>
                {member.status !== "active" && (
                  <p className="text-xs text-amber-600 dark:text-amber-400 mt-0.5">
                    This member&apos;s status is {member.status.charAt(0).toUpperCase() + member.status.slice(1)} — they won&apos;t appear in provider selectors until their membership is Active.
                  </p>
                )}
              </div>
            )}
          </div>
          {statusBadge(member.status)}
        </div>

        {/* Stats */}
        <div className="mt-3 grid grid-cols-4 gap-2">
          {[
            { label: "Events", value: member.attended_event_count },
            { label: "No-Shows", value: member.event_no_show_count },
            { label: "Lessons", value: member.completed_lesson_count },
            { label: "Lesson NS", value: member.member_lesson_no_show_count },
          ].map(s => (
            <div key={s.label} className="ct-card px-2 py-2 text-center">
              <p className="text-base font-bold text-gray-900 dark:text-gray-100">{s.value}</p>
              <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-0.5 leading-tight">{s.label}</p>
            </div>
          ))}
        </div>

        {/* Admin action: book a lesson for this member */}
        {pros.length > 0 && rosterMemberId && (
          <button
            onClick={() => setRequestSheetOpen(true)}
            className="mt-3 w-full bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 rounded-xl py-3 text-sm font-semibold hover:brightness-110 active:scale-[0.98] motion-safe:transition-all motion-safe:duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100"
          >
            Book Lesson
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 px-4 mb-4">
        {(["upcoming", "history", "notes"] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              tab === t
                ? "bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900"
                : "bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
            }`}
          >
            {t.charAt(0).toUpperCase() + t.slice(1)}
            {t === "notes" && notes.length > 0 && ` (${notes.length})`}
          </button>
        ))}
      </div>

      {/* ── Upcoming tab ─────────────────────────────────────────────────── */}
      {tab === "upcoming" && (
        <div className="px-4">
          {upcomingItems.length === 0 ? (
            <p className="text-sm text-gray-400 dark:text-gray-500 py-6 text-center">
              No upcoming activity.
            </p>
          ) : (
            <div className="space-y-2">
              {upcomingItems.map(item => (
                <div key={item.activity_id} className="ct-card px-4 py-3">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wide">
                      {item.activity_type}
                    </span>
                    {statusBadge(item.status)}
                  </div>

                  {item.activity_type === "event" && (
                    <>
                      <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                        {item.title}
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                        {fmtDateTime(item.starts_at, clubTimezone)}
                      </p>
                    </>
                  )}

                  {item.activity_type === "lesson" && (
                    <>
                      <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                        {[item.pro_first_name, item.pro_last_name].filter(Boolean).join(" ") || "Pro"}
                        {item.duration_minutes ? ` · ${item.duration_minutes} min` : ""}
                      </p>
                      {item.proposed_starts_at ? (
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                          {fmtDateTime(item.proposed_starts_at, clubTimezone)}
                          {item.proposed_court_name ? ` · ${item.proposed_court_name}` : ""}
                        </p>
                      ) : (
                        <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
                          Awaiting proposal
                        </p>
                      )}
                    </>
                  )}

                  {item.activity_type === "reservation" && (
                    <>
                      <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                        {item.court_name ?? "Court"}
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                        {fmtDateTime(item.starts_at, clubTimezone)}
                        {item.ends_at
                          ? ` – ${new Date(item.ends_at).toLocaleTimeString("en-US", {
                              timeZone: clubTimezone, hour: "numeric", minute: "2-digit", hour12: true,
                            })}`
                          : ""}
                      </p>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── History tab ──────────────────────────────────────────────────── */}
      {tab === "history" && (
        <div className="px-4">
          {historyItems.length === 0 ? (
            <p className="text-sm text-gray-400 dark:text-gray-500 py-6 text-center">
              No history yet.
            </p>
          ) : (
            <div className="space-y-2">
              {historyItems.map(item => {
                const currentAttendance =
                  attendanceUpdates[item.activity_id] !== undefined
                    ? attendanceUpdates[item.activity_id]
                    : item.attendance_status;
                const currentOutcome =
                  outcomeUpdates[item.activity_id] !== undefined
                    ? outcomeUpdates[item.activity_id]
                    : item.lesson_outcome;
                const isAttLoading = attendanceLoadingId === item.activity_id;
                const isOutLoading = outcomeLoadingId === item.activity_id;
                const isOutMode    = outcomeModeId === item.activity_id;

                return (
                  <div key={item.activity_id} className="ct-card px-4 py-3">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wide">
                        {item.activity_type}
                      </span>
                      {statusBadge(item.status)}
                    </div>

                    {item.activity_type === "event" && (
                      <>
                        <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                          {item.title}
                        </p>
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                          {fmtDateTime(item.starts_at, clubTimezone)}
                        </p>

                        {/* Attendance controls */}
                        {item.status === "confirmed" && (
                          <div className="mt-2">
                            {currentAttendance ? (
                              <div className="flex items-center gap-2">
                                <span className={`text-xs font-medium ${
                                  currentAttendance === "attended"
                                    ? "text-green-600 dark:text-green-400"
                                    : "text-red-600 dark:text-red-400"
                                }`}>
                                  {currentAttendance === "attended" ? "Attended" : "No-Show"}
                                </span>
                                <button
                                  disabled={isAttLoading}
                                  onClick={() => handleAttendance(item.activity_id, item.activity_id, null)}
                                  className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 disabled:opacity-40"
                                >
                                  Clear
                                </button>
                              </div>
                            ) : (
                              <div className="flex items-center gap-2">
                                {ATTENDANCE_OPTIONS.map(opt => (
                                  <button
                                    key={opt.value}
                                    disabled={isAttLoading}
                                    onClick={() => handleAttendance(item.activity_id, item.activity_id, opt.value)}
                                    className="px-2.5 py-1 rounded-lg text-xs font-medium border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-accent hover:text-accent motion-safe:transition-colors disabled:opacity-40"
                                  >
                                    {isAttLoading ? "Saving…" : opt.label}
                                  </button>
                                ))}
                              </div>
                            )}
                            {attendanceErrors[item.activity_id] && (
                              <p className="text-xs text-red-600 dark:text-red-400 mt-1">
                                {attendanceErrors[item.activity_id]}
                              </p>
                            )}
                          </div>
                        )}
                      </>
                    )}

                    {item.activity_type === "lesson" && (
                      <>
                        <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                          {[item.pro_first_name, item.pro_last_name].filter(Boolean).join(" ") || "Pro"}
                          {item.duration_minutes ? ` · ${item.duration_minutes} min` : ""}
                        </p>
                        {item.starts_at && (
                          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                            {fmtDateTime(item.starts_at, clubTimezone)}
                          </p>
                        )}

                        {/* Outcome controls — only for confirmed past lessons */}
                        {item.status === "confirmed" && (
                          <div className="mt-2">
                            {currentOutcome ? (
                              <div className="flex items-center gap-2">
                                <span className="text-xs font-medium text-gray-600 dark:text-gray-300">
                                  {OUTCOME_LABELS[currentOutcome] ?? currentOutcome}
                                </span>
                                <button
                                  disabled={isOutLoading}
                                  onClick={() => setOutcomeModeId(item.activity_id)}
                                  className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 disabled:opacity-40"
                                >
                                  Change
                                </button>
                              </div>
                            ) : isOutMode ? (
                              <div className="space-y-1">
                                <div className="flex flex-wrap gap-1.5">
                                  {OUTCOME_OPTIONS.map(opt => (
                                    <button
                                      key={opt.value}
                                      disabled={isOutLoading}
                                      onClick={() => handleOutcome(item.activity_id, item.activity_id, opt.value)}
                                      className="px-2.5 py-1 rounded-lg text-xs font-medium border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-accent hover:text-accent motion-safe:transition-colors disabled:opacity-40"
                                    >
                                      {isOutLoading ? "Saving…" : opt.label}
                                    </button>
                                  ))}
                                </div>
                                <button
                                  onClick={() => setOutcomeModeId(null)}
                                  className="text-xs text-gray-400 hover:text-gray-600"
                                >
                                  Cancel
                                </button>
                              </div>
                            ) : (
                              <button
                                disabled={isOutLoading}
                                onClick={() => setOutcomeModeId(item.activity_id)}
                                className="text-xs font-medium text-accent hover:underline disabled:opacity-40"
                              >
                                Record outcome
                              </button>
                            )}
                            {outcomeErrors[item.activity_id] && (
                              <p className="text-xs text-red-600 dark:text-red-400 mt-1">
                                {outcomeErrors[item.activity_id]}
                              </p>
                            )}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Load more */}
          {historyHasMore && (
            <div className="mt-3 text-center">
              <button
                onClick={handleLoadMore}
                disabled={historyLoading}
                className="text-sm text-accent hover:underline disabled:opacity-40"
              >
                {historyLoading ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
          {historyLoadError && (
            <p className="mt-2 text-xs text-red-600 dark:text-red-400 text-center">
              {historyLoadError}
            </p>
          )}
        </div>
      )}

      {/* Book Lesson sheet — Phase 33D1: books directly via roster_
          member_id, replacing the old profiles-keyed request-only flow. */}
      {requestSheetOpen && rosterMemberId && (
        <AdminRequestLessonSheet
          pros={pros}
          rosterMembers={[{
            id:      rosterMemberId,
            name:    [member.first_name, member.last_name].filter(Boolean).join(" ") || "Member",
            claimed: true,
          }]}
          courts={courts}
          lessonTypes={lessonTypes}
          clubId={clubId}
          clubTimezone={clubTimezone}
          preselectedMemberId={rosterMemberId}
          onClose={() => setRequestSheetOpen(false)}
        />
      )}

      {/* ── Notes tab ────────────────────────────────────────────────────── */}
      {tab === "notes" && (
        <div className="px-4">
          {/* Add note */}
          <div className="mb-4">
            <textarea
              value={noteContent}
              onChange={e => setNoteContent(e.target.value)}
              placeholder="Add a note about this member…"
              rows={3}
              maxLength={1000}
              className="w-full ct-input text-base md:text-sm resize-none"
            />
            {noteAddError && (
              <p className="mt-1 text-xs text-red-600 dark:text-red-400">{noteAddError}</p>
            )}
            <button
              onClick={handleAddNote}
              disabled={noteAdding || !noteContent.trim()}
              className="mt-2 px-4 py-2 rounded-xl bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-medium disabled:opacity-50"
            >
              {noteAdding ? "Adding…" : "Add Note"}
            </button>
          </div>

          {notes.length === 0 ? (
            <p className="text-sm text-gray-400 dark:text-gray-500 py-4 text-center">
              No notes yet.
            </p>
          ) : (
            <div className="space-y-2">
              {notes.map(note => (
                <div key={note.id} className="ct-card px-4 py-3">
                  {editingNoteId === note.id ? (
                    <div className="space-y-2">
                      <textarea
                        value={editContent}
                        onChange={e => setEditContent(e.target.value)}
                        rows={3}
                        maxLength={1000}
                        autoFocus
                        className="w-full ct-input text-base md:text-sm resize-none"
                      />
                      {noteOpError[note.id] && (
                        <p className="text-xs text-red-600 dark:text-red-400">{noteOpError[note.id]}</p>
                      )}
                      <div className="flex gap-3">
                        <button
                          disabled={noteOpLoading === note.id}
                          onClick={() => handleSaveEdit(note.id)}
                          className="text-xs font-medium text-accent disabled:opacity-40"
                        >
                          {noteOpLoading === note.id ? "Saving…" : "Save"}
                        </button>
                        <button
                          onClick={() => { setEditingNoteId(null); setEditContent(""); }}
                          className="text-xs text-gray-400"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap">
                        {note.content}
                      </p>
                      <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-1.5">
                        {note.author_name_snapshot || "Admin"} · {fmtDate(note.created_at, clubTimezone)}
                      </p>
                      {noteOpError[note.id] && (
                        <p className="text-xs text-red-600 dark:text-red-400 mt-1">{noteOpError[note.id]}</p>
                      )}
                      <div className="flex gap-3 mt-2">
                        <button
                          onClick={() => handleEditNote(note)}
                          className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                        >
                          Edit
                        </button>
                        <button
                          disabled={noteOpLoading === note.id}
                          onClick={() => handleArchiveNote(note.id)}
                          className="text-xs text-red-400 hover:text-red-600 dark:hover:text-red-300 disabled:opacity-40"
                        >
                          {noteOpLoading === note.id ? "Removing…" : "Remove"}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
