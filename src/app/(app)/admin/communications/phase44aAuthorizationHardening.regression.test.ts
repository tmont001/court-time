import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 44A — Communications Authorization & Membership Hardening.
//
// The Phase 44 Communications v2 audit re-checked whether
// 0177_announcement_active_membership_eligibility.sql's fix (club_
// memberships, never the profiles legacy projection, decides who may send
// or receive a club communication) was applied everywhere the same bug
// class could occur. It was not: public.send_announcement(text, text) (the
// original, unhardened v1 RPC nothing calls) still carried both bugs, and
// four more functions — submit_lesson_request, admin_create_lesson_request,
// reassign_lesson_provider, get_club_pros, get_admin_club_pros — plus
// cancel_event's own caller authorization and notification_deliveries'
// admin-read RLS policy still derived eligibility from stale profiles.
// club_id/role/status, which 0081_club_membership_compatibility_
// foundation.sql's own trigger (trg_project_membership_to_profile)
// deliberately leaves frozen at its last value once a club_memberships row
// is removed or deactivated. 0207 closes exactly those gaps.
//
// This is pure SQL-migration content with no live Postgres available in
// this test environment — the same established baseline
// announcementEligibility.regression.test.ts already uses. Eligibility is
// proven via the actual migration text; no real Postgres session is opened
// by these tests.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const MIGRATION_0207 = "supabase/migrations/0207_phase44a_communications_authorization_membership_hardening.sql";
const MIGRATION_0208 = "supabase/migrations/0208_retire_admin_create_lesson_request.sql";
const TYPES_PATH      = "src/lib/db/types.ts";
const ACTIONS_PATH    = "src/app/(app)/admin/communications/communicationsActions.ts";
const LESSONS_ACTIONS_PATH = "src/app/(app)/lessons/actions.ts";

let cachedSrc: string | null = null;
function src(): string {
  if (cachedSrc === null) cachedSrc = readSource(MIGRATION_0207);
  return cachedSrc;
}

// Slices one function's body — from its own `create or replace function
// public.<name>(` signature to the next top-level `$$;`/`$function$;`
// terminator. Distinct terminators are needed because
// submit_lesson_request (reproduced verbatim from its 0146 live-production
// body) is delimited by `$function$;`, while every other function in this
// migration uses the repo's ordinary `$$;` convention.
function functionBody(name: string, terminator: "$$;" | "$function$;" = "$$;"): string {
  const s = src();
  const start = s.indexOf(`create or replace function public.${name}(`);
  if (start === -1) throw new Error(`${name} definition not found in 0207`);
  const end = s.indexOf(terminator, start);
  if (end === -1 || end <= start) throw new Error(`${terminator} terminator not found after ${name}'s body`);
  return s.slice(start, end + terminator.length);
}

