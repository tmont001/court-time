# QA Checklist — Phase 20B

## End-to-End Core Flow QA (Pilot Readiness)

Run this checklist manually against the deployed pilot environment (or local `pnpm dev`
connected to the production Supabase project). All critical user journeys across admin,
pro, and member roles must pass before the pilot begins.

**How to use this checklist**

- Work through sections in order. Section 1 sets up the test data all other sections depend on.
- Check each box `[ ]` as you complete it.
- Record any failure in the **Issues Log** (Section 12) with severity and reproduction steps.
- Only Pilot Blocker failures require a fix before the pilot. Everything else is logged and deferred.
- SQL queries run in the Supabase SQL Editor as the postgres user unless otherwise noted.

---

## 1. Test Data and Account Setup

Complete this section first. All downstream tests reference these accounts and data by name.

### 1A. Required accounts

Create or confirm all of the following exist in the pilot Supabase project.
Use the Supabase Authentication dashboard → Users to create accounts, and
`/admin/members` to assign roles and check invite status.

| Label             | Role   | Purpose                              | Email / Notes          | Ready? |
| ----------------- | ------ | ------------------------------------ | ---------------------- | ------ |
| **Admin**         | admin  | All admin flows, configuration tests | e.g. admin@example.com | ☑      |
| **Pro**           | pro    | Pro-role access tests                | e.g. pro@example.com   | ☑      |
| **Member 1 (M1)** | member | Primary booking and event member     | e.g. m1@example.com    | ☑      |
| **Member 2 (M2)** | member | Waitlist advance target              | e.g. m2@example.com    | ☑      |
| **Member 3 (M3)** | member | Additional waitlist / offer tests    | e.g. m3@example.com    | ☑      |

> Optional: a sixth account in a **second club** for cross-club isolation (Section 9).
> If you do not have a second club, mark those checks N/A.

### 1B. Required courts

- [x] At least **two active courts** exist in the club (`/admin/courts`).
      Record their names: Court A = \***\*\_\_\*\***, Court B = \***\*\_\_\*\***.

### 1C. Required events

Create or confirm the following scheduled future events exist.
Use the calendar or any existing event creation path.

| Label            | Capacity | Who is in it                                                    | Purpose                                                  |
| ---------------- | -------- | --------------------------------------------------------------- | -------------------------------------------------------- |
| **Event-Open**   | 5        | Admin as host, M1 confirmed                                     | Open capacity — join, leave, notification tests          |
| **Event-Full**   | 1        | Admin as host, M1 confirmed; M2 waitlisted #1, M3 waitlisted #2 | Full event — waitlist offer, advance, accept, pass tests |
| **Event-Roster** | 4        | Admin as host, M1 confirmed                                     | Admin roster actions, guest tests                        |

```sql
-- Confirm the three events exist and have the expected status
select id, title, capacity, status, starts_at
from events
where status = 'scheduled'
order by starts_at
limit 10;
-- Expect: at least three scheduled events with future starts_at
```

- [x] Event-Open exists with capacity ≥ 5, M1 confirmed.
- [x] Event-Full exists with capacity 1, M1 confirmed, M2 waitlisted at position #1, M3 waitlisted at position #2.
- [x] Event-Roster exists with capacity 4, M1 confirmed.

> **QA observation:** The roster setup completed correctly, but the event occupancy display did not
> update immediately after roster changes made through the admin roster controls. A manual page
> refresh showed the correct occupancy. The underlying data state (participant rows, waitlist
> positions) was correct throughout. Logged in Section 12 as Issue #1 — important, non-blocking,
> can defer. We will continue QA and increase severity only if the same stale capacity display
> affects member joining, guest capacity, offer acceptance, participant removal, or other
> pilot-critical actions.

### 1D. Operating hours and booking rules baseline

- [x] Confirm operating hours cover today's date (check `/admin/settings` → Operating Hours).
      Record open/close: \***\*\_\_\*\*** – \***\*\_\_\*\***
- [x] Record booking window days: \***\*\_\_\*\***
- [x] Record cancellation window hours: \***\*\_\_\*\***
- [x] Record cancellation grace period minutes: \***\*\_\_\*\***
- [x] Record waitlist offer window hours: \***\*\_\_\*\***

> **Section 1 status: Complete with one documented non-blocking issue.** All required accounts,
> courts, events, roster states, and baseline settings were verified. Issue #1 remains open for
> broader observation during subsequent QA sections.

---

## 2. Authentication and Onboarding Flows

### 2.1 Sign in — valid credentials

**Account:** Admin  
**Navigation:** Go to `/sign-in`

- [x] Enter Admin email and correct password → click **Sign In**.
- [x] **Expected:** Redirected to `/calendar`. No error shown.

---

### 2.2 Sign in — wrong password

**Account:** Any  
**Navigation:** `/sign-in`

- [x] Enter a valid email with an incorrect password → click **Sign In**.
- [x] **Expected:** Error message shown (e.g., "Invalid email or password"). Stay on `/sign-in`.

---

### 2.3 Authenticated user does not see sign-in page

**Account:** Admin (already signed in)

- [x] While signed in, navigate directly to `/sign-in`.
- [x] **Expected:** Redirected to `/calendar` immediately.

---

### 2.4 Unauthenticated user cannot access protected pages

**Account:** None (signed out or private/incognito window)

- [x] Visit `/calendar` without being signed in.
- [x] **Expected:** Redirected to `/sign-in`.
- [x] Visit `/admin/settings` without being signed in.
- [x] **Expected:** Redirected to `/sign-in`.

---

### 2.5 Forgot password and reset flow

**Account:** M1  
**Navigation:** `/sign-in` → **Forgot password**

- [x] Click **Forgot password** → enter M1's email → click **Send reset link**.
- [x] **Expected:** Confirmation message shown ("Check your email…"). ✓ Passed.
- [x] Open the reset email → click the link.
- [x] **Expected:** Lands on `/reset-password` on the production URL (not localhost).
      **✓ Passed on retest.** First attempt failed with `otp_expired` (logged as Issue #3 —
      likely caused by a prior link being opened first, or mail-client link prefetching).
      Fresh-link retest reached `/reset-password` correctly on the production domain.
- [x] Enter and confirm a new password → submit.
- [x] **Expected:** Success message or redirect to sign-in.
- [x] Sign in with the new password.
- [x] **Expected:** Access granted; lands on `/calendar`.
- [x] Reset M1's password back to a known value before continuing.

> **Monitor during pilot.** The first attempt produced `otp_expired` with the production domain
> correct. The fresh-link retest succeeded. Probable cause: an earlier link was opened first
> (consuming the token) or the mail client prefetched the URL. Not a pilot blocker. If members
> report password-reset failures during the pilot, advise them to use only the most recent reset
> email and open the link promptly.

---

### 2.6 Invite acceptance — valid link

**Account:** A new test user (brand-new, no existing Auth account)  
**Setup:** Admin creates a member invite at `/admin/members` → copy the invite link.

- [x] Admin creates a new invite for role **member** → copies the invite link.
- [x] Open the link in a new browser tab while signed out.
- [x] **Expected:** `/join/<code>` page shows club name, role, and a "Sign in to accept" button. ✓ Passed.
- [ ] **Expected:** A brand-new invited member can create an account and accept the invite.
      **⚠ FAILED — no signup path exists.** Clicking "Sign in to accept" navigates to
      `/sign-in?redirect=/join/<code>` (invite code correctly preserved in redirect parameter).
      The sign-in page has no "Create account" or signup link. A brand-new user with no prior
      Auth account cannot proceed — they have no password. Logged as Issue #4.

**Workaround subtest (manual pre-creation flow — operator creates Auth account first):**

The current design requires the operator to manually create the invited member's Supabase Auth
account before sending the invite link. This is the documented flow for the first admin in
`README_bootstrap_new_club.md`. The same steps apply to member invites.

- [ ] Operator creates a Supabase Auth user for the invited member (Auth dashboard → Users →
      Add user; set a temporary password; enable "Auto Confirm User").
- [ ] Member opens the invite link → signs in with their email and temporary password.
- [ ] **Expected:** After sign-in, redirected back to `/join/<code>` showing "Accept Invitation".
- [ ] Member clicks **Accept Invitation**.
- [ ] **Expected:** Redirected to `/welcome` to enter name.
- [ ] Member enters first and last name → submits.
- [ ] **Expected:** Redirected to `/calendar`. Profile shows correct role (member).
- [ ] Member uses **Forgot password** to set their own password.
- [ ] **Expected:** Password reset succeeds (see Test 2.5 — monitor for otp_expired on first attempt).

