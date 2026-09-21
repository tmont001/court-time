import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 43B-4B — "Copy Waiver Link" mint wiring for both Guest source
// domains, built on the 43B-4A backend (0198, applied/immutable — not
// touched by this checkpoint). Source-inspection style, matching this
// repository's established convention.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

function codeOnly(src: string): string {
  return src.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
}

function extractFunctionBody(source: string, marker: string): string {
  const start = source.indexOf(marker);
  expect(start, `${marker} not found`).toBeGreaterThan(-1);
  const sigWindow = source.slice(start, start + 400);
  const bodyOpenMatch = sigWindow.match(/\)\s*:\s*Promise<[\s\S]*?>\s*\{/);
  const relativeBodyStart = bodyOpenMatch
    ? bodyOpenMatch.index! + bodyOpenMatch[0].length - 1
    : sigWindow.indexOf("{");
  let depth = 0;
  let i = start + relativeBodyStart;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return source.slice(start, i + 1);
}

const CALENDAR_ACTIONS_PATH = "src/app/(app)/calendar/actions.ts";
const RESERVATION_ROSTER_SECTION_PATH = "src/app/(app)/calendar/ReservationRosterSection.tsx";
const EVENTS_ACTIONS_PATH = "src/app/(app)/admin/events/actions.ts";
const EVENT_ROSTER_SHEET_PATH = "src/app/(app)/calendar/EventRosterSheet.tsx";
const RESERVATION_RPC_AUTH_PATH = "supabase/migrations/0179_reservation_roster_rpc_layer.sql";
const EVENT_GUEST_AUTH_PATH = "supabase/migrations/0136_staff_event_operational_authorization.sql";
const TOKEN_SERVER_PATH = "src/lib/waivers/guestWaiverTokenServer.ts";

const calendarActionsSrc = readSource(CALENDAR_ACTIONS_PATH);
const calendarActionsCodeOnly = codeOnly(calendarActionsSrc);
const reservationRosterSrc = readSource(RESERVATION_ROSTER_SECTION_PATH);
const eventsActionsSrc = readSource(EVENTS_ACTIONS_PATH);
const eventsActionsCodeOnly = codeOnly(eventsActionsSrc);
const eventRosterSheetSrc = readSource(EVENT_ROSTER_SHEET_PATH);

// ═══════════════════════════════════════════════════════════════════════════
// RESERVATION LINK GENERATION
// ═══════════════════════════════════════════════════════════════════════════

describe("Reservation Guest — link generation", () => {
  const fn = extractFunctionBody(
    calendarActionsSrc,
    "export async function mintReservationGuestWaiverInvitationAction("
  );

  it("uses the reservation mint RPC (mint_reservation_guest_waiver_invitation) — not the event one", () => {
    expect(fn).toContain('supabase.rpc("mint_reservation_guest_waiver_invitation"');
    expect(fn).not.toContain("mint_event_guest_waiver_invitation");
  });

  it("generates the raw token via the production server-only wrapper (guestWaiverTokenServer), not the pure test module directly", () => {
    expect(calendarActionsCodeOnly).toContain(
      'import { generateGuestWaiverToken, hashGuestWaiverToken } from "@/lib/waivers/guestWaiverTokenServer";'
    );
    expect(calendarActionsCodeOnly).not.toContain('from "@/lib/waivers/guestWaiverToken"');
  });

  it("the raw token is generated exactly once and only its hash is sent to the RPC", () => {
    const generateCount = (fn.match(/generateGuestWaiverToken\(\)/g) ?? []).length;
    expect(generateCount).toBe(1);
    expect(fn).toContain("p_token_hash: tokenHash");
    expect(fn).not.toMatch(/p_token_hash:\s*rawToken/);
  });

  it("the returned public URL contains the raw token and is built from the canonical SITE_URL utility, never a hard-coded host", () => {
    expect(fn).toContain("`${SITE_URL}/waivers/guest/${rawToken}`");
    expect(calendarActionsCodeOnly).toContain('import { SITE_URL } from "@/lib/siteUrl";');
    expect(fn).not.toMatch(/localhost|https:\/\/court-time\.app/);
  });

  it("mint failure (assertActiveClub guard OR RPC error) returns no url at all — never a usable fake link", () => {
    const guardStatement = "if (!guard.ok) return { error: guard.error };";
    const rpcErrorStatement = "if (error) return { error: error.message };";
    const guardIdx = fn.indexOf(guardStatement);
    const rpcErrorIdx = fn.indexOf(rpcErrorStatement);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(rpcErrorIdx).toBeGreaterThan(guardIdx);
    // Both early-return branches return only {error}, never {url, error} —
    // checked against the statement's OWN text only, not a fixed-width
    // window that could bleed into the next line's `return { url: ... }`.
    expect(guardStatement).not.toContain("url:");
    expect(rpcErrorStatement).not.toContain("url:");
  });

  it("preflights with assertActiveClub exactly like addReservationGuest/removeReservationGuest — same stale-club posture, no new authorization abstraction", () => {
    expect(fn).toContain("assertActiveClub(expectedClubId)");
  });
});

