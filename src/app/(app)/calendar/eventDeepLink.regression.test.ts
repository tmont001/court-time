import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Phase 36C — regression coverage for generalizing the Event deep link
// (?event=<uuid>, independent of checkout=success) and the cancelled-Event
// read-only display, using this repository's established source-
// inspection style (see reservationDeepLink.regression.test.ts's own
// header comment, itself citing reservationCheckout.regression.test.ts,
// for why: this baseline is deliberately pure-TypeScript with no jsdom/
// Supabase/router mocking). Sheet-open runtime behavior itself is left to
// real runtime QA rather than brittle DOM mocking.
//
// ARCHITECTURE NOTE this file locks in: unlike the reservation deep link
// (Phase 36B, which needed a server-side getReservationDeepLinkDetail
// Server Action because reservations_select_same_club RLS is broader than
// the calendar grid's own per-row click-eligibility rule), the Event deep
// link deliberately keeps its direct browser-side fetch. The audit
// (see the RLS-evidence describe block below) found events_select_same_
// club RLS already IS the exact intended Event-visibility rule — and the
// calendar grid's own click handler has never applied any further
// eligibility check on top of it (every RLS-visible Event block is
// unconditionally clickable). Adding a server-side re-authorization layer
// here would add complexity without adding security.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const PAGE_PATH  = "src/app/(app)/calendar/page.tsx";
const SHELL_PATH = "src/app/(app)/calendar/CalendarShell.tsx";
const SHEET_PATH = "src/app/(app)/calendar/EventDetailSheet.tsx";
const RLS_0132    = "supabase/migrations/0132_staff_operational_authorization.sql";

describe("page.tsx — ?event=<uuid> is accepted independent of checkout=success", () => {
  const src = () => readSource(PAGE_PATH);

  it("computes initialEventId without requiring checkoutParam to be 'success' — the checkoutParam variable no longer exists at all in page.tsx", () => {
    const s = src();
    const idx = s.indexOf("const initialEventId =");
    expect(idx).toBeGreaterThan(-1);
    const line = s.slice(idx, s.indexOf(";", idx) + 1);
    expect(line).not.toContain("checkoutParam");
    expect(s).not.toContain("checkoutParam");
  });

  it("still validates the param against a UUID shape before passing it on — a malformed value is ignored", () => {
    const s = src();
    const idx = s.indexOf("const initialEventId =");
    const line = s.slice(idx, s.indexOf(";", idx) + 1);
    expect(line).toContain("uuidRe.test(eventParam)");
    expect(line).toContain("eventParam &&");
  });

  it("passes the resolved id to CalendarShell as initialEventId, and the old checkout-gated prop name is gone entirely", () => {
    const s = src();
    expect(s).toContain("initialEventId={initialEventId}");
    expect(s).not.toContain("initialCheckoutEventId");
  });

  it("checkout=success&event=<uuid> still resolves the same initialEventId — success is just one of the values eventParam's uuid check no longer distinguishes", () => {
    // Since acceptance no longer branches on checkout at all, both
    // ?checkout=success&event=<uuid> and ?checkout=cancel&event=<uuid>
    // (Stripe's cancel_url, which always carries this same param — see
    // paymentsConfig.test.ts) resolve identically: the event opens either
    // way. This is the intended, positive behavior change (mirroring the
    // reservation deep link's own 36B decision), not an oversight.
    const s = src();
    expect(s).not.toMatch(/checkoutParam\s*===\s*"success"\s*&&\s*eventParam/);
  });
});

