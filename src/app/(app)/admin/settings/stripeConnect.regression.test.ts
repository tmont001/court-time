import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase 34D-A — regression coverage for the exact runtime failure
// observed: clicking "Connect with Stripe" called POST /v1/accounts,
// which Stripe rejected (400 invalid_request_error) because new Connect
// integrations must use POST /v2/core/accounts instead. These tests read
// the actual shipped source of the feature's Stripe-calling files (not a
// mock/reimplementation) and assert the v1 call shape is structurally
// absent and the v2 call shape is present, plus that the unrelated
// court_time_payments locks and the 0147 mode/immutability invariants
// this checkpoint depends on are still intact.
//
// This is a static-source style of test rather than a live-network one
// because this repository's test baseline is deliberately pure-TypeScript
// with no jsdom/Supabase/network mocking (see vitest.config.mts) — for a
// "which SDK call shape did we use" question, reading the real shipped
// source is a more honest regression guard than reimplementing a mock
// Stripe client that could silently drift from the real SDK's shape.

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const STRIPE_CALLING_FILES = [
  "src/app/(app)/admin/settings/stripeConnectActions.ts",
  "src/app/(app)/admin/settings/stripeConnectShared.ts",
  "src/app/api/stripe/connect/refresh/route.ts",
  "src/app/api/stripe/connect/return/route.ts",
  "src/app/api/stripe/connect/account-events/route.ts",
];

describe("Stripe Connect v2 regression guardrail", () => {
  it("no 34D-A file calls the Accounts v1 create method (stripe.accounts.create) — every .accounts.create( call is .v2.core.accounts.create(", () => {
    for (const file of STRIPE_CALLING_FILES) {
      const src = readSource(file);
      const total = countOccurrences(src, ".accounts.create(");
      const v2 = countOccurrences(src, ".v2.core.accounts.create(");
      expect(total, `${file}: every .accounts.create( call must be .v2.core.accounts.create(`).toBe(v2);
    }
  });

  it("every accountLinks.create call in 34D-A goes through the v2 namespace, never the v1 shape", () => {
    for (const file of STRIPE_CALLING_FILES) {
      const src = readSource(file);
      const total = countOccurrences(src, ".accountLinks.create(");
      const v2 = countOccurrences(src, ".v2.core.accountLinks.create(");
      expect(total, `${file}: every .accountLinks.create( call must be .v2.core.accountLinks.create(`).toBe(v2);
    }
  });

  it("account creation is invoked through the v2 namespace", () => {
    const src = readSource("src/app/(app)/admin/settings/stripeConnectActions.ts");
    expect(src).toContain(".v2.core.accounts.create(");
  });

  it("account retrieval (for status sync) is invoked through the v2 namespace", () => {
    const src = readSource("src/app/(app)/admin/settings/stripeConnectShared.ts");
    expect(src).toContain(".v2.core.accounts.retrieve(");
  });

  it("no 34D-A file reads/writes Accounts v1's charges_enabled/details_submitted as actual code (property access or object keys) — explanatory prose contrasting v1 vs v2 is fine", () => {
    // Matches real code usage (`.charges_enabled`, `charges_enabled:`,
    // `charges_enabled =`), not prose mentioning the field names to
    // explain their absence.
    const codeUsage = /(\.charges_enabled\b|\bcharges_enabled\s*[:=])|(\.details_submitted\b|\bdetails_submitted\s*[:=])/;
    for (const file of [...STRIPE_CALLING_FILES, "src/app/(app)/admin/settings/StripeConnectSection.tsx"]) {
      const src = readSource(file);
      expect(src, `${file} must not read/write v1's charges_enabled/details_submitted as code`).not.toMatch(codeUsage);
    }
  });

  it("no PaymentIntent, Checkout, or application_fee code exists anywhere in 34D-A/34D-B", () => {
    for (const file of [...STRIPE_CALLING_FILES, "src/app/(app)/admin/settings/StripeConnectSection.tsx", "src/lib/stripe/server.ts", "src/lib/stripe/connectConfig.ts"]) {
      const src = readSource(file);
      expect(src, `${file} must not reference PaymentIntent`).not.toMatch(/PaymentIntent/);
      expect(src, `${file} must not reference checkout`).not.toMatch(/checkout/i);
      expect(src, `${file} must not reference application_fee`).not.toMatch(/application_fee|applicationFee/);
    }
  });
});

