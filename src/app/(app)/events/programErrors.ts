// programErrors.ts
// Phase 27C: shared error-code → user-facing message mapping for the three
// Phase 27B2 program RPCs (create_program, preview_program_sessions,
// generate_program_sessions). Mirrors the mapCreateError/mapCancelError
// pattern already established in CreateEventSheet.tsx / AdminEventsClient.tsx
// — every RPC raises `error.message` as the literal documented error code,
// so this is a plain string switch, never a raw Postgres message shown to
// the user.

import { STALE_CLUB_CONTEXT_ERROR, STALE_CLUB_MESSAGE } from "@/lib/staleClub";

export function mapProgramError(code: string | undefined, message: string): string {
  if (message === STALE_CLUB_CONTEXT_ERROR || code === STALE_CLUB_CONTEXT_ERROR) {
    return STALE_CLUB_MESSAGE;
  }

  switch (message) {
    case "not_authenticated":
      return "Your session has expired. Please sign in again.";
    case "insufficient_role":
      return "You do not have permission to do this.";
    case "invalid_title":
      return "Enter a title for the program.";
    case "invalid_enrollment_model":
      return "Choose an enrollment model.";
    case "invalid_date_range":
      return "The end date must be on or after the start date.";
    case "range_too_long":
      return "Programs can span at most 26 weeks.";
    case "invalid_capacity":
      return "Capacity must be a positive number.";
    case "event_type_not_found":
      return "That event type is no longer available. Refresh and choose another.";
    case "invalid_rules_payload":
      return "Add at least one schedule rule.";
    case "invalid_day_of_week":
      return "Choose a valid day of the week for each rule.";
    case "invalid_start_time":
      return "Enter a valid start time for each rule.";
    case "invalid_duration":
      return "Duration must be a positive number of minutes.";
    case "invalid_capacity_override":
      return "Capacity override must be a positive number.";
    case "capacity_override_not_allowed_for_program_enrollment":
      return "Capacity override isn't available for whole-program enrollment.";
    case "rule_requires_court":
      return "Each schedule rule needs at least one court.";
    case "duplicate_court_in_rule":
      return "A court is selected more than once in the same rule.";
    case "court_not_found":
      return "One of the selected courts is no longer available. Refresh and try again.";
    case "duplicate_rule":
      return "Two rules have the exact same day and start time.";
    case "overlapping_program_rules":
      return "Two rules overlap on the same court. Adjust the times or use a different court.";
    case "program_not_found":
      return "This program could not be found.";
    case "program_archived":
      return "This program has been archived.";
    case "program_not_generatable":
      return "This program can no longer generate sessions.";
    case "too_many_occurrences":
      return "That date range would generate too many sessions at once. Narrow the range and try again.";
    case "court_conflict":
      return "One or more sessions would conflict with an existing booking. Resolve the conflict and try again.";
    default:
      return "Something went wrong. Please try again.";
  }
}
