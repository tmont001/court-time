import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 45D1 — fixes the P1 finding from the Phase 45D authorization audit:
// public.user_pref_enabled(p_user_id uuid, p_kind text) accepted p_user_id
// verbatim with zero authorization check, letting any authenticated user (any
// role, any club) query any other user's (any club's) notification-kind
// preference — a confirmed cross-user/cross-club IDOR.
//
// Call-site audit (see migration 0213's own header for the full evidence
// trail): every SQL caller passes auth.uid() (self); TWO independent
// TypeScript call sites — src/lib/notification-dispatch.ts's
// dispatchWaitlistNotification (an ordinary Member leaving an event
// legitimately notifies a DIFFERENT member who was offered the spot) and
// src/app/(app)/lessons/actions.ts's dispatchLessonEmail (an ordinary
// Member legitimately notifies their Pro) — prove that NO role-based
// allowlist can gate this function without breaking real, shipped dispatch
// behavior: Member must remain a legitimate cross-user caller. The actual
// confirmed exploitable gap was specifically CROSS-CLUB access, which no
// legitimate call site ever needs (every real cross-user call site targets
// a same-club counterparty by construction). Migration 0213 (created, NOT
// applied) therefore scopes authorization by CLUB, not role: self is always
// allowed; cross-user is allowed only when the target independently
// resolves to the caller's own club; everything else fails closed (false).
//
// Migration 0213 is CREATED but explicitly NOT APPLIED by this checkpoint —
// every assertion below is a source-text check against the migration file,
// not a live database check.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const MIGRATION_PATH = "supabase/migrations/0213_user_pref_enabled_authorization_hardening.sql";
const EMAIL_LIB_PATH = "src/lib/email.ts";
const NOTIFICATION_DISPATCH_PATH = "src/lib/notification-dispatch.ts";
const LESSONS_ACTIONS_PATH = "src/app/(app)/lessons/actions.ts";

function readMigration(): string {
  return readSource(MIGRATION_PATH);
}

