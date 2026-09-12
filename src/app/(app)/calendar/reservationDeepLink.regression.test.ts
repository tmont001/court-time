import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 36B — regression coverage for generalizing the reservation deep
// link (?reservation=<uuid>, independent of checkout=success) and the
// cancelled-reservation read-only display, using this repository's
// established source-inspection style (see reservationCheckout.regression.
// test.ts's own header comment for why: this baseline is deliberately
// pure-TypeScript with no jsdom/Supabase/router mocking, so for "does the
// shipped code actually take this shape" questions, reading the real
// source is a more honest guard than reimplementing a parallel mock that
// could drift). Sheet-open runtime behavior itself (does clicking actually
// render the right thing) is left to real runtime QA rather than brittle
// DOM mocking, per this checkpoint's own instructions.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

// Strips `//` comment-only lines — used only for the "never renders this
// column" check below, which must not be fooled by this file's own prose
// mentioning notification kind names like reservation_cancelled_by_admin.
function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

const PAGE_PATH   = "src/app/(app)/calendar/page.tsx";
const SHELL_PATH  = "src/app/(app)/calendar/CalendarShell.tsx";
const SHEET_PATH  = "src/app/(app)/calendar/ReservationDetailSheet.tsx";

describe("page.tsx — ?reservation=<uuid> is accepted independent of checkout=success", () => {
  const src = () => readSource(PAGE_PATH);

  it("computes initialReservationId without requiring checkoutParam to be 'success'", () => {
    const s = src();
    const idx = s.indexOf("const initialReservationId =");
    expect(idx).toBeGreaterThan(-1);
    const line = s.slice(idx, s.indexOf(";", idx) + 1);
    expect(line).not.toContain("checkoutParam");
  });

  it("still validates the param against a UUID shape before passing it on — a malformed value is ignored", () => {
    const s = src();
    const idx = s.indexOf("const initialReservationId =");
    const line = s.slice(idx, s.indexOf(";", idx) + 1);
    expect(line).toContain("uuidRe.test(reservationParam)");
    expect(line).toContain("reservationParam &&");
  });

  it("passes the resolved id to CalendarShell as initialReservationId", () => {
    const s = src();
    expect(s).toContain("initialReservationId={initialReservationId}");
    // The old checkout-gated prop name must be gone, not just renamed
    // alongside a lingering duplicate.
    expect(s).not.toContain("initialCheckoutReservationId");
  });

  it("leaves the Event checkout param untouched (still gated on checkout=success — out of scope until 36C)", () => {
    const s = src();
    expect(s).toContain('checkoutParam === "success" && eventParam && uuidRe.test(eventParam)');
  });
});

