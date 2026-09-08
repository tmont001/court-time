import { describe, expect, it } from "vitest";
import {
  dateTimeRangeLabel,
  reservationLifecycleLabel,
  lessonRequestLifecycleLabel,
  eventParticipantLifecycleLabel,
  eventGuestLifecycleLabel,
  programEnrollmentLifecycleLabel,
  formatHistoryTimestamp,
  isReservationCollectible,
  isLessonRequestCollectible,
  isEventParticipantCollectible,
  isEventGuestCollectible,
  isProgramEnrollmentCollectible,
} from "./paymentContext";

// Phase 34E-E — genuine behavioral coverage for the real, production-used
// pure booking-context helpers (not a parallel reimplementation, not
// source-inspection — this project's vitest config is a deliberately
// minimal pure-TypeScript baseline with no jsdom/component testing, so
// these are real function calls against real exported functions).

describe("dateTimeRangeLabel — compact 'date · start–end' in the given timezone", () => {
  it("requirement 1: renders start AND end time in the given (club) timezone, e.g. 'Aug 28 · 1:00–2:00 PM'", () => {
    // 2026-08-28T17:00:00Z = 1:00 PM America/New_York (EDT, UTC-4).
    const label = dateTimeRangeLabel("2026-08-28T17:00:00Z", "2026-08-28T18:00:00Z", "America/New_York");
    expect(label).toBe("Aug 28 · 1:00–2:00 PM");
  });

  it("uses the GIVEN timezone, not a hard-coded one — the same instant renders differently in a different zone", () => {
    const eastern = dateTimeRangeLabel("2026-08-28T17:00:00Z", "2026-08-28T18:00:00Z", "America/New_York");
    const pacific = dateTimeRangeLabel("2026-08-28T17:00:00Z", "2026-08-28T18:00:00Z", "America/Los_Angeles");
    expect(eastern).not.toBe(pacific);
    expect(pacific).toBe("Aug 28 · 10:00–11:00 AM");
  });

  it("falls back to just the date when the end timestamp is missing — never fabricates an end time", () => {
    const label = dateTimeRangeLabel("2026-08-28T17:00:00Z", null, "America/New_York");
    expect(label).toBe("Aug 28");
  });

  it("shows the AM/PM period on BOTH times when a booking spans noon (start AM, end PM) — never suppresses a genuinely different period", () => {
    // 2026-08-28T15:30:00Z = 11:30 AM America/New_York; ends at 12:30 PM.
    const label = dateTimeRangeLabel("2026-08-28T15:30:00Z", "2026-08-28T16:30:00Z", "America/New_York");
    expect(label).toBe("Aug 28 · 11:30 AM–12:30 PM");
  });

  it("returns null when the start timestamp itself is missing — handles missing domain context gracefully", () => {
    expect(dateTimeRangeLabel(null, "2026-08-28T18:00:00Z", "America/New_York")).toBeNull();
    expect(dateTimeRangeLabel(null, null, "America/New_York")).toBeNull();
  });
});

