# Phase 32D — Public Trust, Accessibility, Metadata, SEO, and Production Readiness — QA

No migration involved. No product/pricing/inquiry-workflow behavior
changed — this checkpoint is metadata, accessibility, and documentation
only. Keep this focused; it supplements (does not replace) `docs/QA_phase32b.md`
and `docs/QA_phase32c.md`.

---

## 1. Privacy page accuracy

- Load `/privacy` signed out. Confirm a new **"Pilot Inquiries"** section
  appears between "Who Can Access Your Data" and "Data Storage and
  Security," listing the actual fields the `/contact` form collects
  (contact name, work email, optional phone, club/facility name, facility
  type, court count, approximate Members/regular users, optional website,
  current process, operational challenge, preferred operating model,
  optional additional details).
- Confirm it states the three stated purposes (evaluate/respond to
  inquiries; discuss onboarding/fit; communicate about the requested
  pilot) and that inquiry data is Court-Time-team-only, not visible to any
  club.
- Confirm **no invented retention period** appears anywhere on the page.
- Confirm "Data Deletion Requests" now also covers pilot inquiry data via
  the same `hello@court-time.app` address.
- Confirm "Last updated" reads **August 8, 2026**.

## 2. Terms page — reviewed, not rewritten

Confirm `/terms` content is unchanged (only `alternates.canonical` and a
`description` were added to its metadata) — no stale marketing-era claims
were found requiring correction, and none were introduced.

## 3. Metadata / canonical / Open Graph

For each of `/`, `/features`, `/pricing`, `/contact`, `/privacy`, `/terms`:
- View source (or `curl`) and confirm a `<link rel="canonical" href="...">`
  pointing at the correct absolute URL.
- Confirm `<title>` and the meta description are page-specific, not the
  generic root fallback.
- Confirm `og:title`/`og:description` are present (root layout provides
  defaults; `/`, `/features`, `/pricing`, `/contact` also set their own).
- Confirm there is intentionally **no** `og:image` — this is a documented
  deferral (no brand asset exists yet), not a bug.

## 4. Sitemap and robots

- `GET /sitemap.xml` — confirm exactly six `<url>` entries, one each for
  `/`, `/features`, `/pricing`, `/contact`, `/privacy`, `/terms`, and that
  every `<loc>` is a clean absolute URL with **no double slash** (this was
  a real bug found and fixed during this checkpoint — the base URL is now
  normalized via `src/lib/siteUrl.ts`).
- `GET /robots.txt` — confirm it allows exactly the six marketing pages
  plus `/sign-in`, and explicitly disallows `/calendar`, `/events`,
  `/my-schedule`, `/profile`, `/admin`, `/book`, `/lessons`, `/help`,
  `/sign-up`, `/forgot-password`, `/reset-password`, `/welcome`,
  `/pending-invite`, `/join`, `/auth`. Confirm the `Sitemap:` line points
  at the correct absolute `/sitemap.xml` URL.
- Confirm `NEXT_PUBLIC_APP_URL` with a trailing slash (a real
  misconfiguration this checkpoint tested against) still produces clean,
  single-slash URLs everywhere.

## 5. Private routes are not promoted for SEO

- View source on `/sign-in` (or any `(auth)` page) and confirm
  `<meta name="robots" content="noindex, nofollow">` is present.
- Sign in and view source on `/calendar` (or any `(app)` page) — confirm
  the same noindex meta tag.
- Confirm `/` (signed out) has **no** noindex tag — it defaults to
  `index, follow`.

## 6. Favicon

- Confirm `GET /icon` returns `200` with `Content-Type: image/png`, and
  that a favicon (generated "CT" monogram) appears in the browser tab for
  any page. This is a documented placeholder, not a final brand asset.

## 7. Accessibility fixes made this checkpoint

- **`/contact` success confirmation**: submit a valid inquiry with a
  screen reader running (VoiceOver/NVDA) — confirm "Your inquiry was
  received..." is announced automatically (the success container now has
  `role="status"`/`aria-live="polite"`) without needing to manually
  navigate to it.
- **`/contact` submission-failure banner**: trigger a submission failure
  (e.g. temporarily misconfigure `SUPABASE_SECRET_KEY`, or trip the
  fingerprint throttle) — confirm the generic error banner is announced
  automatically (`role="alert"`).
- **`/pricing` card indicator**: with a screen reader running, swipe or use
  the Previous/Next buttons on the mobile plan rail — confirm "N of 3" is
  announced as it changes (`aria-live="polite"`), not just visually updated.

## 8. Accessibility spot-check (no regressions)

Re-confirm, since these already passed in Phase 32B/32C and were not
touched here: MarketingNav desktop nav and mobile hamburger menu (focus
trap, Escape, outside-click, `aria-expanded`); Home CTAs; Features product
miniatures remain `aria-hidden` (decorative, not traversed by screen
readers — substance is in the adjacent paragraph copy); Pricing card rail
keyboard scrolling and Previous/Next disabled states; the comparison
table's semantic structure and sticky column; the Contact form's labels,
required/optional marking, and per-field error association
(`aria-describedby`); heading hierarchy on every public page (exactly one
`<h1>`, no skipped levels — verified this checkpoint via source inspection
on all six pages); reduced-motion behavior on the product-visual loops and
marketing reveal animations; dark-mode contrast.

## 9. Production environment documentation

- Read the updated "Production environment checklist" §1 in
  `supabase/scripts/README_bootstrap_new_club.md` — confirm the table
  correctly marks `SUPABASE_SECRET_KEY` and `PILOT_INQUIRY_HASH_SECRET` as
  server-only/never-`NEXT_PUBLIC_`, and `PILOT_INQUIRY_TO_EMAIL` as
  configuration (not a secret, but still not browser-exposed).
- Confirm the new §7 "Public site SEO" notes are present and mention the
  `NEXT_PUBLIC_APP_URL` sitemap/robots dependency and the deferred
  favicon/OG-image brand asset.

## 10. Secret-boundary verification

- `pnpm build`, then `grep -rl "SUPABASE_SECRET_KEY\|PILOT_INQUIRY_HASH_SECRET\|RESEND_API_KEY" .next/static/` — confirm no matches.
- Confirm `src/lib/supabase/privileged.ts` is imported only by
  `src/app/(marketing)/contact/actions.ts`.
- Confirm `import "server-only"` is present in `privileged.ts` and that
  `pnpm build` still succeeds (defense-in-depth — a client-side import of
  this module would now fail the build outright rather than silently
  bundling a secret).
- Confirm no `NEXT_PUBLIC_`-prefixed variable exists anywhere for
  `SUPABASE_SECRET_KEY`, `PILOT_INQUIRY_HASH_SECRET`, or `RESEND_API_KEY`.

## 11. Regression boundaries (unchanged, spot-check only)

Confirm unchanged: all six locked prices on `/pricing`; "first 10 clubs or
until public launch"; 12-month Founding price protection; no-per-member-fee
wording; the three operating-model choices and their exact wording on
`/contact`; the Member-self-service-is-not-public-booking distinction; the
SMS wording ("Optional text notifications for supported transactional
updates."). None of these files were touched this checkpoint.

## 12. Authenticated-app regression

Sign in as a Member, Pro, and Admin — confirm Calendar, Events, Lessons,
Admin Members, and Admin Reports all behave exactly as before. The only
change touching `(app)` routes this checkpoint is the added
`robots: { index: false }` metadata, which has no effect on rendered
content or behavior.
