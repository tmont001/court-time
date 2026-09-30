import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 45D3B — mechanical hygiene remediation for the 51-function set the
// Phase 45D3A read-only audit identified from LIVE pg_proc/pg_namespace
// metadata: 27 SECURITY DEFINER functions missing an explicit search_path,
// and 50 with `anon` EXECUTE (49 corrected + validate_club_invite, which
// intentionally keeps it), plus a full privilege lock-down for the dormant
// public.v_profile table. No function body is touched anywhere in this
// migration, and v_profile's schema/rows/RLS are untouched — every
// statement is `ALTER FUNCTION ... SET search_path`, `REVOKE EXECUTE`, or
// `REVOKE ALL PRIVILEGES ON TABLE public.v_profile`, nothing else.
//
// v_profile ACL provenance (verified live via pg_class.relacl and
// pg_attribute.attacl before writing 0215, not assumed): anon/authenticated
// hold FULL relation-level privileges (not merely SELECT/INSERT/UPDATE/
// REFERENCES), and every column's attacl is NULL — zero column-level ACLs
// exist. Migration review caught that the first draft's narrower
// SELECT/INSERT/UPDATE/REFERENCES-only revoke would have left DELETE/
// TRUNCATE/TRIGGER/MAINTAIN behind; corrected to a plain relation-level
// `REVOKE ALL PRIVILEGES ON TABLE ... FROM <role>` per role, which is both
// sufficient (no column ACLs to separately revoke) and complete (covers
// every privilege type the relation-level grant actually holds).
//
// Migration 0215 is CREATED but explicitly NOT APPLIED by this checkpoint —
// every assertion below is a source-text check against the migration file,
// not a live database check.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const MIGRATION_PATH = "supabase/migrations/0215_legacy_security_hygiene.sql";

function readMigration(): string {
  return readSource(MIGRATION_PATH);
}

function sqlOnly(s: string): string {
  return s.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
}

const SEARCH_PATH_SIGNATURES = [
  "public.add_court(text)",
  "public.admin_cancel_reservation(uuid)",
  "public.admin_expire_offer(uuid, uuid)",
  "public.archive_event(uuid)",
  "public.create_event(uuid, text, timestamp with time zone, timestamp with time zone, uuid[], text, integer, text, boolean)",
  "public.create_maintenance_block(uuid, timestamp with time zone, timestamp with time zone, text)",
  "public.create_maintenance_blocks(uuid[], timestamp with time zone, timestamp with time zone, text, boolean)",
  "public.create_maintenance_blocks(uuid[], timestamp with time zone, timestamp with time zone, text)",
  "public.delete_court(uuid)",
  "public.delete_operating_hours_override(date, boolean)",
  "public.delete_roster_member(uuid)",
  "public.email_already_delivered(uuid)",
  "public.get_audit_log(integer, integer)",
  "public.get_user_email_for_notification(uuid)",
  "public.notify_reservation_cancelled_by_member(uuid)",
  "public.record_delivery_attempt(uuid, text, text, text, text, text, timestamp with time zone)",
  "public.rename_court(uuid, text)",
  "public.reorder_courts(uuid[])",
  "public.set_court_active(uuid, boolean)",
  "public.set_member_notes(uuid, text)",
  "public.unarchive_event(uuid)",
  "public.update_club_name(text)",
  "public.update_club_settings(integer, integer, integer, integer)",
  "public.update_operating_hours(jsonb, boolean)",
  "public.update_sms_preference(boolean, text)",
  "public.upsert_operating_hours_override(date, boolean, time, time, text, boolean)",
  "public.validate_club_invite(text)",
];