> **Decision:** Manual Supabase Auth-user pre-creation is approved only as a temporary QA
> workaround and emergency admin-only/manual-pilot fallback. Before a member-enabled pilot,
> implement an invite-linked account creation flow (Option A — Phase 20D) so a new member can
> open `/join/<code>`, create an account, authenticate/confirm as required, return to the same
> invite, accept it, complete welcome/profile setup, and reach the calendar. Option B
> (Supabase Auth admin email invite / service-role flow) is deferred — adds unnecessary
> email-template, secret-management, and server-side complexity before the pilot.

---

### 2.7 Invite acceptance — revoked invite

**Setup:** Admin revokes an invite from `/admin/members` → copies that invite's link.

- [x] Click the revoked invite link.
- [x] **Expected:** Error message shown ("This invite has been revoked" or similar). Cannot join.

---

### 2.8 Invite acceptance — expired invite

**Setup:** Create a short-lived invite or use an existing expired code from the DB:

```sql
-- Find an expired invite code
select code, expires_at, accepted_at, revoked_at
from club_invites
where expires_at < now()
  and accepted_at is null
  and revoked_at is null
limit 1;
```

- [x] Attempt to use an expired invite link.
- [x] **Expected:** Error message shown ("This invite has expired" or similar). Cannot join.

> Mark N/A if no expired invite is easily available; use 2.6 and 2.7 to cover the invite flows.

---

### 2.9 Welcome / profile completion

**Account:** Any newly invited account

- [x] After accepting an invite, if name is not set, `/welcome` page appears.
- [x] **Expected:** First name and last name fields present.
- [x] Enter first and last name → submit.
- [x] **Expected:** Redirected to `/calendar`. Name appears in `/profile`.

---

### 2.10 Pending invite state

**Setup:** Create a new Supabase Auth user (via Authentication dashboard) without running bootstrap or inviting them. Their `profiles.club_id` will be null.

- [x] Sign in as this new user.
- [x] **Expected:** Redirected to `/pending-invite` page (not to `/calendar`).
- [x] **Expected:** Cannot access `/calendar` or any app route without accepting an invite first.

> Mark N/A if creating a bare Auth user is inconvenient; confirm the route exists by visiting `/pending-invite` while signed in as an already-joined user (should still load, just less meaningful).

---

## 3. Member Booking Flows

**Account:** M1 throughout, unless noted.

### 3.1 Calendar loads correctly

**Navigation:** `/calendar`

- [x] Calendar grid renders with correct courts across the top (Court A, Court B, etc.).
- [x] Time slots visible and scrollable.
- [x] Today's date highlighted or indicated.
- [x] Operating hours are reflected (slots outside hours appear closed/greyed).
- [x] **Check on mobile viewport** (browser dev tools or actual device): layout is usable and courts are scrollable.

---

### 3.2 Book a court — happy path

**Setup:** Find an open slot on Court A, within operating hours, within the booking window.

**3.2a — Base booking with default 60-minute duration:**

- [x] Tap an empty slot on Court A.
- [x] **Expected:** Booking sheet appears with court name, date, time, and duration selector. ✓ Passed.
- [x] Use the default 60-minute duration → tap **Confirm Booking**.
- [x] **Expected:** Sheet closes. Slot on calendar shows as booked.

```sql
-- Confirm reservation created
select id, status, starts_at, ends_at, court_id
from reservations
where owner_user_id = '<M1-user-id>'
  and status = 'confirmed'
order by created_at desc
limit 1;
-- Expected: one row; ends_at - starts_at = 60 minutes
```

- [x] Reservation appears in `/my-schedule`.

**3.2b — Duration selection (30, 60, 90, 120 min):**

- [] **Expected:** Booking sheet offers selectable duration options: 30 min, 60 min, 90 min, 120 min.
  **⚠ FAILED — incomplete duration options.** Current booking sheet shows only **60 min** and
  **90 min** pill buttons. 30-minute and 120-minute options are missing. The duration selector
  is pill-button based (not a free numeric input), which is the correct pattern, but the
  available options are incomplete per the pilot product decision. Logged as Issue #5.
- [ ] **Retest after Phase 20D fix:** Select 30-minute duration → book → confirm reservation
      ends 30 minutes after start.
- [ ] **Retest:** Select 60-minute duration → book → confirm.
- [ ] **Retest:** Select 90-minute duration → book → confirm.
- [ ] **Retest:** Select 120-minute duration → book → confirm (subject to operating hours).
- [ ] **Retest:** Confirm the backend rejects any duration not in {30, 60, 90, 120} if RPC-level
      validation is added.

**Cleanup:** Cancel the 60-minute reservation from 3.2a before continuing.

---

### 3.3 Double-booking prevented

**Setup:** The slot booked in 3.2 is already taken.
**Pass criteria:** The occupied slot cannot be tapped again (UI prevention), or a booking attempt is rejected at the RPC level. There is no alternate booking entry point for members outside `/calendar`.

- [x] Tap the same slot (now occupied) as M1, or log in as M2 and tap the same slot.
- [x] **Expected:** Slot is not tappable OR booking is rejected. Slot remains occupied by original booking.

---

### 3.4 Booking outside operating hours rejected

**Setup:** Identify a time slot outside the club's operating hours (before open or after close).
**Pass criteria:** Slots outside operating hours are greyed/unavailable in the UI and cannot be tapped. UI prevention is the correct expected outcome — members have no alternate booking path outside `/calendar`.

- [x] Slots outside operating hours are not tappable (shown as greyed/closed).
- [x] **Expected:** No reservation created; UI prevents selection of out-of-hours slots.

---

### 3.5 Booking outside booking window rejected

**Setup:** The booking window is N days (recorded in Section 1D). Navigate to a date beyond the window.
**Pass criteria:** The calendar does not allow tapping slots beyond the booking window (UI prevention), or an explicit rejection message is shown. UI prevention is the correct expected outcome.

- [x] Navigate to a date beyond the booking window in the calendar.
- [x] **Expected:** Slots are not tappable beyond the booking window OR booking is explicitly rejected.

---

### 3.6 Date override — closed day blocks booking

**Setup:** Admin creates a date override marking **tomorrow** as closed (`/admin/settings` → Date Overrides → Add override → mark as closed).
**Pass criteria:** All slots on the closed date are blocked/greyed in the UI and cannot be booked.

- [x] As M1, navigate to tomorrow's date in the calendar.
- [x] **Expected:** All slots are greyed/blocked. No slot is tappable. No reservation can be created.

**Cleanup:** Admin removes the date override after testing.

---

### 3.7 Date override — special hours enforced

**Setup:** Admin creates a date override for **tomorrow** with restricted hours (e.g., only 10:00–12:00 open).
**Pass criteria:** Only slots within the override hours are tappable; slots outside are blocked. UI prevention is the correct expected outcome.

- [x] As M1, observe the calendar for tomorrow under special override hours.
- [x] **Expected:** Slots before and after the override window are greyed/blocked.
- [x] Attempt to tap (or book) a slot within the override window (e.g., 11:00).
- [x] **Expected:** Slot is tappable and booking succeeds.

**Cleanup:** Admin removes the date override after testing.

---

### 3.8 Cancellation within window — allowed

**Setup:** Book a court at least (cancellation window + 1 hour) in the future, OR book a court that starts far enough out that cancellation is permitted.

- [x] As M1, navigate to `/my-schedule`.
- [x] Find the reservation from 3.2 (or the one set up for this test).
- [x] **Expected:** **Cancel** button is visible on the reservation row.
- [x] Click **Cancel** → confirm if prompted.
- [x] **Expected:** Reservation disappears from My Schedule. Status in DB = `cancelled`.

```sql
select status, cancelled_at, cancellation_kind
from reservations
where id = '<reservation-id>';
-- Expected: status = 'cancelled', cancellation_kind = 'member'
```

---

### 3.9 Cancellation within cancellation window and past grace — blocked

**Setup:** Book a reservation that **starts within the cancellation window** (e.g., starts in 1 hour, cancellation window is 24 hours). Wait until the grace period has elapsed (5 minutes default), OR set `created_at` to 10 minutes ago in the DB:

```sql
-- Simulate being past the grace period for a reservation
update reservations
set created_at = now() - interval '10 minutes'
where id = '<reservation-id>';
```

- [x] As M1, go to `/my-schedule`.
- [x] **Expected:** **Cancel** button is NOT shown for this reservation (blocked inside window, past grace).
- [x] Alternatively, attempt the cancel server action directly — it should silently reject (no state change).

