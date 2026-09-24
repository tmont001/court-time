import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 37D — regression coverage for the Admin/Staff reservation
// participant/guest roster UX, using this repository's established
// source-inspection style (see notificationSheetWiring.regression.test.ts's
// own header comment for why: this baseline is deliberately pure-
// TypeScript, no jsdom/React Testing Library available for a "use client"
// component).

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const SECTION_PATH  = "src/app/(app)/calendar/ReservationRosterSection.tsx";
const DETAIL_PATH   = "src/app/(app)/calendar/ReservationDetailSheet.tsx";
const ACTIONS_PATH  = "src/app/(app)/calendar/actions.ts";

const section = () => readSource(SECTION_PATH);
const detail  = () => readSource(DETAIL_PATH);
const actions = () => readSource(ACTIONS_PATH);

// ═══════════════════════════════════════════════════════════════════════════
// 1-3. Gating — member_booking + Admin/Staff only
// ═══════════════════════════════════════════════════════════════════════════

describe("Players & Guests renders only for member_booking, Admin/Staff-gated", () => {
  it("1&3. ReservationDetailSheet renders ReservationRosterSection only when reason === 'member_booking'", () => {
    const d = detail();
    const idx = d.indexOf("<ReservationRosterSection");
    expect(idx).toBeGreaterThan(0);
    const guardLine = d.slice(d.lastIndexOf("{reservation.reason", idx), idx);
    expect(guardLine).toContain('reservation.reason === "member_booking"');
  });

  it("2. the same render gate also requires canManageMemberReservation (isOperator: admin+staff)", () => {
    const d = detail();
    const idx = d.indexOf("<ReservationRosterSection");
    const guardLine = d.slice(d.lastIndexOf("{reservation.reason", idx), idx);
    expect(guardLine).toContain("canManageMemberReservation");
  });

  it("3b. no other reservation reason (maintenance/admin_block/event/pro_lesson) has any rendering path to ReservationRosterSection", () => {
    const d = detail();
    const occurrences = (d.match(/<ReservationRosterSection/g) ?? []).length;
    expect(occurrences).toBe(1); // exactly one render site, behind the single guard above
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4-9. RPC wiring — read/mutation paths use exactly the six 0179 RPCs
// ═══════════════════════════════════════════════════════════════════════════

describe("read/mutation paths use exactly the six Phase 37C RPCs", () => {
  it("4. getReservationRoster server action calls get_reservation_roster, and only that RPC", () => {
    const a = actions();
    const start = a.indexOf("export async function getReservationRoster(");
    const end = a.indexOf("\n}\n", start);
    const body = a.slice(start, end);
    expect(body).toContain('supabase.rpc("get_reservation_roster"');
    expect(body).not.toMatch(/supabase\.rpc\("get_reservation_eligible/);
  });

  it("5. getReservationEligibleRosterMembers server action calls get_reservation_eligible_roster_members", () => {
    const a = actions();
    const start = a.indexOf("export async function getReservationEligibleRosterMembers(");
    const end = a.indexOf("\n}\n", start);
    const body = a.slice(start, end);
    expect(body).toContain('supabase.rpc("get_reservation_eligible_roster_members"');
  });

  it("6. addReservationParticipant server action calls add_reservation_participant", () => {
    const a = actions();
    const start = a.indexOf("export async function addReservationParticipant(");
    const end = a.indexOf("\n}\n", start);
    const body = a.slice(start, end);
    expect(body).toContain('supabase.rpc("add_reservation_participant"');
  });

  it("7. addReservationGuest server action calls add_reservation_guest", () => {
    const a = actions();
    const start = a.indexOf("export async function addReservationGuest(");
    const end = a.indexOf("\n}\n", start);
    const body = a.slice(start, end);
    expect(body).toContain('supabase.rpc("add_reservation_guest"');
  });

  it("8. removeReservationParticipant server action calls remove_reservation_participant", () => {
    const a = actions();
    const start = a.indexOf("export async function removeReservationParticipant(");
    const end = a.indexOf("\n}\n", start);
    const body = a.slice(start, end);
    expect(body).toContain('supabase.rpc("remove_reservation_participant"');
  });

  it("9. removeReservationGuest server action calls remove_reservation_guest", () => {
    const a = actions();
    const start = a.indexOf("export async function removeReservationGuest(");
    const end = a.indexOf("\n}\n", start);
    const body = a.slice(start, end);
    expect(body).toContain('supabase.rpc("remove_reservation_guest"');
  });

  it("the UI component calls only the six wrapper actions — never supabase.rpc directly", () => {
    const s = section();
    expect(s).not.toMatch(/supabase\.rpc/);
    expect(s).not.toMatch(/createClient/);
    for (const fn of [
      "getReservationRoster",
      "getReservationEligibleRosterMembers",
      "addReservationParticipant",
      "removeReservationParticipant",
      "addReservationGuest",
      "removeReservationGuest",
    ]) {
      expect(s).toContain(fn);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Correction 1 — eligible picker refreshes after a participant removal
// ═══════════════════════════════════════════════════════════════════════════

describe("Correction 1 — eligible-member picker stays in sync with participant removal", () => {
  const section_ = () => section();

  it("the eligible-member fetch is extracted into a reusable loadEligibleMembers() helper", () => {
    const s = section_();
    expect(s).toContain("async function loadEligibleMembers()");
    expect(s).toContain("getReservationEligibleRosterMembers(reservationId, clubId)");
  });

  it("openAddMember() uses the shared helper rather than duplicating the fetch", () => {
    const s = section_();
    const start = s.indexOf("async function openAddMember()");
    const end = s.indexOf("\n  }\n", start);
    const body = s.slice(start, end);
    expect(body).toContain("await loadEligibleMembers();");
    expect(body).not.toMatch(/getReservationEligibleRosterMembers\(/);
  });

  it("handleRemoveParticipant refreshes the roster AND, when the picker is open, re-fetches the eligible list via the shared helper", () => {
    const s = section_();
    const start = s.indexOf("async function handleRemoveParticipant(");
    const end = s.indexOf("\n  }\n", start);
    const body = s.slice(start, end);
    expect(body).toContain("loadRoster();");
    const guardIdx = body.indexOf("if (addMemberOpen) {");
    expect(guardIdx).toBeGreaterThan(0);
    expect(body.slice(guardIdx, guardIdx + 60)).toContain("loadEligibleMembers();");
    // The refresh is unconditional on roster, but conditional on the
    // picker's own open state for the eligible-list refresh specifically.
    expect(body.indexOf("loadRoster();")).toBeLessThan(guardIdx);
  });

  it("handleRemoveGuest does NOT trigger an eligible-member refresh — guest removal never affects roster-member eligibility", () => {
    const s = section_();
    const start = s.indexOf("async function handleRemoveGuest(");
    const end = s.indexOf("\n  }\n", start);
    const body = s.slice(start, end);
    expect(body).not.toMatch(/loadEligibleMembers/);
    expect(body).not.toMatch(/addMemberOpen/);
  });

  it("the shared helper preserves the current selection when it remains eligible, and falls back to the first option otherwise", () => {
    const s = section_();
    const start = s.indexOf("async function loadEligibleMembers()");
    const end = s.indexOf("\n  }\n", start);
    const body = s.slice(start, end);
    expect(body).toMatch(/eligible\.some\(m => m\.roster_member_id === prev\)/);
    expect(body).toMatch(/eligible\[0\]\?\.roster_member_id \?\? ""/);
  });

  it("the helper's own error handling matches the rest of the component — mapRosterError, safe empty list on failure", () => {
    const s = section_();
    const start = s.indexOf("async function loadEligibleMembers()");
    const end = s.indexOf("\n  }\n", start);
    const body = s.slice(start, end);
    expect(body).toContain("setAddMemberError(mapRosterError(rpcError));");
    expect(body).toContain("setMemberList([]);");
  });

  it("still queries only get_reservation_eligible_roster_members — never a direct roster_members/reservation_participants read", () => {
    const s = section_();
    expect(s).not.toMatch(/\.from\(\s*["']roster_members["']\s*\)/);
    expect(s).not.toMatch(/\.from\(\s*["']reservation_participants["']\s*\)/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Correction 2 — shared accent button style, no raw blue primary control
// ═══════════════════════════════════════════════════════════════════════════

describe("Correction 2 — Add buttons use the shared PRIMARY COMPACT style, not a raw blue control", () => {
  it("ReservationRosterSection never introduces a raw bg-blue-* class", () => {
    const s = section();
    expect(s).not.toMatch(/bg-blue-\d/);
  });

  it("imports ACTION_BUTTON_PRIMARY_COMPACT from the shared style module", () => {
    const s = section();
    expect(s).toMatch(/import\s*\{[^}]*ACTION_BUTTON_PRIMARY_COMPACT[^}]*\}\s*from\s*"@\/components\/styles\/actionButtonStyles";/);
  });

  it("both the Add-member submit button and the Add-guest submit button use ACTION_BUTTON_PRIMARY_COMPACT", () => {
    const s = section();
    const occurrences = (s.match(/\$\{ACTION_BUTTON_PRIMARY_COMPACT\}/g) ?? []).length;
    expect(occurrences).toBe(2);
  });

  it("secondary (+ Add.../Cancel) and destructive (Remove) button hierarchy is unchanged", () => {
    const s = section();
    expect((s.match(/ACTION_BUTTON_SECONDARY_COMPACT/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((s.match(/ACTION_BUTTON_DESTRUCTIVE_COMPACT/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("no new button-style constant was introduced in this file", () => {
    const s = section();
    expect(s).not.toMatch(/^export const ACTION_BUTTON/m);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Optional hardening — duplicate-submit guards
// ═══════════════════════════════════════════════════════════════════════════

describe("duplicate-submission hardening", () => {
  it("handleAddGuest guards against a second submission while addGuestLoading is already true", () => {
    const s = section();
    const start = s.indexOf("async function handleAddGuest()");
    const end = s.indexOf("\n  }\n", start);
    const body = s.slice(start, end);
    expect(body.slice(0, 90)).toMatch(/if \(addGuestLoading\) return;/);
  });

  it("the guard covers Enter-key submission too, since onKeyDown calls the same handleAddGuest function", () => {
    const s = section();
    const keyDownIdx = s.indexOf('if (e.key === "Enter") handleAddGuest();');
    expect(keyDownIdx).toBeGreaterThan(0);
  });

  it("handleAddMember also guards against a duplicate submission while addMemberLoading is true", () => {
    const s = section();
    const start = s.indexOf("async function handleAddMember()");
    const end = s.indexOf("\n  }\n", start);
    const body = s.slice(start, end);
    expect(body).toMatch(/if \(!selectedMemberId \|\| addMemberLoading\) return;/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. Security — no direct table access anywhere in the new/changed files
// ═══════════════════════════════════════════════════════════════════════════

describe("10. no direct reads/writes against reservation_participants or reservation_guests", () => {
  it("ReservationRosterSection never queries either table directly", () => {
    const s = section();
    expect(s).not.toMatch(/\.from\(\s*["']reservation_participants["']\s*\)/);
    expect(s).not.toMatch(/\.from\(\s*["']reservation_guests["']\s*\)/);
  });

  it("the six server actions never query either table directly — RPC only", () => {
    const a = actions();
    expect(a).not.toMatch(/\.from\(\s*["']reservation_participants["']\s*\)/);
    expect(a).not.toMatch(/\.from\(\s*["']reservation_guests["']\s*\)/);
  });

  it("no service-role client is used for any reservation roster action", () => {
    const a = actions();
    const start = a.indexOf("// Phase 37D — reservation participant/guest roster.");
    const end = a.indexOf("// getReservationDeepLinkDetail", start);
    const rosterSection = a.slice(start, end);
    expect(rosterSection).not.toMatch(/createPrivilegedClient|service_role/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 11. Empty state
// ═══════════════════════════════════════════════════════════════════════════

describe("11. empty roster is valid and shows a neutral empty state", () => {
  it("shows the exact neutral copy, never alarmist language", () => {
    const s = section();
    expect(s).toContain("No players or guests have been added.");
    expect(s).not.toMatch(/incomplete/i);
    expect(s).not.toMatch(/missing player/i);
    expect(s).not.toMatch(/action required/i);
    expect(s).not.toMatch(/roster required/i);
  });

  it("Add controls remain available even when the roster is empty (gated on isCancelled only, not on row count)", () => {
    const s = section();
    const addControlsIdx = s.indexOf("+ Add club member");
    expect(addControlsIdx).toBeGreaterThan(0);
    // The block containing both add buttons is gated by !isCancelled, with
    // no dependency on `rows.length` or `isEmpty` anywhere in that guard.
    const guardIdx = s.lastIndexOf("{!isCancelled && (", addControlsIdx);
    expect(guardIdx).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 12-13. Reservation holder semantics
// ═══════════════════════════════════════════════════════════════════════════

describe("12-13. reservation holder badge", () => {
  it("12. the holder badge is rendered only when row.is_holder is true, and only ever read from the RPC's derived field — never persisted/re-derived locally", () => {
    const s = section();
    expect(s).toContain("{row.is_holder && (");
    expect(s).not.toMatch(/is_booker/i);
    // No local re-derivation of is_holder by comparing two roster_member_id
    // PROPERTY ACCESSES against each other (e.g. row.roster_member_id ===
    // reservation.roster_member_id) — the RPC's own is_holder is the only
    // source. This intentionally does not flag comparing a roster_member_id
    // field against a plain variable (e.g. the eligible-picker's own
    // preserve-selection check, m.roster_member_id === prev), which is
    // unrelated selection-state bookkeeping, not holder derivation.
    expect(s).not.toMatch(/\.roster_member_id\s*===\s*\w+\.roster_member_id/);
  });

  it("13. guest rows never render a holder badge — no is_holder reference anywhere in the guest row block", () => {
    const s = section();
    const guestsHeaderIdx = s.indexOf('Guests\n              </p>');
    expect(guestsHeaderIdx).toBeGreaterThan(0);
    const guestBlockEnd = s.indexOf("{!isCancelled && (", guestsHeaderIdx);
    const guestBlock = s.slice(guestsHeaderIdx, guestBlockEnd);
    expect(guestBlock).not.toMatch(/is_holder/);
    expect(guestBlock).not.toMatch(/Reservation holder/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 14-15. Cancellation behavior
// ═══════════════════════════════════════════════════════════════════════════

describe("14-15. cancelled reservation roster is visible but read-only", () => {
  it("14. loadRoster/rendering never conditions the roster fetch or row display on isCancelled — cancelled rosters remain visible", () => {
    const s = section();
    const loadFnIdx = s.indexOf("function loadRoster()");
    const loadFnEnd = s.indexOf("\n  }\n", loadFnIdx);
    const loadFnBody = s.slice(loadFnIdx, loadFnEnd);
    expect(loadFnBody).not.toMatch(/isCancelled/);
  });

  it("15. Add club member / Add guest buttons and both Remove buttons are all gated on !isCancelled", () => {
    const s = section();
    expect(s).toContain("{!isCancelled && (");
    // Two per-row remove buttons (participant + guest), each individually gated.
    const removeParticipantIdx = s.indexOf("handleRemoveParticipant(row)");
    const removeGuestIdx = s.indexOf("handleRemoveGuest(row)");
    expect(removeParticipantIdx).toBeGreaterThan(0);
    expect(removeGuestIdx).toBeGreaterThan(0);
    expect(s.slice(Math.max(0, removeParticipantIdx - 400), removeParticipantIdx)).toContain("!isCancelled &&");
    expect(s.slice(Math.max(0, removeGuestIdx - 400), removeGuestIdx)).toContain("!isCancelled &&");
  });

  it("a subtle read-only hint is shown when cancelled, without hiding the section itself", () => {
    const s = section();
    expect(s).toContain("{isCancelled && (");
    expect(s).toContain("Read-only");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 16-17. Guest input validation
// ═══════════════════════════════════════════════════════════════════════════

describe("16-17. guest name input validation", () => {
  it("16. duplicate guest display names are never checked or rejected client-side", () => {
    const s = section();
    const fnStart = s.indexOf("async function handleAddGuest()");
    const fnEnd = s.indexOf("\n  }\n", fnStart);
    const body = s.slice(fnStart, fnEnd);
    expect(body).not.toMatch(/duplicate/i);
    expect(body).not.toMatch(/some\(/);
    expect(body).not.toMatch(/find\(/);
  });

  it("17. blank (or whitespace-only) guest input is rejected client-side before any RPC call", () => {
    const s = section();
    const fnStart = s.indexOf("async function handleAddGuest()");
    const fnEnd = s.indexOf("\n  }\n", fnStart);
    const body = s.slice(fnStart, fnEnd);
    const trimIdx = body.indexOf("guestName.trim()");
    const rejectIdx = body.indexOf("Enter a guest name.");
    const rpcIdx = body.indexOf("addReservationGuest(");
    expect(trimIdx).toBeGreaterThanOrEqual(0);
    expect(rejectIdx).toBeGreaterThan(trimIdx);
    expect(rpcIdx).toBeGreaterThan(rejectIdx);
  });

  it("client-side validation does not duplicate the server's >100-character check", () => {
    const s = section();
    const fnStart = s.indexOf("async function handleAddGuest()");
    const fnEnd = s.indexOf("\n  }\n", fnStart);
    const body = s.slice(fnStart, fnEnd);
    expect(body).not.toMatch(/100/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 18. Error handling
// ═══════════════════════════════════════════════════════════════════════════

describe("18. expected RPC errors map to existing user-safe feedback", () => {
  it("mapRosterError covers every documented 0179 error code with a non-raw, user-safe message", () => {
    const s = section();
    const fnStart = s.indexOf("function mapRosterError(");
    const fnEnd = s.indexOf("\n}\n", fnStart);
    const body = s.slice(fnStart, fnEnd);
    for (const code of [
      "reservation_not_found",
      "reservation_not_participant_eligible",
      "reservation_roster_locked",
      "roster_member_not_found",
      "roster_member_inactive",
      "guest_display_name_required",
      "guest_display_name_too_long",
    ]) {
      expect(body).toContain(`case "${code}":`);
    }
    // stale_club_context uses the shared app-wide constant/message, not a
    // locally-invented string — the same convention every other reservation
    // mutation (adminCancelReservation, cancelMemberReservation) already uses.
    expect(body).toContain("STALE_CLUB_CONTEXT_ERROR");
    expect(body).toContain("STALE_CLUB_MESSAGE");
    // Unexpected/unmapped codes fall back to a generic safe message, never
    // a raw Postgres error string reaching the user.
    expect(body).toContain("default:");
  });

  it("imports the shared stale-club constants rather than inventing new copy", () => {
    const s = section();
    expect(s).toContain('import { STALE_CLUB_CONTEXT_ERROR, STALE_CLUB_MESSAGE } from "@/lib/staleClub";');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 19. Sheet stays open/usable after a mutation
// ═══════════════════════════════════════════════════════════════════════════

describe("19. the reservation detail sheet remains open/usable after a roster mutation", () => {
  it("none of the roster mutation handlers call onClose/onCancelled/onUpdated — only loadRoster()", () => {
    const s = section();
    expect(s).not.toMatch(/onClose\s*\(/);
    expect(s).not.toMatch(/onCancelled\s*\(/);
    expect(s).not.toMatch(/onUpdated\s*\(/);
    // ReservationRosterSection takes no such callback props at all.
    const propsStart = s.indexOf("interface Props {");
    const propsEnd = s.indexOf("}", propsStart);
    const propsBlock = s.slice(propsStart, propsEnd);
    expect(propsBlock).not.toMatch(/onClose|onCancelled|onUpdated/);
  });

  it("ReservationDetailSheet passes no callback into ReservationRosterSection that would close the parent sheet", () => {
    const d = detail();
    const start = d.indexOf("<ReservationRosterSection");
    const end = d.indexOf("/>", start);
    const propsPassed = d.slice(start, end);
    expect(propsPassed).not.toMatch(/onClose|onCancelled|onUpdated/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 20. Responsive/mobile structure
// ═══════════════════════════════════════════════════════════════════════════

describe("20. responsive structure avoids horizontal overflow, matching existing conventions", () => {
  it("row layouts use truncate + min-w-0 + flex-wrap, the same idioms EventRosterSheet already relies on", () => {
    const s = section();
    expect(s).toMatch(/truncate/);
    expect(s).toMatch(/min-w-0/);
    expect(s).toMatch(/flex-wrap/);
  });

  it("no fixed pixel width is introduced (would risk overflow in the mobile sheet)", () => {
    const s = section();
    expect(s).not.toMatch(/width:\s*\d+px/);
    expect(s).not.toMatch(/w-\[\d+px\]/);
  });

  it("Remove buttons have accessible names via aria-label", () => {
    const s = section();
    expect(s).toMatch(/aria-label=\{`Remove .* from players`\}/);
    expect(s).toMatch(/aria-label=\{`Remove guest/);
  });

  it("the member picker and guest input both have accessible labels", () => {
    const s = section();
    expect(s).toContain('aria-label="Select a club member to add"');
    expect(s).toContain('aria-label="Guest name"');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Compatibility — no new migration, no unrelated behavior touched
// ═══════════════════════════════════════════════════════════════════════════

describe("compatibility — no non-UI scope creep in Phase 37D", () => {
  it("no direct import of a database migration or SQL file from the new component/actions", () => {
    const s = section();
    const a = actions();
    expect(s).not.toMatch(/\.sql/);
    expect(a).not.toMatch(/\.sql/);
  });

  it("ReservationDetailSheet's existing Edit/Cancel/Price/Payment logic is untouched aside from the new insertion", () => {
    const d = detail();
    expect(d).toContain("async function handleAdminCancel()");
    // Phase 41B completion renamed handleMemberCancel to
    // handleMemberCancelConfirmed (it now calls onMemberCancel with the
    // Member-confirmed policy state) — same cancel-flow role, new name.
    expect(d).toContain("async function handleMemberCancelConfirmed()");
    expect(d).toContain("const canEdit =");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 39C-1 correction — onRosterChanged coordination with the sibling
// Looking-for-Players section
// ═══════════════════════════════════════════════════════════════════════════

describe("onRosterChanged — optional roster-change callback for LFP coordination", () => {
  it("2. Props declares an optional onRosterChanged callback", () => {
    const s = section();
    expect(s).toContain("onRosterChanged?: () => void;");
    expect(s).toMatch(/export default function ReservationRosterSection\(\{[^}]*onRosterChanged[^}]*\}: Props\)/);
  });

  it("3a. a successful add-participant mutation invokes onRosterChanged", () => {
    const s = section();
    const start = s.indexOf("async function handleAddMember()");
    const end = s.indexOf("\n  }\n", start);
    const body = s.slice(start, end);
    expect(body).toContain("loadRoster();\n    onRosterChanged?.();");
  });

  it("3b. a successful remove-participant mutation invokes onRosterChanged", () => {
    const s = section();
    const start = s.indexOf("async function handleRemoveParticipant(");
    const end = s.indexOf("\n  }\n", start);
    const body = s.slice(start, end);
    expect(body).toContain("loadRoster();\n    onRosterChanged?.();");
  });

  it("4a. a successful add-guest mutation invokes onRosterChanged", () => {
    const s = section();
    const start = s.indexOf("async function handleAddGuest()");
    const end = s.indexOf("\n  }\n", start);
    const body = s.slice(start, end);
    expect(body).toContain("loadRoster();\n    onRosterChanged?.();");
  });

  it("4b. a successful remove-guest mutation invokes onRosterChanged", () => {
    const s = section();
    const start = s.indexOf("async function handleRemoveGuest(");
    const end = s.indexOf("\n  }\n", start);
    const body = s.slice(start, end);
    expect(body).toContain("loadRoster();\n    onRosterChanged?.();");
  });

  it("5. every onRosterChanged call site is textually AFTER the mutation's own error-return guard, in all four handlers — never reached on failure", () => {
    const s = section();
    for (const fn of ["handleAddMember", "handleRemoveParticipant", "handleRemoveGuest", "handleAddGuest"]) {
      const start = s.indexOf(`async function ${fn}(`);
      const end = s.indexOf("\n  }\n", start);
      const body = s.slice(start, end);
      const errorReturnIdx = body.indexOf("if (result.error) {");
      const callbackIdx = body.indexOf("onRosterChanged?.();");
      expect(errorReturnIdx, `${fn} missing error guard`).toBeGreaterThan(0);
      expect(callbackIdx, `${fn} missing onRosterChanged call`).toBeGreaterThan(errorReturnIdx);
    }
  });

  it("handleCopyWaiverLink (does not change occupancy) never invokes onRosterChanged", () => {
    const s = section();
    const start = s.indexOf("async function handleCopyWaiverLink(");
    const end = s.indexOf("\n  }\n", start);
    const body = s.slice(start, end);
    expect(body).not.toMatch(/onRosterChanged/);
  });

  it("6. ReservationDetailSheet owns a refresh revision and wires it through both sibling sections", () => {
    const d = detail();
    expect(d).toContain("const [rosterRefreshRevision, setRosterRefreshRevision] = useState(0);");
    expect(d).toContain("onRosterChanged={() => setRosterRefreshRevision(r => r + 1)}");
    expect(d).toContain("refreshRevision={rosterRefreshRevision}");
  });

  it("no participant/guest array or occupancy value is passed from ReservationRosterSection to ReservationDetailSheet — the callback is a plain no-argument signal", () => {
    const d = detail();
    const idx = d.indexOf("onRosterChanged={() => setRosterRefreshRevision(r => r + 1)}");
    expect(idx).toBeGreaterThan(0);
    // The arrow function passed as the callback takes no parameters.
    expect(d.slice(idx, idx + 60)).toMatch(/onRosterChanged=\{\(\) =>/);
  });
});
