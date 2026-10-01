import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Phase 45E4 — closes the proven P2 from the Phase 45E4 concurrency audit:
// public._authorize_reservation_roster_access(uuid, uuid, boolean) read the
// target reservation with a plain, unlocked SELECT. A concurrent admin/
// staff host reassignment (update_member_reservation, which holds
// reservations FOR UPDATE for its whole transaction) could commit a new
// roster_member_id while this unlocked read still returned the stale one.
// The sole exploitable consumer is add_reservation_participant's host-
// exemption branch, which uses this read's roster_member_id to decide
// whether to skip the LFP scope/search-row lock and capacity check.
//
// An exhaustive, database-wide supplemental lock-order audit (querying
// every live function for a reservations lock and/or an LFP-domain lock)
// confirmed public.update_member_reservation is the ONLY function that
// ever acquires reservations FOR UPDATE, and every function that touches
// both a reservations lock and the LFP lock graph does so with the
// reservation lock always FOR SHARE — so no opposite-order deadlock cycle
// exists before or after this change.
//
// The fix: append `for share` to the one SELECT in
// _authorize_reservation_roster_access. No other statement, no caller, no
// ACL change.
//
// Migration 0220 is CREATED but explicitly NOT APPLIED by this checkpoint
// — every assertion below is a source-text check against the migration
// file, not a live database check.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const MIGRATION_PATH = "supabase/migrations/0220_reservation_roster_access_share_lock.sql";

function readMigration(): string {
  return readSource(MIGRATION_PATH);
}

