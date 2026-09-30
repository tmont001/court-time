import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 45C2 — removes obsolete `(supabase.rpc as any)`/`(supabase.from as
// any)` escape hatches that existed only because the previous hand-
// maintained Database type map was incomplete/stale (archive_event/
// unarchive_event, and lesson_requests/lesson_types reads across four
// call sites). Now that database.types.ts is real generated output and
// these tables/functions are structurally present, the casts are provably
// unnecessary — confirmed by `pnpm tsc --noEmit` passing with them
// removed, not assumed. Type-safety cleanup only: no runtime behavior,
// RPC arguments, select columns, filters, or authorization changed.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const EVENTS_ACTIONS_PATH        = "src/app/(app)/admin/events/actions.ts";
const EXPORT_HYDRATION_PATH      = "src/app/(app)/admin/payments/exportDomainHydration.ts";
const PAYMENTS_PAGE_PATH         = "src/app/(app)/admin/payments/page.tsx";
const LESSON_REQUEST_DETAIL_PATH = "src/app/(app)/lessons/LessonRequestDetail.tsx";
const LESSON_PRO_SHEET_PATH      = "src/app/(app)/events/LessonProSheet.tsx";
const EXPORT_ACTIONS_PATH        = "src/app/(app)/admin/payments/exportActions.ts";
const LESSONS_ACTIONS_PATH       = "src/app/(app)/lessons/actions.ts";
const TYPES_PATH                 = "src/lib/db/types.ts";
const GENERATED_PATH             = "src/lib/db/database.types.ts";
const MIGRATION_0211_PATH        = "supabase/migrations/0211_member_notes_schema_reconciliation.sql";
const MIGRATION_0212_PATH        = "supabase/migrations/0212_restore_member_note.sql";

// ─────────────────────────────────────────────────────────────────────────
// 1-2. archive_event/unarchive_event use plain typed supabase.rpc.
// ─────────────────────────────────────────────────────────────────────────

