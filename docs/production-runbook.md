# Court Time Production Runbook

Authoritative operations reference for deploying and running Court Time,
with emphasis on Court Time Payments (Stripe Connect). Audited directly
against the codebase on branch `phase-34d-court-time-payments` at
migration `0168`. Written to be USED during a deploy or an incident, not
read once and filed away.

Do not paste real secret values into this document, a PR, or an issue —
names and placeholders only.

---

## 1. Scope

Covers the current, already-implemented application: multi-club
scheduling (reservations/lessons/events/programs), manual payment
tracking, and Court Time Payments (Stripe Connect online checkout,
refunds, disputes). It does **not** cover Court Time's own SaaS billing
of clubs (`club_subscriptions.stripe_customer_id` /
`stripe_subscription_id`) — that is a separate Stripe relationship, not
audited here, and this runbook's Stripe Connect variables/webhooks are
never used for it.

This document does not add features. It documents what already exists so
a human operator can configure, deploy, verify, and recover it.

## 2. Architecture / environment summary

- Next.js 15 App Router, deployed to Vercel. No `middleware.ts`-adjacent
  edge config beyond session refresh + invite-cookie stamping
  (`middleware.ts`).
- Supabase/Postgres is the only datastore. All financial writes go
  through `SECURITY DEFINER` RPCs; RLS governs reads. No ORM.
- Stripe Connect, **direct charges** on connected club accounts (Accounts
  v2). The club is the merchant/payee; Stripe's processing fees are the
  club's; Court Time currently takes no application fee/take-rate.
- `payment_events` is the append-only canonical financial history.
  `payments.amount_due_cents` / `amount_paid_cents` are derived,
  recomputed rollups — never edited directly.
- Multi-tenant: every table used at request time is scoped by `club_id`
  and governed by RLS; every Server Action re-derives the acting club
  from the authenticated profile, never from client input, for anything
  that touches money.
- Commercial packaging: **Staff-Managed** (no Member self-service) vs.
  **Connected** (Member self-service). **Court Time Payments** is an
  optional add-on, commercially available only under Connected, and its
  online-checkout code paths individually re-check
  `card_payments_status = "active"` on the club's connected account
  before creating a Checkout Session — activation is not a single
  boolean flag flipped once, it's re-verified at each checkout.

## 3. Environment variable inventory

Audited by grepping every `process.env.*` reference in `src/` (17 files)
and cross-checked against `.env.example`, which is currently complete —
no undocumented variable exists in code, and no documented variable is
unused.

### 3.1 Browser-safe / `NEXT_PUBLIC_*`

| Variable | Purpose | Used in | Prod? | Preview? | Local? | Secret? | Failure mode | Validated? |
|---|---|---|---|---|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL | `src/lib/supabase/{client,server,middleware,privileged}.ts`, `src/app/auth/confirm/route.ts` | Yes | Yes | Yes | No (project URL, not a credential) | Every Supabase client construction throws (non-null assertion, `!`); the app fails hard and immediately on first request — loud, not silent | No explicit check; relies on `!` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase publishable/anon key, RLS-scoped | same files as above | Yes | Yes | Yes | No (designed to be public; RLS is the real boundary) | Same as above — immediate hard failure | No explicit check; relies on `!` |
| `NEXT_PUBLIC_APP_URL` | Canonical app origin. Drives `SITE_URL` (`src/lib/siteUrl.ts`), all Stripe Checkout/Account-Link success/cancel/return/refresh URLs, `metadataBase`, sitemap, robots | `src/lib/siteUrl.ts` and every module that imports `SITE_URL` (checkout actions, Stripe Connect actions/routes) | Yes | **Conditional** — required whenever that Preview deployment intentionally exercises Stripe Checkout/Connect (§4 "Payments-enabled Preview"); may remain unset for ordinary non-Payments Preview QA | Optional | No | If unset, falls back to `https://court-time.app` — **never** to `localhost`. For a non-Payments Preview this is harmless; for a Payments-enabled Preview it silently redirects Stripe's return flow to production instead of back to the Preview deployment (§4) | No validation of shape/reachability |

### 3.2 Server-only Supabase values

