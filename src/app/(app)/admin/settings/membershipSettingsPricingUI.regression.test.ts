import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 42C-2 — Membership Settings + Member/Non-Member Court Pricing UI.
// Builds ONLY on top of the already-applied, immutable 0188/0189/0190: a
// Memberships on/off toggle wired to update_club_memberships_enabled
// (0190), and a widened Pricing form / per-court Rate UI wired to 0189's
// current 3-argument update_club_pricing / set_court_hourly_rate. No new
// migration, no membership-type or Member Detail UI (both explicitly
// deferred).
//
// Source-inspection style, matching this project's established convention
// for Server/Client Component files (see settingsInformationArchitecture.
// regression.test.ts and courtsInformationArchitecture.regression.test.ts —
// this vitest baseline has no jsdom/React rendering).

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

const SETTINGS_PAGE_PATH             = "src/app/(app)/admin/settings/page.tsx";
const SETTINGS_ACTIONS_PATH          = "src/app/(app)/admin/settings/actions.ts";
const MEMBERSHIPS_SECTION_PATH       = "src/app/(app)/admin/members/MembershipsSection.tsx";
const MEMBERS_TYPES_PAGE_PATH        = "src/app/(app)/admin/members/types/page.tsx";
// Peak/Off-Peak Pricing IA refinement: PricingSettingsForm.tsx was split
// and relocated — currency stays in Settings (ClubCurrencyForm), default
// court rates moved to Admin -> Courts -> Court Rates
// (DefaultCourtRatesForm). See section 2/5/5b/12 below and
// admin/courts/courtRatePeriodsAdminUI.regression.test.ts for the
// relocated Court Rate Periods coverage.
const CLUB_CURRENCY_FORM_PATH        = "src/app/(app)/admin/settings/ClubCurrencyForm.tsx";
const DEFAULT_COURT_RATES_FORM_PATH  = "src/app/(app)/admin/courts/DefaultCourtRatesForm.tsx";
const COURTS_PAGE_PATH               = "src/app/(app)/admin/courts/page.tsx";
const COURTS_ACTIONS_PATH            = "src/app/(app)/admin/courts/actions.ts";
const COURT_MANAGEMENT_LIST_PATH     = "src/app/(app)/admin/courts/CourtManagementList.tsx";

