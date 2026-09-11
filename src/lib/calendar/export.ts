// calendar/export.ts — Phase 35B one-off "Add to Calendar" domain logic.
//
// Deliberately split from the API route (src/app/api/calendar/export/
// [domain]/[id]/route.ts): everything here is a PURE function over
// already-fetched plain data — no Supabase client, no I/O — so eligibility
// rules, UID stability, and summary/location construction are all
// behavior-tested directly (see export.test.ts) rather than only provable
// through a live database. The route handler is the thin, untestable-
// without-a-real-DB glue: it fetches rows through the caller's own
// session-scoped (RLS-governed) Supabase client and hands the results to
// these functions — it never re-implements or bypasses RLS itself.
//
// UID scheme is locked (Phase 35A/35B product decision) to
// `{domain}-{canonical-row-id}@court-time.app`, where domain is the
// CANONICAL ROW's own domain — a generated Program occurrence is a row in
// `events`, so it always gets an `event-...` UID, identical to what a
// standalone Event with the same id would receive. This is intentional:
// Phase 35C (a future personal subscription feed, not implemented here)
// must be able to reuse these exact identities without a second UID
// scheme.

import type { IcsEvent } from "@/lib/ics";

// ─── DESCRIPTION safety (notes/description enhancement) ────────────────────
//
// AUDIT (repository evidence, see the implementation report for the full
// per-domain writeup): calendar DESCRIPTION may contain ONLY text the
// exporting viewer is already entitled to see as normal participant-facing
// schedule information under Court Time's EXISTING display semantics —
// never merely because a field happens to be queryable. Concretely:
//   - reservations.notes (member_booking): never rendered to the owning
//     Member anywhere today (ReservationDetailSheet only shows it in
//     Admin/Staff mode) — effectively staff-only in practice. NEVER
//     exported, for any viewer.
//   - events.description (standalone event, program_id null): not
//     rendered anywhere in the product today (EditEventSheet is a write-
//     only admin form; no read surface displays it to anyone). NEVER
//     exported for a standalone event.
//   - events.description (a generated Program occurrence): generate_
//     program_sessions (0088) copies the PARENT programs.description into
//     each occurrence at generation time, but a generated occurrence's row
//     can later be edited independently (EditEventSheet has no special
//     case for program-linked events), so an occurrence's OWN description
//     column is not a reliably-safe, still-original value by the time an
//     export runs. The route therefore reads the PARENT programs.
//     description FRESH via program_id, never the occurrence's own copy.
//   - programs.description: rendered unconditionally to any Member who can
//     see their own whole-program enrollment (ProgramEnrollmentCard) — the
//     one domain with a confirmed, current, participant-facing text field.
//     Exported for both the parent-schedule export (uniformly, matching
//     0088's own "same description on every occurrence" origin) and for a
//     single generated-occurrence Event export (looked up via program_id).
//   - lesson_requests.member_note: rendered unconditionally to BOTH the
//     Member (LessonRequestDetail) and the assigned Pro (LessonProSheet),
//     in every status including confirmed — genuinely shared between the
//     two legitimate Lesson parties. Exported for a confirmed Lesson,
//     regardless of which of the two parties (or Admin/Staff) is
//     exporting. decline_reason/cancellation_reason are never read by this
//     module at all.
//
// safeDescription is the one place empty/whitespace-only text collapses to
// "no description" (never emit an empty DESCRIPTION line).
export function safeDescription(text: string | null | undefined): string | null {
  const trimmed = text?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

// ─── UID / filenames ───────────────────────────────────────────────────────

export function reservationUid(id: string): string {
  return `reservation-${id}@court-time.app`;
}

export function eventUid(id: string): string {
  return `event-${id}@court-time.app`;
}

export function lessonUid(id: string): string {
  return `lesson-${id}@court-time.app`;
}

export const EXPORT_FILENAMES = {
  reservation: "court-time-reservation.ics",
  event: "court-time-event.ics",
  lesson: "court-time-lesson.ics",
  program: "court-time-program-schedule.ics",
} as const;

// ─── Reservation ────────────────────────────────────────────────────────────

// Phase 35B locked decision: only a confirmed reason='member_booking'
// reservation is one-off-exportable. reason='event'/'pro_lesson' rows have
// their own dedicated Event/Lesson export path (and their own, more useful
// SUMMARY/LOCATION); reason='maintenance'/'admin_block' rows are internal
// operational court closures, not a personal appointment, and carry
// staff-only notes by default — there is no ReservationDetailSheet "Add to
// Calendar" affordance for them in this checkpoint (see the implementation
// report for the explicit reasoning).
export const RESERVATION_EXPORT_REASON = "member_booking" as const;

// Phase 35B correction pass: "ends_at > now" is folded into eligibility
// itself (not a separate check) so a genuinely finished reservation is
// never one-off-exportable — an "Add to Calendar" action on something
// already over is not useful. `now` defaults to the real clock for
// production callers but is always passed explicitly in tests, so nothing
// here is time-flaky.
export function isReservationExportEligible(
  reservation: { status: string; reason: string; ends_at: string },
  now: Date = new Date(),
): boolean {
  return (
    reservation.status === "confirmed" &&
    reservation.reason === RESERVATION_EXPORT_REASON &&
    new Date(reservation.ends_at) > now
  );
}

// Phase 35B correction pass: Admin/Staff may export any otherwise-eligible
// same-club reservation their existing RLS already lets them read (no
// further check here — unchanged). A Member or Pro may export ONLY their
// own reservation — a Connected club's broad club-wide calendar
// READ-visibility (member_self_service) must never be mistaken for "may
// add someone else's booking to my personal calendar." Ownership uses the
// same durable-identity semantics as the rest of the app: owner_user_id
// match, OR (for a claimed Member whose booking predates their account —
// see 0107-0110) roster_member_id match against the caller's OWN current
// roster identity, which the route resolves server-side via
// current_user_roster_member_id() — never accepted from the client.
export function isReservationOwnedByViewer(
  reservation: { owner_user_id: string | null; roster_member_id: string | null },
  viewer: { id: string; rosterMemberId: string | null },
): boolean {
  if (reservation.owner_user_id !== null && reservation.owner_user_id === viewer.id) return true;
  if (viewer.rosterMemberId !== null && reservation.roster_member_id === viewer.rosterMemberId) return true;
  return false;
}

export function canExportReservationForRole(
  role: string,
  reservation: { owner_user_id: string | null; roster_member_id: string | null },
  viewer: { id: string; rosterMemberId: string | null },
): boolean {
  if (role === "admin" || role === "staff") return true;
  return isReservationOwnedByViewer(reservation, viewer);
}

export function buildReservationIcsEvent(
  reservation: { id: string; starts_at: string; ends_at: string },
  courtName: string,
): IcsEvent {
  return {
    uid: reservationUid(reservation.id),
    dtstart: new Date(reservation.starts_at),
    dtend: new Date(reservation.ends_at),
    summary: `Court Reservation — ${courtName}`,
    location: courtName,
  };
}

// ─── Event (standalone, or one generated Program occurrence) ───────────────

// Phase 35B correction pass: "ends_at > now" folded in here too — an
// occurrence currently underway (starts_at in the past, ends_at still in
// the future) stays eligible; a genuinely finished one does not. This same
// predicate is reused unchanged for Program-occurrence filtering (see
// isProgramOccurrenceExportEligible below) — one rule, not two.
export function isEventExportEligible(
  event: { status: string; archived_at: string | null; ends_at: string },
  now: Date = new Date(),
): boolean {
  return event.status === "scheduled" && event.archived_at === null && new Date(event.ends_at) > now;
}

export function buildEventIcsEvent(
  event: { id: string; title: string; starts_at: string; ends_at: string },
  location: string | null,
  description: string | null = null,
): IcsEvent {
  return {
    uid: eventUid(event.id),
    dtstart: new Date(event.starts_at),
    dtend: new Date(event.ends_at),
    summary: event.title,
    location,
    description,
  };
}

// Resolves a LOCATION string from one or more court ids, deduplicated,
// joined in a stable order, silently skipping any id with no known name
// (a dangling/unresolvable court reference) rather than emitting
// "undefined" or throwing — malformed/incomplete schedule data must
// degrade gracefully, never crash the export.
export function resolveLocation(
  courtIds: readonly string[],
  nameById: ReadonlyMap<string, string>,
): string | null {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const id of courtIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const name = nameById.get(id);
    if (name && name.trim().length > 0) names.push(name);
  }
  return names.length > 0 ? names.join(", ") : null;
}

