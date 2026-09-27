import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 45B, PERF-01 — sendAnnouncementAction dispatched each recipient's
// email SEQUENTIALLY (a plain for-of loop, each await blocking the next),
// so total Server Action latency scaled linearly with recipient count — the
// same regression class Phase 34F-D already diagnosed and fixed for
// updateEventAdmin, just never carried over to this call site. Unlike
// updateEventAdmin's fix, an unbounded Promise.all is NOT acceptable here:
// a club-wide announcement can reach hundreds/thousands of recipients, and
// firing every recipient's email dispatch at once would put an unbounded
// number of outbound SMS/email/DB calls in flight simultaneously. The fix
// is BOUNDED concurrency via the shared runWithBoundedConcurrency helper
// (src/lib/concurrency.ts), capped at DEFAULT_DISPATCH_CONCURRENCY (8).
//
// This is a deterministic, source-verifiable fix (not a timing-based
// assertion): the loop shape itself, plus the RPC call and audience-mode
// contract, which must be byte-identical to before this checkpoint.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const ACTIONS_PATH = "src/app/(app)/admin/communications/communicationsActions.ts";

function getSendAnnouncementActionFn(): string {
  const s = readSource(ACTIONS_PATH);
  const start = s.indexOf("export async function sendAnnouncementAction(");
  const end = s.indexOf(
    "\n// Admin IA Checkpoint 4 — authorization hardening.",
    start,
  );
  return s.slice(start, end);
}

describe("sendAnnouncementAction dispatches recipient email with BOUNDED concurrency, not sequentially and not unbounded", () => {
  it("no longer contains a sequential for-of/for-await dispatch loop", () => {
    const fn = getSendAnnouncementActionFn();
    expect(fn).not.toMatch(/for \(const \{ notification_id, user_id \} of notifications\)/);
  });

  it("uses the shared runWithBoundedConcurrency helper, capped at DEFAULT_DISPATCH_CONCURRENCY — never a raw whole-list Promise.all", () => {
    const fn = getSendAnnouncementActionFn();
    expect(fn).toContain("await runWithBoundedConcurrency(\n    notifications,\n    DEFAULT_DISPATCH_CONCURRENCY,");
    expect(fn).not.toMatch(/await Promise\.all\(\s*notifications\.map/);
  });

  it("imports the concurrency helper from the local, dependency-free module — no external package introduced", () => {
    const s = readSource(ACTIONS_PATH);
    expect(s).toContain(
      'import { runWithBoundedConcurrency, DEFAULT_DISPATCH_CONCURRENCY } from "@/lib/concurrency";',
    );
  });

  it("each dispatch call still isolates its own failure (try/catch inside the worker) — bounding concurrency changes nothing about error handling", () => {
    const fn = getSendAnnouncementActionFn();
    const workerIdx = fn.indexOf("async ({ notification_id, user_id }) => {");
    expect(workerIdx).toBeGreaterThan(-1);
    const block = fn.slice(workerIdx, workerIdx + 400);
    expect(block).toContain("try {");
    expect(block).toContain("await sendEmailNotification(");
    expect(block).toContain("} catch {");
  });

  it("still dispatches exactly the RPC's own returned notifications array — no re-derivation, no slicing, no separate recipient query", () => {
    const fn = getSendAnnouncementActionFn();
    const rpcIdx = fn.indexOf('supabase.rpc("send_announcement_v2"');
    const dispatchIdx = fn.indexOf("runWithBoundedConcurrency(\n    notifications,");
    expect(rpcIdx).toBeGreaterThan(-1);
    expect(dispatchIdx).toBeGreaterThan(rpcIdx);
    const between = fn.slice(rpcIdx, dispatchIdx);
    expect(between).not.toMatch(/\.from\("(profiles|club_memberships|notifications)"\)/);
  });

  it("send_announcement_v2 is still called with the exact same four named arguments — audience mode / recipient contract unchanged by this checkpoint", () => {
    const fn = getSendAnnouncementActionFn();
    expect(fn).toContain('supabase.rpc("send_announcement_v2", {\n    p_title:              title,\n    p_body:                body,\n    p_audience_mode:       audienceMode,\n    p_recipient_user_ids:  recipientUserIds,\n  });');
  });

  it("revalidatePath still runs, still after the (now bounded-parallel) dispatch completes", () => {
    const fn = getSendAnnouncementActionFn();
    const dispatchIdx = fn.indexOf("await runWithBoundedConcurrency(");
    const revalidateIdx = fn.indexOf('revalidatePath("/admin/communications");');
    expect(dispatchIdx).toBeGreaterThan(-1);
    expect(revalidateIdx).toBeGreaterThan(dispatchIdx);
  });

  it("does not touch payment/domain mutation code — this function only ever inserts an announcement and sends email, no reference to Stripe/payments", () => {
    const fn = getSendAnnouncementActionFn();
    expect(fn).not.toMatch(/stripe|payment_mode|checkout/i);
  });
});
