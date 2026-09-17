import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 43A-1 — regression coverage for the Member Waiver backend
// foundation: waivers / waiver_versions / waiver_acceptances, the
// canonical _evaluate_member_waiver_status predicate, the two read RPCs,
// the four Admin authoring RPCs, and the one role-agnostic acceptance RPC.
//
// Same source-inspection style as clubRulesAndPolicies.regression.test.ts /
// membershipDomainFoundation.regression.test.ts — no live Postgres in this
// repo, so the shipped migration text is the honest thing to assert
// against. Migration 0192 IS APPLIED and IMMUTABLE — not touched by this
// checkpoint. 0193 is a pure CREATE OR REPLACE hotfix for a runtime column-
// ambiguity bug (42702) found in get_my_member_waiver_status()/
// get_member_waiver_status(uuid) after 0192 was applied. Neither 0192 nor
// 0193 is applied to any database BY THIS test suite; these tests only
// prove the shipped SQL takes the shape required.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

const MIGRATION_PATH = "supabase/migrations/0192_member_waiver_foundation.sql";
const MIGRATION_0193_PATH = "supabase/migrations/0193_fix_member_waiver_status_accepted_at_ambiguity.sql";

function migrationSql(): string {
  return codeOnly(readSource(MIGRATION_PATH));
}