```sql
select status from reservations where id = '<reservation-id>';
-- Expected: still 'confirmed'
```

---

### 3.10 Cancellation within grace period — allowed

**Setup:** Book a reservation that starts **within the cancellation window** (within next 24 hours). Immediately attempt to cancel (within the 5-minute grace period).

- [x] Book a reservation starting soon (within cancellation window).
- [x] Immediately go to `/my-schedule`.
- [x] **Expected:** **Cancel** button is visible (within grace period).
- [x] Cancel the reservation.
- [x] **Expected:** Reservation cancelled successfully.

---

### 3.11 My Schedule shows upcoming reservations and events

**Account:** M1

- [x] Navigate to `/my-schedule`.
- [x] **Expected:** Page loads with upcoming court reservations and event participations grouped by date.
- [x] **Expected:** Each reservation shows court name, date, time.
- [x] **Expected:** Each event entry shows event title, date, time, and participant status (Confirmed/Waitlisted/Offered).
- [x] **Expected:** Past reservations/events are NOT shown (only upcoming).
- [x] **Expected:** Event-linked reservations do NOT appear as separate reservation rows.

---

### 3.12 My Schedule leave event

**Account:** M1 (confirmed on Event-Open)

- [x] Navigate to `/my-schedule`.
- [x] Find Event-Open in the event list.
- [x] **Expected:** A **Leave** button or similar action is visible on the event row.
- [x] Click **Leave**.
- [x] **Expected:** Event entry disappears from My Schedule (or shows updated status).

```sql
select status from event_participants
where event_id = '<Event-Open-id>' and profile_id = '<M1-user-id>';
-- Expected: status = 'cancelled'
```

**Cleanup:** Re-join M1 to Event-Open (admin adds via `/admin/events` roster).

---

## 4. Member Event and Waitlist Flows

**Navigation:** `/events` and calendar EventDetailSheet.

### 4.1 Member joins event with open capacity

**Account:** M3 (not yet joined Event-Open)  
**Navigation:** `/events`

- [x] Find Event-Open. Button shows **Join Event** (not Join Waitlist).
- [x] Click **Join Event**.
- [x] **Expected:** Page reloads. Event card shows **Joined** badge. Participant count increases by 1.

```sql
select status from event_participants
where event_id = '<Event-Open-id>' and profile_id = '<M3-user-id>';
-- Expected: status = 'confirmed'
```

---

### 4.2 Waitlist state is correctly established from setup

**Account:** M2, then M3  
**Setup:** Event-Full has capacity 1 with M1 confirmed. M2 and M3 were added to the waitlist
during Section 1C setup. This test verifies that state before the remaining Section 4 tests
depend on it.

```sql
-- Verify M1 is confirmed and M2/M3 are waitlisted in correct FIFO order
select profile_id, status, created_at
from event_participants
where event_id = '<Event-Full-id>'
  and status in ('confirmed', 'waitlisted')
order by status desc, created_at asc;
-- Expected: M1 = 'confirmed'; M2 = 'waitlisted' (earlier created_at = #1); M3 = 'waitlisted' (#2)
```

- [x] As M2, navigate to `/events` → Event-Full.
- [x] **Expected:** Event card shows **Waitlisted** badge with position **#1**.
- [x] As M3, navigate to `/events` → Event-Full.
- [x] **Expected:** Event card shows **Waitlisted** badge with position **#2**.
- [x] As any non-joined member, navigate to `/events` → Event-Full.
- [x] **Expected:** Button shows **Join Waitlist** (event is at capacity).

---

### 4.3 Confirmed member leaves — oldest waitlisted member receives offer

**Account:** M1 leaves Event-Full. M2 is #1 on waitlist; M3 is #2.

- [x] As M1, navigate to `/events` → Event-Full → **Leave Event**.
- [x] **Expected:** M1's card changes to show Join button.

```sql
-- Confirm M2 is now offered and M3 remains waitlisted
select profile_id, status, offer_expires_at
from event_participants
where event_id = '<Event-Full-id>'
  and status in ('offered', 'waitlisted', 'confirmed')
order by status, created_at;
-- Expected: M2 = 'offered' with offer_expires_at in the future; M3 = 'waitlisted'
```

```sql
-- Confirm M2 received a waitlist_offer notification
select kind, body from notifications
where user_id = '<M2-user-id>' and kind = 'waitlist_offer'
order by created_at desc limit 1;
-- Expected: 1 row with body mentioning event title and deadline
```

**Cleanup:** This test ends with M2 = 'offered', M3 = 'waitlisted' — use directly for 4.4 and 4.5.

---

### 4.4 Offered member accepts — becomes confirmed

**Account:** M2 (status = 'offered' from 4.3)  
**Navigation:** `/events` or calendar → Event-Full

**On `/events` page:**

- [x] Event-Full card shows **Spot offered** badge (amber).
- [x] "Accept by [time]" deadline visible.
- [x] **Accept** and **Pass** links visible.
- [x] Click **Accept**.
- [x] **Expected:** Page reloads. Event card shows **Joined** badge.

**OR on Calendar → EventDetailSheet:**

- [x] Open EventDetailSheet for Event-Full.
- [x] **Expected:** Amber "Spot offered" banner with deadline.
- [x] Two buttons: **Pass** and **Accept Spot**.
- [x] Click **Accept Spot**.
- [x] **Expected:** Sheet closes; event updates.

```sql
select status, offer_expires_at from event_participants
where event_id = '<Event-Full-id>' and profile_id = '<M2-user-id>';
-- Expected: status = 'confirmed', offer_expires_at = null
```

```sql
select kind from notifications
where user_id = '<M2-user-id>' and kind = 'waitlist_promoted'
order by created_at desc limit 1;
-- Expected: 'waitlist_promoted' notification present
```

**Cleanup:** After 4.4 passes, Event-Full has M2 confirmed and M3 still waitlisted.
To set up 4.5, admin removes M2 from the roster and re-adds M1 as confirmed so that
M1 confirmed, M2 waitlisted #1, M3 waitlisted #2 is restored.

---

### 4.5 Offered member passes — next waitlisted member receives offer

**Setup:** From 4.4 cleanup: Event-Full is reset to M1 confirmed, M2 waitlisted #1, M3 waitlisted #2.
This test drives the full sequence: M1 leaves → M2 offered → M2 passes → M3 offered.

- [x] As M1, navigate to `/events` → Event-Full → **Leave Event**.
- [x] **Expected:** M1's card shows Join button.

```sql
-- Confirm M2 is now offered, M3 still waitlisted
select profile_id, status from event_participants
where event_id = '<Event-Full-id>'
  and status in ('offered', 'waitlisted')
order by status, created_at;
-- Expected: M2 = 'offered'; M3 = 'waitlisted'
```

- [x] As M2, navigate to `/events` → Event-Full → click **Pass**.
- [x] **Expected:** M2's card shows Join button (no longer offered).

```sql
-- Confirm M2 cancelled, M3 now offered
select profile_id, status from event_participants
where event_id = '<Event-Full-id>' and status != 'cancelled'
order by status, created_at;
-- Expected: M3 = 'offered' (queue advanced after M2 passed)
```

---

### 4.6 Expired offer state displays correctly

**Setup:** After 4.5, M3 has status = 'offered'. Use M3 for this test (or whichever member
currently has an offered row — check with the query below before setting the expiry).

```sql
-- Find which member currently has an offered row
select profile_id, status, offer_expires_at
from event_participants
where event_id = '<Event-Full-id>' and status = 'offered';
-- Use the profile_id returned here as <OFFERED-MEMBER-id> in the steps below
```

Expire that member's offer:

```sql
update event_participants
set offer_expires_at = now() - interval '1 minute'
where event_id = '<Event-Full-id>'
  and status = 'offered';
```

**Account:** The member whose offer was just expired (M3 if coming from 4.5)

**On `/events`:**

- [x] Event-Full card shows **Offer expired** badge (grey/muted, not amber).
- [x] **Rejoin** link visible instead of Accept/Pass.

**On Calendar → EventDetailSheet:**

- [x] Amber banner replaced with "This offer has expired" message.
- [x] **Accept Spot / Pass** buttons NOT shown.
- [x] **Rejoin Waitlist** or **Rejoin Event** button shown.
- [x] Click **Rejoin** → M2 placed on waitlist or confirmed (depending on capacity).

---

### 4.7 Offered spots count against capacity

**Setup:** Event-Full has capacity = 1. One member has status = 'offered' (M2 or M3 from
earlier tests — use whichever is currently offered). An offered row reserves the single
available participant slot; no other member can claim it as a confirmed spot.

