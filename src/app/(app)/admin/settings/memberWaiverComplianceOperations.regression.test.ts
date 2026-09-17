import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Phase 43B-1A — Member Waiver Compliance Read Foundation. Backend only:
// one new set-based bulk RPC (get_club_member_waiver_compliance, Admin+
// Staff) and a read-authorization widen on the existing single-Member
// detail RPC (get_member_waiver_status, Admin-only -> Admin-or-Staff).
// 0192/0193 remain untouched. No /admin/members UI, no Guest work, no
// booking/lesson/event enforcement in this checkpoint.
//
// Source-inspection style, matching this repository's established
// convention — no live Postgres in this suite.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

const MIGRATION_PATH = "supabase/migrations/0194_member_waiver_compliance_operations.sql";

function migrationSql(): string {
  return codeOnly(readSource(MIGRATION_PATH));
}

function functionBody(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  expect(start, `function public.${name} not found`).toBeGreaterThanOrEqual(0);
  const dollarDollarEnd = sql.indexOf("\n$$;", start);
  const dollarFnEnd = sql.indexOf("\n$function$;", start);
  const end =
    dollarFnEnd >= 0 && (dollarDollarEnd < 0 || dollarFnEnd < dollarDollarEnd)
      ? dollarFnEnd + "\n$function$;".length
      : dollarDollarEnd + "\n$$;".length;
  expect(end, `closing terminator for public.${name} not found`).toBeGreaterThan(start);
  return sql.slice(start, end);
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Migration ordering
// ═══════════════════════════════════════════════════════════════════════════

describe("0194 — migration numbering", () => {
  it("is the next migration after immutable 0193", () => {
    expect(() => readSource("supabase/migrations/0193_fix_member_waiver_status_accepted_at_ambiguity.sql")).not.toThrow();
    expect(() => readSource(MIGRATION_PATH)).not.toThrow();
  });

  it("no unauthorized 0196+ migration exists yet", () => {
    const files = readdirSync(join(process.cwd(), "supabase/migrations"));
    const laterMigrations = files.filter((f) => {
      const match = f.match(/^(\d{4})_/);
      return match !== null && Number(match[1]) > 195;
    });
    expect(laterMigrations).toEqual([]);
  });

  it("0192 and 0193 both still exist untouched — this migration reads/widens what they defined, never edits them", () => {
    expect(() => readSource("supabase/migrations/0192_member_waiver_foundation.sql")).not.toThrow();
    expect(() => readSource("supabase/migrations/0193_fix_member_waiver_status_accepted_at_ambiguity.sql")).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. get_club_member_waiver_compliance — exists, correct contract
// ═══════════════════════════════════════════════════════════════════════════

describe("0194 — get_club_member_waiver_compliance: contract", () => {
  const sql = migrationSql();
  const fn = functionBody(sql, "get_club_member_waiver_compliance");

  it("is a new zero-argument, set-returning function with exactly the three required output columns, in order", () => {
    expect(sql).toContain(
      "create or replace function public.get_club_member_waiver_compliance()\nreturns table (\n  roster_member_id  uuid,\n  waiver_configured boolean,\n  status            text\n)",
    );
  });

  it("is security definer, stable, canonical search_path", () => {
    expect(fn).toContain("security definer");
    expect(fn).toContain("stable");
    expect(fn).toContain("set search_path = public, pg_temp");
  });

  it("is language plpgsql (not a bare SQL function) so an unauthorized caller gets a real exception, never a silently empty result set", () => {
    expect(fn).toContain("language plpgsql");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Authorization matrix — Admin+Staff allowed, Member/Pro/anon denied,
//    cross-club impossible, no direct table grants
// ═══════════════════════════════════════════════════════════════════════════

describe("0194 — get_club_member_waiver_compliance: authorization matrix", () => {
  const sql = migrationSql();
  const fn = functionBody(sql, "get_club_member_waiver_compliance");

  it("requires an active club (not_authenticated) before any role check", () => {
    const clubCheckIdx = fn.indexOf("if v_club_id is null then raise exception 'not_authenticated'; end if;");
    const roleCheckIdx = fn.indexOf("raise exception 'insufficient_role'");
    expect(clubCheckIdx).toBeGreaterThan(-1);
    expect(roleCheckIdx).toBeGreaterThan(clubCheckIdx);
  });

  it("allows exactly admin or staff via the null-safe two-value allowlist idiom (matches get_members()'s own precedent) — Member and Pro are rejected because they are neither", () => {
    expect(fn).toContain(
      "if v_role is distinct from 'admin' and v_role is distinct from 'staff' then\n    raise exception 'insufficient_role';\n  end if;",
    );
    // No role-check branch ever allowlists 'member' or 'pro' — the only
    // literal role comparisons anywhere in this function are the two
    // 'admin'/'staff' checks above (w.audience = 'member' is an unrelated
    // waiver-document literal, not a role check, and is deliberately not
    // matched by this assertion).
    expect(fn).not.toMatch(/v_role\s*(is (not )?distinct from|=|in)\s*\(?'member'/);
    expect(fn).not.toMatch(/v_role\s*(is (not )?distinct from|=|in)\s*\(?'pro'/);
  });

  it("anon/unauthenticated is rejected — current_user_club_id() resolves to null for a caller with no active membership, hit before the role check", () => {
    expect(fn).toContain("select public.current_user_club_id(), public.current_user_role()");
  });

  it("cross-club data is structurally impossible — the roster query is scoped to v_club_id (server-derived from the caller's own active membership), never a client-supplied club id", () => {
    expect(fn).toContain("where rm.club_id = v_club_id;");
    expect(fn).not.toMatch(/p_club_id/);
  });

  it("is granted to authenticated only, revoked from public/anon (the RPC's own internal role check is the real gate)", () => {
    expect(sql).toContain("revoke execute on function public.get_club_member_waiver_compliance() from public, anon;");
    expect(sql).toContain("grant  execute on function public.get_club_member_waiver_compliance() to authenticated;");
  });

  it("no direct table grant to Staff (or anyone) was added anywhere in this migration — the only new GRANT in the file targets the RPC itself", () => {
    const grantLines = sql.match(/^grant .+$/gm) ?? [];
    expect(grantLines.length).toBe(1);
    expect(grantLines[0]).toContain("get_club_member_waiver_compliance");
    expect(sql).not.toMatch(/grant select|grant insert|grant update|grant delete/i);
  });

  it("does not expose waivers/waiver_versions/waiver_acceptances directly to Staff — no new RLS policy of any kind exists in this migration", () => {
    expect(sql).not.toMatch(/create policy|alter policy/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Set-based implementation guard — no N+1 evaluator loop
// ═══════════════════════════════════════════════════════════════════════════

describe("0194 — get_club_member_waiver_compliance: set-based, no per-row evaluator calls", () => {
  const sql = migrationSql();
  const fn = functionBody(sql, "get_club_member_waiver_compliance");

  it("never calls _evaluate_member_waiver_status (the per-row scalar evaluator) — status is derived inline via CASE/EXISTS in one query", () => {
    expect(fn).not.toMatch(/_evaluate_member_waiver_status/);
  });

  it("contains exactly one `return query` and one `from public.roster_members` — a single set-based statement, not a loop", () => {
    expect((fn.match(/return query/g) ?? []).length).toBe(1);
    expect((fn.match(/from public\.roster_members/g) ?? []).length).toBe(1);
    expect(fn).not.toMatch(/for\s+\w+\s+in\s+select|loop\b/i);
  });

  it("both acceptance checks are correlated EXISTS subqueries inside the single query, not separate round trips", () => {
    expect((fn.match(/exists \(/g) ?? []).length).toBe(2);
  });

  it("every column reference in the query body is alias-qualified — the 0192 column-ambiguity lesson applied: no bare 'status', 'roster_member_id', or 'waiver_configured' is ever written where it could collide with the RETURNS TABLE output names", () => {
    // Strip the RETURNS TABLE declaration and the `declare`d variable list
    // (where the bare names are the OUT-param/declaration syntax itself,
    // not a reference), then check the query body only.
    const queryStart = fn.indexOf("return query");
    const queryBody = fn.slice(queryStart);
    expect(queryBody).not.toMatch(/[^.]\bstatus\b(?!\s*=\s*'published')/); // no bare "status" column ref
    expect(queryBody).toContain("rm.id,");
    expect(queryBody).toContain("(w.id is not null),");
    expect(queryBody).toContain("a.roster_member_id  = rm.id");
    expect(queryBody).toContain("a.roster_member_id = rm.id");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Status derivation matches the 43A canonical evaluator semantics exactly
// ═══════════════════════════════════════════════════════════════════════════

describe("0194 — get_club_member_waiver_compliance: status semantics mirror _evaluate_member_waiver_status", () => {
  const sql = migrationSql();
  const fn = functionBody(sql, "get_club_member_waiver_compliance");

  it("not_required: no waiver row, is_required false, or no current_version_id — same three conditions as the 43A evaluator", () => {
    expect(fn).toContain("when w.id is null                  then 'not_required'");
    expect(fn).toContain("when w.is_required is false        then 'not_required'");
    expect(fn).toContain("when w.current_version_id is null  then 'not_required'");
  });

  it("current: an acceptance exists for w.current_version_id specifically (not any version)", () => {
    const idx = fn.indexOf("then 'current'");
    const block = fn.slice(Math.max(0, idx - 200), idx);
    expect(block).toContain("a.waiver_version_id = w.current_version_id");
  });

  it("outdated: an acceptance exists for ANY version of this waiver, checked only after 'current' has already failed", () => {
    const currentIdx = fn.indexOf("then 'current'");
    const outdatedIdx = fn.indexOf("then 'outdated'");
    expect(outdatedIdx).toBeGreaterThan(currentIdx);
    const block = fn.slice(currentIdx, outdatedIdx);
    expect(block).toContain("v.waiver_id        = w.id");
  });

  it("never_accepted is the final else — reached only when neither acceptance check matched", () => {
    expect(fn).toContain("else 'never_accepted'");
  });

  it("all four evaluator states are represented, spelled exactly as in 0192's evaluator", () => {
    expect(fn).toContain("'not_required'");
    expect(fn).toContain("'current'");
    expect(fn).toContain("'outdated'");
    expect(fn).toContain("'never_accepted'");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. waiver_configured distinguishes no-document vs disabled/unpublished
// ═══════════════════════════════════════════════════════════════════════════

describe("0194 — waiver_configured: explicit no-document vs disabled-document discriminator", () => {
  const sql = migrationSql();
  const fn = functionBody(sql, "get_club_member_waiver_compliance");

  it("waiver_configured is (w.id is not null) — true iff a waivers row exists at all, independent of is_required/current_version_id", () => {
    expect(fn).toContain("(w.id is not null),");
  });

  it("status alone does not distinguish the two states — 'not_required' is reachable both when w.id is null (no document) and when w.id is not null but disabled/unpublished (document exists)", () => {
    const noRowBranch = fn.indexOf("when w.id is null                  then 'not_required'");
    const disabledBranch = fn.indexOf("when w.is_required is false        then 'not_required'");
    expect(noRowBranch).toBeGreaterThan(-1);
    expect(disabledBranch).toBeGreaterThan(noRowBranch);
  });

  it("accepted_at is deliberately NOT part of this bulk return shape — no consumer at this checkpoint (documented reasoning, not an oversight)", () => {
    // The explanatory reasoning lives in the migration's header prose
    // (a `--` comment, stripped by codeOnly()) — read the raw file for it.
    const raw = readSource(MIGRATION_PATH);
    expect(raw).toContain("accepted_at is deliberately NOT included here");
    const returnsBlock = sql.slice(
      sql.indexOf("create or replace function public.get_club_member_waiver_compliance()"),
      sql.indexOf(")", sql.indexOf("status            text")) + 1,
    );
    expect(returnsBlock).not.toMatch(/accepted_at/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Unclaimed roster support
// ═══════════════════════════════════════════════════════════════════════════

describe("0194 — get_club_member_waiver_compliance: unclaimed roster members supported", () => {
  const sql = migrationSql();
  const fn = functionBody(sql, "get_club_member_waiver_compliance");

  it("no claimed_by filter and no role filter anywhere in the query — every roster_members row in the club is returned, claimed or not", () => {
    expect(fn).not.toMatch(/claimed_by/);
    expect(fn).not.toMatch(/rm\.role/);
  });

  it("no roster_members.status filter — active and inactive roster rows are both returned; the caller decides what subset to display", () => {
    expect(fn).not.toMatch(/rm\.status/);
  });

  it("waiver_acceptances is joined by roster_member_id only, which every roster_members row has regardless of claimed_by — an unclaimed member with no acceptance correctly falls through to never_accepted", () => {
    const idx = fn.indexOf("from public.roster_members rm");
    expect(idx).toBeGreaterThan(-1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. get_member_waiver_status widened to Admin+Staff — everything else
//    byte-identical to 0193
// ═══════════════════════════════════════════════════════════════════════════

describe("0194 — get_member_waiver_status: widened to Admin+Staff, contract otherwise unchanged", () => {
  const sql = migrationSql();
  const fn = functionBody(sql, "get_member_waiver_status");

  it("the role check now allows staff alongside admin — same null-safe two-value allowlist idiom", () => {
    expect(fn).toContain(
      "if v_role is distinct from 'admin' and v_role is distinct from 'staff' then\n    raise exception 'insufficient_role';\n  end if;",
    );
    expect(fn).not.toMatch(/if v_role is distinct from 'admin' then raise exception 'insufficient_role'; end if;/);
  });

  it("RETURNS TABLE contract is byte-identical to 0192/0193 — same 8 columns, same order/types, no body/draft field", () => {
    expect(sql).toContain(
      "create or replace function public.get_member_waiver_status(\n  p_roster_member_id uuid\n)\nreturns table (\n  status              text,\n  waiver_id           uuid,\n  current_version_id  uuid,\n  version_number      integer,\n  title               text,\n  published_at        timestamptz,\n  accepted_at         timestamptz,\n  is_required         boolean\n)",
    );
  });

  it("same-club scoping is preserved — roster_member_not_found for a cross-club id", () => {
    expect(fn).toContain("where id = p_roster_member_id and club_id = v_club_id");
    expect(fn).toContain("raise exception 'roster_member_not_found';");
  });

  it("still delegates entirely to the canonical evaluator — never re-derives current/outdated/never_accepted logic", () => {
    expect(fn).toContain("v_status := public._evaluate_member_waiver_status(p_roster_member_id, v_club_id);");
  });

  it("the accepted_at fix from 0193 is preserved (table-qualified via alias a) — this migration does not reintroduce the 42702 ambiguity", () => {
    expect(fn).toContain(
      "select a.accepted_at into v_accepted_at\n      from public.waiver_acceptances a\n     where a.waiver_version_id = v_current_version_id\n       and a.roster_member_id  = p_roster_member_id;",
    );
    expect(fn).not.toMatch(/select accepted_at into v_accepted_at/);
  });

  it("no REVOKE/GRANT is reissued for get_member_waiver_status — CREATE OR REPLACE on an unchanged signature preserves 0192's existing grant (same precedent as 0193's own accepted_at fix)", () => {
    const fnEndIdx = sql.indexOf("end;\n$$;", sql.indexOf("function public.get_member_waiver_status"));
    const afterFn = sql.slice(fnEndIdx, fnEndIdx + 400);
    expect(afterFn).not.toMatch(/revoke execute on function public\.get_member_waiver_status/);
    expect(afterFn).not.toMatch(/grant  execute on function public\.get_member_waiver_status/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. Nothing else touched — authoring RPCs, self-acceptance, Guest,
//    enforcement all unchanged/absent
// ═══════════════════════════════════════════════════════════════════════════

describe("0194 — scope guard: everything else is untouched or absent", () => {
  const sql = migrationSql();

  it("contains exactly two CREATE OR REPLACE FUNCTION statements — the bulk RPC and the widened detail RPC, nothing else", () => {
    expect((sql.match(/create or replace function/g) ?? []).length).toBe(2);
  });

  it("never references get_my_member_waiver_status, accept_member_waiver, or any of the four Member waiver authoring RPCs — Member self-acceptance and Admin-only authoring are both unchanged", () => {
    expect(sql).not.toMatch(/get_my_member_waiver_status|accept_member_waiver|create_member_waiver_draft|update_member_waiver_draft|publish_member_waiver_version|set_member_waiver_required/);
  });

  it("no Guest work of any kind — no guest table, RPC, or token reference anywhere in this migration", () => {
    expect(sql).not.toMatch(/guest/i);
  });

  it("no booking/lesson/event enforcement — no reservation/lesson/event table or RPC referenced anywhere", () => {
    expect(sql).not.toMatch(/\breservations\b|\blessons\b|\blesson_requests\b|\bevents\b|\bprograms\b|\bevent_participants\b|\bprogram_enrollments\b/i);
  });

  it("touches no table, RLS policy, or trigger from any prior migration — no ALTER TABLE, DROP, CREATE TABLE, or CREATE TRIGGER anywhere", () => {
    expect(sql).not.toMatch(/alter table|drop table|drop policy|drop trigger|create table|create trigger/i);
  });
});
