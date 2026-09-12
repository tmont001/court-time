import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// Bug-fix checkpoint — send_announcement_v2 (migration 0102, already
// applied) generates its announcement batch id via an unqualified
// uuid_generate_v4() call inside a plpgsql function body pinned to
// `set search_path = public, pg_temp`. uuid-ossp's uuid_generate_v4() was
// installed by 0001_initial_schema.sql without a SCHEMA clause, which
// Supabase places in the `extensions` schema — not on this function's
// pinned search_path. Every OTHER uuid_generate_v4() call in this repo is a
// column DEFAULT expression (its function OID is resolved once at DDL time
// and is unaffected by any later session's search_path), which is why
// table inserts elsewhere were never affected — this was the only plpgsql
// FUNCTION BODY call to that name, and it failed at runtime with Postgres
// error 42883 ("function uuid_generate_v4() does not exist"), confirmed via
// a temporary runtime diagnostic in communicationsActions.ts (a
// [communications/send_announcement_v2] console.error) that has since been
// removed — runtime QA confirmed the 0171 fix and the diagnostic's job was
// done; see the "temporary diagnostic has been removed" describe block
// below for that removal's own coverage.
//
// Fix: migration 0171 recreates send_announcement_v2 with the exact same
// body, changing ONLY the batch-uuid expression to gen_random_uuid() — the
// repo's own established, always-resolvable (core Postgres, no extension,
// no schema qualification needed) UUID convention, used by 14+ other
// migrations since 0031_club_invites.sql ("Tokens are generated using
// gen_random_uuid() — no pgcrypto required").
//
// This test currently points at the CURRENT authoritative source for
// send_announcement_v2. Before 0171 exists, that is 0102 itself (RED —
// proves the bug). Once 0171 is created, CREATE OR REPLACE makes 0171 the
// new authoritative source for the live function, and this test is updated
// to read 0171 instead (GREEN).

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const MIGRATION_0177_PATH = "supabase/migrations/0177_announcement_active_membership_eligibility.sql";
const MIGRATION_0171_PATH = "supabase/migrations/0171_fix_announcement_batch_uuid.sql";
const MIGRATION_0170_PATH = "supabase/migrations/0170_communications_activity_rpc.sql";
const MIGRATION_0102_PATH = "supabase/migrations/0102_communications_delivery_identity.sql";
const ACTIONS_PATH        = "src/app/(app)/admin/communications/communicationsActions.ts";

function currentAuthoritativeSource(): string {
  // Mirrors what CREATE OR REPLACE does in the live database: once 0177
  // exists (the Phase 36E announcement-eligibility correction), it is the
  // function's current definition; else 0171 if that exists; else 0102.
  if (existsSync(join(process.cwd(), MIGRATION_0177_PATH))) return readSource(MIGRATION_0177_PATH);
  return existsSync(join(process.cwd(), MIGRATION_0171_PATH))
    ? readSource(MIGRATION_0171_PATH)
    : readSource(MIGRATION_0102_PATH);
}

describe("1. 0171 exists", () => {
  it("supabase/migrations/0171_fix_announcement_batch_uuid.sql exists", () => {
    expect(existsSync(join(process.cwd(), MIGRATION_0171_PATH))).toBe(true);
  });
});

describe("2-3. send_announcement_v2 no longer uses unqualified uuid_generate_v4() — uses gen_random_uuid() instead", () => {
  it("the currently authoritative source's send_announcement_v2 body contains no unqualified uuid_generate_v4() call", () => {
    const s = currentAuthoritativeSource();
    const fnStart = s.lastIndexOf("create or replace function public.send_announcement_v2(");
    expect(fnStart, "send_announcement_v2 definition not found").toBeGreaterThan(-1);
    const fnEnd = s.indexOf("$$;", s.indexOf("as $$", fnStart)) + 3;
    const fnBody = s.slice(fnStart, fnEnd);
    expect(fnBody).not.toMatch(/[^.]uuid_generate_v4\(\)/);
  });

  it("v_batch_id is generated via gen_random_uuid() — the repo's established, always-resolvable UUID convention", () => {
    const s = currentAuthoritativeSource();
    const fnStart = s.lastIndexOf("create or replace function public.send_announcement_v2(");
    const fnEnd = s.indexOf("$$;", s.indexOf("as $$", fnStart)) + 3;
    const fnBody = s.slice(fnStart, fnEnd);
    expect(fnBody).toContain("v_batch_id        uuid := gen_random_uuid();");
  });
});

describe("4-7. function contract is unchanged: signature, return type, SECURITY DEFINER, search_path", () => {
  it("signature is still send_announcement_v2(p_title text, p_body text) returning jsonb", () => {
    const s = currentAuthoritativeSource();
    expect(s).toContain("create or replace function public.send_announcement_v2(\n  p_title text,\n  p_body  text\n)\nreturns jsonb");
  });

  it("still SECURITY DEFINER with search_path pinned to public, pg_temp", () => {
    const s = currentAuthoritativeSource();
    const fnStart = s.lastIndexOf("create or replace function public.send_announcement_v2(");
    const fnDecl = s.slice(fnStart, fnStart + 300);
    expect(fnDecl).toContain("security definer");
    expect(fnDecl).toContain("set search_path = public, pg_temp");
  });
});

