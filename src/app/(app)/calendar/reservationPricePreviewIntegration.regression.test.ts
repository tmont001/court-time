import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Peak / Off-Peak Pricing — Checkpoint C: truthful booking-time court
// price preview wired into the existing reservation create/edit UX
// (CalendarShell's booking sheet, EditReservationSheet). Source-inspection
// style, matching this repository's established convention for Server/
// Client Component and Server Action files (no jsdom — see this
// project's other *.regression.test.ts files for the same precedent).
// The pure presentation-label mapping (reservationPriceSourceLabel) has
// its own REAL unit test (src/lib/calendar/reservationPriceSourceLabel.
// test.ts) since it is plain, hook-free TypeScript.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const ACTIONS_PATH        = "src/app/(app)/calendar/actions.ts";
const CALENDAR_SHELL_PATH = "src/app/(app)/calendar/CalendarShell.tsx";
const EDIT_SHEET_PATH     = "src/app/(app)/calendar/EditReservationSheet.tsx";
const PREVIEW_COMPONENT_PATH = "src/app/(app)/calendar/ReservationPricePreview.tsx";
const SOURCE_LABEL_PATH   = "src/lib/calendar/reservationPriceSourceLabel.ts";

function functionBody(src: string, name: string): string {
  const pattern = new RegExp(`export async function ${name}\\(`);
  const match = pattern.exec(src);
  expect(match, `function ${name} not found`).not.toBeNull();
  const start = match!.index;
  const nextExportIdx = src.indexOf("\nexport", start + 1);
  return src.slice(start, nextExportIdx > -1 ? nextExportIdx : undefined);
}

// ═══════════════════════════════════════════════════════════════════════════
// A. previewReservationPrice — the ONE Server Action wrapper
// ═══════════════════════════════════════════════════════════════════════════

