import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// Phase 39C-2B — regression coverage for Open Games discovery + instant
// join, using this repository's established source-inspection style (see
// reservationRosterUx.regression.test.ts / reservationPlayerSearchOwnerUx.
// regression.test.ts's own header comments for why: pure-TypeScript, no
// jsdom/React Testing Library available for a "use client" component).

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const VIEW_PATH    = "src/app/(app)/calendar/OpenGamesView.tsx";
const SHELL_PATH   = "src/app/(app)/calendar/CalendarShell.tsx";
const ACTIONS_PATH = "src/app/(app)/calendar/actions.ts";

const view    = () => readSource(VIEW_PATH);
const shell   = () => readSource(SHELL_PATH);
const actions = () => readSource(ACTIONS_PATH);

function functionBody(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  expect(start, `function ${name} not found`).toBeGreaterThanOrEqual(0);
  // Find the matching closing brace by simple nesting count from the first '{' after the signature.
  const braceStart = src.indexOf("{", start);
  let depth = 0;
  let i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return src.slice(start, i + 1);
}

// ═══════════════════════════════════════════════════════════════════════════
// EXISTENCE
// ═══════════════════════════════════════════════════════════════════════════

describe("OpenGamesView exists", () => {
  it("component file exists on disk", () => {
    expect(existsSync(join(process.cwd(), VIEW_PATH))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 1-6. CALENDAR IA
// ═══════════════════════════════════════════════════════════════════════════

describe("1-6. Calendar / Open Games IA", () => {
  it("1. PageTabs uses 'Calendar' / 'Open Games' labels, not 'Grid'", () => {
    const s = shell();
    expect(s).toContain('label: "Calendar"');
    expect(s).toContain('label: "Open Games"');
    expect(s).not.toMatch(/label:\s*"Grid"/);
  });

  it("2. Open Games (OpenGamesView) is rendered as a sibling content branch inside CalendarShell, not as reservation blocks inside the grid", () => {
    const s = shell();
    expect(s).toContain("import OpenGamesView from \"./OpenGamesView\";");
    expect(s).toContain("{isOpenGamesView ? (\n          <OpenGamesView clubId={clubId} clubTimezone={clubTimezone} />\n        ) : (");
  });

  it("3. the ?view=open-games query param activates isOpenGamesView, both from initial state and from a live searchParams change (covers direct navigation and back/forward)", () => {
    const s = shell();
    expect(s).toContain('() => searchParams.get("view") === "open-games"');
    expect(s).toContain('setIsOpenGamesView(searchParams.get("view") === "open-games");');
  });

  it("4. returning to Calendar removes the view param cleanly via setCalendarView(\"calendar\") — params.delete, not merely set to a falsy value", () => {
    const s = shell();
    const body = functionBody(s, "setCalendarView");
    expect(body).toContain('params.delete("view");');
    expect(body).toContain('params.set("view", "open-games");');
  });

  it("uses window.history.replaceState (never router.push/replace) — matching the existing deep-link URL convention exactly, so switching views never forces a Server Component remount", () => {
    const s = shell();
    const body = functionBody(s, "setCalendarView");
    expect(body).toContain("window.history.replaceState(null, \"\",");
    expect(body).not.toMatch(/router\.(push|replace)\(/);
  });

  it("5. no bottom-navigation component is imported or rendered by this checkpoint — explanatory comments naming 'bottom nav' to describe scope are fine, an actual import/JSX usage is not", () => {
    const s = shell();
    expect(s).not.toMatch(/import .*BottomNav/);
    expect(s).not.toMatch(/<BottomNav/);
  });

  it("6. ordinary grid privacy is untouched — canOpenReservationDetail/isOwnReservation imports and usage are unchanged, and no new import of a broader detail-access helper was added", () => {
    const s = shell();
    expect(s).toContain('import { canOpenReservationDetail, isOwnReservation } from "@/lib/calendar/reservationAccess";');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7-9. SERVER ACTIONS
// ═══════════════════════════════════════════════════════════════════════════

describe("7-9. server action wrappers", () => {
  it("7. getOpenReservationPlayerSearches calls get_open_reservation_player_searches, and only that RPC", () => {
    const a = actions();
    const start = a.indexOf("export async function getOpenReservationPlayerSearches(");
    const end = a.indexOf("\n}\n", start);
    const body = a.slice(start, end);
    expect(body).toContain('supabase.rpc("get_open_reservation_player_searches"');
    expect(body).not.toMatch(/supabase\.rpc\("join_reservation_player_search/);
    expect(body).toContain("await assertActiveClub(expectedClubId)");
  });

  it("8. joinReservationPlayerSearch calls join_reservation_player_search, and only that RPC", () => {
    const a = actions();
    const start = a.indexOf("export async function joinReservationPlayerSearch(");
    const end = a.indexOf("\n}\n", start);
    const body = a.slice(start, end);
    expect(body).toContain('supabase.rpc("join_reservation_player_search"');
    expect(body).not.toMatch(/supabase\.rpc\("get_open_reservation_player_searches/);
    expect(body).toContain("await assertActiveClub(expectedClubId)");
  });

  it("9. neither OpenGamesView nor the two new actions query reservation_player_searches directly — RPC-only access, matching its zero-client-grant posture", () => {
    const v = view();
    const a = actions();
    for (const src of [v, a]) {
      expect(src).not.toMatch(/\.from\(["']reservation_player_searches["']\)/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10-13. PRIVACY / ALLOWLIST
// ═══════════════════════════════════════════════════════════════════════════

describe("10-13. privacy — allowed fields only, no broadened detail access, no role gate", () => {
  it("10. the ReservationPlayerSearchOpportunity interface exposes exactly the ten allowed fields", () => {
    const a = actions();
    const start = a.indexOf("export interface ReservationPlayerSearchOpportunity {");
    const end = a.indexOf("}", start);
    const body = a.slice(start, end);
    for (const field of [
      "reservation_id", "court_id", "court_name", "starts_at", "ends_at",
      "format", "host_display_name", "player_capacity", "occupied_seats", "remaining_spots",
    ]) {
      expect(body).toContain(field);
    }
  });

  it("11. no owner/payment/notes/email/phone/guest/waiver field is referenced anywhere in OpenGamesView or the two new actions", () => {
    const v = view();
    const a = actions();
    const interfaceStart = a.indexOf("export interface ReservationPlayerSearchOpportunity {");
    const interfaceEnd = a.indexOf("}", interfaceStart);
    const interfaceBody = a.slice(interfaceStart, interfaceEnd);
    for (const forbidden of [/owner_user_id/, /email/i, /phone/i, /\bnotes\b/i, /guest/i, /waiver/i, /price|payment/i]) {
      expect(v).not.toMatch(forbidden);
      expect(interfaceBody).not.toMatch(forbidden);
    }
  });

  it("12. no ReservationDetailSheet import or render exists in OpenGamesView — a card is never clickable into full reservation detail (an explanatory comment naming it to state that policy is fine; an actual import/render is not)", () => {
    const v = view();
    expect(v).not.toMatch(/import .*ReservationDetailSheet/);
    expect(v).not.toMatch(/<ReservationDetailSheet/);
    expect(v).not.toMatch(/setSelectedReservation/);
  });

  it("13. no auth-role-only participation gate — OpenGamesView never reads or branches on userRole, and never receives it as a prop", () => {
    const v = view();
    expect(v).not.toMatch(/userRole/);
    const propsStart = v.indexOf("interface Props {");
    const propsEnd = v.indexOf("}", propsStart);
    const propsBody = v.slice(propsStart, propsEnd);
    expect(propsBody).not.toMatch(/role/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 14-17. JOIN BEHAVIOR
// ═══════════════════════════════════════════════════════════════════════════

describe("14-17. join behavior — canonical, no optimistic arithmetic", () => {
  it("14. handleJoin calls joinReservationPlayerSearch", () => {
    const v = view();
    const body = functionBody(v, "handleJoin");
    expect(body).toContain("joinReservationPlayerSearch(reservationId, clubId)");
  });

  it("15. a successful join re-fetches canonical discovery state via loadOpportunities(), not a local list splice", () => {
    const v = view();
    const body = functionBody(v, "handleJoin");
    expect(body).toContain("loadOpportunities();");
    expect(body).not.toMatch(/setOpportunities\(prev =>/);
    expect(body).not.toMatch(/\.filter\(/);
  });

  it("16. joinReservationPlayerSearch (the server action) revalidates /my-schedule on success, alongside /calendar", () => {
    const a = actions();
    const start = a.indexOf("export async function joinReservationPlayerSearch(");
    const end = a.indexOf("\n}\n", start);
    const body = a.slice(start, end);
    expect(body).toContain('revalidatePath("/calendar");');
    expect(body).toContain('revalidatePath("/my-schedule");');
  });

  it("17. no client-side occupancy/capacity arithmetic anywhere in OpenGamesView — occupied_seats/player_capacity/remaining_spots are only ever displayed verbatim", () => {
    const v = view();
    expect(v).not.toMatch(/occupied_seats\s*[-+]|player_capacity\s*[-+]|remaining_spots\s*[-+]/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 18-21. FRIENDLY ERROR MAPPING / RACE BEHAVIOR
// ═══════════════════════════════════════════════════════════════════════════

describe("18-21. friendly error mapping and race behavior", () => {
  it("18. reservation_player_search_full maps to friendly 'spot no longer available' copy", () => {
    const v = view();
    const fnBody = functionBody(v, "mapOpenGamesError");
    expect(fnBody).toContain('case "reservation_player_search_full":');
    expect(fnBody).toMatch(/spot is no longer available/);
  });

  it("19. reservation_player_search_not_open maps to friendly 'no longer open' copy", () => {
    const v = view();
    const fnBody = functionBody(v, "mapOpenGamesError");
    expect(fnBody).toContain('case "reservation_player_search_not_open":');
    expect(fnBody).toMatch(/no longer open for new players/);
  });

  it("20. capability_not_available / roster_identity_required / roster_member_inactive all get distinct friendly copy — no raw code ever surfaces", () => {
    const v = view();
    const fnBody = functionBody(v, "mapOpenGamesError");
    expect(fnBody).toContain('case "capability_not_available":');
    expect(fnBody).toContain('case "roster_identity_required":');
    expect(fnBody).toContain('case "roster_member_inactive":');
    // Plus the remaining required generic mappings.
    for (const code of [
      "reservation_not_found", "reservation_not_confirmed", "reservation_already_started",
    ]) {
      expect(fnBody).toContain(`case "${code}":`);
    }
    expect(fnBody).toContain("if (code === STALE_CLUB_CONTEXT_ERROR) return STALE_CLUB_MESSAGE;");
  });

  it("21. a failed join triggers a canonical re-fetch (loadOpportunities) before presenting the final stable state — the error is recorded AND the list is refreshed, not either/or", () => {
    const v = view();
    const body = functionBody(v, "handleJoin");
    const errorBranchIdx = body.indexOf("if (result.error) {");
    const setErrorIdx = body.indexOf("setJoinErrors(prev =>", errorBranchIdx);
    const refetchIdx = body.indexOf("loadOpportunities();", errorBranchIdx);
    expect(errorBranchIdx).toBeGreaterThan(0);
    expect(setErrorIdx).toBeGreaterThan(errorBranchIdx);
    expect(refetchIdx).toBeGreaterThan(setErrorIdx);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 22-23. EMPTY STATE / TIMEZONE
// ═══════════════════════════════════════════════════════════════════════════

describe("22-23. empty state and club-timezone presentation", () => {
  it("22. renders 'No open games right now.' when the list is empty and there is no loading/error state", () => {
    const v = view();
    expect(v).toContain("No open games right now.");
    expect(v).toMatch(/!loading && !loadError && opportunities\.length === 0/);
  });

  it("23. date/time formatting uses clubTimezone (the prop), not the browser's local timezone", () => {
    const v = view();
    const dateFn = functionBody(v, "formatDateLabel");
    const timeFn = functionBody(v, "formatTimeLabel");
    expect(dateFn).toContain("timeZone: tz");
    expect(timeFn).toContain("timeZone: tz");
    expect(v).toContain("formatDateLabel(game.starts_at, clubTimezone)");
    expect(v).toContain("formatTimeLabel(game.starts_at, clubTimezone)");
  });

  it("a load failure renders inline within OpenGamesView (with a Try again retry) rather than throwing — never breaks the Calendar view", () => {
    const v = view();
    expect(v).toContain("Try again");
    expect(v).not.toMatch(/\bthrow\b/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SCOPE COMPLIANCE (items 27-28 from the broader checkpoint)
// ═══════════════════════════════════════════════════════════════════════════

describe("scope compliance", () => {
  it("27. no new notification preference category was introduced by this checkpoint", () => {
    const v = view();
    const a = actions();
    expect(v).not.toMatch(/notification_preferences/);
    expect(a).not.toMatch(/notification_preferences/);
  });

  it("neither the discovery nor join server action touches payments/pricing/checkout/refund/cancellation state", () => {
    const a = actions();
    const discoveryStart = a.indexOf("export async function getOpenReservationPlayerSearches(");
    const discoveryEnd = a.indexOf("\n}\n", discoveryStart);
    const joinStart = a.indexOf("export async function joinReservationPlayerSearch(");
    const joinEnd = a.indexOf("\n}\n", joinStart);
    for (const body of [a.slice(discoveryStart, discoveryEnd), a.slice(joinStart, joinEnd)]) {
      expect(body).not.toMatch(/payment|price_amount_cents|hourly_rate_cents|checkout|refund|stripe|cancel/i);
    }
  });
});
