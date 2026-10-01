import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Phase 45E1 UX follow-up — browser QA of the applied 0217 migration found
// that after a Member successfully accepted a waitlist offer through the
// app-wide WaitlistOfferModal popup, an already-open EventDetailSheet for
// the same event kept showing stale "Spot offered"/Pass/Accept Spot
// controls until a full page reload. Root cause: WaitlistOfferModal's
// success handlers called only router.refresh(), which correctly refreshes
// its own server-fetched `offer` prop (layout.tsx re-fetches it) but has
// no effect on CalendarShell's independently, purely client-fetched
// events/selectedEvent state — confirmed by CalendarShell's fetchEvents/
// fetchReservations being driven solely by its own refreshTick state, and
// calendar/page.tsx (CalendarShell's Server Component parent) never
// fetching event/participant data itself. Compounding this,
// EventDetailSheet's own localParticipants/localGuestCount were
// initialized once from the event prop at mount and never resynced.
//
// The fix has two parts:
//   1. EventDetailSheet resyncs localParticipants/localGuestCount whenever
//      CalendarShell hands down a fresh event.event_participants/
//      event.event_guests reference.
//   2. WaitlistOfferModal dispatches a window CustomEvent
//      (WAITLIST_OFFER_RESOLVED_EVENT) after a successful accept/decline;
//      CalendarShell listens for it and, if the currently-open
//      selectedEvent matches, reuses its own existing onRefresh mechanism
//      (bump refreshTick, close the sheet) verbatim.
//
// No backend/RPC/migration behavior is touched by this checkpoint — this
// is a client-side synchronization fix only. Every assertion below is a
// source-text check against the actual .tsx/.ts source files.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const WAITLIST_MODAL_PATH   = "src/components/WaitlistOfferModal.tsx";
const CALENDAR_SHELL_PATH   = "src/app/(app)/calendar/CalendarShell.tsx";
const EVENT_DETAIL_PATH     = "src/app/(app)/calendar/EventDetailSheet.tsx";

// ─────────────────────────────────────────────────────────────────────────
// 1-2. Successful accept/decline notify the sheet to clear/refetch.
// ─────────────────────────────────────────────────────────────────────────

