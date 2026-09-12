import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 36E correction — announcement eligibility bug, BOTH halves:
//
// PART 1 (recipients): send_announcement_v2's recipient selection read
// profiles.club_id/profiles.status — a LEGACY PROJECTION that
// 0081_club_membership_compatibility_foundation.sql's own trigger
// (trg_project_membership_to_profile) deliberately leaves stale once a
// club_memberships row is removed or deactivated (its own header comment,
// lines 448-453: "Legacy columns ... are deliberately left untouched here
// ... existing admin RPCs still locate and reactivate inactive users
// through profiles.club_id"). That design is correct for its OWN purpose
// but made removed/deactivated members keep matching forever — both the
// in-app notification AND the email, since communicationsActions.ts
// drives email entirely by looping the SAME {notification_id, user_id}[]
// the RPC itself returns (no second, separate recipient query).
//
// PART 2 (sender): found in review, before 0177 was ever applied. The
// original draft of 0177 kept the SENDER'S OWN admin-authorization check
// on the identical stale profiles.role/profiles.club_id — the exact same
// class of bug, on the other side of the function. A former Admin whose
// club_memberships row was later removed/deactivated would keep
// v_profile.role='admin' and v_profile.club_id pointing at their old club
// forever, letting this SECURITY DEFINER RPC keep accepting them as an
// Admin of a club they no longer belong to.
//
// FIX (both halves): recipient selection reads public.club_memberships
// directly (cm.club_id/cm.status/cm.removed_at); sender authorization uses
// current_user_club_id()/current_user_role() — the same canonical helpers
// (0082_active_club_authorization_foundation.sql) every other membership-
// aware RPC and RLS policy already build on, and the exact pattern
// remove_club_member/set_member_status (0117) already establish for this
// same "is the caller currently an active Admin" question. Neither half
// ever reads profiles.role/club_id/status again.
//
// This is pure SQL-migration content with no live Postgres available in
// this test environment (this repo's established baseline — see
// announcementBatchUuidFix.regression.test.ts's own precedent for the
// identical function). Recipient/sender eligibility is proven via the
// actual migration text; no real email is ever sent by these tests.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const MIGRATION_0177 = "supabase/migrations/0177_announcement_active_membership_eligibility.sql";
const MIGRATION_0082 = "supabase/migrations/0082_active_club_authorization_foundation.sql";
const MIGRATION_0081 = "supabase/migrations/0081_club_membership_compatibility_foundation.sql";
const ACTIONS_PATH   = "src/app/(app)/admin/communications/communicationsActions.ts";

// Slices exactly the function body — from its own signature up to the
// `commit;` that follows its closing `$$;` — never spilling into the
// trailing VERIFICATION comment block, which deliberately quotes OLD
// (pre-fix) patterns in prose and would otherwise produce false matches.
function announcementBody(): string {
  const src = readSource(MIGRATION_0177);
  const start = src.indexOf("create or replace function public.send_announcement_v2(");
  if (start === -1) throw new Error("send_announcement_v2 definition not found in 0177");
  const end = src.indexOf("\ncommit;", start);
  if (end === -1 || end <= start) throw new Error("commit; terminator not found after function body");
  return src.slice(start, end);
}

