import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 34F-D, Item 5 — performance diagnosis for "editing one generated
// Program session's court/time is noticeably slow".
//
// Root cause, traced UI action -> Server Action -> RPC -> DB work ->
// notification dispatch: update_event's own notification loop (0161)
// produces one notification per currently confirmed/waitlisted/offered
// event_participants row on a material (starts_at/ends_at/court-set/
// event_type_id) edit. For a whole-program session, event_participants
// includes EVERY enrolled Member (materialized by _materialize_program_
// member_into_future_events, 0113) — tens of recipients for a real
// class/clinic roster, vs. the handful an ordinary Event usually has.
// updateEventAdmin (admin/events/actions.ts) then dispatched these
// notifications with a SEQUENTIALLY AWAITED for-loop — each dispatchEvent
// Notification call does its own network-bound SMS/email send, so total
// Server Action latency scaled linearly with roster size and blocked the
// Admin's Save action the entire time.
//
// This is a deterministic, source-verifiable cause (not a timing-based
// assertion): the loop shape itself. The fix parallelizes the independent,
// order-agnostic dispatch calls via Promise.all — each call already
// isolates its own failure (both internally, in dispatchEventNotification,
// and via the outer try/catch here), so parallelizing changes nothing
// about which notifications are sent or error handling, only how long the
// Server Action blocks waiting for them.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const ACTIONS_PATH = "src/app/(app)/admin/events/actions.ts";

function getUpdateEventAdminFn(): string {
  const s = readSource(ACTIONS_PATH);
  const start = s.indexOf("export async function updateEventAdmin(");
  const end = s.indexOf("\n// ---------------------------------------------------------------------------\n// setEventPriceOverrideAction", start);
  return s.slice(start, end);
}

describe("updateEventAdmin dispatches notifications in PARALLEL, not sequentially — the deterministic fix for the reported single-Program-session-edit slowness", () => {
  it("uses Promise.all over notifications.map — never a sequential for-of/for-await loop", () => {
    const fn = getUpdateEventAdminFn();
    expect(fn).toContain("await Promise.all(\n    notifications.map(async ({ notification_id }) => {");
    expect(fn).not.toMatch(/for \(const \{ notification_id \} of notifications\)/);
  });

  it("each dispatch call still isolates its own failure (try/catch inside the map callback) — parallelizing changes nothing about error handling, only concurrency", () => {
    const fn = getUpdateEventAdminFn();
    const mapIdx = fn.indexOf("notifications.map(async ({ notification_id }) => {");
    const block = fn.slice(mapIdx, mapIdx + 300);
    expect(block).toContain("try {");
    expect(block).toContain("await dispatchEventNotification(supabase, notification_id);");
    expect(block).toContain("} catch {");
  });

  it("dispatchEventNotification itself is untouched by this fix — no change to what gets sent, only how many are in flight at once", () => {
    const s = readSource("src/lib/notification-dispatch.ts");
    expect(s).toContain("export async function dispatchEventNotification(");
  });

  it("does not touch the Program-level Checkout invariant: this loop only ever inserts notifications/sends SMS/email — no payment/domain mutation, no reference to program_enrollment or Program Checkout anywhere in updateEventAdmin", () => {
    const fn = getUpdateEventAdminFn();
    expect(fn).not.toMatch(/program_enrollment|ProgramCheckout|program_payment/i);
  });

  it("revalidatePath calls are unaffected — still exactly /calendar and /events, still after the (now-parallel) dispatch completes", () => {
    const fn = getUpdateEventAdminFn();
    const dispatchIdx = fn.indexOf("await Promise.all(");
    const revalidateIdx = fn.indexOf('revalidatePath("/calendar");');
    expect(dispatchIdx).toBeGreaterThan(-1);
    expect(revalidateIdx).toBeGreaterThan(dispatchIdx);
    expect(fn).toContain('revalidatePath("/events");');
  });
});
