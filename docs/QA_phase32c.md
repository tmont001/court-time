# Phase 32C — Public Pilot Inquiry Workflow — QA

Requires migrations `0105_pilot_inquiries.sql` and
`0106_fix_pilot_inquiry_ambiguous_id.sql` both applied (Supabase SQL
Editor, cloud only). Until applied, `/contact` submissions will fail
closed with the generic form-level error ("Something went wrong
submitting your request...").

**Runtime correction (0106):** 0105 applied successfully, but the first
real submission exposed PostgreSQL error `42702` ("column reference "id"
is ambiguous"). Cause: `submit_pilot_inquiry`'s `returns table (id uuid,
deduped boolean)` creates an implicit `id` OUT parameter, which collided
with the unqualified `select id ... from public.pilot_inquiries` in the
duplicate-safety lookup. `0106_fix_pilot_inquiry_ambiguous_id.sql`
corrects only that column qualification (via a `pi` table alias) —
signature, validation, duplicate window, fingerprint throttle, and
privileges are all unchanged. After applying 0106, repeat the same
Staff-managed inquiry submission that originally failed and confirm it
now succeeds end-to-end.

Seed/config: run once with `RESEND_API_KEY` and `PILOT_INQUIRY_TO_EMAIL`
both set, and once with one or both unset, to exercise the best-effort
email path in both directions. `PILOT_INQUIRY_HASH_SECRET` is optional —
test once with it set and once unset. When testing the fingerprint
throttle (§10b), a request tool that lets you set `x-forwarded-for`
directly (curl, Postman) is more reliable than a browser, which won't let
you spoof that header.

**`SUPABASE_SECRET_KEY` is now required** for `/contact` to work at all —
this is a server-only, elevated-privilege key (never `NEXT_PUBLIC_`),
distinct from `NEXT_PUBLIC_SUPABASE_ANON_KEY`. `submit_pilot_inquiry` is
granted only to `service_role`; without this key configured, submissions
fail closed (see §14a). Run the full pass once with it configured, and
once with it deliberately unset, to confirm both paths.

---

## 1. Migration review and application

- Read `supabase/migrations/0105_pilot_inquiries.sql` end to end before
  applying.
- Confirm it does not touch any table, policy, or function outside
  `pilot_inquiries` and `submit_pilot_inquiry`.
- Confirm there is exactly **one** function created by this migration —
  `record_pilot_inquiry_email_status` no longer exists anywhere in the
  file.
- Apply via Supabase SQL Editor (cloud). Confirm in Table Editor:
  `pilot_inquiries` exists, RLS is enabled, and zero policies are listed.

## 2. Anonymous submission

- As a fully signed-out visitor (incognito), load `/contact` and submit a
  complete, valid form.
- Confirm success without ever being redirected to `/sign-in` and without
  any account being created (check Supabase Auth users — none added).

## 3. Required fields

Submit with each required field empty in turn — name, email, club name,
facility type, court count, member count, **current process**,
**operational challenge**, and **preferred operating model** — confirm a
field-specific error appears next to that field (or, for the radio group,
a legend-level error) and the form does not submit. All nine are now
required; only phone, website, preferred contact method, and additional
details remain optional.

## 4. Every facility-type option

Submit once per option (Private club, Country club, HOA or residential
community, Public or municipal facility, Tennis academy, School or
university, Other). Confirm each succeeds and the row in `pilot_inquiries`
shows the correct `facility_type` value.

## 4a. "Other" facility type requires clarification

Select "Other" and leave the clarification field blank — confirm a field
error appears and the form does not submit (client-side, via the field's
`required` attribute once shown, and server-side via both the Server
Action and the `pilot_inquiries_facility_type_other_required` table
constraint / `invalid_facility_type_other` RPC check). Confirm a filled-in
clarification succeeds and lands in `facility_type_other`.

## 5. Exactly three operating-model choices

Confirm the form shows **exactly three** radio options, in this order,
with this exact customer-facing wording:

- **Staff-managed** — "Our staff would manage court bookings, events,
  Member records, and communication. Members would not need Court Time
  accounts."
- **Member self-service** — "Our authenticated club Members would use
  Court Time to reserve courts, join events and programs, manage
  waitlists, and request lessons, while staff retains administrative
  oversight."
- **Not sure yet** — "We would like help deciding which approach fits our
  club."

There is no "Hybrid" option anywhere on the page.

## 5a. No Hybrid value accepted anywhere

- The rendered HTML never contains the string "hybrid" or "Hybrid."
- Submitting a request with `preferredOperatingModel=hybrid` crafted
  outside the UI (e.g. via dev tools editing the FormData, or a direct RPC
  call) is rejected: the Server Action's `OPERATING_MODELS` allowlist
  rejects it before ever calling the database, and if the RPC is called
  directly with `p_preferred_operating_model := 'hybrid'`, it raises
  `invalid_operating_model` and no row is inserted.

## 5b. Preferred operating model is required

Submit with no radio selected — confirm the browser's native "please
select one of these options" validation fires (the `required` attribute
is present on each radio in the group), and confirm that bypassing the
client (direct RPC call with `p_preferred_operating_model := ''` or a
value outside the three) is also rejected server-side.

## 6. Invalid controlled values

Using a direct RPC call, attempt `facility_type` and
`preferred_operating_model` values outside the controlled sets — confirm
`submit_pilot_inquiry` raises `invalid_facility_type` /
`invalid_operating_model` and no row is inserted.

## 7. Invalid email, URL, and counts

- Malformed email (`not-an-email`) → field error, no submission.
- Website without `http(s)://` (e.g. `example.com`) → field error.
- **Court count**: `0` → field error ("Enter a number of courts from 1 to
  500."); confirm 0 is rejected both client-side (`min={1}`) and
  server-side (Server Action + RPC + table CHECK all require `>= 1`).
  `501` → field error.
- **Member/regular-user count**: `0` → **succeeds** (0 is a valid answer
  for a facility with no formal membership); `-1` and `100001` → field
  error.

## 8. Length limits

Paste text far beyond each field's limit (e.g. 5,000 characters into
"Additional details," capped at 4,000; or 2,500 into "Current process" or
"Operational challenge," capped at 2,000) — confirm a field error appears
and no oversized row is ever persisted, even if a request is crafted to
skip the client form entirely.

## 9. Honeypot behavior

Using dev tools, populate the hidden `company` field and submit. Confirm
the visitor sees the normal success state, but no row is added to
`pilot_inquiries` and no operator email is sent.

## 10. Duplicate safety (email + club name)

Submit twice in a row with the **same email and same club name** within a
few minutes. Confirm the second submission still shows a normal success
state to the visitor, but `pilot_inquiries` contains only the original row
(no duplicate) — `submit_pilot_inquiry`'s 10-minute dedupe window matches
on **both** fields now, not email alone. Confirm that changing the club
name (same email) or changing the email (same club name) within that same
window is treated as a **new**, non-duplicate submission — this is a
materially different (and more accurate) signal than matching on email
alone.

## 10a. Fingerprint is not derived from email

Confirm (by reading `actions.ts` and migration 0105) that
`request_fingerprint` is an HMAC of the request's client-address header
(`x-forwarded-for` first value, falling back to `x-real-ip`), never a hash
of the email address. Two submissions with different emails/club names
from the same connection should produce the same `request_fingerprint`
value in the database; two submissions with the same email from different
connections should produce different fingerprints.

## 10b. Fingerprint throttle behavior

With `PILOT_INQUIRY_HASH_SECRET` set, submit 4 inquiries with **different**
emails and club names (so the duplicate-safety check in §10 doesn't
absorb them) but the same spoofed `x-forwarded-for` value, within 10
minutes. Confirm the first 3 succeed and the 4th is rejected with the
form-level message referencing too many requests from this connection
("Too many requests from this connection..."), and that no 4th row is
inserted. Confirm the threshold (3 per 10 minutes) matches migration
0105's `rate_limited` check.

## 10c. No raw client address stored or logged

Inspect `pilot_inquiries.request_fingerprint` values and confirm none of
them resemble a plain IP address (they're 64-character hex HMAC digests).
Search server logs from a test run for any IP-address-shaped string —
confirm none appear; `actions.ts` reads the header once, feeds it directly
into the HMAC, and never assigns it to a variable that gets logged.

## 11. Fingerprint unavailable — legitimate inquiry still succeeds

With `PILOT_INQUIRY_HASH_SECRET` unset (or in local dev, where no reverse
proxy sets `x-forwarded-for`), submit a normal, valid inquiry. Confirm it
succeeds — the absence of a fingerprint never blocks a legitimate
submission; only the email+club duplicate-safety check applies.

## 12. Durable record creation

For a successful submission, confirm every submitted field (including
optional ones left blank) lands correctly in `pilot_inquiries` via the
Supabase Table Editor or SQL Editor — `status` defaults to `'new'`.

## 13. Operator email success

With `RESEND_API_KEY` and `PILOT_INQUIRY_TO_EMAIL` both set, submit a
complete inquiry. Confirm an email arrives at the configured address with
subject `New Court Time pilot inquiry — [Club name]` and all submitted
fields, including "Approximate Members or regular users."

## 14. Operator email failure — inquiry remains durable, no anonymous status RPC

Temporarily set an invalid `RESEND_API_KEY` (or block network to Resend)
and submit. Confirm:
- the visitor still sees the normal success confirmation (never told the
  submission failed);
- the row is present in `pilot_inquiries` regardless;
- there is **no** `operator_email_status` or `operator_email_error` column
  on the table, and **no** `record_pilot_inquiry_email_status` function
  exists to call — the failure is visible only in server logs
  (`console.error("pilot inquiry operator email failed", { inquiryId,
  error })`), never persisted to the database.

## 14a. Missing `SUPABASE_SECRET_KEY` fails closed

With `SUPABASE_SECRET_KEY` unset, submit a normal, valid inquiry. Confirm:
- the visitor sees the generic form-level error ("Something went wrong
  submitting your request...") — the same message used for other
  submission failures, not a distinct or more revealing one;
- **no row is inserted** into `pilot_inquiries` (unlike the operator-email
  failure case in §14, this is a hard failure with no durable record —
  there is nothing to persist without a way to call the RPC);
- the server log contains only the safe diagnostic
  `"pilot inquiry submission blocked: SUPABASE_SECRET_KEY is not
  configured"` — no key value, no submission content;
- the code never attempts the submission with a lower-privilege client as
  a fallback (confirm by reading `actions.ts` — there is no anon-key
  client anywhere in the submission path anymore).

## 15. Missing environment variables

With `PILOT_INQUIRY_TO_EMAIL` unset (regardless of `RESEND_API_KEY`) but
`SUPABASE_SECRET_KEY` **set**, submit. Confirm: visitor success, durable
record, and a server-side `console.warn` noting the email was skipped
(inquiry id only — no submission content). No error is thrown to the
visitor either way.

## 16. Duplicate-click behavior

Click "Request a pilot" and immediately click again (or trigger a double
submit). Confirm the button disables and reads "Submitting…" during the
pending request; confirm via §10's dedupe behavior that even a successful
double-POST (e.g. slow network double-tap that both land server-side)
only ever produces one row, as long as email and club name match.

## 17. Accessibility

- Every input/select/textarea/radio has an associated `<label>`.
- Field errors are linked via `aria-describedby` and use `role="alert"`.
- The operating-model radio group is a `<fieldset>`/`<legend>`, each radio
  is individually `required`, and each option's descriptive text is inside
  its own `<label>`.
- Tab through the entire form — logical order, visible focus ring on every
  control, no keyboard trap.
- The honeypot field is unreachable by Tab (`tabIndex={-1}`) and hidden
  from screen readers (`aria-hidden="true"`).
- Run an automated accessibility check (axe or Lighthouse) against
  `/contact` in both the form and success states.

## 18. Mobile

At 320px/375px/390px: confirm no page-level horizontal overflow, every
field is comfortably tappable, the two-column field pairs stack to one
column, and the three operating-model cards remain readable.

## 19. Dark mode

Confirm the form, field errors, honeypot (invisible either way), operating
-model cards, member-count helper text, and the success state all render
with correct contrast and no unstyled flashes.

## 20. Signed-out public access

Re-confirm `/contact` itself remains reachable signed-out (already covered
by the Phase 32B middleware fix) — this checkpoint changes the page's
content, not its route classification.

## 21. Authenticated-app regression

Sign in as a Member, Pro, and Admin and confirm nothing in the
authenticated app changed — Calendar, Events, Lessons, Admin Members,
Admin Reports all behave exactly as before. No persistent Member/guest
product schema, Admin-created-reservation behavior, or account-conversion
logic was added in Phase 32C (see the Phase 33 handoff note below) —
confirm no such tables, columns, or UI exist yet.

## 22. RLS / RPC security

- Confirm `pilot_inquiries` has RLS enabled, zero policies, **and** an
  explicit `revoke all on table public.pilot_inquiries from public, anon,
  authenticated` — attempt a direct `select * from pilot_inquiries` as the
  `anon`/publishable key via the REST API (`/rest/v1/pilot_inquiries`) and
  confirm it returns an empty/denied result, never actual rows. Repeat for
  insert/update/delete via REST — all denied.
- Confirm `submit_pilot_inquiry` is explicitly `revoke`d from `public,
  anon, authenticated` and then `grant`ed **only to `service_role`** — it
  is **not** callable by `anon` or `authenticated` at all. (This corrects
  the prior draft, which granted it to `anon, authenticated` — that gap is
  exactly what this checkpoint closes.)
- Confirm there is no other pilot-inquiry function of any kind grantable to
  `anon` or `authenticated` (`record_pilot_inquiry_email_status` was
  already removed in the prior pass; no replacement public RPC was added).

## 22a. Direct RPC invocation is denied for both anon and authenticated

Using the project's `anon`/publishable key directly (curl or the Supabase
JS client outside the app, e.g. `supabase.rpc('submit_pilot_inquiry',
{...})` with `createClient(url, anonKey)`), attempt to call
`submit_pilot_inquiry` with a fully valid payload. Confirm it is rejected
with a permission-denied error and **no row is inserted**. Repeat signed
in as an ordinary authenticated Member/Pro/Admin (their session's JWT,
still not `service_role`) — confirm the same denial. This is the exact
gap this checkpoint closes: previously, either of these callers could
invoke the RPC directly, skip the Server Action's honeypot entirely, and
either omit `p_fingerprint` or supply an arbitrary value to bypass the
throttle.

## 22b. Normal submission still works end-to-end

With `submit_pilot_inquiry` now locked to `service_role`, confirm a normal
signed-out `/contact` submission through the UI still succeeds (it goes
Browser → Server Action → `createPrivilegedClient()` → RPC, never through
the browser's own anon-key client) and that the fingerprint throttle from
§10b still functions correctly through that path.

## 22c. `SUPABASE_SECRET_KEY` never reaches the browser

- Confirm `src/lib/supabase/privileged.ts` has no `"use client"` directive
  and is imported only from `src/app/(marketing)/contact/actions.ts` (a
  `"use server"` file) — never from any Client Component.
- Run `pnpm build`, then search `.next/static/` (the client bundle output)
  for the literal string `SUPABASE_SECRET_KEY` and for any configured
  secret-key value — confirm neither appears. (Next.js only inlines
  `NEXT_PUBLIC_`-prefixed variables into the client bundle, and
  `SUPABASE_SECRET_KEY` deliberately has no such prefix — this step
  verifies that in practice, not just by convention.)
- Confirm the standard cookie-aware SSR client (`src/lib/supabase/server.ts`,
  used everywhere else in the app) is **not** used anywhere in the
  pilot-inquiry submission path — only `createPrivilegedClient()` is.

## 23. No anonymous inquiry reads

Confirm there is no admin UI, API route, or RPC in this checkpoint that
lets any authenticated club Admin, Pro, or Member — or any anonymous
caller — list, read, or update `pilot_inquiries` rows by ID. Retrieval is
SQL Editor/Table Editor only, by the Court Time operator.

## 24. No automatic package assignment

Confirm nowhere in this checkpoint's code does `preferred_operating_model`
(or any other submitted field) select, assign, or unlock a plan,
entitlement, or feature. It is stored as a plain discovery signal only.

## 25. No automatic club creation

Confirm a pilot inquiry never creates a row in `clubs`, `profiles`, or any
other application table — `pilot_inquiries` is fully standalone with no
foreign keys into the rest of the schema.

## 26. No pricing-page changes

Re-confirm `/pricing` (cards, comparison table, all six locked prices) is
byte-for-byte unchanged — this checkpoint did not touch
`src/app/(marketing)/pricing/`.

---

## Member-versus-guest boundary (documentation only — no schema/behavior added)

Phase 32C does not introduce any new Member/guest schema or authenticated-
product behavior. For discovery purposes only, the working distinction is:
a **Member** may exist as a persistent, staff-managed record without ever
having an authentication account; a **guest** is an occasional, non-member
participant; an **authenticated Member** additionally has self-service
access. Nothing in this checkpoint's code encodes this distinction — it
exists only in the inquiry form's plain-language copy and this note.

## Phase 33 handoff — Staff-Managed Operations audit

A future Staff-Managed Operations audit must evaluate, before any of this
is built:

- no-account Member records;
- Admin-created reservations on behalf of those Members;
- Member versus guest event participation;
- direct email/SMS communication and consent for no-account Members;
- reporting implications;
- account conversion (no-account → authenticated) without duplicating
  history;
- archive/deactivation behavior instead of destructive deletion.

## Phase 33 discovery handoff — commercial packaging

The following fields collected here are intended to inform Phase 33
commercial packaging decisions, not to trigger any automatic behavior now:
`facility_type`, `court_count`, `approximate_member_count`,
`preferred_operating_model`, `operational_challenge`.

Evaluate whether a permanent staff-managed package and a Member
self-service package are commercially and operationally justified using
pilot inquiries and actual club interviews.
