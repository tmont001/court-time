import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Production-polish checkpoint: a production Lighthouse run on /calendar
// reported ~110 button-name accessibility failures — every 30-minute grid
// slot rendered as a <button> with no text content, aria-label, or title,
// whether or not it was actually clickable. This repository's Vitest
// config has no jsdom/RTL, so — matching this project's established
// source-inspection precedent (see eventPriceOverride.regression.test.ts
// and others) — this file asserts the CURRENT SHAPE of the fix directly
// from source rather than rendering the component.
//
// The fix: only a genuinely bookable slot (not occupied, not past, not on
// a closed day) remains a real <button>, now with a descriptive
// aria-label. A disabled slot is redundant with the reservation/event
// block already rendered on top of it (when occupied) or simply conveys
// no action at all (when past/closed) — native `disabled` already made it
// unclickable, so rendering it as a plain, un-labeled <div> instead changes
// nothing about booking behavior while removing it from the accessibility
// tree.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const src = readSource("src/app/(app)/calendar/CalendarShell.tsx");

// Isolates the 30-min slot tap-target block, from its own explanatory
// comment to the reservation-blocks comment that follows it in the JSX.
function slotTapTargetRegion(s: string): string {
  const start = s.indexOf("{/* 30-min slot tap targets */}");
  expect(start, "slot tap-target block not found").toBeGreaterThan(-1);
  const end = s.indexOf("{/* Reservation blocks", start);
  expect(end, "reservation-blocks comment not found after slot block").toBeGreaterThan(start);
  return s.slice(start, end);
}

describe("Calendar day-grid slot buttons — accessible-name invariant", () => {
  const region = slotTapTargetRegion(src);

  it("gives the bookable-slot button a descriptive aria-label (court + time)", () => {
    expect(region).toContain("aria-label={`Book ${court.name} at ${slot.time}`}");
  });

  it("renders the disabled (occupied/past/closed) slot as a plain <div>, not an unlabeled <button>", () => {
    expect(region).toMatch(/if \(isDisabled\) \{\s*return \(\s*<div/);
  });

  it("no longer renders every slot — including disabled ones — as a <button> (the pre-fix shape)", () => {
    // The old, single-branch implementation always returned exactly one
    // <button ... disabled={isDisabled} ...> per slot. Confirms that shape
    // is gone, not just that a div exists somewhere nearby.
    expect(region).not.toContain("disabled={isDisabled}");
  });

  it("the bookable button still wires up the real booking click handler", () => {
    expect(region).toContain("onClick={() => handleSlotTap(court, slotIdx)}");
  });
});

describe("Calendar time slots — full time string available for accessible names", () => {
  it("TimeSlot carries a `time` field distinct from the sparse gutter `label`", () => {
    expect(src).toContain("interface TimeSlot { label: string; time: string; isHour: boolean }");
  });

  it("buildTimeSlots populates `time` for both the on-the-hour and half-hour slot", () => {
    const start = src.indexOf("function buildTimeSlots(");
    expect(start, "buildTimeSlots not found").toBeGreaterThan(-1);
    const end = src.indexOf("\n}", start);
    const body = src.slice(start, end);
    expect(body).toContain("time: `${display}:00 ${ampm}`");
    expect(body).toContain("time: `${display}:30 ${ampm}`");
  });
});
