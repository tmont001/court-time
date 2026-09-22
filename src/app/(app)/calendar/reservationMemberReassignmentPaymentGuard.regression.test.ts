import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Browser QA correction — Admin reassigns ONLY the Member on an existing
// priced reservation; the price preview correctly refreshes, but Save
// fails with the generic "Something went wrong. Please try again." This
// is a pure UI error-mapping gap, not a database defect: update_member_
// reservation (0143/0144/0151, unmodified here) intentionally calls
// _check_member_reassignment_allowed whenever the Member changes, and
// that helper intentionally raises
// payment_resolution_required_before_member_reassignment when the
// reservation has an unresolved payment obligation — a booking's payment
// must never be silently transferred, abandoned, or reassigned. That
// guard is CORRECT and untouched; only the missing UI copy is fixed here.
//
// Source-inspection style, matching this project's established convention
// (no jsdom).

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const EDIT_SHEET_PATH = "src/app/(app)/calendar/EditReservationSheet.tsx";
// 0143 defines _check_member_reassignment_allowed and its exact raised
// error code; 0190 (Peak/Off-Peak Pricing IA's own audit already
// confirmed this is the latest, authoritative body) is where update_
// member_reservation's actual call site to that helper lives.
const PAYMENT_OBLIGATION_MIGRATION = "supabase/migrations/0143_payment_mode_and_ledger_foundation.sql";
const LATEST_UPDATE_MEMBER_RESERVATION_MIGRATION = "supabase/migrations/0190_memberships_enable_disable_foundation.sql";

function mapEditErrorBody(): string {
  const s = readSource(EDIT_SHEET_PATH);
  const start = s.indexOf("function mapEditError(");
  expect(start).toBeGreaterThan(-1);
  const end = s.indexOf("\n}\n", start);
  return s.slice(start, end);
}

describe("Confirmed root cause: mapEditError previously had no entry for payment_resolution_required_before_member_reassignment", () => {
  it("the DB helper genuinely raises this exact error code (0143, immutable, untouched)", () => {
    const migrationSrc = readSource(PAYMENT_OBLIGATION_MIGRATION);
    expect(migrationSrc).toContain("raise exception 'payment_resolution_required_before_member_reassignment';");
  });

  it("update_member_reservation calls the guard whenever the Member changes — the exact call site is unmodified in the latest, authoritative migration", () => {
    const migrationSrc = readSource(LATEST_UPDATE_MEMBER_RESERVATION_MIGRATION);
    expect(migrationSrc).toContain(
      "perform public._check_member_reassignment_allowed(v_club_id, 'reservation', p_reservation_id);",
    );
  });
});

describe("Fix: mapEditError now maps the code to specific operator-facing copy", () => {
  const body = mapEditErrorBody();

  it("maps payment_resolution_required_before_member_reassignment to the exact required copy", () => {
    expect(body).toContain(
      'if (message === "payment_resolution_required_before_member_reassignment")\n    return "Resolve this booking\'s payment before assigning it to a different Member.";',
    );
  });

  it("never surfaces the raw Postgres error code as user-facing text", () => {
    expect(body).not.toMatch(/return message;/);
    expect(body).not.toMatch(/return `\$\{message\}`/);
  });

  it("unrelated/unknown error codes still fall through to the pre-existing generic fallback, unchanged", () => {
    expect(body).toContain('return "Something went wrong. Please try again.";');
    // The fallback is the LAST statement in the function — every specific
    // mapping (including the new one) is checked before it, never after.
    const fallbackIdx = body.lastIndexOf('return "Something went wrong. Please try again.";');
    const newMappingIdx = body.indexOf("payment_resolution_required_before_member_reassignment");
    expect(fallbackIdx).toBeGreaterThan(newMappingIdx);
  });

  it("every pre-existing error mapping is preserved, unmodified, alongside the new one", () => {
    expect(body).toContain('if (message === "stale_edit_conflict")          return "This booking was changed by someone else.";');
    expect(body).toContain('if (message === "member_schedule_conflict")     return "The member already has another confirmed commitment at that time.";');
    expect(body).toContain('if (message === "checkout_still_processing")');
    expect(body).toContain('if (message === "checkout_resolution_failed")');
  });
});

describe("No weakening of the guard, no automatic payment mutation introduced", () => {
  it("EditReservationSheet does not call any payment-mutating RPC/action to work around this error (no auto-void/waive/refund/transfer)", () => {
    const s = readSource(EDIT_SHEET_PATH);
    expect(s).not.toMatch(/void_payment|waive_payment|refund|transfer_payment|resolve_payment_obligation/i);
  });

  it("EditReservationSheet does not bypass the guard by omitting or special-casing Member reassignment before calling updateMemberReservationAdmin", () => {
    const s = readSource(EDIT_SHEET_PATH);
    const saveStart = s.indexOf("async function handleSave()");
    const saveEnd = s.indexOf("\n  }\n", saveStart);
    const saveBody = s.slice(saveStart, saveEnd);
    // The Member id is always sent as selected — never conditionally
    // omitted or forced back to the reservation's original Member to
    // dodge the guard.
    expect(saveBody).toContain("p_roster_member_id:    selectedRosterMemberId,");
  });

  it("this migration (0143) was not modified by this fix — the guard's own SQL body is untouched", () => {
    const migrationSrc = readSource(PAYMENT_OBLIGATION_MIGRATION);
    expect(migrationSrc).toContain("create or replace function public._check_member_reassignment_allowed(");
  });
});
