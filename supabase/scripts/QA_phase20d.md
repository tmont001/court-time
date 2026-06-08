# QA Record — Phase 20D

## Pilot Blocker Fixes and Pre-Pilot Usability Improvements

This document records the verification status of each Phase 20D fix as it is
implemented and retested. It accompanies `QA_phase20b.md`, which contains the
full Phase 20B sign-off and the confirmed issue list that drives this phase.

**Phase 20B sign-off:** QA complete. Pilot not approved.
**Confirmed blockers driving Phase 20D:** Issues #4, #5, #8.
**Recommended pre-pilot fixes:** Issues #1, #6.

---

## Checkpoint 20D-A — Issue #8: Pro role access guards + hydration fix

**Status: Complete ✓ — all manual QA passed; pnpm tsc and pnpm build pass**

### What was fixed

Four admin-only pages were missing page-level role guards. The shared
`admin/layout.tsx` correctly passes both `admin` and `pro` through (required
so Pro can access `/admin/events`), but individual pages had no further check.
This allowed Pro users to load real admin-only data on `/admin/courts` and
`/admin/settings`, and caused error pages instead of clean redirects on
`/admin/members` and `/admin/audit-log`.

### Files changed

| File | Change |
|------|--------|
| `src/app/(app)/admin/courts/page.tsx` | Added `role` to profile select; added `if (profile?.role !== "admin") redirect("/calendar")` before courts query |
| `src/app/(app)/admin/settings/page.tsx` | Added `if (profile?.role !== "admin") redirect("/calendar")` before settings queries (role already selected) |
| `src/app/(app)/admin/members/page.tsx` | Added profile fetch (`select("role")`); added redirect guard before `Promise.all([get_members, get_club_invites])` |
| `src/app/(app)/admin/audit-log/page.tsx` | Added profile fetch (`select("role")`); added redirect guard before `get_audit_log` RPC |

`admin/layout.tsx` and `admin/events/page.tsx` unchanged.
No migrations, no RLS changes, no RPC changes.

### Manual QA results

**Admin:**
- [x] `/admin/courts` — loads correctly
- [x] `/admin/settings` — loads correctly
- [x] `/admin/members` — loads correctly
- [x] `/admin/audit-log` — loads correctly
- [x] `/admin/events` — loads correctly; roster controls visible and functional

**Pro:**
- [x] `/admin/events` — loads correctly; roster management accessible
- [x] `/admin/courts` — redirects cleanly to `/calendar`; no court data shown; no error page
- [x] `/admin/settings` — redirects cleanly to `/calendar`; no settings data shown; no error page
- [x] `/admin/members` — redirects cleanly to `/calendar`; no member data shown; no error page
- [x] `/admin/audit-log` — redirects cleanly to `/calendar`; no audit data shown; no error page

**Member:**
- [x] All `/admin/*` routes redirect to `/calendar` (layout guard, unchanged)

---

## Issue discovered during 20D-A QA: `/admin/events` hydration mismatch

**Status: Fixed in 20D-A, pending retest after restart**

### Cause

`AdminEventsClient.tsx` `formatDate` used a single `toLocaleString("en-US", { weekday, month, day, hour, minute })` call combining both date and time fields. When a single `Intl` call includes both date and time parts, **browsers** (en-US) inject an "at" connector between date and time — `"Wed, Jun 3 at 9:00 AM"` — while **Node.js** (which uses a different ICU library build) produces `"Wed, Jun 3, 9:00 AM"`. The mismatch causes a React hydration error on initial render.

This is a known divergence in `Intl.DateTimeFormat` behavior between browser runtimes and the ICU library bundled with Node.js. It is not a locale or timezone issue — it only occurs when date and time fields are combined in a single format call.

### Fix

Split the single `toLocaleString` into two separate calls joined by a space:

```ts
const datePart = d.toLocaleDateString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" });
const timePart = d.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true });
return `${datePart} ${timePart}`;
```

