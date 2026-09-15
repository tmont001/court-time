import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 41B completion — authoritative Member cancellation-policy preview
// (0187), the expected-state-guard wrapper RPCs, and the policy-aware
// confirmation copy that replaces the earlier state-neutral placeholder.
// Same source-inspection style as the rest of this suite (no jsdom/
// component-rendering harness in this repo — see staleCheckoutInvalidation
// .regression.test.ts's own header comment for why reading the real
// source is the honest guard here).

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !line.trim().startsWith("--") && !line.trim().startsWith("//"))
    .join("\n");
}

const MIGRATION_PATH = "supabase/migrations/0187_member_cancellation_policy_preview.sql";
const DETAIL_SHEET_PATH = "src/app/(app)/calendar/ReservationDetailSheet.tsx";
const LESSON_DETAIL_PATH = "src/app/(app)/lessons/LessonRequestDetail.tsx";
const ADMIN_PAYMENTS_CLIENT_PATH = "src/app/(app)/admin/payments/AdminPaymentsClient.tsx";
const CALENDAR_ACTIONS_PATH = "src/app/(app)/calendar/actions.ts";
const LESSONS_ACTIONS_PATH = "src/app/(app)/lessons/actions.ts";
const CALENDAR_SHELL_PATH = "src/app/(app)/calendar/CalendarShell.tsx";

function migrationSql(): string {
  return codeOnly(readSource(MIGRATION_PATH));
}

function functionBody(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  expect(start, `function public.${name} not found`).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf("\n$$;", start);
  expect(end, `closing $$; for public.${name} not found`).toBeGreaterThan(start);
  return sql.slice(start, end);
}

function cancelBlockSource(): string {
  const src = readSource(DETAIL_SHEET_PATH);
  const start = src.indexOf("{/* Cancel — member mode or admin mode.");
  const end = src.indexOf("</ResponsiveSheet>", start);
  return src.slice(start, end);
}

// ═══════════════════════════════════════════════════════════════════════════
// A. Migration structure
// ═══════════════════════════════════════════════════════════════════════════

