import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Phase 45E2 — ACL-only retirement of the obsolete v1 Admin cancellation
// RPC (public.admin_cancel_reservation(uuid)) from normal authenticated
// application callers. The Phase 45E audit found it lacks the payment-row
// locking, Stripe Checkout-invalidation guard, uncollected-balance
// release, and refund-request workflow that
// public.admin_cancel_reservation_v2(uuid) has, yet remained
// EXECUTE-granted to `authenticated` — its full retirement was explicitly
// out of scope for the Phase 45D3B hygiene pass (0215), which only
// revoked its `anon` grant. This migration closes that gap: a single
// REVOKE EXECUTE ... FROM authenticated, nothing else.
//
// Migration 0218 is CREATED but explicitly NOT APPLIED by this checkpoint
// — every assertion below is a source-text check against the migration
// file, not a live database check.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const MIGRATION_PATH = "supabase/migrations/0218_admin_cancel_reservation_v1_retirement.sql";

function readMigration(): string {
  return readSource(MIGRATION_PATH);
}

function sqlOnly(s: string): string {
  return s
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

// ─────────────────────────────────────────────────────────────────────────
// 1. Exact migration filename exists.
// ─────────────────────────────────────────────────────────────────────────

describe("0218 — migration file exists under its exact expected filename", () => {
  it("0218_admin_cancel_reservation_v1_retirement.sql is present in supabase/migrations", () => {
    const files: string[] = readdirSync(join(process.cwd(), "supabase/migrations"));
    expect(files).toContain("0218_admin_cancel_reservation_v1_retirement.sql");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2-5. Exactly one REVOKE, exact target, exact grantee.
// ─────────────────────────────────────────────────────────────────────────

describe("0218 — exactly one REVOKE statement, targeting exactly admin_cancel_reservation(uuid) from authenticated", () => {
  it("contains exactly one REVOKE statement", () => {
    const s = sqlOnly(readMigration());
    const matches = s.match(/\brevoke\b/gi) ?? [];
    expect(matches.length).toBe(1);
  });

  it("the REVOKE targets exactly public.admin_cancel_reservation(uuid)", () => {
    const s = readMigration();
    expect(s).toContain("revoke execute\non function public.admin_cancel_reservation(uuid)");
  });

  it("does not target admin_cancel_reservation_v2 anywhere in the REVOKE statement", () => {
    const block = readMigration();
    const idx = block.indexOf("revoke execute");
    const stmt = block.slice(idx, block.indexOf(";", idx) + 1);
    expect(stmt).not.toContain("admin_cancel_reservation_v2");
  });

  it("the grantee is exactly authenticated", () => {
    const s = readMigration();
    expect(s).toContain("from authenticated;");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 6-7. No revoke from service_role; no revoke from anon needed/present.
// ─────────────────────────────────────────────────────────────────────────

describe("0218 — service_role and anon are not touched", () => {
  it("no revoke from service_role appears", () => {
    const s = sqlOnly(readMigration());
    expect(s).not.toMatch(/revoke[^;]*\bfrom service_role\b/i);
  });

  it("no revoke from anon appears — anon already has no EXECUTE on v1 (revoked by 0215)", () => {
    const s = sqlOnly(readMigration());
    expect(s).not.toMatch(/revoke[^;]*\bfrom anon\b/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 8. No PUBLIC grant/revoke changes.
// ─────────────────────────────────────────────────────────────────────────

describe("0218 — no PUBLIC grant/revoke changes", () => {
  it("no statement targeting PUBLIC appears — PUBLIC already has no EXECUTE on v1 (revoked by 0216)", () => {
    const s = sqlOnly(readMigration());
    expect(s).not.toMatch(/\bfrom public\b/i);
    expect(s).not.toMatch(/\bto public\b/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 9-11. No GRANT, no CREATE OR REPLACE FUNCTION, no ALTER FUNCTION, no DROP FUNCTION.
// ─────────────────────────────────────────────────────────────────────────

describe("0218 — ACL-only: no body, ownership, or definition changes of any kind", () => {
  it("no GRANT statement appears", () => {
    const s = sqlOnly(readMigration());
    expect(s).not.toMatch(/\bgrant\b/i);
  });

  it("no CREATE FUNCTION or CREATE OR REPLACE FUNCTION appears", () => {
    const s = sqlOnly(readMigration());
    expect(s).not.toMatch(/create\s+(or\s+replace\s+)?function/i);
  });

  it("no ALTER FUNCTION appears", () => {
    const s = sqlOnly(readMigration());
    expect(s).not.toMatch(/\balter function\b/i);
  });

  it("no DROP FUNCTION appears — v1's body/object is untouched, only its authenticated reachability is removed", () => {
    const s = sqlOnly(readMigration());
    expect(s).not.toMatch(/\bdrop function\b/i);
  });

  it("no function body ($function$ ... $function$ or $$ ... $$) appears", () => {
    const s = readMigration();
    expect(s).not.toContain("$function$");
    expect(s).not.toContain("$$");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 12. No table/RLS/policy changes.
// ─────────────────────────────────────────────────────────────────────────

describe("0218 — no table/RLS/policy changes", () => {
  it("no ALTER TABLE, CREATE POLICY, DROP POLICY, or ALTER POLICY appears", () => {
    const s = sqlOnly(readMigration());
    expect(s).not.toMatch(/\balter table\b/i);
    expect(s).not.toMatch(/\bcreate policy\b/i);
    expect(s).not.toMatch(/\bdrop policy\b/i);
    expect(s).not.toMatch(/\balter policy\b/i);
  });

  it("no row level security statement appears", () => {
    const s = sqlOnly(readMigration());
    expect(s).not.toMatch(/\brow level security\b/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 13. admin_cancel_reservation_v2 is not modified.
// ─────────────────────────────────────────────────────────────────────────

describe("0218 — admin_cancel_reservation_v2 is not modified", () => {
  it("admin_cancel_reservation_v2 may only appear in explanatory comments distinguishing it from v1, never in real SQL", () => {
    const s = sqlOnly(readMigration());
    expect(s).not.toContain("admin_cancel_reservation_v2");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 14. 0217 remains untouched.
// ─────────────────────────────────────────────────────────────────────────

describe("0218 — 0217 remains untouched", () => {
  it("0217 still contains its guarded terminal UPDATE statements for accept/decline waitlist offer", () => {
    const s217 = readSource("supabase/migrations/0217_waitlist_offer_terminal_status_guard.sql");
    expect(s217).toContain("and status = 'offered'");
    expect(s217).toContain("raise exception 'offer_no_longer_available';");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 15. No future-migration ceiling assertion.
// ─────────────────────────────────────────────────────────────────────────
// Deliberately no "0219 does not exist" check here — see the Phase 45D
// cleanup and its 45E1 follow-up correction for why that pattern is
// invalid for a historical checkpoint's regression suite.

describe("0218 — migration convention", () => {
  it("wrapped in begin;/commit; matching repo convention, and explicitly not yet applied", () => {
    const s = readMigration();
    expect(s).toContain("\nbegin;\n");
    expect(s.trim().endsWith("commit;")).toBe(true);
    expect(s).toContain("Do NOT apply until reviewed.");
  });
});
