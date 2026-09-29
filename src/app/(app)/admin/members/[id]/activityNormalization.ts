// Phase 45C1B — Member Activity Details Normalization.
//
// get_member_upcoming_activity/get_member_activity_history (migration 0132,
// verified via production pg_get_functiondef — see that migration's own
// comments) return only 9-10 flat top-level columns; every activity-specific
// field (court name, pro name, lesson duration, etc.) is nested inside a
// single `details` jsonb column whose shape varies by activity_type. The
// application previously read several flat fields — pro_first_name,
// pro_last_name, proposed_starts_at, proposed_ends_at, proposed_court_name —
// that never actually existed on either raw RPC row at all (a pre-existing
// bug: every upcoming lesson always rendered "Awaiting proposal", since
// proposed_starts_at was always `undefined` at runtime, never populated by
// either RPC).
//
// This module is the ONLY place that reads `details`. Both call sites —
// page.tsx's initial load and loadMoreMemberHistoryAction's pagination —
// normalize through the two functions below, so they cannot drift from each
// other. MemberDetailClient never learns the raw jsonb schema; it only ever
// receives the flat UpcomingItem/HistoryItem view models defined here.
//
// Raw `details` keys by activity_type (migration 0132's own UNION ALL
// branches — verified structural truth, not inferred from the stale UI):
//   get_member_upcoming_activity:
//     reservation: { court_id, court_name, format, notes }
//     event:       { event_type, event_color, ep_role }
//     lesson:      { pro_id, pro_name, lesson_type, duration_minutes }
//   get_member_activity_history:
//     reservation: { court_id, court_name, format, cancelled_at }
//     event:       { event_type, event_color, ep_role, event_status }
//     lesson:      { pro_id, pro_name, lesson_type, duration_minutes, cancelled_at }
// Only court_name/pro_name/duration_minutes are consumed by
// MemberDetailClient today — the remaining keys are real but currently
// unused, and are deliberately not extracted here (nothing to fabricate,
// nothing to normalize for a value nobody reads yet).

import type { Database, Json } from "@/lib/db/types";

type RawUpcomingRow = Database["public"]["Functions"]["get_member_upcoming_activity"]["Returns"][number];
type RawHistoryRow  = Database["public"]["Functions"]["get_member_activity_history"]["Returns"][number];

export interface UpcomingItem {
  activity_id:       string;
  activity_type:     "reservation" | "event" | "lesson";
  title:             string;
  starts_at:         string | null;
  ends_at:           string | null;
  status:            string;
  attendance_status: string | null;
  outcome:           string | null;
  court_name:        string | null;
  pro_name:          string | null;
  duration_minutes:  number | null;
}

export interface HistoryItem {
  activity_id:       string;
  activity_type:     "reservation" | "event" | "lesson";
  sort_ts:           string;
  title:             string;
  starts_at:         string | null;
  ends_at:           string | null;
  status:            string;
  attendance_status: string | null;
  // Sourced from the RAW TOP-LEVEL `outcome` column (not from `details`),
  // kept under this existing field name so MemberDetailClient's already-
  // correct outcome-handling JSX needs no change.
  lesson_outcome:    string | null;
  court_name:        string | null;
  pro_name:          string | null;
  duration_minutes:  number | null;
}

// ─── Defensive `details` extraction ────────────────────────────────────────
// `details` is jsonb (Json at the type level) — never trust its shape. Null,
// array, and primitive `details`, missing keys, and wrong-typed values all
// safely resolve to null rather than throwing or silently coercing.

function detailValue(details: Json, key: string): Json | undefined {
  if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
  return (details as Record<string, Json | undefined>)[key];
}

function detailString(details: Json, key: string): string | null {
  const value = detailValue(details, key);
  return typeof value === "string" ? value : null;
}

function detailNumber(details: Json, key: string): number | null {
  const value = detailValue(details, key);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// ─── Normalizers ────────────────────────────────────────────────────────────

export function normalizeMemberUpcomingActivity(row: RawUpcomingRow): UpcomingItem {
  return {
    activity_id:       row.activity_id,
    activity_type:     row.activity_type,
    title:             row.title,
    starts_at:         row.starts_at,
    ends_at:           row.ends_at,
    status:            row.status,
    attendance_status: row.attendance_status,
    outcome:           row.outcome,
    court_name:        detailString(row.details, "court_name"),
    pro_name:          detailString(row.details, "pro_name"),
    duration_minutes:  detailNumber(row.details, "duration_minutes"),
  };
}

export function normalizeMemberHistoryActivity(row: RawHistoryRow): HistoryItem {
  return {
    activity_id:       row.activity_id,
    activity_type:     row.activity_type,
    sort_ts:           row.sort_ts,
    title:             row.title,
    starts_at:         row.starts_at,
    ends_at:           row.ends_at,
    status:            row.status,
    attendance_status: row.attendance_status,
    lesson_outcome:    row.outcome,
    court_name:        detailString(row.details, "court_name"),
    pro_name:          detailString(row.details, "pro_name"),
    duration_minutes:  detailNumber(row.details, "duration_minutes"),
  };
}
