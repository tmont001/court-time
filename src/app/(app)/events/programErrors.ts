// programErrors.ts
// Phase 27C: shared error-code → user-facing message mapping for the three
// Phase 27B2 program RPCs (create_program, preview_program_sessions,
// generate_program_sessions). Mirrors the mapCreateError/mapCancelError
// pattern already established in CreateEventSheet.tsx / AdminEventsClient.tsx
// — every RPC raises `error.message` as the literal documented error code,
// so this is a plain string switch, never a raw Postgres message shown to
// the user.
//
// Phase 27D2: extended to also cover the four Phase 27D1 whole-program
// enrollment RPCs (join_program, leave_program, accept_program_waitlist_offer,
// decline_program_waitlist_offer — 0091). Reusing this single switch rather
// than adding a second mapping function keeps every /events error message
// in one place; not_authenticated, program_not_found, and stale-club
// handling below already cover the enrollment RPCs' own use of those same
// codes with no changes needed.
//
// Phase 27D3B: extended to also cover the two Phase 27D3A staff roster RPCs
// (add_program_member, remove_program_member — 0092). insufficient_role,
// program_not_found, program_not_whole_enrollment, program_not_enrollable,
// and enrollment_not_found are already handled above and are reused as-is;
// only target_member_not_found and target_member_inactive are new.
//
// Phase 27E: extended to also cover the four lifecycle RPCs (cancel_program,
// complete_program, archive_program, unarchive_program — 0094).
// not_authenticated, insufficient_role, and program_not_found are reused
// as-is; program_not_cancellable, program_not_completable,
// program_not_archivable, already_archived, and not_archived are new.
//
// Phase 33D2b: extended to also cover the four new roster-identity RPCs
// (add_program_roster_member, remove_program_roster_member, force_confirm_
// program_roster_member, get_program_eligible_roster_members — 0115).
// Every existing code above (program_not_found, program_not_whole_
// enrollment, program_not_enrollable, enrollment_not_found, insufficient_
// role, not_authenticated) is reused as-is; only roster_member_not_found is
// new. phase33d2_unresolved_member_identity and program_enrollment_write_
// failed are defensive fail-closed guards expected to be unreachable for
// any legitimate caller (mirroring the identical, intentionally-unmapped
// event_participant_write_failed precedent in admin/events/actions.ts) —
// deliberately left to fall through to the default message below, not an
// oversight.

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
    case "program_not_whole_enrollment":
      return "This program doesn't use whole-program enrollment.";
    case "program_not_enrollable":
      return "This program isn't open for enrollment right now.";
    case "already_enrolled":
      return "You're already enrolled or on the waitlist for this program.";
    case "enrollment_not_found":
      return "You're not currently enrolled in this program.";
    case "offer_not_found":
      return "That spot offer is no longer available.";
    case "offer_expired":
      return "That spot offer has expired.";
    case "target_member_not_found":
      return "That member could not be found.";
    case "target_member_inactive":
      return "That member is inactive.";
    case "roster_member_not_found":
      return "That member could not be found in your club.";
    case "program_not_editable":
      return "This program can no longer be edited — only draft programs can be changed.";
    case "program_already_generated":
      return "This program already has generated sessions and can no longer be edited directly.";
    case "too_many_occurrences":
      return "That date range would generate too many sessions at once. Narrow the range and try again.";
    case "court_conflict":
      return "One or more sessions would conflict with an existing booking. Resolve the conflict and try again.";
    case "program_not_cancellable":
      return "This program can't be cancelled right now.";
    case "program_not_completable":
      return "This program isn't ready to be marked complete yet.";
    case "program_not_archivable":
      return "Only cancelled or completed programs can be archived.";
    case "already_archived":
      return "This program is already archived.";
    case "not_archived":
      return "This program isn't archived.";
    case "capability_not_available":
      return "This feature isn't available at your club right now. Contact the office for help.";
    default:
      return "Something went wrong. Please try again.";
  }
}
