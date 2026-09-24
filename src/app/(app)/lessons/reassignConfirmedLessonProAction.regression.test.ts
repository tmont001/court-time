import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 38A — regression coverage for reassignConfirmedLessonProAction, the
// Server Action wrapper over admin_reassign_confirmed_lesson_pro (0180).
// Source-inspection style, matching this repository's established
// convention for "use server" files with no jsdom/Supabase mocking
// baseline (see lessonCheckout.regression.test.ts's identical approach for
// cancelLesson).

const ACTIONS_PATH = "src/app/(app)/lessons/actions.ts";

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

function getFn(): string {
  const s = readSource(ACTIONS_PATH);
  const start = s.indexOf("export async function reassignConfirmedLessonProAction(");
  const end = s.indexOf("export async function getConfirmedReassignmentProsAction(");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return s.slice(start, end);
}

function getPickerFn(): string {
  const s = readSource(ACTIONS_PATH);
  const start = s.indexOf("export async function getConfirmedReassignmentProsAction(");
  // Phase 44A (0208): adminCreateLessonRequestAction, the prior end-of-slice
  // delimiter, was retired (dead export, zero callers). Replaced with the
  // next stable live function boundary — this changes only which source
  // text this slice ends at, not the behavior under test.
  const end = s.indexOf("export async function adminCreateMemberLessonAction(");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return s.slice(start, end);
}

describe("reassignConfirmedLessonProAction — RPC call shape", () => {
  it("calls admin_reassign_confirmed_lesson_pro with exactly the three expected params", () => {
    const fn = getFn();
    expect(fn).toContain('supabase.rpc("admin_reassign_confirmed_lesson_pro"');
    expect(fn).toContain("p_request_id:          params.requestId");
    expect(fn).toContain("p_expected_updated_at: params.expectedUpdatedAt");
    expect(fn).toContain("p_new_pro_id:          params.newProId");
  });

  it("guards with assertActiveClub before calling the RPC, matching every other lesson mutation action's stale-club preflight", () => {
    const fn = getFn();
    const guardIdx = fn.indexOf("assertActiveClub(params.expectedClubId)");
    const rpcIdx = fn.indexOf('supabase.rpc("admin_reassign_confirmed_lesson_pro"');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(rpcIdx).toBeGreaterThan(guardIdx);
  });

  it("maps a returned error through mapLessonError, never surfacing a raw Postgres error code", () => {
    const fn = getFn();
    expect(fn).toContain("if (error) return { error: mapLessonError(error.message) };");
  });
});

