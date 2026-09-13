// Phase 36D: pure "does this lesson request's current actionable state
// depend on an active linked reservation" predicate — shared by
// LessonsTab's canReschedule (which button to show) and its ?lessonId=
// deep-link auto-open effect (whether the already-authorized row can be
// trusted directly, or must be re-validated against its linked
// reservation live before opening), so the two can never drift into
// different answers for the same request.
//
// Framework-independent (no React/router/Supabase) — see
// src/lib/auth/roles.ts for the same convention.
//
// True for: a confirmed lesson (its reservation IS the lesson), or a
// proposed RESCHEDULE of an already-confirmed lesson (status='proposed'
// WITH linked_reservation_id already set — proposed_starts_at holds the
// candidate new time, not the original, so the original reservation is
// the only authoritative source of whether it's still live — Phase 30G's
// original reasoning). False for every other state (pending, a FRESH
// proposed with no reservation yet — the normal "Pro proposed, member
// hasn't responded" case — declined, cancelled, withdrawn) — none of
// those have an active reservation to depend on, and each opens directly
// from the already-authorized row instead, exactly like a manual click on
// that same card.
export function lessonDependsOnLiveReservation(
  status: string,
  linkedReservationId: string | null,
): boolean {
  return status === "confirmed" || (status === "proposed" && linkedReservationId !== null);
}

// Phase 38A: "has this CONFIRMED lesson's effective start time already
// passed" — shared by LessonsTab's Active/Past list split and its card
// action gating (Propose New Time / Reassign Pro / card-level Cancel are
// hidden for a past confirmed lesson, replaced with a plain View Details
// affordance into the same LessonProSheet), and by LessonProSheet's own
// Reassign Pro button visibility.
//
// Only meaningful for status='confirmed': proposedStartsAt then holds the
// lesson's actual confirmed start time (kept in sync by every confirm/
// reschedule/direct-edit RPC — the same field LessonsTab already trusts to
// render a confirmed lesson's date/time). For every other status this is
// always false — a pending or first-time-proposed request is never "past",
// and a pending RESCHEDULE's proposed_starts_at holds the new CANDIDATE
// time, not the original lesson's time, so it must never be evaluated here
// (callers gate this predicate on status === 'confirmed' explicitly).
//
// Framework-independent (no React/router/Supabase import) — matches
// lessonDependsOnLiveReservation's own convention exactly.
export function isPastConfirmedLesson(
  status: string,
  proposedStartsAt: string | null,
  now: Date = new Date(),
): boolean {
  if (status !== "confirmed" || !proposedStartsAt) return false;
  return new Date(proposedStartsAt) <= now;
}