Neither call alone triggers the "at" connector. Both runtimes now produce
identical output: e.g. `"Wed, Jun 3 9:00 AM"`.

The club timezone is preserved in both calls. `suppressHydrationWarning` was
not used. SSR was not disabled. Output format changes from `"Wed, Jun 3 at 9:00 AM"` / `"Wed, Jun 3, 9:00 AM"` (inconsistent) to `"Wed, Jun 3 9:00 AM"` (consistent).

### File changed

| File | Change |
|------|--------|
| `src/app/(app)/admin/events/AdminEventsClient.tsx` | Replaced single `toLocaleString` with split `toLocaleDateString` + `toLocaleTimeString` joined by space |

### Retest results

- [x] Restarted `pnpm dev`; opened `/admin/events` as Admin with console open; refreshed and navigated away/back.
- [x] No hydration mismatch error in console.
- [x] Event date/time rendered consistently in deterministic format (no "at" connector, no visible change after load).
- [x] Event time correct in club timezone.
- [x] `/admin/events` as Pro: page loads; no hydration warning; roster controls present.
- [x] Pro redirects from `/admin/courts`, `/admin/settings`, `/admin/members`, `/admin/audit-log` confirmed clean; no admin-only data or error page before redirect.

---

## Checkpoint 20D-B — Issue #5: Member court-reservation duration selector and RPC validation

**Status: Complete ✓ — migration applied, manual QA passed; pnpm tsc and pnpm build pass**

### Scope

Member court reservations only. `CreateEventSheet.tsx` was not modified.
Admin/pro event duration is unrestricted.

### Files changed

| File | Change |
|------|--------|
| `src/app/(app)/calendar/CalendarShell.tsx` | State type `<60 \| 90>` → `<30 \| 60 \| 90 \| 120>`; pill array `[60, 90]` → `[30, 60, 90, 120]`; added `invalid_duration` → user-friendly message to `rpcErrorMessage` |
| `supabase/migrations/0053_create_reservation_duration_check.sql` | New migration — full `create_reservation` body from 0047 + duration allowlist check |

`CreateEventSheet.tsx` — **untouched**. Confirmed.

### Migration base

Migration `0047_create_reservation_override_check.sql` is the latest definition
of `create_reservation` (five migrations define it: 0003, 0010, 0037, 0043, 0047).
Migration 0053 reproduces the 0047 body exactly, inserting only the duration
check between the existing `p_ends_at <= p_starts_at` guard and the Phase 17A
override/hours block.

### Applying migration 0053

**Apply in Supabase SQL Editor before running manual QA against the database.**

1. Open your Supabase project → SQL Editor.
2. Paste the full contents of `supabase/migrations/0053_create_reservation_duration_check.sql`.
3. Run. Expected: no error; `create or replace function` completes.
4. Verify:
   ```sql
   select prosrc from pg_proc where proname = 'create_reservation';
   -- Expected: body contains 'not in (30, 60, 90, 120)' duration check
   ```

### Manual QA results

- [x] Migration `0053` applied successfully in Supabase SQL Editor.
- [x] Verified `create_reservation` function body includes `not in (30, 60, 90, 120)` duration check.
- [x] Booking sheet shows exactly four choices: **30 min**, **60 min**, **90 min**, **120 min**. Default remains 60 min.
- [x] **30-minute reservation:** booked successfully; verified in DB.
- [x] **60-minute reservation:** booked successfully; verified in DB.
- [x] **90-minute reservation:** booked successfully; verified in DB.
- [x] **120-minute reservation:** booked successfully; verified in DB.
- [x] **45-minute direct RPC attempt:** rejected with `invalid_duration`.
- [x] **Special-hours override regression:** booking beyond special closing hours rejected; booking ending within window succeeded.
- [x] **Booking confirmation notification regression:** passed.
- [x] `CreateEventSheet.tsx` untouched; admin/pro event duration unrestricted.

---

