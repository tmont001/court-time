# QA Record — Phase 20E

## Pilot Closeout

This document records the verification status for Phase 20E checkpoints:
20E-A (QA completion), 20E-B (pre-launch configuration), and 20E-C (pilot sign-off).

20E-A bug discovered and fixed during QA is documented in `QA_phase20d.md`
(EventDetailSheet capacity stale after roster mutations — fixed, retested, committed
in `1fa28f2`).

---

## Checkpoint 20E-A — QA Completion

**Status: Complete ✓**

All outstanding manual QA items from Phase 20D passed. See `QA_phase20d.md` for the
full checklist:

- 20D-D Issue #1 (roster/occupancy refresh on `/admin/events`): all items passed
- 20D-D Issue #6 (member calendar reservation detail and cancel): all items passed
- 20D-C confirmation-link-already-consumed failure: passed (redirect to
  `/sign-in?error=confirmation_failed`)
- EventDetailSheet capacity fix discovered, implemented, and retested during 20E-A
  regression; committed in `1fa28f2`

---

## Checkpoint 20E-B — Pre-Launch Configuration Verification

**Status: Complete ✓ — all production configuration prerequisites verified**

### Custom SMTP (Resend)

- [x] Resend domain `court-time.app` verified.
- [x] Supabase custom SMTP configured with Resend; sender is
  `Court Time <no-reply@court-time.app>`.
- [x] Resend delivery logs confirm `POST /emails` status 200 for all Supabase
  Auth emails.
- [x] Password reset email: delivered and flow passed end-to-end.
- [x] Fresh production invite signup confirmation email: delivered and flow passed
  end-to-end. Clicking the confirmation link from a production-initiated signup
  redirects correctly to `https://court-time.vercel.app/welcome`.

**Local-dev caveat (not a production blocker):** Signup initiated from
`http://localhost:3001` generates a confirmation link with a localhost redirect
URL (`redirect_to=http://localhost:3001/...`). Clicking that link from a different
machine or email client fails. Workaround: when testing invite signup against
production Supabase, initiate signup from the deployed Vercel URL, not localhost.
The production flow is unaffected.

### Auth Redirect URL Configuration

- [x] `https://court-time.vercel.app/**` wildcard is present in Supabase →
  Authentication → URL Configuration → Redirect URLs; covers `/auth/confirm?next=...`
  with query parameters.
- [x] `{{ .ConfirmationURL }}` template confirmed working; no template change required.

### Vercel Environment Variables

- [x] All required public production environment variables are present in Vercel
  Production: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and
  `NEXT_PUBLIC_APP_URL`. No `NEXT_PUBLIC` service-role key is present or required.

### Production Database Verification

- [x] `verify_production_setup.sql` executed; all 10 checks passed:
  - All 16 required tables present
  - All required columns present
  - RLS enabled on all tables
  - `notifications` table in `supabase_realtime` publication
  - All 15 required RPCs present
  - `club-logos` storage bucket exists
  - `update_club_settings`: only the 4-argument overload present

---

## Checkpoint 20E-C — Pilot Sign-Off

**Status: Not yet started**
