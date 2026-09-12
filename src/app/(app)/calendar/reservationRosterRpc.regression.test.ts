import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 37C — regression coverage for migration 0179 (the six reservation
// roster RPCs + shared authorization helper), using this repository's
// established source-inspection style (see
// staleCheckoutInvalidation.regression.test.ts / reservationParticipant
// Foundation.regression.test.ts's own header comments for why: this test
// baseline is deliberately pure-TypeScript with no jsdom/Supabase/network
// mocking, so for "does the shipped migration actually take this shape"
// questions, reading the real SQL is a more honest guard than standing up a
// live Postgres instance in this suite).
//
// 0179 is NOT applied to Supabase by this checkpoint — these tests verify
// the migration FILE's content only.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

const MIGRATION_PATH = "supabase/migrations/0179_reservation_roster_rpc_layer.sql";
const CALENDAR_SHELL_PATH = "src/app/(app)/calendar/CalendarShell.tsx";
const EDIT_RESERVATION_SHEET_PATH = "src/app/(app)/calendar/EditReservationSheet.tsx";

function migrationSql(): string {
  return codeOnly(readSource(MIGRATION_PATH));
}

function functionBody(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  expect(start, `function public.${name} not found`).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf("\n$$;", start);
  expect(end, `terminator not found for ${name}`).toBeGreaterThan(start);
  return sql.slice(start, end + "\n$$;".length);
}

const PUBLIC_RPCS = [
  { name: "get_reservation_roster", sig: "get_reservation_roster(uuid, uuid)" },
  { name: "get_reservation_eligible_roster_members", sig: "get_reservation_eligible_roster_members(uuid, uuid)" },
  { name: "add_reservation_participant", sig: "add_reservation_participant(uuid, uuid, uuid)" },
  { name: "remove_reservation_participant", sig: "remove_reservation_participant(uuid, uuid, uuid)" },
  { name: "add_reservation_guest", sig: "add_reservation_guest(uuid, uuid, text)" },
  { name: "remove_reservation_guest", sig: "remove_reservation_guest(uuid, uuid, uuid)" },
];

// ═══════════════════════════════════════════════════════════════════════════
// AUTHORIZATION (items 1-11)
// ═══════════════════════════════════════════════════════════════════════════

describe("0179 authorization — _authorize_reservation_roster_access", () => {
  const body = () => functionBody(migrationSql(), "_authorize_reservation_roster_access");

  it("1&2. Admin and Staff bypass the ownership clause entirely (any same-club member_booking reservation)", () => {
    expect(body()).toMatch(/v_role in \('admin', 'staff'\)/);
  });

  it("3. Member requires member_self_service before the reservation lookup", () => {
    const b = body();
    expect(b).toContain(
      "if v_role = 'member' and not public.current_club_has_capability('member_self_service') then",
    );
    expect(b).toContain("raise exception 'capability_not_available';");
  });

  it("4&7. Member/Pro ownership clause has no blanket bypass — only real ownership match", () => {
    const b = body();
    // The only role-based bypass in the WHERE clause is admin/staff — member
    // and pro are never named in that bypass, so they always fall through
    // to the real ownership predicates below it.
    const whereIdx = b.indexOf("where id      = p_reservation_id");
    const clause = b.slice(whereIdx, b.indexOf(");", whereIdx));
    expect(clause).not.toMatch(/'member'/);
    expect(clause).not.toMatch(/'pro'/);
  });

  it("5&6. Pro is own-only but is NOT gated by member_self_service (capability check names only 'member')", () => {
    const b = body();
    const capIdx = b.indexOf("current_club_has_capability('member_self_service')");
    expect(capIdx).toBeGreaterThan(0);
    const guardLine = b.slice(b.lastIndexOf("if ", capIdx), b.indexOf("then", capIdx));
    expect(guardLine).toContain("v_role = 'member'");
    expect(guardLine).not.toContain("'pro'");
  });

  it("8. ownership is claim-continuity-aware: owner_user_id = auth.uid() OR roster_member_id = current_user_roster_member_id()", () => {
    const b = body();
    expect(b).toContain("owner_user_id = auth.uid()");
    expect(b).toMatch(/v_roster_member_id is not null and roster_member_id = v_roster_member_id/);
    expect(b).toContain("v_roster_member_id := public.current_user_roster_member_id();");
  });

  it("9. created_by is never referenced as authorization authority anywhere in 0179", () => {
    expect(migrationSql()).not.toMatch(/created_by/);
  });

  it("10. profiles.role / profiles.club_id are never used as authorization truth — only current_user_club_id()/current_user_role()", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/profiles\.role/);
    expect(sql).not.toMatch(/profiles\.club_id/);
    expect(sql).not.toMatch(/from public\.profiles/);
    expect(sql).not.toMatch(/from profiles\b/);
    expect(sql).toContain("public.current_user_club_id()");
    expect(sql).toContain("public.current_user_role()");
  });

  it("11. p_expected_club_id is checked for staleness but never used as the actual data-scoping club — every WHERE clause scopes by v_club_id", () => {
    const b = body();
    expect(b).toContain("if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;");
    expect(migrationSql()).not.toMatch(/club_id\s*=\s*p_expected_club_id/);
  });

  it("requires a real authenticated actor — auth.uid() is null is checked explicitly", () => {
    expect(body()).toContain("if auth.uid() is null then");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// READS (items 12-19)
// ═══════════════════════════════════════════════════════════════════════════

describe("0179 reads", () => {
  it("12. get_reservation_roster returns only active participant and active guest rows", () => {
    const b = functionBody(migrationSql(), "get_reservation_roster");
    expect(b).toContain("and rp.status          = 'active'");
    expect(b).toContain("and rg.status          = 'active'");
  });

  it("13. get_reservation_roster authorizes with p_require_not_cancelled = false — cancelled reservations remain readable", () => {
    const b = functionBody(migrationSql(), "get_reservation_roster");
    expect(b).toContain(
      "v_reservation := public._authorize_reservation_roster_access(p_reservation_id, p_expected_club_id, false);",
    );
  });

  it("14. the roster_members join in get_reservation_roster carries no rm.status filter — historical active participation is never hidden by a later roster status change", () => {
    const b = functionBody(migrationSql(), "get_reservation_roster");
    const joinIdx = b.indexOf("join public.roster_members rm on rm.id = rp.roster_member_id");
    expect(joinIdx).toBeGreaterThan(0);
    const untilNextClause = b.slice(joinIdx, b.indexOf("union all", joinIdx));
    expect(untilNextClause).not.toMatch(/rm\.status/);
  });

  it("15. is_holder is a derived comparison expression, never a selected/stored column", () => {
    const b = functionBody(migrationSql(), "get_reservation_roster");
    expect(b).toContain("(rp.roster_member_id = v_reservation.roster_member_id)");
    expect(b).not.toMatch(/is_holder\s+boolean.*column/i);
  });

  it("16. get_reservation_eligible_roster_members requires active same-club roster identity (status='active')", () => {
    const b = functionBody(migrationSql(), "get_reservation_eligible_roster_members");
    expect(b).toMatch(/where rm\.club_id\s+= v_reservation\.club_id/);
    expect(b).toMatch(/and rm\.status\s+= 'active'/);
  });

  it("16b. get_reservation_eligible_roster_members ALSO requires removed_at IS NULL — status='active' alone is not sufficient", () => {
    const b = functionBody(migrationSql(), "get_reservation_eligible_roster_members");
    expect(b).toContain("and rm.removed_at is null");
  });

  it("17. get_reservation_eligible_roster_members does not filter by role — any role is eligible", () => {
    const b = functionBody(migrationSql(), "get_reservation_eligible_roster_members");
    expect(b).not.toMatch(/rm\.role\s*=/);
  });

  it("17b. get_reservation_eligible_roster_members has no claimed-account requirement (no claimed_by filter anywhere in its body)", () => {
    const b = functionBody(migrationSql(), "get_reservation_eligible_roster_members");
    expect(b).not.toMatch(/claimed_by/);
  });

  it("18. get_reservation_eligible_roster_members excludes only currently ACTIVE participants, not historical/removed ones", () => {
    const b = functionBody(migrationSql(), "get_reservation_eligible_roster_members");
    expect(b).toMatch(/not exists \(\s*select 1 from public\.reservation_participants rp/);
    expect(b).toContain("and rp.status           = 'active'");
  });

  it("19. get_reservation_eligible_roster_members authorizes with p_require_not_cancelled = true", () => {
    const b = functionBody(migrationSql(), "get_reservation_eligible_roster_members");
    expect(b).toContain(
      "v_reservation := public._authorize_reservation_roster_access(p_reservation_id, p_expected_club_id, true);",
    );
  });
});

describe("0179 correction 2 — get_reservation_eligible_roster_members return contract has no account-status exposure", () => {
  it("RETURNS TABLE contract is exactly roster_member_id, display_name, role, is_reservation_holder — no has_account", () => {
    const sql = migrationSql();
    const start = sql.indexOf("create or replace function public.get_reservation_eligible_roster_members(");
    const returnsIdx = sql.indexOf("returns table (", start);
    const closeIdx = sql.indexOf(")", returnsIdx);
    const contract = sql.slice(returnsIdx, closeIdx + 1);
    expect(contract).toMatch(/roster_member_id\s+uuid/);
    expect(contract).toMatch(/display_name\s+text/);
    expect(contract).toMatch(/role\s+text/);
    expect(contract).toMatch(/is_reservation_holder\s+boolean/);
    expect(contract).not.toMatch(/has_account/);
  });

  it("SELECT list never computes or exposes has_account/claimed_by, callable by a Member on their own reservation", () => {
    const b = functionBody(migrationSql(), "get_reservation_eligible_roster_members");
    expect(b).not.toMatch(/has_account/);
    expect(b).not.toMatch(/claimed_by/);
  });

  it("no email or phone is exposed by this RPC either", () => {
    const b = functionBody(migrationSql(), "get_reservation_eligible_roster_members");
    expect(b).not.toMatch(/\bemail\b/i);
    expect(b).not.toMatch(/\bphone\b/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PARTICIPANT MUTATIONS (items 20-26)
// ═══════════════════════════════════════════════════════════════════════════

describe("0179 participant mutations", () => {
  it("20. add_reservation_participant validates a same-club roster identity exists (nonexistent/cross-club -> roster_member_not_found)", () => {
    const b = functionBody(migrationSql(), "add_reservation_participant");
    expect(b).toContain("where id      = p_roster_member_id");
    expect(b).toContain("and club_id = v_reservation.club_id");
    expect(b).toContain("if not found then raise exception 'roster_member_not_found'; end if;");
  });

  it("20b. add_reservation_participant rejects status is distinct from 'active' as roster_member_inactive (no new error code)", () => {
    const b = functionBody(migrationSql(), "add_reservation_participant");
    expect(b).toMatch(/if v_roster\.status is distinct from 'active' or v_roster\.removed_at is not null then/);
    expect(b).toContain("raise exception 'roster_member_inactive';");
  });

  it("20c. add_reservation_participant ALSO rejects removed_at IS NOT NULL as roster_member_inactive — status='active' alone is not sufficient", () => {
    const b = functionBody(migrationSql(), "add_reservation_participant");
    const idx = b.indexOf("if v_roster.status is distinct from 'active' or v_roster.removed_at is not null then");
    expect(idx).toBeGreaterThan(0);
    // Exactly one guard, combining both conditions with OR — not two
    // separate checks that could be independently bypassed.
    expect(b).not.toMatch(/if v_roster\.status is distinct from 'active' then raise exception 'roster_member_inactive'; end if;/);
  });

  it("20d. add_reservation_participant has no claimed-account requirement — no claimed_by filter on the target roster identity", () => {
    const b = functionBody(migrationSql(), "add_reservation_participant");
    expect(b).not.toMatch(/claimed_by/);
  });

  it("21. add_reservation_participant inserts or reactivates exactly one durable row (never a second lifecycle row)", () => {
    const b = functionBody(migrationSql(), "add_reservation_participant");
    expect(b).toContain("insert into public.reservation_participants (reservation_id, roster_member_id, added_by)");
    expect(b).toContain("update public.reservation_participants");
    expect(b).toContain("where id = v_existing.id");
    // FOUND captured into a local boolean on the line immediately after the
    // SELECT ... FOR UPDATE — the exact 0114-fix discipline, not the
    // pre-0114 bug (no statement between the select and the capture).
    const selectIdx = b.indexOf("select * into v_existing");
    const forUpdateIdx = b.indexOf("for update;", selectIdx);
    const capture = b.slice(forUpdateIdx, forUpdateIdx + 80);
    expect(capture).toContain("v_existing_found := found;");
  });

  it("22. reactivation clears removal provenance and refreshes added_by, preserving id/created_at", () => {
    const b = functionBody(migrationSql(), "add_reservation_participant");
    const updateIdx = b.indexOf("update public.reservation_participants");
    const block = b.slice(updateIdx, b.indexOf("v_reactivated := true;", updateIdx));
    expect(block).toContain("status     = 'active'");
    expect(block).toContain("removed_at = null");
    expect(block).toContain("removed_by = null");
    expect(block).toContain("added_by   = auth.uid()");
    expect(block).not.toMatch(/set\s+id\s*=/);
    expect(block).not.toMatch(/created_at\s*=/);
  });

  it("23. an already-active add is idempotent — no second row, no audit entry", () => {
    const b = functionBody(migrationSql(), "add_reservation_participant");
    expect(b).toContain("if v_existing.status = 'active' then");
    expect(b).toContain("v_result := v_existing;");
    expect(b).toContain("if v_reactivated or not v_existing_found then");
  });

  it("24. removal soft-removes only — no DELETE statement anywhere in 0179", () => {
    expect(migrationSql()).not.toMatch(/delete from/i);
    const b = functionBody(migrationSql(), "remove_reservation_participant");
    expect(b).toContain("status     = 'removed'");
    expect(b).toContain("removed_at = now()");
    expect(b).toContain("removed_by = auth.uid()");
  });

  it("25. an already-removed removal is idempotent — no second audit entry", () => {
    const b = functionBody(migrationSql(), "remove_reservation_participant");
    const idx = b.indexOf("if v_existing.status = 'removed' then");
    expect(idx).toBeGreaterThan(0);
    expect(b.slice(idx, idx + 90)).toContain("return v_existing.id;");
    // The audit insert appears only after (never before) this early return.
    const auditIdx = b.indexOf("insert into public.audit_log");
    expect(auditIdx).toBeGreaterThan(idx);
  });

  it("26. add/remove both authorize with p_require_not_cancelled = true", () => {
    for (const fn of ["add_reservation_participant", "remove_reservation_participant"]) {
      const b = functionBody(migrationSql(), fn);
      expect(b).toContain(
        "v_reservation := public._authorize_reservation_roster_access(p_reservation_id, p_expected_club_id, true);",
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GUEST MUTATIONS (items 27-31)
// ═══════════════════════════════════════════════════════════════════════════

describe("0179 guest mutations", () => {
  it("27. add_reservation_guest canonicalizes with btrim() BEFORE the INSERT", () => {
    const b = functionBody(migrationSql(), "add_reservation_guest");
    const trimIdx = b.indexOf("v_display_name := btrim(p_display_name);");
    const insertIdx = b.indexOf("insert into public.reservation_guests");
    expect(trimIdx).toBeGreaterThan(0);
    expect(insertIdx).toBeGreaterThan(trimIdx);
    expect(b.slice(insertIdx, insertIdx + 150)).toContain("v_display_name");
  });

  it("28. null, blank, and >100-character display names are all rejected with distinct codes", () => {
    const b = functionBody(migrationSql(), "add_reservation_guest");
    expect(b).toContain("if v_display_name is null or char_length(v_display_name) < 1 then");
    expect(b).toContain("raise exception 'guest_display_name_required';");
    expect(b).toContain("if char_length(v_display_name) > 100 then");
    expect(b).toContain("raise exception 'guest_display_name_too_long';");
  });

  it("29. duplicate guest display names are never checked or prohibited", () => {
    const b = functionBody(migrationSql(), "add_reservation_guest");
    expect(b).not.toMatch(/exists\s*\(\s*select 1 from public\.reservation_guests/);
  });

  it("30. removal soft-removes the guest row", () => {
    const b = functionBody(migrationSql(), "remove_reservation_guest");
    expect(b).toContain("status     = 'removed'");
    expect(b).toContain("removed_at = now()");
    expect(b).toContain("removed_by = auth.uid()");
    expect(b).not.toMatch(/delete from/i);
  });

  it("31. add/remove guest both authorize with p_require_not_cancelled = true", () => {
    for (const fn of ["add_reservation_guest", "remove_reservation_guest"]) {
      const b = functionBody(migrationSql(), fn);
      expect(b).toContain(
        "v_reservation := public._authorize_reservation_roster_access(p_reservation_id, p_expected_club_id, true);",
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECURITY (items 32-37)
// ═══════════════════════════════════════════════════════════════════════════

describe("0179 security posture", () => {
  it.each(PUBLIC_RPCS.map((r) => [r.name]))("32&33. %s is SECURITY DEFINER and pins search_path", (name) => {
    const b = functionBody(migrationSql(), name as string);
    expect(b).toContain("security definer");
    expect(b).toContain("set search_path = public, pg_temp");
  });

  it.each(PUBLIC_RPCS.map((r) => [r.name, r.sig]))("34&35. %s revokes public/anon and grants only authenticated", (_name, sig) => {
    const sql = migrationSql();
    expect(sql).toMatch(new RegExp(`revoke execute on function public\\.${(sig as string).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} from public, anon;`));
    expect(sql).toMatch(new RegExp(`grant {2}execute on function public\\.${(sig as string).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} to authenticated;`));
  });

  it("the private helper revokes EXECUTE from public, anon, AND authenticated — never directly callable", () => {
    expect(migrationSql()).toMatch(
      /revoke execute on function public\._authorize_reservation_roster_access\(uuid, uuid, boolean\)\s+from public, anon, authenticated;/,
    );
  });

  it("36. no service_role reference anywhere in 0179", () => {
    expect(migrationSql()).not.toMatch(/service_role/);
  });

  it("37. no GRANT/REVOKE/POLICY statement targets the 0178 tables directly — only functions are granted/revoked", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/create policy/);
    expect(sql).not.toMatch(/grant .* on (table )?public\.reservation_participants\b/i);
    expect(sql).not.toMatch(/grant .* on (table )?public\.reservation_guests\b/i);
    expect(sql).not.toMatch(/revoke .* on (table )?public\.reservation_participants\b/i);
    expect(sql).not.toMatch(/revoke .* on (table )?public\.reservation_guests\b/i);
    expect(sql).not.toMatch(/force row level security/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// COMPATIBILITY (items 38-41)
// ═══════════════════════════════════════════════════════════════════════════

describe("0179 compatibility — existing schema/RPCs/behavior/UI untouched", () => {
  it("38. does not redefine any existing reservation CRUD RPC", () => {
    const sql = migrationSql();
    for (const fn of [
      "create_reservation",
      "admin_create_member_reservation",
      "update_member_reservation",
      "cancel_member_reservation",
      "admin_cancel_reservation",
      "admin_cancel_reservation_v2",
    ]) {
      expect(sql).not.toMatch(new RegExp(`create or replace function public\\.${fn}\\(`));
    }
  });

  it("39. touches no payment, pricing, checkout, refund, or reporting object", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/public\.payments\b/);
    expect(sql).not.toMatch(/payment_events/);
    expect(sql).not.toMatch(/payment_checkout_attempts/);
    expect(sql).not.toMatch(/price_amount_cents/);
    expect(sql).not.toMatch(/hourly_rate_cents/);
  });

  it("40. does not reference guest_names, player_count, or format anywhere — no synchronization", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/guest_names/);
    expect(sql).not.toMatch(/player_count/);
    expect(sql).not.toMatch(/\bformat\b/);
  });

  it("40b. does not alter 0178 — no CREATE/ALTER/DROP TABLE anywhere in 0179", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/create table/);
    expect(sql).not.toMatch(/alter table/);
    expect(sql).not.toMatch(/drop table/);
  });

  it("41. no UI file references any of the six new RPC names as of 37C (0179 is schema/RPC only, no UI wiring)", () => {
    // Phase 37D subsequently wired calendar/actions.ts and (indirectly, via
    // the new ReservationRosterSection component it imports)
    // ReservationDetailSheet.tsx to these RPCs — see
    // reservationRosterUx.regression.test.ts for that checkpoint's own
    // coverage. This test is narrowed to the two files 37D never touched,
    // preserving its original intent (37C itself adds no UI) without
    // asserting something 37D correctly made false.
    for (const path of [CALENDAR_SHELL_PATH, EDIT_RESERVATION_SHEET_PATH]) {
      const src = readSource(path);
      for (const rpc of PUBLIC_RPCS) {
        expect(src, `${path} unexpectedly references ${rpc.name}`).not.toContain(rpc.name);
      }
    }
  });

  it("introduces exactly seven new functions (six public RPCs + one private helper) and no others", () => {
    const sql = migrationSql();
    const count = (sql.match(/create or replace function public\./g) ?? []).length;
    expect(count).toBe(7);
  });
});
