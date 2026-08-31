import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 34F-B — regression coverage for event_participant Checkout,
// mirroring lessonCheckout.regression.test.ts's own established source-
// inspection style (this repository's vitest baseline is deliberately
// pure-TypeScript, no jsdom/Supabase/network mocking — for "does the
// shipped code actually take this shape" questions, reading the real
// source is a more honest guard than reimplementing a parallel mock).
//
// This is domain EXPANSION, not a parallel Stripe implementation: nearly
// every assertion below confirms eventCheckoutActions.ts reuses the SAME
// service-role RPCs (open_payment_checkout_attempt, supersede_checkout_
// attempt_and_open_fresh, record_checkout_session_created) and the SAME
// pure eligibility/expiry/remaining-balance helpers reservations/lessons
// use — the only genuinely new surface is get_event_payment_for_checkout /
// open_event_payment_checkout_attempt / supersede_event_checkout_attempt_
// and_open_fresh / list_event_blocking_checkout_attempts (0161) and the
// event-flavored Stripe param/return-URL builders.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !line.trim().startsWith("--") && !line.trim().startsWith("//"))
    .join("\n");
}

const ACTION_PATH         = "src/app/(app)/calendar/eventCheckoutActions.ts";
const CALENDAR_ACTIONS     = "src/app/(app)/calendar/actions.ts";
const ADMIN_EVENTS_ACTIONS = "src/app/(app)/admin/events/actions.ts";
const MIGRATION_PATH       = "supabase/migrations/0161_event_online_payment_checkout.sql";
const EVENT_DETAIL_PATH    = "src/app/(app)/calendar/EventDetailSheet.tsx";
const EVENTS_UPCOMING_PATH = "src/app/(app)/events/EventsUpcomingClient.tsx";

// ═══════════════════════════════════════════════════════════════════════════
// Checkout creation — server-authoritative, no client-trusted financial value
// ═══════════════════════════════════════════════════════════════════════════

