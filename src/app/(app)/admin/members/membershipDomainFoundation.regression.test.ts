import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 42A — regression coverage for the membership domain foundation:
// roster_members.membership_status (a second, independent lifecycle axis
// from the existing roster_members.status), the club-configurable
// membership_types table, the canonical role-agnostic active-Member
// predicate (is_active_club_member), and the five new Admin RPCs.
//
// Same source-inspection style as cancellationPolicy.regression.test.ts /
// policyAwareCancellationRefunds.regression.test.ts — no live Postgres in
// this repo, so the shipped migration text is the honest thing to assert
// against. Migration 0188 is NOT applied to any database by this
// checkpoint; these tests only prove the SQL takes the shape the audit
// requires.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !line.trim().startsWith("--") && !line.trim().startsWith("//"))
    .join("\n");
}

const MIGRATION_PATH = "supabase/migrations/0188_membership_domain_foundation.sql";
const LIFECYCLE_MIGRATION_PATH =
  "supabase/migrations/0117_durable_member_guest_lifecycle_and_attendance.sql";

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
// A. Migration ordering / immutability
// ═══════════════════════════════════════════════════════════════════════════

describe("0188 — migration numbering", () => {
  it("is the next migration after immutable 0187, and no 0189+ migration exists yet", () => {
    expect(() => readSource("supabase/migrations/0187_member_cancellation_policy_preview.sql")).not.toThrow();
    expect(() => readSource(MIGRATION_PATH)).not.toThrow();

    const files = readdirSync(join(process.cwd(), "supabase/migrations"));
    const laterMigrations = files.filter((f) => {
      const match = f.match(/^(\d{4})_/);
      return match !== null && Number(match[1]) > 188;
    });
    expect(laterMigrations).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. roster_members.membership_status — schema + backfill
// ═══════════════════════════════════════════════════════════════════════════

describe("0188 — membership_status schema and backfill", () => {
  const sql = migrationSql();

  it("adds membership_status nullable before backfilling, then locks it NOT NULL with a default and a four-value CHECK", () => {
    expect(sql).toMatch(
      /alter table public\.roster_members\s*\n\s*add column membership_status text;/,
    );
    expect(sql).toMatch(
      /alter column membership_status set default 'active',\s*\n\s*alter column membership_status set not null;/,
    );
    expect(sql).toMatch(
      /add constraint roster_members_membership_status_check\s*\n\s*check \(membership_status in \('active', 'inactive', 'suspended', 'non_member'\)\);/,
    );
  });

  it("backfills membership_status strictly from the existing status column — active/active, everything else/inactive", () => {
    expect(sql).toMatch(
      /update public\.roster_members\s*\n\s*set membership_status = case when status = 'active' then 'active' else 'inactive' end;/,
    );
  });

  it("never writes 'suspended' or 'non_member' during backfill (no fabricated membership state)", () => {
    const backfillStart = sql.indexOf("update public.roster_members\n   set membership_status");
    const backfillEnd = sql.indexOf(";", backfillStart);
    const backfillStatement = sql.slice(backfillStart, backfillEnd);
    expect(backfillStatement).not.toMatch(/suspended|non_member/);
  });

  it("does not alter the meaning, storage, or CHECK of the existing roster_members.status column", () => {
    expect(sql).not.toMatch(/alter table public\.roster_members[\s\S]{0,80}drop column status\b/);
    expect(sql).not.toMatch(/roster_members_status_check/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. membership_types — schema, uniqueness, RLS
// ═══════════════════════════════════════════════════════════════════════════

describe("0188 — membership_types table", () => {
  const sql = migrationSql();

  it("is club-scoped, soft-lifecycle (is_active), with no hard-coded category values", () => {
    expect(sql).toMatch(/create table public\.membership_types \(/);
    expect(sql).toMatch(/club_id\s+uuid\s+not null references public\.clubs\(id\) on delete cascade/);
    expect(sql).toMatch(/is_active\s+boolean\s+not null default true/);
    expect(sql).not.toMatch(/'Adult'|'Junior'|'Senior'|'Family'|'Social'|'Student'/);
  });

  it("carries a composite (id, club_id) uniqueness target for the same-club FK", () => {
    expect(sql).toMatch(/constraint membership_types_id_club_uniq unique \(id, club_id\)/);
  });

  it("enforces case-insensitive, trimmed uniqueness per club via a normalized expression index", () => {
    expect(sql).toMatch(
      /create unique index membership_types_club_name_uniq\s*\n\s*on public\.membership_types \(club_id, lower\(btrim\(name\)\)\);/,
    );
  });

  it("enables RLS with admin-only, same-club select/insert/update policies and no delete policy", () => {
    expect(sql).toMatch(/alter table public\.membership_types enable row level security;/);
    expect(sql).toMatch(
      /create policy "membership_types_select_admin"\s*\n\s*on public\.membership_types for select\s*\n\s*using \(\s*\n\s*club_id = current_user_club_id\(\)\s*\n\s*and current_user_role\(\) = 'admin'\s*\n\s*\);/,
    );
    expect(sql).toMatch(/create policy "membership_types_insert_admin"/);
    expect(sql).toMatch(/create policy "membership_types_update_admin"/);
    expect(sql).not.toMatch(/create policy "membership_types_delete/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D. roster_members.membership_type_id — optional, same-club FK
// ═══════════════════════════════════════════════════════════════════════════

describe("0188 — roster_members.membership_type_id", () => {
  const sql = migrationSql();

  it("is a nullable column (membership is never required to have a type)", () => {
    expect(sql).toMatch(
      /alter table public\.roster_members\s*\n\s*add column membership_type_id uuid;/,
    );
  });

  it("enforces same-club assignment via a composite FK against membership_types(id, club_id)", () => {
    expect(sql).toMatch(
      /add constraint roster_members_membership_type_club_fkey\s*\n\s*foreign key \(membership_type_id, club_id\)\s*\n\s*references public\.membership_types \(id, club_id\);/,
    );
  });

  it("does not use ON DELETE SET NULL on the composite FK (would attempt to null the NOT NULL club_id column)", () => {
    const fkStart = sql.indexOf("add constraint roster_members_membership_type_club_fkey");
    const fkEnd = sql.indexOf(";", fkStart);
    expect(sql.slice(fkStart, fkEnd)).not.toMatch(/on delete set null/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// E. is_active_club_member — canonical predicate
// ═══════════════════════════════════════════════════════════════════════════

describe("0188 — is_active_club_member canonical predicate", () => {
  const sql = migrationSql();
  const body = functionBody(sql, "is_active_club_member");

  it("requires BOTH roster_members.status = 'active' AND membership_status = 'active'", () => {
    expect(body).toMatch(/rm\.status\s*=\s*'active'/);
    expect(body).toMatch(/rm\.membership_status\s*=\s*'active'/);
  });

  it("validates club scope explicitly via p_club_id, not just p_roster_member_id", () => {
    expect(body).toMatch(/rm\.club_id\s*=\s*p_club_id/);
  });

  it("never references role (role-agnostic by construction)", () => {
    expect(body).not.toMatch(/role/);
  });

  it("is revoked from public, anon, AND authenticated — not a client-callable RPC", () => {
    expect(sql).toMatch(
      /revoke execute on function public\.is_active_club_member\(uuid, uuid\) from public, anon, authenticated;/,
    );
    expect(sql).not.toMatch(
      /grant\s+execute on function public\.is_active_club_member\(uuid, uuid\) to authenticated;/,
    );
  });

  it("is named distinctly from Phase 41's v_is_member_by_history/v_is_member_by_roster identity-match variables", () => {
    expect(body).not.toMatch(/v_is_member_by_history|v_is_member_by_roster/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F. Admin RPCs — membership_types CRUD
// ═══════════════════════════════════════════════════════════════════════════

describe("0188 — create_membership_type / update_membership_type / set_membership_type_active", () => {
  const sql = migrationSql();

  it("create_membership_type is admin-gated via current_user_role(), same-club via current_user_club_id(), and rejects a case-insensitive/trimmed duplicate", () => {
    const body = functionBody(sql, "create_membership_type");
    expect(body).toMatch(/if v_role is distinct from 'admin' then\s*\n\s*raise exception 'insufficient_role';/);
    expect(body).toMatch(/where club_id = v_club_id\s*\n\s*and lower\(name\) = lower\(v_name\);/);
    expect(body).toMatch(/raise exception 'membership_type_name_taken';/);
    expect(body).toMatch(/insert into public\.membership_types \(club_id, name\)/);
  });

  it("update_membership_type is scoped to the caller's club and excludes self from the duplicate check", () => {
    const body = functionBody(sql, "update_membership_type");
    expect(body).toMatch(/where id = p_id and club_id = v_club_id;/);
    expect(body).toMatch(/and id <> p_id;/);
  });

  it("set_membership_type_active only ever updates membership_types, never roster_members (deactivation preserves existing assignments)", () => {
    const body = functionBody(sql, "set_membership_type_active");
    expect(body).toMatch(/update public\.membership_types\s*\n\s*set is_active = p_is_active/);
    expect(body).not.toMatch(/update public\.roster_members/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// G. Admin RPCs — roster membership assignment
// ═══════════════════════════════════════════════════════════════════════════

describe("0188 — set_roster_member_membership_type", () => {
  const sql = migrationSql();
  const body = functionBody(sql, "set_roster_member_membership_type");

  it("scopes both the roster row and the membership type lookup to the caller's club (cross-club rejected)", () => {
    expect(body).toMatch(
      /from public\.roster_members\s*\n\s*where id = p_roster_member_id and club_id = v_club_id\s*\n\s*for update;/,
    );
    expect(body).toMatch(
      /from public\.membership_types\s*\n\s*where id = p_membership_type_id and club_id = v_club_id\s*\n\s*for share;/,
    );
  });

  it("rejects assigning an inactive type UNLESS it is the roster member's already-current type (no-op)", () => {
    expect(body).toMatch(
      /if not v_type\.is_active and p_membership_type_id is distinct from v_roster\.membership_type_id then/,
    );
    expect(body).toMatch(/raise exception 'membership_type_inactive';/);
  });

  it("allows clearing to NULL unconditionally", () => {
    expect(body).toMatch(/p_membership_type_id\s+uuid\s+default null/);
    expect(body).toMatch(/if p_membership_type_id is not null then/);
  });

  it("updates only membership_type_id, never status or membership_status", () => {
    expect(body).toMatch(/set membership_type_id = p_membership_type_id/);
    expect(body).not.toMatch(/set[^;]*\bstatus\s*=/);
    expect(body).not.toMatch(/set[^;]*membership_status\s*=/);
  });

  // ─── Final concurrency correction: stale roster snapshot ────────────────
  // The roster row is now locked FOR UPDATE unconditionally (BEFORE the
  // p_membership_type_id is-not-null branch), so v_roster.membership_type_id
  // — the value the inactive/no-op comparison and the audit "old" value both
  // rely on — can never go stale between being read and the final UPDATE.
  it("locks the roster row FOR UPDATE unconditionally, strictly before auth resolution's v_role/v_club_id are used for any lookup and before the membership-type branch", () => {
    const authGatePos = body.indexOf("raise exception 'insufficient_role';");
    const rosterLockSelectPos = body.indexOf("from public.roster_members");
    const rosterLockPos = body.indexOf("for update;");
    const notNullBranchStart = body.indexOf("if p_membership_type_id is not null then");

    expect(authGatePos).toBeGreaterThan(-1);
    expect(rosterLockSelectPos).toBeGreaterThan(authGatePos);
    expect(rosterLockPos).toBeGreaterThan(rosterLockSelectPos);
    // The roster FOR UPDATE lock is unconditional — acquired before the
    // p_membership_type_id branch even begins, so it is taken whether the
    // call is clearing to NULL or assigning a type.
    expect(notNullBranchStart).toBeGreaterThan(rosterLockPos);
  });

  it("locks the membership_types row FOR SHARE, inside the p_membership_type_id is not null branch, strictly AFTER the roster FOR UPDATE lock and before relying on is_active", () => {
    const rosterLockPos = body.indexOf("for update;");
    const notNullBranchStart = body.indexOf("if p_membership_type_id is not null then");
    expect(notNullBranchStart).toBeGreaterThan(rosterLockPos);

    const typeLockPos = body.indexOf("for share;", notNullBranchStart);
    const isActiveCheckPos = body.indexOf("v_type.is_active", notNullBranchStart);

    expect(typeLockPos).toBeGreaterThan(notNullBranchStart);
    expect(isActiveCheckPos).toBeGreaterThan(notNullBranchStart);
    // The type lock must be acquired strictly after the roster lock (the
    // final, authoritative lock order: roster_members FOR UPDATE, then
    // membership_types FOR SHARE).
    expect(typeLockPos).toBeGreaterThan(rosterLockPos);
    // And the is_active check must come after its own protecting lock.
    expect(isActiveCheckPos).toBeGreaterThan(typeLockPos);
  });

  it("the inactive/no-op comparison and the audit 'old' value both read v_roster.membership_type_id — the FOR UPDATE-locked snapshot, never re-queried after the lock is taken", () => {
    // No second SELECT of roster_members exists anywhere in this function
    // after the initial FOR UPDATE lock — v_roster is the single, stable,
    // pre-mutation snapshot used throughout.
    const selectRosterOccurrences = (body.match(/from public\.roster_members/g) ?? []).length;
    expect(selectRosterOccurrences).toBe(1);

    expect(body).toMatch(/is distinct from v_roster\.membership_type_id/);
    expect(body).toMatch(/'old_membership_type_id',\s*v_roster\.membership_type_id/);
  });

  it("takes the roster FOR UPDATE lock even when clearing membership_type_id to NULL (only the membership_types FOR SHARE lock is conditional)", () => {
    const rosterLockPos = body.indexOf("for update;");
    const notNullBranchStart = body.indexOf("if p_membership_type_id is not null then");
    // The roster lock is unconditional: it appears BEFORE the only branch
    // that depends on p_membership_type_id, so a NULL call still takes it.
    expect(rosterLockPos).toBeGreaterThan(-1);
    expect(rosterLockPos).toBeLessThan(notNullBranchStart);
  });

  it("uses FOR SHARE (not FOR UPDATE) for the membership_types row — concurrent assignments of the same still-active type, against different roster members, must coexist", () => {
    const typeSelectStart = body.indexOf("from public.membership_types");
    const typeLockClause = body.slice(typeSelectStart, body.indexOf(";", typeSelectStart) + 1);
    expect(typeLockClause).toMatch(/for share;/);
    expect(typeLockClause).not.toMatch(/for update/);
  });
});

describe("0188 — set_roster_member_membership_status", () => {
  const sql = migrationSql();
  const body = functionBody(sql, "set_roster_member_membership_status");

  it("validates against the exact four allowed values and rejects anything else", () => {
    expect(body).toMatch(
      /or p_membership_status not in \('active', 'inactive', 'suspended', 'non_member'\) then/,
    );
    expect(body).toMatch(/raise exception 'invalid_membership_status';/);
  });

  // ─── Correction 2: NULL-safe status validation ───────────────────────────
  it("explicitly rejects NULL before the IN-list check (`x not in (...)` is NULL, not TRUE, when x is NULL)", () => {
    expect(body).toMatch(
      /if p_membership_status is null\s*\n\s*or p_membership_status not in \('active', 'inactive', 'suspended', 'non_member'\) then\s*\n\s*raise exception 'invalid_membership_status';/,
    );
  });

  it("is admin-gated via current_user_role() and same-club scoped via current_user_club_id()", () => {
    expect(body).toMatch(/if v_role is distinct from 'admin' then\s*\n\s*raise exception 'insufficient_role';/);
    expect(body).toMatch(/where id = p_roster_member_id and club_id = v_club_id;/);
  });

  it("writes ONLY membership_status — never roster_members.status", () => {
    const updateStart = body.indexOf("update public.roster_members");
    const updateEnd = body.indexOf("where id", updateStart);
    const setClause = body.slice(updateStart, updateEnd);
    expect(setClause).toMatch(/membership_status\s*=\s*p_membership_status/);
    expect(setClause).not.toMatch(/(?<!membership_)status\s*=\s*(?!p_membership_status)/);
  });

  it("uses a fail-closed exactly-one-row guard", () => {
    expect(body).toMatch(/get diagnostics v_rows_updated = row_count;/);
    expect(body).toMatch(/if v_rows_updated <> 1 then raise exception 'roster_member_update_failed'; end if;/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// G2. Correction 1 — canonical active-club authorization pattern
// ═══════════════════════════════════════════════════════════════════════════

describe("0188 — every privileged RPC uses the canonical current_user_club_id()/current_user_role() pattern", () => {
  const sql = migrationSql();
  const rpcNames = [
    "create_membership_type",
    "update_membership_type",
    "set_membership_type_active",
    "set_roster_member_membership_type",
    "set_roster_member_membership_status",
  ];

  it.each(rpcNames)("%s never references profiles.role or profiles.club_id for authorization or scoping", (name) => {
    const body = functionBody(sql, name);
    expect(body, `${name} must not read v_profile.role`).not.toMatch(/v_profile\.role/);
    expect(body, `${name} must not read v_profile.club_id`).not.toMatch(/v_profile\.club_id/);
    expect(body, `${name} must not select from profiles directly`).not.toMatch(/from public\.profiles|from profiles\b/);
    expect(body, `${name} must not declare a profiles%rowtype`).not.toMatch(/profiles%rowtype/);
  });

  it.each(rpcNames)("%s uses the exact null-safe not_authenticated / current_user_* / insufficient_role sequence", (name) => {
    const body = functionBody(sql, name);
    expect(body).toMatch(
      /if auth\.uid\(\) is null then\s*\n\s*raise exception 'not_authenticated';\s*\n\s*end if;/,
    );
    expect(body).toMatch(
      /select\s*\n\s*public\.current_user_club_id\(\),\s*\n\s*public\.current_user_role\(\)\s*\n\s*into\s*\n\s*v_club_id,\s*\n\s*v_role;/,
    );
    expect(body).toMatch(
      /if v_role is distinct from 'admin' then\s*\n\s*raise exception 'insufficient_role';\s*\n\s*end if;/,
    );
  });

  it.each(rpcNames)("%s scopes every audit_log write to v_club_id, not any profiles-derived value", (name) => {
    const body = functionBody(sql, name);
    const auditStart = body.indexOf("insert into public.audit_log");
    expect(auditStart, `${name} must write an audit_log entry`).toBeGreaterThanOrEqual(0);
    const auditCall = body.slice(auditStart, body.indexOf(");", auditStart) + 2);
    expect(auditCall).toMatch(/values\s*\(\s*\n\s*v_club_id,/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// G3. Final lock-order finding across the whole migration: the authoritative
//     order for the one function that touches both tables is
//     roster_members (FOR UPDATE) -> membership_types (FOR SHARE). No other
//     function in 0188 ever acquires a lock on membership_types and then
//     later needs one on roster_members (or vice versa in any conflicting
//     shape), so no reverse-order path exists anywhere in 0188 for these two
//     tables to deadlock against each other.
// ═══════════════════════════════════════════════════════════════════════════

describe("0188 — lock-order finding: no reverse-order path between roster_members and membership_types", () => {
  const sql = migrationSql();

  it("set_membership_type_active only ever touches membership_types (never roster_members)", () => {
    const body = functionBody(sql, "set_membership_type_active");
    expect(body).not.toMatch(/roster_members/);
  });

  it("set_roster_member_membership_status only ever touches roster_members (never membership_types)", () => {
    const body = functionBody(sql, "set_roster_member_membership_status");
    expect(body).not.toMatch(/membership_types/);
  });

  it("create_membership_type and update_membership_type only ever touch membership_types (never roster_members)", () => {
    for (const name of ["create_membership_type", "update_membership_type"]) {
      const body = functionBody(sql, name);
      expect(body, `${name} must not reference roster_members`).not.toMatch(/roster_members/);
    }
  });

  it("set_roster_member_membership_type is the ONLY function touching both tables, and always locks roster_members FOR UPDATE strictly before membership_types FOR SHARE", () => {
    const body = functionBody(sql, "set_roster_member_membership_type");
    const rosterLockPos = body.indexOf("for update;");
    const membershipTypesLockPos = body.indexOf("for share;");
    expect(rosterLockPos).toBeGreaterThan(-1);
    expect(membershipTypesLockPos).toBeGreaterThan(-1);
    expect(membershipTypesLockPos).toBeGreaterThan(rosterLockPos);
  });

  it("no function in 0188 acquires a membership_types lock/UPDATE and only later touches roster_members (the reverse order)", () => {
    // set_membership_type_active is membership_types-only (asserted above),
    // so it never reaches roster_members at all after its own UPDATE — the
    // one shape that would establish a genuine reverse order. Re-asserted
    // here directly against the function this finding is about, rather than
    // inferred from the earlier isolated assertion.
    const body = functionBody(sql, "set_membership_type_active");
    const updatePos = body.indexOf("update public.membership_types");
    expect(updatePos).toBeGreaterThan(-1);
    expect(body.slice(updatePos)).not.toMatch(/roster_members/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// H. Non-regression — roster lifecycle functions are untouched
// ═══════════════════════════════════════════════════════════════════════════

describe("0188 — non-regression: roster lifecycle functions are not redefined", () => {
  const sql = migrationSql();
  const lifecycleFunctions = [
    "set_member_status",
    "remove_club_member",
    "restore_club_member",
    "remove_roster_member",
    "restore_roster_member",
  ];

  it.each(lifecycleFunctions)(
    "0188 does not contain a redefinition of %s (roster_members.status ownership stays exactly where it was)",
    (name) => {
      expect(sql).not.toMatch(new RegExp(`create or replace function public\\.${name}\\(`));
    },
  );

  it("none of the five lifecycle functions' last-known (0117) bodies reference membership_status", () => {
    const lifecycleSql = codeOnly(readSource(LIFECYCLE_MIGRATION_PATH));
    for (const name of lifecycleFunctions) {
      const body = functionBody(lifecycleSql, name);
      expect(body, `${name} must not reference membership_status`).not.toMatch(/membership_status/);
    }
  });

  it("0188 does not touch accept_club_invite, create_club_invite, or resend_club_invite", () => {
    for (const name of ["accept_club_invite", "create_club_invite", "resend_club_invite"]) {
      expect(sql).not.toMatch(new RegExp(`create or replace function public\\.${name}\\(`));
    }
  });

  it("0188 does not touch reservations, lesson_requests, payments, event_guests, or reservation_guests", () => {
    for (const table of [
      "reservations",
      "lesson_requests",
      "payments",
      "event_guests",
      "reservation_guests",
    ]) {
      expect(sql).not.toMatch(new RegExp(`alter table public\\.${table}\\b`));
    }
  });

  it("0188 does not touch current_user_role or current_user_club_id", () => {
    expect(sql).not.toMatch(/create or replace function public\.current_user_role\(/);
    expect(sql).not.toMatch(/create or replace function public\.current_user_club_id\(/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// I. Every new RPC is admin-only and same-club audited
// ═══════════════════════════════════════════════════════════════════════════

describe("0188 — every new Admin RPC is authenticated-only and audited", () => {
  const sql = migrationSql();
  const rpcs: Array<[string, string]> = [
    ["create_membership_type", "text"],
    ["update_membership_type", "uuid, text"],
    ["set_membership_type_active", "uuid, boolean"],
    ["set_roster_member_membership_type", "uuid, uuid"],
    ["set_roster_member_membership_status", "uuid, text"],
  ];

  it.each(rpcs)("%s(%s) is revoked from public/anon and granted only to authenticated", (name, args) => {
    expect(sql).toMatch(
      new RegExp(`revoke execute on function public\\.${name}\\(${args}\\) from public, anon;`),
    );
    expect(sql).toMatch(
      new RegExp(`grant\\s+execute on function public\\.${name}\\(${args}\\) to authenticated;`),
    );
  });

  it.each(rpcs.map(([name]) => name))("%s writes an audit_log entry", (name) => {
    const body = functionBody(sql, name);
    expect(body).toMatch(/insert into public\.audit_log \(club_id, actor_id, action, target_type, target_id, metadata\)/);
    expect(body).toMatch(new RegExp(`'${name}'`));
  });
});