function sqlOnly(s: string): string {
  return s
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

function functionBody(): string {
  const s = readMigration();
  const start = s.indexOf("create or replace function public._authorize_reservation_roster_access(");
  expect(start).toBeGreaterThan(-1);
  const end = s.indexOf("\n$function$;", start);
  expect(end).toBeGreaterThan(start);
  return s.slice(start, end);
}

// ─────────────────────────────────────────────────────────────────────────
// 1. Migration filename exists.
// ─────────────────────────────────────────────────────────────────────────

describe("0220 — migration file exists under its exact expected filename", () => {
  it("0220_reservation_roster_access_share_lock.sql is present in supabase/migrations", () => {
    const files: string[] = readdirSync(join(process.cwd(), "supabase/migrations"));
    expect(files).toContain("0220_reservation_roster_access_share_lock.sql");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. _authorize_reservation_roster_access now uses FOR SHARE.
// ─────────────────────────────────────────────────────────────────────────

describe("0220 — _authorize_reservation_roster_access acquires FOR SHARE on its reservation read", () => {
  it("redefines exactly this one function", () => {
    const s = sqlOnly(readMigration());
    const matches = s.match(/create or replace function public\.(\w+)\(/g) ?? [];
    expect(matches.length).toBe(1);
    expect(matches[0]).toBe("create or replace function public._authorize_reservation_roster_access(");
  });

  it("the SELECT ends in 'for share;'", () => {
    const block = functionBody();
    const selectIdx = block.indexOf("select * into v_reservation");
    const forShareIdx = block.indexOf("for share;", selectIdx);
    expect(selectIdx).toBeGreaterThan(-1);
    expect(forShareIdx).toBeGreaterThan(selectIdx);
  });

  it("no 'for update' appears in this function's real SQL — FOR SHARE only (an explanatory comment naming update_member_reservation's own FOR UPDATE, for contrast, is fine)", () => {
    const block = sqlOnly(functionBody());
    expect(block).not.toMatch(/for update/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Authorization predicates and exception behavior remain intact.
// ─────────────────────────────────────────────────────────────────────────

describe("0220 — authorization predicates and exception vocabulary are byte-for-byte unchanged", () => {
  it("not_authenticated / stale_club_context / insufficient_role / capability_not_available guards are unchanged", () => {
    const block = functionBody();
    expect(block).toContain("raise exception 'not_authenticated';");
    expect(block).toContain("raise exception 'stale_club_context'; end if;");
    expect(block).toContain("raise exception 'insufficient_role';");
    expect(block).toContain("raise exception 'capability_not_available';");
  });

  it("the ownership/role predicate (admin/staff, owner match, or roster match) is unchanged", () => {
    const block = functionBody();
    expect(block).toContain("v_role in ('admin', 'staff')");
    expect(block).toContain("or owner_user_id = auth.uid()");
    expect(block).toContain("or (v_roster_member_id is not null and roster_member_id = v_roster_member_id)");
  });

  it("reservation_not_found / reservation_not_participant_eligible / reservation_roster_locked outcomes are unchanged", () => {
    const block = functionBody();
    expect(block).toContain("if not found then raise exception 'reservation_not_found'; end if;");
    expect(block).toContain("raise exception 'reservation_not_participant_eligible';");
    expect(block).toContain("raise exception 'reservation_roster_locked';");
  });

  it("returns the full reservation row, matching the original return shape", () => {
    const block = functionBody();
    expect(block).toContain("return v_reservation;");
    expect(block).toContain("RETURNS reservations");
  });

  it("SECURITY DEFINER and search_path are preserved", () => {
    const block = functionBody();
    expect(block).toContain("SECURITY DEFINER");
    expect(block).toContain("SET search_path TO 'public', 'pg_temp'");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. No caller is redefined by 0220.
// ─────────────────────────────────────────────────────────────────────────

describe("0220 — no caller of _authorize_reservation_roster_access is redefined", () => {
  const callers = [
    "add_reservation_participant",
    "remove_reservation_participant",
    "add_reservation_guest",
    "remove_reservation_guest",
    "set_reservation_player_search",
    "clear_reservation_player_search",
    "mint_reservation_guest_waiver_invitation",
    "get_reservation_guest_waiver_compliance",
    "get_reservation_player_search",
    "get_reservation_roster",
    "get_reservation_eligible_roster_members",
  ];

  for (const fn of callers) {
    it(`${fn} is not redefined`, () => {
      const s = sqlOnly(readMigration());
      expect(s).not.toMatch(new RegExp(`create or replace function public\\.${fn}\\(`));
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 5. _lock_and_validate_reservation_roster_mutable remains untouched.
// ─────────────────────────────────────────────────────────────────────────

describe("0220 — _lock_and_validate_reservation_roster_mutable and other LFP lock helpers are untouched", () => {
  it("_lock_and_validate_reservation_roster_mutable is not redefined", () => {
    const s = sqlOnly(readMigration());
    expect(s).not.toMatch(/create or replace function public\._lock_and_validate_reservation_roster_mutable/);
  });

  it("the scope/row lock helpers are not redefined", () => {
    const s = sqlOnly(readMigration());
    expect(s).not.toMatch(/create or replace function public\._lock_reservation_player_search_scope/);
    expect(s).not.toMatch(/create or replace function public\._lock_reservation_player_search_row/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 6. Migration scope is exactly the intended helper — no ACL/table/RLS change.
// ─────────────────────────────────────────────────────────────────────────

describe("0220 — scope discipline: exactly the one helper, no ACL/table/RLS/index changes", () => {
  it("no GRANT/REVOKE statement appears — CREATE OR REPLACE preserves the existing ACL automatically since the signature/return type are unchanged", () => {
    const s = sqlOnly(readMigration());
    expect(s).not.toMatch(/\bgrant\b/i);
    expect(s).not.toMatch(/\brevoke\b/i);
  });

  it("no ALTER FUNCTION, DROP FUNCTION, ALTER TABLE, CREATE POLICY, or CREATE INDEX appears", () => {
    const s = sqlOnly(readMigration());
    expect(s).not.toMatch(/\balter function\b/i);
    expect(s).not.toMatch(/\bdrop function\b/i);
    expect(s).not.toMatch(/\balter table\b/i);
    expect(s).not.toMatch(/\bcreate policy\b/i);
    expect(s).not.toMatch(/\bcreate index\b/i);
    expect(s).not.toMatch(/\brow level security\b/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 0217/0218/0219 untouched; migration convention.
// ─────────────────────────────────────────────────────────────────────────

describe("0220 — 0217/0218/0219 remain untouched", () => {
  it("0217 still contains its guarded terminal UPDATE statements", () => {
    const s217 = readSource("supabase/migrations/0217_waitlist_offer_terminal_status_guard.sql");
    expect(s217).toContain("and status = 'offered'");
  });

  it("0218 still contains its single authenticated revoke on admin_cancel_reservation v1", () => {
    const s218 = readSource("supabase/migrations/0218_admin_cancel_reservation_v1_retirement.sql");
    expect(s218).toContain("revoke execute\non function public.admin_cancel_reservation(uuid)\nfrom authenticated;");
  });

  it("0219 still contains _lock_pro_schedule and its four writer call sites", () => {
    const s219 = readSource("supabase/migrations/0219_pro_lesson_schedule_advisory_lock.sql");
    expect(s219).toContain("create or replace function public._lock_pro_schedule(p_pro_id uuid)");
    const matches = s219.match(/_lock_pro_schedule\(/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(5);
  });
});

describe("0220 — migration convention", () => {
  it("wrapped in begin;/commit; matching repo convention, and explicitly not yet applied", () => {
    const s = readMigration();
    expect(s).toContain("\nbegin;\n");
    expect(s.trim().endsWith("commit;")).toBe(true);
    expect(s).toContain("Do NOT apply until reviewed.");
  });
});
