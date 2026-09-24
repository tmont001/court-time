import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 39C-1 — regression coverage for the owner/operator "Looking for
// Players" controls, using this repository's established source-inspection
// style (see reservationRosterUx.regression.test.ts's own header comment
// for why: pure-TypeScript, no jsdom/React Testing Library available for a
// "use client" component).

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const SECTION_PATH = "src/app/(app)/calendar/ReservationPlayerSearchSection.tsx";
const DETAIL_PATH  = "src/app/(app)/calendar/ReservationDetailSheet.tsx";
const ACTIONS_PATH = "src/app/(app)/calendar/actions.ts";

const section = () => readSource(SECTION_PATH);
const detail  = () => readSource(DETAIL_PATH);
const actions = () => readSource(ACTIONS_PATH);

const CALENDAR_SHELL_PATH        = "src/app/(app)/calendar/CalendarShell.tsx";
const EDIT_RESERVATION_SHEET_PATH = "src/app/(app)/calendar/EditReservationSheet.tsx";
const calendarShell        = () => readSource(CALENDAR_SHELL_PATH);
const editReservationSheet = () => readSource(EDIT_RESERVATION_SHEET_PATH);

// ═══════════════════════════════════════════════════════════════════════════
// 1. RENDER GATE
// ═══════════════════════════════════════════════════════════════════════════

