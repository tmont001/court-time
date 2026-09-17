import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 34G-C2 correction pass — Issue 7. Source-inspection wiring/
// security regression coverage for exportActions.ts and
// exportDomainHydration.ts (the two files that carry real Supabase
// I/O and therefore can't be exercised as genuine unit tests under this
// project's pure-TypeScript vitest baseline — mirrors the established
// paymentProvenanceUX.regression.test.ts convention exactly, including its
// codeOnly() comment-stripping technique so a regex assertion never trips
// on an explanatory doc comment). Pure business-logic behavior (signed
// amounts, date-range validation, cycle selection, column definitions,
// formula-injection protection, etc.) is covered by genuine unit tests in
// exportLogic.test.ts, csv.test.ts, and exhaustiveRange.test.ts — this file
// only proves the WIRING: auth, tenant isolation, timestamp semantics,
// pagination usage, and Stripe-id suppression are actually connected.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

const ACTIONS_PATH = "src/app/(app)/admin/payments/exportActions.ts";
const HYDRATION_PATH = "src/app/(app)/admin/payments/exportDomainHydration.ts";
const PAGE_PATH = "src/app/(app)/admin/payments/page.tsx";

// ═══════════════════════════════════════════════════════════════════════════
// Authorization / tenant isolation
// ═══════════════════════════════════════════════════════════════════════════

