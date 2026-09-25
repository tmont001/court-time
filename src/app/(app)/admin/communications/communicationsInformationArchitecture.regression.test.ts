import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// Admin IA Checkpoint 4 — Communications. One coherent Admin communications
// workspace at /admin/communications (Compose / Activity / Diagnostics),
// replacing the two Settings sections it absorbs (Member Announcements,
// Delivery diagnostics — see settingsInformationArchitecture.regression.
// test.ts describe blocks 11 and 23-25 for that side of the move) and the
// detailed delivery-failure list previously duplicated on /admin/overview
// (see describe 20 below).
//
// Source-inspection style, matching this directory's established
// convention (see courtsInformationArchitecture.regression.test.ts).

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const PAGE_PATH               = "src/app/(app)/admin/communications/page.tsx";
const ANNOUNCEMENTS_PATH      = "src/app/(app)/admin/communications/AnnouncementsSection.tsx";
const ACTIVITY_SECTION_PATH   = "src/app/(app)/admin/communications/CommunicationsActivitySection.tsx";
const DIAGNOSTICS_PATH        = "src/app/(app)/admin/communications/DeliveryDiagnosticsSection.tsx";
const TEST_SMS_PATH           = "src/app/(app)/admin/communications/TestSmsSection.tsx";
const ACTIONS_PATH            = "src/app/(app)/admin/communications/communicationsActions.ts";
const MIGRATION_PATH          = "supabase/migrations/0170_communications_activity_rpc.sql";
const SIDE_NAV_PATH           = "src/components/SideNav.tsx";
const BOTTOM_NAV_PATH         = "src/components/BottomNav.tsx";
const OVERVIEW_PAGE_PATH      = "src/app/(app)/admin/overview/page.tsx";
const ROLES_PATH              = "src/lib/auth/roles.ts";

describe("1-2. /admin/communications exists and is Admin-only", () => {
  it("page.tsx exists and exports a default async page component", () => {
    const s = readSource(PAGE_PATH);
    expect(s).toContain("export default async function AdminCommunicationsPage(");
  });

  it("uses the same hasAdminAuthority + redirect('/calendar') control-plane gate as /admin/courts and /admin/settings", () => {
    const s = readSource(PAGE_PATH);
    expect(s).toContain('import { hasAdminAuthority } from "@/lib/auth/roles";');
    expect(s).toContain("if (!hasAdminAuthority(profile?.role)) redirect(\"/calendar\");");
    expect(s).toContain('if (!user) redirect("/sign-in");');
  });
});

describe("3-5. Staff/Pro/Member are denied — hasAdminAuthority is Admin-only, not a UI-only check", () => {
  it("hasAdminAuthority resolves to isAdmin(role) only — Staff/Pro/Member all fail it", () => {
    const s = readSource(ROLES_PATH);
    expect(s).toMatch(/export function hasAdminAuthority\(role: string \| null \| undefined\): boolean \{\s*return isAdmin\(role\);\s*\}/);
  });

  it("hasAdminAuthority's own doc comment names broadcast Communications as control-plane authority (pre-existing product intent, not introduced by this checkpoint)", () => {
    const s = readSource(ROLES_PATH);
    expect(s).toMatch(/broadcast Communications/);
  });

  it("the redirect target for a denied caller is the existing '/calendar' control-plane convention, not a new destination", () => {
    const s = readSource(PAGE_PATH);
    expect(s).toContain('redirect("/calendar")');
  });
});