describe("1. ReservationPlayerSearchSection renders only for member_booking, owner-or-operator", () => {
  it("ReservationDetailSheet renders it only when reason === 'member_booking'", () => {
    const d = detail();
    const idx = d.indexOf("<ReservationPlayerSearchSection");
    expect(idx).toBeGreaterThan(0);
    const guardLine = d.slice(d.lastIndexOf("{reservation.reason", idx), idx);
    expect(guardLine).toContain('reservation.reason === "member_booking"');
  });

  it("the same gate requires canManageMemberReservation or canManageOwnReservationRoster — identical to ReservationRosterSection's own gate", () => {
    const d = detail();
    const rosterIdx = d.indexOf("<ReservationRosterSection");
    const rosterGuard = d.slice(d.lastIndexOf("{reservation.reason", rosterIdx), rosterIdx);

    const searchIdx = d.indexOf("<ReservationPlayerSearchSection");
    const searchGuard = d.slice(d.lastIndexOf("{reservation.reason", searchIdx), searchIdx);

    expect(searchGuard).toContain("canManageMemberReservation");
    expect(searchGuard).toContain("canManageOwnReservationRoster");
    expect(searchGuard).toContain('reservation.reason === "member_booking" && (canManageMemberReservation || canManageOwnReservationRoster)');
    expect(rosterGuard).toContain('reservation.reason === "member_booking" && (canManageMemberReservation || canManageOwnReservationRoster)');
  });

  it("exactly one render site for ReservationPlayerSearchSection", () => {
    const d = detail();
    expect((d.match(/<ReservationPlayerSearchSection/g) ?? []).length).toBe(1);
  });

  it("it is a sibling of ReservationRosterSection, never nested inside it — ReservationRosterSection.tsx imports/renders nothing from the new component (an explanatory comment naming it, describing the onRosterChanged coordination, is fine)", () => {
    const rosterSectionSrc = readSource("src/app/(app)/calendar/ReservationRosterSection.tsx");
    expect(rosterSectionSrc).not.toMatch(/import .*ReservationPlayerSearchSection/);
    expect(rosterSectionSrc).not.toMatch(/<ReservationPlayerSearchSection/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. EXACT THREE RPC WRAPPERS
// ═══════════════════════════════════════════════════════════════════════════

describe("2. actions.ts exposes exactly the three Phase 39B-2 RPC wrappers", () => {
  it("getReservationPlayerSearch calls get_reservation_player_search, and only that RPC", () => {
    const a = actions();
    const start = a.indexOf("export async function getReservationPlayerSearch(");
    const end = a.indexOf("\n}\n", start);
    const body = a.slice(start, end);
    expect(body).toContain('supabase.rpc("get_reservation_player_search"');
    expect(body).not.toMatch(/supabase\.rpc\("(set|clear)_reservation_player_search/);
  });

  it("setReservationPlayerSearch calls set_reservation_player_search, and only that RPC", () => {
    const a = actions();
    const start = a.indexOf("export async function setReservationPlayerSearch(");
    const end = a.indexOf("\n}\n", start);
    const body = a.slice(start, end);
    expect(body).toContain('supabase.rpc("set_reservation_player_search"');
    expect(body).not.toMatch(/supabase\.rpc\("(get|clear)_reservation_player_search/);
  });

  it("clearReservationPlayerSearch calls clear_reservation_player_search, and only that RPC", () => {
    const a = actions();
    const start = a.indexOf("export async function clearReservationPlayerSearch(");
    const end = a.indexOf("\n}\n", start);
    const body = a.slice(start, end);
    expect(body).toContain('supabase.rpc("clear_reservation_player_search"');
    expect(body).not.toMatch(/supabase\.rpc\("(get|set)_reservation_player_search/);
  });

  it("all three actions use the established assertActiveClub preflight", () => {
    const a = actions();
    for (const fn of ["getReservationPlayerSearch", "setReservationPlayerSearch", "clearReservationPlayerSearch"]) {
      const start = a.indexOf(`export async function ${fn}(`);
      const end = a.indexOf("\n}\n", start);
      const body = a.slice(start, end);
      expect(body).toContain("await assertActiveClub(expectedClubId)");
    }
  });

  it("the owner-control section (ReservationPlayerSearchSection) never calls join/leave/discovery — those are the player-facing 39C-2B surface (OpenGamesView), a separate component entirely", () => {
    // actions.ts is a shared file and, as of Phase 39C-2B, legitimately
    // contains getOpenReservationPlayerSearches/joinReservationPlayerSearch
    // alongside the owner-control actions this file's own describe block
    // covers — so this check is scoped to the SECTION component only, not
    // to the shared actions module.
    const s = section();
    for (const forbidden of [
      "join_reservation_player_search",
      "leave_reservation_participation",
      "get_open_reservation_player_searches",
    ]) {
      expect(s).not.toMatch(new RegExp(forbidden));
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. ZERO-ROW / NO-SEARCH HANDLING
// ═══════════════════════════════════════════════════════════════════════════

describe("3. zero-row read is represented as null state, never as an error", () => {
  it("getReservationPlayerSearch returns data: null (not an error) when the RPC returns zero rows", () => {
    const a = actions();
    const start = a.indexOf("export async function getReservationPlayerSearch(");
    const end = a.indexOf("\n}\n", start);
    const body = a.slice(start, end);
    expect(body).toContain("const rows = (data ?? []) as ReservationPlayerSearchState[];");
    expect(body).toContain("return { data: rows[0] ?? null };");
  });

  it("the component's loadState treats a null result as valid data, not as loadError", () => {
    const s = section();
    const loadStateIdx = s.indexOf("function loadState()");
    const end = s.indexOf("\n  }\n", loadStateIdx);
    const body = s.slice(loadStateIdx, end);
    expect(body).toContain("if (error) {");
    expect(body).toContain("setState(data ?? null);");
    expect(body).not.toMatch(/if \(!data\)/); // null is not treated as an error condition
  });

  it("the no-search case renders the same 'Off' + Turn-on UI as a closed-but-existing search — not a separate error state", () => {
    const s = section();
    expect(s).toContain("{!isOpen && (");
    expect(s).toContain('<p className="text-sm text-gray-400 dark:text-gray-500">Off</p>');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. NO CLIENT OCCUPANCY ARITHMETIC
// ═══════════════════════════════════════════════════════════════════════════

describe("4. occupied/remaining values are always read verbatim from RPC-returned state", () => {
  it("occupied_seats and remaining_spots are displayed via state.occupied_seats / state.player_capacity / state.remaining_spots — never computed", () => {
    const s = section();
    expect(s).toContain("{state.occupied_seats} of {state.player_capacity} spots filled");
    expect(s).toContain("state.remaining_spots === 0");
  });

  it("no arithmetic expression combines participant/guest counts or player_capacity anywhere in the component", () => {
    const s = section();
    // Comments explaining the design legitimately mention these table
    // names (e.g. "never touches reservation_participants/reservation_
    // guests") — what must never appear is an actual RPC/table reference
    // to either, or arithmetic on the RPC-returned seat numbers.
    expect(s).not.toMatch(/\.rpc\(["']\w*reservation_(participant|guest)/);
    expect(s).not.toMatch(/from\(["']reservation_(participants|guests)/);
    expect(s).not.toMatch(/occupied_seats\s*[-+]|player_capacity\s*[-+]/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5-6. CAPACITY SELECTOR
// ═══════════════════════════════════════════════════════════════════════════

describe("5-6. capacity selector — select/dropdown 2-8, 'Total players' semantics", () => {
  it("5. CAPACITY_OPTIONS is exactly [2,3,4,5,6,7,8] and is rendered as <select><option> elements", () => {
    const s = section();
    expect(s).toContain("const CAPACITY_OPTIONS = [2, 3, 4, 5, 6, 7, 8];");
    expect(s).toContain("<select");
    expect(s).toContain("{CAPACITY_OPTIONS.map((n) => (");
    expect(s).toContain("<option key={n} value={n}>{n}</option>");
  });

  it("no boolean toggle/switch control is used anywhere — no role=\"switch\"", () => {
    const s = section();
    expect(s).not.toMatch(/role="switch"/);
    expect(s).not.toMatch(/aria-checked/);
  });

  it("6. the label reads 'Total players' with helper text 'Includes the booking owner.'", () => {
    const s = section();
    expect(s).toContain("Total players");
    expect(s).toContain("Includes the booking owner.");
  });

  it("default capacity for a reservation with no existing search is 4", () => {
    const s = section();
    expect(s).toContain("const DEFAULT_CAPACITY = 4;");
    expect(s).toContain("setCapacityInput(data ? data.player_capacity : DEFAULT_CAPACITY);");
  });

  it("capacity is never inferred from reservation.format anywhere in the component", () => {
    const s = section();
    expect(s).not.toMatch(/\.format\b/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7-8. EFFECTIVE-OPEN vs STORED-OPEN
// ═══════════════════════════════════════════════════════════════════════════

describe("7-8. is_open and effective_is_open are treated as distinct concepts", () => {
  it("7. effectiveIsOpen is read directly from state.effective_is_open, never derived/inferred from is_open", () => {
    const s = section();
    expect(s).toContain("const effectiveIsOpen  = state?.effective_is_open ?? false;");
    expect(s).toContain("const isOpen           = state?.is_open ?? false;");
    // The two are genuinely independent booleans, not one derived from the other.
    expect(s).not.toMatch(/effectiveIsOpen\s*=\s*isOpen/);
  });

  it("8. every is_open && !effective_is_open combination renders the ineffective-notice branch", () => {
    const s = section();
    expect(s).toContain("const showsIneffectiveNotice = isOpen && !effectiveIsOpen;");
    expect(s).toContain("{showsIneffectiveNotice && state && (");
  });

  it("the effective-open (active) branch and the ineffective-notice branch are mutually exclusive and jointly exhaustive over is_open=true", () => {
    const s = section();
    expect(s).toContain("{isOpen && effectiveIsOpen && state && (");
    expect(s).toContain("{showsIneffectiveNotice && state && (");
  });

  it("the stored On state is never rendered as though it were discoverable when effective_is_open is false — the active 'spots filled' branch requires effectiveIsOpen explicitly", () => {
    const s = section();
    const activeIdx = s.indexOf("{isOpen && effectiveIsOpen && state && (");
    expect(activeIdx).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9-11. BLOCK REASON COPY
// ═══════════════════════════════════════════════════════════════════════════

describe("9-11. block-reason copy and reopen action", () => {
  it("9. stale_host renders an explicit Reopen action that calls setReservationPlayerSearch with state.player_capacity, not the capacity selector's value", () => {
    const s = section();
    expect(s).toContain('state.effective_open_block_reason === "stale_host"');
    expect(s).toContain("Reopen for current booking owner");
    const handleReopenIdx = s.indexOf("function handleReopen()");
    const end = s.indexOf("\n  }\n", handleReopenIdx);
    const body = s.slice(handleReopenIdx, end);
    expect(body).toContain("setReservationPlayerSearch(reservationId, clubId, state.player_capacity)");
    expect(body).not.toMatch(/capacityInput/);
  });

  it("reopen never requires the owner to stop/start first or change capacity — it is a single direct action, not a compound flow", () => {
    const s = section();
    const handleReopenIdx = s.indexOf("function handleReopen()");
    const end = s.indexOf("\n  }\n", handleReopenIdx);
    const body = s.slice(handleReopenIdx, end);
    expect(body).not.toMatch(/clearReservationPlayerSearch/);
  });

  it("10. host_inactive and legacy_guest_names each map to their own friendly, specific copy", () => {
    const s = section();
    const fnStart = s.indexOf("function blockReasonMessage(");
    const fnEnd = s.indexOf("\n}\n", fnStart);
    const body = s.slice(fnStart, fnEnd);
    expect(body).toContain('case "host_inactive":');
    expect(body).toMatch(/current booking owner isn't active/);
    expect(body).toContain('case "legacy_guest_names":');
    expect(body).toMatch(/older guest-name field/);
  });

  it("11. an unknown or null block reason falls through to the generic 'not discoverable' copy — never a raw code", () => {
    const s = section();
    const fnStart = s.indexOf("function blockReasonMessage(");
    const fnEnd = s.indexOf("\n}\n", fnStart);
    const body = s.slice(fnStart, fnEnd);
    expect(body).toContain("default:");
    expect(body).toMatch(/This search is currently not discoverable\./);
  });

  it("only stale_host offers a Reopen button — host_inactive/legacy_guest_names/unknown only offer Stop", () => {
    const s = section();
    const noticeIdx = s.indexOf("{showsIneffectiveNotice && state && (");
    const noticeEnd = s.indexOf(")}\n\n          {actionError}", noticeIdx);
    const noticeBlock = noticeEnd > 0 ? s.slice(noticeIdx, noticeEnd) : s.slice(noticeIdx, noticeIdx + 1200);
    expect((noticeBlock.match(/Reopen for current booking owner/g) ?? []).length).toBe(1);
    expect(noticeBlock).toContain("Stop");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 12. reservation_player_capacity_too_small MAPPING
// ═══════════════════════════════════════════════════════════════════════════

describe("12. reservation_player_capacity_too_small maps to friendly copy", () => {
  it("maps to copy explaining capacity can't go below the current roster", () => {
    const s = section();
    const fnStart = s.indexOf("function mapPlayerSearchError(");
    const fnEnd = s.indexOf("\n}\n", fnStart);
    const body = s.slice(fnStart, fnEnd);
    expect(body).toContain('case "reservation_player_capacity_too_small":');
    expect(body).toMatch(/can't be lower than the number of players already/);
  });

  it("every other required error code from the correction list is also mapped, and no raw reservation_*/roster_member_* string is used as displayed copy", () => {
    const s = section();
    const fnStart = s.indexOf("function mapPlayerSearchError(");
    const fnEnd = s.indexOf("\n}\n", fnStart);
    const body = s.slice(fnStart, fnEnd);
    for (const code of [
      "reservation_not_found",
      "reservation_not_confirmed",
      "reservation_already_started",
      "roster_member_inactive",
      "reservation_has_legacy_guest_names",
      "reservation_player_capacity_out_of_range",
      "capability_not_available",
    ]) {
      expect(body).toContain(`case "${code}":`);
    }
    expect(body).toContain("if (code === STALE_CLUB_CONTEXT_ERROR) return STALE_CLUB_MESSAGE;");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 13-14. STOP / NO PARTICIPANT-GUEST MUTATION
// ═══════════════════════════════════════════════════════════════════════════

describe("13-14. Stop behavior and roster-mutation isolation", () => {
  it("13. Stop calls clearReservationPlayerSearch (clear_reservation_player_search) — never a delete", () => {
    const s = section();
    const handleStopIdx = s.indexOf("function handleStop()");
    const end = s.indexOf("\n  }\n", handleStopIdx);
    const body = s.slice(handleStopIdx, end);
    expect(body).toContain("clearReservationPlayerSearch(reservationId, clubId)");
    // No actual delete CALL anywhere (comments mentioning "never deletes"
    // are expected and fine — this checks for a real invocation pattern).
    expect(s).not.toMatch(/\.rpc\(["']delete|deleteReservation|\.delete\(\)/i);
  });

  it("14. the new component never imports or calls any reservation_participants/reservation_guests action", () => {
    const s = section();
    for (const forbidden of [
      "addReservationParticipant",
      "removeReservationParticipant",
      "addReservationGuest",
      "removeReservationGuest",
      "getReservationRoster",
      "getReservationEligibleRosterMembers",
    ]) {
      expect(s).not.toMatch(new RegExp(forbidden));
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 15. CANCELLED RESERVATIONS
// ═══════════════════════════════════════════════════════════════════════════

describe("15. cancelled reservations expose no LFP controls", () => {
  it("the component returns null immediately when isCancelled, before any state/controls render", () => {
    const s = section();
    expect(s).toContain("if (isCancelled) return null;");
    const earlyReturnIdx = s.indexOf("if (isCancelled) return null;");
    const renderIdx = s.indexOf("return (\n    <div");
    expect(earlyReturnIdx).toBeLessThan(renderIdx);
  });

  it("the load effect also skips fetching state when isCancelled — no wasted read for a surface that never renders", () => {
    const s = section();
    expect(s).toContain("if (isCancelled) return;");
  });

  it("no client-side deletion/cleanup of a historical search row is attempted anywhere — no delete RPC/API call invocation pattern", () => {
    const s = section();
    expect(s).not.toMatch(/\.rpc\(["']delete|deleteReservation|\.delete\(\)/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 16. RE-FETCH AFTER MUTATION
// ═══════════════════════════════════════════════════════════════════════════

describe("16. successful mutations re-fetch canonical RPC state", () => {
  it("the shared runMutation helper calls loadState() after every successful action, and only on success", () => {
    const s = section();
    const start = s.indexOf("async function runMutation(");
    const end = s.indexOf("\n  }\n", start);
    const body = s.slice(start, end);
    expect(body).toContain("if (result.error) {");
    expect(body).toContain("return;");
    expect(body).toContain("loadState();");
    // loadState() must be the LAST statement, only reached when the error branch returned early.
    const errorReturnIdx = body.indexOf("return;");
    const loadStateIdx = body.lastIndexOf("loadState();");
    expect(loadStateIdx).toBeGreaterThan(errorReturnIdx);
  });

  it("all three mutation handlers (Turn on/Update, Reopen, Stop) go through the same runMutation helper — one canonical refresh path, not three", () => {
    const s = section();
    expect(s).toContain("runMutation(() => setReservationPlayerSearch(reservationId, clubId, capacityInput));");
    expect(s).toContain("runMutation(() => setReservationPlayerSearch(reservationId, clubId, state.player_capacity));");
    expect(s).toContain("runMutation(() => clearReservationPlayerSearch(reservationId, clubId));");
  });

  it("no optimistic local state mutation of occupied_seats/remaining_spots/player_capacity happens outside of loadState", () => {
    const s = section();
    expect(s).not.toMatch(/setState\(\{[^}]*occupied_seats/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Pre-apply correction — club-context refresh + roster-change coordination
// ═══════════════════════════════════════════════════════════════════════════

describe("correction 1 — the load effect also reloads on a clubId change", () => {
  it("1. the load effect's dependency array includes clubId alongside reservationId/isCancelled/refreshRevision", () => {
    const s = section();
    expect(s).toContain("}, [reservationId, clubId, isCancelled, refreshRevision]);");
  });

  it("cancelled reservations still skip the load entirely — the early return inside the effect is unchanged", () => {
    const s = section();
    const effectIdx = s.indexOf("useEffect(() => {");
    const depsIdx = s.indexOf("}, [reservationId, clubId, isCancelled, refreshRevision]);");
    const body = s.slice(effectIdx, depsIdx);
    expect(body).toContain("if (isCancelled) return;");
  });

  it("authorization is unaffected — no new capability/role check was introduced alongside the dependency fix", () => {
    const s = section();
    expect(s).not.toMatch(/current_club_has_capability|current_user_role/);
  });
});

describe("correction 2 — refreshRevision coordination with the sibling roster section", () => {
  it("6/7. ReservationPlayerSearchSection declares and destructures an optional refreshRevision prop", () => {
    const s = section();
    expect(s).toContain("refreshRevision?: number;");
    expect(s).toMatch(/export default function ReservationPlayerSearchSection\(\{[^}]*refreshRevision[^}]*\}: Props\)/);
  });

  it("8. refreshRevision is a dependency of the load effect, so changing it triggers loadState() (which itself calls getReservationPlayerSearch — the canonical RPC, never a local recomputation)", () => {
    const s = section();
    const effectIdx = s.indexOf("useEffect(() => {");
    const depsIdx = s.indexOf("}, [reservationId, clubId, isCancelled, refreshRevision]);");
    const body = s.slice(effectIdx, depsIdx);
    expect(body).toContain("loadState();");
    expect(depsIdx).toBeGreaterThan(effectIdx);
    const loadStateFnIdx = s.indexOf("function loadState()");
    const loadStateEnd = s.indexOf("\n  }\n", loadStateFnIdx);
    const loadStateBody = s.slice(loadStateFnIdx, loadStateEnd);
    expect(loadStateBody).toContain('getReservationPlayerSearch(reservationId, clubId)');
  });

  it("9. no client occupancy arithmetic was introduced by this correction — occupied_seats/remaining_spots/player_capacity still only ever come from RPC-returned state", () => {
    const s = section();
    expect(s).not.toMatch(/occupied_seats\s*[-+]|player_capacity\s*[-+]/);
    expect(s).not.toMatch(/\.rpc\(["']\w*reservation_(participant|guest)/);
  });

  it("10. no polling, realtime subscription, or global/custom DOM event was introduced — refresh is driven exclusively by the refreshRevision prop dependency", () => {
    const s = section();
    expect(s).not.toMatch(/setInterval|setTimeout/);
    expect(s).not.toMatch(/\.channel\(|realtime|supabase\.from\(.*\)\.on\(/i);
    expect(s).not.toMatch(/addEventListener|dispatchEvent|CustomEvent|window\.postMessage/);

    const d = detail();
    expect(d).not.toMatch(/setInterval|setTimeout/);
    expect(d).not.toMatch(/\.channel\(|realtime/i);
    expect(d).not.toMatch(/CustomEvent|dispatchEvent\(/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Reservation-edit stale-state check — PROVEN ALREADY GUARANTEED, no code
// change made. A successful EditReservationSheet save closes the ENTIRE
// ReservationDetailSheet (unmounting both ReservationRosterSection and
// ReservationPlayerSearchSection), not merely the edit sub-sheet — so no
// stale ReservationPlayerSearchSection instance can ever survive a save,
// and any later reopen of that reservation mounts a brand-new instance
// whose own load effect unconditionally re-fetches canonical state. These
// tests prove that chain end-to-end from the real source, rather than
// asserting a refresh-revision mechanism that turned out not to be needed.
// ═══════════════════════════════════════════════════════════════════════════

describe("reservation-edit stale-state: already guaranteed by full-sheet unmount, no change needed", () => {
  it("1a. EditReservationSheet calls onSaved() only after an error-free RPC response — never on a raw error or a stale-edit conflict", () => {
    const e = editReservationSheet();
    const saveCallIdx = e.indexOf("onSaved();");
    expect(saveCallIdx).toBeGreaterThan(0);
    // Exactly one call site.
    expect((e.match(/onSaved\(\);/g) ?? []).length).toBe(1);
    // Both error branches return before reaching it.
    const errorBlockIdx = e.indexOf('if (rpcError.message === "stale_edit_conflict")');
    expect(errorBlockIdx).toBeGreaterThan(0);
    expect(errorBlockIdx).toBeLessThan(saveCallIdx);
    const between = e.slice(errorBlockIdx, saveCallIdx);
    expect(between).toMatch(/return;\s*\n\s*\}/); // the error branch returns before falling through
  });

  it("1b. ReservationDetailSheet's onSaved wiring always calls the parent's onUpdated on a successful save", () => {
    const d = detail();
    expect(d).toContain("onSaved={() => { setEditOpen(false); onUpdated(); }}");
  });

  it("1c. CalendarShell's onUpdated for ReservationDetailSheet sets selectedReservation to null — a full unmount, not a partial refresh", () => {
    const cs = calendarShell();
    expect(cs).toContain("onUpdated={() => { setRefreshTick(t => t + 1); setSelectedReservation(null); }}");
  });

  it("1d. ReservationDetailSheet (and therefore both sibling sections) has exactly one render site in CalendarShell, gated entirely by selectedReservation — so setSelectedReservation(null) unmounts the whole subtree, not just closes a visual layer", () => {
    const cs = calendarShell();
    expect((cs.match(/<ReservationDetailSheet/g) ?? []).length).toBe(1);
    const idx = cs.indexOf("<ReservationDetailSheet");
    const guardLine = cs.slice(cs.lastIndexOf("{selectedReservation", idx), idx);
    expect(guardLine).toContain("{selectedReservation && (");
  });

  it("4. ReservationPlayerSearchSection's load effect unconditionally re-fetches via getReservationPlayerSearch on every fresh mount (not cancelled) — guaranteeing any reopened reservation is canonical, never carried-over state from a prior instance", () => {
    const s = section();
    const effectIdx = s.indexOf("useEffect(() => {");
    const depsIdx = s.indexOf("}, [reservationId, clubId, isCancelled, refreshRevision]);");
    const body = s.slice(effectIdx, depsIdx);
    expect(body).toContain("if (isCancelled) return;");
    expect(body).toContain("loadState();");
    const loadStateFnIdx = s.indexOf("function loadState()");
    const loadStateEnd = s.indexOf("\n  }\n", loadStateFnIdx);
    expect(s.slice(loadStateFnIdx, loadStateEnd)).toContain("getReservationPlayerSearch(reservationId, clubId)");
  });

  it("2. existing onUpdated/onSaved behavior is fully preserved — no rewrite of the save-close-refresh chain was made for this correction", () => {
    const d = detail();
    // The exact same wiring proven in 1b above, confirming nothing here
    // was altered as part of this correction pass.
    expect(d).toContain("onSaved={() => { setEditOpen(false); onUpdated(); }}");
    expect(d).toContain("onClose={() => setEditOpen(false)}");
  });

  it("3. a cancelled edit (Close, no save) never reaches onSaved/onUpdated — EditReservationSheet's onClose is a separate, distinct prop never aliased to onSaved", () => {
    const d = detail();
    expect(d).toContain("onClose={() => setEditOpen(false)}");
    // onClose and onSaved are two independent props passed to EditReservationSheet — closing alone never fires onUpdated.
    const editSheetIdx = d.indexOf("<EditReservationSheet");
    const editSheetEnd = d.indexOf("/>", editSheetIdx);
    const propsBlock = d.slice(editSheetIdx, editSheetEnd);
    expect(propsBlock).toContain("onClose={() => setEditOpen(false)}");
    expect(propsBlock).toContain("onSaved={() => { setEditOpen(false); onUpdated(); }}");
    expect(propsBlock.match(/onUpdated\(\)/g)?.length).toBe(1); // only reachable via the onSaved prop, not onClose
  });

  it("5. no reservation guest_names or host-eligibility logic is reimplemented client-side anywhere in the edit-save or player-search-load path", () => {
    const s = section();
    const e = editReservationSheet();
    // ReservationPlayerSearchSection legitimately matches on the backend's
    // OWN error-code/block-reason strings (reservation_has_legacy_guest_
    // names, legacy_guest_names) as plain switch cases — that is copy
    // mapping, not reimplementation. What must never exist is the
    // component reading/inspecting a raw guest_names array itself, or
    // computing host eligibility from a raw roster_member_id comparison.
    expect(s).not.toMatch(/\.guest_names\b/);
    expect(s).not.toMatch(/array_length/);
    expect(s).not.toMatch(/roster_member_id\s*(===|!==|==|!=)/);
    // EditReservationSheet legitimately reads/writes guest_names as a plain
    // form field (pre-existing, untouched Phase 33C2 behavior) — what must
    // never exist is any LOCAL effective-open/block-reason computation.
    expect(e).not.toMatch(/effective_is_open|effective_open_block_reason|is_effective_open/);
  });

  it("no refreshRevision increment or second refresh mechanism was added to the edit-save path — the existing full-unmount behavior is the only synchronization mechanism for this case", () => {
    const d = detail();
    const editSheetIdx = d.indexOf("<EditReservationSheet");
    const editSheetEnd = d.indexOf("/>", editSheetIdx);
    const propsBlock = d.slice(editSheetIdx, editSheetEnd);
    expect(propsBlock).not.toMatch(/refreshRevision|setRosterRefreshRevision|setPlayerSearchRefreshRevision/);
  });
});
