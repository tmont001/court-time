import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 45D2 — fixes the P2 Event/Staff authorization inconsistency from
// the Phase 45D audit: public.get_event_guest_waiver_compliance(p_event_id)
// excluded 'staff' from its role check while its two sibling functions
// (get_club_member_waiver_compliance, get_reservation_guest_waiver_
// compliance) and Staff's own established event operational authority
// (migration 0136, predating this function's creation in 0199) both already
// include staff. A narrow consistency correction, not a general Staff
// widening: Admin/Staff/Pro allowed, Member denied — same as before except
// staff is now included.
//
// Also corrects the live function's use of legacy profiles.role/
// profiles.club_id as authorization truth (verified live via
// pg_get_functiondef before writing 0214, not assumed) to the same
// active-membership helpers (current_user_club_id()/current_user_role())
// every other current authorization-sensitive RPC in this schema uses.
//
// Migration 0214 is CREATED but explicitly NOT APPLIED by this checkpoint —
// every assertion below is a source-text check against the migration file,
// not a live database check.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const MIGRATION_PATH = "supabase/migrations/0214_event_guest_waiver_staff_authorization.sql";
const ADMIN_EVENTS_ACTIONS_PATH = "src/app/(app)/admin/events/actions.ts";
const EVENT_ROSTER_SHEET_PATH = "src/app/(app)/calendar/EventRosterSheet.tsx";

function readMigration(): string {
  return readSource(MIGRATION_PATH);
}

