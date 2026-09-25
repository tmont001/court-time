import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 44D — Communications v2 Final Closeout: Activity/history, durable
// body storage, temporary-wrapper retirement, user_pref_enabled security
// hardening.
//
// This is pure SQL-migration content with no live Postgres available in
// this test environment — the same established baseline every prior
// Communications regression suite in this repo already uses.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const MIGRATION_0210 = "supabase/migrations/0210_phase44d_communications_history_security_closeout.sql";
const TYPES_PATH      = "src/lib/db/types.ts";
const PAGE_PATH       = "src/app/(app)/admin/communications/page.tsx";
const ACTIVITY_PATH   = "src/app/(app)/admin/communications/CommunicationsActivitySection.tsx";

let cachedSrc: string | null = null;
function src(): string {
  if (cachedSrc === null) cachedSrc = readSource(MIGRATION_0210);
  return cachedSrc;
}

function sliceBody(startMarker: string, terminator: string): string {
  const s = src();
  const start = s.indexOf(startMarker);
  if (start === -1) throw new Error(`marker not found: ${startMarker}`);
  const end = s.indexOf(terminator, start);
  if (end === -1 || end <= start) throw new Error(`terminator not found after: ${startMarker}`);
  return s.slice(start, end + terminator.length);
}

function sendBody(): string {
  return sliceBody("create or replace function public.send_announcement_v2(", "$$;");
}

function activityBody(): string {
  return sliceBody("create or replace function public.get_communications_activity(", "$$;");
}

function userPrefBody(): string {
  return sliceBody("create or replace function public.user_pref_enabled(", "$$;");
}

