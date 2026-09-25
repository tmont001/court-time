import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 44B — Targeted Audience Backend + Recipient Preview.
//
// Adds audience_mode = 'all' | 'specific' to announcements. PostgreSQL
// function identity includes the argument signature, so send_announcement_v2
// now exists as TWO co-existing overloads: a new four-argument canonical
// implementation, and the pre-existing two-argument signature redefined as
// a thin, temporary compatibility wrapper (retired in Phase 44D) so the
// still-deployed pilot app keeps working unmodified during rollout. A new
// private helper (_announcement_recipient_candidates) is the single shared
// eligibility definition for send, preview, and the selector-listing RPC —
// this is the anti-drift property this suite is most concerned with
// proving.
//
// This is pure SQL-migration content with no live Postgres available in
// this test environment — the same established baseline every prior
// Communications/44A regression suite in this repo already uses.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const MIGRATION_0209 = "supabase/migrations/0209_phase44b_targeted_audience_backend.sql";
const TYPES_PATH      = "src/lib/db/types.ts";
const ACTIONS_PATH    = "src/app/(app)/admin/communications/communicationsActions.ts";
const ANNOUNCEMENTS_SECTION_PATH = "src/app/(app)/admin/communications/AnnouncementsSection.tsx";

let cachedSrc: string | null = null;
function src(): string {
  if (cachedSrc === null) cachedSrc = readSource(MIGRATION_0209);
  return cachedSrc;
}

function sliceBody(startMarker: string, terminator: string, fromIndex = 0): string {
  const s = src();
  const start = s.indexOf(startMarker, fromIndex);
  if (start === -1) throw new Error(`marker not found: ${startMarker}`);
  const end = s.indexOf(terminator, start);
  if (end === -1 || end <= start) throw new Error(`terminator not found after: ${startMarker}`);
  return s.slice(start, end + terminator.length);
}

function helperBody(): string {
  return sliceBody("create or replace function public._announcement_recipient_candidates(", "$$;");
}

function fourArgSendBody(): string {
  return sliceBody(
    "create or replace function public.send_announcement_v2(\n  p_title               text,\n  p_body                text,\n  p_audience_mode       text,\n  p_recipient_user_ids  uuid[]\n)",
    "$$;"
  );
}

function twoArgWrapperBody(): string {
  return sliceBody(
    "create or replace function public.send_announcement_v2(\n  p_title text,\n  p_body  text\n)",
    "$$;"
  );
}

function previewBody(): string {
  return sliceBody("create or replace function public.preview_announcement_recipients(", "$$;");
}

function selectorBody(): string {
  return sliceBody("create or replace function public.get_announcement_recipient_candidates()", "$$;");
}

