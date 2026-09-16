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
// Phase 42C-3B — shared with MembersClient's unclaimed-roster Membership
// editor (admin/members/actions.ts, one directory up): both surfaces
// mutate the same roster_members row through the same two 0188 RPCs, so
// this imports the existing thin wrappers directly rather than
// duplicating the RPC-call/error-mapping logic in this file's own
// actions.ts. Not a new abstraction layer — a plain function import.
import {
  setRosterMemberMembershipStatusAction,
  setRosterMemberMembershipTypeAction,
} from "../actions";
import type { ClubPro } from "@/app/(app)/lessons/actions";
import PaymentStateBadge from "@/components/PaymentStateBadge";
import type { PaymentStateRow } from "@/lib/payments";
import { ACTION_BUTTON_PRIMARY_COMPACT, ACTION_BUTTON_DESTRUCTIVE_COMPACT } from "@/components/styles/actionButtonStyles";

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
  // Phase 42C-3B — 0191 widened get_admin_member_detail to return these.
  // Nullable: a legacy/edge-case claimed profile with no matching
  // roster_members row (0191's own LEFT JOIN) reports null, not a
  // fabricated default — distinct from roster_members.status above,
  // which is club_memberships lifecycle status, never Membership Status.
  membership_status:    "active" | "inactive" | "suspended" | "non_member" | null;
  membership_type_id:   string | null;
  membership_type_name: string | null;
}

export type MembershipTypeOption = { id: string; name: string };

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
  id:                       string;
  name:                     string;
  allowed_durations:        number[] | null;
  pricing_basis:            "flat" | "hourly";
  unit_price_amount_cents:  number | null;
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
  currency:       string;
  pros:           ClubPro[];
  courts:         Court[];
  lessonTypes:    LessonType[];
  // Phase 33D1: this Member's roster_member_id — looked up server-side by
  // claimed_by, since this page is only reachable for a Member with a
  // profiles row (always claimed). Null only if the roster backfill
  // somehow missed this account — the "Request Lesson" button is hidden
  // in that case rather than opening a sheet with no valid target.
  rosterMemberId: string | null;
  // Phase 33G2: this route is admin-only (page.tsx redirects any non-admin
  // away), so AdminRequestLessonSheet is always used in viewerRole="admin"
  // mode here — adminId is only needed to satisfy that prop, never used
  // as a Pro-self-booking identity on this page.
  adminId: string;
  // Phase 34C — lightweight, read-only financial summary. Keyed by
  // `${activity_type}:${activity_id}`, matching UpcomingItem's own fields,
  // so each row can look its own state up directly. This route is
  // admin-only (isOperator, never Pro) — Record Payment lives on the
  // domain's own detail sheet (Reservation/Lesson/Event roster), not
  // duplicated here; this is a summary view, not a management surface.
  paymentStateByActivityKey: Record<string, PaymentStateRow>;
  // Phase 42C-3B
  membershipsEnabled: boolean;
  // Active Membership Types only (the newly-assignable pool) — empty for
  // a Staff caller (page.tsx never queries membership_types for Staff,
  // admin-only RLS, never broadened here). Staff's read-only display
  // needs no separate list at all: member.membership_type_name already
  // has what it needs from 0191.
  membershipTypes: MembershipTypeOption[];
  // Gates edit vs. read-only rendering of the Membership block below —
  // isOperator (admin+staff) already gates the whole route; this
  // distinguishes the two within it. Never used for anything but that
  // render decision — the real enforcement is server-side (0188's RPCs
  // are Admin-only regardless of what this value says).
  userRole: string;
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

// UX correction pass — the member-lifecycle call site below now pairs
// this with a separate muted "Club status" label rather than baking a
// "Club status: " prefix into the pill itself (which made the pill too
// wide on mobile) — matching the same label+badge split already used on
// /admin/members' claimed cards. statusBadge() itself is unchanged from
// its long-standing shape/signature, shared as-is with event/lesson
// status badges elsewhere in this file (upcoming/history items).
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

// Phase 42C-3B — same label map as MembersClient's own membershipLine
// helper (admin/members/MembersClient.tsx), duplicated rather than
// imported: these are two separate client component files, and this
// project's established convention is small per-file display helpers
// (no shared Badge/formatting module exists anywhere in this codebase).
const MEMBERSHIP_STATUS_LABELS: Record<string, string> = {
  active:     "Active",
  inactive:   "Inactive",
  suspended:  "Suspended",
  non_member: "Non-Member",
};

