import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 34F-D, Item 4 — a completed (or cancelled) Program is historical,
// not erased: staff must still be able to VIEW its roster (enrollment
// status, payment state/history) from the Manage → Programs UI. The
// regression this fixes: ProgramsManageClient's own action-button branch
// for status IN ('cancelled','completed') rendered ONLY an Archive button —
// the "Roster" button that opens ProgramRosterSheet existed only in the
// status === 'active' branch, so once a Program left 'active' its roster
// became unreachable from this UI even though get_program_roster (0092)
// itself has no status restriction at all.
//
// Fix: the Roster button is now also rendered in the cancelled/completed
// branch, and ProgramRosterSheet is told the Program's own current status
// (programStatus prop) so it can switch itself read-only (no Add Member /
// Remove / Force Confirm) for anything other than 'active' — without
// touching Record Payment (governed by its own, unrelated financial-
// lifecycle rules) or reopening any enrollment/Member Pay Now path.
//
// Covers items 14-19 from the 34F-D spec.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const MANAGE_CLIENT_PATH = "src/app/(app)/events/ProgramsManageClient.tsx";
const ROSTER_SHEET_PATH  = "src/app/(app)/events/ProgramRosterSheet.tsx";
const PROGRAMS_ACTIONS_PATH = "src/app/(app)/events/programsActions.ts";
const M0091_PATH = "supabase/migrations/0091_whole_program_enrollment.sql";
const M0092_PATH = "supabase/migrations/0092_program_roster_management.sql";

function getCancelledCompletedBranch(): string {
  const s = readSource(MANAGE_CLIENT_PATH);
  const start = s.indexOf("// status is 'cancelled' or 'completed', not yet archived.");
  const end = s.indexOf("{/* Inline destructive confirmation", start);
  return s.slice(start, end);
}

// ═══════════════════════════════════════════════════════════════════════════
// 14/15 — Completed Program remains visible; staff can open its roster
// ═══════════════════════════════════════════════════════════════════════════