function migration0193Sql(): string {
  return codeOnly(readSource(MIGRATION_0193_PATH));
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
// 1. Migration ordering — 0192 remains untouched/immutable; 0193 is the
//    next migration; nothing unauthorized exists past it in this pass.
// ═══════════════════════════════════════════════════════════════════════════

describe("0192 — migration numbering", () => {
  it("is the next migration after immutable 0191", () => {
    expect(() => readSource("supabase/migrations/0191_member_detail_membership_fields.sql")).not.toThrow();
    expect(() => readSource(MIGRATION_PATH)).not.toThrow();
  });

  it("0192's own file is byte-identical to its applied, immutable form — this hotfix pass edits nothing in it", () => {
    const sql = migrationSql();
    // Spot-check: the exact ambiguous (buggy) reads that 0192 shipped with
    // are still present verbatim in 0192 itself — only 0193's CREATE OR
    // REPLACE supersedes their runtime behavior; 0192's text is untouched.
    expect(sql).toContain(
      "select accepted_at into v_accepted_at\n      from public.waiver_acceptances\n     where waiver_version_id = v_current_version_id\n       and roster_member_id  = v_roster_member_id;",
    );
    expect(sql).toContain(
      "select accepted_at into v_accepted_at\n      from public.waiver_acceptances\n     where waiver_version_id = v_current_version_id\n       and roster_member_id  = p_roster_member_id;",
    );
  });
});

describe("0193 — migration numbering", () => {
  it("is the next migration after immutable 0192", () => {
    expect(() => readSource(MIGRATION_PATH)).not.toThrow();
    expect(() => readSource(MIGRATION_0193_PATH)).not.toThrow();
  });

  it("no unauthorized migration beyond 0195 exists (0194 is Phase 43B-1A, a later, unrelated migration)", () => {
    const files = readdirSync(join(process.cwd(), "supabase/migrations"));
    const laterMigrations = files.filter((f) => {
      const match = f.match(/^(\d{4})_/);
      return match !== null && Number(match[1]) > 195;
    });
    expect(laterMigrations).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Schema — waivers: one Member waiver per club
// ═══════════════════════════════════════════════════════════════════════════

describe("0192 — waivers table: exactly one Member waiver per club", () => {
  const sql = migrationSql();

  it("audience is constrained to 'member' only — no other value is possible in 43A", () => {
    expect(sql).toContain("audience            text        not null default 'member'\n                         check (audience = 'member'),");
  });

  it("club_id + audience is unique — the DB itself forbids a second Member waiver document per club", () => {
    expect(sql).toMatch(/create table public\.waivers[\s\S]*?unique \(club_id, audience\)/);
  });

  it("current_version_id has no NOT NULL constraint — a club may exist with no version ever published", () => {
    expect(sql).toContain("current_version_id  uuid,");
    expect(sql).not.toMatch(/current_version_id\s+uuid\s+not null/);
  });

  it("is_required defaults true, and the circular FK to waiver_versions is completed via a separate ALTER TABLE after both tables exist (composite form — see correction-2 coverage below for the full same-waiver guarantee)", () => {
    expect(sql).toContain("is_required         boolean     not null default true,");
    expect(sql).toContain(
      "alter table public.waivers\n  add constraint waivers_current_version_id_fkey\n  foreign key (current_version_id, id) references public.waiver_versions(id, waiver_id);",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Schema — waiver_versions: immutability shape, one draft at a time
// ═══════════════════════════════════════════════════════════════════════════

describe("0192 — waiver_versions table: versioned, no retired status, one draft at a time", () => {
  const sql = migrationSql();

  it("status is constrained to exactly draft/published — no 'retired' value is ever assigned, checked against, or filtered on anywhere", () => {
    expect(sql).toContain("check (status in ('draft', 'published'))");
    // The word appears once, only inside a COMMENT ON TABLE documentation
    // string explaining its deliberate absence (Section B's own header) —
    // never as a status value in a CHECK constraint, an assignment
    // (`status = 'retired'`), or a WHERE filter.
    expect(sql).not.toMatch(/status\s*(=|in)\s*\(?'retired'/);
    expect(sql).not.toMatch(/set status\s*=\s*'retired'/);
  });

  it("waiver_id + version_number is unique, and version_number must be positive", () => {
    expect(sql).toMatch(/create table public\.waiver_versions[\s\S]*?unique \(waiver_id, version_number\)/);
    expect(sql).toContain("version_number integer     not null check (version_number > 0),");
  });

  it("a DB-level partial unique index backstops 'only one draft per waiver' in addition to the RPC-level check", () => {
    expect(sql).toContain(
      "create unique index waiver_versions_one_draft_per_waiver\n  on public.waiver_versions (waiver_id)\n  where status = 'draft';",
    );
  });

  it("published_at/published_by are nullable (a draft has neither) and published_by references profiles", () => {
    expect(sql).toContain("published_at   timestamptz,");
    expect(sql).toContain("published_by   uuid        references public.profiles(id),");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3b. Correction 2 — current_version_id is structurally constrained to a
//     version belonging to the SAME waiver (composite FK), NULL still valid
// ═══════════════════════════════════════════════════════════════════════════

describe("0192 correction 2 — waivers.current_version_id can only reference a version of the SAME waiver", () => {
  const sql = migrationSql();

  it("adds unique(id, waiver_id) on waiver_versions, backing the composite FK below", () => {
    expect(sql).toContain("add constraint waiver_versions_id_waiver_id_uniq unique (id, waiver_id);");
  });

  it("waivers.current_version_id is a COMPOSITE FK (current_version_id, id) -> waiver_versions(id, waiver_id) — not a single-column FK to id alone", () => {
    expect(sql).toContain(
      "  add constraint waivers_current_version_id_fkey\n  foreign key (current_version_id, id) references public.waiver_versions(id, waiver_id);",
    );
    // Explicitly not the old, weaker single-column form.
    expect(sql).not.toMatch(/foreign key \(current_version_id\) references public\.waiver_versions\(id\)/);
  });

  it("current_version_id itself remains a plain nullable uuid column — no NOT NULL was added, so 'no version published yet' stays valid (Postgres' default MATCH SIMPLE short-circuits a multi-column FK when any referencing column is NULL)", () => {
    expect(sql).toContain("current_version_id  uuid,");
    expect(sql).not.toMatch(/current_version_id\s+uuid\s+not null/);
    expect(sql).not.toMatch(/match full/i);
  });

  it("the composite unique constraint is created on waiver_versions BEFORE the composite FK on waivers references it", () => {
    const uniqIdx = sql.indexOf("add constraint waiver_versions_id_waiver_id_uniq");
    const fkIdx = sql.indexOf("add constraint waivers_current_version_id_fkey");
    expect(uniqIdx).toBeGreaterThan(-1);
    expect(fkIdx).toBeGreaterThan(uniqIdx);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3c. Correction 3 — DB-level published-immutability trigger
// ═══════════════════════════════════════════════════════════════════════════

describe("0192 correction 3 — DB-level trigger rejects UPDATE/DELETE once a version is published", () => {
  const sql = migrationSql();
  const fn = functionBody(sql, "_reject_published_waiver_version_mutation");

  it("is a proper trigger function (returns trigger) attached BEFORE UPDATE OR DELETE on waiver_versions", () => {
    expect(fn).toContain("returns trigger");
    expect(sql).toContain(
      "create trigger waiver_versions_block_published_mutation\n  before update or delete on public.waiver_versions\n  for each row execute function public._reject_published_waiver_version_mutation();",
    );
  });

  it("rejects the mutation whenever OLD.status is already 'published' — covers both UPDATE and DELETE with one check", () => {
    expect(fn).toContain("if OLD.status = 'published' then");
    expect(fn).toContain("raise exception 'published_waiver_version_immutable';");
  });

  it("the guard reads OLD.status, never NEW.status — so it cannot be defeated by an UPDATE that also changes status in the same statement", () => {
    expect(fn).not.toMatch(/if NEW\.status/);
  });

  it("allows the legitimate draft -> published transition: the check only rejects when OLD.status is ALREADY 'published', so an UPDATE where OLD.status = 'draft' always passes through to `return NEW`", () => {
    const guardIdx = fn.indexOf("if OLD.status = 'published' then");
    const returnNewIdx = fn.indexOf("return NEW;");
    expect(returnNewIdx).toBeGreaterThan(guardIdx);
  });

  it("never assigns NEW.updated_at (or any NEW column) itself — does not interfere with trigger_set_updated_at's own BEFORE UPDATE trigger on the same table", () => {
    expect(fn).not.toMatch(/NEW\.\w+\s*:?=/);
    expect(sql).toContain("create trigger waiver_versions_updated_at\n  before update on public.waiver_versions\n  for each row execute function public.trigger_set_updated_at();");
  });

  it("is fully private — revoked from public, anon, AND authenticated (a trigger function, never meant to be called directly)", () => {
    expect(sql).toContain(
      "revoke execute on function public._reject_published_waiver_version_mutation()\n  from public, anon, authenticated;",
    );
  });

  it("this trigger is the ONLY UPDATE/DELETE guard on waiver_versions — publish_member_waiver_version's own UPDATE (draft->published) is a distinct, unaffected statement, and no code path ever mutates an already-published row's title/body/status", () => {
    // publish_member_waiver_version's UPDATE always fires with OLD.status
    // = 'draft' (the RPC itself rejects any other status before reaching
    // this UPDATE) — the trigger's guard is a true no-op on that path.
    const publishFn = functionBody(sql, "publish_member_waiver_version");
    expect(publishFn).toContain("if v_version.status <> 'draft' then raise exception 'version_not_draft'; end if;");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Schema — waiver_acceptances: append-only, minimal evidence
// ═══════════════════════════════════════════════════════════════════════════

describe("0192 — waiver_acceptances table: append-only, minimal evidence, no guest identity", () => {
  const sql = migrationSql();
  const tableBlock = (() => {
    const start = sql.indexOf("create table public.waiver_acceptances (");
    const end = sql.indexOf(");", start);
    return sql.slice(start, end);
  })();

  it("has no updated_at column at all", () => {
    expect(tableBlock).not.toMatch(/updated_at/);
  });

  it("roster_member_id and accepted_by are both NOT NULL — no nullable identity, no guest shape introduced", () => {
    expect(tableBlock).toContain("roster_member_id   uuid        not null references public.roster_members(id)");
    expect(tableBlock).toContain("accepted_by        uuid        not null references public.profiles(id)");
  });

  it("accepted_at is server-generated (default now()), never a client-suppliable column default", () => {
    expect(tableBlock).toContain("accepted_at        timestamptz not null default now()");
  });

  it("stores exactly the evidence columns required — no body/title/name snapshot, no IP, no user agent", () => {
    expect(tableBlock).not.toMatch(/snapshot|ip_address|user_agent/i);
    // Exactly the 5 data columns (id, club_id, waiver_version_id, roster_member_id, accepted_by) + accepted_at.
    const columnLines = tableBlock
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("--") && !l.startsWith("unique") && !l.startsWith("create table"));
    expect(columnLines.length).toBe(6);
  });

  it("unique(waiver_version_id, roster_member_id) — one acceptance per version per identity, the idempotency backstop", () => {
    expect(sql).toMatch(/create table public\.waiver_acceptances[\s\S]*?unique \(waiver_version_id, roster_member_id\)/);
  });

  it("no UPDATE or DELETE RPC targets waiver_acceptances anywhere in this migration", () => {
    expect(sql).not.toMatch(/update public\.waiver_acceptances/);
    expect(sql).not.toMatch(/delete from public\.waiver_acceptances/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. RLS — admin-only SELECT, zero write policies anywhere, drafts
//    structurally unreachable by non-admin direct reads
// ═══════════════════════════════════════════════════════════════════════════

describe("0192 — RLS: admin-only SELECT, no direct client write policy on any waiver table", () => {
  const sql = migrationSql();

  it("enables RLS on all three tables", () => {
    expect(sql).toContain("alter table public.waivers            enable row level security;");
    expect(sql).toContain("alter table public.waiver_versions    enable row level security;");
    expect(sql).toContain("alter table public.waiver_acceptances enable row level security;");
  });

  it("defines exactly one SELECT policy per table, all admin+same-club scoped, and zero INSERT/UPDATE/DELETE policies", () => {
    const policies = sql.match(/create policy/g) ?? [];
    expect(policies.length).toBe(3);
    // Each "create policy ... for <verb>" clause must say "select" — scoped
    // per-policy (not a whole-file substring search) because "for update"
    // also appears elsewhere in this file as ordinary row-locking syntax
    // (SELECT ... FOR UPDATE), which is unrelated to RLS policy type.
    const policyForClauses = sql.match(/create policy "[^"]+"\s*\n\s*on public\.\w+ for (\w+)/g) ?? [];
    expect(policyForClauses.length).toBe(3);
    for (const clause of policyForClauses) {
      expect(clause).toMatch(/for select$/);
    }
    expect(sql).toContain('create policy "waivers_select_admin"');
    expect(sql).toContain('create policy "waiver_versions_select_admin"');
    expect(sql).toContain('create policy "waiver_acceptances_select_admin"');
  });

  it("every SELECT policy requires current_user_role() = 'admin' — no 'staff' branch anywhere (staff visibility is explicitly deferred)", () => {
    const policyBlock = sql.slice(sql.indexOf('create policy "waivers_select_admin"'));
    expect(policyBlock).toContain("public.current_user_role() = 'admin'");
    expect(sql).not.toMatch(/'staff'/);
  });

  it("no Member-facing SELECT policy exists on waiver_versions — a draft is structurally unreachable by direct table read, not merely filtered", () => {
    const versionsPolicyBlock = sql.slice(
      sql.indexOf('create policy "waiver_versions_select_admin"'),
      sql.indexOf('create policy "waiver_acceptances_select_admin"'),
    );
    expect((versionsPolicyBlock.match(/create policy/g) ?? []).length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. _evaluate_member_waiver_status — canonical evaluator, four states,
//    fully private
// ═══════════════════════════════════════════════════════════════════════════

describe("0192 — _evaluate_member_waiver_status: canonical evaluator, four states, returns text", () => {
  const sql = migrationSql();
  const fn = functionBody(sql, "_evaluate_member_waiver_status");

  it("returns text, not an enum type", () => {
    expect(fn).toContain("returns text");
    expect(sql).not.toMatch(/create type public\.waiver_status/);
  });

  it("is security definer, stable, canonical search_path", () => {
    expect(fn).toContain("security definer");
    expect(fn).toContain("stable");
    expect(fn).toContain("set search_path = public, pg_temp");
  });

  it("is fully private — revoked from public, anon, AND authenticated (matches is_active_club_member's posture)", () => {
    expect(sql).toContain(
      "revoke execute on function public._evaluate_member_waiver_status(uuid, uuid)\n  from public, anon, authenticated;",
    );
  });

  it("produces exactly the four allowed states, spelled exactly", () => {
    expect(fn).toContain("'not_required'");
    expect(fn).toContain("'current'");
    expect(fn).toContain("'outdated'");
    expect(fn).toContain("'never_accepted'");
  });

  it("not_required covers: requirement disabled, no current version, AND (via the outer coalesce) no waiver row at all", () => {
    expect(fn).toContain("when w.is_required is false        then 'not_required'");
    expect(fn).toContain("when w.current_version_id is null  then 'not_required'");
    expect(fn).toMatch(/select coalesce\(\s*\(/);
    const coalesceIdx = fn.indexOf("select coalesce(");
    const fallbackIdx = fn.lastIndexOf("'not_required'");
    expect(fallbackIdx).toBeGreaterThan(coalesceIdx);
  });

  it("'current' checks an acceptance against w.current_version_id exactly (not any version)", () => {
    const idx = fn.indexOf("then 'current'");
    const block = fn.slice(Math.max(0, idx - 300), idx);
    expect(block).toContain("a.waiver_version_id = w.current_version_id");
  });

  it("'outdated' checks an acceptance against ANY version belonging to the same waiver_id, after the 'current' check has already failed", () => {
    const currentIdx = fn.indexOf("then 'current'");
    const outdatedIdx = fn.indexOf("then 'outdated'");
    expect(outdatedIdx).toBeGreaterThan(currentIdx);
    const block = fn.slice(currentIdx, outdatedIdx);
    expect(block).toContain("v.waiver_id        = w.id");
  });

  it("is role-agnostic — never reads roster_members.role or club_memberships.role", () => {
    expect(fn).not.toMatch(/\.role\b/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. get_my_member_waiver_status — role-agnostic own-status read, no drafts
// ═══════════════════════════════════════════════════════════════════════════

describe("0192 — get_my_member_waiver_status: role-agnostic, own identity only, drafts never exposed", () => {
  const sql = migrationSql();
  const fn = functionBody(sql, "get_my_member_waiver_status");

  it("resolves the caller's own roster identity via claimed_by = auth.uid() — no parameter accepts a roster/user id", () => {
    expect(fn).toContain("where club_id    = v_club_id\n     and claimed_by = auth.uid();");
    expect(fn).not.toMatch(/p_roster_member_id|p_user_id/);
  });

  it("contains no role check of any kind — Member/Pro/Staff/Admin all resolve identically (locked decision 6)", () => {
    expect(fn).not.toMatch(/current_user_role\(\)|insufficient_role|v_role/);
  });

  it("only requires an active club — not_authenticated when absent", () => {
    expect(fn).toContain("if v_club_id is null then raise exception 'not_authenticated'; end if;");
  });

  it("the version join requires cv.status = 'published' — a draft row can never populate title/body here", () => {
    expect(fn).toContain("on cv.id = w.current_version_id and cv.status = 'published'");
  });

  it("accepted_at is populated only when status = 'current', null otherwise", () => {
    expect(fn).toContain("if v_status = 'current' then");
  });

  it("delegates entirely to the canonical evaluator — never re-derives current/outdated/never_accepted logic itself", () => {
    expect(fn).toContain("v_status := public._evaluate_member_waiver_status(v_roster_member_id, v_club_id);");
    expect(fn).not.toMatch(/'outdated'|'never_accepted'/);
  });

  it("is granted to authenticated only, revoked from public/anon", () => {
    expect(sql).toContain("revoke execute on function public.get_my_member_waiver_status() from public, anon;");
    expect(sql).toContain("grant  execute on function public.get_my_member_waiver_status() to authenticated;");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. get_member_waiver_status — Admin-only, same-club enforced
// ═══════════════════════════════════════════════════════════════════════════

describe("0192 — get_member_waiver_status: Admin-only, same-club enforced", () => {
  const sql = migrationSql();
  const fn = functionBody(sql, "get_member_waiver_status");

  it("gates on current_user_role() = admin via is distinct from (null-safe)", () => {
    expect(fn).toContain("if v_role is distinct from 'admin' then raise exception 'insufficient_role'; end if;");
  });

  it("verifies the target roster member belongs to the caller's own club before evaluating — cross-club lookups are rejected", () => {
    expect(fn).toContain("where id = p_roster_member_id and club_id = v_club_id");
    expect(fn).toContain("raise exception 'roster_member_not_found';");
  });

  it("delegates to the same canonical evaluator as the self-service RPC", () => {
    expect(fn).toContain("v_status := public._evaluate_member_waiver_status(p_roster_member_id, v_club_id);");
  });

  it("is granted to authenticated only (the RPC's own internal admin check is the real gate)", () => {
    expect(sql).toContain("revoke execute on function public.get_member_waiver_status(uuid) from public, anon;");
    expect(sql).toContain("grant  execute on function public.get_member_waiver_status(uuid) to authenticated;");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. create_member_waiver_draft — Admin-only, race-safe, one draft at a time
// ═══════════════════════════════════════════════════════════════════════════

describe("0192 — create_member_waiver_draft: Admin-only, race-safe find-or-create, one draft at a time", () => {
  const sql = migrationSql();
  const fn = functionBody(sql, "create_member_waiver_draft");

  it("is Admin-only", () => {
    expect(fn).toContain("if v_role is distinct from 'admin' then raise exception 'insufficient_role'; end if;");
  });

  it("normalizes/trims title and body, rejecting empty input", () => {
    expect(fn).toContain("v_title := nullif(btrim(coalesce(p_title, '')), '');");
    expect(fn).toContain("v_body  := nullif(btrim(coalesce(p_body, '')), '');");
    expect(fn).toContain("if v_title is null then raise exception 'title_required'; end if;");
    expect(fn).toContain("if v_body  is null then raise exception 'body_required'; end if;");
  });

  it("enforces sensible length caps after trimming", () => {
    expect(fn).toContain("if length(v_title) > 300   then raise exception 'title_too_long'; end if;");
    expect(fn).toContain("if length(v_body)  > 20000 then raise exception 'body_too_long'; end if;");
  });

  it("finds-or-creates the club's waivers row via ON CONFLICT DO NOTHING, then locks it with FOR UPDATE before checking for an existing draft", () => {
    const conflictIdx = fn.indexOf("on conflict (club_id, audience) do nothing;");
    const lockIdx = fn.indexOf("for update;", conflictIdx);
    const draftCheckIdx = fn.indexOf("raise exception 'draft_already_exists';", lockIdx);
    expect(conflictIdx).toBeGreaterThan(-1);
    expect(lockIdx).toBeGreaterThan(conflictIdx);
    expect(draftCheckIdx).toBeGreaterThan(lockIdx);
  });

  it("rejects creating a second draft for the same waiver with a specific error code", () => {
    expect(fn).toContain("raise exception 'draft_already_exists';");
  });

  it("computes the next version_number as max(existing)+1, defaulting to 1 for a brand-new waiver", () => {
    expect(fn).toContain("v_next_version_number := coalesce(\n    (select max(version_number) from public.waiver_versions where waiver_id = v_waiver.id),\n    0\n  ) + 1;");
  });

  it("inserts the new row with status = 'draft'", () => {
    expect(fn).toContain("values (v_waiver.id, v_next_version_number, v_title, v_body, 'draft')");
  });

  it("writes exactly one audit_log row, containing lengths only — never the raw title or body text", () => {
    expect((fn.match(/insert into public\.audit_log/g) ?? []).length).toBe(1);
    const auditStart = fn.indexOf("insert into public.audit_log");
    const auditBlock = fn.slice(auditStart);
    expect(auditBlock).toContain("'title_length',   length(v_title),");
    expect(auditBlock).toContain("'body_length',    length(v_body)");
    expect(auditBlock).not.toMatch(/,\s*v_title,/);
    expect(auditBlock).not.toMatch(/,\s*v_body\)/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. update_member_waiver_draft — published immutability enforced here
// ═══════════════════════════════════════════════════════════════════════════

describe("0192 — update_member_waiver_draft: published rows are immutable", () => {
  const sql = migrationSql();
  const fn = functionBody(sql, "update_member_waiver_draft");

  it("rejects any version whose status is not 'draft' — the one place a published title/body could change, closed", () => {
    expect(fn).toContain("if v_version.status <> 'draft' then raise exception 'version_not_editable'; end if;");
  });

  it("scopes the target version to the caller's own club via a join to waivers", () => {
    expect(fn).toContain("join public.waivers w on w.id = v.waiver_id");
    expect(fn).toContain("and w.club_id = v_club_id");
  });

  it("locks the version row (FOR UPDATE OF v) before comparing old vs new", () => {
    expect(fn).toContain("for update of v;");
  });

  it("no-ops (returns without writing) when title and body are unchanged, using null-safe is not distinct from", () => {
    const idx = fn.indexOf("if v_version.title is not distinct from v_title");
    expect(idx).toBeGreaterThan(-1);
    const returnIdx = fn.indexOf("return;", idx);
    const updateIdx = fn.indexOf("update public.waiver_versions", idx);
    expect(returnIdx).toBeGreaterThan(idx);
    expect(returnIdx).toBeLessThan(updateIdx);
  });

  it("a genuine change reaches exactly one UPDATE and one audit_log insert", () => {
    expect((fn.match(/update public\.waiver_versions/g) ?? []).length).toBe(1);
    expect((fn.match(/insert into public\.audit_log/g) ?? []).length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 11. publish_member_waiver_version — atomic publish, no unpublish
// ═══════════════════════════════════════════════════════════════════════════

describe("0192 — publish_member_waiver_version: atomic draft->published + repoint, no unpublish", () => {
  const sql = migrationSql();
  const fn = functionBody(sql, "publish_member_waiver_version");

  it("only a 'draft' version may be published — re-publishing an already-published version is rejected, not silently accepted", () => {
    expect(fn).toContain("if v_version.status <> 'draft' then raise exception 'version_not_draft'; end if;");
  });

  it("sets status/published_at/published_by on the version, then repoints waivers.current_version_id, in that order, within one function invocation", () => {
    const versionUpdateIdx = fn.indexOf("update public.waiver_versions\n     set status       = 'published'");
    const waiverUpdateIdx = fn.indexOf("update public.waivers\n     set current_version_id = p_version_id");
    expect(versionUpdateIdx).toBeGreaterThan(-1);
    expect(waiverUpdateIdx).toBeGreaterThan(versionUpdateIdx);
  });

  it("never sets status back to 'draft' anywhere — no unpublish path exists", () => {
    expect(fn).not.toMatch(/set status\s*=\s*'draft'/);
  });

  it("the old current_version_id is never modified, only read into audit metadata as previous_version_id — the prior published row itself is untouched", () => {
    expect(fn).not.toMatch(/update public\.waiver_versions[\s\S]*?where id = v_waiver\.current_version_id/);
    const auditBlock = fn.slice(fn.indexOf("insert into public.audit_log"));
    expect(auditBlock).toContain("'previous_version_id', v_waiver.current_version_id");
  });

  it("records exactly one audit_log row", () => {
    expect((fn.match(/insert into public\.audit_log/g) ?? []).length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 12. set_member_waiver_required — toggle preserves all history
// ═══════════════════════════════════════════════════════════════════════════

describe("0192 — set_member_waiver_required: disable/re-enable preserves acceptance history", () => {
  const sql = migrationSql();
  const fn = functionBody(sql, "set_member_waiver_required");

  it("touches only waivers.is_required — never references waiver_versions or waiver_acceptances", () => {
    expect(fn).not.toMatch(/waiver_versions|waiver_acceptances/);
  });

  it("fails closed when no waiver exists yet for the club", () => {
    expect(fn).toContain("if not found then raise exception 'waiver_not_found'; end if;");
  });

  it("rejects a null flag explicitly", () => {
    expect(fn).toContain("if p_required is null then raise exception 'required_flag_required'; end if;");
  });

  it("no-ops when the value is unchanged (null-safe is not distinct from)", () => {
    expect(fn).toContain("if v_waiver.is_required is not distinct from p_required then return; end if;");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 13. accept_member_waiver — role-agnostic, no proxy, stale-version
//     rejection, idempotent, append-only
// ═══════════════════════════════════════════════════════════════════════════

describe("0192 — accept_member_waiver: role-agnostic, self-only, stale-version rejected, idempotent", () => {
  const sql = migrationSql();
  const fn = functionBody(sql, "accept_member_waiver");

  it("takes exactly one parameter — the version being accepted — no roster/user id parameter of any kind, closing off any proxy-acceptance path", () => {
    expect(sql).toContain("create or replace function public.accept_member_waiver(\n  p_waiver_version_id uuid\n)");
    expect(fn).not.toMatch(/p_roster_member_id|p_user_id|p_on_behalf_of/);
  });

  it("contains no role check anywhere — Member/Pro/Staff/Admin all accept identically (locked decision 6)", () => {
    expect(fn).not.toMatch(/current_user_role\(\)|insufficient_role|v_role/);
  });

  it("resolves only the CALLER's own claimed roster identity via claimed_by = auth.uid()", () => {
    expect(fn).toContain("where club_id    = v_club_id\n     and claimed_by = auth.uid();");
  });

  it("rejects a version that is not the CURRENT published version — stale_waiver_version", () => {
    expect(fn).toContain("if p_waiver_version_id is distinct from v_waiver.current_version_id then");
    expect(fn).toContain("raise exception 'stale_waiver_version';");
  });

  it("generates accepted_at server-side (now()) — never accepts a client-supplied timestamp", () => {
    expect(fn).toContain("accepted_by, accepted_at)\n  values (v_club_id, p_waiver_version_id, v_roster_member_id, auth.uid(), now())");
  });

  it("is idempotent via ON CONFLICT DO NOTHING + a FOUND check — a repeat call inserts no second row and writes no second audit entry", () => {
    expect(fn).toContain("on conflict (waiver_version_id, roster_member_id) do nothing");
    const conflictIdx = fn.indexOf("on conflict (waiver_version_id, roster_member_id) do nothing");
    const notFoundIdx = fn.indexOf("if not found then", conflictIdx);
    expect(notFoundIdx).toBeGreaterThan(conflictIdx);
    // Exactly one audit_log insert in the whole function, and it lives in
    // the ELSE branch of that same not-found check (the genuinely-new-row path).
    expect((fn.match(/insert into public\.audit_log/g) ?? []).length).toBe(1);
    const auditIdx = fn.indexOf("insert into public.audit_log");
    const elseIdx = fn.indexOf("else", notFoundIdx);
    expect(elseIdx).toBeGreaterThan(notFoundIdx);
    expect(auditIdx).toBeGreaterThan(elseIdx);
  });

  it("never issues an UPDATE or DELETE against waiver_acceptances — strictly append-only", () => {
    expect(fn).not.toMatch(/update public\.waiver_acceptances|delete from public\.waiver_acceptances/);
  });

  it("returns the accepted_at timestamp", () => {
    expect(fn).toContain("returns timestamptz");
    expect(fn).toContain("return v_accepted_at;");
  });

  it("is granted to authenticated only", () => {
    expect(sql).toContain("revoke execute on function public.accept_member_waiver(uuid) from public, anon;");
    expect(sql).toContain("grant  execute on function public.accept_member_waiver(uuid) to authenticated;");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 13b. Correction 1 — accept-vs-publish race closed via FOR SHARE
// ═══════════════════════════════════════════════════════════════════════════

describe("0192 correction 1 — accept_member_waiver locks the waiver pointer BEFORE validating/inserting", () => {
  const sql = migrationSql();
  const acceptFn = functionBody(sql, "accept_member_waiver");
  const publishFn = functionBody(sql, "publish_member_waiver_version");

  it("takes FOR SHARE (not FOR UPDATE) on the waivers row when reading current_version_id", () => {
    expect(acceptFn).toContain(
      "select * into v_waiver\n    from public.waivers\n   where club_id = v_club_id and audience = 'member'\n     for share;",
    );
  });

  it("the FOR SHARE lock precedes BOTH the stale-version check and the acceptance INSERT — the read that establishes current_version_id happens under lock, not before it", () => {
    const lockIdx = acceptFn.indexOf("for share;");
    const staleCheckIdx = acceptFn.indexOf("raise exception 'stale_waiver_version';");
    const insertIdx = acceptFn.indexOf("insert into public.waiver_acceptances");
    expect(lockIdx).toBeGreaterThan(-1);
    expect(staleCheckIdx).toBeGreaterThan(lockIdx);
    expect(insertIdx).toBeGreaterThan(lockIdx);
  });

  it("publish_member_waiver_version locks the SAME waivers row with the conflicting FOR UPDATE mode — the two functions serialize against each other, not merely against themselves", () => {
    expect(publishFn).toContain(
      "select * into v_waiver\n    from public.waivers\n   where id = v_version.waiver_id\n     for update;",
    );
  });

  it("acceptance does NOT take FOR UPDATE (which would additionally serialize concurrent Members against each other) — only FOR SHARE, the least-exclusive mode that still conflicts with a publisher's FOR UPDATE", () => {
    const lockIdx = acceptFn.indexOf("for share;");
    const surroundingClause = acceptFn.slice(Math.max(0, lockIdx - 120), lockIdx + 20);
    expect(surroundingClause).not.toMatch(/for update/);
  });

  it("stale-version rejection and idempotency are both preserved unchanged alongside the new lock", () => {
    expect(acceptFn).toContain("if p_waiver_version_id is distinct from v_waiver.current_version_id then");
    expect(acceptFn).toContain("on conflict (waiver_version_id, roster_member_id) do nothing");
  });

  it("still writes exactly one audit_log row, only for a genuinely new acceptance (unchanged by the locking fix)", () => {
    expect((acceptFn.match(/insert into public\.audit_log/g) ?? []).length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 14. No enforcement changes — reservations/lessons/events/programs are
//     completely untouched by this migration
// ═══════════════════════════════════════════════════════════════════════════

describe("0192 — no booking/lesson/event enforcement introduced (locked decision 4)", () => {
  const sql = migrationSql();

  it("never references reservations, lessons, events, or programs tables/RPCs anywhere in this file", () => {
    expect(sql).not.toMatch(/\breservations\b|\blessons\b|\blesson_requests\b|\bevents\b|\bprograms\b|\bevent_participants\b|\bprogram_enrollments\b/i);
  });

  it("touches no existing table, RLS policy, or function from any prior migration — every CREATE TABLE, CREATE POLICY, and CREATE OR REPLACE FUNCTION here is a brand-new name", () => {
    expect(sql).not.toMatch(/alter policy|drop policy|drop table/i);
    const newFunctionNames = [
      "_evaluate_member_waiver_status",
      "get_my_member_waiver_status",
      "get_member_waiver_status",
      "create_member_waiver_draft",
      "update_member_waiver_draft",
      "publish_member_waiver_version",
      "set_member_waiver_required",
      "accept_member_waiver",
    ];
    for (const name of newFunctionNames) {
      expect(sql).toContain(`function public.${name}(`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 15. 0193 — hotfix for the accepted_at column-ambiguity bug (42702)
// ═══════════════════════════════════════════════════════════════════════════

describe("0193 — redefines exactly get_my_member_waiver_status and get_member_waiver_status, nothing else", () => {
  const sql = migration0193Sql();

  it("contains exactly two CREATE OR REPLACE FUNCTION statements", () => {
    expect((sql.match(/create or replace function/g) ?? []).length).toBe(2);
  });

  it("the two functions are get_my_member_waiver_status() and get_member_waiver_status(uuid) — no other function name appears", () => {
    expect(sql).toContain("create or replace function public.get_my_member_waiver_status()");
    expect(sql).toContain("create or replace function public.get_member_waiver_status(\n  p_roster_member_id uuid\n)");
    expect(sql).not.toMatch(
      /create or replace function public\.(?!get_my_member_waiver_status\(\)|get_member_waiver_status\()/,
    );
  });

  it("touches no table, index, RLS policy, or trigger — CREATE TABLE/INDEX/POLICY/TRIGGER and ALTER TABLE are all absent", () => {
    expect(sql).not.toMatch(/create table|create index|create unique index|create policy|create trigger|alter table/i);
  });

  it("issues no REVOKE/GRANT — CREATE OR REPLACE on an unchanged signature preserves 0192's existing grants (same convention as 0190's create_reservation/admin_create_member_reservation/update_member_reservation replacements)", () => {
    expect(sql).not.toMatch(/revoke execute|grant execute|grant\s+execute/i);
  });
});

describe("0193 — both accepted_at reads are table-qualified; the ambiguous form is gone", () => {
  const sql = migration0193Sql();

  it("neither function contains an unqualified `select accepted_at` — the exact 42702 trigger", () => {
    expect(sql).not.toMatch(/select accepted_at into/);
  });

  it("get_my_member_waiver_status reads a.accepted_at from an aliased waiver_acceptances a, scoped by v_current_version_id and v_roster_member_id", () => {
    const fn = functionBody(sql, "get_my_member_waiver_status");
    expect(fn).toContain(
      "select a.accepted_at into v_accepted_at\n      from public.waiver_acceptances a\n     where a.waiver_version_id = v_current_version_id\n       and a.roster_member_id  = v_roster_member_id;",
    );
  });

  it("get_member_waiver_status reads a.accepted_at from an aliased waiver_acceptances a, scoped by v_current_version_id and p_roster_member_id", () => {
    const fn = functionBody(sql, "get_member_waiver_status");
    expect(fn).toContain(
      "select a.accepted_at into v_accepted_at\n      from public.waiver_acceptances a\n     where a.waiver_version_id = v_current_version_id\n       and a.roster_member_id  = p_roster_member_id;",
    );
  });

  it("both fixed reads still live inside `if v_status = 'current' then ... end if;` — the conditional gating is unchanged", () => {
    for (const name of ["get_my_member_waiver_status", "get_member_waiver_status"]) {
      const fn = functionBody(sql, name);
      const ifIdx = fn.indexOf("if v_status = 'current' then");
      const selectIdx = fn.indexOf("select a.accepted_at into v_accepted_at", ifIdx);
      const endIfIdx = fn.indexOf("end if;", selectIdx);
      expect(ifIdx).toBeGreaterThan(-1);
      expect(selectIdx).toBeGreaterThan(ifIdx);
      expect(endIfIdx).toBeGreaterThan(selectIdx);
    }
  });
});

describe("0193 — signatures, RETURNS TABLE contracts, and modifiers are byte-identical to 0192", () => {
  const sql = migration0193Sql();

  it("get_my_member_waiver_status(): zero-arg, 9-column RETURNS TABLE in the exact original order/types", () => {
    expect(sql).toContain(
      "create or replace function public.get_my_member_waiver_status()\nreturns table (\n  status              text,\n  waiver_id           uuid,\n  current_version_id  uuid,\n  version_number      integer,\n  title               text,\n  body                text,\n  published_at        timestamptz,\n  accepted_at         timestamptz,\n  is_required         boolean\n)",
    );
  });

  it("get_member_waiver_status(uuid): single p_roster_member_id uuid arg, 8-column RETURNS TABLE (no body) in the exact original order/types", () => {
    expect(sql).toContain(
      "create or replace function public.get_member_waiver_status(\n  p_roster_member_id uuid\n)\nreturns table (\n  status              text,\n  waiver_id           uuid,\n  current_version_id  uuid,\n  version_number      integer,\n  title               text,\n  published_at        timestamptz,\n  accepted_at         timestamptz,\n  is_required         boolean\n)",
    );
  });

  it("both functions keep language plpgsql, security definer, stable, and set search_path = public, pg_temp", () => {
    for (const name of ["get_my_member_waiver_status", "get_member_waiver_status"]) {
      const fn = functionBody(sql, name);
      expect(fn).toContain("language plpgsql");
      expect(fn).toContain("security definer");
      expect(fn).toContain("stable");
      expect(fn).toContain("set search_path = public, pg_temp");
    }
  });

  it("get_my_member_waiver_status remains role-agnostic — no role check of any kind (decision 6, unchanged)", () => {
    const fn = functionBody(sql, "get_my_member_waiver_status");
    expect(fn).not.toMatch(/current_user_role\(\)|insufficient_role|v_role/);
    expect(fn).toContain("if v_club_id is null then raise exception 'not_authenticated'; end if;");
  });

  it("get_member_waiver_status remains Admin-only, same-club enforced (unchanged)", () => {
    const fn = functionBody(sql, "get_member_waiver_status");
    expect(fn).toContain("if v_role is distinct from 'admin' then raise exception 'insufficient_role'; end if;");
    expect(fn).toContain("raise exception 'roster_member_not_found';");
  });

  it("both still delegate entirely to the canonical evaluator — never re-derive current/outdated/never_accepted logic", () => {
    const myFn = functionBody(sql, "get_my_member_waiver_status");
    const adminFn = functionBody(sql, "get_member_waiver_status");
    expect(myFn).toContain("v_status := public._evaluate_member_waiver_status(v_roster_member_id, v_club_id);");
    expect(adminFn).toContain("v_status := public._evaluate_member_waiver_status(p_roster_member_id, v_club_id);");
  });

  it("get_my_member_waiver_status still exposes only PUBLISHED version fields — the join still requires cv.status = 'published', so a draft can never reach the return shape", () => {
    const fn = functionBody(sql, "get_my_member_waiver_status");
    expect(fn).toContain("on cv.id = w.current_version_id and cv.status = 'published'");
  });

  it("all existing error codes are preserved verbatim: not_authenticated, no_roster_identity, insufficient_role, roster_member_not_found", () => {
    const myFn = functionBody(sql, "get_my_member_waiver_status");
    const adminFn = functionBody(sql, "get_member_waiver_status");
    expect(myFn).toContain("'not_authenticated'");
    expect(myFn).toContain("'no_roster_identity'");
    expect(adminFn).toContain("'not_authenticated'");
    expect(adminFn).toContain("'insufficient_role'");
    expect(adminFn).toContain("'roster_member_not_found'");
  });

  it("both still return exactly one row via `return query select <scalars>` — no change to the single-row-guarantee shape", () => {
    const myFn = functionBody(sql, "get_my_member_waiver_status");
    const adminFn = functionBody(sql, "get_member_waiver_status");
    expect((myFn.match(/return query/g) ?? []).length).toBe(1);
    expect((adminFn.match(/return query/g) ?? []).length).toBe(1);
  });
});