describe("SEND — canonical four-argument send_announcement_v2 gains durable body history", () => {
  const b = () => sendBody();

  it("only ONE send_announcement_v2 definition exists in this file — the four-argument canonical form", () => {
    const s = src();
    const defs = [...s.matchAll(/create or replace function public\.send_announcement_v2\(/g)];
    expect(defs.length).toBe(1);
    expect(b()).toContain("p_audience_mode       text,");
    expect(b()).toContain("p_recipient_user_ids  uuid[]");
  });

  it("audit_log metadata now includes body, alongside the pre-existing title/recipient_count/batch_id/audience_mode", () => {
    const body = b();
    const idx = body.indexOf("insert into public.audit_log");
    const block = body.slice(idx, idx + 500);
    expect(block).toContain("'title',           trim(p_title),");
    expect(block).toContain("'body',            trim(p_body),");
    expect(block).toContain("'recipient_count', v_recipient_count,");
    expect(block).toContain("'batch_id',        v_batch_id,");
    expect(block).toContain("'audience_mode',   p_audience_mode");
  });

  it("the audit_log insert is unconditional — runs regardless of recipient_count, including zero (ALL mode's pre-existing zero-recipient behavior is unchanged)", () => {
    const body = b();
    const auditIdx = body.indexOf("insert into public.audit_log");
    const raiseIdx = body.indexOf("raise exception 'no_eligible_recipients';");
    // The only fail-closed path that skips the audit insert is the
    // SPECIFIC zero-survivor guard, which happens BEFORE the insert and is
    // unrelated to recipient_count itself (ALL mode never reaches it).
    expect(raiseIdx).toBeLessThan(auditIdx);
    expect(body).not.toMatch(/if\s+v_recipient_count\s*=\s*0/);
  });

  it("every other 0209 behavior is preserved byte-for-byte: auth/role checks, validation, audience validation, shared helper, deterministic ordering, zero-survivor guard, notification metadata, return shape", () => {
    const body = b();
    expect(body).toContain("if auth.uid() is null then raise exception 'not_authenticated'; end if;");
    expect(body).toContain("if v_role is distinct from 'admin' then");
    expect(body).toContain("if trim(p_title) = '' or trim(p_body) = '' then");
    expect(body).toContain("if p_audience_mode is distinct from 'all' and p_audience_mode is distinct from 'specific' then");
    expect(body).toContain("select coalesce(array_agg(c.user_id order by c.user_id), '{}'::uuid[])");
    expect(body).toContain("if p_audience_mode = 'specific' and array_length(v_recipient_ids, 1) is null then");
    expect(body).toContain("raise exception 'no_eligible_recipients';");
    expect(body).toContain("'announcement_batch_id', v_batch_id");
    expect(body).toContain(
      "return jsonb_build_object(\n    'batch_id',        v_batch_id,\n    'recipient_count', v_recipient_count,\n    'notifications',   v_notifications\n  );"
    );
  });

  it("no GRANT/REVOKE is issued for it — same signature as 0209, grants carry forward via CREATE OR REPLACE", () => {
    const idx = src().indexOf("create or replace function public.send_announcement_v2(");
    const nextSectionIdx = src().indexOf("-- 2. Retire the temporary two-argument compatibility wrapper");
    const between = src().slice(idx, nextSectionIdx);
    expect(between).not.toMatch(/revoke execute|grant\s+execute/);
  });
});

describe("WRAPPER — the temporary two-argument send_announcement_v2 is retired", () => {
  it("contains the exact DROP FUNCTION for the two-argument signature", () => {
    expect(src()).toContain("drop function public.send_announcement_v2(text, text);");
  });

  it("no two-argument business logic is recreated anywhere in this file", () => {
    const s = src();
    expect(s).not.toMatch(/create or replace function public\.send_announcement_v2\(\s*\n\s*p_title text,\s*\n\s*p_body\s+text\s*\n\)/);
    expect(s).not.toContain("return public.send_announcement_v2(p_title, p_body, 'all', null);");
  });

  it("does not use CASCADE on the drop", () => {
    const idx = src().indexOf("drop function public.send_announcement_v2(text, text);");
    const line = src().slice(idx, idx + 60);
    expect(line).not.toMatch(/cascade/i);
  });
});

describe("ACTIVITY RPC — get_communications_activity recreated with audience_mode + body", () => {
  it("old signature explicitly dropped (no CASCADE) before being recreated", () => {
    const s = src();
    const dropIdx = s.indexOf("drop function public.get_communications_activity(integer, integer);");
    const createIdx = s.indexOf("create or replace function public.get_communications_activity(");
    expect(dropIdx).toBeGreaterThan(-1);
    expect(createIdx).toBeGreaterThan(dropIdx);
    const dropLine = s.slice(dropIdx, dropIdx + 80);
    expect(dropLine).not.toMatch(/cascade/i);
  });

  it("returns exactly the 8-field shape: batch_id, title, sent_at, recipient_count, email_sent_count, email_failed_count, audience_mode, body", () => {
    const s = src();
    const returnsStart = s.indexOf("returns table (", s.indexOf("create or replace function public.get_communications_activity("));
    const returnsEnd   = s.indexOf(")", returnsStart);
    const block = s.slice(returnsStart, returnsEnd);
    expect(block).toContain("batch_id           uuid");
    expect(block).toContain("title              text");
    expect(block).toContain("sent_at            timestamptz");
    expect(block).toContain("recipient_count    integer");
    expect(block).toContain("email_sent_count   integer");
    expect(block).toContain("email_failed_count integer");
    expect(block).toContain("audience_mode      text");
    expect(block).toContain("body               text");
  });

  it("audience_mode defaults to 'all' when metadata is absent — the approved historical default, not a client invention", () => {
    expect(activityBody()).toContain("coalesce(al.metadata->>'audience_mode', 'all')     as audience_mode");
  });

  it("body prefers audit_log.metadata.body first", () => {
    const body = activityBody();
    const idx = body.indexOf("coalesce(\n        al.metadata->>'body',");
    expect(idx).toBeGreaterThan(-1);
  });

  it("historical fallback is scoped to the SAME caller club, kind='announcement', and matching announcement_batch_id", () => {
    const body = activityBody();
    const idx = body.indexOf("select n2.body");
    expect(idx).toBeGreaterThan(-1);
    const block = body.slice(idx, idx + 300);
    expect(block).toContain("n2.club_id = v_caller_club");
    expect(block).toContain("n2.kind    = 'announcement'");
    expect(block).toContain("n2.metadata->>'announcement_batch_id' = (al.metadata->>'batch_id')");
  });

  it("the fallback uses a deterministic ORDER BY before LIMIT 1 — never a bare unordered LIMIT 1", () => {
    const body = activityBody();
    const idx = body.indexOf("select n2.body");
    const block = body.slice(idx, idx + 400);
    expect(block).toContain("order by n2.created_at, n2.id");
    expect(block).toContain("limit 1");
  });

  it("body remains nullable — no third fallback fabricates a value when both sources are absent", () => {
    const body = activityBody();
    expect(body).not.toMatch(/coalesce\([^)]*body[^)]*,\s*''/);
    expect(body).not.toMatch(/'Message unavailable'/);
  });

  it("existing delivery-count aggregation, Admin/current-club authorization, and pagination clamping are preserved byte-for-byte", () => {
    const body = activityBody();
    expect(body).toContain("if v_caller_club is null or v_caller_role <> 'admin' then");
    expect(body).toContain("return;");
    expect(body).toContain("with notification_outcomes as (");
    expect(body).toContain("bool_or(nd.channel = 'email' and nd.status = 'sent')   as email_sent");
    expect(body).toContain("v_limit       int := greatest(1, least(coalesce(p_limit, 20), 100));");
    expect(body).toContain("order by al.created_at desc");
  });

  it("SECURITY DEFINER, STABLE, and search_path are preserved", () => {
    const body = activityBody();
    expect(body).toContain("security definer");
    expect(body).toContain("stable");
    expect(body).toContain("set search_path = public, pg_temp");
  });

  it("EXECUTE is explicitly restored after DROP+CREATE — PUBLIC/anon revoked, authenticated granted (DROP+CREATE does not preserve privileges, so this cannot be left implicit)", () => {
    const s = src();
    expect(s).toContain("revoke execute on function public.get_communications_activity(int, int) from public, anon;");
    expect(s).toContain("grant  execute on function public.get_communications_activity(int, int) to authenticated;");
  });
});