// ─── Lesson (confirmed only) ────────────────────────────────────────────────

// Phase 35B correction pass: "ends_at > now" added, using the authoritative
// proposed_ends_at (the only end time a confirmed lesson has).
export function isLessonExportEligible(
  lesson: { status: string; proposed_starts_at: string | null; proposed_ends_at: string | null },
  now: Date = new Date(),
): boolean {
  return (
    lesson.status === "confirmed" &&
    !!lesson.proposed_starts_at &&
    !!lesson.proposed_ends_at &&
    new Date(lesson.proposed_ends_at) > now
  );
}

export type LessonCounterparty = "pro" | "member" | "both";

// Pure viewer/row id comparison — no I/O. RLS (lesson_requests_select_
// member/_pro/_admin) already guarantees that if a lesson_requests row was
// readable at all by this viewer, they are either the assigned pro, the
// member, or an Admin/Staff operator — so "neither id matches" can only
// ever mean the viewer is an operator, never an unrelated third party.
export function resolveLessonCounterparty(
  viewerId: string,
  lesson: { member_id: string | null; pro_id: string },
): LessonCounterparty {
  if (viewerId === lesson.pro_id) return "member";
  if (lesson.member_id !== null && viewerId === lesson.member_id) return "pro";
  return "both";
}

export function fullDisplayName(
  profile: { first_name: string | null; last_name: string | null } | null,
): string {
  if (!profile) return "Court Time Member";
  const full = [profile.first_name, profile.last_name].filter(Boolean).join(" ").trim();
  return full || "Court Time Member";
}

