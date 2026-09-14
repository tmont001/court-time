import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 38B final notification polish — regression coverage for migration
// 0183 (Admin-notified-on-submission) and the /admin/payments deep-link
// wiring that consumes it. Source-inspection style, matching this
// repository's established convention for migration SQL (see
// staffRefundRequests.regression.test.ts's own header comment for why:
// 0181/0182 are covered the identical way, reading the real applied SQL
// text rather than executing it against a live Postgres instance).
//
// 0183 is NOT applied to Supabase as of this checkpoint (per the task's
// own explicit "Do not apply 0183" instruction) — these tests validate the
// migration FILE's content exactly as staffRefundRequests.regression.test.ts
// already does for the not-yet-applied 0182 at the time it was written.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

const MIGRATION_0181_PATH = "supabase/migrations/0181_staff_refund_requests.sql";
const MIGRATION_0183_PATH = "supabase/migrations/0183_refund_request_admin_notification.sql";
const CLIENT_PATH = "src/app/(app)/admin/payments/AdminPaymentsClient.tsx";
const NOTIFICATION_TARGETS_PATH = "src/lib/notification-targets.ts";

function migrationSql(): string {
  return codeOnly(readSource(MIGRATION_0183_PATH));
}

// Isolates create_refund_request's own function body up to its terminating
// `$$;` — scoping every function-specific assertion below to exactly that
// function, never spilling into the notifications_kind_check section below
// it in the same file.
function createRefundRequestBody(): string {
  const sql = migrationSql();
  const start = sql.indexOf("create or replace function public.create_refund_request(");
  expect(start).toBeGreaterThan(-1);
  const end = sql.indexOf("\n$$;", start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end + "\n$$;".length);
}

// ═══════════════════════════════════════════════════════════════════════════
// 0181/0182 are untouched
// ═══════════════════════════════════════════════════════════════════════════

