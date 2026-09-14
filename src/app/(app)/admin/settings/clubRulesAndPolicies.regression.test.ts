import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 0184 — Club Rules & Policies. A small, informational-only per-club
// document (court etiquette, dress code, cleanup, ball machine rules,
// general facility expectations, guest/check-in guidance — examples
// only). Deliberately NOT an enforceable policy engine: cancellation
// windows, refund rules, booking restrictions, fees, eligibility, and
// waiver acceptance remain structured product policy handled elsewhere,
// and this feature must never become a path to any of those.
//
// Source-inspection style, matching this repository's established
// convention for migration SQL and Server-Action/page surfaces this
// project's vitest baseline cannot render (see pricingPackagingProvisioning
// .regression.test.ts and settingsInformationArchitecture.regression.test.ts
// for precedent).

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

const MIGRATION_PATH = "supabase/migrations/0184_club_rules_and_policies.sql";
const ACTIONS_PATH = "src/app/(app)/admin/settings/actions.ts";
const SECTION_PATH = "src/app/(app)/admin/settings/ClubRulesSection.tsx";
const SETTINGS_PAGE_PATH = "src/app/(app)/admin/settings/page.tsx";
const HELP_PAGE_PATH = "src/app/(app)/help/page.tsx";
const TYPES_PATH = "src/lib/db/types.ts";

function migrationSql(): string {
  return codeOnly(readSource(MIGRATION_PATH));
}

function rpcBody(): string {
  const sql = migrationSql();
  const start = sql.indexOf("create or replace function public.update_club_rules_and_policies(");
  expect(start, "update_club_rules_and_policies not found").toBeGreaterThan(-1);
  const end = sql.indexOf("\n$$;", start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end + "\n$$;".length);
}

// ═══════════════════════════════════════════════════════════════════════════
// Migration — column, additive, no existing object touched
// ═══════════════════════════════════════════════════════════════════════════

