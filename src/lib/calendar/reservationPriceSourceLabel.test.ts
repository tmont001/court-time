import { describe, expect, it } from "vitest";
import { reservationPriceSourceLabel, reservationPriceClassLabel } from "./reservationPriceSourceLabel";

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

// Final pre-merge polish: which pricing CLASS actually supplied the rate,
// derived from the applied_rate_source SUFFIX — never from
// membership_pricing_class, since a Non-Member can legitimately fall
// through the Non-Member chain into a Member/standard fallback.
describe("reservationPriceClassLabel", () => {
  it("maps a rate-period Member source to 'Member rate'", () => {
    expect(reservationPriceClassLabel("rate_period_member")).toBe("Member rate");
  });

  it("maps a rate-period Non-Member source to 'Non-Member rate'", () => {
    expect(reservationPriceClassLabel("rate_period_non_member")).toBe("Non-Member rate");
  });

  it("maps court-override and club-default sources to a human-readable class label", () => {
    expect(reservationPriceClassLabel("court_override_member")).toBe("Member rate");
    expect(reservationPriceClassLabel("court_override_non_member")).toBe("Non-Member rate");
    expect(reservationPriceClassLabel("club_default_member")).toBe("Member rate");
    expect(reservationPriceClassLabel("club_default_non_member")).toBe("Non-Member rate");
  });

  it("labels a Non-Member's fallthrough to a Member-chain source as 'Member rate' — the APPLIED source, never membership_pricing_class", () => {
    // A Non-Member caller can legitimately resolve through
    // court_override_member / rate_period_member / club_default_member
    // when no Non-Member-specific rate is configured (0200's own
    // fallback chain) — the label must describe what actually won.
    expect(reservationPriceClassLabel("court_override_member")).toBe("Member rate");
    expect(reservationPriceClassLabel("rate_period_member")).toBe("Member rate");
    expect(reservationPriceClassLabel("club_default_member")).toBe("Member rate");
  });

  it("returns null for 'unpriced' — no class label when there is no rate", () => {
    expect(reservationPriceClassLabel("unpriced")).toBeNull();
  });

  it("returns null for a missing/unrecognized source", () => {
    expect(reservationPriceClassLabel(null)).toBeNull();
    expect(reservationPriceClassLabel(undefined)).toBeNull();
    expect(reservationPriceClassLabel("some_future_source")).toBeNull();
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
      const label = reservationPriceClassLabel(source);
      expect(label).not.toBe(source);
      expect(label === null || !label.includes("_")).toBe(true);
    }
  });
});