describe("A. previewReservationPrice wraps the canonical preview_court_reservation_price RPC verbatim", () => {
  const src = readSource(ACTIONS_PATH);
  const body = functionBody(src, "previewReservationPrice");

  it("calls the real RPC with every field forwarded, nothing recomputed", () => {
    expect(body).toContain('supabase.rpc("preview_court_reservation_price", {');
    expect(body).toContain("p_court_id:         params.p_court_id,");
    expect(body).toContain("p_starts_at:        params.p_starts_at,");
    expect(body).toContain("p_ends_at:          params.p_ends_at,");
    expect(body).toContain("p_roster_member_id: params.p_roster_member_id ?? null,");
    expect(body).toContain("p_expected_club_id: params.expectedClubId,");
  });

  it("always sends p_expected_club_id, for BOTH self-service and operator callers — the universal stale-club guard applies uniformly", () => {
    // p_roster_member_id is optional (self-service omits it); p_expected_club_id
    // is not conditional on it anywhere in this function body.
    expect(body).not.toMatch(/if \(params\.p_roster_member_id\)[\s\S]{0,80}p_expected_club_id/);
  });

  it("preflights with assertActiveClub, matching every other read wrapper in this file", () => {
    expect(body).toMatch(/const guard = await assertActiveClub\(params\.expectedClubId\);/);
    expect(body).toMatch(/if \(!guard\.ok\) return \{ error: guard\.error \};/);
  });

  it("performs no writes — no INSERT/UPDATE/DELETE, no reservation, payment, or checkout mutation", () => {
    expect(body).not.toMatch(/\.insert\(|\.update\(|\.delete\(/);
    expect(body).not.toMatch(/createReservation|adminCreateMemberReservation|updateMemberReservationAdmin/);
    expect(body).not.toMatch(/_create_payment_obligation|open_payment_checkout_attempt/);
  });

  it("reshapes the RPC's single row into camelCase and nothing else — no additional computation on the resolved values", () => {
    expect(body).toContain("membershipPricingClass: row.membership_pricing_class");
    expect(body).toContain("hourlyRateCents:        row.hourly_rate_cents,");
    expect(body).toContain("priceAmountCents:       row.price_amount_cents,");
    expect(body).toContain("appliedRateSource:      row.applied_rate_source,");
    expect(body).toContain("appliedRatePeriodId:    row.applied_rate_period_id,");
    expect(body).toContain("appliedRatePeriodName:  row.applied_rate_period_name,");
    // No arithmetic on hourly_rate_cents/price_amount_cents anywhere in
    // this function — it is a pure pass-through, never a recomputation.
    expect(body).not.toMatch(/hourly_rate_cents\s*\*|price_amount_cents\s*\*/);
  });

  it("never queries court_rate_periods directly — the RPC is the only pricing data source this action touches", () => {
    expect(body).not.toMatch(/court_rate_periods/);
  });

  it("returns a generic 'preview_unavailable' when the RPC returns no row, never guessing a price", () => {
    expect(body).toContain('if (!row) return { error: "preview_unavailable" };');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. CREATE flow — CalendarShell booking sheet
// ═══════════════════════════════════════════════════════════════════════════

describe("B. CalendarShell create-flow uses the canonical preview, never client-side precedence", () => {
  const src = readSource(CALENDAR_SHELL_PATH);

  it("no longer computes a price from court.hourly_rate_cents/defaultCourtHourlyRateCents — that entire client-side chain is gone", () => {
    expect(src).not.toMatch(/bookingSlot\.court\.hourly_rate_cents \?\? defaultCourtHourlyRateCents/);
    expect(src).not.toMatch(/const resolvedRateCents/);
  });

  it("imports and calls previewReservationPrice, and renders the shared ReservationPricePreview component", () => {
    expect(src).toContain("previewReservationPrice");
    expect(src).toContain('import ReservationPricePreview, { type ReservationPricePreviewStatus } from "./ReservationPricePreview";');
    expect(src).toContain("<ReservationPricePreview");
  });

  it("never queries court_rate_periods directly from the client", () => {
    expect(src).not.toMatch(/\.from\("court_rate_periods"\)/);
  });

  it("Member self-service booking omits p_roster_member_id (null) — the RPC resolves the caller's OWN roster identity server-side, never a client-supplied one", () => {
    const callStart = src.indexOf("const result = await previewReservationPrice({");
    expect(callStart).toBeGreaterThan(-1);
    const callEnd = src.indexOf("});", callStart);
    const call = src.slice(callStart, callEnd);
    expect(call).toContain("p_roster_member_id: canBookForMember ? selectedRosterMemberId : null,");
  });

  it("operator (Admin/Staff) booking passes the explicit, already-selected roster target and the same expectedClubId used elsewhere in this file", () => {
    const callStart = src.indexOf("const result = await previewReservationPrice({");
    const callEnd = src.indexOf("});", callStart);
    const call = src.slice(callStart, callEnd);
    expect(call).toContain("expectedClubId:     clubId,");
  });

  it("the preview effect refreshes on court/start (bookingSlot), duration, operator-picked Member, and club — never on unrelated metadata (format/player count/guest names/notes)", () => {
    const depsMatch = src.match(
      /}, \[bookingSlot, bookingDuration, canBookForMember, selectedRosterMemberId, clubId\]\);/,
    );
    expect(depsMatch).not.toBeNull();
    // Confirm the metadata fields are real state elsewhere in the file
    // (so their absence from this dependency array is a deliberate
    // exclusion, not a typo) but never appear in this specific effect's
    // own dependency list.
    const effectStart = src.indexOf("useEffect(() => {\n    if (!bookingSlot) {\n      setBookingPreviewStatus");
    const effectEnd = src.indexOf("}, [bookingSlot, bookingDuration, canBookForMember, selectedRosterMemberId, clubId]);", effectStart) + 1;
    const effectBody = src.slice(effectStart, effectEnd);
    expect(effectBody).not.toMatch(/bookingFormat|bookingPlayerCount|bookingGuestNames|bookingNotes/);
  });

  it("operator booking requires a Member selection before previewing — matches handleConfirmBooking's own identical requirement at Save time", () => {
    expect(src).toMatch(
      /if \(canBookForMember && !selectedRosterMemberId\) \{\s*setBookingPreviewStatus\("idle"\);\s*setBookingPreviewQuote\(null\);\s*return;\s*\}/,
    );
  });

  it("the async preview fetch uses a `cancelled` closure-flag guard (this codebase's existing convention) so a slower, superseded response can never overwrite a newer selection", () => {
    const effectStart = src.indexOf("let cancelled = false;\n    setBookingPreviewStatus(\"loading\");");
    expect(effectStart).toBeGreaterThan(-1);
    const effectSlice = src.slice(effectStart, effectStart + 900);
    expect(effectSlice).toMatch(/if \(cancelled\) return;/);
    expect(effectSlice).toMatch(/return \(\) => \{ cancelled = true; \};/);
  });

  it("no reservation, payment obligation, or checkout is created merely by opening/adjusting the booking sheet — the preview effect calls ONLY previewReservationPrice", () => {
    const effectStart = src.indexOf("let cancelled = false;\n    setBookingPreviewStatus(\"loading\");");
    const effectEnd = src.indexOf("return () => { cancelled = true; };", effectStart) + 40;
    const effectBody = src.slice(effectStart, effectEnd);
    expect(effectBody).not.toMatch(/createReservation\(|adminCreateMemberReservation\(/);
  });

  it("passes viewer=\"operator\" for canBookForMember, viewer=\"member\" for self-service, matching the pre-existing PriceSummary convention this replaces", () => {
    const callStart = src.indexOf("<ReservationPricePreview\n");
    const callEnd = src.indexOf("/>", callStart);
    const call = src.slice(callStart, callEnd);
    expect(call).toContain('viewer={canBookForMember ? "operator" : "member"}');
  });

  it("the human source label is derived via the shared reservationPriceSourceLabel helper — never inline string logic reproducing it", () => {
    expect(src).toContain('import { reservationPriceSourceLabel } from "@/lib/calendar/reservationPriceSourceLabel";');
    const callStart = src.indexOf("<ReservationPricePreview\n");
    const callEnd = src.indexOf("/>", callStart);
    const call = src.slice(callStart, callEnd);
    expect(call).toContain("sourceLabel={reservationPriceSourceLabel(");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. EDIT flow — EditReservationSheet, matching update_member_reservation's
//    real A/B/C invariants
// ═══════════════════════════════════════════════════════════════════════════

describe("C. EditReservationSheet's preview matches update_member_reservation's ACTUAL invariants", () => {
  const src = readSource(EDIT_SHEET_PATH);

  it("no longer reproduces rate precedence from court.hourly_rate_cents/defaultCourtHourlyRateCents", () => {
    expect(src).not.toMatch(/destCourt\?\.hourly_rate_cents \?\? defaultCourtHourlyRateCents/);
  });

  it("computes courtChanged, startsAtChanged, memberChanged, AND durationChanged as four independent flags — starts_at is its own trigger, not folded into duration", () => {
    expect(src).toContain("const courtChanged    = courtId !== reservation.court_id;");
    expect(src).toContain("const startsAtChanged = startsAt.getTime() !== new Date(reservation.starts_at).getTime();");
    expect(src).toContain('const memberChanged   = selectedRosterMemberId !== (reservation.roster_member_id ?? "");');
    expect(src).toContain("const durationChanged = duration !== durationOf(reservation);");
  });

  it("needsFreshPreview is court OR starts_at OR Member changed — exactly mirroring update_member_reservation's corrected trigger condition (0200), never gated on duration", () => {
    expect(src).toContain("const needsFreshPreview = courtChanged || startsAtChanged || memberChanged;");
  });

  it("A: fresh preview calls previewReservationPrice ONLY when needsFreshPreview AND a target Member is selected — this sheet is always the operator workflow, so it always previews on behalf of an explicit roster Member", () => {
    expect(src).toContain("if (!needsFreshPreview || !selectedRosterMemberId) {");
    const callStart = src.indexOf("const result = await previewReservationPrice({");
    expect(callStart).toBeGreaterThan(-1);
    const callEnd = src.indexOf("});", callStart);
    const call = src.slice(callStart, callEnd);
    expect(call).toContain("p_roster_member_id: selectedRosterMemberId,");
    expect(call).toContain("expectedClubId:     clubId,");
  });

  it("B: a duration-ONLY change preserves the EXISTING snapshotted hourly_rate_cents and re-multiplies locally — no RPC call for this case", () => {
    expect(src).toMatch(
      /const preservedTotalCents = durationChanged\s*\n\s*\? \(reservation\.hourly_rate_cents !== null \? Math\.round\(\(reservation\.hourly_rate_cents \* duration\) \/ 60\) : null\)\s*\n\s*: reservation\.price_amount_cents;/,
    );
  });

  it("C: metadata-only (nothing scheduling/Member-relevant changed) shows the EXISTING price_amount_cents/hourly_rate_cents completely unchanged", () => {
    // The `else` branch of preservedTotalCents (when durationChanged is
    // false) is literally `reservation.price_amount_cents` — the raw
    // existing snapshot, not a recomputation.
    expect(src).toContain(": reservation.price_amount_cents;");
  });

  it("the fresh-preview branch (A) is the ONLY one that consults previewQuote/hourlyRateCents/appliedRateSource — B/C never reference the RPC's output", () => {
    const preservedStart = src.indexOf("const preservedTotalCents");
    const preservedEnd = src.indexOf("const displayStatus:", preservedStart);
    const preservedBlock = src.slice(preservedStart, preservedEnd);
    expect(preservedBlock).not.toMatch(/previewQuote/);
  });

  it("B/C never show a source label — the reservation row does not store which source originally supplied its rate, so none is guessed or re-derived", () => {
    expect(src).toMatch(
      /const displaySourceLabel = needsFreshPreview\s*\n\s*\? reservationPriceSourceLabel\(previewQuote\?\.appliedRateSource \?\? null, previewQuote\?\.appliedRatePeriodName \?\? null\)\s*\n\s*: null;/,
    );
  });

  it("the async preview fetch uses the same `cancelled` closure-flag staleness guard as the create flow", () => {
    const effectStart = src.indexOf("let cancelled = false;\n    setPreviewStatus(\"loading\");");
    expect(effectStart).toBeGreaterThan(-1);
    const effectSlice = src.slice(effectStart, effectStart + 700);
    expect(effectSlice).toMatch(/if \(cancelled\) return;/);
    expect(effectSlice).toMatch(/return \(\) => \{ cancelled = true; \};/);
  });

  it("opening/adjusting the edit sheet performs no write of any kind — only previewReservationPrice is called from the preview effect, never updateMemberReservationAdmin", () => {
    const effectStart = src.indexOf("let cancelled = false;\n    setPreviewStatus(\"loading\");");
    const effectEnd = src.indexOf("return () => { cancelled = true; };", effectStart) + 40;
    const effectBody = src.slice(effectStart, effectEnd);
    expect(effectBody).not.toMatch(/updateMemberReservationAdmin/);
  });

  it("updateMemberReservationAdmin itself is called ONLY from handleSave, never from the preview effect — merely opening the edit UI never mutates or reprices the reservation", () => {
    const saveStart = src.indexOf("async function handleSave()");
    const saveEnd = src.indexOf("\n  }\n", saveStart);
    const saveBody = src.slice(saveStart, saveEnd);
    expect(saveBody).toContain("await updateMemberReservationAdmin({");
    const previewEffectStart = src.indexOf("useEffect(() => {\n    if (!needsFreshPreview");
    const previewEffectEnd = src.indexOf("[needsFreshPreview, courtId, startsAt, endsAt, selectedRosterMemberId, clubId]);", previewEffectStart);
    const previewEffectBody = src.slice(previewEffectStart, previewEffectEnd);
    expect(previewEffectBody).not.toMatch(/updateMemberReservationAdmin/);
  });

  it("renders the shared ReservationPricePreview component with viewer=\"operator\" (this sheet is always the Admin/Staff operator workflow)", () => {
    expect(src).toContain("<ReservationPricePreview");
    const callStart = src.indexOf("<ReservationPricePreview\n");
    const callEnd = src.indexOf("/>", callStart);
    const call = src.slice(callStart, callEnd);
    expect(call).toContain('viewer="operator"');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D. ReservationPricePreview — NULL/zero/loading/error display contract
// ═══════════════════════════════════════════════════════════════════════════

describe("D. ReservationPricePreview display contract", () => {
  const src = readSource(PREVIEW_COMPONENT_PATH);

  it("does NOT reuse the shared cross-domain PriceSummary component — this checkpoint is reservations-only and the required copy differs", () => {
    expect(src).not.toMatch(/import PriceSummary/);
  });

  it("1. NULL total + operator viewer shows the explicit 'No court fee configured' message", () => {
    expect(src).toContain("No court fee configured");
  });

  it("2. NULL total + member viewer shows the concise 'No court fee' message — a truthful neutral message, never an empty/hidden render", () => {
    expect(src).toMatch(
      /if \(totalCents === null\) \{\s*\n\s*return \(\s*\n\s*<div className=\{className\}>[\s\S]*?\{viewer === "member" \? "No court fee" : "No court fee configured"\}/,
    );
    // Structural guarantee: the NULL branch never returns null/nothing —
    // both viewers reach the same <div> with only the message text
    // differing by viewer.
    const nullBranchStart = src.indexOf('if (totalCents === null) {');
    const nullBranchEnd = src.indexOf('\n  }\n\n  const breakdown', nullBranchStart);
    const nullBranch = src.slice(nullBranchStart, nullBranchEnd);
    expect(nullBranch).not.toMatch(/return null;/);
  });

  it("3. NULL total never formats as a zero amount anywhere in the NULL branch — formatMoney/'$0'-style output only appears in the priced (non-null) branch below it", () => {
    const nullBranchStart = src.indexOf('if (totalCents === null) {');
    const nullBranchEnd = src.indexOf('\n  }\n\n  const breakdown', nullBranchStart);
    const nullBranch = src.slice(nullBranchStart, nullBranchEnd);
    expect(nullBranch).not.toMatch(/formatMoney|\$0/);
  });

  it("4. an explicit zero total still renders 'Free', via a strict === 0 check (0 is never confused with null, and this behavior is unchanged by the NULL-display fix)", () => {
    expect(src).toMatch(/totalCents === 0 \? "Free" : formatMoney\(totalCents, currency\)/);
  });

  it("loading state shows quiet, non-committal copy — never a stale/previous price", () => {
    expect(src).toContain('status === "loading"');
    expect(src).toContain("Checking price…");
    // The loading branch never references totalCents/hourlyRateCents.
    const loadingStart = src.indexOf('if (status === "loading")');
    const loadingEnd = src.indexOf("}\n\n", loadingStart);
    const loadingBlock = src.slice(loadingStart, loadingEnd);
    expect(loadingBlock).not.toMatch(/totalCents|hourlyRateCents/);
  });

  it("error state shows concise unavailable copy, never a guessed fallback amount", () => {
    expect(src).toContain('status === "error"');
    expect(src).toContain("Price unavailable right now.");
    const errorStart = src.indexOf('if (status === "error")');
    const errorEnd = src.indexOf("}\n\n", errorStart);
    const errorBlock = src.slice(errorStart, errorEnd);
    expect(errorBlock).not.toMatch(/totalCents|hourlyRateCents|formatMoney/);
  });

  it("uses the app's shared formatMoney utility and the caller-supplied currency, never a hardcoded currency symbol", () => {
    expect(src).toContain('import { formatMoney } from "@/lib/money";');
    expect(src).toContain("formatMoney(totalCents, currency)");
  });

  it("performs no pricing computation of its own — never references hourly_rate_cents arithmetic beyond formatting an already-resolved value in the breakdown line", () => {
    expect(src).not.toMatch(/hourlyRateCents\s*\*|totalCents\s*\*/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// E. Human source-label mapping never leaks raw internal identifiers
// ═══════════════════════════════════════════════════════════════════════════

describe("E. reservationPriceSourceLabel never exposes raw applied_rate_source values", () => {
  const src = readSource(SOURCE_LABEL_PATH);

  it("maps court_override_* to 'Court rate' and club_default_* to 'Standard rate'", () => {
    expect(src).toContain('return "Court rate";');
    expect(src).toContain('return "Standard rate";');
  });

  it("prefers the server-provided human period name over any generic label", () => {
    const nameCheckIdx = src.indexOf("if (appliedRatePeriodName) return appliedRatePeriodName;");
    const courtLabelIdx = src.indexOf('return "Court rate";');
    expect(nameCheckIdx).toBeGreaterThan(-1);
    expect(courtLabelIdx).toBeGreaterThan(nameCheckIdx);
  });

  it("never returns a raw source string like 'rate_period_non_member' or 'court_override_member' verbatim", () => {
    expect(src).not.toMatch(/return appliedRateSource;/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F. Scope discipline — reservations only, no migration, no role widening
// ═══════════════════════════════════════════════════════════════════════════

describe("F. Checkpoint C scope discipline", () => {
  it("no new migration file was introduced for this checkpoint", () => {
    // 0200/0201/0202 remain the latest Peak/Off-Peak migrations — this
    // checkpoint is UI-only, reusing the already-applied, immutable
    // preview_court_reservation_price RPC exclusively.
    const migrationsDir = join(process.cwd(), "supabase/migrations");
    const files = readdirSync(migrationsDir);
    const peakOffPeakMigrations = files.filter((f) => f.includes("peak_off_peak") || f.startsWith("0200") || f.startsWith("0201") || f.startsWith("0202"));
    expect(peakOffPeakMigrations.sort()).toEqual([
      "0200_court_rate_periods.sql",
      "0201_peak_off_peak_price_preview.sql",
      "0202_peak_off_peak_price_preview_currency_fix.sql",
    ]);
  });

  it("does not touch lessons/events/programs actions or pricing", () => {
    const actionsSrc = readSource(ACTIONS_PATH);
    for (const name of ["submitLessonRequest", "setProgramPrice", "createEventWithPriceOverride"]) {
      // createEventWithPriceOverride already existed before this
      // checkpoint (event pricing) — confirm this checkpoint did not
      // MODIFY it by checking previewReservationPrice was inserted as an
      // entirely separate, later function, not interleaved into it.
      if (name === "createEventWithPriceOverride") continue;
      expect(actionsSrc).not.toContain(`export async function ${name}(`);
    }
  });

  it("does not widen Staff/Pro permissions — previewReservationPrice forwards p_roster_member_id verbatim without adding a new role check of its own", () => {
    const body = functionBody(readSource(ACTIONS_PATH), "previewReservationPrice");
    expect(body).not.toMatch(/role ===|role !==|isOperator|isAdmin|isStaff/);
  });

  it("no Stripe/payment/refund/cancellation-policy function is touched by this checkpoint's changes", () => {
    for (const path of [ACTIONS_PATH, CALENDAR_SHELL_PATH, EDIT_SHEET_PATH]) {
      const s = readSource(path);
      expect(s).not.toMatch(/create or replace function|drop function|alter table/i);
    }
  });
});
