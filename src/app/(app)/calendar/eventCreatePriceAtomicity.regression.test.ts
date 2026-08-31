import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Runtime QA (34F-B pre-commit correction) — regression coverage proving
// the Admin custom-price Create Event path is now atomic: the Event and
// its custom price commit together, inside ONE new RPC (0162,
// create_event_with_price_override), or neither commits at all. This
// replaces the prior polish pass's two-committed-call sequence
// (create_event, then a separate setEventPriceOverrideAction round-trip),
// which left a window where a concurrent join could snapshot the Event
// Type default price instead of the Admin's intended custom one.
//
// This project's vitest baseline is pure-TypeScript with no jsdom/DB
// access — source-inspection against the real, shipped migration/action/
// component text is the established, strongest practical coverage (see
// every other *.regression.test.ts in this codebase for the same
// precedent).

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !line.trim().startsWith("--") && !line.trim().startsWith("//"))
    .join("\n");
}

const MIGRATION_PATH = "supabase/migrations/0162_atomic_event_create_price_override.sql";
const CALENDAR_ACTIONS_PATH = "src/app/(app)/calendar/actions.ts";
const CREATE_SHEET_PATH = "src/app/(app)/calendar/CreateEventSheet.tsx";
const EDIT_SHEET_PATH = "src/app/(app)/calendar/EditEventSheet.tsx";

// ═══════════════════════════════════════════════════════════════════════════
// 0162 architecture — composition, not duplication or a widened signature
// ═══════════════════════════════════════════════════════════════════════════

