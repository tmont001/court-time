import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 41A runtime QA correction — a live Admin cancellation of a paid
// reservation whose Checkout guard needed Stripe resolution showed
// "Something went wrong. Please try again." even though the retry
// (a second click, after the blocking Checkout attempt genuinely
// resolved) durably committed. Root cause, proven by direct source
// inspection (no live Postgres/browser harness in this repo — same
// source-inspection style as staleCheckoutInvalidation.regression.test.ts):
//
//   1. adminCancelReservation returned resolveBlockingCheckoutBeforeMutation's
//      OWN full human-readable `error` string (e.g.
//      "An online payment is already processing or completed. Refresh the
//      payment before making another change.") instead of its short `code`
//      ("checkout_still_processing") — diverging from
//      updateMemberReservationAdmin's own established convention.
//   2. ReservationDetailSheet.tsx's mapCancelError only recognized three
//      known short codes and replaced EVERY other string — including that
//      already-correct message — with a generic, non-actionable fallback,
//      even though EditReservationSheet.tsx's own mapEditError already had
//      the identical two cases for the exact same two codes.
//   3. Neither cancel handler ever refreshed the sheet's paymentState after
//      a failed attempt, so a stale "Unpaid" badge (fetched once on mount)
//      persisted regardless of what the payment actually did in the
//      background — directly contradicting the failure message's own
//      "Refresh the payment" instruction.
//
// This is a correctly-blocked (fail-closed, by design — Postgres cannot
// itself call Stripe) cancellation attempt being shown with a useless
// message and stale supporting UI, not a genuine "reported failure after
// durable success" for the SAME request — a raised Postgres exception can
// never coexist with a commit for the same transaction.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const ACTIONS_PATH = "src/app/(app)/calendar/actions.ts";
const DETAIL_SHEET_PATH = "src/app/(app)/calendar/ReservationDetailSheet.tsx";
const EDIT_SHEET_PATH = "src/app/(app)/calendar/EditReservationSheet.tsx";
const LESSONS_ACTIONS_PATH = "src/app/(app)/lessons/actions.ts";

function functionSource(src: string, exportSignature: string): string {
  const start = src.indexOf(exportSignature);
  expect(start, `${exportSignature} not found`).toBeGreaterThanOrEqual(0);
  const nextExport = src.indexOf("\nexport ", start + exportSignature.length);
  return nextExport > 0 ? src.slice(start, nextExport) : src.slice(start);
}

describe("adminCancelReservation — returns the short machine code, not the raw human sentence", () => {
  it("returns resolved.code (matching updateMemberReservationAdmin's own convention) rather than resolved.error", () => {
    const src = readSource(ACTIONS_PATH);
    const fn = functionSource(src, "export async function adminCancelReservation(");
    expect(fn).toContain("if (!resolved.ok) return { error: resolved.code };");
    expect(fn).not.toContain("if (!resolved.ok) return { error: resolved.error };");
  });

  it("cancelMemberReservation is untouched — it still returns resolved.error, and ReservationDetailSheet's handleMemberCancel displays it raw (no mapCancelError), so that path was never broken and must not be changed", () => {
    const src = readSource(ACTIONS_PATH);
    const fn = functionSource(src, "export async function cancelMemberReservation(");
    expect(fn).toContain("if (!resolved.ok) return { error: resolved.error };");
  });
});

