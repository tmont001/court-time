import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 45C1A — member_notes schema reconciliation.
//
// Live evidence (a reproduced failure — "Something went wrong" — when the
// repository's old p_content call site was actually exercised against the
// live database, plus direct live introspection) confirmed the authoritative
// live contract is member_notes.body/is_archived/archived_by and
// add_member_note/update_member_note(..., p_body). Migration 0132 already
// reconciled the READ side (get_member_notes) by copying live
// pg_get_functiondef output verbatim; the WRITE side (the three functions
// this checkpoint fixes) and the table DDL itself were never captured in
// any migration until 0211.
//
// Migration 0211 is CREATED but explicitly NOT APPLIED by this checkpoint —
// every assertion below is a source-text check against the migration file
// and the application code, not a live database check.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const ACTIONS_PATH  = "src/app/(app)/admin/members/[id]/actions.ts";
const CLIENT_PATH   = "src/app/(app)/admin/members/[id]/MemberDetailClient.tsx";
const TYPES_PATH    = "src/lib/db/types.ts";
const MIGRATION_PATH = "supabase/migrations/0211_member_notes_schema_reconciliation.sql";

function readMigration(): string {
  return readSource(MIGRATION_PATH);
}

// ─────────────────────────────────────────────────────────────────────────
// 1-2. Application call sites send p_body, never p_content.
// ─────────────────────────────────────────────────────────────────────────