describe("0162 — create_event_with_price_override composes the EXISTING create_event and set_event_price_override, never redefines or duplicates either", () => {
  const getFn = () => {
    const m = readSource(MIGRATION_PATH);
    const fnStart = m.indexOf("create or replace function public.create_event_with_price_override(");
    const fnEnd = m.indexOf("\n$$;", fnStart) + "\n$$;".length;
    return m.slice(fnStart, fnEnd);
  };

  it("neither create_event nor set_event_price_override is redefined anywhere in this migration — 0141's authoritative bodies remain the only definitions", () => {
    const m = readSource(MIGRATION_PATH);
    expect(m).not.toMatch(/create or replace function public\.create_event\(/);
    expect(m).not.toMatch(/create or replace function public\.set_event_price_override\(/);
  });

  it("calls create_event by reference (public.create_event(...)) and assigns its full row result — no re-implementation of its own insert/validation logic", () => {
    const fn = getFn();
    expect(fn).toContain("v_event := public.create_event(");
    expect(fn).not.toMatch(/insert into events/);
  });

  it("calls set_event_price_override by reference (public.set_event_price_override(...)) and returns its own result — no re-implementation of its own update/audit_log logic", () => {
    const fn = getFn();
    expect(fn).toContain("v_result := public.set_event_price_override(v_event.id, p_price_amount_cents);");
    expect(fn).toContain("return v_result;");
    expect(codeOnly(fn)).not.toMatch(/update events\s*\n\s*set price_amount_cents/);
    expect(codeOnly(fn)).not.toMatch(/insert into audit_log/);
  });

  it("create_event's own call site passes every one of its parameters through unchanged, in its own declared order — the wrapper never widens create_event's own signature", () => {
    const fn = getFn();
    expect(fn).toContain(
      "public.create_event(\n    p_event_type_id, p_title, p_starts_at, p_ends_at, p_court_ids,\n    p_description, p_capacity, p_notes, p_member_joinable\n  );",
    );
  });
});

describe("1. atomicity — ONE PL/pgSQL function call is ONE Postgres transaction; either both commit or neither does", () => {
  it("create_event_with_price_override is a plain LANGUAGE plpgsql FUNCTION, never a PROCEDURE with explicit COMMIT/ROLLBACK — no partial-commit mechanism exists inside it", () => {
    const m = readSource(MIGRATION_PATH);
    const fnStart = m.indexOf("create or replace function public.create_event_with_price_override(");
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = m.indexOf("\n$$;", fnStart);
    const fn = m.slice(fnStart, fnEnd);
    expect(fn).toContain("language plpgsql");
    expect(fn).not.toMatch(/\bcommit\b|\brollback\b/i);
  });

  it("both delegated calls (create_event, set_event_price_override) occur inside the SAME begin/end function body, with no intervening transaction boundary", () => {
    const m = readSource(MIGRATION_PATH);
    const fnStart = m.indexOf("create or replace function public.create_event_with_price_override(");
    const beginIdx = m.indexOf("\nbegin\n", fnStart);
    const createEventCallIdx = m.indexOf("v_event := public.create_event(", fnStart);
    const overrideCallIdx = m.indexOf("v_result := public.set_event_price_override(", fnStart);
    const endIdx = m.indexOf("\nend;\n$$;", fnStart);
    expect(beginIdx).toBeGreaterThan(fnStart);
    expect(createEventCallIdx).toBeGreaterThan(beginIdx);
    expect(overrideCallIdx).toBeGreaterThan(createEventCallIdx);
    expect(endIdx).toBeGreaterThan(overrideCallIdx);
  });

  it("if set_event_price_override raises (e.g. invalid_price, insufficient_role), the entire function aborts — create_event's own preceding INSERT into events (and its child reservations rows) is rolled back with it, since no COMMIT ever separated them", () => {
    // set_event_price_override itself (0141, unmodified) still raises for
    // a negative price — confirmed directly, not re-implemented here.
    const setOverrideSrc = readSource("supabase/migrations/0141_event_pricing.sql");
    const fnStart = setOverrideSrc.indexOf("create or replace function public.set_event_price_override(");
    const fnEnd = setOverrideSrc.indexOf("revoke execute on function public.set_event_price_override(");
    const fn = setOverrideSrc.slice(fnStart, fnEnd);
    expect(fn).toContain("raise exception 'invalid_price';");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2/6 — default-price path still uses plain create_event; Edit Event
// unaffected
// ═══════════════════════════════════════════════════════════════════════════

describe("2. ordinary/default-price Event creation still uses the existing, unmodified create_event — never routed through the new wrapper", () => {
  it("CreateEventSheet only calls createEventWithPriceOverride when isAdmin AND priceCustomized are both true — every other case (Staff/Pro, or an Admin who never touched the price field) calls plain createEvent", () => {
    const s = readSource(CREATE_SHEET_PATH);
    expect(s).toContain("const useCustomPrice = isAdmin && priceCustomized;");
    expect(s).toMatch(/const result = useCustomPrice\s*\n\s*\? await createEventWithPriceOverride\(/);
    expect(s).toMatch(/: await createEvent\(/);
  });

  it("createEvent (the Server Action) itself still calls plain create_event, unchanged — no price parameter was added to its RPC call", () => {
    const s = readSource(CALENDAR_ACTIONS_PATH);
    const fnIdx = s.indexOf("export async function createEvent(params: {");
    const fnEnd = s.indexOf("\n}\n\n// ---", fnIdx);
    const fn = s.slice(fnIdx, fnEnd);
    expect(fn).toContain('await supabase.rpc("create_event", rpcParams);');
    // codeOnly strips this function's own explanatory comments (which
    // legitimately mention "price" in prose) — only actual code is
    // checked for the absence of a price parameter.
    expect(codeOnly(fn)).not.toMatch(/price/i);
  });
});

describe("6. Edit Event continues using setEventPriceOverrideAction, completely independently of the new create-time atomic path — semantics unchanged", () => {
  it("EditEventSheet still calls setEventPriceOverrideAction directly, never createEventWithPriceOverride or create_event_with_price_override", () => {
    const s = readSource(EDIT_SHEET_PATH);
    expect(s).toContain("setEventPriceOverrideAction(event.id, newPriceCents, clubId)");
    expect(s).not.toMatch(/createEventWithPriceOverride|create_event_with_price_override/);
  });

  it("setEventPriceOverrideAction's own implementation (admin/events/actions.ts) is untouched by this migration — still calls set_event_price_override directly, not the new wrapper", () => {
    const s = readSource("src/app/(app)/admin/events/actions.ts");
    const fnIdx = s.indexOf("export async function setEventPriceOverrideAction(");
    const fnEnd = s.indexOf("\n}\n", fnIdx);
    const fn = s.slice(fnIdx, fnEnd);
    expect(fn).toContain('await supabase.rpc("set_event_price_override"');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3/4 — custom $0 vs default vs nullable no-price, all distinct
// ═══════════════════════════════════════════════════════════════════════════

describe("3/4. price semantics — Event Type default, custom $0 (Free), and custom/no-price null are three distinct, never-conflated states", () => {
  it("p_price_amount_cents is nullable in both the RPC signature and the TS Args type — null is a valid, intentional override value, not an error state", () => {
    const m = readSource(MIGRATION_PATH);
    const fnStart = m.indexOf("create or replace function public.create_event_with_price_override(");
    const fnEnd = m.indexOf("\n$$;", fnStart);
    const fn = m.slice(fnStart, fnEnd);
    // No `not null`/default-non-null constraint on the parameter itself,
    // and the validation only rejects NEGATIVE values, never null.
    expect(fn).toContain("p_price_amount_cents  integer,");
    expect(fn).toContain("if p_price_amount_cents is not null and p_price_amount_cents < 0 then");

    const typesSrc = readSource("src/lib/db/types.ts");
    const idx = typesSrc.indexOf("create_event_with_price_override: {");
    const block = typesSrc.slice(idx, idx + 1200);
    expect(block).toContain("p_price_amount_cents: number | null;");
  });

  it("CreateEventSheet computes the override value identically to EditEventSheet's own established blank-means-null convention — trimmed empty string becomes null, never 0", () => {
    const s = readSource(CREATE_SHEET_PATH);
    expect(s).toContain('p_price_amount_cents: priceDollarsTrimmed === "" ? null : Math.round(priceDollarsNum * 100),');
  });

  it("\"Use [Event Type] default\" is a DIFFERENT code path entirely (resetPriceToTypeDefault + priceCustomized=false), which routes through plain createEvent, never through an explicit override equal to the default value", () => {
    const s = readSource(CREATE_SHEET_PATH);
    expect(s).toContain("function resetPriceToTypeDefault() {");
    expect(s).toContain("setPriceCustomized(false);");
    // resetPriceToTypeDefault only ever touches local component state — it
    // never calls either create action itself.
    const fnIdx = s.indexOf("function resetPriceToTypeDefault() {");
    const fnEnd = s.indexOf("\n  }", fnIdx);
    const fn = s.slice(fnIdx, fnEnd);
    expect(fn).not.toMatch(/createEvent|await/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5 — Staff/Pro cannot use the custom-price path
// ═══════════════════════════════════════════════════════════════════════════

describe("5. Staff/Pro cannot reach the custom-price path — neither client-side nor server-side", () => {
  it("client: useCustomPrice requires isAdmin — a Staff/Pro caller (isAdmin=false) always takes the plain createEvent branch regardless of any local price state", () => {
    const s = readSource(CREATE_SHEET_PATH);
    expect(s).toContain("const useCustomPrice = isAdmin && priceCustomized;");
  });

  it("client: the editable price input itself is Admin-only — Staff/Pro never even see a way to customize the price (read-only PriceSummary instead)", () => {
    const s = readSource(CREATE_SHEET_PATH);
    const idx = s.indexOf("{isAdmin ? (");
    expect(idx).toBeGreaterThan(-1);
  });

  it("server (defense in depth): create_event_with_price_override independently re-verifies role = 'admin' BEFORE calling create_event — a Staff/Pro caller who somehow invoked this RPC directly fails closed with insufficient_role, and the Event is never created at all (not even at the default price)", () => {
    const m = readSource(MIGRATION_PATH);
    const fnStart = m.indexOf("create or replace function public.create_event_with_price_override(");
    const roleCheckIdx = m.indexOf("if v_profile.role <> 'admin' then raise exception 'insufficient_role'; end if;", fnStart);
    const createEventCallIdx = m.indexOf("v_event := public.create_event(", fnStart);
    expect(roleCheckIdx).toBeGreaterThan(fnStart);
    expect(createEventCallIdx).toBeGreaterThan(roleCheckIdx);
  });

  it("granted to authenticated only — never anon/public — matching set_event_price_override's own exact grant pattern (the sibling function it wraps for pricing authority)", () => {
    const m = readSource(MIGRATION_PATH);
    expect(m).toContain(
      "revoke execute on function public.create_event_with_price_override(uuid, text, timestamptz, timestamptz, uuid[], integer, text, integer, text, boolean) from public, anon;",
    );
    expect(m).toContain(
      "grant  execute on function public.create_event_with_price_override(uuid, text, timestamptz, timestamptz, uuid[], integer, text, integer, text, boolean) to authenticated;",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7/8 — no existing-participant repricing, no Checkout invalidation change
// ═══════════════════════════════════════════════════════════════════════════

describe("7. no existing-participant repricing behavior changed — this migration only affects the CREATE-time path, never an already-joined participant's own snapshot", () => {
  it("create_event_with_price_override never touches event_participants/event_guests/payments at all — it only calls create_event (which inserts the NEW Event's own reservations, not participants) and set_event_price_override (which only ever updates events.price_amount_cents)", () => {
    const fn = (() => {
      const m = readSource(MIGRATION_PATH);
      const fnStart = m.indexOf("create or replace function public.create_event_with_price_override(");
      const fnEnd = m.indexOf("\n$$;", fnStart);
      return codeOnly(m.slice(fnStart, fnEnd));
    })();
    expect(fn).not.toMatch(/event_participants|event_guests|payments|payment_events/);
  });

  it("_create_payment_obligation/_adjust_payment_obligation are never called from this migration — obligation creation remains exclusively join_event/accept_waitlist_offer's own job (0144, untouched)", () => {
    const m = codeOnly(readSource(MIGRATION_PATH));
    expect(m).not.toMatch(/_create_payment_obligation|_adjust_payment_obligation/);
  });
});

describe("8. no Checkout invalidation behavior changed — 0162 never touches 0161's guards or the Checkout attempt machinery", () => {
  it("0162 never redefines any of 0161's guarded functions (_leave_event_impl, admin_remove_participant, admin_remove_roster_participant, update_event, cancel_event) or the Checkout wrappers", () => {
    const m = readSource(MIGRATION_PATH);
    for (const name of [
      "_leave_event_impl", "admin_remove_participant", "admin_remove_roster_participant",
      "update_event", "cancel_event", "open_event_payment_checkout_attempt",
      "supersede_event_checkout_attempt_and_open_fresh", "list_event_blocking_checkout_attempts",
    ]) {
      expect(m).not.toMatch(new RegExp(`create or replace function public\\.${name}\\(`));
    }
  });

  it("0162 never calls _invalidate_or_flag_open_checkout_attempt — a brand-new Event has no existing Checkout attempt to invalidate in the first place", () => {
    const m = readSource(MIGRATION_PATH);
    expect(m).not.toMatch(/_invalidate_or_flag_open_checkout_attempt/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Rollback — brand-new function only, DROP FUNCTION, no historical rewrite
// ═══════════════════════════════════════════════════════════════════════════

describe("rollback — DROP FUNCTION only, no historical migration text rewritten", () => {
  it("the rollback documentation is a DROP FUNCTION for the new function only, with the exact matching signature", () => {
    const m = readSource(MIGRATION_PATH);
    const rollbackIdx = m.indexOf("-- Rollback procedure");
    const rollbackBlock = m.slice(rollbackIdx);
    expect(rollbackBlock).toContain(
      "-- drop function if exists public.create_event_with_price_override(uuid, text, timestamptz, timestamptz, uuid[], integer, text, integer, text, boolean);",
    );
    expect(rollbackBlock).not.toMatch(/-- create or replace function/);
  });
});
