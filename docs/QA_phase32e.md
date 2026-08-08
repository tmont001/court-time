# Phase 32E — Final Regression, Production Configuration, and Phase 32 Closeout

Read-only/verification checkpoint — no product, pricing, database, or
migration changes. This document closes out Phase 32 (32A–32E).

---

## Phase 32 completion status

| Checkpoint | Commit | Status |
| --- | --- | --- |
| 32A — Recovery & gap audit | (audit only, no commit) | Complete |
| 32B — Public site access, positioning, pricing | `4d2e96f` Refresh public pilot marketing experience | Complete |
| 32C — Public pilot inquiry workflow | `b7c75eb` Add secure public pilot inquiry workflow | Complete |
| 32D — Public trust, accessibility, SEO | `f1dbdd2` Add public trust and SEO readiness | Complete |
| 32E — Final regression & closeout | this document | Complete (verification only) |

Migrations `0105_pilot_inquiries.sql` and `0106_fix_pilot_inquiry_ambiguous_id.sql`
are applied in Supabase and are immutable — no further migration was needed
or created for 32E.

## Public marketing routes (live)

`/`, `/features`, `/pricing`, `/contact`, `/privacy`, `/terms` — all
signed-out `200`, page-specific title/description/canonical, no redirect to
`/sign-in`. `/robots.txt`, `/sitemap.xml`, `/icon` all `200`. Private/auth
routes (`/calendar`, `/admin/*`, `/profile`, `/sign-in`, etc.) unaffected —
private routes redirect signed-out visitors to `/sign-in` as before;
`/sign-in` itself and the rest of the `(auth)` group carry
`noindex, nofollow`.

## Pilot inquiry architecture (unchanged since 32C, re-verified 32E)

Browser → Next.js Server Action (`submitPilotInquiryAction`) → server-only
privileged Supabase client (`SUPABASE_SECRET_KEY`, `src/lib/supabase/privileged.ts`,
`import "server-only"`) → `submit_pilot_inquiry` RPC, granted **only** to
`service_role`. `pilot_inquiries` has RLS enabled with zero policies and
explicit `revoke all` from `public, anon, authenticated`. Three operating-model
choices only (`staff_managed`, `member_self_service`, `not_sure` — no
`hybrid`). Abuse control: duplicate-safety on normalized email + club name
(10 min), optional HMAC request-fingerprint throttle (3 per 10 min, never a
raw address). Operator email best-effort via Resend; failure never changes
visitor-facing success and is logged server-side only.

## Production environment requirements

See `supabase/scripts/README_bootstrap_new_club.md` §1 "Vercel environment
variables" (updated Phase 32D/E) for the authoritative, exposure-annotated
list. Summary: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`NEXT_PUBLIC_APP_URL` are public/browser-safe; `SUPABASE_SECRET_KEY`,
`PILOT_INQUIRY_HASH_SECRET`, `RESEND_API_KEY` are server-only and must never
carry a `NEXT_PUBLIC_` prefix; `PILOT_INQUIRY_TO_EMAIL` is configuration,
not a secret, but still not browser-exposed. `TWILIO_*` vars are
pre-existing (Phase 16+), optional, unrelated to Phase 32.

## Intentionally deferred (Phase 33+ or later)

- Real Court Time favicon/brand mark (current favicon is a generated "CT"
  monogram placeholder, `src/app/icon.tsx`).
- Open Graph share image (no image asset exists; text-only OG fallback in
  place).
- Analytics.
- Structured data (JSON-LD) — no real business data (address/hours/etc.)
  exists to back it yet.
- A direct scheduling/calendar-booking link on `/contact`.
- Testimonials/case studies — no real pilot-club evidence exists yet.
- Under-13/junior-account policy — requires a separate product/legal
  decision before Court Time supports direct under-13 accounts; not
  addressed in Privacy.
- Staff-Managed commercial packaging/restructuring — explicitly Phase 33,
  informed by `pilot_inquiries.preferred_operating_model` and real club
  interviews, not automated.

## Known non-blocking observations

- ~~SMS wording used close paraphrases instead of the exact locked
  sentence~~ — **resolved.** Home and Features now use the exact locked
  sentence, "Optional text notifications for supported transactional
  updates.", as the feature description; the Pricing comparison table's
  row label (too short for the full sentence) uses the approved short
  form, "Optional transactional text notifications." No Twilio mention,
  no default-active claim, no guaranteed-delivery claim, no bulk-SMS claim
  anywhere.
- `NEXT_PUBLIC_APP_URL` is not yet confirmed for the actual current
  production hostname in Vercel itself — `supabase/scripts/bootstrap_new_club.sql`
  hardcodes `https://court-time.vercel.app` as the deployed app URL, which
  is the strongest repo evidence available, but this must be confirmed
  against the live Vercel project before deploy (see the main report).
