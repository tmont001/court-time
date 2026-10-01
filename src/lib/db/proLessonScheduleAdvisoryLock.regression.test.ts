import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Phase 45E3B — closes the proven P1 from the Phase 45E3A concurrency
// audit: two different lesson_requests for the SAME Pro, on DIFFERENT
// courts, at overlapping times could both durably commit as confirmed
// lesson reservations, since the court GiST exclusion constraint is keyed
// on court_id (different courts never conflict) and no lock anywhere was
// scoped to the Pro's identity. Adds a new internal advisory-lock helper,
// public._lock_pro_schedule(uuid), called by the complete set of live
// writers that create/mutate a Pro-owned public.reservations row:
// accept_lesson_proposal, admin_create_member_lesson,
// admin_update_member_lesson (only its scheduling_changed/pro_changed
// branch), and admin_reassign_confirmed_lesson_pro — immediately before
// each one's own existing (unmodified) Pro availability check.
// public.propose_lesson_time is deliberately excluded: it never writes to
// public.reservations, so a lock there would only serialize a check, never
// prevent a durable double-booking.
//
// Migration 0219 is CREATED but explicitly NOT APPLIED by this checkpoint
// — every assertion below is a source-text check against the migration
// file, not a live database check.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const MIGRATION_PATH = "supabase/migrations/0219_pro_lesson_schedule_advisory_lock.sql";

function readMigration(): string {
  return readSource(MIGRATION_PATH);
}

