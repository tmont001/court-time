import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 42C-3A — Member Detail Membership Read Model. Widens ONLY
// get_admin_member_detail(uuid) so Member Detail can finally see a claimed
// person's membership_status/membership_type_id/membership_type_name —
// exactly the one gap 0190's own audit note left open ("deferred to future
// 42C-4"). No other function, table, or policy changes. No frontend
// implementation in this checkpoint.
//
// Same source-inspection style as membershipDomainFoundation.regression
// .test.ts / membershipsEnableDisable.regression.test.ts — no live Postgres
// in this repo, so the shipped migration text is the honest thing to
// assert against. Migration 0191 is NOT applied to any database by this
// checkpoint.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !line.trim().startsWith("--") && !line.trim().startsWith("//"))
    .join("\n");
}

const MIGRATION_PATH = "supabase/migrations/0191_member_detail_membership_fields.sql";
const MIGRATION_0188_PATH = "supabase/migrations/0188_membership_domain_foundation.sql";
const MIGRATION_0189_PATH = "supabase/migrations/0189_member_non_member_court_pricing.sql";
const MIGRATION_0190_PATH = "supabase/migrations/0190_memberships_enable_disable_foundation.sql";

function migrationSql(): string {
  return codeOnly(readSource(MIGRATION_PATH));
}