describe("authorization — Admin/Staff only, tenant identity always server-derived", () => {
  it("both exported Server Actions route through the SAME resolveExportContext helper, which calls assertActiveClub for staleness", () => {
    const s = codeOnly(readSource(ACTIONS_PATH));
    expect(s).toMatch(/async function resolveExportContext/);
    expect(s).toContain("assertActiveClub(expectedClubId)");
    expect(s).toContain("export async function exportOutstandingBalancesCsv(");
    expect(s).toContain("export async function exportPaymentActivityCsv(");
    // Both actions call resolveExportContext as their first step.
    const outstandingIdx = s.indexOf("export async function exportOutstandingBalancesCsv(");
    const activityIdx = s.indexOf("export async function exportPaymentActivityCsv(");
    const outstandingBody = s.slice(outstandingIdx, s.indexOf("\n}", s.indexOf("return { csv:", outstandingIdx)));
    const activityBody = s.slice(activityIdx);
    expect(outstandingBody).toContain("resolveExportContext(expectedClubId)");
    expect(activityBody).toContain("resolveExportContext(expectedClubId)");
  });

  it("resolveExportContext gates on isOperator(profile.role) — Admin/Staff only, never Member/Pro", () => {
    const s = codeOnly(readSource(ACTIONS_PATH));
    const fnStart = s.indexOf("async function resolveExportContext(");
    const fnEnd = s.indexOf("\n}", s.indexOf("return { supabase", fnStart));
    const fn = s.slice(fnStart, fnEnd);
    expect(fn).toContain("isOperator(profile.role)");
    expect(fn).toContain("insufficient_role");
  });

  it("the ACTUAL queried club_id always comes from profile.club_id (server-derived), NEVER from expectedClubId — expectedClubId is used only inside assertActiveClub's own staleness check", () => {
    const s = codeOnly(readSource(ACTIONS_PATH));
    const fnStart = s.indexOf("async function resolveExportContext(");
    const fnEnd = s.indexOf("\n}", s.indexOf("return { supabase", fnStart));
    const fn = s.slice(fnStart, fnEnd);
    expect(fn).toContain("const clubId = profile.club_id;");
    // expectedClubId appears exactly twice in this function: the parameter
    // declaration itself, and the assertActiveClub staleness call — never
    // assigned to clubId, never used in a query filter.
    const usages = fn.split("expectedClubId").length - 1;
    expect(usages).toBe(2);
    expect(fn).toContain("(expectedClubId: string)");
    expect(fn).toContain("assertActiveClub(expectedClubId)");
    expect(fn).not.toMatch(/=\s*expectedClubId/);
  });

  it("every club-scoped query in both actions filters on clubId (the resolved variable), never on expectedClubId or a client-supplied value", () => {
    const s = codeOnly(readSource(ACTIONS_PATH));
    expect(s).not.toMatch(/\.eq\("club_id",\s*expectedClubId\)/);
    // Every .eq("club_id", ...) call site uses the resolved `clubId`.
    const eqClubIdMatches = [...s.matchAll(/\.eq\("club_id",\s*(\w+)\)/g)];
    expect(eqClubIdMatches.length).toBeGreaterThan(0);
    for (const m of eqClubIdMatches) {
      expect(m[1]).toBe("clubId");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Timestamp semantics — occurred_at, never created_at
// ═══════════════════════════════════════════════════════════════════════════

describe("Payment Activity uses occurred_at, never created_at, for both filtering and ordering", () => {
  it("the main activity query orders and range-filters exclusively on occurred_at", () => {
    const s = codeOnly(readSource(ACTIONS_PATH));
    expect(s).toContain('.order("occurred_at", { ascending: true })');
    expect(s).toContain("range.startUTC");
    expect(s).toContain("range.endUTC");
    expect(s).toMatch(/\.gte\("occurred_at",\s*range\.startUTC\)/);
    expect(s).toMatch(/\.lt\("occurred_at",\s*range\.endUTC\)/);
  });

  it("created_at is never referenced anywhere in the export actions", () => {
    const s = codeOnly(readSource(ACTIONS_PATH));
    expect(s).not.toMatch(/created_at/);
  });

  it("deterministic pagination — the activity query ties off on id after occurred_at, since occurred_at alone is not guaranteed unique", () => {
    const s = codeOnly(readSource(ACTIONS_PATH));
    const orderCalls = s.match(/\.order\("occurred_at"[^)]*\)\s*\n\s*\.order\("id"[^)]*\)/);
    expect(orderCalls).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// "All activity" — no filter at all
// ═══════════════════════════════════════════════════════════════════════════

describe("'All activity' applies no occurred_at filter", () => {
  it("the gte/lt occurred_at clauses are conditionally applied only when range.startUTC/endUTC are non-null — resolveActivityDateRangeUTC returns both null for all:true", () => {
    const s = codeOnly(readSource(ACTIONS_PATH));
    expect(s).toContain("if (range.startUTC) query = query.gte(");
    expect(s).toContain("if (range.endUTC) query = query.lt(");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Stripe-id suppression — raw external_reference never exported for online events
// ═══════════════════════════════════════════════════════════════════════════

describe("raw Stripe ids are never mapped into CSV output; manual external references are", () => {
  it("activityExternalReference (exportLogic.ts, exercised by genuine unit tests) is the ONLY place external_reference reaches a CSV cell — exportActions.ts never reads event.externalReference directly into a row field other than through buildPaymentActivityRow's externalReference param, which is threaded straight into that helper", () => {
    const s = codeOnly(readSource(ACTIONS_PATH));
    expect(s).toContain("externalReference: event.external_reference,");
    // No other, competing mapping of external_reference exists.
    const occurrences = s.split("external_reference").length - 1;
    // exactly one in the select() column list, one in the row type, one in
    // the buildPaymentActivityRow call — never a raw pass-through elsewhere
    // (e.g. into Notes or a synthetic column).
    expect(occurrences).toBeLessThanOrEqual(3);
  });

  it("Stripe account id / livemode / PaymentIntent id / Charge id / Checkout Session id / Refund id / webhook metadata are never referenced anywhere in the export actions or domain hydration", () => {
    const s = codeOnly(readSource(ACTIONS_PATH)) + codeOnly(readSource(HYDRATION_PATH));
    expect(s).not.toMatch(/stripe_account_id|livemode|payment_intent|charge_id|checkout_session|webhook/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Pagination — chunked + exhaustive wired into every bulk export read
// ═══════════════════════════════════════════════════════════════════════════

describe("chunked + exhaustive pagination is wired into every bulk export read (Issue 3)", () => {
  it("exportActions.ts never issues a one-shot .in(...) read without going through fetchAllRowsExhaustively or fetchRowsByIdsExhaustively", () => {
    const s = codeOnly(readSource(ACTIONS_PATH));
    expect(s).toContain('import { fetchAllRowsExhaustively, fetchRowsByIdsExhaustively } from "@/lib/supabase/exhaustiveRange";');
    // Every .in( call site in this file is either inside one of the two
    // pagination helpers' own callback bodies, or (profiles table) is not
    // one-shot — assert the actor lookup specifically goes through
    // fetchRowsByIdsExhaustively rather than a bare await ... .in(...).
    expect(s).not.toMatch(/const \{ data: actors \} = await supabase/);
    expect(s).toMatch(/fetchRowsByIdsExhaustively<\{\s*\n\s*id: string; first_name: string \| null; last_name: string \| null;/);
  });

  it("the reversal-target lookup and parent-payment lookup both use fetchRowsByIdsExhaustively, never a bare .in(...) await", () => {
    const s = codeOnly(readSource(ACTIONS_PATH));
    const targetIdx = s.indexOf("reversalTargetIds.length > 0");
    const targetBlock = s.slice(targetIdx, targetIdx + 600);
    expect(targetBlock).toContain("fetchRowsByIdsExhaustively<{");

    const paymentsLookupIdx = s.indexOf("const { rows: paymentRows, error: paymentsLookupError }");
    expect(s.slice(paymentsLookupIdx, paymentsLookupIdx + 200)).toContain("fetchRowsByIdsExhaustively<{");
  });

  it("the Outstanding Balances provenance/source-summary lookup uses fetchRowsByIdsExhaustively, chunked by payment id", () => {
    const s = codeOnly(readSource(ACTIONS_PATH));
    const idx = s.indexOf("const { rows: provenanceEventRows, error: provenanceError }");
    expect(s.slice(idx, idx + 200)).toContain("fetchRowsByIdsExhaustively<{");
  });

  it("exportDomainHydration.ts's every .in(\"id\", ...) domain lookup goes through fetchRowsByIdsExhaustively, never a bare Promise.resolve/one-shot .select()", () => {
    const s = codeOnly(readSource(HYDRATION_PATH));
    const inCallCount = (s.match(/\.in\("id",\s*chunkIds\)/g) ?? []).length;
    // reservations, lesson_requests, event_participants, event_guests,
    // program_enrollments, roster_members, courts, profiles, events,
    // programs — 10 domain/reference lookups, all chunked.
    expect(inCallCount).toBe(10);
    expect(s).not.toMatch(/Promise\.resolve\(\{\s*data:\s*\[\]\s*\}\)/);
  });

  it("every chunked lookup in exportDomainHydration.ts orders by id for deterministic pagination", () => {
    const s = codeOnly(readSource(HYDRATION_PATH));
    const orderByIdCount = (s.match(/\.order\("id",\s*\{\s*ascending:\s*true\s*\}\)/g) ?? []).length;
    expect(orderByIdCount).toBe(10);
  });

  it("hydrateExportDomainContext propagates any underlying read error as an explicit failure — never returns a partial success map", () => {
    const s = codeOnly(readSource(HYDRATION_PATH));
    expect(s).toContain("export interface HydrationFailure");
    expect(s).toMatch(/if \(r\.error\) return \{ error: r\.error \};/);
  });

  it("both export actions check isHydrationFailure and abort (returning an error) rather than proceeding with a failed hydration", () => {
    const s = codeOnly(readSource(ACTIONS_PATH));
    const occurrences = (s.match(/if \(isHydrationFailure\(domainContextResult\)\)/g) ?? []).length;
    expect(occurrences).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Zero-row exports still produce headers
// ═══════════════════════════════════════════════════════════════════════════

describe("zero-row exports still produce a valid header-only CSV, never an error or empty file", () => {
  it("Outstanding Balances returns serializeCsv(..., []) when there are no genuinely outstanding payments", () => {
    const s = codeOnly(readSource(ACTIONS_PATH));
    expect(s).toContain("if (latestPayments.length === 0) {\n    return { csv: serializeCsv(OUTSTANDING_BALANCE_COLUMNS, []), filename };");
  });

  it("Payment Activity returns serializeCsv(..., []) when there are no matching events", () => {
    const s = codeOnly(readSource(ACTIONS_PATH));
    expect(s).toContain("if (rawEvents.length === 0) {\n    return { csv: serializeCsv(PAYMENT_ACTIVITY_COLUMNS, []), filename };");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// No migration / RPC / service-role path introduced
// ═══════════════════════════════════════════════════════════════════════════

describe("no migration, RPC, or service-role path is introduced by the export actions", () => {
  it("exportActions.ts never calls supabase.rpc(...) or creates a privileged/service-role client", () => {
    const s = codeOnly(readSource(ACTIONS_PATH));
    expect(s).not.toMatch(/\.rpc\(/);
    expect(s).not.toMatch(/createPrivilegedClient|service_role|SUPABASE_SERVICE/);
  });

  it("exportActions.ts never calls a payment-lifecycle-mutating RPC name (waive/void/refund/record_manual_payment/reverse_payment_event) — reads only", () => {
    const s = codeOnly(readSource(ACTIONS_PATH));
    expect(s).not.toMatch(/waive_payment|void_payment_obligation|record_manual_payment|reverse_payment_event\(|record_refund/);
  });

  it("neither export action calls .insert(, .update(, .delete(, or .upsert( — reads only, no mutation of any kind", () => {
    const s = codeOnly(readSource(ACTIONS_PATH));
    expect(s).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\.upsert\(/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Timezone fail-closed (Issue 5)
// ═══════════════════════════════════════════════════════════════════════════

describe("club timezone resolution fails closed — no America/New_York (or any) fallback for a financial export", () => {
  it("resolveExportContext never substitutes a fallback timezone; it returns the standard export failure when clubRow/timezone can't be loaded", () => {
    const s = codeOnly(readSource(ACTIONS_PATH));
    expect(s).not.toMatch(/America\/New_York/);
    const fnStart = s.indexOf("async function resolveExportContext(");
    const fnEnd = s.indexOf("\n}", s.indexOf("return { supabase", fnStart));
    const fn = s.slice(fnStart, fnEnd);
    expect(fn).toMatch(/if \(clubError \|\| !clubRow \|\| !clubRow\.timezone\)/);
    expect(fn).toContain("return { error: ERROR_MESSAGES.load_failed };");
  });

  it("clubTimezone is always assigned directly from clubRow.timezone — never a `??` fallback expression", () => {
    const s = codeOnly(readSource(ACTIONS_PATH));
    expect(s).toContain("clubTimezone: clubRow.timezone");
    expect(s).not.toMatch(/clubTimezone:\s*clubRow\?\.timezone\s*\?\?/);
  });

  it("slug MAY have a defensive non-financial fallback (cosmetic filename metadata only) — distinct from the timezone's fail-closed rule", () => {
    const s = codeOnly(readSource(ACTIONS_PATH));
    expect(s).toContain('const clubSlug = clubRow.slug ?? "club";');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Issue 1 — true-latest-cycle-then-outstanding ordering is actually wired
// ═══════════════════════════════════════════════════════════════════════════

describe("Outstanding Balances fetches the FULL payment set (unfiltered by status) before cycle selection (Issue 1)", () => {
  it("the payments query for Outstanding Balances does NOT filter by status — selectLatestGenuinelyOutstandingPayments performs that filtering AFTER true-latest-cycle selection", () => {
    const s = codeOnly(readSource(ACTIONS_PATH));
    const idx = s.indexOf("export async function exportOutstandingBalancesCsv(");
    const nextFnIdx = s.indexOf("export async function exportPaymentActivityCsv(");
    const body = s.slice(idx, nextFnIdx);
    // Locked order: no `.in("status", ...)` before selectLatestGenuinelyOutstandingPayments is called.
    const queryBlock = body.slice(0, body.indexOf("selectLatestGenuinelyOutstandingPayments"));
    expect(queryBlock).not.toMatch(/\.in\("status"/);
    expect(body).toContain("selectLatestGenuinelyOutstandingPayments(");
  });

  it("the full-payments query orders deterministically by id, not updated_at alone (updated_at is not guaranteed unique)", () => {
    const s = codeOnly(readSource(ACTIONS_PATH));
    const idx = s.indexOf("export async function exportOutstandingBalancesCsv(");
    const queryIdx = s.indexOf('.from("payments")', idx);
    const block = s.slice(queryIdx, queryIdx + 400);
    expect(block).toContain('.order("id", { ascending: true })');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Issue 2 — collectibility filter is actually wired, reusing the same
// predicate page.tsx's Record Payment gate now also uses
// ═══════════════════════════════════════════════════════════════════════════

describe("Outstanding Balances excludes non-collectible (cancelled-family) rows using the SAME predicate as Record Payment (Issue 2)", () => {
  it("exportOutstandingBalancesCsv skips a row whose domainContext.collectible is false", () => {
    const s = codeOnly(readSource(ACTIONS_PATH));
    expect(s).toContain("if (!domainContext.collectible) continue;");
  });

  it("page.tsx's recordPaymentBlocked and the export's domain hydration both call the SAME is*Collectible predicates from paymentContext.ts — not a competing definition", () => {
    const pageSrc = codeOnly(readSource(PAGE_PATH));
    const hydrationSrc = codeOnly(readSource(HYDRATION_PATH));
    for (const predicate of [
      "isReservationCollectible", "isLessonRequestCollectible",
      "isEventParticipantCollectible", "isEventGuestCollectible", "isProgramEnrollmentCollectible",
    ]) {
      expect(pageSrc).toContain(predicate);
      expect(hydrationSrc).toContain(predicate);
    }
  });

  it("Payment Activity (a historical ledger, not a 'what's owed now' report) is NOT filtered by collectibility — it must show what actually happened regardless of current lifecycle state", () => {
    const s = codeOnly(readSource(ACTIONS_PATH));
    const idx = s.indexOf("export async function exportPaymentActivityCsv(");
    const body = s.slice(idx);
    expect(body).not.toMatch(/\.collectible/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Completeness pass — a financial export must never silently drop a row
// (A, B, H, I, J, K from the completeness-pass spec). Items C-G are
// covered as GENUINE unit tests against a mocked Supabase client in
// exportDomainHydration.test.ts, not source-inspection here.
// ═══════════════════════════════════════════════════════════════════════════

describe("K. no financial row uses `continue` to hide missing required payment/domain context", () => {
  it("exportActions.ts's ONLY `continue` is the Issue-2 intentional non-collectible EXCLUSION — never used to skip a missing required payment/domain context", () => {
    const s = codeOnly(readSource(ACTIONS_PATH));
    const continueLines = s.split("\n").filter((line) => /\bcontinue;/.test(line));
    expect(continueLines).toHaveLength(1);
    expect(continueLines[0]).toContain("if (!domainContext.collectible) continue;");
  });

  it("exportDomainHydration.ts's per-domain hydration loop never uses `continue` for a missing required row — it returns { error } instead", () => {
    const s = codeOnly(readSource(HYDRATION_PATH));
    expect(s).not.toMatch(/\bcontinue;/);
    // Every required-row guard returns a HydrationFailure object directly.
    const requiredGuards = (s.match(/if \(!\w+\) return \{ error: /g) ?? []).length;
    // reservation, lesson_request, event_participant row, event_participant's
    // parent event, event_guest row, event_guest's parent event,
    // program_enrollment row, program_enrollment's parent program = 8.
    expect(requiredGuards).toBe(8);
  });
});

describe("A. Payment Activity: a selected event with an unresolvable parent payment fails the export, never a partial CSV", () => {
  it("the row-building loop checks `if (!payment)` and returns the standard export failure — never continues past a missing parent payment", () => {
    const s = codeOnly(readSource(ACTIONS_PATH));
    const loopIdx = s.indexOf("for (const event of rawEvents) {");
    const loopBody = s.slice(loopIdx, s.indexOf("rows.push(buildPaymentActivityRow(", loopIdx));
    expect(loopBody).toMatch(/if \(!payment\) \{[\s\S]*?return \{ error: ERROR_MESSAGES\.load_failed \};/);
  });
});

describe("B. Payment Activity: a selected event with unresolvable required domain context fails the export, never a partial CSV", () => {
  it("the row-building loop checks `if (!domainContext)` and returns the standard export failure", () => {
    const s = codeOnly(readSource(ACTIONS_PATH));
    const loopIdx = s.indexOf("for (const event of rawEvents) {");
    const loopBody = s.slice(loopIdx, s.indexOf("rows.push(buildPaymentActivityRow(", loopIdx));
    expect(loopBody).toMatch(/if \(!domainContext\) \{[\s\S]*?return \{ error: ERROR_MESSAGES\.load_failed \};/);
  });
});

describe("H. a selected reverse_payment_event whose reverses_event_id is absent from the successful target lookup fails the export", () => {
  it("an explicit completeness check iterates rawEvents and fails when a reversal's target id is not present in targetEventById", () => {
    const s = codeOnly(readSource(ACTIONS_PATH));
    expect(s).toMatch(/event\.event_type === "reverse_payment_event" && event\.reverses_event_id\s*\n?\s*&& !targetEventById\.has\(event\.reverses_event_id\)/);
    const checkIdx = s.search(/event\.event_type === "reverse_payment_event" && event\.reverses_event_id/);
    const checkBlock = s.slice(checkIdx, checkIdx + 400);
    expect(checkBlock).toContain("return { error: ERROR_MESSAGES.load_failed };");
  });

  it("this check runs BEFORE domain hydration/row-building, using the fully-resolved targetEventById from the (already-succeeded) reversal-target query", () => {
    const s = codeOnly(readSource(ACTIONS_PATH));
    const targetQueryIdx = s.indexOf("const { rows: targetRows, error: targetError }");
    const reversalCheckIdx = s.search(/event\.event_type === "reverse_payment_event" && event\.reverses_event_id\s*\n?\s*&& !targetEventById\.has/);
    const rowBuildLoopIdx = s.indexOf("for (const event of rawEvents) {\n    const payment = paymentById.get(");
    expect(targetQueryIdx).toBeGreaterThan(-1);
    expect(reversalCheckIdx).toBeGreaterThan(targetQueryIdx);
    expect(rowBuildLoopIdx).toBeGreaterThan(reversalCheckIdx);
  });
});

describe("I. signedAmountCentsForEvent returning null for an included activity event can never reach CSV serialization", () => {
  it("the row-building loop checks signedAmountCents === null and fails the export BEFORE calling buildPaymentActivityRow", () => {
    const s = codeOnly(readSource(ACTIONS_PATH));
    const signedAmountIdx = s.indexOf("const signedAmountCents = signedAmountCentsForEvent(");
    const buildRowIdx = s.indexOf("rows.push(buildPaymentActivityRow(", signedAmountIdx);
    const between = s.slice(signedAmountIdx, buildRowIdx);
    expect(between).toMatch(/if \(signedAmountCents === null\) \{[\s\S]*?return \{ error: ERROR_MESSAGES\.load_failed \};/);
  });

  it("buildPaymentActivityRow is only ever called with the narrowed, non-null signedAmountCents local — not a re-derived or optional value", () => {
    const s = codeOnly(readSource(ACTIONS_PATH));
    expect(s).toContain("signedAmountCents,\n      currency: payment.currency,");
  });
});

describe("J. an optional missing actor profile does NOT fail the export", () => {
  it("actor-name resolution only fails the export on a genuine READ error (actorsError), never on a simply-absent profile row for a given actor id", () => {
    const s = codeOnly(readSource(ACTIONS_PATH));
    const actorBlockIdx = s.indexOf("const actorIds = [...new Set(");
    const actorBlockEnd = s.indexOf("const rows = [];", actorBlockIdx);
    const actorBlock = s.slice(actorBlockIdx, actorBlockEnd);
    // Fails only on a query error...
    expect(actorBlock).toMatch(/if \(actorsError\) \{[\s\S]*?return \{ error: ERROR_MESSAGES\.load_failed \};/);
    // ...never on a for-loop check like `if (!actorNameById.has(...))`.
    expect(actorBlock).not.toMatch(/if \(!actorNameById/);
  });

  it("Recorded By is read via a plain `?? null` optional lookup in the row-building loop, never gated behind a required-context check", () => {
    const s = codeOnly(readSource(ACTIONS_PATH));
    expect(s).toContain("actorName: event.actor_id ? actorNameById.get(event.actor_id) ?? null : null,");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Final runtime-QA correction — child-level cancellation must gate
// collectibility, not just the parent's own status (12, 13 from the spec;
// 14/15 are covered as genuine unit tests in exportDomainHydration.test.ts).
// ═══════════════════════════════════════════════════════════════════════════

describe("12. page.tsx's Record Payment gating passes BOTH parent and child statuses to the two-argument collectibility predicates", () => {
  it("event_participant: recordPaymentBlocked is derived from isEventParticipantCollectible(ev?.status, r.status) — the participant row's OWN status, not just the parent Event's", () => {
    const s = codeOnly(readSource(PAGE_PATH));
    expect(s).toContain("recordPaymentBlocked = !isEventParticipantCollectible(ev?.status, r.status);");
  });

  it("program_enrollment: recordPaymentBlocked is derived from isProgramEnrollmentCollectible(prog?.status, r.status) — the enrollment row's OWN status, not just the parent Program's", () => {
    const s = codeOnly(readSource(PAGE_PATH));
    expect(s).toContain("recordPaymentBlocked = !isProgramEnrollmentCollectible(prog?.status, r.status);");
  });

  it("the underlying predicates themselves now declare two parameters — a single-argument call site would be a TypeScript compile error, so this wiring can't silently regress to parent-only", () => {
    const s = codeOnly(readSource("src/app/(app)/admin/payments/paymentContext.ts"));
    expect(s).toMatch(/export function isEventParticipantCollectible\(\s*\n?\s*eventStatus: string \| undefined,\s*\n?\s*participantStatus: string,?\s*\n?\s*\): boolean/);
    expect(s).toMatch(/export function isProgramEnrollmentCollectible\(\s*\n?\s*programStatus: string \| undefined,\s*\n?\s*enrollmentStatus: string,?\s*\n?\s*\): boolean/);
  });
});

describe("13. exportDomainHydration.ts passes BOTH parent and child statuses to the same two-argument collectibility predicates the export uses", () => {
  it("event_participant: collectible is derived from isEventParticipantCollectible(ev.status, r.status)", () => {
    const s = codeOnly(readSource(HYDRATION_PATH));
    expect(s).toContain("collectible = isEventParticipantCollectible(ev.status, r.status);");
  });

  it("program_enrollment: collectible is derived from isProgramEnrollmentCollectible(prog.status, r.status)", () => {
    const s = codeOnly(readSource(HYDRATION_PATH));
    expect(s).toContain("collectible = isProgramEnrollmentCollectible(prog.status, r.status);");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Final runtime-QA correction — Issue 3: Export control moved into the
// primary toolbar row, neutral (never brand/status green) styling, menu
// options unchanged, outside-click/Escape dismissal preserved.
// ═══════════════════════════════════════════════════════════════════════════

const CLIENT_PATH = "src/app/(app)/admin/payments/AdminPaymentsClient.tsx";
const EXPORT_MENU_PATH = "src/app/(app)/admin/payments/PaymentExportMenu.tsx";

// Admin Cleanup Checkpoint 6 — the Outstanding/Payment Activity/Overview
// tab strip now gets its OWN full-width row (equal-width grid cells),
// matching the approved tab-strip treatment used elsewhere in this app
// (Courts/Lessons/Communications) — a third tab (Overview) made the prior
// single shared toolbar row too cramped, the same reasoning that already
// drove this pattern everywhere else it's used. The search input +
// PaymentExportMenu remain together in their own row immediately below,
// rendered only for the Outstanding/Payment Activity tabs (never Overview,
// which has no list to search or export).
describe("Export control lives in the SAME row as Search, immediately below the (now separate) tab strip", () => {
  it("AdminPaymentsClient.tsx renders <PaymentExportMenu> inside the toolbar div that also contains the search <input>, after the tab strip's own separate row (Phase 43B-3E2 restyled the tab strip itself onto the shared PageTabs component; its position relative to the toolbar below is unchanged)", () => {
    const s = codeOnly(readSource(CLIENT_PATH));
    const tabStripIdx = s.indexOf("<PageTabs");
    expect(tabStripIdx).toBeGreaterThan(-1);
    const toolbarIdx = s.indexOf('<div className="flex flex-col sm:flex-row gap-2 mb-4">', tabStripIdx);
    expect(toolbarIdx).toBeGreaterThan(tabStripIdx);
    const searchInputIdx = s.indexOf('placeholder="Search by name…"', toolbarIdx);
    const exportMenuIdx = s.indexOf("<PaymentExportMenu", toolbarIdx);
    // G-D1 added a conditional {truncated && (...)} notice between the
    // toolbar's own closing </div> and the {filtered.length...} block —
    // find the toolbar's closing tag directly rather than assuming it's
    // immediately followed by {filtered.length.
    const toolbarCloseIdx = s.indexOf("</div>", exportMenuIdx);
    expect(searchInputIdx).toBeGreaterThan(toolbarIdx);
    expect(exportMenuIdx).toBeGreaterThan(searchInputIdx);
    expect(toolbarCloseIdx).toBeGreaterThan(exportMenuIdx);
  });

  it("the explanatory summary paragraph is its own standalone element, no longer sharing a flex row with the Export control", () => {
    const s = codeOnly(readSource(CLIENT_PATH));
    expect(s).toContain('<p className="text-xs text-gray-400 dark:text-gray-500 mb-4">');
    expect(s).not.toMatch(/flex items-start justify-between gap-3 mb-4/);
  });
});

describe("Export trigger styling is neutral secondary/outlined — never Court Time brand green or semantic status green", () => {
  it("the trigger button's className contains no green/brand-accent utility classes", () => {
    const s = codeOnly(readSource(EXPORT_MENU_PATH));
    const buttonStart = s.indexOf("<button\n        onClick={() => setOpen(v => !v)}");
    const buttonEnd = s.indexOf("</button>", buttonStart);
    const buttonMarkup = s.slice(buttonStart, buttonEnd);
    expect(buttonMarkup).not.toMatch(/bg-green|text-green|border-green|ct-brand|bg-accent|text-accent|border-accent/);
    // Neutral gray outlined scheme, matching the existing Details button convention.
    expect(buttonMarkup).toMatch(/text-gray-600/);
    expect(buttonMarkup).toMatch(/border-gray-200/);
  });

  it("the trigger includes a download icon and a chevron indicator, from this project's existing hand-written inline-SVG icon convention (viewBox 0 0 24 24, stroke=currentColor) — no new icon library dependency", () => {
    const s = codeOnly(readSource(EXPORT_MENU_PATH));
    expect(s).toContain("function DownloadIcon()");
    expect(s).toContain("function ChevronIcon()");
    expect(s).toMatch(/viewBox="0 0 24 24" fill="none" stroke="currentColor"/);
  });

  it("the trigger is approximately the same visual height as the adjacent toolbar controls (px-4 py-2, text-sm font-semibold — matching the Outstanding/All tab buttons exactly)", () => {
    const s = codeOnly(readSource(EXPORT_MENU_PATH));
    expect(s).toContain("px-4 py-2 rounded-lg text-sm font-semibold");
  });

  it("on mobile the trigger is full-width (w-full sm:w-auto), matching the tabs container's own stacking convention — no overflow", () => {
    const s = codeOnly(readSource(EXPORT_MENU_PATH));
    expect(s).toContain('className="relative w-full sm:w-auto"');
    expect(s).toContain("w-full sm:w-auto inline-flex items-center justify-center");
  });
});

describe("menu options remain exactly 'Outstanding balances' and 'Payment activity' — no Filters/expanded Search added", () => {
  it("PaymentExportMenu renders exactly two menu items with the exact required labels, nothing else", () => {
    const s = codeOnly(readSource(EXPORT_MENU_PATH));
    expect(s).toContain("Outstanding balances");
    expect(s).toContain("Payment activity");
    expect((s.match(/onClick=\{handleOutstandingBalances\}/g) ?? []).length).toBe(1);
    expect(s).toContain("onClick={() => { close(); setShowActivitySheet(true); }}");
    // Exactly these two menu-item buttons inside the <nav> panel — nothing else.
    const navIdx = s.indexOf("<nav");
    const navEnd = s.indexOf("</nav>", navIdx);
    const navBody = s.slice(navIdx, navEnd);
    expect((navBody.match(/<button/g) ?? []).length).toBe(2);
  });

  it("no Filters control or expanded Search input was added anywhere in this file or AdminPaymentsClient.tsx (both explicitly deferred backlog items)", () => {
    const menuSrc = codeOnly(readSource(EXPORT_MENU_PATH));
    const clientSrc = codeOnly(readSource(CLIENT_PATH));
    expect(menuSrc).not.toMatch(/Filters/i);
    expect(clientSrc).not.toMatch(/Filters/i);
  });
});

describe("outside-click and Escape dismissal are preserved", () => {
  it("a transparent full-screen backdrop closes the menu on click, and an Escape keydown listener closes it too — unchanged from the original implementation", () => {
    const s = codeOnly(readSource(EXPORT_MENU_PATH));
    expect(s).toContain('<div className="fixed inset-0 z-40" onClick={close} />');
    expect(s).toContain('if (e.key === "Escape") close();');
  });
});