function sqlOnly(s: string): string {
  return s
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

function functionBody(fnName: string): string {
  const s = readMigration();
  const start = s.indexOf(`create or replace function public.${fnName}(`);
  expect(start).toBeGreaterThan(-1);
  const end = s.indexOf("\n$function$;", start);
  expect(end).toBeGreaterThan(start);
  return s.slice(start, end);
}

// ─────────────────────────────────────────────────────────────────────────
// 1. Migration filename exists.
// ─────────────────────────────────────────────────────────────────────────

describe("0219 — migration file exists under its exact expected filename", () => {
  it("0219_pro_lesson_schedule_advisory_lock.sql is present in supabase/migrations", () => {
    const files: string[] = readdirSync(join(process.cwd(), "supabase/migrations"));
    expect(files).toContain("0219_pro_lesson_schedule_advisory_lock.sql");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2-7. The new helper: created, correct locking primitive, correct key,
// rejects null, transaction-scoped only, pinned search_path.
// ─────────────────────────────────────────────────────────────────────────

describe("0219 — public._lock_pro_schedule(uuid) is created with the exact required behavior", () => {
  it("is created", () => {
    const s = readMigration();
    expect(s).toContain("create or replace function public._lock_pro_schedule(p_pro_id uuid)");
  });

  it("uses pg_advisory_xact_lock (transaction-scoped)", () => {
    const block = functionBody("_lock_pro_schedule");
    expect(block).toContain("perform pg_advisory_xact_lock(");
  });

  it("does not use pg_advisory_lock or pg_advisory_unlock (session-scoped locking)", () => {
    const block = functionBody("_lock_pro_schedule");
    expect(block).not.toMatch(/\bpg_advisory_lock\b/);
    expect(block).not.toMatch(/\bpg_advisory_unlock\b/);
  });

  it("uses hashtextextended with the 'pro_schedule:' namespace prefix", () => {
    const block = functionBody("_lock_pro_schedule");
    expect(block).toContain("hashtextextended('pro_schedule:' || p_pro_id::text, 0)");
  });

  it("rejects a null target with invalid_pro_schedule_lock_target, before acquiring any lock", () => {
    const block = functionBody("_lock_pro_schedule");
    const nullCheckIdx = block.indexOf("if p_pro_id is null then");
    const raiseIdx = block.indexOf("raise exception 'invalid_pro_schedule_lock_target';");
    const lockIdx = block.indexOf("pg_advisory_xact_lock(");
    expect(nullCheckIdx).toBeGreaterThan(-1);
    expect(raiseIdx).toBeGreaterThan(nullCheckIdx);
    expect(lockIdx).toBeGreaterThan(raiseIdx);
  });

  it("has search_path pinned to public, pg_temp", () => {
    const s = readMigration();
    const idx = s.indexOf("create or replace function public._lock_pro_schedule(");
    const block = s.slice(idx, s.indexOf("as $function$", idx));
    expect(block).toContain("set search_path to 'public', 'pg_temp'");
    expect(block).toContain("security definer");
  });

  it("performs no table reads and no retries — the body is exactly the null-check and the lock call", () => {
    const block = functionBody("_lock_pro_schedule");
    const sqlOnlyBlock = sqlOnly(block);
    expect(sqlOnlyBlock).not.toMatch(/\bselect\b[\s\S]*\bfrom\b/i);
    expect(sqlOnlyBlock).not.toMatch(/\bloop\b/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 8-11. ACL: PUBLIC/anon/authenticated cannot execute; service_role matches
// the evidence-backed convention.
// ─────────────────────────────────────────────────────────────────────────

describe("0219 — _lock_pro_schedule ACL: least-privilege, matching the established internal-helper convention", () => {
  it("owner is set to postgres", () => {
    const s = readMigration();
    expect(s).toContain("alter function public._lock_pro_schedule(uuid) owner to postgres;");
  });

  it("PUBLIC cannot execute", () => {
    const s = readMigration();
    expect(s).toContain("revoke execute on function public._lock_pro_schedule(uuid) from public;");
  });

  it("anon cannot execute", () => {
    const s = readMigration();
    expect(s).toContain("revoke execute on function public._lock_pro_schedule(uuid) from anon;");
  });

  it("authenticated cannot execute", () => {
    const s = readMigration();
    expect(s).toContain("revoke execute on function public._lock_pro_schedule(uuid) from authenticated;");
  });

  it("service_role retains direct EXECUTE, matching every comparable existing internal lock helper's live ACL", () => {
    const s = readMigration();
    expect(s).toContain("grant  execute on function public._lock_pro_schedule(uuid) to service_role;");
  });

  it("no other grantee appears for this function", () => {
    const s = sqlOnly(readMigration());
    const matches = s.match(/(revoke|grant)\s+execute on function public\._lock_pro_schedule\(uuid\)[^;]*;/g) ?? [];
    expect(matches.length).toBe(4);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 12-15. Each writer calls the helper in the exact approved location.
// ─────────────────────────────────────────────────────────────────────────

describe("0219 — accept_lesson_proposal calls the helper immediately before its Pro availability check", () => {
  it("_lock_pro_schedule(v_request.pro_id) precedes _lesson_check_pro_availability", () => {
    const block = functionBody("accept_lesson_proposal");
    const lockIdx = block.indexOf("perform public._lock_pro_schedule(v_request.pro_id);");
    const checkIdx = block.indexOf("perform public._lesson_check_pro_availability(");
    expect(lockIdx).toBeGreaterThan(-1);
    expect(checkIdx).toBeGreaterThan(lockIdx);
  });

  it("the Member availability check still comes after the Pro availability check (Pro -> Member order preserved)", () => {
    const block = functionBody("accept_lesson_proposal");
    const proCheckIdx = block.indexOf("perform public._lesson_check_pro_availability(");
    const memberCheckIdx = block.indexOf("perform public._lesson_check_member_availability(");
    expect(memberCheckIdx).toBeGreaterThan(proCheckIdx);
  });
});

describe("0219 — admin_create_member_lesson calls the helper immediately before its Pro availability check", () => {
  it("_lock_pro_schedule(p_pro_id) precedes _lesson_check_pro_availability", () => {
    const block = functionBody("admin_create_member_lesson");
    const lockIdx = block.indexOf("perform public._lock_pro_schedule(p_pro_id);");
    const checkIdx = block.indexOf("perform public._lesson_check_pro_availability(p_pro_id, p_starts_at, p_ends_at, null);");
    expect(lockIdx).toBeGreaterThan(-1);
    expect(checkIdx).toBeGreaterThan(lockIdx);
  });

  it("Pro -> Member order preserved", () => {
    const block = functionBody("admin_create_member_lesson");
    const proCheckIdx = block.indexOf("_lesson_check_pro_availability(");
    const memberCheckIdx = block.indexOf("_lesson_check_member_availability(");
    expect(memberCheckIdx).toBeGreaterThan(proCheckIdx);
  });
});

describe("0219 — admin_update_member_lesson calls the helper only inside the scheduling_changed/pro_changed branch, before Pro availability", () => {
  it("the helper call sits between the branch's own operating-hours check and its Pro availability check", () => {
    const block = functionBody("admin_update_member_lesson");
    const branchIdx = block.indexOf("if v_scheduling_changed or v_pro_changed then");
    const hoursIdx = block.indexOf("perform public._lesson_check_operating_hours(v_club_id, p_starts_at, p_ends_at, v_tz);", branchIdx);
    const lockIdx = block.indexOf("perform public._lock_pro_schedule(p_pro_id);", branchIdx);
    const checkIdx = block.indexOf("perform public._lesson_check_pro_availability(p_pro_id, p_starts_at, p_ends_at, p_request_id);", branchIdx);
    expect(branchIdx).toBeGreaterThan(-1);
    expect(hoursIdx).toBeGreaterThan(branchIdx);
    expect(lockIdx).toBeGreaterThan(hoursIdx);
    expect(checkIdx).toBeGreaterThan(lockIdx);
  });

  it("no _lock_pro_schedule call exists anywhere outside that one branch", () => {
    const block = functionBody("admin_update_member_lesson");
    const matches = block.match(/_lock_pro_schedule\(/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("Pro -> Member order preserved within the branch", () => {
    const block = functionBody("admin_update_member_lesson");
    const branchIdx = block.indexOf("if v_scheduling_changed or v_pro_changed then");
    const proCheckIdx = block.indexOf("_lesson_check_pro_availability(", branchIdx);
    const memberCheckIdx = block.indexOf("_lesson_check_member_availability(", branchIdx);
    expect(memberCheckIdx).toBeGreaterThan(proCheckIdx);
  });
});

describe("0219 — admin_reassign_confirmed_lesson_pro calls the helper with p_new_pro_id before the club-aware Pro availability check", () => {
  it("_lock_pro_schedule(p_new_pro_id) precedes _lesson_check_pro_availability_for_club", () => {
    const block = functionBody("admin_reassign_confirmed_lesson_pro");
    const lockIdx = block.indexOf("perform public._lock_pro_schedule(p_new_pro_id);");
    const checkIdx = block.indexOf("perform public._lesson_check_pro_availability_for_club(");
    expect(lockIdx).toBeGreaterThan(-1);
    expect(checkIdx).toBeGreaterThan(lockIdx);
  });

  it("the old pro (v_old_pro_id) is never passed to the lock helper", () => {
    const block = functionBody("admin_reassign_confirmed_lesson_pro");
    expect(block).not.toContain("_lock_pro_schedule(v_old_pro_id)");
  });

  it("no Member availability check exists in this function (a pro swap never touches the member's own schedule)", () => {
    const block = functionBody("admin_reassign_confirmed_lesson_pro");
    expect(block).not.toContain("_lesson_check_member_availability(");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 16-19. Untouched functions.
// ─────────────────────────────────────────────────────────────────────────

describe("0219 — propose_lesson_time, both availability-check helpers, and the Member lock helper are not redefined", () => {
  it("propose_lesson_time is not redefined anywhere in this migration", () => {
    const s = sqlOnly(readMigration());
    expect(s).not.toMatch(/create or replace function public\.propose_lesson_time/);
  });

  it("_lesson_check_pro_availability (non-club variant) is not redefined", () => {
    const s = sqlOnly(readMigration());
    expect(s).not.toMatch(/create or replace function public\._lesson_check_pro_availability\(/);
  });

  it("_lesson_check_pro_availability_for_club is not redefined", () => {
    const s = sqlOnly(readMigration());
    expect(s).not.toMatch(/create or replace function public\._lesson_check_pro_availability_for_club\(/);
  });

  it("the existing Member lock helpers (_lesson_check_member_availability, _assert_roster_member_schedule_available) are not redefined", () => {
    const s = sqlOnly(readMigration());
    expect(s).not.toMatch(/create or replace function public\._lesson_check_member_availability/);
    expect(s).not.toMatch(/create or replace function public\._assert_roster_member_schedule_available/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 20. Four writer signatures/returns/security/search_path preserved.
// ─────────────────────────────────────────────────────────────────────────

describe("0219 — all four redefined writers preserve their exact signature, return type, security, and search_path", () => {
  const writers: Array<{ name: string; signature: string; returns: string }> = [
    { name: "accept_lesson_proposal", signature: "create or replace function public.accept_lesson_proposal(p_request_id uuid)", returns: "jsonb" },
    {
      name: "admin_create_member_lesson",
      signature:
        "create or replace function public.admin_create_member_lesson(p_expected_club_id uuid, p_roster_member_id uuid, p_pro_id uuid, p_court_id uuid, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone, p_lesson_type_id uuid DEFAULT NULL::uuid, p_member_note text DEFAULT NULL::text)",
      returns: "lesson_requests",
    },
    {
      name: "admin_update_member_lesson",
      signature:
        "create or replace function public.admin_update_member_lesson(p_request_id uuid, p_expected_club_id uuid, p_expected_updated_at timestamp with time zone, p_roster_member_id uuid, p_pro_id uuid, p_court_id uuid, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone, p_lesson_type_id uuid DEFAULT NULL::uuid, p_member_note text DEFAULT NULL::text)",
      returns: "lesson_requests",
    },
    {
      name: "admin_reassign_confirmed_lesson_pro",
      signature:
        "create or replace function public.admin_reassign_confirmed_lesson_pro(p_request_id uuid, p_expected_updated_at timestamp with time zone, p_new_pro_id uuid)",
      returns: "lesson_requests",
    },
  ];

  for (const w of writers) {
    it(`${w.name}: exact signature preserved`, () => {
      const s = readMigration();
      expect(s).toContain(w.signature);
    });

    it(`${w.name}: returns ${w.returns}, SECURITY DEFINER, search_path pinned`, () => {
      const s = readMigration();
      const idx = s.indexOf(w.signature);
      const block = s.slice(idx, s.indexOf("as $function$", idx));
      expect(block).toContain(`RETURNS ${w.returns}`);
      expect(block).toContain("SECURITY DEFINER");
      expect(block).toContain("SET search_path TO 'public', 'pg_temp'");
    });
  }

  it("no GRANT/REVOKE statement appears for any of the four writers — CREATE OR REPLACE preserves their existing ACLs automatically since signatures/return types are unchanged", () => {
    const s = sqlOnly(readMigration());
    for (const w of ["accept_lesson_proposal", "admin_create_member_lesson", "admin_update_member_lesson", "admin_reassign_confirmed_lesson_pro"]) {
      expect(s).not.toMatch(new RegExp(`(grant|revoke)[^;]*\\bon function public\\.${w}\\(`));
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 21-22. No table/schema/RLS/index changes; no pricing/payment semantic changes.
// ─────────────────────────────────────────────────────────────────────────

describe("0219 — scope discipline: no table/schema/RLS/index changes, no pricing/payment semantic changes", () => {
  it("no ALTER TABLE, CREATE POLICY, DROP POLICY, ALTER POLICY, or CREATE INDEX appears", () => {
    const s = sqlOnly(readMigration());
    expect(s).not.toMatch(/\balter table\b/i);
    expect(s).not.toMatch(/\bcreate policy\b/i);
    expect(s).not.toMatch(/\bdrop policy\b/i);
    expect(s).not.toMatch(/\balter policy\b/i);
    expect(s).not.toMatch(/\bcreate index\b/i);
    expect(s).not.toMatch(/\brow level security\b/i);
  });

  it("pricing computation statements in admin_create_member_lesson/admin_update_member_lesson are byte-for-byte unchanged", () => {
    const createBlock = functionBody("admin_create_member_lesson");
    const updateBlock = functionBody("admin_update_member_lesson");
    expect(createBlock).toContain("v_price_amount_cents := round(v_unit_price_amount_cents * v_duration_minutes / 60.0)::integer;");
    expect(updateBlock).toContain("v_price_amount_cents := round(v_unit_price_amount_cents * v_duration_minutes / 60.0)::integer;");
  });

  it("payment obligation / checkout invalidation calls remain present and unchanged", () => {
    const acceptBlock = functionBody("accept_lesson_proposal");
    const updateBlock = functionBody("admin_update_member_lesson");
    expect(acceptBlock).toContain("perform public._create_payment_obligation(");
    expect(updateBlock).toContain("perform public._invalidate_or_flag_open_checkout_attempt(v_payment_id_for_checkout_guard);");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 23. No future-migration ceiling assertion.
// 24. 0217/0218 untouched.
// ─────────────────────────────────────────────────────────────────────────
// Deliberately no "0220 does not exist" check here — see the Phase 45D
// cleanup and its 45E1/45E2 follow-ups for why that pattern is invalid for
// a historical checkpoint's regression suite.

describe("0219 — 0217/0218 remain untouched", () => {
  it("0217 still contains its guarded terminal UPDATE statements for accept/decline waitlist offer", () => {
    const s217 = readSource("supabase/migrations/0217_waitlist_offer_terminal_status_guard.sql");
    expect(s217).toContain("and status = 'offered'");
    expect(s217).toContain("raise exception 'offer_no_longer_available';");
  });

  it("0218 still contains its single authenticated revoke on admin_cancel_reservation v1", () => {
    const s218 = readSource("supabase/migrations/0218_admin_cancel_reservation_v1_retirement.sql");
    expect(s218).toContain("revoke execute\non function public.admin_cancel_reservation(uuid)\nfrom authenticated;");
  });
});

describe("0219 — migration convention", () => {
  it("wrapped in begin;/commit; matching repo convention, and explicitly not yet applied", () => {
    const s = readMigration();
    expect(s).toContain("\nbegin;\n");
    expect(s.trim().endsWith("commit;")).toBe(true);
    expect(s).toContain("Do NOT apply until reviewed.");
  });
});