// UX polish pass — subtle/soft badge tones (border + 50-weight bg, not the
// more saturated 100-weight fills ProfileCard/Lesson Pro use elsewhere for
// LIFECYCLE status): Membership Status is a deliberately quieter signal
// than account access, so it gets a visually calmer treatment. Same
// palette shape as the existing toneClassName soft-badge convention
// (src/lib/payments.ts) — border + bg-50/900-20 + text — reused here as
// the same visual LANGUAGE, not the same function (different domain/type).
const MEMBERSHIP_STATUS_BADGE_CLASSES: Record<string, string> = {
  active:     "text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800",
  suspended:  "text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800",
  inactive:   "text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700",
  non_member: "text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-slate-800/40 border-slate-200 dark:border-slate-700",
};

// Membership Type is NOT a status — deliberately non-semantic: a neutral
// outlined pill, the same regardless of which type or its active state,
// so it can never be mistaken for a status color.
const MEMBERSHIP_TYPE_BADGE_CLASSES =
  "text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-600";

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
  currency,
  pros,
  courts,
  lessonTypes,
  rosterMemberId,
  adminId,
  paymentStateByActivityKey,
  membershipsEnabled,
  membershipTypes,
  userRole,
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

  // Phase 42C-3B — Membership block (Admin edit / Staff read-only). Local
  // state resynced optimistically on a successful mutation, matching the
  // Lesson Pro block's own pattern above — this shared roster action
  // (setRosterMemberMembershipStatusAction/setRosterMemberMembershipTypeAction,
  // "../actions") only revalidates the LIST route, not this detail route,
  // so local state is what keeps this page's own display current.
  const [membershipStatus, setMembershipStatus] =
    useState<"active" | "inactive" | "suspended" | "non_member" | null>(member.membership_status);
  const [membershipTypeId, setMembershipTypeId] = useState<string | null>(member.membership_type_id);
  const [membershipTypeName, setMembershipTypeName] = useState<string | null>(member.membership_type_name);
  const [membershipStatusLoading, setMembershipStatusLoading] = useState(false);
  const [membershipTypeLoading, setMembershipTypeLoading] = useState(false);
  const [membershipStatusError, setMembershipStatusError] = useState("");
  const [membershipTypeError, setMembershipTypeError] = useState("");

  const [, startTransition] = useTransition();

  const fullName = [member.first_name, member.last_name].filter(Boolean).join(" ") || "Member";

  // Phase 42C-3B — same "currently-assigned inactive type stays visibly
  // selectable, no other inactive type does" rule as MembersClient's
  // roster editor. membershipTypes (prop) is already active-only.
  const isMembershipAdmin = userRole === "admin";
  const membershipTypeOptions: (MembershipTypeOption & { inactive?: boolean })[] = [
    ...membershipTypes,
    ...(membershipTypeId && !membershipTypes.some((t) => t.id === membershipTypeId)
      ? [{ id: membershipTypeId, name: membershipTypeName ?? "Unknown type", inactive: true }]
      : []),
  ];
  // UX polish pass — only computable for Admin (membershipTypes is the
  // active-only pool, empty for Staff by design — see this file's own
  // Props comment on membershipTypes). Never annotate for Staff: with an
  // empty pool, this would otherwise evaluate true for EVERY assigned
  // type, not just genuinely inactive ones.
  const isCurrentTypeInactive =
    isMembershipAdmin && membershipTypeId !== null && !membershipTypes.some((t) => t.id === membershipTypeId);

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

  // ── Membership (Admin edit only — Staff never calls these; the block
  //    below renders read-only for Staff with no onClick handlers at all) ──

  function handleMembershipStatusChange(status: "active" | "inactive" | "suspended" | "non_member") {
    if (!rosterMemberId) return;
    setMembershipStatusLoading(true);
    setMembershipStatusError("");
    startTransition(async () => {
      const res = await setRosterMemberMembershipStatusAction(rosterMemberId, status);
      setMembershipStatusLoading(false);
      if (res.error) {
        setMembershipStatusError(res.error);
        return;
      }
      setMembershipStatus(status);
    });
  }

  function handleMembershipTypeChange(typeId: string, typeName: string | null) {
    if (!rosterMemberId) return;
    setMembershipTypeLoading(true);
    setMembershipTypeError("");
    startTransition(async () => {
      const res = await setRosterMemberMembershipTypeAction(rosterMemberId, typeId || null);
      setMembershipTypeLoading(false);
      if (res.error) {
        setMembershipTypeError(res.error);
        return;
      }
      setMembershipTypeId(typeId || null);
      setMembershipTypeName(typeId ? typeName : null);
    });
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="pb-8">
      {/* Profile header */}
      <div className="px-4 pt-4 pb-3">
        {/* UX correction pass — Member Detail mobile hierarchy. Three
            clearly separated groups (Identity, Lesson Pro, Membership),
            each with its own border-t + pt-3 breathing room once it has
            a prior group above it, replacing the previous single
            undifferentiated column where all three ran together with
            only 1-2 unit margins between them. Club status moved out of
            the top-right corner (where it forced a two-column
            items-start layout for the whole header) down into the
            Identity group itself, right under role/joined — and split
            into a muted "Club status" label + the existing compact
            semantic badge (statusBadge, unprefixed) rather than one wide
            pill carrying the whole phrase, matching the same treatment
            already used on /admin/members' claimed cards. */}

        {/* ── Identity group ── */}
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
          <div className="mt-1.5 flex items-center gap-1.5">
            <span className="text-[11px] text-gray-400 dark:text-gray-500">Club status</span>
            {statusBadge(member.status)}
          </div>
        </div>

        {/* ── Lesson Pro group — contextual per role ── */}
        <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-800">
          <p className="text-xs font-medium text-gray-700 dark:text-gray-300">Lesson Pro</p>
          {member.role === "member" && (
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
              Not eligible (Member role)
            </p>
          )}
          {member.role === "pro" && (
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
              Enabled automatically (Pro role)
            </p>
          )}
          {/* Phase 34A: Staff's provider status is optional, unlike Pro's
              automatic grant — same toggle as Admin's block below.
              set_lesson_provider_status (0131) already accepts role in
              ('admin','staff') as a valid toggle target. Deliberately
              worded as a "designation"/"capability", never a "role" —
              this toggle changes lesson-provider eligibility only, not
              the member's own Staff/Admin role. State (Enabled/Not
              enabled) and action (Enable/Disable) are kept visually
              distinct so the enabled state can't be mistaken for inert
              metadata, reusing the same green/gray pill tokens as
              statusBadge and the shared compact action-button styles. */}
          {(member.role === "admin" || member.role === "staff") && (
            <div className="mt-1">
              <div className="flex items-center gap-2 flex-wrap">
                {lessonProviderStatus ? (
                  <>
                    <span className="inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                      Enabled
                    </span>
                    <button
                      disabled={lessonProviderLoading}
                      onClick={() => handleLessonProviderToggle(false)}
                      className={ACTION_BUTTON_DESTRUCTIVE_COMPACT}
                      aria-label="Disable Lesson Pro designation"
                    >
                      {lessonProviderLoading ? "Saving…" : "Disable"}
                    </button>
                  </>
                ) : (
                  <>
                    <span className="inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400">
                      Not enabled
                    </span>
                    <button
                      disabled={lessonProviderLoading}
                      onClick={() => handleLessonProviderToggle(true)}
                      className={ACTION_BUTTON_PRIMARY_COMPACT}
                      aria-label="Enable Lesson Pro designation"
                    >
                      {lessonProviderLoading ? "Saving…" : "Enable"}
                    </button>
                  </>
                )}
              </div>
              {lessonProviderError && (
                <p className="text-xs text-red-600 dark:text-red-400 mt-1" role="alert">
                  {lessonProviderError}
                </p>
              )}
              <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                Enables this {member.role} to receive and manage lesson assignments.
              </p>
              {member.status !== "active" && (
                <p className="text-xs text-amber-600 dark:text-amber-400 mt-0.5">
                  This member&apos;s status is {member.status.charAt(0).toUpperCase() + member.status.slice(1)} — they won&apos;t appear in provider selectors until their membership is Active.
                </p>
              )}
            </div>
          )}
        </div>

        {/* ── Membership group (Phase 42C-3B) ──
            Distinct heading ("Membership") and field labels ("Membership
            Status" / "Membership Type") so this can never be confused
            with member.status above (roster/lifecycle status — a
            different concept entirely, never renamed or merged with
            this). Hidden entirely when Memberships are off; nothing here
            ever clears membership_status/membership_type_id — hiding is
            a display gate only.
            Pill+select redundancy removed: each role sees exactly ONE
            representation per field. Staff (or Admin with no
            rosterMemberId to edit) sees a read-only pill — semantic
            color for Status, neutral for Type. Admin sees ONLY the
            editable <select>, itself styled with the same
            semantic/neutral color classes the pill used to carry, so the
            select IS the "pill" now rather than sitting beside a
            separate one. Type's "(inactive type)" suffix appears in both
            the pill and the select's own option text — never implying
            the PERSON's membership is inactive, only the assigned type
            itself.
            UX correction pass — Admin's selects now use the available
            width on mobile (w-full) rather than a tiny compact pill,
            settling back to compact/auto-width at sm+ where there's
            plenty of room; Staff's read-only pills are unaffected (they
            were never the width problem). */}
        {membershipsEnabled && (
          <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-800">
            <p className="text-xs font-medium text-gray-700 dark:text-gray-300">Membership</p>

            <div className="mt-1.5">
              <p className="text-[11px] text-gray-400 dark:text-gray-500">Membership Status</p>
              <div className="mt-0.5">
                {isMembershipAdmin && rosterMemberId ? (
                  <select
                    value={membershipStatus ?? ""}
                    disabled={membershipStatusLoading}
                    onChange={(e) => handleMembershipStatusChange(e.target.value as "active" | "inactive" | "suspended" | "non_member")}
                    className={`w-full sm:w-auto px-2.5 py-1 rounded-full border text-[11px] font-semibold disabled:opacity-50 disabled:cursor-not-allowed ${MEMBERSHIP_STATUS_BADGE_CLASSES[membershipStatus ?? "inactive"] ?? MEMBERSHIP_STATUS_BADGE_CLASSES.inactive}`}
                  >
                    {!membershipStatus && <option value="" disabled>—</option>}
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                    <option value="suspended">Suspended</option>
                    <option value="non_member">Non-Member</option>
                  </select>
                ) : membershipStatus ? (
                  <span className={`inline-block px-2 py-0.5 rounded-full border text-[11px] font-semibold ${MEMBERSHIP_STATUS_BADGE_CLASSES[membershipStatus] ?? MEMBERSHIP_STATUS_BADGE_CLASSES.inactive}`}>
                    {MEMBERSHIP_STATUS_LABELS[membershipStatus] ?? membershipStatus}
                  </span>
                ) : (
                  <span className="text-sm text-gray-400 dark:text-gray-500">—</span>
                )}
              </div>
              {membershipStatusLoading && (
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">Saving…</p>
              )}
              {membershipStatusError && (
                <p className="text-xs text-red-600 dark:text-red-400 mt-0.5" role="alert">
                  {membershipStatusError}
                </p>
              )}
            </div>

            <div className="mt-2.5">
              <p className="text-[11px] text-gray-400 dark:text-gray-500">Membership Type</p>
              <div className="mt-0.5">
                {isMembershipAdmin && rosterMemberId ? (
                  <select
                    value={membershipTypeId ?? ""}
                    disabled={membershipTypeLoading}
                    onChange={(e) => {
                      const opt = membershipTypeOptions.find((t) => t.id === e.target.value);
                      handleMembershipTypeChange(e.target.value, opt?.name ?? null);
                    }}
                    className={`w-full sm:w-auto px-2.5 py-1 rounded-full border text-[11px] font-semibold disabled:opacity-50 disabled:cursor-not-allowed ${MEMBERSHIP_TYPE_BADGE_CLASSES}`}
                  >
                    <option value="">None</option>
                    {membershipTypeOptions.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}{t.inactive ? " (inactive type)" : ""}
                      </option>
                    ))}
                  </select>
                ) : membershipTypeName ? (
                  <span className={`inline-block px-2 py-0.5 rounded-full border text-[11px] font-semibold ${MEMBERSHIP_TYPE_BADGE_CLASSES}`}>
                    {membershipTypeName}{isCurrentTypeInactive ? " (inactive type)" : ""}
                  </span>
                ) : (
                  <span className="text-sm text-gray-400 dark:text-gray-500">None</span>
                )}
              </div>
              {membershipTypeLoading && (
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">Saving…</p>
              )}
              {membershipTypeError && (
                <p className="text-xs text-red-600 dark:text-red-400 mt-0.5" role="alert">
                  {membershipTypeError}
                </p>
              )}
            </div>
          </div>
        )}

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

                  {/* Payment state — Phase 34C. Renders nothing when there
                      is no payment row for this item. */}
                  <PaymentStateBadge
                    state={paymentStateByActivityKey[`${item.activity_type}:${item.activity_id}`] ?? null}
                    className="mt-1.5"
                  />
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
          currency={currency}
          preselectedMemberId={rosterMemberId}
          viewerRole="admin"
          viewerId={adminId}
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