describe("PRIVATE HELPER — _announcement_recipient_candidates", () => {
  it("requires active, non-removed club_memberships row in the given club", () => {
    const b = helperBody();
    expect(b).toContain("from public.club_memberships cm");
    expect(b).toContain("cm.club_id    = p_club_id");
    expect(b).toContain("cm.status     = 'active'");
    expect(b).toContain("cm.removed_at is null");
  });

  it("submitted IDs only narrow/intersect — never widen — club scope; p_club_id is the only club-scoping input", () => {
    const b = helperBody();
    expect(b).toContain("p_recipient_user_ids is null or cm.user_id = any(p_recipient_user_ids)");
    // Exactly one club_id predicate, always against the server-derived
    // p_club_id parameter — never against a value sourced from
    // p_recipient_user_ids or any other client-shaped input.
    const clubIdPredicates = (b.match(/cm\.club_id\s*=\s*p_club_id/g) ?? []).length;
    expect(clubIdPredicates).toBe(1);
    expect(b).not.toMatch(/cm\.club_id\s*=\s*any/);
  });

  it("excludes p_exclude_user_id when non-null", () => {
    const b = helperBody();
    expect(b).toContain("p_exclude_user_id    is null or cm.user_id <> p_exclude_user_id");
  });

  it("DISTINCT so duplicate submitted IDs cannot duplicate a candidate", () => {
    const b = helperBody();
    expect(b).toMatch(/select distinct\s*\n\s*cm\.user_id,/);
  });

  it("returns announcement_enabled (preference state) alongside every candidate, including opted-out ones — filtering is the CONSUMER's job, not this helper's", () => {
    const b = helperBody();
    expect(b).toContain("announcement_enabled");
    expect(b).toContain("from public.notification_preferences np");
    expect(b).toContain("np.kind    = 'announcement'");
    expect(b).toMatch(/coalesce\(\s*\(select np\.enabled/);
    // No WHERE clause filters on announcement_enabled inside the helper
    // itself — it must return candidates regardless of preference state.
    const whereIdx = b.indexOf("where cm.club_id");
    const bodyAfterWhere = b.slice(whereIdx);
    expect(bodyAfterWhere).not.toMatch(/announcement_enabled\s*=\s*(true|false)/);
  });

  it("EXECUTE revoked from public, anon, AND authenticated — never a client-callable capability", () => {
    const s = src();
    expect(s).toContain(
      "revoke execute on function public._announcement_recipient_candidates(uuid, uuid, uuid[])\n  from public, anon, authenticated;"
    );
    // No corresponding GRANT to authenticated anywhere for this function.
    expect(s).not.toMatch(/grant\s+execute on function public\._announcement_recipient_candidates/);
  });

  it("SECURITY DEFINER, STABLE, pinned search_path", () => {
    const b = helperBody();
    expect(b).toContain("security definer");
    expect(b).toContain("stable");
    expect(b).toContain("set search_path = public, pg_temp");
  });
});

describe("SELECTOR — get_announcement_recipient_candidates", () => {
  const b = () => selectorBody();

  it("Admin-only, membership-derived (current_user_club_id/current_user_role), never profiles.role", () => {
    const body = b();
    expect(body).toContain("select public.current_user_club_id(), public.current_user_role()");
    expect(body).toContain("if v_role is distinct from 'admin' then raise exception 'insufficient_role'; end if;");
    expect(body).not.toMatch(/v_role\s+not\s+in\s*\(\s*'admin'\s*,\s*'staff'/);
  });

  it("current club only, active/non-removed only, sender excluded, role sourced from club_memberships", () => {
    const body = b();
    expect(body).toContain("from public._announcement_recipient_candidates(v_club_id, auth.uid()) c");
    expect(body).toContain("join public.club_memberships cm on cm.user_id = c.user_id and cm.club_id = v_club_id");
    expect(body).toContain("select p.id, p.first_name, p.last_name, cm.role, c.announcement_enabled");
  });

  it("no email/phone/membership-type/private roster data is selected — only display fields", () => {
    const body = b();
    expect(body).not.toMatch(/\bphone\b/);
    expect(body).not.toMatch(/\bemail\b/);
    expect(body).not.toMatch(/membership_type|membership_status/);
  });

  it("does not reuse or widen get_members() — an entirely separate query, no reference to it", () => {
    const body = b();
    expect(body).not.toMatch(/get_members/);
  });

  it("opted-out candidates are NOT filtered out — announcement_enabled is returned as-is, including false", () => {
    const body = b();
    expect(body).not.toMatch(/where[\s\S]*announcement_enabled\s*=\s*true/);
    expect(body).toContain("c.announcement_enabled");
  });

  it("ordering is fully deterministic — last_name, first_name, then p.id as the final tie-breaker", () => {
    const body = b();
    expect(body).toContain(
      "order by\n       p.last_name nulls last,\n       p.first_name nulls last,\n       p.id;"
    );
  });

  it("EXECUTE granted to authenticated only (RPC-level auth is the real gate, matching every sibling listing RPC)", () => {
    const s = src();
    expect(s).toContain("revoke execute on function public.get_announcement_recipient_candidates() from public, anon;");
    expect(s).toContain("grant  execute on function public.get_announcement_recipient_candidates() to authenticated;");
  });
});

describe("PREVIEW — preview_announcement_recipients", () => {
  const b = () => previewBody();

  it("Admin-only, membership-derived", () => {
    const body = b();
    expect(body).toContain("select public.current_user_club_id(), public.current_user_role()");
    expect(body).toContain("if v_role is distinct from 'admin' then raise exception 'insufficient_role'; end if;");
  });

  it("invalid/unrecognized audience_mode (including NULL, via is distinct from) is rejected", () => {
    const body = b();
    expect(body).toContain(
      "if p_audience_mode is distinct from 'all' and p_audience_mode is distinct from 'specific' then"
    );
    expect(body).toContain("raise exception 'invalid_audience';");
  });

  it("ALL + non-empty recipient array is rejected", () => {
    const body = b();
    const idx = body.indexOf("if p_audience_mode = 'all'");
    expect(idx).toBeGreaterThan(-1);
    const block = body.slice(idx, idx + 250);
    expect(block).toContain("p_recipient_user_ids is not null");
    expect(block).toContain("array_length(p_recipient_user_ids, 1) > 0");
    expect(block).toContain("raise exception 'invalid_audience';");
  });

  it("SPECIFIC + null/empty recipient array is rejected", () => {
    const body = b();
    const idx = body.indexOf("if p_audience_mode = 'specific'");
    expect(idx).toBeGreaterThan(-1);
    const block = body.slice(idx, idx + 300);
    expect(block).toContain("p_recipient_user_ids is null or array_length(p_recipient_user_ids, 1) is null or array_length(p_recipient_user_ids, 1) = 0");
    expect(block).toContain("raise exception 'invalid_audience';");
  });

  it("calls the canonical helper exactly once, filters announcement_enabled = true", () => {
    const body = b();
    const helperCalls = (body.match(/_announcement_recipient_candidates\(/g) ?? []).length;
    expect(helperCalls).toBe(1);
    expect(body).toContain("where c.announcement_enabled = true;");
  });

  it("recipient-id aggregation is deterministic — array_agg is explicitly ORDER BY c.user_id, not unordered", () => {
    const body = b();
    expect(body).toContain("select coalesce(array_agg(c.user_id order by c.user_id), '{}'::uuid[])");
  });

  it("ALL mode never returns the full eligible roster — eligible_user_ids is NULL for 'all'", () => {
    const body = b();
    expect(body).toContain("v_result_ids := case when p_audience_mode = 'specific' then v_candidates else null end;");
  });

  it("a valid, non-empty SPECIFIC selection that resolves to zero eligible ids SUCCEEDS with count 0 and an empty array — preview never raises for this case", () => {
    const body = b();
    // No no_eligible_recipients / raise anywhere after validation — the
    // function always falls through to a single successful return.
    expect(body).not.toMatch(/no_eligible_recipients/);
    expect(body).toContain("return query select coalesce(array_length(v_candidates, 1), 0), v_result_ids;");
  });

  it("is STABLE — mutates nothing", () => {
    expect(b()).toContain("stable");
  });

  it("EXECUTE granted to authenticated only", () => {
    const s = src();
    expect(s).toContain("revoke execute on function public.preview_announcement_recipients(text, uuid[]) from public, anon;");
    expect(s).toContain("grant  execute on function public.preview_announcement_recipients(text, uuid[]) to authenticated;");
  });
});

describe("SEND — canonical four-argument send_announcement_v2", () => {
  const b = () => fourArgSendBody();

  it("exists as a distinct four-argument function", () => {
    const body = b();
    expect(body).toContain("p_audience_mode       text,");
    expect(body).toContain("p_recipient_user_ids  uuid[]");
    // No defaults, per the locked design — every caller must be explicit.
    expect(body).not.toMatch(/p_audience_mode\s+text\s+default/);
    expect(body).not.toMatch(/p_recipient_user_ids\s+uuid\[\]\s+default/);
  });

  it("title/body validation, limits, not_authenticated/insufficient_role checks preserved byte-identical to 0177", () => {
    const body = b();
    expect(body).toContain("if auth.uid() is null then raise exception 'not_authenticated'; end if;");
    expect(body).toContain("if v_role is distinct from 'admin' then");
    expect(body).toContain("raise exception 'insufficient_role';");
    expect(body).toContain("if trim(p_title) = '' or trim(p_body) = '' then");
    expect(body).toContain("raise exception 'invalid_announcement';");
    expect(body).toContain("if length(trim(p_title)) > 100 or length(trim(p_body)) > 500 then");
  });

  it("audience_mode validated with the identical rules as preview (all+nonempty rejected, specific+empty rejected, NULL-safe)", () => {
    const body = b();
    expect(body).toContain(
      "if p_audience_mode is distinct from 'all' and p_audience_mode is distinct from 'specific' then"
    );
    expect(body).toContain("p_recipient_user_ids is not null");
    expect(body).toContain("array_length(p_recipient_user_ids, 1) > 0");
    expect(body).toContain("p_recipient_user_ids is null or array_length(p_recipient_user_ids, 1) is null or array_length(p_recipient_user_ids, 1) = 0");
  });

  it("recipient resolution calls the SAME canonical helper preview uses, independently, at send time — never reuses a preview result", () => {
    const body = b();
    const helperCalls = (body.match(/_announcement_recipient_candidates\(/g) ?? []).length;
    expect(helperCalls).toBe(1);
    expect(body).toContain("where c.announcement_enabled = true;");
    expect(body).not.toMatch(/eligible_user_ids|preview_announcement_recipients/);
  });

  it("recipient-id aggregation is deterministic — array_agg is explicitly ORDER BY c.user_id, not unordered", () => {
    const body = b();
    expect(body).toContain("select coalesce(array_agg(c.user_id order by c.user_id), '{}'::uuid[])");
  });

  it("SPECIFIC zero-survivor: raises no_eligible_recipients BEFORE the notifications insert and BEFORE the audit_log insert", () => {
    const body = b();
    const raiseIdx  = body.indexOf("raise exception 'no_eligible_recipients';");
    const insertIdx = body.indexOf("insert into public.notifications");
    const auditIdx  = body.indexOf("insert into public.audit_log");
    expect(raiseIdx).toBeGreaterThan(-1);
    expect(insertIdx).toBeGreaterThan(raiseIdx);
    expect(auditIdx).toBeGreaterThan(raiseIdx);
  });

  it("no_eligible_recipients guard is scoped to 'specific' only — ALL mode's pre-existing zero-recipient behavior (silent, audited) is unchanged", () => {
    const body = b();
    const idx = body.indexOf("if p_audience_mode = 'specific' and array_length(v_recipient_ids, 1) is null then");
    expect(idx).toBeGreaterThan(-1);
  });

  it("duplicates are deduplicated (inherited from the helper's own DISTINCT — no separate dedup logic exists or is needed here)", () => {
    const body = b();
    expect(body).not.toMatch(/select distinct|array_agg\(distinct/i);
  });

  it("audience_mode is written to audit_log metadata, additively, alongside the existing fields", () => {
    const body = b();
    const idx = body.indexOf("insert into public.audit_log");
    const block = body.slice(idx, idx + 500);
    expect(block).toContain("'title',           trim(p_title),");
    expect(block).toContain("'recipient_count', v_recipient_count,");
    expect(block).toContain("'batch_id',        v_batch_id,");
    expect(block).toContain("'audience_mode',   p_audience_mode");
  });

  it("batch id generation, notification metadata shape, and return jsonb shape are preserved byte-identical to 0177", () => {
    const body = b();
    expect(body).toContain("v_batch_id        uuid := gen_random_uuid();");
    expect(body).toContain("'announcement_batch_id', v_batch_id");
    expect(body).toContain("'sender_id',             auth.uid(),");
    expect(body).toContain(
      "return jsonb_build_object(\n    'batch_id',        v_batch_id,\n    'recipient_count', v_recipient_count,\n    'notifications',   v_notifications\n  );"
    );
  });

  it("no SMS dispatch of any kind", () => {
    expect(b()).not.toMatch(/sms/i);
  });

  it("EXECUTE granted to authenticated only, matching the two-argument signature's live posture", () => {
    const s = src();
    expect(s).toContain(
      "revoke execute on function public.send_announcement_v2(text, text, text, uuid[]) from public, anon;"
    );
    expect(s).toContain(
      "grant  execute on function public.send_announcement_v2(text, text, text, uuid[]) to authenticated;"
    );
  });
});

describe("SEND — two-argument compatibility wrapper (temporary, retired in Phase 44D)", () => {
  const b = () => twoArgWrapperBody();

  it("delegates to the four-argument implementation with audience_mode='all', p_recipient_user_ids=null", () => {
    const body = b();
    expect(body).toContain("return public.send_announcement_v2(p_title, p_body, 'all', null);");
  });

  it("contains NO independent recipient-resolution logic — no club_memberships query, no notifications insert, no audit_log insert, no helper call of its own", () => {
    const body = b();
    expect(body).not.toMatch(/club_memberships/);
    expect(body).not.toMatch(/insert into public\.notifications/);
    expect(body).not.toMatch(/insert into public\.audit_log/);
    expect(body).not.toMatch(/_announcement_recipient_candidates/);
    expect(body).not.toMatch(/not_authenticated|insufficient_role|invalid_announcement/);
  });

  it("is a one-statement passthrough body", () => {
    const body = b();
    const beginIdx = body.indexOf("begin\n");
    const endIdx   = body.indexOf("\nend;", beginIdx);
    expect(beginIdx).toBeGreaterThan(-1);
    expect(endIdx).toBeGreaterThan(beginIdx);
    const statements = body.slice(beginIdx + 6, endIdx).trim();
    expect(statements).toBe("return public.send_announcement_v2(p_title, p_body, 'all', null);");
  });

  it("no explicit GRANT/REVOKE for the two-argument signature — same signature as before, grants carry forward from CREATE OR REPLACE", () => {
    const s = src();
    expect(s).not.toMatch(/execute on function public\.send_announcement_v2\(text, text\)\s/);
  });

  it("the two-argument signature is NOT dropped anywhere in this migration", () => {
    const s = src();
    expect(s).not.toMatch(/drop function public\.send_announcement_v2\(text, text\)/);
  });
});

describe("SERVER ACTION — sendAnnouncementAction explicitly calls the four-argument RPC", () => {
  it("passes audience_mode/recipient_user_ids on the existing send path — Phase 44C (this checkpoint's successor) now sources these from the Compose UI's own audience state (defaulting to \"all\"/null when absent) rather than the hardcoded literals this test originally locked in", () => {
    const s = readSource(ACTIONS_PATH);
    const idx = s.indexOf('supabase.rpc("send_announcement_v2", {');
    expect(idx).toBeGreaterThan(-1);
    const block = s.slice(idx, idx + 250);
    expect(block).toContain("p_audience_mode:       audienceMode,");
    expect(block).toContain("p_recipient_user_ids:  recipientUserIds,");
  });

  it("new preview/candidate Server Actions exist and rely on RPC-level authorization only, matching this file's established pattern", () => {
    const s = readSource(ACTIONS_PATH);
    expect(s).toContain("export async function getAnnouncementRecipientCandidatesAction(");
    expect(s).toContain('supabase.rpc("get_announcement_recipient_candidates")');
    expect(s).toContain("export async function previewAnnouncementRecipientsAction(");
    expect(s).toContain('supabase.rpc("preview_announcement_recipients"');
  });

  it("both actions are now imported and used by the Compose section — Phase 44C (this checkpoint's successor) wires them into the Specific People picker/preview; see announcementAudienceUI.regression.test.ts for the full 44C coverage", () => {
    const s = readSource(ANNOUNCEMENTS_SECTION_PATH);
    expect(s).toMatch(/getAnnouncementRecipientCandidatesAction/);
    expect(s).toMatch(/previewAnnouncementRecipientsAction/);
  });
});

describe("DEPLOYMENT SAFETY / scope discipline", () => {
  it("no table, column, RLS policy, notification-kind, or preference-schema DDL of any kind", () => {
    const s = src();
    expect(s).not.toMatch(/create table|alter table|create policy|alter policy|drop table|drop policy/i);
    expect(s).not.toMatch(/notifications_kind_check|notification_preferences_kind_check/);
  });

  it("get_communications_activity is NOT redefined in this migration", () => {
    const s = src();
    expect(s).not.toContain("create or replace function public.get_communications_activity(");
  });

  it("get_announcement_batch_delivery_context is NOT redefined in this migration", () => {
    const s = src();
    expect(s).not.toContain("create or replace function public.get_announcement_batch_delivery_context(");
  });

  it("no payment, reservation, waiver, or Phase 39 (reservation player search) function/table is created, redefined, or referenced in executable SQL — the header's own scope-declaration prose naming those domains is not executable content", () => {
    const s = src();
    expect(s).not.toMatch(/payment_mode|stripe/i);
    expect(s).not.toMatch(/reservation_player_search|reservation_player_activity|reservation_participants/);
    expect(s).not.toMatch(/create or replace function public\.\w*waiver/i);
    expect(s).not.toMatch(/from public\.\w*(payment|waiver|reservation)\w*/i);
  });

  it("exactly the five functions in scope are created/redefined — no other function signature is touched", () => {
    const s = src();
    const defined = [...s.matchAll(/create or replace function public\.([\w]+)\(/g)].map((m) => m[1]);
    expect(defined.sort()).toEqual(
      [
        "_announcement_recipient_candidates",
        "get_announcement_recipient_candidates",
        "preview_announcement_recipients",
        "send_announcement_v2",
        "send_announcement_v2", // two overloads, same name
      ].sort()
    );
  });

  it("is a single self-contained transaction", () => {
    const s = src();
    expect(s.match(/^begin;$/gm) ?? []).toHaveLength(1);
    expect(s.match(/^commit;$/gm) ?? []).toHaveLength(1);
  });
});

describe("db/types.ts", () => {
  it("send_announcement_v2's hand-maintained type describes the canonical four-argument shape", () => {
    const s = readSource(TYPES_PATH);
    const idx = s.indexOf("send_announcement_v2: {");
    expect(idx).toBeGreaterThan(-1);
    const block = s.slice(idx, idx + 400);
    expect(block).toContain("p_audience_mode:       string;");
    expect(block).toContain("p_recipient_user_ids:  string[] | null;");
  });

  it("documents the two-argument overload limitation rather than fabricating a misleading union type", () => {
    const s = readSource(TYPES_PATH);
    expect(s).toMatch(/cannot express two distinct\s*\n\s*\/\/ overloads under one key/);
  });

  it("preview_announcement_recipients and get_announcement_recipient_candidates entries exist", () => {
    const s = readSource(TYPES_PATH);
    expect(s).toContain("preview_announcement_recipients: {");
    expect(s).toContain("get_announcement_recipient_candidates: {");
  });
});