describe("mapCancelError (ReservationDetailSheet.tsx) — recognizes the checkout-resolution codes", () => {
  function mapCancelErrorSource(): string {
    const src = readSource(DETAIL_SHEET_PATH);
    const start = src.indexOf("function mapCancelError(message: string): string {");
    const end = src.indexOf("\n}\n", start);
    return src.slice(start, end);
  }

  it("no longer falls through to the generic fallback for checkout_still_processing", () => {
    const fn = mapCancelErrorSource();
    expect(fn).toContain('if (message === "checkout_still_processing")');
    expect(fn).toContain(
      "An online payment is already processing or completed. Refresh the payment before making another change.",
    );
  });

  it("no longer falls through to the generic fallback for checkout_resolution_failed", () => {
    const fn = mapCancelErrorSource();
    expect(fn).toContain('if (message === "checkout_resolution_failed")');
    expect(fn).toContain("Court Time could not verify the online payment status. No changes were made. Please try again.");
  });

  it("uses the SAME copy EditReservationSheet.tsx's mapEditError already uses for these two codes — one established mapping, not a divergent duplicate", () => {
    const detailSheetFn = mapCancelErrorSource();
    const editSheetSrc = readSource(EDIT_SHEET_PATH);
    const editSheetFn = editSheetSrc.slice(
      editSheetSrc.indexOf("function mapEditError("),
      editSheetSrc.indexOf("\n}\n", editSheetSrc.indexOf("function mapEditError(")),
    );

    for (const phrase of [
      "An online payment is already processing or completed. Refresh the payment before making another change.",
      "Court Time could not verify the online payment status. No changes were made. Please try again.",
    ]) {
      expect(detailSheetFn).toContain(phrase);
      expect(editSheetFn).toContain(phrase);
    }
  });

  it("still falls through to the generic message for a genuinely unrecognized/internal code — this is not a blanket pass-through", () => {
    const fn = mapCancelErrorSource();
    expect(fn).toContain('return "Something went wrong. Please try again.";');
  });
});

describe("stale payment-state display — refreshed after a failed cancel attempt", () => {
  function handlerSource(name: string): string {
    const src = readSource(DETAIL_SHEET_PATH);
    const start = src.indexOf(`async function ${name}(`);
    expect(start, `${name} not found`).toBeGreaterThanOrEqual(0);
    const end = src.indexOf("\n  }\n", start);
    return src.slice(start, end);
  }

  it("handleAdminCancel refreshes paymentState (loadPaymentState) inside its error branch, after setError and before returning", () => {
    const fn = handlerSource("handleAdminCancel");
    const errorBranch = fn.slice(fn.indexOf("if (result?.error)"));
    const setErrorIdx = errorBranch.indexOf("setError(mapCancelError(result.error));");
    const refreshIdx = errorBranch.indexOf("loadPaymentState();");
    const returnIdx = errorBranch.indexOf("return;");
    expect(setErrorIdx).toBeGreaterThan(-1);
    expect(refreshIdx).toBeGreaterThan(setErrorIdx);
    expect(refreshIdx).toBeLessThan(returnIdx);
  });

  it("handleMemberCancel refreshes paymentState identically — same shared state, same component", () => {
    const fn = handlerSource("handleMemberCancel");
    const errorBranch = fn.slice(fn.indexOf("if (result?.error)"));
    expect(errorBranch).toContain("loadPaymentState();");
  });

  it("loadPaymentState itself is unchanged — this is a call-site fix, not a redesign of the payment-fetch mechanism", () => {
    const src = readSource(DETAIL_SHEET_PATH);
    expect(src).toContain("async function loadPaymentState() {");
    expect(src).toContain('if (reservation.reason !== "member_booking") return;');
  });

  it("a SUCCESSFUL cancel still takes the onCancelled() path (which closes/removes the sheet) — the refresh fix only touches the failure branch", () => {
    const fn = handlerSource("handleAdminCancel");
    expect(fn).toMatch(/onCancelled\(\);\s*$/);
  });
});

describe("non-regression — lessons already handle this correctly via a different, server-side mapping architecture", () => {
  it("mapLessonError already maps open_checkout_requires_resolution to CHECKOUT_STILL_PROCESSING_MESSAGE, and runs server-side inside cancelLesson itself — no client-side gap exists there", () => {
    const src = readSource(LESSONS_ACTIONS_PATH);
    expect(src).toContain("open_checkout_requires_resolution: CHECKOUT_STILL_PROCESSING_MESSAGE,");
    expect(src).toContain("return { error: mapLessonError(error.message) };");
  });
});