describe("account-events webhook route — orchestration contract (Phase 34D-B)", () => {
  const route = () => readSource("src/app/api/stripe/connect/account-events/route.ts");

  it("requires the Stripe-Signature header before doing anything else", () => {
    const src = route();
    expect(src).toMatch(/headers\.get\(["']stripe-signature["']\)/);
    expect(src).toMatch(/if \(!signature\)/);
  });

  it("reads the raw body via request.text(), never actually calls request.json() (which could alter the signed bytes)", () => {
    const src = route();
    expect(src).toContain("await request.text()");
    // Real code usage would be `request.json()` or `await request.json()` —
    // not present anywhere as an actual call; the file's own explanatory
    // comment mentions the phrase "request.json()" in prose, which is fine.
    expect(src).not.toMatch(/[^/]\s*await request\.json\(\)|=\s*request\.json\(\)/);
  });

  it("verifies the signature via the SDK's parseEventNotification, never trusting the body first", () => {
    const src = route();
    expect(src).toContain(".parseEventNotification(rawBody, signature, webhookSecret)");
  });

  it("only acts on the two locked event types — every other valid, verified event is a safe 200 no-op", () => {
    const src = route();
    expect(src).toContain("SUPPORTED_ACCOUNT_LIFECYCLE_EVENT_TYPES[0]");
    expect(src).toContain("SUPPORTED_ACCOUNT_LIFECYCLE_EVENT_TYPES[1]");
  });

  it("re-fetches the full versioned Event via the SDK using the verified notification's own id, rather than trusting the thin body's own fields directly", () => {
    const src = route();
    expect(src).toContain("notification.fetchEvent()");
  });

  it("re-retrieves current Account state with configuration.merchant included, via the same shared params 34D-A's return route uses", () => {
    const src = route();
    expect(src).toContain(".v2.core.accounts.retrieve(accountId, CONNECT_ACCOUNT_RETRIEVE_PARAMS)");
  });

  it("derives card_payments_status via the shared extractCardPaymentsStatus helper — never reads a status field directly off the webhook body", () => {
    const src = route();
    expect(src).toContain("extractCardPaymentsStatus(account)");
    expect(src).not.toMatch(/notification\.data/);
  });

  it("passes event.livemode (from the verified event) into the RPC — never a client/query-supplied value", () => {
    const src = route();
    expect(src).toContain("p_livemode: event.livemode");
    expect(src).not.toMatch(/searchParams/);
    expect(src).not.toMatch(/req\.query/);
  });

  it("persists through the narrow service-role RPC boundary, not a direct table write", () => {
    const src = route();
    expect(src).toContain('.rpc("process_stripe_connect_account_event"');
    expect(src).not.toMatch(/\.from\(["']stripe_event_receipts["']\)/);
    expect(src).not.toMatch(/\.from\(["']club_stripe_accounts["']\)/);
  });

  it("fails closed (does not proceed) when its own webhook secret or Stripe key is unconfigured", () => {
    const src = route();
    expect(src).toMatch(/STRIPE_CONNECT_ACCOUNT_WEBHOOK_SECRET/);
    expect(src).toMatch(/if \(!webhookSecret\)/);
    expect(src).toMatch(/if \(!context\)/);
  });
});

describe("court_time_payments locks — 0143's own original definitions (historical, unchanged files)", () => {
  it("update_club_payment_mode still rejects court_time_payments directly (0143, unchanged, still the none/manual path only)", () => {
    const src = readSource("supabase/migrations/0143_payment_mode_and_ledger_foundation.sql");
    expect(src).toContain("court_time_payments_not_available");
  });

  it("0143's OWN original _create_payment_obligation body only acted on manual mode — a historical fact this file's own text still accurately describes (0149 supersedes it for the live system; see the 0149 describe block below)", () => {
    const src = readSource("supabase/migrations/0143_payment_mode_and_ledger_foundation.sql");
    expect(src).toContain("if v_mode is distinct from 'manual' then");
  });
});

describe("0147 migration — mode scoping and financial-identity immutability invariants", () => {
  const migration = () => readSource("supabase/migrations/0147_stripe_connect_account_foundation.sql");

  it("uses unique(club_id, livemode), not unique(club_id) alone", () => {
    expect(migration()).toContain("unique (club_id, livemode)");
  });

  it("keeps stripe_account_id globally unique", () => {
    expect(migration()).toContain("unique (stripe_account_id)");
  });

  it("never assigns stripe_account_id in the upsert's ON CONFLICT SET clause", () => {
    const src = migration();
    const onConflictBlock = src.slice(src.indexOf("on conflict (club_id, livemode) do update"), src.indexOf("stripe_account_mismatch"));
    expect(onConflictBlock).not.toMatch(/set[\s\S]*stripe_account_id\s*=/);
  });

  it("fails closed with stripe_account_mismatch when the conflicting row's account id differs", () => {
    const src = migration();
    expect(src).toContain("where public.club_stripe_accounts.stripe_account_id = excluded.stripe_account_id");
    expect(src).toContain("raise exception 'stripe_account_mismatch'");
  });

  it("all three RPCs are service-role-only, never authenticated-callable", () => {
    const src = migration();
    expect(src).toContain("grant  execute on function public.get_club_stripe_connect_status(uuid, boolean) to service_role;");
    expect(src).toContain("grant  execute on function public.get_club_stripe_account_ref(uuid, boolean) to service_role;");
    expect(src).toContain("grant  execute on function public.upsert_club_stripe_account(uuid, text, text, uuid, boolean) to service_role;");
    expect(src).not.toMatch(/grant\s+execute on function public\.(get_club_stripe_connect_status|get_club_stripe_account_ref|upsert_club_stripe_account).*to authenticated/);
  });

  it("uses the Accounts v2 readiness vocabulary (card_payments_status) as an actual column, not v1 fields", () => {
    const src = migration();
    expect(src).toContain("card_payments_status");
    // Real column/parameter definitions look like `charges_enabled     boolean`
    // — this must be structurally absent. Explanatory prose contrasting
    // v1 vs v2 (e.g. "no v1-style charges_enabled/details_submitted
    // pair") is fine and expected.
    expect(src).not.toMatch(/charges_enabled\s+boolean/);
    expect(src).not.toMatch(/details_submitted\s+boolean/);
  });

  it("0147 exists and is a distinct file from 0148 (Phase 34D-B's lifecycle-events migration)", () => {
    // Guards against a stray migration number regression, not a full
    // directory scan (out of scope for a pure-TS test with no fs.readdir
    // policy elsewhere in this suite) — the file must at least exist at
    // this exact path.
    expect(() => migration()).not.toThrow();
  });
});

describe("0148 migration — Phase 34D-B lifecycle event idempotency and safety invariants", () => {
  const migration = () => readSource("supabase/migrations/0148_stripe_connect_lifecycle_events.sql");

  it("exists as its own migration — 34D-B does not rewrite 0147", () => {
    expect(() => migration()).not.toThrow();
  });

  it("does not touch payment_events — this is technical webhook infrastructure, not the financial ledger", () => {
    const src = migration();
    expect(src).not.toMatch(/create table public\.payment_events/);
    expect(src).not.toMatch(/insert into public\.payment_events/);
  });

  it("deduplicates on stripe_event_id via a primary key + ON CONFLICT DO NOTHING", () => {
    const src = migration();
    expect(src).toContain("stripe_event_id    text        primary key");
    expect(src).toContain("on conflict (stripe_event_id) do nothing;");
  });

  it("never inserts a new club_stripe_accounts row — only updates an existing one matching both stripe_account_id and livemode", () => {
    const src = migration();
    expect(src).not.toMatch(/insert into public\.club_stripe_accounts/);
    expect(src).toMatch(/update public\.club_stripe_accounts[\s\S]*where stripe_account_id = p_stripe_account_id\s*\n\s*and livemode\s*=\s*p_livemode/);
  });

  it("does not store full Stripe payloads or secrets — only the documented minimum columns", () => {
    const src = migration();
    expect(src).toMatch(/create table public\.stripe_event_receipts \(\s*\n\s*stripe_event_id/);
    expect(src).not.toMatch(/payload\s+jsonb/);
    expect(src).not.toMatch(/\bsecret\b\s+text/);
    expect(src).not.toMatch(/raw_body/);
  });

  it("the lifecycle RPC is service-role-only, never authenticated-callable", () => {
    const src = migration();
    expect(src).toContain(
      "grant  execute on function public.process_stripe_connect_account_event(text, text, boolean, text, text) to service_role;",
    );
    expect(src).not.toMatch(/grant\s+execute on function public\.process_stripe_connect_account_event.*to authenticated/);
  });

  it("stripe_event_receipts is deny-all RLS, identical discipline to club_stripe_accounts (0147)", () => {
    const src = migration();
    expect(src).toContain("alter table public.stripe_event_receipts enable row level security;");
    expect(src).toContain("revoke all on public.stripe_event_receipts from public, anon, authenticated;");
  });

  it("card_payments_status parameter accepts a value (validated against Stripe's own four documented values inside the RPC too — see below)", () => {
    const src = migration();
    expect(src).toContain("p_card_payments_status text");
  });

  // Pre-apply correction: an unknown-account/livemode-mismatch first
  // delivery must be RETRYABLE (roll back its receipt, fail the RPC),
  // never a permanently recorded no-op.
  it("stripe_account_id is NOT NULL — a row only ever exists for a genuinely matched event", () => {
    const src = migration();
    expect(src).toContain("stripe_account_id  text        not null,");
  });

  it("raises stripe_account_not_found (not a silent no-op) when the UPDATE matches zero rows, so the caller/route can retry", () => {
    const src = migration();
    expect(src).toContain("raise exception 'stripe_account_not_found';");
    // The exception must be reachable from the UPDATE's own `if not found`
    // branch, not just present somewhere in a comment.
    expect(src).toMatch(/if not found then\s*\n[\s\S]{0,400}raise exception 'stripe_account_not_found';/);
  });

  it("the exception is raised AFTER the event-receipt INSERT, in the same function call, so Postgres rolls the INSERT back too", () => {
    const src = migration();
    const insertIndex = src.indexOf("insert into public.stripe_event_receipts");
    const updateIndex = src.indexOf("update public.club_stripe_accounts");
    const raiseIndex = src.indexOf("raise exception 'stripe_account_not_found';");
    expect(insertIndex).toBeGreaterThan(-1);
    expect(updateIndex).toBeGreaterThan(insertIndex);
    expect(raiseIndex).toBeGreaterThan(updateIndex);
  });

  it("never claims an unmatched event was successfully receipted/no-op'd — no stale comment language remains", () => {
    const src = migration();
    expect(src).not.toMatch(/still records? a receipt/);
    expect(src).not.toMatch(/still gets a receipt/);
    expect(src).not.toMatch(/receipted as no-?op/i);
  });

  it("a duplicate delivery returns already_processed=true and never re-runs the UPDATE", () => {
    const src = migration();
    const notNewBlock = src.slice(src.indexOf("if not v_new_receipt then"), src.indexOf("update public.club_stripe_accounts"));
    expect(notNewBlock).toContain("return query select true, true;");
    expect(notNewBlock).toContain("return;");
  });

  it("validates p_event_type against exactly the two locked event types, failing closed otherwise", () => {
    const src = migration();
    expect(src).toMatch(
      /if p_event_type not in \(\s*\n\s*'v2\.core\.account\[requirements\]\.updated',\s*\n\s*'v2\.core\.account\[configuration\.merchant\]\.capability_status_updated'\s*\n\s*\) then\s*\n\s*raise exception 'invalid_event_type';/,
    );
  });

  it("validates p_card_payments_status against exactly Stripe's four documented values, failing closed otherwise", () => {
    const src = migration();
    expect(src).toContain(
      "if p_card_payments_status not in ('active', 'pending', 'restricted', 'unsupported') then",
    );
    expect(src).toContain("raise exception 'invalid_card_payments_status';");
  });
});

describe("0149 migration — Phase 34D-C activation gate invariants", () => {
  const migration = () => readSource("supabase/migrations/0149_court_time_payments_activation_gate.sql");

  it("exists as its own migration and does not touch 0143-0148 (diff-empty, verified separately via git diff --stat)", () => {
    expect(() => migration()).not.toThrow();
  });

  it("activate_court_time_payments checks a row matching BOTH club_id and livemode — never 'any active row for this club' regardless of environment", () => {
    const src = migration();
    expect(src).toMatch(
      /select 1 from public\.club_stripe_accounts\s*\n\s*where club_id = p_club_id\s*\n\s*and livemode = p_livemode\s*\n\s*and card_payments_status = 'active'/,
    );
  });

  it("raises stripe_connect_not_ready (a stable, UI-mappable error) when not ready", () => {
    const src = migration();
    expect(src).toMatch(/if not v_ready then\s*\n\s*raise exception 'stripe_connect_not_ready';/);
  });

  it("activate_court_time_payments is service-role-only — never authenticated-callable, so no client-supplied p_livemode can bypass the gate", () => {
    const src = migration();
    expect(src).toContain(
      "revoke execute on function public.activate_court_time_payments(uuid, boolean, uuid) from public, anon, authenticated;",
    );
    expect(src).toContain(
      "grant  execute on function public.activate_court_time_payments(uuid, boolean, uuid) to service_role;",
    );
  });

  it("does not redefine update_club_payment_mode — the none/manual (downgrade) path stays exactly as 0143 defined it", () => {
    const src = migration();
    expect(src).not.toMatch(/create (or replace )?function public\.update_club_payment_mode/);
  });

  it("widens _create_payment_obligation's mode gate to manual and court_time_payments using IS DISTINCT FROM, never NOT IN", () => {
    const src = migration();
    expect(src).toContain(
      "if v_mode is distinct from 'manual'\n     and v_mode is distinct from 'court_time_payments' then",
    );
    // Regression: `v_mode not in ('manual', 'court_time_payments')` is a
    // real bug for a null/unrecognized v_mode — SQL's NOT IN evaluates to
    // NULL (not true) against a null left-hand side, so the `if` would be
    // falsy and execution would fall through instead of returning null.
    // IS DISTINCT FROM has no such NULL trap. Matches actual code usage
    // (the `if` statement), not the file's own explanatory prose above.
    expect(src).not.toMatch(/if\s+v_mode\s+not in\s*\(/);
  });

  it("excludes event_guest from court_time_payments — only manual mode may create an obligation for that domain type", () => {
    const src = migration();
    expect(src).toMatch(
      /if v_mode = 'court_time_payments' and p_domain_type = 'event_guest' then\s*\n\s*return null;\s*\n\s*end if;/,
    );
  });

  it("the event_guest carve-out is a plain return-null no-op — no new exception type, matching every caller's use of `perform` to discard the return value", () => {
    const src = migration();
    const fnBody = src.slice(
      src.indexOf("create or replace function public._create_payment_obligation"),
      src.indexOf("revoke all on function public._create_payment_obligation"),
    );
    // Exactly the two pre-existing raised exceptions from 0143
    // (event_guest_must_not_have_roster_member_id, roster_member_id_required,
    // cross_club_roster_member_not_allowed) — no new exception name added
    // for the court_time_payments/event_guest exclusion.
    expect(countOccurrences(fnBody, "raise exception")).toBe(3);
    expect(fnBody).not.toMatch(/raise exception 'event_guest.*court_time/i);
  });

  it("the event_guest carve-out runs BEFORE the pre-existing event_guest roster_member_id validation, so it short-circuits cleanly for court_time_payments", () => {
    const src = migration();
    const carveOutIndex = src.indexOf("if v_mode = 'court_time_payments' and p_domain_type = 'event_guest' then");
    const validationIndex = src.indexOf("if p_domain_type = 'event_guest' then");
    expect(carveOutIndex).toBeGreaterThan(-1);
    expect(validationIndex).toBeGreaterThan(carveOutIndex);
  });

  it("_create_payment_obligation is otherwise the same body as 0143 — no INSERT/UPDATE beyond the existing payments/payment_events writes", () => {
    const src = migration();
    const fnBody = src.slice(
      src.indexOf("create or replace function public._create_payment_obligation"),
      src.indexOf("revoke all on function public._create_payment_obligation"),
    );
    expect(countOccurrences(fnBody, "insert into public.")).toBe(2);
    expect(fnBody).toContain("insert into public.payments (");
    expect(fnBody).toContain("insert into public.payment_events (");
  });

  it("no PaymentIntent, Checkout, charge, or application_fee code anywhere in this migration — activation/readiness only, zero money movement (the file's own header comments explain the ABSENCE of these using the words themselves, so this checks actual SQL code lines only, excluding `--` comments)", () => {
    const codeOnly = migration()
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    expect(codeOnly).not.toMatch(/PaymentIntent/);
    expect(codeOnly).not.toMatch(/checkout/i);
    expect(codeOnly).not.toMatch(/application_fee|applicationFee/);
    expect(codeOnly).not.toMatch(/stripe\.charges|\.charges\.create/);
  });

  it("never calls a Stripe account-mutating operation — this migration is pure Postgres DDL/DML, no Stripe API calls of any kind", () => {
    const src = migration();
    expect(src).not.toMatch(/\.v2\.core\.accounts\.(create|update)/);
    expect(src).not.toMatch(/stripe\.accounts\.(create|update)/);
  });

  it("wraps both object definitions in a single begin/commit transaction", () => {
    const src = migration();
    expect(countOccurrences(src, "\nbegin;\n")).toBe(1);
    expect(countOccurrences(src, "\ncommit;\n")).toBe(1);
  });

  // Phase 34D-C2 (activation UI fix) requirement 5 — switching a club's
  // payment_mode to court_time_payments must preserve existing payment
  // history and existing obligations; only future/new obligations follow
  // the newly selected mode. activate_court_time_payments only ever
  // updates club_settings — it must never write to payments/payment_events
  // itself (that stays exclusively _create_payment_obligation's job, and
  // only for NEW obligations created after activation).
  it("activate_court_time_payments only ever updates club_settings — never payments or payment_events directly, so existing obligation history is untouched by activation itself", () => {
    const src = migration();
    const fnBody = src.slice(
      src.indexOf("create or replace function public.activate_court_time_payments"),
      src.indexOf("revoke execute on function public.activate_court_time_payments"),
    );
    expect(fnBody).toContain("update public.club_settings");
    expect(fnBody).not.toMatch(/update public\.payments/);
    expect(fnBody).not.toMatch(/insert into public\.payments/);
    expect(fnBody).not.toMatch(/update public\.payment_events/);
    expect(fnBody).not.toMatch(/insert into public\.payment_events/);
  });

  it("an obligation's payment_mode_at_creation is immutable once written — _create_payment_obligation snapshots the club's mode at INSERT time only, never re-stamping existing rows when the club's mode later changes", () => {
    const src = migration();
    const fnBody = src.slice(
      src.indexOf("create or replace function public._create_payment_obligation"),
      src.indexOf("revoke all on function public._create_payment_obligation"),
    );
    // payment_mode_at_creation is only ever written inside the INSERT —
    // there is no UPDATE ... set payment_mode_at_creation anywhere.
    expect(fnBody).toContain("payment_mode_at_creation, created_by");
    expect(fnBody).not.toMatch(/update public\.payments[\s\S]*payment_mode_at_creation\s*=/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 34D-C2 — activation UI fix. Root cause: activation wiring
// (activate_court_time_payments, updateClubPaymentModeAction,
// PaymentTrackingSection's own selectable/click logic) was already fully
// implemented in 34D-C — the ONLY defect was stale copy in two places
// (StripeConnectSection's "ready" description, and page.tsx's Court Time
// Payments section intro) that both falsely claimed activation "isn't
// available yet" even once Stripe was genuinely ready, making the
// already-working control undiscoverable/untrustworthy. These tests would
// have FAILED against that stale copy.
// ═══════════════════════════════════════════════════════════════════════════

describe("Activation UI — stale 'coming in a future update' copy removed (requirement 6)", () => {
  it("StripeConnectSection's 'ready' state no longer claims activation is coming in a future update", () => {
    const src = readSource("src/app/(app)/admin/settings/StripeConnectSection.tsx");
    expect(src).not.toMatch(/coming in a future update/i);
    // Points the Admin at the actual control instead.
    expect(src).toMatch(/Select Court Time Payments in Payment Tracking above/);
  });

  it("the admin/settings page's Court Time Payments section intro no longer claims activation isn't available yet", () => {
    const src = readSource("src/app/(app)/admin/settings/page.tsx");
    expect(src).not.toMatch(/isn.t available to turn on yet/i);
    expect(src).toMatch(/activate Court Time Payments in Payment Tracking above/);
  });

  it("PaymentTrackingSection's court_time_payments option is genuinely selectable (not hardcoded disabled) once Stripe reports ready — the real activation control this copy now correctly points to", () => {
    const src = readSource("src/app/(app)/admin/settings/PaymentTrackingSection.tsx");
    expect(src).toContain("const courtTimePaymentsReady = isCourtTimePaymentsSelectable(stripeReadiness);");
    expect(src).toContain('const isDisabled = option === "court_time_payments" && !courtTimePaymentsReady;');
    // Never unconditionally disabled — that would be the pre-34D-C, "Coming
    // Soon" behavior this fix's copy update would otherwise still contradict.
    // The exact old unconditional line (no trailing "&& !courtTimePaymentsReady")
    // must be structurally absent.
    expect(src).not.toContain('const isDisabled = option === "court_time_payments";');
  });

  it("court_time_payments Server Action wiring already exists end-to-end (no missing application wiring beyond the copy fix) — role check, server-derived livemode, and the activation RPC call are all present", () => {
    const src = readSource("src/app/(app)/admin/payments/actions.ts");
    expect(src).toContain('if (mode === "court_time_payments")');
    expect(src).toContain("isAuthorizedToConnectStripe(profile.role)");
    expect(src).toContain("const context = getStripeContext();");
    expect(src).toContain('.rpc("activate_court_time_payments", {');
    expect(src).toContain("p_livemode: context.livemode,");
  });
});

describe("Activation UI — failed activation never falsely shows ACTIVE (requirement 7)", () => {
  it("PaymentTrackingSection only updates the locally-selected mode inside the SUCCESS branch — an error response leaves the previously-active option showing Active, never the one that just failed", () => {
    const src = readSource("src/app/(app)/admin/settings/PaymentTrackingSection.tsx");
    const handleSelectStart = src.indexOf("function handleSelect(next: PaymentMode) {");
    const handleSelectEnd = src.indexOf("\n  }\n", handleSelectStart);
    const fnBody = src.slice(handleSelectStart, handleSelectEnd);
    const errorBranch = fnBody.slice(fnBody.indexOf("if (result.error) {"), fnBody.indexOf("} else {"));
    const successBranch = fnBody.slice(fnBody.indexOf("} else {"));
    expect(errorBranch).not.toMatch(/setMode\(/);
    expect(errorBranch).toContain('setStatus({ type: "error", message: result.error });');
    expect(successBranch).toContain("setMode(next);");
  });

  it("the Active badge is derived purely from the current `mode` state, never from isPending/optimistic UI — so a still-in-flight or failed activation can never render as Active", () => {
    const src = readSource("src/app/(app)/admin/settings/PaymentTrackingSection.tsx");
    expect(src).toContain("const isSelected = mode === option;");
    expect(src).not.toMatch(/isSelected\s*=\s*.*isPending/);
  });
});
