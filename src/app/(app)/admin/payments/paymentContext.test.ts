import { describe, expect, it } from "vitest";
import {
  dateTimeRangeLabel,
  reservationLifecycleLabel,
  lessonRequestLifecycleLabel,
  eventParticipantLifecycleLabel,
  eventGuestLifecycleLabel,
  programEnrollmentLifecycleLabel,
  formatHistoryTimestamp,
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