describe("CalendarShell.tsx — Event deep-link effect", () => {
  const src = () => readSource(SHELL_PATH);

  it("reads the generalized initialEventId prop, not the old checkout-only name", () => {
    const s = src();
    expect(s).toContain("initialEventId");
    expect(s).not.toMatch(/initialCheckoutEventId\??:\s*string/);
    expect(s).not.toMatch(/\{\s*[^}]*\binitialCheckoutEventId\b[^}]*\}\s*:\s*Props/);
  });

  it("fetches the Event directly via the browser Supabase client — no Server Action, unlike the reservation deep link (deliberate: see this file's own header comment / the RLS-evidence describe block below)", () => {
    const s = src();
    const idx = s.indexOf("if (!initialEventId) return;");
    expect(idx).toBeGreaterThan(-1);
    const endIdx = s.indexOf("}, [initialEventId, searchParams]);", idx);
    expect(endIdx).toBeGreaterThan(idx);
    const block = s.slice(idx, endIdx);
    expect(block).toContain('.from("events")');
    expect(block).toContain(".single()");
    expect(block).not.toContain("getEventDeepLinkDetail");
    expect(block).not.toContain("canOpenReservationDetail");
  });

  it("Phase 36E: the effect depends on [initialEventId, searchParams], not [] — reactive to a same-route notification click and a repeat click of the same notification, not mount-only", () => {
    const s = src();
    const idx = s.indexOf("if (!initialEventId) return;");
    const endIdx = s.indexOf("}, [initialEventId, searchParams]);", idx);
    expect(endIdx).toBeGreaterThan(idx);
    const block = s.slice(idx, endIdx + "}, [initialEventId, searchParams]);".length);
    expect(block).toMatch(/\},\s*\[initialEventId,\s*searchParams\]\);/);
    expect(block).not.toMatch(/\},\s*\[\]\);/);
  });

  it("useSearchParams is imported and called (shared with the reservation effect above) — the reactivity signal that makes this work", () => {
    const s = src();
    expect(s).toContain('import { useRouter, useSearchParams } from "next/navigation";');
    expect(s).toContain("const searchParams = useSearchParams();");
  });

  it("strips event/checkout via window.history.replaceState, preserving other params (e.g. ?date=), never reintroducing router.replace", () => {
    const s = src();
    const idx = s.indexOf("if (!initialEventId) return;");
    const endIdx = s.indexOf("}, [initialEventId, searchParams]);", idx);
    const block = s.slice(idx, endIdx);
    expect(block).toContain('params.delete("event");');
    expect(block).toContain('params.delete("checkout");');
    expect(block).toContain('window.history.replaceState(null, "", query ? `/calendar?${query}` : "/calendar");');
    expect(block).not.toContain("router.replace(");
  });

  it("does not disturb the reservation deep-link effect from Phase 36B — it still calls getReservationDeepLinkDetail, untouched by this checkpoint", () => {
    const s = src();
    expect(s).toContain("getReservationDeepLinkDetail(initialReservationId)");
    const idx = s.indexOf("if (!initialReservationId) return;");
    const endIdx = s.indexOf("}, [initialReservationId, searchParams]);", idx);
    expect(endIdx).toBeGreaterThan(idx);
    const block = s.slice(idx, endIdx);
    expect(block).toContain('params.delete("reservation");');
    expect(block).toContain('params.delete("checkout");');
  });
});

describe("RLS evidence — events_select_same_club already IS the intended Event-detail visibility rule (no separate app-level narrowing exists to preserve)", () => {
  it("events_select_same_club (0132, the last migration to touch it) grants full same-club visibility for admin/pro/staff OR a member_self_service club, and participation-gated visibility otherwise — there is no fourth, narrower branch", () => {
    const s = readSource(RLS_0132);
    const idx = s.indexOf('create policy "events_select_same_club"');
    expect(idx).toBeGreaterThan(-1);
    const policy = s.slice(idx, s.indexOf(");", idx) + 2);
    expect(policy).toContain("current_user_role() in ('admin', 'pro', 'staff')");
    expect(policy).toContain("current_club_has_capability('member_self_service')");
    expect(policy).toContain("current_user_participates_in_event(id)");
  });

  it("no migration after 0132 redefines events_select_same_club", () => {
    // If this ever fails, the RLS-matches-visibility evidence above may be
    // stale and the "no server-side re-authorization layer" decision for
    // Event deep links must be re-audited against the newer policy.
    const migrationsDir = join(process.cwd(), "supabase/migrations");
    const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
    const laterFiles = files.filter((f) => f > "0132_staff_operational_authorization.sql");
    for (const f of laterFiles) {
      const content = readFileSync(join(migrationsDir, f), "utf-8");
      expect(content).not.toContain('drop policy if exists "events_select_same_club"');
    }
  });

  it("the calendar grid's own Event-block click handler has no eligibility gate — every rendered Event block is unconditionally clickable, confirming there is no app-level rule narrower than RLS to replicate for the deep link", () => {
    const s = readSource(SHELL_PATH);
    const idx = s.indexOf("{/* Event blocks — colored, tappable, span the full column */}");
    expect(idx).toBeGreaterThan(-1);
    const block = s.slice(idx, idx + 1200);
    expect(block).toContain("onClick={() => setSelectedEvent(ev)}");
    expect(block).not.toMatch(/isClickable|isOperator|isOwn/);
  });
});

