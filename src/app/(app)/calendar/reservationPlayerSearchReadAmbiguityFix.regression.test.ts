import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { existsSync } from "node:fs";

// Phase 39B-2 — regression coverage for migration 0205 (runtime fix: the
// PL/pgSQL column-vs-output-variable ambiguity in
// get_reservation_player_search, found in live Stage A QA after 0204 was
// applied). 0204 is APPLIED and immutable and is asserted here to be
// untouched by 0205. 0205 itself is NOT applied by this checkpoint — these
// tests verify the migration FILE's content only.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

const MIGRATION_0204_PATH = "supabase/migrations/0204_reservation_player_search_rpc_layer.sql";
const MIGRATION_0205_PATH = "supabase/migrations/0205_fix_reservation_player_search_read_ambiguity.sql";

function migration0205Sql(): string {
  return codeOnly(readSource(MIGRATION_0205_PATH));
}

function raw0205Sql(): string {
  return readSource(MIGRATION_0205_PATH);
}

function functionBody(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  expect(start, `function public.${name} not found`).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf("\n$$;", start);
  expect(end, `terminator not found for ${name}`).toBeGreaterThan(start);
  return sql.slice(start, end + "\n$$;".length);
}

// ═══════════════════════════════════════════════════════════════════════════
// EXISTENCE / IMMUTABILITY (items 1-2)
// ═══════════════════════════════════════════════════════════════════════════