describe("CalendarShell.tsx — reservation deep-link effect", () => {
  const src = () => readSource(SHELL_PATH);

  it("reads the generalized initialReservationId prop, not the old checkout-only name", () => {
    const s = src();
    expect(s).toContain("initialReservationId");
    // The old name may still appear in prose explaining the rename, but
    // never as an actual prop/destructure/type reference.
    expect(s).not.toMatch(/initialCheckoutReservationId\??:\s*string/);
    expect(s).not.toMatch(/\{\s*[^}]*\binitialCheckoutReservationId\b[^}]*\}\s*:\s*Props/);
  });

  it("Phase 36B security correction: delegates to the getReservationDeepLinkDetail Server Action rather than querying reservations directly from the browser — the deep-link effect block itself never calls .from(\"reservations\")", () => {
    const s = src();
    const idx = s.indexOf("if (!initialReservationId) return;");
    expect(idx).toBeGreaterThan(-1);
    const endIdx = s.indexOf("}, []);", idx);
    const block = s.slice(idx, endIdx);
    expect(block).toContain("getReservationDeepLinkDetail(initialReservationId)");
    expect(block).toContain("if (reservation) setSelectedReservation(reservation);");
    expect(block).not.toContain('.from("reservations")');
    // canOpenReservationDetail is applied server-side inside the action now
    // — not re-applied a second time in this client effect.
    expect(block).not.toContain("canOpenReservationDetail(");
  });

  it("imports getReservationDeepLinkDetail from the calendar Server Actions module", () => {
    const s = src();
    expect(s).toMatch(/import\s*\{[^}]*\bgetReservationDeepLinkDetail\b[^}]*\}\s*from\s*"\.\/actions";/);
  });

  it("the grid's own isClickable delegates to the same canOpenReservationDetail helper — one rule, not two", () => {
    const s = src();
    expect(s).toContain("const isClickable = canOpenReservationDetail(");
  });

  it("imports canOpenReservationDetail from the extracted, framework-independent module", () => {
    const s = src();
    expect(s).toContain('import { canOpenReservationDetail } from "@/lib/calendar/reservationAccess";');
  });

  it("runs the reservation deep-link effect once on mount only (empty dependency array)", () => {
    const s = src();
    const idx = s.indexOf("if (!initialReservationId) return;");
    const endIdx = s.indexOf("}, []);", idx);
    expect(endIdx).toBeGreaterThan(idx);
    const block = s.slice(idx, endIdx + "}, []);".length);
    expect(block).toMatch(/\},\s*\[\]\);/);
  });

  it("strips reservation/checkout via window.history.replaceState, preserving other params, and never reintroduces router.replace for this effect", () => {
    const s = src();
    const idx = s.indexOf("if (!initialReservationId) return;");
    const endIdx = s.indexOf("}, []);", idx);
    const block = s.slice(idx, endIdx);
    expect(block).toContain('params.delete("reservation");');
    expect(block).toContain('params.delete("checkout");');
    expect(block).toContain("window.history.replaceState(null, \"\", query ? `/calendar?${query}` : \"/calendar\");");
    expect(block).not.toContain("router.replace(");
  });
});

describe("ReservationDetailSheet.tsx — cancelled reservation renders read-only", () => {
  const src = () => readSource(SHEET_PATH);

  it("derives isCancelled from reservation.status", () => {
    const s = src();
    expect(s).toContain('const isCancelled = reservation.status === "cancelled";');
  });

  it("shows a visible Cancelled indicator", () => {
    const s = src();
    const idx = s.indexOf("{isCancelled && (");
    expect(idx).toBeGreaterThan(-1);
    const block = s.slice(idx, idx + 300);
    expect(block).toContain("Cancelled");
    expect(block).toContain("<span");
  });

  it("never renders the Cancel button once already cancelled", () => {
    const s = src();
    const idx = s.indexOf("{/* Cancel — member mode or admin mode");
    expect(idx).toBeGreaterThan(-1);
    const block = s.slice(idx, idx + 400);
    expect(block).toContain("{!isCancelled && (");
  });

  it("never renders Pay Now or Record Payment once already cancelled", () => {
    const s = src();
    expect(s).toContain("{!isCancelled && !onMemberCancel && canManageMemberReservation && isPaymentOpenForRecording(paymentState)");
    expect(s).toContain("{!isCancelled && onMemberCancel && checkoutEligible && isPaymentOpenForRecording(paymentState)");
  });

  it("never reads/renders internal cancellation metadata (cancelled_at/cancelled_by/cancellation_kind)", () => {
    const s = codeOnly(src());
    expect(s).not.toContain("cancelled_at");
    expect(s).not.toContain("cancelled_by");
    expect(s).not.toContain("cancellation_kind");
  });

  it("Edit/Edit Block and Add to Calendar remain gated by status === 'confirmed', unchanged by this checkpoint", () => {
    const s = src();
    expect(s).toContain('reservation.status === "confirmed" &&\n    new Date(reservation.starts_at) > new Date();');
    expect(s).toContain('reservation.status === "confirmed" &&\n    new Date(reservation.ends_at) > new Date()');
  });
});
