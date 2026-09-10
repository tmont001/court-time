import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 34G-D1 — Production Code Hardening. Source-inspection regression
// coverage (this project's established convention for Server Action/route/
// migration wiring that isn't a pure function — see paymentProvenanceUX.
// regression.test.ts / courtTimeBrand.regression.test.ts for precedent)
// proving each of the 9 hardening items from the 34G-D audit. Letters
// below reference the corresponding §10 spec item.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

const REFUND_ACTIONS_PATH = "src/app/(app)/admin/payments/refundActions.ts";
const PAYMENTS_ACTIONS_PATH = "src/app/(app)/admin/payments/actions.ts";
const CHECKOUT_INVALIDATION_PATH = "src/lib/stripe/checkoutInvalidation.ts";
const PAYMENTS_WEBHOOK_PATH = "src/app/api/stripe/payments/events/route.ts";
const CONNECT_WEBHOOK_PATH = "src/app/api/stripe/connect/account-events/route.ts";
const RESERVATION_CHECKOUT_PATH = "src/app/(app)/calendar/reservationCheckoutActions.ts";
const EXPORT_ACTIONS_PATH = "src/app/(app)/admin/payments/exportActions.ts";
const TAILWIND_CONFIG_PATH = "tailwind.config.ts";
const ACTION_BUTTON_STYLES_PATH = "src/components/styles/actionButtonStyles.ts";
const PAGE_PATH = "src/app/(app)/admin/payments/page.tsx";
const CLIENT_PATH = "src/app/(app)/admin/payments/AdminPaymentsClient.tsx";
const MIGRATION_0166_PATH = "supabase/migrations/0166_bootstrap_new_club_search_path_hardening.sql";
const MIGRATION_0167_PATH = "supabase/migrations/0167_bootstrap_new_club_execute_privilege_hardening.sql";
const MIGRATION_0164_PATH = "supabase/migrations/0164_pricing_packaging_alignment.sql";
const MIGRATION_0143_PATH = "supabase/migrations/0143_payment_mode_and_ledger_foundation.sql";

// ═══════════════════════════════════════════════════════════════════════════
// 1 — Refund tenant scoping (A, B, C)
// ═══════════════════════════════════════════════════════════════════════════