describe("6-7. three URL-backed tabs; unknown tab falls back to Compose", () => {
  it("resolveCommunicationsTab recognizes exactly activity/diagnostics and defaults everything else to compose", () => {
    const s = readSource(PAGE_PATH);
    expect(s).toContain('type CommunicationsTab = "compose" | "activity" | "diagnostics";');
    expect(s).toMatch(/if \(raw === "activity"\) return "activity";/);
    expect(s).toMatch(/if \(raw === "diagnostics"\) return "diagnostics";/);
    expect(s).toContain('return "compose";');
  });

  it("all three tabs are plain Link + searchParams hrefs (direct link/refresh/back-forward all work naturally)", () => {
    const s = readSource(PAGE_PATH);
    expect(s).toContain('{ key: "compose",     label: "Compose",     href: "/admin/communications" }');
    expect(s).toContain('{ key: "activity",    label: "Activity",    href: "/admin/communications?tab=activity" }');
    expect(s).toContain('{ key: "diagnostics", label: "Diagnostics", href: "/admin/communications?tab=diagnostics" }');
  });
});

describe("8. Compose relocation", () => {
  it("AnnouncementsSection lives at the new location and imports its action from the new colocated file", () => {
    const s = readSource(ANNOUNCEMENTS_PATH);
    expect(s).toContain('import { sendAnnouncementAction } from "./communicationsActions";');
  });

  it("page.tsx renders AnnouncementsSection under the compose tab", () => {
    const s = readSource(PAGE_PATH);
    expect(s).toContain('import AnnouncementsSection from "./AnnouncementsSection";');
    expect(s).toMatch(/tab === "compose" &&[\s\S]{0,600}<AnnouncementsSection \/>/);
  });
});

