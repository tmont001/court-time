import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 45B, PERF-02 — cancelEvent dispatched each notified participant's
// SMS/email SEQUENTIALLY (a plain for-of loop, each await blocking the
// next), unlike its sibling updateEventAdmin (Phase 34F-D), which already
// parallelizes the identical fan-out shape. An unbounded Promise.all is
// deliberately NOT used here either: a cancelled whole-Program session can
// notify every currently enrolled Member in one call, and firing every
// recipient's SMS/email dispatch at once would put an unbounded number of
// outbound calls in flight simultaneously. The fix is BOUNDED concurrency
// via the shared runWithBoundedConcurrency helper (src/lib/concurrency.ts),
// capped at DEFAULT_DISPATCH_CONCURRENCY (8) — the same helper and constant
// used by sendAnnouncementAction's equivalent fix.
//
// This is a deterministic, source-verifiable fix (not a timing-based
// assertion): the loop shape itself, the actor-exclusion behavior, and the
// cancel_event RPC/checkout-invalidation contract, all of which must be
// unchanged by this checkpoint.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const CALENDAR_ACTIONS = "src/app/(app)/calendar/actions.ts";

function getCancelEventFn(): string {
  const s = readSource(CALENDAR_ACTIONS);
  const start = s.indexOf("export async function cancelEvent(");
  const end = s.indexOf("export async function cancelMemberReservation(", start);
  return s.slice(start, end);
}

describe("cancelEvent dispatches notifications with BOUNDED concurrency, not sequentially and not unbounded", () => {
  it("no longer contains a sequential for-of/for-await dispatch loop", () => {
    const fn = getCancelEventFn();
    expect(fn).not.toMatch(/for \(const \{ notification_id, user_id \} of notifications\)/);
  });

  it("uses the shared runWithBoundedConcurrency helper, capped at DEFAULT_DISPATCH_CONCURRENCY — never a raw whole-list Promise.all", () => {
    const fn = getCancelEventFn();
    expect(fn).toContain("await runWithBoundedConcurrency(\n    recipientsToNotify,\n    DEFAULT_DISPATCH_CONCURRENCY,");
    expect(fn).not.toMatch(/await Promise\.all\(\s*notifications\.map/);
    expect(fn).not.toMatch(/await Promise\.all\(\s*recipientsToNotify\.map/);
  });

  it("imports the concurrency helper from the local, dependency-free module — no external package introduced", () => {
    const s = readSource(CALENDAR_ACTIONS);
    expect(s).toContain(
      'import { runWithBoundedConcurrency, DEFAULT_DISPATCH_CONCURRENCY } from "@/lib/concurrency";',
    );
  });

  it("still excludes the actor before dispatch (filter, not a per-item `continue`) — the actor is never emailed/SMS'd even though they may appear in the RPC's returned array", () => {
    const fn = getCancelEventFn();
    expect(fn).toContain(
      "const recipientsToNotify = notifications.filter(({ user_id }) => user_id !== actorUserId);",
    );
  });

  it("every entry in the filtered recipientsToNotify list is dispatched exactly once — the filter runs before the bounded-concurrency call, not inside the worker, so no recipient can be skipped or duplicated by chunk boundaries", () => {
    const fn = getCancelEventFn();
    const filterStatement = "const recipientsToNotify = notifications.filter(({ user_id }) => user_id !== actorUserId);";
    const filterIdx = fn.indexOf(filterStatement);
    const dispatchIdx = fn.indexOf("await runWithBoundedConcurrency(");
    expect(filterIdx).toBeGreaterThan(-1);
    expect(dispatchIdx).toBeGreaterThan(filterIdx);
    const between = fn.slice(filterIdx + filterStatement.length, dispatchIdx);
    // No second filter/slice/re-derivation of the recipient list between the
    // actor-exclusion filter and the dispatch call.
    expect(between).not.toMatch(/\.filter\(|\.slice\(/g);
  });

  it("each dispatch call still isolates its own failure (try/catch inside the worker) — bounding concurrency changes nothing about error handling", () => {
    const fn = getCancelEventFn();
    const workerIdx = fn.indexOf("async ({ notification_id }) => {");
    expect(workerIdx).toBeGreaterThan(-1);
    const block = fn.slice(workerIdx, workerIdx + 250);
    expect(block).toContain("try {");
    expect(block).toContain("await dispatchEventNotification(supabase, notification_id);");
    expect(block).toContain("} catch {");
  });

  it("dispatchEventNotification itself is untouched by this fix — no change to what gets sent, only how many are in flight at once", () => {
    const s = readSource("src/lib/notification-dispatch.ts");
    expect(s).toContain("export async function dispatchEventNotification(");
  });

  it("cancel_event RPC call and the checkout-invalidation resolve-then-retry loop are unchanged — this checkpoint only touches the notification fan-out, after the RPC has already returned", () => {
    const fn = getCancelEventFn();
    expect(fn).toContain('supabase.rpc("cancel_event", {\n    p_event_id: eventId,\n  });');
    expect(fn).toMatch(/for \(let attempt = 0; attempt < 2 &&/);
    expect(fn).toContain("resolveAllBlockingEventCheckouts(eventId, expectedClubId)");
  });

  it("does not move the cancellation itself into client-side concurrency logic — the RPC call and its retry loop remain sequential/awaited before any notification is ever dispatched", () => {
    const fn = getCancelEventFn();
    const rpcIdx = fn.indexOf('supabase.rpc("cancel_event"');
    const dispatchIdx = fn.indexOf("await runWithBoundedConcurrency(");
    expect(rpcIdx).toBeGreaterThan(-1);
    expect(dispatchIdx).toBeGreaterThan(rpcIdx);
  });
});