describe("8-13. every other behavior of send_announcement_v2 is preserved verbatim", () => {
  it("8. announcement preference filtering is unchanged (kind='announcement', enabled defaults true)", () => {
    const s = currentAuthoritativeSource();
    expect(s).toContain("and kind    = 'announcement'");
    expect(s).toMatch(/coalesce\(\s*\(select enabled/);
  });

  it("9. announcement_batch_id is still stamped into each inserted notification's metadata", () => {
    const s = currentAuthoritativeSource();
    expect(s).toContain("'announcement_batch_id', v_batch_id");
  });

  it("10. the exact {notification_id, user_id} recipient list is still returned via a real insert...returning, never a re-query", () => {
    const s = currentAuthoritativeSource();
    expect(s).toContain("returning id, user_id");
    expect(s).toContain("jsonb_agg(jsonb_build_object('notification_id', id, 'user_id', user_id))");
  });

  it("11. recipient_count is still returned, computed from the actual insert row count", () => {
    const s = currentAuthoritativeSource();
    expect(s).toContain("'recipient_count', v_recipient_count");
  });

  it("12. the audit_log 'send_announcement' entry is still written with title/recipient_count/batch_id", () => {
    const s = currentAuthoritativeSource();
    expect(s).toContain("'send_announcement',");
    expect(s).toContain("'recipient_count', v_recipient_count,\n      'batch_id',        v_batch_id");
  });

  it("13. the sending Admin is still excluded from their own announcement's recipients — the column reference changed (profiles.id -> club_memberships.user_id) as of Phase 36E's eligibility fix (0177), but the exclusion itself is unchanged", () => {
    const s = currentAuthoritativeSource();
    const excludesViaClubMemberships = s.includes("and cm.user_id   <> auth.uid()");
    const excludesViaProfiles        = s.includes("and p.id      <> auth.uid()");
    expect(excludesViaClubMemberships || excludesViaProfiles).toBe(true);
  });

  it("title/body validation (not_authenticated, insufficient_role, invalid_announcement) still raise the exact same exception strings the Server Action maps", () => {
    const s = currentAuthoritativeSource();
    expect(s).toContain("raise exception 'not_authenticated'");
    expect(s).toContain("raise exception 'insufficient_role'");
    expect(s).toContain("raise exception 'invalid_announcement'");
  });
});

describe("14. no 0170 changes", () => {
  it("0170's own content is untouched by this bug-fix checkpoint", () => {
    const s = readSource(MIGRATION_0170_PATH);
    expect(s).toContain("create or replace function public.get_communications_activity(");
    expect(s).not.toMatch(/uuid_generate_v4|gen_random_uuid/);
  });
});

describe("15. no table/RLS changes", () => {
  it("0171 contains no ALTER TABLE, CREATE POLICY, or ALTER POLICY statements", () => {
    if (!existsSync(join(process.cwd(), MIGRATION_0171_PATH))) return; // pre-fix: nothing to check yet
    const s = readSource(MIGRATION_0171_PATH);
    expect(s).not.toMatch(/alter table/i);
    expect(s).not.toMatch(/create policy/i);
    expect(s).not.toMatch(/alter policy/i);
  });
});

describe("16. no payment-domain changes", () => {
  it("0171 never references Stripe/payment tables or columns", () => {
    if (!existsSync(join(process.cwd(), MIGRATION_0171_PATH))) return; // pre-fix: nothing to check yet
    const s = readSource(MIGRATION_0171_PATH);
    expect(s).not.toMatch(/stripe|payment_mode|court_time_payments/i);
  });
});

describe("EXECUTE privilege preservation", () => {
  it("0171 revokes from public/anon and grants to authenticated, matching 0102's original hardening", () => {
    if (!existsSync(join(process.cwd(), MIGRATION_0171_PATH))) return; // pre-fix: nothing to check yet
    const s = readSource(MIGRATION_0171_PATH);
    expect(s).toContain("revoke execute on function public.send_announcement_v2(text, text) from public, anon;");
    expect(s).toContain("grant  execute on function public.send_announcement_v2(text, text) to authenticated;");
  });
});

describe("temporary diagnostic has been removed — runtime QA confirmed the 0171 fix", () => {
  it("communicationsActions.ts no longer logs [communications/send_announcement_v2]", () => {
    const s = readSource(ACTIONS_PATH);
    expect(s).not.toContain("[communications/send_announcement_v2]");
    expect(s).not.toMatch(/console\.error\(.*send_announcement_v2/);
  });

  it("the error branch is back to its pre-diagnostic shape — maps the RPC error directly with no intervening logging statement", () => {
    const s = readSource(ACTIONS_PATH);
    expect(s).toMatch(/if \(error\) \{\s*const key = error\.message\.match/);
  });
});