function functionBody(): string {
  const s = readMigration();
  const start = s.indexOf("create or replace function public.get_event_guest_waiver_compliance(");
  const end = s.indexOf("alter function public.get_event_guest_waiver_compliance", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return s.slice(start, end);
}

// ─────────────────────────────────────────────────────────────────────────
// 1-4. Signature/return shape/security contract preserved.
// ─────────────────────────────────────────────────────────────────────────

describe("0214 — signature, return shape, and security contract preserved", () => {
  it("signature unchanged: (p_event_id uuid)", () => {
    const block = functionBody();
    expect(block).toContain("create or replace function public.get_event_guest_waiver_compliance(\n  p_event_id uuid\n)");
  });

  it("RETURNS TABLE shape unchanged: (relationship_id uuid, waiver_configured boolean, status text)", () => {
    const block = functionBody();
    expect(block).toContain("returns table(relationship_id uuid, waiver_configured boolean, status text)");
  });

  it("STABLE and SECURITY DEFINER preserved", () => {
    const block = functionBody();
    expect(block).toContain("stable");
    expect(block).toContain("security definer");
  });

  it("search_path remains pinned to public, pg_temp", () => {
    const block = functionBody();
    expect(block).toContain("set search_path = public, pg_temp");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 5. ACL explicitly restored/normalized.
// ─────────────────────────────────────────────────────────────────────────

describe("0214 — ACL explicitly restored to the current live intended ACL (verified before writing this migration)", () => {
  it("owner restated to postgres", () => {
    const s = readMigration();
    expect(s).toContain("alter function public.get_event_guest_waiver_compliance(uuid) owner to postgres;");
  });

  it("EXECUTE explicitly revoked from public and anon", () => {
    const s = readMigration();
    expect(s).toContain("revoke execute on function public.get_event_guest_waiver_compliance(uuid) from public;");
    expect(s).toContain("revoke execute on function public.get_event_guest_waiver_compliance(uuid) from anon;");
  });

  it("EXECUTE granted to authenticated and service_role only — matching the live ACL exactly, no widening", () => {
    const s = readMigration();
    expect(s).toContain("grant  execute on function public.get_event_guest_waiver_compliance(uuid) to authenticated;");
    expect(s).toContain("grant  execute on function public.get_event_guest_waiver_compliance(uuid) to service_role;");
    expect(s).not.toMatch(/grant\s+execute on function public\.get_event_guest_waiver_compliance\([^)]*\) to (public|anon);/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 6-9. Role contract: Admin/Staff/Pro allowed, Member denied.
// ─────────────────────────────────────────────────────────────────────────

describe("0214 — role contract: admin/staff/pro allowed, member denied", () => {
  it("the allowed-role list is exactly ('admin', 'staff', 'pro')", () => {
    const block = functionBody();
    expect(block).toContain("if v_role not in ('admin', 'staff', 'pro') then");
  });

  it("staff is now included — the actual fix (previously admin/pro only)", () => {
    const block = functionBody();
    const idx = block.indexOf("if v_role not in (");
    expect(idx).toBeGreaterThan(-1);
    expect(block.slice(idx, idx + 60)).toContain("'staff'");
  });

  it("pro remains allowed — unchanged from before this migration", () => {
    const block = functionBody();
    const idx = block.indexOf("if v_role not in (");
    expect(block.slice(idx, idx + 60)).toContain("'pro'");
  });

  it("member is not in the allowed-role list — denied, same as before this migration", () => {
    const block = functionBody();
    const idx = block.indexOf("if v_role not in (");
    const line = block.slice(idx, block.indexOf("\n", idx));
    expect(line).not.toContain("'member'");
  });

  it("insufficient_role is still the exact raised exception for a disallowed role", () => {
    const block = functionBody();
    expect(block).toContain("raise exception 'insufficient_role';");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 10-13. Multi-club authorization correction: active-membership helpers,
// not legacy profiles.role/profiles.club_id.
// ─────────────────────────────────────────────────────────────────────────

describe("0214 — caller club/role derive from the active-membership helpers, never legacy profiles.role/profiles.club_id", () => {
  it("caller club derives from public.current_user_club_id()", () => {
    const block = functionBody();
    expect(block).toContain("select public.current_user_club_id(), public.current_user_role()");
  });

  it("caller role derives from public.current_user_role() — same call as the club derivation, guaranteeing both are non-null together", () => {
    const block = functionBody();
    expect(block).toContain("into v_club_id, v_role;");
  });

  it("no valid active club (v_club_id is null) fails closed with not_authenticated, checked BEFORE the role check", () => {
    const block = functionBody();
    const clubCheckIdx = block.indexOf("if v_club_id is null then raise exception 'not_authenticated'; end if;");
    const roleCheckIdx = block.indexOf("if v_role not in (");
    expect(clubCheckIdx).toBeGreaterThan(-1);
    expect(roleCheckIdx).toBeGreaterThan(clubCheckIdx);
  });

  it("profiles.club_id/profiles.role are not used as tenant/role authority anywhere in the function's real SQL (an explanatory comment naming the legacy pattern, to say it's deliberately not used, is fine)", () => {
    const block = functionBody();
    const sqlOnly = block
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    expect(sqlOnly).not.toContain("v_profile");
    expect(sqlOnly).not.toMatch(/from public\.profiles/);
  });

  it("a foreign-club event cannot be resolved — the event lookup is scoped to club_id = v_club_id (the caller's own active-membership club), raising event_not_found otherwise", () => {
    const block = functionBody();
    expect(block).toContain("and club_id = v_club_id;");
    const idx = block.indexOf("select * into v_event");
    const notFoundIdx = block.indexOf("raise exception 'event_not_found';", idx);
    expect(notFoundIdx).toBeGreaterThan(idx);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 14-15. Waiver-compliance calculation and guest filtering unchanged.
// ─────────────────────────────────────────────────────────────────────────

describe("0214 — waiver-compliance calculation and active-guest filtering are byte-for-byte unchanged", () => {
  it("all four status outcomes are preserved: not_required, current, outdated, never_accepted", () => {
    const block = functionBody();
    expect(block).toContain("'not_required'");
    expect(block).toContain("'current'");
    expect(block).toContain("'outdated'");
    expect(block).toContain("'never_accepted'");
  });

  it("only active event_guests remain included — same filter as before", () => {
    const block = functionBody();
    expect(block).toContain("from public.event_guests eg");
    expect(block).toContain("where eg.event_id = p_event_id");
    expect(block).toContain("and eg.status     = 'active';");
  });

  it("the guest_waiver_acceptances current/outdated exists() checks are unchanged", () => {
    const block = functionBody();
    expect(block).toContain("a.waiver_version_id = w.current_version_id");
    expect(block).toContain("and a.event_guest_id    = eg.id");
    expect(block).toContain("join public.waiver_versions v on v.id = a.waiver_version_id");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 16. Application code compatibility — no change required.
// ─────────────────────────────────────────────────────────────────────────

describe("0214 — application call path requires no code change (verified, not assumed)", () => {
  it("getEventGuestWaiverComplianceAction adds no role gate of its own beyond assertActiveClub — the RPC's own role check is the sole authorization, so widening it requires zero action-code change", () => {
    const s = readSource(ADMIN_EVENTS_ACTIONS_PATH);
    const idx = s.indexOf("export async function getEventGuestWaiverComplianceAction(");
    expect(idx).toBeGreaterThan(-1);
    const block = s.slice(idx, s.indexOf("\n}", idx));
    expect(block).toContain("assertActiveClub(expectedClubId)");
    expect(block).toContain('supabase.rpc("get_event_guest_waiver_compliance"');
    expect(block).not.toMatch(/role\s*[=!]==?\s*["']/);
  });

  it("EventRosterSheet.tsx's fetch call is unconditional (not gated behind a role check) — already correct for a Staff viewer once 0214 lands, no UI change required", () => {
    const s = readSource(EVENT_ROSTER_SHEET_PATH);
    const idx = s.indexOf("getEventGuestWaiverComplianceAction(eventId, clubId)");
    expect(idx).toBeGreaterThan(-1);
    const precedingLine = s.slice(Math.max(0, idx - 40), idx);
    expect(precedingLine).not.toMatch(/isAdmin\s*&&/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 17-18. Scope discipline.
// ─────────────────────────────────────────────────────────────────────────

describe("0214 — scope discipline", () => {
  it("touches only public.get_event_guest_waiver_compliance — no other function, table, RLS policy, or grant appears in this migration", () => {
    const s = readMigration();
    const sqlLines = s.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    expect(sqlLines).not.toMatch(/create (or replace )?function public\.(?!get_event_guest_waiver_compliance)/);
    expect(sqlLines).not.toMatch(/\balter table\b/i);
    expect(sqlLines).not.toMatch(/\bcreate policy\b/i);
    expect(sqlLines).not.toMatch(/\bdrop policy\b/i);
  });

  it("0213 remains untouched (byte-for-byte as Phase 45D1 left it)", () => {
    const s213 = readSource("supabase/migrations/0213_user_pref_enabled_authorization_hardening.sql");
    expect(s213).toContain("IMPORTANT CORRECTION");
    expect(s213).toContain("v_target_in_club");
  });

  // A "no migration beyond N was created" hardcoded ceiling previously lived
  // here (first as ===214, then bumped to ===216 when 0215/0216 were added).
  // Removed: that pattern is invalid for a historical checkpoint's
  // regression suite — it cannot prove no LATER, unrelated checkpoint will
  // ever add a migration, and re-bumping the number every time one does is
  // exactly the moving-target maintenance burden this cleanup exists to
  // eliminate. 0214's own content is already fully proven by every other
  // test in this file, and 0213's is proven untouched by the test above;
  // migration-specific claims for later migrations (0215/0216) belong in
  // their own owning test files. See
  // topLevelBackLinkCleanup.regression.test.ts's own note on this same
  // cleanup.

  it("wrapped in begin;/commit; matching repo convention, and explicitly not yet applied", () => {
    const s = readMigration();
    expect(s).toContain("\nbegin;\n");
    expect(s.trim().endsWith("commit;")).toBe(true);
    expect(s).toContain("Do NOT apply until reviewed.");
  });
});