describe("0181/0182 are not modified by this migration", () => {
  it("0183 exists as its own new file — 0181/0182 are not edited", () => {
    expect(() => readSource(MIGRATION_0183_PATH)).not.toThrow();
    // 0181's own create_refund_request body still contains its original
    // "no Admin notification" comment, verbatim, untouched by 0183 (which
    // supersedes it via a NEW create or replace, exactly like 0182 layered
    // a correction over 0181 without editing it).
    const original0181 = readSource(MIGRATION_0181_PATH);
    expect(original0181).toContain("No Admin notification/email on submission (locked decision)");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Atomicity — one function call, one transaction
// ═══════════════════════════════════════════════════════════════════════════

describe("atomicity — the notification insert lives inside the SAME create_refund_request call as the request row", () => {
  it("0183's own SQL is wrapped in a single begin;/commit; transaction block", () => {
    const sql = migrationSql();
    expect(sql).toMatch(/^begin;/m);
    expect(sql).toMatch(/^commit;/m);
  });

  it("the notifications insert appears INSIDE create_refund_request's own function body, after the payment_refund_requests insert and its audit_log entry — never as a separate top-level statement outside the function", () => {
    const fn = createRefundRequestBody();
    const requestInsertIdx = fn.indexOf("insert into public.payment_refund_requests (");
    const auditIdx = fn.indexOf("insert into public.audit_log");
    const notifyIdx = fn.indexOf("insert into public.notifications");
    expect(requestInsertIdx).toBeGreaterThan(-1);
    expect(auditIdx).toBeGreaterThan(requestInsertIdx);
    expect(notifyIdx).toBeGreaterThan(auditIdx);
    // Still inside the function body (before its own closing $$;).
    expect(fn.indexOf("\n$$;")).toBeGreaterThan(notifyIdx);
  });

  it("create_refund_request preserves its original signature/return type exactly — same name, same 4 params, same public.payment_refund_requests return type", () => {
    const fn = createRefundRequestBody();
    expect(fn).toContain(
      "create or replace function public.create_refund_request(\n" +
      "  p_payment_id   uuid,\n" +
      "  p_amount_cents integer,\n" +
      "  p_reason       text,\n" +
      "  p_notes        text default null\n" +
      ")\n" +
      "returns public.payment_refund_requests",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Recipient logic — same-club, active, Admin only; no duplicates; not the
// requester
// ═══════════════════════════════════════════════════════════════════════════

describe("recipient selection — current club membership truth, Admin only, same club", () => {
  it("selects from club_memberships directly — never profiles.role, never profiles.active_club_id", () => {
    const fn = createRefundRequestBody();
    const notifyIdx = fn.indexOf("insert into public.notifications");
    const notifyBlock = fn.slice(notifyIdx);
    expect(notifyBlock).toContain("from public.club_memberships cm");
    expect(notifyBlock).not.toMatch(/profiles\.role|profiles\.active_club_id|p\.active_club_id/);
  });

  it("requires role = 'admin' — the exact same predicate that excludes Staff/Pro/Member", () => {
    const fn = createRefundRequestBody();
    const notifyBlock = fn.slice(fn.indexOf("insert into public.notifications"));
    expect(notifyBlock).toContain("and cm.role        = 'admin'");
  });

  it("requires status = 'active' and removed_at is null — the SAME predicate current_user_club_id()'s own _current_user_active_membership() and send_announcement_v2 (0177) already use for 'current membership truth'", () => {
    const fn = createRefundRequestBody();
    const notifyBlock = fn.slice(fn.indexOf("insert into public.notifications"));
    expect(notifyBlock).toContain("and cm.status      = 'active'");
    expect(notifyBlock).toContain("and cm.removed_at is null");
  });

  it("scopes to the SAME club as the request — cm.club_id = v_club_id, the server-derived club id, never a client-supplied value", () => {
    const fn = createRefundRequestBody();
    const notifyBlock = fn.slice(fn.indexOf("insert into public.notifications"));
    expect(notifyBlock).toContain("where cm.club_id    = v_club_id");
  });

  it("excludes the requesting Staff member (auth.uid()) explicitly, in addition to role = 'admin' already excluding them structurally", () => {
    const fn = createRefundRequestBody();
    const notifyBlock = fn.slice(fn.indexOf("insert into public.notifications"));
    expect(notifyBlock).toContain("and cm.user_id    <> auth.uid()");
  });

  it("no DISTINCT/dedup logic is needed or present — club_memberships' own unique(user_id, club_id) constraint (0081) makes duplicate recipients structurally impossible from this query", () => {
    const fn = createRefundRequestBody();
    const notifyBlock = fn.slice(fn.indexOf("insert into public.notifications"), fn.indexOf("insert into public.notifications") + 700);
    expect(notifyBlock).not.toMatch(/distinct/i);
  });

  it("does NOT join notification_preferences — this is an in-app-only mandatory operational notification, same posture as refund_request_rejected/refund_request_completed (0181), never a preference-gated opt-in", () => {
    const fn = createRefundRequestBody();
    const notifyBlock = fn.slice(fn.indexOf("insert into public.notifications"), fn.indexOf("insert into public.notifications") + 700);
    expect(notifyBlock).not.toMatch(/notification_preferences/);
  });

  it("exactly one notification row is produced per matching club_memberships row (a plain INSERT...SELECT, one row in -> one row out, no fan-out/multiplication)", () => {
    const fn = createRefundRequestBody();
    const notifyBlock = fn.slice(fn.indexOf("insert into public.notifications"), fn.indexOf("insert into public.notifications") + 900);
    // A single, unjoined club_memberships source with no lateral join or
    // additional FROM item that could multiply rows.
    const fromCount = (notifyBlock.match(/\bfrom\s+public\./g) ?? []).length;
    expect(fromCount).toBe(1);
    expect(notifyBlock).not.toMatch(/\bjoin\b/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Metadata + notification content
// ═══════════════════════════════════════════════════════════════════════════

describe("notification content — kind, body, metadata", () => {
  it("kind is 'refund_request_submitted', body is 'Refund request received'", () => {
    const fn = createRefundRequestBody();
    const notifyBlock = fn.slice(fn.indexOf("insert into public.notifications"), fn.indexOf("insert into public.notifications") + 300);
    expect(notifyBlock).toContain("'refund_request_submitted',");
    expect(notifyBlock).toContain("'Refund request received',");
  });

  it("metadata carries request_id, payment_id, requested_by, requested_amount_cents, and target_path", () => {
    const fn = createRefundRequestBody();
    const notifyBlock = fn.slice(fn.indexOf("insert into public.notifications"), fn.indexOf("insert into public.notifications") + 900);
    expect(notifyBlock).toContain("'request_id',             v_result.id,");
    expect(notifyBlock).toContain("'payment_id',             v_result.payment_id,");
    expect(notifyBlock).toContain("'requested_by',           v_result.requested_by,");
    expect(notifyBlock).toContain("'requested_amount_cents', v_result.requested_amount_cents,");
    expect(notifyBlock).toContain("'target_path',            '/admin/payments?refundRequest=' || v_result.id::text");
  });

  it("target_path matches the EXACT deep-link shape /admin/payments?refundRequest=<request_id> — no standalone refund-request page", () => {
    const fn = createRefundRequestBody();
    expect(fn).toContain("'/admin/payments?refundRequest=' || v_result.id::text");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// notifications_kind_check widened correctly
// ═══════════════════════════════════════════════════════════════════════════

describe("notifications_kind_check — adds refund_request_submitted as the 20th kind", () => {
  it("drops and re-adds the constraint with all 19 prior kinds preserved plus the new one", () => {
    const sql = migrationSql();
    const idx = sql.indexOf("add constraint notifications_kind_check");
    expect(idx).toBeGreaterThan(-1);
    const block = sql.slice(idx, sql.indexOf(");", idx) + 2);
    for (const kind of [
      "reservation_confirmed", "reservation_cancelled_by_admin", "reservation_cancelled_by_member",
      "reservation_rescheduled", "event_cancelled", "event_joined", "event_updated",
      "waitlist_promoted", "waitlist_offer", "announcement",
      "lesson_request_received", "lesson_request_proposed", "lesson_request_confirmed",
      "lesson_request_declined", "lesson_cancelled", "lesson_provider_reassigned",
      "lesson_admin_requested", "refund_request_rejected", "refund_request_completed",
      "refund_request_submitted",
    ]) {
      expect(block).toContain(`'${kind}'`);
    }
  });

  it("is not added to notification_preferences_kind_check — in-app only, nothing to opt out of, same posture as refund_request_rejected/completed", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/notification_preferences_kind_check/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Existing reject/completed notifications are unchanged
// ═══════════════════════════════════════════════════════════════════════════

describe("existing refund_request_rejected/refund_request_completed notifications are unchanged", () => {
  it("0183 never redefines reject_refund_request or _complete_refund_request_for_attempt — only create_refund_request and notifications_kind_check are touched", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/create or replace function public\.reject_refund_request/);
    expect(sql).not.toMatch(/create or replace function public\._complete_refund_request_for_attempt/);
  });

  it("0181's own refund_request_rejected/refund_request_completed notification inserts remain word-for-word identical to their original text", () => {
    const original = codeOnly(readSource(MIGRATION_0181_PATH));
    expect(original).toContain(
      "v_club_id, v_request.requested_by, 'refund_request_rejected',\n" +
      "    'Your refund request was not approved.',",
    );
    expect(original).toContain("'refund_request_completed',\n    'Your refund request has been approved and the refund is complete.',");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Deep link — resolveNotificationTarget structured mapping
// ═══════════════════════════════════════════════════════════════════════════

describe("deep link — refund_request_submitted resolves via the structured payment_refund_request domain", () => {
  it("notification-targets.ts maps refund_request_submitted to { domain: 'payment_refund_request', idKey: 'request_id' }", () => {
    const src = readSource(NOTIFICATION_TARGETS_PATH);
    expect(src).toContain('refund_request_submitted:        { domain: "payment_refund_request", idKey: "request_id" },');
  });

  it("buildStructuredPath's payment_refund_request case returns EXACTLY /admin/payments?refundRequest=<id>", () => {
    const src = readSource(NOTIFICATION_TARGETS_PATH);
    const idx = src.indexOf('case "payment_refund_request":');
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 700);
    expect(block).toContain("return `/admin/payments?refundRequest=${encodedId}`;");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// /admin/payments — ?refundRequest=<id> auto-opens Review
// ═══════════════════════════════════════════════════════════════════════════

describe("AdminPaymentsClient — ?refundRequest=<id> deep link auto-opens ReviewRefundRequestSheet", () => {
  it("reads the refundRequest param via useSearchParams, mirroring LessonsTab's own ?lessonId= auto-open pattern (Phase 30G/36) — no new routing framework", () => {
    const src = readSource(CLIENT_PATH);
    expect(src).toContain('import { useRouter, usePathname, useSearchParams } from "next/navigation";');
    expect(src).toContain('const refundRequestParam = searchParams.get("refundRequest");');
  });

  it("matches against `rows` — the caller's own already-scoped list — never an independent/unscoped lookup by id", () => {
    const src = readSource(CLIENT_PATH);
    const effectIdx = src.indexOf("useEffect(() => {\n    if (!refundRequestParam) return;");
    expect(effectIdx).toBeGreaterThan(-1);
    const effectBlock = src.slice(effectIdx, effectIdx + 700);
    expect(effectBlock).toContain("rows.find(r => r.pendingRefundRequest?.requestId === refundRequestParam)");
  });

  it("requires isAdmin in addition to a match — a Staff viewer (or any non-Admin) never gets the sheet auto-opened even if a match exists", () => {
    const src = readSource(CLIENT_PATH);
    const effectIdx = src.indexOf("useEffect(() => {\n    if (!refundRequestParam) return;");
    const effectBlock = src.slice(effectIdx, effectIdx + 700);
    expect(effectBlock).toContain("if (!match || !isAdmin) {");
  });

  it("opens via the SAME setReviewTarget state ReviewRefundRequestSheet's normal Review button already uses — no parallel/duplicate sheet-opening mechanism", () => {
    const src = readSource(CLIENT_PATH);
    const effectIdx = src.indexOf("useEffect(() => {\n    if (!refundRequestParam) return;");
    const effectBlock = src.slice(effectIdx, effectIdx + 900);
    expect(effectBlock).toContain("setReviewTarget(match);");
  });

  it("a resolved/missing/unauthorized request clears the param and does nothing else — never a crash, never a stale fake review target", () => {
    const src = readSource(CLIENT_PATH);
    const clearFnStart = src.indexOf("function clearRefundRequestParam()");
    expect(clearFnStart).toBeGreaterThan(-1);
    const clearFnEnd = src.indexOf("\n  }", clearFnStart);
    const clearFn = src.slice(clearFnStart, clearFnEnd);
    expect(clearFn).toContain('params.delete("refundRequest");');
    expect(clearFn).toContain("router.replace(");
    // The no-match/non-admin branch calls exactly this function and
    // returns — no fabricated row is ever constructed.
    const effectIdx = src.indexOf("useEffect(() => {\n    if (!refundRequestParam) return;");
    const effectBlock = src.slice(effectIdx, effectIdx + 900);
    expect(effectBlock).toContain("clearRefundRequestParam();\n      return;");
  });

  it("fires once per distinct refundRequest value via a ref, mirroring LessonsTab's own autoOpenAttemptRef guard — never re-fights a user who has since closed the sheet on their own", () => {
    const src = readSource(CLIENT_PATH);
    expect(src).toContain("const autoOpenReviewAttemptRef = useRef<string | null>(null);");
    expect(src).toContain("if (autoOpenReviewAttemptRef.current === refundRequestParam) return;");
    expect(src).toContain("autoOpenReviewAttemptRef.current = refundRequestParam;");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Correction pass — fail-closed interaction between the pending-request
// read failure and the ?refundRequest= deep link. row.pendingRefundRequest
// is untrustworthy for every row while refundRequestReadFailed is true, so
// "no match" during a read failure must NEVER be treated as "resolved/
// missing" — that would silently clear a deep link to a request that may
// still genuinely exist.
// ═══════════════════════════════════════════════════════════════════════════

describe("AdminPaymentsClient — ?refundRequest= deep link fails closed when the pending-request read failed", () => {
  it("1. a read failure preserves ?refundRequest= — the effect returns immediately on refundRequestReadFailed, before ever reaching clearRefundRequestParam()", () => {
    const src = readSource(CLIENT_PATH);
    const effectIdx = src.indexOf("useEffect(() => {\n    if (!refundRequestParam) return;");
    expect(effectIdx).toBeGreaterThan(-1);
    const refIdx = src.indexOf("if (autoOpenReviewAttemptRef.current === refundRequestParam) return;", effectIdx);
    const failIdx = src.indexOf("if (refundRequestReadFailed) return;", refIdx);
    const clearCallIdx = src.indexOf("clearRefundRequestParam();", effectIdx);
    const matchIdx = src.indexOf("rows.find(r => r.pendingRefundRequest?.requestId === refundRequestParam)", effectIdx);
    // The fail-closed guard sits BEFORE both the match lookup and the
    // only clearRefundRequestParam() call site inside this effect —
    // structurally guaranteeing neither runs while the read failed.
    expect(failIdx).toBeGreaterThan(refIdx);
    expect(clearCallIdx).toBeGreaterThan(failIdx);
    expect(matchIdx).toBeGreaterThan(failIdx);
  });

  it("2. a read failure does not setReviewTarget — the same early return sits before setReviewTarget(match) too", () => {
    const src = readSource(CLIENT_PATH);
    const effectIdx = src.indexOf("useEffect(() => {\n    if (!refundRequestParam) return;");
    const failIdx = src.indexOf("if (refundRequestReadFailed) return;", effectIdx);
    const setReviewIdx = src.indexOf("setReviewTarget(match);", effectIdx);
    expect(failIdx).toBeGreaterThan(-1);
    expect(setReviewIdx).toBeGreaterThan(failIdx);
  });

  it("a read failure does not even mark the param 'attempted' — the ref write (autoOpenReviewAttemptRef.current = refundRequestParam) sits AFTER the fail-closed guard, so a later successful read for the SAME param can still auto-open on retry", () => {
    const src = readSource(CLIENT_PATH);
    const effectIdx = src.indexOf("useEffect(() => {\n    if (!refundRequestParam) return;");
    const failIdx = src.indexOf("if (refundRequestReadFailed) return;", effectIdx);
    const refWriteIdx = src.indexOf("autoOpenReviewAttemptRef.current = refundRequestParam;", effectIdx);
    expect(failIdx).toBeGreaterThan(-1);
    expect(refWriteIdx).toBeGreaterThan(failIdx);
  });

  it("3. successful read + matching Admin request opens Review — with refundRequestReadFailed false, a match plus isAdmin still reaches setReviewTarget exactly as before this correction", () => {
    const src = readSource(CLIENT_PATH);
    const effectIdx = src.indexOf("useEffect(() => {\n    if (!refundRequestParam) return;");
    const effectBlock = src.slice(effectIdx, effectIdx + 900);
    expect(effectBlock).toContain("if (refundRequestReadFailed) return;");
    expect(effectBlock).toContain("const match = rows.find(r => r.pendingRefundRequest?.requestId === refundRequestParam);");
    expect(effectBlock).toContain("if (!match || !isAdmin) {");
    expect(effectBlock).toContain("setReviewTarget(match);");
  });

  it("4. successful read + missing request clears the param — the !match branch (reached only once refundRequestReadFailed is false) still calls clearRefundRequestParam()", () => {
    const src = readSource(CLIENT_PATH);
    const effectIdx = src.indexOf("useEffect(() => {\n    if (!refundRequestParam) return;");
    const failIdx = src.indexOf("if (refundRequestReadFailed) return;", effectIdx);
    const notMatchIdx = src.indexOf("if (!match || !isAdmin) {", effectIdx);
    const clearCallIdx = src.indexOf("clearRefundRequestParam();\n      return;", effectIdx);
    expect(notMatchIdx).toBeGreaterThan(failIdx);
    expect(clearCallIdx).toBeGreaterThan(notMatchIdx);
  });

  it("5. non-Admin still clears the param — the SAME !match || !isAdmin branch covers a non-Admin viewer regardless of whether a row happens to match", () => {
    const src = readSource(CLIENT_PATH);
    const effectIdx = src.indexOf("useEffect(() => {\n    if (!refundRequestParam) return;");
    const effectBlock = src.slice(effectIdx, effectIdx + 900);
    // A single combined condition — !isAdmin alone is sufficient to reach
    // clearRefundRequestParam(), independent of `match`.
    expect(effectBlock).toContain("if (!match || !isAdmin) {");
  });

  it("refundRequestReadFailed is a dependency of the effect — so it re-runs (and can retry auto-opening the SAME param) the moment a failed read later succeeds, without needing a full remount", () => {
    const src = readSource(CLIENT_PATH);
    expect(src).toContain("}, [refundRequestParam, rows, isAdmin, refundRequestReadFailed]);");
  });
});
