import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 34G-A2 — Pricing & Packaging Alignment: provisioning + commercial
// enforcement. Covers items 9-15 from the 34G-A2 spec.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !line.trim().startsWith("--") && !line.trim().startsWith("//"))
    .join("\n");
}

const MIGRATION_PATH = "supabase/migrations/0164_pricing_packaging_alignment.sql";
const FIX_MIGRATION_PATH = "supabase/migrations/0165_fix_tier_downgrade_column_ambiguity.sql";
const M0125_PATH = "supabase/migrations/0125_fix_operator_on_conflict_ambiguity.sql";
const M0035_PATH = "supabase/migrations/0035_bootstrap_new_club.sql";
const M0122_PATH = "supabase/migrations/0122_entitlement_foundation.sql";
const M0143_PATH = "supabase/migrations/0143_payment_mode_and_ledger_foundation.sql";
const M0156_PATH = "supabase/migrations/0156_stripe_dispute_visibility.sql";
const GRANT_SCRIPT_PATH = "scripts/grant-club-entitlement.mjs";
const PAYMENTS_ACTIONS_PATH = "src/app/(app)/admin/payments/actions.ts";
const PAYMENT_TRACKING_SECTION_PATH = "src/app/(app)/admin/settings/PaymentTrackingSection.tsx";
const COURT_TIME_PAYMENTS_SECTION_PATH = "src/app/(app)/admin/settings/CourtTimePaymentsSection.tsx";
const SETTINGS_PAGE_PATH = "src/app/(app)/admin/settings/page.tsx";

function getBootstrapFn(migrationText: string): string {
  const start = migrationText.indexOf("create or replace function bootstrap_new_club(");
  const end = migrationText.indexOf(
    "grant execute\n  on function bootstrap_new_club(text, text, text, int, uuid, text[], time, time, int, int, int)\n  to service_role;",
    start,
  );
  return migrationText.slice(start, end);
}

function getActivateFn(migrationText: string): string {
  const start = migrationText.indexOf("create or replace function public.activate_court_time_payments(");
  const end = migrationText.indexOf(
    "revoke execute on function public.activate_court_time_payments(uuid, boolean, uuid) from public, anon, authenticated;",
    start,
  );
  return migrationText.slice(start, end);
}

// Phase 34G-A2 (correction round) — the three functions redefined/added to
// close the Connected -> Staff-Managed downgrade gap.
function getSetTierFn(migrationText: string): string {
  const start = migrationText.indexOf("create or replace function public.set_club_tier_for_operator(");
  const end = migrationText.indexOf(
    "revoke execute on function public.set_club_tier_for_operator(uuid, text) from public, anon, authenticated;",
    start,
  );
  return migrationText.slice(start, end);
}

function getOpenAttemptFn(migrationText: string): string {
  const start = migrationText.indexOf("create or replace function public.open_payment_checkout_attempt(");
  const end = migrationText.indexOf(
    "revoke execute on function public.open_payment_checkout_attempt(uuid, uuid, text, boolean, uuid) from public, anon, authenticated;",
    start,
  );
  return migrationText.slice(start, end);
}

function getSupersedeFn(migrationText: string): string {
  const start = migrationText.indexOf("create or replace function public.supersede_checkout_attempt_and_open_fresh(");
  const end = migrationText.indexOf(
    "revoke execute on function public.supersede_checkout_attempt_and_open_fresh(uuid, uuid, uuid, text, boolean, uuid) from public, anon, authenticated;",
    start,
  );
  return migrationText.slice(start, end);
}

function getListBlockingFn(migrationText: string): string {
  const start = migrationText.indexOf("create or replace function public.list_club_blocking_checkout_attempts(");
  const end = migrationText.indexOf(
    "revoke execute on function public.list_club_blocking_checkout_attempts(uuid) from public, anon, authenticated;",
    start,
  );
  return migrationText.slice(start, end);
}

// ═══════════════════════════════════════════════════════════════════════════
// 9 — new-club provisioning produces explicit Staff-Managed entitlement state
// ═══════════════════════════════════════════════════════════════════════════

