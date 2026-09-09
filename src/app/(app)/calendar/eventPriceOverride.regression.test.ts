import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Runtime QA (34F-B polish, then a pre-commit atomicity correction) —
// regression coverage for exposing Event price override in Create Event
// and confirming Edit Event's own pre-existing price control keeps its
// locked invariants, using this repository's established source-inspection
// style (no jsdom — see this project's other *.regression.test.ts files
// for the same precedent).
//
// UPDATED after the pre-commit correction: the original polish pass's
// two-committed-call sequence (create_event, then a separate Server Action
// round-trip calling setEventPriceOverrideAction) was replaced by a single
// atomic RPC, create_event_with_price_override (migration 0162) — see
// eventCreatePriceAtomicity.regression.test.ts for the dedicated coverage
// of that correction (composition, atomicity, role gating, rollback). The
// tests below now assert the CURRENT (post-correction) shape; a few that
// specifically described the old two-call sequence have been updated
// in place rather than left describing removed code.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !line.trim().startsWith("--") && !line.trim().startsWith("//"))
    .join("\n");
}

const CREATE_SHEET_PATH = "src/app/(app)/calendar/CreateEventSheet.tsx";
const EDIT_SHEET_PATH = "src/app/(app)/calendar/EditEventSheet.tsx";
const CALENDAR_ACTIONS_PATH = "src/app/(app)/calendar/actions.ts";
const ADMIN_EVENTS_ACTIONS_PATH = "src/app/(app)/admin/events/actions.ts";

// ═══════════════════════════════════════════════════════════════════════════
// 6/7 — Create Event: custom price, Event Type default remains default
// ═══════════════════════════════════════════════════════════════════════════

