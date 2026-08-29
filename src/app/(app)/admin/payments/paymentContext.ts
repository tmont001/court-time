// Phase 34E-E — pure, side-effect-free booking-context helpers for
// /admin/payments. Extracted from page.tsx (rather than left as local
// closures) specifically so they are directly importable and testable
// with real function calls — this project's vitest config is a
// deliberately minimal pure-TypeScript baseline (no jsdom/component
// testing), so genuine behavioral coverage here means real assertions
// against real exported functions, not source-inspection mimicry.

// Compact "date · start–end" label in the given IANA timezone, e.g.
// "Aug 28 · 1:00–2:00 PM". Falls back to just the date whenever the end
// timestamp is missing, and to null whenever the start date itself is
// missing — a domain row with an incomplete time window must never
// fabricate one.
export function dateTimeRangeLabel(
  startsAtISO: string | null,
  endsAtISO: string | null,
  timezone: string,
): string | null {
  if (!startsAtISO) return null;
  const date = new Date(startsAtISO).toLocaleDateString("en-US", {
    timeZone: timezone, month: "short", day: "numeric",
  });
  if (!endsAtISO) return date;
  const timeFormat: Intl.DateTimeFormatOptions = {
    timeZone: timezone, hour: "numeric", minute: "2-digit", hour12: true,
  };
  const start = new Date(startsAtISO).toLocaleTimeString("en-US", timeFormat);
  const end = new Date(endsAtISO).toLocaleTimeString("en-US", timeFormat);
  // "1:00–2:00 PM", not "1:00 PM–2:00 PM" — the period (AM/PM) is shown
  // once, on the end time, whenever start and end share the same one.
  // A booking spanning noon (e.g. 11:30 AM–12:30 PM) still shows both,
  // since suppressing either there would be misleading.
  const startPeriod = start.slice(-2);
  const endPeriod = end.slice(-2);
  const startDisplay = startPeriod === endPeriod ? start.slice(0, -3) : start;
  return `${date} · ${startDisplay}–${end}`;
}

// Domain lifecycle is independent from payment/financial lifecycle
// (locked invariant: cancellation never mutates amount_paid_cents/
// status). Each returns null when the domain row is active/has no
// cancellation concept — never fabricated.
export function reservationLifecycleLabel(status: string): string | null {
  return status === "cancelled" ? "Booking Cancelled" : null;
}

// lesson_requests is itself the lifecycle entity (no separate parent row)
// — status alone is authoritative.
export function lessonRequestLifecycleLabel(status: string): string | null {
  if (status === "cancelled") return "Request Cancelled";
  if (status === "declined") return "Request Declined";
  if (status === "withdrawn") return "Request Withdrawn";
  return null;
}

// External review correction — cancel_event sets events.status =
// 'cancelled' WITHOUT cancelling individual event_participants rows
// (confirmed/waitlisted participants are intentionally preserved as
// historical). A payment can therefore belong to a cancelled event while
// its own participant row still reads "confirmed" — the PARENT event's
// own status must be checked first, with the participant's own status
// only as a fallback for the (rarer) case of an individually cancelled
// registration on a still-active event.
export function eventParticipantLifecycleLabel(
  eventStatus: string | undefined,
  participantStatus: string,
): string | null {
  if (eventStatus === "cancelled") return "Event Cancelled";
  if (participantStatus === "cancelled") return "Registration Cancelled";
  return null;
}

// event_guests has no lifecycle status column of its own at all — the
// ONLY lifecycle signal available is the parent event's own status. Never
// invents a guest-specific status.
export function eventGuestLifecycleLabel(eventStatus: string | undefined): string | null {
  return eventStatus === "cancelled" ? "Event Cancelled" : null;
}

// External review correction — mirrors eventParticipantLifecycleLabel's
// own reasoning exactly: cancel_program sets programs.status =
// 'cancelled' while program_enrollments are intentionally preserved
// (may remain enrolled/waitlisted/offered). Parent program status is
// checked first.
export function programEnrollmentLifecycleLabel(
  programStatus: string | undefined,
  enrollmentStatus: string,
): string | null {
  if (programStatus === "cancelled") return "Program Cancelled";
  if (enrollmentStatus === "cancelled") return "Enrollment Cancelled";
  return null;
}

// External review correction — financial-history timestamps must use the
// CLUB's timezone, exactly like the booking-context time range above,
// never the browser/device timezone. "Aug 28, 1:29 PM" — a useful
// operator timestamp, date AND time together.
export function formatHistoryTimestamp(iso: string, timezone: string): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: timezone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
  });
}
