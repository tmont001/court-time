import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 34F-C — regression coverage for program_enrollment Checkout
// (whole-program enrollment only), mirroring eventCheckout.regression.
// test.ts's own established source-inspection style (this repository's
// vitest baseline is deliberately pure-TypeScript, no jsdom/Supabase/
// network mocking — for "does the shipped code actually take this shape"
// questions, reading the real source is a more honest guard than
// reimplementing a parallel mock).
//
// This is domain EXPANSION, not a parallel Stripe implementation: nearly
// every assertion below confirms programCheckoutActions.ts reuses the SAME
// service-role RPCs (open_payment_checkout_attempt, supersede_checkout_
// attempt_and_open_fresh, record_checkout_session_created) and the SAME
// pure eligibility/expiry/remaining-balance helpers reservations/lessons/
// events use — the only genuinely new surface is get_program_payment_for_
// checkout / open_program_payment_checkout_attempt / supersede_program_
// checkout_attempt_and_open_fresh / list_program_blocking_checkout_
// attempts (0163) and the program-flavored Stripe param/return-URL
// builders.
//
// Numbered items below correspond 1:1 to the 22 requirements from this
// checkpoint's own spec.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !line.trim().startsWith("--") && !line.trim().startsWith("//"))
    .join("\n");
}

const ACTION_PATH             = "src/app/(app)/events/programCheckoutActions.ts";
const PROGRAMS_ACTIONS        = "src/app/(app)/events/programsActions.ts";
const ENROLLMENT_ACTIONS      = "src/app/(app)/events/programEnrollmentActions.ts";
const ROSTER_ACTIONS          = "src/app/(app)/events/programRosterActions.ts";
const MIGRATION_PATH          = "supabase/migrations/0163_program_online_payment_checkout.sql";
const PROGRAM_CARD_PATH       = "src/app/(app)/events/ProgramEnrollmentCard.tsx";
const EVENTS_UPCOMING_PATH    = "src/app/(app)/events/EventsUpcomingClient.tsx";
const EVENTS_PAGE_PATH        = "src/app/(app)/events/page.tsx";
const PAYMENTS_CONFIG_PATH    = "src/lib/stripe/paymentsConfig.ts";
const EVENT_MIGRATION_PATH    = "supabase/migrations/0161_event_online_payment_checkout.sql";
const M0115_PATH              = "supabase/migrations/0115_program_enrollment_identity.sql";
const M0137_PATH              = "supabase/migrations/0137_staff_program_operational_authorization.sql";

// ═══════════════════════════════════════════════════════════════════════════
// Checkout creation — server-authoritative, no client-trusted financial value
// (requirement 21)
// ═══════════════════════════════════════════════════════════════════════════