describe("0205 exists and 0204 remains untouched", () => {
  it("1. migration 0205 exists on disk", () => {
    expect(existsSync(join(process.cwd(), MIGRATION_0205_PATH))).toBe(true);
  });

  it("2. 0204's own file content is byte-for-byte unchanged (0205 does not edit it)", () => {
    // get_reservation_player_search's ORIGINAL (buggy) body must still be
    // present, verbatim, inside 0204's own file — proving 0205 was added
    // as a NEW migration, never as an edit to the historical 0204 file.
    const sql0204 = codeOnly(readSource(MIGRATION_0204_PATH));
    const body = functionBody(sql0204, "get_reservation_player_search");
    expect(body).toContain("select * into v_search\n    from public.reservation_player_searches\n   where reservation_id = p_reservation_id;");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SCOPE (item 3)
// ═══════════════════════════════════════════════════════════════════════════

describe("0205 redefines only get_reservation_player_search", () => {
  it("3. exactly one CREATE OR REPLACE FUNCTION statement in 0205, and it is get_reservation_player_search", () => {
    const sql = migration0205Sql();
    const matches = [...sql.matchAll(/create or replace function public\.([a-z_]+)\(/g)];
    expect(matches.length).toBe(1);
    expect(matches[0][1]).toBe("get_reservation_player_search");
  });

  it("0205 does not touch 0203 or any other 0204 object (no other function name, no table, no trigger)", () => {
    const sql = migration0205Sql();
    expect(sql).not.toMatch(/create table/);
    expect(sql).not.toMatch(/create trigger/);
    expect(sql).not.toMatch(/enforce_reservation_player_search_domain/);
    expect(sql).not.toMatch(/_reservation_player_search_occupied_seats\(uuid, uuid\)\s*\nreturns/); // not redefined
    for (const otherFn of [
      "_reservation_player_search_is_effective_open",
      "_reservation_player_search_block_reason",
      "_lock_reservation_player_search_row",
      "_lock_reservation_player_search_scope",
      "add_reservation_participant",
      "add_reservation_guest",
      "set_reservation_player_search",
      "clear_reservation_player_search",
      "get_open_reservation_player_searches",
      "join_reservation_player_search",
      "leave_reservation_participation",
    ]) {
      expect(sql).not.toMatch(new RegExp(`create or replace function public\\.${otherFn}\\(`));
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE FIX ITSELF (items 4-6)
// ═══════════════════════════════════════════════════════════════════════════

describe("0205 fixes the ambiguity", () => {
  it("4. reservation_player_searches is explicitly aliased in the lookup", () => {
    const body = functionBody(migration0205Sql(), "get_reservation_player_search");
    expect(body).toContain("from public.reservation_player_searches s");
  });

  it("5. reservation_id is table-qualified (s.reservation_id) in the lookup's WHERE clause", () => {
    const body = functionBody(migration0205Sql(), "get_reservation_player_search");
    expect(body).toContain("where s.reservation_id = p_reservation_id;");
  });

  it("the target list also uses the alias (select s.*, not select *) so the projection is unambiguous too", () => {
    const body = functionBody(migration0205Sql(), "get_reservation_player_search");
    expect(body).toContain("select s.* into v_search");
    expect(body).not.toMatch(/select \* into v_search/);
  });

  it("6. no bare 'where reservation_id = p_reservation_id' remains anywhere in the new function body", () => {
    const body = functionBody(migration0205Sql(), "get_reservation_player_search");
    expect(body).not.toMatch(/where reservation_id = p_reservation_id/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// EVERYTHING ELSE PRESERVED (items 7-13)
// ═══════════════════════════════════════════════════════════════════════════

describe("0205 preserves everything else about get_reservation_player_search exactly", () => {
  it("7. signature and RETURNS TABLE shape are unchanged from 0204 — same column names, order, and types, including the output column literally named reservation_id", () => {
    const sql0204 = codeOnly(readSource(MIGRATION_0204_PATH));
    const start0204 = sql0204.indexOf("create or replace function public.get_reservation_player_search(");
    const tableEnd0204 = sql0204.indexOf(")\nlanguage plpgsql", sql0204.indexOf("returns table (", start0204));
    const shape0204 = sql0204.slice(start0204, tableEnd0204);

    const sql0205 = migration0205Sql();
    const start0205 = sql0205.indexOf("create or replace function public.get_reservation_player_search(");
    const tableEnd0205 = sql0205.indexOf(")\nlanguage plpgsql", sql0205.indexOf("returns table (", start0205));
    const shape0205 = sql0205.slice(start0205, tableEnd0205);

    expect(shape0205).toBe(shape0204);
  });

  it("8. SECURITY DEFINER is preserved", () => {
    const body = functionBody(migration0205Sql(), "get_reservation_player_search");
    expect(body).toContain("security definer");
  });

  it("9. search_path remains public, pg_temp", () => {
    const body = functionBody(migration0205Sql(), "get_reservation_player_search");
    expect(body).toContain("set search_path = public, pg_temp");
  });

  it("10. EXECUTE is revoked from public and anon", () => {
    const sql = migration0205Sql();
    expect(sql).toMatch(/revoke execute on function public\.get_reservation_player_search\(uuid, uuid\) from public, anon;/);
  });

  it("11. EXECUTE is granted to authenticated", () => {
    const sql = migration0205Sql();
    expect(sql).toMatch(/grant\s+execute on function public\.get_reservation_player_search\(uuid, uuid\) to authenticated;/);
  });

  it("12. no INSERT/UPDATE/DELETE occurs anywhere in the function — still purely read-only", () => {
    const body = functionBody(migration0205Sql(), "get_reservation_player_search");
    expect(body).not.toMatch(/\binsert into\b/i);
    expect(body).not.toMatch(/\bupdate\s+public\./i);
    expect(body).not.toMatch(/\bdelete from\b/i);
  });

  it("authorization gate, zero-row behavior, occupied-seat calculation, and effective-open/block-reason calculation are all unchanged", () => {
    const body = functionBody(migration0205Sql(), "get_reservation_player_search");
    expect(body).toContain("v_reservation := public._authorize_reservation_roster_access(p_reservation_id, p_expected_club_id, false);");
    expect(body).toContain("if not found then\n    return;\n  end if;");
    expect(body).toContain("v_occupied := public._reservation_player_search_occupied_seats(p_reservation_id, v_search.host_roster_member_id);");
    expect(body).toContain("public._reservation_player_search_is_effective_open(v_reservation, v_search),");
    expect(body).toContain("public._reservation_player_search_block_reason(v_reservation, v_search),");
  });

  it("13. no payment, pricing, notification, or capacity-mutation behavior is touched — no reference to payments/notifications/reservation_participants/reservation_guests tables anywhere in 0205", () => {
    const sql = migration0205Sql();
    expect(sql).not.toMatch(/public\.payments\b/);
    expect(sql).not.toMatch(/price_amount_cents|hourly_rate_cents|stripe/i);
    expect(sql).not.toMatch(/public\.notifications\b/);
    expect(sql).not.toMatch(/reservation_participants|reservation_guests/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SAME-CLASS SCAN DOCUMENTATION
// ═══════════════════════════════════════════════════════════════════════════

describe("0205 documents the same-class scan of get_open_reservation_player_searches", () => {
  it("the migration header records that get_open_reservation_player_searches was scanned and found already alias-qualified, and is NOT redefined here", () => {
    const raw = raw0205Sql();
    expect(raw).toMatch(/NARROW SAME-CLASS SCAN/);
    expect(raw).toContain("get_open_reservation_player_searches");
    expect(raw).toMatch(/already alias-qualified/);
    const sql = migration0205Sql();
    expect(sql).not.toMatch(/create or replace function public\.get_open_reservation_player_searches/);
  });

  it("independently verifies the claim: every column reference in get_open_reservation_player_searches's live 0204 query is alias-qualified — no bare reservation_id/court_id/starts_at/ends_at/format/player_capacity/occupied_seats/remaining_spots", () => {
    const sql0204 = codeOnly(readSource(MIGRATION_0204_PATH));
    const body = functionBody(sql0204, "get_open_reservation_player_searches");
    const queryStart = body.indexOf("return query");
    const query = body.slice(queryStart);
    // None of the output-column bare names appear unqualified (i.e. not
    // immediately preceded by an alias + '.') anywhere in the query. No
    // lookbehind regex (this project's tsc target is ES2017) — manual
    // preceding-character check instead.
    // Note: court_id, occupied_seats, and remaining_spots are OUTPUT
    // column names only — they are never spelled literally as table
    // columns anywhere in this query (occupied_seats/remaining_spots are
    // computed expressions; court_id is populated from courts.id, not a
    // literally-named column), so they carry no ambiguity risk and are not
    // expected to appear at all. reservation_id/starts_at/ends_at/format/
    // player_capacity ARE real table columns referenced in this query and
    // must always be alias-qualified wherever they do appear.
    let sawAtLeastOneRealColumnCheck = false;
    for (const outputColumn of ["reservation_id", "starts_at", "ends_at", "format", "player_capacity"]) {
      const wordBoundary = new RegExp(`\\b${outputColumn}\\b`, "g");
      const matches = [...query.matchAll(wordBoundary)];
      expect(matches.length, `expected at least one reference to "${outputColumn}"`).toBeGreaterThan(0);
      sawAtLeastOneRealColumnCheck = true;
      for (const m of matches) {
        const precedingChar = query[m.index! - 1];
        expect(precedingChar, `bare "${outputColumn}" found unqualified in get_open_reservation_player_searches`).toBe(".");
      }
    }
    expect(sawAtLeastOneRealColumnCheck).toBe(true);
  });
});