```sql
-- Confirm exactly one offered row exists and no confirmed participant rows remain
select profile_id, status from event_participants
where event_id = '<Event-Full-id>'
  and status in ('confirmed', 'offered')
  and role = 'participant';
-- Expected: 1 row with status = 'offered'
```

- [x] As any non-joined member (e.g., M1 if removed, or a fresh account), navigate to `/events` → Event-Full.
- [x] **Expected:** Capacity shows `1 of 1` (the offered member's slot counts as filled).
- [x] Button shows **Join Waitlist** (not Join Event) — event is at capacity with the offered slot reserved.
- [x] Click **Join Waitlist** → member placed on waitlist (not confirmed).

```sql
-- Confirm newly joined member is waitlisted
select profile_id, status from event_participants
where event_id = '<Event-Full-id>'
  and profile_id = '<newly-joined-member-id>';
-- Expected: status = 'waitlisted'
```

---

### 4.8 Guests count against capacity

**Setup:** Event-Roster: capacity = 4. M1 confirmed (1 slot used). Admin adds 3 guests.

- [x] Admin adds 3 guests via `/admin/events` roster (Guest 1, Guest 2, Guest 3).
- [x] As M2 (not yet joined), navigate to `/events` → Event-Roster.
- [x] **Expected:** Capacity shows `4 of 4` (1 member + 3 guests = full).
- x] Button shows **Join Waitlist**.

---

### 4.9 Member leaves waitlist correctly

**Account:** M3 (waitlisted on Event-Full from 4.7 or reset)  
**Navigation:** `/events`

- [x] Find Event-Full. Button shows **Leave Waitlist**.
- [x] Click **Leave Waitlist**.
- [x] **Expected:** M3 no longer shown as waitlisted. Button returns to **Join Waitlist**.

```sql
select status from event_participants
where event_id = '<Event-Full-id>' and profile_id = '<M3-user-id>'
order by updated_at desc limit 1;
-- Expected: status = 'cancelled'
```

---

## 5. Notification Flows

> **Note:** In-app notifications are pilot-critical. SMS is optional. If Twilio is not configured,
> mark SMS tests N/A and confirm in-app notifications work correctly.

### 5.1 Booking confirmation notification

**Account:** M1  
**Setup:** Create a new court reservation.

- [x] After booking, navigate to any page with the notification bell.
- [x] **Expected:** Bell shows unread count ≥ 1 (orange dot or number badge).
- [x] Click bell → notification sheet opens.
- [x] **Expected:** "Reservation confirmed" (or similar) notification visible at top.

```sql
select kind, body from notifications
where user_id = '<M1-user-id>' and kind = 'reservation_confirmed'
order by created_at desc limit 1;
-- Expected: 1 row
```

---

### 5.2 Booking cancellation notification

**Account:** M1  
**Setup:** Cancel a reservation (as done in 3.8).

- [x] After cancellation, check notification bell.
- [x] **Expected:** New notification for "Reservation cancelled by member" (or similar).

---

### 5.3 Event join notification

**Account:** M1 (joining Event-Open)

- [x] Join Event-Open as M1.
- [x] **Expected:** `event_joined` notification appears in bell.

```sql
select kind, body from notifications
where user_id = '<M1-user-id>' and kind = 'event_joined'
order by created_at desc limit 1;
-- Expected: 1 row mentioning the event title
```

---

### 5.4 Waitlist offer notification

**Setup:** From test 4.3 — M2 received a `waitlist_offer` notification when M1 left Event-Full.

- [x] Log in as M2 → check notification bell.
- [x] **Expected:** Notification with kind `waitlist_offer` visible, mentioning event name and deadline.

---

### 5.5 Waitlist accepted / promoted notification

**Setup:** From test 4.4 — M2 accepted an offer.

- [x] Check M2's notification bell.
- [x] **Expected:** `waitlist_promoted` notification present ("You've accepted and are confirmed for…").

---

### 5.6 Event cancellation notification

**Setup:** Admin cancels Event-Open (or a test event with M1 confirmed).

- [x] Admin cancels the event.
- [x] Admin received an `event_cancelled` notification. ✓ (Admin notification confirmed.)
- [ ] **Expected:** All confirmed, offered, and waitlisted members receive `event_cancelled`.
      **⚠ FAILED — under investigation.** Impacted members did not receive `event_cancelled`
      notifications. `event_cancelled` is a mandatory notification kind (always delivered,
      not gated by user preferences). Logged as Issue #7. Pending SQL verification of
      participant roster and notification rows before confirming.

```sql
-- Step 1: Confirm which profiles were confirmed/offered/waitlisted on the cancelled event
select ep.profile_id, ep.status
from event_participants ep
where ep.event_id = '<cancelled-event-id>'
  and ep.status in ('confirmed', 'waitlisted', 'offered', 'cancelled')
order by ep.status, ep.created_at;
-- Note: after cancellation, all rows should be status='cancelled';
-- cross-reference created_at to identify who was active at time of cancellation.

-- Step 2: Check whether event_cancelled notifications exist for each expected recipient
select user_id, kind, body, created_at
from notifications
where kind = 'event_cancelled'
  and created_at > now() - interval '24 hours'
order by created_at desc;
-- Expected: one row per affected member (confirmed, offered, waitlisted at time of cancel).
-- If Admin received one but other members did not, the cancel_event RPC recipient filter
-- may be excluding non-confirmed statuses incorrectly.
```

**Cleanup:** Create a replacement event if Event-Open was cancelled.

---

### 5.7 Announcement notification

**Account:** Admin sends; M1 receives.

- [x] Admin → `/admin/settings` → Announcements section → enter title and body → click **Send**.
- [x] **Expected:** Success message shown in settings.
- [x] As M1, check notification bell.
- [x] **Expected:** `announcement` notification present with the title and body Admin sent.

```sql
select kind, body from notifications
where kind = 'announcement'
order by created_at desc limit 1;
-- Expected: 1 row matching the message sent
```

---

### 5.8 Notification bell unread count updates in real time

**Account:** M1 logged in; leave the page open.

- [x] In a separate browser window or incognito tab, log in as Admin.
- [x] Admin sends an announcement (as in 5.7).
- [x] Switch back to M1's browser tab **without refreshing**.
- [x] **Expected:** The notification bell count increments within a few seconds (Supabase Realtime).

> **Pilot blocker if:** the count only updates after a manual page refresh. This means
> the `notifications` table is not in the `supabase_realtime` publication.
> Fix: `ALTER PUBLICATION supabase_realtime ADD TABLE notifications;`

---

### 5.9 Mark notification as read

**Account:** M1

- [x] Click the notification bell → notification sheet opens.
- [x] **Expected:** Unread notifications are visually distinct (bold, dot, or highlighted).
- [x] Click one notification to mark it as read (or click "Mark all as read" if the UI has that).
- [x] **Expected:** That notification's unread indicator disappears.
- [x] Close and reopen the sheet.
- [x] **Expected:** The notification remains marked as read.

```sql
select is_read from notifications
where user_id = '<M1-user-id>'
order by created_at desc limit 1;
-- Expected: is_read = true for the notification just marked
```

---

### 5.10 Notification preference — suppress configurable kind

**Account:** M1  
**Navigation:** `/profile/notifications`

- [x] Toggle off **Reservation confirmed** preference.
- [x] Book a new court reservation as M1.
- [x] **Expected:** No `reservation_confirmed` notification appears in the bell (suppressed by preference).

```sql
select count(*) from notifications
where user_id = '<M1-user-id>'
  and kind = 'reservation_confirmed'
  and created_at > now() - interval '2 minutes';
-- Expected: 0 rows (notification was suppressed)
```

- [x] Re-enable **Reservation confirmed** preference.
- [x] Book another reservation.
- [x] **Expected:** `reservation_confirmed` notification appears (preference back on).

---

### 5.11 Always-delivered notifications still arrive with preferences off

**Account:** M1  
**Setup:** Turn off all configurable notification preferences in `/profile/notifications`.

- [x] Admin cancels an event M1 is confirmed in.
- [x] **Expected:** M1 still receives an `event_cancelled` notification (mandatory kind — always delivered).

```sql
select kind, body from notifications
where user_id = '<M1-user-id>' and kind = 'event_cancelled'
order by created_at desc limit 1;
-- Expected: 1 row (delivered regardless of user preferences)
```

- [x] Re-enable all preferences for M1 after this test.

---

### 5.12 SMS test (if Twilio is configured)

