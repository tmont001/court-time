import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 36C correction — regression coverage for the whole-Program
// enrollment deep link (?program=<uuid> on /events), the destination for
// a waitlist_offer notification whose producer is
// _advance_program_waitlist_offer (program_id only — see
// notification-targets.ts's own comment on why that kind is polymorphic).
//
// ProgramEnrollmentCard remains the sole canonical whole-Program Member
// surface — this checkpoint adds no new detail page, no new sheet, no
// duplicated Accept/Decline logic. The deep link only finds an
// already-rendered card by id and scrolls it into view; visibility is
// entirely determined by the existing, unconditional `programs`
// (getMemberPrograms) fetch — the query param is never itself a data
// source or an authorization signal.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const PAGE_PATH     = "src/app/(app)/events/page.tsx";
const UPCOMING_PATH = "src/app/(app)/events/EventsUpcomingClient.tsx";
const CARD_PATH      = "src/app/(app)/events/ProgramEnrollmentCard.tsx";

describe("page.tsx — ?program=<uuid> is accepted independent of checkout=success", () => {
  it("computes initialProgramId from a plain programParam, with no checkout gate", () => {
    const s = readSource(PAGE_PATH);
    const idx = s.indexOf("const initialProgramId =");
    expect(idx).toBeGreaterThan(-1);
    const line = s.slice(idx, s.indexOf(";", idx) + 1);
    expect(line).not.toContain("checkoutParam");
    expect(line).toContain("uuidRe.test(programParam)");
  });

  it("passes the resolved id to EventsUpcomingClient as initialProgramId — the old checkout-gated prop name is gone", () => {
    const s = readSource(PAGE_PATH);
    expect(s).toContain("initialProgramId={initialProgramId}");
    expect(s).not.toContain("initialCheckoutProgramId");
  });
});

describe("/events?program=<valid visible id> targets the matching ProgramEnrollmentCard", () => {
  it("each rendered card is wrapped in a stable, program-id-keyed DOM id — the exact string the deep-link effect looks up", () => {
    const s = readSource(UPCOMING_PATH);
    expect(s).toContain("id={`program-card-${p.id}`}");
  });

  it("the deep-link effect looks up that same id pattern and scrolls it into view with a restrained, non-flashy call", () => {
    const s = readSource(UPCOMING_PATH);
    const idx = s.indexOf("if (!initialProgramId) return;");
    expect(idx).toBeGreaterThan(-1);
    const endIdx = s.indexOf("}, []);", idx);
    const block = s.slice(idx, endIdx);
    expect(block).toContain("document.getElementById(`program-card-${initialProgramId}`)");
    expect(block).toContain('.scrollIntoView({ behavior: "smooth", block: "center" });');
    // Restrained: no highlight class toggling, no animation library, no
    // redesign of the card itself.
    expect(block).not.toMatch(/classList|animate|highlight/i);
  });

  it("runs once on mount only (empty dependency array) — a later refresh (with the param already stripped) does not re-scroll", () => {
    const s = readSource(UPCOMING_PATH);
    const idx = s.indexOf("if (!initialProgramId) return;");
    const endIdx = s.indexOf("}, []);", idx);
    expect(endIdx).toBeGreaterThan(idx);
    const block = s.slice(idx, endIdx + "}, []);".length);
    expect(block).toMatch(/\},\s*\[\]\);/);
  });

  it("strips program/checkout via window.history.replaceState, preserving any other param, never reintroducing router.replace", () => {
    const s = readSource(UPCOMING_PATH);
    const idx = s.indexOf("if (!initialProgramId) return;");
    const endIdx = s.indexOf("}, []);", idx);
    const block = s.slice(idx, endIdx);
    expect(block).toContain('params.delete("program");');
    expect(block).toContain('params.delete("checkout");');
    expect(block).toContain('window.history.replaceState(null, "", query ? `/events?${query}` : "/events");');
    expect(block).not.toContain("router.replace(");
  });
});

describe("unknown/invisible/nonexistent Program id — no leak, no extra fetch, page stays normal", () => {
  it("the deep-link effect never issues its own data fetch — it only reads DOM elements already rendered from the unconditional `programs` prop", () => {
    const s = readSource(UPCOMING_PATH);
    const idx = s.indexOf("if (!initialProgramId) return;");
    const endIdx = s.indexOf("}, []);", idx);
    const block = s.slice(idx, endIdx);
    expect(block).not.toMatch(/supabase|fetch\(|getMemberPrograms/);
  });

  it("the getElementById lookup uses optional chaining — a non-matching id (not visible/not this club/nonexistent) is a silent no-op, never a throw", () => {
    const s = readSource(UPCOMING_PATH);
    const idx = s.indexOf("document.getElementById(`program-card-${initialProgramId}`)");
    expect(idx).toBeGreaterThan(-1);
    const line = s.slice(idx, s.indexOf(";", idx) + 1);
    expect(line).toContain("?.scrollIntoView(");
  });

  it("Program visibility is decided entirely by the existing getMemberPrograms fetch (unconditional, independent of the query param) — the deep-link param is never itself a visibility or authorization input", () => {
    const s = readSource(PAGE_PATH);
    expect(s).toMatch(/clubId\s*&&\s*isMember\s*\?\s*getMemberPrograms\(clubId,\s*user\.id\)/);
    // getMemberPrograms is never called with, or gated by, programParam/initialProgramId.
    expect(s).not.toMatch(/getMemberPrograms\([^)]*program(Param|Id)/);
  });
});

describe("ProgramEnrollmentCard's existing offered Accept/Decline logic is reused unchanged", () => {
  it("ProgramEnrollmentCard still owns acceptProgramOffer/declineProgramOffer — no duplicate action wiring was added to EventsUpcomingClient for this checkpoint", () => {
    const cardSrc = readSource(CARD_PATH);
    expect(cardSrc).toContain("acceptProgramOffer({ p_program_id: program.id, expectedClubId: clubId })");
    expect(cardSrc).toContain("declineProgramOffer({ p_program_id: program.id, expectedClubId: clubId })");

    const upcomingSrc = readSource(UPCOMING_PATH);
    expect(upcomingSrc).not.toMatch(/acceptProgramOffer|declineProgramOffer/);
  });

  it("EventsUpcomingClient wraps ProgramEnrollmentCard in a plain id-bearing div — it does not fork into a second component or pass any new action props", () => {
    const s = readSource(UPCOMING_PATH);
    const idx = s.indexOf("{filteredPrograms.map(p => (");
    expect(idx).toBeGreaterThan(-1);
    const block = s.slice(idx, idx + 600);
    expect(block).toContain("<ProgramEnrollmentCard");
    expect(block).toContain("program={p}");
    expect(block).not.toContain("initialProgramId");
  });
});