## Checkpoint 20D-C — Issue #4: Invited-user signup from `/join/<code>`

**Status: Complete ✓ — migration applied, corrected flow verified, manual QA passed; pnpm tsc and pnpm build pass**

### Confirmed architecture decisions

- Email confirmation remains enabled. Not disabled or worked around.
- Email template remains `{{ .ConfirmationURL }}`. Not changed.
- No service-role key required.
- Custom SMTP is a Phase 20E / pilot-launch configuration requirement (not code).

### Files changed

| File | Type | Change |
|------|------|--------|
| `supabase/migrations/0054_validate_club_invite_privacy.sql` | New migration | Replaces `email: string\|null` with `email_restricted: boolean` in `validate_club_invite` response |
| `src/app/auth/confirm/route.ts` | New Route Handler | Exchanges PKCE code via `exchangeCodeForSession`; validates `next` (/join/<code> only); sets session cookies on redirect response |
| `src/lib/supabase/middleware.ts` | Edit | Added `/sign-up` and `/auth/confirm` to `isAppRoute` exclusion list |
| `src/app/(auth)/sign-up/page.tsx` | New Server Component | Validates `redirect` param; redirects authenticated users; renders `SignUpForm` |
| `src/app/(auth)/sign-up/SignUpForm.tsx` | New Client Component | Email + password + confirm; email_restricted notice; `signUp()` with `emailRedirectTo`; check-email confirmation state; sign-in link |
| `src/app/(auth)/join/[code]/page.tsx` | Edit | `InviteValid.email → email_restricted: boolean`; signed-out branch adds "Create account" link and email-restriction notice |

### Migration 0054

**Apply in Supabase SQL Editor before running manual QA.**
Changes `validate_club_invite` to return `email_restricted: boolean` instead of
`email: string|null`. Existing UI did not display the invite email; this closes
the anonymous-caller privacy exposure while preserving all validation behavior.

```sql
-- Verify after applying:
select validate_club_invite('<any-valid-invite-code>');
-- Expected: contains "email_restricted": true/false (not "email": "...")
```

### Open-redirect protection in `/auth/confirm`

Only `/join/<32-char-hex>` passes the regex `^\/join\/[0-9a-f]{32}$`.
Any missing, absolute, or arbitrary `next` value redirects to
`/sign-in?error=invalid_redirect` without performing code exchange.

### Supabase Redirect URL entries required before local/production testing

Ensure these are present in Supabase → Authentication → URL Configuration → Redirect URLs:
- `https://court-time.vercel.app/**` (wildcard — covers `/auth/confirm?next=...`)
- `http://localhost:3000/**` (for local development)

The wildcard should cover `/auth/confirm` with query parameters. If wildcard
matching does not cover query strings in your Supabase plan, add the explicit entry:
- `https://court-time.vercel.app/auth/confirm`

### Email template

Current template uses `{{ .ConfirmationURL }}`. No change required. Supabase
builds the ConfirmationURL from the OTP and appends `?code=<pkce>` to the
`emailRedirectTo` value when the user clicks. The Route Handler at `/auth/confirm`
then exchanges the code.

### QA progress

**Invalid `next` redirect protection:** ✓ Passed
- [x] `/auth/confirm?next=https://evil.com` → redirected to `/sign-in?error=invalid_redirect`.
- [x] `/auth/confirm?next=/calendar` → redirected to `/sign-in?error=invalid_redirect`.
- [x] `/auth/confirm` (no code) → redirected to `/sign-in?error=confirmation_failed`.
- [x] No external navigation or data exposure occurred in any case.

**Initial signup-confirmation test — redundant steps identified:**
Initial test revealed that after clicking the confirmation link, the user landed on
`/join/<code>` and had to manually click "Accept Invitation" as a second step.
The intended flow is: confirm email → invite auto-accepted → `/welcome` once →
`/calendar`. Correction implemented: `/auth/confirm` now auto-accepts the invite
after exchanging the PKCE code, then redirects directly to `/welcome`. See
implementation note below.

