import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 43B-2A — Guest Waiver Document Foundation. Backend only: widens
// waivers.audience's CHECK domain to include 'guest', and adds four new
// Guest-specific Admin authoring RPCs (create/update/publish_guest_
// waiver_version, set_guest_waiver_required) that mirror the existing,
// FROZEN Member RPCs (0192/0193/0194, untouched). No guest acceptance,
// no invitations, no tokens, no public routes, no reservation/event
// integration, no Settings UI in this checkpoint.
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

const MIGRATION_PATH = "supabase/migrations/0195_guest_waiver_document_foundation.sql";

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
// 1/2. Migration ordering — 0195 exists, no 0197+, 0192-0194 untouched
// ═══════════════════════════════════════════════════════════════════════════

describe("0195 — migration numbering and prior-migration immutability", () => {
  it("is the next migration after immutable 0194", () => {
    expect(() => readSource("supabase/migrations/0194_member_waiver_compliance_operations.sql")).not.toThrow();
    expect(() => readSource(MIGRATION_PATH)).not.toThrow();
  });

  // "no unauthorized 0197+ migration exists yet" was previously asserted
  // here as a hardcoded ceiling. Removed: that pattern cannot hold as an
  // evergreen invariant across later, unrelated checkpoints (0197 has
  // since been added by the Phase 43B-3F Member Waiver Notifications
  // checkpoint) — see topLevelBackLinkCleanup.regression.test.ts's own
  // note on this same cleanup, and memberWaiverNotifications.regression.
  // test.ts for 0197's own contract coverage.

  it("0192, 0193, and 0194 all still exist untouched", () => {
    expect(() => readSource("supabase/migrations/0192_member_waiver_foundation.sql")).not.toThrow();
    expect(() => readSource("supabase/migrations/0193_fix_member_waiver_status_accepted_at_ambiguity.sql")).not.toThrow();
    expect(() => readSource("supabase/migrations/0194_member_waiver_compliance_operations.sql")).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3/4/5/6. Schema widen — audience CHECK, default, unique, and every
//          other invariant preserved
// ═══════════════════════════════════════════════════════════════════════════

describe("0195 — waivers.audience CHECK widened to exactly member|guest, everything else preserved", () => {
  const sql = migrationSql();

  it("drops the exact auto-generated constraint name (waivers_audience_check), matching this repo's own established convention for widening an inline unnamed CHECK", () => {
    expect(sql).toContain("alter table public.waivers\n  drop constraint if exists waivers_audience_check;");
  });

  it("re-adds the CHECK as exactly audience in ('member', 'guest') — no third value, no removal of either", () => {
    expect(sql).toContain(
      "alter table public.waivers\n  add constraint waivers_audience_check\n  check (audience in ('member', 'guest'));",
    );
  });

  it("never touches NOT NULL or the 'member' column default — no ALTER COLUMN of any kind", () => {
    expect(sql).not.toMatch(/alter column audience/i);
  });

  it("never touches unique(club_id, audience) — no DROP/ADD CONSTRAINT referencing it anywhere (ordinary INSERT column lists like `(club_id, audience)` are expected and unrelated)", () => {
    expect(sql).not.toMatch(/constraint\s+\w*club_id_audience\w*/i);
    expect(sql).not.toMatch(/drop constraint[^;]*unique/i);
  });

  it("never recreates any table — no CREATE TABLE anywhere in this migration", () => {
    expect(sql).not.toMatch(/create table/i);
  });

  it("never backfills existing rows — no UPDATE public.waivers statement anywhere", () => {
    expect(sql).not.toMatch(/update public\.waivers\s+set\s+audience/i);
  });

  it("never touches the same-waiver composite FK (waivers_current_version_id_fkey), the one-draft partial unique index, the waiver_versions_id_waiver_id_uniq constraint, or the published-immutability trigger — all are audience-agnostic by construction and need no change", () => {
    expect(sql).not.toMatch(/waivers_current_version_id_fkey/);
    expect(sql).not.toMatch(/waiver_versions_one_draft_per_waiver/);
    expect(sql).not.toMatch(/waiver_versions_id_waiver_id_uniq/);
    expect(sql).not.toMatch(/_reject_published_waiver_version_mutation/);
  });

  it("never touches RLS — no CREATE POLICY, ALTER POLICY, or DROP POLICY anywhere", () => {
    expect(sql).not.toMatch(/create policy|alter policy|drop policy/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7/8/9/10. Exactly four new Guest RPCs, all Admin-only, no table grants
// ═══════════════════════════════════════════════════════════════════════════

describe("0195 — exactly four NEW Guest authoring RPCs (plus two hardened existing Member RPCs — six total), all Admin-only", () => {
  const sql = migrationSql();

  it("contains exactly six CREATE OR REPLACE FUNCTION statements — four new Guest RPCs plus the two hardened Member RPCs, NOT four", () => {
    expect((sql.match(/create or replace function/g) ?? []).length).toBe(6);
  });

  it("the four NEW functions are named exactly as locked: create/update/publish_guest_waiver_version, set_guest_waiver_required", () => {
    for (const name of [
      "create_guest_waiver_draft",
      "update_guest_waiver_draft",
      "publish_guest_waiver_version",
      "set_guest_waiver_required",
    ]) {
      expect(sql).toContain(`function public.${name}(`);
    }
  });

  it("every Guest RPC gates on v_role is distinct from 'admin' — Staff/Member/Pro all rejected by the same single check, no allowlist that could admit them", () => {
    for (const name of [
      "create_guest_waiver_draft",
      "update_guest_waiver_draft",
      "publish_guest_waiver_version",
      "set_guest_waiver_required",
    ]) {
      const fn = functionBody(sql, name);
      expect(fn).toContain("if v_role is distinct from 'admin' then raise exception 'insufficient_role'; end if;");
      expect(fn).not.toMatch(/'staff'|'pro'|'member'/);
    }
  });

  it("every Guest RPC is security definer, fixed search_path, and revoked from public/anon with an authenticated grant (internal role check is the real gate)", () => {
    for (const [name, sig] of [
      ["create_guest_waiver_draft", "text, text"],
      ["update_guest_waiver_draft", "uuid, text, text"],
      ["publish_guest_waiver_version", "uuid"],
      ["set_guest_waiver_required", "boolean"],
    ]) {
      const fn = functionBody(sql, name);
      expect(fn).toContain("security definer");
      expect(fn).toContain("set search_path = public, pg_temp");
      expect(sql).toContain(`revoke execute on function public.${name}(${sig}) from public, anon;`);
      expect(sql).toContain(`grant  execute on function public.${name}(${sig}) to authenticated;`);
    }
  });

  it("no direct table-write policy of any kind was added for any role — Staff gains no authoring or direct draft access", () => {
    expect(sql).not.toMatch(/grant (select|insert|update|delete) on/i);
    expect(sql).not.toMatch(/create policy/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 11/12/13. create_guest_waiver_draft — audience='guest', one draft, coexistence
// ═══════════════════════════════════════════════════════════════════════════

describe("0195 — create_guest_waiver_draft: audience='guest', one draft at a time, coexists with Member waiver", () => {
  const sql = migrationSql();
  const fn = functionBody(sql, "create_guest_waiver_draft");

  it("finds-or-creates the club's waivers row with audience='guest' specifically, never 'member'", () => {
    expect(fn).toContain("values (v_club_id, 'guest')");
    expect(fn).toContain("where club_id = v_club_id and audience = 'guest'");
    expect(fn).not.toMatch(/'member'/);
  });

  it("rejects a second Guest draft with the same draft_already_exists error the Member RPC uses", () => {
    expect(fn).toContain("raise exception 'draft_already_exists';");
  });

  it("computes version_number as max(existing)+1 scoped to this waiver_id, defaulting to 1 for a brand-new Guest waiver", () => {
    expect(fn).toContain("v_next_version_number := coalesce(\n    (select max(version_number) from public.waiver_versions where waiver_id = v_waiver.id),\n    0\n  ) + 1;");
  });

  it("creates only a DRAFT row — status='draft' on insert, never 'published'", () => {
    expect(fn).toContain("values (v_waiver.id, v_next_version_number, v_title, v_body, 'draft')");
  });

  it("returns the new version id (same contract shape as create_member_waiver_draft — returns uuid)", () => {
    expect(sql).toContain("create or replace function public.create_guest_waiver_draft(\n  p_title text,\n  p_body  text\n)\nreturns uuid");
    expect(fn).toContain("return v_new_version_id;");
  });

  it("validates non-blank title/body with the exact same trim/length-cap semantics as the Member flow (300/20000)", () => {
    expect(fn).toContain("if v_title is null then raise exception 'title_required'; end if;");
    expect(fn).toContain("if v_body  is null then raise exception 'body_required'; end if;");
    expect(fn).toContain("if length(v_title) > 300   then raise exception 'title_too_long'; end if;");
    expect(fn).toContain("if length(v_body)  > 20000 then raise exception 'body_too_long'; end if;");
  });

  it("never reads or writes the club's Member waivers row — only ever touches (club_id, 'guest')", () => {
    expect(fn).not.toMatch(/audience = 'member'/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 14/15/16. Cross-audience protections — update/publish cannot touch a
//           Member version, publish repoints only the Guest pointer
// ═══════════════════════════════════════════════════════════════════════════

describe("0195 — update_guest_waiver_draft: cannot mutate a Member-audience version", () => {
  const sql = migrationSql();
  const fn = functionBody(sql, "update_guest_waiver_draft");

  it("the version lookup requires w.audience = 'guest' — a Member waiver_version_id structurally fails to match (waiver_version_not_found), never reaching the UPDATE", () => {
    expect(fn).toContain("and w.audience = 'guest'");
    const lookupIdx = fn.indexOf("select v.* into v_version");
    const audienceIdx = fn.indexOf("and w.audience = 'guest'", lookupIdx);
    const notFoundIdx = fn.indexOf("if not found then raise exception 'waiver_version_not_found'; end if;", audienceIdx);
    expect(audienceIdx).toBeGreaterThan(lookupIdx);
    expect(notFoundIdx).toBeGreaterThan(audienceIdx);
  });

  it("still rejects a published version outright (version_not_editable) — published immutability enforced at the RPC level here too", () => {
    expect(fn).toContain("if v_version.status <> 'draft' then raise exception 'version_not_editable'; end if;");
  });

  it("exactly one UPDATE statement, reached only after both the audience gate and the draft-status gate", () => {
    expect((fn.match(/update public\.waiver_versions/g) ?? []).length).toBe(1);
  });
});

describe("0195 — publish_guest_waiver_version: cannot publish a Member version, repoints only the Guest pointer", () => {
  const sql = migrationSql();
  const fn = functionBody(sql, "publish_guest_waiver_version");

  it("the version lookup requires w.audience = 'guest' — a Member waiver_version_id is rejected as waiver_version_not_found", () => {
    expect(fn).toContain("and w.audience = 'guest'");
  });

  it("only a 'draft' version may be published (version_not_draft otherwise) — no unpublish, no silent re-publish", () => {
    expect(fn).toContain("if v_version.status <> 'draft' then raise exception 'version_not_draft'; end if;");
  });

  it("the waivers row repointed is v_version.waiver_id — since v_version was already scoped to audience='guest', this can only ever be the Guest waivers row, never Member's", () => {
    expect(fn).toContain("where id = v_version.waiver_id");
    expect(fn).toContain("set current_version_id = p_version_id");
  });

  it("sets status/published_at/published_by on the version, then repoints current_version_id, in that order, before the one audit_log insert — same atomicity as the Member RPC", () => {
    const versionUpdateIdx = fn.indexOf("update public.waiver_versions\n     set status       = 'published'");
    const waiverUpdateIdx = fn.indexOf("update public.waivers\n     set current_version_id = p_version_id");
    const auditIdx = fn.indexOf("insert into public.audit_log");
    expect(versionUpdateIdx).toBeGreaterThan(-1);
    expect(waiverUpdateIdx).toBeGreaterThan(versionUpdateIdx);
    expect(auditIdx).toBeGreaterThan(waiverUpdateIdx);
  });

  it("never sets status back to 'draft' — no unpublish path, no 'retired' state introduced anywhere", () => {
    expect(fn).not.toMatch(/set status\s*=\s*'draft'/);
    expect(sql).not.toMatch(/'retired'/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2-8, 13-15. Cross-audience hardening of the two existing Member RPCs —
// the correction this file exists to make: redefined in place (CREATE OR
// REPLACE, unchanged signature), with the ONLY behavioral delta in each
// being the added `and w.audience = 'member'` predicate.
// ═══════════════════════════════════════════════════════════════════════════

describe("0195 — update_member_waiver_draft and publish_member_waiver_version are redefined here (hardening, not a feature change)", () => {
  const sql = migrationSql();

  it("both functions are present in this file's CREATE OR REPLACE statements", () => {
    expect(sql).toContain("function public.update_member_waiver_draft(");
    expect(sql).toContain("function public.publish_member_waiver_version(");
  });

  it("each contains exactly one `and w.audience = 'member'` predicate — the single added line", () => {
    const updateFn = functionBody(sql, "update_member_waiver_draft");
    const publishFn = functionBody(sql, "publish_member_waiver_version");
    expect((updateFn.match(/and w\.audience = 'member'/g) ?? []).length).toBe(1);
    expect((publishFn.match(/and w\.audience = 'member'/g) ?? []).length).toBe(1);
  });

  it("the audience predicate sits inside the SAME version-lookup WHERE clause as w.club_id, immediately after it, before the FOR UPDATE lock — structurally identical placement to the Guest RPCs' own audience guard", () => {
    for (const name of ["update_member_waiver_draft", "publish_member_waiver_version"]) {
      const fn = functionBody(sql, name);
      expect(fn).toContain(
        "   where v.id = p_version_id\n     and w.club_id = v_club_id\n     and w.audience = 'member'\n     for update of v;",
      );
    }
  });

  it("a Member RPC given a GUEST version id is structurally rejected — the join predicate cannot match a row whose owning waivers row has audience='guest'", () => {
    const updateFn = functionBody(sql, "update_member_waiver_draft");
    const publishFn = functionBody(sql, "publish_member_waiver_version");
    expect(updateFn).toContain("if not found then raise exception 'waiver_version_not_found'; end if;");
    expect(publishFn).toContain("if not found then raise exception 'waiver_version_not_found'; end if;");
  });

  it("EVERYTHING besides the one added predicate is byte-identical to the exact 0192-applied bodies: same signature, same declare block, same error codes, same trim/length-cap validation, same no-op equality gate, same locking (FOR UPDATE OF v / FOR UPDATE), same publish ordering (version update -> waiver repoint -> audit), same audit action name/metadata shape", () => {
    const updateFn = functionBody(sql, "update_member_waiver_draft");
    expect(updateFn).toContain("returns void");
    expect(updateFn).toContain("if v_role is distinct from 'admin' then raise exception 'insufficient_role'; end if;");
    expect(updateFn).toContain("if v_version.status <> 'draft' then raise exception 'version_not_editable'; end if;");
    expect(updateFn).toContain("if length(v_title) > 300   then raise exception 'title_too_long'; end if;");
    expect(updateFn).toContain("if length(v_body)  > 20000 then raise exception 'body_too_long'; end if;");
    expect(updateFn).toContain("if v_version.title is not distinct from v_title\n     and v_version.body is not distinct from v_body then\n    return;\n  end if;");
    expect(updateFn).toContain("'update_member_waiver_draft', 'waiver_version', p_version_id,");
    expect((updateFn.match(/insert into public\.audit_log/g) ?? []).length).toBe(1);

    const publishFn = functionBody(sql, "publish_member_waiver_version");
    expect(publishFn).toContain("returns void");
    expect(publishFn).toContain("if v_role is distinct from 'admin' then raise exception 'insufficient_role'; end if;");
    expect(publishFn).toContain("if v_version.status <> 'draft' then raise exception 'version_not_draft'; end if;");
    const versionUpdateIdx = publishFn.indexOf("update public.waiver_versions\n     set status       = 'published'");
    const waiverUpdateIdx = publishFn.indexOf("update public.waivers\n     set current_version_id = p_version_id");
    const auditIdx = publishFn.indexOf("insert into public.audit_log");
    expect(versionUpdateIdx).toBeGreaterThan(-1);
    expect(waiverUpdateIdx).toBeGreaterThan(versionUpdateIdx);
    expect(auditIdx).toBeGreaterThan(waiverUpdateIdx);
    expect(publishFn).toContain("'publish_member_waiver_version', 'waiver_version', p_version_id,");
  });

  it("signatures are byte-identical to 0192 — same argument names/types/order, same RETURNS — so no privilege was widened", () => {
    expect(sql).toContain(
      "create or replace function public.update_member_waiver_draft(\n  p_version_id uuid,\n  p_title      text,\n  p_body       text\n)\nreturns void",
    );
    expect(sql).toContain(
      "create or replace function public.publish_member_waiver_version(\n  p_version_id uuid\n)\nreturns void",
    );
  });

  it("no REVOKE/GRANT is reissued for either function — CREATE OR REPLACE on an unchanged signature preserves the existing 0192 grants automatically (same precedent as 0193's own accepted_at fix)", () => {
    expect(sql).not.toMatch(/revoke execute on function public\.update_member_waiver_draft/);
    expect(sql).not.toMatch(/grant  execute on function public\.update_member_waiver_draft/);
    expect(sql).not.toMatch(/revoke execute on function public\.publish_member_waiver_version/);
    expect(sql).not.toMatch(/grant  execute on function public\.publish_member_waiver_version/);
  });

  it("this is the exact, verified 0192-applied text for both functions (spot-check against the immutable 0192 file itself) — the hardening did not drift beyond the one predicate", () => {
    const s0192 = codeOnly(readSource("supabase/migrations/0192_member_waiver_foundation.sql"));
    const applied0192Update = functionBody(s0192, "update_member_waiver_draft");
    const applied0192Publish = functionBody(s0192, "publish_member_waiver_version");
    const hardenedUpdate = functionBody(sql, "update_member_waiver_draft")
      .replace("\n     and w.audience = 'member'", "");
    const hardenedPublish = functionBody(sql, "publish_member_waiver_version")
      .replace("\n     and w.audience = 'member'", "");
    expect(hardenedUpdate).toBe(applied0192Update);
    expect(hardenedPublish).toBe(applied0192Publish);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5/6/7/8. Two-way cross-audience rejection — both Member and Guest RPCs
// reject the other audience's version id
// ═══════════════════════════════════════════════════════════════════════════

describe("0195 — two-way cross-audience protection: Member RPC + Guest version, Guest RPC + Member version, both directions rejected identically", () => {
  const sql = migrationSql();

  it("update_member_waiver_draft rejects a Guest version id (structurally, via the audience predicate) exactly the same way update_guest_waiver_draft rejects a Member version id", () => {
    const memberUpdate = functionBody(sql, "update_member_waiver_draft");
    const guestUpdate = functionBody(sql, "update_guest_waiver_draft");
    expect(memberUpdate).toContain("and w.audience = 'member'");
    expect(guestUpdate).toContain("and w.audience = 'guest'");
    expect(memberUpdate).toContain("if not found then raise exception 'waiver_version_not_found'; end if;");
    expect(guestUpdate).toContain("if not found then raise exception 'waiver_version_not_found'; end if;");
  });

  it("publish_member_waiver_version rejects a Guest version id exactly the same way publish_guest_waiver_version rejects a Member version id", () => {
    const memberPublish = functionBody(sql, "publish_member_waiver_version");
    const guestPublish = functionBody(sql, "publish_guest_waiver_version");
    expect(memberPublish).toContain("and w.audience = 'member'");
    expect(guestPublish).toContain("and w.audience = 'guest'");
    expect(memberPublish).toContain("if not found then raise exception 'waiver_version_not_found'; end if;");
    expect(guestPublish).toContain("if not found then raise exception 'waiver_version_not_found'; end if;");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 17. Published immutability remains DB-enforced (unchanged trigger)
// ═══════════════════════════════════════════════════════════════════════════

describe("0195 — published immutability stays DB-enforced by the unchanged 0192 trigger", () => {
  const sql = migrationSql();

  it("this migration defines no new trigger and does not redefine _reject_published_waiver_version_mutation — the existing BEFORE UPDATE OR DELETE trigger on waiver_versions already covers Guest rows automatically (it is not audience-scoped)", () => {
    expect(sql).not.toMatch(/create trigger/i);
    expect(sql).not.toMatch(/create or replace function public\._reject_published_waiver_version_mutation/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 18/19. set_guest_waiver_required — Guest row only, history preserved
// ═══════════════════════════════════════════════════════════════════════════

describe("0195 — set_guest_waiver_required: Guest row only, disable/re-enable preserves history", () => {
  const sql = migrationSql();
  const fn = functionBody(sql, "set_guest_waiver_required");

  it("scopes its read/write to (club_id, audience='guest') only", () => {
    expect(fn).toContain("where club_id = v_club_id and audience = 'guest'");
  });

  it("touches only waivers.is_required — never waiver_versions or waiver_acceptances, never current_version_id", () => {
    expect(fn).not.toMatch(/waiver_versions|waiver_acceptances/);
    expect(fn).not.toMatch(/current_version_id/);
  });

  it("fails closed when no Guest waiver document exists yet (waiver_not_found)", () => {
    expect(fn).toContain("if not found then raise exception 'waiver_not_found'; end if;");
  });

  it("no-ops cleanly when already at the requested value (null-safe is not distinct from)", () => {
    expect(fn).toContain("if v_waiver.is_required is not distinct from p_required then return; end if;");
  });

  it("rejects a null flag explicitly", () => {
    expect(fn).toContain("if p_required is null then raise exception 'required_flag_required'; end if;");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 20/21. Distinct Guest audit action names, no body in metadata
// ═══════════════════════════════════════════════════════════════════════════

describe("0195 — audit log: distinct Guest action names, no body text ever stored", () => {
  const sql = migrationSql();

  it("uses exactly the four locked Guest action names, each spelled distinctly from its Member counterpart (create_member_waiver_draft and set_member_waiver_required legitimately do NOT appear anywhere in this file — those two RPCs are not redefined here; update_member_waiver_draft/publish_member_waiver_version DO legitimately appear, once each, as their own unchanged audit action names inside the two hardened Member RPCs — see the dedicated hardening describe block for that)", () => {
    for (const action of [
      "create_guest_waiver_draft",
      "update_guest_waiver_draft",
      "publish_guest_waiver_version",
      "set_guest_waiver_required",
    ]) {
      expect(sql).toContain(`'${action}'`);
    }
    // The two RPCs genuinely NOT redefined in this file must still have no
    // trace of their action names here.
    expect(sql).not.toMatch(/'create_member_waiver_draft'|'set_member_waiver_required'/);
  });

  it("no audit_log metadata block ever contains a bare v_title/v_body/title/body value — only lengths, ids, and version numbers", () => {
    const metadataBlocks = sql.match(/jsonb_build_object\(([\s\S]*?)\)/g) ?? [];
    expect(metadataBlocks.length).toBeGreaterThan(0);
    for (const block of metadataBlocks) {
      expect(block).not.toMatch(/,\s*v_title,/);
      expect(block).not.toMatch(/,\s*v_body,/);
    }
  });

  it("each Guest authoring RPC writes exactly one audit_log row on a genuine mutation", () => {
    for (const name of [
      "create_guest_waiver_draft",
      "update_guest_waiver_draft",
      "publish_guest_waiver_version",
      "set_guest_waiver_required",
    ]) {
      const fn = functionBody(sql, name);
      expect((fn.match(/insert into public\.audit_log/g) ?? []).length).toBe(1);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 22/23/24/25. Everything else frozen/absent
// ═══════════════════════════════════════════════════════════════════════════

describe("0195 — scope guard: Member RPCs frozen, waiver_acceptances untouched, no invitation/token/reservation-event work", () => {
  const sql = migrationSql();

  it("never redefines SEVEN of the nine existing Member waiver RPCs/evaluator — those remain completely absent from this file's CREATE statements (update_member_waiver_draft and publish_member_waiver_version are the two deliberate, documented exceptions — see the dedicated hardening describe block below)", () => {
    for (const name of [
      "create_member_waiver_draft",
      "set_member_waiver_required",
      "accept_member_waiver",
      "get_my_member_waiver_status",
      "get_member_waiver_status",
      "get_club_member_waiver_compliance",
      "_evaluate_member_waiver_status",
    ]) {
      expect(sql).not.toContain(`function public.${name}(`);
    }
  });

  it("never references waiver_acceptances anywhere — Guest acceptance is explicitly a later checkpoint and must not reuse it", () => {
    expect(sql).not.toMatch(/waiver_acceptances/);
  });

  it("no invitation/token/bearer/public-route work of any kind", () => {
    expect(sql).not.toMatch(/invitation|token_hash|bearer|createPrivilegedClient|anon\)/i);
  });

  it("no reservation_guests, event_guests, or guest_names schema work — this migration touches only waivers/waiver_versions and four new functions", () => {
    expect(sql).not.toMatch(/reservation_guests|event_guests|guest_names/);
  });

  it("no rich text, PDF, e-sign, expiration, or minors/guardian work referenced", () => {
    expect(sql).not.toMatch(/pdf|docusign|e-sign|esign|expiration|guardian|minor/i);
  });
});