describe("9/A. correct Audience wording — matches preference-filtered recipient semantics, not 'all active profiles'", () => {
  it("Compose states the true audience: active club users with announcements enabled, not merely 'all active'", () => {
    const s = readSource(ANNOUNCEMENTS_PATH);
    expect(s).toContain('value="Active club users with announcements enabled"');
    expect(s).not.toMatch(/value="All active club users"/);
    expect(s).not.toMatch(/Send to all active club users\?/);
    expect(s).not.toMatch(/Send to all active members\?/);
  });

  it("the confirmation copy states the preference-filtered semantics truthfully: enabled recipients only, excluding the sender", () => {
    const s = readSource(ANNOUNCEMENTS_PATH);
    expect(s).toMatch(/who have announcement notifications enabled, excluding you/);
    expect(s).toMatch(/Members, Staff, Pros, and other Admins/);
  });

  it("send_announcement_v2's actual preference filter is unchanged — still notification_preferences.kind='announcement', enabled defaults true", () => {
    const s = readSource("supabase/migrations/0102_communications_delivery_identity.sql");
    expect(s).toContain("and kind    = 'announcement'");
    expect(s).toMatch(/coalesce\(\s*\(select enabled/);
  });
});

describe("10. Timing = Send now is explicitly represented", () => {
  it("Compose has an explicit Timing row reading 'Send now'", () => {
    const s = readSource(ANNOUNCEMENTS_PATH);
    expect(s).toContain('<InfoRow label="Timing" value="Send now" />');
  });

  it("no fake disabled dropdown or selector was added for Audience/Timing/Delivery — plain read-only rows only", () => {
    const s = readSource(ANNOUNCEMENTS_PATH);
    expect(s).not.toMatch(/<select/i);
    expect(s).not.toMatch(/disabled[^>]*>\s*<option/i);
  });
});

describe("11. Delivery information is truthful", () => {
  it("Compose's Delivery row states in-app + conditional email, never a guaranteed-for-everyone claim, never SMS", () => {
    const s = readSource(ANNOUNCEMENTS_PATH);
    expect(s).toContain('<InfoRow label="Delivery" value="In-app + email when available" />');
    expect(s).not.toMatch(/<InfoRow label="Delivery"[^/]*SMS/);
  });
});

describe("B. success message no longer says 'member(s)' — Staff/Pro/Admin can also receive an announcement", () => {
  it("sendAnnouncementAction's success message says 'recipient(s)', never 'member(s)'", () => {
    const s = readSource(ACTIONS_PATH);
    expect(s).toMatch(/Announcement sent to \$\{recipientCount\} recipient\$\{recipientCount === 1 \? "" : "s"\}\./);
    expect(s).not.toMatch(/Announcement sent to \$\{recipientCount\} member/);
  });

  it("recipientCount itself is still sourced verbatim from send_announcement_v2's own return value — not recomputed or re-derived", () => {
    const s = readSource(ACTIONS_PATH);
    expect(s).toContain("const recipientCount = result?.recipient_count ?? 0;");
  });
});

describe("C. Activity exposes Recipients / Email sent / Email failed only", () => {
  it("the rendered card shows exactly these three labels and no others", () => {
    const s = readSource(ACTIVITY_SECTION_PATH);
    expect(s).toContain("Recipients: {b.recipientCount}");
    expect(s).toContain("Email sent: {b.emailSentCount}");
    expect(s).toContain("Email failed: {b.emailFailedCount}");
    expect(s).not.toMatch(/In-app:/);
  });
});

describe("12. send_announcement_v2 is unchanged", () => {
  it("communicationsActions.ts calls send_announcement_v2 with the same title/body values — Phase 44B (migration 0209) additionally passes audience_mode: \"all\", recipient_user_ids: null on this same existing send path, calling the new canonical four-argument RPC explicitly rather than the temporary two-argument compatibility wrapper", () => {
    const s = readSource(ACTIONS_PATH);
    expect(s).toContain('supabase.rpc("send_announcement_v2", {');
    expect(s).toContain("p_title:              title,");
    expect(s).toContain("p_body:                body,");
    expect(s).toContain('p_audience_mode:       "all"');
    expect(s).toContain("p_recipient_user_ids:  null");
  });

  it("the migration does not modify send_announcement_v2, notifications, or notification_deliveries", () => {
    const s = readSource(MIGRATION_PATH);
    expect(s).not.toMatch(/create or replace function public\.send_announcement_v2/);
    expect(s).not.toMatch(/alter table (public\.)?notifications\b/);
    expect(s).not.toMatch(/alter table (public\.)?notification_deliveries\b/);
  });
});

describe("13. no SMS announcement path was added", () => {
  it("neither AnnouncementsSection nor communicationsActions.ts references SMS/dispatchSmsNotification for announcements", () => {
    for (const path of [ANNOUNCEMENTS_PATH, ACTIONS_PATH]) {
      const s = readSource(path);
      expect(s).not.toMatch(/dispatchSmsNotification/);
    }
    // sendSms IS imported in communicationsActions.ts, but only for the
    // Diagnostics Test SMS tool — never invoked from sendAnnouncementAction.
    const s = readSource(ACTIONS_PATH);
    const announceStart = s.indexOf("export async function sendAnnouncementAction(");
    const announceEnd   = s.indexOf("\n}\n", announceStart);
    const announceBody  = s.slice(announceStart, announceEnd);
    expect(announceBody).not.toMatch(/sendSms\(/);
  });
});

describe("14. Activity groups by announcement batch, not one row per notification_deliveries record", () => {
  it("get_communications_activity groups by audit_log.id (one row per send), joining notifications/notification_deliveries for aggregate counts", () => {
    const s = readSource(MIGRATION_PATH);
    expect(s).toContain("group by al.id");
    expect(s).toContain("and al.action  = 'send_announcement'");
  });

  it("CommunicationsActivitySection renders one card per batch, keyed by batchId", () => {
    const s = readSource(ACTIVITY_SECTION_PATH);
    expect(s).toContain("const key = b.batchId ?? `legacy-${b.sentAt}`;");
    expect(s).toContain("batches.map(b =>");
  });
});

// Correction — notification_deliveries has no unique constraint on
// (notification_id, channel); it represents delivery ATTEMPTS, so a
// notification can accumulate multiple 'failed' rows before an eventual
// 'sent' row (email_already_delivered only blocks a further SEND once
// 'sent' exists, never blocks recording a prior failure). email_sent_count/
// email_failed_count must therefore be RECIPIENT-level outcomes derived by
// reducing each notification's attempts to one boolean first, never a raw
// per-status SUM over notification_deliveries rows.
describe("1-6/8. retry-safe recipient-level counting, not raw attempt-row SUMs", () => {
  it("1. the RPC does not SUM raw notification_deliveries status matches directly — it aggregates over a per-notification outcome CTE instead", () => {
    const s = readSource(MIGRATION_PATH);
    expect(s).not.toMatch(/sum\(case when nd\.channel = 'email' and nd\.status = 'sent'/);
    expect(s).not.toMatch(/sum\(case when nd\.channel = 'email' and nd\.status = 'failed'/);
    expect(s).toContain("with notification_outcomes as (");
  });

  it("2/5. failed attempts are reduced with bool_or per notification before counting — multiple failed rows for one notification can only ever contribute once", () => {
    const s = readSource(MIGRATION_PATH);
    expect(s).toContain("bool_or(nd.channel = 'email' and nd.status = 'failed') as email_failed_attempt");
    expect(s).toContain("group by n.id");
  });

  it("3/4. sent is derived the same bool_or way and takes priority over failed — a notification with a failed-then-sent history counts only as sent", () => {
    const s = readSource(MIGRATION_PATH);
    expect(s).toContain("bool_or(nd.channel = 'email' and nd.status = 'sent')   as email_sent");
    expect(s).toContain("coalesce(sum(case when o.email_sent then 1 else 0 end), 0)::integer");
    expect(s).toContain("coalesce(sum(case when o.email_failed_attempt and not o.email_sent then 1 else 0 end), 0)::integer");
  });

  it("6. a notification with no email delivery row at all contributes to neither sent nor failed — the outcome CTE is a LEFT JOIN, and both booleans are checked via case/coalesce, never defaulted to a positive count", () => {
    const s = readSource(MIGRATION_PATH);
    expect(s).toContain("left join public.notification_deliveries nd");
    // The only two case expressions that produce a 1 both require an
    // explicit true boolean (o.email_sent / o.email_failed_attempt) — a
    // NULL outcome (no delivery row at all) falls through to the else 0
    // branch in both, never inferred as a failure.
    expect(s).toMatch(/case when o\.email_sent then 1 else 0 end/);
    expect(s).toMatch(/case when o\.email_failed_attempt and not o\.email_sent then 1 else 0 end/);
  });

  it("8. authorization/hardening is unchanged by this correction — same admin/club-scoped fail-closed check, same SECURITY DEFINER/STABLE/search_path, same revoke/grant", () => {
    const s = readSource(MIGRATION_PATH);
    expect(s).toContain("if v_caller_club is null or v_caller_role <> 'admin' then");
    expect(s).toContain("security definer");
    expect(s).toContain("stable");
    expect(s).toContain("set search_path = public, pg_temp");
    expect(s).toContain("revoke execute on function public.get_communications_activity(int, int) from public, anon;");
    expect(s).toContain("grant  execute on function public.get_communications_activity(int, int) to authenticated;");
  });
});

describe("7. final return contract is unchanged by this correction", () => {
  it("get_communications_activity still returns exactly batch_id, title, sent_at, recipient_count, email_sent_count, email_failed_count", () => {
    const s = readSource(MIGRATION_PATH);
    const returnsStart = s.indexOf("returns table (");
    const returnsEnd   = s.indexOf(")", returnsStart);
    const returnsBlock = s.slice(returnsStart, returnsEnd);
    expect(returnsBlock).toContain("batch_id           uuid");
    expect(returnsBlock).toContain("title              text");
    expect(returnsBlock).toContain("sent_at            timestamptz");
    expect(returnsBlock).toContain("recipient_count    integer");
    expect(returnsBlock).toContain("email_sent_count   integer");
    expect(returnsBlock).toContain("email_failed_count integer");
    expect(returnsBlock).not.toContain("email_opted_out_count");
  });

  it("the function signature (name + args) is unchanged — still edited in place, no 0171", () => {
    const s = readSource(MIGRATION_PATH);
    expect(s).toContain("create or replace function public.get_communications_activity(\n  p_limit  int default 20,\n  p_offset int default 0\n)");
    expect(existsSync(join(process.cwd(), "supabase/migrations/0171_communications_activity_rpc_fix.sql"))).toBe(false);
  });
});

describe("15. truthful Email sent/failed terminology — never 'Delivered'", () => {
  it("CommunicationsActivitySection never uses the word 'Delivered' for email", () => {
    const s = readSource(ACTIVITY_SECTION_PATH);
    expect(s).not.toMatch(/\bDelivered\b/);
    expect(s).toContain("Email sent:");
    expect(s).toMatch(/Email failed/);
  });

  it("the RPC's own returned columns are named email_sent/failed_count, never a generic 'delivered' column", () => {
    const s = readSource(MIGRATION_PATH);
    expect(s).toContain("email_sent_count");
    expect(s).toContain("email_failed_count");
    expect(s).not.toMatch(/delivered_count/);
  });

  it("Activity never implies announcements send SMS", () => {
    const s = readSource(ACTIVITY_SECTION_PATH);
    expect(s).not.toMatch(/\bSMS\b/);
  });
});

describe("D. email_opted_out_count is absent from 0170, db/types.ts, and the Activity UI", () => {
  it("the migration's return table and SELECT no longer produce an opted-out column (checked within the function body only — the migration's own historical CORRECTION note legitimately names the removed column for documentation)", () => {
    const s = readSource(MIGRATION_PATH);
    const fnStart = s.indexOf("create or replace function public.get_communications_activity(");
    const fnEnd   = s.indexOf("grant  execute on function public.get_communications_activity");
    const fnBody  = s.slice(fnStart, fnEnd);
    expect(fnBody).not.toMatch(/email_opted_out_count/);
    expect(fnBody).not.toMatch(/status = 'opted_out'/);
  });

  it("db/types.ts's get_communications_activity Returns shape has no opted-out field", () => {
    const s = readSource("src/lib/db/types.ts");
    const fnStart = s.indexOf("get_communications_activity: {");
    const fnEnd   = s.indexOf("};", s.indexOf("Returns: {", fnStart));
    const fnBlock = s.slice(fnStart, fnEnd);
    expect(fnBlock).not.toMatch(/email_opted_out_count/);
    expect(fnBlock).toContain("email_sent_count");
    expect(fnBlock).toContain("email_failed_count");
  });

  it("AnnouncementBatch never carries an opted-out count, and the batch-level metrics row never renders one (a per-recipient drill-down status of 'opted_out' is a separate, evidence-based concern — see the recipientStatusLabel coverage below — not the removed aggregate metric)", () => {
    const s = readSource(ACTIVITY_SECTION_PATH);
    expect(s).not.toMatch(/emailOptedOutCount/);
    const metricsRowStart = s.indexOf('className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500 dark:text-gray-400"');
    const metricsRowEnd   = s.indexOf("</div>", metricsRowStart);
    const metricsRow = s.slice(metricsRowStart, metricsRowEnd);
    expect(metricsRow).not.toMatch(/Email opted out/);
  });

  it("page.tsx's row-mapping no longer reads email_opted_out_count", () => {
    const s = readSource(PAGE_PATH);
    expect(s).not.toMatch(/email_opted_out_count/);
  });
});

describe("E. no fake inferred 'not sent' metric was added", () => {
  it("Activity shows exactly Recipients / Email sent / Email failed — no subtraction-derived count", () => {
    const s = readSource(ACTIVITY_SECTION_PATH);
    expect(s).toContain("Recipients: {b.recipientCount}");
    expect(s).not.toMatch(/recipientCount\s*-\s*emailSentCount/);
    expect(s).not.toMatch(/not[_ ]sent/i);
  });
});

describe("16. Activity does not rely on lossy generic audit-log client-side filtering", () => {
  it("page.tsx calls the dedicated get_communications_activity RPC, never get_audit_log, for the Activity list", () => {
    const s = readSource(PAGE_PATH);
    expect(s).toContain('supabase.rpc("get_communications_activity"');
    expect(s).not.toContain('get_audit_log');
  });

  it("the RPC itself filters action = 'send_announcement' server-side within the query, not via a paginated generic feed", () => {
    const s = readSource(MIGRATION_PATH);
    expect(s).toContain("where al.club_id = v_caller_club");
    expect(s).toContain("and al.action  = 'send_announcement'");
  });
});

describe("17. announcement detail remains Admin/club-scoped", () => {
  it("get_communications_activity fails closed (returns, no rows) for a non-admin or club-less caller", () => {
    const s = readSource(MIGRATION_PATH);
    expect(s).toContain("if v_caller_club is null or v_caller_role <> 'admin' then");
    expect(s).toContain("return;");
  });

  it("EXECUTE is revoked from public/anon and granted only to authenticated, matching get_announcement_batch_delivery_context's own hardening", () => {
    const s = readSource(MIGRATION_PATH);
    expect(s).toContain("revoke execute on function public.get_communications_activity(int, int) from public, anon;");
    expect(s).toContain("grant  execute on function public.get_communications_activity(int, int) to authenticated;");
  });

  it("the RPC is SECURITY DEFINER, STABLE, and pins search_path", () => {
    const s = readSource(MIGRATION_PATH);
    const fnStart = s.indexOf("create or replace function public.get_communications_activity(");
    const fnDecl  = s.slice(fnStart, fnStart + 600);
    expect(fnDecl).toContain("security definer");
    expect(fnDecl).toContain("stable");
    expect(fnDecl).toContain("set search_path = public, pg_temp");
  });

  it("the drill-down action relies on get_announcement_batch_delivery_context's own admin/club-scoped authorization, adding no separate role check of its own (matching sendAnnouncementAction's own convention of trusting its RPC)", () => {
    const s = readSource(ACTIONS_PATH);
    expect(s).toContain('supabase.rpc("get_announcement_batch_delivery_context", {');
  });
});

describe("H. pagination is bounded and fails safely — not general pagination infrastructure", () => {
  it("p_limit is clamped to [1, 100] with a default of 20", () => {
    const s = readSource(MIGRATION_PATH);
    expect(s).toContain("v_limit       int := greatest(1, least(coalesce(p_limit, 20), 100));");
  });

  it("p_offset is clamped to [0, ...) with a default of 0", () => {
    const s = readSource(MIGRATION_PATH);
    expect(s).toContain("v_offset      int := greatest(0, coalesce(p_offset, 0));");
  });

  it("the final query uses the clamped v_limit/v_offset, never the raw p_limit/p_offset parameters, in its LIMIT/OFFSET clause", () => {
    const s = readSource(MIGRATION_PATH);
    expect(s).toContain("limit v_limit offset v_offset;");
    expect(s).not.toMatch(/limit p_limit offset p_offset/);
  });

  it("this stays a fixed clamp on one RPC, not generalized pagination infrastructure — no shared pagination helper/table was introduced", () => {
    const s = readSource(MIGRATION_PATH);
    expect(s).not.toMatch(/create (or replace )?function public\.(paginate|clamp_pagination)/);
    expect((s.match(/create or replace function public\./g) ?? []).length).toBe(1);
  });
});

describe("18. Diagnostics relocation", () => {
  it("DeliveryDiagnosticsSection and TestSmsSection live at the new location", () => {
    const diag = readSource(DIAGNOSTICS_PATH);
    expect(diag).toContain('import TestSmsSection from "./TestSmsSection";');
    const testSms = readSource(TEST_SMS_PATH);
    expect(testSms).toContain('import { sendTestSms } from "./communicationsActions";');
  });

  it("page.tsx renders DeliveryDiagnosticsSection under the diagnostics tab with email/sms configured props", () => {
    const s = readSource(PAGE_PATH);
    expect(s).toContain('import DeliveryDiagnosticsSection from "./DeliveryDiagnosticsSection";');
    expect(s).toMatch(/tab === "diagnostics" &&[\s\S]{0,600}<DeliveryDiagnosticsSection/);
  });

  it("no provider credential value or environment-variable name is passed as a prop or rendered — only booleans", () => {
    const s = readSource(PAGE_PATH);
    expect(s).not.toMatch(/TWILIO_ACCOUNT_SID\s*[:=]\s*[^!]/);
    expect(s).toContain("!!process.env.TWILIO_ACCOUNT_SID");
  });

  it("no retry control or provider credential management was added", () => {
    const s = readSource(DIAGNOSTICS_PATH);
    expect(s).not.toMatch(/retry/i);
    expect(s).not.toMatch(/api[_-]?key/i);
  });
});

describe("19. detailed delivery failure history lives in Communications", () => {
  it("DeliveryDiagnosticsSection renders the per-failure list (channel + relative age), absorbed from Overview", () => {
    const s = readSource(DIAGNOSTICS_PATH);
    expect(s).toContain("failureDetails.map((f, i) =>");
    expect(s).toContain("f.channel");
    expect(s).toContain("formatRelativeAge(f.created_at)");
  });

  it("page.tsx fetches the failure count and up to 10 failure details, club-scoped", () => {
    const s = readSource(PAGE_PATH);
    expect(s).toContain('.from("notification_deliveries")');
    expect(s).toContain('.eq("club_id", clubId)');
    expect(s).toContain(".limit(10)");
  });
});

describe("20. Overview retains a lightweight summary + diagnostics link, never the detailed list", () => {
  it("Overview's Communications section links to /admin/communications?tab=diagnostics", () => {
    const s = readSource(OVERVIEW_PAGE_PATH);
    expect(s).toContain('href="/admin/communications?tab=diagnostics"');
    expect(s).toContain("<SectionHeading>Communications</SectionHeading>");
  });

  it("Overview no longer maps over a per-failure details array — no duplicated detailed list", () => {
    const s = readSource(OVERVIEW_PAGE_PATH);
    expect(s).not.toMatch(/failureDetails\.map/);
    expect(s).not.toContain("formatRelativeAge");
  });

  it("Overview still shows email/sms configured status and the 48h failure count — high-level visibility is preserved, not removed", () => {
    const s = readSource(OVERVIEW_PAGE_PATH);
    expect(s).toContain("Email configured");
    expect(s).toContain("SMS configured");
    expect(s).toContain("Delivery failures (48 h)");
  });
});

describe("21. sendTestSms explicitly requires Admin server-side", () => {
  it("sendTestSms checks profile.role === 'admin' before doing anything else communication-related", () => {
    const s = readSource(ACTIONS_PATH);
    const fnStart = s.indexOf("export async function sendTestSms(): Promise<{ sid?: string; error?: string }> {");
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = s.slice(fnStart, fnStart + 400);
    expect(fnBody).toContain("const profile = await getAuthProfile();");
    expect(fnBody).toContain('if (profile?.role !== "admin") return { error: "Admin access required." };');
    // The admin check must precede the get_my_communication_settings call.
    const adminCheckIdx = fnBody.indexOf('profile?.role !== "admin"');
    const rpcIdx        = fnBody.indexOf("get_my_communication_settings");
    expect(adminCheckIdx).toBeGreaterThan(-1);
    expect(rpcIdx === -1 || adminCheckIdx < rpcIdx).toBe(true);
  });
});

describe("22. get_my_communication_settings remains self-service-capable — not narrowed", () => {
  it("this checkpoint's migration does not modify get_my_communication_settings", () => {
    const s = readSource(MIGRATION_PATH);
    expect(s).not.toMatch(/get_my_communication_settings/);
  });

  it("/profile/notifications still calls it directly with no admin check — Members/Staff/Pros keep using their own communication settings", () => {
    const s = readSource("src/app/(app)/profile/notifications/page.tsx");
    expect(s).toContain('supabase.rpc("get_my_communication_settings")');
    expect(s).not.toContain('profile?.role !== "admin"');
  });
});

describe("26-28. Navigation: Admin-only, Staff/Pro/Member excluded", () => {
  it("SideNav's Admin block includes Communications, positioned after Club Settings and before Audit Log", () => {
    const s = readSource(SIDE_NAV_PATH);
    const settingsIdx = s.indexOf('href="/admin/settings"');
    const commsIdx     = s.indexOf('href="/admin/communications"');
    const auditIdx     = s.indexOf('href="/admin/audit-log"');
    expect(settingsIdx).toBeGreaterThan(-1);
    expect(commsIdx).toBeGreaterThan(settingsIdx);
    expect(auditIdx).toBeGreaterThan(commsIdx);
  });

  it("BottomNav's Admin moreLinks includes Communications, positioned after Club Settings and before Audit Log", () => {
    const s = readSource(BOTTOM_NAV_PATH);
    const adminLinksStart = s.indexOf('const moreLinks = userRole === "admin"');
    const adminLinksEnd   = s.indexOf("// Phase 34A: admin+staff (isOperator)", adminLinksStart);
    const adminBlock = s.slice(adminLinksStart, adminLinksEnd);
    const settingsIdx = adminBlock.indexOf('href: "/admin/settings"');
    const commsIdx     = adminBlock.indexOf('href: "/admin/communications"');
    const auditIdx     = adminBlock.indexOf('href: "/admin/audit-log"');
    expect(settingsIdx).toBeGreaterThan(-1);
    expect(commsIdx).toBeGreaterThan(settingsIdx);
    expect(auditIdx).toBeGreaterThan(commsIdx);
  });

  it("SideNav's Pro and Staff blocks never reference /admin/communications", () => {
    const s = readSource(SIDE_NAV_PATH);
    const proBlockStart = s.indexOf(': userRole === "pro" ? (');
    const memberBlockStart = s.indexOf(") : (", s.indexOf('userRole === "staff"'));
    const workspaceBlock = s.slice(proBlockStart, memberBlockStart);
    expect(workspaceBlock).not.toContain("/admin/communications");
  });

  it("BottomNav's isOperator (Staff) and plain-Member moreLinks arrays never reference /admin/communications", () => {
    const s = readSource(BOTTOM_NAV_PATH);
    const afterAdminBlock = s.slice(s.indexOf("// Phase 34A: admin+staff (isOperator)"));
    expect(afterAdminBlock).not.toContain("/admin/communications");
  });
});

describe("29-32. no out-of-scope implementation was added", () => {
  it("29. no event-targeted announcement implementation — send_announcement_v2 is still called with only {p_title, p_body}, no event/participant argument", () => {
    const s = readSource(ACTIONS_PATH);
    expect(s).not.toMatch(/p_event_id|p_participants|audience_type/);
  });

  it("30. no reminder/scheduler implementation — no cron, queue, or reminder table/RPC reference anywhere in the new Communications files", () => {
    for (const path of [PAGE_PATH, ANNOUNCEMENTS_PATH, ACTIVITY_SECTION_PATH, DIAGNOSTICS_PATH, ACTIONS_PATH, MIGRATION_PATH]) {
      const s = readSource(path);
      expect(s).not.toMatch(/cron|pg_cron|reminder_schedule|scheduled_send/i);
    }
  });

  it("31. no Member messaging implementation — no inbox/thread/reply/unread-message construct was added", () => {
    for (const path of [PAGE_PATH, ANNOUNCEMENTS_PATH, ACTIVITY_SECTION_PATH]) {
      const s = readSource(path);
      expect(s).not.toMatch(/inbox|thread_id|member_message|support_ticket/i);
    }
  });

  it("32. no payment behavior changes — no Communications file references Stripe or Court Time Payments", () => {
    for (const path of [PAGE_PATH, ANNOUNCEMENTS_PATH, ACTIVITY_SECTION_PATH, DIAGNOSTICS_PATH, TEST_SMS_PATH, ACTIONS_PATH, MIGRATION_PATH]) {
      const s = readSource(path);
      expect(s).not.toMatch(/stripe|court_time_payments|payment_mode/i);
    }
  });
});
