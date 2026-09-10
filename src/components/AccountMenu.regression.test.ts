import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Production-polish checkpoint: a production Lighthouse run flagged the
// account-menu trigger with a WCAG 2.5.3 (label-in-name) mismatch — the
// visible initials ("HH") were not included in the button's accessible
// name ("Account menu"), even though they're marked aria-hidden (which
// hides them from the accessibility tree but not from what a sighted user
// sees, so the mismatch check still fires). Source-inspection style, per
// this repository's established precedent — no jsdom in this Vitest config.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const src = readSource("src/components/AccountMenu.tsx");

describe("AccountMenu trigger — WCAG 2.5.3 label-in-name invariant", () => {
  it("the accessible name includes the visible initials", () => {
    expect(src).toContain("aria-label={`Account menu, ${userInitials}`}");
  });

  it("the visible initials stay aria-hidden (not double-announced with the label)", () => {
    expect(src).toContain('<span aria-hidden="true">{userInitials}</span>');
  });
});