**Account:** Admin  
**Navigation:** `/admin/settings` → SMS section

**- N/A — Twilio is not configured; in-app notifications are the pilot-critical channel.**

- [ ] If the SMS section shows **"SMS configured"**: proceed.
  - Admin enters a phone number opted into SMS → clicks **Send test**.
  - **Expected:** Success message in UI. SMS received on target phone.
- [ ] If the SMS section shows **"SMS not configured"**: mark this test **N/A**.
  - Confirm in-app notifications (5.1–5.11) all pass — that is the pilot-critical channel.

---

## 6. Admin Setup and Configuration Flows

**Account:** Admin throughout.

### 6.1 Admin can access all admin routes

- [x] `/admin/members` — page loads, member list visible.
- [x] `/admin/courts` — page loads, court list visible.
- [x] `/admin/events` — page loads, event list visible.
- [x] `/admin/settings` — page loads, all settings sections visible.
- [x] `/admin/audit-log` — page loads, log entries visible.

---

### 6.2 Club branding — logo upload

**Navigation:** `/admin/settings` → Club Branding

- [x] Click **Upload logo** → choose a JPEG or PNG image (< 2 MB).
- [x] **Expected:** Upload completes; logo preview appears.
- [x] Navigate away and return to `/admin/settings`.
- [x] **Expected:** Logo still shown (persisted).
- [x] Check the logo appears in the app header or wherever it is displayed club-wide.

---

### 6.3 Club branding — theme selection

**Navigation:** `/admin/settings` → Club Branding

- [x] Select a different theme (e.g., **Forest Green** if currently on Classic Gray).
- [x] **Expected:** Theme color changes immediately or after save.
- [x] Navigate to `/calendar`.
- [x] **Expected:** Calendar reflects the new theme colors.
- [x] Switch back to the original theme.

---

### 6.4 Booking rules save and persist

**Navigation:** `/admin/settings` → Booking Rules

- [x] Change **Booking window (days)** to a different value (e.g., 10).
- [x] Click **Save**.
- [x] **Expected:** Success message shown.
- [x] Reload the page.
- [x] **Expected:** Booking window shows the new value (10).
- [x] Restore to the original value → Save.

- [x] Test invalid values (e.g., 0 or 400 for booking window).
- [x] **Expected:** Validation error shown; value not saved.

---

### 6.5 Operating hours save and affect calendar

**Navigation:** `/admin/settings` → Operating Hours

- [x] Change tomorrow's closing time to 1 hour earlier (e.g., 18:00 → 17:00).
- [x] Click **Save** (or the per-row save if the editor works that way).
- [x] **Expected:** Success confirmation.
- [x] Navigate to `/calendar` → go to tomorrow's date.
- [x] **Expected:** Slots after 17:00 appear closed/unavailable.
- [x] Attempt to book a slot at 17:30.
- [x] **Expected:** Booking rejected.
- [x] Restore original closing time.

---

### 6.6 Date override — add, verify, delete

**Navigation:** `/admin/settings` → Date Overrides

- [x] Click **Add override** → choose a future date → mark as **Closed** → Save.
- [x] **Expected:** Override appears in the list with date and "Closed" label.
- [x] Navigate to `/calendar` → go to that date.
- [x] **Expected:** All slots appear blocked/closed.
- [x] Return to Date Overrides → delete the override.
- [x] **Expected:** Override removed from list; calendar returns to normal hours for that date.

---

### 6.7 Announcement send

**Navigation:** `/admin/settings` → Announcements  
_(Already tested in 5.7 — mark as pass if 5.7 passed.)_

- [x] Send an announcement with a title and body.
- [x] **Expected:** All active club members receive an `announcement` notification in their bell.

---

### 6.8 Court rename

**Navigation:** `/admin/courts`

- [x] Click edit (pencil icon) on Court A → change the name → save.
- [x] **Expected:** New name appears in the courts list and on the calendar.
- [x] Rename back to the original.

---

### 6.9 Court reorder

**Navigation:** `/admin/courts`

- [x] Drag Court A below Court B (or use the reorder controls).
- [x] **Expected:** Order updates; calendar column order reflects the new order.
- [x] Restore original order.

---

### 6.10 Court deactivate

**Navigation:** `/admin/courts`

- [x] Toggle Court B to **inactive**.
- [x] **Expected:** Court B disappears from the calendar grid.
- [x] **Expected:** Existing reservations on Court B remain in the DB (not deleted).
- [x] Re-activate Court B.
- [x] **Expected:** Court B reappears in the calendar.

---

### 6.11 Member invite creation

**Navigation:** `/admin/members`

- [x] Click **Invite** → choose role **member** → optionally enter an email restriction.
- [x] **Expected:** Invite link generated and shown (or copyable).
- [x] Verify the invite link uses the **actual production domain** and opens the invitation route successfully:
  - Link begins with your production URL (e.g., `https://your-production-domain/join/`).
  - Opening the link loads the `/join/[code]` page with "Accept invitation" content.
  - Do not assume a specific token length or format — verify the link works end-to-end.

---

### 6.12 Member role change

**Navigation:** `/admin/members`

- [x] Find M1 in the member list.
- [x] Change M1's role from **member** to **pro**.
- [x] **Expected:** Role badge updates in the list.
- [x] Sign in as M1 → confirm `/admin/events` is now accessible.
- [x] Confirm `/admin/members` is NOT accessible (redirects to `/calendar`).
- [x] Admin changes M1's role back to **member**.

---

### 6.13 Member status change

**Navigation:** `/admin/members`

- [x] Change M1's status to **inactive** or **suspended**.
- [x] **Expected:** Status badge updates. ✓ Passed.
- [x] Attempt to sign in as M1.
      **Note:** Deactivated member can still sign in to the app (Supabase Auth does not block
      login based on profile status). Authentication remains allowed.
- [x] Attempt a court booking as M1 (deactivated).
- [x] **Expected:** Booking attempt returns an error and no reservation is created. ✓ Passed —
      booking is blocked at the RPC level for inactive/suspended members.
- [x] **Follow-up verified:** Attempted to join an event and waitlist as M1 (deactivated).
  - Event join: **blocked** at the RPC level. ✓
  - Waitlist join: **blocked** at the RPC level. ✓
  - **Pass with note:** Authentication (sign-in) remains permitted for deactivated members, but
    all member actions (court booking, event join, waitlist join) are correctly blocked at the
    RPC level. No status-enforcement issue to log.
- [x] Admin restores M1 to **active** status immediately after all deactivated-member tests.

---

## 7. Admin Event and Participant Management Flows

**Account:** Admin throughout.  
**Navigation:** `/admin/events`

### 7.1 Events page loads with correct content

- [x] Page loads with "All Events" heading.
- [x] Events listed newest-first (check `starts_at` ordering).
- [x] Each card shows: event type pill, status badge (Scheduled/Cancelled), title, date/time, capacity/occupancy, roster button.
- [x] Cancelled events show "Cancelled" badge and are visually muted; no Roster button.

---

### 7.2 Open roster and view participants

- [x] Click **Roster** on Event-Roster.
- [x] **Expected:** EventRosterSheet opens showing M1 in Confirmed section.
- [x] **Expected:** Capacity line shows correct numbers (participants + guests).

---

### 7.3 Add member — open slot → confirmed

**Setup:** Event-Roster has open capacity. M2 not yet joined.

- [x] Click **+ Add Member** → select M2 from dropdown.
- [x] **Expected:** M2 appears in Confirmed section.

```sql
select status from event_participants
where event_id = '<Event-Roster-id>' and profile_id = '<M2-user-id>';
-- Expected: 'confirmed'
```

---

### 7.4 Add member — full event → waitlisted

**Setup:** Fill Event-Roster to capacity first (add guests or members to fill slots).

- [x] Click **+ Add Member** → select M3.
- [x] **Expected:** M3 appears in Waitlisted section (not Confirmed).

```sql
select status from event_participants
where event_id = '<Event-Roster-id>' and profile_id = '<M3-user-id>';
-- Expected: 'waitlisted'
```

---

### 7.5 Add member — reactivate previously cancelled row

