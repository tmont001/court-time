import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 43B-3F — Member Waiver Notifications. Regression coverage for
// migration 0197 (fan-out + idempotency + acceptance cleanup) and the
// notification-targets.ts deep-link wiring it relies on. Source-inspection
// style, matching this repository's established convention for migration
// SQL (see refundRequestAdminNotification.regression.test.ts) — 0197 is
// not yet applied to Supabase, so these tests validate the migration
// FILE's content exactly as that precedent does for its own not-yet-
// applied migration.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

const MIGRATION_0192_PATH = "supabase/migrations/0192_member_waiver_foundation.sql";
const MIGRATION_0196_PATH = "supabase/migrations/0196_waiver_pdf_document_foundation.sql";
const MIGRATION_0197_PATH = "supabase/migrations/0197_member_waiver_notifications.sql";
const NOTIFICATION_TARGETS_PATH = "src/lib/notification-targets.ts";
const NOTIFICATION_SHEET_PATH = "src/components/NotificationSheet.tsx";

function migrationSql(): string {
  return codeOnly(readSource(MIGRATION_0197_PATH));
}

function extractFunctionBody(sql: string, signaturePrefix: string): string {
  const start = sql.indexOf(signaturePrefix);
  expect(start).toBeGreaterThan(-1);
  const end = sql.indexOf("\n$$;", start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end + "\n$$;".length);
}

function notifyHelperBody(): string {
  return extractFunctionBody(
    migrationSql(),
    "create or replace function public._notify_member_waiver_requires_acceptance("
  );
}

function publishBody(): string {
  return extractFunctionBody(
    migrationSql(),
    "create or replace function public.publish_waiver_pdf_version("
  );
}

function setRequiredBody(): string {
  return extractFunctionBody(
    migrationSql(),
    "create or replace function public.set_member_waiver_required("
  );
}

function acceptBody(): string {
  return extractFunctionBody(
    migrationSql(),
    "create or replace function public.accept_member_waiver("
  );
}

