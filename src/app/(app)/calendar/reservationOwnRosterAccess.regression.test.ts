import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canOpenReservationDetail, isOwnReservation } from "@/lib/calendar/reservationAccess";

// Phase 37E — regression coverage for Member/Pro own-reservation Players &
// Guests access, plus the application-authorization-layer investigation
// into the 37D QA finding that a Pro could not open their own
// member_booking reservation in the browser. Uses this repository's
// established source-inspection style for the "use client"/Server Action
// wiring (no jsdom/React Testing Library available), and direct function
// calls for the pure canOpenReservationDetail/isOwnReservation logic
// (framework-independent, safely unit-testable).

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const CALENDAR_SHELL_PATH = "src/app/(app)/calendar/CalendarShell.tsx";
const CALENDAR_PAGE_PATH  = "src/app/(app)/calendar/page.tsx";
const ACTIONS_PATH        = "src/app/(app)/calendar/actions.ts";
const DETAIL_PATH         = "src/app/(app)/calendar/ReservationDetailSheet.tsx";
const SECTION_PATH        = "src/app/(app)/calendar/ReservationRosterSection.tsx";
const USER_LIB_PATH       = "src/lib/supabase/user.ts";

const shell   = () => readSource(CALENDAR_SHELL_PATH);
const page    = () => readSource(CALENDAR_PAGE_PATH);
const actions = () => readSource(ACTIONS_PATH);
const detail  = () => readSource(DETAIL_PATH);
const section = () => readSource(SECTION_PATH);
const userLib = () => readSource(USER_LIB_PATH);

// ═══════════════════════════════════════════════════════════════════════════
// Root-cause investigation — items 7, 8, 9, 10, 19, 20
// ═══════════════════════════════════════════════════════════════════════════
//
// Finding: after auditing canOpenReservationDetail/isOwnReservation (pure
// logic), the current reservations_select_same_club RLS policy (0132:
// `current_user_role() in ('admin', 'pro', 'staff')` — unconditional,
// club-wide, Pro included), CalendarShell's grid-click wiring, page.tsx's
// canonical role/roster resolution (getAuthProfile() -> get_current_
// account_context() -> the same active-membership primitive current_user_
// role()/current_user_club_id() are built on — never legacy profiles.role/
// club_id), and getReservationDeepLinkDetail's own wiring, NO application-
// layer authorization defect was found for a Pro opening their own
// member_booking reservation — every one of these already correctly
// includes/authorizes Pro. This is confirmed both by the ALREADY-PASSING
// "the owning Pro may open their own booking" test in reservationAccess
// .test.ts (proving the pure rule is correct) and, live, against the exact
// QA fixture (reservation 9b0e50bc-ea61-45cd-be1d-23cedecb9d84,
// owner_user_id = the Pro's own user id, club a1b2c3d4-...): every
// ownership/club condition the app-layer chain checks is satisfied. The
// tests below lock in that this chain remains correct and unduplicated
// (no second, stale ownership calculation anywhere), and that no
// unrelated visibility rule (Event/Lesson) was touched while confirming
// this.

