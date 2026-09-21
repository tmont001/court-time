import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 43B-5B — Guest Waiver Compliance Surfaces. Shows current Guest
// waiver compliance directly on Reservation/Event Guest rows,
// informational only. Backed by a new migration (0199, authorized after
// a blocker report found no existing set-based read for this — neither
// get_reservation_roster (0179) nor get_event_roster (0117) joins
// guest_waiver_acceptances/waivers). 0198 untouched. Source-inspection
// style, matching this repository's established convention for
// not-yet-applied migrations.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

function codeOnly(src: string): string {
  return src.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
}

function extractFunctionBody(source: string, marker: string): string {
  const start = source.indexOf(marker);
  expect(start, `${marker} not found`).toBeGreaterThan(-1);
  const end = source.indexOf("\n$$;", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end + "\n$$;".length);
}

function extractTsFunctionBody(source: string, marker: string): string {
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

const MIGRATION_PATH = "supabase/migrations/0199_guest_waiver_compliance_operations.sql";
const EVENT_ROSTER_RPC_PATH = "supabase/migrations/0117_durable_member_guest_lifecycle_and_attendance.sql";
const CALENDAR_ACTIONS_PATH = "src/app/(app)/calendar/actions.ts";
const RESERVATION_ROSTER_SECTION_PATH = "src/app/(app)/calendar/ReservationRosterSection.tsx";
const EVENTS_ACTIONS_PATH = "src/app/(app)/admin/events/actions.ts";
const EVENT_ROSTER_SHEET_PATH = "src/app/(app)/calendar/EventRosterSheet.tsx";

const migrationSrc = readSource(MIGRATION_PATH);
const migrationCodeOnly = codeOnly(migrationSrc);
const calendarActionsSrc = readSource(CALENDAR_ACTIONS_PATH);
const reservationRosterSrc = readSource(RESERVATION_ROSTER_SECTION_PATH);
const eventsActionsSrc = readSource(EVENTS_ACTIONS_PATH);
const eventRosterSheetSrc = readSource(EVENT_ROSTER_SHEET_PATH);

function reservationRpcBody(): string {
  return extractFunctionBody(
    migrationCodeOnly,
    "create or replace function public.get_reservation_guest_waiver_compliance("
  );
}
function eventRpcBody(): string {
  return extractFunctionBody(
    migrationCodeOnly,
    "create or replace function public.get_event_guest_waiver_compliance("
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Migration ordering / scope guard
// ═══════════════════════════════════════════════════════════════════════════

describe("migration ordering", () => {
  it("0199 is the next migration after immutable 0198, and 0198 is not modified by this checkpoint", () => {
    expect(() => readSource("supabase/migrations/0198_guest_waiver_invitation_acceptance.sql")).not.toThrow();
    expect(() => readSource(MIGRATION_PATH)).not.toThrow();
  });

  it("0199 is wrapped in a single begin;/commit; transaction block", () => {
    expect(migrationCodeOnly).toMatch(/^begin;/m);
    expect(migrationCodeOnly).toMatch(/^commit;/m);
  });

  it("no writes anywhere in this migration's function bodies — read-only (no insert/update/delete)", () => {
    expect(reservationRpcBody()).not.toMatch(/\binsert\b|\bupdate\b|\bdelete\b/i);
    expect(eventRpcBody()).not.toMatch(/\binsert\b|\bupdate\b|\bdelete\b/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUTHORIZATION AUDIT CONCLUSION — Event roster READ boundary
// ═══════════════════════════════════════════════════════════════════════════

describe("Event roster READ authorization audit conclusion: admin+pro ONLY, never staff", () => {
  it("get_event_roster's CURRENT (0117) definition rejects everyone except admin/pro", () => {
    const s = readSource(EVENT_ROSTER_RPC_PATH);
    const idx = s.indexOf("create or replace function get_event_roster(p_event_id uuid)");
    expect(idx).toBeGreaterThan(-1);
    const fn = s.slice(idx, idx + 800);
    expect(fn).toContain("if v_profile.role not in ('admin', 'pro') then");
    expect(fn).not.toMatch(/'admin', 'pro', 'staff'/);
  });

  it("get_event_guest_waiver_compliance (0199) mirrors that EXACT boundary — not the wider admin/pro/staff mutation boundary", () => {
    const fn = eventRpcBody();
    expect(fn).toContain("if v_profile.role not in ('admin', 'pro') then");
    expect(fn).not.toMatch(/'admin', 'pro', 'staff'/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BACKEND — Reservation RPC
// ═══════════════════════════════════════════════════════════════════════════

describe("get_reservation_guest_waiver_compliance", () => {
  it("reuses _authorize_reservation_roster_access verbatim, with p_require_not_cancelled = false — matching get_reservation_roster's own READ call exactly", () => {
    const fn = reservationRpcBody();
    expect(fn).toContain("public._authorize_reservation_roster_access(p_reservation_id, p_expected_club_id, false)");
  });

  it("returns one row per ACTIVE reservation_guest in that reservation", () => {
    const fn = reservationRpcBody();
    expect(fn).toContain("from public.reservation_guests rg");
    expect(fn).toContain("where rg.reservation_id = p_reservation_id");
    expect(fn).toContain("and rg.status          = 'active';");
  });

  it("is SECURITY DEFINER, STABLE, hardened search_path", () => {
    const sigStart = migrationCodeOnly.indexOf(
      "create or replace function public.get_reservation_guest_waiver_compliance("
    );
    const sig = migrationCodeOnly.slice(sigStart, sigStart + 400);
    expect(sig).toContain("security definer");
    expect(sig).toContain("stable");
    expect(sig).toContain("set search_path = public, pg_temp");
  });

  it("is granted to authenticated only — revoked from public/anon", () => {
    expect(migrationCodeOnly).toContain(
      "revoke execute on function public.get_reservation_guest_waiver_compliance(uuid, uuid)\n  from public, anon;\ngrant  execute on function public.get_reservation_guest_waiver_compliance(uuid, uuid)\n  to authenticated;"
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BACKEND — Event RPC
// ═══════════════════════════════════════════════════════════════════════════

describe("get_event_guest_waiver_compliance", () => {
  it("enforces same-club Event access, matching get_event_roster's own lookup", () => {
    const fn = eventRpcBody();
    expect(fn).toContain("from public.events");
    expect(fn).toContain("where id      = p_event_id");
    expect(fn).toContain("and club_id = v_profile.club_id;");
  });

  it("returns one row per ACTIVE event_guest in that Event", () => {
    const fn = eventRpcBody();
    expect(fn).toContain("from public.event_guests eg");
    expect(fn).toContain("where eg.event_id = p_event_id");
    expect(fn).toContain("and eg.status     = 'active';");
  });

  it("is SECURITY DEFINER, STABLE, hardened search_path", () => {
    const sigStart = migrationCodeOnly.indexOf("create or replace function public.get_event_guest_waiver_compliance(");
    const sig = migrationCodeOnly.slice(sigStart, sigStart + 300);
    expect(sig).toContain("security definer");
    expect(sig).toContain("stable");
    expect(sig).toContain("set search_path = public, pg_temp");
  });

  it("is granted to authenticated only — revoked from public/anon", () => {
    expect(migrationCodeOnly).toContain(
      "revoke execute on function public.get_event_guest_waiver_compliance(uuid)\n  from public, anon;\ngrant  execute on function public.get_event_guest_waiver_compliance(uuid)\n  to authenticated;"
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// STATUS DERIVATION — both RPCs
// ═══════════════════════════════════════════════════════════════════════════

describe("status derivation matches the locked semantics, for both RPCs", () => {
  for (const [label, bodyFn, idCol] of [
    ["reservation", reservationRpcBody, "reservation_guest_id"],
    ["event", eventRpcBody, "event_guest_id"],
  ] as const) {
    describe(label, () => {
      it("waiver_configured = true ONLY when a current published version exists (current_version_id is not null) — stricter than 0194's own Member-side 'row exists at all' definition", () => {
        const fn = bodyFn();
        expect(fn).toContain("(w.current_version_id is not null)");
      });

      it("no current version -> not_required", () => {
        const fn = bodyFn();
        expect(fn).toContain("when w.current_version_id is null then 'not_required'");
      });

      it("current version but not required -> not_required (waiver_configured still true)", () => {
        const fn = bodyFn();
        expect(fn).toContain("when w.is_required is false       then 'not_required'");
      });

      it("exact-current-version acceptance -> 'current'", () => {
        const fn = bodyFn();
        expect(fn).toContain("then 'current'");
        expect(fn).toContain(`a.${idCol}`);
        expect(fn).toContain("a.waiver_version_id");
      });

      it("acceptance of an OLDER version of the same waiver (never the exact current one) -> 'outdated'", () => {
        const fn = bodyFn();
        expect(fn).toContain("then 'outdated'");
        expect(fn).toContain("join public.waiver_versions v on v.id = a.waiver_version_id");
        expect(fn).toContain("v.waiver_id");
      });

      it("no acceptance of any version -> 'never_accepted' (the else branch)", () => {
        const fn = bodyFn();
        expect(fn).toContain("else 'never_accepted'");
      });

      it("invitation existence never participates — guest_waiver_invitations is never referenced in this function", () => {
        const fn = bodyFn();
        expect(fn).not.toMatch(/guest_waiver_invitations/);
      });

      it("no bare column reference collides with this function's own RETURNS TABLE OUT parameters (relationship_id/waiver_configured/status) — every reference is alias-qualified", () => {
        const fn = bodyFn();
        const bareCollision = fn.match(/(^|[^.a-zA-Z_])(relationship_id|waiver_configured|status)\s*(=|,|\))/g) ?? [];
        for (const match of bareCollision) {
          expect(match).toMatch(/\b(rg|eg|w|a|v)\.(relationship_id|waiver_configured|status)/);
        }
      });
    });
  }

  it("reservation_guest_id and event_guest_id are never conflated — the reservation RPC only ever references reservation_guest_id, the event RPC only ever event_guest_id", () => {
    expect(reservationRpcBody()).not.toContain("event_guest_id");
    expect(eventRpcBody()).not.toContain("reservation_guest_id");
  });

  it("no N+1 — each RPC issues exactly ONE return query, a single set-based SELECT, never a per-row RPC call or loop", () => {
    for (const fn of [reservationRpcBody(), eventRpcBody()]) {
      const returnQueryCount = (fn.match(/return query/g) ?? []).length;
      expect(returnQueryCount).toBe(1);
      expect(fn).not.toMatch(/for\s+\w+\s+in\s+select/i); // no PL/pgSQL row-by-row loop
    }
  });

  it("no raw bearer token or invitation/token requirement anywhere in either function", () => {
    for (const fn of [reservationRpcBody(), eventRpcBody()]) {
      expect(fn).not.toMatch(/token_hash|rawToken|p_token/i);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// UI — Reservation
// ═══════════════════════════════════════════════════════════════════════════

describe("Reservation Guest — compliance UI wiring", () => {
  it("actions.ts exports a GuestWaiverComplianceRow type and a Server Action calling the new RPC", () => {
    expect(calendarActionsSrc).toContain("export interface GuestWaiverComplianceRow {");
    const fn = extractTsFunctionBody(
      calendarActionsSrc,
      "export async function getReservationGuestWaiverComplianceAction("
    );
    expect(fn).toContain('supabase.rpc("get_reservation_guest_waiver_compliance"');
  });

  it("ReservationRosterSection.tsx loads compliance alongside the roster and merges ONLY by relationship_id", () => {
    expect(reservationRosterSrc).toContain("getReservationGuestWaiverComplianceAction,");
    expect(reservationRosterSrc).toContain(
      "getReservationGuestWaiverComplianceAction(reservationId, clubId).then(({ data }) => {"
    );
    expect(reservationRosterSrc).toContain("row.relationship_id, row");
  });

  it("Accepted / Needs acceptance / Not required mapping, reusing the 43B-5A vocabulary", () => {
    const configStart = reservationRosterSrc.indexOf("GUEST_WAIVER_STATUS_CONFIG");
    const configEnd = reservationRosterSrc.indexOf("};", configStart);
    const config = reservationRosterSrc.slice(configStart, configEnd);
    expect(config).toContain('label: "Accepted"');
    expect(config).toContain('label: "Needs acceptance"');
    expect(config).toContain('label: "Not required"');
    const labels = [...config.matchAll(/label:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(labels)).toEqual(new Set(["Accepted", "Needs acceptance", "Not required"]));
  });

  it("unconfigured Guest waiver (waiver_configured=false) hides the indicator entirely — gate requires compliance.waiver_configured, not just compliance existing", () => {
    expect(reservationRosterSrc).toContain("{compliance && compliance.waiver_configured && (");
  });

  it("never exposes waiver_version_id, 'Version N', acceptance ids, or token/invitation ids in the rendered pill area", () => {
    const pillAreaIdx = reservationRosterSrc.indexOf("{compliance && compliance.waiver_configured && (");
    const pillArea = reservationRosterSrc.slice(pillAreaIdx, pillAreaIdx + 300);
    expect(pillArea).not.toMatch(/waiver_version_id|Version \d|acceptance_id|invitation_id|token/i);
  });

  it("does not widen Reservation roster visibility — merges compliance without any new role/permission branching of its own", () => {
    const loadRosterFn = extractTsFunctionBody(reservationRosterSrc.replace("function loadRoster()", "function loadRoster(): void"), "function loadRoster(): void");
    expect(loadRosterFn).not.toMatch(/role ===|isAdmin\b|isOperator\(/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// UI — Event
// ═══════════════════════════════════════════════════════════════════════════

describe("Event Guest — compliance UI wiring", () => {
  it("admin/events/actions.ts exports a GuestWaiverComplianceRow type (local duplicate, matching this file's own cross-import-avoidance convention) and a Server Action calling the new RPC", () => {
    expect(eventsActionsSrc).toContain("export interface GuestWaiverComplianceRow {");
    const fn = extractTsFunctionBody(eventsActionsSrc, "export async function getEventGuestWaiverComplianceAction(");
    expect(fn).toContain('supabase.rpc("get_event_guest_waiver_compliance"');
  });

  it("EventRosterSheet.tsx loads compliance alongside the roster and merges ONLY by relationship_id (event_guests.id, i.e. rowKey)", () => {
    expect(eventRosterSheetSrc).toContain("getEventGuestWaiverComplianceAction,");
    expect(eventRosterSheetSrc).toContain(
      "getEventGuestWaiverComplianceAction(eventId, clubId).then(({ data }) => {"
    );
    expect(eventRosterSheetSrc).toContain("row.relationship_id, row");
  });

  it("compliance is merged/rendered ONLY on the true (anonymous) Guest rows — never attached to roster-linked 'No Account Yet' rows", () => {
    const mergeCount = (eventRosterSheetSrc.match(/const compliance = guestCompliance\.get\(key\);/g) ?? []).length;
    expect(mergeCount).toBe(1);
    const renderCount = (eventRosterSheetSrc.match(/\{compliance && compliance\.waiver_configured && \(/g) ?? []).length;
    expect(renderCount).toBe(1);
    // Both occur only within the anonGuests render block, after its own
    // map() call — never inside the earlier rosterGuests block.
    const anonGuestsMapIdx = eventRosterSheetSrc.indexOf("{anonGuests.map(row => {");
    const mergeIdx = eventRosterSheetSrc.indexOf("const compliance = guestCompliance.get(key);");
    expect(mergeIdx).toBeGreaterThan(anonGuestsMapIdx);
  });

  it("Accepted / Needs acceptance / Not required mapping, reusing the 43B-5A vocabulary", () => {
    const configStart = eventRosterSheetSrc.indexOf("GUEST_WAIVER_STATUS_CONFIG");
    const configEnd = eventRosterSheetSrc.indexOf("};", configStart);
    const config = eventRosterSheetSrc.slice(configStart, configEnd);
    const labels = [...config.matchAll(/label:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(labels)).toEqual(new Set(["Accepted", "Needs acceptance", "Not required"]));
  });

  it("unconfigured Guest waiver hides the indicator entirely", () => {
    expect(eventRosterSheetSrc).toContain("{compliance && compliance.waiver_configured && (");
  });

  it("never exposes waiver_version_id, 'Version N', acceptance ids, or token/invitation ids in the rendered pill area", () => {
    const pillAreaIdx = eventRosterSheetSrc.indexOf("{compliance && compliance.waiver_configured && (");
    const pillArea = eventRosterSheetSrc.slice(pillAreaIdx, pillAreaIdx + 300);
    expect(pillArea).not.toMatch(/waiver_version_id|Version \d|acceptance_id|invitation_id|token/i);
  });

  it("does not widen who can VIEW compliance — the fetch is gated by the RPC's own admin/pro-only check, not a new client-side role branch", () => {
    const fn = extractTsFunctionBody(eventsActionsSrc, "export async function getEventGuestWaiverComplianceAction(");
    expect(fn).not.toMatch(/role ===|isAdmin\b|isOperator\(|canAccessOperationsWorkspace\(/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// NO ENFORCEMENT
// ═══════════════════════════════════════════════════════════════════════════

describe("no enforcement — informational only", () => {
  it("no booking/Event-blocking logic references Guest waiver compliance — scoped to the new functions/blocks this checkpoint actually added (the surrounding pre-existing files legitimately contain unrelated 'block'/'booking' text elsewhere, e.g. Stripe checkout blocking)", () => {
    const reservationComplianceFn = extractTsFunctionBody(
      calendarActionsSrc,
      "export async function getReservationGuestWaiverComplianceAction("
    );
    const eventComplianceFn = extractTsFunctionBody(eventsActionsSrc, "export async function getEventGuestWaiverComplianceAction(");
    const reservationLoadRosterStart = reservationRosterSrc.indexOf("function loadRoster() {");
    const reservationLoadRosterBlock = reservationRosterSrc.slice(reservationLoadRosterStart, reservationLoadRosterStart + 800);
    const eventLoadRosterStart = eventRosterSheetSrc.indexOf("function loadRoster() {");
    const eventLoadRosterBlock = eventRosterSheetSrc.slice(eventLoadRosterStart, eventLoadRosterStart + 1200);
    for (const s of [reservationComplianceFn, eventComplianceFn, reservationLoadRosterBlock, eventLoadRosterBlock]) {
      expect(s).not.toMatch(/block.*book|prevent.*book|block.*particip|disable.*guest|auto.*remove.*guest/i);
    }
  });

  it("no email/SMS/notification dispatch references Guest waiver compliance in either new Server Action", () => {
    const reservationFn = extractTsFunctionBody(
      calendarActionsSrc,
      "export async function getReservationGuestWaiverComplianceAction("
    );
    const eventFn = extractTsFunctionBody(eventsActionsSrc, "export async function getEventGuestWaiverComplianceAction(");
    for (const fn of [reservationFn, eventFn]) {
      expect(fn).not.toMatch(/sendEmail|sendSms|dispatch.*[Nn]otification/);
    }
  });

  it("no proxy-acceptance action exists on this surface — no accept_guest_waiver call anywhere in the compliance read paths", () => {
    const reservationFn = extractTsFunctionBody(
      calendarActionsSrc,
      "export async function getReservationGuestWaiverComplianceAction("
    );
    const eventFn = extractTsFunctionBody(eventsActionsSrc, "export async function getEventGuestWaiverComplianceAction(");
    for (const fn of [reservationFn, eventFn]) {
      expect(fn).not.toMatch(/accept_guest_waiver|acceptGuestWaiver/);
    }
  });

  it("does not auto-mint a Guest waiver invitation as a side effect of reading compliance — Copy Waiver Link remains a fully separate action", () => {
    const reservationFn = extractTsFunctionBody(
      calendarActionsSrc,
      "export async function getReservationGuestWaiverComplianceAction("
    );
    const eventFn = extractTsFunctionBody(eventsActionsSrc, "export async function getEventGuestWaiverComplianceAction(");
    for (const fn of [reservationFn, eventFn]) {
      expect(fn).not.toMatch(/mint_reservation_guest_waiver_invitation|mint_event_guest_waiver_invitation/);
    }
  });

  it("the compliance pill renders with no onClick/button/link of its own on either surface", () => {
    for (const [src, marker] of [
      [reservationRosterSrc, "{compliance && compliance.waiver_configured && ("],
      [eventRosterSheetSrc, "{compliance && compliance.waiver_configured && ("],
    ] as const) {
      const idx = src.indexOf(marker);
      const block = src.slice(idx, idx + 300);
      expect(block).not.toMatch(/onClick|<button|<a\s|href=/);
    }
  });

  it("no Guest CRM/contact field (email/phone) is introduced anywhere in the touched files", () => {
    for (const s of [reservationRosterSrc, eventRosterSheetSrc, calendarActionsSrc, eventsActionsSrc]) {
      expect(s).not.toMatch(/guest_email|guest_phone|guest_contacts/i);
    }
  });
});