describe("WaitlistOfferModal — successful accept/decline notify any open sheet before refreshing", () => {
  it("exports WAITLIST_OFFER_RESOLVED_EVENT as the shared signal name", () => {
    const s = readSource(WAITLIST_MODAL_PATH);
    expect(s).toContain('export const WAITLIST_OFFER_RESOLVED_EVENT = "ct:waitlist-offer-resolved";');
  });

  it("handleAccept calls notifyOfferResolved(offer!.eventId) on success, before router.refresh()", () => {
    const s = readSource(WAITLIST_MODAL_PATH);
    const idx = s.indexOf("function handleAccept()");
    const end = s.indexOf("function handleDecline()", idx);
    const block = s.slice(idx, end);
    const notifyIdx = block.indexOf("notifyOfferResolved(offer!.eventId);");
    const refreshIdx = block.indexOf("router.refresh();");
    expect(notifyIdx).toBeGreaterThan(-1);
    expect(refreshIdx).toBeGreaterThan(notifyIdx);
  });

  it("handleDecline calls notifyOfferResolved(offer!.eventId) on success, before router.refresh()", () => {
    const s = readSource(WAITLIST_MODAL_PATH);
    const idx = s.indexOf("function handleDecline()");
    const end = s.indexOf("return (", idx);
    const block = s.slice(idx, end);
    const notifyIdx = block.indexOf("notifyOfferResolved(offer!.eventId);");
    const refreshIdx = block.indexOf("router.refresh();");
    expect(notifyIdx).toBeGreaterThan(-1);
    expect(refreshIdx).toBeGreaterThan(notifyIdx);
  });

  it("notifyOfferResolved dispatches a window CustomEvent carrying the eventId, guarded for a non-browser environment", () => {
    const s = readSource(WAITLIST_MODAL_PATH);
    const idx = s.indexOf("function notifyOfferResolved(");
    expect(idx).toBeGreaterThan(-1);
    const block = s.slice(idx, s.indexOf("\n}", idx));
    expect(block).toContain('if (typeof window === "undefined") return;');
    expect(block).toContain("window.dispatchEvent(");
    expect(block).toContain("new CustomEvent(WAITLIST_OFFER_RESOLVED_EVENT, { detail: { eventId } })");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Error paths do NOT clear the offer state.
// ─────────────────────────────────────────────────────────────────────────

describe("WaitlistOfferModal — error paths never notify or refresh", () => {
  it("handleAccept's error branch returns before notifyOfferResolved/router.refresh are reachable", () => {
    const s = readSource(WAITLIST_MODAL_PATH);
    const idx = s.indexOf("function handleAccept()");
    const end = s.indexOf("function handleDecline()", idx);
    const block = s.slice(idx, end);
    const errorIdx = block.indexOf("if (res.error) { setError(mapOfferError(res.error)); return; }");
    const notifyIdx = block.indexOf("notifyOfferResolved(offer!.eventId);");
    expect(errorIdx).toBeGreaterThan(-1);
    expect(notifyIdx).toBeGreaterThan(errorIdx);
  });

  it("handleDecline's error branch returns before notifyOfferResolved/router.refresh are reachable", () => {
    const s = readSource(WAITLIST_MODAL_PATH);
    const idx = s.indexOf("function handleDecline()");
    const end = s.indexOf("return (", idx);
    const block = s.slice(idx, end);
    const errorIdx = block.indexOf("if (res.error) { setError(mapOfferError(res.error)); return; }");
    const notifyIdx = block.indexOf("notifyOfferResolved(offer!.eventId);");
    expect(errorIdx).toBeGreaterThan(-1);
    expect(notifyIdx).toBeGreaterThan(errorIdx);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. offer_no_longer_available mapping remains in both UI files.
// ─────────────────────────────────────────────────────────────────────────

describe("offer_no_longer_available error mapping remains intact in both UI surfaces", () => {
  it("WaitlistOfferModal.tsx still maps offer_no_longer_available", () => {
    const s = readSource(WAITLIST_MODAL_PATH);
    expect(s).toContain("offer_no_longer_available: \"This offer is no longer available.\",");
  });

  it("EventDetailSheet.tsx still maps offer_no_longer_available", () => {
    const s = readSource(EVENT_DETAIL_PATH);
    expect(s).toContain('if (message === "offer_no_longer_available") return "This offer is no longer valid.";');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// CalendarShell listens for the signal and reuses its own existing
// refresh/close mechanism (not a new one).
// ─────────────────────────────────────────────────────────────────────────

describe("CalendarShell — listens for WAITLIST_OFFER_RESOLVED_EVENT without a stale-closure risk", () => {
  function listenerEffectBlock(): string {
    const s = readSource(CALENDAR_SHELL_PATH);
    const idx = s.indexOf("function handleOfferResolved(e: Event)");
    expect(idx).toBeGreaterThan(-1);
    const end = s.indexOf("}, [", idx);
    expect(end).toBeGreaterThan(idx);
    return s.slice(idx, s.indexOf("]);", end) + 3);
  }

  it("imports WAITLIST_OFFER_RESOLVED_EVENT from WaitlistOfferModal", () => {
    const s = readSource(CALENDAR_SHELL_PATH);
    expect(s).toContain('import { WAITLIST_OFFER_RESOLVED_EVENT } from "@/components/WaitlistOfferModal";');
  });

  it("subscribes via window.addEventListener and unsubscribes on cleanup", () => {
    const s = readSource(CALENDAR_SHELL_PATH);
    expect(s).toContain("window.addEventListener(WAITLIST_OFFER_RESOLVED_EVENT, handleOfferResolved);");
    expect(s).toContain("return () => window.removeEventListener(WAITLIST_OFFER_RESOLVED_EVENT, handleOfferResolved);");
  });

  it("registers exactly once, with an empty dependency array — never re-subscribes on selectedEvent changes", () => {
    const block = listenerEffectBlock();
    expect(block.trim().endsWith("}, []);")).toBe(true);
  });

  it("does NOT branch using a closed-over `selectedEvent && selectedEvent.id === eventId` condition anywhere in the handler", () => {
    const block = listenerEffectBlock();
    expect(block).not.toMatch(/if\s*\(\s*selectedEvent\s*&&\s*selectedEvent\.id\s*===\s*eventId\s*\)/);
  });

  it("the handler never reads `selectedEvent` directly (no closure dependency on it at all)", () => {
    const block = listenerEffectBlock();
    expect(block).not.toContain("selectedEvent.id");
    expect(block).not.toMatch(/\bselectedEvent\b/);
  });

  it("always (unconditionally) bumps refreshTick, regardless of which event resolved", () => {
    const block = listenerEffectBlock();
    const bumpIdx = block.indexOf("setRefreshTick(t => t + 1);");
    const guardIdx = block.indexOf("setSelectedEvent(");
    expect(bumpIdx).toBeGreaterThan(-1);
    // The refresh bump must not be nested inside any conditional — it is
    // the very next statement after eventId is read, before any
    // setSelectedEvent call.
    expect(bumpIdx).toBeLessThan(guardIdx);
    const between = block.slice(0, bumpIdx);
    expect(between).not.toContain("if (");
  });

  it("closes the sheet via a functional setState updater comparing prev?.id === eventId — never a captured value", () => {
    const block = listenerEffectBlock();
    expect(block).toContain("setSelectedEvent(prev => (prev?.id === eventId ? null : prev));");
  });

  it("does not call setSelectedEvent with a bare null (the old captured-value pattern) anywhere inside the listener", () => {
    const block = listenerEffectBlock();
    expect(block).not.toContain("setSelectedEvent(null);");
  });

  it("reuses refreshTick/setSelectedEvent — the same underlying state the pre-existing onRefresh callback already manages — not a new state-management mechanism", () => {
    const s = readSource(CALENDAR_SHELL_PATH);
    expect(s).toContain("onRefresh={() => { setRefreshTick(t => t + 1); setSelectedEvent(null); }}");
  });

  it("no full reload, location.reload, or timeout-based workaround was introduced for this fix", () => {
    const s = readSource(CALENDAR_SHELL_PATH);
    expect(s).not.toMatch(/location\.reload/);
    expect(s).not.toMatch(/window\.location\s*=/);
    const block = listenerEffectBlock();
    expect(block).not.toMatch(/setTimeout|setInterval/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// EventDetailSheet resyncs local participant/guest state from the event prop.
// ─────────────────────────────────────────────────────────────────────────

describe("EventDetailSheet — localParticipants/localGuestCount resync from the event prop instead of being captured once at mount", () => {
  it("resyncs localParticipants whenever event.event_participants changes", () => {
    const s = readSource(EVENT_DETAIL_PATH);
    expect(s).toContain("useEffect(() => {\n    setLocalParticipants(event.event_participants);\n  }, [event.event_participants]);");
  });

  it("resyncs localGuestCount whenever event.event_guests changes", () => {
    const s = readSource(EVENT_DETAIL_PATH);
    expect(s).toContain(
      'useEffect(() => {\n    setLocalGuestCount(event.event_guests?.filter(g => g.status === "active").length ?? 0);\n  }, [event.event_guests]);'
    );
  });

  it("the initial useState calls for localParticipants/localGuestCount are unchanged (still seeded from the event prop at mount, now just also resynced later)", () => {
    const s = readSource(EVENT_DETAIL_PATH);
    expect(s).toContain("const [localParticipants, setLocalParticipants]     = useState<EventParticipant[]>(event.event_participants);");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 5. No backend/RPC/migration behavior is changed by this checkpoint.
// ─────────────────────────────────────────────────────────────────────────

describe("no backend/RPC/migration behavior changed by this UX checkpoint", () => {
  it("0217 remains untouched (guarded terminal UPDATE statements still present)", () => {
    const s217 = readSource("supabase/migrations/0217_waitlist_offer_terminal_status_guard.sql");
    expect(s217).toContain("and status = 'offered'");
    expect(s217).toContain("raise exception 'offer_no_longer_available';");
  });

  it("0218 remains untouched (single authenticated revoke on v1)", () => {
    const s218 = readSource("supabase/migrations/0218_admin_cancel_reservation_v1_retirement.sql");
    expect(s218).toContain("revoke execute\non function public.admin_cancel_reservation(uuid)\nfrom authenticated;");
  });

  it("0217 and 0218 both exist as real migration files on disk — this checkpoint is a client-only UX fix and created neither a new nor higher-numbered migration", () => {
    const files: string[] = readdirSync(join(process.cwd(), "supabase/migrations"));
    expect(files).toContain("0217_waitlist_offer_terminal_status_guard.sql");
    expect(files).toContain("0218_admin_cancel_reservation_v1_retirement.sql");
  });

  it("neither acceptWaitlistOffer nor declineWaitlistOffer server actions (calendar/actions.ts) were modified — they still call the same two RPCs with the same argument shape", () => {
    const s = readSource("src/app/(app)/calendar/actions.ts");
    expect(s).toContain('const { error: rpcError } = await supabase.rpc("accept_waitlist_offer", {\n    p_event_id: eventId,\n  });');
    expect(s).toContain('const { error: rpcError } = await supabase.rpc("decline_waitlist_offer", {\n    p_event_id: eventId,\n  });');
  });
});