describe("0184 migration — additive column, no existing RLS/constraint/RPC touched", () => {
  it("adds club_settings.rules_and_policies as a nullable text column via add column if not exists", () => {
    const sql = migrationSql();
    expect(sql).toContain("alter table public.club_settings\n  add column if not exists rules_and_policies text;");
  });

  it("never touches an existing RLS policy, constraint, or any other function — no ALTER POLICY, no DROP CONSTRAINT, no other CREATE OR REPLACE FUNCTION", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/alter policy|drop constraint|drop policy/i);
    const fnDefs = sql.match(/create or replace function/gi) ?? [];
    expect(fnDefs.length).toBe(1);
  });

  it("documents (never enforces) that this column is informational only — cancellation/refund/booking/fee/eligibility/waiver policy is explicitly out of scope in the migration's own header comment", () => {
    const flattened = readSource(MIGRATION_PATH)
      .split("\n")
      .map((line) => line.replace(/^--\s?/, ""))
      .join(" ")
      .replace(/\s+/g, " ");
    expect(flattened).toContain("cancellation windows, refund rules, booking restrictions, fees, eligibility, and waiver acceptance remain structured product policy");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// RPC — auth, trimming, length cap, stable error codes
// ═══════════════════════════════════════════════════════════════════════════

describe("update_club_rules_and_policies — server-side derivation, Admin only", () => {
  it("derives club id and role via the CURRENT auth helpers (current_user_club_id/current_user_role) — never a raw profiles.role read, never a client-supplied club id", () => {
    const fn = rpcBody();
    expect(fn).toContain("v_club_id := public.current_user_club_id();");
    expect(fn).toContain("v_role    := public.current_user_role();");
    expect(fn).not.toMatch(/profiles%rowtype|from public\.profiles/);
  });

  it("requires an active club (not_authenticated) and role = 'admin' (insufficient_role), using the null-safe `is distinct from` form", () => {
    const fn = rpcBody();
    expect(fn).toContain("if v_club_id is null then raise exception 'not_authenticated'; end if;");
    expect(fn).toContain("if v_role is distinct from 'admin' then raise exception 'insufficient_role'; end if;");
    expect(fn).not.toMatch(/v_role\s*<>\s*'admin'/);
  });

  it("Staff/Pro/Member are all rejected by the SAME single admin-only check — no allowlist that could admit them", () => {
    const fn = rpcBody();
    // Exactly one role-gate exists, and it names only 'admin'.
    const roleChecks = fn.match(/raise exception 'insufficient_role'/g) ?? [];
    expect(roleChecks.length).toBe(1);
    expect(fn).not.toMatch(/'staff'|'pro'|'member'/);
  });
});

describe("update_club_rules_and_policies — normalization: trim, empty -> NULL, 10,000-char cap", () => {
  it("trims and normalizes empty/whitespace-only input to NULL via the same nullif(btrim(coalesce(...))) idiom used elsewhere in this codebase", () => {
    const fn = rpcBody();
    expect(fn).toContain("v_new := nullif(btrim(coalesce(p_rules_and_policies, '')), '');");
  });

  it("rejects anything over 10,000 characters AFTER trimming/normalizing, with a stable, specific error code", () => {
    const fn = rpcBody();
    const checkIdx = fn.indexOf("if v_new is not null and length(v_new) > 10000 then");
    expect(checkIdx).toBeGreaterThan(-1);
    const normalizeIdx = fn.indexOf("v_new := nullif(btrim(coalesce(p_rules_and_policies, '')), '');");
    expect(checkIdx).toBeGreaterThan(normalizeIdx);
    expect(fn.slice(checkIdx, checkIdx + 120)).toContain("raise exception 'rules_and_policies_too_long';");
  });

  it("the length check reads exactly 10000, not some other boundary (off-by-one safe: > 10000 rejects 10001+, permits exactly 10000)", () => {
    const fn = rpcBody();
    expect(fn).toContain("length(v_new) > 10000");
  });
});

describe("update_club_rules_and_policies — correction pass: locked read, NOT FOUND check, and equality gate all precede any write", () => {
  it("1. the existing row is read with SELECT ... FOR UPDATE — a real row lock, not a plain SELECT", () => {
    const fn = rpcBody();
    expect(fn).toContain(
      "select rules_and_policies into v_old\n" +
      "    from public.club_settings\n" +
      "   where club_id = v_club_id\n" +
      "     for update;",
    );
  });

  it("2. a missing club_settings row is detected via NOT FOUND immediately after the locked SELECT, and raises club_settings_not_found — BEFORE the equality check, so a missing row can never be mistaken for an existing row with NULL content", () => {
    const fn = rpcBody();
    const selectIdx = fn.indexOf("select rules_and_policies into v_old");
    const forUpdateIdx = fn.indexOf("for update;", selectIdx);
    const notFoundIdx = fn.indexOf("if not found then raise exception 'club_settings_not_found'; end if;", forUpdateIdx);
    const equalityIdx = fn.indexOf("if v_old is not distinct from v_new then", notFoundIdx);
    expect(forUpdateIdx).toBeGreaterThan(selectIdx);
    expect(notFoundIdx).toBeGreaterThan(forUpdateIdx);
    expect(equalityIdx).toBeGreaterThan(notFoundIdx);
    // The now-redundant GET DIAGNOSTICS row_count check was removed rather
    // than kept as dead code — FOUND/NOT FOUND on the locked SELECT is the
    // single, earlier existence check.
    expect(fn).not.toMatch(/get diagnostics|row_count|v_rows_updated/);
  });

  it("3/4. old-vs-new equality is checked (null-safe, `is not distinct from`) and a no-op RETURNs immediately — strictly before the UPDATE and before the audit_log insert, so an unchanged Save touches neither", () => {
    const fn = rpcBody();
    const equalityIdx = fn.indexOf("if v_old is not distinct from v_new then");
    const returnIdx = fn.indexOf("return;", equalityIdx);
    const updateIdx = fn.indexOf("update public.club_settings", equalityIdx);
    const auditIdx = fn.indexOf("insert into public.audit_log", equalityIdx);
    expect(equalityIdx).toBeGreaterThan(-1);
    expect(returnIdx).toBeGreaterThan(equalityIdx);
    expect(returnIdx).toBeLessThan(updateIdx);
    expect(updateIdx).toBeLessThan(auditIdx);
  });

  it("updated_at is set only inside the UPDATE that a genuine change reaches — there is no separate/earlier updated_at write a no-op could hit", () => {
    const fn = rpcBody();
    const occurrences = (fn.match(/updated_at\s*=\s*now\(\)/g) ?? []).length;
    expect(occurrences).toBe(1);
    const updateIdx = fn.indexOf("update public.club_settings");
    const updatedAtIdx = fn.indexOf("updated_at         = now()");
    expect(updatedAtIdx).toBeGreaterThan(updateIdx);
  });

  it("5. a genuine change still reaches exactly one UPDATE and exactly one audit_log insert, in that order, after the equality gate", () => {
    const fn = rpcBody();
    const equalityIdx = fn.indexOf("if v_old is not distinct from v_new then");
    const updateIdx = fn.indexOf("update public.club_settings", equalityIdx);
    const auditIdx = fn.indexOf("insert into public.audit_log", equalityIdx);
    expect(updateIdx).toBeGreaterThan(equalityIdx);
    expect(auditIdx).toBeGreaterThan(updateIdx);
    expect((fn.match(/update public\.club_settings/g) ?? []).length).toBe(1);
    expect((fn.match(/insert into public\.audit_log/g) ?? []).length).toBe(1);
  });

  it("audit metadata contains ONLY had_content_before/has_content_after/previous_character_count/new_character_count — never the actual policy text (neither v_old nor v_new appears as a bare metadata value)", () => {
    const fn = rpcBody();
    const auditIdx = fn.indexOf("insert into public.audit_log");
    expect(auditIdx).toBeGreaterThan(-1);
    const metadataStart = fn.indexOf("jsonb_build_object(", auditIdx);
    const metadataEnd = fn.indexOf(")\n  );", metadataStart);
    const metadataBlock = fn.slice(metadataStart, metadataEnd);
    expect(metadataBlock).toContain("'had_content_before',       v_old is not null,");
    expect(metadataBlock).toContain("'has_content_after',        v_new is not null,");
    expect(metadataBlock).toContain("'previous_character_count', coalesce(length(v_old), 0),");
    expect(metadataBlock).toContain("'new_character_count',      coalesce(length(v_new), 0)");
    // The raw text values are never passed as a jsonb_build_object VALUE —
    // only wrapped in `is not null` or `length(...)`, never bare `v_old`/
    // `v_new` on their own.
    expect(metadataBlock).not.toMatch(/,\s*v_old,/);
    expect(metadataBlock).not.toMatch(/,\s*v_new,/);
  });

  it("action/target_type/target_id follow the established audit_log convention for this domain", () => {
    const fn = rpcBody();
    expect(fn).toContain("v_club_id, auth.uid(), 'update_club_rules_and_policies', 'club_settings', v_club_id,");
  });

  it("concurrent Admin saves serialize cleanly — FOR UPDATE means a second concurrent call blocks on the row lock until the first transaction commits/rolls back, so before/after audit metadata is never computed from a stale, concurrently-overwritten v_old", () => {
    const fn = rpcBody();
    const forUpdateCount = (fn.match(/for update;/g) ?? []).length;
    expect(forUpdateCount).toBe(1);
  });
});

describe("update_club_rules_and_policies — no financial/enforcement side effect exists", () => {
  it("never references payments, payment_events, cancellation windows, refunds, or any RPC beyond the club_settings update + audit_log insert", () => {
    const fn = rpcBody();
    expect(fn).not.toMatch(/payments|payment_events|cancellation_window|refund|waiver|eligib/i);
  });

  it("never calls a notification-related table or RPC — this feature adds no notification path", () => {
    const fn = rpcBody();
    expect(fn).not.toMatch(/notifications|notify/i);
    const fullSql = migrationSql();
    expect(fullSql).not.toMatch(/insert into public\.notifications/);
  });
});

describe("update_club_rules_and_policies — grants preserve current same-club SELECT behavior; write stays Admin-only", () => {
  it("EXECUTE is revoked from public/anon and granted only to authenticated (the RPC's own internal admin check is the real gate, matching update_club_timezone/update_club_pricing's exact posture)", () => {
    const sql = migrationSql();
    expect(sql).toContain("revoke execute on function public.update_club_rules_and_policies(text) from public, anon;");
    expect(sql).toContain("grant  execute on function public.update_club_rules_and_policies(text) to authenticated;");
  });

  it("does not touch club_settings_select_same_club or club_settings_update_admin — the existing same-club SELECT and Admin-only UPDATE RLS backstops are left completely alone (referenced only in this migration's own explanatory comment, never redefined)", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/create policy|alter policy/i);
    const raw = readSource(MIGRATION_PATH);
    expect(raw).toContain("club_settings_select_same_club");
    expect(raw).toContain("club_settings_update_admin");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Server Action layer
// ═══════════════════════════════════════════════════════════════════════════

describe("updateClubRulesAndPolicies (Server Action) — thin RPC wrapper, correct error mapping", () => {
  it("calls update_club_rules_and_policies with p_rules_and_policies, and maps rules_and_policies_too_long/not_authenticated/insufficient_role", () => {
    const src = readSource(ACTIONS_PATH);
    const fnStart = src.indexOf("export async function updateClubRulesAndPolicies(");
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = src.indexOf("\n}", fnStart) + 2;
    const fn = src.slice(fnStart, fnEnd);
    expect(fn).toContain('supabase.rpc("update_club_rules_and_policies", {');
    expect(fn).toContain("p_rules_and_policies: rulesAndPolicies,");
    expect(fn).toContain("/rules_and_policies_too_long|not_authenticated|insufficient_role/");
  });

  it("ERROR_MESSAGES carries a specific, user-facing rules_and_policies_too_long message — no generic fallback text for this code", () => {
    const src = readSource(ACTIONS_PATH);
    expect(src).toContain('rules_and_policies_too_long: "Club Rules & Policies must be 10,000 characters or fewer.",');
  });

  it("revalidates the whole layout (covers both /admin/settings and /help under the same root layout) — same convention every other club_settings/clubs mutation in this file already uses", () => {
    const src = readSource(ACTIONS_PATH);
    const fnStart = src.indexOf("export async function updateClubRulesAndPolicies(");
    const fnEnd = src.indexOf("\n}", fnStart) + 2;
    const fn = src.slice(fnStart, fnEnd);
    expect(fn).toContain('revalidatePath("/", "layout");');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Admin UI — /admin/settings
// ═══════════════════════════════════════════════════════════════════════════

describe("ClubRulesSection — existing settings-section conventions, no new pattern", () => {
  it("is a textarea bound to updateClubRulesAndPolicies via useTransition, mirroring ClubTimezoneSection's exact shape", () => {
    const src = readSource(SECTION_PATH);
    expect(src).toContain('import { updateClubRulesAndPolicies } from "./actions";');
    expect(src).toContain("const [isPending, startTransition] = useTransition();");
    expect(src).toContain("<textarea");
    expect(src).toContain("updateClubRulesAndPolicies(value)");
  });

  it("enforces maxLength=10000 client-side (UX only — the RPC is still the real backstop) and shows a character count", () => {
    const src = readSource(SECTION_PATH);
    expect(src).toContain("const MAX_LENGTH = 10000;");
    expect(src).toContain("maxLength={MAX_LENGTH}");
    expect(src).toContain("{value.length}/{MAX_LENGTH}");
  });

  it("shows a pending state on Save and success/error feedback, matching ClubTimezoneSection's exact copy/behavior", () => {
    const src = readSource(SECTION_PATH);
    expect(src).toContain('{isPending ? "Saving…" : "Save"}');
    expect(src).toContain('setStatus({ type: "success", message: "Saved" });');
    expect(src).toContain('status.type === "success" ? "text-green-600" : "text-red-500"');
  });

  it("its own copy explicitly disclaims enforcement — informational only, cancellation/refunds/booking limits/fees configured elsewhere", () => {
    const src = readSource(SECTION_PATH).replace(/\s+/g, " ");
    expect(src).toContain("not enforced by the app");
  });

  it("uses no new UI dependency (no markdown/rich-text library import)", () => {
    const src = readSource(SECTION_PATH);
    expect(src).not.toMatch(/markdown|tiptap|quill|slate|prosemirror/i);
  });
});

describe("/admin/settings page.tsx — ClubRulesSection wired under Club Profile, Admin-only route unchanged", () => {
  it("redirects non-Admins before rendering anything (unchanged, pre-existing gate — this feature adds no new gate, relies on the existing one)", () => {
    const s = readSource(SETTINGS_PAGE_PATH);
    expect(s).toContain('if (profile?.role !== "admin") redirect("/calendar");');
  });

  it("selects rules_and_policies alongside the existing club_settings columns — one additional column, no new query", () => {
    const s = readSource(SETTINGS_PAGE_PATH);
    expect(s).toContain('.select("currency, default_court_hourly_rate_cents, payment_mode, rules_and_policies")');
  });

  it("renders ClubRulesSection under the Club Profile group, after Timezone, passing settings?.rules_and_policies", () => {
    const s = readSource(SETTINGS_PAGE_PATH);
    const groupStart = s.indexOf('<h2 className="text-base font-bold text-gray-900 dark:text-gray-100">Club Profile</h2>');
    const groupEnd = s.indexOf('<h2 className="text-base font-bold text-gray-900 dark:text-gray-100">Pricing & Payments</h2>');
    const group = s.slice(groupStart, groupEnd);
    expect(group).toContain("<ClubTimezoneSection");
    expect(group).toContain("<ClubRulesSection currentRulesAndPolicies={settings?.rules_and_policies ?? null} />");
    const timezoneIdx = group.indexOf("<ClubTimezoneSection");
    const rulesIdx = group.indexOf("<ClubRulesSection");
    expect(rulesIdx).toBeGreaterThan(timezoneIdx);
  });

  it("page.tsx itself still performs no .rpc(/.update(/.insert(/.delete( — read plus prop-passing only, unchanged by this addition", () => {
    const s = readSource(SETTINGS_PAGE_PATH);
    expect(s).not.toMatch(/\.rpc\(/);
    expect(s).not.toMatch(/\.update\(|\.insert\(|\.delete\(/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Member/Staff/Pro read experience — /help
// ═══════════════════════════════════════════════════════════════════════════

describe("/help page.tsx — conditional rendering, whitespace-pre-wrap, no markdown", () => {
  it("extends the existing club_settings query (same .select/.eq/.single call) rather than adding a second query", () => {
    const s = readSource(HELP_PAGE_PATH);
    const occurrences = (s.match(/from\("club_settings"\)/g) ?? []).length;
    expect(occurrences).toBe(1);
    expect(s).toContain('.select("booking_window_days, cancellation_window_hours, rules_and_policies")');
  });

  it("renders the section ONLY when rules_and_policies is truthy — never an empty card for null/empty content", () => {
    const s = readSource(HELP_PAGE_PATH);
    expect(s).toContain("{rulesAndPolicies && (");
  });

  it("uses whitespace-pre-wrap on the raw text — no markdown parsing, no dangerouslySetInnerHTML, no new rendering dependency", () => {
    const s = readSource(HELP_PAGE_PATH);
    const idx = s.indexOf("{rulesAndPolicies && (");
    const block = s.slice(idx, idx + 500);
    expect(block).toContain("whitespace-pre-wrap");
    expect(block).toContain("{rulesAndPolicies}");
    expect(s).not.toMatch(/dangerouslySetInnerHTML|markdown|tiptap|quill/i);
  });

  it("reuses the existing app typography (same text-xs uppercase label + ct-card treatment the other /help sections already use)", () => {
    const s = readSource(HELP_PAGE_PATH);
    const idx = s.indexOf("{rulesAndPolicies && (");
    const block = s.slice(idx, idx + 500);
    expect(block).toContain("text-xs font-semibold text-gray-500 uppercase tracking-wide");
    expect(block).toContain("ct-card");
  });

  it("the page performs no mutation — read-only, same as before this addition", () => {
    const s = readSource(HELP_PAGE_PATH);
    expect(s).not.toMatch(/\.rpc\(|\.update\(|\.insert\(|\.delete\(/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

describe("hand-maintained DB types — club_settings.rules_and_policies", () => {
  it("Row/Insert/Update all carry rules_and_policies: string | null (optional on Insert/Update)", () => {
    const s = readSource(TYPES_PATH);
    const clubSettingsStart = s.indexOf("club_settings: {");
    expect(clubSettingsStart).toBeGreaterThan(-1);
    const clubSettingsBlock = s.slice(clubSettingsStart, clubSettingsStart + 2000);
    expect(clubSettingsBlock).toContain("rules_and_policies: string | null;");
    expect(clubSettingsBlock).toContain("rules_and_policies?: string | null;");
  });

  it("the update_club_rules_and_policies RPC is declared in the Functions map with the correct Args/Returns shape", () => {
    const s = readSource(TYPES_PATH);
    const idx = s.indexOf("update_club_rules_and_policies: {");
    expect(idx).toBeGreaterThan(-1);
    const block = s.slice(idx, idx + 200);
    expect(block).toContain("Args: { p_rules_and_policies: string | null };");
    expect(block).toContain("Returns: undefined;");
  });
});
