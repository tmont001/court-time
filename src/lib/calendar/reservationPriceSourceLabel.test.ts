import { describe, expect, it } from "vitest";
import { reservationPriceSourceLabel } from "./reservationPriceSourceLabel";

describe("reservationPriceSourceLabel", () => {
  it("prefers the human period name whenever one is present, regardless of source", () => {
    expect(reservationPriceSourceLabel("rate_period_member", "Peak")).toBe("Peak");
    expect(reservationPriceSourceLabel("rate_period_non_member", "Off-Peak")).toBe("Off-Peak");
    expect(reservationPriceSourceLabel("rate_period_member", "Weekday Evening")).toBe("Weekday Evening");
  });

  it("maps any court_override_* source to the human label 'Court rate'", () => {
    expect(reservationPriceSourceLabel("court_override_member", null)).toBe("Court rate");
    expect(reservationPriceSourceLabel("court_override_non_member", null)).toBe("Court rate");
  });

  it("maps any club_default_* source to the human label 'Standard rate'", () => {
    expect(reservationPriceSourceLabel("club_default_member", null)).toBe("Standard rate");
    expect(reservationPriceSourceLabel("club_default_non_member", null)).toBe("Standard rate");
  });

  it("returns null for 'unpriced' — no source label when there is no rate", () => {
    expect(reservationPriceSourceLabel("unpriced", null)).toBeNull();
  });

  it("returns null for a missing/unrecognized source", () => {
    expect(reservationPriceSourceLabel(null, null)).toBeNull();
    expect(reservationPriceSourceLabel(undefined, undefined)).toBeNull();
    expect(reservationPriceSourceLabel("some_future_source", null)).toBeNull();
  });

  it("never returns a raw internal identifier verbatim", () => {
    for (const source of [
      "rate_period_member",
      "rate_period_non_member",
      "court_override_member",
      "court_override_non_member",
      "club_default_member",
      "club_default_non_member",
    ]) {
      const label = reservationPriceSourceLabel(source, null);
      expect(label).not.toBe(source);
      expect(label === null || !label.includes("_")).toBe(true);
    }
  });

  it("an empty-string period name is treated as absent, not as a label", () => {
    expect(reservationPriceSourceLabel("court_override_member", "")).toBe("Court rate");
  });
});
