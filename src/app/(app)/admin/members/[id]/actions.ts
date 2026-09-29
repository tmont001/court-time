"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
// Phase 45C1B — HistoryItem is now defined in activityNormalization.ts (the
// single source of truth shared by page.tsx's initial load and this file's
// own loadMoreMemberHistoryAction below); re-exported here so
// MemberDetailClient's/page.tsx's existing `import { type HistoryItem }
// from "./actions"` needs no path change.
import { normalizeMemberHistoryActivity, type HistoryItem } from "./activityNormalization";
export type { HistoryItem } from "./activityNormalization";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AddedNote {
  id:                   string;
  member_id:            string;
  author_id:            string | null;
  author_name_snapshot: string;
  body:                 string;
  is_archived:          boolean;
  created_at:           string;
  updated_at:           string;
  archived_at:          string | null;
  archived_by:          string | null;
}

// ─── addMemberNoteAction ──────────────────────────────────────────────────────

export async function addMemberNoteAction(
  memberId: string,
  body:     string,
): Promise<{ note?: AddedNote; error?: string }> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("add_member_note", {
    p_member_id: memberId,
    p_body:      body,
  });

  if (error) return { error: mapNoteError(error.message) };

  const row = data as AddedNote | null;
  return { note: row ?? undefined };
}

// ─── updateMemberNoteAction ───────────────────────────────────────────────────

export async function updateMemberNoteAction(
  noteId: string,
  body:   string,
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("update_member_note", {
    p_note_id: noteId,
    p_body:    body,
  });

  if (error) return { error: mapNoteError(error.message) };
  return {};
}

// ─── archiveMemberNoteAction ──────────────────────────────────────────────────

export async function archiveMemberNoteAction(
  noteId: string,
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("archive_member_note", {
    p_note_id: noteId,
  });

  if (error) return { error: mapNoteError(error.message) };
  return {};
}

// ─── restoreMemberNoteAction ──────────────────────────────────────────────────
// Phase 45C1A2 — the reverse of archiveMemberNoteAction, via migration
// 0212's restore_member_note (created, not yet applied). Clears exactly
// is_archived/archived_at/archived_by; body/author/created_at/member_id/
// club_id are untouched server-side.

export async function restoreMemberNoteAction(
  noteId: string,
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("restore_member_note", {
    p_note_id: noteId,
  });

  if (error) return { error: mapNoteError(error.message) };
  return {};
}

// ─── loadMoreMemberHistoryAction ─────────────────────────────────────────────

export async function loadMoreMemberHistoryAction(
  memberId:   string,
  cursorTs:   string,
  cursorType: string,
  cursorId:   string,
): Promise<{ items?: HistoryItem[]; error?: string }> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_member_activity_history", {
    p_member_id:   memberId,
    p_cursor_ts:   cursorTs,
    p_cursor_type: cursorType,
    p_cursor_id:   cursorId,
    p_limit:       20,
  });

  if (error) return { error: "Failed to load more history." };

  // Same normalizeMemberHistoryActivity adapter page.tsx's initial load
  // uses (activityNormalization.ts) — paginated and initial history rows
  // always share the exact same view-model shape, never mapped separately.
  return { items: (data ?? []).map(normalizeMemberHistoryActivity) };
}

// ─── markAttendanceFromDetailAction ──────────────────────────────────────────

export async function markAttendanceFromDetailAction(
  eventId:    string,
  profileId:  string,
  attendance: string | null,
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("mark_attendance", {
    p_event_id:          eventId,
    p_profile_id:        profileId,
    p_attendance_status: attendance,
  });

  if (error) return { error: mapAttendanceError(error.message) };
  revalidatePath(`/admin/members/${profileId}`);
  return {};
}

// ─── recordLessonOutcomeFromDetailAction ──────────────────────────────────────

export async function recordLessonOutcomeFromDetailAction(
  requestId: string,
  outcome:   string,
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("mark_lesson_outcome", {
    p_request_id: requestId,
    p_outcome:    outcome,
  });

  if (error) return { error: mapOutcomeError(error.message) };
  return {};
}

// ─── Error mappers ────────────────────────────────────────────────────────────

function mapNoteError(msg: string): string {
  const map: Record<string, string> = {
    not_authenticated:     "Please sign in to continue.",
    insufficient_role:     "Admin access required.",
    member_not_found:      "Member not found.",
    note_not_found:        "Note not found.",
    note_archived:         "This note has already been archived.",
    note_already_archived: "This note has already been archived.",
    // Phase 45C1A2 — restore_member_note's own lifecycle guard. The UI
    // never offers Restore on an active note, so this should be
    // unreachable in normal use; mapped defensively anyway, matching every
    // other lifecycle-guard code in this map.
    note_not_archived:     "This note is not archived.",
    // Phase 45C1A: migration 0211 reconciles add_member_note/
    // update_member_note with the live-verified error codes (body_empty/
    // body_too_long, matching member_notes_body_length's 2000-char CHECK)
    // — the old content_required/content_too_long (1000-char) codes these
    // replace were never actually raised by the live database.
    body_empty:            "Note content cannot be empty.",
    body_too_long:         "Note is too long (max 2000 characters).",
  };
  return map[msg] ?? "Something went wrong. Please try again.";
}

function mapAttendanceError(msg: string): string {
  const map: Record<string, string> = {
    not_authenticated:       "Please sign in to continue.",
    insufficient_role:       "Admin or pro access required.",
    invalid_attendance_status: "Invalid attendance status.",
    event_not_found:         "Event not found.",
    event_archived:          "This event is archived.",
    participant_not_found:   "Participant not found or not confirmed.",
  };
  return map[msg] ?? "Something went wrong. Please try again.";
}

function mapOutcomeError(msg: string): string {
  const map: Record<string, string> = {
    not_authenticated:        "Please sign in to continue.",
    insufficient_role:        "Admin or pro access required.",
    invalid_outcome:          "Invalid lesson outcome.",
    request_not_found:        "Lesson request not found.",
    invalid_status_for_outcome: "Outcome can only be set on confirmed lessons.",
    lesson_not_yet_started:   "The lesson has not started yet.",
  };
  return map[msg] ?? "Something went wrong. Please try again.";
}

// ─── setLessonProviderStatusAction ───────────────────────────────────────────

export async function setLessonProviderStatusAction(
  targetUserId: string,
  enabled:      boolean,
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_lesson_provider_status", {
    p_target_user_id: targetUserId,
    p_enabled:        enabled,
  });

  if (error) return { error: mapLessonProviderError(error.message) };

  revalidatePath("/admin/members");
  revalidatePath(`/admin/members/${targetUserId}`);
  revalidatePath("/admin/lessons");
  return {};
}

function mapLessonProviderError(msg: string): string {
  const map: Record<string, string> = {
    not_authenticated:     "Please sign in to continue.",
    insufficient_role:     "Admin access required.",
    inactive_actor:        "Your account must be Active to make this change.",
    no_club:               "Your account is not assigned to a club.",
    user_not_found:        "Member not found in your club.",
    target_not_admin_role: "Lesson Pro designation can only be set for Admin-role members.",
  };
  return map[msg] ?? "Something went wrong. Please try again.";
}