describe("domain lifecycle labels — independent from payment/financial status, never fabricated for an active row", () => {
  it("requirement 2: an active (non-cancelled) reservation has NO lifecycle label — normal booking context only", () => {
    expect(reservationLifecycleLabel("confirmed")).toBeNull();
    expect(reservationLifecycleLabel("pending")).toBeNull();
  });

  it("requirement 3/4: a cancelled reservation always yields 'Booking Cancelled', regardless of payment status (this function knows nothing about payment status at all — it takes only the reservation's own status)", () => {
    expect(reservationLifecycleLabel("cancelled")).toBe("Booking Cancelled");
  });

  it("lesson_request: cancelled/declined/withdrawn each yield a distinct, accurate label; active statuses yield null", () => {
    expect(lessonRequestLifecycleLabel("cancelled")).toBe("Request Cancelled");
    expect(lessonRequestLifecycleLabel("declined")).toBe("Request Declined");
    expect(lessonRequestLifecycleLabel("withdrawn")).toBe("Request Withdrawn");
    expect(lessonRequestLifecycleLabel("pending")).toBeNull();
    expect(lessonRequestLifecycleLabel("proposed")).toBeNull();
    expect(lessonRequestLifecycleLabel("confirmed")).toBeNull();
  });

  it("event_participant: an active event with a confirmed participant has no label", () => {
    expect(eventParticipantLifecycleLabel("scheduled", "confirmed")).toBeNull();
  });

  it("event_participant: an individually cancelled registration on a still-active event reads 'Registration Cancelled'", () => {
    expect(eventParticipantLifecycleLabel("scheduled", "cancelled")).toBe("Registration Cancelled");
  });

  it("event_participant: a cancelled PARENT event takes precedence, even when the participant row itself was never cancelled (cancel_event does not cascade to event_participants)", () => {
    expect(eventParticipantLifecycleLabel("cancelled", "confirmed")).toBe("Event Cancelled");
    expect(eventParticipantLifecycleLabel("cancelled", "waitlisted")).toBe("Event Cancelled");
  });

  it("event_participant: parent-cancelled wins even if the participant row ALSO reads cancelled — 'Event Cancelled' is shown, not 'Registration Cancelled'", () => {
    expect(eventParticipantLifecycleLabel("cancelled", "cancelled")).toBe("Event Cancelled");
  });

  it("event_guest: has no lifecycle status of its own — null on an active event, 'Event Cancelled' on a cancelled parent event", () => {
    expect(eventGuestLifecycleLabel("scheduled")).toBeNull();
    expect(eventGuestLifecycleLabel("cancelled")).toBe("Event Cancelled");
    expect(eventGuestLifecycleLabel(undefined)).toBeNull();
  });

  it("program_enrollment: an active program with an active enrollment has no label", () => {
    expect(programEnrollmentLifecycleLabel("active", "enrolled")).toBeNull();
    expect(programEnrollmentLifecycleLabel("active", "waitlisted")).toBeNull();
    expect(programEnrollmentLifecycleLabel("active", "offered")).toBeNull();
  });

  it("program_enrollment: an individually cancelled enrollment on a still-active program reads 'Enrollment Cancelled'", () => {
    expect(programEnrollmentLifecycleLabel("active", "cancelled")).toBe("Enrollment Cancelled");
  });

  it("program_enrollment: a cancelled PARENT program takes precedence, even when the enrollment row itself was preserved as enrolled/waitlisted (cancel_program does not cascade to program_enrollments)", () => {
    expect(programEnrollmentLifecycleLabel("cancelled", "enrolled")).toBe("Program Cancelled");
    expect(programEnrollmentLifecycleLabel("cancelled", "waitlisted")).toBe("Program Cancelled");
  });

  it("program_enrollment: parent-cancelled wins even if the enrollment row ALSO reads cancelled — 'Program Cancelled' is shown, not 'Enrollment Cancelled'", () => {
    expect(programEnrollmentLifecycleLabel("cancelled", "cancelled")).toBe("Program Cancelled");
  });
});