// ═══════════════════════════════════════════════════════════════════════════
// 1. Memberships toggle UI wired to update_club_memberships_enabled
// ═══════════════════════════════════════════════════════════════════════════
describe("1. Memberships toggle is wired to update_club_memberships_enabled", () => {
  it("MembershipsSection calls the updateClubMembershipsEnabled Server Action on toggle", () => {
    const s = readSource(MEMBERSHIPS_SECTION_PATH);
    expect(s.trimStart().startsWith('"use client"')).toBe(true);
    expect(s).toContain('import { updateClubMembershipsEnabled } from "@/app/(app)/admin/settings/actions";');
    expect(s).toContain("const result = await updateClubMembershipsEnabled(next);");
  });

  it("the Server Action calls the real update_club_memberships_enabled RPC with p_enabled", () => {
    const s = readSource(SETTINGS_ACTIONS_PATH);
    expect(s).toContain("export async function updateClubMembershipsEnabled(");
    expect(s).toContain('supabase.rpc("update_club_memberships_enabled", {');
    expect(s).toContain("p_enabled: enabled,");
  });

  it("a successful mutation revalidates and the component never optimistically flips on error", () => {
    const actions = readSource(SETTINGS_ACTIONS_PATH);
    const start = actions.indexOf("export async function updateClubMembershipsEnabled(");
    const body = actions.slice(start, start + 700);
    expect(body).toContain('revalidatePath("/", "layout");');

    const section = readSource(MEMBERSHIPS_SECTION_PATH);
    expect(section).toContain("// Never optimistically flips");
    expect(section).toContain("setMembershipsEnabled(next);");
  });

  it("does not use a destructive confirmation modal (locked UX: turning Memberships off is non-destructive)", () => {
    const s = readSource(MEMBERSHIPS_SECTION_PATH);
    expect(s).not.toMatch(/ConfirmModal|window\.confirm/);
  });

  it("resyncs local state from the server-confirmed `enabled` prop, matching PaymentTrackingSection's precedent", () => {
    const s = readSource(MEMBERSHIPS_SECTION_PATH);
    expect(s).toContain("const [membershipsEnabled, setMembershipsEnabled] = useState(enabled);");
    expect(s).toContain("useEffect(() => {\n    setMembershipsEnabled(enabled);\n  }, [enabled]);");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Settings page reads/passes memberships_enabled
// ═══════════════════════════════════════════════════════════════════════════
describe("2. /admin/settings no longer needs memberships_enabled or default court rates (Peak/Off-Peak Pricing IA refinement)", () => {
  it("the club_settings query no longer selects memberships_enabled or either default court rate column — nothing remaining on this page reads them", () => {
    // Checks the actual .select(...) call, not the whole file text — this
    // file's own explanatory comment above legitimately NAMES these
    // columns in prose (documenting that they moved), which a blanket
    // "not.toContain" over the full source would misflag.
    const s = readSource(SETTINGS_PAGE_PATH);
    const selectMatch = s.match(/\.from\("club_settings"\)\s*\n\s*\.select\("([^"]+)"\)/);
    expect(selectMatch).not.toBeNull();
    const selectedColumns = selectMatch![1];
    expect(selectedColumns).not.toContain("default_court_hourly_rate_non_member_cents");
    expect(selectedColumns).not.toContain("default_court_hourly_rate_cents");
    expect(selectedColumns).not.toContain("memberships_enabled");
    expect(selectedColumns).toBe("currency, payment_mode, rules_and_policies");
  });

  it("MembershipsSection is rendered with the resolved enabled value on its home, /admin/members/types (Phase 43B-3E relocated it out of /admin/settings)", () => {
    const s = readSource(MEMBERS_TYPES_PAGE_PATH);
    expect(s).toContain('import MembershipsSection from "../MembershipsSection";');
    expect(s).toContain("const membershipsEnabled = settingsResult.data?.memberships_enabled ?? true;");
    expect(s).toContain("<MembershipsSection enabled={membershipsEnabled} />");
  });

  it("/admin/settings no longer imports or renders MembershipsSection", () => {
    const s = readSource(SETTINGS_PAGE_PATH);
    expect(s).not.toMatch(/import MembershipsSection/);
    expect(s).not.toMatch(/<MembershipsSection/);
  });

  it("does not add a duplicate club_settings/courts fetch — reuses the existing Promise.all query", () => {
    const s = readSource(SETTINGS_PAGE_PATH);
    const matches = s.match(/\.from\("club_settings"\)/g) ?? [];
    expect(matches.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3-4. Non-Member club rate: visibility + preservation
// ═══════════════════════════════════════════════════════════════════════════
describe("3. Non-Member club rate field appears only when Memberships are ON", () => {
  it("DefaultCourtRatesForm gates the Non-Member input behind membershipsEnabled", () => {
    const s = readSource(DEFAULT_COURT_RATES_FORM_PATH);
    const idx = s.indexOf("{membershipsEnabled && (");
    expect(idx).toBeGreaterThan(-1);
    const block = s.slice(idx, idx + 700);
    expect(block).toContain("Non-Member court hourly rate (optional)");
    expect(block).toContain('name="default_court_hourly_rate_non_member_cents"');
  });

  it("the Standard/Member rate field label distinguishes itself from the base label when Memberships are ON", () => {
    const s = readSource(DEFAULT_COURT_RATES_FORM_PATH);
    expect(s).toContain('"Standard / Member court hourly rate (optional)"');
    expect(s).toContain('"Court reservation pricing (optional)"');
  });
});

describe("4. hiding the Non-Member club rate does not clear its stored value", () => {
  it("the Non-Member rate is read from component state on submit, never from FormData", () => {
    const s = readSource(DEFAULT_COURT_RATES_FORM_PATH);
    expect(s).toContain("const [nonMemberRateDollars, setNonMemberRateDollars] = useState(");
    expect(s).toContain("defaultCourtHourlyRateNonMemberCents !== null ? (defaultCourtHourlyRateNonMemberCents / 100).toFixed(2) : \"\"");
    // The submit handler must derive nonMemberRateCents from the state
    // variable, not from `formData.get(...)` — this is what keeps the
    // value alive while its own input isn't mounted (Memberships off).
    const submitStart = s.indexOf("function handleSubmit(");
    const submitBody = s.slice(submitStart, s.indexOf("startTransition(async () => {", submitStart));
    expect(submitBody).toContain("nonMemberRateDollars.trim()");
    expect(submitBody).not.toContain('formData.get("default_court_hourly_rate_non_member_cents")');
  });

  it("state is seeded once from the server prop, so a stored value the club already has survives even while the field is hidden on mount", () => {
    const s = readSource(DEFAULT_COURT_RATES_FORM_PATH);
    expect(s).toContain("defaultCourtHourlyRateNonMemberCents: number | null;");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Peak/Off-Peak Pricing IA refinement: the former single updateClubPricing
//    action is now the private persistClubPricing helper, called by exactly
//    two thin exported wrappers (updateClubCurrency, updateDefaultCourtRates)
//    that each re-read, fresh from the server, the ONE field they don't
//    themselves own. This preserves every pre-existing correction pass
//    below byte-for-byte — only the export surface changed.
// ═══════════════════════════════════════════════════════════════════════════
describe("5. persistClubPricing (shared helper) sends all three update_club_pricing RPC args", () => {
  function persistClubPricingBody(): string {
    const s = readSource(SETTINGS_ACTIONS_PATH);
    const start = s.indexOf("async function persistClubPricing(");
    expect(start).toBeGreaterThan(-1);
    const nextFnIdx = s.indexOf("\nexport async function", start + 1);
    return s.slice(start, nextFnIdx > -1 ? nextFnIdx : undefined);
  }

  it("the RPC call includes currency, member rate, and the resolved non-member rate", () => {
    const body = persistClubPricingBody();
    expect(body).toContain('supabase.rpc("update_club_pricing", {');
    expect(body).toContain("p_currency: currency,");
    expect(body).toContain("p_default_court_hourly_rate_cents: defaultCourtHourlyRateCents,");
    expect(body).toContain("p_default_court_hourly_rate_non_member_cents: nonMemberRateCents,");
  });

  it("Correction (Section 2, preserved): persistClubPricing's third parameter is REQUIRED — no default value", () => {
    const s = readSource(SETTINGS_ACTIONS_PATH);
    expect(s).toContain("defaultCourtHourlyRateNonMemberCents: number | null,\n): Promise<{ error?: string; nonMemberRatePreserved?: boolean; effectiveNonMemberRateCents?: number | null }> {");
    expect(s).not.toContain("defaultCourtHourlyRateNonMemberCents: number | null = null");
  });

  it("updateClubCurrency and updateDefaultCourtRates are persistClubPricing's ONLY two callers, and both pass all 3 arguments explicitly", () => {
    const s = readSource(SETTINGS_ACTIONS_PATH);
    // One definition site (`async function persistClubPricing(` itself
    // also matches this substring) plus exactly two call sites.
    const matches = [...s.matchAll(/persistClubPricing\(/g)];
    expect(matches.length).toBe(3);
    expect(s).toContain(
      "const result = await persistClubPricing(\n    currency,\n    currentSettings.default_court_hourly_rate_cents,\n    currentSettings.default_court_hourly_rate_non_member_cents,\n  );",
    );
    expect(s).toContain(
      "return persistClubPricing(\n    currentSettings.currency,\n    defaultCourtHourlyRateCents,\n    defaultCourtHourlyRateNonMemberCents,\n  );",
    );
  });

  it("Correction (Section 1A / 4.1, preserved): while memberships_enabled is currently false, the client-supplied non-member rate is IGNORED and the CURRENT stored value is used instead", () => {
    const body = persistClubPricingBody();
    expect(body).toContain('.select("memberships_enabled, default_court_hourly_rate_non_member_cents")');
    expect(body).toContain("const nonMemberRatePreserved = currentSettings.memberships_enabled === false;");
    expect(body).toMatch(/const nonMemberRateCents = nonMemberRatePreserved\s*\?\s*currentSettings\.default_court_hourly_rate_non_member_cents\s*:\s*defaultCourtHourlyRateNonMemberCents;/);
  });

  it("Correction (Section 1A / 4.2, preserved): while memberships_enabled is currently true, the explicit client value (including null) is used as-is", () => {
    const body = persistClubPricingBody();
    // nonMemberRateCents is derived exactly once, by a single ternary keyed
    // on memberships_enabled === false — no other assignment exists that
    // could touch it, so the true/unresolved branch always receives
    // exactly what the caller passed in, untouched, null included.
    const assignments = [...body.matchAll(/nonMemberRateCents (=|:) /g)];
    expect(assignments.length).toBe(1);
  });

  it("Second correction pass (fail-closed, preserved): the settings read is REQUIRED to succeed — a query error or a missing row returns an error and never reaches the RPC", () => {
    const body = persistClubPricingBody();
    expect(body).toContain("const { data: currentSettings, error: settingsError } = await supabase");
    expect(body).toMatch(/if \(settingsError \|\| !currentSettings\) \{\s*return \{ error: ERROR_MESSAGES\.settings_unavailable \};\s*\}/);
    // The settings_unavailable return must appear strictly BEFORE the RPC
    // call — proving the RPC is genuinely unreachable on that path, not
    // merely that an error object exists somewhere in the function.
    const guardIdx = body.indexOf("ERROR_MESSAGES.settings_unavailable");
    const rpcIdx = body.indexOf('supabase.rpc("update_club_pricing"');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(rpcIdx).toBeGreaterThan(guardIdx);
  });

  it("Second correction pass (fail-closed, preserved): an unresolved active club (no clubId) also returns an error before any settings read or RPC call", () => {
    const body = persistClubPricingBody();
    expect(body).toMatch(/if \(!clubId\) return \{ error: ERROR_MESSAGES\.insufficient_role \};/);
    const clubGuardIdx = body.indexOf("if (!clubId)");
    const settingsReadIdx = body.indexOf('.from("club_settings")');
    expect(clubGuardIdx).toBeGreaterThan(-1);
    expect(settingsReadIdx).toBeGreaterThan(clubGuardIdx);
  });

  it("settings_unavailable is a real, project-convention error message — not an invented error subsystem", () => {
    const s = readSource(SETTINGS_ACTIONS_PATH);
    expect(s).toMatch(/settings_unavailable:\s*"[^"]+",/);
  });

  it("resolving the club for this preflight read reuses the existing canonical getAuthProfile() helper — no new/duplicated authorization check", () => {
    const body = persistClubPricingBody();
    expect(body).toContain("const profile = await getAuthProfile();");
    expect(body).not.toMatch(/if \(profile\?\.\s*role/); // no new role gate added here — the RPC's own admin check is unduplicated
  });
});

describe("5b. updateClubCurrency never touches rates; updateDefaultCourtRates never touches currency", () => {
  function actionBody(name: string): string {
    const s = readSource(SETTINGS_ACTIONS_PATH);
    const start = s.indexOf(`export async function ${name}(`);
    expect(start, `${name} not found`).toBeGreaterThan(-1);
    const nextExportIdx = s.indexOf("\nexport async function", start + 1);
    return s.slice(start, nextExportIdx > -1 ? nextExportIdx : undefined);
  }

  it("updateClubCurrency takes only a currency parameter — no rate parameter exists for it to accept", () => {
    const s = readSource(SETTINGS_ACTIONS_PATH);
    expect(s).toMatch(/export async function updateClubCurrency\(\s*currency: string,\s*\): Promise<\{ error\?: string \}> \{/);
  });

  it("updateClubCurrency re-reads the CURRENT default rates fresh from club_settings before calling persistClubPricing, fail-closed on a failed read", () => {
    const body = actionBody("updateClubCurrency");
    expect(body).toContain('.select("default_court_hourly_rate_cents, default_court_hourly_rate_non_member_cents")');
    expect(body).toMatch(/if \(settingsError \|\| !currentSettings\) \{\s*return \{ error: ERROR_MESSAGES\.settings_unavailable \};\s*\}/);
    const guardIdx = body.indexOf("ERROR_MESSAGES.settings_unavailable");
    const callIdx = body.indexOf("persistClubPricing(");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeGreaterThan(guardIdx);
  });

  it("updateDefaultCourtRates takes only rate parameters — no currency parameter exists for it to accept", () => {
    const s = readSource(SETTINGS_ACTIONS_PATH);
    expect(s).toMatch(
      /export async function updateDefaultCourtRates\(\s*defaultCourtHourlyRateCents: number \| null,\s*defaultCourtHourlyRateNonMemberCents: number \| null,\s*\)/,
    );
  });

  it("updateDefaultCourtRates re-reads the CURRENT authoritative currency fresh from club_settings before calling persistClubPricing, fail-closed on a failed read", () => {
    const body = actionBody("updateDefaultCourtRates");
    expect(body).toContain('.select("currency")');
    expect(body).toMatch(/if \(settingsError \|\| !currentSettings\) \{\s*return \{ error: ERROR_MESSAGES\.settings_unavailable \};\s*\}/);
    const guardIdx = body.indexOf("ERROR_MESSAGES.settings_unavailable");
    const callIdx = body.indexOf("persistClubPricing(");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeGreaterThan(guardIdx);
  });

  it("neither action lets the caller pass a value for the field it doesn't own", () => {
    const currencyBody = actionBody("updateClubCurrency");
    const ratesBody = actionBody("updateDefaultCourtRates");
    expect(currencyBody).not.toMatch(/defaultCourtHourlyRateCents:\s*number/);
    expect(ratesBody).not.toMatch(/currency:\s*string/);
  });

  it("ClubCurrencyForm calls updateClubCurrency with only the currency value; DefaultCourtRatesForm calls updateDefaultCourtRates with only the two rate values", () => {
    const currencyForm = readSource(CLUB_CURRENCY_FORM_PATH);
    expect(currencyForm).toContain("await updateClubCurrency(trimmed);");
    const ratesForm = readSource(DEFAULT_COURT_RATES_FORM_PATH);
    expect(ratesForm).toContain("await updateDefaultCourtRates(rateCents, nonMemberRateCents);");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5c. currency_locked_by_pricing maps to clear operator copy; generic
//     fallback is preserved for unmapped errors; ClubCurrencyForm explains
//     and reacts to the lock without reproducing the DB's own scan
// ═══════════════════════════════════════════════════════════════════════════
describe("5c. currency_locked_by_pricing error mapping and ClubCurrencyForm UX", () => {
  it("ERROR_MESSAGES maps currency_locked_by_pricing to specific, non-generic operator-facing copy", () => {
    const s = readSource(SETTINGS_ACTIONS_PATH);
    expect(s).toContain(
      'currency_locked_by_pricing:  "Currency can’t be changed after paid pricing has been configured or recorded.",',
    );
  });

  it("persistClubPricing's error regex includes currency_locked_by_pricing alongside every pre-existing mapped code", () => {
    const s = readSource(SETTINGS_ACTIONS_PATH);
    expect(s).toMatch(
      /error\.message\.match\(\/currency_required\|invalid_currency\|currency_locked_by_pricing\|invalid_rate\|not_authenticated\|insufficient_role\//,
    );
  });

  it("an unmapped/unknown error code still falls back to the pre-existing generic message, unchanged", () => {
    const body = (() => {
      const s = readSource(SETTINGS_ACTIONS_PATH);
      const start = s.indexOf("async function persistClubPricing(");
      const nextFnIdx = s.indexOf("\nexport async function", start + 1);
      return s.slice(start, nextFnIdx > -1 ? nextFnIdx : undefined);
    })();
    expect(body).toContain('ERROR_MESSAGES[key] ?? "Failed to save pricing settings."');
  });

  it("ClubCurrencyForm explains the currency lock in helper copy beneath the input", () => {
    const s = readSource(CLUB_CURRENCY_FORM_PATH);
    expect(s).toContain(
      "Currency is locked once paid pricing has been configured or recorded, so existing amounts",
    );
  });

  it("ClubCurrencyForm does NOT disable the field or reproduce the DB's positive-pricing scan — no client-side eligibility check gates the input or submit button", () => {
    const s = readSource(CLUB_CURRENCY_FORM_PATH);
    expect(s).not.toMatch(/disabled=\{.*locked/i);
    expect(s).not.toMatch(/positive_pricing|hourly_rate_cents\s*>\s*0|price_amount_cents\s*>\s*0/);
    // The only `disabled` on the input/button is the existing isPending
    // submit-in-flight guard, not a new eligibility computation.
    const submitButtonIdx = s.indexOf('<button type="submit"');
    expect(s.slice(submitButtonIdx, submitButtonIdx + 60)).toContain("disabled={isPending}");
  });

  it("on the currency_locked_by_pricing failure specifically, the visible field resets to the persisted currency prop — never a widened Server Action return contract", () => {
    const s = readSource(CLUB_CURRENCY_FORM_PATH);
    expect(s).toMatch(
      /if \(result\.error === CURRENCY_LOCKED_MESSAGE\) \{\s*setCurrencyValue\(currency\);\s*\}/,
    );
    // updateClubCurrency's return type is untouched — still just an
    // optional error string, no new error-code field.
    const actionsSource = readSource(SETTINGS_ACTIONS_PATH);
    expect(actionsSource).toMatch(
      /export async function updateClubCurrency\(\s*currency: string,\s*\): Promise<\{ error\?: string \}> \{/,
    );
  });

  it("other (non-lock) errors leave the typed value in place, so the Admin can see and correct their own mistake", () => {
    const s = readSource(CLUB_CURRENCY_FORM_PATH);
    const handlerStart = s.indexOf("function handleSubmit(");
    const handlerEnd = s.indexOf("\n  }\n", handlerStart);
    const handlerBody = s.slice(handlerStart, handlerEnd);
    // setCurrencyValue is called only inside the lock-specific branch, not
    // unconditionally on every error.
    const setCalls = [...handlerBody.matchAll(/setCurrencyValue\(/g)];
    expect(setCalls.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Courts page reads/passes memberships_enabled
// ═══════════════════════════════════════════════════════════════════════════
describe("6. /admin/courts reads and passes memberships_enabled", () => {
  it("the club_settings query selects memberships_enabled and the non-member default rate", () => {
    const s = readSource(COURTS_PAGE_PATH);
    expect(s).toContain("default_court_hourly_rate_non_member_cents");
    expect(s).toContain("memberships_enabled");
  });

  it("the courts query selects hourly_rate_non_member_cents", () => {
    const s = readSource(COURTS_PAGE_PATH);
    expect(s).toContain('"id, name, display_order, is_active, hourly_rate_cents, hourly_rate_non_member_cents"');
  });

  it("CourtManagementList is rendered with membershipsEnabled and defaultHourlyRateNonMemberCents", () => {
    const s = readSource(COURTS_PAGE_PATH);
    expect(s).toContain("membershipsEnabled={settings?.memberships_enabled ?? true}");
    expect(s).toContain("defaultHourlyRateNonMemberCents={settings?.default_court_hourly_rate_non_member_cents ?? null}");
  });

  it("does not add a duplicate club_settings/courts fetch — reuses the existing Promise.all query", () => {
    const s = readSource(COURTS_PAGE_PATH);
    const settingsMatches = s.match(/\.from\("club_settings"\)/g) ?? [];
    const courtsMatches   = s.match(/\.from\("courts"\)/g) ?? [];
    expect(settingsMatches.length).toBe(1);
    expect(courtsMatches.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7-8. Per-court Non-Member rate: visibility + preservation
// ═══════════════════════════════════════════════════════════════════════════
describe("7. per-court Non-Member rate override appears only when Memberships are ON", () => {
  it("the Rate edit row's Non-Member input is gated behind membershipsEnabled", () => {
    const s = readSource(COURT_MANAGEMENT_LIST_PATH);
    const editRowIdx = s.indexOf("editingRateId === court.id");
    const nextBranchIdx = s.indexOf(") : (", editRowIdx);
    const editRow = s.slice(editRowIdx, nextBranchIdx);
    // Two separate `{membershipsEnabled && (` gates live in this row (the
    // "Standard / Member" label, then the Non-Member field block) — find
    // the one that actually renders nonMemberRateValue.
    const gateIdx = editRow.indexOf("value={nonMemberRateValue}");
    expect(gateIdx).toBeGreaterThan(-1);
    const precedingGateIdx = editRow.lastIndexOf("{membershipsEnabled && (", gateIdx);
    expect(precedingGateIdx).toBeGreaterThan(-1);
    const gatedBlock = editRow.slice(precedingGateIdx, gateIdx + 200);
    expect(gatedBlock).toContain("Non-Member");
    expect(gatedBlock).toContain("value={nonMemberRateValue}");
  });

  it("the normal row's Non-Member RateSegment (and its separator) is gated behind membershipsEnabled", () => {
    // UX polish pass: the normal row's pricing summary moved from a flat
    // inline badge to a dedicated pricing row using the shared RateSegment
    // component — this now checks that gate structurally rather than by
    // exact class-string match, since the visual styling is expected to
    // change independent of this invariant.
    const s = readSource(COURT_MANAGEMENT_LIST_PATH);
    const pricingRowIdx = s.indexOf('className="mt-1 flex items-center gap-x-1.5 gap-y-0.5 flex-wrap text-xs"');
    expect(pricingRowIdx).toBeGreaterThan(-1);
    const nextRowIdx = s.indexOf("{/* Action buttons", pricingRowIdx);
    const pricingRow = s.slice(pricingRowIdx, nextRowIdx > -1 ? nextRowIdx : pricingRowIdx + 800);
    expect(pricingRow).toContain("{membershipsEnabled && (");
    const gateIdx = pricingRow.indexOf("{membershipsEnabled && (");
    const gatedBlock = pricingRow.slice(gateIdx);
    expect(gatedBlock).toContain('label="Non-Member"');
    expect(gatedBlock).toContain("describeNonMemberRate(court, defaultHourlyRateCents, defaultHourlyRateNonMemberCents, currency)");
  });

  it("the Member RateSegment's label is empty (unlabeled base rate) when Memberships are off", () => {
    const s = readSource(COURT_MANAGEMENT_LIST_PATH);
    expect(s).toContain('label={membershipsEnabled ? "Member" : ""}');
    expect(s).toContain("display={describeMemberRate(court, defaultHourlyRateCents, currency)}");
  });
});

describe("8. hiding the per-court Non-Member rate does not clear its stored value", () => {
  it("nonMemberRateValue is seeded from the court row on rate-edit start, independent of visibility", () => {
    const s = readSource(COURT_MANAGEMENT_LIST_PATH);
    const start = s.indexOf("function handleRateStart(court: Court) {");
    const body = s.slice(start, start + 500);
    expect(body).toContain("setNonMemberRateValue(");
    expect(body).toContain("court.hourly_rate_non_member_cents !== null ? (court.hourly_rate_non_member_cents / 100).toFixed(2) : \"\"");
  });

  it("handleRateSubmit derives the non-member cents from state, never from a FormData read", () => {
    const s = readSource(COURT_MANAGEMENT_LIST_PATH);
    const start = s.indexOf("function handleRateSubmit(courtId: string) {");
    const body = s.slice(start, s.indexOf("startTransition(async () => {", start));
    expect(body).toContain("nonMemberRateValue.trim()");
    expect(s).not.toContain("formData.get(\"hourly_rate_non_member_cents\")");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. court pricing action sends all three RPC args correctly, with
//    server-side preservation (Section 1B) when Memberships are off
// ═══════════════════════════════════════════════════════════════════════════
describe("9. setCourtHourlyRate sends all three set_court_hourly_rate RPC args", () => {
  function setCourtHourlyRateBody(): string {
    const s = readSource(COURTS_ACTIONS_PATH);
    const start = s.indexOf("export async function setCourtHourlyRate(");
    expect(start).toBeGreaterThan(-1);
    const nextExportIdx = s.indexOf("\nexport async function", start + 1);
    return s.slice(start, nextExportIdx > -1 ? nextExportIdx : undefined);
  }

  it("the RPC call includes court id, member rate, and the resolved non-member rate", () => {
    const body = setCourtHourlyRateBody();
    expect(body).toContain('supabase.rpc("set_court_hourly_rate", {');
    expect(body).toContain("p_court_id: courtId,");
    expect(body).toContain("p_hourly_rate_cents: hourlyRateCents,");
    expect(body).toContain("p_hourly_rate_non_member_cents: nonMemberRateCents,");
  });

  it("hourlyRateNonMemberCents is a required positional argument (not defaulted) — every call site must pass it explicitly", () => {
    const s = readSource(COURTS_ACTIONS_PATH);
    expect(s).toContain("hourlyRateNonMemberCents: number | null,");
    expect(s).not.toContain("hourlyRateNonMemberCents: number | null = ");
  });

  it("Correction (Section 4.5): every setCourtHourlyRate call site in the app passes all 4 arguments explicitly", () => {
    // CourtManagementList is (and must remain) the only production call
    // site in the app — verified against a repo-wide grep during this
    // checkpoint. Any future new call site must be added here too.
    const s = readSource(COURT_MANAGEMENT_LIST_PATH);
    expect(s).toContain("await setCourtHourlyRate(courtId, cents, nonMemberCents, clubId);");
  });

  it("Correction (Section 1B / 4.5): while memberships_enabled is currently false, the client-supplied non-member override is IGNORED and the CURRENT stored court value is used instead", () => {
    const body = setCourtHourlyRateBody();
    expect(body).toContain('.select("hourly_rate_non_member_cents")');
    expect(body).toContain("const nonMemberRatePreserved = currentSettings.memberships_enabled === false;");
    expect(body).toMatch(/const nonMemberRateCents = nonMemberRatePreserved\s*\?\s*currentCourt\.hourly_rate_non_member_cents\s*:\s*hourlyRateNonMemberCents;/);
  });

  it("Correction (Section 1B / 4.6): while memberships_enabled is currently true, the explicit client value (including null) is used as-is", () => {
    const body = setCourtHourlyRateBody();
    // nonMemberRateCents is derived exactly once, by a single ternary keyed
    // on memberships_enabled === false — no other assignment exists.
    const assignments = [...body.matchAll(/nonMemberRateCents (=|:) /g)];
    expect(assignments.length).toBe(1);
  });

  it("Second correction pass (fail-closed): the settings read is REQUIRED to succeed — a query error or a missing row returns an error and never reaches the RPC", () => {
    const body = setCourtHourlyRateBody();
    expect(body).toContain("error: settingsError");
    expect(body).toMatch(/if \(settingsError \|\| !currentSettings\) \{\s*return \{ error: ERROR_MESSAGES\.settings_unavailable \};\s*\}/);
    const guardIdx = body.indexOf("ERROR_MESSAGES.settings_unavailable");
    const rpcIdx = body.indexOf('supabase.rpc("set_court_hourly_rate"');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(rpcIdx).toBeGreaterThan(guardIdx);
  });

  it("Second correction pass (fail-closed): the court read is REQUIRED to succeed — a query error or a missing row returns an error and never reaches the RPC", () => {
    const body = setCourtHourlyRateBody();
    expect(body).toContain("error: courtError");
    expect(body).toMatch(/if \(courtError \|\| !currentCourt\) \{\s*return \{ error: ERROR_MESSAGES\.invalid_court \};\s*\}/);
    const guardIdx = body.lastIndexOf("ERROR_MESSAGES.invalid_court");
    const rpcIdx = body.indexOf('supabase.rpc("set_court_hourly_rate"');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(rpcIdx).toBeGreaterThan(guardIdx);
  });

  it("settings_unavailable is a real, project-convention error message — not an invented error subsystem", () => {
    const s = readSource(COURTS_ACTIONS_PATH);
    expect(s).toMatch(/settings_unavailable:\s*"[^"]+",/);
  });

  it("both preservation reads run in parallel via Promise.all before either guard is evaluated", () => {
    const body = setCourtHourlyRateBody();
    const promiseAllIdx = body.indexOf("await Promise.all([");
    const settingsErrorGuardIdx = body.indexOf("if (settingsError || !currentSettings)");
    expect(promiseAllIdx).toBeGreaterThan(-1);
    expect(settingsErrorGuardIdx).toBeGreaterThan(promiseAllIdx);
  });

  it("Correction (Section 1B / 4.7): the court lookup used for preservation is same-club scoped, using the club already confirmed active by assertActiveClub", () => {
    const body = setCourtHourlyRateBody();
    const courtsQueryIdx = body.indexOf('.from("courts")');
    expect(courtsQueryIdx).toBeGreaterThan(-1);
    const courtsQuery = body.slice(courtsQueryIdx, courtsQueryIdx + 200);
    expect(courtsQuery).toContain('.eq("id", courtId)');
    expect(courtsQuery).toContain('.eq("club_id", expectedClubId)');
  });

  it("the club_settings lookup used for the memberships_enabled check is also scoped to expectedClubId", () => {
    const body = setCourtHourlyRateBody();
    const settingsQueryIdx = body.indexOf('.from("club_settings")');
    expect(settingsQueryIdx).toBeGreaterThan(-1);
    const settingsQuery = body.slice(settingsQueryIdx, settingsQueryIdx + 150);
    expect(settingsQuery).toContain('.eq("club_id", expectedClubId)');
  });

  it("still guards with assertActiveClub as the first check, unchanged", () => {
    const body = setCourtHourlyRateBody();
    const guardIdx = body.indexOf("assertActiveClub");
    const settingsReadIdx = body.indexOf('.from("club_settings")');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(settingsReadIdx);
  });

  it("does not duplicate or weaken authorization — no new role/admin check is added beyond the existing not_authenticated guard and assertActiveClub", () => {
    const body = setCourtHourlyRateBody();
    expect(body).not.toMatch(/profile\?\.\s*role|insufficient_role.*=.*true/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 11. effective Non-Member rate display reflects the full 4-level 0189
//     fallback chain (Correction Section 3 / requirement 4.8)
// ═══════════════════════════════════════════════════════════════════════════
describe("11. CourtManagementList reflects the complete effective Non-Member fallback chain", () => {
  function describeNonMemberRateBody(): string {
    const s = readSource(COURT_MANAGEMENT_LIST_PATH);
    const start = s.indexOf("function describeNonMemberRate(");
    expect(start).toBeGreaterThan(-1);
    const end = s.indexOf("\nfunction nonMemberRatePlaceholder(", start);
    expect(end).toBeGreaterThan(start);
    return s.slice(start, end);
  }

  function nonMemberRatePlaceholderBody(): string {
    const s = readSource(COURT_MANAGEMENT_LIST_PATH);
    const start = s.indexOf("function nonMemberRatePlaceholder(");
    expect(start).toBeGreaterThan(-1);
    const end = s.indexOf("\ninterface Props", start);
    expect(end).toBeGreaterThan(start);
    return s.slice(start, end);
  }

  it("resolves in order: court override -> club Non-Member default -> effective Standard/Member rate -> No price set", () => {
    const body = describeNonMemberRateBody();
    const overrideIdx = body.indexOf("court.hourly_rate_non_member_cents !== null");
    const clubDefaultIdx = body.indexOf("defaultHourlyRateNonMemberCents !== null");
    const memberFallbackIdx = body.indexOf("const effectiveMemberRateCents = court.hourly_rate_cents ?? defaultHourlyRateCents;");
    const noPriceIdx = body.indexOf('"No price set"');
    expect(overrideIdx).toBeGreaterThan(-1);
    expect(clubDefaultIdx).toBeGreaterThan(overrideIdx);
    expect(memberFallbackIdx).toBeGreaterThan(clubDefaultIdx);
    expect(noPriceIdx).toBeGreaterThan(memberFallbackIdx);
  });

  it('labels an explicit court override as "(override)" and a club default as "(default)", each as a structured { text, qualifier } pair', () => {
    // UX polish pass: describeNonMemberRate now returns { text, qualifier }
    // instead of one pre-concatenated string, so RateSegment can style the
    // amount more prominently than the qualifier — the resolution ORDER
    // and the two labels themselves are unchanged.
    const body = describeNonMemberRateBody();
    expect(body).toMatch(/qualifier: "\(override\)"/);
    expect(body).toMatch(/qualifier: "\(default\)"/);
    expect(body).toContain("} /hr`, qualifier:");
  });

  it('never reports "No price set" when a Standard/Member rate would actually apply — falls to "Uses Standard/Member rate" first', () => {
    const body = describeNonMemberRateBody();
    expect(body).toContain('text: "Uses Standard/Member rate"');
    const memberFallbackIdx = body.indexOf('text: "Uses Standard/Member rate"');
    const noPriceIdx = body.indexOf('text: "No price set"');
    expect(memberFallbackIdx).toBeGreaterThan(-1);
    expect(noPriceIdx).toBeGreaterThan(memberFallbackIdx);
  });

  it('only reports "No price set" when the effective Member rate (court override or club default) is ALSO null', () => {
    const body = describeNonMemberRateBody();
    expect(body).toMatch(/if \(effectiveMemberRateCents !== null\) \{\s*return \{ text: "Uses Standard\/Member rate", qualifier: "" \};\s*\}\s*return \{ text: "No price set", qualifier: "" \};/);
  });

  it("does not introduce a new pricing class — no membership_pricing_class-style literal in the display helpers", () => {
    const body = describeNonMemberRateBody() + nonMemberRatePlaceholderBody();
    expect(body).not.toMatch(/membership_pricing_class/);
  });

  it("the normal-row badge and the edit-row placeholder both route through these two helpers, not ad hoc inline fallback logic", () => {
    const s = readSource(COURT_MANAGEMENT_LIST_PATH);
    expect(s).toContain("describeNonMemberRate(court, defaultHourlyRateCents, defaultHourlyRateNonMemberCents, currency)");
    expect(s).toContain("nonMemberRatePlaceholder(court, defaultHourlyRateCents, defaultHourlyRateNonMemberCents)");
    // The old ad hoc override/default ternary this correction replaced is gone.
    expect(s).not.toMatch(/court\.hourly_rate_non_member_cents !== null \? " \/hr \(override\)" : court\.hourly_rate_non_member_cents === null/);
  });

  it("the placeholder mirrors the same fallback rule: club default, else the effective Member rate labeled as such, else unpriced", () => {
    const body = nonMemberRatePlaceholderBody();
    expect(body).toContain("(club default)");
    expect(body).toContain("(uses Standard/Member rate)");
    expect(body).toContain('"0.00 (unpriced)"');
    const clubDefaultIdx = body.indexOf("defaultHourlyRateNonMemberCents !== null");
    const memberFallbackIdx = body.indexOf("const effectiveMemberRateCents = court.hourly_rate_cents ?? defaultHourlyRateCents;");
    const unpricedIdx = body.indexOf('"0.00 (unpriced)"');
    expect(clubDefaultIdx).toBeGreaterThan(-1);
    expect(memberFallbackIdx).toBeGreaterThan(clubDefaultIdx);
    expect(unpricedIdx).toBeGreaterThan(memberFallbackIdx);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 12. UX polish — preservation result metadata, stale-state feedback,
//     authoritative Non-Member resync, and route refresh (final correction)
// ═══════════════════════════════════════════════════════════════════════════
describe("12. UX polish: persistClubPricing/DefaultCourtRatesForm stale-tab feedback", () => {
  function persistClubPricingBody(): string {
    const s = readSource(SETTINGS_ACTIONS_PATH);
    const start = s.indexOf("async function persistClubPricing(");
    expect(start).toBeGreaterThan(-1);
    const nextFnIdx = s.indexOf("\nexport async function", start + 1);
    return s.slice(start, nextFnIdx > -1 ? nextFnIdx : undefined);
  }

  it("persistClubPricing returns nonMemberRatePreserved and effectiveNonMemberRateCents on every successful path, matching what was actually sent to the RPC", () => {
    const body = persistClubPricingBody();
    expect(body).toContain("return { nonMemberRatePreserved, effectiveNonMemberRateCents: nonMemberRateCents };");
    // The returned effectiveNonMemberRateCents is the SAME variable that
    // was sent as p_default_court_hourly_rate_non_member_cents — not a
    // second, independently-derived value that could drift from what was
    // actually persisted.
    expect(body).toContain("p_default_court_hourly_rate_non_member_cents: nonMemberRateCents,");
  });

  it("the error path never returns preservation metadata (no result to trust when the mutation didn't happen)", () => {
    const body = persistClubPricingBody();
    const errorReturns = [...body.matchAll(/return \{ error: [^}]+\};/g)];
    expect(errorReturns.length).toBeGreaterThan(0);
    for (const m of errorReturns) {
      expect(m[0]).not.toContain("nonMemberRatePreserved");
    }
  });

  it("updateDefaultCourtRates itself is a thin pass-through — it returns persistClubPricing's result directly, so the preservation metadata reaches DefaultCourtRatesForm unchanged", () => {
    const s = readSource(SETTINGS_ACTIONS_PATH);
    expect(s).toContain(
      "return persistClubPricing(\n    currentSettings.currency,\n    defaultCourtHourlyRateCents,\n    defaultCourtHourlyRateNonMemberCents,\n  );",
    );
  });

  it("DefaultCourtRatesForm shows the stale-tab message and resyncs local state ONLY when nonMemberRatePreserved is true", () => {
    const s = readSource(DEFAULT_COURT_RATES_FORM_PATH);
    expect(s).toContain("if (result.nonMemberRatePreserved) {");
    const preservedBranchIdx = s.indexOf("if (result.nonMemberRatePreserved) {");
    const elseIdx = s.indexOf("} else {", preservedBranchIdx);
    const preservedBranch = s.slice(preservedBranchIdx, elseIdx);
    expect(preservedBranch).toContain("setNonMemberRateDollars(");
    expect(preservedBranch).toContain("result.effectiveNonMemberRateCents");
    expect(preservedBranch).toContain("Saved. Memberships are off, so the Non-Member rate was left unchanged.");
  });

  it("a normal ON-state save still shows the plain existing \"Saved\" message, unchanged", () => {
    const s = readSource(DEFAULT_COURT_RATES_FORM_PATH);
    expect(s).toContain('setStatus({ type: "success", message: "Saved" });');
  });

  it("the route is refreshed after every successful save, not only the stale-tab case — so a stale tab's membershipsEnabled prop stops being stale", () => {
    const s = readSource(DEFAULT_COURT_RATES_FORM_PATH);
    expect(s).toContain('import { useRouter } from "next/navigation";');
    expect(s).toContain("const router = useRouter();");
    const submitStart = s.indexOf("function handleSubmit(");
    const submitEnd = s.indexOf("\n\n  return (", submitStart);
    const handlerBody = s.slice(submitStart, submitEnd > -1 ? submitEnd : undefined);
    // Called exactly once, after the preserved/non-preserved if/else has
    // already run — not duplicated inside either branch.
    const refreshCalls = [...handlerBody.matchAll(/router\.refresh\(\);/g)];
    expect(refreshCalls.length).toBe(1);
    const refreshIdx = handlerBody.indexOf("router.refresh();");
    const preservedBranchEndIdx = handlerBody.lastIndexOf('setStatus({ type: "success", message: "Saved" });');
    expect(refreshIdx).toBeGreaterThan(-1);
    expect(refreshIdx).toBeGreaterThan(preservedBranchEndIdx);
  });
});

describe("12. UX polish: setCourtHourlyRate/CourtManagementList stale-tab feedback", () => {
  function setCourtHourlyRateBody(): string {
    const s = readSource(COURTS_ACTIONS_PATH);
    const start = s.indexOf("export async function setCourtHourlyRate(");
    expect(start).toBeGreaterThan(-1);
    const nextExportIdx = s.indexOf("\nexport async function", start + 1);
    return s.slice(start, nextExportIdx > -1 ? nextExportIdx : undefined);
  }

  it("setCourtHourlyRate returns nonMemberRatePreserved and effectiveNonMemberRateCents on success, matching what was actually sent to the RPC", () => {
    const body = setCourtHourlyRateBody();
    expect(body).toContain("return { nonMemberRatePreserved, effectiveNonMemberRateCents: nonMemberRateCents };");
    expect(body).toContain("p_hourly_rate_non_member_cents: nonMemberRateCents,");
  });

  it("the error/fail-closed paths never return preservation metadata", () => {
    const body = setCourtHourlyRateBody();
    const errorReturns = [...body.matchAll(/return \{ error: [^}]+\};/g)];
    expect(errorReturns.length).toBeGreaterThan(0);
    for (const m of errorReturns) {
      expect(m[0]).not.toContain("nonMemberRatePreserved");
    }
  });

  it("CourtManagementList shows the stale-tab message and resyncs nonMemberRateValue ONLY when nonMemberRatePreserved is true", () => {
    const s = readSource(COURT_MANAGEMENT_LIST_PATH);
    expect(s).toContain("if (result.nonMemberRatePreserved) {");
    const preservedBranchIdx = s.indexOf("if (result.nonMemberRatePreserved) {");
    const elseIdx = s.indexOf("} else {", preservedBranchIdx);
    const preservedBranch = s.slice(preservedBranchIdx, elseIdx);
    expect(preservedBranch).toContain("setNonMemberRateValue(");
    expect(preservedBranch).toContain("result.effectiveNonMemberRateCents");
    expect(preservedBranch).toContain("Court rate saved. Memberships are off, so the Non-Member rate was left unchanged.");
  });

  it("a normal ON-state save still shows the plain existing \"Court rate saved.\" message, unchanged", () => {
    const s = readSource(COURT_MANAGEMENT_LIST_PATH);
    expect(s).toContain('showStatus({ type: "success", message: "Court rate saved." });');
  });

  it("router.refresh() still runs after a successful save regardless of which branch fired (pre-existing behavior, preserved)", () => {
    const s = readSource(COURT_MANAGEMENT_LIST_PATH);
    const start = s.indexOf("function handleRateSubmit(courtId: string) {");
    const end = s.indexOf("\n  }\n\n  // ── Activate", start);
    const handlerBody = s.slice(start, end > -1 ? end : start + 1500);
    const refreshIdx = handlerBody.lastIndexOf("router.refresh();");
    const preservedBranchIdx = handlerBody.indexOf("if (result.nonMemberRatePreserved)");
    expect(refreshIdx).toBeGreaterThan(-1);
    // router.refresh() sits after the if/else, not duplicated inside it.
    expect(refreshIdx).toBeGreaterThan(preservedBranchIdx);
    const refreshCalls = [...handlerBody.matchAll(/router\.refresh\(\);/g)];
    expect(refreshCalls.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 13. UX polish — pricing hierarchy restructure is responsive and
//     behavior-neutral (no pricing/business-logic change)
// ═══════════════════════════════════════════════════════════════════════════
describe("13. UX polish: pricing hierarchy is a distinct compact row, responsive, and behavior-neutral", () => {
  it("court name/status/action-button layout architecture (outer flex-col/sm:flex-row wrapper) is unchanged", () => {
    const s = readSource(COURT_MANAGEMENT_LIST_PATH);
    expect(s).toContain('<div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">');
  });

  it("pricing now sits on its own row beneath name/status, using flex-wrap so it wraps on mobile without overflowing and sits inline on desktop when space permits", () => {
    const s = readSource(COURT_MANAGEMENT_LIST_PATH);
    expect(s).toContain('className="mt-1 flex items-center gap-x-1.5 gap-y-0.5 flex-wrap text-xs"');
  });

  it("Member and Non-Member segments share identical styling classes — no semantic color distinction between them", () => {
    const s = readSource(COURT_MANAGEMENT_LIST_PATH);
    const start = s.indexOf("function RateSegment(");
    const end = s.indexOf("\ninterface Props", start);
    const body = s.slice(start, end);
    // RateSegment is the ONE component both Member and Non-Member render
    // through (verified by the two call sites above) — its styling
    // classes are therefore inherently shared, not duplicated per type.
    expect(body).toContain("text-gray-500 dark:text-gray-400");
    expect(body).toContain("font-medium text-gray-700 dark:text-gray-300");
    expect(body).not.toMatch(/text-(red|blue|orange|purple|amber|teal|indigo)-/);
  });

  it("the rate VALUE is styled more prominently (font-medium, darker gray) than the (override)/(default) qualifier, which stays secondary", () => {
    const s = readSource(COURT_MANAGEMENT_LIST_PATH);
    const start = s.indexOf("function RateSegment(");
    const end = s.indexOf("\ninterface Props", start);
    const body = s.slice(start, end);
    expect(body).toMatch(/font-medium text-gray-700 dark:text-gray-300">\{display\.text\}/);
    expect(body).toMatch(/text-gray-400 dark:text-gray-500"> \{display\.qualifier\}/);
  });

  it("when Memberships are off, only the single effective court/base rate renders — no Non-Member reference at all", () => {
    const s = readSource(COURT_MANAGEMENT_LIST_PATH);
    const pricingRowIdx = s.indexOf('className="mt-1 flex items-center gap-x-1.5 gap-y-0.5 flex-wrap text-xs"');
    const nextRowIdx = s.indexOf("{/* Action buttons", pricingRowIdx);
    const pricingRow = s.slice(pricingRowIdx, nextRowIdx);
    // Non-Member's RateSegment (and its separator) are the ONLY things
    // gated behind membershipsEnabled in this row — the Member segment
    // itself always renders, just with an empty label when off.
    const nonMemberGateIdx = pricingRow.indexOf("{membershipsEnabled && (");
    const memberSegmentIdx = pricingRow.indexOf("<RateSegment");
    expect(memberSegmentIdx).toBeGreaterThan(-1);
    expect(nonMemberGateIdx).toBeGreaterThan(memberSegmentIdx);
  });

  it("no pricing/business-logic change: describeMemberRate's resolution chain (court override -> club default -> unpriced) is exactly the same chain the row always used", () => {
    const s = readSource(COURT_MANAGEMENT_LIST_PATH);
    const start = s.indexOf("function describeMemberRate(");
    const end = s.indexOf("\nfunction describeNonMemberRate(", start);
    const body = s.slice(start, end);
    expect(body).toContain("court.hourly_rate_cents !== null");
    expect(body).toContain("defaultHourlyRateCents !== null");
    expect(body).toContain('qualifier: "(override)"');
    expect(body).toContain('qualifier: "(default)"');
    expect(body).toContain('text: "No price set"');
  });

  it("no pricing/business-logic change: setCourtHourlyRate/updateClubPricing's RPC argument names and resolution order are untouched by this polish pass", () => {
    const settingsBody = readSource(SETTINGS_ACTIONS_PATH);
    const courtsBody = readSource(COURTS_ACTIONS_PATH);
    expect(settingsBody).toContain("p_currency: currency,");
    expect(settingsBody).toContain("p_default_court_hourly_rate_cents: defaultCourtHourlyRateCents,");
    expect(courtsBody).toContain("p_court_id: courtId,");
    expect(courtsBody).toContain("p_hourly_rate_cents: hourlyRateCents,");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. no scope creep
// ═══════════════════════════════════════════════════════════════════════════
describe("10. no membership-management or Member Detail scope creep", () => {
  // Checks actual `.rpc("...")` call sites only — not prose. Some of these
  // files' own explanatory comments legitimately mention "membership_types"
  // or "membership_status" in describing what OFF preserves; that is not
  // scope creep, calling those RPCs would be.
  const FORBIDDEN_RPC_NAMES = [
    "set_roster_member_membership_status",
    "set_roster_member_membership_type",
    "create_membership_type",
    "update_membership_type",
    "set_membership_type_active",
  ];

  function rpcNamesCalled(source: string): string[] {
    return [...source.matchAll(/\.rpc\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
  }

  it("MembershipsSection and DefaultCourtRatesForm never call a membership-type/roster-membership RPC", () => {
    for (const path of [MEMBERSHIPS_SECTION_PATH, DEFAULT_COURT_RATES_FORM_PATH]) {
      const calledNames = rpcNamesCalled(readSource(path));
      for (const forbidden of FORBIDDEN_RPC_NAMES) {
        expect(calledNames).not.toContain(forbidden);
      }
    }
  });

  it("settings/actions.ts (Phase 42C-3B) legitimately calls the three membership_TYPE RPCs, but never a roster-membership mutation RPC", () => {
    // Membership Types management is genuinely owned by admin/settings —
    // this checkpoint's own scope claim was narrower (42C-2 predates
    // Membership Types UI entirely) than what the codebase correctly
    // grew into one checkpoint later. What must stay permanently true is
    // the boundary itself: settings/actions.ts manages TYPES, never an
    // individual roster member's status/type assignment — that stays in
    // admin/members/actions.ts exclusively.
    const calledNames = rpcNamesCalled(readSource(SETTINGS_ACTIONS_PATH));
    expect(calledNames).toContain("create_membership_type");
    expect(calledNames).toContain("update_membership_type");
    expect(calledNames).toContain("set_membership_type_active");
    expect(calledNames).not.toContain("set_roster_member_membership_status");
    expect(calledNames).not.toContain("set_roster_member_membership_type");
  });

  it("CourtManagementList and courts actions never call a membership-type/roster-membership RPC", () => {
    for (const path of [COURT_MANAGEMENT_LIST_PATH, COURTS_ACTIONS_PATH]) {
      const calledNames = rpcNamesCalled(readSource(path));
      for (const forbidden of FORBIDDEN_RPC_NAMES) {
        expect(calledNames).not.toContain(forbidden);
      }
    }
  });

  it("MembershipsSection renders no membership-type or Member Detail UI (its own explanatory copy about what is PRESERVED when off is not scope creep)", () => {
    const s = readSource(MEMBERSHIPS_SECTION_PATH);
    expect(s).not.toMatch(/MemberDetail|AddMemberSheet/);
    // The component's helper copy legitimately mentions "membership
    // status/types" in prose (explaining what OFF preserves) — the actual
    // scope-creep guard is that it imports/renders none of the real
    // membership-type management surface.
    expect(s).not.toMatch(/import .*MembershipType|<MembershipType/);
  });

  it("0188/0189/0190 are not modified by this checkpoint", () => {
    // Not a "no 0191 exists" blanket check — a later, legitimate
    // checkpoint (Phase 42C-3A, migration 0191) truthfully added one.
    // This checkpoint's own concern is narrower and still holds: none of
    // ITS files touch 0188/0189/0190's owned RPCs, and it introduced no
    // migration of its own.
    for (const path of [SETTINGS_ACTIONS_PATH, COURTS_ACTIONS_PATH, DEFAULT_COURT_RATES_FORM_PATH, COURT_MANAGEMENT_LIST_PATH, MEMBERSHIPS_SECTION_PATH]) {
      const s = readSource(path);
      expect(s).not.toMatch(/create or replace function|drop function|alter table/i);
    }
  });
});