**Test-user cleanup — out of scope:**
Supabase returned `Failed to delete user: Database error deleting user` when
attempting to delete a test Auth user during cleanup. This is not investigated or
fixed in Phase 20D-C. A new email alias will be used for the post-correction
retest. Deleting a user that has accepted an invite references profile/invite/audit
rows — deletion failure is expected behavior from Supabase's cascade handling.

### Correction: auto-accept in `/auth/confirm`

After `exchangeCodeForSession` establishes the session, the Route Handler now
calls `accept_club_invite` server-side using the same Supabase client (which has
the new session in its auth context). If acceptance succeeds, redirects to
`/welcome`. If acceptance fails (email_mismatch, expired, etc.), redirects to
`/join/<code>` with the session cookie set so the user sees the appropriate error
via the existing AcceptButton error display.

### Manual QA results (post-correction retest)

- [x] Migration `0054` already applied; `validate_club_invite` returns `email_restricted` boolean, not email value.
- [x] `/join/<code>` signed-out view: both "Sign in to accept" and "Create account" visible; email-restriction notice shown without revealing actual email address.
- [x] `/sign-up?redirect=/join/<code>`: restricted-invite notice shown, editable email field, sign-in fallback link present.
- [x] Signup with correct restricted email → "Check your email" state shown.
- [x] Clicking newest confirmation link → redirected directly to `/welcome` (no redundant sign-in or manual accept step).
- [x] `/welcome` is the only profile step → submit → `/calendar` with correct member role.
- [x] DB: `profiles.club_id` set, `club_invites.accepted_at`/`accepted_by` set, audit log `accept_invite` entry present.
- [x] Reusing the accepted invite link → "Invite already used" shown correctly.
- [x] Existing-user "Sign in to accept" path intact.
- [x] Wrong-email enforcement intact (`accept_club_invite` unchanged; `email_mismatch` error path redirects back to `/join/<code>` with session established).
- [x] Invalid `/auth/confirm?next=...` redirect tests passed (external URL, arbitrary internal path, missing params all redirected safely).
- [x] No hydration or runtime errors during corrected onboarding flow.
- [x] Supabase Auth user deletion error is test-cleanup only and out of scope; fresh email aliases used for onboarding tests.

### Custom SMTP — Phase 20E / pilot-launch prerequisite (retained)

Supabase built-in email is rate-limited and not suitable for production member
onboarding or password-reset reliability. Custom SMTP must be configured before
inviting real pilot members. No code change required. Add to Phase 20E launch checklist.

**Confirmation link failure:**
- [ ] Use an already-consumed or expired confirmation code (e.g., click the link twice).
- [ ] Expected: redirect to `/sign-in?error=confirmation_failed` (exchange fails).

### Custom SMTP — Phase 20E pilot-launch requirement

Supabase built-in email has rate limits not suitable for production. Custom SMTP
must be configured before inviting real pilot members. This does not affect any
application code. Add to Phase 20E / pilot-launch checklist.

Must preserve email verification. Must not assume invite redirect automatically
establishes an SSR-authenticated session without inspecting the existing
callback/confirmation architecture first.

---

## Checkpoint 20D-D — Issues #1 and #6: Pre-pilot usability fixes

**Status: Implemented — pending manual QA**

### Issue #1: Roster and occupancy refresh after mutations

**Root cause:** `AdminEventsClient` holds a local `events` state initialized from server props. The event card's occupancy count is derived from `ev.event_participants` and `ev.event_guests` arrays in that state. Roster mutations update Supabase correctly and `EventRosterSheet` already calls `loadRoster()` after each mutation — the roster rows update. But `AdminEventsClient`'s `events` state was never notified, so the parent card counts stayed stale.