function functionBody(): string {
  const s = readMigration();
  const start = s.indexOf("create or replace function public.user_pref_enabled(");
  const end = s.indexOf("alter function public.user_pref_enabled", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return s.slice(start, end);
}

// ─────────────────────────────────────────────────────────────────────────
// 1-4. Security contract: SECURITY DEFINER, search_path, ACL.
// ─────────────────────────────────────────────────────────────────────────

describe("0213 — security contract (SECURITY DEFINER, search_path, ACL)", () => {
  it("remains SECURITY DEFINER and STABLE", () => {
    const block = functionBody();
    expect(block).toContain("security definer");
    expect(block).toContain("stable");
  });

  it("search_path remains pinned to public, pg_temp", () => {
    const block = functionBody();
    expect(block).toContain("set search_path = public, pg_temp");
  });

  it("owner explicitly restated to postgres", () => {
    const s = readMigration();
    expect(s).toContain("alter function public.user_pref_enabled(uuid, text) owner to postgres;");
  });

  it("EXECUTE explicitly revoked from PUBLIC and anon", () => {
    const s = readMigration();
    expect(s).toContain("revoke execute on function public.user_pref_enabled(uuid, text) from public;");
    expect(s).toContain("revoke execute on function public.user_pref_enabled(uuid, text) from anon;");
  });

  it("EXECUTE granted to authenticated and service_role only", () => {
    const s = readMigration();
    expect(s).toContain("grant  execute on function public.user_pref_enabled(uuid, text) to authenticated;");
    expect(s).toContain("grant  execute on function public.user_pref_enabled(uuid, text) to service_role;");
    // No broadening beyond these two roles.
    expect(s).not.toMatch(/grant\s+execute on function public\.user_pref_enabled\([^)]*\) to (public|anon);/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 5-10. Authorization behavior — proven via the migration's own SQL
// structure (source-text, matching this codebase's established migration-
// behavior-testing convention; 0213 is not applied, so no live execution
// is possible this checkpoint).
//
// CORRECTED DESIGN (migration review): the first draft resolved "club" via
// profiles.club_id for both caller and target — rejected in review because
// profiles.club_id is NOT this schema's authorization truth under the
// multi-club foundation. The corrected function instead: (1) resolves the
// CALLER's club via public.current_user_club_id() (the same trusted
// active-membership helper every other authorization-sensitive RPC in this
// schema uses), and (2) independently verifies the TARGET holds an ACTIVE
// club_memberships row (status='active', removed_at is null) in that exact
// club — deliberately NOT consulting the target's own
// profiles.active_club_id, since a multi-club user may legitimately hold
// an active membership in the caller's club while their own active UI
// context points elsewhere.
// ─────────────────────────────────────────────────────────────────────────

describe("0213 — authorization behavior (corrected: active-membership model, not profiles.club_id)", () => {
  it("fails closed (returns false) when there is no authenticated caller identity, or when p_user_id itself is null", () => {
    const block = functionBody();
    const idx = block.indexOf("v_caller_id is null or p_user_id is null");
    expect(idx).toBeGreaterThan(-1);
    expect(block.slice(idx, idx + 80)).toContain("return false;");
  });

  it("does not rely on SQL's three-valued p_user_id <> auth.uid() to reject a null p_user_id — the null check is a separate, explicit early guard", () => {
    const block = functionBody();
    const nullGuardIdx = block.indexOf("if v_caller_id is null or p_user_id is null then");
    const selfCheckIdx = block.indexOf("if p_user_id <> v_caller_id then");
    expect(nullGuardIdx).toBeGreaterThan(-1);
    expect(selfCheckIdx).toBeGreaterThan(nullGuardIdx);
  });

  it("SELF lookup is allowed: p_user_id = auth.uid() skips the club/membership check entirely", () => {
    const block = functionBody();
    expect(block).toContain("if p_user_id <> v_caller_id then");
  });

  it("no profiles.club_id authorization lookup remains anywhere in the function's real SQL (an explanatory comment naming it, to say it's deliberately not used, is fine)", () => {
    const block = functionBody();
    expect(block).not.toContain("from public.profiles");
    const sqlOnly = block
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    expect(sqlOnly).not.toMatch(/profiles\.club_id/);
  });

  it("caller's cross-user club scope is resolved via public.current_user_club_id(), not profiles.club_id — and a null result (no valid active membership) fails closed before any target lookup", () => {
    const block = functionBody();
    const idx = block.indexOf("if p_user_id <> v_caller_id then");
    const end = block.indexOf("end if;\n  end if;", idx);
    const crossUserBlock = block.slice(idx, end);
    expect(crossUserBlock).toContain("v_caller_club_id := public.current_user_club_id();");
    const nullCheckIdx = crossUserBlock.indexOf("if v_caller_club_id is null then");
    expect(nullCheckIdx).toBeGreaterThan(-1);
    expect(crossUserBlock.slice(nullCheckIdx, nullCheckIdx + 60)).toContain("return false;");
    // The caller-club resolution must precede the target-membership check.
    expect(crossUserBlock.indexOf("v_caller_club_id := public.current_user_club_id();"))
      .toBeLessThan(crossUserBlock.indexOf("club_memberships"));
  });

  it("target membership is checked through public.club_memberships — exists(), keyed on the target's user_id and the caller's resolved club_id", () => {
    const block = functionBody();
    const idx = block.indexOf("from public.club_memberships cm");
    expect(idx).toBeGreaterThan(-1);
    const membershipBlock = block.slice(idx, block.indexOf("into v_target_in_club;", idx));
    expect(membershipBlock).toContain("cm.user_id     = p_user_id");
    expect(membershipBlock).toContain("cm.club_id     = v_caller_club_id");
  });

  it("target membership must be status = 'active' AND removed_at IS NULL — both conditions present in the same exists() check", () => {
    const block = functionBody();
    const idx = block.indexOf("from public.club_memberships cm");
    const membershipBlock = block.slice(idx, block.indexOf("into v_target_in_club;", idx));
    expect(membershipBlock).toContain("cm.status      = 'active'");
    expect(membershipBlock).toContain("cm.removed_at is null");
  });

  it("the target's own profiles.active_club_id is NOT required to match the caller's club — no real SQL reads active_club_id anywhere (an explanatory comment naming it, to say it's deliberately not consulted, is fine)", () => {
    const block = functionBody();
    const sqlOnly = block
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    expect(sqlOnly).not.toMatch(/active_club_id/);
  });

  it("an unauthorized cross-user/cross-club/inactive/removed-membership result fails closed (return false) — no path falls through to the preference lookup without v_target_in_club being true", () => {
    const block = functionBody();
    const idx = block.indexOf("if not v_target_in_club then");
    expect(idx).toBeGreaterThan(-1);
    expect(block.slice(idx, idx + 60)).toContain("return false;");
  });

  it("no role condition gates any part of this function — confirms the fix is club/membership-scoped, not role-scoped, matching the evidenced same-club Member dispatch requirement", () => {
    const block = functionBody();
    expect(block).not.toMatch(/\brole\b/);
    expect(block).not.toContain("current_user_role");
    expect(block).not.toContain("v_actor.role");
  });

  it("default-true behavior is preserved for an authorized target with no notification_preferences row — identical coalesce(...,true) as before this migration, reached only after authorization passes", () => {
    const block = functionBody();
    const returnIdx = block.lastIndexOf("return coalesce(");
    expect(returnIdx).toBeGreaterThan(-1);
    const returnBlock = block.slice(returnIdx);
    expect(returnBlock).toContain("from public.notification_preferences");
    expect(returnBlock).toContain("where user_id = p_user_id");
    expect(returnBlock).toContain("and kind    = p_kind");
    expect(returnBlock).toContain("true\n  );");
    // Exactly one such lookup exists — self and authorized-cross-user share
    // the identical final read, not two divergent implementations.
    expect((block.match(/from public\.notification_preferences/g) ?? []).length).toBe(1);
  });
});

describe("0213 — migration wording accurately describes a narrow boundary, not an elimination of cross-user access", () => {
  it("explicitly documents that same-club cross-user access remains intentionally allowed, and only cross-club access is prohibited", () => {
    const s = readMigration();
    expect(s).toContain("deliberate, narrow security boundary, not an elimination of");
    expect(s).toContain("Only CROSS-CLUB access is prohibited.");
  });

  it("does not claim all cross-user access is eliminated/prohibited anywhere in the file", () => {
    const s = readMigration();
    expect(s).not.toMatch(/eliminat(e|es|ing|ion) (all )?cross-user/i);
    expect(s).not.toMatch(/prohibits? (all )?cross-user/i);
  });

  it("documents the profiles.club_id correction explicitly, including why it was wrong", () => {
    const s = readMigration();
    expect(s).toContain("IMPORTANT CORRECTION");
    expect(s).toContain("profiles.club_id is legacy/informational only");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 11-12. No application-code change required; signature/return unchanged.
// ─────────────────────────────────────────────────────────────────────────

describe("0213 — signature unchanged, no application call site requires a change", () => {
  it("signature is unchanged: (p_user_id uuid, p_kind text) -> boolean", () => {
    const block = functionBody();
    expect(block).toContain("create or replace function public.user_pref_enabled(\n  p_user_id uuid,\n  p_kind    text\n)\nreturns boolean");
  });

  it("src/lib/email.ts's sendEmailNotification call site is untouched by this checkpoint — same arguments, same guard structure", () => {
    const s = readSource(EMAIL_LIB_PATH);
    const idx = s.indexOf('await supabase.rpc("user_pref_enabled"');
    expect(idx).toBeGreaterThan(-1);
    const block = s.slice(idx, idx + 150);
    expect(block).toContain("p_user_id: recipientUserId,");
    expect(block).toContain("p_kind:    kind,");
  });

  it("src/app/(app)/lessons/actions.ts's dispatchLessonEmail call site is untouched by this checkpoint — same arguments", () => {
    const s = readSource(LESSONS_ACTIONS_PATH);
    const idx = s.indexOf('await supabase.rpc("user_pref_enabled"');
    expect(idx).toBeGreaterThan(-1);
    const block = s.slice(idx, idx + 150);
    expect(block).toContain("p_user_id: recipientUserId,");
    expect(block).toContain("p_kind:    kind,");
  });

  it("notification-dispatch.ts (the waitlist/reservation/event dispatcher whose own comments document the Member-triggers-cross-user-notification requirement) is untouched by this checkpoint", () => {
    const s = readSource(NOTIFICATION_DISPATCH_PATH);
    expect(s).toContain("the Member who called leave_event");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 13-14. No unrelated object modified; no 0214 created.
// ─────────────────────────────────────────────────────────────────────────

describe("0213 — scope discipline", () => {
  it("touches only public.user_pref_enabled — no other function, table, RLS policy, or grant appears in this migration", () => {
    const s = readMigration();
    // Only one function name appears anywhere in real (non-comment) SQL.
    const sqlLines = s.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    expect(sqlLines).not.toMatch(/create (or replace )?function public\.(?!user_pref_enabled)/);
    expect(sqlLines).not.toMatch(/\balter table\b/i);
    expect(sqlLines).not.toMatch(/\bcreate policy\b/i);
    expect(sqlLines).not.toMatch(/\bdrop policy\b/i);
  });

  it("does not modify migrations 0211/0212 (both remain byte-for-byte as Phase 45C left them)", () => {
    const s211 = readSource("supabase/migrations/0211_member_notes_schema_reconciliation.sql");
    expect(s211).toContain("-- 1a. member_notes — member_id FK convergence (ON DELETE CASCADE)");
    const s212 = readSource("supabase/migrations/0212_restore_member_note.sql");
    expect(s212).toContain("if not v_note.is_archived then raise exception 'note_not_archived'; end if;");
  });

  // A "no migration beyond N was created" hardcoded ceiling previously lived
  // here (first as ===213, then bumped to ===216 when 0214-0216 were added).
  // Removed: that pattern is invalid for a historical checkpoint's
  // regression suite — it cannot prove no LATER, unrelated checkpoint will
  // ever add a migration, and re-bumping the number every time one does is
  // exactly the moving-target maintenance burden this cleanup exists to
  // eliminate. 0213's own content is already fully proven by every other
  // test in this file; migration-specific claims for later migrations
  // (0214-0216) belong in their own owning test files. See
  // topLevelBackLinkCleanup.regression.test.ts's own note on this same
  // cleanup.

  it("wrapped in begin;/commit; matching repo convention, and explicitly not yet applied (created this checkpoint only)", () => {
    const s = readMigration();
    expect(s).toContain("\nbegin;\n");
    expect(s.trim().endsWith("commit;")).toBe(true);
    expect(s).toContain("Do NOT apply until reviewed.");
  });
});