describe("addMemberNoteAction / updateMemberNoteAction send p_body, never p_content", () => {
  it("addMemberNoteAction's add_member_note call uses p_body", () => {
    const s = readSource(ACTIONS_PATH);
    const idx = s.indexOf('supabase.rpc("add_member_note"');
    expect(idx).toBeGreaterThan(-1);
    const block = s.slice(idx, idx + 200);
    expect(block).toContain("p_body:");
    expect(block).not.toContain("p_content");
  });

  it("updateMemberNoteAction's update_member_note call uses p_body", () => {
    const s = readSource(ACTIONS_PATH);
    const idx = s.indexOf('supabase.rpc("update_member_note"');
    expect(idx).toBeGreaterThan(-1);
    const block = s.slice(idx, idx + 200);
    expect(block).toContain("p_body:");
    expect(block).not.toContain("p_content");
  });

  it("no p_content reference remains anywhere in actions.ts", () => {
    const s = readSource(ACTIONS_PATH);
    expect(s).not.toContain("p_content");
  });

  it("mapNoteError maps the live-verified body_empty/body_too_long codes, not the stale content_required/content_too_long codes", () => {
    const s = readSource(ACTIONS_PATH);
    const mapIdx = s.indexOf("function mapNoteError");
    const mapBlock = s.slice(mapIdx, s.indexOf("return map[msg]", mapIdx));
    expect(mapBlock).toContain("body_empty:");
    expect(mapBlock).toContain("body_too_long:");
    // Only the error-code MAP itself must not carry the stale keys — an
    // explanatory comment nearby is allowed to name them for context.
    expect(mapBlock).not.toMatch(/\bcontent_required:/);
    expect(mapBlock).not.toMatch(/\bcontent_too_long:/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Structured note model uses `body`, not `content`.
// ─────────────────────────────────────────────────────────────────────────

describe("structured note read-model uses body/is_archived/archived_by, not content", () => {
  it("AddedNote (actions.ts) declares body/is_archived/archived_by, not content", () => {
    const s = readSource(ACTIONS_PATH);
    const idx = s.indexOf("export interface AddedNote {");
    const end = s.indexOf("}", idx);
    const block = s.slice(idx, end);
    expect(block).toContain("body:");
    expect(block).toContain("is_archived:");
    expect(block).toContain("archived_by:");
    expect(block).not.toContain("content:");
  });

  it("ClientNote (MemberDetailClient.tsx) declares body/is_archived/archived_by, not content", () => {
    const s = readSource(CLIENT_PATH);
    const idx = s.indexOf("export interface ClientNote {");
    const end = s.indexOf("}", idx);
    const block = s.slice(idx, end);
    expect(block).toContain("body:");
    expect(block).toContain("is_archived:");
    expect(block).toContain("archived_by:");
    expect(block).not.toContain("content:");
  });

  it("MemberDetailClient.tsx's note add/edit/render handlers read/write .body, not .content", () => {
    const s = readSource(CLIENT_PATH);
    expect(s).not.toMatch(/note\.content\b/);
    expect(s).not.toMatch(/\{\s*\.\.\.n,\s*content:/);
    expect(s).toContain("setEditContent(note.body)");
    expect(s).toContain("{ ...n, body: trimmed");
    expect(s).toContain("{note.body}");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 5-6. member_notes structural type comes from generated truth; stale
// overrides are gone.
// ─────────────────────────────────────────────────────────────────────────

describe("types.ts no longer overrides member_notes — it flows through from database.types.ts", () => {
  it("no MemberNotesRow/MemberNotesWrite override types remain", () => {
    const s = readSource(TYPES_PATH);
    expect(s).not.toContain("MemberNotesRow");
    expect(s).not.toContain("MemberNotesWrite");
  });

  it("TablesOverride does not mention member_notes at all", () => {
    const s = readSource(TYPES_PATH);
    const idx = s.indexOf("type TablesOverride = {");
    const end = s.indexOf("\n};", idx);
    const block = s.slice(idx, end);
    expect(block).not.toContain("member_notes");
  });

  it("add_member_note/update_member_note's Args are no longer hand-declared with p_content", () => {
    const s = readSource(TYPES_PATH);
    expect(s).not.toContain('Args: { p_member_id: string; p_content: string }');
    expect(s).not.toContain('Args: { p_note_id: string; p_content: string }');
  });

  it("get_member_notes is NOT manually redeclared as a full literal object — only a narrow OverrideArrayReturns refinement", () => {
    const s = readSource(TYPES_PATH);
    // A full hand-written redeclaration would look like `get_member_notes: {`
    // (an object literal type). The narrow refinement instead reads
    // `get_member_notes: OverrideArrayReturns<`.
    expect(s).not.toMatch(/get_member_notes:\s*\{/);
    expect(s).toContain('get_member_notes: OverrideArrayReturns<\n    GeneratedFunctions["get_member_notes"],');
  });

  it("get_member_notes' refinement overrides ONLY author_id/archived_at/archived_by, derived from GeneratedTables member_notes Row via Pick", () => {
    const s = readSource(TYPES_PATH);
    const idx = s.indexOf('get_member_notes: OverrideArrayReturns<');
    expect(idx).toBeGreaterThan(-1);
    const block = s.slice(idx, s.indexOf(";", idx));
    expect(block).toContain('Pick<GeneratedTables["member_notes"]["Row"], "author_id" | "archived_at" | "archived_by">');
    // No other field name appears inside the Pick's key list.
    expect(block).not.toContain('"body"');
    expect(block).not.toContain('"is_archived"');
    expect(block).not.toContain('"author_name"');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. add_member_note's domain return refinement matches migration 0211's
// actual json_build_object field list exactly.
// ─────────────────────────────────────────────────────────────────────────

describe("add_member_note's narrow Returns refinement matches 0211's json_build_object exactly", () => {
  it("types.ts's refinement lists exactly the fields 0211's json_build_object constructs (no club_id)", () => {
    const typesSrc = readSource(TYPES_PATH);
    const idx = typesSrc.indexOf("add_member_note: Omit<GeneratedFunctions");
    expect(idx).toBeGreaterThan(-1);
    const block = typesSrc.slice(idx, idx + 700);
    for (const field of [
      "id", "member_id", "author_id", "author_name_snapshot", "body",
      "is_archived", "created_at", "updated_at", "archived_at", "archived_by",
    ]) {
      expect(block).toContain(`"${field}"`);
    }
    expect(block).not.toContain('"club_id"');

    const migrationSrc = readMigration();
    const jsonIdx = migrationSrc.indexOf("return json_build_object(");
    const jsonBlock = migrationSrc.slice(jsonIdx, migrationSrc.indexOf(");", jsonIdx));
    expect(jsonBlock).not.toContain("'club_id'");
    for (const field of [
      "id", "member_id", "author_id", "author_name_snapshot", "body",
      "is_archived", "created_at", "updated_at", "archived_at", "archived_by",
    ]) {
      expect(jsonBlock).toContain(`'${field}'`);
    }
  });

  it("derives from GeneratedTables[\"member_notes\"][\"Row\"] via Pick, not manually retyped primitives", () => {
    const s = readSource(TYPES_PATH);
    const idx = s.indexOf("add_member_note: Omit<GeneratedFunctions");
    const block = s.slice(idx, idx + 700);
    expect(block).toContain('Pick<\n      GeneratedTables["member_notes"]["Row"],');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 7-9. 0211's table convergence: state-A/state-B safety, ambiguous/missing
// column guards.
// ─────────────────────────────────────────────────────────────────────────

describe("0211 — table convergence is conditional and safe for both starting states", () => {
  it("renames content -> body only when content exists and body does not (state A)", () => {
    const s = readMigration();
    expect(s).toContain("alter table public.member_notes rename column content to body;");
    const idx = s.indexOf("if v_has_content then");
    expect(idx).toBeGreaterThan(-1);
  });

  it("refuses to proceed if BOTH content and body exist", () => {
    const s = readMigration();
    expect(s).toMatch(/if v_has_content and v_has_body then\s*\n\s*raise exception 'member_notes_ambiguous_column_state/);
  });

  it("refuses to proceed if NEITHER content nor body exist", () => {
    const s = readMigration();
    expect(s).toMatch(/if not v_has_content and not v_has_body then\s*\n\s*raise exception 'member_notes_missing_column_state/);
  });

  it("never uses DROP ... CASCADE anywhere in the migration — the only legitimate CASCADE usage is the ON DELETE CASCADE foreign-key action being converged to (migration-review correction 1), never on a DROP statement", () => {
    const s = readMigration();
    const sqlLines = s
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    // Every real (non-comment) occurrence of "cascade" must be part of
    // "on delete cascade" — never trailing a "drop ... " statement.
    const cascadeOccurrences = sqlLines.match(/[^\n]*cascade[^\n]*/gi) ?? [];
    expect(cascadeOccurrences.length).toBeGreaterThan(0); // sanity: the FK convergence really does add ON DELETE CASCADE
    for (const line of cascadeOccurrences) {
      expect(line.toLowerCase()).toContain("on delete cascade");
      expect(line.toLowerCase()).not.toMatch(/\bdrop\b/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 10-12. Canonical constraints represented.
// ─────────────────────────────────────────────────────────────────────────

describe("0211 — canonical body/is_archived/archived_by constraints", () => {
  it("represents both canonical body CHECK constraints by exact name", () => {
    const s = readMigration();
    expect(s).toContain("add constraint member_notes_body_nonempty check (char_length(trim(body)) > 0)");
    expect(s).toContain("add constraint member_notes_body_length check (char_length(body) <= 2000)");
  });

  it("drops any pre-existing CHECK constraint on member_notes that isn't one of the two canonical names (found via pg_constraint, not an assumed legacy name)", () => {
    const s = readMigration();
    expect(s).toContain("con.contype = 'c'");
    expect(s).toContain("con.conname not in ('member_notes_body_length', 'member_notes_body_nonempty')");
  });

  it("guards each canonical constraint ADD with a pg_constraint existence check (idempotent on state B)", () => {
    const s = readMigration();
    const addCount = (s.match(/add constraint member_notes_body_(nonempty|length)/g) ?? []).length;
    const guardCount = (s.match(/con\.conname = 'member_notes_body_(nonempty|length)'/g) ?? []).length;
    expect(addCount).toBe(2);
    expect(guardCount).toBe(2);
  });

  it("backfills is_archived = true for legacy archived_at-only rows, never inventing archived_at", () => {
    const s = readMigration();
    const idx = s.indexOf("set is_archived = true");
    expect(idx).toBeGreaterThan(-1);
    const block = s.slice(idx, idx + 150);
    expect(block).toContain("archived_at is not null");
    expect(s).not.toMatch(/set\s+archived_at\s*=/); // never sets archived_at from this backfill
  });

  it("adds the canonical archived_by FK by exact name, guarded against duplication", () => {
    const s = readMigration();
    expect(s).toContain("add constraint member_notes_archived_by_fkey");
    expect(s).toContain("foreign key (archived_by) references public.profiles(id) on delete set null");
    expect(s).toContain("con.conname = 'member_notes_archived_by_fkey'");
  });

  it("does not touch id/club_id/member_id/author_id/author_name_snapshot/created_at/archived_at column definitions", () => {
    const s = readMigration();
    expect(s).not.toMatch(/rename column (id|club_id|member_id|author_id|author_name_snapshot|created_at|archived_at)\b/);
    expect(s).not.toMatch(/drop column (id|club_id|member_id|author_id|author_name_snapshot|created_at|archived_at)\b/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Migration review correction 1 — member_id FK converges to the verified
// live canonical: ON DELETE CASCADE, detected via pg_constraint.confdeltype
// (not an assumed constraint name), never dropped via CASCADE.
// ─────────────────────────────────────────────────────────────────────────

describe("0211 — member_id FK converges to ON DELETE CASCADE via catalog-semantic detection", () => {
  it("detects the existing FK's real delete-action via confdeltype, not by name", () => {
    const s = readMigration();
    expect(s).toContain("con.confdeltype");
    expect(s).toContain("con.contype = 'f'");
    // Detection keys off the column (member_id's attnum in conkey), not an
    // assumed constraint name.
    expect(s).toContain("con.conkey = array[v_member_id_attnum]");
  });

  it("adds the canonical FK only when absent, and replaces it only when not already CASCADE — never unconditionally", () => {
    const s = readMigration();
    expect(s).toContain("if v_conname is null then");
    expect(s).toContain("elsif v_confdeltype <> 'c' then");
    // Both branches converge to the exact same canonical definition.
    const canonicalCount = (
      s.match(/foreign key \(member_id\) references public\.profiles\(id\) on delete cascade/g) ?? []
    ).length;
    expect(canonicalCount).toBe(2); // once in the "absent" branch, once in the "wrong action" branch
  });

  it("is a no-op when the FK is already ON DELETE CASCADE (proof: no unconditional ADD/DROP for member_id's FK exists outside the guarded branches)", () => {
    const s = readMigration();
    const idx = s.indexOf("-- 1a. member_notes — member_id FK convergence");
    // Skip past this section's OWN closing "-- ═" border (immediately below
    // its title) to find the NEXT section's opening border as the true end.
    const ownClosingBorder = s.indexOf("-- ═", idx);
    const end = s.indexOf("-- ═", ownClosingBorder + 10);
    const block = s.slice(idx, end);
    // Every ADD/DROP CONSTRAINT touching member_id's FK is inside the two
    // conditional branches (if v_conname is null / elsif v_confdeltype <>
    // 'c'), never unconditional — confirmed structurally: the block's only
    // top-level statements outside the do $$ ... $$ body are the do-block
    // wrapper itself.
    const addCount = (block.match(/add constraint member_notes_member_id_fkey/g) ?? []).length;
    const dropCount = (block.match(/drop constraint %I/g) ?? []).length;
    expect(addCount).toBe(2);
    expect(dropCount).toBe(1); // only in the elsif (replace) branch
  });

  it("never uses CASCADE on the DROP statement itself — only as the target ON DELETE action being added", () => {
    const s = readMigration();
    // The exact DROP statement has no CASCADE keyword anywhere on its line.
    expect(s).toContain("execute format('alter table public.member_notes drop constraint %I', v_conname);");
    const dropLine = s
      .split("\n")
      .find((line) => line.includes("drop constraint %I', v_conname"));
    expect(dropLine).toBeDefined();
    expect(dropLine!.toLowerCase()).not.toContain("cascade");
  });

  it("never alters member_id's column value or type — only the FK constraint", () => {
    const s = readMigration();
    const idx = s.indexOf("-- 1a. member_notes — member_id FK convergence");
    const ownClosingBorder = s.indexOf("-- ═", idx);
    const end = s.indexOf("-- ═", ownClosingBorder + 10);
    const block = s.slice(idx, end);
    expect(block).not.toMatch(/update public\.member_notes/i);
    expect(block).not.toMatch(/alter column member_id/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Migration review correction 5 — the legacy CHECK-constraint cleanup is
// narrowed to a catalog-semantic fingerprint of 0075's specific check, not
// a blanket "drop everything not in this name list" loop.
// ─────────────────────────────────────────────────────────────────────────

describe("0211 — legacy CHECK constraint cleanup is narrowly scoped, not a blanket drop", () => {
  it("fingerprints the specific legacy expression (btrim + length) rather than dropping by exclusion alone", () => {
    const s = readMigration();
    expect(s).toContain("pg_get_constraintdef(con.oid)");
    // The migration's own regex literal, matched as a literal substring of
    // the SQL source (not re-interpreted as a JS regex here).
    expect(s).toContain("btrim\\s*\\(\\s*body\\s*\\)");
    expect(s).toContain("\\mlength\\s*\\(");
  });

  it("uses PostgreSQL's `\\m` (beginning-of-word) escape, never `\\b` (which PostgreSQL's ARE dialect treats as a literal BACKSPACE, not a word-boundary escape)", () => {
    const s = readMigration();
    const idx = s.indexOf("-- 2. member_notes — body CHECK constraints");
    const loopIdx = s.indexOf("for v_con in", idx);
    const loopEnd = s.indexOf("end loop;", loopIdx);
    const block = s.slice(idx, loopEnd);
    expect(block).toContain("\\mlength");
    expect(block).not.toContain("\\blength");
  });

  it("still excludes the two canonical names from the drop candidate set (belt-and-suspenders, not the sole filter)", () => {
    const s = readMigration();
    expect(s).toContain("con.conname not in ('member_notes_body_length', 'member_notes_body_nonempty')");
  });

  it("the cleanup loop's WHERE clause requires BOTH the exclusion list AND the expression fingerprint (an unrelated CHECK constraint matching only one condition is preserved)", () => {
    const s = readMigration();
    const idx = s.indexOf("-- 2. member_notes — body CHECK constraints");
    const loopIdx = s.indexOf("for v_con in", idx);
    const loopEnd = s.indexOf("end loop;", loopIdx);
    const block = s.slice(loopIdx, loopEnd);
    // All four predicates must be present in the same loop's WHERE clause.
    expect(block).toContain("con.contype = 'c'");
    expect(block).toContain("con.conname not in (");
    expect(block).toContain("~* 'btrim");
    expect(block).toContain("~* '\\mlength");
  });

  it("still guards the two canonical constraint ADDs unconditionally afterward", () => {
    const s = readMigration();
    expect(s).toContain("add constraint member_notes_body_nonempty check (char_length(trim(body)) > 0)");
    expect(s).toContain("add constraint member_notes_body_length check (char_length(body) <= 2000)");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Migration review corrections 3-4 — explicit ACL (public + anon) and
// explicit owner restatement for all three write RPCs.
// ─────────────────────────────────────────────────────────────────────────

describe("0211 — ACL explicitly revokes from public AND anon; owner explicitly restated for all three functions", () => {
  for (const [fn, args] of [
    ["add_member_note", "uuid, text"],
    ["update_member_note", "uuid, text"],
    ["archive_member_note", "uuid"],
  ] as const) {
    it(`${fn} explicitly revokes from public, anon (not just public)`, () => {
      const s = readMigration();
      expect(s).toContain(`revoke execute on function public.${fn}(${args}) from public, anon;`);
    });

    it(`${fn} explicitly restates OWNER TO postgres`, () => {
      const s = readMigration();
      expect(s).toContain(`alter function public.${fn}(${args}) owner to postgres;`);
    });
  }

  it("no function's grant statement broadens access beyond authenticated/service_role", () => {
    const s = readMigration();
    for (const fn of ["add_member_note", "update_member_note", "archive_member_note"]) {
      const grantLines = s
        .split("\n")
        .filter((line) => line.trim().startsWith("grant") && line.includes(`public.${fn}(`));
      for (const line of grantLines) {
        expect(line).toMatch(/to (authenticated|service_role);/);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 13-15. Function replacement strategy.
// ─────────────────────────────────────────────────────────────────────────

describe("0211 — function replacement strategy matches the specified DROP/CREATE vs CREATE OR REPLACE split", () => {
  it("add_member_note uses DROP FUNCTION ... RESTRICT then CREATE (not CREATE OR REPLACE)", () => {
    const s = readMigration();
    expect(s).toContain("drop function if exists public.add_member_note(uuid, text) restrict;");
    const dropIdx = s.indexOf("drop function if exists public.add_member_note(uuid, text) restrict;");
    const createIdx = s.indexOf("create function public.add_member_note(", dropIdx);
    expect(createIdx).toBeGreaterThan(dropIdx);
    expect(s).not.toContain("create or replace function public.add_member_note(");
  });

  it("update_member_note uses DROP FUNCTION ... RESTRICT then CREATE (not CREATE OR REPLACE)", () => {
    const s = readMigration();
    expect(s).toContain("drop function if exists public.update_member_note(uuid, text) restrict;");
    const dropIdx = s.indexOf("drop function if exists public.update_member_note(uuid, text) restrict;");
    const createIdx = s.indexOf("create function public.update_member_note(", dropIdx);
    expect(createIdx).toBeGreaterThan(dropIdx);
    expect(s).not.toContain("create or replace function public.update_member_note(");
  });

  it("archive_member_note uses CREATE OR REPLACE only — never dropped", () => {
    const s = readMigration();
    expect(s).toContain("create or replace function public.archive_member_note(");
    expect(s).not.toContain("drop function if exists public.archive_member_note");
  });

  it("neither DROP statement uses CASCADE — RESTRICT only", () => {
    const s = readMigration();
    expect(s).toContain("public.add_member_note(uuid, text) restrict;");
    expect(s).toContain("public.update_member_note(uuid, text) restrict;");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 16. Grants/security/search_path restored explicitly.
// ─────────────────────────────────────────────────────────────────────────

describe("0211 — grants, SECURITY DEFINER, search_path explicitly restated for all three functions", () => {
  for (const fn of ["add_member_note", "update_member_note", "archive_member_note"]) {
    it(`${fn} explicitly restates security definer + search_path + canonical grants`, () => {
      const s = readMigration();
      const fnIdx = s.indexOf(
        fn === "archive_member_note"
          ? `create or replace function public.${fn}(`
          : `create function public.${fn}(`,
      );
      expect(fnIdx).toBeGreaterThan(-1);
      const nextFnIdx = s.length;
      const grantSectionEnd = s.indexOf(
        fn === "add_member_note" ? "-- 6. update_member_note"
          : fn === "update_member_note" ? "-- 7. archive_member_note"
          : "-- 8. PostgREST schema cache",
        fnIdx,
      );
      const block = s.slice(fnIdx, grantSectionEnd > -1 ? grantSectionEnd : nextFnIdx);
      expect(block).toContain("security definer");
      expect(block).toContain("set search_path = public, pg_temp");
      expect(block).toContain(`revoke execute on function public.${fn}(`);
      expect(block).toContain(`grant  execute on function public.${fn}(`);
      expect(block).toMatch(new RegExp(`grant\\s+execute on function public\\.${fn}\\([^)]*\\) to authenticated;`));
      expect(block).toMatch(new RegExp(`grant\\s+execute on function public\\.${fn}\\([^)]*\\) to service_role;`));
    });
  }

  it("dropped-and-recreated functions have their owner explicitly restated to postgres (never relies on implicit CREATE-time ownership)", () => {
    const s = readMigration();
    expect(s).toContain("alter function public.add_member_note(uuid, text) owner to postgres;");
    expect(s).toContain("alter function public.update_member_note(uuid, text) owner to postgres;");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 19. get_member_notes is not redefined by 0211.
// ─────────────────────────────────────────────────────────────────────────

describe("0211 does not touch get_member_notes — migration 0132 already contains its canonical read contract", () => {
  it("0211's source contains no get_member_notes definition", () => {
    const s = readMigration();
    expect(s).not.toContain("function public.get_member_notes");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 20. The separate Member Activity/History `details` mismatch was
// deliberately NOT touched by THIS (Phase 45C1A) checkpoint — it was
// resolved later, by Phase 45C1B (see activityNormalization.regression.
// test.ts for that checkpoint's full coverage). This checkpoint's own
// scope discipline (0211 never touches either RPC) still holds and is
// still asserted below.
// ─────────────────────────────────────────────────────────────────────────

describe("the separate get_member_upcoming_activity/get_member_activity_history `details` mismatch — Phase 45C1A scope discipline, later resolved by Phase 45C1B", () => {
  it("types.ts no longer carries the full flat-shape compatibility overrides Phase 45C1A left in place — Phase 45C1B replaced them with a normalization adapter plus a narrow literal-union/nullability correction (see activityNormalization.regression.test.ts)", () => {
    const s = readSource(TYPES_PATH);
    expect(s).not.toContain("Phase 45C1B debt");
    // No FIELD named pro_first_name remains (an explanatory comment nearby
    // may still name it for historical context).
    expect(s).not.toMatch(/pro_first_name:\s*string/);
    expect(s).toContain("get_member_upcoming_activity: OverrideArrayReturns<");
    expect(s).toContain("get_member_activity_history: OverrideArrayReturns<");
  });

  it("0211 does not touch get_member_upcoming_activity or get_member_activity_history", () => {
    const s = readMigration();
    expect(s).not.toContain("get_member_upcoming_activity");
    expect(s).not.toContain("get_member_activity_history");
  });

  it("MemberDetailClient.tsx no longer reads the stale, never-real item.pro_first_name field — Phase 45C1B's normalization adapter now supplies item.pro_name instead", () => {
    const s = readSource(CLIENT_PATH);
    expect(s).not.toContain("item.pro_first_name");
    expect(s).toContain("item.pro_name");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// PostgREST schema cache reload.
// ─────────────────────────────────────────────────────────────────────────

describe("0211 explicitly reloads the PostgREST schema cache", () => {
  it("ends with a NOTIFY pgrst reload, since no prior migration establishes any such convention to reuse", () => {
    const s = readMigration();
    expect(s).toContain("NOTIFY pgrst, 'reload schema';");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Post-apply UX closeout polish — Member Notes action buttons reuse the
// established actionButtonStyles.ts vocabulary (already imported/used
// elsewhere in this same file for Lesson Pro Enable/Disable) instead of
// one-off bespoke classes, and "Remove" is relabeled "Archive" since
// archive_member_note never deletes the row — it only sets
// is_archived/archived_at/archived_by. Purely presentational: no handler,
// RPC, or state-management change.
// ─────────────────────────────────────────────────────────────────────────

describe("Member Notes action buttons — semantic hierarchy reuses actionButtonStyles.ts, no bespoke classes", () => {
  it("imports ACTION_BUTTON_SECONDARY_COMPACT alongside the already-imported PRIMARY_COMPACT/DESTRUCTIVE_COMPACT", () => {
    const s = readSource(CLIENT_PATH);
    expect(s).toContain(
      'import { ACTION_BUTTON_PRIMARY_COMPACT, ACTION_BUTTON_SECONDARY_COMPACT, ACTION_BUTTON_DESTRUCTIVE_COMPACT } from "@/components/styles/actionButtonStyles";',
    );
  });

  it("Add Note / Save use the shared PRIMARY_COMPACT style, not a bespoke bg-gray-900 pill", () => {
    const s = readSource(CLIENT_PATH);
    expect(s).not.toContain("bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-medium disabled:opacity-50");
    expect(s).toContain("className={`mt-2 ${ACTION_BUTTON_PRIMARY_COMPACT}`}");
    // Save (inside the edit form) also uses PRIMARY_COMPACT, not a bare
    // text-accent link.
    const saveIdx = s.indexOf("onClick={() => handleSaveEdit(note.id)}");
    expect(saveIdx).toBeGreaterThan(-1);
    // Fixed-length window, not indexOf(">", ...) — that would stop at the
    // arrow function's own `=>` rather than the JSX tag's closing `>`.
    const saveBlock = s.slice(saveIdx, saveIdx + 150);
    expect(saveBlock).toContain("className={ACTION_BUTTON_PRIMARY_COMPACT}");
  });

  it("Edit / Cancel use the shared SECONDARY_COMPACT style, not bare gray text links", () => {
    const s = readSource(CLIENT_PATH);
    expect(s).not.toContain('className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"');
    expect(s).not.toContain('className="text-xs text-gray-400"');

    const editIdx = s.indexOf("onClick={() => handleEditNote(note)}");
    expect(editIdx).toBeGreaterThan(-1);
    expect(s.slice(editIdx, editIdx + 150)).toContain("className={ACTION_BUTTON_SECONDARY_COMPACT}");

    const cancelIdx = s.indexOf('onClick={() => { setEditingNoteId(null); setEditContent(""); }}');
    expect(cancelIdx).toBeGreaterThan(-1);
    expect(s.slice(cancelIdx, cancelIdx + 150)).toContain("className={ACTION_BUTTON_SECONDARY_COMPACT}");
  });

  it("the archive action is labeled 'Archive', never 'Remove', and uses the shared DESTRUCTIVE_COMPACT style (Phase 45C1A2 routes it through a confirmation dialog first — see memberNoteArchiveLifecycleUx.regression.test.ts for that flow)", () => {
    const s = readSource(CLIENT_PATH);
    const archiveIdx = s.indexOf("onClick={() => setArchiveConfirmNoteId(note.id)}");
    expect(archiveIdx).toBeGreaterThan(-1);
    const block = s.slice(archiveIdx, s.indexOf("</button>", archiveIdx));
    expect(block).toContain("className={ACTION_BUTTON_DESTRUCTIVE_COMPACT}");
    expect(block).not.toContain("Remove");
    expect(block).not.toContain("Removing");
    // No bespoke red-text-link class remains anywhere in the file.
    expect(s).not.toContain('className="text-xs text-red-400 hover:text-red-600 dark:hover:text-red-300 disabled:opacity-40"');
  });

  it("handleArchiveNote still calls archiveMemberNoteAction (Phase 45C1A2 changed its success path from filtering the note out to updating it in place — see memberNoteArchiveLifecycleUx.regression.test.ts for full coverage of the new archive-lifecycle UX)", () => {
    const s = readSource(CLIENT_PATH);
    const idx = s.indexOf("function handleArchiveNote(noteId: string) {");
    expect(idx).toBeGreaterThan(-1);
    const block = s.slice(idx, s.indexOf("\n  function handleRestoreNote", idx));
    expect(block).toContain("archiveMemberNoteAction(noteId)");
  });

  it("no RPC call, server action import, or handler signature changed — only className/label JSX", () => {
    const actionsSrc = readSource(ACTIONS_PATH);
    // actions.ts (server actions + RPC calls) is completely untouched by
    // this checkpoint — confirmed by re-asserting its p_body contract is
    // still exactly as Phase 45C1A left it.
    expect(actionsSrc).toContain('p_body:      body,');
    expect(actionsSrc).toContain('p_body:    body,');

    const clientSrc = readSource(CLIENT_PATH);
    for (const handler of [
      "function handleAddNote()",
      "function handleEditNote(note: ClientNote)",
      "function handleSaveEdit(noteId: string)",
      "function handleArchiveNote(noteId: string)",
    ]) {
      expect(clientSrc).toContain(handler);
    }
  });
});