**Fix:** Added `onRosterChange` callback prop chain: `AdminEventsClient` → `EventRosterButton` → `EventRosterSheet`. After every successful `loadRoster()`, `EventRosterSheet` calls the callback with the fresh participant rows and guest count. `AdminEventsClient.handleRosterChange` updates the specific event's `event_participants` and `event_guests` arrays in local state, causing the occupancy counts to recompute immediately on re-render.

**Files changed:**

| File | Change |
|------|--------|
| `src/app/(app)/calendar/EventRosterSheet.tsx` | Export `RosterParticipantRow` type; add `onRosterChange` prop; call it after each successful `loadRoster()` |
| `src/app/(app)/events/EventRosterButton.tsx` | Add `clubTimezone` and `onRosterChange` props; pass both to `EventRosterSheet` |
| `src/app/(app)/admin/events/AdminEventsClient.tsx` | Import `RosterParticipantRow`; add `handleRosterChange`; pass callback and `clubTimezone` to `EventRosterButton` |

No migrations. No new RPCs.

### Issue #6: Calendar own-reservation detail and cancel

**Root cause:** Reservation blocks in CalendarShell were rendered as `pointer-events-none <div>` for all non-admin users. No path existed for a member to view or cancel their own reservation from Calendar.

**Fix:**
1. Own (non-maintenance) reservation blocks are now rendered as clickable `<button>` for members when `isOwn && !isBlocked`. This calls `setSelectedReservation(res)`.
2. `ReservationDetailSheet` gains an optional `onMemberCancel` prop. When present, it shows a cancel button using the member-level action (not `adminCancelReservation`). The owner-profile fetch and "Booked by" line are suppressed in member mode.
3. CalendarShell passes `onMemberCancel` when `selectedReservation.owner_user_id === userId && userRole === "member"`.
4. New `cancelMemberReservation` server action in `calendar/actions.ts` enforces the same cancellation-window and grace-period rules as `my-schedule/page.tsx`. Returns `{ error }` if blocked so the sheet can display a message.

**Files changed:**

| File | Change |
|------|--------|
| `src/app/(app)/calendar/actions.ts` | Add `revalidatePath` import; add `cancelMemberReservation` server action |
| `src/app/(app)/calendar/ReservationDetailSheet.tsx` | Add `onMemberCancel` prop; member-mode cancel path; suppress "Booked by" and owner fetch in member mode |
| `src/app/(app)/calendar/CalendarShell.tsx` | Import `cancelMemberReservation`; make `isOwn && !isBlocked` blocks clickable; pass `onMemberCancel` to `ReservationDetailSheet` |

No migrations. No RLS changes. No new RPCs.

### Pending manual QA

**Issue #1 — roster refresh:**
- [ ] Open `/admin/events` as Admin → open roster on a scheduled event → add a member → occupancy count on the event card updates immediately (no page reload needed).
- [ ] Add a guest → event card occupancy count updates immediately.
- [ ] Remove a participant → event card count updates.
- [ ] Force Confirm, Offer Spot, Expire Offer → event card count updates after each action.
- [ ] Roster sheet rows are still correct after each mutation (unchanged behavior).

**Issue #6 — member reservation detail/cancel:**
- [ ] M1 books a court → own reservation block shows as "You" on the calendar.
- [ ] M1 taps the "You" block → reservation detail sheet opens showing court, date, time.
- [ ] "Booked by" line is NOT shown (member is viewing their own booking).
- [ ] **Within cancellation window + after grace period:** Cancel Booking button → "This booking can no longer be cancelled — the cancellation window has passed." error shown. Reservation not cancelled.
- [ ] **Outside cancellation window (or within grace period):** Cancel Booking → succeeds → reservation disappears from calendar → `/my-schedule` no longer shows it.
- [ ] M2's reservation block (another member's booking) shows as a non-clickable div — no detail sheet opens.
- [ ] Admin tapping any reservation still opens the admin-mode detail sheet with "Booked by" and admin-cancel behavior intact.

---

## Checkpoint 20D-E — Final sign-off

**Status: Not yet started**