**Setup:** M3 was previously in the event and cancelled (or manually cancel M3's row):

```sql
update event_participants
set status = 'cancelled', updated_at = now()
where event_id = '<Event-Roster-id>' and profile_id = '<M3-user-id>';
```

- [x] **+ Add Member** dropdown shows M3 (cancelled rows are eligible to rejoin).
- [x] Select M3 → Add.
- [x] **Expected:** M3 appears (confirmed or waitlisted). No duplicate row.

```sql
select count(*), status from event_participants
where event_id = '<Event-Roster-id>' and profile_id = '<M3-user-id>'
group by status;
-- Expected: exactly 1 row (reactivated, not duplicated)
```

---

### 7.6 Add member — already active member not in dropdown

- [x] Open **+ Add Member**.
- [x] **Expected:** M1 (already confirmed) does NOT appear in the dropdown.

---

### 7.7 Add guest — basic flow

**Setup:** Event-Roster with open capacity.

- [x] Click **+ Add Guest**.
- [x] **Expected:** Inline input field appears.
- [x] Type "Alex Smith" → click **Add** (or press Enter).
- [x] **Expected:** Guests section appears at the bottom of the roster with "Alex Smith".

```sql
select display_name, added_by from event_guests
where event_id = '<Event-Roster-id>'
order by created_at desc limit 1;
-- Expected: display_name = 'Alex Smith'
```

```sql
select action from audit_log
where action = 'admin_add_guest'
order by created_at desc limit 1;
-- Expected: 1 row
```

---

### 7.8 Add guest — blank name rejected

- [x] Open **+ Add Guest** → leave input empty → click **Add**.
- [x] **Expected:** Error "Enter a guest name." shown. No guest created.
- [x] Type only spaces → click **Add**.
- [x] **Expected:** Same error (backend check constraint rejects empty/whitespace-only names).

---

### 7.9 Remove guest — capacity freed, waitlist advances if applicable

**Setup:** Event-Roster at capacity (M1 confirmed, guests fill remaining slots). M2 on waitlist.

- [x] Click **Remove** on one of the guests.
- [x] **Expected:** Guest disappears from Guests section.

```sql
select profile_id, status from event_participants
where event_id = '<Event-Roster-id>' and profile_id = '<M2-user-id>';
-- Expected: status = 'offered' (waitlist advanced after guest slot freed)
```

---

### 7.10 Remove confirmed participant — slot freed, waitlist advances

**Setup:** M2 confirmed on Event-Roster. M3 waitlisted.

- [x] Click **Remove** on M2's row in Confirmed section.
- [x] **Expected:** M2 removed. M3 moves to Offered state.

```sql
select profile_id, status from event_participants
where event_id = '<Event-Roster-id>'
  and profile_id in ('<M2-user-id>', '<M3-user-id>');
-- Expected: M2 = 'cancelled', M3 = 'offered'
```

```sql
select action from audit_log
where action = 'admin_remove_participant'
order by created_at desc limit 1;
-- Expected: 1 row
```

---

### 7.11 Host row has no Remove button

- [x] In Confirmed section, find the Admin (host) row.
- [x] **Expected:** No **Remove** button on the host row. A "Host" label is shown instead.

---

### 7.12 Force confirm — waitlisted member

**Setup:** Event at capacity. M2 on waitlist.

- [x] Click **Force Confirm** on M2 in the Waitlisted section.
- [x] **Expected:** M2 moves to Confirmed section. Event is now over capacity.

```sql
select status from event_participants
where event_id = '<Event-Roster-id>' and profile_id = '<M2-user-id>';
-- Expected: 'confirmed'
```

```sql
select action, metadata from audit_log
where action = 'admin_force_confirm'
order by created_at desc limit 1;
-- Expected: 1 row; metadata may include was_over_capacity flag
```

> **Expected over-capacity behavior:** Admin Force Confirm intentionally places the event over
> capacity. This is expected administrative override behavior, not a defect. The audit log
> retains evidence of the over-capacity action. A future UX enhancement may add an optional
> confirmation dialog warning the admin; this is not pilot-blocking.

---

### 7.13 Force confirm — offered member

**Setup:** M3 has status = 'offered'.

- [x] Click **Force Confirm** on M3 in the Offered section.
- [x] **Expected:** M3 moves to Confirmed. `offer_expires_at` cleared.

```sql
select status, offer_expires_at from event_participants
where event_id = '<Event-Roster-id>' and profile_id = '<M3-user-id>';
-- Expected: status = 'confirmed', offer_expires_at = null
```

---

### 7.14 Offer spot — manual FIFO bypass

**Setup:** M2 (#1 on waitlist) and M3 (#2 on waitlist). No active offer exists.

- [x] Click **Offer Spot** on M3 (who is #2, bypassing M2).
- [x] **Expected:** M3 moves to Offered section. M2 remains waitlisted.

```sql
select action, metadata from audit_log
where action = 'admin_offer_spot'
order by created_at desc limit 1;
-- Expected: metadata contains skipped_profile_ids with M2's ID
```

---

### 7.15 Offer spot — blocked when active offer already exists

**Setup:** One member already has status = 'offered' (from 7.14).

- [x] Click **Offer Spot** on M2 (the other waitlisted member).
- [x] **Expected:** Error shown ("Another member already has an active offer. Expire that offer first.").
- [x] No second offered row created.

---

### 7.16 Expire offer — no auto-advance

**Setup:** M3 has status = 'offered'. M2 is still waitlisted.

- [x] Click **Expire** on M3 in the Offered section.
- [x] **Expected:** M3's row disappears from Offered section (status → cancelled).
- [x] **Expected:** M2 is NOT automatically offered (no auto-advance on admin expire).

```sql
select profile_id, status from event_participants
where event_id = '<Event-Roster-id>'
  and profile_id in ('<M2-user-id>', '<M3-user-id>');
-- Expected: M2 = 'waitlisted', M3 = 'cancelled'
```

```sql
select action from audit_log
where action = 'admin_expire_offer'
order by created_at desc limit 1;
-- Expected: 1 row
```

---

### 7.17 Capacity display — guests included everywhere

**Setup:** Event-Roster: capacity 4. M1 confirmed (1). Two guests added (2). Total occupied = 3.

- [x] **`/admin/events` card:** shows `3 / 4` (or `3 of 4 filled`).
- [x] **`/events` page card (as M1):** shows `3 / 4 joined`.
- [x] **Calendar EventDetailSheet:** capacity line shows `3 of 4 spots filled`.
- [x] **Roster button label:** includes correct total count.

---

### 7.18 Audit log — all Phase 19 actions labeled correctly

**Navigation:** `/admin/audit-log`

- [x] After performing the tests above, the audit log shows human-readable labels:

| DB action                | Expected UI label              |
| ------------------------ | ------------------------------ |
| admin_add_member         | Added member to event          |
| admin_remove_participant | Removed participant from event |
| admin_force_confirm      | Force confirmed participant    |
| admin_offer_spot         | Manually offered spot          |
| admin_expire_offer       | Expired offer                  |
| admin_add_guest          | Added guest to event           |
| admin_remove_guest       | Removed guest from event       |

> **Product decision — `/admin/events` navigation placement:** The `/admin/events` link in the
> Profile/Admin tools area is intentionally separate from the member-facing `/events` route.
> `/events` is the member event experience; `/admin/events` is the administrative roster-management
> view. A future cosmetic improvement may rename the admin link to "Manage Events" for clarity.
> Not an issue.

> **Deferred enhancement — admin/host as event participant:** In the future, an admin or host
> may need the ability to explicitly join an event as a playing participant. A host should not
> automatically consume a participant spot by organizing the event. Deferred as a post-pilot
> enhancement unless the pilot client specifically requires it.

---

## 8. Pro Role Access and Controls

**Account:** Pro (after role was set in Section 6.12 tests, or use the dedicated Pro account).

### 8.1 Pro can access /admin/events

- [x] Sign in as Pro → navigate to `/admin/events`.
- [x] **Expected:** Page loads with full event list and roster buttons.

---

### 8.2 Pro can perform roster management actions

- [x] Pro opens an event roster → clicks **+ Add Guest** → adds a guest.
- [x] **Expected:** Guest added successfully (same as admin).
- [x] Pro removes a non-host participant.
- [x] **Expected:** Participant removed successfully.

---

### 8.3 Pro cannot access admin-only pages

**⚠ Under investigation — logged as Issue #8.**
Intended: Pro → `/admin/events` only. All other `/admin/*` routes should redirect to `/calendar`.

| Route              | Intended                | Observed             | Status                                               |
| ------------------ | ----------------------- | -------------------- | ---------------------------------------------------- |
| `/admin/members`   | Redirect to `/calendar` | Error (not redirect) | Access blocked; UX inconsistent                      |
| `/admin/courts`    | Redirect to `/calendar` | Page appears to load | **Investigate — Pilot Blocker if Pro can view/edit** |
| `/admin/settings`  | Redirect to `/calendar` | Page appears to load | **Investigate — Pilot Blocker if Pro can view/edit** |
| `/admin/audit-log` | Redirect to `/calendar` | Error (not redirect) | Access blocked; UX inconsistent                      |

- [ ] Verify: as Pro, can court names/settings be read from `/admin/courts` and `/admin/settings`?
- [ ] Verify: can Pro submit any change on those pages (rename court, save booking rules, etc.)?
- [ ] If Pro can view or modify admin-only data: classify as Pilot Blocker; fix route role guard in Phase 20D.
- [ ] If Pro sees pages but write actions are server-rejected: classify as Important, can defer redirect fix.

---

### 8.4 Pro has normal member booking access

- [x] Pro navigates to `/calendar` → books a court.
- [x] **Expected:** Booking succeeds.
- [x] Pro navigates to `/events` → joins an event with capacity.
- [x] **Expected:** Joins as confirmed.

---

## 9. Permission and Security Spot Checks

### 9.1 Regular member cannot access any /admin route

**Account:** M1

- [x] Navigate to `/admin/members`.
- [x] **Expected:** Redirected to `/calendar`.
- [x] Navigate to `/admin/events`.
- [x] **Expected:** Redirected to `/calendar`.
- [x] Navigate to `/admin/settings`.
- [x] **Expected:** Redirected to `/calendar`.

---

### 9.2 Member sees no roster management controls

**Account:** M1  
**Navigation:** `/events` → open any event roster (if roster button is available to members)

- [x] Open an event roster or EventDetailSheet.
- [x] **Expected:** No **+ Add Member**, **+ Add Guest**, **Remove**, **Force Confirm**, **Offer Spot**, or **Expire** buttons visible.
- [x] **Expected:** Roster shows participant names only (read-only view).

> **Pass — stricter than expected:** Members cannot access the admin roster at all in the current
> UI. No roster-management controls are exposed to members. This is more restrictive than read-only
> roster visibility and is acceptable for the pilot.

---

### 9.3 RLS — member cannot read audit_log directly

Replace `<M1-user-id>` with M1's actual UUID before running.

```sql
set role authenticated;

select set_config('request.jwt.claim.sub', '<M1-user-id>', false);

select set_config(
  'request.jwt.claims',
  '{"sub":"<M1-user-id>","role":"authenticated"}',
  false
);

select auth.uid();
-- Expected: <M1-user-id> (confirms auth context is active)

select count(*) from audit_log;
-- Expected: 0 rows (RLS blocks members from reading audit_log)

reset role;
```

---

### 9.4 RLS — member cannot read notification_deliveries directly

Replace `<M1-user-id>` with M1's actual UUID before running.

```sql
set role authenticated;

select set_config('request.jwt.claim.sub', '<M1-user-id>', false);

select set_config(
  'request.jwt.claims',
  '{"sub":"<M1-user-id>","role":"authenticated"}',
  false
);

select auth.uid();
-- Expected: <M1-user-id>

select count(*) from notification_deliveries;
-- Expected: 0 rows (RLS blocks members from reading notification_deliveries)

reset role;
```

---

### 9.5 Cross-club data isolation (if second club is available)

**Setup:** A member of Club B (separate club, separate `club_id`).
Replace `<Club-B-member-id>` with that member's actual UUID before running.

```sql
set role authenticated;

select set_config('request.jwt.claim.sub', '<Club-B-member-id>', false);

select set_config(
  'request.jwt.claims',
  '{"sub":"<Club-B-member-id>","role":"authenticated"}',
  false
);

select auth.uid();
-- Expected: <Club-B-member-id>

select count(*) from reservations;
-- Expected: 0 rows (Club A reservations are invisible to Club B member)

select count(*) from events;
-- Expected: 0 rows (Club A events are invisible to Club B member)

reset role;
```

> **N/A for current single-club QA run.** Repeat during bootstrap validation if a temporary
> second club is created. Require before any multi-club rollout.

---

### 9.6 No service role key in client environment

- [x] Sign in to the deployed app in a browser.
- [x] Open DevTools → **Network** tab → filter for `supabase.co`.
- [x] Refresh the page or navigate to `/calendar` to trigger Supabase requests.
- [x] Click any Supabase request → **Headers** → find the `apikey` header.
- [x] Privately compare the `apikey` value against your Supabase Project Settings → API Keys → **anon/public** key.
- [x] **Expected:** The `apikey` value matches the anon/public key exactly. It should NOT match the service-role key.
- [x] In Vercel Environment Variables, confirm there is no `NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY` or `NEXT_PUBLIC_SERVICE_ROLE_KEY` variable (any secret in a `NEXT_PUBLIC_` prefix is exposed to the client bundle).
- [x] **Do not record or paste key values into this QA file.**

---

### 9.7 Twilio secrets remain server-side only

- [x] In the deployed app, open browser DevTools → Sources or Application → look for any env variable exposure.
- [x] **Expected:** `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` are NOT visible in any JavaScript bundle or network response.
- [x] The settings page shows only a boolean "configured / not configured" status — not the actual credentials.

---

## 10. Deployment and Environment Checks

### 10.1 Vercel deployment is live

- [x] Open the Vercel dashboard for this project.
- [x] **Expected:** Latest deployment shows **Ready** (green).
- [x] No build errors in the deployment log.

---

### 10.2 Production site loads over HTTPS

- [x] Visit the production URL in a browser.
- [x] **Expected:** HTTPS padlock shown. No mixed-content warnings.
- [x] `/calendar` loads correctly and is usable on the HTTPS production domain.

---

### 10.3 Required environment variables set in Vercel

- [x] Vercel dashboard → Settings → Environment Variables.
- [x] **Expected:** The following are present (values can be masked):
  - `NEXT_PUBLIC_SUPABASE_URL`
  - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  - `NEXT_PUBLIC_APP_URL`
    Passed after configuration correction — NEXT_PUBLIC_APP_URL was initially missing from Vercel Production/Preview environment variables. Added NEXT_PUBLIC_APP_URL=https://court-time.vercel.app and redeployed successfully. Required environment variable names are now present. Twilio variables are N/A because SMS is not enabled for the pilot.
- [ ] If SMS is enabled, also present:
  - `TWILIO_ACCOUNT_SID`
  - `TWILIO_AUTH_TOKEN`
  - `TWILIO_FROM_NUMBER`
    N/A as Twilio isn't configured yet

---

### 10.4 Auth redirect URLs support production flows

- [x] Password reset email (tested in 2.5) redirected to the production URL, not localhost.
- [x] Invite links use the production URL (tested in 2.6).
- [x] Verify in Supabase dashboard → Authentication → URL Configuration:
  - **Site URL** is the production URL.
  - **Redirect URLs** include `https://your-app.vercel.app/**`.

---

### 10.5 Notifications realtime works in deployed app

_(Already tested in 5.8 — mark as pass if 5.8 passed.)_

- [x] Notification bell count updates in the deployed app without a page refresh when a new notification is delivered.

---

### 10.6 Club logo upload works in deployed app

_(Already tested in 6.2 — mark as pass if 6.2 passed.)_

- [x] Logo upload succeeds in the production environment (confirms the `club-logos` bucket is configured correctly).

---

### 10.7 Bootstrap README reflects current operator workflow

- [x] Review `supabase/scripts/README_bootstrap_new_club.md`.
- [x] **Expected:** The production environment checklist section accurately describes the setup required before bootstrapping a club.
- [x] **Expected:** Step-by-step instructions are still accurate for the current codebase.

---

## 11. Build Verification

Run locally before committing:

```bash
pnpm tsc --noEmit
# Expected: zero TypeScript errors (no output)

pnpm build
# Expected: build succeeds
# Expected: /admin/events appears in the route table as a dynamic (ƒ) route
```

- [x] `pnpm tsc --noEmit` — zero errors.
- [x] `pnpm build` — succeeds; `/admin/events` listed as `ƒ (Dynamic)` in route output.

---

## 12. Issues Log

Record any failures or unexpected behavior here. Determine severity before filing a fix.

| #   | Test                                            | Issue description                                                                                                                                                                                                                                                                                                                                         | Severity                                                                                                     | Repro steps                                                                                                                                                                                                  | Proposed fix                                                                                                                                                                                                                                                                                 | Status                                                                      |
| --- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1   | Section 1C / Event-Full setup; roster mutations | Two related stale-state behaviors observed after admin roster mutations (add member, add guest, remove): (1) event occupancy display on the event card did not update until page refresh; (2) the roster contents themselves also remained stale after adding members/guests until page refresh. Underlying data was correct after refresh in both cases. | Important pre-pilot fix recommended; not yet a pilot blocker because persisted data is correct after refresh | Use admin roster controls to add M1, M2, M3, and a guest to an event; observe the event card occupancy count and the open roster sheet before and after a manual page refresh. | After any roster mutation (add/remove/offer/expire), refetch roster data and refresh parent event occupancy/count state without requiring a manual page reload. Add to Phase 20D. | Open |
| 2   | General navigation / sticky header | Next.js logs a console warning during route changes: `Skipping auto-scroll behavior due to position: sticky or position: fixed on element`, referencing the sticky app header. No visible navigation or scroll failure occurred during QA. | Cosmetic / UX polish | Navigate between app pages while DevTools Console is open; observe warning. | Review sticky-header/Next.js scroll behavior during post-pilot UX polish; address before pilot only if visible navigation or scroll failure emerges. | Deferred |
| 3   | Test 2.5 / Forgot password reset | Opening the password reset email link redirected to the production `/sign-in` page with `error_code=otp_expired` and "Email link is invalid or has expired," instead of reaching `/reset-password`. Production domain was used correctly, but the recovery token was rejected. | Not a pilot blocker — not reproducible with a fresh link | Request password reset for M1; open emailed reset link; observe redirect URL and error fragment. | Retest using only a newly generated latest link; verify Supabase Auth Site URL and exact `/reset-password` Redirect URL; if repeatable, inspect reset flow and possible email-link prefetching/security scanning. | Resolved on retest / Monitor during pilot |
| 4   | Test 2.6 / New member invite onboarding | A brand-new invited member can open `/join/<code>` and view the invitation, but clicking "Sign in to accept" requires login credentials for an Auth account that does not yet exist. There is no account-creation path from the invite flow. | Pilot Blocker for member-enabled pilot; workaround available for admin-only/manual pilot | Admin creates a member invite; open the invite link as a new user without an existing Auth account; click "Sign in to accept"; user is taken to login but cannot proceed because no account/password exists. | Option A (Phase 20D): add "Create account" path from `/join/<code>`, preserve invite code through signup and sign-in, return user to accept the invite. Option B (service-role magic-link) deferred. | Open — Phase 20D fix required before member-enabled pilot |
| 5   | Test 3.2 / Mobile booking duration | The member booking sheet shows only 60 min and 90 min duration options. 30-minute and 120-minute durations are missing from the pilot product decision (30/60/90/120 min required). The duration selector correctly uses pill buttons rather than a free text field, but the option set is incomplete. | Pilot Blocker for member-enabled pilot | On mobile or desktop, tap an available court slot as a member; observe the duration options in the booking sheet. | Extend the booking sheet pill buttons from [60, 90] to [30, 60, 90, 120] and update the state type to match. Also replace the free numeric input in the CreateEventSheet (admin/pro event creation) with a select offering the same options. Add RPC-level duration validation if specified. | Open — Phase 20D fix required |
| 6   | Test 3.2 / Calendar reservation management | After a member books a court from the Calendar, tapping their own booked time slot does not provide a way to manage or cancel the reservation. Cancellation is available only through `/my-schedule`. | Important pre-pilot usability fix; not a pilot blocker because a working workaround exists | As a member, book an available court slot from `/calendar`; tap/click the booked reservation block; observe that no reservation-details/cancel action is available; navigate to `/my-schedule` to confirm cancellation is available there. | Add an own-reservation detail/manage sheet from the Calendar with a Cancel Reservation action that reuses the existing cancellation action and eligibility rules from `/my-schedule`. Do not show cancellation controls for another user's reservation. | Open — Phase 20D fix recommended |
| 7   | Test 5.6 / Event cancellation notifications | Initial observation: Admin received `event_cancelled` notification but impacted members did not. Controlled retest: fresh event cancelled with M1 confirmed, M2 waitlisted, and M2 in offered state. All three received `event_cancelled` notifications. First test likely had no active confirmed/waitlisted/offered participants at time of cancel, or stale notification state was observed. | Not a pilot blocker — passed on controlled retest | Create an event with M1 confirmed, M2 waitlisted, and an offered participant; cancel as Admin; verify all three receive event_cancelled notifications in their bells and in the notifications table. | No fix required — cancel_event RPC correctly delivers event_cancelled to all active participants. | Resolved on retest / Monitor during pilot |
| 8   | Test 8.3 / Pro admin-route permissions | Pro can navigate to `/admin/courts` and `/admin/settings` and view real club data (court names, booking rules, operating hours, branding). Edit controls appear but save actions were not tested. Read access to admin-only configuration violates the intended role boundary regardless of whether writes are blocked server-side. `/admin/members` and `/admin/audit-log` show an error page rather than redirecting. | Confirmed Pilot Blocker — Pro can view admin-only court and settings data | Sign in as Pro; navigate to `/admin/courts` — real court data visible. Navigate to `/admin/settings` — real club settings visible. | Add role guard checks to `/admin/courts` and `/admin/settings` server components: redirect to `/calendar` if `role !== 'admin'`, matching the guards on `/admin/members` and `/admin/audit-log`. Normalize error vs. redirect behavior for all non-events admin routes. | Open — Phase 20D fix required |

**Severity definitions:**

- **Pilot blocker** — blocks a user from completing a core workflow; must be fixed before pilot.
- **Important, can defer** — noticeably wrong but has a workaround; fix after pilot launch.
- **Cosmetic** — visual or minor UX issue; defer to a polish phase.

> **Phase 20D scope — final (Phase 20B QA complete):**
>
> **Confirmed pilot blockers — must fix before member-enabled pilot:**
>
> - **Issue #4:** Invited-user signup flow — add "Create account" path from `/join/<code>`.
> - **Issue #5:** Member court-booking duration selector — extend to 30/60/90/120 min; add server-side validation for `create_reservation` only. CreateEventSheet (admin/pro event creation) scope is a separate decision.
> - **Issue #8:** Pro role access — add role guard to `/admin/courts` and `/admin/settings` server components; redirect to `/calendar` when `role !== 'admin'`.
>
> **Issue #7 resolved:** Event cancellation notifications passed on controlled retest — no fix required.
>
> **Strongly recommended pre-pilot usability fixes (not hard blockers):**
>
> - **Issue #1:** Roster and occupancy display stale after admin roster mutations — refetch on mutation.
> - **Issue #6:** No calendar-level reservation detail/cancel for a member's own booking — add own-reservation manage sheet reusing My Schedule cancellation logic.

---

## 13. Sign-Off

Complete this table after running all sections. A group passes only when all
individual tests within it pass (or are marked N/A with documented reason).

| Group | Tests | Pass? | Notes |
| ---------------------------------- | --------- | ----- | ----- |
| **Auth / Onboarding** | 2.1–2.10 | Partial | 2.6 invite signup blocked (Issue #4 — pilot blocker); 2.5/2.7/2.8/2.9/2.10 pass |
| **Member Booking** | 3.1–3.12 | Partial | 3.2 duration options incomplete (Issue #5 — pilot blocker); 3.11/3.12 pass; Issue #6 logged (non-blocker) |
| **Events / Waitlist** | 4.1–4.9 | Pass | All tests pass |
| **Notifications** | 5.1–5.12 | Pass | 5.6 passed on controlled retest; Issue #7 resolved |
| **Admin Configuration** | 6.1–6.13 | Pass | 6.13 deactivated-member actions correctly blocked |
| **Admin Event / Participant Mgmt** | 7.1–7.18 | Pass | Issue #1 logged (non-blocker) |
| **Pro Permissions** | 8.1–8.4 | Fail | 8.3 Pro can view admin-only court/settings data (Issue #8 — pilot blocker) |
| **Security Spot Checks** | 9.1–9.7 | Pass | 9.5 N/A (single-club run) |
| **Deployment / Environment** | 10.1–10.7 | Pass | |
| **Build Checks** | 11 | Pass | pnpm tsc and pnpm build pass; /admin/events in route output |

**QA execution status:** Complete  
**Pilot blocker failures:** Issue #4 (invite signup), Issue #5 (booking duration), Issue #8 (Pro route access)  
**Strongly recommended pre-pilot fixes:** Issue #1 (roster staleness), Issue #6 (calendar reservation manage/cancel)  
**Deferred / resolved:** Issue #2 (cosmetic), Issue #3 (resolved on retest), Issue #7 (resolved on retest)  
**QA completed by:** tmont001  
**QA completed on:** 2026-06-02  
**Pilot approved to proceed:** ☐ Yes ☑ No — blocked by: Issues #4, #5, #8 — Phase 20D fixes required