describe("A. legacy send_announcement(text, text) v1 — dropped, not repaired", () => {
  it("1. 0207 explicitly drops the obsolete v1 function", () => {
    expect(src()).toContain("drop function public.send_announcement(text, text);");
  });

  it("2. no current source call site invokes send_announcement (v1) — only send_announcement_v2 is ever called", () => {
    const s = readSource(ACTIONS_PATH);
    expect(s).toContain('supabase.rpc("send_announcement_v2"');
    expect(s).not.toMatch(/\.rpc\(\s*["']send_announcement["']/);
  });

  it("3. send_announcement_v2 remains — 0207 does not redefine or drop it", () => {
    expect(src()).not.toContain("create or replace function public.send_announcement_v2(");
    expect(src()).not.toMatch(/drop function public\.send_announcement_v2/);
  });

  it("4. the obsolete db/types.ts Functions entry for send_announcement (v1) is removed; send_announcement_v2's entry remains", () => {
    const s = readSource(TYPES_PATH);
    expect(s).not.toMatch(/\n {6}send_announcement:\s*\{/);
    expect(s).toContain("send_announcement_v2: {");
  });

  it("0207 does not redefine send_announcement's replaced signature elsewhere in the file (drop only, no CREATE OR REPLACE for the v1 name)", () => {
    expect(src()).not.toContain("create or replace function public.send_announcement(");
  });
});

describe("B1. submit_lesson_request — caller club/role membership-derived; provider eligibility membership-derived", () => {
  const body = () => functionBody("submit_lesson_request", "$function$;");

  it("5. caller club/role are resolved via current_user_club_id()/current_user_role(), not solely stale profiles fields", () => {
    const b = body();
    expect(b).toContain("select public.current_user_club_id(), public.current_user_role()\n    into v_club_id, v_role;");
    expect(b).toContain("if v_club_id is null then raise exception 'no_club'; end if;");
  });

  it("6. provider eligibility requires an active, non-removed club_memberships row in the SAME (verified) club", () => {
    const b = body();
    const idx = b.indexOf("if not exists (");
    const block = b.slice(idx, idx + 400);
    expect(block).toContain("from public.club_memberships cm");
    expect(block).toContain("cm.user_id            = p_pro_id");
    expect(block).toContain("cm.club_id            = v_club_id");
    expect(block).toContain("cm.status             = 'active'");
    expect(block).toContain("cm.removed_at         is null");
    expect(block).toContain("cm.role               in ('pro', 'admin', 'staff')");
    expect(block).toContain("cm.is_lesson_provider = true");
    expect(block).toContain("raise exception 'pro_not_found';");
  });

  it("provider validation no longer reads profiles.status/role/club_id at all — v_pro is not declared or fetched (unused downstream, unlike admin_create_lesson_request/reassign_lesson_provider's own v_pro)", () => {
    const b = body();
    expect(b).not.toMatch(/select \* into v_pro\b/);
    expect(b).not.toMatch(/v_pro\.first_name/);
    expect(b).not.toMatch(/v_pro\s+public\.profiles%rowtype/);
  });

  it("7. pricing (flat/hourly snapshot, lesson_price_not_configured guard), duration, and capability protections remain present, byte-identical to 0146", () => {
    const b = body();
    expect(b).toContain("raise exception 'lesson_price_not_configured';");
    expect(b).toContain("raise exception 'capability_not_available';");
    expect(b).toContain("raise exception 'lesson_type_required';");
    expect(b).toContain("raise exception 'invalid_duration';");
    expect(b).toContain("raise exception 'duration_not_allowed_for_type';");
    expect(b).toContain("v_price_amount_cents := round(v_unit_price_amount_cents * p_duration_minutes / 60.0)::integer;");
    expect(b).toContain("public.current_club_has_capability('member_self_service')");
  });

  it("account_inactive (an independently meaningful profile-level check) is preserved, not removed", () => {
    const b = body();
    expect(b).toContain("if v_profile.status <> 'active' then raise exception 'account_inactive'; end if;");
  });

  it("roster identity resolution, notification body, and audit_log entry are unchanged in shape", () => {
    const b = body();
    expect(b).toContain("raise exception 'no_roster_identity'; end if;");
    expect(b).toContain("'lesson_request_received',");
    expect(b).toContain("'submit_lesson_request', 'lesson_request', v_result.id,");
  });
});

describe("B3. reassign_lesson_provider — caller-role boundary preserved exactly; new provider membership-derived; stale recipients not notified", () => {
  const body = () => functionBody("reassign_lesson_provider");

  it("11. caller-role boundary is preserved EXACTLY (admin-or-staff), now membership-derived", () => {
    const b = body();
    expect(b).toContain("select public.current_user_club_id(), public.current_user_role()\n    into v_actor_club_id, v_actor_role;");
    expect(b).toContain("if v_actor_role not in ('admin', 'staff') then raise exception 'insufficient_role'; end if;");
  });

  it("12. new provider requires an active, non-removed club_memberships row in the caller's verified club; eligible-role set unchanged (pro, admin, staff)", () => {
    const b = body();
    const idx = b.indexOf("cm.user_id            = p_new_pro_id");
    expect(idx).toBeGreaterThan(-1);
    const block = b.slice(idx - 60, idx + 400);
    expect(block).toContain("from public.club_memberships cm");
    expect(block).toContain("cm.club_id            = v_actor_club_id");
    expect(block).toContain("cm.status             = 'active'");
    expect(block).toContain("cm.removed_at         is null");
    expect(block).toContain("cm.role               in ('pro', 'admin', 'staff')");
    expect(block).toContain("cm.is_lesson_provider = true");
    expect(block).toContain("raise exception 'pro_not_found';");
  });

  it("review correction 5/6. v_new_pro is loaded BY ID ONLY (no pr.club_id filter) — same-club/role/provider eligibility for the new provider is derived entirely from club_memberships, never profiles.club_id", () => {
    const b = body();
    expect(b).toContain("select pr.* into v_new_pro from public.profiles pr where pr.id = p_new_pro_id;");
    expect(b).not.toMatch(/select pr\.\* into v_new_pro from public\.profiles pr\s+where pr\.id\s+=\s+p_new_pro_id\s+and pr\.club_id/);
    expect(b).not.toMatch(/pr\.club_id/);
  });

  it("new-provider failure (missing profile or failed membership eligibility) uniformly raises pro_not_found", () => {
    const b = body();
    const profileCheckIdx = b.indexOf("select pr.* into v_new_pro from public.profiles pr where pr.id = p_new_pro_id;");
    const afterProfile = b.slice(profileCheckIdx, profileCheckIdx + 160);
    expect(afterProfile).toContain("if not found then raise exception 'pro_not_found'; end if;");
    const proNotFoundOccurrences = (b.match(/raise exception 'pro_not_found';/g) ?? []).length;
    expect(proNotFoundOccurrences).toBe(2); // missing profile, and failed membership eligibility
  });

  it("13. the OLD provider is notified only inside a guard requiring their own active, non-removed membership", () => {
    const b = body();
    const oldNotifyIdx = b.indexOf("v_old_pro_id,\n      'lesson_provider_reassigned',");
    expect(oldNotifyIdx).toBeGreaterThan(-1);
    const guardStart = b.lastIndexOf("if exists (", oldNotifyIdx);
    expect(guardStart).toBeGreaterThan(-1);
    const guard = b.slice(guardStart, oldNotifyIdx);
    expect(guard).toContain("cm.user_id    = v_old_pro_id");
    expect(guard).toContain("cm.club_id    = v_actor_club_id");
    expect(guard).toContain("cm.status     = 'active'");
    expect(guard).toContain("cm.removed_at is null");
  });

  it("14. the Member is notified only inside a guard requiring their own active, non-removed membership", () => {
    const b = body();
    const memberNotifyIdx = b.indexOf("v_request.member_id,\n      'lesson_provider_reassigned',");
    expect(memberNotifyIdx).toBeGreaterThan(-1);
    const guardStart = b.lastIndexOf("if exists (", memberNotifyIdx);
    expect(guardStart).toBeGreaterThan(-1);
    const guard = b.slice(guardStart, memberNotifyIdx);
    expect(guard).toContain("cm.user_id    = v_request.member_id");
    expect(guard).toContain("cm.club_id    = v_actor_club_id");
    expect(guard).toContain("cm.status     = 'active'");
    expect(guard).toContain("cm.removed_at is null");
  });

  it("the new provider's own lesson_request_received notification is unconditional (already proven eligible above) — reassignment/status-transition semantics are otherwise unchanged", () => {
    const b = body();
    expect(b).toContain("raise exception 'same_pro';");
    expect(b).toContain("raise exception 'cannot_assign_to_self';");
    expect(b).toContain("status             = 'pending',");
    expect(b).toContain("last_actor_role    = v_actor_role,");
  });
});

describe("B4/B5. get_club_pros / get_admin_club_pros — candidates and their role are membership-derived", () => {
  it("15. get_club_pros candidates require an active, non-removed club_memberships row; role/is_lesson_provider read from that row", () => {
    const b = functionBody("get_club_pros");
    expect(b).toContain("from public.club_memberships cm");
    expect(b).toContain("join public.profiles p on p.id = cm.user_id");
    expect(b).toContain("cm.club_id            = v_club_id");
    expect(b).toContain("cm.status             = 'active'");
    expect(b).toContain("cm.removed_at         is null");
    expect(b).toContain("cm.user_id            <> auth.uid()");
    expect(b).toContain("cm.role               in ('pro', 'admin', 'staff')");
    expect(b).toContain("cm.is_lesson_provider = true");
    expect(b).toContain("select p.id, p.first_name, p.last_name, cm.role, cm.is_lesson_provider");
  });

  it("16. get_admin_club_pros candidates require an active, non-removed club_memberships row; role/is_lesson_provider read from that row", () => {
    const b = functionBody("get_admin_club_pros");
    expect(b).toContain("from public.club_memberships cm");
    expect(b).toContain("cm.club_id            = v_club_id");
    expect(b).toContain("cm.status             = 'active'");
    expect(b).toContain("cm.removed_at         is null");
    expect(b).toContain("cm.role               in ('pro', 'admin', 'staff')");
    expect(b).toContain("cm.is_lesson_provider = true");
    // caller-role boundary preserved exactly (admin-or-staff)
    expect(b).toContain("if v_role not in ('admin', 'staff') then raise exception 'insufficient_role'; end if;");
  });

  it("17. neither function selects p.role/p.is_lesson_provider from profiles — role is membership-derived, not profile-derived", () => {
    expect(functionBody("get_club_pros")).not.toContain("p.role, p.is_lesson_provider");
    expect(functionBody("get_admin_club_pros")).not.toContain("p.role, p.is_lesson_provider");
  });
});

describe("C. cancel_event — caller club/role membership-derived; Admin/Staff/Pro authority and Pro ownership unchanged", () => {
  const body = () => functionBody("cancel_event");

  it("18. caller club/role are resolved via current_user_club_id()/current_user_role() — v_profile is not declared, fetched, or read anywhere in the function body", () => {
    const b = body();
    expect(b).toContain("select public.current_user_club_id(), public.current_user_role()\n    into v_club_id, v_role;");
    expect(b).not.toMatch(/v_profile\s+public\.profiles%rowtype/);
    expect(b).not.toContain("select * into v_profile from public.profiles");
    // Inline comments inside this body reference the OLD, pre-44A
    // behavior in prose (see line ~829's "the pre-44A body, whose
    // v_profile.club_id was also null") purely for documentation — the
    // substantive check is that v_profile is never declared/fetched above.
  });

  it("Admin/Staff/Pro authority model is unchanged — same three roles, same is-distinct-from-NULL-safe rejection", () => {
    const b = body();
    expect(b).toContain("if v_role is distinct from 'admin' and v_role is distinct from 'pro' and v_role is distinct from 'staff' then");
    expect(b).toContain("raise exception 'insufficient_role';");
  });

  it("19. Pro creator/ownership restriction is intact, unchanged", () => {
    const b = body();
    expect(b).toContain("if v_role = 'pro' and v_event.created_by is distinct from auth.uid() then");
  });

  it("20. event row locking, Stripe Checkout invalidation fan-out, participant/reservation mutation, and the returned jsonb shape are unchanged", () => {
    const b = body();
    expect(b).toContain("for update;");
    expect(b).toContain("_invalidate_or_flag_open_checkout_attempt(v_payment_id_for_checkout_guard)");
    expect(b).toContain("status            = 'cancelled',");
    expect(b).toContain("cancellation_kind = 'admin',");
    expect(b).toContain("'event',         to_jsonb(v_result),");
    expect(b).toContain("'notifications', v_notifications");
  });
});

describe("D. notification_deliveries — admin-only, current-active-club-scoped read RLS", () => {
  it("21/22. admin_select policy scopes to the caller's VERIFIED current club and requires the Admin role, both membership-derived", () => {
    const s = src();
    const idx = s.indexOf('alter policy "admin_select"');
    expect(idx).toBeGreaterThan(-1);
    const block = s.slice(idx, idx + 250);
    expect(block).toContain("on public.notification_deliveries");
    expect(block).toContain("club_id = public.current_user_club_id()");
    expect(block).toContain("public.current_user_role() = 'admin'");
  });

  it("23. a removed/former Admin cannot satisfy the policy — it no longer reads profiles directly at all", () => {
    const s = src();
    const idx = s.indexOf('alter policy "admin_select"');
    const block = s.slice(idx, idx + 250);
    expect(block).not.toMatch(/from profiles/);
  });

  it("no INSERT/UPDATE/DELETE policy is introduced for notification_deliveries; no other table's RLS is touched", () => {
    const s = src();
    expect(s).not.toMatch(/create policy/i);
    // Exactly one ALTER POLICY statement in the whole file, and it is the
    // "admin_select" (read) policy — no policy targeting insert/update/
    // delete is added. (cancel_event's own unrelated "for update;" row
    // lock clause is not an RLS policy command and is deliberately not
    // matched here.)
    const policyMatches = [...s.matchAll(/alter policy\s+"([^"]+)"/gi)];
    expect(policyMatches.length).toBe(1);
    expect(policyMatches[0][1]).toBe("admin_select");
  });
});

describe("no unrelated behavior changed", () => {
  it("24. no notification kind/preference schema change", () => {
    const s = src();
    expect(s).not.toMatch(/notifications_kind_check/);
    expect(s).not.toMatch(/notification_preferences_kind_check/);
    expect(s).not.toMatch(/create table|alter table.*add column/i);
  });

  it("25. no Communications UI change — the Server Action still calls send_announcement_v2 unmodified", () => {
    const s = readSource(ACTIONS_PATH);
    expect(s).toContain('supabase.rpc("send_announcement_v2", {\n    p_title: title,\n    p_body:  body,');
  });

  it("26. no payment, reservation, waiver, or Phase 39 (reservation player search) RPC is redefined — cancel_event's own preserved Stripe Checkout fan-out (an unmodified read of the existing payments table) is the only payment-domain reference in this file", () => {
    const s = src();
    // Only functions actually redefined by 0207 (cited in its own header):
    // send_announcement (dropped), submit_lesson_request,
    // admin_create_lesson_request, reassign_lesson_provider, get_club_pros,
    // get_admin_club_pros, cancel_event, plus the notification_deliveries
    // RLS policy. No OTHER function signature is redefined.
    const redefined = [...s.matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]);
    expect(redefined.sort()).toEqual(
      [
        "admin_create_lesson_request",
        "cancel_event",
        "get_admin_club_pros",
        "get_club_pros",
        "reassign_lesson_provider",
        "submit_lesson_request",
      ].sort()
    );
    // "Stripe Checkout" appears only inside cancel_event's preserved,
    // unmodified 0161 fan-out comments/logic — not a new payment surface.
    expect(s).not.toMatch(/payment_mode/i);
    expect(s).not.toMatch(/reservation_player_search|reservation_player_activity|reservation_participants/);
    expect(s).not.toMatch(/create_reservation\(|update_member_reservation\(|admin_cancel_reservation|accept_member_waiver|set_member_waiver_required|publish_waiver_pdf_version/);
  });

  it("every redefined function keeps its original signature — no GRANT/REVOKE statements are needed or included", () => {
    const s = src();
    expect(s).not.toMatch(/revoke execute|grant\s+execute/);
  });

  it("0207 is a single self-contained transaction — exactly one begin;/commit; pair, no other migration file's DDL is re-executed inside it", () => {
    const s = src();
    const beginMatches = s.match(/^begin;$/gm) ?? [];
    const commitMatches = s.match(/^commit;$/gm) ?? [];
    expect(beginMatches.length).toBe(1);
    expect(commitMatches.length).toBe(1);
    // Source-migration citations belong in comments (traceability, required
    // by this checkpoint's own process) but no other migration's CREATE
    // TABLE/ALTER TABLE/CREATE POLICY statements are reproduced here.
    expect(s).not.toMatch(/create table|alter table/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// E. admin_create_lesson_request retirement (0208) — final-state assertions
// ═══════════════════════════════════════════════════════════════════════════
// 0207 is immutable and correctly still CONTAINS a full historical
// `create or replace function public.admin_create_lesson_request(...)`
// definition (proven above, section "26.") — that is 0207's own applied
// history and must never be asserted away. What changed is the CURRENT,
// LIVE state of the database and the repository: 0208 drops that function,
// and its now-dead TypeScript call site/type is removed. These assertions
// prove the final state, not 0207's own historical content.

let cached0208Src: string | null = null;
function src0208(): string {
  if (cached0208Src === null) cached0208Src = readSource(MIGRATION_0208);
  return cached0208Src;
}

describe("0208 — exact-signature drop, no other function touched", () => {
  it("contains the exact DROP FUNCTION for admin_create_lesson_request's full original signature", () => {
    const s = src0208();
    expect(s).toContain(
      "drop function public.admin_create_lesson_request(\n  uuid,\n  uuid,\n  integer,\n  uuid,\n  uuid,\n  text,\n  jsonb\n);"
    );
  });

  it("does not use CASCADE on the DROP statement itself", () => {
    const s = src0208();
    const idx = s.indexOf("drop function public.admin_create_lesson_request(");
    expect(idx).toBeGreaterThan(-1);
    const end = s.indexOf(";", idx);
    const dropStatement = s.slice(idx, end + 1);
    expect(dropStatement).not.toMatch(/cascade/i);
  });

  it("does not touch admin_create_member_lesson, submit_lesson_request, reassign_lesson_provider, or any other function/table/policy — no CREATE/ALTER DDL of any kind, only the one DROP", () => {
    const s = src0208();
    // Prose in this file's own header legitimately NAMES the untouched
    // functions (documenting scope) — the substantive check is that no DDL
    // statement targets them, and that the DROP is the only statement.
    expect(s).not.toMatch(/create or replace function/i);
    expect(s).not.toMatch(/create table|alter table|create policy|alter policy|drop table|drop policy/i);
    const dropMatches = s.match(/^drop function/gim) ?? [];
    expect(dropMatches.length).toBe(1);
    expect(s).not.toMatch(/drop function public\.admin_create_member_lesson/i);
  });

  it("is a single self-contained transaction", () => {
    const s = src0208();
    expect(s.match(/^begin;$/gm) ?? []).toHaveLength(1);
    expect(s.match(/^commit;$/gm) ?? []).toHaveLength(1);
  });
});

describe("source retirement — no live reference to the retired path remains", () => {
  it("lessons/actions.ts no longer exports adminCreateLessonRequestAction or AdminCreateLessonParams", () => {
    const s = readSource(LESSONS_ACTIONS_PATH);
    expect(s).not.toMatch(/adminCreateLessonRequestAction/);
    expect(s).not.toMatch(/AdminCreateLessonParams/);
  });

  it("lessons/actions.ts contains no .rpc(\"admin_create_lesson_request\" call site", () => {
    const s = readSource(LESSONS_ACTIONS_PATH);
    expect(s).not.toMatch(/\.rpc\(\s*["']admin_create_lesson_request["']/);
  });

  it("db/types.ts contains no admin_create_lesson_request Functions entry", () => {
    const s = readSource(TYPES_PATH);
    expect(s).not.toMatch(/\n\s*admin_create_lesson_request:\s*\{/);
  });

  it("admin_create_member_lesson and adminCreateMemberLessonAction remain, untouched, as the sole Admin lesson-create path", () => {
    const s = readSource(LESSONS_ACTIONS_PATH);
    expect(s).toContain("export async function adminCreateMemberLessonAction(");
    expect(s).toContain('supabase.rpc("admin_create_member_lesson"');
    const typesSrc = readSource(TYPES_PATH);
    expect(typesSrc).toMatch(/\n\s*admin_create_member_lesson:\s*\{/);
  });

  it("historical notification kinds/templates for the retired path (lesson_admin_requested) are NOT removed — historical notification rows may still need to render", () => {
    const s = readSource(LESSONS_ACTIONS_PATH);
    expect(s).toContain("lesson_admin_requested");
    expect(s).toContain("lessonAdminRequestedTemplate");
  });
});
