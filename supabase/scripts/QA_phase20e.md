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
      Production: `NEXT_PUBLIC_`SUPABASE\_`URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and
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

**Status: Complete ✓ — Approved for private pilot**

---

### Go / No-Go Result

**GO. All pilot blockers resolved. All pre-pilot usability fixes verified. Production
configuration confirmed. Deferred list frozen.**

---

### Resolved Pilot Blockers (from Phase 20B QA)

These three issues were hard blockers identified in the Phase 20B sign-off. All
are resolved and verified.

| Issue  | Description                                                                                                                                                                                                      | Resolution                                                                                                                                                                                                                                                 |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **#4** | No account-creation path for brand-new invited members. `/join/<code>` signed-out view only offered "Sign in to accept" with no way to create a new account.                                                     | Fixed in **20D-C**: new `/sign-up` page and `SignUpForm`, PKCE confirm handler at `/auth/confirm`, `0054_validate_club_invite_privacy` migration. New flow: `/join/<code>` → Create account → email confirmation → auto-accept → `/welcome` → `/calendar`. |
| **#5** | Member court-reservation duration limited to 60/90 min. 30 and 120 min options missing. No server-side duration validation on `create_reservation`.                                                              | Fixed in **20D-B**: `CalendarShell` pill selector widened to [30, 60, 90, 120]; `0053_create_reservation_duration_check` migration adds allowlist guard in the RPC. Admin/Pro event duration unrestricted.                                                 |
| **#8** | Pro role could load real admin-only data on `/admin/courts` and `/admin/settings`. Page-level role guard missing; `/admin/members` and `/admin/audit-log` showed error pages for Pro instead of clean redirects. | Fixed in **20D-A**: role guard added to all four admin-only server components; Pro redirects cleanly to `/calendar` for those routes; Pro retains access to `/admin/events` for roster management.                                                         |

---

### Resolved Pre-Pilot Usability Fixes (from Phase 20B QA)

These issues were not hard blockers but were recommended before the pilot for a
coherent member experience. All are resolved and verified.

| Issue                         | Description                                                                                                                                                                                                                    | Resolution                                                                                                                                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **#1**                        | Admin event card occupancy counts and roster rows stale after mutations on `/admin/events`. Page reload required to see correct state.                                                                                         | Fixed in **20D-D**: `onRosterChange` callback chain `AdminEventsClient → EventRosterButton → EventRosterSheet`; roster mutations push updated participant rows and guest count back to parent state immediately.                                     |
| **#6**                        | Members had no way to manage or cancel their own court reservation from Calendar. Cancellation was only available from `/my-schedule`.                                                                                         | Fixed in **20D-D**: own reservation blocks are now clickable; `ReservationDetailSheet` gains a member-mode cancel path via `cancelMemberReservation` server action with the same cancellation-window and grace-period enforcement as `/my-schedule`. |
| **Hydration**                 | `/admin/events` showed a React hydration mismatch on initial render caused by `Intl.DateTimeFormat` producing different output in Node.js vs. browser when date and time parts are combined in a single `toLocaleString` call. | Fixed in **20D-A**: split into separate `toLocaleDateString` + `toLocaleTimeString` calls joined by a space. Deterministic on both runtimes.                                                                                                         |
| **EventDetailSheet capacity** | Calendar event detail sheet showed stale capacity counts after roster mutations made inside the nested roster sheet. `/admin/events` counts were already correct; the Calendar-side sheet had no `onRosterChange` wiring.      | Fixed in **20E-A**: `EventDetailSheet` now holds local participant and guest-count state; `onRosterChange` from the inline `EventRosterSheet` updates it after every successful roster fetch.                                                        |

---

### Explicitly Deferred (Not Pilot Blockers)

The following items were identified during Phases 20A–20E and are explicitly
deferred to post-pilot phases. Each is a known gap, not an oversight.

| Item                                     | Notes                                                                                                                                                                                                                             |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Automated SMS dispatch                   | In-app notifications are pilot-critical. SMS delivery requires Twilio configuration, which is deferred. `sms_opt_in` column and schema are in place.                                                                              |
| Email notifications                      | In-app notification bell is pilot-critical. Email delivery of notifications is a post-pilot enhancement.                                                                                                                          |
| Operator self-serve / setup UI           | First pilot club is onboarded manually using `README_bootstrap_new_club.md`. Self-serve operator signup deferred.                                                                                                                 |
| Multi-club switching                     | Single-club architecture sufficient for pilot. `club_id` is on profiles; multi-club UI deferred.                                                                                                                                  |
| BottomSheet UX standardization           | Five sheets (InviteSheet, CreateEventSheet, CreateMaintenanceSheet, EventDetailSheet, EventRosterSheet) still use static drag handles rather than the shared `BottomSheet` component. Cosmetic; deferred to a post-pilot UX pass. |
| Waitlist promotion mode toggle           | Admin toggle between offer-confirm and auto-promote modes. Needs migration + RPC branch + mid-flight edge-case handling. Deferred.                                                                                                |
| Notification settings consolidation      | SMS opt-in and per-kind preferences are split across `/profile` and `/profile/notifications`. Consolidate under `/profile/notifications` in a future profile polish phase.                                                        |
| Guest contact info                       | Guest name only for v1. Full contact details (email, phone) deferred.                                                                                                                                                             |
| Bulk participant import / CSV export     | Not in pilot scope.                                                                                                                                                                                                               |
| Public event embed                       | Not in pilot scope.                                                                                                                                                                                                               |
| Rate limiting hardening                  | No per-endpoint rate limiting beyond Supabase's built-in protections. Post-pilot.                                                                                                                                                 |
| Full error monitoring stack              | No Sentry or equivalent. Console errors visible in Vercel logs. Post-pilot.                                                                                                                                                       |
| Issue #2 — sticky-header console warning | Next.js logs "Skipping auto-scroll behavior due to `position: sticky`" during route changes. No visible navigation or scroll failure. Cosmetic; review during post-pilot UX polish.                                               |
| Admin/host as event participant          | Admins and hosts organizing events do not automatically consume a participant spot. Intentional for v1; enhancement deferred.                                                                                                     |

---

### Production Configuration Readiness

All items verified in Checkpoint 20E-B:

- Custom SMTP via Resend (`court-time.app` domain verified; sender `Court Time <no-reply@court-time.app>`)
- Password reset and invite signup confirmation emails confirmed delivered and functional from production
- Supabase Auth redirect URL wildcard covers `/auth/confirm?next=...`
- All required public Vercel environment variables confirmed present
- `verify_production_setup.sql` all 10 checks passed

---

### Post-Pilot Release Discipline

- `main` is production-stable from pilot launch. No direct commits for feature work.
- New features go on feature branches; merge to `main` requires:
  - `pnpm tsc --noEmit` passes
  - `pnpm build` passes
  - Focused manual QA of affected flows
- Production migrations must be forward-safe and non-destructive: no `DROP COLUMN`, no data loss, `IF EXISTS` guards on all drops.

---

### Pilot Operating Notes

**Inviting members:**

1. Admin navigates to `/admin/members` → opens the invite sheet → creates an invite (with optional email restriction and role).
2. Copy the generated `/join/<code>` URL and share it directly with the invitee.
3. Invitees with existing accounts use "Sign in to accept." Brand-new members use "Create account" — they must initiate signup from the production URL (`https://court-time.vercel.app/join/<code>`), not a locally-forwarded link, for email confirmation to redirect correctly.

**Email confirmation:**
Confirmation emails are delivered via Resend. If a member reports not receiving an email, check Resend logs. The confirmation link is single-use; a consumed or expired link redirects to `/sign-in?error=confirmation_failed`.

**Auth user deletion caveat:**
Attempting to delete a Supabase Auth user who has accepted an invite via the Supabase dashboard will fail (`Database error deleting user`) due to foreign-key constraints on `profiles`, `club_invites`, and `audit_log`. To deactivate a pilot member, use the app's deactivation controls in `/admin/members` rather than deleting the Auth user.

**Supabase Auth user deletion (test accounts):**
During testing, use fresh email aliases for each signup test rather than attempting to reuse or delete accounts that have completed the invite flow.