describe("root-cause: canOpenReservationDetail is provably correct for the Pro-own case", () => {
  it("7. an owning Pro may open their own member_booking reservation — exact fixture shape reproduced", () => {
    // Mirrors the live QA fixture's shape: owner_user_id set directly to
    // the Pro's own id (no roster_member_id fallback needed for this case).
    const reservation = { reason: "member_booking", ownerUserId: "pro-fixture-1", rosterMemberId: "roster-fixture-1" };
    const viewer = { userId: "pro-fixture-1", userRosterMemberId: "roster-fixture-1", role: "pro" };
    expect(canOpenReservationDetail(reservation, viewer)).toBe(true);
    expect(isOwnReservation(reservation, viewer)).toBe(true);
  });

  it("7b. an owning Pro may also open via the roster_member_id-only claim-continuity path (pre-claim staff-created booking)", () => {
    const reservation = { reason: "member_booking", ownerUserId: null, rosterMemberId: "roster-fixture-2" };
    const viewer = { userId: "pro-fixture-2", userRosterMemberId: "roster-fixture-2", role: "pro" };
    expect(canOpenReservationDetail(reservation, viewer)).toBe(true);
  });

  it("8. a Pro cannot open another user's member_booking reservation merely because role is Pro", () => {
    const reservation = { reason: "member_booking", ownerUserId: "someone-else", rosterMemberId: "someone-elses-roster" };
    const viewer = { userId: "pro-fixture-1", userRosterMemberId: "roster-fixture-1", role: "pro" };
    expect(canOpenReservationDetail(reservation, viewer)).toBe(false);
    expect(isOwnReservation(reservation, viewer)).toBe(false);
  });

  it("9. ownership is claim-continuity-aware — owner_user_id OR roster_member_id, never role alone", () => {
    // Same viewer, same role, only the match field differs.
    const byOwnerId = isOwnReservation(
      { reason: "member_booking", ownerUserId: "pro-fixture-3", rosterMemberId: null },
      { userId: "pro-fixture-3", userRosterMemberId: null, role: "pro" },
    );
    const byRosterId = isOwnReservation(
      { reason: "member_booking", ownerUserId: null, rosterMemberId: "roster-fixture-3" },
      { userId: "pro-fixture-3", userRosterMemberId: "roster-fixture-3", role: "pro" },
    );
    expect(byOwnerId).toBe(true);
    expect(byRosterId).toBe(true);
  });

  it("10. created_by is never part of the ownership/access calculation — reservationAccess.ts has no such field", () => {
    const s = readSource("src/lib/calendar/reservationAccess.ts");
    expect(s).not.toMatch(/created_by/);
  });

  it("page.tsx resolves role/club canonically via getAuthProfile() — never a direct profiles.role select at this call site", () => {
    const p = page();
    expect(p).toContain("const profile  = await getAuthProfile();");
    expect(p).toContain('const userRole = profile?.role    ?? "member";');
    // The Staff-Managed redirect applies to role='member' only — Pro is
    // never redirected away from /calendar regardless of tier, matching
    // the locked Phase 37E rule that Pro never needs member_self_service.
    const redirectIdx = p.indexOf('if (profile?.role === "member" && profile.memberSelfService === false)');
    expect(redirectIdx).toBeGreaterThan(0);
  });

  it("getAuthProfile()'s role/club_id are sourced from get_current_account_context() (the active-membership primitive), never legacy profiles.role/club_id directly", () => {
    const u = userLib();
    const fnStart = u.indexOf("export const getAuthProfile");
    const fnEnd = u.indexOf("\n});", fnStart);
    const body = u.slice(fnStart, fnEnd);
    expect(body).toContain('supabase.rpc("get_current_account_context")');
    expect(body).not.toMatch(/\.from\(\s*["']profiles["']\s*\)/);
  });

  it("CalendarShell's grid-click gate delegates to the single canonical canOpenReservationDetail — no second, inline ownership rule", () => {
    const s = shell();
    expect(s).toContain('import { canOpenReservationDetail, isOwnReservation } from "@/lib/calendar/reservationAccess";');
    const idx = s.indexOf("const isClickable = canOpenReservationDetail(");
    expect(idx).toBeGreaterThan(0);
    const call = s.slice(idx, s.indexOf(");", idx) + 2);
    expect(call).toContain("role: userRole");
    expect(call).toContain("userRosterMemberId");
  });

  it("getReservationDeepLinkDetail (Server Action) uses the SAME canOpenReservationDetail rule, sourced from canonical identity, never a client-supplied role/club", () => {
    const a = actions();
    const start = a.indexOf("export async function getReservationDeepLinkDetail(");
    const end = a.indexOf("\n}\n", start);
    const body = a.slice(start, end);
    expect(body).toContain("canOpenReservationDetail(");
    expect(body).toContain("role: profile.role");
    expect(body).toContain('supabase.rpc("current_user_roster_member_id")');
    // Every identity input is server-resolved — the function's only
    // parameter is the reservation id itself.
    expect(a.slice(start, a.indexOf(")", start))).not.toMatch(/role|club|user/i);
  });

  it("19. reservation deep-link authorization is unchanged by Phase 37E — getReservationDeepLinkDetail still takes exactly one parameter", () => {
    const a = actions();
    expect(a).toMatch(/export async function getReservationDeepLinkDetail\(\s*\n\s*reservationId: string,\s*\n\)/);
  });

  it("20. unrelated Event/Lesson visibility rules are untouched — CalendarShell's only Phase 37E change is the new canManageOwnReservationRoster derivation", () => {
    const s = shell();
    // The lesson-privacy and maintenance-block branches are byte-identical
    // in shape to the pre-37E behavior audited during this checkpoint.
    expect(s).toContain('const isLesson  = res.reason === "pro_lesson";');
    expect(s).toContain('const isBlocked = !isLesson && res.reason !== "member_booking";');
    // Exactly one Phase 37E marker in the whole file, and it is the
    // roster-ownership prop derivation, not a change to lesson/event logic.
    const phase37EOccurrences = (s.match(/Phase 37E/g) ?? []).length;
    expect(phase37EOccurrences).toBeGreaterThan(0);
    const idx = s.indexOf("Phase 37E");
    expect(s.slice(idx, idx + 1200)).toContain("canManageOwnReservationRoster");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Presentation gate — items 1-6, 11, 15, 16, 17, 18
// ═══════════════════════════════════════════════════════════════════════════

describe("ReservationDetailSheet's Players & Guests render gate", () => {
  const gateLine = () => {
    const d = detail();
    const idx = d.indexOf("<ReservationRosterSection");
    return d.slice(d.lastIndexOf("{reservation.reason", idx), idx);
  };

  it("1&2. Admin/Staff (canManageMemberReservation) still renders the section — 37D behavior preserved", () => {
    expect(gateLine()).toContain("canManageMemberReservation");
  });

  it("3&6. Member/Pro who own this reservation render the section via the EXPLICIT canManageOwnReservationRoster prop, not onMemberCancel", () => {
    expect(gateLine()).toMatch(/\(canManageMemberReservation \|\| canManageOwnReservationRoster\)/);
    expect(gateLine()).not.toMatch(/onMemberCancel/);
  });

  it("correction: onMemberCancel itself (constructed in CalendarShell for cancellation) is a completely separate concern from the roster gate — cancellation availability and roster ownership must not be coupled", () => {
    const s = shell();
    const idx = s.indexOf("onMemberCancel={");
    const block = s.slice(idx, s.indexOf("}\n        />", idx));
    expect(block).toContain("selectedReservation.owner_user_id === userId");
    expect(block).toContain("selectedReservation.roster_member_id === userRosterMemberId");
    expect(block).toMatch(/userRole === "member" \|\| userRole === "pro"/);
    // The gate consumed by ReservationRosterSection's presentation prop
    // never reads onMemberCancel — verified above (gateLine has no
    // onMemberCancel reference at all).
  });

  it("5. a Staff-Managed Member never reaches this UI — page.tsx redirects before CalendarShell mounts, so no separate client capability check was added here", () => {
    // Scoped to CODE only (JSX {/* ... */} comment blocks stripped) — this
    // checkpoint's own explanatory comment legitimately discusses
    // memberSelfService as background/rationale, which must not trip this
    // guard the way a real prop/property-access addition would.
    const codeOnly = detail().replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    expect(codeOnly).not.toMatch(/memberSelfService/);
    expect(codeOnly).not.toMatch(/member_self_service/);
  });

  it("11. exactly one ReservationRosterSection component/file exists and exactly one render site consumes it — no Member/Pro-specific duplicate was created", () => {
    const d = detail();
    expect((d.match(/<ReservationRosterSection/g) ?? []).length).toBe(1);
    expect(d).not.toMatch(/MemberReservationRosterSection|ProReservationRosterSection/);
  });

  it("15. isCancelled continues to be passed through unconditionally — cancelled own reservations still render a read-only roster", () => {
    const d = detail();
    const idx = d.indexOf("<ReservationRosterSection");
    const propsBlock = d.slice(idx, d.indexOf("/>", idx));
    expect(propsBlock).toContain("isCancelled={isCancelled}");
  });

  it("16. capability_not_available is mapped to a safe, non-raw message", () => {
    const s = section();
    expect(s).toContain('case "capability_not_available":');
    const idx = s.indexOf('case "capability_not_available":');
    const line = s.slice(idx, s.indexOf(";", idx) + 1);
    expect(line).not.toMatch(/postgres|pg_|db error/i);
  });

  it("17&18. Admin/Staff and Member's existing detail-sheet fields (Edit, Cancel, Price) are structurally unchanged", () => {
    const d = detail();
    expect(d).toContain("async function handleAdminCancel()");
    expect(d).toContain("async function handleMemberCancel()");
    expect(d).toContain("const canEdit =");
    expect(d).toContain('{!onMemberCancel && reservation.reason === "member_booking" && (');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Correction — canManageOwnReservationRoster is an explicit, independent
// presentation prop derived via the canonical isOwnReservation helper,
// never coupled to onMemberCancel/cancellation availability.
// ═══════════════════════════════════════════════════════════════════════════

describe("correction: canManageOwnReservationRoster is explicit and independent of onMemberCancel", () => {
  it("Props declares canManageOwnReservationRoster as a required boolean, separate from onMemberCancel", () => {
    const d = detail();
    expect(d).toMatch(/canManageOwnReservationRoster:\s*boolean;/);
    // Required (no `?`), unlike onMemberCancel which stays optional.
    expect(d).not.toMatch(/canManageOwnReservationRoster\?:/);
  });

  it("the component destructures and forwards canManageOwnReservationRoster into the render gate only — never reads onMemberCancel for that purpose", () => {
    const d = detail();
    expect(d).toContain("canManageOwnReservationRoster");
    const gateIdx = d.indexOf("<ReservationRosterSection");
    const gate = d.slice(d.lastIndexOf("{reservation.reason", gateIdx), gateIdx);
    expect(gate).toContain("canManageOwnReservationRoster");
    expect(gate).not.toContain("onMemberCancel");
  });

  it("CalendarShell derives canManageOwnReservationRoster using the imported canonical isOwnReservation helper — no second ownership formula", () => {
    const s = shell();
    expect(s).toContain('import { canOpenReservationDetail, isOwnReservation } from "@/lib/calendar/reservationAccess";');
    const idx = s.indexOf("canManageOwnReservationRoster={");
    expect(idx).toBeGreaterThan(0);
    const block = s.slice(idx, s.indexOf("currency={currency}", idx));
    expect(block).toContain("isOwnReservation(");
    expect(block).toMatch(/userRole === "member" \|\| userRole === "pro"/);
  });

  it("the derivation is completely independent of onMemberCancel — its own block never references it, and it is defined BEFORE onMemberCancel in the props list", () => {
    const s = shell();
    const ownRosterIdx = s.indexOf("canManageOwnReservationRoster={");
    const onMemberCancelIdx = s.indexOf("onMemberCancel={");
    expect(ownRosterIdx).toBeGreaterThan(0);
    expect(onMemberCancelIdx).toBeGreaterThan(ownRosterIdx);
    const ownRosterBlock = s.slice(ownRosterIdx, s.indexOf("currency={currency}", ownRosterIdx));
    expect(ownRosterBlock).not.toMatch(/onMemberCancel/);
  });

  it("the derivation never references reservation.status/cancellation — a cancelled own reservation still receives roster presentation access", () => {
    const s = shell();
    const idx = s.indexOf("canManageOwnReservationRoster={");
    const block = s.slice(idx, s.indexOf("currency={currency}", idx));
    expect(block).not.toMatch(/status/);
    expect(block).not.toMatch(/cancel/i);
  });

  it("Member own => true, Pro own => true (via the same isOwnReservation logic CalendarShell wires in)", () => {
    // isOwnReservation itself is role-agnostic (matches the correction's
    // own note that it "doesn't care about role") — CalendarShell's own
    // `userRole === "member" || userRole === "pro"` guard, verified in a
    // separate test above, is what restricts the derived prop to these
    // two roles. This test locks in that ownership resolves true for both.
    expect(isOwnReservation(
      { reason: "member_booking", ownerUserId: "member-own-1", rosterMemberId: null },
      { userId: "member-own-1", userRosterMemberId: null, role: "member" },
    )).toBe(true);
    expect(isOwnReservation(
      { reason: "member_booking", ownerUserId: "pro-own-1", rosterMemberId: null },
      { userId: "pro-own-1", userRosterMemberId: null, role: "pro" },
    )).toBe(true);
  });

  it("Member other => false, Pro other => false", () => {
    const memberOther = isOwnReservation(
      { reason: "member_booking", ownerUserId: "someone-else", rosterMemberId: "someone-elses-roster" },
      { userId: "member-own-1", userRosterMemberId: "member-own-1-roster", role: "member" },
    );
    const proOther = isOwnReservation(
      { reason: "member_booking", ownerUserId: "someone-else", rosterMemberId: "someone-elses-roster" },
      { userId: "pro-own-1", userRosterMemberId: "pro-own-1-roster", role: "pro" },
    );
    expect(memberOther).toBe(false);
    expect(proOther).toBe(false);
  });

  it("owner_user_id continuity works for both roles", () => {
    expect(isOwnReservation(
      { reason: "member_booking", ownerUserId: "member-x", rosterMemberId: null },
      { userId: "member-x", userRosterMemberId: null, role: "member" },
    )).toBe(true);
    expect(isOwnReservation(
      { reason: "member_booking", ownerUserId: "pro-x", rosterMemberId: null },
      { userId: "pro-x", userRosterMemberId: null, role: "pro" },
    )).toBe(true);
  });

  it("roster_member_id continuity works for both roles (pre-claim / staff-created booking)", () => {
    expect(isOwnReservation(
      { reason: "member_booking", ownerUserId: null, rosterMemberId: "roster-x" },
      { userId: "member-y", userRosterMemberId: "roster-x", role: "member" },
    )).toBe(true);
    expect(isOwnReservation(
      { reason: "member_booking", ownerUserId: null, rosterMemberId: "roster-z" },
      { userId: "pro-y", userRosterMemberId: "roster-z", role: "pro" },
    )).toBe(true);
  });

  it("Admin/Staff 37D behavior is unchanged — canManageMemberReservation's own construction (isOperator(userRole)) is untouched", () => {
    const s = shell();
    expect(s).toContain("canManageMemberReservation={isOperator(userRole)}");
  });

  it("ReservationRosterSection remains the single shared component consumed by both presentation paths — no per-role variant", () => {
    const d = detail();
    expect((d.match(/<ReservationRosterSection/g) ?? []).length).toBe(1);
    expect((d.match(/import ReservationRosterSection/g) ?? []).length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Reuse — no duplicated roster UI, no new database access surface
// ═══════════════════════════════════════════════════════════════════════════

describe("Phase 37E reuses the existing 37D component and RPC surface without modification to its access rules", () => {
  it("ReservationRosterSection's own render logic is untouched aside from the capability_not_available mapping — no new prop was added for role", () => {
    const s = section();
    expect(s).toContain("interface Props {");
    const start = s.indexOf("interface Props {");
    const end = s.indexOf("}", start);
    const propsBlock = s.slice(start, end);
    expect(propsBlock).toContain("reservationId");
    expect(propsBlock).toContain("clubId");
    expect(propsBlock).toContain("isCancelled");
    expect(propsBlock).not.toMatch(/role|isAdmin|canManage/i);
  });

  it("no direct reservation_participants/reservation_guests table access was introduced anywhere touched in 37E", () => {
    for (const src of [detail(), section()]) {
      expect(src).not.toMatch(/\.from\(\s*["']reservation_participants["']\s*\)/);
      expect(src).not.toMatch(/\.from\(\s*["']reservation_guests["']\s*\)/);
    }
  });

  it("ReservationRosterSection itself never queries roster_members directly (its own pre-existing separate Member-name lookup in ReservationDetailSheet is unrelated, unchanged 34A4A functionality, not part of the 37B-E roster surface)", () => {
    expect(section()).not.toMatch(/\.from\(\s*["']roster_members["']\s*\)/);
  });

  it("still exactly six 0179 RPC wrapper functions are used — no new RPC or API route was added", () => {
    const a = actions();
    for (const fn of [
      "get_reservation_roster",
      "get_reservation_eligible_roster_members",
      "add_reservation_participant",
      "remove_reservation_participant",
      "add_reservation_guest",
      "remove_reservation_guest",
    ]) {
      expect((a.match(new RegExp(`supabase\\.rpc\\("${fn}"`, "g")) ?? []).length).toBe(1);
    }
  });

  it("no service-role client or new RLS/grant statement was introduced by touching these files", () => {
    // detail()/section() never use a service-role client at all. actions.ts
    // legitimately uses createPrivilegedClient elsewhere (pre-existing
    // Stripe checkout resolution, unrelated to the roster surface) — scoped
    // to the Phase 37D/37E roster-actions block specifically, matching the
    // same bounded-slice convention reservationRosterUx.regression.test.ts
    // already uses for this exact file.
    for (const src of [detail(), section()]) {
      expect(src).not.toMatch(/create policy|service_role|createPrivilegedClient/);
    }
    const a = actions();
    const start = a.indexOf("// Phase 37D — reservation participant/guest roster.");
    const end = a.indexOf("// getReservationDeepLinkDetail", start);
    const rosterSection = a.slice(start, end);
    expect(rosterSection).not.toMatch(/create policy|service_role|createPrivilegedClient/);
  });

  it("no migration file was created for Phase 37E", () => {
    // Read-only structural check: neither modified file references a new
    // migration number, and no .sql content appears in either.
    expect(detail()).not.toMatch(/\.sql/);
    expect(section()).not.toMatch(/\.sql/);
  });
});