describe("SENDER AUTHORIZATION — uses canonical club_memberships state, never the profiles legacy projection", () => {
  it("1. an active current Admin can send: current_user_role()='admin' is the only condition that passes the check", () => {
    const body = announcementBody();
    expect(body).toContain("select public.current_user_club_id(), public.current_user_role()\n    into v_club_id, v_role;");
    expect(body).toContain("if v_role is distinct from 'admin' then");
  });

  it("2/3/4. removed, inactive, and suspended Admin memberships cannot send — current_user_role() traces to _current_user_active_membership(), which requires status='active' and removed_at is null", () => {
    const helperCallerSrc = announcementBody();
    expect(helperCallerSrc).toContain("public.current_user_role()");

    const roleFnSrc = readSource(MIGRATION_0082);
    const roleFnIdx = roleFnSrc.indexOf("create or replace function public.current_user_role()");
    expect(roleFnIdx).toBeGreaterThan(-1);
    const roleFnBody = roleFnSrc.slice(roleFnIdx, roleFnSrc.indexOf("$$;", roleFnIdx) + 3);
    expect(roleFnBody).toContain("select role from public._current_user_active_membership();");

    const helperIdx = roleFnSrc.indexOf("create or replace function public._current_user_active_membership()");
    expect(helperIdx).toBeGreaterThan(-1);
    const helperBody = roleFnSrc.slice(helperIdx, roleFnSrc.indexOf("$$;", helperIdx) + 3);
    expect(helperBody).toContain("cm.status = 'active'");
    expect(helperBody).toContain("cm.removed_at is null");
    // A removed OR deactivated membership yields zero rows here, hence
    // current_user_role() returns NULL for exactly those three cases
    // (removed, inactive, suspended) — regardless of profiles.role.
  });

  it("5/6. stale profiles.role/profiles.club_id are never read by send_announcement_v2 — not even as a fallback", () => {
    const body = announcementBody();
    expect(body).not.toMatch(/v_profile\.role/);
    expect(body).not.toMatch(/v_profile\.club_id/);
    expect(body).not.toContain("from public.profiles p");
    expect(body).not.toContain("select * into v_profile");
  });

  it("7/8/9. active Member, Pro, and Staff cannot send — the check rejects ANY role other than the literal string 'admin', not merely NULL", () => {
    const body = announcementBody();
    // is distinct from is NULL-safe AND rejects every non-'admin' string
    // equally — 'member'/'pro'/'staff' are rejected exactly like NULL.
    const idx = body.indexOf("if v_role is distinct from 'admin' then");
    expect(idx).toBeGreaterThan(-1);
    const block = body.slice(idx, idx + 120);
    expect(block).toContain("raise exception 'insufficient_role';");
  });

  it("the NULL-safe `is distinct from` form is used, not a plain `<>` — a plain `<>` against a NULL role would silently evaluate to NULL and skip the exception in PL/pgSQL", () => {
    const body = announcementBody();
    expect(body).toContain("v_role is distinct from 'admin'");
    expect(body).not.toMatch(/v_role\s*<>\s*'admin'/);
  });

  it("not_authenticated is still raised for a genuinely unauthenticated caller, checked before any club/role resolution", () => {
    const body = announcementBody();
    const idx = body.indexOf("if auth.uid() is null then raise exception 'not_authenticated'; end if;");
    expect(idx).toBeGreaterThan(-1);
    const laterIdx = body.indexOf("public.current_user_role()");
    expect(laterIdx).toBeGreaterThan(idx);
  });
});

describe("10. recipient scoping uses the VERIFIED canonical sending club id (v_club_id), never a stale profile column", () => {
  it("v_club_id is assigned from current_user_club_id() and used, alone, to scope recipients", () => {
    const body = announcementBody();
    expect(body).toContain("cm.club_id    = v_club_id");
    expect(body).not.toMatch(/cm\.club_id\s*=\s*v_profile\.club_id/);
    const clubIdOccurrences = (body.match(/cm\.club_id/g) ?? []).length;
    expect(clubIdOccurrences).toBe(1); // exactly the one recipient-scoping reference
  });

  it("v_club_id (not a stale profile column) also feeds the notifications insert and the audit_log entry", () => {
    const body = announcementBody();
    expect(body).toContain("select\n      v_club_id,\n      cm.user_id,");
    expect(body).toContain("values (\n    v_club_id,\n    auth.uid(),");
  });
});

