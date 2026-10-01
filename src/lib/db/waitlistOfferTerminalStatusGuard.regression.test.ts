import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Phase 45E1 — closes the P1 lost-update race from the Phase 45E concurrency
// audit: accept_waitlist_offer/decline_waitlist_offer read the caller's
// participant row filtered on status='offered', but their terminal UPDATE
// statements mutated by participant id ALONE, with no status predicate at
// the actual write — unlike admin_expire_offer, which already guards its
// own terminal UPDATE with `and status = 'offered'`. A concurrent
// admin_expire_offer (or a second accept/decline for the same row) could
// commit first, and the original transaction's unconditional terminal
// UPDATE would then silently overwrite that newer state, after payment
// obligation / notification / audit work downstream had already run.
//
// The fix: add `and status = 'offered'` to each function's own terminal
// UPDATE, and raise 'offer_no_longer_available' immediately when it
// affects zero rows — before any of the payment/notification/audit work
// that follows in the original control flow, so the whole transaction
// rolls back cleanly.
//
// Migration 0217 is CREATED but explicitly NOT APPLIED by this checkpoint
// — every assertion below is a source-text check against the migration
// file, not a live database check.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const MIGRATION_PATH = "supabase/migrations/0217_waitlist_offer_terminal_status_guard.sql";

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
// 1. Migration redefines exactly the two intended RPCs.
// ─────────────────────────────────────────────────────────────────────────

