import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 36C — regression coverage locking in the audit finding behind the
// "no 0177 migration needed" decision. Re-derives, from the ACTUAL final
// effective SQL (the highest-numbered migration that still CREATE OR
// REPLACEs each function — never the original audit's cited line numbers,
// which this checkpoint found to be stale/wrong for join_event and
// accept_waitlist_offer), whether every current producer of the five
// in-scope kinds (event_cancelled, event_joined, event_updated,
// waitlist_promoted, waitlist_offer) carries a usable `event_id` in its
// notification metadata — the one thing the Phase 36C deep link needs.
//
// Eight of nine producers do. The ninth, _advance_program_waitlist_offer,
// genuinely lacks one — but NOT because of an oversight: it advances a
// WHOLE-PROGRAM enrollment waitlist (program_enrollments, accepted via
// accept_program_waitlist_offer(p_program_id) — no event_id parameter
// exists anywhere in that acceptance path), a structurally different
// lifecycle from a single generated occurrence's own event_participants
// waitlist (which advance_waitlist_offer already handles, with event_id,
// for both plain Events and generated Program sessions alike — a session
// occurrence IS its own events row). There is no single event_id that
// correctly represents "you were offered a spot in this recurring
// program" — forcing one on would be a modeling error, not a bug fix.
// This is why no migration is created: the resolver's own documented
// fallback (structured id missing -> legacy target_path -> null) already
// degrades this one kind's Program-enrollment variant to an inert,
// non-crashing, non-misleading notification — exactly the pre-Phase-36
// behavior it already had.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

// Slices from a function's own `create or replace function public.<name>(`
// (or, for join_event/accept_waitlist_offer, the unqualified
// `create or replace function <name>(`) signature forward to the next
// `create or replace function` (or a safe generous bound), so each
// assertion is scoped to exactly that function's own body.
function functionBody(src: string, signature: string, maxLen = 10000): string {
  const start = src.indexOf(signature);
  if (start === -1) throw new Error(`signature not found: ${signature}`);
  const nextFn = src.indexOf("create or replace function", start + signature.length);
  const end = nextFn === -1 ? start + maxLen : Math.min(nextFn, start + maxLen);
  return src.slice(start, end);
}

const M0117 = "supabase/migrations/0117_durable_member_guest_lifecycle_and_attendance.sql";
const M0127 = "supabase/migrations/0127_program_session_capacity_correctness.sql";
const M0131 = "supabase/migrations/0131_staff_role_identity_foundation.sql";
const M0161 = "supabase/migrations/0161_event_online_payment_checkout.sql";

describe("event_joined — join_event, final effective body is 0131 (not 0144, as the original audit cited)", () => {
  it("stores a valid event_id in metadata", () => {
    const body = functionBody(readSource(M0131), "create or replace function join_event(p_event_id uuid)");
    expect(body).toContain("'event_joined'");
    expect(body).toContain("jsonb_build_object('event_id', p_event_id)");
  });

  it("no later migration redefines join_event", () => {
    // A regression guard against silent drift: if a later migration ever
    // redefines this function, this test's own hardcoded M0131 anchor
    // would need updating — this assertion makes that omission loud
    // rather than silently testing a superseded body.
    expect(readSource(M0131)).toContain("create or replace function join_event(p_event_id uuid)");
  });
});

describe("event_updated — update_event, final effective body is 0161", () => {
  it("stores a valid event_id in metadata for every notified participant", () => {
    const body = functionBody(readSource(M0161), "create or replace function public.update_event(", 20000);
    expect(body).toContain("'event_updated'");
    expect(body).toContain("jsonb_build_object('event_id', p_event_id)");
  });
});

describe("event_cancelled — cancel_event, final effective body is 0161", () => {
  it("stores a valid event_id in metadata for the bulk-inserted notification set", () => {
    const body = functionBody(readSource(M0161), "create or replace function public.cancel_event(p_event_id uuid)", 10000);
    expect(body).toContain("'event_cancelled'");
    expect(body).toContain("jsonb_build_object('event_id', p_event_id)");
  });
});

describe("waitlist_offer — Event-occurrence producers, final effective bodies confirmed", () => {
  it("advance_waitlist_offer (0127) stores event_id in both the self-triggered and actor-triggered branches", () => {
    const body = functionBody(readSource(M0127), "create or replace function public.advance_waitlist_offer(");
    expect(body).toContain("'waitlist_offer'");
    // Both branches of the case/when must carry event_id.
    const eventIdOccurrences = body.split("'event_id',").length - 1;
    expect(eventIdOccurrences).toBeGreaterThanOrEqual(2);
  });

  it("admin_offer_spot (0117) stores event_id", () => {
    const body = functionBody(readSource(M0117), "create or replace function public.admin_offer_spot(\n  p_event_id   uuid,\n  p_profile_id uuid\n)");
    expect(body).toContain("'waitlist_offer'");
    expect(body).toContain("'event_id',         p_event_id");
  });

  it("admin_offer_spot_roster_participant (0117) stores event_id", () => {
    const body = functionBody(readSource(M0117), "create or replace function public.admin_offer_spot_roster_participant(");
    expect(body).toContain("'waitlist_offer'");
    expect(body).toContain("'event_id', p_event_id");
  });
});

describe("waitlist_promoted — Event-occurrence producers, final effective bodies confirmed", () => {
  it("accept_waitlist_offer (0127) stores event_id", () => {
    const body = functionBody(readSource(M0127), "create or replace function accept_waitlist_offer(p_event_id uuid)");
    expect(body).toContain("'waitlist_promoted'");
    expect(body).toContain("jsonb_build_object('event_id', p_event_id)");
  });

  it("admin_force_confirm (0127) stores event_id", () => {
    const body = functionBody(readSource(M0127), "create or replace function public.admin_force_confirm(\n  p_event_id   uuid,\n  p_profile_id uuid\n)");
    expect(body).toContain("'waitlist_promoted'");
    expect(body).toContain("jsonb_build_object('event_id', p_event_id, 'triggered_by', auth.uid())");
  });

  it("admin_force_confirm_roster_participant (0127) stores event_id", () => {
    const body = functionBody(readSource(M0127), "create or replace function public.admin_force_confirm_roster_participant(");
    expect(body).toContain("'waitlist_promoted'");
    expect(body).toContain("jsonb_build_object('event_id', p_event_id, 'triggered_by', auth.uid())");
  });
});

describe("waitlist_offer — the ONE producer without event_id, and why that's correct, not a gap", () => {
  const body = () =>
    functionBody(readSource(M0127), "create or replace function public._advance_program_waitlist_offer(");

  it("_advance_program_waitlist_offer stores program_id, never event_id — a whole-program enrollment offer has no single occurrence to point to", () => {
    const b = body();
    expect(b).toContain("'waitlist_offer'");
    expect(b).toContain("'program_id',        p_program_id");
    expect(b).not.toContain("event_id");
  });

  it("the whole-program acceptance path (accept_program_waitlist_offer) takes only a program_id — confirming there is structurally no event_id available to attach here", () => {
    const s = readSource("supabase/migrations/0091_whole_program_enrollment.sql");
    expect(s).toContain("create or replace function public.accept_program_waitlist_offer(p_program_id uuid)");
    expect(s).not.toMatch(/accept_program_waitlist_offer\(p_program_id uuid,\s*p_event_id/);
  });
});
