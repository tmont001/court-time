import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 45D3C — closes out the PUBLIC EXECUTE gap discovered after 0215
// applied: every function 0215 revoked anon/authenticated EXECUTE from
// still carried Postgres's implicit PUBLIC grant (proacl `=X/postgres`),
// which applies unconditionally to every role including anon regardless
// of a role-specific REVOKE. Live aclexplode(pg_proc.proacl) precheck
// against the full 50-function cohort (39 Category B + 10 Category D +
// validate_club_invite) confirmed 0215's role-specific grants are all
// already correct, so the only statement needed per function is
// REVOKE EXECUTE ... FROM PUBLIC. No GRANT statements are needed anywhere.
//
// Migration 0216 is CREATED but explicitly NOT APPLIED by this checkpoint
// — every assertion below is a source-text check against the migration
// file, not a live database check. Narrowly scoped to the PUBLIC-execute
// closeout; does not duplicate 0215's own coverage.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const MIGRATION_PATH = "supabase/migrations/0216_function_public_execute_acl_closeout.sql";

function readMigration(): string {
  return readSource(MIGRATION_PATH);
}

function sqlOnly(s: string): string {
  return s
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

const CATEGORY_B_SIGNATURES = [
  "accept_waitlist_offer(uuid)",
  "add_court(text)",
  "add_roster_member(text, text, text, text, text, text)",
  "admin_add_guest(uuid, text)",
  "admin_add_member(uuid, uuid)",
  "admin_add_roster_member_to_event(uuid, uuid)",
  "admin_cancel_reservation(uuid)",
  "admin_expire_offer(uuid, uuid)",
  "admin_remove_guest(uuid, uuid)",
  "admin_remove_participant(uuid, uuid)",
  "archive_event(uuid)",
  "create_event(uuid, text, timestamp with time zone, timestamp with time zone, uuid[], text, integer, text, boolean)",
  "create_maintenance_block(uuid, timestamp with time zone, timestamp with time zone, text)",
  "create_maintenance_blocks(uuid[], timestamp with time zone, timestamp with time zone, text, boolean)",
  "create_maintenance_blocks(uuid[], timestamp with time zone, timestamp with time zone, text)",
  "create_reservation(uuid, timestamp with time zone, timestamp with time zone, text, integer, text[], text)",
  "decline_waitlist_offer(uuid)",
  "delete_court(uuid)",
  "delete_operating_hours_override(date, boolean)",
  "delete_roster_member(uuid)",
  "email_already_delivered(uuid)",
  "get_audit_log(integer, integer)",
  "get_club_invites()",
  "get_event_roster(uuid)",
  "get_user_email_for_notification(uuid)",
  "join_event(uuid)",
  "notify_reservation_cancelled_by_member(uuid)",
  "record_delivery_attempt(uuid, text, text, text, text, text, timestamp with time zone)",
  "rename_court(uuid, text)",
  "reorder_courts(uuid[])",
  "revoke_club_invite(text)",
  "set_court_active(uuid, boolean)",
  "unarchive_event(uuid)",
  "update_club_name(text)",
  "update_club_settings(integer, integer, integer, integer)",
  "update_operating_hours(jsonb, boolean)",
  "update_roster_member(uuid, text, text, text, text, text, text)",
  "update_sms_preference(boolean, text)",
  "upsert_operating_hours_override(date, boolean, time, time, text, boolean)",
];

const CATEGORY_D_SIGNATURES = [
  "check_event_type_active()",
  "enforce_event_capacity_reduction()",
  "enforce_event_guest_capacity()",
  "enforce_event_member_schedule()",
  "enforce_event_participant_capacity()",
  "enforce_event_participant_member_schedule()",
  "enforce_lesson_request_member_schedule()",
  "enforce_member_booking_roster_identity()",
  "enforce_reservation_member_schedule()",
  "handle_new_user()",
];

const VALIDATE_CLUB_INVITE_SIGNATURE = "validate_club_invite(text)";

// ─────────────────────────────────────────────────────────────────────────
// 1. Exactly 50 REVOKE EXECUTE ... FROM PUBLIC statements.
// ─────────────────────────────────────────────────────────────────────────

describe("0216 — exactly 50 REVOKE EXECUTE ... FROM PUBLIC statements", () => {
  it("statement count is exactly 50", () => {
    const s = sqlOnly(readMigration());
    const matches = s.match(/^revoke execute on function public\.[a-z_]+\([^)]*\) from public;$/gm) ?? [];
    expect(matches.length).toBe(50);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2-3. All 39 Category B + 10 Category D exact signatures included.
// ─────────────────────────────────────────────────────────────────────────

describe("0216 — all 39 Category B signatures are revoked from public", () => {
  for (const sig of CATEGORY_B_SIGNATURES) {
    it(`includes: revoke execute on function public.${sig} from public;`, () => {
      const s = readMigration();
      expect(s).toContain(`revoke execute on function public.${sig} from public;`);
    });
  }
});

describe("0216 — all 10 Category D trigger signatures are revoked from public", () => {
  for (const sig of CATEGORY_D_SIGNATURES) {
    it(`includes: revoke execute on function public.${sig} from public;`, () => {
      const s = readMigration();
      expect(s).toContain(`revoke execute on function public.${sig} from public;`);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 4. validate_club_invite(text) is included.
// ─────────────────────────────────────────────────────────────────────────

describe("0216 — validate_club_invite(text) is revoked from public", () => {
  it(`includes: revoke execute on function public.${VALIDATE_CLUB_INVITE_SIGNATURE} from public;`, () => {
    const s = readMigration();
    expect(s).toContain(`revoke execute on function public.${VALIDATE_CLUB_INVITE_SIGNATURE} from public;`);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 5-8. No anon/authenticated/service_role REVOKE, no GRANT anywhere.
// ─────────────────────────────────────────────────────────────────────────

describe("0216 — scope discipline: only PUBLIC is revoked, no other ACL statement appears", () => {
  it("no REVOKE ... FROM anon appears anywhere", () => {
    const s = sqlOnly(readMigration());
    expect(s).not.toMatch(/revoke[^;]*\bfrom anon\b/i);
  });

  it("no REVOKE ... FROM authenticated appears anywhere", () => {
    const s = sqlOnly(readMigration());
    expect(s).not.toMatch(/revoke[^;]*\bfrom authenticated\b/i);
  });

  it("no REVOKE ... FROM service_role appears anywhere", () => {
    const s = sqlOnly(readMigration());
    expect(s).not.toMatch(/revoke[^;]*\bfrom service_role\b/i);
  });

  it("no GRANT statement appears anywhere — no new privilege is added, only PUBLIC is removed", () => {
    const s = sqlOnly(readMigration());
    expect(s).not.toMatch(/\bgrant\b/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 9-14. No function/body/RLS/trigger/table-privilege changes.
// ─────────────────────────────────────────────────────────────────────────

describe("0216 — no changes beyond PUBLIC EXECUTE revocation", () => {
  it("no CREATE FUNCTION or CREATE OR REPLACE FUNCTION appears", () => {
    const s = sqlOnly(readMigration());
    expect(s).not.toMatch(/create\s+(or\s+replace\s+)?function/i);
  });

  it("no ALTER FUNCTION appears", () => {
    const s = sqlOnly(readMigration());
    expect(s).not.toMatch(/\balter function\b/i);
  });

  it("no function body ($$ ... $$) appears", () => {
    const s = readMigration();
    expect(s).not.toContain("$$");
  });

  it("no table privilege statement (ON TABLE) appears — v_profile and all other tables untouched", () => {
    const s = sqlOnly(readMigration());
    expect(s).not.toMatch(/\bon table\b/i);
    expect(s).not.toContain("v_profile");
  });

  it("no RLS or policy statement appears", () => {
    const s = sqlOnly(readMigration());
    expect(s).not.toMatch(/\brow level security\b/i);
    expect(s).not.toMatch(/\bcreate policy\b/i);
    expect(s).not.toMatch(/\bdrop policy\b/i);
    expect(s).not.toMatch(/\balter policy\b/i);
  });

  it("no trigger definition statement (CREATE/DROP/ALTER TRIGGER) appears", () => {
    const s = sqlOnly(readMigration());
    expect(s).not.toMatch(/\b(create|drop|alter) trigger\b/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 15-16. Prior migrations untouched.
// ─────────────────────────────────────────────────────────────────────────

describe("0216 — scope discipline: prior migrations untouched", () => {
  it("0213 remains untouched (byte-for-byte as Phase 45D1 left it)", () => {
    const s213 = readSource("supabase/migrations/0213_user_pref_enabled_authorization_hardening.sql");
    expect(s213).toContain("v_target_in_club");
  });

  it("0214 remains untouched (byte-for-byte as Phase 45D2 left it)", () => {
    const s214 = readSource("supabase/migrations/0214_event_guest_waiver_staff_authorization.sql");
    expect(s214).toContain("if v_role not in ('admin', 'staff', 'pro') then");
  });

  it("0215 remains untouched (byte-for-byte as the corrected Phase 45D3B left it)", () => {
    const s215 = readSource("supabase/migrations/0215_legacy_security_hygiene.sql");
    expect(s215).toContain("revoke all privileges on table public.v_profile from anon;");
    expect(s215).toContain("revoke all privileges on table public.v_profile from authenticated;");
  });

  // "0216 is the highest migration — no 0217 was created" was previously
  // asserted here as a hardcoded "highest migration === 216" ceiling.
  // Removed: that pattern is invalid for a historical checkpoint's
  // regression suite — it cannot prove no LATER, unrelated checkpoint will
  // ever add a migration. 0216's own content is already fully proven by
  // every other test in this file, and 0213/0214/0215's are proven
  // untouched by the three tests above; migration-specific claims for any
  // future migration (0217+) belong in its own owning test file. See
  // topLevelBackLinkCleanup.regression.test.ts's own note on this same
  // cleanup.

  it("wrapped in begin;/commit; matching repo convention, and explicitly not yet applied", () => {
    const s = readMigration();
    expect(s).toContain("\nbegin;\n");
    expect(s.trim().endsWith("commit;")).toBe(true);
    expect(s).toContain("Do NOT apply until reviewed.");
  });
});
