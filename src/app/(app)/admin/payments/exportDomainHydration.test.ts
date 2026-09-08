import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db/types";
import { hydrateExportDomainContext, isHydrationFailure, type DomainHydrationInput } from "./exportDomainHydration";

// Phase 34G-C2 completeness pass — genuine unit tests (real function calls
// against a minimal mocked Supabase client, not source-inspection) for
// hydrateExportDomainContext's REQUIRED-vs-SUPPORTING distinction: a
// missing required domain/parent row must fail the whole batch; a missing
// SUPPORTING display lookup (Court name, Pro profile, roster Member name)
// must not.

type Row = Record<string, unknown>;

// Minimal Supabase query-builder mock: supports exactly the
// .from(table).select(...).in(col, ids).order(...).range(offset, end)
// chain hydrateExportDomainContext actually issues, resolving with
// {data, error} at the end — enough to exercise the real function without
// a live database.
function makeMockSupabase(tables: Record<string, Row[]>) {
  const client = {
    from(table: string) {
      const allRows = tables[table] ?? [];
      let filtered = allRows;
      const builder = {
        select() { return builder; },
        in(column: string, ids: string[]) {
          filtered = allRows.filter((r) => ids.includes(r[column] as string));
          return builder;
        },
        order() { return builder; },
        range(offset: number, end: number) {
          const limit = end - offset + 1;
          return Promise.resolve({ data: filtered.slice(offset, offset + limit), error: null });
        },
      };
      return builder;
    },
  };
  return client as unknown as SupabaseClient<Database>;
}

function input(overrides: Partial<DomainHydrationInput> & Pick<DomainHydrationInput, "paymentId" | "domainType" | "domainId">): DomainHydrationInput {
  return { rosterMemberId: null, ...overrides };
}

describe("hydrateExportDomainContext — required domain rows missing FAILS the batch", () => {
  it("reservation: missing reservation row itself fails the whole hydration", async () => {
    const supabase = makeMockSupabase({ reservations: [] });
    const result = await hydrateExportDomainContext(
      supabase,
      [input({ paymentId: "pay1", domainType: "reservation", domainId: "res1" })],
      "America/New_York",
    );
    expect(isHydrationFailure(result)).toBe(true);
  });

  it("lesson_request: missing lesson_request row itself fails the whole hydration", async () => {
    const supabase = makeMockSupabase({ lesson_requests: [] });
    const result = await hydrateExportDomainContext(
      supabase,
      [input({ paymentId: "pay1", domainType: "lesson_request", domainId: "lr1" })],
      "America/New_York",
    );
    expect(isHydrationFailure(result)).toBe(true);
  });

  it("E. event_participant with missing parent Event fails the whole hydration, even though the participant row itself exists", async () => {
    const supabase = makeMockSupabase({
      event_participants: [{ id: "ep1", event_id: "ev-missing", status: "confirmed" }],
      events: [], // parent event does not resolve
    });
    const result = await hydrateExportDomainContext(
      supabase,
      [input({ paymentId: "pay1", domainType: "event_participant", domainId: "ep1" })],
      "America/New_York",
    );
    expect(isHydrationFailure(result)).toBe(true);
  });

  it("F. event_guest with missing parent Event fails the whole hydration, even though the guest row itself exists", async () => {
    const supabase = makeMockSupabase({
      event_guests: [{ id: "eg1", event_id: "ev-missing", display_name: "Jane Guest" }],
      events: [],
    });
    const result = await hydrateExportDomainContext(
      supabase,
      [input({ paymentId: "pay1", domainType: "event_guest", domainId: "eg1" })],
      "America/New_York",
    );
    expect(isHydrationFailure(result)).toBe(true);
  });

  it("G. program_enrollment with missing parent Program fails the whole hydration, even though the enrollment row itself exists", async () => {
    const supabase = makeMockSupabase({
      program_enrollments: [{ id: "pe1", program_id: "prog-missing", status: "enrolled" }],
      programs: [],
    });
    const result = await hydrateExportDomainContext(
      supabase,
      [input({ paymentId: "pay1", domainType: "program_enrollment", domainId: "pe1" })],
      "America/New_York",
    );
    expect(isHydrationFailure(result)).toBe(true);
  });

  it("one missing required row in a multi-payment batch fails the ENTIRE batch, not just that one payment", async () => {
    const supabase = makeMockSupabase({
      reservations: [{ id: "res-ok", court_id: "c1", starts_at: "2026-09-02T18:00:00Z", ends_at: "2026-09-02T19:00:00Z", status: "confirmed" }],
    });
    const result = await hydrateExportDomainContext(
      supabase,
      [
        input({ paymentId: "pay-ok", domainType: "reservation", domainId: "res-ok" }),
        input({ paymentId: "pay-bad", domainType: "reservation", domainId: "res-missing" }),
      ],
      "America/New_York",
    );
    expect(isHydrationFailure(result)).toBe(true);
  });
});