// Phase 34G-C2 correction (Issue 2) — the extracted collectibility gate,
// the SAME cancelled-family predicate that governs whether Record Payment
// may be offered on /admin/payments (previously inline in page.tsx),
// reused verbatim by the Outstanding Balances CSV export.
//
// Final runtime-QA correction — event_participant/program_enrollment now
// take BOTH the parent's status AND the child registration/enrollment's
// own status: a cancelled/withdrawn CHILD row is not collectible merely
// because its parent Event/Program remains active. Numbered items below
// (1-11) are the exact matrix required by the final correction spec.
describe("collectibility predicates — mirror the existing Record Payment gate exactly", () => {
  it("9. Reservation: cancelled is not collectible; every other status is", () => {
    expect(isReservationCollectible("cancelled")).toBe(false);
    expect(isReservationCollectible("confirmed")).toBe(true);
    expect(isReservationCollectible("pending")).toBe(true);
  });

  it("10. Lesson: cancelled/declined/withdrawn are all NOT collectible — a request that can no longer result in a lesson is never a collection target", () => {
    expect(isLessonRequestCollectible("cancelled")).toBe(false);
    expect(isLessonRequestCollectible("declined")).toBe(false);
    expect(isLessonRequestCollectible("withdrawn")).toBe(false);
  });

  it("11. Lesson: confirmed (the only current payable state) is collectible", () => {
    expect(isLessonRequestCollectible("confirmed")).toBe(true);
  });

  it("1. Event participant: active Event + confirmed participant => collectible", () => {
    expect(isEventParticipantCollectible("scheduled", "confirmed")).toBe(true);
  });

  it("2. Event participant: active Event + CANCELLED participant => NOT collectible, even though the parent Event remains active", () => {
    expect(isEventParticipantCollectible("scheduled", "cancelled")).toBe(false);
  });

  it("3. Event participant: CANCELLED Event + confirmed participant => NOT collectible", () => {
    expect(isEventParticipantCollectible("cancelled", "confirmed")).toBe(false);
  });

  it("4. Event participant: a non-cancelled parent Event status (e.g. a hypothetical 'completed') + valid confirmed participant => collectible, mirroring completed-service debt remaining collectible elsewhere in this app", () => {
    expect(isEventParticipantCollectible("completed", "confirmed")).toBe(true);
  });

  it("both statuses cancelled at once is still NOT collectible (either alone is sufficient to block)", () => {
    expect(isEventParticipantCollectible("cancelled", "cancelled")).toBe(false);
  });

  it("Event guest: gated on the PARENT event's status only (event_guest has no lifecycle status column of its own)", () => {
    expect(isEventGuestCollectible("cancelled")).toBe(false);
    expect(isEventGuestCollectible("scheduled")).toBe(true);
  });

  it("5. Program enrollment: active Program + enrolled enrollment => collectible", () => {
    expect(isProgramEnrollmentCollectible("active", "enrolled")).toBe(true);
  });

  it("6. Program enrollment: active Program + CANCELLED enrollment => NOT collectible, even though the parent Program remains active", () => {
    expect(isProgramEnrollmentCollectible("active", "cancelled")).toBe(false);
  });

  it("7. Program enrollment: CANCELLED Program + enrolled enrollment => NOT collectible", () => {
    expect(isProgramEnrollmentCollectible("cancelled", "enrolled")).toBe(false);
  });

  it("8. Program enrollment: completed Program + enrolled enrollment => collectible (delivered service, debt still owed)", () => {
    expect(isProgramEnrollmentCollectible("completed", "enrolled")).toBe(true);
  });

  it("both statuses cancelled at once is still NOT collectible (either alone is sufficient to block)", () => {
    expect(isProgramEnrollmentCollectible("cancelled", "cancelled")).toBe(false);
  });
});

describe("formatHistoryTimestamp — financial-history timestamps rendered in the club's own timezone", () => {
  it("renders a compact 'date, time' operator timestamp in the given timezone", () => {
    // 2026-08-28T17:29:00Z = 1:29 PM America/New_York (EDT, UTC-4).
    expect(formatHistoryTimestamp("2026-08-28T17:29:00Z", "America/New_York")).toBe("Aug 28, 1:29 PM");
  });

  it("uses the GIVEN club timezone, not the browser/device timezone — the SAME UTC instant renders differently in New York vs Los Angeles", () => {
    const ny = formatHistoryTimestamp("2026-08-28T17:29:00Z", "America/New_York");
    const la = formatHistoryTimestamp("2026-08-28T17:29:00Z", "America/Los_Angeles");
    expect(ny).toBe("Aug 28, 1:29 PM");
    expect(la).toBe("Aug 28, 10:29 AM");
    expect(ny).not.toBe(la);
  });
});