// SUMMARY never includes phone/email/payment/notes — just the counterparty
// name(s), exactly what both parties of a lesson already know about each
// other from the rest of the product.
export function formatLessonSummary(
  counterparty: LessonCounterparty,
  names: { memberName: string; proName: string },
): string {
  if (counterparty === "member") return `Lesson with ${names.memberName}`;
  if (counterparty === "pro") return `Lesson with ${names.proName}`;
  return `Lesson: ${names.memberName} with ${names.proName}`;
}

export function buildLessonIcsEvent(
  lesson: { id: string; proposed_starts_at: string; proposed_ends_at: string },
  summary: string,
  location: string | null,
  description: string | null = null,
): IcsEvent {
  return {
    uid: lessonUid(lesson.id),
    dtstart: new Date(lesson.proposed_starts_at),
    dtend: new Date(lesson.proposed_ends_at),
    summary,
    location,
    description,
  };
}

// ─── Program (parent schedule export — multiple VEVENTs) ───────────────────

export function isProgramExportEligible(program: {
  status: string;
  archived_at: string | null;
}): boolean {
  return program.status !== "cancelled" && program.archived_at === null;
}

// Same per-occurrence eligibility rule as a standalone Event — a generated
// occurrence IS an events row (see the module header), so it is
// individually excluded/included exactly as it would be if exported on its
// own.
export const isProgramOccurrenceExportEligible = isEventExportEligible;

// Phase 35B correction pass: Admin/Staff may export any same-club Program
// schedule (RLS's programs_select_same_club already grants them
// unconditional, club-wide row visibility, and — unlike Pro — the existing
// Program *management* workflow (ProgramsManageClient's own `canManage`)
// never scopes Admin/Staff to "only the ones they created" either, so this
// export must not invent a narrower rule for them than management already
// has). A Pro, however, is scoped to programs THEY created — mirroring
// ProgramsManageClient's existing `canManage` boundary
// (`userRole === "pro" && program.created_by === userId`) exactly, even
// though raw RLS row-visibility for Pro is broader (club-wide) than that —
// this export must not grant every Pro every other Pro's Program schedule
// merely because the row happens to be visible to them.
export function canOperatorExportProgramSchedule(
  role: string,
  program: { created_by: string },
  viewerId: string,
): boolean {
  if (role === "admin" || role === "staff") return true;
  if (role === "pro") return program.created_by === viewerId;
  return false;
}

// Phase 35B locked decision: a Member may only export a whole-program
// parent schedule when (a) the Program itself uses enrollment_model=
// 'program' (per_session/admin_managed Members join individual occurrences
// directly — export those from the occurrence's own Event detail, never
// from here) AND (b) their own program_enrollments row for it is
// status='enrolled' (never waitlisted/offered/cancelled — none of those is
// a confirmed calendar commitment).
export function canMemberExportProgramSchedule(
  enrollmentModel: string,
  enrollmentStatus: string | null,
): boolean {
  return enrollmentModel === "program" && enrollmentStatus === "enrolled";
}

// `description` is the PARENT Program's own current description (see the
// module's DESCRIPTION-safety note above for why the parent's fresh value
// is used rather than each occurrence's own, independently-editable copy),
// applied uniformly to every occurrence in this schedule export — matching
// the exact behavior generate_program_sessions (0088) itself established
// by copying the same description onto every occurrence at generation time.
export function buildProgramOccurrenceIcsEvents(
  occurrences: readonly { id: string; title: string; starts_at: string; ends_at: string }[],
  locationByEventId: ReadonlyMap<string, string | null>,
  description: string | null = null,
): IcsEvent[] {
  return occurrences.map(occurrence =>
    buildEventIcsEvent(occurrence, locationByEventId.get(occurrence.id) ?? null, description),
  );
}
