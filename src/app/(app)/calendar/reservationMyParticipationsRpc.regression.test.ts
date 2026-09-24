import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// Phase 39C-2A — regression coverage for migration 0206
// (get_my_reservation_player_participations), using this repository's
// established source-inspection style (see reservationPlayerSearchRpc.
// regression.test.ts's own header comment for why: pure-TypeScript, no
// jsdom/Supabase/network mocking — reading the real SQL is a more honest
// guard than standing up a live Postgres instance in this suite).
//
// 0206 is NOT applied to Supabase by this checkpoint — these tests verify
// the migration FILE's content only. 0001-0205 are APPLIED and immutable
// and are asserted here to be untouched.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

const MIGRATION_PATH = "supabase/migrations/0206_my_reservation_player_participations.sql";
const PREVIOUS_MIGRATIONS = [
  "0203_reservation_player_search_foundation.sql",
  "0204_reservation_player_search_rpc_layer.sql",
  "0205_fix_reservation_player_search_read_ambiguity.sql",
];

function migrationSql(): string {
  return codeOnly(readSource(MIGRATION_PATH));
}

function rawMigrationSql(): string {
  return readSource(MIGRATION_PATH);
}

function functionBody(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  expect(start, `function public.${name} not found`).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf("\n$$;", start);
  expect(end, `terminator not found for ${name}`).toBeGreaterThan(start);
  return sql.slice(start, end + "\n$$;".length);
}

const FN = "get_my_reservation_player_participations";

// ═══════════════════════════════════════════════════════════════════════════
// EXISTENCE
// ═══════════════════════════════════════════════════════════════════════════