describe("D. a known non-collectible (cancelled) domain is intentionally EXCLUDED via collectible:false — NOT a hydration failure", () => {
  it("a cancelled Reservation still hydrates successfully, with collectible: false", async () => {
    const supabase = makeMockSupabase({
      reservations: [{ id: "res1", court_id: "c1", starts_at: "2026-09-02T18:00:00Z", ends_at: "2026-09-02T19:00:00Z", status: "cancelled" }],
    });
    const result = await hydrateExportDomainContext(
      supabase,
      [input({ paymentId: "pay1", domainType: "reservation", domainId: "res1" })],
      "America/New_York",
    );
    expect(isHydrationFailure(result)).toBe(false);
    if (isHydrationFailure(result)) throw new Error("expected success");
    expect(result.get("pay1")?.collectible).toBe(false);
  });

  it("a cancelled parent Event still hydrates successfully for event_participant, with collectible: false — the parent DID resolve, it's just non-collectible", async () => {
    const supabase = makeMockSupabase({
      event_participants: [{ id: "ep1", event_id: "ev1", status: "confirmed" }],
      events: [{ id: "ev1", title: "Mixer", starts_at: "2026-09-02T18:00:00Z", ends_at: "2026-09-02T19:00:00Z", status: "cancelled" }],
    });
    const result = await hydrateExportDomainContext(
      supabase,
      [input({ paymentId: "pay1", domainType: "event_participant", domainId: "ep1" })],
      "America/New_York",
    );
    expect(isHydrationFailure(result)).toBe(false);
    if (isHydrationFailure(result)) throw new Error("expected success");
    expect(result.get("pay1")?.collectible).toBe(false);
    expect(result.get("pay1")?.title).toBe("Mixer");
  });

  it("a cancelled parent Program still hydrates successfully for program_enrollment, with collectible: false", async () => {
    const supabase = makeMockSupabase({
      program_enrollments: [{ id: "pe1", program_id: "prog1", status: "enrolled" }],
      programs: [{ id: "prog1", title: "Junior Clinic", starts_on: "2026-09-01", status: "cancelled" }],
    });
    const result = await hydrateExportDomainContext(
      supabase,
      [input({ paymentId: "pay1", domainType: "program_enrollment", domainId: "pe1" })],
      "America/New_York",
    );
    expect(isHydrationFailure(result)).toBe(false);
    if (isHydrationFailure(result)) throw new Error("expected success");
    expect(result.get("pay1")?.collectible).toBe(false);
  });

  it("a completed Program remains collectible: true (completion is never blocking)", async () => {
    const supabase = makeMockSupabase({
      program_enrollments: [{ id: "pe1", program_id: "prog1", status: "enrolled" }],
      programs: [{ id: "prog1", title: "Junior Clinic", starts_on: "2026-09-01", status: "completed" }],
    });
    const result = await hydrateExportDomainContext(
      supabase,
      [input({ paymentId: "pay1", domainType: "program_enrollment", domainId: "pe1" })],
      "America/New_York",
    );
    expect(isHydrationFailure(result)).toBe(false);
    if (isHydrationFailure(result)) throw new Error("expected success");
    expect(result.get("pay1")?.collectible).toBe(true);
  });
});

describe("SUPPORTING display lookups (Court name, Pro profile, roster Member name) keep their neutral fallback — never fail the export", () => {
  it("a reservation whose court cannot be resolved still hydrates successfully, with the existing 'Court Reservation' fallback title", async () => {
    const supabase = makeMockSupabase({
      reservations: [{ id: "res1", court_id: "court-missing", starts_at: "2026-09-02T18:00:00Z", ends_at: "2026-09-02T19:00:00Z", status: "confirmed" }],
      courts: [], // court lookup fails — supporting only
    });
    const result = await hydrateExportDomainContext(
      supabase,
      [input({ paymentId: "pay1", domainType: "reservation", domainId: "res1" })],
      "America/New_York",
    );
    expect(isHydrationFailure(result)).toBe(false);
    if (isHydrationFailure(result)) throw new Error("expected success");
    expect(result.get("pay1")?.title).toBe("Court Reservation");
  });

  it("a lesson whose Pro profile cannot be resolved still hydrates successfully, with the existing 'Pro' fallback", async () => {
    const supabase = makeMockSupabase({
      lesson_requests: [{ id: "lr1", pro_id: "pro-missing", proposed_starts_at: "2026-09-02T18:00:00Z", proposed_ends_at: "2026-09-02T19:00:00Z", status: "confirmed" }],
      profiles: [],
    });
    const result = await hydrateExportDomainContext(
      supabase,
      [input({ paymentId: "pay1", domainType: "lesson_request", domainId: "lr1" })],
      "America/New_York",
    );
    expect(isHydrationFailure(result)).toBe(false);
    if (isHydrationFailure(result)) throw new Error("expected success");
    expect(result.get("pay1")?.title).toBe("Lesson with Pro");
  });

  it("a payment whose roster Member name cannot be resolved still hydrates successfully, with the existing 'Unknown' fallback", async () => {
    const supabase = makeMockSupabase({
      reservations: [{ id: "res1", court_id: "c1", starts_at: "2026-09-02T18:00:00Z", ends_at: "2026-09-02T19:00:00Z", status: "confirmed" }],
      courts: [{ id: "c1", name: "Court 1" }],
      roster_members: [], // roster lookup fails — supporting only
    });
    const result = await hydrateExportDomainContext(
      supabase,
      [input({ paymentId: "pay1", domainType: "reservation", domainId: "res1", rosterMemberId: "rm-missing" })],
      "America/New_York",
    );
    expect(isHydrationFailure(result)).toBe(false);
    if (isHydrationFailure(result)) throw new Error("expected success");
    expect(result.get("pay1")?.identityName).toBe("Unknown");
  });
});