describe("createEventCheckoutAction — server-authoritative, no client-trusted financial value", () => {
  const src = () => readSource(ACTION_PATH);

  it("rejects an unauthenticated caller before touching any financial data", () => {
    const s = src();
    expect(s).toMatch(/const user = await getAuthUser\(\);\s*\n\s*if \(!user\) return \{ error: ERROR_MESSAGES\.not_authenticated \};/);
  });

  it("resolves the payment via the ownership-scoped RPC, never a client-supplied payment_id/club_id", () => {
    const s = src();
    expect(s).toContain('.rpc("get_event_payment_for_checkout", {');
    expect(s).toContain("p_event_id: eventId");
    expect(s).not.toMatch(/createEventCheckoutAction\(\s*[\s\S]{0,80}p_payment_id/);
  });

  it("rejects an obligation not created under court_time_payments", () => {
    const s = src();
    expect(s).toContain('row.payment_mode_at_creation !== "court_time_payments"');
  });

  it("rejects a zero/already-resolved balance via the same status+remaining gate reservations/lessons use", () => {
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

  it("uses a stable, server-derived Stripe idempotency key built from the attempt id, via the EVENT-specific builder — never the reservation/lesson one", () => {
    const s = src();
    expect(s).toContain("idempotencyKey: buildEventCheckoutIdempotencyKey(attempt.id)");
    expect(s).not.toContain("buildReservationCheckoutIdempotencyKey");
    expect(s).not.toContain("buildLessonCheckoutIdempotencyKey");
  });

  it("passes eventId (never a reservation/lesson identity) into the event-specific session-param and return-URL builders", () => {
    const s = src();
    expect(s).toContain("eventId,");
    expect(s).not.toMatch(/reservationId|lessonRequestId/);
  });

  it("derives the /calendar return date server-side from the Event's own starts_at + club timezone — never client-supplied", () => {
    const s = src();
    expect(s).toContain('new Date(row.event_starts_at).toLocaleDateString("en-CA", { timeZone: clubTimezone })');
    expect(s).toContain("buildEventCheckoutReturnUrls(SITE_URL, eventId, eventDateISO)");
  });

  it("opens the checkout attempt through the atomic EVENT-aware wrapper (never the raw reservation/lesson-shaped RPC directly), via the privileged client", () => {
    const s = src();
    expect(s).toContain('privileged.rpc("open_event_payment_checkout_attempt"');
    expect(s).not.toContain('privileged.rpc("open_payment_checkout_attempt"');
    expect(s).not.toContain('privileged.rpc("open_lesson_payment_checkout_attempt"');
    expect(s).not.toMatch(/\.from\(["']payment_checkout_attempts["']\)/);
  });

  it("passes eventId (not row.payment_id) to the atomic wrapper — the wrapper itself resolves payment_id fresh, under the events row lock", () => {
    const s = src();
    expect(s).toMatch(/open_event_payment_checkout_attempt",\s*\{\s*\n\s*p_event_id: eventId,/);
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
});

// ═══════════════════════════════════════════════════════════════════════════
// Eligibility — confirmed own Member, waitlisted/offered/guest excluded,
// parent cancelled/archived blocks
// ═══════════════════════════════════════════════════════════════════════════

describe("get_event_payment_for_checkout — eligibility gate", () => {
  const getFn = () => {
    const m = readSource(MIGRATION_PATH);
    const fnStart = m.indexOf("create or replace function public.get_event_payment_for_checkout(");
    const fnEnd = m.indexOf("revoke execute on function public.get_event_payment_for_checkout(");
    return m.slice(fnStart, fnEnd);
  };

  it("requires role = 'member' before anything else", () => {
    const fn = getFn();
    expect(fn).toContain("v_role := public.current_user_role();");
    expect(fn).toMatch(/if v_role <> 'member' then\s*\n\s*raise exception 'insufficient_role';/);
  });

  it("requires the parent Event to be status = 'scheduled' AND archived_at is null — a cancelled or archived Event's participant is unreachable even if their own row still reads 'confirmed'", () => {
    const fn = getFn();
    expect(fn).toContain("if not found or v_event_status <> 'scheduled' or v_event_archived_at is not null then");
    expect(fn).toContain("return;");
  });

  it("requires the caller's OWN participant row (matched by roster identity, never a client-supplied identity) to be exactly 'confirmed' — waitlisted/offered resolve zero rows, not an error", () => {
    const fn = getFn();
    const eventCheckIdx = fn.indexOf("if not found or v_event_status <> 'scheduled'");
    const participantLookupIdx = fn.indexOf("from public.event_participants ep");
    const statusCheckIdx = fn.indexOf("if not found or v_participant_status <> 'confirmed' then");
    expect(eventCheckIdx).toBeGreaterThan(-1);
    expect(participantLookupIdx).toBeGreaterThan(eventCheckIdx);
    expect(statusCheckIdx).toBeGreaterThan(participantLookupIdx);
    expect(fn).toContain("ep.roster_member_id = v_roster_member_id");
  });

  it("hardcoded to domain_type = 'event_participant' — no event_guest path exists (event_guest has no roster identity to match current_user_roster_member_id() against)", () => {
    const fn = getFn();
    expect(fn).toContain("p.domain_type = 'event_participant'");
    expect(fn).not.toMatch(/event_guest/);
  });

  it("returns event_starts_at alongside the payment fields, so callers can build a date-aware /calendar return URL", () => {
    const fn = getFn();
    expect(fn).toContain("event_starts_at           timestamptz");
    expect(fn).toContain("v_event_starts_at");
  });

  it("resolves only the LATEST obligation cycle for the participant — order by obligation_cycle desc limit 1", () => {
    const fn = getFn();
    expect(fn).toMatch(/order by p\.obligation_cycle desc\s*\n\s*limit 1;/);
  });

  it("grants execute only to authenticated — never public/anon", () => {
    const m = readSource(MIGRATION_PATH);
    expect(m).toContain("revoke execute on function public.get_event_payment_for_checkout(uuid) from public, anon;");
    expect(m).toContain("grant  execute on function public.get_event_payment_for_checkout(uuid) to authenticated;");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Atomic wrappers — lock events FIRST, defensive column qualification
// (never repeat 0159/0160's own PL/pgSQL RETURNS TABLE ambiguity)
// ═══════════════════════════════════════════════════════════════════════════

describe("open_event_payment_checkout_attempt / supersede_event_checkout_attempt_and_open_fresh — atomic lock-then-delegate wrappers", () => {
  const getOpenFn = () => {
    const m = readSource(MIGRATION_PATH);
    const fnStart = m.indexOf("create or replace function public.open_event_payment_checkout_attempt(");
    const fnEnd = m.indexOf(
      "revoke execute on function public.open_event_payment_checkout_attempt(uuid, uuid, text, boolean, uuid) from public, anon, authenticated;",
    );
    return m.slice(fnStart, fnEnd);
  };
  const getSupersedeFn = () => {
    const m = readSource(MIGRATION_PATH);
    const fnStart = m.indexOf("create or replace function public.supersede_event_checkout_attempt_and_open_fresh(");
    const fnEnd = m.indexOf(
      "revoke execute on function public.supersede_event_checkout_attempt_and_open_fresh(uuid, uuid, uuid, text, boolean, uuid) from public, anon, authenticated;",
    );
    return m.slice(fnStart, fnEnd);
  };

  it("open_event_payment_checkout_attempt locks the events row FIRST (for update), matching every other Event-mutating RPC's own established lock order", () => {
    const fn = getOpenFn();
    const lockIdx = fn.indexOf("from public.events e");
    const forUpdateIdx = fn.indexOf("for update;", lockIdx);
    const participantLookupIdx = fn.indexOf("from public.event_participants ep");
    expect(lockIdx).toBeGreaterThan(-1);
    expect(forUpdateIdx).toBeGreaterThan(lockIdx);
    expect(participantLookupIdx).toBeGreaterThan(forUpdateIdx);
  });

  it("re-verifies scheduled/non-archived AND the caller's own participant is still confirmed UNDER that lock, before ever resolving a payment id", () => {
    const fn = getOpenFn();
    const scheduledCheckIdx = fn.indexOf("raise exception 'event_not_scheduled';");
    const confirmedCheckIdx = fn.indexOf("raise exception 'event_participant_not_confirmed';");
    const paymentLookupIdx = fn.indexOf("select p.id into v_payment_id");
    expect(scheduledCheckIdx).toBeGreaterThan(-1);
    expect(confirmedCheckIdx).toBeGreaterThan(scheduledCheckIdx);
    expect(paymentLookupIdx).toBeGreaterThan(confirmedCheckIdx);
  });

  it("never trusts a client-supplied payment id — resolved fresh from the payments table, never accepted as a parameter", () => {
    const fn = getOpenFn();
    expect(fn).not.toMatch(/p_payment_id/);
    expect(fn).toContain("domain_type   = 'event_participant'");
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
      "revoke execute on function public.open_event_payment_checkout_attempt(uuid, uuid, text, boolean, uuid) from public, anon, authenticated;",
    );
    expect(m).toContain(
      "grant  execute on function public.open_event_payment_checkout_attempt(uuid, uuid, text, boolean, uuid) to service_role;",
    );
  });

  it("supersede_event_checkout_attempt_and_open_fresh mirrors the identical lock/re-verify/resolve/delegate pattern, and is also service_role-only", () => {
    const fn = getSupersedeFn();
    expect(fn).toContain("for update;");
    expect(fn).toContain("raise exception 'event_participant_not_confirmed';");
    expect(fn).toContain(
      "select * from public.supersede_checkout_attempt_and_open_fresh(\n      p_stale_attempt_id, v_payment_id, p_club_id, p_stripe_account_id, p_livemode, p_actor_id\n    );",
    );
    const m = readSource(MIGRATION_PATH);
    expect(m).toContain(
      "grant  execute on function public.supersede_event_checkout_attempt_and_open_fresh(uuid, uuid, uuid, text, boolean, uuid) to service_role;",
    );
  });

  it("every table column reference in both wrappers is qualified with an alias (e./ep./p./a.) — never a bare column name that could collide with the RETURNS TABLE output variables of the same name, the exact class of bug 0159 shipped and 0160 had to fix at runtime", () => {
    for (const fn of [getOpenFn(), getSupersedeFn()]) {
      // Every FROM clause in these two functions binds an alias, and every
      // WHERE/SELECT INTO column reference below it uses that alias —
      // spot-check the specific columns that collided in the 0159/0160
      // incident (status/id/club_id) plus the two column families unique
      // to this migration's own queries.
      expect(fn).toMatch(/select e\.status, e\.archived_at/);
      expect(fn).toMatch(/select ep\.id, ep\.status/);
      expect(fn).toMatch(/select p\.id into v_payment_id/);
      expect(fn).not.toMatch(/\n\s*select status into/);
      expect(fn).not.toMatch(/\n\s*select id into v_participant_id(?!\s*,)/);
    }
  });

  it("service-role wrappers list_event_blocking_checkout_attempts is also defensively column-qualified (p./ep./a./p2.)", () => {
    const m = readSource(MIGRATION_PATH);
    const fnStart = m.indexOf("create or replace function public.list_event_blocking_checkout_attempts(");
    const fnEnd = m.indexOf("revoke execute on function public.list_event_blocking_checkout_attempts(");
    const fn = m.slice(fnStart, fnEnd);
    expect(fn).toContain("select distinct p.id");
    expect(fn).toContain("ep.event_id = p_event_id");
    expect(fn).toContain("a.status      = 'open'");
    expect(fn).toContain("p2.club_id     = p_club_id");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Member-only enforcement (defense in depth)
// ═══════════════════════════════════════════════════════════════════════════

describe("Member-only checkout enforcement (defense in depth) — owning Member yes, another Member/Pro/Admin/Staff/guest no", () => {
  const actionSrc = () => readSource(ACTION_PATH);

  it("createEventCheckoutAction requires the caller's current role to be exactly 'member' before any Stripe/payment-attempt mutation", () => {
    const s = actionSrc();
    const profileCheckIdx = s.indexOf('if (!profile || profile.role !== "member")');
    const stripeContextIdx = s.indexOf("const context = getStripeContext();");
    const attemptRpcIdx = s.indexOf('open_event_payment_checkout_attempt"');
    expect(profileCheckIdx).toBeGreaterThan(-1);
    expect(stripeContextIdx).toBeGreaterThan(profileCheckIdx);
    expect(attemptRpcIdx).toBeGreaterThan(profileCheckIdx);
  });

  it("getEventCheckoutEligibilityAction (the Pay Now button's own visibility gate) applies the identical role check", () => {
    const s = actionSrc();
    const eligibilityFnIdx = s.indexOf("export async function getEventCheckoutEligibilityAction");
    const createFnIdx = s.indexOf("export async function createEventCheckoutAction");
    const eligibilityBody = s.slice(eligibilityFnIdx, createFnIdx);
    expect(eligibilityBody).toContain('if (!profile || profile.role !== "member") return { eligible: false };');
  });

  it("EventDetailSheet only renders Pay Now for the owning Member's own confirmed, still-scheduled participation — never for waitlisted/offered/another participant/guest/Admin/Staff/Pro", () => {
    const s = readSource(EVENT_DETAIL_PATH);
    expect(s).toContain('const isConfirmed  = myPart?.status === "confirmed" && event.status === "scheduled";');
    expect(s).toContain("{isConfirmed && paymentState && (");
    // myPart itself is resolved from the caller's OWN identity match
    // (profile_id === userId or roster_member_id === userRosterMemberId)
    // — never any other participant's row.
    expect(s).toMatch(/p\.profile_id === userId \|\| \(userRosterMemberId !== null && p\.roster_member_id === userRosterMemberId\)/);
  });

  it("Admin's Record Payment control is never imported/rendered on EventDetailSheet — the Member surface stays read-only + Pay Now only", () => {
    const s = readSource(EVENT_DETAIL_PATH);
    expect(s).not.toMatch(/recordManualPayment|RecordPayment/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Event Guest exclusion — untouched, structurally enforced
// ═══════════════════════════════════════════════════════════════════════════

describe("Event Guest remains excluded — 0161 does not weaken or touch the existing exclusion", () => {
  it("0161 never redefines _create_payment_obligation — the 0149 court_time_payments + event_guest carve-out is untouched", () => {
    const m = readSource(MIGRATION_PATH);
    expect(m).not.toMatch(/create or replace function public\._create_payment_obligation/);
  });

  it("the 0149 exclusion itself still exists in its own migration, unmodified by this checkpoint", () => {
    const m = readSource("supabase/migrations/0149_court_time_payments_activation_gate.sql");
    expect(m).toContain("if v_mode = 'court_time_payments' and p_domain_type = 'event_guest' then");
    expect(m).toContain("return null;");
  });

  it("get_event_payment_for_checkout has no guest branch — event_guest cannot be resolved through it regardless of input", () => {
    const m = readSource(MIGRATION_PATH);
    const fnStart = m.indexOf("create or replace function public.get_event_payment_for_checkout(");
    const fnEnd = m.indexOf("revoke execute on function public.get_event_payment_for_checkout(");
    const fn = m.slice(fnStart, fnEnd);
    expect(fn).not.toMatch(/event_guest/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Stale Checkout guards — Member leave, both Admin removal paths
// ═══════════════════════════════════════════════════════════════════════════

describe("_leave_event_impl invalidates/flags an open Checkout attempt BEFORE its own domain mutation", () => {
  const getFn = () => {
    const m = readSource(MIGRATION_PATH);
    const fnStart = m.indexOf("create or replace function public._leave_event_impl(p_event_id uuid)");
    const fnEnd = m.indexOf("revoke execute on function public._leave_event_impl(uuid) from public, anon, authenticated;");
    return m.slice(fnStart, fnEnd);
  };

  it("resolves the current payment obligation and calls the SAME _invalidate_or_flag_open_checkout_attempt helper 0151 already established — never a bespoke event-leave-specific invalidation routine", () => {
    const fn = getFn();
    expect(fn).toContain("select p.id into v_payment_id_for_checkout_guard");
    expect(fn).toContain("p.domain_type  = 'event_participant'");
    expect(fn).toContain("perform public._invalidate_or_flag_open_checkout_attempt(v_payment_id_for_checkout_guard)");
  });

  it("the guard runs AFTER the participant is located (not_joined already raised for anyone else) but BEFORE the event_participants status mutation", () => {
    const fn = getFn();
    const notJoinedIdx = fn.indexOf("raise exception 'not_joined';");
    const guardIdx = fn.indexOf("perform public._invalidate_or_flag_open_checkout_attempt(v_payment_id_for_checkout_guard)");
    const mutationIdx = fn.indexOf("set status           = 'cancelled'");
    expect(notJoinedIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(notJoinedIdx);
    expect(guardIdx).toBeLessThan(mutationIdx);
  });

  it("runs unconditionally (not branched on v_old_status) — a safe no-op for waitlisted/offered leaves, which never have a payment to find", () => {
    const fn = getFn();
    const guardIdx = fn.indexOf("select p.id into v_payment_id_for_checkout_guard");
    const branchIdx = fn.indexOf("if v_old_status = 'confirmed' then");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(branchIdx);
  });

  it("remains a pure DOMAIN mutation — never inserts a payment_events row, never references amount_due_cents/amount_paid_cents/refund/waive/void", () => {
    const fn = codeOnly(getFn());
    expect(fn).not.toMatch(/insert into public\.payment_events/);
    expect(fn).not.toMatch(/amount_due_cents|amount_paid_cents/);
    expect(fn).not.toMatch(/perform public\.(record_refund|waive_payment|void_payment_obligation)/);
  });
});

describe("leaveEvent Server Action resolves a blocking bound Session via the established handshake before retrying", () => {
  it("catches OPEN_CHECKOUT_REQUIRES_RESOLUTION, resolves via resolveBlockingCheckoutBeforeMutation (the SAME shared handshake), then retries leave_event_v2 exactly once", () => {
    const s = readSource(CALENDAR_ACTIONS);
    const fnIdx = s.indexOf("export async function leaveEvent(");
    const nextFnIdx = s.indexOf("export async function acceptWaitlistOffer(");
    const fn = s.slice(fnIdx, nextFnIdx);
    expect(fn).toContain("rpcError?.message.includes(OPEN_CHECKOUT_REQUIRES_RESOLUTION)");
    expect(fn).toContain("resolveBlockingCheckoutBeforeMutation(paymentId, expectedClubId)");
    const occurrences = fn.split('"leave_event_v2"').length - 1;
    expect(occurrences).toBe(2);
  });

  it("resolves the payment id via get_event_payment_for_checkout BEFORE the leave attempt — never a second round-trip to discover which payment was blocking", () => {
    const s = readSource(CALENDAR_ACTIONS);
    const fnIdx = s.indexOf("export async function leaveEvent(");
    const nextFnIdx = s.indexOf("export async function acceptWaitlistOffer(");
    const fn = s.slice(fnIdx, nextFnIdx);
    const paymentLookupIdx = fn.indexOf('get_event_payment_for_checkout"');
    const leaveCallIdx = fn.indexOf('"leave_event_v2"');
    expect(paymentLookupIdx).toBeGreaterThan(-1);
    expect(paymentLookupIdx).toBeLessThan(leaveCallIdx);
  });
});

describe("admin_remove_participant / admin_remove_roster_participant both invalidate/flag an open Checkout attempt BEFORE their own domain mutation — both live removal paths guarded, not just one", () => {
  const getFn = (marker: string) => {
    const m = readSource(MIGRATION_PATH);
    const fnStart = m.indexOf(marker);
    const fnEnd = m.indexOf("\n$$;", fnStart) + "\n$$;".length;
    return m.slice(fnStart, fnEnd);
  };

  it("admin_remove_participant: widens its existing lookup to capture the participant's own id, then guards before the status UPDATE", () => {
    const fn = getFn("create or replace function public.admin_remove_participant(p_event_id uuid, p_profile_id uuid)");
    expect(fn).toContain("select id, status into v_participant_id, v_old_status");
    const guardIdx = fn.indexOf("perform public._invalidate_or_flag_open_checkout_attempt(v_payment_id_for_checkout_guard)");
    const mutationIdx = fn.indexOf("update event_participants\n    set status           = 'cancelled'");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(mutationIdx);
  });

  it("admin_remove_roster_participant: guards before its status UPDATE, using the participant id it already captured", () => {
    const fn = getFn("create or replace function public.admin_remove_roster_participant(p_event_id uuid, p_expected_club_id uuid, p_roster_member_id uuid)");
    const guardIdx = fn.indexOf("perform public._invalidate_or_flag_open_checkout_attempt(v_payment_id_for_checkout_guard)");
    const mutationIdx = fn.indexOf("update public.event_participants\n     set status           = 'cancelled'");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(mutationIdx);
  });

  it("both are pure DOMAIN mutations — neither inserts a payment_events row nor references amount_due_cents/amount_paid_cents/refund/waive/void", () => {
    for (const marker of [
      "create or replace function public.admin_remove_participant(p_event_id uuid, p_profile_id uuid)",
      "create or replace function public.admin_remove_roster_participant(p_event_id uuid, p_expected_club_id uuid, p_roster_member_id uuid)",
    ]) {
      const fn = codeOnly(getFn(marker));
      expect(fn).not.toMatch(/insert into public\.payment_events/);
      expect(fn).not.toMatch(/amount_due_cents|amount_paid_cents/);
      expect(fn).not.toMatch(/perform public\.(record_refund|waive_payment|void_payment_obligation)/);
    }
  });
});

describe("adminRemoveParticipant / adminRemoveRosterParticipant Server Actions both resolve-then-retry on the guard's error", () => {
  const src = () => readSource(ADMIN_EVENTS_ACTIONS);

  it("adminRemoveParticipant catches OPEN_CHECKOUT_REQUIRES_RESOLUTION and retries admin_remove_participant exactly once", () => {
    const s = src();
    const fnIdx = s.indexOf("export async function adminRemoveParticipant(");
    const nextFnIdx = s.indexOf("export async function adminForceConfirm(");
    const fn = s.slice(fnIdx, nextFnIdx);
    expect(fn).toContain("error?.message.includes(OPEN_CHECKOUT_REQUIRES_RESOLUTION)");
    const occurrences = fn.split('"admin_remove_participant"').length - 1;
    expect(occurrences).toBe(2);
  });

  it("adminRemoveRosterParticipant catches OPEN_CHECKOUT_REQUIRES_RESOLUTION and retries admin_remove_roster_participant exactly once", () => {
    const s = src();
    const fnIdx = s.indexOf("export async function adminRemoveRosterParticipant(");
    const nextFnIdx = s.indexOf("export async function adminForceConfirmRosterParticipant(", fnIdx) === -1
      ? s.length
      : s.indexOf("export async function adminForceConfirmRosterParticipant(", fnIdx);
    const fn = s.slice(fnIdx, nextFnIdx);
    expect(fn).toContain("error?.message.includes(OPEN_CHECKOUT_REQUIRES_RESOLUTION)");
    const occurrences = fn.split('"admin_remove_roster_participant"').length - 1;
    expect(occurrences).toBe(2);
  });

  it("both resolve the blocking payment id via the SAME sanitized batched read boundary (fetchPaymentStates) every other event-payment surface uses — never a raw table query for the payment id", () => {
    const s = src();
    expect(s).toContain('fetchPaymentStates("event_participant", [participantRow.id])');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Event cancellation fan-out — must not finish cancelling while ANY
// confirmed participant has a possibly-payable Session; bounded batch
// resolution, never an unbounded retry loop
// ═══════════════════════════════════════════════════════════════════════════

describe("cancel_event — fan-out stale-Checkout guard across every currently-confirmed participant", () => {
  const getFn = () => {
    const m = readSource(MIGRATION_PATH);
    const fnStart = m.indexOf("create or replace function public.cancel_event(p_event_id uuid)");
    const fnEnd = m.indexOf("\n$$;", fnStart) + "\n$$;".length;
    return m.slice(fnStart, fnEnd);
  };

  it("loops over every event_participants row currently 'confirmed', resolving each one's LATEST payment cycle, calling the same _invalidate_or_flag_open_checkout_attempt helper once per participant", () => {
    const fn = getFn();
    expect(fn).toContain("for v_payment_id_for_checkout_guard in");
    expect(fn).toContain("ep.status   = 'confirmed'");
    expect(fn).toContain("order by p.domain_id, p.obligation_cycle desc");
    expect(fn).toContain("perform public._invalidate_or_flag_open_checkout_attempt(v_payment_id_for_checkout_guard);\n  end loop;");
  });

  it("the fan-out loop runs BEFORE the events status UPDATE — an invalid cancellation never expires a legitimate Session before Court Time knows the action would fail", () => {
    const fn = getFn();
    const loopIdx = fn.indexOf("for v_payment_id_for_checkout_guard in");
    const mutationIdx = fn.indexOf("update public.events\n    set status = 'cancelled'");
    expect(loopIdx).toBeGreaterThan(-1);
    expect(loopIdx).toBeLessThan(mutationIdx);
  });

  it("uses `distinct on (p.domain_id) ... order by p.domain_id, p.obligation_cycle desc` — exactly one (the latest) payment per participant, never re-guarding an old superseded cycle", () => {
    const fn = getFn();
    expect(fn).toContain("select distinct on (p.domain_id) p.id");
  });

  it("still a pure DOMAIN mutation — the fan-out guard itself never touches amount_due_cents/amount_paid_cents/payment_events", () => {
    const fn = codeOnly(getFn());
    expect(fn).not.toMatch(/insert into public\.payment_events/);
    expect(fn).not.toMatch(/amount_due_cents|amount_paid_cents/);
  });

  // ─────────────────────────────────────────────────────────────────────
  // Runtime QA correction (this round) — cancel_event's authoritative
  // Event lookup originally shipped WITHOUT `for update`, meaning its own
  // fan-out guard (above) was not actually serialized against a
  // concurrent Member Checkout attempt-open racing in on the same Event.
  // ─────────────────────────────────────────────────────────────────────

  it("1. the authoritative Event lookup includes FOR UPDATE — cancel_event now locks the events row, matching every other Event mutation this migration touches", () => {
    const fn = getFn();
    expect(fn).toMatch(
      /where id\s+= p_event_id\s*\n\s*and club_id = v_profile\.club_id\s*\n\s*and status\s+= 'scheduled'\s*\n\s*for update;/,
    );
  });

  it("2. the Event lock is acquired BEFORE the fan-out guard — the guard's own scan (does any confirmed participant have a blocking attempt?) is meaningless unless it runs under the same lock a concurrent Checkout attempt-open must also acquire first", () => {
    const fn = getFn();
    const lockIdx = fn.indexOf("for update;");
    const loopIdx = fn.indexOf("for v_payment_id_for_checkout_guard in");
    expect(lockIdx).toBeGreaterThan(-1);
    expect(loopIdx).toBeGreaterThan(lockIdx);
  });

  it("3. the fan-out guard still runs BEFORE `update public.events ... status = 'cancelled'` (re-confirmed after the lock correction, same ordering as before it)", () => {
    const fn = getFn();
    const loopIdx = fn.indexOf("for v_payment_id_for_checkout_guard in");
    const mutationIdx = fn.indexOf("update public.events\n    set status = 'cancelled'");
    expect(loopIdx).toBeGreaterThan(-1);
    expect(loopIdx).toBeLessThan(mutationIdx);
  });

  it("5. the rollback-documented cancel_event body remains byte-identical to authoritative 0136 — the new FOR UPDATE (and the fan-out guard) are forward-only deltas, never carried into the rollback", () => {
    const authoritative = readSource("supabase/migrations/0136_staff_event_operational_authorization.sql");
    const srcStart = authoritative.indexOf("CREATE OR REPLACE FUNCTION public.cancel_event(p_event_id uuid)");
    const srcEnd = authoritative.indexOf("$function$;", srcStart) + "$function$;".length;
    const srcBlock = authoritative.slice(srcStart, srcEnd).trim();

    const m = readSource(MIGRATION_PATH);
    const rbMarker = "-- CREATE OR REPLACE FUNCTION public.cancel_event(p_event_id uuid)";
    const rbStart = m.indexOf(rbMarker);
    const rbEnd = m.indexOf("$function$;", rbStart) + "$function$;".length;
    const rbBlockRaw = m.slice(rbStart, rbEnd);
    const rbBlock = rbBlockRaw
      .split("\n")
      .map((line) => (line.startsWith("-- ") ? line.slice(3) : line === "--" ? "" : line.startsWith("--") ? line.slice(2) : line))
      .join("\n")
      .trim();

    expect(rbBlock).toBe(srcBlock);
    // The rollback must NOT contain the new lock — it restores exactly
    // the pre-0161, unlocked authoritative behavior.
    expect(rbBlock).not.toContain("for update;");
  });
});

describe("Event-row-first lock ordering — cross-function proof across every Event mutation this migration touches or introduces", () => {
  it("4. open_event_payment_checkout_attempt, supersede_event_checkout_attempt_and_open_fresh, update_event, _leave_event_impl, admin_remove_participant, admin_remove_roster_participant, and (after this round's correction) cancel_event ALL lock events/event_participants via `for update` as their first substantive step — one consistent lock ordering, never a competing/ad-hoc one", () => {
    const m = readSource(MIGRATION_PATH);
    const markers: [string, string][] = [
      ["open_event_payment_checkout_attempt", "create or replace function public.open_event_payment_checkout_attempt("],
      ["supersede_event_checkout_attempt_and_open_fresh", "create or replace function public.supersede_event_checkout_attempt_and_open_fresh("],
      ["update_event", "create or replace function public.update_event(p_event_id uuid, p_expected_club_id uuid,"],
      ["_leave_event_impl", "create or replace function public._leave_event_impl(p_event_id uuid)"],
      ["admin_remove_roster_participant", "create or replace function public.admin_remove_roster_participant(p_event_id uuid, p_expected_club_id uuid, p_roster_member_id uuid)"],
      ["cancel_event", "create or replace function public.cancel_event(p_event_id uuid)"],
    ];
    for (const [name, marker] of markers) {
      const start = m.indexOf(marker);
      expect(start, `${name} marker not found`).toBeGreaterThan(-1);
      // Measure from `begin` (the start of the function BODY, after its
      // signature) rather than from the marker itself — the signature's
      // own length (parameter list, RETURNS TABLE shape) varies a lot
      // between these functions and isn't part of "how early does the
      // body lock the row" at all.
      const beginIdx = m.indexOf("\nbegin\n", start);
      expect(beginIdx, `${name} has no begin`).toBeGreaterThan(start);
      const nextForUpdate = m.indexOf("for update", beginIdx);
      expect(nextForUpdate, `${name} has no for update`).toBeGreaterThan(beginIdx);
      // The lock must be reasonably early — the function's own first
      // substantive Event/participant lookup, not an incidental later one.
      // Measured on comment-stripped code so a verbose explanatory comment
      // (e.g. cancel_event's own delta 1/2 documentation, this round)
      // doesn't inflate the raw character distance.
      const codeSlice = codeOnly(m.slice(beginIdx, nextForUpdate + "for update".length));
      expect(codeSlice.length, `${name} locks too late`).toBeLessThan(650);
    }
  });

  it("admin_remove_participant locks events (for update) before its own participant lookup and guard — the sixth Event mutation, checked separately since its marker text collides with admin_remove_roster_participant's own prefix", () => {
    const m = readSource(MIGRATION_PATH);
    const start = m.indexOf("create or replace function public.admin_remove_participant(p_event_id uuid, p_profile_id uuid)");
    expect(start).toBeGreaterThan(-1);
    const forUpdateIdx = m.indexOf("for update;", start);
    const guardIdx = m.indexOf("perform public._invalidate_or_flag_open_checkout_attempt(v_payment_id_for_checkout_guard)", start);
    expect(forUpdateIdx).toBeGreaterThan(start);
    expect(guardIdx).toBeGreaterThan(forUpdateIdx);
  });
});

describe("race-ordering proof — both orders in which cancel_event and a concurrent Member Checkout attempt-open can acquire the events row lock resolve safely", () => {
  it("Cancellation wins the lock first: cancel_event's fan-out guard runs and commits (or rolls back if it finds a blocker) BEFORE releasing the lock; a concurrent open_event_payment_checkout_attempt, blocked on the same events row, then proceeds and re-reads the Event fresh under its OWN lock — finding status <> 'scheduled', it raises event_not_scheduled before ever resolving a participant or payment", () => {
    const m = readSource(MIGRATION_PATH);
    const openFnStart = m.indexOf("create or replace function public.open_event_payment_checkout_attempt(");
    const openFnEnd = m.indexOf(
      "revoke execute on function public.open_event_payment_checkout_attempt(uuid, uuid, text, boolean, uuid) from public, anon, authenticated;",
    );
    const openFn = m.slice(openFnStart, openFnEnd);
    const lockIdx = openFn.indexOf("for update;");
    const scheduledCheckIdx = openFn.indexOf("raise exception 'event_not_scheduled';");
    const participantLookupIdx = openFn.indexOf("from public.event_participants ep");
    expect(lockIdx).toBeGreaterThan(-1);
    expect(scheduledCheckIdx).toBeGreaterThan(lockIdx);
    expect(participantLookupIdx).toBeGreaterThan(scheduledCheckIdx);
  });

  it("Checkout wins the lock first: it opens/reuses the attempt and commits (releasing the events lock) — cancel_event, blocked on that same lock, then proceeds, re-acquires the lock, and its OWN fan-out scan (running fresh, post-commit) sees the just-opened attempt and runs _invalidate_or_flag_open_checkout_attempt against it BEFORE the events status UPDATE", () => {
    const fn = getEventFn();
    const lockIdx = fn.indexOf("for update;");
    const loopIdx = fn.indexOf("for v_payment_id_for_checkout_guard in");
    const mutationIdx = fn.indexOf("update public.events\n    set status = 'cancelled'");
    expect(lockIdx).toBeGreaterThan(-1);
    expect(loopIdx).toBeGreaterThan(lockIdx);
    expect(loopIdx).toBeLessThan(mutationIdx);
  });

  it("the create/bind cleanup path still safely handles a remote Stripe Session created after its local attempt was invalidated: _invalidate_or_flag_open_checkout_attempt only acts on a currently-'open' local attempt row — an UNBOUND attempt (no Stripe Session yet) is safely canceled locally; a BOUND attempt raises open_checkout_requires_resolution, which eventCheckoutActions.ts never even reaches synchronously (Stripe Session creation happens in a LATER step, after the atomic wrapper already returned 'ready') — so cancel_event's guard can only ever race a bound Session into 'canceled_but_Stripe_still_thinks_its_open', a state the SAME resolveBlockingCheckoutBeforeMutation handshake this migration reuses everywhere else already resolves via the unchanged webhook/reconciliation path", () => {
    const helper = readSource("supabase/migrations/0151_stale_checkout_invalidation.sql");
    const fnStart = helper.indexOf("create or replace function public._invalidate_or_flag_open_checkout_attempt(");
    const fnEnd = helper.indexOf("revoke all on function public._invalidate_or_flag_open_checkout_attempt(");
    const fn = helper.slice(fnStart, fnEnd);
    expect(fn).toContain("and status = 'open'");
    expect(fn).toContain("if v_attempt.stripe_checkout_session_id is null then");
    expect(fn).toContain("raise exception 'open_checkout_requires_resolution';");
  });

  function getEventFn(): string {
    const m = readSource(MIGRATION_PATH);
    const fnStart = m.indexOf("create or replace function public.cancel_event(p_event_id uuid)");
    const fnEnd = m.indexOf("\n$$;", fnStart) + "\n$$;".length;
    return m.slice(fnStart, fnEnd);
  }
});

describe("update_event — material-edit fan-out guard: starts_at/ends_at/court-set/event_type_id invalidate; title/capacity/description/future-only price override do not", () => {
  const getFn = () => {
    const m = readSource(MIGRATION_PATH);
    const fnStart = m.indexOf("create or replace function public.update_event(p_event_id uuid, p_expected_club_id uuid,");
    const fnEnd = m.indexOf("\n$$;", fnStart) + "\n$$;".length;
    return m.slice(fnStart, fnEnd);
  };

  it("materiality predicate is exactly v_time_changed OR v_court_set_changed OR event_type_id changed — never title/capacity/description", () => {
    const fn = getFn();
    expect(fn).toMatch(
      /v_payment_material_change :=\s*\n\s*v_time_changed\s*\n\s*or v_court_set_changed\s*\n\s*or \(p_event_type_id is distinct from v_before\.event_type_id\);/,
    );
  });

  it("the fan-out loop is gated on v_payment_material_change and runs AFTER the existing no-op early-return but BEFORE the first mutating statement", () => {
    const fn = getFn();
    const earlyReturnIdx = fn.indexOf("if array_length(v_changed_fields, 1) is null then");
    const materialCheckIdx = fn.indexOf("if v_payment_material_change then");
    const firstMutationIdx = fn.indexOf("if v_time_changed then\n    update reservations");
    expect(earlyReturnIdx).toBeGreaterThan(-1);
    expect(materialCheckIdx).toBeGreaterThan(earlyReturnIdx);
    expect(materialCheckIdx).toBeLessThan(firstMutationIdx);
  });

  it("a pure title/capacity/description-only edit (v_time_changed=false, v_court_set_changed=false, event_type_id unchanged) leaves v_payment_material_change false — the guard loop structurally cannot fire", () => {
    const fn = getFn();
    // title/capacity/description are none of the three disjuncts in the
    // materiality predicate itself.
    const predicateIdx = fn.indexOf("v_payment_material_change :=");
    const predicateBlock = fn.slice(predicateIdx, fn.indexOf(";", predicateIdx) + 1);
    expect(predicateBlock).not.toMatch(/title|capacity|description/);
  });

  it("set_event_price_override is never redefined by this migration — a future-only Event price change (never rewriting an existing participant's own price_amount_cents snapshot, per 0141) has no guard because it has nothing to invalidate", () => {
    const m = readSource(MIGRATION_PATH);
    expect(m).not.toMatch(/create or replace function public\.set_event_price_override/);
  });

  it("paid participant obligations are never repriced by update_event — no call to _adjust_payment_obligation/_create_payment_obligation anywhere in this function", () => {
    const fn = getFn();
    expect(fn).not.toMatch(/_adjust_payment_obligation|_create_payment_obligation/);
  });
});

describe("resolveAllBlockingEventCheckouts — bounded batch resolution, never an unbounded retry loop", () => {
  it("calendar/actions.ts's cancelEvent bounds its resolve-then-retry loop to at most 2 total attempts", () => {
    const s = readSource(CALENDAR_ACTIONS);
    const fnIdx = s.indexOf("export async function cancelEvent(");
    const nextFnIdx = s.indexOf("export async function cancelMemberReservation(");
    const fn = s.slice(fnIdx, nextFnIdx);
    expect(fn).toMatch(/for \(let attempt = 0; attempt < 2 &&/);
    expect(fn).not.toMatch(/while\s*\(true\)/);
  });

  it("admin/events/actions.ts's updateEventAdmin bounds its resolve-then-retry loop identically", () => {
    const s = readSource(ADMIN_EVENTS_ACTIONS);
    const fnIdx = s.indexOf("export async function updateEventAdmin(");
    const fn = s.slice(fnIdx, fnIdx + 3000);
    expect(fn).toMatch(/for \(let attempt = 0; attempt < 2 &&/);
    expect(fn).not.toMatch(/while\s*\(true\)/);
  });

  it("both batch-resolution helpers list blocking attempts via the service-role-only preflight RPC, then resolve each via the EXISTING generic per-payment helper — never a duplicated Stripe algorithm", () => {
    for (const path of [CALENDAR_ACTIONS, ADMIN_EVENTS_ACTIONS]) {
      const s = readSource(path);
      expect(s).toContain('"list_event_blocking_checkout_attempts"');
      expect(s).toContain("resolveBlockingCheckoutBeforeMutation(payment_id, clubId)");
    }
  });

  it("a resolution failure returns { ok: false } without ever calling the mutation RPC again — the Event/edit is left exactly as it was rather than risk charging for a cancelled Event", () => {
    for (const path of [CALENDAR_ACTIONS, ADMIN_EVENTS_ACTIONS]) {
      const s = readSource(path);
      const fnIdx = s.indexOf("async function resolveAllBlockingEventCheckouts(");
      const fn = s.slice(fnIdx, fnIdx + 1500);
      expect(fn).toContain("if (!resolved.ok) return { ok: false, error: resolved.error };");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Financial/domain separation invariants
// ═══════════════════════════════════════════════════════════════════════════

describe("domain lifecycle stays separate from financial lifecycle — no automatic refund/waive/void anywhere in 0161", () => {
  it("no refund/waive/void RPC is ever called from within 0161's own guarded functions", () => {
    const m = codeOnly(readSource(MIGRATION_PATH));
    expect(m).not.toMatch(/perform public\.(record_refund|waive_payment|void_payment_obligation)/);
  });

  it("_invalidate_or_flag_open_checkout_attempt itself is untouched by this migration (not redefined) — the guard reuses the existing, already-proven helper verbatim", () => {
    const m = readSource(MIGRATION_PATH);
    expect(m).not.toMatch(/create or replace function public\._invalidate_or_flag_open_checkout_attempt/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// One canonical Member payment surface
// ═══════════════════════════════════════════════════════════════════════════

describe("one canonical Member Pay Now surface — EventDetailSheet only", () => {
  it("eventCheckoutActions is imported/used only by EventDetailSheet.tsx, not by EventsUpcomingClient.tsx or any admin surface", () => {
    const detailSrc = readSource(EVENT_DETAIL_PATH);
    expect(detailSrc).toContain('from "./eventCheckoutActions"');

    const upcomingSrc = readSource(EVENTS_UPCOMING_PATH);
    expect(upcomingSrc).not.toMatch(/eventCheckoutActions|createEventCheckoutAction|Pay Now/);
  });

  it("no separate Event payment implementation exists for /events — it has no detail sheet of its own to duplicate into", () => {
    const upcomingSrc = readSource(EVENTS_UPCOMING_PATH);
    expect(upcomingSrc).not.toMatch(/EventDetailSheet/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Return flow — history.replaceState, not router.replace (34F-A lesson)
// ═══════════════════════════════════════════════════════════════════════════

describe("CalendarShell's Event checkout-return effect uses window.history.replaceState, mirroring the 34F-A lesson-navigation fix — never router.replace, which the 34F-A runtime QA found forces a visible double Server Component re-fetch", () => {
  it("the NEW event checkout-return effect uses window.history.replaceState", () => {
    const s = readSource("src/app/(app)/calendar/CalendarShell.tsx");
    const start = s.indexOf("if (!initialCheckoutEventId) return;");
    const end = s.indexOf("}, []);", start) + "}, []);".length;
    const effect = s.slice(start, end);
    expect(effect).toContain('window.history.replaceState(null, "", "/calendar");');
    expect(effect).not.toMatch(/router\.replace/);
  });

  it("fetches the Event with the same full-detail shape fetchEvents itself uses, so EventDetailSheet receives everything it needs to render", () => {
    const s = readSource("src/app/(app)/calendar/CalendarShell.tsx");
    const start = s.indexOf("if (!initialCheckoutEventId) return;");
    const end = s.indexOf("}, []);", start) + "}, []);".length;
    const effect = s.slice(start, end);
    expect(effect).toContain("event_participants(id, profile_id, roster_member_id, role, status, offer_expires_at)");
    expect(effect).toContain("event_guests(id, status)");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Reused, domain-agnostic machinery — confirms the "generalize, don't
// duplicate" claim against the shared, UNCHANGED files.
// ═══════════════════════════════════════════════════════════════════════════

describe("reused domain-agnostic machinery — process_stripe_payment_event, open_payment_checkout_attempt, and _invalidate_or_flag_open_checkout_attempt are untouched and already event-aware via the new wrappers only", () => {
  it("process_stripe_payment_event is never called from eventCheckoutActions.ts — reconciliation is entirely webhook-driven and shared, not duplicated per domain", () => {
    const s = readSource(ACTION_PATH);
    expect(s).not.toMatch(/\.rpc\(\s*["']process_stripe_payment_event["']/);
  });

  it("eventCheckoutActions.ts never redefines/duplicates open_payment_checkout_attempt, supersede_checkout_attempt_and_open_fresh, or record_checkout_session_created — it only calls the atomic event wrappers and the existing RPCs by name", () => {
    const s = readSource(ACTION_PATH);
    expect(s).not.toMatch(/create (or replace )?function/i);
    expect(s).toContain('privileged.rpc("open_event_payment_checkout_attempt"');
    expect(s).toContain('privileged.rpc("record_checkout_session_created"');
  });

  it("0161 contains no actual CODE touching lesson_requests/domain_type='lesson_request' — only explanatory prose (in comments) compares to the Lesson pattern; 0159/0160 themselves are never redefined here", () => {
    const m = codeOnly(readSource(MIGRATION_PATH));
    expect(m).not.toMatch(/lesson_requests|'lesson_request'/);
    expect(m).not.toMatch(/create or replace function public\.(get_lesson_payment_for_checkout|open_lesson_payment_checkout_attempt|supersede_lesson_checkout_attempt_and_open_fresh|cancel_lesson)/);
  });
});