describe("createProgramCheckoutAction — server-authoritative, no client-trusted financial value (21)", () => {
  const src = () => readSource(ACTION_PATH);

  it("rejects an unauthenticated caller before touching any financial data", () => {
    const s = src();
    expect(s).toMatch(/const user = await getAuthUser\(\);\s*\n\s*if \(!user\) return \{ error: ERROR_MESSAGES\.not_authenticated \};/);
  });

  it("resolves the payment via the ownership-scoped RPC, never a client-supplied payment_id/club_id", () => {
    const s = src();
    expect(s).toContain('.rpc("get_program_payment_for_checkout", {');
    expect(s).toContain("p_program_id: programId");
    expect(s).not.toMatch(/createProgramCheckoutAction\(\s*[\s\S]{0,80}p_payment_id/);
  });

  it("rejects an obligation not created under court_time_payments", () => {
    const s = src();
    expect(s).toContain('row.payment_mode_at_creation !== "court_time_payments"');
  });

  it("rejects a zero/already-resolved balance via the same status+remaining gate reservations/lessons/events use", () => {
    const s = src();
    expect(s).toMatch(/row\.status !== "unpaid" && row\.status !== "partially_paid"/);
    expect(s).toContain("remainingCents(row.amount_due_cents, row.amount_paid_cents) <= 0");
  });

  it("derives livemode server-side via getStripeContext — never from a request/query value", () => {
    const s = src();
    expect(s).toContain("const context = getStripeContext();");
    expect(s).not.toMatch(/searchParams/);
    expect(s).not.toMatch(/p_livemode:\s*(true|false)\b/);
  });

  it("uses a stable, server-derived Stripe idempotency key built from the attempt id, via the PROGRAM-specific builder — never reservation/lesson/event's own", () => {
    const s = src();
    expect(s).toContain("idempotencyKey: buildProgramCheckoutIdempotencyKey(attempt.id)");
    expect(s).not.toContain("buildReservationCheckoutIdempotencyKey");
    expect(s).not.toContain("buildLessonCheckoutIdempotencyKey");
    expect(s).not.toContain("buildEventCheckoutIdempotencyKey");
  });

  it("passes programId (never a reservation/lesson/event identity) into the program-specific session-param and return-URL builders", () => {
    const s = src();
    expect(s).toContain("buildProgramCheckoutReturnUrls(SITE_URL, programId)");
    expect(s).not.toMatch(/reservationId|lessonRequestId|eventId/);
  });

  it("opens the checkout attempt through the atomic PROGRAM-aware wrapper (never the raw reservation/lesson/event-shaped RPC directly), via the privileged client", () => {
    const s = src();
    expect(s).toContain('privileged.rpc("open_program_payment_checkout_attempt"');
    expect(s).not.toContain('privileged.rpc("open_payment_checkout_attempt"');
    expect(s).not.toContain('privileged.rpc("open_event_payment_checkout_attempt"');
    expect(s).not.toContain('privileged.rpc("open_lesson_payment_checkout_attempt"');
    expect(s).not.toMatch(/\.from\(["']payment_checkout_attempts["']\)/);
  });

  it("passes programId (not row.payment_id) to the atomic wrapper — the wrapper itself resolves payment_id fresh, under the programs row lock", () => {
    const s = src();
    expect(s).toMatch(/open_program_payment_checkout_attempt",\s*\{\s*\n\s*p_program_id: programId,/);
  });

  it("REQUIRED, not best-effort: binds the Stripe Session before ever returning a checkout URL", () => {
    const s = src();
    const bindIdx = s.indexOf('const { error: bindError } = await privileged.rpc("record_checkout_session_created"');
    const urlReturnIdx = s.indexOf("return { url: session.url };");
    expect(bindIdx).toBeGreaterThan(-1);
    expect(urlReturnIdx).toBeGreaterThan(bindIdx);
  });

  it("never sets application_fee_amount or on_behalf_of anywhere in this file", () => {
    const s = src();
    expect(s).not.toMatch(/application_fee_amount|applicationFeeAmount/);
    expect(s).not.toMatch(/on_behalf_of/);
  });

  it("never redefines/duplicates open_payment_checkout_attempt, supersede_checkout_attempt_and_open_fresh, or record_checkout_session_created — only calls the atomic program wrappers and existing RPCs by name", () => {
    const s = src();
    expect(s).not.toMatch(/create (or replace )?function/i);
    expect(s).toContain('privileged.rpc("open_program_payment_checkout_attempt"');
    expect(s).toContain('privileged.rpc("record_checkout_session_created"');
  });

  it("process_stripe_payment_event is never called from programCheckoutActions.ts — reconciliation is entirely webhook-driven and shared, not duplicated per domain", () => {
    const s = src();
    expect(s).not.toMatch(/\.rpc\(\s*["']process_stripe_payment_event["']/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 1/2/3 — scope: only whole-program enrollment, only own enrolled Member,
// waitlisted/offered excluded
// ═══════════════════════════════════════════════════════════════════════════

describe("get_program_payment_for_checkout — eligibility gate (1, 2, 3)", () => {
  const getFn = () => {
    const m = readSource(MIGRATION_PATH);
    const fnStart = m.indexOf("create or replace function public.get_program_payment_for_checkout(");
    const fnEnd = m.indexOf("revoke execute on function public.get_program_payment_for_checkout(");
    return m.slice(fnStart, fnEnd);
  };

  it("requires role = 'member' before anything else", () => {
    const fn = getFn();
    expect(fn).toContain("v_role := public.current_user_role();");
    expect(fn).toMatch(/if v_role <> 'member' then\s*\n\s*raise exception 'insufficient_role';/);
  });

  it("1. hardcoded to enrollment_model = 'program' — a per_session or admin_managed Program never returns a row here regardless of input", () => {
    const fn = getFn();
    expect(fn).toContain("v_program_enrollment_model <> 'program'");
  });

  it("2. requires the caller's OWN program_enrollments row, matched by the caller's own current roster identity — never a client-supplied identity", () => {
    const fn = getFn();
    expect(fn).toContain("v_roster_member_id := public.current_user_roster_member_id();");
    expect(fn).toContain("pe.roster_member_id = v_roster_member_id");
  });

  it("3. requires that row's status to be exactly 'enrolled' — waitlisted/offered resolve zero rows, not an error", () => {
    const fn = getFn();
    expect(fn).toContain("if not found or v_enrollment_status <> 'enrolled' then");
    expect(fn).toContain("return;");
  });

  it("hardcoded to domain_type = 'program_enrollment', domain_id = the enrollment row's own id — never program_id", () => {
    const fn = getFn();
    expect(fn).toContain("p.domain_type = 'program_enrollment'");
    expect(fn).toContain("p.domain_id = v_enrollment_id");
  });

  it("resolves only the LATEST obligation cycle for the enrollment — order by obligation_cycle desc limit 1", () => {
    const fn = getFn();
    expect(fn).toMatch(/order by p\.obligation_cycle desc\s*\n\s*limit 1;/);
  });

  it("grants execute only to authenticated — never public/anon (19)", () => {
    const m = readSource(MIGRATION_PATH);
    expect(m).toContain("revoke execute on function public.get_program_payment_for_checkout(uuid) from public, anon;");
    expect(m).toContain("grant  execute on function public.get_program_payment_for_checkout(uuid) to authenticated;");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4/5/6/7/8 — eligibility allowlist: active/completed eligible;
// cancelled/draft/archived ineligible
// ═══════════════════════════════════════════════════════════════════════════

describe("eligibility allowlist — status IN ('active','completed') AND archived_at IS NULL, never the broader status <> 'cancelled' predicate (4, 5, 6, 7, 8)", () => {
  const getReadFn = () => {
    const m = readSource(MIGRATION_PATH);
    const fnStart = m.indexOf("create or replace function public.get_program_payment_for_checkout(");
    const fnEnd = m.indexOf("revoke execute on function public.get_program_payment_for_checkout(");
    return m.slice(fnStart, fnEnd);
  };
  const getOpenFn = () => {
    const m = readSource(MIGRATION_PATH);
    const fnStart = m.indexOf("create or replace function public.open_program_payment_checkout_attempt(");
    const fnEnd = m.indexOf(
      "revoke execute on function public.open_program_payment_checkout_attempt(uuid, uuid, text, boolean, uuid) from public, anon, authenticated;",
    );
    return m.slice(fnStart, fnEnd);
  };

  it("4/5. the read's allowlist explicitly includes BOTH 'active' and 'completed' — a completed Program with a legitimate outstanding balance remains eligible", () => {
    const fn = getReadFn();
    expect(fn).toContain("v_program_status not in ('active', 'completed')");
  });

  it("6/7. 'cancelled' and 'draft' are excluded by the SAME allowlist — neither is in the ('active','completed') list, so both are structurally unreachable, never via a separate exclusion check", () => {
    const fn = getReadFn();
    // The only two statuses ever admitted are 'active' and 'completed' —
    // an exclusion-style predicate like `<> 'cancelled'` would also admit
    // 'draft', which the locked correction explicitly rejected.
    expect(fn).not.toMatch(/status\s*<>\s*'cancelled'/);
    const allowlistMatch = fn.match(/v_program_status not in \(('active', 'completed')\)/);
    expect(allowlistMatch).not.toBeNull();
  });

  it("8. archived_at IS NULL is a SEPARATE, additional condition from status — an archived-but-'completed' Program is still ineligible even though 'completed' alone is in the allowlist", () => {
    const fn = getReadFn();
    expect(fn).toContain("v_program_status not in ('active', 'completed')\n     or v_program_archived_at is not null");
  });

  it("the atomic opener wrapper re-applies the IDENTICAL allowlist under lock — never a looser or differently-worded re-check", () => {
    const fn = getOpenFn();
    expect(fn).toContain("v_program_status not in ('active', 'completed') or v_program_archived_at is not null");
    expect(fn).toContain("raise exception 'program_not_payable';");
  });

  it("unarchiving a completed Program restores eligibility (archived_at clears, status stays 'completed' — still in the allowlist); unarchiving a cancelled Program does not (status stays 'cancelled' — never in the allowlist) — proven structurally: eligibility depends on status+archived_at only, and unarchive_program (0137, untouched) never touches status", () => {
    const m137 = readSource(M0137_PATH);
    const fnStart = m137.indexOf("CREATE OR REPLACE FUNCTION public.unarchive_program(");
    const fnEnd = m137.indexOf("$function$;", fnStart) + "$function$;".length;
    const fn = codeOnly(m137.slice(fnStart, fnEnd));
    expect(fn).not.toMatch(/set\s+[\s\S]{0,40}status\s*=/);
    expect(fn).toMatch(/archived_at\s*=\s*null/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9 — Atomic wrappers lock programs FIRST, defensive column qualification
// ═══════════════════════════════════════════════════════════════════════════

describe("open_program_payment_checkout_attempt / supersede_program_checkout_attempt_and_open_fresh — Program-row-first lock-then-delegate wrappers (9)", () => {
  const getOpenFn = () => {
    const m = readSource(MIGRATION_PATH);
    const fnStart = m.indexOf("create or replace function public.open_program_payment_checkout_attempt(");
    const fnEnd = m.indexOf(
      "revoke execute on function public.open_program_payment_checkout_attempt(uuid, uuid, text, boolean, uuid) from public, anon, authenticated;",
    );
    return m.slice(fnStart, fnEnd);
  };
  const getSupersedeFn = () => {
    const m = readSource(MIGRATION_PATH);
    const fnStart = m.indexOf("create or replace function public.supersede_program_checkout_attempt_and_open_fresh(");
    const fnEnd = m.indexOf(
      "revoke execute on function public.supersede_program_checkout_attempt_and_open_fresh(uuid, uuid, uuid, text, boolean, uuid) from public, anon, authenticated;",
    );
    return m.slice(fnStart, fnEnd);
  };

  it("open_program_payment_checkout_attempt locks the programs row FIRST (for update), matching every other Program-mutating RPC's own established lock order", () => {
    const fn = getOpenFn();
    const lockIdx = fn.indexOf("from public.programs pr");
    const forUpdateIdx = fn.indexOf("for update;", lockIdx);
    const rosterLookupIdx = fn.indexOf("from public.roster_members rm");
    expect(lockIdx).toBeGreaterThan(-1);
    expect(forUpdateIdx).toBeGreaterThan(lockIdx);
    expect(rosterLookupIdx).toBeGreaterThan(forUpdateIdx);
  });

  it("re-verifies enrollment_model/status/archived AND the caller's own enrollment is still 'enrolled' UNDER that lock, before ever resolving a payment id", () => {
    const fn = getOpenFn();
    const payableCheckIdx = fn.indexOf("raise exception 'program_not_payable';");
    const confirmedCheckIdx = fn.indexOf("raise exception 'program_enrollment_not_confirmed';");
    const paymentLookupIdx = fn.indexOf("select p.id into v_payment_id");
    expect(payableCheckIdx).toBeGreaterThan(-1);
    expect(confirmedCheckIdx).toBeGreaterThan(payableCheckIdx);
    expect(paymentLookupIdx).toBeGreaterThan(confirmedCheckIdx);
  });

  it("never trusts a client-supplied payment id — resolved fresh from the payments table, never accepted as a parameter", () => {
    const fn = getOpenFn();
    expect(fn).not.toMatch(/p_payment_id/);
    expect(fn).toContain("domain_type   = 'program_enrollment'");
  });

  it("delegates the ENTIRE remaining algorithm to the existing, unmodified open_payment_checkout_attempt — never duplicates its own eligibility/amount/reuse logic", () => {
    const fn = getOpenFn();
    expect(fn).toContain(
      "select * from public.open_payment_checkout_attempt(\n      v_payment_id, p_club_id, p_stripe_account_id, p_livemode, p_actor_id\n    );",
    );
    expect(fn).not.toMatch(/amount_expected_cents\s*:=|currency_expected\s*:=/);
  });

  it("service_role-only — never callable from an authenticated browser session", () => {
    const m = readSource(MIGRATION_PATH);
    expect(m).toContain(
      "revoke execute on function public.open_program_payment_checkout_attempt(uuid, uuid, text, boolean, uuid) from public, anon, authenticated;",
    );
    expect(m).toContain(
      "grant  execute on function public.open_program_payment_checkout_attempt(uuid, uuid, text, boolean, uuid) to service_role;",
    );
  });

  it("supersede_program_checkout_attempt_and_open_fresh mirrors the identical lock/re-verify/resolve/delegate pattern, and is also service_role-only", () => {
    const fn = getSupersedeFn();
    expect(fn).toContain("for update;");
    expect(fn).toContain("raise exception 'program_enrollment_not_confirmed';");
    expect(fn).toContain(
      "select * from public.supersede_checkout_attempt_and_open_fresh(\n      p_stale_attempt_id, v_payment_id, p_club_id, p_stripe_account_id, p_livemode, p_actor_id\n    );",
    );
    const m = readSource(MIGRATION_PATH);
    expect(m).toContain(
      "grant  execute on function public.supersede_program_checkout_attempt_and_open_fresh(uuid, uuid, uuid, text, boolean, uuid) to service_role;",
    );
  });

  it("service-role wrapper list_program_blocking_checkout_attempts is also defensively column-qualified and never exposes a Stripe session id or enrollment PII", () => {
    const m = readSource(MIGRATION_PATH);
    const fnStart = m.indexOf("create or replace function public.list_program_blocking_checkout_attempts(");
    const fnEnd = m.indexOf("revoke execute on function public.list_program_blocking_checkout_attempts(");
    const fn = m.slice(fnStart, fnEnd);
    expect(fn).toContain("select distinct p.id");
    expect(fn).toContain("pe.status     = 'enrolled'");
    expect(fn).toContain("a.status     = 'open'");
    expect(fn).not.toMatch(/stripe_checkout_session_id\s+as|select[\s\S]{0,40}stripe_checkout_session_id\s*,/);
  });

  it("both wrappers grant execute ONLY to service_role, never authenticated/public/anon", () => {
    const m = readSource(MIGRATION_PATH);
    expect(m).toContain("revoke execute on function public.open_program_payment_checkout_attempt(uuid, uuid, text, boolean, uuid) from public, anon, authenticated;");
    expect(m).toContain("revoke execute on function public.supersede_program_checkout_attempt_and_open_fresh(uuid, uuid, uuid, text, boolean, uuid) from public, anon, authenticated;");
    expect(m).toContain("revoke execute on function public.list_program_blocking_checkout_attempts(uuid, uuid) from public, anon, authenticated;");
    expect(m).toContain("grant  execute on function public.list_program_blocking_checkout_attempts(uuid, uuid) to service_role;");
  });
});

describe("Program-row-first lock ordering — cross-function proof across every new/guarded Program mutation this migration touches (9, 12)", () => {
  it("open_program_payment_checkout_attempt, supersede_program_checkout_attempt_and_open_fresh, leave_program, remove_program_member, remove_program_roster_member, and cancel_program ALL lock programs via `for update` as their first substantive step", () => {
    const m = readSource(MIGRATION_PATH);
    const markers: [string, string][] = [
      ["open_program_payment_checkout_attempt", "create or replace function public.open_program_payment_checkout_attempt("],
      ["supersede_program_checkout_attempt_and_open_fresh", "create or replace function public.supersede_program_checkout_attempt_and_open_fresh("],
      ["leave_program", "create or replace function public.leave_program(p_program_id uuid)"],
      ["remove_program_member", "create or replace function public.remove_program_member(p_program_id uuid, p_profile_id uuid)"],
      ["remove_program_roster_member", "create or replace function public.remove_program_roster_member(p_program_id uuid, p_expected_club_id uuid, p_roster_member_id uuid)"],
      ["cancel_program", "create or replace function public.cancel_program(p_program_id uuid)"],
    ];
    for (const [name, marker] of markers) {
      const start = m.indexOf(marker);
      expect(start, `${name} marker not found`).toBeGreaterThan(-1);
      const beginIdx = m.indexOf("\nbegin\n", start);
      expect(beginIdx, `${name} has no begin`).toBeGreaterThan(start);
      const nextForUpdate = m.indexOf("for update", beginIdx);
      expect(nextForUpdate, `${name} has no for update`).toBeGreaterThan(beginIdx);
      const codeSlice = codeOnly(m.slice(beginIdx, nextForUpdate + "for update".length));
      expect(codeSlice.length, `${name} locks too late`).toBeLessThan(900);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Member-only enforcement (defense in depth)
// ═══════════════════════════════════════════════════════════════════════════

describe("Member-only checkout enforcement (defense in depth) — owning Member yes, another Member/Pro/Admin/Staff no", () => {
  const actionSrc = () => readSource(ACTION_PATH);

  it("createProgramCheckoutAction requires the caller's current role to be exactly 'member' before any Stripe/payment-attempt mutation", () => {
    const s = actionSrc();
    const profileCheckIdx = s.indexOf('if (!profile || profile.role !== "member")');
    const stripeContextIdx = s.indexOf("const context = getStripeContext();");
    const attemptRpcIdx = s.indexOf('open_program_payment_checkout_attempt"');
    expect(profileCheckIdx).toBeGreaterThan(-1);
    expect(stripeContextIdx).toBeGreaterThan(profileCheckIdx);
    expect(attemptRpcIdx).toBeGreaterThan(profileCheckIdx);
  });

  it("getProgramCheckoutEligibilityAction (the Pay Now button's own visibility gate) applies the identical role check", () => {
    const s = actionSrc();
    const eligibilityFnIdx = s.indexOf("export async function getProgramCheckoutEligibilityAction");
    const createFnIdx = s.indexOf("export async function createProgramCheckoutAction");
    const eligibilityBody = s.slice(eligibilityFnIdx, createFnIdx);
    expect(eligibilityBody).toContain('if (!profile || profile.role !== "member") return { eligible: false };');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10 — leave_program guard before enrollment mutation
// ═══════════════════════════════════════════════════════════════════════════

describe("leave_program invalidates/flags an open Checkout attempt BEFORE its own domain mutation (10)", () => {
  const getFn = () => {
    const m = readSource(MIGRATION_PATH);
    const fnStart = m.indexOf("create or replace function public.leave_program(p_program_id uuid)");
    const fnEnd = m.indexOf("revoke execute on function public.leave_program(uuid) from public, anon;");
    return m.slice(fnStart, fnEnd);
  };

  it("resolves the current payment obligation and calls the SAME _invalidate_or_flag_open_checkout_attempt helper 0151 already established — never a bespoke program-leave-specific invalidation routine", () => {
    const fn = getFn();
    expect(fn).toContain("select p.id into v_payment_id_for_checkout_guard");
    expect(fn).toContain("p.domain_type  = 'program_enrollment'");
    expect(fn).toContain("perform public._invalidate_or_flag_open_checkout_attempt(v_payment_id_for_checkout_guard)");
  });

  it("the guard runs AFTER the enrollment is located (enrollment_not_found already raised for anyone else) but BEFORE the program_enrollments status mutation", () => {
    const fn = getFn();
    const notFoundIdx = fn.indexOf("raise exception 'enrollment_not_found';");
    const guardIdx = fn.indexOf("perform public._invalidate_or_flag_open_checkout_attempt(v_payment_id_for_checkout_guard)");
    const mutationIdx = fn.indexOf("set status           = 'cancelled'");
    expect(notFoundIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(notFoundIdx);
    expect(guardIdx).toBeLessThan(mutationIdx);
  });

  it("runs unconditionally (not branched on v_old.status) — a safe no-op for waitlisted/offered leaves, which never have a payment to find", () => {
    const fn = getFn();
    const guardIdx = fn.indexOf("select p.id into v_payment_id_for_checkout_guard");
    const branchIdx = fn.indexOf("if v_old.status in ('enrolled', 'offered') then");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(branchIdx);
  });

  it("remains a pure DOMAIN mutation — never inserts a payment_events row, never references amount_due_cents/amount_paid_cents/refund/waive/void (22)", () => {
    const fn = codeOnly(getFn());
    expect(fn).not.toMatch(/insert into public\.payment_events/);
    expect(fn).not.toMatch(/amount_due_cents|amount_paid_cents/);
    expect(fn).not.toMatch(/perform public\.(record_refund|waive_payment|void_payment_obligation)/);
  });

  it("the Program row lock precedes the enrollment lookup and the guard — Program-row-first ordering holds even for the single-row leave case", () => {
    const fn = getFn();
    const lockIdx = fn.indexOf("for update;");
    const enrollmentNotFoundIdx = fn.indexOf("raise exception 'enrollment_not_found';");
    const guardIdx = fn.indexOf("perform public._invalidate_or_flag_open_checkout_attempt(v_payment_id_for_checkout_guard)");
    expect(lockIdx).toBeGreaterThan(-1);
    expect(enrollmentNotFoundIdx).toBeGreaterThan(lockIdx);
    expect(guardIdx).toBeGreaterThan(enrollmentNotFoundIdx);
  });
});

describe("leaveProgram Server Action resolves a blocking bound Session via the established handshake before retrying", () => {
  it("catches OPEN_CHECKOUT_REQUIRES_RESOLUTION, resolves via resolveBlockingCheckoutBeforeMutation (the SAME shared handshake), then retries leave_program exactly once", () => {
    const s = readSource(ENROLLMENT_ACTIONS);
    const fnIdx = s.indexOf("export async function leaveProgram(");
    const nextFnIdx = s.indexOf("export async function acceptProgramOffer(");
    const fn = s.slice(fnIdx, nextFnIdx);
    expect(fn).toContain("error?.message.includes(OPEN_CHECKOUT_REQUIRES_RESOLUTION)");
    expect(fn).toContain("resolveBlockingCheckoutBeforeMutation(paymentId, params.expectedClubId)");
    const occurrences = fn.split('"leave_program"').length - 1;
    expect(occurrences).toBe(2);
  });

  it("resolves the payment id via get_program_payment_for_checkout BEFORE the leave attempt — never a second round-trip to discover which payment was blocking", () => {
    const s = readSource(ENROLLMENT_ACTIONS);
    const fnIdx = s.indexOf("export async function leaveProgram(");
    const nextFnIdx = s.indexOf("export async function acceptProgramOffer(");
    const fn = s.slice(fnIdx, nextFnIdx);
    const paymentLookupIdx = fn.indexOf('get_program_payment_for_checkout"');
    const leaveCallIdx = fn.indexOf('"leave_program"');
    expect(paymentLookupIdx).toBeGreaterThan(-1);
    expect(paymentLookupIdx).toBeLessThan(leaveCallIdx);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 11 — both removal RPCs guard before mutation
// ═══════════════════════════════════════════════════════════════════════════

describe("remove_program_member / remove_program_roster_member both invalidate/flag an open Checkout attempt BEFORE their own domain mutation — both live removal paths guarded, not just one (11)", () => {
  const getFn = (marker: string, revokeMarker: string) => {
    const m = readSource(MIGRATION_PATH);
    const fnStart = m.indexOf(marker);
    const fnEnd = m.indexOf(revokeMarker, fnStart);
    return m.slice(fnStart, fnEnd);
  };

  it("remove_program_member: guards before the status UPDATE, using the enrollment id it already resolved", () => {
    const fn = getFn(
      "create or replace function public.remove_program_member(p_program_id uuid, p_profile_id uuid)",
      "revoke execute on function public.remove_program_member(uuid, uuid) from public, anon;",
    );
    const guardIdx = fn.indexOf("perform public._invalidate_or_flag_open_checkout_attempt(v_payment_id_for_checkout_guard)");
    const mutationIdx = fn.indexOf("update public.program_enrollments\n    set status");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(mutationIdx);
  });

  it("remove_program_roster_member: guards before its status UPDATE, using the enrollment id it already resolved", () => {
    const fn = getFn(
      "create or replace function public.remove_program_roster_member(p_program_id uuid, p_expected_club_id uuid, p_roster_member_id uuid)",
      "revoke execute on function public.remove_program_roster_member(uuid, uuid, uuid) from public, anon;",
    );
    const guardIdx = fn.indexOf("perform public._invalidate_or_flag_open_checkout_attempt(v_payment_id_for_checkout_guard)");
    const mutationIdx = fn.indexOf("update public.program_enrollments\n    set status");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(mutationIdx);
  });

  it("both are pure DOMAIN mutations — neither inserts a payment_events row nor references amount_due_cents/amount_paid_cents/refund/waive/void (22)", () => {
    for (const [marker, revokeMarker] of [
      [
        "create or replace function public.remove_program_member(p_program_id uuid, p_profile_id uuid)",
        "revoke execute on function public.remove_program_member(uuid, uuid) from public, anon;",
      ],
      [
        "create or replace function public.remove_program_roster_member(p_program_id uuid, p_expected_club_id uuid, p_roster_member_id uuid)",
        "revoke execute on function public.remove_program_roster_member(uuid, uuid, uuid) from public, anon;",
      ],
    ]) {
      const fn = codeOnly(getFn(marker, revokeMarker));
      expect(fn).not.toMatch(/insert into public\.payment_events/);
      expect(fn).not.toMatch(/amount_due_cents|amount_paid_cents/);
      expect(fn).not.toMatch(/perform public\.(record_refund|waive_payment|void_payment_obligation)/);
    }
  });

  it("both preserve their own Program-row-first lock, role/ownership authorization, and materialization/waitlist behavior — the guard is a pure addition, not a replacement of any existing check", () => {
    for (const [marker, revokeMarker] of [
      [
        "create or replace function public.remove_program_member(p_program_id uuid, p_profile_id uuid)",
        "revoke execute on function public.remove_program_member(uuid, uuid) from public, anon;",
      ],
      [
        "create or replace function public.remove_program_roster_member(p_program_id uuid, p_expected_club_id uuid, p_roster_member_id uuid)",
        "revoke execute on function public.remove_program_roster_member(uuid, uuid, uuid) from public, anon;",
      ],
    ]) {
      const fn = getFn(marker, revokeMarker);
      expect(fn).toContain("for update;");
      expect(fn).toContain("v_role not in ('admin', 'pro', 'staff')");
      expect(fn).toContain("_cancel_program_member_future_participation");
      expect(fn).toContain("_advance_program_waitlist_offer");
    }
  });
});

describe("removeProgramMember / removeProgramRosterMember Server Actions both resolve-then-retry on the guard's error", () => {
  it("removeProgramMember catches OPEN_CHECKOUT_REQUIRES_RESOLUTION and retries remove_program_member exactly once", () => {
    const s = readSource(ROSTER_ACTIONS);
    const fnIdx = s.indexOf("export async function removeProgramMember(");
    const nextFnIdx = s.indexOf("export async function addProgramRosterMember(");
    const fn = s.slice(fnIdx, nextFnIdx);
    expect(fn).toContain("error?.message.includes(OPEN_CHECKOUT_REQUIRES_RESOLUTION)");
    const occurrences = fn.split('"remove_program_member"').length - 1;
    expect(occurrences).toBe(2);
  });

  it("removeProgramRosterMember catches OPEN_CHECKOUT_REQUIRES_RESOLUTION and retries remove_program_roster_member exactly once", () => {
    const s = readSource(ROSTER_ACTIONS);
    const fnIdx = s.indexOf("export async function removeProgramRosterMember(");
    const nextFnIdx = s.indexOf("export async function forceConfirmProgramRosterMember(");
    const fn = s.slice(fnIdx, nextFnIdx);
    expect(fn).toContain("error?.message.includes(OPEN_CHECKOUT_REQUIRES_RESOLUTION)");
    const occurrences = fn.split('"remove_program_roster_member"').length - 1;
    expect(occurrences).toBe(2);
  });

  it("both resolve the blocking payment id via the SAME sanitized batched read boundary (fetchPaymentStates) every other program-payment surface uses — never a raw table query for the payment id", () => {
    const s = readSource(ROSTER_ACTIONS);
    const occurrences = s.split('fetchPaymentStates("program_enrollment"').length - 1;
    expect(occurrences).toBe(2);
  });

  it("never duplicates Stripe invalidation logic — both import the shared resolveBlockingCheckoutBeforeMutation helper rather than reimplementing it", () => {
    const s = readSource(ROSTER_ACTIONS);
    expect(s).toContain('from "@/lib/stripe/checkoutInvalidation"');
    expect(s).not.toMatch(/checkout\.sessions\.(retrieve|expire)/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 12/13 — cancel_program: Program lock before fan-out guard, fan-out guard
// before cancellation mutation
// ═══════════════════════════════════════════════════════════════════════════

describe("cancel_program — fan-out stale-Checkout guard across every currently-enrolled Member (12, 13)", () => {
  const getFn = () => {
    const m = readSource(MIGRATION_PATH);
    const fnStart = m.indexOf("create or replace function public.cancel_program(p_program_id uuid)");
    const fnEnd = m.indexOf("\n$$;", fnStart) + "\n$$;".length;
    return m.slice(fnStart, fnEnd);
  };

  it("preserves all existing cancellation authorization/lifecycle checks (role, pro-ownership, program_not_cancellable) unmodified", () => {
    const fn = getFn();
    expect(fn).toContain("v_role not in ('admin', 'pro', 'staff')");
    expect(fn).toContain("v_role = 'pro' and v_program.created_by <> auth.uid()");
    expect(fn).toContain("v_program.archived_at is not null or v_program.status not in ('draft', 'active')");
    expect(fn).toContain("raise exception 'program_not_cancellable';");
  });

  it("12. the Program row lock precedes the fan-out guard — the guard's own scan is meaningless unless it runs under the same lock a concurrent Checkout attempt-open must also acquire first", () => {
    const fn = getFn();
    const lockIdx = fn.indexOf("for update;");
    const loopIdx = fn.indexOf("for v_payment_id_for_checkout_guard in");
    expect(lockIdx).toBeGreaterThan(-1);
    expect(loopIdx).toBeGreaterThan(lockIdx);
  });

  it("loops over every program_enrollments row currently 'enrolled', resolving each one's LATEST payment cycle, calling the same _invalidate_or_flag_open_checkout_attempt helper once per enrollment", () => {
    const fn = getFn();
    expect(fn).toContain("for v_payment_id_for_checkout_guard in");
    expect(fn).toContain("pe.status     = 'enrolled'");
    expect(fn).toContain("order by p.domain_id, p.obligation_cycle desc");
    expect(fn).toContain("perform public._invalidate_or_flag_open_checkout_attempt(v_payment_id_for_checkout_guard);\n  end loop;");
  });

  it("uses `distinct on (p.domain_id) ... order by p.domain_id, p.obligation_cycle desc` — exactly one (the latest) payment per enrollment, never re-guarding an old superseded cycle", () => {
    const fn = getFn();
    expect(fn).toContain("select distinct on (p.domain_id) p.id");
  });

  it("13. the fan-out loop runs BEFORE the programs status UPDATE — an invalid cancellation never expires a legitimate Session before Court Time knows the action would fail", () => {
    const fn = getFn();
    const loopIdx = fn.indexOf("for v_payment_id_for_checkout_guard in");
    const mutationIdx = fn.indexOf("update public.programs\n    set status = 'cancelled'");
    expect(loopIdx).toBeGreaterThan(-1);
    expect(loopIdx).toBeLessThan(mutationIdx);
  });

  it("still a pure DOMAIN mutation — the fan-out guard itself never touches amount_due_cents/amount_paid_cents/payment_events, and program_enrollments is never mutated by cancel_program at all (22)", () => {
    const fn = codeOnly(getFn());
    expect(fn).not.toMatch(/insert into public\.payment_events/);
    expect(fn).not.toMatch(/amount_due_cents|amount_paid_cents/);
    expect(fn).not.toMatch(/update public\.program_enrollments/);
    expect(fn).not.toMatch(/update program_enrollments\s+set/);
  });

  it("preserves the existing bulk session-cancellation behavior for generated events/reservations/offered participants unchanged", () => {
    const fn = getFn();
    expect(fn).toContain("update public.events\n      set status = 'cancelled', updated_at = now()");
    expect(fn).toContain("cancellation_kind = 'admin'");
    expect(fn).toContain("where event_id = any(v_cancelled_event_ids)\n        and status   = 'offered';");
  });
});

describe("resolveAllBlockingProgramCheckouts — bounded batch resolution, never an unbounded retry loop", () => {
  it("programsActions.ts's cancelProgram bounds its resolve-then-retry loop to at most 2 total attempts", () => {
    const s = readSource(PROGRAMS_ACTIONS);
    const fnIdx = s.indexOf("export async function cancelProgram(");
    const nextFnIdx = s.indexOf("export async function completeProgram(");
    const fn = s.slice(fnIdx, nextFnIdx);
    expect(fn).toMatch(/for \(let attempt = 0; attempt < 2 &&/);
    expect(fn).not.toMatch(/while\s*\(true\)/);
  });

  it("lists blocking attempts via the service-role-only preflight RPC, then resolves each via the EXISTING generic per-payment helper — never a duplicated Stripe algorithm", () => {
    const s = readSource(PROGRAMS_ACTIONS);
    expect(s).toContain('"list_program_blocking_checkout_attempts"');
    expect(s).toContain("resolveBlockingCheckoutBeforeMutation(payment_id, clubId)");
  });

  it("a resolution failure returns { ok: false } without ever calling cancel_program again — the Program is left exactly as it was rather than risk charging for a cancelled Program", () => {
    const s = readSource(PROGRAMS_ACTIONS);
    const fnIdx = s.indexOf("async function resolveAllBlockingProgramCheckouts(");
    const fn = s.slice(fnIdx, fnIdx + 1500);
    expect(fn).toContain("if (!resolved.ok) return { ok: false, error: resolved.error };");
  });

  it("reuses ONE generic Program-level listing RPC — list_program_blocking_checkout_attempts is called from exactly one place in the codebase (inside the single shared resolveAllBlockingProgramCheckouts helper), never duplicated per lifecycle action even though BOTH cancelProgram and archiveProgram now call that helper", () => {
    const s = readSource(PROGRAMS_ACTIONS);
    const occurrences = s.split('"list_program_blocking_checkout_attempts"').length - 1;
    expect(occurrences).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Race-ordering proof — both orders in which cancel_program and a
// concurrent Member Checkout attempt-open can acquire the programs row
// lock resolve safely
// ═══════════════════════════════════════════════════════════════════════════

describe("race-ordering proof — both orders in which cancel_program and a concurrent Member Checkout attempt-open can acquire the programs row lock resolve safely", () => {
  it("Cancellation wins the lock first: cancel_program's fan-out guard runs and commits (or rolls back if it finds a blocker) BEFORE releasing the lock; a concurrent open_program_payment_checkout_attempt, blocked on the same programs row, then proceeds and re-reads the Program fresh under its OWN lock — finding status no longer in ('active','completed') (now 'cancelled'), it raises program_not_payable before ever resolving an enrollment or payment", () => {
    const m = readSource(MIGRATION_PATH);
    const openFnStart = m.indexOf("create or replace function public.open_program_payment_checkout_attempt(");
    const openFnEnd = m.indexOf(
      "revoke execute on function public.open_program_payment_checkout_attempt(uuid, uuid, text, boolean, uuid) from public, anon, authenticated;",
    );
    const openFn = m.slice(openFnStart, openFnEnd);
    const lockIdx = openFn.indexOf("for update;");
    const payableCheckIdx = openFn.indexOf("raise exception 'program_not_payable';");
    const rosterLookupIdx = openFn.indexOf("from public.roster_members rm");
    expect(lockIdx).toBeGreaterThan(-1);
    expect(payableCheckIdx).toBeGreaterThan(lockIdx);
    expect(rosterLookupIdx).toBeGreaterThan(payableCheckIdx);
  });

  it("Checkout wins the lock first: it opens/reuses the attempt and commits (releasing the programs lock) — cancel_program, blocked on that same lock, then proceeds, re-acquires the lock, and its OWN fan-out scan (running fresh, post-commit) sees the just-opened attempt and runs _invalidate_or_flag_open_checkout_attempt against it BEFORE the programs status UPDATE", () => {
    const fn = getProgramFn();
    const lockIdx = fn.indexOf("for update;");
    const loopIdx = fn.indexOf("for v_payment_id_for_checkout_guard in");
    const mutationIdx = fn.indexOf("update public.programs\n    set status = 'cancelled'");
    expect(lockIdx).toBeGreaterThan(-1);
    expect(loopIdx).toBeGreaterThan(lockIdx);
    expect(loopIdx).toBeLessThan(mutationIdx);
  });

  it("the create/bind cleanup path still safely handles a remote Stripe Session created after its local attempt was invalidated — the SAME _invalidate_or_flag_open_checkout_attempt helper (0151, untouched by this migration) either safely cancels an unbound attempt locally or raises open_checkout_requires_resolution for a bound one, resolved via the unchanged webhook/reconciliation path exactly like every other domain", () => {
    const helper = readSource("supabase/migrations/0151_stale_checkout_invalidation.sql");
    const fnStart = helper.indexOf("create or replace function public._invalidate_or_flag_open_checkout_attempt(");
    const fnEnd = helper.indexOf("revoke all on function public._invalidate_or_flag_open_checkout_attempt(");
    const fn = helper.slice(fnStart, fnEnd);
    expect(fn).toContain("and status = 'open'");
    expect(fn).toContain("if v_attempt.stripe_checkout_session_id is null then");
    expect(fn).toContain("raise exception 'open_checkout_requires_resolution';");
  });

  function getProgramFn(): string {
    const m = readSource(MIGRATION_PATH);
    const fnStart = m.indexOf("create or replace function public.cancel_program(p_program_id uuid)");
    const fnEnd = m.indexOf("\n$$;", fnStart) + "\n$$;".length;
    return m.slice(fnStart, fnEnd);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 14 — rollback equality for all four overwritten RPCs (programmatic proof,
// mirroring the Python-script verification already run this checkpoint)
// ═══════════════════════════════════════════════════════════════════════════

describe("rollback equality — the documented rollback body for each of the four redefined functions is byte-identical to its true pre-0163 authoritative source (14)", () => {
  function normalize(block: string): string {
    return block
      .split("\n")
      .map((line) => {
        const trimmed = line.replace(/\s+$/, "");
        if (trimmed.startsWith("-- ")) return trimmed.slice(3);
        if (trimmed === "--") return "";
        return trimmed;
      })
      .join("\n")
      .trim();
  }

  it("leave_program rollback == 0115's own authoritative body + privilege statements", () => {
    const m = readSource(MIGRATION_PATH);
    const rbStart = m.indexOf("-- create or replace function public.leave_program");
    const rbEndMarker = "-- revoke execute on function public.leave_program(uuid) from public, anon;\n-- grant  execute on function public.leave_program(uuid) to authenticated;";
    const rbEnd = m.indexOf(rbEndMarker, rbStart) + rbEndMarker.length;
    const rollback = normalize(m.slice(rbStart, rbEnd));

    const m0115 = readSource(M0115_PATH);
    const authStart = m0115.indexOf("create or replace function public.leave_program");
    const authEndMarker = "revoke execute on function public.leave_program(uuid) from public, anon;\ngrant  execute on function public.leave_program(uuid) to authenticated;";
    const authEnd = m0115.indexOf(authEndMarker, authStart) + authEndMarker.length;
    const authoritative = normalize(m0115.slice(authStart, authEnd));

    expect(rollback).toBe(authoritative);
  });

  it("remove_program_member rollback == 0137's own authoritative body, and its restated privilege statements == 0115's original grant (0137 itself never restates them, relying on CREATE OR REPLACE preserving them)", () => {
    const m = readSource(MIGRATION_PATH);
    const rbStart = m.indexOf("-- CREATE OR REPLACE FUNCTION public.remove_program_member");
    const rbBodyEnd = m.indexOf("-- $function$;", rbStart) + "-- $function$;".length;
    const rollbackBody = normalize(m.slice(rbStart, rbBodyEnd));

    const m137 = readSource(M0137_PATH);
    const authStart = m137.indexOf("CREATE OR REPLACE FUNCTION public.remove_program_member");
    const authBodyEnd = m137.indexOf("$function$;", authStart) + "$function$;".length;
    const authoritativeBody = normalize(m137.slice(authStart, authBodyEnd));

    expect(rollbackBody).toBe(authoritativeBody);

    const rbPriv = "-- revoke execute on function public.remove_program_member(uuid, uuid) from public, anon;\n-- grant  execute on function public.remove_program_member(uuid, uuid) to authenticated;";
    expect(m).toContain(rbPriv);
    const m0115 = readSource(M0115_PATH);
    expect(m0115).toContain("revoke execute on function public.remove_program_member(uuid, uuid) from public, anon;\ngrant  execute on function public.remove_program_member(uuid, uuid) to authenticated;");
  });

  it("remove_program_roster_member rollback == 0137's own authoritative body, and its restated privilege statements == 0115's original grant", () => {
    const m = readSource(MIGRATION_PATH);
    const rbStart = m.indexOf("-- CREATE OR REPLACE FUNCTION public.remove_program_roster_member");
    const rbBodyEnd = m.indexOf("-- $function$;", rbStart) + "-- $function$;".length;
    const rollbackBody = normalize(m.slice(rbStart, rbBodyEnd));

    const m137 = readSource(M0137_PATH);
    const authStart = m137.indexOf("CREATE OR REPLACE FUNCTION public.remove_program_roster_member");
    const authBodyEnd = m137.indexOf("$function$;", authStart) + "$function$;".length;
    const authoritativeBody = normalize(m137.slice(authStart, authBodyEnd));

    expect(rollbackBody).toBe(authoritativeBody);

    const rbPriv = "-- revoke execute on function public.remove_program_roster_member(uuid, uuid, uuid) from public, anon;\n-- grant  execute on function public.remove_program_roster_member(uuid, uuid, uuid) to authenticated;";
    expect(m).toContain(rbPriv);
    const m0115 = readSource(M0115_PATH);
    expect(m0115).toContain("revoke execute on function public.remove_program_roster_member(uuid, uuid, uuid) from public, anon;\ngrant  execute on function public.remove_program_roster_member(uuid, uuid, uuid) to authenticated;");
  });

  it("cancel_program rollback body == 0137's own authoritative body; its restated privilege statements == 0094's original grant (the only migration that ever declared them — 0137 never restated them)", () => {
    const m = readSource(MIGRATION_PATH);
    const rbStart = m.indexOf("-- CREATE OR REPLACE FUNCTION public.cancel_program");
    const rbBodyEnd = m.indexOf("-- $function$;", rbStart) + "-- $function$;".length;
    const rollbackBody = normalize(m.slice(rbStart, rbBodyEnd));

    const m137 = readSource(M0137_PATH);
    const authStart = m137.indexOf("CREATE OR REPLACE FUNCTION public.cancel_program");
    const authBodyEnd = m137.indexOf("$function$;", authStart) + "$function$;".length;
    const authoritativeBody = normalize(m137.slice(authStart, authBodyEnd));

    expect(rollbackBody).toBe(authoritativeBody);

    const rbPriv = "-- revoke execute on function public.cancel_program(uuid) from public, anon;\n-- grant  execute on function public.cancel_program(uuid) to authenticated;";
    expect(m).toContain(rbPriv);
    const m0094 = readSource("supabase/migrations/0094_program_lifecycle.sql");
    expect(m0094).toContain("revoke execute on function public.cancel_program(uuid) from public, anon;");
    expect(m0094).toContain("grant  execute on function public.cancel_program(uuid) to authenticated;");
  });

  it("8. archive_program rollback body == 0137's own authoritative body; its restated privilege statements == 0094's original grant (the only migration that ever declared them — 0137 never restated them) — correction round", () => {
    const m = readSource(MIGRATION_PATH);
    const rbStart = m.indexOf("-- CREATE OR REPLACE FUNCTION public.archive_program");
    const rbBodyEnd = m.indexOf("-- $function$;", rbStart) + "-- $function$;".length;
    const rollbackBody = normalize(m.slice(rbStart, rbBodyEnd));

    const m137 = readSource(M0137_PATH);
    const authStart = m137.indexOf("CREATE OR REPLACE FUNCTION public.archive_program");
    const authBodyEnd = m137.indexOf("$function$;", authStart) + "$function$;".length;
    const authoritativeBody = normalize(m137.slice(authStart, authBodyEnd));

    expect(rollbackBody).toBe(authoritativeBody);

    const rbPriv = "-- revoke execute on function public.archive_program(uuid) from public, anon;\n-- grant  execute on function public.archive_program(uuid) to authenticated;";
    expect(m).toContain(rbPriv);
    const m0094 = readSource("supabase/migrations/0094_program_lifecycle.sql");
    expect(m0094).toContain("revoke execute on function public.archive_program(uuid) from public, anon;");
    expect(m0094).toContain("grant  execute on function public.archive_program(uuid) to authenticated;");
  });

  it("the LIVE (forward) archive_program differs from its own rollback-documented body by exactly the guard addition — never a silent, undocumented behavior change", () => {
    const m = readSource(MIGRATION_PATH);
    const liveStart = m.indexOf("create or replace function public.archive_program(p_program_id uuid)");
    const liveEnd = m.indexOf("revoke execute on function public.archive_program(uuid) from public, anon;", liveStart);
    const live = m.slice(liveStart, liveEnd);
    expect(live).toContain("v_payment_id_for_checkout_guard uuid;");
    expect(live).toContain("perform public._invalidate_or_flag_open_checkout_attempt(v_payment_id_for_checkout_guard);");
    // Every other check/mutation/audit_log call from the authoritative
    // 0137 body is still present, byte-for-byte.
    expect(live).toContain("raise exception 'already_archived';");
    expect(live).toContain("set archived_at = now(), archived_by = auth.uid(), updated_at = now()");
    expect(live).toContain("'archive_program', 'program', p_program_id");
  });

  it("new functions roll back via DROP FUNCTION, documented for all four new RPCs", () => {
    const m = readSource(MIGRATION_PATH);
    expect(m).toContain("drop function if exists public.get_program_payment_for_checkout(uuid);");
    expect(m).toContain("drop function if exists public.open_program_payment_checkout_attempt(uuid, uuid, text, boolean, uuid);");
    expect(m).toContain("drop function if exists public.supersede_program_checkout_attempt_and_open_fresh(uuid, uuid, uuid, text, boolean, uuid);");
    expect(m).toContain("drop function if exists public.list_program_blocking_checkout_attempts(uuid, uuid);");
  });

  it("the LIVE (forward) leave_program differs from its own rollback-documented body by exactly the guard addition — never a silent, undocumented behavior change", () => {
    const m = readSource(MIGRATION_PATH);
    const liveStart = m.indexOf("create or replace function public.leave_program(p_program_id uuid)");
    const liveEnd = m.indexOf("revoke execute on function public.leave_program(uuid) from public, anon;", liveStart);
    const live = m.slice(liveStart, liveEnd);
    expect(live).toContain("v_payment_id_for_checkout_guard uuid;");
    expect(live).toContain("perform public._invalidate_or_flag_open_checkout_attempt(v_payment_id_for_checkout_guard);");
    // Every other declared local and every audit_log/notification call from
    // the authoritative 0115 body is still present, byte-for-byte.
    expect(live).toContain("perform public._cancel_program_member_future_participation(p_program_id, v_roster_member_id, v_club_id);");
    expect(live).toContain("perform public._expire_stale_program_offers(p_program_id, v_club_id, v_program.title);");
    expect(live).toContain("perform public._advance_program_waitlist_offer(p_program_id, v_club_id, v_program.title);");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 15 — complete_program / unarchive_program remain unmodified;
// archive_program correction round — archive_program IS now redefined with
// its own Program-level fan-out guard (1, 2 below)
// ═══════════════════════════════════════════════════════════════════════════

describe("complete_program / unarchive_program are NOT redefined by 0163 — deliberate omission, not an oversight (15)", () => {
  it("0163 never contains a CREATE OR REPLACE for complete_program or unarchive_program", () => {
    const m = readSource(MIGRATION_PATH);
    expect(m).not.toMatch(/create or replace function public\.complete_program/);
    expect(m).not.toMatch(/create or replace function public\.unarchive_program/);
  });

  it("1. complete_program's own current (0137, untouched) body never touches program_enrollments or payments — a pure programs.status flip, so no guard was ever needed", () => {
    const m137 = readSource(M0137_PATH);
    const fnStart = m137.indexOf("CREATE OR REPLACE FUNCTION public.complete_program(");
    const fnEnd = m137.indexOf("$function$;", fnStart) + "$function$;".length;
    const fn = codeOnly(m137.slice(fnStart, fnEnd));
    expect(fn).not.toMatch(/program_enrollments|payments|payment_events/);
  });

  it("2. unarchive_program's own current (0137, untouched) body never restores status to 'active' — only ever clears archived_at/archived_by", () => {
    const m137 = readSource(M0137_PATH);
    const fnStart = m137.indexOf("CREATE OR REPLACE FUNCTION public.unarchive_program(");
    const fnEnd = m137.indexOf("$function$;", fnStart) + "$function$;".length;
    const fn = codeOnly(m137.slice(fnStart, fnEnd));
    expect(fn).not.toMatch(/set\s+[\s\S]{0,40}status\s*=\s*'active'/);
  });

  it("14. unarchiving a completed Program may restore fresh Pay Now eligibility (status stays 'completed', archived_at clears — back in the allowlist); a FRESH Checkout is opened through the normal machinery, never a resurrected old Session — unarchive_program's own body has no attempt-reopening/rebinding logic at all", () => {
    const m137 = readSource(M0137_PATH);
    const fnStart = m137.indexOf("CREATE OR REPLACE FUNCTION public.unarchive_program(");
    const fnEnd = m137.indexOf("$function$;", fnStart) + "$function$;".length;
    const fn = codeOnly(m137.slice(fnStart, fnEnd));
    expect(fn).not.toMatch(/payment_checkout_attempts|stripe_checkout_session|record_checkout_session_created/);
  });

  it("15. unarchiving a cancelled Program leaves Pay Now unavailable — status remains 'cancelled' regardless of archived_at, and unarchive_program never touches status at all (re-confirmed against the same body used for 2 above)", () => {
    const m137 = readSource(M0137_PATH);
    const fnStart = m137.indexOf("CREATE OR REPLACE FUNCTION public.unarchive_program(");
    const fnEnd = m137.indexOf("$function$;", fnStart) + "$function$;".length;
    const fn = m137.slice(fnStart, fnEnd);
    expect(fn).not.toMatch(/\bstatus\s*=/);
  });

  it("the Server Actions for the two untouched lifecycle mutations (completeProgram/unarchiveProgram) contain no Checkout-invalidation orchestration — no OPEN_CHECKOUT_REQUIRES_RESOLUTION handling, no resolveBlockingCheckoutBeforeMutation call, in either", () => {
    const s = readSource(PROGRAMS_ACTIONS);
    for (const fnName of ["completeProgram", "unarchiveProgram"]) {
      const fnIdx = s.indexOf(`export async function ${fnName}(`);
      expect(fnIdx, `${fnName} not found`).toBeGreaterThan(-1);
      const fnEnd = s.indexOf("\n}\n", fnIdx);
      const fn = s.slice(fnIdx, fnEnd);
      expect(fn).not.toMatch(/OPEN_CHECKOUT_REQUIRES_RESOLUTION|resolveBlockingCheckoutBeforeMutation|resolveAllBlockingProgramCheckouts/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// archive_program correction round — archive_program IS redefined, closing
// the defect where a completed Program's still-open Checkout (deliberately
// never invalidated by complete_program) could otherwise survive archiving
// (3, 4, 5, 6, 7, 8)
// ═══════════════════════════════════════════════════════════════════════════

describe("archive_program IS redefined by 0163, with its own Program-level fan-out guard mirroring cancel_program's exactly (3, 4, 5, 6)", () => {
  const getFn = () => {
    const m = readSource(MIGRATION_PATH);
    const fnStart = m.indexOf("create or replace function public.archive_program(p_program_id uuid)");
    const fnEnd = m.indexOf("\n$$;", fnStart) + "\n$$;".length;
    return m.slice(fnStart, fnEnd);
  };

  it("3. 0163 DOES contain a CREATE OR REPLACE for archive_program", () => {
    const m = readSource(MIGRATION_PATH);
    expect(m).toMatch(/create or replace function public\.archive_program\(p_program_id uuid\)/);
  });

  it("preserves all existing authorization/lifecycle checks unmodified: role allowlist, pro-ownership rule, already_archived, program_not_archivable (status IN ('cancelled','completed'))", () => {
    const fn = getFn();
    expect(fn).toContain("v_role not in ('admin', 'pro', 'staff')");
    expect(fn).toContain("v_role = 'pro' and v_program.created_by <> auth.uid()");
    expect(fn).toContain("raise exception 'already_archived';");
    expect(fn).toContain("v_program.status not in ('cancelled', 'completed')");
    expect(fn).toContain("raise exception 'program_not_archivable';");
  });

  it("4. keeps Program-row-first locking — the programs row is locked (for update) before any authorization/precondition check that depends on its data", () => {
    const fn = getFn();
    const lockIdx = fn.indexOf("for update;");
    const notFoundIdx = fn.indexOf("raise exception 'program_not_found';");
    expect(lockIdx).toBeGreaterThan(-1);
    expect(notFoundIdx).toBeGreaterThan(lockIdx);
  });

  it("5. the fan-out guard runs AFTER authorization/preconditions succeed (already_archived and program_not_archivable both already raised for a non-archivable Program)", () => {
    const fn = getFn();
    const archivableCheckIdx = fn.indexOf("raise exception 'program_not_archivable';");
    const loopIdx = fn.indexOf("for v_payment_id_for_checkout_guard in");
    expect(archivableCheckIdx).toBeGreaterThan(-1);
    expect(loopIdx).toBeGreaterThan(archivableCheckIdx);
  });

  it("6. the fan-out guard runs BEFORE the archived_at/archived_by mutation — an invalid archive never expires a legitimate Session before Court Time knows the action would fail", () => {
    const fn = getFn();
    const loopIdx = fn.indexOf("for v_payment_id_for_checkout_guard in");
    const mutationIdx = fn.indexOf("set archived_at = now()");
    expect(loopIdx).toBeGreaterThan(-1);
    expect(loopIdx).toBeLessThan(mutationIdx);
  });

  it("uses the IDENTICAL fan-out idiom as cancel_program: every CURRENTLY 'enrolled' program_enrollments row, latest payment cycle via distinct on (p.domain_id) ... order by p.domain_id, p.obligation_cycle desc, one _invalidate_or_flag_open_checkout_attempt call per enrollment", () => {
    const fn = getFn();
    expect(fn).toContain("select distinct on (p.domain_id) p.id");
    expect(fn).toContain("pe.status     = 'enrolled'");
    expect(fn).toContain("order by p.domain_id, p.obligation_cycle desc");
    expect(fn).toContain("perform public._invalidate_or_flag_open_checkout_attempt(v_payment_id_for_checkout_guard);\n  end loop;");
  });

  it("7. still a pure DOMAIN mutation — the guard itself never touches amount_due_cents/amount_paid_cents/payment_events, and never inserts a payment_events row, refunds, waives, or voids anything", () => {
    const fn = codeOnly(getFn());
    expect(fn).not.toMatch(/insert into public\.payment_events/);
    expect(fn).not.toMatch(/amount_due_cents|amount_paid_cents/);
    expect(fn).not.toMatch(/perform public\.(record_refund|waive_payment|void_payment_obligation)/);
  });

  it("preserves the exact original mutation, audit_log entry, and return shape — archived_at/archived_by/updated_at set, 'archive_program' audit action, v_result returned", () => {
    const fn = getFn();
    expect(fn).toContain("set archived_at = now(), archived_by = auth.uid(), updated_at = now()");
    expect(fn).toContain("'archive_program', 'program', p_program_id");
    expect(fn).toContain("return v_result;");
  });

  it("grants execute only to authenticated — same pre-existing privilege, never widened", () => {
    const m = readSource(MIGRATION_PATH);
    expect(m).toContain("revoke execute on function public.archive_program(uuid) from public, anon;");
    expect(m).toContain("grant  execute on function public.archive_program(uuid) to authenticated;");
  });
});

describe("archive_program's Program-row-first lock ordering is consistent with every other guarded Program mutation in 0163", () => {
  it("archive_program locks programs via `for update` early in its body, matching leave_program/remove_program_member/remove_program_roster_member/cancel_program's own established ordering", () => {
    const m = readSource(MIGRATION_PATH);
    const marker = "create or replace function public.archive_program(p_program_id uuid)";
    const start = m.indexOf(marker);
    expect(start).toBeGreaterThan(-1);
    const beginIdx = m.indexOf("\nbegin\n", start);
    expect(beginIdx).toBeGreaterThan(start);
    const nextForUpdate = m.indexOf("for update", beginIdx);
    expect(nextForUpdate).toBeGreaterThan(beginIdx);
    const codeSlice = codeOnly(m.slice(beginIdx, nextForUpdate + "for update".length));
    expect(codeSlice.length).toBeLessThan(900);
  });
});

describe("archiveProgram Server Action — bounded batch resolution, reusing the SAME generic primitives cancelProgram uses (9, 10)", () => {
  it("9. uses the SAME generic list_program_blocking_checkout_attempts RPC via the shared resolveAllBlockingProgramCheckouts helper — no second listing RPC added", () => {
    const s = readSource(PROGRAMS_ACTIONS);
    const occurrences = s.split('"list_program_blocking_checkout_attempts"').length - 1;
    expect(occurrences).toBe(1);

    const fnIdx = s.indexOf("export async function archiveProgram(");
    const nextFnIdx = s.indexOf("// ─── Pricing", fnIdx) === -1 ? s.length : s.indexOf("// ─── Pricing", fnIdx);
    const fn = s.slice(fnIdx, nextFnIdx);
    expect(fn).toContain("resolveAllBlockingProgramCheckouts(params.p_program_id, expectedClubId)");
  });

  it("10. bounds its resolve-then-retry loop to at most 2 total attempts — never an unbounded loop", () => {
    const s = readSource(PROGRAMS_ACTIONS);
    const fnIdx = s.indexOf("export async function archiveProgram(");
    const nextFnIdx = s.indexOf("// ─── Pricing", fnIdx) === -1 ? s.length : s.indexOf("// ─── Pricing", fnIdx);
    const fn = s.slice(fnIdx, nextFnIdx);
    expect(fn).toMatch(/for \(let attempt = 0; attempt < 2 &&/);
    expect(fn).not.toMatch(/while\s*\(true\)/);
  });

  it("catches OPEN_CHECKOUT_REQUIRES_RESOLUTION and retries archive_program exactly once per bounded attempt", () => {
    const s = readSource(PROGRAMS_ACTIONS);
    const fnIdx = s.indexOf("export async function archiveProgram(");
    const nextFnIdx = s.indexOf("// ─── Pricing", fnIdx) === -1 ? s.length : s.indexOf("// ─── Pricing", fnIdx);
    const fn = s.slice(fnIdx, nextFnIdx);
    expect(fn).toContain("error?.message.includes(OPEN_CHECKOUT_REQUIRES_RESOLUTION)");
    const occurrences = fn.split('"archive_program"').length - 1;
    expect(occurrences).toBe(2);
  });

  it("11. a resolution failure returns { ok: false } without ever calling archive_program again — the archive cannot commit until every blocking Session is proven nonpayable", () => {
    const s = readSource(PROGRAMS_ACTIONS);
    const fnIdx = s.indexOf("export async function archiveProgram(");
    const nextFnIdx = s.indexOf("// ─── Pricing", fnIdx) === -1 ? s.length : s.indexOf("// ─── Pricing", fnIdx);
    const fn = s.slice(fnIdx, nextFnIdx);
    expect(fn).toContain("if (!resolved.ok) return { error: { message: resolved.error } };");
  });

  it("reuses the exact same resolveAllBlockingProgramCheckouts helper cancelProgram calls — never a second, duplicated Program batch-resolution implementation", () => {
    const s = readSource(PROGRAMS_ACTIONS);
    const occurrences = s.split("resolveAllBlockingProgramCheckouts(").length - 1;
    // Exactly 1 definition + 2 call sites (cancelProgram, archiveProgram).
    expect(occurrences).toBe(3);
  });
});

describe("archive/Checkout race-order proof — both orders in which archive_program and a concurrent Member Checkout attempt-open can acquire the programs row lock resolve safely (12)", () => {
  it("Checkout wins the lock first: open_program_payment_checkout_attempt verifies completed+unarchived, opens/reuses the attempt, and commits (releasing the programs lock) — archive_program, blocked on that same lock, then proceeds, re-acquires the lock, and its OWN fan-out scan (running fresh, post-commit) sees the just-opened attempt and runs _invalidate_or_flag_open_checkout_attempt against it BEFORE the archived_at mutation; archive only commits once that Session is proven nonpayable (via the Server Action's resolve-then-retry)", () => {
    const m = readSource(MIGRATION_PATH);
    const fnStart = m.indexOf("create or replace function public.archive_program(p_program_id uuid)");
    const fnEnd = m.indexOf("\n$$;", fnStart) + "\n$$;".length;
    const fn = m.slice(fnStart, fnEnd);
    const lockIdx = fn.indexOf("for update;");
    const loopIdx = fn.indexOf("for v_payment_id_for_checkout_guard in");
    const mutationIdx = fn.indexOf("set archived_at = now()");
    expect(lockIdx).toBeGreaterThan(-1);
    expect(loopIdx).toBeGreaterThan(lockIdx);
    expect(loopIdx).toBeLessThan(mutationIdx);
  });

  it("Archive wins the lock first: archive_program's fan-out guard resolves/invalidates every currently-blocking attempt, sets archived_at, and commits — a concurrent open_program_payment_checkout_attempt, blocked on the same programs row, then proceeds and re-reads the Program fresh under its OWN lock, finding archived_at is no longer null, and raises program_not_payable before ever resolving an enrollment or payment — no new payable Program Checkout is ever authorized against an archived Program", () => {
    const m = readSource(MIGRATION_PATH);
    const openFnStart = m.indexOf("create or replace function public.open_program_payment_checkout_attempt(");
    const openFnEnd = m.indexOf(
      "revoke execute on function public.open_program_payment_checkout_attempt(uuid, uuid, text, boolean, uuid) from public, anon, authenticated;",
    );
    const openFn = m.slice(openFnStart, openFnEnd);
    const lockIdx = openFn.indexOf("for update;");
    const payableCheckIdx = openFn.indexOf("raise exception 'program_not_payable';");
    expect(lockIdx).toBeGreaterThan(-1);
    expect(payableCheckIdx).toBeGreaterThan(lockIdx);
    // The payable check is the SAME predicate that already tests
    // archived_at is not null (see the 4/5/6/7/8 eligibility describe
    // block above) — re-confirmed here in the specific archive-race
    // context.
    expect(openFn).toContain("v_program_status not in ('active', 'completed') or v_program_archived_at is not null");
  });

  it("harmless unbound-attempt race, consistent with Event architecture: archive may invalidate a still-unbound local attempt via the SAME _invalidate_or_flag_open_checkout_attempt helper (0151, untouched) — a later Stripe bind attempt against a now-canceled local attempt row fails closed (record_checkout_session_created requires an 'open' attempt), so the Member can never receive a usable checkout URL for an invalidated attempt", () => {
    const helper = readSource("supabase/migrations/0151_stale_checkout_invalidation.sql");
    const fnStart = helper.indexOf("create or replace function public._invalidate_or_flag_open_checkout_attempt(");
    const fnEnd = helper.indexOf("revoke all on function public._invalidate_or_flag_open_checkout_attempt(");
    const fn = helper.slice(fnStart, fnEnd);
    expect(fn).toContain("and status = 'open'");
    expect(fn).toContain("if v_attempt.stripe_checkout_session_id is null then");
    // Unbound path: locally canceled without raising — no
    // open_checkout_requires_resolution for an attempt Stripe was never
    // told about.
    expect(fn).toMatch(/status\s*=\s*'canceled'/);
  });
});

describe("cancelled → archived remains valid and harmless (13)", () => {
  it("13. archive_program's fan-out guard is a structural no-op on an already-cancelled Program: cancel_program's own guard already resolved every blocking Checkout as a precondition of that cancellation succeeding, so no CURRENTLY 'enrolled' row can still have a bound attempt by the time archive_program runs — no special-casing was added to archive_program's own body (per instruction: don't special-case unless the authoritative body requires it), and none was needed", () => {
    const m = readSource(MIGRATION_PATH);
    const fnStart = m.indexOf("create or replace function public.archive_program(p_program_id uuid)");
    const fnEnd = m.indexOf("\n$$;", fnStart) + "\n$$;".length;
    const fn = m.slice(fnStart, fnEnd);
    // The guard is unconditional (not branched on v_program.status) —
    // identical loop runs regardless of whether the archivable Program is
    // 'cancelled' or 'completed'.
    expect(fn).not.toMatch(/if v_program\.status = 'cancelled'/);
    expect(fn).not.toMatch(/if v_program\.status = 'completed'/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 16 — generated session edits do not gain Program Checkout invalidation
// ═══════════════════════════════════════════════════════════════════════════

describe("update_event / cancel_event (0161) gain NO Program-enrollment stale-Checkout guard — session-level edits/cancellations never invalidate the whole-Program Checkout (16)", () => {
  it("0161 is not touched by this migration at all — 0163 contains no CREATE OR REPLACE for update_event or cancel_event", () => {
    const m = readSource(MIGRATION_PATH);
    expect(m).not.toMatch(/create or replace function public\.update_event/);
    expect(m).not.toMatch(/create or replace function public\.cancel_event\(/);
  });

  it("0161's own update_event/cancel_event bodies never reference program_enrollment domain_type or program_enrollments at all", () => {
    const m161 = readSource(EVENT_MIGRATION_PATH);
    const updateStart = m161.indexOf("create or replace function public.update_event(p_event_id uuid, p_expected_club_id uuid,");
    const updateEnd = m161.indexOf("\n$$;", updateStart) + "\n$$;".length;
    const updateFn = m161.slice(updateStart, updateEnd);
    expect(updateFn).not.toMatch(/program_enrollment/);

    const cancelStart = m161.indexOf("create or replace function public.cancel_event(p_event_id uuid)");
    const cancelEnd = m161.indexOf("\n$$;", cancelStart) + "\n$$;".length;
    const cancelFn = m161.slice(cancelStart, cancelEnd);
    expect(cancelFn).not.toMatch(/program_enrollment/);
  });

  it("_materialize_program_member_into_future_events (latest def. in 0113, untouched) never sets a price or calls _create_payment_obligation — whole-program enrollees' session-level event_participants rows carry zero independent financial weight, which is WHY no guard is needed here at all, not merely that one wasn't added", () => {
    const m113 = readSource("supabase/migrations/0113_staff_managed_events_identity.sql");
    const fnStart = m113.indexOf("create or replace function public._materialize_program_member_into_future_events(");
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = m113.indexOf("\n$$;", fnStart) + "\n$$;".length;
    const fn = m113.slice(fnStart, fnEnd);
    expect(fn).not.toMatch(/_create_payment_obligation|price_amount_cents\s*=|price/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 17 — set_program_price remains future-enrollment-only
// ═══════════════════════════════════════════════════════════════════════════

describe("set_program_price remains future-enrollment-only — untouched by this migration (17)", () => {
  it("0163 never redefines set_program_price", () => {
    const m = readSource(MIGRATION_PATH);
    expect(m).not.toMatch(/create or replace function public\.set_program_price/);
  });

  it("set_program_price's own current body only ever updates programs.price_amount_cents — never program_enrollments.price_amount_cents, never payments, never a new obligation cycle", () => {
    const m142 = readSource("supabase/migrations/0142_program_pricing.sql");
    const fnStart = m142.indexOf("create or replace function public.set_program_price(");
    const fnEnd = m142.indexOf("revoke execute on function public.set_program_price(", fnStart);
    const fn = m142.slice(fnStart, fnEnd);
    expect(fn).toMatch(/update public\.programs\s*\n\s*set price_amount_cents = p_price_amount_cents/);
    expect(fn).not.toMatch(/program_enrollments|payments|payment_events|_create_payment_obligation|_adjust_payment_obligation/);
  });

  it("setProgramPriceAction Server Action contains no Checkout-invalidation orchestration — nothing to invalidate since no existing enrollment is ever repriced", () => {
    const s = readSource(PROGRAMS_ACTIONS);
    const fnIdx = s.indexOf("export async function setProgramPriceAction(");
    const fnEnd = s.indexOf("\n}\n", fnIdx);
    const fn = s.slice(fnIdx, fnEnd);
    expect(fn).not.toMatch(/OPEN_CHECKOUT_REQUIRES_RESOLUTION|resolveBlockingCheckoutBeforeMutation/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 18 — Program Checkout does not affect Lesson/Event/Reservation Checkout
// ═══════════════════════════════════════════════════════════════════════════

describe("Program Checkout does not affect Lesson/Event/Reservation Checkout (18)", () => {
  it("0163 contains no code touching reservations/lesson_requests/event_participants domain types — only explanatory prose (comments) references them for contrast", () => {
    const m = codeOnly(readSource(MIGRATION_PATH));
    expect(m).not.toMatch(/'lesson_request'|'reservation'|'event_participant'/);
    expect(m).not.toMatch(/create or replace function public\.(get_lesson_payment_for_checkout|get_event_payment_for_checkout|get_reservation_payment_for_checkout|open_event_payment_checkout_attempt|open_lesson_payment_checkout_attempt|cancel_event\(|cancel_lesson)/);
  });

  it("0163 never redefines the shared generic RPCs (open_payment_checkout_attempt, supersede_checkout_attempt_and_open_fresh, _invalidate_or_flag_open_checkout_attempt, process_stripe_payment_event) — only calls them by name from the new Program wrappers", () => {
    const m = readSource(MIGRATION_PATH);
    expect(m).not.toMatch(/create or replace function public\.open_payment_checkout_attempt\(/);
    expect(m).not.toMatch(/create or replace function public\.supersede_checkout_attempt_and_open_fresh\(/);
    expect(m).not.toMatch(/create or replace function public\._invalidate_or_flag_open_checkout_attempt\(/);
    expect(m).not.toMatch(/create or replace function public\.process_stripe_payment_event\(/);
  });

  it("programCheckoutActions.ts is a wholly separate module from eventCheckoutActions.ts/lessonCheckoutActions.ts/reservationCheckoutActions.ts — no shared mutable state, no cross-import between domain-specific action files", () => {
    const s = readSource(ACTION_PATH);
    expect(s).not.toMatch(/from ["']\.\/eventCheckoutActions["']/);
    expect(s).not.toMatch(/from ["'].*lessonCheckoutActions["']/);
    expect(s).not.toMatch(/from ["'].*reservationCheckoutActions["']/);
  });

  it("paymentsConfig.ts's Program builders are additive — the Reservation/Lesson/Event builders immediately above are untouched in this same file", () => {
    const s = readSource(PAYMENTS_CONFIG_PATH);
    expect(s).toContain("export function buildReservationCheckoutSessionParams(");
    expect(s).toContain("export function buildLessonCheckoutSessionParams(");
    expect(s).toContain("export function buildEventCheckoutSessionParams(");
    expect(s).toContain("export function buildProgramCheckoutSessionParams(");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 19 — privileges for all new functions
// ═══════════════════════════════════════════════════════════════════════════

describe("privilege matrix — every new function grants execute to exactly the intended role, nothing broader (19)", () => {
  it("get_program_payment_for_checkout: authenticated only", () => {
    const m = readSource(MIGRATION_PATH);
    expect(m).toContain("revoke execute on function public.get_program_payment_for_checkout(uuid) from public, anon;");
    expect(m).toContain("grant  execute on function public.get_program_payment_for_checkout(uuid) to authenticated;");
  });

  it("open_program_payment_checkout_attempt / supersede_program_checkout_attempt_and_open_fresh / list_program_blocking_checkout_attempts: service_role only, explicitly revoked from authenticated too (not just public/anon)", () => {
    const m = readSource(MIGRATION_PATH);
    for (const [sig] of [
      ["open_program_payment_checkout_attempt(uuid, uuid, text, boolean, uuid)"],
      ["supersede_program_checkout_attempt_and_open_fresh(uuid, uuid, uuid, text, boolean, uuid)"],
      ["list_program_blocking_checkout_attempts(uuid, uuid)"],
    ]) {
      expect(m).toContain(`revoke execute on function public.${sig} from public, anon, authenticated;`);
      expect(m).toContain(`grant  execute on function public.${sig} to service_role;`);
    }
  });

  it("the four redefined functions keep their pre-existing authenticated-only privilege — never widened to public/anon/service_role as a side effect of redefinition", () => {
    const m = readSource(MIGRATION_PATH);
    for (const sig of ["leave_program(uuid)", "remove_program_member(uuid, uuid)", "remove_program_roster_member(uuid, uuid, uuid)", "cancel_program(uuid)"]) {
      expect(m).toContain(`revoke execute on function public.${sig} from public, anon;`);
      expect(m).toContain(`grant  execute on function public.${sig} to authenticated;`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 20 — return-route behavior
// ═══════════════════════════════════════════════════════════════════════════

describe("return-route behavior — /events only, history.replaceState not router.replace (20)", () => {
  it("buildProgramCheckoutReturnUrls targets /events, never /calendar or /my-schedule", () => {
    const s = readSource(PAYMENTS_CONFIG_PATH);
    const fnIdx = s.indexOf("export function buildProgramCheckoutReturnUrls(");
    const fnEnd = s.indexOf("\n}\n", fnIdx);
    const fn = s.slice(fnIdx, fnEnd);
    expect(fn).toContain("${siteUrl}/events?checkout=success&program=${programId}");
    expect(fn).toContain("${siteUrl}/events?checkout=cancel&program=${programId}");
    expect(fn).not.toMatch(/\/calendar|\/my-schedule/);
  });

  it("does not embed a date-jump parameter — /events is a flat upcoming-programs list, not date-navigated like /calendar", () => {
    const s = readSource(PAYMENTS_CONFIG_PATH);
    const fnIdx = s.indexOf("export function buildProgramCheckoutReturnUrls(");
    const fnEnd = s.indexOf("\n}\n", fnIdx);
    const fn = s.slice(fnIdx, fnEnd);
    expect(fn).not.toMatch(/date=/);
  });

  it("events/page.tsx parses ?checkout=success&program=<uuid> with the same uuid-validated, success-gated derivation as Calendar/Lessons' own established convention", () => {
    const s = readSource(EVENTS_PAGE_PATH);
    expect(s).toContain('const checkoutParam = typeof sp.checkout === "string" ? sp.checkout : null;');
    expect(s).toContain('const programParam  = typeof sp.program === "string" ? sp.program : null;');
    expect(s).toContain('checkoutParam === "success" && programParam && uuidRe.test(programParam) ? programParam : null;');
  });

  it("EventsUpcomingClient's own return-flow effect uses window.history.replaceState, mirroring the 34F-A lesson-navigation fix — never router.replace, which the 34F-A runtime QA found forces a visible double Server Component re-fetch", () => {
    const s = readSource(EVENTS_UPCOMING_PATH);
    const start = s.indexOf("if (!initialCheckoutProgramId) return;");
    const end = s.indexOf("}, []);", start) + "}, []);".length;
    const effect = s.slice(start, end);
    expect(effect).toContain('window.history.replaceState(null, "", "/events");');
    expect(effect).not.toMatch(/router\.replace/);
  });

  it("no second Program detail/payment surface is created — ProgramEnrollmentCard is already inline on /events for every program the caller has a stake in, so the return effect needs no sheet-opening logic", () => {
    const s = readSource(EVENTS_UPCOMING_PATH);
    const start = s.indexOf("if (!initialCheckoutProgramId) return;");
    const end = s.indexOf("}, []);", start) + "}, []);".length;
    const effect = s.slice(start, end);
    expect(effect).not.toMatch(/setSelected|supabase\s*\n?\s*\.from/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// One canonical Member payment surface (G in the spec)
// ═══════════════════════════════════════════════════════════════════════════

describe("one canonical Member Program Pay Now surface — ProgramEnrollmentCard only", () => {
  it("programCheckoutActions is imported/used only by ProgramEnrollmentCard.tsx, not by any Admin roster/program-management surface", () => {
    const cardSrc = readSource(PROGRAM_CARD_PATH);
    expect(cardSrc).toContain('from "./programCheckoutActions"');

    for (const path of [
      "src/app/(app)/events/ProgramRosterSheet.tsx",
      "src/app/(app)/events/ProgramsManageClient.tsx",
    ]) {
      const s = readSource(path);
      expect(s).not.toMatch(/programCheckoutActions|createProgramCheckoutAction|Pay Now/);
    }
  });

  it("/my-schedule contains no Program Pay Now action — it remains read-only and links back to /events", () => {
    const s = readSource("src/app/(app)/my-schedule/page.tsx");
    expect(s).not.toMatch(/programCheckoutActions|createProgramCheckoutAction/);
    expect(s).toContain('href: "/events"');
  });

  it("CalendarShell/EventDetailSheet (the /calendar surface) contain no Program Checkout wiring — a generated session's own detail sheet never gains a Program-level Pay Now button", () => {
    for (const path of ["src/app/(app)/calendar/CalendarShell.tsx", "src/app/(app)/calendar/EventDetailSheet.tsx"]) {
      const s = readSource(path);
      expect(s).not.toMatch(/programCheckoutActions|createProgramCheckoutAction|get_program_payment_for_checkout/);
    }
  });

  it("the Pay Now button itself renders only for status === 'enrolled' — never waitlisted, offered, or a different Member's own card (which this component never receives in the first place, since program.my_enrollment is always the CALLER's own row)", () => {
    const s = readSource(PROGRAM_CARD_PATH);
    const idx = s.indexOf('{status === "enrolled" && paymentState && (');
    expect(idx).toBeGreaterThan(-1);
    const block = s.slice(idx, s.indexOf("{checkoutError &&", idx));
    expect(block).toContain("checkoutEligible && isPaymentOpenForRecording(paymentState)");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// getMemberPrograms widening — completed-but-enrolled programs surface too
// ═══════════════════════════════════════════════════════════════════════════

describe("getMemberPrograms — widened to surface a completed, non-archived Program the caller is still 'enrolled' in (needed for 5/G: completed Programs retain Pay Now)", () => {
  const src = () => readSource(ENROLLMENT_ACTIONS);

  it("fetches an additional 'completed' branch, separate from the pre-existing 'active' browsable/joinable query", () => {
    const s = src();
    expect(s).toContain('.eq("status", "active")');
    expect(s).toContain('.eq("status", "completed")');
  });

  it("the completed branch is still scoped to enrollment_model='program' and archived_at is null — the same domain/lifecycle boundary as the active branch", () => {
    const s = src();
    const idx = s.indexOf('.eq("status", "completed")');
    const block = s.slice(Math.max(0, idx - 300), idx + 100);
    expect(block).toContain('.eq("enrollment_model", "program")');
    expect(block).toContain('.is("archived_at", null)');
  });

  it("a completed program is only kept in the final result if the caller's own enrollment status is exactly 'enrolled' — never merely because they were once waitlisted/offered/cancelled, and never for a completed program they have no history with", () => {
    const s = src();
    expect(s).toContain('.filter(p => !completedProgramIds.has(p.id) || enrollmentByProgram.get(p.id)?.status === "enrolled")');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 22 — no financial mutation on cancellation/withdrawal/removal, anywhere
// ═══════════════════════════════════════════════════════════════════════════

describe("domain lifecycle stays separate from financial lifecycle — no automatic refund/waive/void anywhere in 0163 (22)", () => {
  it("no refund/waive/void RPC is ever called from within 0163's own guarded functions", () => {
    const m = codeOnly(readSource(MIGRATION_PATH));
    expect(m).not.toMatch(/perform public\.(record_refund|waive_payment|void_payment_obligation)/);
  });

  it("_invalidate_or_flag_open_checkout_attempt itself is untouched by this migration (not redefined) — the guard reuses the existing, already-proven helper verbatim", () => {
    const m = readSource(MIGRATION_PATH);
    expect(m).not.toMatch(/create or replace function public\._invalidate_or_flag_open_checkout_attempt/);
  });

  it("none of the four TS Server Actions with a resolve-then-retry pattern (leaveProgram, removeProgramMember, removeProgramRosterMember, cancelProgram) ever call a record/refund/waive/void payment action themselves — resolution is exclusively via the shared Stripe-session-expiry helper", () => {
    for (const [path, fnName, nextFnMarker] of [
      [ENROLLMENT_ACTIONS, "export async function leaveProgram(", "export async function acceptProgramOffer("],
      [ROSTER_ACTIONS, "export async function removeProgramMember(", "export async function addProgramRosterMember("],
      [ROSTER_ACTIONS, "export async function removeProgramRosterMember(", "export async function forceConfirmProgramRosterMember("],
      [PROGRAMS_ACTIONS, "export async function cancelProgram(", "export async function completeProgram("],
    ]) {
      const s = readSource(path);
      const fnIdx = s.indexOf(fnName);
      const nextIdx = s.indexOf(nextFnMarker);
      const fn = s.slice(fnIdx, nextIdx);
      expect(fn).not.toMatch(/recordManualPayment|waivePayment|voidPaymentObligation|refund/i);
    }
  });
});