const CATEGORY_B_ANON_REVOKE_SIGNATURES = [
  "public.accept_waitlist_offer(uuid)",
  "public.add_court(text)",
  "public.add_roster_member(text, text, text, text, text, text)",
  "public.admin_add_guest(uuid, text)",
  "public.admin_add_member(uuid, uuid)",
  "public.admin_add_roster_member_to_event(uuid, uuid)",
  "public.admin_cancel_reservation(uuid)",
  "public.admin_expire_offer(uuid, uuid)",
  "public.admin_remove_guest(uuid, uuid)",
  "public.admin_remove_participant(uuid, uuid)",
  "public.archive_event(uuid)",
  "public.create_event(uuid, text, timestamp with time zone, timestamp with time zone, uuid[], text, integer, text, boolean)",
  "public.create_maintenance_block(uuid, timestamp with time zone, timestamp with time zone, text)",
  "public.create_maintenance_blocks(uuid[], timestamp with time zone, timestamp with time zone, text, boolean)",
  "public.create_maintenance_blocks(uuid[], timestamp with time zone, timestamp with time zone, text)",
  "public.create_reservation(uuid, timestamp with time zone, timestamp with time zone, text, integer, text[], text)",
  "public.decline_waitlist_offer(uuid)",
  "public.delete_court(uuid)",
  "public.delete_operating_hours_override(date, boolean)",
  "public.delete_roster_member(uuid)",
  "public.email_already_delivered(uuid)",
  "public.get_audit_log(integer, integer)",
  "public.get_club_invites()",
  "public.get_event_roster(uuid)",
  "public.get_user_email_for_notification(uuid)",
  "public.join_event(uuid)",
  "public.notify_reservation_cancelled_by_member(uuid)",
  "public.record_delivery_attempt(uuid, text, text, text, text, text, timestamp with time zone)",
  "public.rename_court(uuid, text)",
  "public.reorder_courts(uuid[])",
  "public.revoke_club_invite(text)",
  "public.set_court_active(uuid, boolean)",
  "public.unarchive_event(uuid)",
  "public.update_club_name(text)",
  "public.update_club_settings(integer, integer, integer, integer)",
  "public.update_operating_hours(jsonb, boolean)",
  "public.update_roster_member(uuid, text, text, text, text, text, text)",
  "public.update_sms_preference(boolean, text)",
  "public.upsert_operating_hours_override(date, boolean, time, time, text, boolean)",
];

const TRIGGER_SIGNATURES = [
  "public.check_event_type_active()",
  "public.enforce_event_capacity_reduction()",
  "public.enforce_event_guest_capacity()",
  "public.enforce_event_member_schedule()",
  "public.enforce_event_participant_capacity()",
  "public.enforce_event_participant_member_schedule()",
  "public.enforce_lesson_request_member_schedule()",
  "public.enforce_member_booking_roster_identity()",
  "public.enforce_reservation_member_schedule()",
  "public.handle_new_user()",
];

// ─────────────────────────────────────────────────────────────────────────
// 1-3. search_path hardening — exactly 27 signatures, both
// create_maintenance_blocks overloads, validate_club_invite included.
// ─────────────────────────────────────────────────────────────────────────

