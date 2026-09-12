import { describe, expect, it } from "vitest";
import { lessonDependsOnLiveReservation } from "./lessonAccess";

const RES_ID = "11111111-1111-1111-1111-111111111111";

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