describe("Reservation Guest — Copy Waiver Link UI wiring", () => {
  it("the roster section imports and calls the reservation mint action", () => {
    expect(reservationRosterSrc).toContain("mintReservationGuestWaiverInvitationAction,");
    expect(reservationRosterSrc).toContain(
      "mintReservationGuestWaiverInvitationAction(reservationId, clubId, row.relationship_id)"
    );
  });

  it("copies the returned URL to the clipboard and shows success feedback ('Copied!')", () => {
    expect(reservationRosterSrc).toContain("navigator.clipboard.writeText(result.url)");
    expect(reservationRosterSrc).toContain('"Copied!"');
  });

  it("the button carries a tooltip making rotation-replaces-the-old-link behavior understandable", () => {
    expect(reservationRosterSrc).toContain(
      'title="Creating a new link replaces the previous Guest waiver link."'
    );
  });

  it("is gated by the same !isCancelled condition as Remove — no new, looser availability than the existing Guest management boundary", () => {
    const handlerCallIdx = reservationRosterSrc.indexOf("onClick={() => handleCopyWaiverLink(row)}");
    const precedingGate = reservationRosterSrc.slice(Math.max(0, handlerCallIdx - 350), handlerCallIdx);
    expect(precedingGate).toContain("!isCancelled &&");
  });

  it("new error codes from the mint RPC are mapped to friendly copy, not raw exception text", () => {
    expect(reservationRosterSrc).toContain('case "no_current_guest_waiver":');
    expect(reservationRosterSrc).toContain('case "guest_waiver_not_required":');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// EVENT LINK GENERATION
// ═══════════════════════════════════════════════════════════════════════════

describe("Event Guest — link generation", () => {
  const fn = extractFunctionBody(
    eventsActionsSrc,
    "export async function mintEventGuestWaiverInvitationAction("
  );

  it("uses the event mint RPC (mint_event_guest_waiver_invitation) — not the reservation one", () => {
    expect(fn).toContain('supabase.rpc("mint_event_guest_waiver_invitation"');
    expect(fn).not.toContain("mint_reservation_guest_waiver_invitation");
  });

  it("generates the raw token via the production server-only wrapper, exactly like the reservation action", () => {
    expect(eventsActionsCodeOnly).toContain(
      'import { generateGuestWaiverToken, hashGuestWaiverToken } from "@/lib/waivers/guestWaiverTokenServer";'
    );
  });

  it("the raw token is generated exactly once and only its hash is sent to the RPC", () => {
    const generateCount = (fn.match(/generateGuestWaiverToken\(\)/g) ?? []).length;
    expect(generateCount).toBe(1);
    expect(fn).toContain("p_token_hash: tokenHash");
  });

  it("the returned public URL is built from SITE_URL, never a hard-coded host", () => {
    expect(fn).toContain("`${SITE_URL}/waivers/guest/${rawToken}`");
  });

  it("mint failure returns no url at all — never a usable fake link", () => {
    const guardStatement = "if (!guard.ok) return { error: ERROR_MESSAGES[guard.error] };";
    const rpcErrorStatement = "if (error) return { error: rpcError(error) };";
    const guardIdx = fn.indexOf(guardStatement);
    const rpcErrorIdx = fn.indexOf(rpcErrorStatement);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(rpcErrorIdx).toBeGreaterThan(guardIdx);
    expect(guardStatement).not.toContain("url:");
    expect(rpcErrorStatement).not.toContain("url:");
  });

  it("preflights with assertActiveClub exactly like adminAddGuest/adminRemoveGuest — no new authorization abstraction", () => {
    expect(fn).toContain("assertActiveClub(expectedClubId)");
  });
});

describe("Event Guest — Copy Waiver Link UI wiring", () => {
  it("the roster sheet imports and calls the event mint action", () => {
    expect(eventRosterSheetSrc).toContain("mintEventGuestWaiverInvitationAction,");
    expect(eventRosterSheetSrc).toContain(
      "mintEventGuestWaiverInvitationAction(eventId, row.profile_id!, clubId)"
    );
  });

  it("copies the returned URL to the clipboard and shows success feedback ('Copied!')", () => {
    expect(eventRosterSheetSrc).toContain("navigator.clipboard.writeText(result.url)");
    expect(eventRosterSheetSrc).toContain('"Copied!"');
  });

  it("the button carries a tooltip making rotation-replaces-the-old-link behavior understandable", () => {
    expect(eventRosterSheetSrc).toContain(
      'title="Creating a new link replaces the previous Guest waiver link."'
    );
  });

  it("is gated by isAdmin (canAccessOperationsWorkspace: admin/pro/staff) — the SAME allowlist as Remove, never widened to Member", () => {
    const copyButtonIdx = eventRosterSheetSrc.indexOf("onClick={() => handleCopyWaiverLink(row)}");
    const precedingGate = eventRosterSheetSrc.slice(Math.max(0, copyButtonIdx - 300), copyButtonIdx);
    expect(precedingGate).toContain("isAdmin && !readOnly &&");
  });

  it("new error codes from the mint RPC are mapped to friendly copy in the shared ERROR_MESSAGES table", () => {
    expect(eventsActionsCodeOnly).toContain("no_current_guest_waiver:");
    expect(eventsActionsCodeOnly).toContain("guest_waiver_not_required:");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TOKEN ROTATION UX
// ═══════════════════════════════════════════════════════════════════════════

describe("TOKEN ROTATION UX", () => {
  it("repeated Copy Link intentionally creates a new invitation — mint is called unconditionally on every click, no 'already has a link' short-circuit in either action", () => {
    const reservationFn = extractFunctionBody(
      calendarActionsSrc,
      "export async function mintReservationGuestWaiverInvitationAction("
    );
    const eventFn = extractFunctionBody(
      eventsActionsSrc,
      "export async function mintEventGuestWaiverInvitationAction("
    );
    for (const fn of [reservationFn, eventFn]) {
      expect(fn).not.toMatch(/hasActiveToken|already.*active|existingInvitation/i);
    }
  });

  it("0198's own mint helper rotation semantics are what actually enforce 'max one active invitation per slot' — this checkpoint's actions add no parallel dedupe logic of their own", () => {
    for (const fn of [calendarActionsCodeOnly, eventsActionsCodeOnly]) {
      expect(fn).not.toMatch(/revoked_at|active_reservation_guest_idx|active_event_guest_idx/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUTHORIZATION REGRESSIONS
// ═══════════════════════════════════════════════════════════════════════════

describe("AUTHORIZATION REGRESSIONS", () => {
  it("no widening of Reservation roster authorization — mint_reservation_guest_waiver_invitation (0198) still calls the exact same private helper add/removeReservationGuest already use", () => {
    const migrationSql = readSource("supabase/migrations/0198_guest_waiver_invitation_acceptance.sql");
    expect(migrationSql).toContain(
      "public._authorize_reservation_roster_access(p_reservation_id, p_expected_club_id, true)"
    );
    // The underlying helper itself (0179, immutable) is untouched by 0198.
    const authHelperSrc = readSource(RESERVATION_RPC_AUTH_PATH);
    expect(authHelperSrc).toContain("create or replace function public._authorize_reservation_roster_access(");
  });

  it("no widening of Event Guest authorization — mint_event_guest_waiver_invitation (0198) uses the exact same admin/pro/staff allowlist as the CURRENT (0136) admin_add_guest/admin_remove_guest", () => {
    const migrationSql = readSource("supabase/migrations/0198_guest_waiver_invitation_acceptance.sql");
    expect(migrationSql).toContain("if v_actor.role not in ('admin', 'pro', 'staff') then");
    expect(migrationSql).not.toMatch(/'admin', 'pro', 'staff', 'member'/);
    const currentEventGuestAuth = readSource(EVENT_GUEST_AUTH_PATH);
    expect(currentEventGuestAuth).toContain("if v_actor.role not in ('admin', 'pro', 'staff') then");
  });

  it("neither mint Server Action independently re-derives or loosens authorization — both delegate entirely to their RPC plus the shared assertActiveClub preflight", () => {
    const reservationFn = extractFunctionBody(
      calendarActionsSrc,
      "export async function mintReservationGuestWaiverInvitationAction("
    );
    const eventFn = extractFunctionBody(
      eventsActionsSrc,
      "export async function mintEventGuestWaiverInvitationAction("
    );
    for (const fn of [reservationFn, eventFn]) {
      expect(fn).not.toMatch(/role ===|role in \(|isAdmin|isOperator|isStaff|isPro/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// OUT OF SCOPE — no email/SMS, no Guest CRM
// ═══════════════════════════════════════════════════════════════════════════

describe("out of scope items are genuinely absent", () => {
  it("no email/SMS sending anywhere in the new mint functions specifically (the surrounding files legitimately send email/SMS for other, unrelated features)", () => {
    const reservationFn = extractFunctionBody(
      calendarActionsSrc,
      "export async function mintReservationGuestWaiverInvitationAction("
    );
    const eventFn = extractFunctionBody(
      eventsActionsSrc,
      "export async function mintEventGuestWaiverInvitationAction("
    );
    for (const fn of [reservationFn, eventFn]) {
      expect(fn).not.toMatch(/sendEmail|sendSms|sendRosterOperationalEmail/);
    }
  });

  it("no new Guest identity/CRM table or persisted contact field (email/phone) is introduced by the mint actions", () => {
    for (const src of [calendarActionsCodeOnly, eventsActionsCodeOnly]) {
      expect(src).not.toMatch(/guest_email|guest_phone|guest_contacts|create.*guest.*record/i);
    }
  });

  it("guestWaiverTokenServer.ts (the production import path) is unchanged by this checkpoint — same file 43B-4A's own hardening pass already produced", () => {
    const s = readSource(TOKEN_SERVER_PATH);
    expect(s.trimStart().startsWith('import "server-only";')).toBe(true);
    expect(s).not.toMatch(/randomBytes|createHash/); // still a pure re-export, no logic of its own
  });
});