describe("security review correction: no client-supplied identity fields", () => {
  it("the action's parameter object accepts ONLY mutation intent — requestId, expectedUpdatedAt, newProId, expectedClubId — never oldProId/memberId/actorId", () => {
    const s = readSource(ACTIONS_PATH);
    const sigStart = s.indexOf("export async function reassignConfirmedLessonProAction(params: {");
    const sigEnd = s.indexOf("}): Promise<{ error?: string }> {", sigStart);
    expect(sigStart).toBeGreaterThan(-1);
    expect(sigEnd).toBeGreaterThan(sigStart);
    const signature = s.slice(sigStart, sigEnd);
    expect(signature).toContain("requestId:         string;");
    expect(signature).toContain("expectedUpdatedAt: string;");
    expect(signature).toContain("newProId:          string;");
    expect(signature).toContain("expectedClubId:    string;");
    expect(signature).not.toMatch(/oldProId|memberId|actorId/);
  });

  it("actorId is derived from getAuthUser() — the caller's own authenticated session — never a parameter", () => {
    const fn = getFn();
    expect(fn).toContain("const actorUser = await getAuthUser();");
    expect(fn).toContain("const actorId = actorUser?.id ?? null;");
    expect(fn).not.toMatch(/params\.actorId/);
  });

  it("getAuthUser is imported from the established @/lib/supabase/user module, the same one calendar/actions.ts's getReservationDeepLinkDetail already uses for the identical purpose", () => {
    const s = readSource(ACTIONS_PATH);
    expect(s).toContain('import { getAuthUser } from "@/lib/supabase/user";');
  });

  it("oldProId is derived from a trusted pre-mutation table read (lesson_requests.pro_id, scoped by id + club_id) — never a parameter", () => {
    const fn = getFn();
    expect(fn).toMatch(/\.from\("lesson_requests"\)\s*\n\s*\.select\("pro_id"\)\s*\n\s*\.eq\("id", params\.requestId\)\s*\n\s*\.eq\("club_id", params\.expectedClubId\)/);
    expect(fn).toContain("const oldProId = before?.pro_id ?? null;");
    expect(fn).not.toMatch(/params\.oldProId/);
  });

  it("the trusted pre-mutation read happens BEFORE the RPC call — pro_id is only recoverable pre-mutation, since the RPC overwrites it", () => {
    const fn = getFn();
    const readIdx = fn.indexOf('.from("lesson_requests")');
    const rpcIdx = fn.indexOf('supabase.rpc("admin_reassign_confirmed_lesson_pro"');
    expect(readIdx).toBeGreaterThan(-1);
    expect(rpcIdx).toBeGreaterThan(readIdx);
  });

  it("memberId is derived from the RPC's own post-mutation returned row (result.member_id) — never a parameter", () => {
    const fn = getFn();
    expect(fn).toContain("const memberId = result?.member_id ?? null;");
    expect(fn).not.toMatch(/params\.memberId/);
  });

  it("newProId remains client-selected mutation intent, unconditionally passed through to 0180 for its own full eligibility/conflict validation", () => {
    const fn = getFn();
    expect(fn).toContain("p_new_pro_id:          params.newProId");
  });
});