describe("Create Event — Admin-only per-event price override", () => {
  const src = () => readSource(CREATE_SHEET_PATH);

  it("6. priceDollars is seeded from the selected Event Type's own default and marked customized the moment the Admin edits it — a genuinely different value is what gets submitted as an override", () => {
    const s = src();
    expect(s).toContain("function handlePriceDollarsChange(value: string) {");
    expect(s).toContain("setPriceCustomized(true);");
    expect(s).toContain("setPriceDollars(type.default_price_amount_cents !== null ? (type.default_price_amount_cents / 100).toFixed(2) : \"\");");
  });

  it("7. the atomic custom-price RPC is only ever called when priceCustomized is true — an untouched (still-default) price takes the plain createEvent branch, so the Event simply keeps its Event Type's own default snapshot from create_event itself. See eventCreatePriceAtomicity.regression.test.ts for the dedicated atomicity coverage.", () => {
    const s = src();
    const fnIdx = s.indexOf("async function handleCreate() {");
    const fnEnd = s.indexOf("\n  }\n\n  // ── Display helpers", fnIdx);
    const fn = s.slice(fnIdx, fnEnd === -1 ? fnIdx + 2500 : fnEnd);
    expect(fn).toContain("const useCustomPrice = isAdmin && priceCustomized;");
    expect(fn).toMatch(/\? await createEventWithPriceOverride\(/);
  });

  it("a clean reset path back to the Event Type's own default exists (\"Use {type} default\"), only shown once customized", () => {
    const s = src();
    expect(s).toContain("function resetPriceToTypeDefault() {");
    expect(s).toContain("{priceCustomized && (");
    expect(s).toMatch(/onClick=\{resetPriceToTypeDefault\}/);
  });

  it("the price field itself is Admin-only — Staff/Pro see the SAME read-only PriceSummary (Event Type default) they always did, never the editable override control", () => {
    const s = src();
    const idx = s.indexOf("{isAdmin ? (");
    const elseIdx = s.indexOf(") : (", idx);
    const nonAdminBlock = s.slice(elseIdx, s.indexOf("{/* Member joinable toggle */}", elseIdx));
    expect(nonAdminBlock).toContain('label="Event price"');
    expect(nonAdminBlock).toContain("amountCents={selectedType.default_price_amount_cents}");
  });

  it("the plain createEvent branch's own call is never widened with a price parameter — matching 0141's own locked price-blind decision for create_event; a customized price routes through the entirely separate createEventWithPriceOverride branch instead", () => {
    const s = src();
    const rpcCallIdx = s.indexOf(": await createEvent({");
    const rpcCallEnd = s.indexOf("});", rpcCallIdx);
    const rpcCallBlock = codeOnly(s.slice(rpcCallIdx, rpcCallEnd));
    expect(rpcCallBlock).not.toMatch(/price/i);
  });

  it("$0 / free Event semantics remain valid — an explicit \"0.00\" and a blank field are both distinct, already-supported PriceSummary states (Free vs No price set), never conflated", () => {
    // PriceSummary itself (unmodified, imported here) already renders 0 as
    // "Free" and null as "No price set" for an operator viewer — confirmed
    // directly against its own source, not re-implemented here.
    const priceSummarySrc = readSource("src/components/PriceSummary.tsx");
    expect(priceSummarySrc).toContain('amountCents === 0 ? "Free"');
    expect(priceSummarySrc).toContain('"No price set"');
  });
});

describe("createEvent Server Action — default-price path only, matching createReservation's own established convention", () => {
  it("discards create_event's own RETURNS row entirely (no caller needs the created id on this path anymore, now that custom pricing has its own atomic RPC) — matching createReservation/adminCreateMemberReservation's own identical {error?}-only convention", () => {
    const s = readSource(CALENDAR_ACTIONS_PATH);
    const fnIdx = s.indexOf("export async function createEvent(params: {");
    const fnEnd = s.indexOf("\n}\n", fnIdx);
    const fn = s.slice(fnIdx, fnEnd);
    expect(fn).toContain('const { error } = await supabase.rpc("create_event", rpcParams);');
    expect(fn).toContain("return {};");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8/9/10 — Edit Event: future-only price change, no repricing, no Checkout
// invalidation
// ═══════════════════════════════════════════════════════════════════════════

describe("Edit Event — price change affects future sign-ups only (pre-existing, unmodified invariants, re-confirmed after this pass's copy update)", () => {
  it("8. the price control's own copy makes clear this changes FUTURE sign-ups only", () => {
    const s = readSource(EDIT_SHEET_PATH);
    expect(s).toContain("Price for future sign-ups");
    expect(s).toMatch(/Existing participants and guests keep the price they joined at/);
  });

  it("9. set_event_price_override (the RPC EditEventSheet calls) never touches event_participants/event_guests/payments — confirmed directly against its own current body, not re-implemented", () => {
    const s = readSource("supabase/migrations/0141_event_pricing.sql");
    const fnStart = s.indexOf("create or replace function public.set_event_price_override(");
    const fnEnd = s.indexOf("revoke execute on function public.set_event_price_override(");
    const fn = s.slice(fnStart, fnEnd);
    expect(fn).toContain("update events\n  set price_amount_cents = p_price_amount_cents, updated_at = now()\n  where id = p_event_id");
    expect(fn).not.toMatch(/event_participants|event_guests|payments|payment_events/);
  });

  it("does not create a new obligation cycle or reprice any existing participant — _create_payment_obligation/_adjust_payment_obligation are never called from set_event_price_override", () => {
    const s = readSource("supabase/migrations/0141_event_pricing.sql");
    const fnStart = s.indexOf("create or replace function public.set_event_price_override(");
    const fnEnd = s.indexOf("revoke execute on function public.set_event_price_override(");
    const fn = s.slice(fnStart, fnEnd);
    expect(fn).not.toMatch(/_create_payment_obligation|_adjust_payment_obligation/);
  });

  it("10. a price-only Event edit does not invalidate an existing participant's Checkout — 0161's own update_event guard is scoped to starts_at/ends_at/court-set/event_type_id only, and set_event_price_override is a COMPLETELY SEPARATE RPC from update_event, never redefined or guarded by 0161 at all", () => {
    const s = readSource("supabase/migrations/0161_event_online_payment_checkout.sql");
    expect(s).not.toMatch(/create or replace function public\.set_event_price_override/);
    // update_event's own material-change predicate (unaffected by this
    // polish pass) still excludes price entirely.
    expect(s).toMatch(
      /v_payment_material_change :=\s*\n\s*v_time_changed\s*\n\s*or v_court_set_changed\s*\n\s*or \(p_event_type_id is distinct from v_before\.event_type_id\);/,
    );
  });

  it("setEventPriceOverrideAction is a single, unmodified primitive, used ONLY by Edit Event now — Create Event's custom-price path was corrected to the atomic create_event_with_price_override RPC (0162) instead, so setEventPriceOverrideAction is no longer called from CreateEventSheet at all", () => {
    const s = readSource(ADMIN_EVENTS_ACTIONS_PATH);
    const occurrences = s.split("export async function setEventPriceOverrideAction(").length - 1;
    expect(occurrences).toBe(1);

    const editSrc = readSource(EDIT_SHEET_PATH);
    const createSrc = readSource(CREATE_SHEET_PATH);
    expect(editSrc).toContain("setEventPriceOverrideAction(event.id, newPriceCents, clubId)");
    expect(createSrc).not.toMatch(/setEventPriceOverrideAction/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Role gating — isAdmin threaded correctly to every CreateEventSheet call
// site, no second/inconsistent pricing authority path
// ═══════════════════════════════════════════════════════════════════════════

describe("isAdmin is threaded to every CreateEventSheet call site — no call site silently loses price-authority gating", () => {
  it("CalendarShell, AdminEventsClient, and EventsCreateButton all pass isAdmin={userRole === \"admin\"} (or an equivalent already-resolved boolean) into CreateEventSheet — never omitted", () => {
    const calendarShellSrc = readSource("src/app/(app)/calendar/CalendarShell.tsx");
    const adminEventsSrc = readSource("src/app/(app)/admin/events/AdminEventsClient.tsx");
    const createButtonSrc = readSource("src/app/(app)/events/EventsCreateButton.tsx");

    const csIdx = calendarShellSrc.indexOf("<CreateEventSheet");
    const csBlock = calendarShellSrc.slice(csIdx, calendarShellSrc.indexOf("/>", csIdx));
    expect(csBlock).toContain('isAdmin={userRole === "admin"}');

    const aeIdx = adminEventsSrc.indexOf("<CreateEventSheet");
    const aeBlock = adminEventsSrc.slice(aeIdx, adminEventsSrc.indexOf("/>", aeIdx));
    expect(aeBlock).toContain('isAdmin={userRole === "admin"}');

    const cbIdx = createButtonSrc.indexOf("<CreateEventSheet");
    const cbBlock = createButtonSrc.slice(cbIdx, createButtonSrc.indexOf("/>", cbIdx));
    expect(cbBlock).toContain("isAdmin={isAdmin}");
  });

  it("EventsCreateButton's own isAdmin prop is threaded from EventsAdminShell, which is threaded from events/page.tsx's own resolved profile role — not re-derived client-side from anything else", () => {
    const shellSrc = readSource("src/app/(app)/events/EventsAdminShell.tsx");
    expect(shellSrc).toContain("isAdmin={isAdmin}");
    const pageSrc = readSource("src/app/(app)/events/page.tsx");
    expect(pageSrc).toContain('isAdmin={profile!.role === "admin"}');
  });
});