describe("EventDetailSheet.tsx — cancelled Event renders read-only (mirrors ReservationDetailSheet's Phase 36B fix)", () => {
  const src = () => readSource(SHEET_PATH);

  it("derives isCancelled from event.status", () => {
    const s = src();
    expect(s).toContain('const isCancelled = event.status === "cancelled";');
  });

  it("shows a visible Cancelled indicator", () => {
    const s = src();
    const idx = s.indexOf("{isCancelled && (");
    expect(idx).toBeGreaterThan(-1);
    const block = s.slice(idx, idx + 300);
    expect(block).toContain("Cancelled");
    expect(block).toContain("<span");
  });

  it("never offers Join/Leave/Waitlist/Accept/Pass once the Event is cancelled — the whole action block is gated on !isCancelled", () => {
    const s = src();
    const idx = s.indexOf("{!isCancelled && (isOffered ? (");
    expect(idx).toBeGreaterThan(-1);
  });

  it("never offers Cancel Event once already cancelled — canCancelEvent requires event.status === 'scheduled'", () => {
    const s = src();
    expect(s).toContain('const canCancelEvent = event.status === "scheduled" &&');
  });

  it("Edit Event and the member-joinable toggle remain gated by event.status === 'scheduled', unchanged by this checkpoint", () => {
    const s = src();
    expect(s).toContain('const canEdit         = isOperator(userRole) && event.status === "scheduled" && !isPastEvent;');
    expect(s).toContain("const canToggleMemberJoinable = canCancelEvent && event.status === \"scheduled\" && !isPastEvent;");
  });

  it("Pay Now / payment badge already correctly hidden for a cancelled Event via the pre-existing isConfirmed eligibility point (event.status === 'scheduled' required) — no change needed there", () => {
    const s = src();
    expect(s).toContain('const isConfirmed  = myPart?.status === "confirmed" && event.status === "scheduled";');
  });

  it("View Roster, price, courts/date/time/capacity remain visible for a cancelled Event — informational context is retained, only actions are hidden", () => {
    const s = src();
    expect(s).toContain("{canViewRoster && (");
    expect(s).not.toMatch(/canViewRoster\s*=.*status/);
  });
});

describe("Program occurrences deep-link via event_id — no parallel Program-session target", () => {
  it("the Event deep-link effect and its RawEventRow mapping carry program_id only as EXISTING Event-row context (already present pre-36C) — no new program-keyed fetch/branch was added for this checkpoint", () => {
    const s = readSource(SHELL_PATH);
    const idx = s.indexOf("if (!initialEventId) return;");
    const endIdx = s.indexOf("}, [initialEventId, searchParams]);", idx);
    expect(endIdx).toBeGreaterThan(idx);
    const block = s.slice(idx, endIdx);
    // program_id is read as one field of the fetched Event row (via the
    // same RawEventRow shape fetchEvents already uses) — it is never used
    // as a separate lookup key or branch condition in this effect.
    expect(block).toContain("program_id");
    expect(block).not.toMatch(/\.eq\("program_id"/);
    expect(block).not.toContain("/programs/");
  });

  it("EventDetailSheet's own Program context link resolves via the Event's program_id, pointing at the existing Program management surface — not a new dedicated Program-session route", () => {
    const s = readSource(SHEET_PATH);
    expect(s).toContain('event.program_id && canAccessOperationsWorkspace(userRole)');
    expect(s).toContain('href="/events?tab=programs"');
  });
});