describe("USER_PREF_ENABLED — search_path pinned, PUBLIC/anon revoked, authenticated preserved", () => {
  const b = () => userPrefBody();

  it("same signature and preference-lookup semantics — missing row still defaults to enabled", () => {
    const body = b();
    expect(body).toContain("select coalesce(\n    (select enabled\n       from notification_preferences\n      where user_id = p_user_id\n        and kind    = p_kind),\n    true\n  );");
  });

  it("SECURITY DEFINER and STABLE preserved; search_path now pinned", () => {
    const body = b();
    expect(body).toContain("security definer");
    expect(body).toContain("stable");
    expect(body).toContain("set search_path = public, pg_temp");
  });

  it("PUBLIC and anon are explicitly revoked", () => {
    expect(src()).toContain("revoke execute on function public.user_pref_enabled(uuid, text) from public, anon;");
  });

  it("authenticated remains granted — NOT revoked — because real, currently load-bearing application code (sendEmailNotification, the lessons action) calls this RPC through a real per-request authenticated session, not a service-role key", () => {
    const s = src();
    expect(s).toContain("grant  execute on function public.user_pref_enabled(uuid, text) to authenticated;");
    expect(s).not.toMatch(/revoke execute on function public\.user_pref_enabled\(uuid, text\) from[^;]*authenticated/);
  });

  it("the residual cross-user/cross-club preference-visibility risk is documented as intentionally deferred, not solved here", () => {
    const s = src();
    expect(s).toMatch(/RESIDUAL RISK/);
    expect(s).toMatch(/deferred/i);
  });
});

describe("db/types.ts", () => {
  it("get_communications_activity's Returns gains audience_mode and body", () => {
    const s = readSource(TYPES_PATH);
    const idx = s.indexOf("get_communications_activity: {");
    expect(idx).toBeGreaterThan(-1);
    const block = s.slice(idx, idx + 1700);
    expect(block).toContain('audience_mode:      "all" | "specific";');
    expect(block).toContain("body:                string | null;");
  });

  it("send_announcement_v2's typed Args/Returns are unchanged by this checkpoint", () => {
    const s = readSource(TYPES_PATH);
    const idx = s.indexOf("send_announcement_v2: {");
    const block = s.slice(idx, idx + 400);
    expect(block).toContain("p_title:               string;");
    expect(block).toContain("p_audience_mode:       string;");
    expect(block).toContain("p_recipient_user_ids:  string[] | null;");
  });
});

describe("PAGE MAPPING", () => {
  it("page.tsx maps audience_mode/body from the RPC row into the AnnouncementBatch prop", () => {
    const s = readSource(PAGE_PATH);
    const idx = s.indexOf("const batches: AnnouncementBatch[]");
    const block = s.slice(idx, idx + 650);
    expect(block).toContain("audienceMode:     row.audience_mode,");
    expect(block).toContain("body:             row.body,");
  });
});