describe("0187 — migration structure", () => {
  const sql = migrationSql();

  it("adds exactly four new functions — two previews, two confirmed wrappers", () => {
    const matches = migrationSql().match(/create or replace function public\.\w+/g) ?? [];
    const names = new Set(matches.map((m) => m.replace("create or replace function public.", "")));
    expect(names).toEqual(
      new Set([
        "preview_member_reservation_cancellation_policy",
        "preview_member_lesson_cancellation_policy",
        "cancel_member_reservation_confirmed",
        "cancel_member_lesson_confirmed",
      ]),
    );
  });

  it("does not redefine cancel_member_reservation, cancel_lesson, admin_cancel_reservation_v2, or any event/program RPC", () => {
    for (const name of ["cancel_member_reservation", "cancel_lesson", "admin_cancel_reservation_v2"]) {
      expect(sql).not.toMatch(new RegExp(`create or replace function public\\.${name}\\(`));
    }
    expect(sql).not.toMatch(/cancel_event|cancel_program|leave_event\b|leave_program\b/);
  });

  it("touches no payments/payment_events/payment_refund_requests table and no Stripe reference — read-only + delegating only", () => {
    expect(sql).not.toMatch(/insert into (public\.)?payment_events|update (public\.)?payments\b/i);
    expect(sql).not.toMatch(/stripe\.refunds|stripe\.checkout/i);
  });

  it("adds no new club_settings column and no auto-refund/auto-approve setting", () => {
    expect(sql).not.toMatch(/alter table\s+(public\.)?club_settings/i);
    expect(sql).not.toMatch(/auto_approve|auto_refund/i);
  });

  it("is wrapped in a single begin/commit transaction", () => {
    expect((sql.match(/^begin;/m) ?? []).length).toBe(1);
    expect((sql.match(/^commit;/m) ?? []).length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. Preview RPCs — reservation
// ═══════════════════════════════════════════════════════════════════════════

describe("preview_member_reservation_cancellation_policy", () => {
  const fn = () => functionBody(migrationSql(), "preview_member_reservation_cancellation_policy");

  it("delegates arithmetic ONLY to _evaluate_cancellation_policy — no duplicated boundary logic", () => {
    const body = fn();
    expect(body).toContain("from public._evaluate_cancellation_policy(");
    expect(body).not.toMatch(/make_interval|cutoff_at\s*:=/);
  });

  it("mirrors cancel_member_reservation's exact club/role/roster-aware-ownership resolution", () => {
    const body = fn();
    expect(body).toContain("if v_role is null or v_role not in ('member', 'pro') then");
    expect(body).toContain("or (v_roster_member_id is not null and roster_member_id = v_roster_member_id)");
    expect(body).toContain("if p_expected_club_id is distinct from v_club_id then raise exception 'stale_club_context'; end if;");
  });

  it("only allows an editable, confirmed member_booking reservation — same gate as cancel_member_reservation", () => {
    const body = fn();
    expect(body).toContain("if v_res.reason <> 'member_booking' then raise exception 'reservation_not_editable'; end if;");
    expect(body).toContain("if v_res.status <> 'confirmed' then raise exception 'reservation_not_editable'; end if;");
  });

  it("resolves cancellation_window_hours/cancellation_grace_minutes with the same 24h/5min defaulting as cancel_member_reservation", () => {
    const body = fn();
    expect(body).toContain("v_cancellation_window_hours  := 24;");
    expect(body).toContain("v_cancellation_grace_minutes := 5;");
    expect(body).toContain("v_cancellation_window_hours  := coalesce(v_cancellation_window_hours, 24);");
  });

  it("takes no row lock — read-only, nothing is mutated", () => {
    const body = fn();
    expect(body).not.toContain("for update");
  });

  it("returns only state/cutoff_at/within_grace — never a refund amount", () => {
    const body = fn();
    expect(body).toMatch(/returns table \(\s*\n\s*state\s+text,\s*\n\s*cutoff_at\s+timestamptz,\s*\n\s*within_grace boolean\s*\n\)/);
    expect(body).not.toMatch(/refundable|amount_cents|amount_due|amount_paid/i);
  });

  it("is granted to authenticated only, revoked from public/anon", () => {
    expect(migrationSql()).toMatch(
      /revoke execute on function public\.preview_member_reservation_cancellation_policy\(uuid, uuid\) from public, anon;\s*\n\s*grant\s+execute on function public\.preview_member_reservation_cancellation_policy\(uuid, uuid\) to authenticated;/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. Preview RPCs — lesson
// ═══════════════════════════════════════════════════════════════════════════

describe("preview_member_lesson_cancellation_policy", () => {
  const fn = () => functionBody(migrationSql(), "preview_member_lesson_cancellation_policy");

  it("delegates arithmetic ONLY to _evaluate_cancellation_policy", () => {
    const body = fn();
    expect(body).toContain("from public._evaluate_cancellation_policy(");
  });

  it("mirrors cancel_lesson's exact durable Member-identity resolution (history OR roster) — never role alone", () => {
    const body = fn();
    expect(body).toContain("v_is_member_by_history := v_request.member_id is not null and v_request.member_id = auth.uid();");
    expect(body).toContain("v_is_member_by_roster  := v_caller_roster_id is not null and v_request.roster_member_id = v_caller_roster_id;");
    expect(body).toContain("if not (v_is_member_by_history or v_is_member_by_roster) then");
    expect(body).toContain("raise exception 'not_authorised_to_cancel';");
  });

  it("mirrors cancel_lesson's exact effective-start-time resolution (linked reservation's own starts_at when a reschedule is in flight, else proposed_starts_at)", () => {
    const body = fn();
    expect(body).toContain("and reason  = 'pro_lesson'");
    expect(body).toContain("v_effective_starts_at := v_old_reservation.starts_at;");
    expect(body).toContain("v_effective_starts_at := v_request.proposed_starts_at;");
  });

  it("grace is hard-disabled — 0 minutes, null anchor — lessons can never preview 'grace'", () => {
    const body = fn();
    expect(body).toMatch(/_evaluate_cancellation_policy\(\s*\n\s*v_effective_starts_at,\s*\n\s*v_window_hours,\s*\n\s*0,\s*\n\s*null,\s*\n\s*now\(\)\s*\n\s*\)/);
  });

  it("takes no row lock", () => {
    const body = fn();
    expect(body).not.toContain("for update");
  });

  it("is granted to authenticated only", () => {
    expect(migrationSql()).toMatch(
      /revoke execute on function public\.preview_member_lesson_cancellation_policy\(uuid\) from public, anon;\s*\n\s*grant\s+execute on function public\.preview_member_lesson_cancellation_policy\(uuid\) to authenticated;/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D. Expected-state guard wrappers
// ═══════════════════════════════════════════════════════════════════════════

describe("cancel_member_reservation_confirmed — expected-state guard, correction pass (preview -> lock -> re-preview -> compare -> delegate)", () => {
  const fn = () => functionBody(migrationSql(), "cancel_member_reservation_confirmed");

  it("rejects an invalid/missing expected policy state before any evaluation", () => {
    const body = fn();
    expect(body).toContain("if p_expected_policy_state is null or p_expected_policy_state not in ('in_policy', 'grace', 'late') then");
    expect(body).toContain("raise exception 'invalid_arguments';");
  });

  it("step 1: authenticates/authorizes via an UNLOCKED preview call, result discarded (perform, not select into)", () => {
    const body = fn();
    expect(body).toMatch(/perform public\.preview_member_reservation_cancellation_policy\(p_reservation_id, p_expected_club_id\);/);
  });

  it("step 2: acquires FOR UPDATE on the reservation row, id+club scoped only — no ownership/reason/status predicate duplicated", () => {
    const body = fn();
    expect(body).toMatch(
      /perform 1 from public\.reservations\s*\n\s*where id = p_reservation_id and club_id = p_expected_club_id\s*\n\s*for update;/,
    );
  });

  it("step 3: acquires FOR SHARE (not FOR UPDATE) on that club's club_settings row, AFTER the reservation lock", () => {
    const body = fn();
    const reservationLockIdx = body.indexOf("from public.reservations\n   where id = p_reservation_id");
    const settingsLockMatch = body.match(
      /perform 1 from public\.club_settings\s*\n\s*where club_id = p_expected_club_id\s*\n\s*for share;/,
    );
    expect(settingsLockMatch, "club_settings FOR SHARE lock not found").toBeTruthy();
    expect(body.indexOf(settingsLockMatch![0])).toBeGreaterThan(reservationLockIdx);
  });

  it("step 4: performs a SECOND preview call AFTER BOTH locks (reservation + club_settings), and the comparison uses ONLY this second result", () => {
    const body = fn();
    const settingsLockIdx = body.indexOf("for share;");
    const secondPreviewIdx = body.indexOf("select state into v_final_state");
    const compareIdx = body.indexOf("if v_final_state is distinct from p_expected_policy_state then");
    expect(settingsLockIdx).toBeGreaterThan(-1);
    expect(secondPreviewIdx).toBeGreaterThan(settingsLockIdx);
    expect(compareIdx).toBeGreaterThan(secondPreviewIdx);
    // Only ONE variable ever feeds the comparison — no v_current_state
    // (the first draft's unlocked-only single-read variable) survives.
    expect(body).not.toMatch(/v_current_state/);
    expect((body.match(/preview_member_reservation_cancellation_policy\(/g) ?? []).length).toBe(2);
  });

  it("on a match, delegates to the existing cancel_member_reservation verbatim — no duplicated cancellation arithmetic/body", () => {
    const body = fn();
    expect(body).toContain("return public.cancel_member_reservation(p_reservation_id, p_expected_club_id);");
    expect(body).not.toMatch(/update reservations set|insert into audit_log|insert into notifications|_evaluate_cancellation_policy\(/);
  });

  it("is granted to authenticated only", () => {
    expect(migrationSql()).toMatch(
      /revoke execute on function public\.cancel_member_reservation_confirmed\(uuid, uuid, text\) from public, anon;\s*\n\s*grant\s+execute on function public\.cancel_member_reservation_confirmed\(uuid, uuid, text\) to authenticated;/,
    );
  });
});

describe("cancel_member_lesson_confirmed — expected-state guard, correction pass (preview -> lock lesson_request -> lock linked reservation -> re-preview -> compare -> delegate)", () => {
  const fn = () => functionBody(migrationSql(), "cancel_member_lesson_confirmed");

  it("only accepts in_policy/late — grace is not a reachable lesson preview result", () => {
    const body = fn();
    expect(body).toContain("if p_expected_policy_state is null or p_expected_policy_state not in ('in_policy', 'late') then");
  });

  it("step 1: authenticates via an UNLOCKED preview call, result discarded — no separate Member-identity check duplicated here", () => {
    const body = fn();
    expect(body).not.toMatch(/v_is_member_by_history|v_is_member_by_roster/);
    expect(body).toMatch(/perform public\.preview_member_lesson_cancellation_policy\(p_request_id\);/);
  });

  it("step 2: locks lesson_requests FOR UPDATE (id-scoped), reading club_id/linked_reservation_id for the next step", () => {
    const body = fn();
    expect(body).toMatch(
      /select club_id, linked_reservation_id into v_club_id, v_linked_reservation_id\s*\n\s*from public\.lesson_requests\s*\n\s*where id = p_request_id\s*\n\s*for update;/,
    );
  });

  it("step 3: locks the linked pro_lesson reservation FOR UPDATE only when one exists, AFTER the lesson_requests lock — same order as cancel_lesson", () => {
    const body = fn();
    const lessonLockIdx = body.indexOf("from public.lesson_requests");
    const reservationLockIdx = body.indexOf("if v_linked_reservation_id is not null then");
    expect(reservationLockIdx).toBeGreaterThan(lessonLockIdx);
    const reservationLockBlock = body.slice(reservationLockIdx, body.indexOf("end if;", reservationLockIdx));
    expect(reservationLockBlock).toContain("and reason = 'pro_lesson'");
    expect(reservationLockBlock).toContain("for update;");
  });

  it("step 4: locks that lesson's club_settings row FOR SHARE, using the already-resolved v_club_id (never a client-supplied club id), AFTER the reservation lock", () => {
    const body = fn();
    const reservationLockBlockEnd = body.indexOf("end if;", body.indexOf("if v_linked_reservation_id is not null then"));
    const settingsLockMatch = body.match(
      /perform 1 from public\.club_settings\s*\n\s*where club_id = v_club_id\s*\n\s*for share;/,
    );
    expect(settingsLockMatch, "club_settings FOR SHARE lock not found").toBeTruthy();
    expect(body.indexOf(settingsLockMatch![0])).toBeGreaterThan(reservationLockBlockEnd);
  });

  it("step 5: performs a SECOND preview call AFTER all three locks, and the comparison uses ONLY this second result", () => {
    const body = fn();
    const settingsLockIdx = body.indexOf("for share;");
    const secondPreviewIdx = body.indexOf("select state into v_final_state");
    const compareIdx = body.indexOf("if v_final_state is distinct from p_expected_policy_state then");
    expect(settingsLockIdx).toBeGreaterThan(-1);
    expect(secondPreviewIdx).toBeGreaterThan(settingsLockIdx);
    expect(compareIdx).toBeGreaterThan(secondPreviewIdx);
    expect(body).not.toMatch(/v_current_state/);
    expect((body.match(/preview_member_lesson_cancellation_policy\(/g) ?? []).length).toBe(2);
  });

  it("raises cancellation_policy_changed on a mismatch, delegates to the existing cancel_lesson verbatim on a match — no duplicated body", () => {
    const body = fn();
    expect(body).toContain("raise exception 'cancellation_policy_changed';");
    expect(body).toContain("return public.cancel_lesson(p_request_id, p_reason);");
    expect(body).not.toMatch(/update public\.lesson_requests set|update public\.reservations\s*\n\s*set|_evaluate_cancellation_policy\(/);
  });

  it("is granted to authenticated only", () => {
    expect(migrationSql()).toMatch(
      /revoke execute on function public\.cancel_member_lesson_confirmed\(uuid, text, text\) from public, anon;\s*\n\s*grant\s+execute on function public\.cancel_member_lesson_confirmed\(uuid, text, text\) to authenticated;/,
    );
  });
});

describe("lock-order compatibility — verified, not assumed", () => {
  it("cancel_lesson, propose_lesson_time, and admin_update_member_lesson all lock lesson_requests BEFORE any linked reservation — no reverse-order path exists to deadlock against", () => {
    const files = [
      "0186_policy_aware_cancellation_refunds.sql",
      "0159_lesson_online_payment_checkout.sql",
    ];
    for (const file of files) {
      const sql = codeOnly(readSource(`supabase/migrations/${file}`));
      for (const name of ["cancel_lesson", "propose_lesson_time", "admin_update_member_lesson"]) {
        const idx = sql.indexOf(`create or replace function public.${name}(`);
        if (idx === -1) continue; // not (re)defined in this particular file
        const lessonLockIdx = sql.indexOf("from public.lesson_requests", idx);
        const reservationLockIdx = sql.indexOf("from public.reservations", idx);
        if (lessonLockIdx === -1 || reservationLockIdx === -1) continue;
        expect(lessonLockIdx, `${name} in ${file} should lock lesson_requests before reservations`).toBeLessThan(reservationLockIdx);
      }
    }
  });

  it("no club_settings-mutating function locks (FOR UPDATE/FOR SHARE) a reservations or lesson_requests row — verified across every function that writes to club_settings, so 0187's domain-row-then-club_settings order cannot deadlock against any of them", () => {
    // Effective (highest-numbered) body of every function found by grepping
    // `insert into club_settings` / `update club_settings set` across the
    // whole migrations directory.
    const targets: [file: string, fn: string][] = [
      ["0049_waitlist_offer_rpcs.sql", "update_club_settings"],
      ["0142_program_pricing.sql", "update_club_pricing"],
      ["0143_payment_mode_and_ledger_foundation.sql", "update_club_payment_mode"],
      ["0184_club_rules_and_policies.sql", "update_club_rules_and_policies"],
    ];
    for (const [file, name] of targets) {
      const sql = codeOnly(readSource(`supabase/migrations/${file}`));
      const start = sql.indexOf(`create or replace function public.${name}(`) >= 0
        ? sql.indexOf(`create or replace function public.${name}(`)
        : sql.indexOf(`create or replace function ${name}(`);
      expect(start, `${name} not found in ${file}`).toBeGreaterThanOrEqual(0);
      const end = sql.indexOf("\n$$;", start);
      const body = sql.slice(start, end);

      // update_club_pricing legitimately READS reservations/lesson_requests
      // (a plain, non-locking existence check gating its currency-lock
      // rule) — assert specifically that neither table is ever the target
      // of a FOR UPDATE/FOR SHARE clause, not that the table name is
      // absent entirely.
      const lockedReservations = /from\s+(public\.)?reservations[\s\S]{0,400}?for (update|share)/i.test(body)
        || /from\s+(public\.)?reservations\s+r?\s*where[\s\S]{0,400}?for (update|share)/i.test(body);
      const lockedLessonRequests = /from\s+(public\.)?lesson_requests[\s\S]{0,400}?for (update|share)/i.test(body);
      expect(lockedReservations, `${name} should never lock reservations`).toBe(false);
      expect(lockedLessonRequests, `${name} should never lock lesson_requests`).toBe(false);
    }
  });

  it("the new-club bootstrap function's club_settings INSERT only ever runs for a brand-new club — never touches an existing club's reservations/lesson_requests", () => {
    const sql = codeOnly(readSource("supabase/migrations/0164_pricing_packaging_alignment.sql"));
    const insertIdx = sql.indexOf("insert into club_settings (");
    expect(insertIdx).toBeGreaterThan(-1);
    // The club row itself is freshly inserted immediately before — proof
    // this is bootstrap, not an edit of a pre-existing club.
    const clubInsertIdx = sql.lastIndexOf("returning * into v_club;", insertIdx);
    expect(clubInsertIdx).toBeGreaterThan(-1);
    expect(clubInsertIdx).toBeLessThan(insertIdx);
  });
});

describe("club_settings FOR SHARE lock — matches this project's own established pattern", () => {
  it("0126 (events, before an advisory lock) and 0178 (reservations, before a roster mutation) already use FOR SHARE for the identical 'freeze against concurrent UPDATE without blocking readers' purpose", () => {
    const events = readSource("supabase/migrations/0126_member_schedule_guards.sql");
    const roster = readSource("supabase/migrations/0178_reservation_participant_foundation.sql");
    expect(events).toMatch(/from public\.events where id = new\.event_id for share;/);
    expect(roster).toMatch(/for share;/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// E. Security — no cross-club oracle, private evaluator stays private
// ═══════════════════════════════════════════════════════════════════════════

describe("security — same-club/ownership isolation, no new reachability for the private evaluator", () => {
  it("_evaluate_cancellation_policy is not redefined or re-granted by 0187", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/create or replace function public\._evaluate_cancellation_policy/);
    expect(sql).not.toMatch(/grant execute on function public\._evaluate_cancellation_policy/);
  });

  it("every reservation/lesson lookup in 0187 is scoped by club_id — no cross-club preview", () => {
    const sql = migrationSql();
    expect(sql).toContain("and club_id = v_club_id\n      and (");
    expect(sql).toContain("where id      = p_request_id\n     and club_id = v_profile.club_id;");
  });

  it("none of the four new functions is granted to anon or public", () => {
    const sql = migrationSql();
    expect(sql).not.toMatch(/grant execute on function public\.(preview_member_|cancel_member_reservation_confirmed|cancel_member_lesson_confirmed)[\s\S]{0,80}to (public|anon)/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F. ReservationDetailSheet — UX: preview-first confirmation, no immediate
//    mutation, policy-aware Member copy
// ═══════════════════════════════════════════════════════════════════════════

describe("ReservationDetailSheet — confirmation requires a fetched preview before opening, no immediate mutation", () => {
  it("the trigger button calls handleCancelTriggerClick, never the mutation handlers directly", () => {
    const block = cancelBlockSource();
    const triggerButton = block.slice(0, block.indexOf("{!isCancelled && confirmCancel"));
    expect(triggerButton).toContain("onClick={handleCancelTriggerClick}");
    expect(triggerButton).not.toMatch(/onClick=\{handleAdminCancel\}/);
    expect(triggerButton).not.toMatch(/onClick=\{handleMemberCancelConfirmed\}/);
  });

  it("handleCancelTriggerClick fetches the preview for member mode before ever opening the confirm panel", () => {
    const src = readSource(DETAIL_SHEET_PATH);
    const start = src.indexOf("async function handleCancelTriggerClick()");
    const end = src.indexOf("\n  }\n", start);
    const fn = src.slice(start, end);
    expect(fn).toContain("if (onMemberCancel) {");
    expect(fn).toContain("const ok = await loadPolicyPreview();");
    expect(fn).toContain("if (!ok) return;");
    expect(fn).toContain("setConfirmCancel(true);");
  });

  it("the confirm panel's own button is the only place that calls the actual mutation handlers", () => {
    const block = cancelBlockSource();
    const confirmPanel = block.slice(block.indexOf("{!isCancelled && confirmCancel"));
    expect(confirmPanel).toContain("onClick={onMemberCancel ? handleMemberCancelConfirmed : handleAdminCancel}");
    const triggerButton = block.slice(0, block.indexOf("{!isCancelled && confirmCancel"));
    expect(triggerButton).not.toMatch(/handleAdminCancel|handleMemberCancelConfirmed/);
  });

  it("mutation fires exactly once per confirm click", () => {
    const block = cancelBlockSource();
    expect((block.match(/onClick=\{onMemberCancel \? handleMemberCancelConfirmed : handleAdminCancel\}/g) ?? []).length).toBe(1);
  });

  it("the confirm button is disabled while loading, and for member mode also while the preview hasn't resolved yet", () => {
    const block = cancelBlockSource();
    expect(block).toContain("disabled={loading || (!!onMemberCancel && !policyPreview)}");
  });

  it("Keep Booking/Keep Block resets confirmCancel, clears the error, AND clears the policy-changed notice", () => {
    const block = cancelBlockSource();
    expect(block).toContain("onClick={() => { setConfirmCancel(false); setError(null); setPolicyChangedNotice(false); }}");
  });
});

describe("ReservationDetailSheet — Member confirmation copy is authoritative and policy-aware", () => {
  const copyFn = () => {
    const src = readSource(DETAIL_SHEET_PATH);
    const start = src.indexOf("function memberReservationCancelCopy(");
    const end = src.indexOf("\n}\n", start);
    return src.slice(start, end);
  };

  it("in_policy: states the refund request is created automatically, and that Admin approval is still required for actual processing", () => {
    const fn = copyFn();
    const branch = fn.slice(fn.indexOf('policy.state === "in_policy"'));
    expect(branch).toMatch(/refund request is automatically created/i);
    expect(branch).toMatch(/actual refund processing still requires Admin approval/i);
    expect(branch).not.toMatch(/never automatic/i);
  });

  it("grace: same financial treatment/message as in_policy — explicitly says so", () => {
    const fn = copyFn();
    const branch = fn.slice(fn.indexOf('policy.state === "grace"'), fn.indexOf("// late"));
    expect(branch).toMatch(/treated the same as an in-policy cancellation/i);
    expect(branch).toMatch(/refund request is automatically created/i);
  });

  it("late + collected/paid: strong warning, no policy refund request, never implies Admin can't manually refund later", () => {
    const fn = copyFn();
    const paidBranch = fn.slice(
      fn.indexOf("if (payment && payment.current_amount_paid_cents > 0)"),
      fn.indexOf('return "This cancellation is outside the club\'s cancellation window. The court will be released.";'),
    );
    expect(paidBranch).toMatch(/outside the club's cancellation window/i);
    expect(paidBranch).toMatch(/no refund request will be created/i);
    expect(paidBranch).toMatch(/not.{0,5}automatically refunded/i);
    expect(paidBranch).toMatch(/contact the club/i); // never implies Admin can never manually refund
  });

  it("late + outstanding balance: strong warning, uses paymentState to phrase the amount, never implies the debt is erased", () => {
    const fn = copyFn();
    const outstandingBranch = fn.slice(
      fn.indexOf("if (payment && isPaymentOpenForRecording(payment))"),
      fn.indexOf("if (payment && payment.current_amount_paid_cents > 0)"),
    );
    expect(outstandingBranch).toMatch(/outstanding balance of \$\{formatMoney/);
    expect(outstandingBranch).toMatch(/remains due — cancelling does not erase it/i);
  });

  it("never computes policy classification from payment state — policy is always a parameter, payment only selects the late sub-message", () => {
    const fn = copyFn();
    expect(fn).not.toMatch(/current_status === ['"]unpaid['"]|current_amount_due_cents >.*current_amount_paid_cents.*state\s*=/);
  });
});

describe("ReservationDetailSheet — late destructive CTA and policy-changed reconfirmation", () => {
  it("the confirm CTA reads 'Cancel Anyway' for a Member's late cancellation, 'Confirm Cancellation' otherwise", () => {
    const block = cancelBlockSource();
    expect(block).toContain('onMemberCancel && policyPreview?.state === "late"');
    expect(block).toContain('"Cancel Anyway"');
  });

  it("a policyChanged result re-fetches the preview and shows a distinct notice, WITHOUT closing the confirm panel or claiming success", () => {
    const src = readSource(DETAIL_SHEET_PATH);
    const start = src.indexOf("async function handleMemberCancelConfirmed()");
    const end = src.indexOf("\n  }\n", start);
    const fn = src.slice(start, end);
    expect(fn).toContain("if (result?.policyChanged) {");
    const policyChangedBranch = fn.slice(fn.indexOf("if (result?.policyChanged) {"), fn.indexOf("if (result?.error) {"));
    expect(policyChangedBranch).toContain("setPolicyChangedNotice(true);");
    expect(policyChangedBranch).toContain("await loadPolicyPreview();");
    expect(policyChangedBranch).not.toContain("onCancelled();");
  });

  it("the policy-changed notice is rendered inside the confirm panel, amber, member-mode only", () => {
    const block = cancelBlockSource();
    expect(block).toContain("{onMemberCancel && policyChangedNotice && (");
    expect(block).toMatch(/text-amber-600/);
  });
});

describe("ReservationDetailSheet — Admin/Staff confirmation stays simple, no Member policy language", () => {
  it("the admin copy contains no refund/policy language at all", () => {
    const block = cancelBlockSource();
    const adminMatch = block.match(/:\s*`Cancel this \$\{reservation\.reason === "maintenance" \? "block" : "booking"\}\? ([^`]+)`/);
    expect(adminMatch, "admin confirmation copy not found").toBeTruthy();
    expect(adminMatch![1].toLowerCase()).not.toMatch(/refund|in_policy|grace period|cancellation window|late cancellation/);
  });

  it("admin mode never triggers a preview fetch — handleCancelTriggerClick's preview branch is gated on onMemberCancel", () => {
    const src = readSource(DETAIL_SHEET_PATH);
    const start = src.indexOf("async function handleCancelTriggerClick()");
    const end = src.indexOf("\n  }\n", start);
    const fn = src.slice(start, end);
    expect(fn.indexOf("if (onMemberCancel) {")).toBeLessThan(fn.indexOf("setConfirmCancel(true)"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// G. LessonRequestDetail — Member gets authoritative preview, Pro keeps
//    simple confirmation
// ═══════════════════════════════════════════════════════════════════════════

describe("LessonRequestDetail — Member cancellation now uses the authoritative preview", () => {
  it("determines the viewer's role via request.pro_id === userId — the same signal cancel_lesson's own v_actor_role uses for 'pro'", () => {
    const src = readSource(LESSON_DETAIL_PATH);
    expect(src).toContain("const isViewerPro = request.pro_id === _userId;");
  });

  it("the trigger fetches the preview only for the non-Pro (Member) viewer", () => {
    const src = readSource(LESSON_DETAIL_PATH);
    const start = src.indexOf("async function handleCancelTriggerClick()");
    const end = src.indexOf("\n  }\n", start);
    const fn = src.slice(start, end);
    expect(fn).toContain("if (!isViewerPro) {");
    expect(fn).toContain("const ok = await loadPolicyPreview();");
  });

  it("Pro confirmation copy is unchanged/simple; Member confirmation copy is policy-aware via memberLessonCancelCopy", () => {
    const src = readSource(LESSON_DETAIL_PATH);
    const start = src.indexOf("{confirmCancel && (");
    const end = src.indexOf("Keep Lesson", start);
    const block = src.slice(start, end);
    expect(block).toContain("Cancel this confirmed lesson? This will remove it from the calendar.");
    expect(block).toContain("memberLessonCancelCopy(policyPreview, paymentState)");
  });

  it("in_policy lesson copy states the refund request is automatic; late lesson copy never claims grace (lessons never get grace)", () => {
    const src = readSource(LESSON_DETAIL_PATH);
    const start = src.indexOf("function memberLessonCancelCopy(");
    const end = src.indexOf("\n}\n", start);
    const fn = src.slice(start, end);
    expect(fn).toMatch(/refund request is automatically created/i);
    expect(fn).not.toMatch(/\bgrace\b/i);
  });

  it("the destructive CTA reads 'Cancel Anyway' for a Member's late lesson cancellation", () => {
    const src = readSource(LESSON_DETAIL_PATH);
    const start = src.indexOf('{confirmCancel && (');
    const end = src.indexOf("Keep Lesson", start);
    const block = src.slice(start, end);
    expect(block).toContain('!isViewerPro && policyPreview?.state === "late"');
    expect(block).toContain('"Cancel Anyway"');
  });

  it("a policyChanged result re-fetches the preview rather than closing the sheet or claiming success", () => {
    const src = readSource(LESSON_DETAIL_PATH);
    const start = src.indexOf("function handleMemberCancelConfirmed()");
    const end = src.indexOf("\n  }\n", start);
    const fn = src.slice(start, end);
    expect(fn).toContain("if (res.policyChanged) {");
    const branch = fn.slice(fn.indexOf("if (res.policyChanged) {"), fn.indexOf("if (res.error)"));
    expect(branch).toContain("setPolicyChangedNotice(true);");
    expect(branch).toContain("await loadPolicyPreview();");
    expect(branch).not.toContain("onClose();");
  });

  it("mutation fires exactly once per confirm click, gated on the correct actor", () => {
    const src = readSource(LESSON_DETAIL_PATH);
    const start = src.indexOf("{confirmCancel && (");
    const end = src.indexOf("Keep Lesson", start);
    const block = src.slice(start, end);
    expect((block.match(/handleMemberCancelConfirmed/g) ?? []).length).toBe(1);
    expect((block.match(/cancelLesson\(\{/g) ?? []).length).toBe(1);
  });

  it("the confirm button is disabled while pending, and for the Member also while the preview hasn't resolved", () => {
    const src = readSource(LESSON_DETAIL_PATH);
    const start = src.indexOf("{confirmCancel && (");
    const end = src.indexOf("Keep Lesson", start);
    const block = src.slice(start, end);
    expect(block).toContain("disabled={isPending || (!isViewerPro && !policyPreview)}");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// H. Refund requested — amber attention styling (carried over, re-verified)
// ═══════════════════════════════════════════════════════════════════════════

describe("AdminPaymentsClient — Refund requested pill uses amber (warning) tone", () => {
  it("no longer uses the neutral (gray) tone", () => {
    const src = readSource(ADMIN_PAYMENTS_CLIENT_PATH);
    const start = src.indexOf("{row.pendingRefundRequest && (");
    const end = src.indexOf("Refund requested", start) + "Refund requested".length;
    const block = src.slice(start, end);
    expect(block).toContain('toneClassName("warning")');
    expect(block).not.toContain('toneClassName("neutral")');
  });

  it("the layout and label text are unchanged", () => {
    const src = readSource(ADMIN_PAYMENTS_CLIENT_PATH);
    const start = src.indexOf("{row.pendingRefundRequest && (");
    const end = src.indexOf("Refund requested", start) + "Refund requested".length;
    const block = src.slice(start, end);
    expect(block).toContain("inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// I. Non-regression — Phase 41A behavior untouched
// ═══════════════════════════════════════════════════════════════════════════

describe("non-regression — Phase 41A cancellation/error-mapping behavior preserved", () => {
  it("mapCancelError still recognizes all four previously-fixed codes", () => {
    const src = readSource(DETAIL_SHEET_PATH);
    const start = src.indexOf("function mapCancelError(message: string): string {");
    const end = src.indexOf("\n}\n", start);
    const fn = src.slice(start, end);
    for (const code of ["reservation_not_found", "insufficient_role", "checkout_still_processing", "checkout_resolution_failed"]) {
      expect(fn).toContain(`message === "${code}"`);
    }
  });

  it("adminCancelReservation still returns resolved.code (not resolved.error) on a blocked Checkout resolution — untouched by this completion pass", () => {
    const src = readSource(CALENDAR_ACTIONS_PATH);
    const start = src.indexOf("export async function adminCancelReservation(");
    const end = src.indexOf("export async function updateMemberReservationAdmin(");
    const fn = src.slice(start, end);
    expect(fn).toContain("if (!resolved.ok) return { error: resolved.code };");
  });

  it("the new cancelMemberReservationConfirmed retry-once handshake ALSO returns resolved.code, and retries the SAME confirmed wrapper (never the raw RPC)", () => {
    const src = readSource(CALENDAR_ACTIONS_PATH);
    const start = src.indexOf("export async function cancelMemberReservationConfirmed(");
    const end = src.indexOf("\n}\n", start);
    const fn = src.slice(start, end);
    expect(fn).toContain("if (!resolved.ok) return { error: resolved.code };");
    expect((fn.match(/supabase\.rpc\("cancel_member_reservation_confirmed"/g) ?? []).length).toBe(2);
  });

  it("CalendarShell now binds onMemberCancel to cancelMemberReservationConfirmed, passing the expected policy state through", () => {
    const src = readSource(CALENDAR_SHELL_PATH);
    expect(src).toContain("cancelMemberReservationConfirmed(selectedReservation.id, clubId, expectedPolicyState)");
    expect(src).not.toContain("cancelMemberReservation(selectedReservation.id, clubId)");
  });

  it("0186's three cancel RPCs remain untouched by this completion pass (0187 only adds new functions)", () => {
    const sql = readSource("supabase/migrations/0186_policy_aware_cancellation_refunds.sql");
    expect(sql).toMatch(/create or replace function public\.cancel_member_reservation\(/);
    expect(sql).toMatch(/create or replace function public\.cancel_lesson\(/);
    expect(sql).toMatch(/create or replace function public\.admin_cancel_reservation_v2\(/);
  });

  it("no new club_settings column or auto-refund setting exists anywhere added by 0186 or 0187", () => {
    for (const file of ["0186_policy_aware_cancellation_refunds.sql", "0187_member_cancellation_policy_preview.sql"]) {
      const sql = readSource(`supabase/migrations/${file}`);
      expect(sql).not.toMatch(/auto_approve|auto_refund/i);
    }
  });

  it("lessons/actions.ts's cancelLesson (Admin/Staff/Pro path) is untouched by this completion pass", () => {
    const src = readSource(LESSONS_ACTIONS_PATH);
    const start = src.indexOf("export async function cancelLesson(params: {");
    const end = src.indexOf("export async function", start + 1);
    const fn = src.slice(start, end);
    expect(fn).toContain('supabase.rpc("cancel_lesson"');
    expect(fn).not.toContain("cancel_member_lesson_confirmed");
  });
});