describe("11/12/13/14/15/16/17/18. recipient audience rules are unchanged by the sender-side correction", () => {
  it("11/12/13/14/15. no role filter — active Member, Pro, Staff, and Admin (other than the sender) all remain eligible recipients", () => {
    const body = announcementBody();
    expect(body).toContain("from public.club_memberships cm");
    expect(body).toContain("cm.status     = 'active'");
    expect(body).toContain("cm.removed_at is null");
    expect(body).not.toMatch(/cm\.role\s*=|cm\.role\s+in\s*\(/);
  });

  it("11. an archived/removed Member's membership row (removed_at set) can never match — this is the fix retained from the original recipient-side correction", () => {
    const body = announcementBody();
    expect(body).toContain("cm.removed_at is null");
  });

  it("16. sender remains excluded from their own announcement's recipients", () => {
    const body = announcementBody();
    expect(body).toContain("and cm.user_id   <> auth.uid()");
  });

  it("17. a recipient with the announcement preference explicitly disabled remains excluded; defaults to included when no preference row exists", () => {
    const body = announcementBody();
    expect(body).toContain("where user_id = cm.user_id");
    expect(body).toContain("and kind    = 'announcement'");
    expect(body).toMatch(/coalesce\(\s*\(select enabled/);
  });

  it("18. cross-club membership rows can never be included — recipient selection is scoped to cm.club_id = v_club_id and nothing else", () => {
    const body = announcementBody();
    expect(body).toContain("cm.club_id    = v_club_id");
  });
});

describe("19. email consumes exactly the same returned recipient list as in-app notifications — eligibility cannot drift between channels", () => {
  it("the notifications insert and the returned recipient list come from the SAME insert...returning — no second query ever re-derives recipients", () => {
    const body = announcementBody();
    const insertIdx = body.indexOf("insert into public.notifications");
    const returningIdx = body.indexOf("returning id, user_id", insertIdx);
    expect(insertIdx).toBeGreaterThan(-1);
    expect(returningIdx).toBeGreaterThan(insertIdx);
    const insertOccurrences = (body.match(/insert into public\.notifications/g) ?? []).length;
    expect(insertOccurrences).toBe(1);
  });

  it("communicationsActions.ts loops exactly the RPC's own returned {notification_id, user_id}[] list for email, with no independent club-member/profiles query in between", () => {
    const s = readSource(ACTIONS_PATH);
    const rpcIdx = s.indexOf('supabase.rpc("send_announcement_v2"');
    expect(rpcIdx).toBeGreaterThan(-1);
    const loopIdx = s.indexOf("for (const { notification_id, user_id } of notifications)", rpcIdx);
    expect(loopIdx).toBeGreaterThan(rpcIdx);
    const between = s.slice(rpcIdx, loopIdx);
    expect(between).not.toMatch(/\.from\("(profiles|club_memberships)"\)/);
  });
});

describe("0081's own documented design explains WHY the legacy columns are stale — confirms this is a real, load-bearing behavior of the trigger, not a misreading", () => {
  it("trg_project_membership_to_profile deliberately leaves profiles.club_id/status untouched on removal/deactivation", () => {
    const s = readSource(MIGRATION_0081);
    expect(s).toContain("Legacy columns");
    expect(s).toContain("are deliberately left");
    expect(s).toMatch(/untouched here/);
  });
});

describe("no unrelated Communications behavior changed", () => {
  it("0177 does not touch 0170, any table, any RLS policy, or the payment domain", () => {
    const s = readSource(MIGRATION_0177);
    expect(s).not.toMatch(/alter table/i);
    expect(s).not.toMatch(/create policy/i);
    expect(s).not.toMatch(/alter policy/i);
    expect(s).not.toMatch(/stripe|payment_mode|court_time_payments/i);
    const body = announcementBody();
    expect(body).not.toContain("get_communications_activity");
    expect(body).not.toContain("get_announcement_batch_delivery_context");
  });

  it("EXECUTE privileges are unchanged — no new GRANT/REVOKE statements (same function name/signature carries the old grants forward)", () => {
    const s = readSource(MIGRATION_0177);
    expect(s).not.toMatch(/revoke execute|grant\s+execute/);
  });

  it("function contract (signature, SECURITY DEFINER, search_path, batch id generation, audit_log entry) is otherwise preserved", () => {
    const body = announcementBody();
    expect(body).toContain("create or replace function public.send_announcement_v2(\n  p_title text,\n  p_body  text\n)\nreturns jsonb");
    expect(body).toContain("security definer");
    expect(body).toContain("set search_path = public, pg_temp");
    expect(body).toContain("v_batch_id        uuid := gen_random_uuid();");
    expect(body).toContain("'send_announcement',");
    expect(body).toContain("raise exception 'not_authenticated'");
    expect(body).toContain("raise exception 'insufficient_role'");
    expect(body).toContain("raise exception 'invalid_announcement'");
  });
});