describe("admin/events/actions.ts — archive_event/unarchive_event use typed supabase.rpc, no cast", () => {
  it("archiveEventAction calls supabase.rpc(\"archive_event\", { p_event_id: eventId }) with no (supabase.rpc as any) wrapper", () => {
    const s = readSource(EVENTS_ACTIONS_PATH);
    expect(s).toContain('await supabase.rpc("archive_event", { p_event_id: eventId });');
    expect(s).not.toContain('(supabase.rpc as any)("archive_event"');
  });

  it("unarchiveEventAction calls supabase.rpc(\"unarchive_event\", { p_event_id: eventId }) with no (supabase.rpc as any) wrapper", () => {
    const s = readSource(EVENTS_ACTIONS_PATH);
    expect(s).toContain('await supabase.rpc("unarchive_event", { p_event_id: eventId });');
    expect(s).not.toContain('(supabase.rpc as any)("unarchive_event"');
  });

  it("no `as any` remains anywhere in this file", () => {
    const s = readSource(EVENTS_ACTIONS_PATH);
    expect(s).not.toContain("as any");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3-4. lesson_requests/lesson_types reads use plain typed supabase.from.
// ─────────────────────────────────────────────────────────────────────────

describe("lesson_requests/lesson_types reads use typed supabase.from across all four call sites, no cast", () => {
  it("exportDomainHydration.ts's lesson_requests read is typed, exact select/order/range preserved", () => {
    const s = readSource(EXPORT_HYDRATION_PATH);
    expect(s).not.toContain('(supabase.from as any)("lesson_requests")');
    expect(s).toContain('supabase\n          .from("lesson_requests")\n          .select("id, pro_id, proposed_starts_at, proposed_ends_at, status")\n          .in("id", chunkIds)\n          .order("id", { ascending: true })\n          .range(offset, offset + limit - 1);');
  });

  it("admin/payments/page.tsx's lesson_requests read is typed, exact select/filter preserved", () => {
    const s = readSource(PAYMENTS_PAGE_PATH);
    expect(s).not.toContain('(supabase.from as any)("lesson_requests")');
    expect(s).toContain('supabase.from("lesson_requests").select("id, pro_id, proposed_starts_at, proposed_ends_at, status").in("id", idsByDomain.lesson_request)');
  });

  it("LessonRequestDetail.tsx's price_amount_cents read is typed, exact select/filter preserved, no replacement result-type cast", () => {
    const s = readSource(LESSON_REQUEST_DETAIL_PATH);
    expect(s).not.toContain('(supabase.from as any)("lesson_requests")');
    expect(s).toContain('.from("lesson_requests")');
    expect(s).toContain('.select("price_amount_cents")');
    expect(s).toContain('.eq("id", request.id)');
    expect(s).toContain(".single();");
    // The manual `as { data: {...} | null }` result cast this `(supabase.
    // from as any)` forced is now provably redundant (database.types.ts's
    // price_amount_cents is already `number | null`) and was removed too —
    // not merely swapped for a different escape hatch.
    expect(s).not.toMatch(/\.single\(\)\s*as\s*\{/);
  });

  it("LessonProSheet.tsx's lesson_requests AND lesson_types reads are both typed, exact selects/filters preserved, no replacement result-type casts", () => {
    const s = readSource(LESSON_PRO_SHEET_PATH);
    expect(s).not.toContain('(supabase.from as any)("lesson_requests")');
    expect(s).not.toContain('(supabase.from as any)("lesson_types")');
    expect(s).toContain('.from("lesson_requests")');
    expect(s).toContain('.select("lesson_type_id, pricing_basis, unit_price_amount_cents, price_amount_cents")');
    expect(s).toContain('.from("lesson_types")');
    expect(s).toContain('.select("allowed_durations")');
    expect(s).toContain('.eq("id", lr.lesson_type_id)');
    expect(s).not.toMatch(/\.single\(\)\s*as\s*\{/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 7-9. Stale comments removed; no replacement escape hatch; no broad
// manual override introduced.
// ─────────────────────────────────────────────────────────────────────────

describe("no replacement escape hatch, no stale type-lag comment, no broad manual override was introduced for these five call sites", () => {
  it("admin/events/actions.ts: the archive_event/unarchive_event calls themselves carry no \"as unknown as\" (the file's own unrelated pre-existing usage elsewhere is out of scope)", () => {
    const s = readSource(EVENTS_ACTIONS_PATH);
    const archiveIdx = s.indexOf('supabase.rpc("archive_event"');
    const unarchiveIdx = s.indexOf('supabase.rpc("unarchive_event"');
    expect(archiveIdx).toBeGreaterThan(-1);
    expect(unarchiveIdx).toBeGreaterThan(-1);
    expect(s.slice(archiveIdx - 20, archiveIdx + 80)).not.toContain("as unknown as");
    expect(s.slice(unarchiveIdx - 20, unarchiveIdx + 80)).not.toContain("as unknown as");
  });

  for (const path of [EXPORT_HYDRATION_PATH, PAYMENTS_PAGE_PATH, LESSON_REQUEST_DETAIL_PATH, LESSON_PRO_SHEET_PATH]) {
    it(`${path}: no "as unknown as" (or equivalent double-cast) escape hatch remains anywhere in the file`, () => {
      const s = readSource(path);
      expect(s).not.toContain("as unknown as");
    });
  }

  it("exportDomainHydration.ts's stale 'staleness workaround' comment for lesson_requests is gone", () => {
    const s = readSource(EXPORT_HYDRATION_PATH);
    expect(s).not.toContain("Same pre-existing db/types.ts staleness workaround");
  });

  it("LessonProSheet.tsx's stale 'generated-types-lag' comment (and its now-dangling reference to admin/events/actions.ts's removed cast) is gone", () => {
    const s = readSource(LESSON_PRO_SHEET_PATH);
    expect(s).not.toContain("aren't in the generated");
    expect(s).not.toContain("archive_event");
  });

  it("admin/payments/page.tsx's payment_events comment no longer claims to mirror a lesson_requests cast that was removed from this file", () => {
    const s = readSource(PAYMENTS_PAGE_PATH);
    expect(s).not.toContain("mirrors this same file's own lesson_requests");
  });

  it("types.ts gained no new archive_event/unarchive_event FunctionsOverride entry — both already flowed through GeneratedFunctions unmodified", () => {
    const s = readSource(TYPES_PATH);
    expect(s).not.toMatch(/archive_event:\s*[{<]/);
    expect(s).not.toMatch(/unarchive_event:\s*[{<]/);
  });

  it("types.ts's PRE-EXISTING lesson_requests/lesson_types TablesOverride entries were not duplicated — each key appears exactly once", () => {
    const s = readSource(TYPES_PATH);
    const lessonRequestsMatches = s.match(/\blesson_requests:\s*Omit</g) ?? [];
    const lessonTypesMatches = s.match(/\blesson_types:\s*Omit</g) ?? [];
    expect(lessonRequestsMatches.length).toBe(1);
    expect(lessonTypesMatches.length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 10. Legitimate narrow overrides in types.ts remain untouched.
// ─────────────────────────────────────────────────────────────────────────

describe("legitimate narrow domain overrides in types.ts are untouched by this cleanup", () => {
  it("lesson_requests/lesson_types literal-union corrections (status/pricing_basis/etc.) are still present", () => {
    const s = readSource(TYPES_PATH);
    expect(s).toContain("type LessonRequestsRow");
    expect(s).toContain("type LessonTypesRow");
    expect(s).toContain('pricing_basis: "flat" | "hourly"');
  });

  it("get_member_notes nullable refinement and add_member_note narrow Returns refinement are still present", () => {
    const s = readSource(TYPES_PATH);
    expect(s).toContain("get_member_notes: OverrideArrayReturns<");
    expect(s).toContain('add_member_note: Omit<GeneratedFunctions["add_member_note"], "Returns">');
  });

  it("restore_member_note and the activity-normalization corrections (get_member_upcoming_activity/get_member_activity_history) remain flow-through/narrow as Phase 45C1A3/45C1B left them", () => {
    const s = readSource(TYPES_PATH);
    expect(s).not.toMatch(/restore_member_note:\s*\{/);
    expect(s).toContain("get_member_upcoming_activity: OverrideArrayReturns<");
    expect(s).toContain("get_member_activity_history: OverrideArrayReturns<");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Generated support proof: archive_event/unarchive_event/lesson_requests/
// lesson_types are all real, structurally present in database.types.ts.
// ─────────────────────────────────────────────────────────────────────────

describe("database.types.ts (generated, never hand-edited) structurally supports all four cleanup targets", () => {
  it("archive_event/unarchive_event both take { p_event_id: string }", () => {
    const s = readSource(GENERATED_PATH);
    expect(s).toMatch(/archive_event:\s*\{\s*\n\s*Args:\s*\{\s*p_event_id:\s*string\s*\}/);
    expect(s).toMatch(/unarchive_event:\s*\{\s*\n\s*Args:\s*\{\s*p_event_id:\s*string\s*\}/);
  });

  it("lesson_requests table exists with the exact columns these five call sites select", () => {
    const s = readSource(GENERATED_PATH);
    expect(s).toContain("      lesson_requests: {");
    for (const col of ["pro_id", "proposed_starts_at", "proposed_ends_at", "status", "lesson_type_id", "pricing_basis", "unit_price_amount_cents", "price_amount_cents"]) {
      expect(s).toContain(`${col}:`);
    }
  });

  it("lesson_types table exists with allowed_durations", () => {
    const s = readSource(GENERATED_PATH);
    expect(s).toContain("      lesson_types: {");
    expect(s).toContain("allowed_durations: number[] | null");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Phase 45C2B — payment_events.event_type union reconciliation. Phase 45C2
// proved the three payment_events casts were caused by types.ts's OWN
// hand-maintained PaymentEventsRow.event_type union lagging two live CHECK
// widenings (migration 0150 added online_payment_recorded, 0153 added
// online_refund_recorded — confirmed against both migration history AND a
// live pg_get_constraintdef read of payment_events_event_type_check, which
// agree exactly: 9 values, no drift between them). The narrow domain union
// was corrected to the complete 9-value set, and all three casts removed.
// ─────────────────────────────────────────────────────────────────────────

describe("PaymentEventsRow.event_type is now the complete authoritative 9-value CHECK set — a literal union, not plain string", () => {
  it("contains all 9 authoritative values, none missing", () => {
    const s = readSource(TYPES_PATH);
    const idx = s.indexOf("type PaymentEventsRow = {");
    expect(idx).toBeGreaterThan(-1);
    const block = s.slice(idx, s.indexOf("};", idx));
    for (const value of [
      "obligation_created", "obligation_amount_adjusted", "manual_payment_recorded",
      "online_payment_recorded", "refund_recorded", "online_refund_recorded",
      "reverse_payment_event", "void_payment_obligation", "waived",
    ]) {
      expect(block).toContain(`"${value}"`);
    }
  });

  it("event_type is still a literal union (piped string literals), not widened to plain string", () => {
    const s = readSource(TYPES_PATH);
    const idx = s.indexOf("event_type:", s.indexOf("type PaymentEventsRow = {"));
    expect(idx).toBeGreaterThan(-1);
    const fieldBlock = s.slice(idx, s.indexOf(";", idx));
    const pipeCount = (fieldBlock.match(/\|\s*"/g) ?? []).length;
    expect(pipeCount).toBe(9); // this file's leading-pipe style: each of the 9 values, including the first, is prefixed with "| "
    expect(fieldBlock).not.toMatch(/event_type:\s*string/);
  });

  it("the method field override is untouched", () => {
    const s = readSource(TYPES_PATH);
    expect(s).toContain('method: "cash" | "check" | "card_terminal" | "bank_transfer" | "digital_wallet" | "other" | null;');
  });
});

describe("all three payment_events.event_type casts are removed — ordinary typed .in(...) calls now", () => {
  it("admin/payments/page.tsx's .in(\"event_type\", ...) has no `as any`, and the exact same three literal values are still queried", () => {
    const s = readSource(PAYMENTS_PAGE_PATH);
    expect(s).toContain('.in("event_type", ["manual_payment_recorded", "online_payment_recorded", "reverse_payment_event"])');
    expect(s).not.toContain('.in("event_type", ["manual_payment_recorded", "online_payment_recorded", "reverse_payment_event"] as any)');
  });

  it("exportActions.ts's first .in(\"event_type\", ...) has no `as any`, and the exact same three literal values are still queried", () => {
    const s = readSource(EXPORT_ACTIONS_PATH);
    expect(s).toContain('.in("event_type", ["manual_payment_recorded", "online_payment_recorded", "reverse_payment_event"])');
    expect(s).not.toContain('.in("event_type", ["manual_payment_recorded", "online_payment_recorded", "reverse_payment_event"] as any)');
  });

  it("exportActions.ts's PAYMENT_ACTIVITY_EVENT_TYPES query has no `as any`", () => {
    const s = readSource(EXPORT_ACTIONS_PATH);
    expect(s).toContain('.in("event_type", PAYMENT_ACTIVITY_EVENT_TYPES)');
    expect(s).not.toContain(".in(\"event_type\", PAYMENT_ACTIVITY_EVENT_TYPES as any)");
  });

  it("PAYMENT_ACTIVITY_EVENT_TYPES itself is unchanged — same 5 values, still `as const`, no widening to string[]", () => {
    const s = readSource("src/app/(app)/admin/payments/exportLogic.ts");
    const idx = s.indexOf("export const PAYMENT_ACTIVITY_EVENT_TYPES = [");
    expect(idx).toBeGreaterThan(-1);
    const block = s.slice(idx, s.indexOf("] as const;", idx) + "] as const;".length);
    for (const value of ["manual_payment_recorded", "online_payment_recorded", "refund_recorded", "online_refund_recorded", "reverse_payment_event"]) {
      expect(block).toContain(`"${value}"`);
    }
    expect(block).toContain("] as const;");
  });

  it("no replacement `as unknown as` or equivalent escape hatch was added at any of the three call sites", () => {
    for (const path of [PAYMENTS_PAGE_PATH, EXPORT_ACTIONS_PATH]) {
      const s = readSource(path);
      expect(s).not.toContain("as unknown as");
    }
  });

  it("no `as any` remains anywhere in exportActions.ts", () => {
    const s = readSource(EXPORT_ACTIONS_PATH);
    expect(s).not.toContain("as any");
  });

  it("query semantics (select/eq/in/order/range) around all three filters are otherwise unchanged", () => {
    const pageSrc = readSource(PAYMENTS_PAGE_PATH);
    expect(pageSrc).toContain('.select("id, payment_id, event_type, method, reverses_event_id")');
    expect(pageSrc).toContain('.eq("club_id", clubId)');
    expect(pageSrc).toContain('.in("payment_id", paymentIds)');

    const exportSrc = readSource(EXPORT_ACTIONS_PATH);
    expect(exportSrc).toContain('.select("id, payment_id, event_type, method, reverses_event_id, occurred_at")');
    expect(exportSrc).toContain('.order("id", { ascending: true })');
    expect(exportSrc).toContain('.select("id, payment_id, event_type, amount_cents, method, external_reference, notes, reverses_event_id, actor_id, occurred_at")');
    expect(exportSrc).toContain('.order("occurred_at", { ascending: true })');
  });
});

describe("database.types.ts was not hand-edited for this reconciliation — the fix lives entirely in types.ts's domain layer", () => {
  it("database.types.ts still types payment_events.event_type as plain string (generator behavior, untouched)", () => {
    const s = readSource(GENERATED_PATH);
    const idx = s.indexOf("      payment_events: {");
    expect(idx).toBeGreaterThan(-1);
    const block = s.slice(idx, idx + 600);
    expect(block).toContain("event_type: string");
  });
});

describe("the one known unrelated remaining cast is intentionally untouched", () => {
  it("lessons/actions.ts's p_preferred_windows Json-value cast remains exactly as-is — a Record<string, unknown> vs Json mismatch, not schema-map drift, explicitly out of THIS checkpoint's scope", () => {
    const s = readSource(LESSONS_ACTIONS_PATH);
    expect(s).toContain("p_preferred_windows:   (params.p_preferred_windows ?? null) as any,");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 11-13. Migration immutability.
// ─────────────────────────────────────────────────────────────────────────

describe("0211/0212 untouched; this type-safety-only cleanup added no migration of its own", () => {
  it("0211 still contains fingerprints from every prior correction round", () => {
    const s = readSource(MIGRATION_0211_PATH);
    expect(s).toContain("-- 1a. member_notes — member_id FK convergence (ON DELETE CASCADE)");
    expect(s).toContain("\\mlength\\s*\\(");
  });

  it("0212 still contains its full restore_member_note contract", () => {
    const s = readSource(MIGRATION_0212_PATH);
    expect(s).toContain("if not v_note.is_archived then raise exception 'note_not_archived'; end if;");
  });

  // "0212 remains the highest migration — no 0213" was previously asserted
  // here as a hardcoded "highest migration === 212" ceiling. Removed: that
  // pattern is invalid for a historical checkpoint's regression suite — it
  // cannot prove no LATER, unrelated checkpoint will ever add a migration
  // (several have since: 0213-0216, added by Phase 45D). This checkpoint
  // truthfully added no migration of its own, which the two contract checks
  // above continue to prove by confirming 0211/0212 are exactly as this
  // checkpoint left them; migration-specific claims for later migrations
  // belong in the test suite of the checkpoint that actually owns them. See
  // topLevelBackLinkCleanup.regression.test.ts's own note on this same
  // cleanup.
});