describe("notification behavior — old Pro, new Pro, and Member, all from trusted identities", () => {
  it("always emails the new Pro (they always have an account) — newProId is validated mutation intent, not a routing-trust concern", () => {
    const fn = getFn();
    expect(fn).toContain('dispatchLessonEmail(params.newProId, "lesson_provider_reassigned", resultId)');
  });

  it("emails the old Pro (trusted oldProId) unless the old Pro is themselves the actor (trusted actorId) — same self-notification-skip convention cancelLesson already uses", () => {
    const fn = getFn();
    expect(fn).toMatch(/if \(oldProId && actorId !== oldProId\) \{[\s\S]{0,120}dispatchLessonEmail\(oldProId, "lesson_provider_reassigned", resultId\)/);
  });

  it("emails a claimed Member (trusted memberId) unless the Member is themselves the actor (trusted actorId)", () => {
    const fn = getFn();
    expect(fn).toMatch(/if \(memberId && actorId !== memberId\) \{[\s\S]{0,120}dispatchLessonEmail\(memberId, "lesson_provider_reassigned", resultId\)/);
  });

  it("a no-account Member (memberId null) gets the SAME roster operational email mechanism cancelLesson already uses — sendRosterOperationalEmail + rosterOperationalEmailTemplate — never a new communications path", () => {
    const fn = getFn();
    const idx = fn.indexOf("else if (!memberId && result?.roster_member_id)");
    expect(idx).toBeGreaterThan(-1);
    const block = fn.slice(idx);
    expect(block).toContain("sendRosterOperationalEmail(");
    expect(block).toContain("rosterOperationalEmailTemplate(");
    expect(block).toContain("resolveLessonDisplayNames(");
  });

  it("resolves the new pro's display name server-side from the trusted, already-validated newProId — never a client-supplied display string", () => {
    const fn = getFn();
    expect(fn).toContain("resolveLessonDisplayNames(\n        supabase, params.expectedClubId, params.newProId, result.proposed_court_id ?? null,\n      )");
  });

  it("no accidental double-send: each of the three recipients (new pro, old pro, member) is emailed via exactly one dispatchLessonEmail/sendRosterOperationalEmail call site, never two", () => {
    const fn = getFn();
    expect(fn.split('dispatchLessonEmail(params.newProId,').length - 1).toBe(1);
    expect(fn.split('dispatchLessonEmail(oldProId,').length - 1).toBe(1);
    expect(fn.split('dispatchLessonEmail(memberId,').length - 1).toBe(1);
    expect(fn.split("sendRosterOperationalEmail(").length - 1).toBe(1);
  });
});

describe("payment non-interference — this action never touches Stripe/checkout/payments", () => {
  it("never references payments, Stripe, checkout, or refund — unlike cancelLesson/proposeLessonTime, reassignment has no payment-obligation interaction at all", () => {
    const fn = getFn();
    expect(fn).not.toMatch(/payments|stripe|checkout|refund/i);
  });

  it("never uses the OPEN_CHECKOUT_REQUIRES_RESOLUTION retry handshake — that only exists for mutations that can invalidate a bound Checkout Session, which this one is not", () => {
    const fn = getFn();
    expect(fn).not.toMatch(/OPEN_CHECKOUT_REQUIRES_RESOLUTION|resolveBlockingCheckoutBeforeMutation|fetchPaymentStates/);
  });
});

describe("cache revalidation", () => {
  it("revalidates /events, /admin/lessons, and /calendar — the three surfaces that render a lesson's assigned Pro", () => {
    const fn = getFn();
    expect(fn).toContain('revalidatePath("/events");');
    expect(fn).toContain('revalidatePath("/admin/lessons");');
    expect(fn).toContain('revalidatePath("/calendar");');
  });
});

describe("mapLessonError has a friendly message for the new RPC's own error code", () => {
  it("invalid_status_for_pro_reassign is mapped", () => {
    const s = readSource(ACTIONS_PATH);
    expect(s).toMatch(/invalid_status_for_pro_reassign:\s*".+"/);
  });

  it("every other error admin_reassign_confirmed_lesson_pro can raise was already mapped before this phase (not_authenticated, insufficient_role, request_not_found, stale_edit_conflict, linked_reservation_not_found, cannot_reschedule_started_lesson, same_pro, pro_not_found, cannot_assign_to_self, pro_has_conflict)", () => {
    const s = readSource(ACTIONS_PATH);
    for (const code of [
      "not_authenticated", "insufficient_role", "request_not_found", "stale_edit_conflict",
      "linked_reservation_not_found", "cannot_reschedule_started_lesson", "same_pro",
      "pro_not_found", "cannot_assign_to_self", "pro_has_conflict",
    ]) {
      expect(s).toMatch(new RegExp(`${code}:\\s*".+"`));
    }
  });
});

describe("getConfirmedReassignmentProsAction — multi-club correction: confirmed-reassignment-only provider list", () => {
  it("calls get_confirmed_lesson_reassignment_pros (not get_admin_club_pros)", () => {
    const fn = getPickerFn();
    expect(fn).toContain('supabase.rpc("get_confirmed_lesson_reassignment_pros")');
    expect(fn).not.toMatch(/get_admin_club_pros/);
  });

  it("maps a returned error through mapLessonError, never surfacing a raw Postgres error code", () => {
    const fn = getPickerFn();
    expect(fn).toContain("if (error) return { error: mapLessonError(error.message) };");
  });

  it("returns the same ClubPro[] shape getClubProsAction/get_admin_club_pros already return — no new type, no duplicated shape", () => {
    const fn = getPickerFn();
    expect(fn).toContain("Promise<{ pros?: ClubPro[]; error?: string }>");
    expect(fn).toContain("return { pros: (data ?? []) as ClubPro[] };");
  });

  it("takes no parameters — the RPC itself scopes everything to the caller's own current club/role", () => {
    const fn = getPickerFn();
    expect(fn).toContain("export async function getConfirmedReassignmentProsAction(): Promise<");
  });
});