describe("0215 — search_path hardening: exactly the 27 approved signatures", () => {
  it("exactly 27 ALTER FUNCTION ... SET search_path statements exist", () => {
    const sql = sqlOnly(readMigration());
    const matches = sql.match(/^alter function .+ set search_path = public, pg_temp;$/gm) ?? [];
    expect(matches.length).toBe(27);
  });

  for (const sig of SEARCH_PATH_SIGNATURES) {
    it(`pins search_path for ${sig}`, () => {
      const s = readMigration();
      expect(s).toContain(`alter function ${sig} set search_path = public, pg_temp;`);
    });
  }

  it("both create_maintenance_blocks overloads (4-arg and 5-arg) are included", () => {
    const s = readMigration();
    expect(s).toContain("alter function public.create_maintenance_blocks(uuid[], timestamp with time zone, timestamp with time zone, text, boolean) set search_path = public, pg_temp;");
    expect(s).toContain("alter function public.create_maintenance_blocks(uuid[], timestamp with time zone, timestamp with time zone, text) set search_path = public, pg_temp;");
  });

  it("validate_club_invite gets search_path pinned", () => {
    const s = readMigration();
    expect(s).toContain("alter function public.validate_club_invite(text) set search_path = public, pg_temp;");
  });

  it("set_member_notes gets search_path pinned", () => {
    const s = readMigration();
    expect(s).toContain("alter function public.set_member_notes(uuid, text) set search_path = public, pg_temp;");
  });

  it("no ALTER FUNCTION statement changes anything other than search_path (no RENAME TO, no OWNER TO, no RETURNS, no cost/rows)", () => {
    const sql = sqlOnly(readMigration());
    const alterLines = sql.match(/^alter function .+;$/gm) ?? [];
    for (const line of alterLines) {
      expect(line).toMatch(/set search_path = public, pg_temp;$/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4-6. validate_club_invite / set_member_notes ACL explicitly preserved.
// ─────────────────────────────────────────────────────────────────────────

describe("0215 — explicit exclusions: validate_club_invite and set_member_notes ACLs are untouched", () => {
  it("validate_club_invite does NOT appear in any REVOKE EXECUTE statement — anon execute is preserved", () => {
    const sql = sqlOnly(readMigration());
    const revokeLines = sql.match(/^revoke execute.+$/gm) ?? [];
    for (const line of revokeLines) {
      expect(line).not.toContain("validate_club_invite");
    }
  });

  it("set_member_notes does NOT appear in any REVOKE or GRANT EXECUTE statement — its service_role-only ACL is untouched", () => {
    const sql = sqlOnly(readMigration());
    const aclLines = sql.match(/^(revoke|grant)\s+execute.+$/gm) ?? [];
    for (const line of aclLines) {
      expect(line).not.toContain("set_member_notes");
    }
  });

  it("no GRANT statement of any kind appears anywhere in this migration — every ACL change is a REVOKE", () => {
    const sql = sqlOnly(readMigration());
    expect(sql).not.toMatch(/^grant\b/im);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 7-9. Category B — anon revoked, authenticated/service_role untouched.
// ─────────────────────────────────────────────────────────────────────────

describe("0215 — Category B: all 39 signatures lose anon EXECUTE, authenticated/service_role are never mentioned", () => {
  it("exactly 39 Category B REVOKE EXECUTE ... FROM anon statements exist", () => {
    const s = readMigration();
    const bStart = s.indexOf("-- B. CATEGORY B");
    const cStart = s.indexOf("-- C. CATEGORY D");
    expect(bStart).toBeGreaterThan(-1);
    expect(cStart).toBeGreaterThan(bStart);
    const bBlock = sqlOnly(s.slice(bStart, cStart));
    const matches = bBlock.match(/^revoke execute on function .+ from anon;$/gm) ?? [];
    expect(matches.length).toBe(39);
  });

  for (const sig of CATEGORY_B_ANON_REVOKE_SIGNATURES) {
    it(`revokes anon EXECUTE for ${sig}`, () => {
      const s = readMigration();
      expect(s).toContain(`revoke execute on function ${sig} from anon;`);
    });
  }

  it("no statement anywhere in this migration revokes authenticated or service_role from any Category B function", () => {
    const s = readMigration();
    const bStart = s.indexOf("-- B. CATEGORY B");
    const cStart = s.indexOf("-- C. CATEGORY D");
    const bBlock = sqlOnly(s.slice(bStart, cStart));
    expect(bBlock).not.toMatch(/from authenticated/);
    expect(bBlock).not.toMatch(/from service_role/);
  });

  it("admin_cancel_reservation and create_maintenance_block (confirmed dead/superseded) lose anon EXECUTE like every other Category B function, but are not otherwise singled out (no extra authenticated revoke, no DROP, no retirement)", () => {
    const s = readMigration();
    expect(s).toContain("revoke execute on function public.admin_cancel_reservation(uuid) from anon;");
    expect(s).toContain("revoke execute on function public.create_maintenance_block(uuid, timestamp with time zone, timestamp with time zone, text) from anon;");
    expect(s).not.toMatch(/drop function.+admin_cancel_reservation/);
    expect(s).not.toMatch(/drop function.+create_maintenance_block\(/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 10-12. Category D — trigger functions lose anon AND authenticated direct
// EXECUTE; trigger definitions themselves untouched.
// ─────────────────────────────────────────────────────────────────────────

describe("0215 — Category D: all 10 trigger functions lose both anon and authenticated direct EXECUTE", () => {
  it("exactly 10 REVOKE EXECUTE ... FROM anon, authenticated statements exist", () => {
    const s = readMigration();
    const cStart = s.indexOf("-- C. CATEGORY D");
    const dStart = s.indexOf("-- D. public.v_profile");
    expect(cStart).toBeGreaterThan(-1);
    expect(dStart).toBeGreaterThan(cStart);
    const cBlock = sqlOnly(s.slice(cStart, dStart));
    const matches = cBlock.match(/^revoke execute on function .+ from anon, authenticated;$/gm) ?? [];
    expect(matches.length).toBe(10);
  });

  for (const sig of TRIGGER_SIGNATURES) {
    it(`revokes anon and authenticated EXECUTE for trigger function ${sig}`, () => {
      const s = readMigration();
      expect(s).toContain(`revoke execute on function ${sig} from anon, authenticated;`);
    });
  }

  it("no CREATE TRIGGER, DROP TRIGGER, ALTER TABLE ... ENABLE/DISABLE TRIGGER, or trigger-definition statement appears anywhere — only EXECUTE ACL is touched", () => {
    const sql = sqlOnly(readMigration());
    expect(sql).not.toMatch(/create trigger/i);
    expect(sql).not.toMatch(/drop trigger/i);
    expect(sql).not.toMatch(/enable trigger/i);
    expect(sql).not.toMatch(/disable trigger/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 13-16. v_profile — not dropped, RLS untouched, FULL relation-level client
// privileges revoked (corrected on migration review — the live precheck
// found anon/authenticated hold ALL relation-level privileges, not just
// SELECT/INSERT/UPDATE/REFERENCES, so a narrower REVOKE would have left
// DELETE/TRUNCATE/TRIGGER/MAINTAIN behind), service_role untouched.
// ─────────────────────────────────────────────────────────────────────────

describe("0215 — public.v_profile: REVOKE ALL PRIVILEGES (relation-level, per the live ACL-provenance precheck), no drop, no RLS change", () => {
  it("v_profile is never dropped", () => {
    const sql = sqlOnly(readMigration());
    expect(sql).not.toMatch(/drop table.+v_profile/i);
  });

  it("v_profile's RLS is not touched — no ALTER TABLE ... (ENABLE|DISABLE|FORCE|NO FORCE) ROW LEVEL SECURITY, no CREATE/DROP POLICY", () => {
    const sql = sqlOnly(readMigration());
    expect(sql).not.toMatch(/row level security/i);
    expect(sql).not.toMatch(/create policy/i);
    expect(sql).not.toMatch(/drop policy/i);
  });

  it("anon receives REVOKE ALL PRIVILEGES ON TABLE public.v_profile — not a narrower SELECT/INSERT/UPDATE/REFERENCES-only revoke", () => {
    const s = readMigration();
    expect(s).toContain("revoke all privileges on table public.v_profile from anon;");
  });

  it("authenticated receives the same REVOKE ALL PRIVILEGES statement", () => {
    const s = readMigration();
    expect(s).toContain("revoke all privileges on table public.v_profile from authenticated;");
  });

  it("no partial SELECT/INSERT/UPDATE/REFERENCES-only revoke remains anywhere for v_profile", () => {
    const s = readMigration();
    expect(s).not.toContain("revoke select, insert, update, references on public.v_profile");
  });

  it("no column-specific REVOKE syntax is present for v_profile — none is needed (the precheck confirmed zero explicit column-level ACL entries exist)", () => {
    const s = readMigration();
    expect(s).not.toMatch(/revoke\s+\w+\s*\([^)]*\)\s+on\s+(table\s+)?public\.v_profile/i);
  });

  it("service_role's v_profile grants are never mentioned or touched — REVOKE ALL PRIVILEGES is scoped to anon and authenticated only, one REVOKE statement per role", () => {
    const s = readMigration();
    expect(s).not.toMatch(/v_profile from service_role/);
    expect(s).not.toMatch(/on (table\s+)?public\.v_profile to /);
    const vProfileRevokes = sqlOnly(s).match(/^revoke all privileges on table public\.v_profile from \w+;$/gm) ?? [];
    expect(vProfileRevokes.length).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 17-19. No function body rewrite, no CREATE OR REPLACE, no RLS policy
// statement anywhere in the whole file.
// ─────────────────────────────────────────────────────────────────────────

describe("0215 — no function body changes, no CREATE OR REPLACE FUNCTION, no RLS policy statements anywhere", () => {
  it("no CREATE FUNCTION or CREATE OR REPLACE FUNCTION statement appears anywhere in this migration", () => {
    const sql = sqlOnly(readMigration());
    expect(sql).not.toMatch(/create\s+(or replace\s+)?function/i);
  });

  it("no PL/pgSQL body delimiter ($$/$function$) appears — confirms no function body is being (re)defined", () => {
    const sql = sqlOnly(readMigration());
    expect(sql).not.toContain("$$");
    expect(sql).not.toContain("$function$");
  });

  it("no CREATE POLICY / DROP POLICY / ALTER POLICY statement appears anywhere", () => {
    const sql = sqlOnly(readMigration());
    expect(sql).not.toMatch(/\b(create|drop|alter)\s+policy\b/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 20-21. 0213/0214 untouched.
// ─────────────────────────────────────────────────────────────────────────

describe("0215 — scope discipline: 0213/0214 untouched", () => {
  it("0213 remains untouched (byte-for-byte as Phase 45D1 left it)", () => {
    const s213 = readSource("supabase/migrations/0213_user_pref_enabled_authorization_hardening.sql");
    expect(s213).toContain("v_target_in_club");
  });

  it("0214 remains untouched (byte-for-byte as Phase 45D2 left it)", () => {
    const s214 = readSource("supabase/migrations/0214_event_guest_waiver_staff_authorization.sql");
    expect(s214).toContain("if v_role not in ('admin', 'staff', 'pro') then");
  });

  // A "no migration beyond N was created" hardcoded ceiling previously lived
  // here (first as ===215, then bumped to ===216 when 0216 was added).
  // Removed: that pattern is invalid for a historical checkpoint's
  // regression suite — it cannot prove no LATER, unrelated checkpoint will
  // ever add a migration, and re-bumping the number every time one does is
  // exactly the moving-target maintenance burden this cleanup exists to
  // eliminate. 0215's own content is already fully proven by every other
  // test in this file, and 0213/0214's are proven untouched by the two
  // tests above; migration-specific claims for later migrations (0216)
  // belong in their own owning test files. See
  // topLevelBackLinkCleanup.regression.test.ts's own note on this same
  // cleanup.

  it("wrapped in begin;/commit; matching repo convention, and explicitly not yet applied", () => {
    const s = readMigration();
    expect(s).toContain("\nbegin;\n");
    expect(s.trim().endsWith("commit;")).toBe(true);
    expect(s).toContain("Do NOT apply until reviewed.");
  });
});