describe("14/15. a completed (or cancelled) Program remains visible in Manage → Programs, and authorized staff can open its roster", () => {
  it("14. the default ('active' archiveView) getPrograms query filters ONLY on archived_at IS NULL — never on status — so a completed/cancelled-but-not-archived Program was ALWAYS already listed here; the regression was specifically the missing Roster button, not list visibility", () => {
    const s = readSource(PROGRAMS_ACTIONS_PATH);
    const idx = s.indexOf("const filteredQuery =");
    const block = s.slice(idx, s.indexOf(";", idx) + 1);
    expect(block).toContain('archiveView === "archived" ? baseQuery.not("archived_at", "is", null) :');
    expect(block).toContain('archiveView === "all"      ? baseQuery :');
    expect(block).toContain('baseQuery.is("archived_at", null)');
    expect(block).not.toMatch(/\.eq\("status"/);
  });

  it("15. the cancelled/completed action-button branch now renders a Roster button (gated on enrollment_model === 'program', matching the active branch's own identical gate) in addition to Archive", () => {
    const block = getCancelledCompletedBranch();
    expect(block).toContain('p.enrollment_model === "program"');
    expect(block).toContain("onClick={() => setViewingRoster(p)}");
    expect(block).toMatch(/>\s*Roster\s*</);
    expect(block).toContain('onClick={() => setConfirmingAction({ programId: p.id, action: "archive" })}');
  });

  it("get_program_roster (0092, unmodified) has no status/archived_at restriction on the parent Program at all — the read path already fully supported completed Programs before this fix; only the UI's own Roster button was missing", () => {
    const s = readSource(M0092_PATH);
    const fnStart = s.indexOf("create or replace function public.get_program_roster(p_program_id uuid)");
    const fnEnd = s.indexOf("\n$$;", fnStart) + "\n$$;".length;
    const fn = s.slice(fnStart, fnEnd);
    expect(fn).not.toMatch(/v_program\.status|program_not_archivable|program_not_active/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 16 — roster is read-only where lifecycle requires
// ═══════════════════════════════════════════════════════════════════════════

describe("16. ProgramRosterSheet switches to read-only (no Add Member / Remove / Force Confirm) for any non-'active' Program", () => {
  const src = () => readSource(ROSTER_SHEET_PATH);

  it("isReadOnly is derived purely from the programStatus prop — true whenever it is defined and not 'active'", () => {
    const s = src();
    expect(s).toContain('const isReadOnly = programStatus !== undefined && programStatus !== "active";');
  });

  it("the Add Member control is entirely hidden (not merely disabled) when read-only", () => {
    const s = src();
    const idx = s.indexOf("{!isReadOnly && (\n            <div className=\"mb-5\">");
    expect(idx).toBeGreaterThan(-1);
    const block = s.slice(idx, idx + 400);
    expect(block).toContain("+ Add Member");
  });

  it("every per-row Remove trigger/confirmation (enrolled, offered, waitlisted sections) is gated on !isReadOnly — three sections, six gated blocks total (trigger + confirmation each)", () => {
    const s = src();
    const occurrences = s.split("!isReadOnly &&").length - 1;
    // Add Member (1) + enrolled Remove trigger/confirm (2) + offered
    // Force-Confirm-or-Remove trigger/confirm (2) + waitlisted trigger/
    // confirm (2) = 7 total gates.
    expect(occurrences).toBe(7);
  });

  it("Force Confirm (offered and waitlisted sections) is gated behind the SAME !isReadOnly condition as its sibling Remove button, not a separate/looser one", () => {
    const s = src();
    expect(s).toContain('{!isReadOnly && !isConfirming && (\n                              <div className="ml-3 flex items-center gap-2 shrink-0">');
    expect(s).toContain('{!isReadOnly && !isConfirming && (\n                              <div className="ml-2 flex items-center gap-2 shrink-0">');
  });

  it("a visible banner explains the read-only state to staff, naming the Program's own current status", () => {
    const s = src();
    expect(s).toContain("This program is {programStatus} — the roster is shown for reference only.");
  });

  it("add_program_member/add_program_roster_member already independently re-enforce 'active'-only server-side via _program_is_enrollable (0091) — isReadOnly is a UI mirror of an already-existing authorization boundary, not a new one", () => {
    const s = readSource(M0091_PATH);
    const fnStart = s.indexOf("create or replace function public._program_is_enrollable(");
    const fnEnd = s.indexOf("\n$$;", fnStart) + "\n$$;".length;
    const fn = s.slice(fnStart, fnEnd);
    expect(fn).toContain("if p_program.status <> 'active' then");
    expect(fn).toContain("return false;");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 17 — payment state/history remains visible
// ═══════════════════════════════════════════════════════════════════════════

describe("17/8. payment badges/history remain fully visible on a cancelled Program's roster — only the Record Payment ACTION is withheld", () => {
  it("PaymentStateBadge rendering is NEVER gated by isReadOnly or recordPaymentLifecycleBlocked — a cancelled Program's roster still shows every enrolled Member's payment state/history", () => {
    const s = readSource(ROSTER_SHEET_PATH);
    const badgeIdx = s.indexOf("<PaymentStateBadge state={paymentStateByRowKey.get(key)} />");
    expect(badgeIdx).toBeGreaterThan(-1);
    const precedingBlock = s.slice(badgeIdx - 400, badgeIdx);
    expect(precedingBlock).not.toMatch(/isReadOnly|recordPaymentLifecycleBlocked/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 34F-D correction round — ProgramRosterSheet's own Record Payment action
// must distinguish completed (allowed) from cancelled (blocked), separately
// from isReadOnly (which gates enrollment-changing actions only). Covers
// items 5, 6, 7 from the follow-up spec.
// ═══════════════════════════════════════════════════════════════════════════

describe("ProgramRosterSheet Record Payment — lifecycle-specific predicate, distinct from isReadOnly (5, 6, 7)", () => {
  const src = () => readSource(ROSTER_SHEET_PATH);

  it("recordPaymentLifecycleBlocked is its OWN predicate, computed only from programStatus === 'cancelled' — never reusing isReadOnly, which would incorrectly suppress Record Payment for a completed Program too", () => {
    const s = src();
    expect(s).toContain('const recordPaymentLifecycleBlocked = programStatus === "cancelled";');
  });

  it("5. active Program: recordPaymentLifecycleBlocked is false (programStatus !== 'cancelled') — Record Payment renders whenever canRecordPayment && isPaymentOpenForRecording are true, unchanged from before this correction", () => {
    const s = src();
    const idx = s.indexOf("{canRecordPayment && !recordPaymentLifecycleBlocked && isPaymentOpenForRecording(paymentStateByRowKey.get(key)) && (");
    expect(idx).toBeGreaterThan(-1);
  });

  it("6. completed Program: recordPaymentLifecycleBlocked is false ('completed' !== 'cancelled') — Record Payment remains available when the financial state is otherwise open, exactly like active", () => {
    const s = src();
    // The predicate only ever compares against 'cancelled' — 'completed'
    // is never mentioned anywhere near it, meaning it structurally falls
    // through to false for a completed Program.
    const predicateIdx = s.indexOf('const recordPaymentLifecycleBlocked = programStatus === "cancelled";');
    const surrounding = s.slice(predicateIdx, predicateIdx + 700);
    expect(surrounding).not.toMatch(/completed/);
  });

  it("7. cancelled Program: recordPaymentLifecycleBlocked is true — the Record Payment button is hidden even when isPaymentOpenForRecording would otherwise allow it", () => {
    const s = src();
    const idx = s.indexOf("{canRecordPayment && !recordPaymentLifecycleBlocked && isPaymentOpenForRecording(paymentStateByRowKey.get(key)) && (");
    expect(idx).toBeGreaterThan(-1);
    // The gate is a genuine AND-clause (not merely documented) — the
    // button's own render condition literally includes
    // !recordPaymentLifecycleBlocked as one of its three conjuncts.
    const buttonCondition = s.slice(idx, idx + 120);
    expect(buttonCondition).toContain("canRecordPayment");
    expect(buttonCondition).toContain("!recordPaymentLifecycleBlocked");
    expect(buttonCondition).toContain("isPaymentOpenForRecording");
  });

  it("Record Payment is NOT gated by isReadOnly anywhere — proves the fix didn't just reuse the enrollment-actions flag, which would have wrongly blocked a completed Program's Record Payment too", () => {
    const s = src();
    const idx = s.indexOf("canRecordPayment && !recordPaymentLifecycleBlocked && isPaymentOpenForRecording");
    const line = s.slice(Math.max(0, idx - 50), idx + 200);
    expect(line).not.toContain("isReadOnly");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9 — no financial mutation introduced by either surface's correction
// ═══════════════════════════════════════════════════════════════════════════

describe("9. no financial mutation introduced by the Program Record Payment correction, on either surface", () => {
  it("ProgramRosterSheet still calls no refund/waive/void RPC — recordPaymentLifecycleBlocked only ever controls whether the (unmodified) RecordPaymentSheet is offered, never mutates payments/program_enrollments itself", () => {
    const s = readSource(ROSTER_SHEET_PATH);
    expect(s).not.toMatch(/waive_payment|void_payment_obligation|record_refund/);
  });

  it("/admin/payments page.tsx still calls no refund/waive/void RPC for the Program branch either", () => {
    const s = readSource("src/app/(app)/admin/payments/page.tsx");
    expect(s).not.toMatch(/waive_payment|void_payment_obligation|record_refund/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 18 — completed state is not accidentally changed back to active
// ═══════════════════════════════════════════════════════════════════════════

describe("18. this fix never mutates programs.status — purely a read/visibility + UI-gating change", () => {
  it("ProgramsManageClient's cancelled/completed branch adds ONLY a Roster button (client-side view state, setViewingRoster) alongside the pre-existing Archive button — no new lifecycle-mutating call", () => {
    const block = getCancelledCompletedBranch();
    expect(block).not.toMatch(/handleComplete|handleCancel\(|handleUnarchive|completeProgram\(|cancelProgram\(|archiveProgram\(/);
    expect(block).toContain("setViewingRoster(p)");
  });

  it("ProgramRosterSheet itself calls no Program-lifecycle RPC/action at all (complete_program/archive_program/cancel_program/unarchive_program) — only the pre-existing roster-membership actions (add/remove/force-confirm), which are unaffected by isReadOnly's OWN definition (isReadOnly only controls rendering, not any new RPC)", () => {
    const s = readSource(ROSTER_SHEET_PATH);
    expect(s).not.toMatch(/completeProgram|archiveProgram|unarchiveProgram|cancelProgram/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 19 — Member eligibility (Program Checkout) behavior unchanged
// ═══════════════════════════════════════════════════════════════════════════

describe("19. Member Program Checkout eligibility is completely unaffected by this staff-visibility fix", () => {
  it("ProgramRosterSheet never imports or calls anything from programCheckoutActions.ts — Member Pay Now remains governed exclusively by the already-proven 34F-C Program Checkout RPCs/actions, never by anything in this admin roster sheet", () => {
    const s = readSource(ROSTER_SHEET_PATH);
    expect(s).not.toMatch(/programCheckoutActions|createProgramCheckoutAction|get_program_payment_for_checkout/);
  });

  it("ProgramEnrollmentCard.tsx (the ONE canonical Member Pay Now surface) is untouched by this checkpoint's roster-visibility fix — no reference to isReadOnly/programStatus-as-read-only-gate exists there", () => {
    const s = readSource("src/app/(app)/events/ProgramEnrollmentCard.tsx");
    expect(s).not.toMatch(/isReadOnly/);
  });
});
