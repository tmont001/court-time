"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AddedNote {
  id:                   string;
  member_id:            string;
  author_id:            string | null;
  author_name_snapshot: string;
  content:              string;
  created_at:           string;
  updated_at:           string;
  archived_at:          string | null;
}

export interface HistoryItem {
  activity_id:       string;
  activity_type:     "event" | "lesson";
  sort_ts:           string;
  status:            string;
  starts_at:         string | null;
  ends_at:           string | null;
  title:             string | null;
  attendance_status: string | null;
  pro_first_name:    string | null;
  pro_last_name:     string | null;
  duration_minutes:  number | null;
  lesson_outcome:    string | null;
}

// ─── addMemberNoteAction ──────────────────────────────────────────────────────

export async function addMemberNoteAction(
  memberId: string,
  content:  string,
): Promise<{ note?: AddedNote; error?: string }> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("add_member_note", {
    p_member_id: memberId,
    p_content:   content,
  });

  if (error) return { error: mapNoteError(error.message) };

  const row = data as AddedNote | null;
  return { note: row ?? undefined };
}

// ─── updateMemberNoteAction ───────────────────────────────────────────────────

export async function updateMemberNoteAction(
  noteId:  string,
  content: string,
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("update_member_note", {
    p_note_id: noteId,
    p_content: content,
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

  return { items: (data ?? []) as HistoryItem[] };
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
    not_authenticated:   "Please sign in to continue.",
    insufficient_role:   "Admin access required.",
    member_not_found:    "Member not found.",
    note_not_found:      "Note not found.",
    note_archived:       "This note has already been archived.",
    note_already_archived: "This note has already been archived.",
    content_required:    "Note content cannot be empty.",
    content_too_long:    "Note is too long (max 1000 characters).",
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