function closePriorHelperBody(): string {
  return extractFunctionBody(
    migrationSql(),
    "create or replace function public._close_prior_member_waiver_notifications("
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 0192/0196 are untouched
// ═══════════════════════════════════════════════════════════════════════════

describe("0192/0196 are not modified by this migration", () => {
  it("0197 exists as its own new file — 0192/0196 are not edited", () => {
    expect(() => readSource(MIGRATION_0197_PATH)).not.toThrow();
    const original0192 = readSource(MIGRATION_0192_PATH);
    expect(original0192).toContain("Role-agnostic (decision 6): no role check anywhere in this function.");
    const original0196 = readSource(MIGRATION_0196_PATH);
    expect(original0196).toContain("waiver_document_file_immutable");
  });

  it("0197 is wrapped in a single begin;/commit; transaction block", () => {
    const sql = migrationSql();
    expect(sql).toMatch(/^begin;/m);
    expect(sql).toMatch(/^commit;/m);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// notifications_kind_check widened
// ═══════════════════════════════════════════════════════════════════════════

describe("notifications_kind_check widened to add member_waiver_requires_acceptance", () => {
  it("all 20 pre-existing kinds are preserved and the 21st is added", () => {
    const sql = migrationSql();
    const checkStart = sql.indexOf("add constraint notifications_kind_check");
    expect(checkStart).toBeGreaterThan(-1);
    const checkEnd = sql.indexOf("));", checkStart);
    const checkClause = sql.slice(checkStart, checkEnd);
    for (const kind of [
      "reservation_confirmed",
      "reservation_cancelled_by_admin",
      "reservation_cancelled_by_member",
      "reservation_rescheduled",
      "event_cancelled",
      "event_joined",
      "event_updated",
      "waitlist_promoted",
      "waitlist_offer",
      "announcement",
      "lesson_request_received",
      "lesson_request_proposed",
      "lesson_request_confirmed",
      "lesson_request_declined",
      "lesson_cancelled",
      "lesson_provider_reassigned",
      "lesson_admin_requested",
      "refund_request_rejected",
      "refund_request_completed",
      "refund_request_submitted",
      "member_waiver_requires_acceptance",
    ]) {
      expect(checkClause).toContain(`'${kind}'`);
    }
  });

  it("is NOT added to notification_preferences_kind_check — mandatory, in-app-only, matching refund_request_submitted's precedent", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/notification_preferences/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Idempotency
// ═══════════════════════════════════════════════════════════════════════════

describe("idempotency — partial unique index on the existing metadata column", () => {
  it("creates a unique index on (user_id, metadata->>'waiver_version_id') scoped to this kind", () => {
    const sql = migrationSql();
    expect(sql).toContain("create unique index if not exists notifications_member_waiver_requires_acceptance_uniq");
    expect(sql).toContain("on public.notifications (user_id, ((metadata ->> 'waiver_version_id')))");
    expect(sql).toContain("where kind = 'member_waiver_requires_acceptance'");
  });

  it("the fan-out helper inserts with ON CONFLICT ... DO UPDATE against that exact index (pre-apply correction: reactivates a since-closed row instead of leaving it read forever)", () => {
    const fn = notifyHelperBody();
    expect(fn).toMatch(/on conflict \(user_id, \(\(metadata ->> 'waiver_version_id'\)\)\)\s*\n\s*where kind = 'member_waiver_requires_acceptance'\s*\n\s*do update set/);
    expect(fn).not.toMatch(/do nothing;/);
  });

  it("the DO UPDATE restores is_read = false and refreshes created_at, matching NotificationSheet's created_at-desc ordering so a renewed requirement surfaces as current", () => {
    const fn = notifyHelperBody();
    const conflictIdx = fn.indexOf("on conflict (user_id,");
    const setClause = fn.slice(conflictIdx);
    expect(setClause).toContain("is_read    = false");
    expect(setClause).toContain("body       = excluded.body");
    expect(setClause).toContain("metadata   = excluded.metadata");
    expect(setClause).toContain("created_at = now();");
  });

  it("no new dedupe column/table is introduced — only the existing metadata jsonb column is used as the conflict key", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/create table/i);
    expect(sql).not.toMatch(/add column/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Fan-out audience — active, claimed Members only
// ═══════════════════════════════════════════════════════════════════════════

describe("fan-out audience matches the canonical active-Member predicate (is_active_club_member, 0188)", () => {
  it("filters on roster_members.status = 'active' and membership_status = 'active', and requires a claimed identity", () => {
    const fn = notifyHelperBody();
    expect(fn).toContain("from public.roster_members rm");
    expect(fn).toContain("rm.status            = 'active'");
    expect(fn).toContain("rm.membership_status = 'active'");
    expect(fn).toContain("rm.claimed_by is not null");
  });

  it("is role-agnostic — never filters on roster_members.role or club_memberships.role", () => {
    const fn = notifyHelperBody();
    expect(fn).not.toMatch(/rm\.role|cm\.role/);
  });

  it("excludes Members who already accepted this exact waiver_version_id", () => {
    const fn = notifyHelperBody();
    expect(fn).toContain("not exists (");
    expect(fn).toContain("select 1 from public.waiver_acceptances a\n        where a.waiver_version_id = p_waiver_version_id\n          and a.roster_member_id  = rm.id");
  });

  it("a Guest (no roster_members row) is structurally excluded — the query only ever selects from roster_members, never reservation_guests/event_guests", () => {
    const fn = notifyHelperBody();
    expect(fn).not.toMatch(/reservation_guests|event_guests/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Body-text branching — first-required vs updated-waiver copy
// ═══════════════════════════════════════════════════════════════════════════

describe("body text distinguishes never-accepted-any-version vs accepted-an-older-version", () => {
  it("uses a single kind, branching body text via a case expression joined through waiver_versions.waiver_id", () => {
    const fn = notifyHelperBody();
    expect(fn).toContain("'Waiver requires your acceptance'");
    expect(fn).toContain("'Updated waiver requires your acceptance'");
    expect(fn).toContain("join public.waiver_versions v on v.id = a.waiver_version_id");
    expect(fn).toContain("v.waiver_id        = v_waiver_id");
  });

  it("writes metadata.waiver_version_id and metadata.target_path = '/waivers/member' for every inserted row", () => {
    const fn = notifyHelperBody();
    expect(fn).toContain("'waiver_version_id', p_waiver_version_id");
    expect(fn).toContain("'target_path',       '/waivers/member'");
  });

  it("the helper is private — revoked from public/anon/authenticated", () => {
    const sql = migrationSql();
    expect(sql).toContain(
      "revoke execute on function public._notify_member_waiver_requires_acceptance(uuid, uuid)\n  from public, anon, authenticated;"
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Triggers — publish (first + replacement) and Required OFF -> ON
// ═══════════════════════════════════════════════════════════════════════════

describe("publish_waiver_pdf_version triggers the fan-out only for a required Member-audience publish", () => {
  it("calls the helper with p_club_id and p_version_id after the audit_log insert, gated on audience='member' and is_required", () => {
    const fn = publishBody();
    const auditIdx = fn.indexOf("'publish_waiver_pdf_version'");
    const notifyIdx = fn.indexOf("_notify_member_waiver_requires_acceptance(p_club_id, p_version_id)");
    expect(auditIdx).toBeGreaterThan(-1);
    expect(notifyIdx).toBeGreaterThan(auditIdx);
    expect(fn).toContain("if p_audience = 'member' and coalesce(v_waiver.is_required, false) then");
  });

  it("a Guest-audience publish never calls the fan-out helper or the close-prior helper — both gates require audience='member'", () => {
    const fn = publishBody();
    expect(fn).toContain("if p_audience = 'member' then\n    perform public._close_prior_member_waiver_notifications(v_waiver.id, p_version_id);\n  end if;");
    expect(fn).toContain("if p_audience = 'member' and coalesce(v_waiver.is_required, false) then");
    // Neither gate's body ever references 'guest' — a Guest publish simply
    // never satisfies either condition.
    const closePriorGateIdx = fn.indexOf("if p_audience = 'member' then");
    const closePriorGateBlock = fn.slice(closePriorGateIdx, closePriorGateIdx + 150);
    expect(closePriorGateBlock).not.toContain("guest");
  });

  it("version_id_already_exists is still raised BEFORE any new-version work — retries of the same version never reach the fan-out a second time", () => {
    const fn = publishBody();
    const guardIdx = fn.indexOf("raise exception 'version_id_already_exists';");
    const notifyIdx = fn.indexOf("_notify_member_waiver_requires_acceptance");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(notifyIdx).toBeGreaterThan(guardIdx);
  });

  it("v_next_version_number is still computed unchanged (1 = first publication, >1 = replacement) — no new state introduced for this signal", () => {
    const fn = publishBody();
    expect(fn).toContain("v_next_version_number := coalesce(");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Problem 1 (pre-apply correction) — superseded-version cleanup on publish
// ═══════════════════════════════════════════════════════════════════════════

describe("publish_waiver_pdf_version closes PRIOR-version notifications unconditionally on every Member publish (Problem 1)", () => {
  it("calls _close_prior_member_waiver_notifications(v_waiver.id, p_version_id) BEFORE the fan-out call, gated only on audience='member' — not gated on is_required", () => {
    const fn = publishBody();
    const closeIdx = fn.indexOf("_close_prior_member_waiver_notifications(v_waiver.id, p_version_id)");
    const fanOutIdx = fn.indexOf("_notify_member_waiver_requires_acceptance(p_club_id, p_version_id)");
    expect(closeIdx).toBeGreaterThan(-1);
    expect(fanOutIdx).toBeGreaterThan(closeIdx);
    // The close-prior gate is its own standalone "if p_audience = 'member'
    // then" — not combined with the is_required check the fan-out gate uses.
    const closeGateIdx = fn.lastIndexOf("if p_audience = 'member' then", closeIdx);
    expect(closeGateIdx).toBeGreaterThan(-1);
  });

  it("the helper closes unread notifications for ANY other version of the same waiver_id — not just the immediately prior one", () => {
    const fn = closePriorHelperBody();
    expect(fn).toContain("n.kind = 'member_waiver_requires_acceptance'");
    expect(fn).toContain("n.is_read = false");
    expect(fn).toContain("(n.metadata ->> 'waiver_version_id') <> p_current_version_id::text");
    expect(fn).toContain("v.id::text  = (n.metadata ->> 'waiver_version_id')");
    expect(fn).toContain("v.waiver_id = p_waiver_id");
  });

  it("never casts notification metadata to uuid — compares waiver_versions.id as text instead, matching accept_member_waiver's own idiom, so a malformed row can never raise a cast error", () => {
    const fn = closePriorHelperBody();
    expect(fn).not.toMatch(/metadata ->> 'waiver_version_id'\)::uuid/);
  });

  it("is private — revoked from public/anon/authenticated", () => {
    const sql = migrationSql();
    expect(sql).toContain(
      "revoke execute on function public._close_prior_member_waiver_notifications(uuid, uuid)\n  from public, anon, authenticated;"
    );
  });
});

describe("set_member_waiver_required triggers the fan-out only on OFF -> ON with a current version", () => {
  it("calls the helper with v_club_id and v_waiver.current_version_id, gated on p_required and current_version_id not null", () => {
    const fn = setRequiredBody();
    expect(fn).toContain("if p_required and v_waiver.current_version_id is not null then");
    expect(fn).toContain("_notify_member_waiver_requires_acceptance(v_club_id, v_waiver.current_version_id);");
  });

  it("the pre-existing no-op early return for an unchanged flag still precedes the new call — a repeated Required=true is a no-op before the fan-out is ever reached", () => {
    const fn = setRequiredBody();
    const earlyReturnIdx = fn.indexOf("if v_waiver.is_required is not distinct from p_required then return; end if;");
    const notifyIdx = fn.indexOf("_notify_member_waiver_requires_acceptance");
    expect(earlyReturnIdx).toBeGreaterThan(-1);
    expect(notifyIdx).toBeGreaterThan(earlyReturnIdx);
  });

  it("turning Required OFF (p_required = false) never calls the fan-out helper", () => {
    const fn = setRequiredBody();
    const guardIdx = fn.indexOf("if p_required and v_waiver.current_version_id is not null then");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(fn).toContain("elsif not p_required then");
  });

  it("reusing the SAME fan-out helper (not a second mechanism) for OFF -> ON means reactivation comes for free from the helper's own ON CONFLICT DO UPDATE (Problem 3) — no duplicate-row risk", () => {
    const fn = setRequiredBody();
    const onIdx = fn.indexOf("if p_required and v_waiver.current_version_id is not null then");
    const elsifIdx = fn.indexOf("elsif not p_required then");
    expect(onIdx).toBeGreaterThan(-1);
    expect(elsifIdx).toBeGreaterThan(onIdx);
    // No second insert/upsert statement is introduced for the ON branch —
    // it is exactly one call to the existing helper.
    const onBranch = fn.slice(onIdx, elsifIdx);
    expect((onBranch.match(/perform public\._notify_member_waiver_requires_acceptance/g) ?? []).length).toBe(1);
    expect(onBranch).not.toMatch(/insert into public\.notifications/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Problem 2 (pre-apply correction) — Required ON -> OFF closes the
// current-version notification (history preserved, not deleted)
// ═══════════════════════════════════════════════════════════════════════════

describe("set_member_waiver_required closes the current version's unread notifications on Required ON -> OFF (Problem 2)", () => {
  it("the elsif not p_required branch marks unread notifications for v_waiver.current_version_id as read", () => {
    const fn = setRequiredBody();
    const elsifIdx = fn.indexOf("elsif not p_required then");
    expect(elsifIdx).toBeGreaterThan(-1);
    const branch = fn.slice(elsifIdx);
    expect(branch).toContain("update public.notifications");
    expect(branch).toContain("set is_read = true");
    expect(branch).toContain("where kind = 'member_waiver_requires_acceptance'");
    expect(branch).toContain("and is_read = false");
    expect(branch).toContain("and (metadata ->> 'waiver_version_id') = v_waiver.current_version_id::text;");
  });

  it("marks read, never deletes — no delete/truncate statement touches notifications anywhere in this migration", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/delete\s+from\s+public\.notifications/i);
    expect(sql).not.toMatch(/truncate.*notifications/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Acceptance cleanup
// ═══════════════════════════════════════════════════════════════════════════

describe("acceptance cleanup — accept_member_waiver marks matching unread notifications read", () => {
  it("updates notifications scoped to auth.uid(), this kind, and this exact waiver_version_id", () => {
    const fn = acceptBody();
    expect(fn).toContain("update public.notifications");
    expect(fn).toContain("set is_read = true");
    expect(fn).toContain("where user_id = auth.uid()");
    expect(fn).toContain("and kind    = 'member_waiver_requires_acceptance'");
    expect(fn).toContain("and (metadata ->> 'waiver_version_id') = p_waiver_version_id::text");
  });

  it("runs after both the new-acceptance and idempotent-repeat-acceptance branches converge, before the return", () => {
    const fn = acceptBody();
    const branchEndIdx = fn.lastIndexOf("end if;", fn.indexOf("update public.notifications"));
    const updateIdx = fn.indexOf("update public.notifications");
    const returnIdx = fn.indexOf("return v_accepted_at;");
    expect(branchEndIdx).toBeGreaterThan(-1);
    expect(updateIdx).toBeGreaterThan(branchEndIdx);
    expect(returnIdx).toBeGreaterThan(updateIdx);
  });

  it("stale-version acceptance is rejected before reaching the cleanup — a notification for a prior, superseded version is never touched by accepting the current one", () => {
    const fn = acceptBody();
    const staleGuardIdx = fn.indexOf("raise exception 'stale_waiver_version';");
    const updateIdx = fn.indexOf("update public.notifications");
    expect(staleGuardIdx).toBeGreaterThan(-1);
    expect(updateIdx).toBeGreaterThan(staleGuardIdx);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Deep-link wiring (src/lib/notification-targets.ts)
// ═══════════════════════════════════════════════════════════════════════════

describe("notification-targets.ts wires the new kind to the legacy target_path fallback", () => {
  it("adds member_waiver_requires_acceptance to the NotificationKind union", () => {
    const s = readSource(NOTIFICATION_TARGETS_PATH);
    expect(s).toContain('| "member_waiver_requires_acceptance";');
  });

  it("maps the new kind to null in NOTIFICATION_TARGET_MAP, matching announcement/refund_request_rejected/refund_request_completed's precedent", () => {
    const s = readSource(NOTIFICATION_TARGETS_PATH);
    expect(s).toContain("member_waiver_requires_acceptance: null,");
  });

  it("resolveNotificationTarget resolves the kind's metadata.target_path with no kind-specific code change needed", async () => {
    const { resolveNotificationTarget } = await import("@/lib/notification-targets");
    const path = resolveNotificationTarget(
      "member_waiver_requires_acceptance",
      { waiver_version_id: "11111111-1111-1111-1111-111111111111", target_path: "/waivers/member" },
      "member"
    );
    expect(path).toBe("/waivers/member");
  });

  it("an unsafe target_path (absolute/protocol-relative) is still rejected by the shared getSafeTargetPath check", async () => {
    const { resolveNotificationTarget } = await import("@/lib/notification-targets");
    expect(
      resolveNotificationTarget("member_waiver_requires_acceptance", { target_path: "//evil.example.com" }, "member")
    ).toBeNull();
  });
});

describe("NotificationSheet renders the new kind's body like every other non-announcement kind", () => {
  it("no announcement-only special-case rendering is added for this kind — its body is plain text like reservation_confirmed etc.", () => {
    const s = readSource(NOTIFICATION_SHEET_PATH);
    expect(s).not.toContain('n.kind === "member_waiver_requires_acceptance"');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Guest behavior — completely unaffected by every pre-apply correction
// ═══════════════════════════════════════════════════════════════════════════

describe("Guest waivers are untouched by all three pre-apply corrections", () => {
  it("_close_prior_member_waiver_notifications is only ever called from publish_waiver_pdf_version's audience='member' gate — never from a guest path", () => {
    const sql = migrationSql();
    const callSites = sql.split("_close_prior_member_waiver_notifications(v_waiver.id, p_version_id)").length - 1;
    // Exactly one call site: inside the definition's own signature/body is
    // not a call, so this counts only the perform in publish_waiver_pdf_version.
    expect(callSites).toBe(1);
  });

  it("set_member_waiver_required has no p_audience parameter at all — it is Member-only by construction (a separate set_guest_waiver_required RPC, untouched, governs Guest Required)", () => {
    const fn = setRequiredBody();
    expect(fn).not.toContain("p_audience");
    expect(fn).toContain("audience = 'member'");
  });

  it("this migration never defines or calls set_guest_waiver_required", () => {
    const sql = migrationSql();
    expect(sql).not.toContain("set_guest_waiver_required");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Problem 3 — reactivation is scoped only to non-acceptors, matching the
// invariant "already-current acceptors excluded"
// ═══════════════════════════════════════════════════════════════════════════

describe("reactivation (Problem 3) can never resurface a notification for a Member who has since accepted", () => {
  it("the fan-out helper's candidate SELECT still excludes acceptors, so the DO UPDATE path is only ever reachable for a non-acceptor's own previously-closed row", () => {
    const fn = notifyHelperBody();
    const selectIdx = fn.indexOf("insert into public.notifications");
    const conflictIdx = fn.indexOf("on conflict (user_id,");
    const selectClause = fn.slice(selectIdx, conflictIdx);
    expect(selectClause).toContain("not exists (");
    expect(selectClause).toContain("select 1 from public.waiver_acceptances a\n        where a.waiver_version_id = p_waiver_version_id\n          and a.roster_member_id  = rm.id");
  });
});