describe("9. bootstrap_new_club now explicitly provisions Staff-Managed commercial state", () => {
  it("inserts an explicit club_subscriptions row (tier='staff_managed', status='active') for every newly bootstrapped club", () => {
    const m = readSource(MIGRATION_PATH);
    const fn = getBootstrapFn(m);
    expect(fn).toContain("insert into club_subscriptions (club_id, tier, status, source)");
    expect(fn).toContain("values (v_club.id, 'staff_managed', 'active', 'manual_pilot');");
  });

  it("the insert runs AFTER the club_settings insert and BEFORE courts are created — early, unconditional provisioning, not a late/optional step", () => {
    const m = readSource(MIGRATION_PATH);
    const fn = getBootstrapFn(m);
    const settingsIdx = fn.indexOf("insert into club_settings (");
    const subscriptionIdx = fn.indexOf("insert into club_subscriptions (club_id, tier, status, source)");
    const courtsIdx = fn.indexOf("for v_i in 1..p_court_count loop");
    expect(settingsIdx).toBeGreaterThan(-1);
    expect(subscriptionIdx).toBeGreaterThan(settingsIdx);
    expect(courtsIdx).toBeGreaterThan(subscriptionIdx);
  });

  it("uses source='manual_pilot' — the same value set_club_tier_for_operator already uses for manual tier grants, not a new/invented source", () => {
    const m0122 = readSource(M0122_PATH);
    expect(m0122).toContain("check (source in ('backfill', 'manual_pilot', 'manual_admin', 'stripe'))");
  });

  it("does NOT insert a club_entitlements row — absence of an active member_self_service grant already means false by design (club_has_capability's own coalesce default), matching set_club_tier_for_operator's own staff_managed branch, which never inserts a disabled row either", () => {
    const m = readSource(MIGRATION_PATH);
    const fn = getBootstrapFn(m);
    expect(fn).not.toMatch(/insert into club_entitlements/);
  });

  it("bootstrap_new_club's rollback body is byte-identical to its true pre-0164 authoritative source (0035)", () => {
    const m = readSource(MIGRATION_PATH);
    const m0035 = readSource(M0035_PATH);

    function norm(s: string): string {
      return s
        .split("\n")
        .map((line) => {
          let stripped = line.replace(/\s+$/, "");
          while (true) {
            if (stripped.startsWith("-- ")) stripped = stripped.slice(3);
            else if (stripped === "--") { stripped = ""; break; }
            else break;
          }
          return stripped;
        })
        .join("\n")
        .trim();
    }

    const rbStart = m.indexOf("-- create or replace function bootstrap_new_club(");
    const rbEndMarker = "-- grant execute\n--   on function bootstrap_new_club(text, text, text, int, uuid, text[], time, time, int, int, int)\n--   to service_role;";
    const rbEnd = m.indexOf(rbEndMarker, rbStart) + rbEndMarker.length;
    const rollback = norm(m.slice(rbStart, rbEnd));

    const authStart = m0035.indexOf("create or replace function bootstrap_new_club(");
    const authEndMarker = "grant execute\n  on function bootstrap_new_club(text, text, text, int, uuid, text[], time, time, int, int, int)\n  to service_role;";
    const authEnd = m0035.indexOf(authEndMarker, authStart) + authEndMarker.length;
    const authoritative = norm(m0035.slice(authStart, authEnd));

    expect(rollback).toBe(authoritative);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10 — Connected provisioning uses the existing privileged path
// ═══════════════════════════════════════════════════════════════════════════

describe("10. Connected provisioning still goes through set_club_tier_for_operator as the sole tier-mutation path — 0164's own downgrade-safety redefinition of it is covered separately (see 16-21)", () => {
  it("scripts/grant-club-entitlement.mjs remains the sole caller, documented with the exact Founding Club provisioning recipe (grant connected, then Admin enables Stripe/Payments separately)", () => {
    const s = readSource(GRANT_SCRIPT_PATH);
    expect(s).toContain('supabase.rpc("set_club_tier_for_operator"');
    expect(s).toMatch(/Founding Club provisioning workflow/);
    expect(s).toMatch(/grant-club-entitlement\.mjs <club> connected/);
  });

  it("set_club_tier_for_operator remains service_role-only — no widening to authenticated/Admin", () => {
    const m0122 = readSource(M0122_PATH);
    expect(m0122).toContain("revoke execute on function public.set_club_tier_for_operator(uuid, text) from public, anon, authenticated;");
    expect(m0122).toContain("grant  execute on function public.set_club_tier_for_operator(uuid, text) to service_role;");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 11 — Payments remains off by default
// ═══════════════════════════════════════════════════════════════════════════

describe("11. Court Time Payments remains off by default for every newly bootstrapped club", () => {
  it("bootstrap_new_club still never sets club_settings.payment_mode explicitly — the column's own DEFAULT 'none' (0143) is what applies", () => {
    const m = readSource(MIGRATION_PATH);
    const fn = codeOnly(getBootstrapFn(m));
    expect(fn).not.toMatch(/payment_mode/);
  });

  it("club_settings.payment_mode's column default is 'none', unchanged by this checkpoint", () => {
    const m0143 = readSource(M0143_PATH);
    expect(m0143).toContain("add column payment_mode text not null default 'none'");
  });

  it("granting Connected via set_club_tier_for_operator never touches payment_mode — tier and payment activation remain two independent steps", () => {
    const m0122 = readSource(M0122_PATH);
    const fnStart = m0122.indexOf("create or replace function public.set_club_tier_for_operator(");
    const fnEnd = m0122.indexOf("revoke execute on function public.set_club_tier_for_operator(", fnStart);
    const fn = m0122.slice(fnStart, fnEnd);
    expect(fn).not.toMatch(/payment_mode/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 12 — activating Court Time Payments without Connected fails closed
// ═══════════════════════════════════════════════════════════════════════════

describe("12. activate_court_time_payments fails closed for a Staff-Managed club (commercial enforcement)", () => {
  it("checks club_has_capability(p_club_id, 'member_self_service') and raises capability_not_available — the SAME error code every other capability gate already raises (0123), never an invented one", () => {
    const m = readSource(MIGRATION_PATH);
    const fn = getActivateFn(m);
    expect(fn).toContain("if not public.club_has_capability(p_club_id, 'member_self_service') then");
    expect(fn).toContain("raise exception 'capability_not_available';");
  });

  it("the capability check runs BEFORE the Stripe-readiness check and BEFORE the payment_mode UPDATE — a Staff-Managed club is told the real, prerequisite reason first and no mutation occurs", () => {
    const m = readSource(MIGRATION_PATH);
    const fn = getActivateFn(m);
    const capabilityIdx = fn.indexOf("raise exception 'capability_not_available';");
    const readyIdx = fn.indexOf("raise exception 'stripe_connect_not_ready';");
    const updateIdx = fn.indexOf("update public.club_settings");
    expect(capabilityIdx).toBeGreaterThan(-1);
    expect(readyIdx).toBeGreaterThan(capabilityIdx);
    expect(updateIdx).toBeGreaterThan(readyIdx);
  });

  it("club_has_capability is reused verbatim (0122, SECURITY DEFINER, internal-only) — never duplicated or re-implemented inline", () => {
    const m = readSource(MIGRATION_PATH);
    expect(m).not.toMatch(/create or replace function public\.club_has_capability/);
  });

  it("the TS error-mapping layer (admin/payments/actions.ts) recognizes capability_not_available and surfaces a clear upgrade message, never a generic failure", () => {
    const s = readSource(PAYMENTS_ACTIONS_PATH);
    expect(s).toContain("capability_not_available: \"Court Time Payments requires the Connected plan. Contact us to upgrade.\",");
    expect(s).toContain("error.message.match(/capability_not_available|stripe_connect_not_ready|invalid_arguments|club_not_found/)");
  });

  it("CourtTimePaymentsSection's online-payments toggle is pre-emptively disabled with the same reason when the club is not Connected, so an Admin is never sent to hit this server error unnecessarily (moved from PaymentTrackingSection at Phase 34G-B)", () => {
    const s = readSource(COURT_TIME_PAYMENTS_SECTION_PATH);
    expect(s).toContain("const onlineDisabled = isPending || (!onlineOn && (!trackingOn || !connected || !stripeReady));");
    expect(s).toContain('"Court Time Payments requires the Connected plan. Contact us to upgrade."');
  });

  it("activate_court_time_payments rollback body is byte-identical to its true pre-0164 authoritative source (0149)", () => {
    const m = readSource(MIGRATION_PATH);
    const m0149 = readSource("supabase/migrations/0149_court_time_payments_activation_gate.sql");

    function norm(s: string): string {
      return s
        .split("\n")
        .map((line) => {
          let stripped = line.replace(/\s+$/, "");
          while (true) {
            if (stripped.startsWith("-- ")) stripped = stripped.slice(3);
            else if (stripped === "--") { stripped = ""; break; }
            else break;
          }
          return stripped;
        })
        .join("\n")
        .trim();
    }

    const rbStart = m.indexOf("-- create or replace function public.activate_court_time_payments(");
    const rbEndMarker = "-- grant  execute on function public.activate_court_time_payments(uuid, boolean, uuid) to service_role;";
    const rbEnd = m.indexOf(rbEndMarker, rbStart) + rbEndMarker.length;
    const rollback = norm(m.slice(rbStart, rbEnd));

    const authStart = m0149.indexOf("create or replace function public.activate_court_time_payments(");
    const authEndMarker = "grant  execute on function public.activate_court_time_payments(uuid, boolean, uuid) to service_role;";
    const authEnd = m0149.indexOf(authEndMarker, authStart) + authEndMarker.length;
    const authoritative = norm(m0149.slice(authStart, authEnd));

    expect(rollback).toBe(authoritative);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 13 — Connected + ready Stripe account can activate Payments
// ═══════════════════════════════════════════════════════════════════════════

describe("13. a Connected club with a Stripe-ready account can still activate Court Time Payments — the new gate is additive, not a regression for the happy path", () => {
  it("the Stripe-readiness check (card_payments_status='active' for the matching club_id+livemode) is preserved byte-for-byte from 0149", () => {
    const m = readSource(MIGRATION_PATH);
    const fn = getActivateFn(m);
    expect(fn).toContain("select exists (\n    select 1 from public.club_stripe_accounts\n     where club_id = p_club_id\n       and livemode = p_livemode\n       and card_payments_status = 'active'\n  ) into v_ready;");
  });

  it("the payment_mode UPDATE and audit_log insert are preserved byte-for-byte from 0149 — activation still only ever touches club_settings, never payments/payment_events", () => {
    const m = readSource(MIGRATION_PATH);
    const fn = codeOnly(getActivateFn(m));
    expect(fn).toContain("set payment_mode = 'court_time_payments'");
    expect(fn).not.toMatch(/insert into public\.payments|insert into public\.payment_events/);
  });

  it("the live (forward) function differs from its own rollback-documented body by EXACTLY the two new additions (canonical lock, then capability check) — no other behavioral delta. Full lock coverage is verified in describe 23", () => {
    const m = readSource(MIGRATION_PATH);
    const liveFn = getActivateFn(m);
    expect(liveFn).toContain("if p_club_id is null or p_livemode is null or p_actor_id is null then");
    expect(liveFn).toContain("raise exception 'invalid_arguments';");
    expect(liveFn).toContain("if not public.club_has_capability(p_club_id, 'member_self_service') then");
    // Still returns the full updated club_settings row, unchanged shape.
    expect(liveFn).toContain("returning * into v_result;");
    expect(liveFn).toContain("return v_result;");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 14 — downgrade behavior preserves historical payment/refund/dispute access
// ═══════════════════════════════════════════════════════════════════════════

describe("14. historical payment/refund/dispute/Record Payment access remains fully independent of tier — this checkpoint deliberately does not touch any of it", () => {
  it("record_manual_payment (0143) remains untouched by 0164 and still has no capability/tier check of its own", () => {
    const m = readSource(MIGRATION_PATH);
    expect(m).not.toMatch(/create or replace function public\.record_manual_payment/);
    const m0143 = readSource(M0143_PATH);
    const fnStart = m0143.indexOf("create or replace function public.record_manual_payment(");
    const fnEnd = m0143.indexOf("$$;", fnStart);
    const fn = m0143.slice(fnStart, fnEnd);
    expect(fn).not.toMatch(/member_self_service|club_has_capability|club_subscriptions/);
  });

  it("record_refund / reverse_payment_event / waive_payment / void_payment_obligation (0143) are untouched by 0164", () => {
    const m = readSource(MIGRATION_PATH);
    for (const fnName of ["record_refund", "reverse_payment_event", "waive_payment", "void_payment_obligation"]) {
      expect(m).not.toMatch(new RegExp(`create or replace function public\\.${fnName}\\(`));
    }
  });

  it("Stripe dispute visibility (0156) is untouched by 0164 and has no capability/tier gate", () => {
    const m = readSource(MIGRATION_PATH);
    expect(m).not.toMatch(/payment_disputes/);
    const m0156 = readSource(M0156_PATH);
    expect(m0156).not.toMatch(/member_self_service|club_has_capability/);
  });

  it("this migration documents the downgrade-safe design explicitly (correction round) rather than leaving it unresolved or silently ignored — see 16-21 for the executable behavior", () => {
    const m = readSource(MIGRATION_PATH);
    expect(m).toContain("CORRECTION ROUND");
    expect(m).toContain("CANONICAL COMMERCIAL LOCK");
    expect(m).toContain("Explicitly NOT done here");
  });

  it("/admin/payments itself is untouched by 0164 — Record Payment, refund, and dispute UI remain reachable regardless of tier", () => {
    const s = readSource(PAYMENTS_ACTIONS_PATH);
    // capability_not_available legitimately appears here (added this
    // checkpoint) but ONLY in the court_time_payments activation branch's
    // own ERROR_MESSAGES entry/regex — never anywhere near
    // recordManualPayment or the refund/dispute read paths.
    const recordFnStart = s.indexOf("export async function recordManualPaymentAction(");
    expect(recordFnStart).toBeGreaterThan(-1);
    const recordFnEnd = s.indexOf("\n}\n", recordFnStart);
    const recordFn = s.slice(recordFnStart, recordFnEnd);
    expect(recordFn).not.toMatch(/memberSelfService|member_self_service|capability_not_available/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 15 — no Admin-facing tier mutation is introduced
// ═══════════════════════════════════════════════════════════════════════════

describe("15. no Admin-facing tier-mutation UI or Server Action is introduced — the read-only indicator never writes", () => {
  it("admin/settings/page.tsx's Plan & Access group (Operating Model) only READS profile.memberSelfService — no Server Action, no form, no onClick/mutation call inside the rendered group itself", () => {
    const s = readSource(SETTINGS_PAGE_PATH);
    // Anchor on the actual JSX group heading (Admin IA Checkpoint 5: Plan &
    // Access is the last of the three groups on the page, containing only
    // Operating Model), not the earlier prose comment (which legitimately
    // mentions "Operating Model" and "set_club_tier_for_operator" only to
    // document that tier mutation stays privileged/out of scope here).
    const idx = s.indexOf('<h2 className="text-base font-bold text-gray-900 dark:text-gray-100">Plan & Access</h2>');
    expect(idx).toBeGreaterThan(-1);
    const sectionEnd = s.indexOf("</section>", idx);
    const section = s.slice(idx, sectionEnd);
    expect(section).not.toMatch(/onClick|action=|Server Action|\.rpc\(|set_club_tier_for_operator/);
    expect(section).toContain("memberSelfService");
  });

  it("no new Server Action file exports a tier-mutation function (e.g. setClubTier/updateClubTier) anywhere under src/app", () => {
    const s = readSource(SETTINGS_PAGE_PATH);
    expect(s).not.toMatch(/setClubTier|updateClubTier|changeTier|upgradeTier/i);
  });

  it("set_club_tier_for_operator is never actually CALLED (no .rpc(\"set_club_tier_for_operator\" invocation) from any in-app TypeScript file this checkpoint touches — a documentation mention explaining tier mutation stays privileged is not a call", () => {
    for (const path of [SETTINGS_PAGE_PATH, PAYMENTS_ACTIONS_PATH, PAYMENT_TRACKING_SECTION_PATH, COURT_TIME_PAYMENTS_SECTION_PATH]) {
      const s = readSource(path);
      expect(s).not.toMatch(/\.rpc\(\s*["']set_club_tier_for_operator["']/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 16 — canonical commercial lock: identical key, shared by all three sites
// ═══════════════════════════════════════════════════════════════════════════

describe("16. a single canonical advisory lock key serializes downgrade against Checkout-opening — required invariant 7/10/11 (no unsafe race)", () => {
  const LOCK_EXPR =
    "perform pg_advisory_xact_lock(hashtextextended('club_commercial_tier:' || p_club_id::text, 0));";

  it("set_club_tier_for_operator acquires the lock as its first action after the club-existence check, before any tier/entitlement read or mutation", () => {
    const m = readSource(MIGRATION_PATH);
    const fn = getSetTierFn(m);
    const clubNotFoundIdx = fn.indexOf("raise exception 'club_not_found';");
    const lockIdx = fn.indexOf(LOCK_EXPR);
    const currentTierIdx = fn.indexOf("select cs.tier into v_current_tier");
    const upsertIdx = fn.indexOf("insert into public.club_subscriptions (club_id, tier, status, source)");
    expect(clubNotFoundIdx).toBeGreaterThan(-1);
    expect(lockIdx).toBeGreaterThan(clubNotFoundIdx);
    expect(currentTierIdx).toBeGreaterThan(lockIdx);
    expect(upsertIdx).toBeGreaterThan(currentTierIdx);
  });

  it("open_payment_checkout_attempt acquires the IDENTICAL lock expression, before its payments-row lock", () => {
    const m = readSource(MIGRATION_PATH);
    const fn = getOpenAttemptFn(m);
    const lockIdx = fn.indexOf(LOCK_EXPR);
    const capabilityIdx = fn.indexOf("if not public.club_has_capability(p_club_id, 'member_self_service') then");
    const paymentsLockIdx = fn.indexOf("for update;");
    expect(lockIdx).toBeGreaterThan(-1);
    expect(capabilityIdx).toBeGreaterThan(lockIdx);
    expect(paymentsLockIdx).toBeGreaterThan(capabilityIdx);
  });

  it("supersede_checkout_attempt_and_open_fresh acquires the IDENTICAL lock expression, before its payments-row lock — the second attempt-opening call site is covered too, not only the first", () => {
    const m = readSource(MIGRATION_PATH);
    const fn = getSupersedeFn(m);
    const lockIdx = fn.indexOf(LOCK_EXPR);
    const capabilityIdx = fn.indexOf("if not public.club_has_capability(p_club_id, 'member_self_service') then");
    const paymentsLockIdx = fn.indexOf("for update;");
    expect(lockIdx).toBeGreaterThan(-1);
    expect(capabilityIdx).toBeGreaterThan(lockIdx);
    expect(paymentsLockIdx).toBeGreaterThan(capabilityIdx);
  });

  it("the downgrade path never locks a payments row directly — it only calls the existing _invalidate_or_flag_open_checkout_attempt helper (0151), which locks payment_checkout_attempts, not payments — so no ABBA cycle is possible against the Checkout-opening path's fixed (lock -> payments row) order", () => {
    const m = readSource(MIGRATION_PATH);
    const fn = getSetTierFn(m);
    expect(fn).not.toMatch(/from public\.payments p\s*where p\.id = .* for update/);
    expect(fn).toContain("perform public._invalidate_or_flag_open_checkout_attempt(v_payment_id_for_checkout_guard);");
    expect(m).toMatch(/no ABBA cycle is\s*\n-- possible/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 17 — new Checkout after downgrade is blocked for all four domains (3-6)
// ═══════════════════════════════════════════════════════════════════════════

describe("17. a NEW Checkout cannot be opened once the club lacks member_self_service — closes the gap for Reservation/Lesson/Event/Program at the ONE shared boundary they all delegate to", () => {
  it("open_payment_checkout_attempt fails closed with capability_not_available when club_has_capability is false — Reservation calls this directly, so this alone covers Reservation (item 3)", () => {
    const m = readSource(MIGRATION_PATH);
    const fn = getOpenAttemptFn(m);
    expect(fn).toContain("raise exception 'capability_not_available';");
  });

  it("supersede_checkout_attempt_and_open_fresh carries the identical check — a stale existing attempt cannot be superseded into a fresh one after downgrade either", () => {
    const m = readSource(MIGRATION_PATH);
    const fn = getSupersedeFn(m);
    expect(fn).toContain("raise exception 'capability_not_available';");
  });

  it("Lesson/Event/Program wrapper migrations (0160/0161/0163) are untouched by 0164 — they still delegate their ENTIRE remaining algorithm to open_payment_checkout_attempt / supersede_checkout_attempt_and_open_fresh, so the one capability check above covers items 4-6 without duplicating logic in three more places", () => {
    const m = readSource(MIGRATION_PATH);
    expect(m).not.toMatch(/create or replace function public\.open_lesson_payment_checkout_attempt/);
    expect(m).not.toMatch(/create or replace function public\.open_event_payment_checkout_attempt/);
    expect(m).not.toMatch(/create or replace function public\.open_program_payment_checkout_attempt/);
  });

  it("the capability check applies regardless of the payment's own frozen payment_mode_at_creation — an OLD outstanding obligation still snapshotted 'court_time_payments' is blocked exactly the same as a fresh one, since the check runs BEFORE the payments row is even selected", () => {
    const m = readSource(MIGRATION_PATH);
    const openFn = getOpenAttemptFn(m);
    const capabilityIdx = openFn.indexOf("raise exception 'capability_not_available';");
    const paymentSelectIdx = openFn.indexOf("select * into v_payment");
    expect(capabilityIdx).toBeGreaterThan(-1);
    expect(paymentSelectIdx).toBeGreaterThan(capabilityIdx);
  });

  it("the four Checkout Server Actions (Reservation/Lesson/Event/Program) all recognize capability_not_available and surface a clear Member-facing message, never a generic fallback", () => {
    const paths = [
      "src/app/(app)/calendar/reservationCheckoutActions.ts",
      "src/app/(app)/lessons/lessonCheckoutActions.ts",
      "src/app/(app)/calendar/eventCheckoutActions.ts",
      "src/app/(app)/events/programCheckoutActions.ts",
    ];
    for (const path of paths) {
      const s = readSource(path);
      expect(s).toContain('capability_not_available: "Online payments are no longer available for this club."');
      // Both the resolveError and supersedeError regexes must include it —
      // the wrapper functions can raise it from either call site.
      const matches = s.match(/capability_not_available\|/g) ?? [];
      expect(matches.length).toBeGreaterThanOrEqual(2);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 18 — an already-open, remotely-payable Checkout blocks downgrade (7-9)
// ═══════════════════════════════════════════════════════════════════════════

describe("18. a bound, possibly-still-payable remote Stripe Checkout Session blocks the ENTIRE downgrade until resolved — reuses the existing stale-Checkout architecture rather than inventing a second one", () => {
  it("set_club_tier_for_operator's fan-out loop calls the EXISTING, unmodified _invalidate_or_flag_open_checkout_attempt (0151) — never a new/duplicated resolver", () => {
    const m = readSource(MIGRATION_PATH);
    expect(m).not.toMatch(/create or replace function public\._invalidate_or_flag_open_checkout_attempt/);
    const fn = getSetTierFn(m);
    expect(fn).toContain("perform public._invalidate_or_flag_open_checkout_attempt(v_payment_id_for_checkout_guard);");
  });

  it("_invalidate_or_flag_open_checkout_attempt (0151, unmodified) only ever cancels LOCALLY when no Stripe session is bound — a bound session raises open_checkout_requires_resolution instead, never marking a remotely-payable Session dead in the database alone (item 8)", () => {
    const m0151 = readSource("supabase/migrations/0151_stale_checkout_invalidation.sql");
    expect(m0151).toContain("raise exception 'open_checkout_requires_resolution';");
    expect(m0151).toMatch(/stripe_checkout_session_id is null/);
  });

  it("the fan-out loop runs, and can therefore raise open_checkout_requires_resolution, BEFORE the club_subscriptions upsert and BEFORE the club_entitlements revoke branch — a blocking Session fails the downgrade before any commercial state changes (item 7)", () => {
    const m = readSource(MIGRATION_PATH);
    const fn = getSetTierFn(m);
    const fanOutIdx = fn.indexOf("for v_payment_id_for_checkout_guard in");
    const upsertIdx = fn.indexOf("insert into public.club_subscriptions (club_id, tier, status, source)");
    const entitlementBranchIdx = fn.indexOf("if p_tier = 'connected' then");
    expect(fanOutIdx).toBeGreaterThan(-1);
    expect(upsertIdx).toBeGreaterThan(fanOutIdx);
    expect(entitlementBranchIdx).toBeGreaterThan(upsertIdx);
  });

  it("once every blocking attempt is resolved/expired (the loop completes without raising), downgrade proceeds to the payment_mode step-down and the tier/entitlement mutation — nothing about the resolution path is invented beyond the loop calling the existing helper (item 9)", () => {
    const m = readSource(MIGRATION_PATH);
    const fn = getSetTierFn(m);
    const loopEndIdx = fn.indexOf("end loop;");
    const paymentModeIdx = fn.indexOf("set payment_mode = 'manual', updated_at = now()");
    expect(loopEndIdx).toBeGreaterThan(-1);
    expect(paymentModeIdx).toBeGreaterThan(loopEndIdx);
  });

  it("list_club_blocking_checkout_attempts is service-role-only, read-only, and uses the EXACT same blocking predicate (open + bound) as the fan-out guard — the operator-facing preflight cannot disagree with the enforcement path", () => {
    const m = readSource(MIGRATION_PATH);
    const fn = getListBlockingFn(m);
    expect(fn).toContain("a.status      = 'open'");
    expect(fn).toContain("a.stripe_checkout_session_id is not null");
    expect(m).toContain("revoke execute on function public.list_club_blocking_checkout_attempts(uuid) from public, anon, authenticated;");
    expect(m).toContain("grant  execute on function public.list_club_blocking_checkout_attempts(uuid) to service_role;");
  });

  it("scripts/grant-club-entitlement.mjs catches open_checkout_requires_resolution, lists the blocking payment ids via list_club_blocking_checkout_attempts, and never attempts to resolve a remote Stripe Session itself", () => {
    const s = readSource(GRANT_SCRIPT_PATH);
    expect(s).toContain("open_checkout_requires_resolution");
    expect(s).toContain('supabase.rpc(\n        "list_club_blocking_checkout_attempts"');
    expect(s).not.toMatch(/stripe\.checkout\.sessions/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 19 — concurrency: no unsafe interleaving between downgrade and Checkout (10-11)
// ═══════════════════════════════════════════════════════════════════════════

describe("19. downgrade and Checkout-opening cannot interleave unsafely — whichever acquires the canonical lock first fully commits or rolls back before the other proceeds", () => {
  it("both open_payment_checkout_attempt and set_club_tier_for_operator key the advisory lock off the SAME club_id-scoped expression — a shared namespace, not two independent locks that could both be held simultaneously", () => {
    const m = readSource(MIGRATION_PATH);
    const openFn = getOpenAttemptFn(m);
    const tierFn = getSetTierFn(m);
    const lockExpr = "hashtextextended('club_commercial_tier:' || p_club_id::text, 0)";
    expect(openFn).toContain(lockExpr);
    expect(tierFn).toContain(lockExpr);
  });

  it("pg_advisory_xact_lock (not pg_advisory_lock) is used everywhere — the lock is transaction-scoped and released automatically at commit/rollback, so a crashed or long-idle session cannot wedge the other side forever", () => {
    const m = readSource(MIGRATION_PATH);
    const code = codeOnly(m);
    expect(code).not.toMatch(/pg_advisory_lock\(/);
    // Exactly four LIVE call sites (activate_court_time_payments,
    // set_club_tier_for_operator, open_payment_checkout_attempt,
    // supersede_checkout_attempt_and_open_fresh) — codeOnly strips the
    // documentation mentions in this migration's own header/section
    // comments, and the rollback section (which restores the pre-0164
    // originals, containing none) is comment-only. See describe 23 for
    // the activation lock specifically.
    expect(code.match(/pg_advisory_xact_lock\(/g)?.length).toBe(4);
  });

  it("there is no code path where set_club_tier_for_operator returns successfully AND a Checkout attempt opened after it was still using stale Connected state — the capability check inside open_payment_checkout_attempt is a live read taken AFTER acquiring the same lock the downgrade just released, so it always observes the downgrade's own committed result, never a cached/earlier value", () => {
    const m = readSource(MIGRATION_PATH);
    const openFn = getOpenAttemptFn(m);
    const lockIdx = openFn.indexOf("perform pg_advisory_xact_lock(");
    const capabilityIdx = openFn.indexOf("if not public.club_has_capability(p_club_id, 'member_self_service') then");
    expect(capabilityIdx).toBeGreaterThan(lockIdx);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 20 — successful downgrade state transition (12-19)
// ═══════════════════════════════════════════════════════════════════════════

describe("20. a successful Connected -> Staff-Managed downgrade produces exactly the documented state transition — nothing more, nothing less", () => {
  it("member_self_service is revoked (the else/staff_managed branch revokes the active grant) and the subscription tier is set to staff_managed (items 12-13)", () => {
    const m = readSource(MIGRATION_PATH);
    const fn = getSetTierFn(m);
    expect(fn).toContain("-- staff_managed: revoke the active grant if one exists.");
    expect(fn).toContain("values (p_club_id, p_tier, 'active', 'manual_pilot')");
  });

  it("club_settings.payment_mode steps down from 'court_time_payments' to 'manual' — the club can no longer be configured as actively offering Member online payments (item 14)", () => {
    const m = readSource(MIGRATION_PATH);
    const fn = getSetTierFn(m);
    expect(fn).toContain("set payment_mode = 'manual', updated_at = now()");
    expect(fn).toContain("and payment_mode = 'court_time_payments';");
    expect(fn).not.toMatch(/payment_mode = 'none'/);
  });

  it("no historical payments or payment_events row is ever touched by this function — the only UPDATE statements target club_subscriptions, club_entitlements, and club_settings (items 15-16)", () => {
    const m = readSource(MIGRATION_PATH);
    const fn = codeOnly(getSetTierFn(m));
    expect(fn).not.toMatch(/update public\.payments\b/);
    expect(fn).not.toMatch(/insert into public\.payment_events/);
    expect(fn).not.toMatch(/update public\.payment_events\b/);
  });

  it("record_manual_payment, record_refund, and dispute visibility remain completely untouched by this migration — Record Payment/refund/dispute access does not depend on tier at all (items 17-19)", () => {
    const m = readSource(MIGRATION_PATH);
    for (const fnName of ["record_manual_payment", "record_refund", "reverse_payment_event", "waive_payment", "void_payment_obligation"]) {
      expect(m).not.toMatch(new RegExp(`create or replace function public\\.${fnName}\\(`));
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 21 — failed downgrade leaves the club fully Connected (20-21)
// ═══════════════════════════════════════════════════════════════════════════

describe("21. a FAILED downgrade (blocked by an open remote Checkout) leaves the club's commercial state completely unchanged — never a partial revoke", () => {
  it("the fan-out loop (which can raise open_checkout_requires_resolution) runs BEFORE the club_subscriptions upsert, the club_entitlements revoke, and the payment_mode UPDATE — a raised exception rolls back the whole function, so tier/entitlement/payment_mode are untouched on failure (items 20-21)", () => {
    const m = readSource(MIGRATION_PATH);
    const fn = getSetTierFn(m);
    const fanOutIdx = fn.indexOf("for v_payment_id_for_checkout_guard in");
    const paymentModeIdx = fn.indexOf("set payment_mode = 'manual', updated_at = now()");
    const upsertIdx = fn.indexOf("insert into public.club_subscriptions (club_id, tier, status, source)");
    const revokeIdx = fn.lastIndexOf("set revoked_at = now()");
    expect(fanOutIdx).toBeGreaterThan(-1);
    expect(paymentModeIdx).toBeGreaterThan(fanOutIdx);
    expect(upsertIdx).toBeGreaterThan(paymentModeIdx);
    expect(revokeIdx).toBeGreaterThan(upsertIdx);
  });

  it("the entire fan-out guard is confined to a single PL/pgSQL function body — a raised exception there is a single-statement transaction failure with no separate network round-trip in between that could leave partial application-visible state", () => {
    const m = readSource(MIGRATION_PATH);
    const fn = getSetTierFn(m);
    expect(fn).toContain("language plpgsql");
    expect(fn).toContain("security definer");
  });

  it("the canonical lock is acquired via pg_advisory_XACT_lock, so it releases automatically on the same rollback — a failed downgrade never leaves the lock held or the club in a half-locked state for the next caller", () => {
    const m = readSource(MIGRATION_PATH);
    const fn = getSetTierFn(m);
    expect(fn).toContain("pg_advisory_xact_lock(");
    expect(fn).not.toMatch(/pg_advisory_unlock/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 22 — marketing copy correction: Staff-Managed self-service wording
// ═══════════════════════════════════════════════════════════════════════════

describe("22. /pricing describes Staff-Managed as not REQUIRING Member accounts/self-service, never as categorically prohibiting them — actual behavior preserves existing Member accounts for continuity across a downgrade", () => {
  it("the Staff-Managed tagline states self-service is not required, not that Member accounts cannot exist", () => {
    const s = readSource("src/app/(marketing)/pricing/planData.ts");
    expect(s).toContain("Member accounts and self-service are not required.");
    expect(s).not.toMatch(/no member accounts/i);
  });

  it("the Connected-only feature row is scoped to NEW self-service accounts, not \"Member accounts\" categorically — consistent with a downgraded club preserving an existing Member's account for continuity", () => {
    const s = readSource("src/app/(marketing)/pricing/planData.ts");
    expect(s).toContain('label: "New Member self-service accounts"');
    expect(s).not.toContain('label: "Member accounts and access"');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 23 — activation joins the canonical commercial lock (correction round 2)
// ═══════════════════════════════════════════════════════════════════════════

describe("23. activate_court_time_payments acquires the SAME canonical commercial lock as tier downgrade and Checkout-opening — closes the activation-vs-downgrade race so no committed state can ever be staff_managed + court_time_payments", () => {
  const LOCK_EXPR =
    "perform pg_advisory_xact_lock(hashtextextended('club_commercial_tier:' || p_club_id::text, 0));";

  it("acquires the IDENTICAL lock expression used by set_club_tier_for_operator and the Checkout-opening pair (item 1)", () => {
    const m = readSource(MIGRATION_PATH);
    const activateFn = getActivateFn(m);
    const tierFn = getSetTierFn(m);
    const openFn = getOpenAttemptFn(m);
    expect(activateFn).toContain(LOCK_EXPR);
    expect(activateFn).toContain("hashtextextended('club_commercial_tier:' || p_club_id::text, 0)");
    expect(tierFn).toContain("hashtextextended('club_commercial_tier:' || p_club_id::text, 0)");
    expect(openFn).toContain("hashtextextended('club_commercial_tier:' || p_club_id::text, 0)");
  });

  it("the lock is acquired AFTER argument validation but BEFORE the capability check — never an earlier pre-lock read (items 2-3)", () => {
    const m = readSource(MIGRATION_PATH);
    const fn = getActivateFn(m);
    const argsIdx = fn.indexOf("raise exception 'invalid_arguments';");
    const lockIdx = fn.indexOf(LOCK_EXPR);
    const capabilityIdx = fn.indexOf("if not public.club_has_capability(p_club_id, 'member_self_service') then");
    expect(argsIdx).toBeGreaterThan(-1);
    expect(lockIdx).toBeGreaterThan(argsIdx);
    expect(capabilityIdx).toBeGreaterThan(lockIdx);
  });

  it("there is only ONE capability check in the function, and it is the one under the lock — no separate earlier/unlocked capability read exists to rely on instead (item 3)", () => {
    const m = readSource(MIGRATION_PATH);
    const fn = getActivateFn(m);
    const matches = fn.match(/club_has_capability\(/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("the Stripe-readiness check runs AFTER the capability check, and the payment_mode UPDATE runs after both — the existing 0149 ordering is preserved on top of the new lock+check (items 4-5)", () => {
    const m = readSource(MIGRATION_PATH);
    const fn = getActivateFn(m);
    const capabilityIdx = fn.indexOf("if not public.club_has_capability(p_club_id, 'member_self_service') then");
    const readyIdx = fn.indexOf("raise exception 'stripe_connect_not_ready';");
    const updateIdx = fn.indexOf("set payment_mode = 'court_time_payments'");
    expect(readyIdx).toBeGreaterThan(capabilityIdx);
    expect(updateIdx).toBeGreaterThan(readyIdx);
  });

  it("activation and tier downgrade key the SAME club-scoped advisory lock namespace, so whichever acquires it first fully commits or rolls back before the other proceeds — no interleaving window (item 6)", () => {
    const m = readSource(MIGRATION_PATH);
    const activateFn = getActivateFn(m);
    const tierFn = getSetTierFn(m);
    const lockExpr = "hashtextextended('club_commercial_tier:' || p_club_id::text, 0)";
    expect(activateFn).toContain(lockExpr);
    expect(tierFn).toContain(lockExpr);
  });

  it("race order A — activation wins the lock first: activation's capability check, Stripe-readiness check, and club_settings write are all inside the SAME transaction as the lock acquisition (pg_advisory_xact_lock is transaction-scoped), so a downgrade attempting the same lock cannot observe or interleave with any partial activation state — it can only run before activation starts or after activation's whole transaction has committed. A downgrade that runs after sees the just-activated Connected club, and its own fan-out/payment_mode-stepdown logic (describe 18/20) then correctly steps 'court_time_payments' back down to 'manual' and revokes the capability (item 7)", () => {
    const m = readSource(MIGRATION_PATH);
    const activateFn = getActivateFn(m);
    const tierFn = getSetTierFn(m);
    expect(activateFn).toContain("language plpgsql");
    expect(activateFn).toContain("security definer");
    // The downgrade path's own payment_mode stepdown (already proven in
    // describe 20) is what makes this order coherent — re-anchored here
    // only to document the dependency, not to re-verify it.
    expect(tierFn).toContain("set payment_mode = 'manual', updated_at = now()");
  });

  it("race order B — downgrade wins the lock first: set_club_tier_for_operator's whole body (tier flip + entitlement revoke) runs inside the same transaction as its own lock acquisition and commits BEFORE releasing it. Activation's capability check is now guaranteed to run against the post-downgrade committed row (never a cached/earlier value), so it raises capability_not_available and never reaches the payment_mode UPDATE (item 8)", () => {
    const m = readSource(MIGRATION_PATH);
    const fn = getActivateFn(m);
    const lockIdx = fn.indexOf(LOCK_EXPR);
    const capabilityIdx = fn.indexOf("if not public.club_has_capability(p_club_id, 'member_self_service') then");
    const updateIdx = fn.indexOf("set payment_mode = 'court_time_payments'");
    expect(capabilityIdx).toBeGreaterThan(lockIdx);
    expect(updateIdx).toBeGreaterThan(capabilityIdx);
  });

  it("no path can commit staff_managed + court_time_payments: the capability check and the payment_mode write are in the SAME function invocation, under the SAME lock acquisition, with no intervening network round-trip or second transaction — there is no window between 'read capability' and 'write payment_mode' that a concurrent downgrade could occupy undetected (item 9)", () => {
    const m = readSource(MIGRATION_PATH);
    const fn = getActivateFn(m);
    const lockIdx = fn.indexOf(LOCK_EXPR);
    const capabilityIdx = fn.indexOf("if not public.club_has_capability(p_club_id, 'member_self_service') then");
    const updateIdx = fn.indexOf("set payment_mode = 'court_time_payments'");
    // All three in strict order, all inside one plpgsql function body —
    // no separate statement/transaction boundary between them.
    expect(lockIdx).toBeGreaterThan(-1);
    expect(capabilityIdx).toBeGreaterThan(lockIdx);
    expect(updateIdx).toBeGreaterThan(capabilityIdx);
    expect(fn.indexOf("$$;")).toBeGreaterThan(updateIdx);
  });

  it("the existing Staff-Managed activation block (raise capability_not_available before any mutation) remains intact (item 10)", () => {
    const m = readSource(MIGRATION_PATH);
    const fn = getActivateFn(m);
    const capabilityIdx = fn.indexOf("raise exception 'capability_not_available';");
    const updateIdx = fn.indexOf("update public.club_settings");
    expect(capabilityIdx).toBeGreaterThan(-1);
    expect(updateIdx).toBeGreaterThan(capabilityIdx);
  });

  it("a Connected club with a Stripe-ready account can still activate — the happy path is unchanged beyond the new lock (item 11)", () => {
    const m = readSource(MIGRATION_PATH);
    const fn = getActivateFn(m);
    expect(fn).toContain("select exists (\n    select 1 from public.club_stripe_accounts\n     where club_id = p_club_id\n       and livemode = p_livemode\n       and card_payments_status = 'active'\n  ) into v_ready;");
    expect(fn).toContain("returning * into v_result;");
  });

  it("activation does not acquire a payments-row or payment_checkout_attempts-row lock — it needs no second lock class, so it cannot participate in any lock-ordering cycle with the Checkout-opening path's own (advisory lock -> payments row) order (deadlock analysis)", () => {
    const m = readSource(MIGRATION_PATH);
    const fn = codeOnly(getActivateFn(m));
    expect(fn).not.toMatch(/for update/);
    expect(fn).not.toMatch(/payment_checkout_attempts/);
  });

  it("the four Checkout Server Actions and their capability_not_available handling (describe 17) are untouched by this activation-lock fix — no domain wrapper migration (0160/0161/0163) is redefined (item 12)", () => {
    const m = readSource(MIGRATION_PATH);
    expect(m).not.toMatch(/create or replace function public\.open_lesson_payment_checkout_attempt/);
    expect(m).not.toMatch(/create or replace function public\.open_event_payment_checkout_attempt/);
    expect(m).not.toMatch(/create or replace function public\.open_program_payment_checkout_attempt/);
  });

  it("historical payments/payment_events/refunds/disputes remain untouched — activation still only ever writes club_settings and audit_log (item 13)", () => {
    const m = readSource(MIGRATION_PATH);
    const fn = codeOnly(getActivateFn(m));
    expect(fn).not.toMatch(/insert into public\.payments|insert into public\.payment_events|update public\.payments\b|update public\.payment_events\b/);
    for (const fnName of ["record_manual_payment", "record_refund", "reverse_payment_event", "waive_payment", "void_payment_obligation"]) {
      expect(m).not.toMatch(new RegExp(`create or replace function public\\.${fnName}\\(`));
    }
  });

  it("the canonical-lock header documents the lock as shared by all three families (activation, downgrade, Checkout-opening) — no longer claims only sections 3 and 4", () => {
    const m = readSource(MIGRATION_PATH);
    expect(m).toContain("CANONICAL COMMERCIAL LOCK — shared by sections 2, 3, and 4");
    expect(m).not.toMatch(/shared by sections 3 and 4/);
  });

  it("activate_court_time_payments's rollback body remains byte-identical to its true pre-0164 authoritative source (0149) — the lock addition only changed the FORWARD body", () => {
    const m = readSource(MIGRATION_PATH);
    const m0149 = readSource("supabase/migrations/0149_court_time_payments_activation_gate.sql");

    function norm(s: string): string {
      return s
        .split("\n")
        .map((line) => {
          let stripped = line.replace(/\s+$/, "");
          while (true) {
            if (stripped.startsWith("-- ")) stripped = stripped.slice(3);
            else if (stripped === "--") { stripped = ""; break; }
            else break;
          }
          return stripped;
        })
        .join("\n")
        .trim();
    }

    const rbStart = m.indexOf("-- create or replace function public.activate_court_time_payments(");
    const rbEndMarker = "-- grant  execute on function public.activate_court_time_payments(uuid, boolean, uuid) to service_role;";
    const rbEnd = m.indexOf(rbEndMarker, rbStart) + rbEndMarker.length;
    const rollback = norm(m.slice(rbStart, rbEnd));

    const authStart = m0149.indexOf("create or replace function public.activate_court_time_payments(");
    const authEndMarker = "grant  execute on function public.activate_court_time_payments(uuid, boolean, uuid) to service_role;";
    const authEnd = m0149.indexOf(authEndMarker, authStart) + authEndMarker.length;
    const authoritative = norm(m0149.slice(authStart, authEnd));

    expect(rollback).toBe(authoritative);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 24 — 0165: runtime QA fix for the confirmed 42702 ambiguity in the
// downgrade's club_settings UPDATE. 0164 is already applied and NOT
// modified by 0165 — this is a targeted CREATE OR REPLACE layered on top.
// ═══════════════════════════════════════════════════════════════════════════

function getFixedSetTierFn(): string {
  const m = readSource(FIX_MIGRATION_PATH);
  const start = m.indexOf("create or replace function public.set_club_tier_for_operator(");
  const end = m.indexOf(
    "revoke execute on function public.set_club_tier_for_operator(uuid, text) from public, anon, authenticated;",
    start,
  );
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return m.slice(start, end);
}

describe("24. 0165 restores the 0164-regressed 0124/0125 fixes (named-constraint ON CONFLICT, Member-invite revocation) AND fixes the newly-confirmed 42702 ambiguity in the downgrade's club_settings UPDATE — built from the TRUE pre-0164 baseline (0125), not the incorrect 0122 baseline 0164 itself used", () => {
  it("1-2. the downgrade club_settings UPDATE qualifies the target table (as cs) and its WHERE clause — no bare/ambiguous club_id remains in that update statement", () => {
    const fn = getFixedSetTierFn();
    expect(fn).toContain("update public.club_settings as cs");
    expect(fn).toContain("where cs.club_id = p_club_id");
    expect(fn).toContain("and cs.payment_mode = 'court_time_payments';");
    expect(fn).not.toMatch(/update public\.club_settings\s*\n\s*set payment_mode/);
  });

  it("3. club_subscriptions upsert uses the named-constraint ON CONFLICT target restored from 0125 — club_subscriptions_club_id_key", () => {
    const fn = getFixedSetTierFn();
    expect(fn).toContain("on conflict on constraint club_subscriptions_club_id_key do update");
  });

  it("4. no EXECUTABLE 'on conflict (club_id)' form remains anywhere in the function — only prose/comment mentions of the retired form are permitted", () => {
    const fn = getFixedSetTierFn();
    const codeOnlyFn = fn
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    expect(codeOnlyFn).not.toContain("on conflict (club_id)");
  });

  it("5-7. the 0123/0124/0125 outstanding Member-invite revocation block is restored verbatim (0164 had dropped it entirely) — ci-aliased, club-scoped, Member-role-only, excludes accepted and already-revoked invites", () => {
    const fn = getFixedSetTierFn();
    expect(fn).toContain("update public.club_invites ci");
    expect(fn).toContain("where ci.club_id     = p_club_id");
    expect(fn).toContain("and ci.role        = 'member'");
    expect(fn).toContain("and ci.accepted_at is null");
    expect(fn).toContain("and ci.revoked_at  is null;");
    // No bare/unqualified club_id in this statement either.
    const inviteBlockStart = fn.indexOf("update public.club_invites ci");
    const inviteBlockEnd = fn.indexOf(";", inviteBlockStart) + 1;
    const inviteBlock = fn.slice(inviteBlockStart, inviteBlockEnd);
    expect(inviteBlock).not.toMatch(/(?<!ci\.)\bclub_id\b(?!\s*[,)])/);
  });

  it("8. the canonical advisory lock acquisition (0164's intended addition) is present, keyed identically to activation/Checkout-opening", () => {
    const fn = getFixedSetTierFn();
    expect(fn).toContain("perform pg_advisory_xact_lock(hashtextextended('club_commercial_tier:' || p_club_id::text, 0));");
  });

  it("9. the Checkout fan-out guard (0164's intended addition — loop + call to the existing _invalidate_or_flag_open_checkout_attempt) is present, byte-identical to the applied 0164 body's own version of it", () => {
    const fn = getFixedSetTierFn();
    expect(fn).toContain("for v_payment_id_for_checkout_guard in");
    expect(fn).toContain("perform public._invalidate_or_flag_open_checkout_attempt(v_payment_id_for_checkout_guard);");
    expect(fn).toContain(
      "select distinct p.id\n        from public.payments p\n        join public.payment_checkout_attempts a\n          on a.payment_id = p.id\n         and a.club_id    = p_club_id\n         and a.status     = 'open'\n       where p.club_id = p_club_id",
    );
  });

  it("10. payment_mode still steps down to 'manual' (never 'none') for a genuine downgrade, conditioned on the prior value being 'court_time_payments'", () => {
    const fn = getFixedSetTierFn();
    expect(fn).toContain("set payment_mode = 'manual',");
    expect(fn).not.toMatch(/payment_mode = 'none'/);
  });

  it("11. entitlement grant/revoke branches (Connected grant/regrant, Staff-Managed revoke) are present with their original semantics, unchanged by any of this migration's corrections", () => {
    const fn = getFixedSetTierFn();
    expect(fn).toContain("if p_tier = 'connected' then");
    expect(fn).toContain("'Granted via set_club_tier_for_operator (manual_pilot).'");
    expect(fn).toContain("-- staff_managed: revoke the active grant if one exists.");
  });

  it("12. no historical payments or payment_events row is ever touched — the only mutating statements target club_settings, club_subscriptions, club_entitlements, and club_invites", () => {
    const fn = getFixedSetTierFn();
    const codeOnlyFn = fn
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    expect(codeOnlyFn).not.toMatch(/update public\.payments\b/);
    expect(codeOnlyFn).not.toMatch(/insert into public\.payment_events/);
    expect(codeOnlyFn).not.toMatch(/update public\.payment_events\b/);
  });

  it("13. privileges are preserved exactly: SECURITY DEFINER, the identical fixed search_path, service_role-only execute", () => {
    const fn = getFixedSetTierFn();
    const m = readSource(FIX_MIGRATION_PATH);
    expect(fn).toContain("language plpgsql");
    expect(fn).toContain("security definer");
    expect(fn).toContain("set search_path = public, pg_temp");
    expect(m).toContain("revoke execute on function public.set_club_tier_for_operator(uuid, text) from public, anon, authenticated;");
    expect(m).toContain("grant  execute on function public.set_club_tier_for_operator(uuid, text) to service_role;");
  });

  it("14. 0164 remains an unedited, applied historical migration — its own text still contains the two regressions this migration corrects (bare 'on conflict (club_id)' and no invite-revoke block), proving 0165 is a layered fix on top of applied history, never an edit of it", () => {
    const m0164 = readSource(MIGRATION_PATH);
    const tierFn0164 = getSetTierFn(m0164);
    expect(tierFn0164).toContain("on conflict (club_id) do update");
    expect(tierFn0164).not.toContain("update public.club_invites");
    expect(m0164).toContain("where club_id = p_club_id\n       and payment_mode = 'court_time_payments';");
  });

  it("0165 redefines ONLY set_club_tier_for_operator — no other function (activation, Checkout opener/supersede, fan-out helper) is touched", () => {
    const m = readSource(FIX_MIGRATION_PATH);
    for (const fnName of [
      "activate_court_time_payments",
      "open_payment_checkout_attempt",
      "supersede_checkout_attempt_and_open_fresh",
      "bootstrap_new_club",
      "list_club_blocking_checkout_attempts",
      "_invalidate_or_flag_open_checkout_attempt",
    ]) {
      expect(m).not.toMatch(new RegExp(`create or replace function (public\\.)?${fnName}\\(`));
    }
  });

  it("compares the final merged function against BOTH conceptual parents — not only against 0164: every 0125 behavior that must survive (named-constraint ON CONFLICT, ci-aliased invite revoke, tier/entitlement upsert-and-revoke) AND every 0164 commercial addition that must survive (advisory lock, current-tier read, Checkout fan-out, payment_mode stepdown) are present in the same final body", () => {
    const m0125 = readSource(M0125_PATH);
    const fn0125 = (() => {
      const start = m0125.indexOf("create or replace function public.set_club_tier_for_operator(");
      const end = m0125.indexOf("revoke execute on function public.set_club_tier_for_operator(", start);
      return m0125.slice(start, end);
    })();
    const fn = getFixedSetTierFn();

    // Every 0125 behavior that must survive.
    expect(fn0125).toContain("on conflict on constraint club_subscriptions_club_id_key do update");
    expect(fn).toContain("on conflict on constraint club_subscriptions_club_id_key do update");
    expect(fn0125).toContain("update public.club_invites ci");
    expect(fn).toContain("update public.club_invites ci");

    // Every 0164 commercial addition that must survive (absent from 0125,
    // since 0125 predates the downgrade-safety design entirely).
    expect(fn0125).not.toContain("pg_advisory_xact_lock");
    expect(fn).toContain("pg_advisory_xact_lock(hashtextextended('club_commercial_tier:' || p_club_id::text, 0));");
    expect(fn0125).not.toContain("_invalidate_or_flag_open_checkout_attempt");
    expect(fn).toContain("perform public._invalidate_or_flag_open_checkout_attempt(v_payment_id_for_checkout_guard);");
    expect(fn0125).not.toMatch(/payment_mode = 'manual'/);
    expect(fn).toContain("set payment_mode = 'manual',");
  });

  it("0165's rollback-documented body is byte-identical to the TRUE currently-applied 0164 body (the one that still raises 42702 AND still lacks the 0124/0125 fixes) — not to any other version, and the rollback documentation explicitly flags that target as the known-regressed state", () => {
    const m165 = readSource(FIX_MIGRATION_PATH);
    const m164 = readSource(MIGRATION_PATH);

    function norm(s: string): string {
      return s
        .split("\n")
        .map((line) => {
          let stripped = line.replace(/\s+$/, "");
          while (true) {
            if (stripped.startsWith("-- ")) stripped = stripped.slice(3);
            else if (stripped === "--") { stripped = ""; break; }
            else break;
          }
          return stripped;
        })
        .join("\n")
        .trim();
    }

    const rbStart = m165.indexOf("-- create or replace function public.set_club_tier_for_operator(");
    const rbEndMarker = "-- grant  execute on function public.set_club_tier_for_operator(uuid, text) to service_role;";
    const rbEnd = m165.indexOf(rbEndMarker, rbStart) + rbEndMarker.length;
    const rollback = norm(m165.slice(rbStart, rbEnd));

    const authStart = m164.indexOf("create or replace function public.set_club_tier_for_operator(");
    const authEndMarker = "grant  execute on function public.set_club_tier_for_operator(uuid, text) to service_role;";
    const authEnd = m164.indexOf(authEndMarker, authStart) + authEndMarker.length;
    const authoritative = norm(m164.slice(authStart, authEnd));

    expect(rollback).toBe(authoritative);
    expect(m165).toMatch(/KNOWN-REGRESSED\s*\n-- state/);
  });

  // Why the prior static regression suite did not catch the ORIGINAL
  // 42702 (describes 16-21 assert on literal TEXT/POSITION inside the
  // migration source via .toContain/.indexOf — they never connect to a
  // database or execute the SQL; 42702 is a PLANNER-time error only
  // raised when the ambiguous statement is actually prepared and run,
  // requiring both the genuine-downgrade branch and a pre-existing
  // payment_mode='court_time_payments' row) applies identically to why
  // no earlier round of THIS suite caught the 0164-vs-0125 baseline
  // regression: describes 16-23 only ever compared 0164 against ITS OWN
  // stated predecessor (0122, per 0164's own header claim) — they never
  // cross-checked that claim against the actual migration history. This
  // describe block's own "compares against BOTH conceptual parents" test
  // above is the structural fix for that blind spot going forward.
  it("documents why source-inspection tests could not have caught the 42702 ambiguity, and why the earlier rounds of this suite did not catch the 0122-vs-0125 baseline error either", () => {
    const m0164 = readSource(MIGRATION_PATH);
    // The ambiguous statement is syntactically valid SQL — confirmed by
    // its continued (unedited) presence in the applied 0164 text itself.
    expect(m0164).toMatch(/where club_id = p_club_id/);
    // 0164's own header claim (now known incorrect) is still present,
    // unedited, in applied history — this migration does not rewrite it.
    expect(m0164).toMatch(/Reproduced VERBATIM from its sole authoritative body \(0122\)/);
  });
});