describe("0217 — redefines exactly accept_waitlist_offer and decline_waitlist_offer", () => {
  it("contains create or replace function public.accept_waitlist_offer(p_event_id uuid)", () => {
    const s = readMigration();
    expect(s).toContain("create or replace function public.accept_waitlist_offer(p_event_id uuid)");
  });

  it("contains create or replace function public.decline_waitlist_offer(p_event_id uuid)", () => {
    const s = readMigration();
    expect(s).toContain("create or replace function public.decline_waitlist_offer(p_event_id uuid)");
  });

  it("no other create or replace function appears", () => {
    const s = sqlOnly(readMigration());
    const matches = s.match(/create or replace function public\.(\w+)\(/g) ?? [];
    expect(matches.length).toBe(2);
    expect(matches).toContain("create or replace function public.accept_waitlist_offer(");
    expect(matches).toContain("create or replace function public.decline_waitlist_offer(");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2-3. Terminal UPDATE includes participant id AND status='offered'.
// ─────────────────────────────────────────────────────────────────────────

describe("0217 — accept_waitlist_offer's terminal UPDATE is guarded", () => {
  it("terminal UPDATE targets id = v_my_row.id AND status = 'offered'", () => {
    const block = functionBody("accept_waitlist_offer");
    const idx = block.indexOf("update event_participants\n    set status           = 'confirmed',");
    expect(idx).toBeGreaterThan(-1);
    const clause = block.slice(idx, block.indexOf("returning * into v_result;", idx));
    expect(clause).toContain("where id     = v_my_row.id");
    expect(clause).toContain("and status = 'offered'");
  });

  it("no unconditional (id-only, no status predicate) terminal UPDATE remains for accept", () => {
    const block = functionBody("accept_waitlist_offer");
    expect(block).not.toContain("where id = v_my_row.id\n  returning * into v_result;");
  });
});

describe("0217 — decline_waitlist_offer's terminal UPDATE is guarded", () => {
  it("terminal UPDATE targets id = v_my_row.id AND status = 'offered'", () => {
    const block = functionBody("decline_waitlist_offer");
    const idx = block.indexOf("update event_participants\n    set status           = 'cancelled',");
    expect(idx).toBeGreaterThan(-1);
    const clause = block.slice(idx, block.indexOf(";", idx + 1) + 1);
    expect(clause).toContain("where id     = v_my_row.id");
    expect(clause).toContain("and status = 'offered';");
  });

  it("no unconditional (id-only, no status predicate) terminal UPDATE remains for decline", () => {
    const block = functionBody("decline_waitlist_offer");
    expect(block).not.toContain("where id = v_my_row.id;");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4-5. Both detect a zero-row terminal update and raise offer_no_longer_available.
// ─────────────────────────────────────────────────────────────────────────

describe("0217 — both functions detect zero rows affected and raise offer_no_longer_available", () => {
  it("accept_waitlist_offer: 'if not found then raise exception 'offer_no_longer_available';' appears immediately after the terminal UPDATE", () => {
    const block = functionBody("accept_waitlist_offer");
    const updateIdx = block.indexOf("returning * into v_result;");
    const raiseIdx = block.indexOf("raise exception 'offer_no_longer_available';", updateIdx);
    expect(updateIdx).toBeGreaterThan(-1);
    expect(raiseIdx).toBeGreaterThan(updateIdx);
    // Nothing else sits between the UPDATE and the not-found check.
    const between = block.slice(updateIdx + "returning * into v_result;".length, raiseIdx).replace(/\s+/g, " ").trim();
    expect(between).toBe("if not found then");
  });

  it("decline_waitlist_offer: 'if not found then raise exception 'offer_no_longer_available';' appears immediately after the terminal UPDATE", () => {
    const block = functionBody("decline_waitlist_offer");
    const updateIdx = block.indexOf("and status = 'offered';");
    const raiseIdx = block.indexOf("raise exception 'offer_no_longer_available';", updateIdx);
    expect(updateIdx).toBeGreaterThan(-1);
    expect(raiseIdx).toBeGreaterThan(updateIdx);
    const between = block.slice(updateIdx + "and status = 'offered';".length, raiseIdx).replace(/\s+/g, " ").trim();
    expect(between).toContain("if not found then");
  });

  it("the zero-row detection mechanism is plpgsql's own FOUND variable (set by UPDATE), not GET DIAGNOSTICS or a manual row-count variable", () => {
    const s = sqlOnly(readMigration());
    expect(s).not.toMatch(/get diagnostics/i);
    expect(s).not.toMatch(/v_row_count/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 6-7. Accept: payment obligation, notification, audit semantics remain
// present and sequenced AFTER the guarded transition.
// ─────────────────────────────────────────────────────────────────────────

describe("0217 — accept_waitlist_offer preserves payment/notification/audit semantics, now sequenced after the guard", () => {
  it("payment obligation logic (_create_payment_obligation) is still present", () => {
    const block = functionBody("accept_waitlist_offer");
    expect(block).toContain("perform public._create_payment_obligation(");
    expect(block).toContain("v_result.price_amount_cents, auth.uid(), v_has_prior_payment");
  });

  it("the payment obligation call occurs AFTER the not-found guard, not before", () => {
    const block = functionBody("accept_waitlist_offer");
    const guardIdx = block.indexOf("raise exception 'offer_no_longer_available';");
    const paymentIdx = block.indexOf("perform public._create_payment_obligation(");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(paymentIdx).toBeGreaterThan(guardIdx);
  });

  it("waitlist_promoted notification content is unchanged", () => {
    const block = functionBody("accept_waitlist_offer");
    expect(block).toContain("'waitlist_promoted',");
    expect(block).toContain("You''ve accepted and are confirmed for \"' || v_event.title || '\".',");
  });

  it("accept_waitlist_offer audit_log entry is unchanged", () => {
    const block = functionBody("accept_waitlist_offer");
    expect(block).toContain("'accept_waitlist_offer',");
    expect(block).toContain("jsonb_build_object('event_title', v_event.title)");
  });

  it("notification and audit_log inserts both occur after the not-found guard", () => {
    const block = functionBody("accept_waitlist_offer");
    const guardIdx = block.indexOf("raise exception 'offer_no_longer_available';");
    const notifIdx = block.indexOf("insert into notifications");
    const auditIdx = block.indexOf("insert into audit_log");
    expect(notifIdx).toBeGreaterThan(guardIdx);
    expect(auditIdx).toBeGreaterThan(guardIdx);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 8. Decline: audit semantics remain present.
// ─────────────────────────────────────────────────────────────────────────

describe("0217 — decline_waitlist_offer preserves audit semantics, sequenced after the guard", () => {
  it("decline_waitlist_offer audit_log entry is unchanged", () => {
    const block = functionBody("decline_waitlist_offer");
    expect(block).toContain("'decline_waitlist_offer',");
    expect(block).toContain("jsonb_build_object('event_title', coalesce(v_event.title, ''))");
  });

  it("the audit_log insert occurs after the not-found guard", () => {
    const block = functionBody("decline_waitlist_offer");
    const guardIdx = block.indexOf("raise exception 'offer_no_longer_available';");
    const auditIdx = block.indexOf("insert into audit_log", guardIdx);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(auditIdx).toBeGreaterThan(guardIdx);
  });

  it("advance_waitlist_offer / expire_stale_offers_for_event calls are unchanged and still gated on found and v_event.status = 'scheduled'", () => {
    const block = functionBody("decline_waitlist_offer");
    expect(block).toContain("if found and v_event.status = 'scheduled' then");
    expect(block).toContain("perform expire_stale_offers_for_event(p_event_id, v_profile.club_id, v_event.title);");
    expect(block).toContain("perform advance_waitlist_offer(p_event_id, v_profile.club_id, v_event.title);");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 9. admin_expire_offer is not redefined.
// ─────────────────────────────────────────────────────────────────────────

describe("0217 — admin_expire_offer is untouched", () => {
  it("admin_expire_offer is not redefined — it may only be mentioned in explanatory comments (it already has the correct terminal-guard pattern)", () => {
    const s = sqlOnly(readMigration());
    expect(s).not.toMatch(/create or replace function public\.admin_expire_offer/);
    expect(s).not.toMatch(/\bdrop function\b.*admin_expire_offer/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 10-11. No table/schema/RLS changes; no unrelated function definitions.
// ─────────────────────────────────────────────────────────────────────────

describe("0217 — scope discipline: no table/schema/RLS changes, no unrelated functions", () => {
  it("no ALTER TABLE, CREATE POLICY, DROP POLICY, or ALTER POLICY appears", () => {
    const s = sqlOnly(readMigration());
    expect(s).not.toMatch(/\balter table\b/i);
    expect(s).not.toMatch(/\bcreate policy\b/i);
    expect(s).not.toMatch(/\bdrop policy\b/i);
    expect(s).not.toMatch(/\balter policy\b/i);
  });

  it("no GRANT/REVOKE statement appears — ACLs are preserved automatically by CREATE OR REPLACE on an unchanged signature/return type", () => {
    const s = sqlOnly(readMigration());
    expect(s).not.toMatch(/\bgrant\b/i);
    expect(s).not.toMatch(/\brevoke\b/i);
  });

  it("no ALTER FUNCTION, CREATE TRIGGER, or DROP FUNCTION appears", () => {
    const s = sqlOnly(readMigration());
    expect(s).not.toMatch(/\balter function\b/i);
    expect(s).not.toMatch(/\bcreate trigger\b/i);
    expect(s).not.toMatch(/\bdrop function\b/i);
  });

  it("SECURITY DEFINER and search_path are preserved on both redefined functions", () => {
    const acceptBlock = functionBody("accept_waitlist_offer");
    const declineBlock = functionBody("decline_waitlist_offer");
    for (const block of [acceptBlock, declineBlock]) {
      expect(block).toContain("security definer");
      expect(block).toContain("set search_path to 'public', 'pg_temp'");
    }
  });

  it("capacity logic, event locking, offer expiry rules are byte-for-byte unchanged from the live definitions", () => {
    const acceptBlock = functionBody("accept_waitlist_offer");
    expect(acceptBlock).toContain("from events\n    where id      = p_event_id\n      and club_id = v_profile.club_id\n      and status  = 'scheduled'\n    for update;");
    expect(acceptBlock).toContain("if v_my_row.offer_expires_at <= now() then");
    expect(acceptBlock).toContain("raise exception 'offer_expired';");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 12. This checkpoint's migration exists under its exact expected filename.
// ─────────────────────────────────────────────────────────────────────────

// A "no 0218 file exists" hardcoded future-migration-ceiling assertion
// previously lived here. Removed: that pattern is invalid for a historical
// checkpoint's regression suite — it cannot prove no LATER, unrelated
// checkpoint (e.g. a legitimate Phase 45E2 migration 0218) will ever be
// created, and would fail the moment one is. Replaced with a durable
// existence/filename check for the one migration this checkpoint actually
// owns. See topLevelBackLinkCleanup.regression.test.ts's own note on this
// same cleanup (the pattern first identified and removed in Phase 45D).
describe("0217 — this checkpoint's migration exists under its exact expected filename", () => {
  it("0217_waitlist_offer_terminal_status_guard.sql is present in supabase/migrations", () => {
    const files: string[] = readdirSync(join(process.cwd(), "supabase/migrations"));
    expect(files).toContain("0217_waitlist_offer_terminal_status_guard.sql");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 13. 0213-0216 remain untouched.
// ─────────────────────────────────────────────────────────────────────────

describe("0217 — 0213-0216 remain untouched", () => {
  it("0213 still contains its active-membership authorization fix", () => {
    const s213 = readSource("supabase/migrations/0213_user_pref_enabled_authorization_hardening.sql");
    expect(s213).toContain("v_target_in_club");
  });

  it("0214 still contains its admin/staff/pro role widening", () => {
    const s214 = readSource("supabase/migrations/0214_event_guest_waiver_staff_authorization.sql");
    expect(s214).toContain("if v_role not in ('admin', 'staff', 'pro') then");
  });

  it("0215 still contains its corrected v_profile REVOKE ALL PRIVILEGES statements", () => {
    const s215 = readSource("supabase/migrations/0215_legacy_security_hygiene.sql");
    expect(s215).toContain("revoke all privileges on table public.v_profile from anon;");
    expect(s215).toContain("revoke all privileges on table public.v_profile from authenticated;");
  });

  it("0216 still contains exactly 50 REVOKE EXECUTE ... FROM PUBLIC statements", () => {
    const s216 = sqlOnly(readSource("supabase/migrations/0216_function_public_execute_acl_closeout.sql"));
    const matches = s216.match(/^revoke execute on function public\.[a-z_]+\([^)]*\) from public;$/gm) ?? [];
    expect(matches.length).toBe(50);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Wrapped in begin;/commit;, not yet applied.
// ─────────────────────────────────────────────────────────────────────────

describe("0217 — migration convention", () => {
  it("wrapped in begin;/commit; matching repo convention, and explicitly not yet applied", () => {
    const s = readMigration();
    expect(s).toContain("\nbegin;\n");
    expect(s.trim().endsWith("commit;")).toBe(true);
    expect(s).toContain("Do NOT apply until reviewed.");
  });
});