| Variable | Purpose | Used in | Prod? | Preview? | Local? | Secret? | Failure mode | Validated? |
|---|---|---|---|---|---|---|---|---|
| `SUPABASE_SECRET_KEY` | Backend-only key (`sb_secret_...` model) for `service_role`-only RPCs (e.g. `submit_pilot_inquiry`, and every Stripe webhook handler's DB write) | `src/lib/supabase/privileged.ts` | Yes | Yes | Optional (only needed to exercise privileged paths locally) | **Yes** | `createPrivilegedClient()` returns `null` (never throws); every caller fails closed — e.g. both Stripe webhook routes (`/api/stripe/payments/events`, `/api/stripe/connect/account-events`) return sanitized `500` rather than silently dropping the event | Yes — explicit presence check, fails closed |

### 3.3 Stripe platform values

| Variable | Purpose | Used in | Prod? | Preview? | Local? | Secret? | Failure mode | Validated? |
|---|---|---|---|---|---|---|---|---|
| `STRIPE_SECRET_KEY` | Authenticates outbound Stripe API calls; its `sk_live_`/`sk_test_` (or `rk_live_`/`rk_test_`) prefix is the **sole source of truth** for `livemode` throughout the integration (`deriveLivemode`, `src/lib/stripe/connectConfig.ts`) | `src/lib/stripe/server.ts` (`getStripeContext`) | Yes (live key) | Yes (test key) | Yes (test key) | **Yes** | `getStripeContext()` returns `null` for unset or unrecognized-prefix keys (fails closed, never guesses); every caller (checkout creation, Connect actions, all Stripe webhook routes) checks for `null` and fails closed | Yes — presence + prefix validated, fails closed |

### 3.4 Stripe webhook signing values

| Variable | Purpose | Used in | Prod? | Preview? | Local? | Secret? | Failure mode | Validated? |
|---|---|---|---|---|---|---|---|---|
| `STRIPE_CONNECT_ACCOUNT_WEBHOOK_SECRET` | Verifies `Stripe-Signature` on the Accounts v2 lifecycle webhook (`parseEventNotification`) | `src/app/api/stripe/connect/account-events/route.ts` | Yes | **Conditional** — only when that specific Preview environment is intentionally exercising Connect account-lifecycle webhook QA (§4 "Payments-enabled Preview"); not required for every Preview deployment | Via `stripe listen` | **Yes** | Missing → sanitized `500` (Stripe retries). Bad signature → sanitized `400`. Both logged as `[webhook:connect-account-events] <stage>` | Yes — presence checked before use; signature verification is the real check |
| `STRIPE_PAYMENTS_WEBHOOK_SECRET` | Verifies `Stripe-Signature` on the Checkout/refund/dispute reconciliation webhook (`stripe.webhooks.constructEvent`) | `src/app/api/stripe/payments/events/route.ts` | Yes | **Conditional** — same as above, only when that Preview environment is intentionally exercising Checkout/refund/dispute webhook QA | Via `stripe listen` | **Yes** | Same shape as above, logged as `[webhook:payments-events] <stage>` | Yes |

These two secrets are **structurally distinct** — different Stripe event
families (v2 thin events vs. classic v1 Events), different verification
calls, and the code never shares one between the two routes. Swapping
them in Vercel config fails safely and observably: every delivery to the
misconfigured route gets `signature_verification_failed` (400), visible
both in Vercel logs and in the Stripe Dashboard's webhook delivery
history — it does not silently drop money.

### 3.5 Application URL/origin values

Covered under 3.1 (`NEXT_PUBLIC_APP_URL`) — there is no separate
server-only origin variable; `SITE_URL` is derived from the one public
value everywhere (checkout return URLs, Connect Account Link
refresh/return URLs, sitemap/robots/metadata).

### 3.6 Other production-relevant configuration (non-Payments, present in the same inventory)

| Variable | Purpose | Required for Payments? | Failure mode if absent |
|---|---|---|---|
| `RESEND_API_KEY` | Outbound transactional email | No | Email skipped silently; in-app notifications unaffected |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER` | Outbound SMS (all three required together) | No | SMS skipped silently; Admin Settings shows "not configured" |
| `PILOT_INQUIRY_TO_EMAIL` | Operator notification address for `/contact` | No | Inquiry still saved to `pilot_inquiries`; email skipped |
| `PILOT_INQUIRY_HASH_SECRET` | HMAC salt for `/contact` abuse throttle | No | Throttle skipped; duplicate-submission check still applies |

None of these gate Payments functionality. They're included for
completeness since they were found in the same `process.env` audit.

## 4. Production environment matrix

| | Local | Preview (Vercel) | Production (Vercel) |
|---|---|---|---|
| Supabase project | Dev/pilot project | Same as Local (recommended) — **see finding below**; this is a code-deployment-readiness note, not a live-payments gate (§9, §19) | Dedicated production project **required before real live-mode payments are activated** — not required merely to deploy/merge code (§19) |
| `STRIPE_SECRET_KEY` | `sk_test_...` | `sk_test_...` — see Preview modes below | `sk_live_...` |
| Stripe webhook secrets | `stripe listen` values (ephemeral, per-session) | Required only for Payments-enabled Preview (mode B below); absent is fine for mode A | Live-mode endpoint's `whsec_...` |
| `NEXT_PUBLIC_APP_URL` | `http://localhost:3000` (optional — only needed to complete Connect onboarding locally) | See Preview modes below — **must be explicitly set** whenever Stripe Checkout/Connect is being exercised | Production domain, no trailing slash |
| Money movement | None (test mode) | None (test mode) | Real (live mode) |

**Finding (documentation, no code change):** there is currently no
Supabase project genuinely separate from the one used for development —
Preview and Local share the same project per repo convention. This is
acceptable for ordinary code deployment and merge activity; it becomes a
real operational risk only once a paying club's real production data
exists, since any Preview deployment (which anyone with repo access can
trigger by opening a PR) would read/write the same rows as Production.
**This is a live-payments-activation gate, not a code-merge/deploy gate
— see §19's locked decision.** Recommendation, not built in D2: before
Court Time stores the first real paying-club data / intentionally
activates real live-mode payments, provision a dedicated production
Supabase project and point `NEXT_PUBLIC_SUPABASE_URL` /
`NEXT_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_SECRET_KEY` at it for the
Production Vercel environment only, keeping Preview on the dev project.

### Preview deployment — two supported modes

A Preview deployment is not one uniform configuration. Which mode applies
determines whether `NEXT_PUBLIC_APP_URL` and the Stripe test-mode webhook
secrets are required for that specific deployment.

**A. Non-Payments Preview** (the default, most Preview deployments):
- General app/UI QA only — no Stripe Checkout or Connect flow is
  intentionally exercised.
- `NEXT_PUBLIC_APP_URL` may remain unset; `SITE_URL` falling back to
  `https://court-time.app` is harmless here because nothing in this mode
  depends on the return URL actually resolving back to the Preview
  deployment.
- Payment-specific configuration (`STRIPE_SECRET_KEY`,
  `STRIPE_CONNECT_ACCOUNT_WEBHOOK_SECRET`, `STRIPE_PAYMENTS_WEBHOOK_SECRET`)
  may remain absent — those code paths fail closed (§3.3, §3.4), and
  nothing else in the app depends on them.

**B. Payments-enabled Preview** (only when Stripe Checkout/Connect is
being deliberately exercised against that Preview deployment):
- Stripe **test mode only** — never a live key.
- `NEXT_PUBLIC_APP_URL` **must be explicitly set** to that Preview
  deployment's own stable origin. `SITE_URL` drives every Stripe Checkout
  success/cancel URL and every Connect Account Link return/refresh URL —
  if it's left to fall back to `https://court-time.app`, Stripe will
  redirect the browser to production instead of back to the Preview
  deployment being tested.
- Supabase Auth's Redirect URL allowlist must include that Preview
  origin wherever the flow being tested touches auth (sign-up
  confirmation, password reset).
- If webhook QA is part of what's being tested, the test-mode webhook
  endpoint(s) must be configured to target that specific stable Preview
  origin, and the matching `STRIPE_CONNECT_ACCOUNT_WEBHOOK_SECRET` /
  `STRIPE_PAYMENTS_WEBHOOK_SECRET` set for that Preview environment.
- **Never** intentionally exercise a Preview Stripe/Connect flow while
  `SITE_URL` is silently falling back to the production domain — that
  produces a broken-looking flow (browser redirected away from Preview)
  rather than a useful test.

This is documentation of an operating policy only — no `VERCEL_URL`-based
routing or environment-detection code is introduced by this correction.

## 5. Supabase production configuration

- **Migration state**: 168 sequential migrations, `0001`–`0168`, no gaps
  (verified by directory listing). Applied through `0168` on the current
  environment per the user's own confirmation this session. Migrations
  are never edited after being applied — every correction found during
  D1's QA rounds was a new migration (`0166`, `0167`, `0168`), never an
  edit to an already-applied one. Continue this discipline in production.
- **RLS**: every table read by application code is RLS-governed;
  `service_role` (via `createPrivilegedClient`) is used only for the
  narrow set of `SECURITY DEFINER` RPCs that must be reachable without a
  session (e.g. webhook reconciliation, `submit_pilot_inquiry`). This
  document does not re-audit RLS policy correctness — that was the scope
  of the prior G-D production-readiness audit and the two live-evidence
  QA correction rounds (migrations `0167`, `0168`), both closed.
- **Auth Site URL / Redirect URLs** (Supabase Dashboard, not code): must
  include the production domain. Code evidence: sign-up
  (`SignUpForm.tsx`) and forgot-password
  (`src/app/(auth)/forgot-password/page.tsx`) both build
  `emailRedirectTo`/`redirectTo` from `window.location.origin` at request
  time — correct by construction for whatever domain the user is actually
  on, **but** Supabase Auth only honors a redirect URL if it matches an
  allowlist configured in the Dashboard. If the production domain isn't
  in that allowlist, sign-up confirmation and password-reset links will
  fail for real users. This is a manual Dashboard step (§16.N).
- **Extensions**: none beyond what every migration already assumes
  (`pgcrypto`/`gen_random_uuid()` — standard on Supabase, not something
  to configure).
- **service_role boundary**: exactly one code path constructs a
  service_role client (`src/lib/supabase/privileged.ts`), guarded by
  `import "server-only"` (build-time enforcement against accidental
  client-bundle inclusion) and returns `null` rather than throwing when
  unconfigured.

## 6. Stripe / Connect configuration

- Stripe Accounts v2 (not v1) is this integration's foundation
  (`src/lib/stripe/connectConfig.ts`).
- API version is pinned explicitly in code
  (`STRIPE_API_VERSION = "2026-07-29.dahlia"`, `src/lib/stripe/server.ts`)
  — not left to the Dashboard's account-level default, so behavior can't
  silently drift as that default changes.
- Direct charges: the club is the merchant of record on every charge; no
  Court Time application fee.
- Court Time Payments activation is re-checked at the moment of each
  checkout (`card_payments_status = "active"` on the club's connected
  account is read fresh, not cached as a one-time flag) — a club whose
  Stripe capability regresses (e.g. restricted) stops being able to
  accept new online payments immediately, without any code change or
  redeploy.
- Test/live separation is enforced **structurally at the database layer**,
  not merely by convention: `process_stripe_payment_event`
  (migration `0150`) explicitly raises `livemode_mismatch` if the
  webhook's verified `livemode` doesn't match the stored checkout
  attempt's own `livemode`, and separately raises `stripe_account_mismatch`
  if the connected account doesn't match. This is real evidence against
  the "Stripe live/test mode can be silently crossed" failure mode named
  in the D2 charter — the code cannot be tricked into crediting a test
  event against a live attempt or vice versa, given a correctly-configured
  key. What is **not** enforced is upstream of the key: nothing in code
  stops an operator from configuring a live `STRIPE_SECRET_KEY` in the
  Preview Vercel environment. See §8 for why this is left as a
  documented policy rather than a code change.

## 7. Webhook configuration

Two independent Connect webhook endpoints, both required, never sharing a
signing secret.

### `/api/stripe/connect/account-events` — Account lifecycle

- **Endpoint URL shape**: `https://<production-domain>/api/stripe/connect/account-events`
- **Signing secret**: `STRIPE_CONNECT_ACCOUNT_WEBHOOK_SECRET`
- **Delivery semantics**: Accounts v2 **thin events**, delivered for
  connected-account changes (this integration listens to connected
  accounts, not the platform account itself)
- **Event types handled** (exactly two, `src/lib/stripe/connectConfig.ts`
  `SUPPORTED_ACCOUNT_LIFECYCLE_EVENT_TYPES`):
  - `v2.core.account[requirements].updated`
  - `v2.core.account[configuration.merchant].capability_status_updated`
- **Events safely ignored**: any other verified event type → `200`
  (not an error)
- **Idempotency**: `stripe_event_id` is a Postgres primary key
  (`stripe_event_receipts`, migration `0148`); duplicate deliveries
  no-op
- **Responses**: `500` for our own missing config or transient failures
  (Stripe retries); `400` for signature/malformed payload; `200` for
  ignored or successfully-processed events (including duplicates)
- **Never trusts the thin body**: re-fetches the full Event, then
  separately re-retrieves current Account state — the webhook only ever
  signals "something changed," never the new value itself

### `/api/stripe/payments/events` — Checkout / refund / dispute reconciliation

- **Endpoint URL shape**: `https://<production-domain>/api/stripe/payments/events`
- **Signing secret**: `STRIPE_PAYMENTS_WEBHOOK_SECRET`
- **Delivery semantics**: classic v1 Events, Connect webhook (delivered
  for connected-account activity; the `account` field identifies which
  connected account)
- **Event types handled**:
  - `checkout.session.completed` (only acted on when `mode === "payment"`
    and `payment_status === "paid"`; other combinations → `200`, ignored)
  - `refund.created`, `refund.updated`, `refund.failed`
  - `charge.dispute.created`, `charge.dispute.updated`,
    `charge.dispute.closed`, `charge.dispute.funds_withdrawn`,
    `charge.dispute.funds_reinstated` (informational only — never
    mutates payment/refund state)
- **Idempotency**: same `stripe_event_id` primary-key pattern, enforced
  per event family in migrations `0150` (payments), `0153` (refunds),
  `0156` (disputes) — all three RPCs use
  `on conflict (stripe_event_id) do nothing`
- **Refund/dispute handling never trusts the event payload's snapshot**:
  both handlers retrieve the current Refund/Dispute fresh by id, in the
  event's own verified connected-account context, before reconciling —
  because Stripe does not guarantee delivery ordering
- **Responses**: same `500`/`400`/`200` shape as above

### Required Stripe Dashboard configuration (manual, not done by this session)

- **Two separate webhook endpoints** must be registered (not one) — the
  two routes verify against different secrets and different event
  families.
- Both must be configured to **listen to events on connected accounts**
  (Stripe Connect webhook, not platform-only) — every event this
  integration cares about originates on a connected account.
- Each endpoint's signing secret must be copied into the matching Vercel
  environment variable — swapping them fails safely (§3.4) but silently
  from a money standpoint until someone checks the Stripe Dashboard's
  delivery log or Vercel's function logs.

## 8. Test/live separation findings

**No code change made.** Findings:

1. **Enforced in code/DB**: `livemode` is derived once, from the
   configured `STRIPE_SECRET_KEY`'s own prefix, and is the single source
   of truth threaded through every mode-scoped read/write. The DB layer
   independently re-validates it against stored state
   (`livemode_mismatch`) rather than trusting the webhook payload's
   `livemode` field blindly for matching. This closes the specific
   "silently crossed" failure mode described in the D2 charter, given a
   correctly-configured key.
2. **Not enforced in code — genuinely can't be, safely**: nothing checks
   whether a `sk_live_...` key has been placed in a non-Production Vercel
   environment (or a `sk_test_...` key in Production). A Vercel-native
   signal for "which environment am I" (`VERCEL_ENV`) exists but is
   **not currently read anywhere in this codebase** (confirmed by grep —
   zero references). Adding a `VERCEL_ENV`-based guard was considered and
   rejected for D2: it would only work when literally deployed on
   Vercel (silently no-op locally and on any other host), the D2 charter
   explicitly says not to build environment-management infrastructure
   absent a concrete blocker, and the actual failure mode this would
   guard against — an operator manually pasting a live key into the
   wrong Vercel project environment — is a configuration-discipline
   problem, not a code defect. **This is the one place in the audit where
   the correct fix is a documented human procedure, not code**: §9 and
   §16.N make "verify `STRIPE_SECRET_KEY` mode matches the target
   environment before every deploy" an explicit pre-deploy checklist
   item.
3. `NEXT_PUBLIC_APP_URL` cannot silently become `localhost` in
   Production — the code fallback is the real production domain
   (`https://court-time.app`), never `localhost`. The realistic failure
   mode is a stale-but-plausible URL (e.g., last year's preview URL) left
   in the Production env var, not a placeholder value — this is a
   checklist verification item (§9), not a code-detectable condition.
4. **The same fallback is a real problem in one specific case, not a
   general one**: `NEXT_PUBLIC_APP_URL` falling back to
   `https://court-time.app` is harmless for a non-Payments Preview
   deployment (§4 mode A), but must never be relied on for a
   Payments-enabled Preview deployment (§4 mode B) — since `SITE_URL`
   drives every Stripe Checkout and Connect Account Link return/refresh
   URL, a Preview deployment intentionally exercising those flows while
   this variable is unset will have Stripe redirect the browser back to
   production instead of to the Preview deployment under test. This is a
   policy correction (§4), not a code change — the fallback behavior
   itself is correct and stays as-is.

## 9. Pre-deploy checklist

**Code deployment and live-payments activation are two separate
decisions — this checklist covers both, and they are labeled
separately.** Court Time can be deployed/merged to production with
Court Time Payments remaining commercially/operationally unactivated in
live mode (e.g. `STRIPE_SECRET_KEY` absent or still test-mode in
Production, so online-checkout paths simply stay unavailable/fail closed
while the rest of the app runs normally). Items marked **[deploy]** gate
an ordinary code deployment; items marked **[live payments]** gate the
separate decision to start moving real money and are not required to
ship code. See §19 for the locked decision this reflects.

**Repo / code — [deploy]:**
- [ ] `git status --short` clean, on the intended branch, up to date with
      remote
- [ ] `npx vitest run` — full suite green
- [ ] `npx tsc --noEmit` — clean
- [ ] `npx eslint .` — zero errors (pre-existing warnings in unrelated
      files are not a blocker; check no new ones were introduced)
- [ ] `npx next build` — clean production build
- [ ] `git diff --check` — no whitespace errors, if there's an active
      diff to review

**Environment variables (Vercel → Production) — [deploy]:**
- [ ] `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` set and
      point at whichever Supabase project Production is currently using
- [ ] `SUPABASE_SECRET_KEY` set, matches that same project
- [ ] `NEXT_PUBLIC_APP_URL` set to the real production domain, no
      trailing slash, not a stale preview URL
- [ ] Vercel Preview environment variables independently confirmed to
      use **test-mode** Stripe values only, never live (§4)

**Environment variables — [live payments], required only when
intentionally activating real online payments:**
- [ ] `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` /
      `SUPABASE_SECRET_KEY` point at a **dedicated production** Supabase
      project, genuinely separate from Preview/Local (§4 finding, §19) —
      not required merely to deploy code
- [ ] `STRIPE_SECRET_KEY` is a **live** key (`sk_live_...`) — confirm the
      prefix by eye without pasting the full value anywhere logged
- [ ] `STRIPE_CONNECT_ACCOUNT_WEBHOOK_SECRET` and
      `STRIPE_PAYMENTS_WEBHOOK_SECRET` are the **live-mode** endpoint
      secrets from the Stripe Dashboard, correctly matched to their
      respective routes (§7) — not swapped, not copied from test mode

**Supabase — [deploy]:**
- [ ] Production project's migration state matches `0168` (or later, if
      more have shipped) — see §10 for how to confirm
- [ ] Auth → URL Configuration → Site URL and Redirect URLs include the
      production domain (§5, §16.N)

**Stripe — [live payments]:**
- [ ] Live-mode Connect webhook endpoints exist for both routes (§7),
      each set to receive connected-account events
- [ ] Endpoint signing secrets copied into the matching Vercel env vars
      (not swapped)
- [ ] Platform account is live-mode-activated for Connect (not still in
      Stripe's own test/review state)

## 10. Database migration procedure

- Migrations apply in strict numeric order; the current head is `0168`.
- **Never edit an already-applied migration.** Every correction found in
  this project's own QA history (search_path hardening, EXECUTE privilege
  hardening, an RLS gap) was shipped as a new, higher-numbered migration,
  never an edit — continue this in production.
- **How migrations are actually applied in this project**: there is no
  Supabase CLI config (`supabase/config.toml`) in this repo and no
  `supabase` CLI dependency in `package.json` — migrations are applied by
  hand, in order, via the Supabase Dashboard SQL Editor (consistent with
  this phase's own history: `0166`–`0168` were each applied this way).
  There is no automatic migration-tracking table to query.
- **Confirming current state**: since there's no tracking table, confirm
  by checking for the concrete effect of the latest migration(s) directly
  — e.g. for `0168`, query `pg_policies` for the `program_enrollments`
  Staff SELECT branch; for `0167`, `aclexplode` on `bootstrap_new_club`'s
  ACL to confirm no explicit `anon`/`authenticated` grant remains. Compare
  against `ls supabase/migrations/ | sort | tail -1` in this repo to know
  what "should" be applied.
- **Stop condition**: if a migration fails partway, do **not** attempt to
  manually patch the schema to "finish" it and do not edit the failed
  migration file. Stop, capture the exact error, and treat it as a
  blocker requiring a new corrective migration — the same pattern this
  project already used three times this phase (`0166`–`0168`).
- **Verification**: for any migration touching payments/refunds/RLS,
  confirm via a live read (not just "no error") — e.g. re-run the
  specific `aclexplode`/policy-inspection query that caught the two prior
  live-evidence QA regressions (bootstrap_new_club EXECUTE grants,
  program_enrollments Staff SELECT) rather than assuming success from a
  clean migration run alone. That gap is exactly what those two rounds
  found.

## 11. Deploy procedure

1. Confirm §9's pre-deploy checklist is fully green.
2. Apply any pending migrations to the production Supabase project first
   (§10) — schema changes should land before the code that depends on
   them goes live, consistent with this project's existing migration
   discipline.
3. Deploy to Vercel Production (merge to the deploy branch per your
   existing Vercel Git integration, or `vercel --prod` if deploying
   manually) — this session does not perform this step.
4. Confirm the Vercel build succeeded and the deployment is serving from
   the intended commit.
5. Validate the production URL resolves, is on HTTPS, and
   `NEXT_PUBLIC_APP_URL` matches what's actually being served.
6. Smoke-test a handful of unauthenticated routes (marketing pages,
   `/sign-in`) before touching anything financial.

## 12. Post-deploy smoke test

Run in order; stop at the first failure and consult §13/§14. Steps 1–6
are the ordinary smoke test for **every** code deployment. Steps 7–10
belong to the separate, deliberate **live-payments activation/go-live
procedure** (§19) — they are not a default part of every deploy and must
never run merely because a deploy happened to succeed.

**Every deploy:**

1. Admin sign-in succeeds; lands on an authorized page.
2. Member sign-in succeeds (separate test account).
3. Staff account: confirm `/admin/payments` is reachable, Financial
   History loads, Record Payment is available, CSV Export works, and the
   **Refund action is not rendered** (D1's UI-only Admin gate).
4. Admin account, same payment: Refund action **is** rendered (do not
   click it yet — see step 8).
5. `/admin/payments` loads without error for a club with existing
   payment history. If a genuinely existing QA/production-like club
   already has ≥500 rows, confirm the disclosure text ("Showing the 500
   most recent payments. Use Export for complete payment history.")
   appears. **Do not manufacture or seed hundreds of payment rows solely
   to exercise this check** — the 500-row cap and disclosure already have
   dedicated regression coverage (`productionHardening.regression.test.ts`
   and related payments test files); rely on that unless a qualifying
   club already exists naturally.
6. Stripe Connect status on Admin Settings reflects the connected
   account's real state (not stale) for a club that has one connected.

**Live-payments activation/go-live only — a separate, deliberate
decision, not run on every deploy:**

7. Confirm the environment being tested is genuinely ready for real
   money: dedicated production Supabase project in place (§4, §19),
   `STRIPE_SECRET_KEY` is a live key, live webhook endpoints configured
   (§9 "[live payments]" items) — this is the conscious go/no-go decision
   itself, not a formality.
8. **One minimal live-mode payment smoke test**, only once step 7's
   readiness has been explicitly confirmed: complete one small real
   Checkout as a test Member, confirm it reconciles into
   `/admin/payments` and Financial History without manual intervention,
   then (Admin) issue a full refund for that exact test payment through
   the UI and confirm it reconciles back.
9. Webhook reconciliation: confirm both endpoints show recent successful
   deliveries in the Stripe Dashboard for the events exercised in step 8.
10. Check Vercel function logs for the routes touched — confirm log
    lines use the sanitized `[refund]` / `[event-checkout]` /
    `[reservation-checkout]` / `[program-checkout]` / `[lesson-checkout]`
    / `[webhook:connect-account-events]` / `[webhook:payments-events]` /
    `[export]` shape (§16) and that no raw body, signature header,
    secret, or full Stripe object appears anywhere in them.

## 13. Payment incident procedures

General rule throughout: **never manually `UPDATE`/`DELETE`
`payments`, `payment_events`, Stripe IDs, refund attempts, or disputes.**
Financial state must stay reconstructable from Stripe + the append-only
event log. Every procedure below ends in either "wait for the automatic
reconciliation path to catch up" or "escalate" — never a direct row edit.

1. **Payment succeeded in Stripe but Court Time doesn't show it yet.**
   Observe: Stripe Dashboard shows a successful Checkout Session/charge;
   `/admin/payments` doesn't reflect it. First check: Stripe Dashboard →
   that webhook endpoint's delivery log for this event — did it deliver,
   and what was the response? Normal behavior: Stripe retries
   automatically on non-2xx; `checkout.session.completed` reconciliation
   is webhook-driven, not client-redirect-driven, by design (the
   browser's success redirect is never treated as authoritative). Safe
   action: wait for the retry (Stripe retries over an extended window);
   check Vercel logs for `[webhook:payments-events]` entries for this
   event's `event_id`. Do not: manually insert a `payment_events` row.
   Escalate if: the webhook shows repeated `500`s past a reasonable retry
   window, or repeated `400` (signature failures — likely a
   misconfigured/rotated secret, §7).

2. **Checkout was opened but remains unpaid.** Observe: a
   `payment_checkout_attempts` row exists with no completion. First
   check: did the Member actually complete Checkout, or abandon it?
   Normal behavior: an abandoned Checkout Session simply expires on
   Stripe's side; no Court Time action is needed. Safe action: none
   required; the Member can re-attempt checkout, which creates a new
   attempt. Escalate if: the Member insists they paid and Stripe shows a
   successful charge — treat as incident 1.

3. **Payment appears overpaid.** Observe: `amount_paid_cents >
   amount_due_cents`. This is explicitly representable by design
   (overpayments are historical truth, not an error state). First check:
   Financial History / payment_events for this payment to see the actual
   sequence of captures. Safe action: none automatic — if a refund of the
   excess is warranted, an Admin issues it through the normal Refund UI,
   which is itself Stripe-provenance-tracked. Do not: manually zero out
   `amount_paid_cents`.

4. **Reservation/Event/Program/Lesson is cancelled after payment.**
   Observe: domain status is `cancelled`; payment history still shows the
   original charge. This is intentional — cancellation never
   auto-refunds, auto-waives, or auto-voids (locked architecture). First
   check: none needed, this is expected behavior. Safe action: if a
   refund is the correct business outcome, an Admin issues it explicitly
   through the Refund UI (still available for a Paid, cancelled item —
   confirmed in D1 regression coverage). Escalate if: the UI is not
   offering Refund for a payment that genuinely has a Stripe-refundable
   balance.

5. **Refund requested and status is pending.** Observe: `refund_attempts`
   row in a non-terminal state. First check: Stripe Dashboard for that
   Refund object's own status. Normal behavior: refunds are asynchronous;
   `pending` is expected transiently. Safe action: wait; the webhook
   (`refund.updated`) will reconcile the terminal state automatically.
   Do not: retry the refund from the UI without confirming via Stripe
   first (risk of a second, duplicate refund attempt).

6. **Refund result uncertain due to Stripe/API/network failure.**
   Observe: the UI/logs show `refund_uncertain` (the action's own
   documented fallback state — see `refundActions.ts`'s
   `ERROR_MESSAGES.refund_uncertain`). First check: Stripe Dashboard,
   search for the PaymentIntent/Charge directly — did the refund actually
   get created despite the API call appearing to fail? Safe action: if
   Stripe shows no refund was created, it is safe to retry through the
   UI; if Stripe shows one WAS created, do nothing further — the webhook
   will reconcile it (incident 7). Do not: assume "uncertain" means
   "failed" and retry blindly.

7. **Refund appears in Stripe but Court Time hasn't reconciled yet.**
   Same shape as incident 1, for the refund webhook. First check: Stripe
   Dashboard delivery log for `refund.updated`/`refund.created` to this
   integration's payments-events endpoint. Safe action: wait for retry;
   check Vercel logs for `[webhook:payments-events]`. A refund created
   directly in the Stripe Dashboard (outside Court Time) is explicitly
   handled — the webhook reconciles it by PaymentIntent match even
   without Court Time-originated metadata.

8. **Webhook endpoint is returning failures.** Observe: Stripe Dashboard
   shows non-2xx responses. First check: Vercel function logs for the
   specific `[webhook:payments-events]` or `[webhook:connect-account-events]`
   stage being logged — the sanitized `{stage, event_id,
   stripe_account_id, code, message}` will usually name the exact cause
   (`missing_webhook_secret`, `signature_verification_failed`, an RPC
   error code, etc.). Safe action: fix the identified root cause (env var,
   secret rotation mismatch); Stripe's own retry schedule will redeliver
   once fixed — no manual event replay needed for most failures.
   Escalate if: the failure is inside the RPC itself (a real data
   anomaly, not a config issue) — this needs an engineer, not an
   operator action.

9. **Duplicate webhook deliveries appear.** Observe: the same event
   delivered more than once (normal Stripe behavior, not a bug). Normal
   behavior: every reconciliation RPC dedupes on `stripe_event_id` via
   `on conflict (stripe_event_id) do nothing` — a duplicate is a safe
   no-op by construction. Safe action: none needed. Escalate if: you
   observe actual duplicated money (two ledger entries for what should be
   one event) — this would indicate the dedup constraint itself is
   broken and is a P0 engineering escalation, not an operator fix.

10. **Stripe connected account loses `charges_enabled`/readiness.**
    Observe: Admin Settings shows a degraded Connect status; new
    Checkout Sessions for that club stop being offered (checkout actions
    re-check `card_payments_status === "active"` live, so this is
    automatic, not something an operator flips). First check: Stripe
    Dashboard for that connected account's own requirements/restrictions.
    Safe action: direct the club to resolve the flagged requirement in
    their own Stripe onboarding; the account-events webhook will pick up
    the resync automatically once resolved (no manual DB update needed).
    Do not: manually set `card_payments_status` in the DB.

11. **Dispute is opened.** Observe: `charge.dispute.created` reconciled;
    visible in payment context. This is informational-only — no refund,
    no `amount_paid_cents` change (locked architecture: dispute ≠
    refund). First check: Stripe Dashboard for the dispute's own evidence
    deadline. Safe action: respond to the dispute directly in Stripe
    (evidence submission is not built into Court Time — confirmed:
    the handler never submits evidence). Escalate if: the deadline is
    close and no one owns responding to it — this is a business/finance
    escalation, not a Court Time bug.

12. **Dispute is won.** Observe: `charge.dispute.closed` with a won
    outcome reconciled. Normal behavior: informational update only, no
    ledger change (funds were never actually removed by the dispute
    itself in Court Time's model — see incident 13's contrast). Safe
    action: none needed.

13. **Dispute is lost.** Observe: `charge.dispute.closed` with a lost
    outcome. The disputed amount is withdrawn by Stripe at the
    connected-account level — outside Court Time's own ledger by design
    (dispute handling is informational-only; it doesn't rewrite
    `amount_paid_cents`). First check: confirm this matches the club's
    own Stripe balance transactions. Safe action: none from within Court
    Time. Escalate if: the club disputes (no pun intended) the loss
    itself — that's a Stripe-side appeal process, not a Court Time
    action.

14. **Court Time `amount_due` differs from business expectation.**
    Observe: a staff member believes the wrong amount is owed. First
    check: Financial History for that payment — the full
    `payment_events` sequence is the audit trail; walk it chronologically
    rather than trusting the current rollup alone. Safe action: if the
    rollup genuinely doesn't match its own event history, that's an
    engineering escalation (a rollup-computation bug), not something to
    patch by editing the row. If the event history is correct and it's a
    business/pricing misunderstanding, no system action is needed.

15. **Domain lifecycle and payment lifecycle appear inconsistent** (e.g.
    a cancelled Event still shows as "collectible" somewhere it
    shouldn't). First check: confirm which specific screen/export is
    showing the inconsistency — Record Payment eligibility is
    domain-status-derived (`recordPaymentBlocked`) and computed
    separately per domain (event/program/reservation/lesson), while
    Refund eligibility is purely payment-financial and intentionally
    never looks at domain status at all (locked architecture: domain and
    money lifecycles stay separate — this is by design, not a bug, for
    Refund specifically). Escalate if: Record Payment is open for an
    obviously-cancelled item, or the reverse (blocked for a genuinely
    active one) — that is a real defect.

16. **Staff cannot perform an Admin-only payment action.** Observe: Staff
    does not see a Refund action in `/admin/payments` or the payment
    detail sheet — Refund is intentionally Admin-only, and as of D1 the
    UI itself never renders the action for Staff (`isAdmin`-gated
    rendering in `AdminPaymentsClient.tsx`/`PaymentDetailSheet.tsx`).
    This is correct, intended, expected behavior — **not an incident**.
    Safe action: if a refund is genuinely needed, have an Admin perform
    it; Staff retains every other Payments capability (History, Record
    Payment, CSV Export) unaffected. Escalate as a **UI authorization
    regression** if: Staff *can* currently see a Refund button/action
    anywhere in Payments — that means the D1 UI gate has regressed and
    needs an engineering fix, not a workaround. Independently of the UI:
    a direct or crafted request to the refund Server Action from a Staff
    session must still be rejected server-side with "Only an Admin can
    issue a refund." (`refundActions.ts`'s own `profile.role !== "admin"`
    check) — this server-side check is the real authorization boundary
    and is defense-in-depth regardless of what the UI shows; if it were
    ever found to accept a Staff-issued refund, that is a P0 security
    escalation, not a UI issue.

17. **CSV export fails.** First check: Vercel logs for `[export]` entries
    — sanitized to `{club_id, code, message}` (never a raw error object),
    so the message usually identifies the cause directly (a read
    failure, a domain-hydration failure naming the specific
    `domain_type`/`domain_id`). Safe action: if it's a transient DB read
    failure, retry the export. Escalate if: it names a genuine data
    anomaly ("required domain context missing for a genuinely outstanding
    payment") — that needs engineering investigation, not a retry.

18. **Connected capability / Court Time Payments is disabled.** Observe:
    a club that previously had online checkout available no longer does.
    First check: is this commercial (their plan changed away from
    Connected) or technical (`card_payments_status` regressed, incident
    10)? Admin Settings should indicate which. Safe action: none from
    within the incident itself — commercial changes are a packaging/plan
    decision; technical ones route to incident 10.

19. **A production operator suspects test/live mode mismatch.** Observe:
    a payment that should have moved real money didn't (or vice versa).
    **`payments` and `payment_events` themselves do not have a
    `livemode` column** — mode lives on the provenance/attempt records
    that reference them. First check, depending on what's being
    investigated:
    - For a Checkout/payment: the matching `payment_checkout_attempts`
      row's own `livemode`, cross-checked against the corresponding
      `stripe_event_receipts` row for the webhook event that reconciled
      it — this pair is the primary provenance for a payment incident.
    - For a refund: the matching `payment_refund_attempts` row's own
      `livemode`.
    - For a dispute: the matching `payment_disputes` row's own
      `livemode`.
    - For the connected account's own configured mode: `club_stripe_accounts.livemode`
      (a club can have at most one row per `(club_id, livemode)` pair —
      this is the connected-account/mode context those attempts were
      created against, not itself proof of what a given payment's mode
      was).
    Not every incident will have every one of these rows — check whichever
    ones are relevant to the specific payment/refund/dispute in question,
    not all five reflexively. Each reflects the verified webhook's own
    `livemode` at the time it was processed, which is derived from the
    configured `STRIPE_SECRET_KEY`'s prefix (§8). Cross-check against
    which Vercel environment (Production vs. Preview) actually served the
    request. Safe action: if a genuine mismatch is confirmed (e.g.,
    Preview was accidentally given a live key and processed a real
    charge), this is an **immediate P0** — stop further traffic to that
    environment (rotate/unset the misconfigured key in Vercel) before
    doing anything else, then engage Stripe support regarding the
    specific live charge; do not attempt to "fix" it by editing Court
    Time's own database rows.

## 14. Stripe Connect incident procedures

See incident 10 above for the primary Connect-readiness case. Additional
notes:

- Connect account status changes are **push-driven** via the
  `account-events` webhook (§7) — an operator should never need to
  manually trigger a "refresh" for status to update, though Admin
  Settings' own return-from-onboarding flow (`/api/stripe/connect/return`)
  independently re-syncs at that one moment as a secondary path.
- If the webhook itself appears down (incident 8) while a club is mid-
  onboarding, the return-route sync still covers the moment they finish
  Stripe's onboarding flow — but any *later* Stripe-side requirement
  change (e.g. Stripe asks for more documentation weeks later) won't be
  reflected until the webhook is healthy again.

## 15. Disputes

Fully covered as incidents 11–13 in §13. The one operational rule worth
repeating on its own: **Court Time's dispute handling is read-only by
design.** No workflow in this codebase submits evidence, accepts, or
closes a dispute — that always happens directly in the Stripe Dashboard.
Do not look for an in-app dispute-response feature; there isn't one, and
building one is out of scope for D2.

## 16. Logging / diagnostics

Sanitized `console.error` diagnostic prefixes that actually exist in code
today (all confirmed to log only `{stage/context, event_id, club_id, or
stripe_account_id, code, message}` shapes — never a raw request body,
Stripe-Signature header, webhook secret, API key, full Stripe object, or
card/customer PII):

| Prefix | File | Fires on |
|---|---|---|
| `[refund]` | `src/app/(app)/admin/payments/refundActions.ts` | Refund Server Action failure paths |
| `[event-checkout]` | `src/app/(app)/calendar/eventCheckoutActions.ts` | Event checkout failure paths |
| `[reservation-checkout]` | `src/app/(app)/calendar/reservationCheckoutActions.ts` | Reservation checkout failure paths |
| `[program-checkout]` | `src/app/(app)/events/programCheckoutActions.ts` | Program checkout failure paths |
| `[lesson-checkout]` | `src/app/(app)/lessons/lessonCheckoutActions.ts` | Lesson checkout failure paths |
| `[webhook:connect-account-events]` | `src/app/api/stripe/connect/account-events/route.ts` | Account lifecycle webhook failures |
| `[webhook:payments-events]` | `src/app/api/stripe/payments/events/route.ts` | Checkout/refund/dispute webhook failures |
| `[export]` | `src/app/(app)/admin/payments/exportActions.ts` | CSV export failures, sanitized to `{club_id, code, message}` |

These land in **Vercel's function logs** (Runtime Logs in the Vercel
dashboard, or `vercel logs` from the CLI) — there is no separate log
aggregation configured. Search by prefix to isolate a subsystem during an
incident.

**Future enhancement (not built in D2):** a structured observability
platform (Sentry, Datadog, or similar) would let these sanitized log
lines be queried/alerted on directly rather than requiring a manual
Vercel log search during an incident. Worth revisiting once Payments has
real production traffic; not a D2 blocker since the underlying signal
already exists and is already sanitized.

## 17. Rollback and stop conditions

**Reversible:**
- A bad Vercel deploy — redeploy the previous known-good commit/build
  through Vercel's own rollback UI.
- An unapplied migration that fails cleanly before any commit — safe to
  fix the new migration file and re-run (it was never "applied").

**NOT reversible by rolling back — requires a forward fix instead:**
- Any already-applied migration. Do not attempt to "undo" it by
  reverting the deploy; write a new corrective migration (this project's
  own established pattern for `0166`–`0168`).
- Any financial row (`payments`, `payment_events`, refund/dispute
  records) once written. These are never edited or deleted, in an
  incident or otherwise — the append-only ledger is the entire point.

**Stop conditions (halt the deploy, do not proceed):**
- A DB migration fails partway through applying.
- Any webhook signature verification failure observed during
  post-deploy smoke testing (§12) — indicates a secret mismatch, must be
  fixed before relying on webhook-driven reconciliation.
- Evidence of a Stripe live/test mode mismatch (§8, §13.19).
- Any required environment variable (§3) confirmed missing in the target
  Vercel environment.
- A payment is created during smoke testing but its lifecycle cannot be
  observed to reconcile within a reasonable window — stop before doing
  more live-mode testing and investigate as incident 1/7.
- Any tenant-authorization anomaly (a user sees or acts on another
  club's data) or an RLS/privilege result that doesn't match what the
  code review predicted — treat with the same severity as the two live-
  evidence findings that produced migrations `0167`/`0168` this phase:
  stop, verify against live DB state directly, do not assume the code
  review alone was sufficient.
- Production build failure — never deploy a broken build "to see what
  happens in production."

## 18. Security rules / prohibited manual actions

- Never manually `UPDATE`/`DELETE` `payments`, `payment_events`,
  `payment_checkout_attempts`, `payment_refund_attempts`, or any
  Stripe-ID-bearing row, for any reason, including "fixing" an incident.
- Never log or paste a real secret value (any variable marked "Secret?
  Yes" in §3) into a doc, PR, issue, or chat — including this runbook.
- Never widen `service_role` usage beyond `src/lib/supabase/privileged.ts`.
- Never grant `EXECUTE` on a `SECURITY DEFINER` function to `public`,
  `anon`, or `authenticated` unless a specific, reviewed reason requires
  it (this exact mistake was found and corrected live this phase —
  migration `0167`).
- Never trust a client-supplied `club_id`/`expectedClubId` as the
  authorization boundary for a financial read or write — every payments
  Server Action derives the acting club from the authenticated profile
  server-side (established pattern, re-verified across every payments
  action this phase).
- Never respond to a dispute, submit evidence, or otherwise act on a
  dispute from within Court Time — there is no such feature; do it
  directly in Stripe.
- Never apply a Supabase production migration, configure the live Stripe
  Dashboard, or deploy to Production from this kind of audit/documentation
  session — those require an explicit, separate, human-authorized action.

## 19. Future operational improvements

### Locked decision: code deployment vs. live-payments activation

This distinction is intentional and applies throughout this runbook
(§4, §9, §12):

- A dedicated production Supabase project is **not** required merely to
  commit D2's documentation, or to merge/deploy Court Time's code to
  Vercel Production.
- It **is** required before Court Time stores the first real
  paying-club's production data, or before Court Time Payments is
  intentionally activated in live mode for a real club.
- Phase 34 can close, and this branch can be merged and deployed, with
  Court Time Payments remaining commercially and operationally
  **unactivated** in live mode — the rest of the application (scheduling,
  manual payment tracking, everything not depending on `STRIPE_SECRET_KEY`
  being a live key) is unaffected by that choice.
- Real live-mode payment and refund smoke testing (§12, steps 7–10)
  belongs to a later, explicit live-payments activation/go-live
  procedure — it is not exercised as part of an ordinary deploy unless
  the team deliberately decides to activate live money during that
  specific procedure (e.g., during D3, if D3 is scoped to include it).
- Moving real money is never an automatic step of every deploy.

### Recommendations (not built in D2)

Documented as recommendations only — none of these are built in D2, and
none are blockers for an initial pilot deploy given the mitigations
already in place:

- Provision a dedicated production Supabase project, separate from the
  one Preview/Local currently share, before the live-payments activation
  decision above is made (§4).
- Consider a lightweight `VERCEL_ENV`-aware guard if/when a second
  incident of Stripe test/live key misconfiguration actually occurs in
  practice — deliberately not built pre-emptively per D2's scope (§8).
- Add a third-party observability/alerting platform (Sentry, Datadog, or
  similar) so the sanitized log signals in §16 can be queried and alerted
  on rather than manually searched during an incident.
- Add automated Stripe webhook delivery health monitoring (Stripe itself
  will disable an endpoint after sustained failures — proactive alerting
  before that point would shorten incident 8's detection time).