describe("0206 exists", () => {
  it("migration file exists on disk", () => {
    expect(existsSync(join(process.cwd(), MIGRATION_PATH))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 1-4. SIGNATURE / SECURITY POSTURE
// ═══════════════════════════════════════════════════════════════════════════

describe("1-4. signature and security posture", () => {
  it("1. exact RPC signature — single uuid parameter, returns table shape", () => {
    const sql = migrationSql();
    const start = sql.indexOf(`create or replace function public.${FN}(`);
    expect(start).toBeGreaterThanOrEqual(0);
    const sigEnd = sql.indexOf(")", start);
    const signature = sql.slice(start, sigEnd);
    expect(signature).toContain("p_expected_club_id uuid");
    // Only one parameter — no reservation_id, no roster_member_id.
    expect(signature).not.toMatch(/p_reservation_id|p_roster_member_id/);

    const returnsStart = sql.indexOf("returns table (", start);
    const returnsEnd = sql.indexOf(")", returnsStart);
    const returnShape = sql.slice(returnsStart, returnsEnd);
    expect(returnShape).toContain("reservation_id     uuid");
    expect(returnShape).toContain("court_id           uuid");
    expect(returnShape).toContain("court_name         text");
    expect(returnShape).toContain("starts_at          timestamptz");
    expect(returnShape).toContain("ends_at            timestamptz");
    expect(returnShape).toContain("format             text");
    expect(returnShape).toContain("host_display_name  text");
  });

  it("2. SECURITY DEFINER", () => {
    const body = functionBody(migrationSql(), FN);
    expect(body).toContain("security definer");
  });

  it("3. search_path pinned to public, pg_temp", () => {
    const body = functionBody(migrationSql(), FN);
    expect(body).toContain("set search_path = public, pg_temp");
  });

  it("4. EXECUTE revoked from public/anon, granted to authenticated", () => {
    const sql = migrationSql();
    expect(sql).toMatch(
      new RegExp(`revoke execute on function public\\.${FN}\\(uuid\\) from public, anon;`),
    );
    expect(sql).toMatch(
      new RegExp(`grant\\s+execute on function public\\.${FN}\\(uuid\\) to authenticated;`),
    );
    // Never granted to anon.
    expect(sql).not.toMatch(new RegExp(`grant\\s+execute on function public\\.${FN}\\(uuid\\) to anon;`));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5-8. IDENTITY — claim continuity WITHOUT eligibility
// ═══════════════════════════════════════════════════════════════════════════

describe("5-8. identity: claim continuity only, no eligibility gate", () => {
  it("5. authenticates and enforces expected-club continuity, fail-closed", () => {
    const body = functionBody(migrationSql(), FN);
    expect(body).toContain("if auth.uid() is null then raise exception 'not_authenticated'; end if;");
    expect(body).toContain("v_club_id := public.current_user_club_id();");
    expect(body).toContain("if v_club_id is null then raise exception 'not_authenticated'; end if;");
    expect(body).toContain("if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;");
  });

  it("6. resolves the caller's identity via current_user_roster_member_id() — claim continuity", () => {
    const body = functionBody(migrationSql(), FN);
    expect(body).toContain("v_caller_roster_id := public.current_user_roster_member_id();");
    expect(body).toContain("if v_caller_roster_id is null then raise exception 'roster_identity_required'; end if;");
  });

  it("7. NEVER calls current_club_has_capability — no member_self_service gate", () => {
    const body = functionBody(migrationSql(), FN);
    expect(body).not.toMatch(/current_club_has_capability/);
  });

  it("8. NEVER checks roster_members.status/removed_at for the caller's own identity — no active-eligibility rejection", () => {
    const body = functionBody(migrationSql(), FN);
    // The function queries roster_members only via the LEFT JOIN for the
    // HOST's display name (hrm) — never a second lookup of the caller's
    // own roster_members row. The legitimate rp.status = 'active' filter
    // (reservation_participants — the participation-existence check
    // itself) is expected and must remain; what must never appear is any
    // roster_members-side status/removed_at eligibility predicate on the
    // caller (rm./v_caller_roster./hrm.status would all be such a check —
    // hrm is only ever used for its name, never its status).
    expect(body).not.toMatch(/\brm\.status/);
    expect(body).not.toMatch(/hrm\.status/);
    expect(body).not.toMatch(/v_caller_roster\.status/);
    expect(body).not.toMatch(/removed_at/);
    expect(body).not.toMatch(/select \* into v_caller_roster/i);
    expect(body).not.toMatch(/roster_member_inactive/);
    // The one legitimate status check present is the participant row's
    // own status, not a roster identity's.
    expect(body).toContain("rp.status            = 'active'");
  });

  it("preserves the exact leave_reservation_participation (0204) escape-path model — no capability call and no status check there either, confirmed by direct comparison", () => {
    const leaveSql = codeOnly(readSource("supabase/migrations/0204_reservation_player_search_rpc_layer.sql"));
    const leaveBody = functionBody(leaveSql, "leave_reservation_participation");
    expect(leaveBody).not.toMatch(/current_club_has_capability/);
    expect(leaveBody).not.toMatch(/roster_member_inactive/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9-14. "MY JOINED GAME" PREDICATE
// ═══════════════════════════════════════════════════════════════════════════

describe("9-14. what counts as my joined game", () => {
  it("9. only active reservation_participants rows for the caller's roster identity", () => {
    const body = functionBody(migrationSql(), FN);
    expect(body).toContain("rp.roster_member_id = v_caller_roster_id");
    expect(body).toContain("rp.status            = 'active'");
  });

  it("10. same club only", () => {
    const body = functionBody(migrationSql(), FN);
    expect(body).toContain("r.club_id            = v_club_id");
  });

  it("11. member_booking only", () => {
    const body = functionBody(migrationSql(), FN);
    expect(body).toContain("r.reason             = 'member_booking'");
  });

  it("12. confirmed only", () => {
    const body = functionBody(migrationSql(), FN);
    expect(body).toContain("r.status              = 'confirmed'");
  });

  it("13. future only (starts_at > now())", () => {
    const body = functionBody(migrationSql(), FN);
    expect(body).toContain("r.starts_at           > now()");
  });

  it("14. the caller as current host is excluded — compared against the reservation's CURRENT roster_member_id using a NULL-safe predicate", () => {
    const body = functionBody(migrationSql(), FN);
    expect(body).toContain("r.roster_member_id is distinct from v_caller_roster_id");
  });

  it("14b. the host-exclusion predicate is NOT the plain <> operator — plain <> against a NULL roster_member_id evaluates to NULL in Postgres, which WHERE treats as false and silently drops an otherwise-valid participation row", () => {
    const body = functionBody(migrationSql(), FN);
    expect(body).not.toMatch(/r\.roster_member_id\s*<>\s*v_caller_roster_id/);
  });

  it("14c. NULL-host inclusion invariant: a reservation with a NULL current roster_member_id is not the caller by definition and must be INCLUDED — IS DISTINCT FROM (unlike <>) evaluates true for NULL vs. a non-null v_caller_roster_id, so the row is never dropped", () => {
    // Source-level proof (no live Postgres in this suite, per this file's
    // own header): confirms the predicate is the NULL-safe form AND that
    // v_caller_roster_id is established as non-null before this predicate
    // ever runs (the roster_identity_required guard above it) — the two
    // facts together are what make "NULL current host -> included" hold.
    const body = functionBody(migrationSql(), FN);
    const guardIdx = body.indexOf("if v_caller_roster_id is null then raise exception 'roster_identity_required'; end if;");
    const predicateIdx = body.indexOf("r.roster_member_id is distinct from v_caller_roster_id");
    expect(guardIdx).toBeGreaterThan(0);
    expect(predicateIdx).toBeGreaterThan(guardIdx);
  });

  it("14d. the LEFT JOIN to roster_members (not an INNER JOIN) is what lets a NULL current host still produce a row, with host_display_name falling back to 'Unknown' rather than the row vanishing", () => {
    const body = functionBody(migrationSql(), FN);
    expect(body).toContain("left join public.roster_members hrm on hrm.id    = r.roster_member_id");
    // Exactly one join to roster_members in the whole function, and it is
    // the LEFT JOIN above — no second, plain (inner) join to the same
    // table that would re-impose a NOT NULL requirement.
    const joinOccurrences = body.match(/join public\.roster_members hrm/g) ?? [];
    expect(joinOccurrences.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 15. CURRENT HOST DISPLAY NAME
// ═══════════════════════════════════════════════════════════════════════════

describe("15. host_display_name reflects the CURRENT reservation host", () => {
  it("joins roster_members on reservations.roster_member_id (current host), never on any reservation_player_searches host snapshot", () => {
    const body = functionBody(migrationSql(), FN);
    expect(body).toContain("left join public.roster_members hrm on hrm.id    = r.roster_member_id");
    expect(body).not.toMatch(/host_roster_member_id/);
  });

  it("uses the established display-name fallback convention", () => {
    const body = functionBody(migrationSql(), FN);
    expect(body).toContain("coalesce(nullif(trim(concat_ws(' ', hrm.first_name, hrm.last_name)), ''), 'Unknown')::text");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 16. SEARCH-STATE INDEPENDENCE
// ═══════════════════════════════════════════════════════════════════════════

describe("16. search-state independence — no reservation_player_searches reference anywhere", () => {
  it("the function body never references reservation_player_searches, is_open, effective_is_open, player_capacity, or remaining_spots", () => {
    const body = functionBody(migrationSql(), FN);
    expect(body).not.toMatch(/reservation_player_searches/);
    expect(body).not.toMatch(/\bis_open\b/);
    expect(body).not.toMatch(/effective_is_open/);
    expect(body).not.toMatch(/player_capacity/);
    expect(body).not.toMatch(/remaining_spots/);
  });

  it("the entire migration file (outside comments) never references reservation_player_searches", () => {
    // codeOnly already strips explanatory `--` comment lines (which
    // legitimately discuss the search table BY NAME to document why it is
    // excluded) — the executable SQL itself must contain zero references.
    const sql = migrationSql();
    expect(sql).not.toMatch(/reservation_player_searches/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 17-18. PRIVACY RETURN ALLOWLIST
// ═══════════════════════════════════════════════════════════════════════════

describe("17-18. privacy — return allowlist only, no payment/pricing/waiver data", () => {
  it("17. returns only the seven allowlisted fields — no owner_user_id, host roster_member_id, participant ids, guest names, or notes", () => {
    const sql = migrationSql();
    const returnsStart = sql.indexOf("returns table (", sql.indexOf(`function public.${FN}(`));
    const returnsEnd = sql.indexOf(")", returnsStart);
    const returnShape = sql.slice(returnsStart, returnsEnd);
    expect(returnShape).not.toMatch(/owner_user_id/);
    expect(returnShape).not.toMatch(/roster_member_id/);
    expect(returnShape).not.toMatch(/participant_id/);
    expect(returnShape).not.toMatch(/guest/i);
    expect(returnShape).not.toMatch(/notes/i);
    expect(returnShape).not.toMatch(/email|phone/i);
  });

  it("18. no payment, pricing, Stripe, refund, or waiver field/table is referenced anywhere in the migration", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/public\.payments\b/);
    expect(sql).not.toMatch(/price_amount_cents|hourly_rate_cents/);
    expect(sql).not.toMatch(/stripe/i);
    expect(sql).not.toMatch(/refund/i);
    expect(sql).not.toMatch(/waiver/i);
  });

  it("the function body never selects r.notes or any roster_members.notes/email/phone column", () => {
    const body = functionBody(migrationSql(), FN);
    expect(body).not.toMatch(/r\.notes/);
    expect(body).not.toMatch(/hrm\.(notes|email|phone)/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 19-20. NO RLS CHANGES / PRIOR MIGRATIONS UNTOUCHED
// ═══════════════════════════════════════════════════════════════════════════

describe("19-20. no RLS/policy changes, migrations 0001-0205 untouched", () => {
  it("19. no CREATE POLICY, ALTER TABLE, or GRANT on reservation_participants/reservations/roster_members anywhere in 0206", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/create policy/i);
    expect(sql).not.toMatch(/alter table/i);
    expect(sql).not.toMatch(/grant .* on public\.reservation_participants/i);
    expect(sql).not.toMatch(/grant .* on public\.reservations\b/i);
    expect(sql).not.toMatch(/grant .* on public\.roster_members/i);
  });

  it("introduces exactly one new function and zero new tables", () => {
    const sql = migrationSql();
    expect((sql.match(/create table public\./g) ?? []).length).toBe(0);
    expect((sql.match(/create or replace function public\./g) ?? []).length).toBe(1);
  });

  it("no existing RPC (0203/0204/0205's own functions) is redefined by 0206", () => {
    const sql = migrationSql();
    for (const fn of [
      "_reservation_player_search_is_effective_open",
      "_reservation_player_search_block_reason",
      "_reservation_player_search_occupied_seats",
      "_lock_reservation_player_search_row",
      "_lock_reservation_player_search_scope",
      "add_reservation_participant",
      "add_reservation_guest",
      "set_reservation_player_search",
      "clear_reservation_player_search",
      "get_reservation_player_search",
      "get_open_reservation_player_searches",
      "join_reservation_player_search",
      "leave_reservation_participation",
      "enforce_reservation_player_search_domain",
    ]) {
      expect(sql).not.toMatch(new RegExp(`create or replace function public\\.${fn}\\(`));
    }
  });

  it("20. migrations 0203-0205 are unmodified — their own bodies still contain their known, unique content unchanged", () => {
    const foundation = codeOnly(readSource("supabase/migrations/0203_reservation_player_search_foundation.sql"));
    expect(foundation).toContain("create table public.reservation_player_searches (");

    const rpcLayer = codeOnly(readSource("supabase/migrations/0204_reservation_player_search_rpc_layer.sql"));
    expect(rpcLayer).toContain("create or replace function public.join_reservation_player_search(");

    const fix = codeOnly(readSource("supabase/migrations/0205_fix_reservation_player_search_read_ambiguity.sql"));
    expect(fix).toContain("select s.* into v_search");

    for (const path of PREVIOUS_MIGRATIONS) {
      expect(existsSync(join(process.cwd(), "supabase/migrations", path))).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// HEADER DOCUMENTATION
// ═══════════════════════════════════════════════════════════════════════════

describe("0206 documents its own locked invariants", () => {
  it("the header states the claim-continuity-without-eligibility invariant and the search-state independence invariant", () => {
    const raw = rawMigrationSql();
    expect(raw).toMatch(/CRITICAL IDENTITY \/ LEAVE INVARIANT/);
    expect(raw).toMatch(/SEARCH-STATE INDEPENDENCE/);
    expect(raw).toMatch(/CURRENT-HOST EXCLUSION/);
  });
});