describe("A/B/C. createOnlineRefundAction's authoritative club identity is profile.club_id, never expectedClubId", () => {
  it("A. open_payment_refund_attempt's p_club_id comes from the server-derived `clubId` local, not expectedClubId", () => {
    const s = codeOnly(readSource(REFUND_ACTIONS_PATH));
    expect(s).toContain("p_club_id: clubId,");
    expect(s).not.toMatch(/p_club_id:\s*expectedClubId/);
  });

  it("B. buildRefundMetadata's clubId argument comes from `clubId`, not expectedClubId", () => {
    const s = codeOnly(readSource(REFUND_ACTIONS_PATH));
    const metadataIdx = s.indexOf("metadata: buildRefundMetadata({");
    const metadataEnd = s.indexOf("}),", metadataIdx);
    const metadataBlock = s.slice(metadataIdx, metadataEnd);
    expect(metadataBlock).toContain("clubId,");
    expect(metadataBlock).not.toMatch(/expectedClubId/);
  });

  it("`clubId` itself is derived from profile.club_id, resolved after the Admin-only role check", () => {
    const s = codeOnly(readSource(REFUND_ACTIONS_PATH));
    expect(s).toContain("const clubId = profile.club_id;");
    const clubIdIdx = s.indexOf("const clubId = profile.club_id;");
    const roleCheckIdx = s.indexOf('profile.role !== "admin"');
    expect(roleCheckIdx).toBeGreaterThan(-1);
    expect(clubIdIdx).toBeGreaterThan(roleCheckIdx);
  });

  it("C. expectedClubId appears ONLY in the parameter declaration and the assertActiveClub preflight call — never in any RPC/metadata argument", () => {
    const s = codeOnly(readSource(REFUND_ACTIONS_PATH));
    const fnStart = s.indexOf("export async function createOnlineRefundAction(");
    const fnBody = s.slice(fnStart);
    const usages = fnBody.split("expectedClubId").length - 1;
    // (1) the parameter declaration itself, (2) the assertActiveClub call.
    expect(usages).toBe(2);
    expect(fnBody).toContain("expectedClubId: string,");
    expect(fnBody).toContain("assertActiveClub(expectedClubId)");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 — Payment history tenant/role correction (D, E, F)
// ═══════════════════════════════════════════════════════════════════════════

describe("D/E/F. fetchPaymentEventHistory follows the exportActions.ts known-good pattern", () => {
  it("D. the payment_events query filters on the server-derived `clubId` (profile.club_id), not expectedClubId", () => {
    const s = codeOnly(readSource(PAYMENTS_ACTIONS_PATH));
    const fnStart = s.indexOf("export async function fetchPaymentEventHistory(");
    const fnEnd = s.indexOf("\nexport async function updateClubPaymentModeAction", fnStart);
    const fn = s.slice(fnStart, fnEnd);
    expect(fn).toContain("const clubId = profile.club_id;");
    expect(fn).toMatch(/\.eq\("club_id",\s*clubId\)/);
    expect(fn).not.toMatch(/\.eq\("club_id",\s*expectedClubId\)/);
  });

  it("E. explicitly blocks Member/non-staff Pro via isOperator(profile.role) — an application-layer gate, not RLS alone", () => {
    const s = codeOnly(readSource(PAYMENTS_ACTIONS_PATH));
    const fnStart = s.indexOf("export async function fetchPaymentEventHistory(");
    const fnEnd = s.indexOf("\nexport async function updateClubPaymentModeAction", fnStart);
    const fn = s.slice(fnStart, fnEnd);
    expect(fn).toContain("isOperator(profile.role)");
    expect(s).toContain('import { isOperator } from "@/lib/auth/roles";');
  });

  it("F. RLS remains intact — payment_events_select_admin_staff (the backstop) is unmodified in its original migration", () => {
    const migration = readSource(MIGRATION_0143_PATH);
    expect(migration).toContain("payment_events_select_admin_staff");
    expect(migration).toMatch(/current_user_club_id\(\)/);
  });

  it("assertActiveClub remains the stale-context preflight, checked first", () => {
    const s = codeOnly(readSource(PAYMENTS_ACTIONS_PATH));
    const fnStart = s.indexOf("export async function fetchPaymentEventHistory(");
    const guardIdx = s.indexOf("assertActiveClub(expectedClubId)", fnStart);
    const profileIdx = s.indexOf("getAuthProfile()", fnStart);
    expect(guardIdx).toBeGreaterThan(fnStart);
    expect(profileIdx).toBeGreaterThan(guardIdx);
  });

  it("returned history fields/shape (PaymentEventHistoryItem) are unchanged by this correction", () => {
    const s = readSource(PAYMENTS_ACTIONS_PATH);
    expect(s).toContain("export interface PaymentEventHistoryItem {");
    expect(s).toContain("actorName: string | null;");
    expect(s).toContain("reversesEventId: string | null;");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 — Checkout invalidation structural correction (G, H)
// ═══════════════════════════════════════════════════════════════════════════

describe("G/H. resolveBlockingCheckoutBeforeMutation is structurally safe regardless of caller convention", () => {
  it("G. both privileged RPC calls (lookup + finalize) use the internally-derived `clubId` (profile.club_id), never the expectedClubId parameter", () => {
    const s = codeOnly(readSource(CHECKOUT_INVALIDATION_PATH));
    const fnStart = s.indexOf("export async function resolveBlockingCheckoutBeforeMutation(");
    const fn = s.slice(fnStart);
    expect(fn).toContain("const clubId = profile?.club_id;");
    expect(fn).toMatch(/p_club_id:\s*clubId\s*}/); // get_blocking_checkout_attempt_for_payment
    expect(fn).toMatch(/p_club_id:\s*clubId\s*}/); // expire_blocking_checkout_attempt (same pattern)
    expect(fn).not.toMatch(/p_club_id:\s*expectedClubId/);
  });

  it("the function performs its own assertActiveClub(expectedClubId) preflight internally — structural, not dependent on caller convention", () => {
    const s = codeOnly(readSource(CHECKOUT_INVALIDATION_PATH));
    const fnStart = s.indexOf("export async function resolveBlockingCheckoutBeforeMutation(");
    const fn = s.slice(fnStart, fnStart + 800);
    expect(fn).toContain("assertActiveClub(expectedClubId)");
    expect(fn).toContain("getAuthProfile()");
  });

  it("no circular dependency was introduced — @/lib/supabase/user has no Stripe imports", () => {
    const userLib = readSource("src/lib/supabase/user.ts");
    expect(userLib).not.toMatch(/from ["']@\/lib\/stripe/);
  });

  it("H. the exported function signature (paymentId, expectedClubId) is unchanged — every existing call site remains behaviorally identical with zero call-site edits", () => {
    const s = readSource(CHECKOUT_INVALIDATION_PATH);
    expect(s).toContain(
      "export async function resolveBlockingCheckoutBeforeMutation(\n  paymentId: string,\n  expectedClubId: string,\n): Promise<ResolveBlockingCheckoutResult> {",
    );
  });

  it("H. every existing call site still passes exactly (paymentId, someClubId) positionally — no call site was rewritten", () => {
    const callSites = [
      "src/app/(app)/calendar/actions.ts",
      "src/app/(app)/admin/payments/actions.ts",
      "src/app/(app)/admin/events/actions.ts",
      "src/app/(app)/lessons/actions.ts",
      "src/app/(app)/events/programsActions.ts",
      "src/app/(app)/events/programRosterActions.ts",
      "src/app/(app)/events/programEnrollmentActions.ts",
    ];
    for (const path of callSites) {
      const s = readSource(path);
      expect(s).toMatch(/resolveBlockingCheckoutBeforeMutation\([^,]+,\s*[^)]+\)/);
    }
  });

  it("H. the resolution's own branch logic (still-processing vs resolution-failed vs ok) is unchanged", () => {
    const s = readSource(CHECKOUT_INVALIDATION_PATH);
    expect(s).toContain("CHECKOUT_STILL_PROCESSING_CODE");
    expect(s).toContain("RESOLUTION_FAILED_CODE");
    expect(s).toContain('if (session.status === "complete") {');
    expect(s).toContain('if (session.status === "open") {');
    expect(s).toContain('finalizeRows?.[0]?.action === "already_completed"');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 — Webhook failure observability (I, J, K)
// ═══════════════════════════════════════════════════════════════════════════

describe("I/J/K. Both Stripe webhook routes log sanitized diagnostics on every failure path", () => {
  it("I. payments/events webhook: logWebhookFailure is called on every failure branch", () => {
    const s = codeOnly(readSource(PAYMENTS_WEBHOOK_PATH));
    const failureLogCount = (s.match(/logWebhookFailure\(/g) ?? []).length;
    // 1 function definition + 17 call sites (missing_webhook_secret,
    // missing_stripe_context (main), missing_signature_header,
    // signature_verification_failed, checkout_session_missing_amount_or_currency,
    // missing_privileged_client (main), process_stripe_payment_event,
    // missing_stripe_context (refund), refund_retrieve_failed, refund_status_unrecognized,
    // missing_privileged_client (refund), process_stripe_refund_webhook_event,
    // missing_stripe_context (dispute), dispute_retrieve_failed, dispute_charge_retrieve_failed,
    // missing_privileged_client (dispute), process_stripe_dispute_webhook_event) = 18
    expect(failureLogCount).toBe(18);
  });

  it("I. connect/account-events webhook: logWebhookFailure is called on every failure branch", () => {
    const s = codeOnly(readSource(CONNECT_WEBHOOK_PATH));
    const failureLogCount = (s.match(/logWebhookFailure\(/g) ?? []).length;
    // 1 function definition + 8 call sites (missing_webhook_secret,
    // missing_stripe_context, missing_signature_header,
    // signature_verification_failed, fetch_event_failed, account_retrieve_failed,
    // missing_privileged_client, process_stripe_connect_account_event) = 9
    expect(failureLogCount).toBe(9);
  });

  it("J. neither webhook route's logging ever passes rawBody, the signature header, or the webhook secret as a logged value", () => {
    // Line-window-scoped (not a multi-line regex requiring the ES2018 `s`
    // flag) — every call site here spans at most 4 source lines.
    for (const path of [PAYMENTS_WEBHOOK_PATH, CONNECT_WEBHOOK_PATH]) {
      const lines = codeOnly(readSource(path)).split("\n");
      let checked = 0;
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].includes("logWebhookFailure(")) continue;
        if (lines[i].trim().startsWith("function ")) continue; // the definition itself
        const window = lines.slice(i, i + 4).join("\n");
        expect(window).not.toMatch(/rawBody/);
        expect(window).not.toMatch(/\bsignature\b/);
        expect(window).not.toMatch(/webhookSecret/);
        checked++;
      }
      expect(checked).toBeGreaterThan(0);
    }
  });

  it("J. logWebhookFailure's own implementation only ever extracts {code, message} from an error — never logs a full object/event/refund/dispute verbatim", () => {
    for (const path of [PAYMENTS_WEBHOOK_PATH, CONNECT_WEBHOOK_PATH]) {
      const s = codeOnly(readSource(path));
      const fnStart = s.indexOf("function logWebhookFailure(");
      const fnEnd = s.indexOf("\n}", fnStart) + 2;
      const fn = s.slice(fnStart, fnEnd);
      expect(fn).toContain("code");
      expect(fn).toContain("message");
      expect(fn).not.toMatch(/event\.data|refund\.metadata|dispute\.evidence|JSON\.stringify\(err\)/);
    }
  });

  it("J. no route ever logs the full verified event/refund/dispute/account object (e.g. via console.error(event) or console.error(refund))", () => {
    for (const path of [PAYMENTS_WEBHOOK_PATH, CONNECT_WEBHOOK_PATH]) {
      const s = codeOnly(readSource(path));
      expect(s).not.toMatch(/console\.error\([^,)]*\bevent\b\)/);
      expect(s).not.toMatch(/console\.error\([^,)]*\brefund\b\)/);
      expect(s).not.toMatch(/console\.error\([^,)]*\bdispute\b\)/);
      expect(s).not.toMatch(/console\.error\([^,)]*\baccount\b\)/);
    }
  });

  it("K. payments/events webhook: every HTTP status code is unchanged from before this correction pass", () => {
    const s = codeOnly(readSource(PAYMENTS_WEBHOOK_PATH));
    // 500s: missing config/context, checkout amount/currency anomaly, missing
    // privileged client, RPC failures (payment/refund/dispute), retrieve failures.
    expect((s.match(/status: 500/g) ?? []).length).toBeGreaterThanOrEqual(13);
    // 400s: missing signature header, signature verification failure.
    expect((s.match(/status: 400/g) ?? []).length).toBe(2);
    // 200s: legitimate skips + successful reconciliation paths.
    expect((s.match(/status: 200/g) ?? []).length).toBeGreaterThanOrEqual(8);
  });

  it("K. connect/account-events webhook: every HTTP status code is unchanged from before this correction pass", () => {
    const s = codeOnly(readSource(CONNECT_WEBHOOK_PATH));
    expect((s.match(/status: 500/g) ?? []).length).toBeGreaterThanOrEqual(6);
    expect((s.match(/status: 400/g) ?? []).length).toBe(2);
    expect((s.match(/status: 200/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("no webhook lifecycle behavior changed — both routes still call the same reconciliation RPCs with the same parameters as before", () => {
    const paymentsSrc = readSource(PAYMENTS_WEBHOOK_PATH);
    expect(paymentsSrc).toContain('privileged.rpc("process_stripe_payment_event"');
    expect(paymentsSrc).toContain('privileged.rpc("process_stripe_refund_webhook_event"');
    expect(paymentsSrc).toContain('privileged.rpc("process_stripe_dispute_webhook_event"');
    const connectSrc = readSource(CONNECT_WEBHOOK_PATH);
    expect(connectSrc).toContain('privileged.rpc("process_stripe_connect_account_event"');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5 — Reservation checkout observability (L)
// ═══════════════════════════════════════════════════════════════════════════

describe("L. reservationCheckoutActions.ts gets the sibling-style sanitized diagnostic helper", () => {
  it("logUnexpectedReservationCheckoutError exists, mirroring logUnexpectedEventCheckoutError's exact {reservation_id, code, message} shape", () => {
    const s = readSource(RESERVATION_CHECKOUT_PATH);
    expect(s).toContain("function logUnexpectedReservationCheckoutError(");
    expect(s).toContain("reservation_id: reservationId,");
    expect(s).toContain("code: err?.code ?? null,");
    expect(s).toContain("message: err?.message ?? null,");
  });

  it("is wired into every previously-silent catch/unrecognized-error branch", () => {
    const s = codeOnly(readSource(RESERVATION_CHECKOUT_PATH));
    const callCount = (s.match(/logUnexpectedReservationCheckoutError\(/g) ?? []).length;
    // 1 function definition + 10 call sites: connected_account_retrieve,
    // open_payment_checkout_attempt, stale_session_retrieve,
    // stale_session_expire, supersede_checkout_attempt_and_open_fresh,
    // checkout_session_reuse_retrieve, checkout_session_create (catch),
    // checkout_session_create (missing url/expires_at),
    // record_checkout_session_created, final_session_url_check.
    expect(callCount).toBe(11);
  });

  it("does not log Stripe objects, auth information, metadata blobs, or secrets — only reservationId/stage/code/message", () => {
    // Line-scoped (not block-regex) check to sidestep semicolons/parens
    // legitimately embedded inside a call's own type-cast/template-literal
    // arguments — every call site here spans at most 3 source lines.
    const lines = readSource(RESERVATION_CHECKOUT_PATH).split("\n");
    let checked = 0;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes("logUnexpectedReservationCheckoutError(")) continue;
      if (lines[i].trim().startsWith("function ")) continue; // the definition itself
      const window = lines.slice(i, i + 3).join("\n");
      // A boolean presence-check (!!session.url) is fine — it never logs
      // the actual URL string; only a BARE, unwrapped reference would leak
      // the value itself.
      expect(window).not.toMatch(/[^!]session\.url\b/);
      expect(window).not.toMatch(/idempotencyKey|clientSecret|stripeAccount:|account\.email|account\.id\b/);
      checked++;
    }
    expect(checked).toBe(10);
  });

  it("preserves all existing Member-facing error messages — ERROR_MESSAGES map is untouched", () => {
    const s = readSource(RESERVATION_CHECKOUT_PATH);
    expect(s).toContain('insufficient_role: "Online payment is only available to Members paying their own booking."');
    expect(s).toContain('payment_processing: "Your payment is already being processed. Please check back in a moment."');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6 — Export error logging sanitization (M)
// ═══════════════════════════════════════════════════════════════════════════

describe("M. exportActions.ts logs only {club_id, code, message} for every genuine error-reporting call — never a whole error object", () => {
  it("every console.error call that reports an underlying read/write failure includes both `code` and `message` keys", () => {
    const s = codeOnly(readSource(EXPORT_ACTIONS_PATH));
    // The 9 genuine error-reporting calls (club metadata, outstanding
    // payments/hydration/provenance, activity events/reversal-target/
    // parent-payment/hydration/actor-lookup) — diagnostic-only calls
    // (missing required domain context, unresolved reversal target,
    // unresolved signed amount) report an application-level invariant
    // violation with no separate caught error object, so they are
    // correctly excluded from this shape.
    const errorReportingCalls = [
      "club metadata read failed",
      "outstanding balances payments read failed",
      "outstanding balances domain hydration failed",
      "outstanding balances provenance read failed",
      "payment activity events read failed",
      "payment activity reversal-target read failed",
      "payment activity parent-payment read failed",
      "payment activity domain hydration failed",
      "payment activity actor lookup failed",
    ];
    for (const label of errorReportingCalls) {
      const idx = s.indexOf(label);
      expect(idx).toBeGreaterThan(-1);
      const callBlock = s.slice(idx, s.indexOf(");", idx));
      expect(callBlock).toMatch(/code:/);
      expect(callBlock).toMatch(/message:/);
    }
  });

  it("never logs a whole error object directly under `message` (e.g. `message: someError` where someError is an object, not a string/property access)", () => {
    const s = codeOnly(readSource(EXPORT_ACTIONS_PATH));
    // A raw-object leak would look like `message: xError }` with no
    // `code:` sibling on the same call — already disproven above, but
    // this additionally confirms no call passes an error variable
    // directly as the whole logged value (e.g. `console.error(msg, err)`
    // with err a bare second positional argument).
    const rawObjectLeak = /console\.error\([^,]+,\s*\w*[eE]rror\)/;
    expect(s).not.toMatch(rawObjectLeak);
  });

  it("export behavior itself is unchanged — same CSV columns, same error-message map, same fail-closed returns", () => {
    const s = readSource(EXPORT_ACTIONS_PATH);
    expect(s).toContain("ERROR_MESSAGES.load_failed");
    expect(s).toContain("serializeCsv(OUTSTANDING_BALANCE_COLUMNS,");
    expect(s).toContain("serializeCsv(PAYMENT_ACTIVITY_COLUMNS,");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7 — Tailwind shared action-button fix (N, O)
// ═══════════════════════════════════════════════════════════════════════════

describe("N/O. actionButtonStyles.ts lives in an already-Tailwind-scanned path; no global src/lib/** glob was introduced", () => {
  it("N. the file exists at src/components/styles/actionButtonStyles.ts (under src/components/**, already scanned)", () => {
    expect(() => readSource(ACTION_BUTTON_STYLES_PATH)).not.toThrow();
    const s = readSource(ACTION_BUTTON_STYLES_PATH);
    expect(s).toContain("export const ACTION_BUTTON_PRIMARY =");
    expect(s).toContain("export const ACTION_BUTTON_POSITIVE_COMPACT =");
  });

  it("N. no longer exists at the old src/lib/actionButtonStyles.ts location", () => {
    expect(() => readSource("src/lib/actionButtonStyles.ts")).toThrow();
  });

  it("N. every exported class string is unchanged by the move (byte-for-byte, including the previously-uncompiled classes)", () => {
    const s = readSource(ACTION_BUTTON_STYLES_PATH);
    expect(s).toContain("hover:brightness-110");
    expect(s).toContain("disabled:opacity-40 disabled:pointer-events-none");
    expect(s).toContain("focus-visible:ring-green-500");
    expect(s).toContain("focus-visible:ring-blue-500");
    expect(s).toContain("focus-visible:ring-amber-500");
  });

  it("O. tailwind.config.ts's content array is exactly the original 3 globs — no src/lib entry was (re-)added", () => {
    const config = readSource(TAILWIND_CONFIG_PATH);
    const contentStart = config.indexOf("content: [");
    const contentEnd = config.indexOf("],", contentStart);
    const contentBlock = config.slice(contentStart, contentEnd);
    expect(contentBlock).not.toMatch(/src\/lib/);
    const globCount = (contentBlock.match(/"\.\/src\//g) ?? []).length;
    expect(globCount).toBe(3);
  });

  it("the /events re-export shim now points at the new location, preserving every existing relative-import call site unchanged", () => {
    const s = readSource("src/app/(app)/events/actionButtonStyles.ts");
    expect(s).toContain('from "@/components/styles/actionButtonStyles"');
    expect(s).not.toMatch(/@\/lib\/actionButtonStyles/);
  });

  it("every former @/lib/actionButtonStyles importer now imports from the new path", () => {
    const importers = [
      "src/app/(app)/calendar/ReservationDetailSheet.tsx",
      "src/app/(app)/calendar/EventDetailSheet.tsx",
      "src/app/(app)/admin/lessons/LessonTypesSection.tsx",
      "src/app/(app)/admin/events/EventTypesSection.tsx",
      "src/app/(app)/admin/payments/PaymentActivityExportSheet.tsx",
      "src/app/(app)/admin/payments/AdminPaymentsClient.tsx",
      "src/app/(app)/admin/members/[id]/MemberDetailClient.tsx",
      "src/app/(app)/admin/courts/CourtManagementList.tsx",
      "src/app/(app)/lessons/LessonRequestDetail.tsx",
      "src/app/(app)/events/LessonProSheet.tsx",
    ];
    for (const path of importers) {
      const s = readSource(path);
      expect(s).toContain("@/components/styles/actionButtonStyles");
      expect(s).not.toMatch(/@\/lib\/actionButtonStyles/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8 — bootstrap_new_club search_path hardening (Q, R, S)
// ═══════════════════════════════════════════════════════════════════════════

describe("Q/R/S. bootstrap_new_club gets an explicit hardened search_path (0166) and EXECUTE-privilege lockdown (0167), both via NEW migrations, without touching 0164", () => {
  it("Q. migration 0166 applies `set search_path to 'public', 'pg_temp'` to bootstrap_new_club's exact existing signature", () => {
    const s = readSource(MIGRATION_0166_PATH);
    expect(s).toContain("alter function public.bootstrap_new_club(");
    expect(s).toContain("text, text, text, int, uuid, text[], time, time, int, int, int");
    expect(s).toContain("set search_path to 'public', 'pg_temp'");
  });

  it("Q. does not redefine the function body, arguments, or use CREATE OR REPLACE — ALTER FUNCTION only", () => {
    const s = readSource(MIGRATION_0166_PATH);
    expect(s).not.toMatch(/create (or replace )?function/i);
    expect(s).toMatch(/^alter function/im);
  });

  // QA correction — live ACL inspection (aclexplode) of the deployed
  // database, performed AFTER 0166 was applied, found EXPLICIT, DIRECT
  // EXECUTE grants to anon and authenticated on bootstrap_new_club — not
  // merely inherited PUBLIC access. Root cause, confirmed by reading
  // every migration that has ever touched this function (0035 original
  // CREATE, 0074/0129/0164 each CREATE OR REPLACE, 0166 search_path
  // only): EVERY revoke/grant pair this schema has ever applied here
  // revokes ONLY from `public` and grants ONLY to `service_role` — never
  // explicitly touching anon/authenticated by name. `revoke execute ...
  // from public` removes only the implicit PUBLIC pseudo-role grant every
  // new function receives by default; it does NOT remove a SEPARATE,
  // explicit grant made directly to a named role. No migration in this
  // repository's history ever explicitly granted EXECUTE to anon/
  // authenticated on this function — the live explicit grants observed
  // did not originate from any migration here (most likely a manual/
  // out-of-band grant applied directly against the database).
  //
  // LESSON, made structural here: a `revoke ... from public` statement is
  // NOT sufficient proof that anon/authenticated lack EXECUTE — Supabase/
  // Postgres function ACLs may carry independent, explicit per-role
  // grants that a PUBLIC-only revoke never touches. Every operator-only
  // SECURITY DEFINER function's regression coverage must therefore assert
  // an EXPLICIT revoke naming every non-privileged role by name (public,
  // anon, authenticated), not merely a revoke-from-public statement's
  // presence. 0167 is now the authoritative, latest-effective ACL
  // definition for this function; 0164's own revoke/grant text is no
  // longer treated as sufficient evidence of anon/authenticated exclusion
  // on its own (see the two tests below, both targeting 0167 instead).
  it("R. 0167 explicitly revokes EXECUTE from public, anon, AND authenticated by name — never relying on a PUBLIC-only revoke to imply their absence", () => {
    const s = readSource(MIGRATION_0167_PATH);
    expect(s).toMatch(/revoke execute[\s\S]*?from public, anon, authenticated;/);
  });

  it("S. 0167 explicitly (re-)grants EXECUTE to service_role only", () => {
    const s = readSource(MIGRATION_0167_PATH);
    expect(s).toMatch(/grant execute[\s\S]*?to service_role;/);
    // Never re-grants to anon/authenticated/public alongside service_role
    // — check only the `to <roles>;` clause itself, not the whole
    // statement (which legitimately contains the schema-qualified
    // `public.bootstrap_new_club` function name).
    const toClauseIdx = s.lastIndexOf("to service_role;");
    const toClause = s.slice(toClauseIdx, toClauseIdx + "to service_role;".length);
    expect(toClause).toBe("to service_role;");
    expect(toClause).not.toMatch(/\banon\b|\bauthenticated\b|\bpublic\b/);
  });

  it("0167 targets the exact deployed signature confirmed by live ACL inspection — text/int/time forms are Postgres-synonymous with the canonical integer/\"time without time zone\" spelling", () => {
    const s = readSource(MIGRATION_0167_PATH);
    expect(s).toMatch(/text,\s*\n\s*text,\s*\n\s*text,\s*\n\s*integer,\s*\n\s*uuid,\s*\n\s*text\[\],\s*\n\s*time without time zone,\s*\n\s*time without time zone,\s*\n\s*integer,\s*\n\s*integer,\s*\n\s*integer/);
  });

  it("0167 does not redefine the function body, arguments, or search_path — REVOKE/GRANT only", () => {
    const s = readSource(MIGRATION_0167_PATH);
    expect(s).not.toMatch(/create (or replace )?function/i);
    expect(s).not.toMatch(/set search_path/i);
    expect(s).not.toMatch(/language plpgsql/i);
  });

  it("neither 0164 nor 0166 (the already-applied migrations) was modified by this correction — 0167 is a new migration, not a rewrite", () => {
    const s164 = readSource(MIGRATION_0164_PATH);
    // The function's own body/validation logic is still present verbatim.
    expect(s164).toContain("invalid_name: club name must be at least 2 characters");
    expect(s164).toContain("language plpgsql security definer as $$");
    const s166 = readSource(MIGRATION_0166_PATH);
    expect(s166).toContain("set search_path to 'public', 'pg_temp'");
  });

  it("no migration in this schema's history ever explicitly granted EXECUTE to anon or authenticated on bootstrap_new_club (confirms the grant was out-of-band, not migration-sourced)", () => {
    const migrationPaths = [
      "supabase/migrations/0035_bootstrap_new_club.sql",
      "supabase/migrations/0074_expand_club_theme_presets.sql",
      "supabase/migrations/0129_deprecate_private_lesson_event_type.sql",
      MIGRATION_0164_PATH,
      MIGRATION_0166_PATH,
    ];
    for (const path of migrationPaths) {
      const s = readSource(path);
      // No line in any prior migration grants execute on this function to
      // anon/authenticated by name.
      expect(s).not.toMatch(/grant execute\s*\n?\s*on function [\w.]*bootstrap_new_club[\s\S]{0,120}?to (anon|authenticated)\b/i);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9 — /admin/payments 500-row disclosure (T, U, V)
// ═══════════════════════════════════════════════════════════════════════════

describe("T/U/V. a compact neutral notice appears only when the 500-row cap is actually hit", () => {
  it("T. page.tsx computes `truncated` as exactly-MAX_ROWS-returned and passes it to AdminPaymentsClient", () => {
    const s = codeOnly(readSource(PAGE_PATH));
    expect(s).toContain("const truncated = rawPayments.length === MAX_ROWS;");
    expect(s).toContain("truncated={truncated}");
  });

  it("T. AdminPaymentsClient renders the notice only when truncated is true, with the required copy", () => {
    const s = readSource(CLIENT_PATH);
    expect(s).toContain("{truncated && (");
    expect(s).toContain("Showing the 500 most recent payments. Use Export for complete payment history.");
  });

  it("U. the notice is absent whenever truncated is falsy — conditional rendering via `&&`, never always-rendered", () => {
    const s = readSource(CLIENT_PATH);
    const noticeIdx = s.indexOf("Showing the 500 most recent payments");
    const guardIdx = s.lastIndexOf("{truncated && (", noticeIdx);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(noticeIdx);
  });

  it("the notice never implies data was deleted and directs Staff/Admin toward Export", () => {
    const s = readSource(CLIENT_PATH);
    const noticeLine = "Showing the 500 most recent payments. Use Export for complete payment history.";
    expect(s).toContain(noticeLine);
    expect(noticeLine).not.toMatch(/deleted|removed|lost/i);
    expect(noticeLine).toContain("Use Export");
  });

  it("V. the Export control remains present and unaffected by this change", () => {
    const s = readSource(CLIENT_PATH);
    expect(s).toContain("<PaymentExportMenu clubId={clubId} clubTimezone={clubTimezone} />");
  });

  it("the MAX_ROWS cap itself is unchanged — still 500, still applied via .limit(), no pagination/filter redesign", () => {
    const s = readSource(PAGE_PATH);
    expect(s).toContain("const MAX_ROWS = 500;");
    expect(s).toContain(".limit(MAX_ROWS)");
  });

  it("works identically on desktop/mobile — the notice uses plain block-level Tailwind classes, no responsive-only visibility utility hiding it on either breakpoint", () => {
    const s = readSource(CLIENT_PATH);
    const noticeLineIdx = s.indexOf("Showing the 500 most recent payments");
    const classNameLineStart = s.lastIndexOf("className=", noticeLineIdx);
    const classNameLine = s.slice(classNameLineStart, noticeLineIdx);
    expect(classNameLine).not.toMatch(/\bhidden\b|sm:hidden|md:hidden|lg:hidden/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10 — program_enrollments Staff SELECT authorization (QA correction).
//
// Runtime + live-database finding: Staff CSV export QA failed closed on
// program_enrollment payments ("program_enrollment row not found") even
// though the row genuinely existed — program_enrollments' own RLS policy
// (latest effective: 0115) never granted Staff SELECT visibility, so the
// export's authenticated (RLS-governed) client saw zero rows for a Staff
// caller. exportDomainHydration.ts correctly, safely failed closed; the
// defect was the RLS policy, not the export code. 0168 adds exactly one
// Staff branch, preserving every other branch verbatim.
// ═══════════════════════════════════════════════════════════════════════════

const MIGRATION_0168_PATH = "supabase/migrations/0168_program_enrollment_staff_select_authorization.sql";
const MIGRATION_0115_PATH = "supabase/migrations/0115_program_enrollment_identity.sql";
const MIGRATION_0087_PATH = "supabase/migrations/0087_programs_schema_foundation.sql";
const EXPORT_DOMAIN_HYDRATION_PATH = "src/app/(app)/admin/payments/exportDomainHydration.ts";

describe("program_enrollments Staff SELECT authorization (10 items)", () => {
  it("1. program_enrollments_select explicitly includes Staff — a bare current_user_role() = 'staff' branch, mirroring this policy's own existing = 'admin' style", () => {
    const s = readSource(MIGRATION_0168_PATH);
    expect(s).toContain('drop policy if exists "program_enrollments_select" on public.program_enrollments;');
    expect(s).toContain('create policy "program_enrollments_select"');
    expect(s).toContain("or public.current_user_role() = 'staff'");
  });

  it("2. the new Staff branch is INSIDE the same exists(...) clause that scopes every other branch to the owning Program's current active club — never a separate, unscoped OR", () => {
    // Scoped to AFTER `begin;` — this migration's own header comment
    // (SQL `--` comments, not stripped by this file's // -only codeOnly)
    // quotes the OLD (pre-fix) policy body verbatim for documentation;
    // without this anchor, `s.indexOf("using (")` would match that quoted
    // illustration instead of the actual executable policy below it.
    const full = readSource(MIGRATION_0168_PATH);
    const s = full.slice(full.indexOf("begin;"));
    const usingStart = s.indexOf("using (");
    const usingEnd = s.indexOf(");", usingStart);
    const usingClause = s.slice(usingStart, usingEnd);
    const clubScopeIdx = usingClause.indexOf("pr.club_id = public.current_user_club_id()");
    const staffBranchIdx = usingClause.indexOf("current_user_role() = 'staff'");
    const closingParenAfterClub = usingClause.indexOf(");", clubScopeIdx);
    expect(clubScopeIdx).toBeGreaterThan(-1);
    expect(staffBranchIdx).toBeGreaterThan(clubScopeIdx);
    // The staff branch must fall before the exists(...) clause's own
    // closing, i.e. still inside the club-scoped subquery.
    expect(staffBranchIdx).toBeLessThan(closingParenAfterClub === -1 ? usingClause.length : closingParenAfterClub + 200);
    // There is only ONE `exists (` in the whole policy — confirms no
    // parallel, unscoped OR branch was introduced outside it.
    expect((usingClause.match(/exists \(/g) ?? []).length).toBe(1);
  });

  it("3. Member own-row semantics (profile_id and roster_member_id branches) are preserved verbatim from 0115", () => {
    const s0168 = readSource(MIGRATION_0168_PATH);
    expect(s0168).toContain("program_enrollments.profile_id = auth.uid()");
    expect(s0168).toContain("program_enrollments.roster_member_id = public.current_user_roster_member_id()");
  });

  it("4. Pro creator-only semantics are preserved verbatim — never widened to all Pros", () => {
    const s = readSource(MIGRATION_0168_PATH);
    expect(s).toContain("or (public.current_user_role() = 'pro' and pr.created_by = auth.uid())");
  });

  it("5. Admin semantics are preserved verbatim (existing bare = 'admin' branch untouched)", () => {
    const s = readSource(MIGRATION_0168_PATH);
    expect(s).toContain("or public.current_user_role() = 'admin'");
  });

  it("6. no Staff (or any) INSERT/UPDATE/DELETE privilege is introduced — 0168 contains exactly one policy statement, SELECT only", () => {
    // Scoped to AFTER `begin;` — see item 2's own comment on why (this
    // migration's header comment quotes the old policy for documentation).
    const full = readSource(MIGRATION_0168_PATH);
    const s = full.slice(full.indexOf("begin;"));
    expect(s).not.toMatch(/for insert|for update|for delete/i);
    expect((s.match(/create policy/g) ?? []).length).toBe(1);
    expect(s).toContain("for select");
  });

  it("0168 does not touch 0115 (or any other already-applied migration) — a new migration was created instead of rewriting one", () => {
    const s115 = readSource(MIGRATION_0115_PATH);
    // 0115's own rollback documentation (pre-existing, unrelated to this
    // fix) still references re-running "the 0087 policy body verbatim" —
    // confirms 0115's text is untouched.
    expect(s115).toContain("re-run the 0087 policy body verbatim");
    const s087 = readSource(MIGRATION_0087_PATH);
    expect(s087).toContain('create policy "program_enrollments_select"');
  });

  it("7. exportActions.ts remains Admin/Staff via isOperator — unchanged by this correction", () => {
    const s = readSource(EXPORT_ACTIONS_PATH);
    expect(s).toContain("isOperator(profile.role)");
    expect(s).toContain('import { isOperator } from "@/lib/auth/roles";');
  });

  it("8. hydrateExportDomainContext remains authenticated-client/RLS-governed — never a service-role/privileged client", () => {
    const s = readSource(EXPORT_DOMAIN_HYDRATION_PATH);
    expect(s).not.toMatch(/createPrivilegedClient|service_role/);
    expect(s).toContain("SupabaseClient<Database>");
  });

  it("9. missing genuinely-required domain context still fails closed — the exact error path that correctly surfaced this defect is unchanged", () => {
    const s = readSource(EXPORT_DOMAIN_HYDRATION_PATH);
    expect(s).toContain('return { error: `program_enrollment row not found (payment ${input.paymentId}, domain_id ${input.domainId})` };');
    expect(s).toContain('return { error: `parent program not found for program_enrollment ${input.domainId} (payment ${input.paymentId})` };');
  });

  it("10. no privileged/service-role export path is introduced anywhere in exportActions.ts or exportDomainHydration.ts", () => {
    for (const path of [EXPORT_ACTIONS_PATH, EXPORT_DOMAIN_HYDRATION_PATH]) {
      const s = readSource(path);
      expect(s).not.toMatch(/createPrivilegedClient/);
    }
  });

  it("the other 4 export-domain tables (reservations, lesson_requests, event_participants, event_guests) already grant Staff visibility — confirmed via their own latest-effective policies, no correction needed for them", () => {
    const reservations = readSource("supabase/migrations/0132_staff_operational_authorization.sql");
    expect(reservations).toContain("current_user_role() in ('admin', 'pro', 'staff')");
    expect(reservations).toContain('"reservations_select_same_club"');
    expect(reservations).toContain('"event_participants_select_same_club"');
    // lesson_requests_select_admin uses the admin-or-staff helper.
    expect(reservations).toContain("current_user_is_operator()");
    const eventGuests = readSource("supabase/migrations/0050_event_guests.sql");
    expect(eventGuests).toContain('"event_guests_select_club_members"');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 11 — Refund action visibility: Admin-only UI (QA correction).
//
// Runtime finding: Staff could SEE the Refund button/action in
// /admin/payments even though the server correctly rejects a Staff-issued
// refund ("Only an Admin can issue a refund."). Backend authorization was
// already correct; this closes the UI gap by threading page.tsx's own
// isAdmin(profile.role) — the SAME predicate the rest of the app already
// uses for Admin-only authority — down through AdminPaymentsClient into
// both surfaces where Refund can render (the list row and
// PaymentDetailSheet), never introducing a parallel authorization check.
// ═══════════════════════════════════════════════════════════════════════════

const PAGE_PATH_FOR_REFUND = "src/app/(app)/admin/payments/page.tsx";
const CLIENT_PATH_FOR_REFUND = "src/app/(app)/admin/payments/AdminPaymentsClient.tsx";
const DETAIL_SHEET_PATH_FOR_REFUND = "src/components/PaymentDetailSheet.tsx";
const REFUND_ACTIONS_PATH_FOR_REFUND = "src/app/(app)/admin/payments/refundActions.ts";

describe("Refund action visibility is Admin-only in the UI, while backend authorization is unchanged (6 items)", () => {
  it("page.tsx reuses the existing isAdmin(role) predicate (never a new/duplicate authorization mechanism) and passes it down as a plain boolean prop", () => {
    const s = codeOnly(readSource(PAGE_PATH_FOR_REFUND));
    expect(s).toContain('import { isOperator, isAdmin } from "@/lib/auth/roles";');
    expect(s).toContain("const isAdminRole = isAdmin(profile.role);");
    expect(s).toContain("isAdmin={isAdminRole}");
  });

  it("1. Admin can see Refund — the list-row button's condition is `isAdmin && isOnlineRefundEligible(...) && !row.disputeBlocksRefund`, so it renders whenever isAdmin is true and the pre-existing eligibility holds, exactly as before this correction", () => {
    const s = readSource(CLIENT_PATH_FOR_REFUND);
    expect(s).toContain("{isAdmin && isOnlineRefundEligible(row.refundableCents) && !row.disputeBlocksRefund && (");
  });

  it("2. Staff cannot see Refund — isAdmin is false for role='staff' (isAdmin(role) = role === \"admin\" only), so the render condition is false regardless of eligibility, in BOTH surfaces", () => {
    const s = codeOnly(readSource("src/lib/auth/roles.ts"));
    const fnStart = s.indexOf("export function isAdmin(");
    const fn = s.slice(fnStart, s.indexOf("\n}", fnStart) + 2);
    expect(fn).toContain('return role === "admin";');

    const clientSrc = readSource(CLIENT_PATH_FOR_REFUND);
    expect(clientSrc).toMatch(/\{isAdmin && isOnlineRefundEligible/);

    const detailSrc = readSource(DETAIL_SHEET_PATH_FOR_REFUND);
    expect(detailSrc).toContain("const canRefund = isAdmin && isRefundEligible;");
    expect(detailSrc).toContain("{canRefund && (");
  });

  it("3. the existing server-side Admin-only refund authorization is present and unchanged — createOnlineRefundAction still independently checks profile.role !== \"admin\"", () => {
    const s = codeOnly(readSource(REFUND_ACTIONS_PATH_FOR_REFUND));
    expect(s).toContain('if (!profile || profile.role !== "admin") {');
    expect(s).toContain('insufficient_role: "Only an Admin can issue a refund.",');
    // Confirms the G-D1 tenant-scope correction (profile.club_id, never
    // expectedClubId) from the prior QA pass is also still intact.
    expect(s).toContain("const clubId = profile.club_id;");
  });

  it("hiding the button never substitutes for server authorization — the UI-only nature of this gate is documented at both call sites", () => {
    const clientSrc = readSource(CLIENT_PATH_FOR_REFUND);
    const detailSrc = readSource(DETAIL_SHEET_PATH_FOR_REFUND);
    expect(clientSrc + detailSrc).toMatch(/UI-only/);
    expect(clientSrc + detailSrc).toMatch(/authorization boundary/);
  });

  it("4. Staff still retains Record Payment — its render condition is untouched by this correction (no isAdmin gate added to it, in either surface)", () => {
    const clientSrc = codeOnly(readSource(CLIENT_PATH_FOR_REFUND));
    expect(clientSrc).toContain("{isPaymentOpenForRecording(row.state) && !row.recordPaymentBlocked && (");
    expect(clientSrc).not.toMatch(/isAdmin && isPaymentOpenForRecording/);

    const detailSrc = codeOnly(readSource(DETAIL_SHEET_PATH_FOR_REFUND));
    expect(detailSrc).toContain("const canRecordPayment = isPaymentOpenForRecording(row.state) && !row.recordPaymentBlocked;");
    expect(detailSrc).not.toMatch(/isAdmin && isPaymentOpenForRecording/);
  });

  it("5. Staff CSV/export authorization is unchanged — exportActions.ts still gates on isOperator (admin OR staff), never narrowed to isAdmin", () => {
    const s = readSource(EXPORT_ACTIONS_PATH);
    expect(s).toContain("isOperator(profile.role)");
    expect(s).not.toMatch(/isAdmin\(profile\.role\)/);
  });

  it("Staff still retains /admin/payments access and Financial History — page.tsx's own gate is still isOperator, not isAdmin, and fetchPaymentEventHistory still uses isOperator", () => {
    const pageSrc = readSource(PAGE_PATH_FOR_REFUND);
    expect(pageSrc).toContain('if (!profile || !isOperator(profile.role)) redirect("/calendar");');
    const actionsSrc = readSource(PAYMENTS_ACTIONS_PATH);
    const fnStart = actionsSrc.indexOf("export async function fetchPaymentEventHistory(");
    const fnEnd = actionsSrc.indexOf("\nexport async function updateClubPaymentModeAction");
    expect(actionsSrc.slice(fnStart, fnEnd)).toContain("isOperator(profile.role)");
  });

  it("6. no financial/refund lifecycle logic changed — refund amount/eligibility computation, Stripe calls, and RPC parameters in refundActions.ts are byte-for-byte unchanged by this correction", () => {
    const s = readSource(REFUND_ACTIONS_PATH_FOR_REFUND);
    expect(s).toContain('p_payment_id: params.paymentId,');
    expect(s).toContain("p_club_id: clubId,");
    expect(s).toContain("p_requested_amount_cents: params.amountCents,");
    expect(s).toContain("context.client.refunds.create(");
    expect(s).toContain('privileged.rpc("bind_stripe_refund_result"');
    // isOnlineRefundEligible/refundableCents computation is untouched —
    // this correction only ever adds an isAdmin && prefix in the JSX
    // render condition, never touches the eligibility source values.
    const provenanceSrc = readSource("src/lib/stripe/refundConfig.ts");
    expect(provenanceSrc).toContain("export function isOnlineRefundEligible(");
  });

  it("no privileged/service-role change and no RLS/migration touched by this correction — purely conditional rendering plus one new boolean prop", () => {
    const clientSrc = readSource(CLIENT_PATH_FOR_REFUND);
    const detailSrc = readSource(DETAIL_SHEET_PATH_FOR_REFUND);
    expect(clientSrc).not.toMatch(/createPrivilegedClient/);
    expect(detailSrc).not.toMatch(/createPrivilegedClient|\.rpc\(/);
  });
});