// Extracts one `CREATE OR REPLACE FUNCTION public.<name>(...)` body,
// matching membershipsEnableDisable.regression.test.ts's own helper —
// handles both the `$$`/`$function$` terminator styles this repo's
// migrations use interchangeably.
function functionBody(sql: string, name: string): string {
  const pattern = new RegExp(`create or replace function public\\.${name}\\(`, "i");
  const match = pattern.exec(sql);
  expect(match, `function public.${name} not found`).not.toBeNull();
  const start = match!.index;
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

describe("0191 — migration numbering", () => {
  it("is the next migration after immutable 0190, and no unauthorized 0194+ migration exists yet", () => {
    expect(() => readSource(MIGRATION_0190_PATH)).not.toThrow();
    expect(() => readSource(MIGRATION_PATH)).not.toThrow();

    // Phase 43A-1 (0192, member waiver foundation) and its 0193 hotfix
    // (accepted_at column-ambiguity fix) are the legitimate next
    // migrations once 0191 is applied — this guard now checks for
    // anything PAST that authorized boundary, not past 0191 itself.
    const files = readdirSync(join(process.cwd(), "supabase/migrations"));
    const laterMigrations = files.filter((f) => {
      const match = f.match(/^(\d{4})_/);
      return match !== null && Number(match[1]) > 193;
    });
    expect(laterMigrations).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. 0188/0189/0190 are untouched
// ═══════════════════════════════════════════════════════════════════════════

describe("0191 — 0188/0189/0190 remain immutable", () => {
  it("all three prior migration files are still present and readable", () => {
    expect(() => readSource(MIGRATION_0188_PATH)).not.toThrow();
    expect(() => readSource(MIGRATION_0189_PATH)).not.toThrow();
    expect(() => readSource(MIGRATION_0190_PATH)).not.toThrow();
  });

  it("0191's own SQL never targets a table/policy/function that 0188/0189/0190 own, other than reading roster_members/membership_types via SELECT/JOIN", () => {
    const sql = migrationSql();
    // No ALTER/DROP TABLE/CREATE POLICY/DROP POLICY anywhere in this
    // migration — it is a pure function widen.
    expect(sql).not.toMatch(/alter table/i);
    expect(sql).not.toMatch(/drop table/i);
    expect(sql).not.toMatch(/create policy/i);
    expect(sql).not.toMatch(/drop policy/i);
    // It never redefines any 0188/0189/0190-owned function.
    const otherOwnedFunctions = [
      "create_membership_type", "update_membership_type", "set_membership_type_active",
      "set_roster_member_membership_type", "set_roster_member_membership_status",
      "is_active_club_member",
      "update_club_pricing", "set_court_hourly_rate", "create_reservation",
      "admin_create_member_reservation", "update_member_reservation",
      "update_club_memberships_enabled", "get_members", "get_roster_members",
    ];
    for (const fn of otherOwnedFunctions) {
      expect(sql).not.toMatch(new RegExp(`create or replace function public\\.${fn}\\(`, "i"));
      expect(sql).not.toMatch(new RegExp(`drop function public\\.${fn}\\(`, "i"));
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. exact get_admin_member_detail(uuid) old signature is dropped first
// ═══════════════════════════════════════════════════════════════════════════

describe("0191 — get_admin_member_detail is DROPped before recreation", () => {
  const sql = migrationSql();

  it("issues an explicit DROP FUNCTION with the exact existing 1-arg signature, no IF EXISTS, no CASCADE", () => {
    expect(sql).toMatch(/drop function public\.get_admin_member_detail\(uuid\);/i);
    expect(sql).not.toMatch(/drop function if exists public\.get_admin_member_detail/i);
    expect(sql).not.toMatch(/drop function public\.get_admin_member_detail\(uuid\)\s+cascade/i);
  });

  it("the DROP appears strictly before the CREATE OR REPLACE FUNCTION", () => {
    const dropIdx = sql.search(/drop function public\.get_admin_member_detail\(uuid\);/i);
    const createIdx = sql.search(/create or replace function public\.get_admin_member_detail\(p_member_id uuid\)/i);
    expect(dropIdx).toBeGreaterThan(-1);
    expect(createIdx).toBeGreaterThan(dropIdx);
  });

  it("exactly one DROP FUNCTION statement exists in this migration", () => {
    const dropMatches = sql.match(/drop function /gi) ?? [];
    expect(dropMatches.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. return contract: all existing columns/order preserved, exactly 3
//    membership fields appended
// ═══════════════════════════════════════════════════════════════════════════

describe("0191 — get_admin_member_detail return contract", () => {
  const sql = migrationSql();

  it("preserves the exact 14 pre-existing columns in their exact existing order, with exactly 3 new trailing columns appended", () => {
    expect(sql).toMatch(
      /RETURNS TABLE\(id uuid, first_name text, last_name text, phone text, role text, status text, created_at timestamp with time zone, email text, is_lesson_provider boolean, removed_at timestamp with time zone, attended_event_count bigint, event_no_show_count bigint, completed_lesson_count bigint, member_lesson_no_show_count bigint, membership_status text, membership_type_id uuid, membership_type_name text\)/
    );
  });

  it("appends no columns beyond the three specified — the signature ends at membership_type_name text)", () => {
    const match = /RETURNS TABLE\([^)]*\)/.exec(sql);
    expect(match).not.toBeNull();
    const signature = match![0];
    expect(signature.endsWith("membership_type_name text)")).toBe(true);
    // Exactly 17 columns total (14 existing + 3 new).
    const columnCount = signature.slice("RETURNS TABLE(".length, -1).split(",").length;
    expect(columnCount).toBe(17);
  });

  it("the SELECT list's final three projected columns are the new membership fields, in order", () => {
    const body = functionBody(sql, "get_admin_member_detail");
    expect(body).toMatch(
      /member_lesson_no_show_count,\s*\n\s*rm\.membership_status,\s*\n\s*rm\.membership_type_id,\s*\n\s*mt\.name as membership_type_name/
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5-6. roster_members / membership_types joins
// ═══════════════════════════════════════════════════════════════════════════

describe("0191 — roster_members join", () => {
  it("is a LEFT JOIN, same-club scoped, on claimed_by = p.id (never an INNER JOIN — a legacy claimed profile with no roster row must not disappear)", () => {
    const body = functionBody(migrationSql(), "get_admin_member_detail");
    expect(body).toMatch(
      /left join public\.roster_members rm on rm\.club_id = v_actor_club_id and rm\.claimed_by = p\.id/i
    );
    // Every occurrence of "join public.roster_members" (any join kind) is
    // immediately preceded by "left " — i.e. there is exactly one join
    // against this table and it is a LEFT JOIN, never a bare/INNER JOIN.
    const anyJoinCount = (body.match(/join public\.roster_members/gi) ?? []).length;
    const leftJoinCount = (body.match(/left join public\.roster_members/gi) ?? []).length;
    expect(anyJoinCount).toBe(1);
    expect(leftJoinCount).toBe(1);
    expect(body).not.toMatch(/inner join public\.roster_members/i);
  });
});

describe("0191 — membership_types join", () => {
  it("is a LEFT JOIN, explicitly same-club scoped as defense in depth (mt.club_id = v_actor_club_id), on rm.membership_type_id", () => {
    const body = functionBody(migrationSql(), "get_admin_member_detail");
    expect(body).toMatch(
      /left join public\.membership_types mt on mt\.id = rm\.membership_type_id and mt\.club_id = v_actor_club_id/i
    );
    expect(body).not.toMatch(/inner join public\.membership_types/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7-9. Authorization / SECURITY DEFINER / grants preserved exactly
// ═══════════════════════════════════════════════════════════════════════════

describe("0191 — Admin+Staff authorization is preserved exactly", () => {
  const body = functionBody(migrationSql(), "get_admin_member_detail");

  it("keeps the exact null-safe Admin-OR-Staff gate, unchanged from 0132", () => {
    expect(body).toContain(
      "if v_actor_role is distinct from 'admin' and v_actor_role is distinct from 'staff' then"
    );
    expect(body).toContain("raise exception 'insufficient_role';");
  });

  it("keeps the auth.uid() check and canonical current_user_club_id()/current_user_role() resolution", () => {
    expect(body).toContain("if auth.uid() is null then raise exception 'not_authenticated'; end if;");
    expect(body).toContain("select public.current_user_club_id(), public.current_user_role()");
    expect(body).toContain("into v_actor_club_id, v_actor_role;");
  });

  it("keeps the same-club club_memberships lookup and member_not_found behavior", () => {
    expect(body).toMatch(/select cm\.\* into v_membership\s*\n\s*from public\.club_memberships cm/);
    expect(body).toContain("where cm.user_id = p_member_id");
    expect(body).toContain("and cm.club_id = v_actor_club_id;");
    expect(body).toContain("raise exception 'member_not_found';");
  });

  it("no new authorization predicate was added beyond the pre-existing Admin-OR-Staff check", () => {
    const roleChecks = body.match(/raise exception 'insufficient_role';/g) ?? [];
    expect(roleChecks.length).toBe(1);
  });
});

describe("0191 — SECURITY DEFINER / search_path preserved", () => {
  const sql = migrationSql();

  it("keeps SECURITY DEFINER and the exact hardened search_path", () => {
    const createIdx = sql.indexOf("CREATE OR REPLACE FUNCTION public.get_admin_member_detail(p_member_id uuid)");
    const securityIdx = sql.indexOf("SECURITY DEFINER", createIdx);
    const searchPathIdx = sql.indexOf("SET search_path TO 'public', 'pg_temp'", createIdx);
    expect(createIdx).toBeGreaterThan(-1);
    expect(securityIdx).toBeGreaterThan(createIdx);
    expect(searchPathIdx).toBeGreaterThan(securityIdx);
  });

  it("keeps p_member_id uuid as the sole parameter — signature unchanged", () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.get_admin_member_detail\(p_member_id uuid\)/);
  });
});

describe("0191 — grants: public/anon revoked, authenticated granted", () => {
  const sql = migrationSql();

  it("revokes execute from public and anon", () => {
    expect(sql).toContain("revoke execute on function public.get_admin_member_detail(uuid) from public, anon;");
  });

  it("grants execute to authenticated", () => {
    expect(sql).toContain("grant  execute on function public.get_admin_member_detail(uuid) to authenticated;");
  });

  it("exactly one revoke and one grant statement for this function", () => {
    const revokes = sql.match(/revoke execute on function public\.get_admin_member_detail/g) ?? [];
    const grants = sql.match(/grant\s+execute on function public\.get_admin_member_detail/g) ?? [];
    expect(revokes.length).toBe(1);
    expect(grants.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. Four existing activity/stat subqueries remain present, unchanged
// ═══════════════════════════════════════════════════════════════════════════

describe("0191 — all four existing stat subqueries are preserved", () => {
  const body = functionBody(migrationSql(), "get_admin_member_detail");

  it("attended_event_count — event_participants joined to events, attendance_status = 'attended'", () => {
    expect(body).toMatch(
      /select count\(\*\) from public\.event_participants ep\s*\n\s*join public\.events ev on ev\.id = ep\.event_id\s*\n\s*where ep\.profile_id\s+= p_member_id\s*\n\s*and ep\.attendance_status = 'attended'\s*\n\s*and ev\.club_id\s+= v_actor_club_id\s*\n\s*\) as attended_event_count,/
    );
  });

  it("event_no_show_count — same shape, attendance_status = 'no_show'", () => {
    expect(body).toMatch(/and ep\.attendance_status = 'no_show'[\s\S]{0,120}as event_no_show_count,/);
  });

  it("completed_lesson_count — lesson_requests, lesson_outcome = 'completed'", () => {
    expect(body).toMatch(
      /select count\(\*\) from public\.lesson_requests lr\s*\n\s*where lr\.member_id\s+= p_member_id\s*\n\s*and lr\.club_id\s+= v_actor_club_id\s*\n\s*and lr\.lesson_outcome = 'completed'\s*\n\s*\) as completed_lesson_count,/
    );
  });

  it("member_lesson_no_show_count — same shape, lesson_outcome = 'member_no_show'", () => {
    expect(body).toMatch(/and lr\.lesson_outcome = 'member_no_show'[\s\S]{0,120}as member_lesson_no_show_count,/);
  });

  it("the underlying identity join (profiles + auth.users) is unchanged", () => {
    expect(body).toContain("from public.profiles p");
    expect(body).toContain("left join auth.users u on u.id = p.id");
    expect(body).toContain("where p.id = p_member_id;");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 11. No other DB function/table/policy is changed
// ═══════════════════════════════════════════════════════════════════════════

describe("0191 — scope is strictly limited to get_admin_member_detail", () => {
  const sql = migrationSql();

  it("exactly one function is created/replaced in this migration", () => {
    const creates = sql.match(/create or replace function public\./gi) ?? [];
    expect(creates.length).toBe(1);
  });

  it("no CREATE TABLE, ALTER TABLE, CREATE INDEX, or trigger is introduced", () => {
    expect(sql).not.toMatch(/create table/i);
    expect(sql).not.toMatch(/alter table/i);
    expect(sql).not.toMatch(/create index/i);
    expect(sql).not.toMatch(/create trigger/i);
  });

  it("membership_types and roster_members RLS are not touched — no policy statement of any kind appears", () => {
    expect(sql).not.toMatch(/create policy/i);
    expect(sql).not.toMatch(/alter policy/i);
    expect(sql).not.toMatch(/drop policy/i);
    expect(sql).not.toMatch(/enable row level security/i);
    expect(sql).not.toMatch(/disable row level security/i);
  });

  it("the types.ts delta touches only get_admin_member_detail's Returns shape — no other RPC Returns/Args were widened", () => {
    const typesSource = readSource("src/lib/db/types.ts");
    const idx = typesSource.indexOf("get_admin_member_detail: {");
    expect(idx).toBeGreaterThan(-1);
    const block = typesSource.slice(idx, typesSource.indexOf("get_member_upcoming_activity: {", idx));
    expect(block).toContain("// 0191 — Phase 42C-3A");
    const otherPhase42C3AMentions = (typesSource.match(/Phase 42C-3A/g) ?? []).length;
    // membership_status/membership_type_id/membership_type_name each carry
    // one "// 0191 — Phase 42C-3A" comment — exactly 3, all inside
    // get_admin_member_detail's own block, none anywhere else in the file.
    expect(otherPhase42C3AMentions).toBe(3);
    const mentionsOutsideBlock = typesSource.split("Phase 42C-3A").length - 1 - (block.match(/Phase 42C-3A/g) ?? []).length;
    expect(mentionsOutsideBlock).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 12. No frontend membership-management implementation introduced yet
// ═══════════════════════════════════════════════════════════════════════════

// This checkpoint's own scope claim was "no frontend implementation yet" —
// true when 42C-3A shipped, and superseded by design once Phase 42C-3B
// (the very next checkpoint) legitimately built that frontend. Per this
// file's own established convention (see settingsInformationArchitecture.
// regression.test.ts's header comment on why a hardcoded ceiling like this
// cannot be evergreen), the five checks that used to assert "frontend
// fields/RPCs/components do not exist yet" are retired here rather than
// left to fail for a correct reason. What DOES remain a permanent,
// evergreen invariant of THIS migration specifically — and is asserted
// below instead — is that 0191 itself (the applied, immutable SQL file)
// is never touched by any later frontend checkpoint's changes. Full
// frontend-side coverage for the Membership Status/Type UI itself lives
// in Phase 42C-3B's own regression files, not here.
describe("0191 — the applied migration file itself remains byte-identical regardless of later frontend work", () => {
  it("still drops the exact old signature and appends exactly the 3 documented columns (unchanged since first apply)", () => {
    const sql = migrationSql();
    expect(sql).toMatch(/drop function public\.get_admin_member_detail\(uuid\);/i);
    expect(sql).toMatch(
      /RETURNS TABLE\(id uuid, first_name text, last_name text, phone text, role text, status text, created_at timestamp with time zone, email text, is_lesson_provider boolean, removed_at timestamp with time zone, attended_event_count bigint, event_no_show_count bigint, completed_lesson_count bigint, member_lesson_no_show_count bigint, membership_status text, membership_type_id uuid, membership_type_name text\)/
    );
  });
});
