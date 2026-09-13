import { describe, expect, it } from "vitest";
import { lessonDependsOnLiveReservation, isPastConfirmedLesson } from "./lessonAccess";

const RES_ID = "11111111-1111-1111-1111-111111111111";
const NOW = new Date("2026-06-15T12:00:00.000Z");
const PAST_ISO = "2026-06-15T10:00:00.000Z";
const FUTURE_ISO = "2026-06-15T14:00:00.000Z";

describe("lessonDependsOnLiveReservation", () => {
  it("true for a confirmed lesson, with or without a linked reservation id present", () => {
    expect(lessonDependsOnLiveReservation("confirmed", RES_ID)).toBe(true);
    expect(lessonDependsOnLiveReservation("confirmed", null)).toBe(true);
  });

  it("true for a proposed RESCHEDULE — proposed status with a linked reservation already set", () => {
    expect(lessonDependsOnLiveReservation("proposed", RES_ID)).toBe(true);
  });

  it("false for a FRESH proposed — proposed status with no linked reservation yet (the normal case)", () => {
    expect(lessonDependsOnLiveReservation("proposed", null)).toBe(false);
  });

  it("false for pending — no reservation exists yet", () => {
    expect(lessonDependsOnLiveReservation("pending", null)).toBe(false);
  });

  it("false for declined, cancelled, and withdrawn — terminal states with no active reservation dependency", () => {
    expect(lessonDependsOnLiveReservation("declined", null)).toBe(false);
    expect(lessonDependsOnLiveReservation("cancelled", RES_ID)).toBe(false);
    expect(lessonDependsOnLiveReservation("withdrawn", null)).toBe(false);
  });

  it("false for an unrecognized/future status — fails closed to the direct-open path, never throws", () => {
    expect(() => lessonDependsOnLiveReservation("some_future_status", RES_ID)).not.toThrow();
    expect(lessonDependsOnLiveReservation("some_future_status", RES_ID)).toBe(false);
  });
});

describe("isPastConfirmedLesson", () => {
  it("false for a confirmed lesson whose proposed_starts_at is in the future", () => {
    expect(isPastConfirmedLesson("confirmed", FUTURE_ISO, NOW)).toBe(false);
  });

  it("true for a confirmed lesson whose proposed_starts_at is in the past", () => {
    expect(isPastConfirmedLesson("confirmed", PAST_ISO, NOW)).toBe(true);
  });

  it("true for a confirmed lesson starting at exactly `now` — boundary is inclusive, matching the RPCs' own <= now() guards", () => {
    expect(isPastConfirmedLesson("confirmed", NOW.toISOString(), NOW)).toBe(true);
  });

  it("false for any non-confirmed status regardless of the time value — pending/proposed/declined/cancelled/withdrawn are never classified as past", () => {
    for (const status of ["pending", "proposed", "declined", "cancelled", "withdrawn"]) {
      expect(isPastConfirmedLesson(status, PAST_ISO, NOW)).toBe(false);
    }
  });

  it("false when proposed_starts_at is null, even for a confirmed status — never misclassifies missing time data as past", () => {
    expect(isPastConfirmedLesson("confirmed", null, NOW)).toBe(false);
  });

  it("defaults `now` to the current time when omitted, never throws", () => {
    expect(() => isPastConfirmedLesson("confirmed", PAST_ISO)).not.toThrow();
    expect(isPastConfirmedLesson("confirmed", "2000-01-01T00:00:00.000Z")).toBe(true);
  });
});