describe("ACTIVITY UI", () => {
  it("AnnouncementBatch carries audienceMode ('all' | 'specific') and body", () => {
    const s = readSource(ACTIVITY_PATH);
    expect(s).toContain('audienceMode:     "all" | "specific";');
    expect(s).toContain("body:             string | null;");
  });

  it("the audience label maps only 'all'/'specific' to fixed copy — no client-side invention of a third state", () => {
    const s = readSource(ACTIVITY_PATH);
    const idx = s.indexOf("function audienceLabel(");
    const block = s.slice(idx, idx + 200);
    expect(block).toContain('mode === "specific" ? "Specific people" : "All active club users"');
  });

  it("View message / Hide message toggle exists, keyed independently of the recipient-detail state", () => {
    const s = readSource(ACTIVITY_PATH);
    expect(s).toContain("const [expandedMessageKey, setExpandedMessageKey] = useState<string | null>(null);");
    expect(s).toContain("function toggleMessage(key: string) {");
    expect(s).toContain('{isMessageOpen ? "Hide message" : "View message"}');
  });

  it("body is rendered with whitespace-pre-wrap plain text — no dangerouslySetInnerHTML, no markdown import", () => {
    const s = readSource(ACTIVITY_PATH);
    expect(s).toContain("whitespace-pre-wrap");
    expect(s).not.toMatch(/dangerouslySetInnerHTML/);
    expect(s).not.toMatch(/react-markdown|marked|remark/i);
  });

  it("a NULL body renders 'Message unavailable' text instead of a View message button — no button that opens an empty body", () => {
    const s = readSource(ACTIVITY_PATH);
    const idx = s.indexOf("{b.body ? (");
    expect(idx).toBeGreaterThan(-1);
    const block = s.slice(idx, idx + 900);
    expect(block).toContain("Message unavailable");
    // The "Message unavailable" branch is the : (else) side of the SAME
    // ternary that renders the View message button — so exactly one or
    // the other renders per row, never both, never a button with no body.
    const elseIdx = block.indexOf(") : (");
    expect(elseIdx).toBeGreaterThan(-1);
    expect(block.slice(elseIdx)).toContain("Message unavailable");
  });

  it("View message never triggers a new RPC/Server Action call — body is already present in the batches prop", () => {
    const s = readSource(ACTIVITY_PATH);
    const idx = s.indexOf("function toggleMessage(");
    const block = s.slice(idx, idx + 150);
    expect(block).not.toMatch(/await|Action\(/);
  });

  it("View message uses explicit <button> semantics — type=\"button\" and aria-expanded reflecting its own open/closed state", () => {
    const s = readSource(ACTIVITY_PATH);
    const idx = s.indexOf('aria-expanded={isMessageOpen}');
    expect(idx).toBeGreaterThan(-1);
    const block = s.slice(Math.max(0, idx - 100), idx + 250);
    expect(block).toContain('type="button"');
    expect(block).toContain("aria-controls={messagePanelId}");
    expect(block).toContain("onClick={() => toggleMessage(key)}");
  });

  it("Delivery details / Hide details button exists, wired to the EXISTING toggleExpand function and lazy-fetch behavior — unchanged (expanded label shortened to \"Hide details\" for mobile — collapsed label, styling, aria attributes, and wiring are otherwise unchanged)", () => {
    const s = readSource(ACTIVITY_PATH);
    const idx = s.indexOf('aria-expanded={isExpanded}');
    expect(idx).toBeGreaterThan(-1);
    const block = s.slice(Math.max(0, idx - 100), idx + 400);
    expect(block).toContain('type="button"');
    expect(block).toContain("aria-controls={deliveryPanelId}");
    expect(block).toContain("onClick={() => toggleExpand(b.batchId!)}");
    expect(block).toContain('{isExpanded ? "Hide details" : "Delivery details"}');
    // Rendered only when a batchId exists — a legacy no-batch record never
    // gets a Delivery details button that couldn't work.
    expect(s).toContain("{b.batchId && (\n                <button\n                  type=\"button\"\n                  aria-expanded={isExpanded}");
  });

  it("recipient-detail fetch (getAnnouncementBatchDetailAction) and its loading/error/detail rendering are byte-identical to before this polish — only the trigger moved", () => {
    const s = readSource(ACTIVITY_PATH);
    expect(s).toContain('import { getAnnouncementBatchDetailAction, type AnnouncementRecipientDetail } from "./communicationsActions";');
    expect(s).toContain("const result = await getAnnouncementBatchDetailAction(batchId);");
    expect(s).toContain("Loading recipients…");
    expect(s).toContain("recipientStatusLabel(r.emailStatus)");
  });

  it("the summary/card is NO LONGER the recipient-detail click target — it is a plain non-interactive <div>, not a <button>", () => {
    const s = readSource(ACTIVITY_PATH);
    const idx = s.indexOf('<div key={key} className="ct-card overflow-hidden">');
    expect(idx).toBeGreaterThan(-1);
    // The very next JSX element after the card wrapper is a plain <div>
    // (the summary), not a <button> — and it carries no onClick/disabled
    // of its own.
    const summaryIdx = s.indexOf('<div className="px-4 py-3 space-y-2">', idx);
    expect(summaryIdx).toBeGreaterThan(idx);
    const summaryBlock = s.slice(summaryIdx, s.indexOf("Delivery detail not available", summaryIdx));
    expect(summaryBlock).not.toMatch(/onClick=/);
    expect(summaryBlock).not.toMatch(/disabled=\{!b\.batchId\}/);
    expect(s).not.toMatch(/onClick=\{\(\) => b\.batchId && toggleExpand/);
  });

  it("View message and Delivery details are two independent sibling buttons in the same row — neither nested inside the other, neither nested inside the summary — opening one cannot open/close the other", () => {
    const s = readSource(ACTIVITY_PATH);
    const rowIdx = s.indexOf('<div className="px-4 pb-3 flex flex-wrap items-center gap-2">');
    expect(rowIdx).toBeGreaterThan(-1);
    const rowEnd = s.indexOf("\n            </div>", rowIdx);
    const row = s.slice(rowIdx, rowEnd);
    expect(row).toContain("toggleMessage(key)");
    expect(row).toContain("toggleExpand(b.batchId!)");
    // Exactly two <button> opening tags in this row, siblings of each
    // other, neither containing the other.
    expect((row.match(/<button/g) ?? []).length).toBe(2);
  });

  it("uses the existing ct-button-secondary pattern — no new button/design system", () => {
    const s = readSource(ACTIVITY_PATH);
    const messageButtonClassIdx = s.indexOf('className="ct-button-secondary px-3 py-1.5 text-xs"');
    expect(messageButtonClassIdx).toBeGreaterThan(-1);
    const occurrences = (s.match(/className="ct-button-secondary px-3 py-1\.5 text-xs"/g) ?? []).length;
    expect(occurrences).toBe(2); // View message AND Delivery details
  });

  it("no modal, no new dependency, no new global state — still exactly the two useState hooks this component already had, plus expandedMessageKey", () => {
    const s = readSource(ACTIVITY_PATH);
    expect(s).toMatch(/^import \{ useState \} from "react";$/m);
    expect(s).not.toMatch(/Dialog|Modal|Sheet/);
    const useStateCount = (s.match(/useState[<(]/g) ?? []).length;
    expect(useStateCount).toBe(5); // expandedBatchId, detailByBatch, loadingBatchId, errorByBatch, expandedMessageKey
  });

  it("no resend/edit/reply action was added to Activity", () => {
    const s = readSource(ACTIVITY_PATH);
    expect(s).not.toMatch(/resend|onEdit|reply/i);
  });
});

describe("BOUNDARIES — no out-of-scope work introduced", () => {
  it("no table, column, or RLS DDL of any kind", () => {
    const s = src();
    expect(s).not.toMatch(/create table|alter table|create policy|alter policy|drop table|drop policy/i);
  });

  it("no SMS, scheduling, chat, or targeting-expansion CODE — the header's own scope-declaration prose naming those domains as excluded is not executable content", () => {
    const s = src();
    expect(s).not.toMatch(/sendSms|dispatchSmsNotification|twilio/i);
    expect(s).not.toMatch(/cron|scheduled_send/i);
    expect(s).not.toMatch(/thread_id|chat_message|reply_to/i);
    expect(s).not.toMatch(/membership_type|role_based_filter/i);
  });

  it("no payment, reservation, waiver, or Phase 39 function is created/redefined/dropped", () => {
    const s = src();
    const touched = [
      ...[...s.matchAll(/create or replace function public\.(\w+)\(/g)].map(m => m[1]),
      ...[...s.matchAll(/drop function public\.(\w+)\(/g)].map(m => m[1]),
    ];
    expect(touched.sort()).toEqual(
      [
        "send_announcement_v2",  // create or replace (4-arg)
        "send_announcement_v2",  // drop (2-arg)
        "get_communications_activity", // drop
        "get_communications_activity", // create or replace
        "user_pref_enabled",
      ].sort()
    );
  });

  it("is a single self-contained transaction", () => {
    const s = src();
    expect(s.match(/^begin;$/gm) ?? []).toHaveLength(1);
    expect(s.match(/^commit;$/gm) ?? []).toHaveLength(1);
  });
});