// Final runtime-QA correction — a cancelled/withdrawn CHILD registration/
// enrollment must not be collectible merely because its parent Event/
// Program remains active. This is the exact bug the runtime CSV surfaced:
// Lifecycle Status = "Registration Cancelled"/"Enrollment Cancelled" while
// Payment Status stayed Unpaid in the Outstanding Balances export.
describe("14/15. child-level cancellation on an ACTIVE parent — collectible: false, so this row cannot reach the Outstanding Balances CSV (which only ever includes collectible: true rows)", () => {
  it("14. Registration Cancelled: active Event + cancelled participant => collectible: false", async () => {
    const supabase = makeMockSupabase({
      event_participants: [{ id: "ep1", event_id: "ev1", status: "cancelled" }],
      events: [{ id: "ev1", title: "Mixer", starts_at: "2026-09-02T18:00:00Z", ends_at: "2026-09-02T19:00:00Z", status: "scheduled" }],
    });
    const result = await hydrateExportDomainContext(
      supabase,
      [input({ paymentId: "pay1", domainType: "event_participant", domainId: "ep1" })],
      "America/New_York",
    );
    expect(isHydrationFailure(result)).toBe(false);
    if (isHydrationFailure(result)) throw new Error("expected success");
    const context = result.get("pay1");
    expect(context?.collectible).toBe(false);
    // The lifecycle label still correctly reflects the child cancellation
    // (visible under /admin/payments -> All) — collectibility and the
    // label are computed from the same two statuses, never inconsistent.
    expect(context?.lifecycleLabel).toBe("Registration Cancelled");
  });

  it("15. Enrollment Cancelled: active Program + cancelled enrollment => collectible: false", async () => {
    const supabase = makeMockSupabase({
      program_enrollments: [{ id: "pe1", program_id: "prog1", status: "cancelled" }],
      programs: [{ id: "prog1", title: "Junior Clinic", starts_on: "2026-09-01", status: "active" }],
    });
    const result = await hydrateExportDomainContext(
      supabase,
      [input({ paymentId: "pay1", domainType: "program_enrollment", domainId: "pe1" })],
      "America/New_York",
    );
    expect(isHydrationFailure(result)).toBe(false);
    if (isHydrationFailure(result)) throw new Error("expected success");
    const context = result.get("pay1");
    expect(context?.collectible).toBe(false);
    expect(context?.lifecycleLabel).toBe("Enrollment Cancelled");
  });

  it("13. hydrateExportDomainContext (Outstanding's own domain hydration) passes BOTH parent and child status into the collectibility predicates — not just the parent, which was the exact bug", async () => {
    // Active parent + active child => collectible (control case).
    const activeSupabase = makeMockSupabase({
      event_participants: [{ id: "ep1", event_id: "ev1", status: "confirmed" }],
      events: [{ id: "ev1", title: "Mixer", starts_at: "2026-09-02T18:00:00Z", ends_at: "2026-09-02T19:00:00Z", status: "scheduled" }],
    });
    const activeResult = await hydrateExportDomainContext(
      activeSupabase,
      [input({ paymentId: "pay1", domainType: "event_participant", domainId: "ep1" })],
      "America/New_York",
    );
    if (isHydrationFailure(activeResult)) throw new Error("expected success");
    expect(activeResult.get("pay1")?.collectible).toBe(true);

    // Same active parent, but a cancelled child => NOT collectible — proves
    // the child status is actually threaded through, not ignored.
    const cancelledChildSupabase = makeMockSupabase({
      event_participants: [{ id: "ep2", event_id: "ev1", status: "cancelled" }],
      events: [{ id: "ev1", title: "Mixer", starts_at: "2026-09-02T18:00:00Z", ends_at: "2026-09-02T19:00:00Z", status: "scheduled" }],
    });
    const cancelledChildResult = await hydrateExportDomainContext(
      cancelledChildSupabase,
      [input({ paymentId: "pay2", domainType: "event_participant", domainId: "ep2" })],
      "America/New_York",
    );
    if (isHydrationFailure(cancelledChildResult)) throw new Error("expected success");
    expect(cancelledChildResult.get("pay2")?.collectible).toBe(false);
  });
});
